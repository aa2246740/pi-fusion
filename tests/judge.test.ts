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
      else if (sys.includes("[PHASE: VERIFY_REPAIR]")) key = "repair";
      else if (sys.includes("[PHASE: VERIFY]")) key = "verify";
      else if (sys.includes("[PHASE: REVISE]")) key = "revise";
      else if (sys.includes("[PHASE: FINAL_HARDEN]")) key = "harden";

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

  it("requires source-heavy verification to fail on omitted material candidate facts", async () => {
    const systemPrompts: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        return {
          answer: JSON.stringify(MOCK_VERIFICATION_PASS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- financing mix\n- segment trend");

    await judge.verify("draft text", MOCK_ANALYSIS, EMPTY_EVIDENCE, "Recovery notes with a rate spread candidate", PARTICIPANTS);

    const verifyPrompt = systemPrompts.join("\n");
    expect(verifyPrompt).toContain("remainingCaveats: string[] (must include any material source-backed candidate fact");
    expect(verifyPrompt).toContain("pass=true is only valid after the draft includes or explicitly rejects every material candidate fact family");
    expect(verifyPrompt).toContain("equity/forward-sale proceeds or settlements");
    expect(verifyPrompt).toContain("segment trend deltas");
    expect(verifyPrompt).toContain("omits the explicit caveated aggregate");
    expect(verifyPrompt).toContain("named property/loan debt-table row");
    expect(verifyPrompt).toContain("issued/forward-sale exposure total");
    expect(verifyPrompt).toContain("timing urgency/capital velocity");
    expect(verifyPrompt).toContain("capital-mix ratio");
    expect(verifyPrompt).toContain("basis-point or dollar delta");
    expect(verifyPrompt).toContain("company-share percentage");
    expect(verifyPrompt).toContain("participant-backed causal insights");
  });

  it("revises draft when verification fails", async () => {
    const caller = makeFakeCaller({
      revise: "Revised answer that fixes issues",
    });
    const judge = new JudgeRunner(caller, "test-model");
    const revised = await judge.revise("original draft", MOCK_VERIFICATION_FAIL);

    expect(revised).toBe("Revised answer that fixes issues");
  });

  it("hardens final answers by integrating remaining verification issues", async () => {
    const calls: Array<{ tools?: string[]; content: string; systemPrompt: string }> = [];
    const caller: ModelCaller = {
      async call(request) {
        calls.push({
          tools: request.tools,
          content: request.messages.map((m) => m.content).join("\n"),
          systemPrompt: request.systemPrompt,
        });
        return {
          answer: "Hardened answer with requested-item ledger",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- exact finance item");

    const hardened = await judge.hardenWithVerificationIssues(
      "Current answer",
      MOCK_VERIFICATION_FAIL,
      "finance prompt",
      EMPTY_EVIDENCE,
      "Recovery notes",
      MOCK_ANALYSIS,
      PARTICIPANTS,
    );

    expect(hardened).toContain("Hardened answer");
    expect(calls[0].systemPrompt).toContain("[PHASE: FINAL_HARDEN]");
    expect(calls[0].systemPrompt).toContain("integrate the listed verification issues into the main answer");
    expect(calls[0].systemPrompt).toContain("requested-item/evidence coverage ledger");
    expect(calls[0].systemPrompt).toContain("Internal Fusion Requirement Checklist");
    expect(calls[0].systemPrompt).toContain("combined cash deployment formula");
    expect(calls[0].systemPrompt).toContain("every issue must be visibly resolved");
    expect(calls[0].systemPrompt).toContain("add that exact aggregate/formula");
    expect(calls[0].systemPrompt).toContain("geographic concentration");
    expect(calls[0].systemPrompt).toContain("capital velocity");
    expect(calls[0].systemPrompt).toContain("fee/AUM decline");
    expect(calls[0].systemPrompt).toContain("combined non-overlapping capital raised/contracted formula");
    expect(calls[0].systemPrompt).toContain("prefer latest-period SEC filing tables");
    expect(calls[0].systemPrompt).toContain("total issued/forward-sale exposure formula");
    expect(calls[0].systemPrompt).toContain("debt-to-total-capital");
    expect(calls[0].systemPrompt).toContain("compute the company-share percentage");
    expect(calls[0].systemPrompt).toContain("basis-point or dollar delta");
    expect(calls[0].systemPrompt).toContain("participant unique insights explain a causal mechanism");
    expect(calls[0].tools).toBeUndefined();
    expect(calls[0].content).toContain("Verification Issues To Integrate Into Main Answer");
    expect(calls[0].content).toContain("Claim about Z has no source");
  });

  it("repairs verification issues with tools before final revision", async () => {
    const calls: Array<{ tools?: string[]; content: string; systemPrompt: string }> = [];
    const caller: ModelCaller = {
      async call(request) {
        calls.push({
          tools: request.tools,
          content: request.messages.map((m) => m.content).join("\n"),
          systemPrompt: request.systemPrompt,
        });
        return {
          answer: "Repair notes with exact sourced value",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
          evidence: [{
            id: "repair-ev",
            source: "web_fetch",
            url: "https://example.com/filing",
            title: "Filing",
            snippet: "exact value",
            participantSlotIndex: -1,
            fetchedAt: Date.now(),
          }],
        };
      },
    };
    const evidence: EvidencePool = { entries: [] };
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch", "bash"], "## Checklist\n- exact term loan amount");

    const notes = await judge.repairVerificationIssues(
      "draft missing term loan",
      MOCK_VERIFICATION_FAIL,
      "finance prompt",
      MOCK_ANALYSIS,
      PARTICIPANTS,
      evidence,
      "Initial recovery notes",
    );

    expect(notes).toContain("Repair notes");
    expect(calls[0].systemPrompt).toContain("[PHASE: VERIFY_REPAIR]");
    expect(calls[0].tools).toEqual(["web_search", "web_fetch", "bash"]);
    expect(calls[0].content).toContain("Verification Issues");
    expect(calls[0].content).toContain("Initial recovery notes");
    expect(evidence.entries.map((entry) => entry.id)).toContain("repair-ev");
  });

  it("treats draft and revise as private-analysis synthesis phases", async () => {
    const systemPrompts: string[] = [];
    const userMessages: string[] = [];
    const toolSets: Array<string[] | undefined> = [];
    const caller: ModelCaller = {
      async call(request) {
        systemPrompts.push(request.systemPrompt);
        userMessages.push(request.messages.map((m) => m.content).join("\n"));
        toolSets.push(request.tools);
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
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"]);

    await judge.draft("test prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL, "test prompt", EMPTY_EVIDENCE, "Recovered notes", MOCK_ANALYSIS, PARTICIPANTS);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("final synthesizer");
    expect(combined).toContain("private scaffolding");
    expect(combined).toContain("Do not render the judge report itself");
    expect(combined).toContain("Return only the revised user-facing answer");
    expect(combined).toContain("Structured Judge Analysis");
    expect(combined).toContain("Judge Verification");
    expect(combined).toContain("Participants");
    expect(combined).toContain("Artifacts");
    expect(userMessages.join("\n")).toContain("Answer from GPT");
    expect(userMessages.join("\n")).toContain("Recovered notes");
    expect(userMessages.join("\n")).toContain("Both models agree X is true");
    expect(combined).toContain("Do not use or request tools during drafting");
    expect(combined).toContain("Do not call tools during revision");
    expect(toolSets).toEqual([undefined, undefined]);
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
    expect(combined).toContain("source-reported ratios only");
    expect(combined).toContain("presumed, likely");
    expect(combined).toContain("structural-model");
    expect(combined).toContain("Mark it unsupported if it calculates public-health workforce ratios");
    expect(combined).toContain("not retrieved in this run");
    expect(combined).toContain("blanket data-unavailable claim");
    expect(combined).toContain("named facilities/programs/referral hospitals");
    expect(combined).toContain("before/after trajectories");
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

  it("keeps later high-signal filing excerpts when compacting fetched evidence", async () => {
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
    const filler = "ordinary filing boilerplate ".repeat(80);
    const lowSignalBlocks = Array.from({ length: 18 }, (_value, index) =>
      `--- excerpt around "boilerplate-${index}" at char ${index * 1000}-${index * 1000 + 900} ---\n${filler}`,
    );
    const evidence: EvidencePool = {
      entries: [{
        id: "ev-sec",
        source: "web_fetch",
        url: "https://example.com/sec-filing",
        title: "SEC Filing",
        snippet: "[focused excerpts for: filing]\n--- excerpt around \"boilerplate\" ---\nordinary filing boilerplate",
        fullContent: [
          "[focused excerpts for: filing]",
          ...lowSignalBlocks,
          "--- excerpt around \"Rental revenue\" at char 22000-22900 ---\nSEC HTML table near \"Rental revenue\": REIT Portfolio Rental revenue increased by 12.1 and Investment Management operating income declined year over year.",
          "--- excerpt around \"ATM Forward Sale Agreements\" at char 23000-23900 ---\nATM Forward Sale Agreements settled forward shares with net proceeds and old-versus-new spread terms.",
        ].join("\n"),
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      }],
    };
    const judge = new JudgeRunner(caller, "test-model");

    await judge.analyze("Analyze a REIT SEC filing", PARTICIPANTS, evidence);

    const promptText = userMessages.join("\n");
    expect(promptText).toContain("REIT Portfolio Rental revenue increased");
    expect(promptText).toContain("Investment Management operating income declined");
    expect(promptText).toContain("ATM Forward Sale Agreements");
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
    expect(combined).toContain("publisher tools/co-branded pages/widgets/deep links");
    expect(combined).toContain("soft-inquiry or prequalification handling");
    expect(combined).toContain("displacement risk");
  });

  it("includes corporate financial-filing extraction and ledger guidance", async () => {
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
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch", "bash"], "## Checklist\n- extract segment revenue, impairment, debt terms, and equity issuance");

    await judge.analyze("Analyze a REIT SEC filing", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Analyze a REIT SEC filing", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Analyze a REIT SEC filing", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL, "Analyze a REIT SEC filing", EMPTY_EVIDENCE, "", MOCK_ANALYSIS, PARTICIPANTS);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("corporate financial-filing");
    expect(combined).toContain("extract exact table values");
    expect(combined).toContain("rates/spreads/maturities");
    expect(combined).toContain("Never summarize around a requested numeric item");
    expect(combined).toContain("requested-item ledger");
    expect(combined).toContain("segment revenue, operating income/margin");
    expect(combined).toContain("impairment owner/property/charge/timing");
    expect(combined).toContain("source-backed adjacent facts");
    expect(combined).toContain("equity issuance/ATM/forward sales");
    expect(combined).toContain("segment trend evidence");
    expect(combined).toContain("geographic or asset concentration");
    expect(combined).toContain("noncontrolling-interest/ownership-share economics");
    expect(combined).toContain("capital-velocity pressure");
    expect(combined).toContain("Narrative notes, MD&A text, footnotes, earnings-supplement pages, and table notes can support property-specific");
    expect(combined).toContain("settled-fact ledger");
    expect(combined).toContain("INCLUDE WITH CAVEAT");
    expect(combined).toContain("specific filing narrative, footnote, participant-cited source, or earnings-supplement table supports the fact");
    expect(combined).toContain("equity issuance/ATM/forward sale/settlement/proceeds");
    expect(combined).toContain("says “not recovered” while recovery, participants, or evidence contains a specific candidate value");
    expect(combined).toContain("old-versus-new spread");
    expect(combined).toContain("forward-settlement proceeds");
    expect(combined).toContain("rental revenue and operating income changes");
    expect(combined).toContain("total committed/gross facility amount");
    expect(combined).toContain("actual-drawn effect and the full-commitment/capacity effect");
    expect(combined).toContain("separate actual cash proceeds already received from outstanding forward-sale aggregate value/net value and unused program capacity");
    expect(combined).toContain("actual cash deployment/outlay formula");
    expect(combined).toContain("prefer the latest retrieved period");
    expect(combined).toContain("latest-period primary SEC filing tables/notes");
    expect(combined).toContain("named property, loan, or equity-program table row");
    expect(combined).toContain("total issued/forward-sale exposure");
    expect(combined).toContain("share total, company-share percentage, implied ownership percentage");
    expect(combined).toContain("cash consideration plus a non-overlapping paydown");
    expect(combined).toContain("latest-period segment trend lines");
    expect(combined).toContain("do not stop at a fact ledger");
    expect(combined).toContain("Each major section should open with a finding sentence");
    expect(combined).toContain("debt-to-total-capital");
    expect(combined).toContain("company-share percentage");
    expect(combined).toContain("basis points or dollars");
    expect(combined).toContain("investor-liquidity pressure");
    expect(combined).toContain("participant unique insights");
    expect(combined).toContain("select the primary answer by matching the user's requested entities, period, and source family first");
    expect(combined).toContain("broader context-only set");
    expect(combined).toContain("do not add earlier quarterly rows or overlapping component rows");
    expect(combined).toContain("absolute delta in percentage points, basis points, or dollars");
    expect(combined).toContain("PRIMARY, CONTEXT ONLY, INCLUDE WITH CAVEAT, or EXCLUDE");
    expect(combined).toContain("guard against double counting overlapping quarterly, year-to-date, and table-total rows");
    expect(combined).toContain("chooses a broader context-only total over a prompt-matched scoped total");
    expect(combined).toContain("privately enumerate the material numeric, source, and causal-mechanism candidates");
    expect(combined).toContain("missing participant-backed candidate facts");
  });

  it("includes ERP UX platform-pattern guidance", async () => {
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
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- compare SAP Fiori and NetSuite workflow patterns");

    await judge.analyze("Compare SAP Fiori and NetSuite ERP UX for work orders and inventory dashboards", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Compare SAP Fiori and NetSuite ERP UX for work orders and inventory dashboards", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Compare SAP Fiori and NetSuite ERP UX for work orders and inventory dashboards", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL, "Compare SAP Fiori and NetSuite ERP UX for work orders and inventory dashboards", EMPTY_EVIDENCE, "", MOCK_ANALYSIS, PARTICIPANTS);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("ERP, enterprise UX");
    expect(combined).toContain("SAP object pages, wizards, launchpad/shell patterns");
    expect(combined).toContain("NetSuite centers/roles/dashboards/global search/Item 360/work-order flows");
    expect(combined).toContain("platform-pattern matrix");
    expect(combined).toContain("adoption speed, ultimate utilization, proficiency");
  });

  it("includes cross-domain research source and answer-structure guidance", async () => {
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
    const judge = new JudgeRunner(caller, "test-model", ["web_search", "web_fetch"], "## Checklist\n- compare legal and medical evidence");

    await judge.analyze("Compare a medical and legal question", PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.recoverObligations("Compare a medical and legal question", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.draft("Compare a medical and legal question", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL, "Compare a medical and legal question", EMPTY_EVIDENCE, "", MOCK_ANALYSIS, PARTICIPANTS);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("clinical guidelines");
    expect(combined).toContain("jurisdiction, date/currentness");
    expect(combined).toContain("methodology, effect sizes");
    expect(combined).toContain("official docs, specs, changelogs");
    expect(combined).toContain("needle-in-a-haystack");
    expect(combined).toContain("short answer or recommendation first");
    expect(combined).toContain("evidence-backed table");
    expect(combined).toContain("Tie decision-critical facts to source IDs/URLs");
    expect(combined).toContain("complete user-facing deliverable");
    expect(combined).toContain("Do not fix verification issues by deleting requested facts");
    expect(combined).toContain("strongest supported or confidence-labeled answer");
    expect(combined).toContain("requested-item coverage table");
    expect(combined).toContain("source or candidate basis");
  });

  it("treats missing requested-item coverage as a verification failure", async () => {
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
    const judge = new JudgeRunner(caller, "test-model", ["web_search"], [
      "## Requirement Checklist",
      "- [metric-1] (metric) Report exact revenue for each segment",
      "- [metric-2] (metric) Report debt terms and maturity",
    ].join("\n"));

    await judge.draft("source-heavy finance prompt", MOCK_ANALYSIS, PARTICIPANTS, EMPTY_EVIDENCE);
    await judge.verify("draft without a coverage table", MOCK_ANALYSIS, EMPTY_EVIDENCE);
    await judge.revise("draft", MOCK_VERIFICATION_FAIL, "source-heavy finance prompt", EMPTY_EVIDENCE, "", MOCK_ANALYSIS, PARTICIPANTS);

    const combined = systemPrompts.join("\n");
    expect(combined).toContain("requested-item coverage table");
    expect(combined).toContain("Set pass=false");
    expect(combined).toContain("any prompt-derived checklist item has no answer/status/source/confidence");
    expect(combined).toContain("blanket unavailable-data caveat");
    expect(combined).toContain("participant answers or recovery notes contain candidate facts");
  });

  it("provides participant candidates to verification", async () => {
    const userMessages: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        userMessages.push(request.messages.map((m) => m.content).join("\n"));
        return {
          answer: JSON.stringify(MOCK_VERIFICATION_PASS),
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const judge = new JudgeRunner(caller, "test-model");

    await judge.verify("draft", MOCK_ANALYSIS, EMPTY_EVIDENCE, "recovery notes", [{
      slotIndex: 0,
      model: "filing-model",
      answer: "Participant candidate: cumulative table total should be primary; additive total is overlap.",
      evidence: [],
      tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
    }]);

    const combined = userMessages.join("\n");
    expect(combined).toContain("## Participant Answers");
    expect(combined).toContain("Participant candidate: cumulative table total should be primary");
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
