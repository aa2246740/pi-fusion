import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ArtifactWriter } from "../src/artifacts.js";
import type { FusionResult, StructuredJudgeAnalysis } from "../src/types.js";

const MOCK_RESULT: FusionResult = {
  finalAnswer: "The best approach is X because Y.",
  judgeAnalysis: {
    consensus: ["Both agree X is best"],
    contradictions: [],
    coverageGaps: [],
    uniqueInsights: [],
    blindSpots: [],
    sourceConfidence: [],
  },
  judgeVerification: {
    unsupportedClaims: [],
    missingContradictions: [],
    citationIssues: [],
    remainingCaveats: [],
    pass: true,
  },
  participants: [
    { state: "success", slotIndex: 0, output: { slotIndex: 0, model: "openai/gpt-4.1", answer: "Answer 1", evidence: [], tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }, cost: 0.01 } },
    { state: "success", slotIndex: 1, output: { slotIndex: 1, model: "anthropic/claude-sonnet-4-5", answer: "Answer 2", evidence: [], tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 }, cost: 0.02 } },
  ],
  evidence: { totalEntries: 0, sources: [] },
  artifactsPath: "",
  mode: "quality",
  totalCost: 0.03,
  totalTokens: { input: 200, output: 400, cacheRead: 0, cacheWrite: 0 },
};

describe("ArtifactWriter", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-artifacts-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("writes all artifact files", async () => {
    const writer = new ArtifactWriter(tmpDir);
    const artifactsPath = await writer.write(MOCK_RESULT);

    expect(artifactsPath).toBeTruthy();

    // Check files exist
    const finalAnswer = await fs.readFile(path.join(artifactsPath, "final-answer.md"), "utf-8");
    expect(finalAnswer).toContain("The best approach is X");

    const analysisJson = await fs.readFile(path.join(artifactsPath, "judge-analysis.json"), "utf-8");
    const analysis = JSON.parse(analysisJson);
    expect(analysis.consensus).toContain("Both agree X is best");

    const verification = await fs.readFile(path.join(artifactsPath, "judge-verification.json"), "utf-8");
    expect(JSON.parse(verification).pass).toBe(true);

    const runMeta = await fs.readFile(path.join(artifactsPath, "run.json"), "utf-8");
    const meta = JSON.parse(runMeta);
    expect(meta.mode).toBe("quality");
    expect(meta.totalCost).toBe(0.03);

    // Check participant files
    const p1 = await fs.readFile(path.join(artifactsPath, "participant-1.md"), "utf-8");
    expect(p1).toContain("Answer 1");

    const p2 = await fs.readFile(path.join(artifactsPath, "participant-2.md"), "utf-8");
    expect(p2).toContain("Answer 2");
  });

  it("generates unique run directory names", async () => {
    const writer = new ArtifactWriter(tmpDir);
    const path1 = await writer.write(MOCK_RESULT);
    const path2 = await writer.write(MOCK_RESULT);
    expect(path1).not.toBe(path2);
  });

  it("includes error info for failed participants", async () => {
    const result: FusionResult = {
      ...MOCK_RESULT,
      participants: [
        { state: "failed", slotIndex: 0, error: "429 rate limited", errorType: "rate_limit" },
        { state: "skipped", slotIndex: 1, reason: "User skipped after failure" },
      ],
    };
    const writer = new ArtifactWriter(tmpDir);
    const artifactsPath = await writer.write(result);

    const p1 = await fs.readFile(path.join(artifactsPath, "participant-1.md"), "utf-8");
    expect(p1).toContain("FAILED");
    expect(p1).toContain("429 rate limited");

    const p2 = await fs.readFile(path.join(artifactsPath, "participant-2.md"), "utf-8");
    expect(p2).toContain("SKIPPED");
  });
});
