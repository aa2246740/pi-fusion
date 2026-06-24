import { describe, expect, it } from "vitest";
import { ObligationPlanner, formatObligationPlanForModel } from "../src/obligations.js";
import type { ModelCaller } from "../src/types.js";

describe("ObligationPlanner", () => {
  it("parses and normalizes prompt-derived obligations", async () => {
    const caller: ModelCaller = {
      async call(request) {
        expect(request.systemPrompt).toContain("[PHASE: PLAN]");
        expect(request.systemPrompt).toContain("source-retrieval friendly");
        expect(request.systemPrompt).toContain("prompt-named source systems");
        expect(request.tools).toBeUndefined();
        return {
          answer: JSON.stringify({
            obligations: [{
              id: "core-margin",
              kind: "calculation",
              description: "Calculate Retail Segment operating margin",
              entities: ["Retail Segment"],
              timePeriod: "Q1 2024",
              expectedEvidence: ["revenue", "operating income"],
              preferredSourceTypes: ["official filing"],
            }],
            notes: ["Use only the prompt"],
          }),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };

    const planner = new ObligationPlanner(caller, "judge/model");
    const plan = await planner.plan("Calculate Q1 2024 Retail Segment margin");

    expect(plan.obligations).toHaveLength(1);
    expect(plan.obligations[0].id).toBe("core-margin");
    expect(plan.obligations[0].status).toBe("unknown");
  });

  it("formats obligations for participants and judge without treating them as answer keys", () => {
    const text = formatObligationPlanForModel({
      obligations: [{
        id: "metric-1",
        kind: "metric",
        description: "Find metric from source",
        preferredSourceTypes: ["official filing"],
      }],
    });

    expect(text).toContain("Internal Fusion Requirement Checklist");
    expect(text).toContain("not an answer key or benchmark rubric");
    expect(text).toContain("metric-1");
  });
});
