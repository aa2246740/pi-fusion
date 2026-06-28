import { describe, it, expect, vi } from "vitest";
import { JudgeRunner } from "../src/judge.js";
import type { ModelCaller, ParticipantOutput, EvidencePool, StructuredJudgeAnalysis, JudgeVerification } from "../src/types.js";

const MOCK_ANALYSIS: StructuredJudgeAnalysis = {
  consensus: ["Both models agree X is true"],
  contradictions: [{ topic: "Y", stances: [{ slotIndex: 0, stance: "yes" }, { slotIndex: 1, stance: "no" }] }],
  coverageGaps: ["Neither covered Z"],
  uniqueInsights: [{ slotIndex: 0, insight: "Only model A mentioned W" }],
  blindSpots: ["Risk R was missed"],
  sourceConfidence: [{ claim: "X is true", supportedBy: ["ev1"], confidence: "high" }],
};

const MOCK_VERIFICATION_PASS: JudgeVerification = {
  unsupportedClaims: [],
  missingContradictions: [],
  citationIssues: [],
  remainingCaveats: [],
  pass: true,
};

const MOCK_VERIFICATION_FAIL: JudgeVerification = {
  unsupportedClaims: ["Claim about Z has no source"],
  missingContradictions: [],
  citationIssues: ["[1] does not support claim about W"],
  remainingCaveats: ["Uncertain about R"],
  pass: false,
};

function makeFakeCaller(responses: Record<string, string>): ModelCaller {
  return {
    async call(request) {
      // Detect phase by PHASE marker
      const sys = request.systemPrompt;
      let key = "unknown";
      if (sys.includes("[PHASE: ANALYSIS]")) key = "analysis";
      else if (sys.includes("[PHASE: DRAFT]")) key = "draft";
      else if (sys.includes("[PHASE: VERIFY]")) key = "verify";
      else if (sys.includes("[PHASE: REVISE]")) key = "revise";

      return {
        answer: responses[key] ?? JSON.stringify({ error: `no response for ${key}` }),
        model: request.model,
        tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      };
    },
  };
}

const PARTICIPANTS: ParticipantOutput[] = [
  {
    slotIndex: 0,
    model: "openai/gpt-4.1",
    answer: "Answer from GPT: X is true, Y is maybe",
    evidence: [],
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    cost: 0.01,
  },
  {
    slotIndex: 1,
    model: "anthropic/claude-sonnet-4-5",
    answer: "Answer from Claude: X is true, Y is no",
    evidence: [],
    tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
    cost: 0.02,
  },
];

const EMPTY_EVIDENCE: EvidencePool = { entries: [] };

describe("JudgeRunner", () => {
  it("produces structured analysis from participant outputs", async () => {
    const caller = makeFakeCaller({
      analysis: JSON.stringify(MOCK_ANALYSIS),
    });
    const judge = new JudgeRunner(caller, "test-model");
    const analysis = await judge.analyze("test prompt", PARTICIPANTS, EMPTY_EVIDENCE);

    expect(analysis.consensus).toContain("Both models agree X is true");
    expect(analysis.contradictions).toHaveLength(1);
    expect(analysis.coverageGaps).toContain("Neither covered Z");
  });

  it("drafts answer from analysis", async () => {
    const caller = makeFakeCaller({
      draft: "Final drafted answer based on analysis",
    });
    const judge = new JudgeRunner(caller, "test-model");
    const draft = await judge.draft("test prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);

    expect(draft).toBe("Final drafted answer based on analysis");
  });

  it("verifies draft against analysis and evidence", async () => {
    const caller = makeFakeCaller({
      verify: JSON.stringify(MOCK_VERIFICATION_PASS),
    });
    const judge = new JudgeRunner(caller, "test-model");
    const verification = await judge.verify("draft text", MOCK_ANALYSIS, EMPTY_EVIDENCE);

    expect(verification).toBeDefined();
    expect(verification.pass).toBe(true);
    expect(verification.unsupportedClaims).toHaveLength(0);
  });

  it("revises draft when verification fails", async () => {
    const caller = makeFakeCaller({
      revise: "Revised answer that fixes issues",
    });
    const judge = new JudgeRunner(caller, "test-model");
    const revised = await judge.revise("original draft", MOCK_VERIFICATION_FAIL);

    expect(revised).toBe("Revised answer that fixes issues");
  });

  it("treats draft and revise as private-analysis synthesis phases", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        const answer = request.systemPrompt.includes("[PHASE: REVISE]")
          ? "Revised user-facing answer"
          : "Draft user-facing answer";
        return {
          answer,
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model");

    await judge.draft("test prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("final synthesizer");
    expect(combined).toContain("private scaffolding");
    expect(combined).toContain("Do not render the judge report itself");
    expect(combined).toContain("Return only the revised user-facing answer");
    expect(combined).toContain("Structured Judge Analysis");
    expect(combined).toContain("Judge Verification");
    expect(combined).toContain("Participants");
    expect(combined).toContain("Artifacts");
  });

  it("runs full quality mode pipeline", async () => {
    const caller = makeFakeCaller({
      analysis: JSON.stringify(MOCK_ANALYSIS),
      draft: "Drafted answer",
      verify: JSON.stringify(MOCK_VERIFICATION_FAIL),
      revise: "Revised and improved answer",
    });
    const judge = new JudgeRunner(caller, "test-model");

    const analysis = await judge.analyze("prompt", PARTICIPANTS, EMPTY_EVIDENCE);
    const draft = await judge.draft("prompt", analysis, PARTICIPANTS, EMPTY_EVIDENCE);
    const verification = await judge.verify(draft, analysis, EMPTY_EVIDENCE);
    const final_ = await judge.revise(draft, verification);

    expect(analysis.consensus).toBeDefined();
    expect(draft).toBe("Drafted answer");
    expect(verification.pass).toBe(false);
    expect(final_).toBe("Revised and improved answer");
  });

  it("runs fast mode pipeline (no verify/revise)", async () => {
    const caller = makeFakeCaller({
      analysis: JSON.stringify(MOCK_ANALYSIS),
      draft: "Direct final answer",
    });
    const judge = new JudgeRunner(caller, "test-model");

    const analysis = await judge.analyze("prompt", PARTICIPANTS, EMPTY_EVIDENCE);
    const final_ = await judge.draft("prompt", analysis, PARTICIPANTS, EMPTY_EVIDENCE);

    expect(analysis).toBeDefined();
    expect(final_).toBe("Direct final answer");
    // Fast mode: no verify/revise calls
  });

  it("includes public-health numeric extraction guidance in judge prompts", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        return {
          answer: request.systemPrompt.includes("[PHASE: VERIFY]") ? JSON.stringify(MOCK_VERIFICATION_PASS) : "Recovered notes",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- compare public-health service metrics");

    await judge.recoverObligations("health service prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("health service prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("coverage rates");
    expect(combined).toContain("mortality rates");
    expect(combined).toContain("workforce/capacity");
    expect(combined).toContain("referral");
    expect(combined).toContain("numerator/denominator");
    expect(combined).toContain("compact evidence ledger");
    expect(combined).toContain("remaining gap");
    expect(combined).toContain("Do not invent derived ratios/rates");
    expect(combined).toContain("numerator, denominator, unit, period, and method");
    expect(combined).toContain("not retrieved in this run");
    expect(combined).toContain("blanket data-unavailable claim");
  });

  it("preserves compact full focused excerpts for fetched evidence in judge prompts", async () => {
    const userMessages: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        userMessages.push(request.messages.map((m) => m.content).join("\n"));
        return {
          answer: JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const evidence: EvidencePool = {
      entries: [{
        id: "ev-fetch",
        source: "web_fetch",
        url: "https://example.com/report",
        title: "Fetched Report",
        snippet: "[focused excerpts for: metric]\n--- excerpt around \"metric\" ---\nfirst short excerpt",
        fullContent: [
          "[focused excerpts for: metric]",
          "--- excerpt around \"metric\" at char 0-100 ---\nfirst short excerpt",
          "--- excerpt around \"rate\" at char 1000-1200 ---\nsecond source-bound numeric excerpt",
          "--- excerpt around \"pipeline\" at char 2000-2200 ---\nthird implementation excerpt",
        ].join("\n"),
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      }],
    };
    const judge = new JudgeRunner(caller, "test-model");

    await judge.analyze("prompt", PARTICIPANTS, evidence);

    const promptText = userMessages.join("\n");
    expect(promptText).toContain("first short excerpt");
    expect(promptText).toContain("second source-bound numeric excerpt");
    expect(promptText).toContain("third implementation excerpt");
  });

  it("includes generic product/procurement source-binding guidance in judge prompts", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        return {
          answer: request.systemPrompt.includes("[PHASE: VERIFY]") ? JSON.stringify(MOCK_VERIFICATION_PASS) : JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- compare vendors and lifecycle costs");

    await judge.analyze("Compare two equipment vendors for procurement", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Compare two equipment vendors for procurement", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Compare two equipment vendors for procurement", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("product/procurement/vendor comparisons");
    expect(combined).toContain("regional warranty/support terms");
    expect(combined).toContain("application/workload requirements");
    expect(combined).toContain("independent thermal/performance/serviceability evidence");
    expect(combined).toContain("source IDs or URLs");
    expect(combined).toContain("do not invent missing values");
    expect(combined).toContain("compact matrix");
    expect(combined).toContain("lifecycle or support implications");
    expect(combined).toContain("verification actions");
  });

  it("includes generic personal-finance/tax-planning source and structure guidance", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        return {
          answer: request.systemPrompt.includes("[PHASE: VERIFY]") ? JSON.stringify(MOCK_VERIFICATION_PASS) : JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch", "bash"], "## Checklist\n- compare account rules and tax consequences");

    await judge.analyze("Create a tax-efficient retirement and education-funding plan", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Create a tax-efficient retirement and education-funding plan", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Create a tax-efficient retirement and education-funding plan", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("personal-finance, tax-planning");
    expect(combined).toContain("account rules and limits");
    expect(combined).toContain("benefit/grant formulas");
    expect(combined).toContain("jurisdiction/current-year context");
    expect(combined).toContain("Use bash for explicit arithmetic");
    expect(combined).toContain("registered account sequencing");
    expect(combined).toContain("action checklist");
    expect(combined).toContain("do not invent current-year numbers");
  });

  it("includes generic affiliate/referral source-use and layer guidance", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        return {
          answer: request.systemPrompt.includes("[PHASE: VERIFY]") ? JSON.stringify(MOCK_VERIFICATION_PASS) : JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- compare direct provider and referral marketplace layers");

    await judge.analyze("Analyze an affiliate referral partnership strategy", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Analyze an affiliate referral partnership strategy", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Analyze an affiliate referral partnership strategy", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("affiliate, referral, marketplace");
    expect(combined).toContain("who performs the underlying service");
    expect(combined).toContain("licensing/compliance/underwriting/customer servicing");
    expect(combined).toContain("official program, publisher, partner");
    expect(combined).toContain("direct versus partner-delivered");
    expect(combined).toContain("customer data/lead flow");
    expect(combined).toContain("displacement risk");
  });

  it("includes evidence URLs in judge phase prompts", async () => {
    const userMessages: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        userMessages.push(request.messages.map((m) => m.content).join("\n"));
        return {
          answer: JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const evidence: EvidencePool = {
      entries: [{
        id: "ev-url",
        source: "web_search",
        url: "https://example.com/source",
        title: "Example Source",
        snippet: "useful snippet",
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      }],
    };
    const judge = new JudgeRunner(caller, "test-model");

    await judge.analyze("prompt", PARTICIPANTS, evidence);

    expect(userMessages.join("\n")).toContain("Example Source (https://example.com/source)");
  });

  it("includes participant workspace changed files in judge prompts", async () => {
    const userMessages: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        userMessages.push(request.messages.map((m) => m.content).join("\n"));
        return {
          answer: JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const participants: ParticipantOutput[] = [{
      ...PARTICIPANTS[0],
      workspace: {
        sandboxId: "p1",
        root: "/tmp/pi-fusion/p1",
        sourceRoot: "/tmp/project",
        baselineSha256: "a".repeat(64),
        fileCount: 2,
        skippedCount: 1,
        changedFiles: [
          { op: "modify", path: "src/app.ts", size: 120 },
          { op: "add", path: "notes/plan.md", size: 40 },
        ],
      },
    }];
    const judge = new JudgeRunner(caller, "test-model");

    await judge.analyze("prompt", participants, EMPTY_EVIDENCE);

    const promptText = userMessages.join("\n");
    expect(promptText).toContain("Workspace Sandbox");
    expect(promptText).toContain("Sandbox: p1");
    expect(promptText).toContain("modify src/app.ts (120 bytes)");
    expect(promptText).toContain("add notes/plan.md (40 bytes)");
  });

  it("passes configured tools to judge phases and merges judge evidence", async () => {
    const calls: Array<{ tools?: string[]; judge?: boolean }> = [];
    const caller: ModelCaller = {
      async call(request) {
        calls.push({ tools: request.tools, judge: request.toolContext?.judge });
        return {
          answer: JSON.stringify(MOCK_ANALYSIS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          evidence: [{
            id: "judge-ev",
            source: "web_fetch",
            url: "https://example.com",
            title: "Example",
            snippet: "judge evidence",
            participantSlotIndex: -1,
            fetchedAt: Date.now(),
          }],
        };
      },
    };
    const evidence: EvidencePool = { entries: [] };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch", "bash"]);

    await judge.analyze("prompt", PARTICIPANTS, evidence);

    expect(calls[0].tools).toEqual(["web_search", "web_fetch", "bash"]);
    expect(calls[0].judge).toBe(true);
    expect(evidence.entries.map((e) => e.id)).toContain("judge-ev");
  });
});
