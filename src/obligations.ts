import type { FusionObligation, ModelCaller, ObligationPlan } from "./types.js";

function parseJsonResponse<T>(answer: string): T {
  const trimmed = answer.trim();
  const candidates = [trimmed];

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());

  const firstObject = trimmed.indexOf("{");
  const lastObject = trimmed.lastIndexOf("}");
  if (firstObject >= 0 && lastObject > firstObject) {
    candidates.push(trimmed.slice(firstObject, lastObject + 1));
  }

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // Try next candidate.
    }
  }

  throw new Error(`Obligation planner returned invalid JSON: ${answer.slice(0, 200)}`);
}

function normalizePlan(plan: ObligationPlan): ObligationPlan {
  const obligations = Array.isArray(plan.obligations) ? plan.obligations : [];
  return {
    obligations: obligations
      .filter((obligation) => obligation && typeof obligation.description === "string" && obligation.description.trim())
      .slice(0, 36)
      .map((obligation, index) => ({
        id: obligation.id?.trim() || `obligation-${index + 1}`,
        kind: obligation.kind ?? "other",
        description: obligation.description.trim(),
        ...(obligation.entities?.length ? { entities: obligation.entities.slice(0, 8) } : {}),
        ...(obligation.timePeriod ? { timePeriod: obligation.timePeriod } : {}),
        ...(obligation.expectedEvidence?.length ? { expectedEvidence: obligation.expectedEvidence.slice(0, 8) } : {}),
        ...(obligation.preferredSourceTypes?.length ? { preferredSourceTypes: obligation.preferredSourceTypes.slice(0, 8) } : {}),
        status: obligation.status ?? "unknown",
      })),
    ...(Array.isArray(plan.notes) ? { notes: plan.notes.slice(0, 12) } : {}),
  };
}

function combinedPlanText(prompt: string, plan: ObligationPlan): string {
  return [
    prompt,
    ...(plan.notes ?? []),
    ...plan.obligations.flatMap((obligation) => [
      obligation.id,
      obligation.kind,
      obligation.description,
      obligation.timePeriod ?? "",
      ...(obligation.entities ?? []),
      ...(obligation.expectedEvidence ?? []),
      ...(obligation.preferredSourceTypes ?? []),
    ]),
  ].join("\n").toLowerCase();
}

function hasObligation(plan: ObligationPlan, pattern: RegExp): boolean {
  return plan.obligations.some((obligation) => pattern.test([
    obligation.id,
    obligation.description,
    ...(obligation.entities ?? []),
    ...(obligation.expectedEvidence ?? []),
  ].join(" ").toLowerCase()));
}

function addObligation(plan: ObligationPlan, obligation: FusionObligation): void {
  if (plan.obligations.length >= 36) return;
  plan.obligations.push(obligation);
}

function augmentFinancialFilingPlan(prompt: string, plan: ObligationPlan): ObligationPlan {
  const text = combinedPlanText(prompt, plan);
  const isFilingPrompt = /\b(10-k|10-q|sec|edgar|filing|annual report|quarterly report|earnings|investor presentation|reit|segment|operating margin|impairment|term loan|sofr|atm|forward sale|portfolio strategy|capital allocation)\b/.test(text);
  const hasCorporateFinanceSignal = /\b(reit|segment|operating income|operating margin|rental revenue|impairment|acquisition|purchase price|assumed debt|mortgage|principal paydown|term loan|drawdown|net debt|sofr|equity issuance|atm|forward sale|capital allocation|risk management|portfolio strategy)\b/.test(text);
  const hasComplexFinanceNeed = /\b(strategy|risk|risk management|capital allocation|impairment|term loan|drawdown|net debt|sofr|atm|forward sale|equity issuance|acquisition|purchase price|assumed debt|principal paydown|portfolio strategy)\b/.test(text)
    || (/\breit\b/.test(text) && /\bsegment\b/.test(text));
  if (!isFilingPrompt || !hasCorporateFinanceSignal || !hasComplexFinanceNeed) return plan;

  const notes = new Set(plan.notes ?? []);
  notes.add("For corporate filing prompts, include source-backed adjacent finance and segment-trend facts when they materially explain strategy, risk, or capital allocation.");
  plan.notes = Array.from(notes).slice(0, 12);

  if (!hasObligation(plan, /\b(segment trend|period-over-period|year over year|rental revenue|same-property|same property|fee income|assets under management|aum|structured financing)\b/)) {
    addObligation(plan, {
      id: "latest-segment-trend-deltas",
      kind: "metric",
      description: "Identify latest comparable-period segment trend deltas that materially affect the strategy/risk judgment.",
      entities: ["reportable segments"],
      timePeriod: "latest retrieved quarter and year-to-date period",
      expectedEvidence: [
        "segment revenue or rental revenue changes",
        "segment operating income changes",
        "same-property NOI, fee income, assets under management, or structured-financing drivers when disclosed",
        "absolute and percentage change or clearly labeled unavailable values",
      ],
      preferredSourceTypes: ["SEC filings", "earnings supplement", "management discussion and analysis"],
      status: "unknown",
    });
  }

  if (/\b(term loan|drawdown|paydown|net debt|principal paydown|borrowing|sofr|credit facility)\b/.test(text)
    && !hasObligation(plan, /\b(commitment|committed|gross facility|drawn at closing|actual drawn|full.*term loan|capacity interpretation)\b/)) {
    addObligation(plan, {
      id: "term-loan-commitment-vs-drawn-net-debt",
      kind: "calculation",
      description: "For term-loan and paydown calculations, identify both the total committed/gross facility amount and the amount actually drawn or outstanding, then compute net debt effects under each source-disclosed scope if the prompt wording is ambiguous.",
      entities: ["borrower", "loan facility", "paydown target"],
      timePeriod: "reported financing period",
      expectedEvidence: [
        "total committed or gross term-loan facility amount",
        "amount drawn at closing or outstanding",
        "latest-period named property/loan principal paydown or outstanding amount",
        "old-versus-new loan rate/spread and maturity when a modification is disclosed",
        "basis-point or dollar delta for old-versus-new spread, margin, rate, capacity, or guarantee changes",
        "net debt formula for actual-drawn and full-commitment/capacity interpretations",
      ],
      preferredSourceTypes: ["SEC debt note", "credit agreement", "quarterly report"],
      status: "unknown",
    });
  }

  if (/\b(equity|atm|forward sale|capital allocation|financing|liquidity|borrowing|risk management|portfolio strategy)\b/.test(text)
    && !hasObligation(plan, /\b(equity issuance|atm|forward sale|settled forward|program availability|actual cash proceeds|aggregate proceeds)\b/)) {
    addObligation(plan, {
      id: "equity-issuance-atm-aggregate",
      kind: "calculation",
      description: "Recover equity issuance, ATM, and forward-sale financing activity; aggregate source-bound issued/settled/contracted amounts separately from unused capacity.",
      entities: ["issuer"],
      timePeriod: "reported financing period",
      expectedEvidence: [
        "settled or physically settled share count and cash/net proceeds",
        "latest-period outstanding forward-sale share count, aggregate value, or aggregate net value",
        "remaining ATM/program availability",
        "aggregate actual cash proceeds/contracted proceeds and total issued-or-forward-sale exposure without double counting unused capacity",
      ],
      preferredSourceTypes: ["SEC equity note", "quarterly report", "ATM program disclosure"],
      status: "unknown",
    });
  }

  if (/\b(strategy|risk|risk management|capital allocation|portfolio|transformation|diversified|control|controlling|minority|noncontrolling|geograph|market concentration|annual report|10-k)\b/.test(text)
    && !hasObligation(plan, /\b(geographic concentration|ownership constraint|minority|noncontrolling|control constraint|risk factor|annual filing|segment deterioration)\b/)) {
    addObligation(plan, {
      id: "strategy-risk-context-factors",
      kind: "caveat",
      description: "Retrieve strategy and risk-context factors that can change the capital-allocation conclusion.",
      entities: ["company", "portfolio", "reportable segments"],
      timePeriod: "annual report and latest interim filings",
      expectedEvidence: [
        "geographic or asset concentration",
        "ownership, minority-control, noncontrolling-interest, or consolidation constraints",
        "refinancing, maturity, liquidity, or covenant risks",
        "management-disclosed segment deterioration mechanisms such as fee decline, AUM runoff, tenant/rental trends, structured-financing headwinds, or shortened hold periods",
      ],
      preferredSourceTypes: ["Form 10-K", "Form 10-Q", "risk factors", "management discussion and analysis"],
      status: "unknown",
    });
  }

  if (/\b(strategy|risk|risk management|capital allocation|portfolio|transformation|borrowing|equity|debt|segment|impairment|control|minority|noncontrolling)\b/.test(text)
    && !hasObligation(plan, /\b(capital mix|debt-to-total|debt\/equity|capital velocity|causal mechanism|decision rights|recovery strategy)\b/)) {
    addObligation(plan, {
      id: "strategy-mechanism-and-capital-mix",
      kind: "calculation",
      description: "Convert recovered filing facts into strategy mechanisms, not just a numeric ledger.",
      entities: ["company", "segments", "financing sources", "ownership interests"],
      timePeriod: "periods covered by retrieved filings",
      expectedEvidence: [
        "debt-to-total-capital, equity-to-total-capital, or debt/equity mix ratio when non-overlapping debt and equity financing inputs exist",
        "company-share percentage plus control, decision-rights, disposition, or recovery-strategy implications from gross/share, minority, or noncontrolling-interest figures",
        "timing urgency or capital-velocity implications from clustered loan draws, impairments, acquisitions, or asset sales",
        "multi-driver segment deterioration analysis using source-backed impairment, fee/AUM, structured-financing, rental, tenant, market, or liquidity evidence",
      ],
      preferredSourceTypes: ["SEC filings", "management discussion and analysis", "earnings supplement", "risk factors"],
      status: "unknown",
    });
  }

  return plan;
}

export function formatObligationPlanForModel(plan: ObligationPlan | undefined): string {
  if (!plan?.obligations.length) return "";
  const lines = [
    "",
    "## Internal Fusion Requirement Checklist",
    "This checklist was generated only from the user's prompt. It is not an answer key or benchmark rubric. Use it to avoid missing requested entities, metrics, source categories, calculations, and caveats. Do not mention this checklist in the final answer.",
    "",
  ];

  for (const obligation of plan.obligations) {
    const details = [
      obligation.entities?.length ? `entities=${obligation.entities.join(", ")}` : undefined,
      obligation.timePeriod ? `period=${obligation.timePeriod}` : undefined,
      obligation.preferredSourceTypes?.length ? `preferred sources=${obligation.preferredSourceTypes.join(", ")}` : undefined,
      obligation.expectedEvidence?.length ? `evidence needed=${obligation.expectedEvidence.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    lines.push(`- [${obligation.id}] (${obligation.kind}) ${obligation.description}${details ? ` — ${details}` : ""}`);
  }

  if (plan.notes?.length) {
    lines.push("", "Notes:");
    for (const note of plan.notes) lines.push(`- ${note}`);
  }

  return lines.join("\n");
}

export class ObligationPlanner {
  private caller: ModelCaller;
  private model: string;

  constructor(caller: ModelCaller, model: string) {
    this.caller = caller;
    this.model = model;
  }

  async plan(prompt: string): Promise<ObligationPlan> {
    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: PLAN] You are planning a multi-model answer.
Create an obligation checklist ONLY from the user's prompt. Do not use web tools. Do not infer hidden benchmark rubrics, answer keys, or expected values. The checklist should capture what the final answer must cover to satisfy the user: requested metrics, comparisons, entities, time periods, source categories, calculations, caveats, and decision/recommendation outputs.
Do not merge concrete fact slots into broad obligations. If the prompt asks for specific years, jurisdictions, products, companies, populations, sources, numeric indicators, exceptions, thresholds, examples, or calculations, create separate obligations for those exact items so retrieval can target them directly.
For public-health or service-delivery comparison prompts, make the checklist source-retrieval friendly: separate requested indicators from delivery-model inputs, preserve each setting/entity and time span from the prompt, and put any prompt-named source systems, reports, datasets, or publications into preferredSourceTypes or expectedEvidence. Do not invent source names, years, entities, or values.

Return ONLY valid JSON:
{
  "obligations": [
    {
      "id": "short-kebab-case-id",
      "kind": "metric" | "comparison" | "source" | "calculation" | "recommendation" | "caveat" | "other",
      "description": "what must be answered",
      "entities": ["optional entity names"],
      "timePeriod": "optional period/year range",
      "expectedEvidence": ["what evidence/value/calculation is needed"],
      "preferredSourceTypes": ["official filings", "vendor docs", "peer-reviewed studies", "public health surveillance", "etc"],
      "status": "unknown"
    }
  ],
  "notes": ["brief planning notes, if useful"]
}

Keep the checklist concise but complete. Prefer 14-28 obligations for source-heavy complex prompts, fewer for simple prompts. Split requested metrics and calculations aggressively enough that each item can drive a focused search query.`,
      messages: [{ role: "user", content: prompt }],
    });

    return augmentFinancialFilingPlan(prompt, normalizePlan(parseJsonResponse<ObligationPlan>(result.answer)));
  }
}
