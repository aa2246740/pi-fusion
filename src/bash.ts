import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { spawn } from "node:child_process";

export interface SandboxBashOptions {
  timeoutMs?: number;
  maxOutputChars?: number;
}

export interface SandboxBashResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_OUTPUT_CHARS = 20_000;
const MAX_COMMAND_CHARS = 4_000;

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /(^|\s)(sudo|su|osascript|open)\b/i, reason: "privilege escalation or desktop automation is not allowed" },
  { pattern: /(^|\s)(rm|mv|cp|chmod|chown|touch|mkdir|rmdir|dd|truncate|tee|install|ln|mkfifo|mount|umount|kill|pkill)\b/i, reason: "filesystem mutation or process control is not allowed" },
  { pattern: /(^|\s)(curl|wget|nc|netcat|ssh|scp|sftp|ftp|telnet|nmap|dig|host|nslookup)\b/i, reason: "network access is not allowed from bash; use web_search/web_fetch instead" },
  { pattern: /(^|\s)(git|gh|brew|npm|pnpm|yarn|pip|pip3|python\s+-m\s+pip|python3\s+-m\s+pip)\b/i, reason: "package managers and repo mutation commands are not allowed" },
  { pattern: /(^|[^<])>{1,2}[^>]/, reason: "file redirection is not allowed" },
  { pattern: /(^|\s)(cat|less|more|head|tail|grep|rg|sed|awk|find|ls)\b/i, reason: "local file inspection is not allowed from bash" },
  { pattern: /(^|[\s"'`])(~|\$HOME|\/Users\/|\/private\/|\/var\/folders\/|\.pi\b|\.config\b)/i, reason: "sensitive local paths are not allowed" },
  { pattern: /(auth\.json|mcp\.json|models\.json|id_rsa|id_ed25519|BEGIN [A-Z ]*PRIVATE KEY)/i, reason: "sensitive credential material is not allowed" },
  { pattern: /\b(import\s+(os|subprocess|socket|requests|urllib|http|pathlib|shutil|glob)|from\s+(os|subprocess|socket|requests|urllib|http|pathlib|shutil|glob)\s+import)\b/i, reason: "Python filesystem, process, or network modules are not allowed in bash" },
  { pattern: /\b(open|exec|eval|compile|__import__)\s*\(/i, reason: "dynamic execution or file opening is not allowed in bash" },
];

export function validateSandboxBashCommand(command: string): string | undefined {
  const trimmed = command.trim();
  if (!trimmed) return "command must be non-empty";
  if (trimmed.length > MAX_COMMAND_CHARS) return `command exceeds ${MAX_COMMAND_CHARS} characters`;

  for (const { pattern, reason } of BLOCKED_PATTERNS) {
    if (pattern.test(trimmed)) return reason;
  }

  return undefined;
}

export async function runSandboxedBash(command: string, options: SandboxBashOptions = {}): Promise<SandboxBashResult> {
  const validationError = validateSandboxBashCommand(command);
  if (validationError) {
    return {
      stdout: "",
      stderr: `sandboxed bash rejected command: ${validationError}`,
      exitCode: 126,
      timedOut: false,
    };
  }

  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS));
  const maxOutputChars = Math.max(1_000, Math.min(options.maxOutputChars ?? DEFAULT_MAX_OUTPUT_CHARS, 100_000));
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-bash-"));

  try {
    return await new Promise<SandboxBashResult>((resolve) => {
      const child = spawn("/bin/bash", ["--noprofile", "--norc", "-c", command], {
        cwd,
        env: {
          PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
          LANG: "C",
          LC_ALL: "C",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;

      const append = (kind: "stdout" | "stderr", chunk: Buffer) => {
        const text = chunk.toString("utf8");
        if (kind === "stdout") stdout = (stdout + text).slice(0, maxOutputChars);
        else stderr = (stderr + text).slice(0, maxOutputChars);
        if (stdout.length + stderr.length >= maxOutputChars) {
          stderr = (stderr + `\n[output truncated at ${maxOutputChars} chars]`).slice(0, maxOutputChars);
          child.kill("SIGTERM");
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }, timeoutMs);
      timer.unref();

      child.stdout?.on("data", (chunk: Buffer) => append("stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("stderr", chunk));
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: `${stderr}\n${error.message}`.trim(), exitCode: 127, timedOut });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: stdout.trimEnd(), stderr: stderr.trimEnd(), exitCode: code, timedOut });
      });
    });
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
}

export function formatSandboxBashResult(result: SandboxBashResult): string {
  const parts = [
    `exitCode: ${result.exitCode}${result.timedOut ? " (timed out)" : ""}`,
    result.stdout ? `stdout:\n${result.stdout}` : "stdout: <empty>",
    result.stderr ? `stderr:\n${result.stderr}` : "stderr: <empty>",
  ];
  return parts.join("\n");
}
