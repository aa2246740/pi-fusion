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

  it("augments complex corporate filing plans with adjacent finance coverage obligations", async () => {
    const caller: ModelCaller = {
      async call(request) {
        return {
          answer: JSON.stringify({
            obligations: [{
              id: "term-loan-drawdown",
              kind: "metric",
              description: "Identify the 2025 term loan drawdown and Renaissance principal paydown",
              entities: ["Acadia", "Renaissance Portfolio"],
              timePeriod: "2025",
              expectedEvidence: ["term loan drawdown", "principal paydown"],
              preferredSourceTypes: ["SEC filings"],
            }],
          }),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const planner = new ObligationPlanner(caller, "judge/model");

    const plan = await planner.plan("Analyze whether Acadia's evolving REIT portfolio strategy demonstrates effective capital allocation and risk management using SEC filings, including term loan drawdown, impairments, and equity financing.");
    const text = formatObligationPlanForModel(plan);

    expect(text).toContain("latest-segment-trend-deltas");
    expect(text).toContain("segment revenue or rental revenue changes");
    expect(text).toContain("term-loan-commitment-vs-drawn-net-debt");
    expect(text).toContain("total committed or gross term-loan facility amount");
    expect(text).toContain("latest-period named property/loan principal paydown");
    expect(text).toContain("old-versus-new loan rate/spread");
    expect(text).toContain("basis-point or dollar delta");
    expect(text).toContain("equity-issuance-atm-aggregate");
    expect(text).toContain("latest-period outstanding forward-sale share count");
    expect(text).toContain("total issued-or-forward-sale exposure");
    expect(text).toContain("strategy-risk-context-factors");
    expect(text).toContain("ownership, minority-control, noncontrolling-interest");
    expect(text).toContain("strategy-mechanism-and-capital-mix");
    expect(text).toContain("debt-to-total-capital");
    expect(text).toContain("company-share percentage");
    expect(text).toContain("decision-rights");
    expect(text).toContain("timing urgency or capital-velocity");
    expect(text).toContain("multi-driver segment deterioration");
    expect(text).toContain("not an answer key or benchmark rubric");
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
