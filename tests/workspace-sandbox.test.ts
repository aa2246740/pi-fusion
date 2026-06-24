import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyChangeSetToWorkspace,
  buildChangeSet,
  createWorkspaceBaseline,
  createWorkspaceSandbox,
  deleteSandboxFile,
  editSandboxFile,
  extractLocalFileReferences,
  importExternalEvidence,
  listSandboxFiles,
  readSandboxFile,
  searchSandboxFiles,
  workspaceBaselineSha256,
  writeSandboxFile,
} from "../src/workspace-sandbox.js";

async function tempDir(name: string): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), `${name}-`));
}

async function writeFile(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, "utf-8");
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

describe("workspace sandbox safety contracts", () => {
  it("extracts local file references without treating web URLs as local files", () => {
    expect(extractLocalFileReferences("Use /workspace/project/handoff.md and file:///workspace/notes%201.md but not https://example.com/x")).toEqual([
      "/workspace/notes 1.md",
      "/workspace/project/handoff.md",
    ]);
  });

  it("rejects relative path escapes before reading or writing", async () => {
    const root = await tempDir("pi-fusion-sandbox-root");
    const baselineRoot = path.join(root, "baseline");
    const sandboxRoot = path.join(root, "sandbox");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "hello");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot, sandboxId: "p1" });

    await expect(readSandboxFile(sandbox, "../source/README.md")).rejects.toThrow(/outside sandbox|unsafe path/i);
    await expect(writeSandboxFile(sandbox, "../source/pwned.txt", "oops")).rejects.toThrow(/outside sandbox|unsafe path/i);
    await expect(fs.access(path.join(sourceRoot, "pwned.txt"))).rejects.toThrow();
  });

  it("enforces forbidden path policy at sandbox API and ChangeSet construction boundaries", async () => {
    const root = await tempDir("pi-fusion-policy-sandbox");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "safe");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });

    await expect(writeSandboxFile(sandbox, ".git/config", "malicious")).rejects.toThrow(/forbidden|excluded|policy/i);
    await expect(writeSandboxFile(sandbox, ".auto/prompt.md", "benchmark leak")).rejects.toThrow(/forbidden|excluded|policy/i);
    await expect(writeSandboxFile(sandbox, "node_modules/pkg/index.js", "supply chain")).rejects.toThrow(/forbidden|excluded|policy/i);
    await expect(writeSandboxFile(sandbox, ".env", "REDACTED_VALUE=placeholder")).rejects.toThrow(/secret|forbidden|policy/i);

    await writeFile(path.join(sandbox.root, ".git", "hooks", "post-commit"), "bypassed sandbox API");
    await expect(buildChangeSet({ baseline, sandbox })).rejects.toThrow(/forbidden|excluded|policy/i);
  });

  it("rejects forged ChangeSets targeting forbidden workspace paths before applying", async () => {
    const root = await tempDir("pi-fusion-policy-apply");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "safe");
    await fs.mkdir(path.join(sourceRoot, ".git", "hooks"), { recursive: true });

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const content = Buffer.from("malicious hook\n", "utf-8");
    const changeSet = {
      version: 1 as const,
      sandboxId: "forged",
      baselineSha256: workspaceBaselineSha256(baseline),
      operations: [
        {
          op: "add" as const,
          path: ".git/hooks/post-commit",
          contentBase64: content.toString("base64"),
          mode: 0o644,
          sha256: sha256(content),
          size: content.length,
        },
      ],
    };

    await expect(applyChangeSetToWorkspace({ sourceRoot, baseline, changeSet, confirmed: true })).rejects.toThrow(
      /forbidden|excluded|policy/i,
    );
    await expect(fs.access(path.join(sourceRoot, ".git", "hooks", "post-commit"))).rejects.toThrow();
  });

  it("rejects sandbox symlinks that point outside", async () => {
    const root = await tempDir("pi-fusion-symlink");
    const sourceRoot = path.join(root, "source");
    const outside = path.join(root, "outside-secret.txt");
    await writeFile(path.join(sourceRoot, "README.md"), "safe");
    await writeFile(outside, "secret");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });
    await fs.symlink(outside, path.join(sandbox.root, "leak.txt"));

    await expect(readSandboxFile(sandbox, "leak.txt")).rejects.toThrow(/symlink/i);
    await expect(writeSandboxFile(sandbox, "leak.txt", "overwrite")).rejects.toThrow(/symlink/i);
    await expect(fs.readFile(outside, "utf-8")).resolves.toBe("secret");
  });

  it("lists, searches, edits, and deletes files inside the sandbox without touching the source workspace", async () => {
    const root = await tempDir("pi-fusion-sandbox-tools");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "Pi Fusion\nmodel fusion layer\n");
    await writeFile(path.join(sourceRoot, "src", "index.ts"), "export const name = 'pi-fusion';\n");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });

    expect(await listSandboxFiles(sandbox)).toEqual(["README.md", "src/index.ts"]);
    expect(await searchSandboxFiles(sandbox, "fusion")).toEqual([
      { path: "README.md", line: 1, preview: "Pi Fusion" },
      { path: "README.md", line: 2, preview: "model fusion layer" },
      { path: "src/index.ts", line: 1, preview: "export const name = 'pi-fusion';" },
    ]);

    await editSandboxFile(sandbox, "README.md", "model fusion layer", "sandboxed model fusion layer");
    expect(await readSandboxFile(sandbox, "README.md")).toContain("sandboxed model fusion layer");
    expect(await fs.readFile(path.join(sourceRoot, "README.md"), "utf-8")).toBe("Pi Fusion\nmodel fusion layer\n");

    await deleteSandboxFile(sandbox, "src/index.ts");
    const changeSet = await buildChangeSet({ baseline, sandbox });
    expect(changeSet.operations.map((op) => `${op.op}:${op.path}`)).toEqual(["modify:README.md", "delete:src/index.ts"]);
    await expect(fs.access(path.join(sourceRoot, "src", "index.ts"))).resolves.toBeUndefined();
  });

  it("requires exact unique edit matches", async () => {
    const root = await tempDir("pi-fusion-exact-edit");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "repeat\nrepeat\n");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });

    await expect(editSandboxFile(sandbox, "README.md", "missing", "x")).rejects.toThrow(/not found/i);
    await expect(editSandboxFile(sandbox, "README.md", "repeat", "x")).rejects.toThrow(/exactly one/i);
    await expect(readSandboxFile(sandbox, "README.md")).resolves.toBe("repeat\nrepeat\n");
  });

  it("does not copy hardlinked files into the baseline", async () => {
    const root = await tempDir("pi-fusion-hardlink");
    const sourceRoot = path.join(root, "source");
    const outside = path.join(root, "outside.txt");
    await writeFile(outside, "shared secret");
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.link(outside, path.join(sourceRoot, "linked-secret.txt"));
    await writeFile(path.join(sourceRoot, "normal.txt"), "normal");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });

    expect(baseline.manifest.files.map((file) => file.path)).toContain("normal.txt");
    expect(baseline.manifest.files.map((file) => file.path)).not.toContain("linked-secret.txt");
    await expect(fs.access(path.join(baseline.root, "linked-secret.txt"))).rejects.toThrow();
  });

  it("rejects conflicting ChangeSet operations before touching the workspace", async () => {
    const root = await tempDir("pi-fusion-conflicting-changeset");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "before");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const before = baseline.manifest.files.find((file) => file.path === "README.md");
    if (!before) throw new Error("test setup failed");
    const first = Buffer.from("after one", "utf-8");
    const second = Buffer.from("after two", "utf-8");
    const changeSet = {
      version: 1 as const,
      sandboxId: "forged",
      baselineSha256: workspaceBaselineSha256(baseline),
      operations: [
        {
          op: "modify" as const,
          path: "README.md",
          beforeSha256: before.sha256,
          contentBase64: first.toString("base64"),
          mode: before.mode,
          sha256: sha256(first),
          size: first.length,
        },
        {
          op: "modify" as const,
          path: "README.md",
          beforeSha256: before.sha256,
          contentBase64: second.toString("base64"),
          mode: before.mode,
          sha256: sha256(second),
          size: second.length,
        },
      ],
    };

    await expect(applyChangeSetToWorkspace({ sourceRoot, baseline, changeSet, confirmed: true })).rejects.toThrow(
      /duplicate|conflict/i,
    );
    await expect(fs.readFile(path.join(sourceRoot, "README.md"), "utf-8")).resolves.toBe("before");
  });

  it("binds ChangeSets to the exact baseline before applying", async () => {
    const root = await tempDir("pi-fusion-baseline-binding");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "before");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });
    await writeSandboxFile(sandbox, "README.md", "after");
    const changeSet = await buildChangeSet({ baseline, sandbox });

    expect((changeSet as { baselineSha256?: string }).baselineSha256).toMatch(/^[a-f0-9]{64}$/);
    const forged = { ...changeSet, baselineSha256: "0".repeat(64) };

    await expect(applyChangeSetToWorkspace({ sourceRoot, baseline, changeSet: forged, confirmed: true })).rejects.toThrow(
      /baseline/i,
    );
    await expect(fs.readFile(path.join(sourceRoot, "README.md"), "utf-8")).resolves.toBe("before");
  });

  it("never applies a ChangeSet to the real workspace without explicit confirmation", async () => {
    const root = await tempDir("pi-fusion-no-confirm");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "before");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });
    await writeSandboxFile(sandbox, "README.md", "after");
    const changeSet = await buildChangeSet({ baseline, sandbox });

    await expect(applyChangeSetToWorkspace({ sourceRoot, baseline, changeSet, confirmed: false })).rejects.toThrow(/confirmation/i);
    await expect(fs.readFile(path.join(sourceRoot, "README.md"), "utf-8")).resolves.toBe("before");
  });

  it("fails preflight when the real workspace drifted from the baseline", async () => {
    const root = await tempDir("pi-fusion-drift");
    const sourceRoot = path.join(root, "source");
    await writeFile(path.join(sourceRoot, "README.md"), "before");

    const baseline = await createWorkspaceBaseline({ sourceRoot, baselineRoot: path.join(root, "baseline") });
    const sandbox = await createWorkspaceSandbox({ baseline, sandboxRoot: path.join(root, "sandbox"), sandboxId: "p1" });
    await writeSandboxFile(sandbox, "README.md", "participant edit");
    const changeSet = await buildChangeSet({ baseline, sandbox });

    await fs.writeFile(path.join(sourceRoot, "README.md"), "user changed after baseline", "utf-8");
    await expect(applyChangeSetToWorkspace({ sourceRoot, baseline, changeSet, confirmed: true })).rejects.toThrow(/drift/i);
    await expect(fs.readFile(path.join(sourceRoot, "README.md"), "utf-8")).resolves.toBe("user changed after baseline");
  });

  it("imports external evidence by copying, hashing, and making the copy read-only", async () => {
    const root = await tempDir("pi-fusion-external-evidence");
    const source = path.join(root, "handoff.md");
    await writeFile(source, "handoff content");

    const imported = await importExternalEvidence({ sourcePath: source, evidenceRoot: path.join(root, "evidence") });

    expect(imported.modelPath).toBe("__external__/handoff.md");
    expect(imported.sha256).toMatch(/^[a-f0-9]{64}$/);
    await expect(fs.readFile(imported.sandboxPath, "utf-8")).resolves.toBe("handoff content");
    const mode = (await fs.stat(imported.sandboxPath)).mode & 0o777;
    expect(mode & 0o222).toBe(0);
    expect(JSON.stringify(imported)).not.toContain(source);
  });
});
