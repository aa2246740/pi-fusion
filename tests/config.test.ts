import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ConfigManager } from "../src/config.js";
import type { GlobalFusionConfig } from "../src/types.js";

const VALID_CONFIG: GlobalFusionConfig = {
  participants: [
    { model: "anthropic/claude-sonnet-4-5" },
    { model: "openai/gpt-4.1" },
  ],
  judge: { model: "anthropic/claude-opus-4-5" },
  defaultFallbacks: ["google/gemini-2.5-flash"],
  webPolicy: "optional",
  monitorDefault: false,
  confirmBeforeRun: true,
};

describe("ConfigManager", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reports non-existent config", async () => {
    const mgr = new ConfigManager(tmpDir);
    expect(await mgr.exists()).toBe(false);
  });

  it("saves and loads a valid config", async () => {
    const mgr = new ConfigManager(tmpDir);
    await mgr.save(VALID_CONFIG);

    expect(await mgr.exists()).toBe(true);
    const loaded = await mgr.load();
    expect(loaded).toEqual(VALID_CONFIG);
  });

  it("rejects config with no participants", async () => {
    const mgr = new ConfigManager(tmpDir);
    const bad = { ...VALID_CONFIG, participants: [] };
    await expect(mgr.save(bad)).rejects.toThrow(/participant/i);
  });

  it("rejects config with participant missing model", async () => {
    const mgr = new ConfigManager(tmpDir);
    const bad = { ...VALID_CONFIG, participants: [{ model: "" }] };
    await expect(mgr.save(bad)).rejects.toThrow(/model/i);
  });

  it("rejects config with judge missing model", async () => {
    const mgr = new ConfigManager(tmpDir);
    const bad = { ...VALID_CONFIG, judge: { model: "" } };
    await expect(mgr.save(bad)).rejects.toThrow(/model/i);
  });

  it("rejects invalid web policy", async () => {
    const mgr = new ConfigManager(tmpDir);
    const bad = { ...VALID_CONFIG, webPolicy: "aggressive" as any };
    await expect(mgr.save(bad)).rejects.toThrow(/webPolicy/i);
  });

  it("loads config with optional fields defaulted", async () => {
    const mgr = new ConfigManager(tmpDir);
    const minimal = {
      participants: [{ model: "openai/gpt-4.1" }],
      judge: { model: "openai/gpt-4.1" },
    };
    await mgr.saveRaw(JSON.stringify(minimal));
    const loaded = await mgr.load();
    expect(loaded.defaultFallbacks).toEqual([]);
    expect(loaded.webPolicy).toBe("optional");
    expect(loaded.monitorDefault).toBe(false);
    expect(loaded.confirmBeforeRun).toBe(true);
  });

  it("supports per-slot fallbacks", async () => {
    const mgr = new ConfigManager(tmpDir);
    const config: GlobalFusionConfig = {
      ...VALID_CONFIG,
      participants: [
        { model: "anthropic/claude-sonnet-4-5", fallbacks: ["openai/gpt-4.1"] },
        { model: "google/gemini-2.5-pro" },
      ],
    };
    await mgr.save(config);
    const loaded = await mgr.load();
    expect(loaded.participants[0].fallbacks).toEqual(["openai/gpt-4.1"]);
    expect(loaded.participants[1].fallbacks).toBeUndefined();
  });

  it("supports sandboxed bash tool policy", async () => {
    const mgr = new ConfigManager(tmpDir);
    await mgr.save({ ...VALID_CONFIG, toolPolicy: { bash: "sandboxed" } });
    const loaded = await mgr.load();
    expect(loaded.toolPolicy?.bash).toBe("sandboxed");
  });

  it("rejects invalid bash tool policy", async () => {
    const mgr = new ConfigManager(tmpDir);
    await expect(mgr.saveRaw(JSON.stringify({ ...VALID_CONFIG, toolPolicy: { bash: "raw" } }))).rejects.toThrow(/toolPolicy\.bash/i);
  });
});
