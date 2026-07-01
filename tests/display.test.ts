import { describe, expect, it } from "vitest";
import { formatFusionDisplayResult } from "../src/display.js";
import type { FusionResult } from "../src/types.js";

function makeResult(): FusionResult {
  return {
    finalAnswer: "SYNTHESIZED FINAL ANSWER",
    judgeAnalysis: {
      consensus: ["INTERNAL CONSENSUS SHOULD STAY OUT"],
      contradictions: [{
        topic: "INTERNAL CONTRADICTION TOPIC",
        stances: [{ slotIndex: 0, stance: "INTERNAL STANCE" }],
      }],
      coverageGaps: ["INTERNAL COVERAGE GAP"],
      uniqueInsights: [{ slotIndex: 1, insight: "INTERNAL UNIQUE INSIGHT" }],
      blindSpots: ["INTERNAL BLIND SPOT"],
      sourceConfidence: [{
        claim: "INTERNAL CLAIM",
        supportedBy: ["web-1"],
        confidence: "medium",
      }],
    },
    judgeVerification: {
      unsupportedClaims: ["INTERNAL UNSUPPORTED CLAIM"],
      missingContradictions: ["INTERNAL MISSING CONTRADICTION"],
      citationIssues: ["INTERNAL CITATION ISSUE"],
      remainingCaveats: ["INTERNAL CAVEAT"],
      pass: false,
    },
    participants: [
      {
        state: "success",
        slotIndex: 0,
        output: {
          slotIndex: 0,
          model: "provider/model-a",
          answer: "INTERNAL PARTICIPANT ANSWER",
          evidence: [],
          tokens: { input: 11, output: 22, cacheRead: 0, cacheWrite: 0 },
          cost: 0.01,
        },
      },
      {
        state: "skipped",
        slotIndex: 1,
        reason: "INTERNAL SKIP REASON",
      },
    ],
    evidence: {
      totalEntries: 1,
      sources: [{
        id: "web-1",
        source: "web_search",
        title: "INTERNAL SOURCE TITLE",
        url: "https://example.com/internal-source",
        usedBySlots: [0],
      }],
    },
    workspace: {
      enabled: true,
      sourceRoot: "/Users/example/private/source",
      root: "/Users/example/private/sandboxes",
      baselineSha256: "abc123",
      fileCount: 12,
      skippedCount: 3,
      participantCount: 2,
    },
    artifactsPath: "/Users/example/private/runs/2026-06-29-test",
    mode: "quality",
    totalCost: 0.123456,
    totalTokens: { input: 111, output: 222, cacheRead: 0, cacheWrite: 0 },
  };
}

describe("formatFusionDisplayResult", () => {
  it("shows the synthesized answer and keeps judge diagnostics in artifacts/details", () => {
    delete process.env.PI_FUSION_PRINT_RUN_DIRECTORY;
    const content = formatFusionDisplayResult(makeResult());

    expect(content).toContain("SYNTHESIZED FINAL ANSWER");
    expect(content).toContain("## Run Summary");
    expect(content).toContain("| Participants | 1/2 success, 1 skipped |");
    expect(content).toContain("| Judge verification | Needs review; see artifacts |");
    expect(content).toContain("saved as artifacts/details");

    expect(content).not.toContain("## Structured Judge Analysis");
    expect(content).not.toContain("## Judge Verification");
    expect(content).not.toContain("INTERNAL CONSENSUS SHOULD STAY OUT");
    expect(content).not.toContain("INTERNAL UNSUPPORTED CLAIM");
    expect(content).not.toContain("INTERNAL PARTICIPANT ANSWER");
    expect(content).not.toContain("INTERNAL SOURCE TITLE");
    expect(content).not.toContain("https://example.com/internal-source");
    expect(content).not.toContain("/Users/example/private");
  });

  it("can print a machine-readable run directory for local benchmark automation", () => {
    const previous = process.env.PI_FUSION_PRINT_RUN_DIRECTORY;
    process.env.PI_FUSION_PRINT_RUN_DIRECTORY = "1";
    try {
      const content = formatFusionDisplayResult(makeResult());
      expect(content).toContain("Run directory: /Users/example/private/runs/2026-06-29-test");
    } finally {
      if (previous === undefined) delete process.env.PI_FUSION_PRINT_RUN_DIRECTORY;
      else process.env.PI_FUSION_PRINT_RUN_DIRECTORY = previous;
    }
  });
});
