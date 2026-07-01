import { describe, expect, it } from "vitest";
import { formatSandboxBashResult, runSandboxedBash, validateSandboxBashCommand } from "../src/bash.js";

describe("sandboxed bash", () => {
  it("allows deterministic calculations", async () => {
    const result = await runSandboxedBash("python3 - <<'PY'\nprint(12.3 + 4.5)\nPY");
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("16.8");
  });

  it("rejects network commands", () => {
    expect(validateSandboxBashCommand("curl https://example.com")).toMatch(/network/i);
  });

  it("rejects sensitive local paths", () => {
    expect(validateSandboxBashCommand("python3 - <<'PY'\nprint('/workspace/.pi/agent/auth.json')\nPY")).toMatch(/sensitive/i);
  });

  it("rejects filesystem mutation", () => {
    expect(validateSandboxBashCommand("rm -rf /tmp/example")).toMatch(/filesystem/i);
  });

  it("formats stdout and stderr", () => {
    expect(formatSandboxBashResult({ stdout: "ok", stderr: "", exitCode: 0, timedOut: false })).toContain("stdout:\nok");
  });
});
