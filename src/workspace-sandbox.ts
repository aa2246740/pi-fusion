import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

const DEFAULT_EXCLUDED_NAMES = new Set([
  ".git",
  "node_modules",
  ".auto",
  ".ds_store",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".cache",
  ".vite",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  ".venv",
  "__pycache__",
  "venv",
  "coverage",
  "dist",
  "build",
  "out",
  "target",
  "deriveddata",
]);

const SECRET_FILE_RE = /(^|\/)(\.env(?:\..*)?|id_rsa|id_dsa|id_ecdsa|id_ed25519|.*\.pem|.*\.key|.*token.*|.*secret.*|.*credentials.*)$/i;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;
const DEFAULT_MAX_WORKSPACE_FILES = 5_000;
const DEFAULT_MAX_WORKSPACE_BYTES = 50_000_000;
const DEFAULT_MAX_CHANGESET_OPERATIONS = 200;
const DEFAULT_MAX_CHANGESET_BYTES = 5_000_000;
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;

type WorkspaceFileType = "file";

export interface WorkspacePolicy {
  excludedNames: ReadonlySet<string>;
  secretFilePattern: RegExp;
  maxFileBytes: number;
  maxWorkspaceFiles: number;
  maxWorkspaceBytes: number;
  maxChangeSetOperations: number;
  maxChangeSetBytes: number;
}

export const DEFAULT_WORKSPACE_POLICY: WorkspacePolicy = {
  excludedNames: DEFAULT_EXCLUDED_NAMES,
  secretFilePattern: SECRET_FILE_RE,
  maxFileBytes: DEFAULT_MAX_FILE_BYTES,
  maxWorkspaceFiles: DEFAULT_MAX_WORKSPACE_FILES,
  maxWorkspaceBytes: DEFAULT_MAX_WORKSPACE_BYTES,
  maxChangeSetOperations: DEFAULT_MAX_CHANGESET_OPERATIONS,
  maxChangeSetBytes: DEFAULT_MAX_CHANGESET_BYTES,
};

export interface WorkspaceManifestFile {
  path: string;
  type: WorkspaceFileType;
  sha256: string;
  size: number;
  mode: number;
}

export interface WorkspaceBaselineManifest {
  version: 1;
  sourceRoot: string;
  gitHead?: string;
  gitStatus?: string;
  createdAt: string;
  files: WorkspaceManifestFile[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface WorkspaceBaseline {
  root: string;
  sourceRoot: string;
  manifest: WorkspaceBaselineManifest;
}

export interface WorkspaceSandbox {
  sandboxId: string;
  root: string;
  baseline: WorkspaceBaseline;
}

export type ChangeSetOperation =
  | { op: "add"; path: string; contentBase64: string; mode: number; sha256: string; size: number }
  | { op: "modify"; path: string; beforeSha256: string; contentBase64: string; mode: number; sha256: string; size: number }
  | { op: "delete"; path: string; beforeSha256: string };

export interface WorkspaceChangeSet {
  version: 1;
  sandboxId: string;
  baselineSha256: string;
  operations: ChangeSetOperation[];
}

export interface ImportedExternalEvidence {
  modelPath: string;
  sandboxPath: string;
  sha256: string;
  size: number;
  mode: number;
}

export class WorkspaceSandboxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceSandboxError";
  }
}

export class WorkspaceDriftError extends WorkspaceSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "WorkspaceDriftError";
  }
}

function workspacePathPolicyViolation(relativePath: string, policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY): string | undefined {
  const normalized = path.posix.normalize(relativePath.replace(/\\/g, "/"));
  const segments = normalized.split("/").filter(Boolean);
  const excludedSegment = segments.find((segment) => policy.excludedNames.has(segment.toLowerCase()));
  if (excludedSegment) {
    return `excluded path segment: ${excludedSegment}`;
  }
  if (policy.secretFilePattern.test(normalized)) {
    return "secret-like path";
  }
  return undefined;
}

function assertWorkspacePolicyAllowsPath(relativePath: string, policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY): void {
  const violation = workspacePathPolicyViolation(relativePath, policy);
  if (violation) {
    throw new WorkspaceSandboxError(`workspace policy forbids ${relativePath}: ${violation}`);
  }
}

function normalizeRelativePath(userPath: string, policy: WorkspacePolicy = DEFAULT_WORKSPACE_POLICY): string {
  if (!userPath || userPath.trim() === "") {
    throw new WorkspaceSandboxError("unsafe path: empty path");
  }
  if (userPath.includes("\0")) {
    throw new WorkspaceSandboxError("unsafe path: NUL byte");
  }
  if (path.isAbsolute(userPath)) {
    throw new WorkspaceSandboxError(`unsafe path outside sandbox: ${userPath}`);
  }
  const normalized = path.posix.normalize(userPath.replace(/\\/g, "/"));
  if (normalized === "." || normalized.startsWith("../") || normalized === "..") {
    throw new WorkspaceSandboxError(`unsafe path outside sandbox: ${userPath}`);
  }
  assertWorkspacePolicyAllowsPath(normalized, policy);
  return normalized;
}

function toFsPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const data = await fs.readFile(filePath);
  hash.update(data);
  return hash.digest("hex");
}

function sha256Data(buffer: Buffer): string {
  return createHash("sha256").update(buffer).digest("hex");
}

async function sha256Buffer(buffer: Buffer): Promise<string> {
  return sha256Data(buffer);
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
    .join(",")}}`;
}

export function workspaceBaselineSha256(baseline: WorkspaceBaseline): string {
  return createHash("sha256").update(stableJson(baseline.manifest)).digest("hex");
}

async function gitInfo(sourceRoot: string): Promise<{ gitHead?: string; gitStatus?: string }> {
  try {
    const [{ stdout: head }, { stdout: status }] = await Promise.all([
      execFile("git", ["rev-parse", "HEAD"], { cwd: sourceRoot }),
      execFile("git", ["status", "--short", "--branch"], { cwd: sourceRoot }),
    ]);
    return { gitHead: head.trim(), gitStatus: status.trim() };
  } catch {
    return {};
  }
}

async function ensureNoSymlinkPath(root: string, relativePath: string, options: { allowMissingLeaf?: boolean } = {}): Promise<string> {
  const safeRel = normalizeRelativePath(relativePath);
  const rootReal = await fs.realpath(root);
  const parts = safeRel.split("/").filter(Boolean);
  let current = rootReal;

  for (let i = 0; i < parts.length; i++) {
    current = path.join(current, parts[i]);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new WorkspaceSandboxError(`refusing symlink inside sandbox: ${safeRel}`);
      }
      if (i < parts.length - 1 && !stat.isDirectory()) {
        throw new WorkspaceSandboxError(`unsafe path component is not a directory: ${safeRel}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && options.allowMissingLeaf && i === parts.length - 1) {
        const parentReal = await fs.realpath(path.dirname(current));
        if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
          throw new WorkspaceSandboxError(`unsafe path outside sandbox: ${safeRel}`);
        }
        return current;
      }
      throw error;
    }
  }

  const parentReal = await fs.realpath(path.dirname(current));
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new WorkspaceSandboxError(`unsafe path outside sandbox: ${safeRel}`);
  }
  return current;
}

async function ensureNoSymlinkParentDirectory(root: string, relativePath: string): Promise<string> {
  const safeRel = normalizeRelativePath(relativePath);
  const rootReal = await fs.realpath(root);
  const parentRel = path.posix.dirname(safeRel);
  if (parentRel === ".") return path.join(rootReal, safeRel);

  const parts = parentRel.split("/").filter(Boolean);
  let current = rootReal;
  for (const part of parts) {
    current = path.join(current, part);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new WorkspaceSandboxError(`refusing symlink inside sandbox: ${safeRel}`);
      }
      if (!stat.isDirectory()) {
        throw new WorkspaceSandboxError(`unsafe path component is not a directory: ${safeRel}`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await fs.mkdir(current);
      const created = await fs.lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw new WorkspaceSandboxError(`unsafe created path component: ${safeRel}`);
      }
    }
  }

  const parentReal = await fs.realpath(current);
  if (parentReal !== rootReal && !parentReal.startsWith(`${rootReal}${path.sep}`)) {
    throw new WorkspaceSandboxError(`unsafe path outside sandbox: ${safeRel}`);
  }
  return path.join(rootReal, ...safeRel.split("/"));
}

async function copyRegularFile(sourcePath: string, destPath: string, mode: number): Promise<void> {
  await fs.mkdir(path.dirname(destPath), { recursive: true });
  await fs.copyFile(sourcePath, destPath, fsConstants.COPYFILE_EXCL);
  await fs.chmod(destPath, mode & 0o777);
}

async function walkSource(
  sourceRoot: string,
  relativeDir: string,
  visitor: (relativePath: string, absolutePath: string, stat: Awaited<ReturnType<typeof fs.lstat>>) => Promise<void>,
  options: {
    policy?: WorkspacePolicy;
    policyViolation?: "skip" | "reject";
    onPolicySkip?: (relativePath: string, reason: string) => void;
  } = {},
): Promise<void> {
  const policy = options.policy ?? DEFAULT_WORKSPACE_POLICY;
  const policyViolation = options.policyViolation ?? "skip";
  const dir = toFsPath(sourceRoot, relativeDir || ".");
  const entries = await fs.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    const violation = workspacePathPolicyViolation(relativePath, policy);
    if (violation) {
      if (policyViolation === "reject") {
        throw new WorkspaceSandboxError(`workspace policy forbids ${relativePath}: ${violation}`);
      }
      options.onPolicySkip?.(relativePath, violation);
      continue;
    }
    const absolutePath = path.join(dir, entry.name);
    const stat = await fs.lstat(absolutePath);
    await visitor(relativePath, absolutePath, stat);
    if (stat.isDirectory()) {
      await walkSource(sourceRoot, relativePath, visitor, options);
    }
  }
}

export async function createWorkspaceBaseline(options: {
  sourceRoot: string;
  baselineRoot: string;
  maxFileBytes?: number;
  policy?: WorkspacePolicy;
}): Promise<WorkspaceBaseline> {
  const sourceRoot = await fs.realpath(options.sourceRoot);
  const baselineRoot = path.resolve(options.baselineRoot);
  const policy = options.policy ?? DEFAULT_WORKSPACE_POLICY;
  const maxFileBytes = options.maxFileBytes ?? policy.maxFileBytes;
  await fs.rm(baselineRoot, { recursive: true, force: true });
  await fs.mkdir(baselineRoot, { recursive: true });

  const files: WorkspaceManifestFile[] = [];
  const skipped: WorkspaceBaselineManifest["skipped"] = [];
  let copiedBytes = 0;

  await walkSource(sourceRoot, "", async (relativePath, absolutePath, stat) => {
    if (stat.isDirectory()) {
      await fs.mkdir(toFsPath(baselineRoot, relativePath), { recursive: true });
      return;
    }
    if (stat.isSymbolicLink()) {
      skipped.push({ path: relativePath, reason: "symlink" });
      return;
    }
    if (!stat.isFile()) {
      skipped.push({ path: relativePath, reason: "not-regular-file" });
      return;
    }
    if (stat.nlink > 1) {
      skipped.push({ path: relativePath, reason: "hardlink" });
      return;
    }
    const size = Number(stat.size);
    if (size > maxFileBytes) {
      skipped.push({ path: relativePath, reason: "too-large" });
      return;
    }
    if (files.length >= policy.maxWorkspaceFiles) {
      skipped.push({ path: relativePath, reason: "workspace-file-limit" });
      return;
    }
    if (copiedBytes + size > policy.maxWorkspaceBytes) {
      skipped.push({ path: relativePath, reason: "workspace-byte-limit" });
      return;
    }

    const mode = Number(stat.mode) & 0o777;
    const destPath = toFsPath(baselineRoot, relativePath);
    await copyRegularFile(absolutePath, destPath, mode);
    copiedBytes += size;
    files.push({
      path: relativePath,
      type: "file",
      sha256: await sha256File(absolutePath),
      size,
      mode,
    });
  }, {
    policy,
    policyViolation: "skip",
    onPolicySkip: (relativePath, reason) => {
      skipped.push({ path: relativePath, reason });
    },
  });

  files.sort((a, b) => a.path.localeCompare(b.path));
  const git = await gitInfo(sourceRoot);
  const manifest: WorkspaceBaselineManifest = {
    version: 1,
    sourceRoot,
    ...git,
    createdAt: new Date().toISOString(),
    files,
    skipped,
  };
  await fs.writeFile(path.join(baselineRoot, "baseline-manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
  return { root: baselineRoot, sourceRoot, manifest };
}

export async function createWorkspaceSandbox(options: {
  baseline: WorkspaceBaseline;
  sandboxRoot: string;
  sandboxId: string;
}): Promise<WorkspaceSandbox> {
  const root = path.resolve(options.sandboxRoot);
  await fs.rm(root, { recursive: true, force: true });
  await fs.mkdir(root, { recursive: true });
  for (const file of options.baseline.manifest.files) {
    await copyRegularFile(toFsPath(options.baseline.root, file.path), toFsPath(root, file.path), file.mode);
  }
  return { sandboxId: options.sandboxId, root, baseline: options.baseline };
}

export async function readSandboxFile(sandbox: WorkspaceSandbox, userPath: string): Promise<string> {
  const safeRel = normalizeRelativePath(userPath);
  const filePath = await ensureNoSymlinkPath(sandbox.root, safeRel);
  const stat = await fs.lstat(filePath);
  if (!stat.isFile()) throw new WorkspaceSandboxError(`not a file: ${safeRel}`);
  const handle = await fs.open(filePath, fsConstants.O_RDONLY | NOFOLLOW);
  try {
    return await handle.readFile("utf-8");
  } finally {
    await handle.close();
  }
}

export async function writeSandboxFile(sandbox: WorkspaceSandbox, userPath: string, content: string): Promise<void> {
  const safeRel = normalizeRelativePath(userPath);
  const size = Buffer.byteLength(content, "utf-8");
  if (size > DEFAULT_WORKSPACE_POLICY.maxFileBytes) {
    throw new WorkspaceSandboxError(`file exceeds byte limit for ${safeRel}`);
  }
  const filePath = await ensureNoSymlinkParentDirectory(sandbox.root, safeRel);
  try {
    const stat = await fs.lstat(filePath);
    if (stat.isSymbolicLink()) throw new WorkspaceSandboxError(`refusing symlink inside sandbox: ${safeRel}`);
    if (!stat.isFile()) throw new WorkspaceSandboxError(`not a file: ${safeRel}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  await fs.writeFile(filePath, content, "utf-8");
}

export async function editSandboxFile(sandbox: WorkspaceSandbox, userPath: string, oldText: string, newText: string): Promise<void> {
  if (!oldText) throw new WorkspaceSandboxError("oldText must be non-empty");
  const current = await readSandboxFile(sandbox, userPath);
  const first = current.indexOf(oldText);
  if (first < 0) throw new WorkspaceSandboxError("oldText not found");
  if (current.indexOf(oldText, first + oldText.length) >= 0) {
    throw new WorkspaceSandboxError("oldText must match exactly one location");
  }
  await writeSandboxFile(sandbox, userPath, `${current.slice(0, first)}${newText}${current.slice(first + oldText.length)}`);
}

export async function deleteSandboxFile(sandbox: WorkspaceSandbox, userPath: string): Promise<void> {
  const safeRel = normalizeRelativePath(userPath);
  const filePath = await ensureNoSymlinkPath(sandbox.root, safeRel);
  const stat = await fs.lstat(filePath);
  if (stat.isSymbolicLink()) throw new WorkspaceSandboxError(`refusing symlink inside sandbox: ${safeRel}`);
  if (!stat.isFile()) throw new WorkspaceSandboxError(`not a file: ${safeRel}`);
  await fs.rm(filePath);
}

export interface WorkspaceSearchResult {
  path: string;
  line: number;
  preview: string;
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, Math.min(buffer.length, 4096)).includes(0);
}

export async function listSandboxFiles(sandbox: WorkspaceSandbox): Promise<string[]> {
  const files = await collectFiles(sandbox.root);
  return files
    .map((file) => file.path)
    .filter((filePath) => !SECRET_FILE_RE.test(filePath));
}

export async function searchSandboxFiles(sandbox: WorkspaceSandbox, query: string, options: { maxResults?: number } = {}): Promise<WorkspaceSearchResult[]> {
  const trimmed = query.trim();
  if (!trimmed) throw new WorkspaceSandboxError("query must be non-empty");
  const maxResults = options.maxResults ?? 20;
  const results: WorkspaceSearchResult[] = [];
  for (const filePath of await listSandboxFiles(sandbox)) {
    if (results.length >= maxResults) break;
    const absPath = await ensureNoSymlinkPath(sandbox.root, filePath);
    const stat = await fs.lstat(absPath);
    if (stat.size > DEFAULT_MAX_FILE_BYTES) continue;
    const buffer = await fs.readFile(absPath);
    if (looksBinary(buffer)) continue;
    const text = buffer.toString("utf-8");
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].toLowerCase().includes(trimmed.toLowerCase())) continue;
      results.push({ path: filePath, line: i + 1, preview: lines[i].slice(0, 300) });
      if (results.length >= maxResults) break;
    }
  }
  return results;
}

async function collectFiles(
  root: string,
  options: { policy?: WorkspacePolicy; policyViolation?: "skip" | "reject" } = {},
): Promise<WorkspaceManifestFile[]> {
  const files: WorkspaceManifestFile[] = [];
  await walkSource(root, "", async (relativePath, absolutePath, stat) => {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink > 1) return;
    files.push({
      path: relativePath,
      type: "file",
      sha256: await sha256File(absolutePath),
      size: Number(stat.size),
      mode: Number(stat.mode) & 0o777,
    });
  }, options);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

export async function buildChangeSet(options: { baseline: WorkspaceBaseline; sandbox: WorkspaceSandbox }): Promise<WorkspaceChangeSet> {
  const baselineByPath = new Map(options.baseline.manifest.files.map((file) => [file.path, file]));
  const currentFiles = await collectFiles(options.sandbox.root, { policyViolation: "reject" });
  const currentByPath = new Map(currentFiles.map((file) => [file.path, file]));
  const operations: ChangeSetOperation[] = [];

  for (const before of options.baseline.manifest.files) {
    const after = currentByPath.get(before.path);
    if (!after) {
      operations.push({ op: "delete", path: before.path, beforeSha256: before.sha256 });
      continue;
    }
    if (before.sha256 !== after.sha256 || before.mode !== after.mode) {
      const data = await fs.readFile(toFsPath(options.sandbox.root, after.path));
      operations.push({
        op: "modify",
        path: after.path,
        beforeSha256: before.sha256,
        contentBase64: data.toString("base64"),
        mode: after.mode,
        sha256: after.sha256,
        size: after.size,
      });
    }
  }

  for (const after of currentFiles) {
    if (baselineByPath.has(after.path)) continue;
    const data = await fs.readFile(toFsPath(options.sandbox.root, after.path));
    operations.push({
      op: "add",
      path: after.path,
      contentBase64: data.toString("base64"),
      mode: after.mode,
      sha256: after.sha256,
      size: after.size,
    });
  }

  operations.sort((a, b) => a.path.localeCompare(b.path));
  const changeSet: WorkspaceChangeSet = {
    version: 1,
    sandboxId: options.sandbox.sandboxId,
    baselineSha256: workspaceBaselineSha256(options.baseline),
    operations,
  };
  validateWorkspaceChangeSet({ baseline: options.baseline, changeSet });
  return changeSet;
}

function assertSha256(value: string, field: string, filePath: string): void {
  if (!/^[a-f0-9]{64}$/.test(value)) {
    throw new WorkspaceSandboxError(`invalid ${field} for ${filePath}`);
  }
}

function validateChangeSetContentOperation(
  operation: Extract<ChangeSetOperation, { op: "add" | "modify" }>,
  policy: WorkspacePolicy,
): void {
  assertSha256(operation.sha256, "sha256", operation.path);
  if (!Number.isSafeInteger(operation.size) || operation.size < 0) {
    throw new WorkspaceSandboxError(`invalid content size for ${operation.path}`);
  }
  if (operation.size > policy.maxFileBytes) {
    throw new WorkspaceSandboxError(`ChangeSet file exceeds byte limit for ${operation.path}`);
  }
  if (!Number.isSafeInteger(operation.mode) || operation.mode < 0 || operation.mode > 0o777) {
    throw new WorkspaceSandboxError(`invalid file mode for ${operation.path}`);
  }
}

function validateWorkspaceChangeSet(options: {
  baseline: WorkspaceBaseline;
  changeSet: WorkspaceChangeSet;
  policy?: WorkspacePolicy;
}): void {
  const policy = options.policy ?? DEFAULT_WORKSPACE_POLICY;
  if (options.changeSet.version !== 1) {
    throw new WorkspaceSandboxError("unsupported ChangeSet version");
  }
  if (options.changeSet.operations.length > policy.maxChangeSetOperations) {
    throw new WorkspaceSandboxError("ChangeSet exceeds operation limit");
  }

  const baselineByPath = new Map(options.baseline.manifest.files.map((file) => [file.path, file]));
  const seen = new Set<string>();
  let totalBytes = 0;

  for (const operation of options.changeSet.operations) {
    const safePath = normalizeRelativePath(operation.path, policy);
    if (safePath !== operation.path) {
      throw new WorkspaceSandboxError(`ChangeSet path must be canonical: ${operation.path}`);
    }
    if (seen.has(safePath)) {
      throw new WorkspaceSandboxError(`duplicate or conflicting ChangeSet operation for ${safePath}`);
    }
    seen.add(safePath);

    const baselineEntry = baselineByPath.get(safePath);
    if (operation.op === "add") {
      if (baselineEntry) {
        throw new WorkspaceSandboxError(`ChangeSet add conflicts with baseline file ${safePath}`);
      }
      validateChangeSetContentOperation(operation, policy);
      totalBytes += operation.size;
      continue;
    }

    if (!baselineEntry) {
      throw new WorkspaceSandboxError(`ChangeSet ${operation.op} has no baseline file ${safePath}`);
    }
    assertSha256(operation.beforeSha256, "beforeSha256", safePath);
    if (operation.beforeSha256 !== baselineEntry.sha256) {
      throw new WorkspaceSandboxError(`ChangeSet beforeSha256 does not match baseline for ${safePath}`);
    }
    if (operation.op === "modify") {
      validateChangeSetContentOperation(operation, policy);
      totalBytes += operation.size;
    }
  }

  if (totalBytes > policy.maxChangeSetBytes) {
    throw new WorkspaceSandboxError("ChangeSet exceeds total byte limit");
  }
}

async function assertWorkspaceMatchesBaselineForOperation(sourceRoot: string, baseline: WorkspaceBaseline, operation: ChangeSetOperation): Promise<void> {
  const baselineEntry = baseline.manifest.files.find((file) => file.path === operation.path);
  const sourcePath = toFsPath(sourceRoot, operation.path);
  if (operation.op === "add") {
    try {
      await fs.lstat(sourcePath);
      throw new WorkspaceDriftError(`workspace drift: target already exists for add ${operation.path}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
  }

  if (!baselineEntry) {
    throw new WorkspaceDriftError(`workspace drift: missing baseline entry for ${operation.path}`);
  }
  let stat;
  try {
    stat = await fs.lstat(sourcePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new WorkspaceDriftError(`workspace drift: source file missing ${operation.path}`);
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WorkspaceDriftError(`workspace drift: source file is not a regular file ${operation.path}`);
  }
  const currentHash = await sha256File(sourcePath);
  if (currentHash !== baselineEntry.sha256) {
    throw new WorkspaceDriftError(`workspace drift: ${operation.path} changed since baseline`);
  }
}

export async function applyChangeSetToWorkspace(options: {
  sourceRoot: string;
  baseline: WorkspaceBaseline;
  changeSet: WorkspaceChangeSet;
  confirmed: boolean;
}): Promise<void> {
  if (!options.confirmed) {
    throw new WorkspaceSandboxError("explicit user confirmation is required before applying a ChangeSet");
  }
  const expectedBaselineSha256 = workspaceBaselineSha256(options.baseline);
  if (options.changeSet.baselineSha256 !== expectedBaselineSha256) {
    throw new WorkspaceSandboxError("ChangeSet baseline digest does not match the selected workspace baseline");
  }
  validateWorkspaceChangeSet({ baseline: options.baseline, changeSet: options.changeSet });
  const sourceRoot = await fs.realpath(options.sourceRoot);
  for (const operation of options.changeSet.operations) {
    normalizeRelativePath(operation.path);
    await assertWorkspaceMatchesBaselineForOperation(sourceRoot, options.baseline, operation);
  }

  for (const operation of options.changeSet.operations) {
    const target = await ensureNoSymlinkPath(sourceRoot, operation.path, { allowMissingLeaf: operation.op === "add" });
    if (operation.op === "delete") {
      await fs.rm(target, { force: true });
      continue;
    }
    const data = Buffer.from(operation.contentBase64, "base64");
    if (data.length !== operation.size) {
      throw new WorkspaceSandboxError(`ChangeSet content size mismatch for ${operation.path}`);
    }
    if (await sha256Buffer(data) !== operation.sha256) {
      throw new WorkspaceSandboxError(`ChangeSet content hash mismatch for ${operation.path}`);
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, data);
    await fs.chmod(target, operation.mode & 0o777);
  }
}

export function extractLocalFileReferences(text: string): string[] {
  const refs: string[] = [];
  const seen = new Set<string>();
  const add = (value: string) => {
    const cleaned = value.trim().replace(/[),.;:]+$/g, "");
    if (!cleaned || seen.has(cleaned)) return;
    seen.add(cleaned);
    refs.push(cleaned);
  };

  for (const match of text.matchAll(/file:\/\/([^\s)>'\"]+)/g)) {
    try {
      add(decodeURIComponent(match[1]));
    } catch {
      add(match[1]);
    }
  }
  for (const match of text.matchAll(/(^|[\s(])((?:\/[^\s)>'\"]+)+)/g)) {
    const candidate = match[2];
    if (/^\/\//.test(candidate)) continue;
    add(candidate);
  }
  return refs;
}

export async function importExternalEvidence(options: {
  sourcePath: string;
  evidenceRoot: string;
  maxBytes?: number;
}): Promise<ImportedExternalEvidence> {
  const sourcePath = path.resolve(options.sourcePath);
  const stat = await fs.lstat(sourcePath);
  if (stat.isSymbolicLink()) throw new WorkspaceSandboxError("external evidence source must not be a symlink");
  if (!stat.isFile()) throw new WorkspaceSandboxError("external evidence source must be a regular file");
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_FILE_BYTES;
  if (stat.size > maxBytes) throw new WorkspaceSandboxError("external evidence source is too large");

  const basename = path.basename(sourcePath).replace(/[^A-Za-z0-9._-]/g, "_");
  const modelPath = `__external__/${basename}`;
  const evidenceRoot = path.resolve(options.evidenceRoot);
  const sandboxPath = toFsPath(evidenceRoot, modelPath);
  await fs.mkdir(path.dirname(sandboxPath), { recursive: true });
  await fs.copyFile(sourcePath, sandboxPath, fsConstants.COPYFILE_EXCL);
  await fs.chmod(sandboxPath, 0o444);
  return {
    modelPath,
    sandboxPath,
    sha256: await sha256File(sandboxPath),
    size: stat.size,
    mode: 0o444,
  };
}
