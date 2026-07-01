import type {
  ModelCaller,
  ParticipantOutput,
  EvidencePool,
  StructuredJudgeAnalysis,
  JudgeVerification,
} from "./types.js";

function focusedBlockScore(block: string): number {
  const text = block.toLowerCase();
  let score = 0;
  const patterns = [
    /rental revenue/,
    /operating income/,
    /investment management/,
    /reit portfolio/,
    /forward sale|atm program|settled forward|physically settled|net proceeds|aggregate net value/,
    /atm forward sale agreements|aggregate value|average net share price|common shares offered|outstanding forward/,
    /term loan|delayed draw|drawn at closing/,
    /sofr\s*\+|spread|basis points|maturity/,
    /modified .* loans|reduce(?:d)? the interest rate/,
    /mortgages payable|notes payable|carrying value|interest rate as of|maturity date as of/,
    /renaissance portfolio/,
    /purchase price|cash outlay|principal paydown|mortgage debt/,
    /bald hill/,
    /washington|d\.c\.|new york/,
    /noncontrolling|ownership|proportionate share|acadia.?s share|minority control|control limitation/,
    /same property noi|fee income|fee decline|assets under management|aum|structured financing/,
    /shortened hold|reduced holding period|capital velocity|deployment urgency|investor liquidity|market pressure/,
    /debt.?equity|capital mix|capital ratio|balance.?sheet discipline/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) score += 2;
  }
  if (/no exact focus terms found/.test(text)) score -= 4;
  if (/sec html table near|>\s*\d+:\s*/i.test(block)) score += 1;
  return score;
}

function compactFocusedFullContent(value: string, maxChars = 9_000): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  if (!text.includes("--- excerpt around")) return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;

  const [header, ...rawBlocks] = text.split(/\n--- excerpt around /);
  const parts = [header.trim()].filter(Boolean);
  let used = parts.join("\n").length;
  const selectedBlocks = rawBlocks
    .map((rawBlock, index) => ({ rawBlock, index, score: focusedBlockScore(rawBlock) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 18);
  for (const { rawBlock } of selectedBlocks) {
    const block = `--- excerpt around ${rawBlock}`.trim();
    const remaining = maxChars - used - 80;
    if (remaining <= 240) break;
    const clipped = block.length > Math.min(1_900, remaining)
      ? `${block.slice(0, Math.min(1_900, remaining))}\n[excerpt truncated]`
      : block;
    parts.push(clipped);
    used += clipped.length + 1;
  }
  return parts.join("\n");
}

function evidenceBody(e: EvidencePool["entries"][number]): string {
  if (e.source === "web_fetch" && e.fullContent && e.fullContent.length > e.snippet.length) {
    return compactFocusedFullContent(e.fullContent);
  }
  return e.snippet;
}

function formatEvidenceLine(e: EvidencePool["entries"][number]): string {
  const label = e.url ? `${e.title ?? e.source} (${e.url})` : (e.title ?? e.source);
  return `- [${e.id}] ${label}:\n${evidenceBody(e)}`;
}

function formatParticipantForJudge(p: ParticipantOutput): string {
  const workspace = p.workspace
    ? [
      "",
      "#### Workspace Sandbox",
      `Sandbox: ${p.workspace.sandboxId}`,
      `Changed files: ${p.workspace.changedFiles.length}`,
      ...p.workspace.changedFiles.slice(0, 80).map((file) => `- ${file.op} ${file.path}${file.size !== undefined ? ` (${file.size} bytes)` : ""}`),
      p.workspace.changedFiles.length > 80 ? `- [truncated ${p.workspace.changedFiles.length - 80} additional file changes]` : "",
      p.workspace.error ? `Workspace summary error: ${p.workspace.error}` : "",
    ].filter(Boolean).join("\n")
    : "";
  return `### Participant ${p.slotIndex + 1} (${p.model})\n${p.answer}${workspace ? `\n\n${workspace}` : ""}`;
}

const PRODUCT_PROCUREMENT_SOURCE_GUIDANCE = "For product/procurement/vendor comparisons, keep configuration options, expandability, regional warranty/support terms, application/workload requirements, independent thermal/performance/serviceability evidence, lifecycle/TCO inputs, and current price/availability source-bound to official vendor/application docs, service terms, credible reviews, or market listings. Distinguish official specs from assumptions; include source IDs or URLs; do not invent missing values.";
const PRODUCT_PROCUREMENT_ANSWER_STRUCTURE = "When answering a side-by-side product/procurement comparison, prefer a compact matrix that maps each user-requested criterion to each option, with source IDs/URLs, confidence/assumption notes, lifecycle or support implications, and a final recommendation with verification actions for any missing decision-critical value.";
const PERSONAL_FINANCE_SOURCE_GUIDANCE = "For personal-finance, tax-planning, retirement, education-funding, insurance, or household cash-flow questions, keep account rules and limits, eligibility, contribution and withdrawal tax consequences, benefit/grant formulas, marginal-tax assumptions, debt/cash-flow constraints, insurance risks, time horizons, and jurisdiction/current-year context source-bound to official tax, regulator, plan-provider, or government sources. Use bash for explicit arithmetic from stated inputs. Cite source IDs or URLs and do not invent current-year numbers.";
const PERSONAL_FINANCE_ANSWER_STRUCTURE = "When answering personal-finance planning prompts, separate: emergency/cash-flow and debt priorities; tax-advantaged or registered account sequencing; taxable investing; education/disability/insurance/estate considerations; calculations with assumptions; an action checklist; and caveats or source-required values to verify.";
const FINANCIAL_FILING_SOURCE_GUIDANCE = "For corporate financial-filing, SEC/EDGAR, earnings, REIT, segment, acquisition, impairment, debt, equity-issuance, or operating-margin prompts, behave like a filing analyst: extract exact table values, reporting periods, entity names, transaction terms, rates/spreads/maturities, noncontrolling-interest implications, and calculation inputs from filings, interactive report tables, supplements, or releases. Use bash for arithmetic from cited values. Never summarize around a requested numeric item that can be represented as value + source + formula.";
const FINANCIAL_FILING_ANSWER_STRUCTURE = "When answering corporate-filing prompts, include a requested-item ledger covering every user slot: item, filing/source table, exact value(s), calculation/formula if any, confidence/remaining gap, and answer implication. For REIT/segment prompts, explicitly cover segment revenue, operating income/margin, period-over-period trend, acquisition purchase price/debt/paydown/cash outlay, impairment owner/property/charge/timing, loan amount/rate/maturity, refinancing spread improvement, equity issuance and forward-settlement proceeds, net debt, geography, ownership share, and consolidation/control implications when requested. When comparing margins, rates, spreads, revenues, income, or balances, state both the ratio/percent change and the absolute delta in percentage points, basis points, or dollars when source-bound inputs are available. For delayed-draw, partially drawn, or capacity-style loan facilities, present both the total committed/gross facility amount and the amount actually drawn/outstanding; if net debt impact depends on scope, compute the actual-drawn effect and the full-commitment/capacity effect in separate rows instead of choosing one silently.";
const FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE = "For corporate-filing strategy or risk-management questions, include source-backed adjacent facts when they materially explain the requested judgment, even if the prompt does not name every metric. In particular, preserve financing mix and balance-sheet discipline evidence (debt plus equity issuance/ATM/forward sales, settlements, or proceeds), full loan terms (gross facility, drawn amount, rate/spread, maturity, paydowns, old-versus-new spread or maturity changes), acquisition accounting/control economics (change-in-control or remeasurement gains/losses, consolidation effects), segment trend evidence across comparable periods (rental revenue and operating income changes, not only one-period margins), geographic or asset concentration, noncontrolling-interest/ownership-share economics, and management-disclosed causes such as shortened hold periods, liquidity pressure, AUM runoff, fee decline, structured-financing headwinds, refinancing risk, or capital-velocity pressure. For acquisitions, keep gross asset value, debt assumed or consolidated, cash consideration paid, principal paydown/payoff, note funding, seller financing, NCI, and non-cash accounting effects in separate rows; when cash consideration and paydown/funding components are source-bound and non-overlapping, compute a separate actual cash deployment/outlay formula row instead of substituting purchase-price-less-debt as the cash outlay. For equity/ATM/forward-sale evidence, prefer the latest retrieved period when the user asks current/latest/strategy, separate actual cash proceeds already received from outstanding forward-sale aggregate value/net value and unused program capacity, then report both the cash-received/contracted view and, when the user asks issuance/financing scale, the total issuance/forward-sale exposure from settled proceeds plus the latest outstanding forward-sale aggregate value/net value. Keep unused program capacity separate from issued, settled, or contracted amounts. For impairment, ownership, and NCI evidence, compute the reporting company's share and implied ownership percentage when source-bound gross and share values are available, and avoid double counting overlapping quarterly/year-to-date rows. For latest-period segment trend evidence, include the actual table values or deltas for material segment revenue/rental revenue and operating income changes, plus management-stated causes, when retrieved. For evolving-strategy assessments, cite the relevant annual 10-K when retrieved plus subsequent 10-Qs. Keep these adjacent facts source-bound and label them as context rather than inventing unsupported narrative.";
const FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE = "For corporate-filing strategy synthesis, do not stop at a fact ledger. Each major section should open with a finding sentence, then use the table as evidence. Translate source-backed proportional ownership, noncontrolling-interest, or company-share figures into control, decision-rights, disposition, and recovery-strategy implications when the prompt asks about strategy or risk; when both gross amount and company-share amount are available, compute the company-share percentage and state whether that minority/economic share limits control over troubled-asset disposition or recovery. When both debt financing and equity/ATM/forward-sale financing components are available, compute a clearly scoped debt-to-total-capital, equity-to-total-capital, or debt/equity mix ratio from non-overlapping inputs and explain what it says about balance-sheet discipline. When old and new loan rates, spreads, coupons, margins, or capacity amounts are both available, compute the absolute delta in basis points or dollars and carry that delta into the interpretation, not only the table. When a segment's operating income, fees, AUM, or structured-financing economics deteriorate, connect the deterioration to multiple retrieved drivers instead of attributing it only to impairments. When loan draws, acquisition funding, impairments, or asset sales cluster in time, explicitly interpret timing urgency, capital velocity, market pressure, or investor-liquidity pressure if supported by participant answers, recovery notes, or evidence. Preserve participant unique insights that explain causality or strategic mechanism, not only numeric rows.";
const FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE = "For corporate-filing prompts, when participant answers or recovery notes contain multiple plausible totals, periods, scopes, or interpretations, select the primary answer by matching the user's requested entities, period, and source family first. Do not let a broader context-only set contaminate the requested total. Preserve broader figures in a separate context row if useful. For the same fact slot, prefer latest-period primary SEC filing tables/notes over older quarterly tables, earnings supplements, releases, or participant inference; a supplement can add context but should not override a later same-entity SEC table row unless you explain the source contradiction. When one candidate is tied to a named property, loan, or equity-program table row and another is a broader venture/program summary, make the named table row primary for that scoped item and retain the broader summary as context or caveat. If participants provide a source-backed candidate that exactly matches the prompt scope, include that candidate as the primary finding unless a stronger source contradiction is identified. For cumulative filing rows such as year-to-date, nine months ended, total 20XX, or table totals, do not add earlier quarterly rows or overlapping component rows unless the source clearly labels them as incremental and non-overlapping; use the cumulative/table-total row as primary and put additive reconstructions in a separate caveated reconciliation.";
const FINANCIAL_FILING_FACT_RETENTION_GUIDANCE = "For corporate-filing prompts, do not drop a concrete, source-backed numeric fact from participant answers, recovery notes, repair notes, or evidence merely because it was not in the first draft. If a participant or repair step recovered a relevant filing fact such as a change-in-control loss, old/new loan spread, exact loan rate/maturity, equity proceeds or settled forward shares, period-over-period segment revenue/operating-income trend, property/geographic concentration, or ownership/NCI share, the final answer should either include it in the ledger/analysis or explicitly reject it with a source-based reason. When a participant provides a more exact field-level value than the recovery prose, carry that exact candidate into the repair ledger instead of replacing it with a broader range or generic caveat. Narrative notes, MD&A text, footnotes, earnings-supplement pages, and table notes can support property-specific or transaction-specific facts even when a primary table is grouped by segment, fund, or location; include the supported narrative fact with a caveat instead of turning it into “not recovered”. Verification should flag omitted relevant source-backed filing facts as remaining caveats.";
const FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE = "For financial-filing verification repair, resolve conflicts in recovery notes and participant candidates into a settled-fact ledger before revising. Mark each candidate as PRIMARY, CONTEXT ONLY, INCLUDE WITH CAVEAT, or EXCLUDE, with the source and scope reason. Do not let a later conservative note silently erase an earlier source-backed fact. When evidence is mixed, prefer INCLUDE WITH CAVEAT if a specific filing narrative, footnote, participant-cited source, or earnings-supplement table supports the fact and the limitation is only that a different summary table is aggregated. But when a latest-period SEC filing table has a named property/loan/equity-program row for the exact item, treat that table row as stronger than a stale table or supplemental summary for the same slot. For financing, debt, equity, or forward-sale evidence, compute and state requested totals from component values when the component inputs are source-bound; show the formula and keep broader context-only totals separate. For acquisition cash deployment, reconcile and label at least three scopes when available: accounting purchase price/gross value, debt assumed or consolidated, and actual cash paid including non-overlapping consideration, paydowns, payoff, or note funding. If verification or recovery notes already name non-overlapping cash-use components and ask for a caveated aggregate, the final answer must include an explicit aggregate formula row; listing the components separately is not enough. For ATM/equity programs, prefer latest-period outstanding forward-sale tables over stale earlier-period tables when both are retrieved, and separately show proceeds already received, outstanding contracted net proceeds, total issued/forward-sale exposure, and unused capacity. If a latest table gives both aggregate value and aggregate net value, use the metric that matches the wording and show the other as a nearby reconciliation rather than ignoring it. For ownership/impairment tables, compute the reporting-company share from gross and proportional amounts and state control/minority constraints when they affect strategy. For cumulative financial statement tables, guard against double counting overlapping quarterly, year-to-date, and table-total rows; if a participant supplies a scoped total/range that avoids overlap, prefer it over a broader additive reconstruction. Required final-answer actions should be imperative and concrete, for example: add the exact value, add the source/period, total the components, cite the annual filing, state the prompt-matched primary total, or state the strongest caveated proxy.";
const FINANCIAL_FILING_VERIFICATION_GATE_GUIDANCE = "For financial-filing drafts, set pass=false if the answer omits source-backed, participant-backed, or repair-backed values for any material financing mix, equity issuance/ATM/forward sale/settlement/proceeds, exact loan rate/spread/maturity, old-versus-new spread reduction, paydown, acquisition accounting, annual filing citation, segment revenue or operating-income trend, property/fund/geographic concentration, ownership/NCI/Acadia-share total, or management-disclosed cause that appears in recovery notes, participant answers, or evidence. Set pass=false when a draft says “not recovered” while recovery, participants, or evidence contains a specific candidate value and source; require the final answer to include the candidate with confidence/caveat or reject it with a precise source contradiction. Set pass=false if a strategy/risk draft omits retrieved latest-period segment trend lines such as rental revenue changes, operating income changes, fee/AUM changes, or structured-financing drivers merely because they were not in the first checklist. Set pass=false if a segment deterioration section cites only impairments while participant answers or evidence also identify fee decline, AUM runoff, structured-financing headwinds, tenant/rental trends, market pressure, or other management-disclosed drivers. Set pass=false if delayed-draw or committed financing evidence includes both total commitment and drawn/outstanding amount but the draft presents only one net-debt interpretation while the prompt wording could reasonably require the other. Set pass=false if source-backed term-loan evidence shows a full facility amount and later-period debt evidence shows the full amount outstanding, but the draft only treats an earlier partial draw as the main borrowing amount. Set pass=false if an acquisition answer presents a purchase-price-minus-debt proxy as cash deployment while evidence contains actual cash consideration plus a non-overlapping paydown, payoff, or note-funding component, or if it lists source-backed non-overlapping cash-use components but omits the explicit caveated aggregate requested by verification/recovery notes. Set pass=false if a named property/loan debt-table row supplies a specific paydown/outstanding amount, rate, maturity, or old-new spread and the draft instead uses only a supplement-backed or stale candidate without explaining the conflict. Set pass=false if old and new loan rates/spreads/capacity amounts are both present but the answer omits the absolute basis-point or dollar delta in the same row or nearby interpretation. Set pass=false if an equity/ATM answer includes proceeds already received and outstanding forward-sale net value but omits a clearly scoped combined non-overlapping total, if it omits a latest-period outstanding-forward aggregate value/net value while using an older period, or if an issuance/financing prompt reports unused capacity but omits the issued/forward-sale exposure total. Set pass=false if impairment or ownership evidence contains gross and reporting-company-share amounts but the draft omits the share total, company-share percentage, implied ownership percentage, or control/minority strategic implication. Set pass=false if debt and equity financing components are both present but the draft omits a clearly scoped capital-mix ratio such as debt-to-total-capital, equity-to-total-capital, or debt/equity mix. Set pass=false if a strategy/risk answer only mentions locations, impairment timing, ownership-share figures, or segment deterioration metrics in tables but does not explicitly interpret retrieved geographic concentration, timing urgency/capital velocity, control/minority constraints, disposition/recovery decision rights, market/investor-liquidity pressure, or management-disclosed drivers in the judgment. Set pass=false if a finance answer has major sections that start with data tables but no section-level analytical finding when the prompt asks for a strategic assessment. Set pass=false if the draft chooses a broader context-only total over a prompt-matched scoped total without presenting the prompt-matched total as primary. Before setting pass=true, privately enumerate the material numeric, source, and causal-mechanism candidates in recovery notes, participant answers, and evidence, then confirm the draft includes each candidate or a source-based rejection. Treat missing participant-backed candidate facts and participant-backed causal insights as coverage failures even when unsupportedClaims is empty.";
const AFFILIATE_REFERRAL_SOURCE_GUIDANCE = "For affiliate, referral, marketplace, partnership, lead-generation, or publisher-network questions, source-bind who performs the underlying service, who merely refers or compares providers, who owns licensing/compliance/underwriting/customer servicing, how compensation or publisher tools work, and which product lines are direct versus partner-delivered. Prefer official program, publisher, partner, terms, help-center, or product documentation before third-party affiliate-network listings. Do not infer service ownership from marketing copy alone.";
const AFFILIATE_REFERRAL_ANSWER_STRUCTURE = "When answering affiliate/referral strategy prompts, separate the business model layers: direct operator, referral/intermediary, end provider, compliance owner, customer data/lead flow, publisher tools/co-branded pages/widgets/deep links, CPL/CPA or commission mechanics, soft-inquiry or prequalification handling, product-line fit, partnership leverage, displacement risk, and recommended positioning/actions.";
const ENTERPRISE_UX_SOURCE_GUIDANCE = "For ERP, enterprise UX, SAP Fiori, NetSuite, navigation, workflow, dashboard, or adoption prompts, bind recommendations to official product/design documentation and credible usability or change-management research. Preserve platform-specific patterns instead of replacing them with generic UX advice: SAP object pages, wizards, launchpad/shell patterns, and work-list/object-page flows; NetSuite centers/roles/dashboards/global search/Item 360/work-order flows; plus usability evidence for hidden navigation, progressive disclosure, recognition over recall, older or legacy users, and adoption/proficiency.";
const ENTERPRISE_UX_ANSWER_STRUCTURE = "When answering ERP/enterprise UX prompts, include a platform-pattern matrix and an implementation recommendation: workflow pattern, why it reduces cognitive load or supports adoption, where it fits in SAP/NetSuite-style screens, risks for discoverability/training, and how to measure adoption speed, ultimate utilization, proficiency, task completion, and error rate.";
const RESEARCH_DOMAIN_SOURCE_GUIDANCE = "For medicine and public health, prioritize current clinical guidelines, regulator or public-health agencies, systematic reviews, RCTs, and drug labels; preserve population, intervention, comparator, outcomes, dose, harms, contraindications, evidence certainty, and medical-advice caveats. For public-health workforce ratios, do not create new crude total-population or women-of-reproductive-age ratios from staffing counts. Report source-provided ratios only; if no authoritative source-reported ratio is available, report the staffing count and explicitly state that no authoritative ratio was recovered. Only calculate a ratio when the source instructs that exact calculation or the user supplies the exact denominator standard. For law and policy, preserve jurisdiction, date/currentness, statutory or regulatory text, leading cases, elements/tests, exceptions, procedural posture, enforcement agency guidance, and legal-advice caveats. For academic or literature-review prompts, separate consensus, disputed findings, methodology, effect sizes, sample/population limits, causal versus correlational claims, and representative primary studies or reviews. For technology or standards prompts, prefer official docs, specs, changelogs, benchmarks, security advisories, and versioned compatibility notes. For general-knowledge or needle-in-a-haystack prompts, search exact named entities, dates, quotes, tables, and source titles; avoid replacing a requested specific answer with a generic overview.";
const RESEARCH_DOMAIN_ANSWER_STRUCTURE = "For complex research answers, use the user's requested deliverable as the shape, but default to: short answer or recommendation first; evidence-backed table for comparable entities/criteria; detailed reasoning by factor; uncertainty and missing-source notes; practical next steps or decision rules. Tie decision-critical facts to source IDs/URLs and label assumptions instead of smoothing over gaps.";
const EXACT_FACT_COVERAGE_GUIDANCE = "For source-heavy prompts, exact-fact coverage and a direct usable answer outrank narrative polish. Preserve every concrete fact slot from the checklist: named entity, metric, year/period, jurisdiction/setting, threshold, exception, product spec, transaction term, source family, and calculation. A good final answer should let a reader audit each requested slot as answered with a source, calculated from cited inputs, or presented as a clearly labeled best-effort finding with confidence and next verification source. Do not collapse multiple requested facts into a broad summary.";
const COMPLETENESS_REPAIR_GUIDANCE = "Do not fix verification issues by deleting requested facts, leaving cells blank, or replacing the deliverable with broad missing-source caveats. For each still-missing requested slot, first do one targeted retrieval attempt or use participant candidates/evidence to provide the strongest supported or confidence-labeled answer. If exact annual or perfectly comparable data are unavailable, still preserve source-bound nearest proxies, historical cohort values, adjacent-period indicators, named facilities/programs/referral hospitals, source-bound distance or travel-time figures, before/after trajectories, and official operational capacity figures with explicit period/setting/definition caveats instead of leaving the slot empty. Final output must be a complete user-facing deliverable, not a judge audit; include uncertainty inline while still answering the user's concrete question.";
const REQUESTED_ITEM_LEDGER_GUIDANCE = "For source-heavy, numeric, product, finance, public-health, legal, affiliate, or multi-criterion prompts, include a user-facing requested-item coverage table or equivalent matrix. Each user-requested item should have an explicit finding/status, source or candidate basis, confidence/limits, and next verification source or action when incomplete. Do not expose the internal checklist as an artifact; make the table read like part of the answer. Keep useful participant-derived or recovery-derived candidate facts when primary support is incomplete, but label them as low/medium confidence and separate them from verified values.";
const VERIFICATION_COVERAGE_GATE_GUIDANCE = "Set pass=false when a source-heavy or multi-slot draft lacks an explicit requested-item/evidence coverage table or equivalent, when any prompt-derived checklist item has no answer/status/source/confidence in the draft, or when the draft replaces requested facts with a blanket unavailable-data caveat even though participant answers or recovery notes contain candidate facts. For public-health/service-delivery drafts, also set pass=false when requested findings rely on phrases like presumed, likely, generally, structurally, or known model without a source-bound basis, or when the answer presents unsourced distance, referral-time, staffing, or workforce-ratio claims as findings. Treat coverage omissions as critical issues even if unsupportedClaims is empty.";

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

  throw new Error(`Judge model returned invalid JSON: ${answer.slice(0, 200)}`);
}

export class JudgeRunner {
  private caller: ModelCaller;
  private model: string;
  private tools: string[];
  private obligationText: string;

  constructor(caller: ModelCaller, model: string, tools: string[] = [], obligationText = "") {
    this.caller = caller;
    this.model = model;
    this.tools = tools;
    this.obligationText = obligationText;
  }

  private mergeEvidence(evidence: EvidencePool, resultEvidence: Awaited<ReturnType<ModelCaller["call"]>>["evidence"]): void {
    if (!resultEvidence?.length) return;
    const seen = new Set(evidence.entries.map((entry) => entry.id));
    for (const entry of resultEvidence) {
      if (seen.has(entry.id)) continue;
      seen.add(entry.id);
      evidence.entries.push(entry);
    }
  }

  private requestTools(): string[] | undefined {
    return this.tools.length > 0 ? this.tools : undefined;
  }

  async analyze(
    prompt: string,
    participants: ParticipantOutput[],
    evidence: EvidencePool,
  ): Promise<StructuredJudgeAnalysis> {
    const participantSummaries = participants
      .map(formatParticipantForJudge)
      .join("\n\n");

    const evidenceText = evidence.entries.length > 0
      ? "\n\n## Evidence\n" + evidence.entries.map(formatEvidenceLine).join("\n")
      : "";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: ANALYSIS] You are the Judge in a multi-model deliberation. Perform structured analysis of participant answers.
Return a JSON object with these fields:
- consensus: string[] (points all/most models agree on)
- contradictions: Array<{topic: string, stances: Array<{slotIndex: number, stance: string}>}>
- coverageGaps: string[] (topics no model covered)
- uniqueInsights: Array<{slotIndex: number, insight: string}>
- blindSpots: string[] (risks or concerns missed)
- sourceConfidence: Array<{claim: string, supportedBy: string[], confidence: "high"|"medium"|"low"}>

Use web_search/web_fetch when participant evidence is thin or conflicting. Use bash for arithmetic, table checks, or small deterministic calculations. Do not use tools to look up benchmark rubrics, answer keys, or evaluation artifacts.
${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE}
${PERSONAL_FINANCE_SOURCE_GUIDANCE}
${FINANCIAL_FILING_SOURCE_GUIDANCE}
${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE}
${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE}
${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE}
${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE}
${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE}
${AFFILIATE_REFERRAL_SOURCE_GUIDANCE}
${ENTERPRISE_UX_SOURCE_GUIDANCE}
${RESEARCH_DOMAIN_SOURCE_GUIDANCE}
${EXACT_FACT_COVERAGE_GUIDANCE}
${COMPLETENESS_REPAIR_GUIDANCE}
Return ONLY valid JSON, no markdown fencing.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n## Participant Answers\n${participantSummaries}${evidenceText}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);

    return parseJsonResponse<StructuredJudgeAnalysis>(result.answer);
  }

  async recoverObligations(
    prompt: string,
    analysis: StructuredJudgeAnalysis,
    participants: ParticipantOutput[],
    evidence: EvidencePool,
  ): Promise<string> {
    if (!this.obligationText.trim()) return "";

    const participantSummaries = participants
      .map(formatParticipantForJudge)
      .join("\n\n");
    const evidenceText = evidence.entries.length > 0
      ? "\n\n## Existing Evidence\n" + evidence.entries.map(formatEvidenceLine).join("\n")
      : "\n\n## Existing Evidence\nNo evidence available.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: RECOVER] You are the Judge in a multi-model deliberation. Before drafting, audit the user-prompt-derived requirement checklist and recover missing sourceable facts.

Rules:
- Use only the user's prompt, participant answers, current evidence, and public tools. Do not look up benchmark rubrics, answer keys, or evaluation artifacts.
- For every checklist item, decide whether it is supported, missing, contradicted, or not publicly available from retrieved sources.
- Use web_search/web_fetch for missing important factual, legal, financial, public-health, product, UX, or technical claims.
- For public-health or service-delivery questions, recover source-bound numeric facts with definitions, geography, time period, numerator/denominator when available, and uncertainty. Look for coverage rates, mortality rates, cause-of-death patterns, workforce/capacity counts, referral distances/times, and before/after trajectories when the user's prompt asks for them. Do not invent derived ratios/rates. For workforce ratios, do not calculate a new total-population or women-of-reproductive-age ratio from staffing counts; use source-reported ratios only, otherwise state that no authoritative ratio was recovered while preserving the staffing counts.
- ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE}
- ${PERSONAL_FINANCE_SOURCE_GUIDANCE}
- ${FINANCIAL_FILING_SOURCE_GUIDANCE}
- ${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE}
- ${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE}
- ${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE}
- ${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE}
- ${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE}
- ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE}
- ${ENTERPRISE_UX_SOURCE_GUIDANCE}
- ${RESEARCH_DOMAIN_SOURCE_GUIDANCE}
- ${EXACT_FACT_COVERAGE_GUIDANCE}
- ${COMPLETENESS_REPAIR_GUIDANCE}
- For long filings, reports, PDFs, or documentation pages, call web_fetch with focused terms for each missing metric/entity (for example: revenue + operating income + segment name; acquisition + purchase price + assumed debt; impairment + property/fund name; term loan + SOFR + maturity; SAP object page + wizard; NetSuite global search + Item 360 + work order; public-health examples: coverage rate + year; mortality rate + setting; cause of death + surveillance; workforce count + referral time).
- Use bash for arithmetic and table checks.
- Prefer primary/official sources, filings, vendor docs, surveillance reports, peer-reviewed papers, or original documentation.
- If a requested value cannot be found after targeted attempts, say so and explain what source would be needed.
- Preserve candidate facts from participants or search snippets when primary support is incomplete: mark confidence and verification need instead of deleting the requested item.

Return concise markdown notes. Include a compact evidence ledger for source-heavy numeric prompts with columns: checklist item, status, recovered value/finding, definition/period/setting, source ID/URL, and remaining gap. Do not write the final answer.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n${this.obligationText}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Participant Answers\n${participantSummaries}${evidenceText}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);
    return result.answer;
  }

  async draft(
    prompt: string,
    analysis: StructuredJudgeAnalysis,
    participants: ParticipantOutput[],
    evidence: EvidencePool,
    recoveryNotes = "",
  ): Promise<string> {
    const participantSummaries = participants
      .map(formatParticipantForJudge)
      .join("\n\n");

    const evidenceText = evidence.entries.length > 0
      ? "\n\n## Evidence\n" + evidence.entries.map(formatEvidenceLine).join("\n")
      : "";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: DRAFT] You are the final synthesizer in a multi-model deliberation. Write one complete, useful, user-facing answer to the original question.
Use the structured judge analysis, recovery notes, participant answers, and evidence as private scaffolding. Do not render the judge report itself.
Address contradictions explicitly. Cover gaps. Cite evidence where available.
Use the requirement checklist and recovery notes as a coverage gate: every user-requested metric, source category, comparison, calculation, and caveat should be answered with source support, a calculated value from cited inputs, or a confidence-labeled best-effort finding plus next verification source.
The recovery phase has already had the opportunity to retrieve missing facts. During drafting, synthesize from the provided participant answers, recovery notes, and evidence; do not defer the answer to more research. For public-health/service-delivery comparisons, preserve source-bound definitions, geography, time period, numerator/denominator when available, and uncertainty; include requested coverage, mortality, cause, workforce/capacity, referral, and trajectory metrics whenever you have source-backed or confidence-labeled partial evidence. Distinguish “not retrieved in this run” from “not publicly available”, but do not make missing-source caveats the main answer: retain partial, dated, non-comparable, or participant-derived estimates with clear confidence labels instead of replacing them with a blanket data-unavailable claim. Never upgrade presumed, likely, generally known, or structural-model claims into findings for requested public-health indicators; put them in a clearly labeled hypothesis/not-recovered caveat or omit them. Do not invent derived ratios/rates; for public-health workforce ratios, do not calculate a new total-population or women-of-reproductive-age ratio from staffing counts unless the source itself reports the ratio or instructs that exact calculation. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${FINANCIAL_FILING_SOURCE_GUIDANCE} ${FINANCIAL_FILING_ANSWER_STRUCTURE} ${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE} ${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE} ${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE} ${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE} ${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} ${ENTERPRISE_UX_SOURCE_GUIDANCE} ${ENTERPRISE_UX_ANSWER_STRUCTURE} ${RESEARCH_DOMAIN_SOURCE_GUIDANCE} ${RESEARCH_DOMAIN_ANSWER_STRUCTURE} ${EXACT_FACT_COVERAGE_GUIDANCE} ${COMPLETENESS_REPAIR_GUIDANCE} ${REQUESTED_ITEM_LEDGER_GUIDANCE} Do not use or request tools during drafting. Do not look up benchmark rubrics, answer keys, or evaluation artifacts.
Do not mention the deliberation process or the internal checklist. Do not output sections named "Structured Judge Analysis", "Judge Verification", "Participants", "Workspace Sandboxes", "Evidence", or "Artifacts" unless the user explicitly asks for diagnostics.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Participant Answers\n${participantSummaries}${evidenceText}`,
      }],
      tools: undefined,
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);

    return result.answer;
  }

  async verify(
    draft: string,
    analysis: StructuredJudgeAnalysis,
    evidence: EvidencePool,
    recoveryNotes = "",
    participants: ParticipantOutput[] = [],
  ): Promise<JudgeVerification> {
    const evidenceText = evidence.entries.length > 0
      ? evidence.entries.map(formatEvidenceLine).join("\n")
      : "No evidence available.";
    const participantSummaries = participants.length > 0
      ? participants.map(formatParticipantForJudge).join("\n\n")
      : "No participant answers provided to verify phase.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: VERIFY] You are verifying a draft answer against structured analysis and evidence.
Check for:
- Claims not supported by participant answers or evidence
- Contradictions the analysis found but the draft ignores
- Citations that don't actually support the claims they're attached to
- Remaining caveats or uncertainties
- Missing coverage for any item in the user-prompt-derived requirement checklist

Use web_search/web_fetch for verification when support is unclear; for long source documents, use focused web_fetch terms. For public-health/service-delivery drafts, verify that numeric coverage/mortality/cause/workforce/referral/trajectory claims include source IDs or URLs, definitions, setting, period, and uncertainty where available. Mark the draft unsupported if requested findings are presented as presumed, likely, generally known, structurally expected, or from an uncited model instead of evidence. Mark it unsupported if it calculates public-health workforce ratios from staffing counts rather than using a source-reported ratio. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${FINANCIAL_FILING_SOURCE_GUIDANCE} ${FINANCIAL_FILING_ANSWER_STRUCTURE} ${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE} ${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE} ${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE} ${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE} ${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE} ${FINANCIAL_FILING_VERIFICATION_GATE_GUIDANCE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} ${ENTERPRISE_UX_SOURCE_GUIDANCE} ${ENTERPRISE_UX_ANSWER_STRUCTURE} ${RESEARCH_DOMAIN_SOURCE_GUIDANCE} ${RESEARCH_DOMAIN_ANSWER_STRUCTURE} Use bash only for source-bound arithmetic checks. Do not use tools to look up benchmark rubrics, answer keys, or evaluation artifacts.
${EXACT_FACT_COVERAGE_GUIDANCE}
${COMPLETENESS_REPAIR_GUIDANCE}
${REQUESTED_ITEM_LEDGER_GUIDANCE}
${VERIFICATION_COVERAGE_GATE_GUIDANCE}

Return a JSON object:
- unsupportedClaims: string[]
- missingContradictions: string[]
- citationIssues: string[]
- remainingCaveats: string[] (must include any material source-backed candidate fact from recovery notes, participants, or evidence that the draft omits or only partially covers)
- pass: boolean (true if no critical issues)

For finance/source-heavy tasks, pass=true is only valid after the draft includes or explicitly rejects every material candidate fact family named in the prompt, recovery notes, structured analysis, participant answers, or evidence: requested metrics, adjacent financing mix, old/new rate or spread changes, full loan terms, equity/forward-sale proceeds or settlements, segment trend deltas, annual filing/risk-factor source, geography, ownership/NCI share, and management-disclosed causes. If any such candidate is omitted, set pass=false and put a concrete repair instruction in remainingCaveats or citationIssues.

Return ONLY valid JSON, no markdown fencing.`,
      messages: [{
        role: "user",
        content: `## Draft Answer\n${draft}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Participant Answers\n${participantSummaries}\n\n## Evidence\n${evidenceText}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);

    return parseJsonResponse<JudgeVerification>(result.answer);
  }

  async repairVerificationIssues(
    draft: string,
    verification: JudgeVerification,
    prompt: string,
    analysis: StructuredJudgeAnalysis,
    participants: ParticipantOutput[],
    evidence: EvidencePool,
    recoveryNotes = "",
  ): Promise<string> {
    const issues = [
      ...verification.unsupportedClaims.map((c) => `Unsupported claim: ${c}`),
      ...verification.missingContradictions.map((c) => `Missing contradiction: ${c}`),
      ...verification.citationIssues.map((c) => `Citation issue: ${c}`),
      ...verification.remainingCaveats.map((c) => `Caveat: ${c}`),
    ].join("\n");
    if (!issues.trim()) return "";

    const participantSummaries = participants.map(formatParticipantForJudge).join("\n\n");
    const evidenceText = evidence.entries.length > 0
      ? evidence.entries.map(formatEvidenceLine).join("\n")
      : "No evidence available.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: VERIFY_REPAIR] You are repairing a draft answer after verification found concrete gaps.

Use only the user's prompt, participant answers, existing evidence, public web tools, and deterministic bash. Do not look up benchmark rubrics, answer keys, local scoring JSON, prior benchmark outputs, or evaluation artifacts.

For each verification issue:
- If a requested metric/detail/source is missing, make one or more targeted web_search/web_fetch attempts using exact named entities, years, source families, and terms from the issue.
- If evidence is already present but buried in a long filing/report/table, extract the exact value, period, entity, definition, and source ID/URL from existing evidence.
- For SEC filings and long reports, use focused web_fetch terms like the missing metric + entity + reporting period.
- Use bash for arithmetic checks when inputs are available.
- Preserve useful candidate facts with confidence labels when primary support is incomplete; do not replace requested facts with broad unavailability caveats.
- Prefer official filings, official rule text, official vendor docs, public-health surveillance, operational reports, peer-reviewed studies, or original program/product pages.
- For financial-filing gaps, extract exact values into a requested-item ledger rather than prose summaries. Include adjacent source-backed facts that materially explain strategy or risk: financing mix, equity issuance/ATM/forward sales/settlements/proceeds, full loan terms, acquisition accounting/control losses, segment trends, geography/asset concentration, ownership/NCI economics, capital-mix ratios, and disclosed causes such as shortened hold periods, market pressure, investor liquidity pressure, AUM runoff, fee decline, structured-financing headwinds, refinancing risk, or capital-velocity pressure. For ERP/UX gaps, map official SAP/NetSuite patterns to the concrete workflow/user segment.
- ${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE}
- ${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE}
- ${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE}

Return concise markdown repair notes only. Include a table with columns: verification issue, repaired value/finding, source ID/URL, confidence, remaining limitation, final-answer action. Do not write the final answer.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n${this.obligationText}\n\n## Existing Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Verification Issues\n${issues}\n\n## Draft Answer\n${draft}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Participant Answers\n${participantSummaries}\n\n## Existing Evidence\n${evidenceText}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);
    return result.answer;
  }

  async revise(
    draft: string,
    verification: JudgeVerification,
    prompt?: string,
    evidence?: EvidencePool,
    recoveryNotes = "",
    analysis?: StructuredJudgeAnalysis,
    participants: ParticipantOutput[] = [],
  ): Promise<string> {
    const issues = [
      ...verification.unsupportedClaims.map((c) => `Unsupported claim: ${c}`),
      ...verification.missingContradictions.map((c) => `Missing contradiction: ${c}`),
      ...verification.citationIssues.map((c) => `Citation issue: ${c}`),
      ...verification.remainingCaveats.map((c) => `Caveat: ${c}`),
    ].join("\n");
    const participantSummaries = participants.length > 0
      ? participants.map(formatParticipantForJudge).join("\n\n")
      : "No participant answers provided to revise phase.";
    const evidenceText = evidence?.entries.length
      ? evidence.entries.map(formatEvidenceLine).join("\n")
      : "No evidence available.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: REVISE] You are the final synthesizer revising a user-facing answer to fix verification issues.
Fix all listed issues while preserving the overall quality and structure. Ensure the answer covers the user-prompt-derived requirement checklist or clearly explains unavailable information.
Use the structured analysis, participant answers, recovery notes, and evidence as private scaffolding. If fixing an unsupported claim would remove useful coverage, first try to replace it with a supported, caveated version from the original participant/evidence context.
Do not call tools during revision. Repair the answer from the original draft, participant answers, recovery notes, verification issues, and evidence already provided. Remove or downgrade public-health findings that rely on presumed, likely, generally known, structural-model, uncited distance/referral-time/staffing, or non-source-reported workforce-ratio claims; state "not recovered in this run" with the best source-bound partial fact instead. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${FINANCIAL_FILING_SOURCE_GUIDANCE} ${FINANCIAL_FILING_ANSWER_STRUCTURE} ${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE} ${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE} ${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE} ${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE} ${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE} ${FINANCIAL_FILING_VERIFICATION_GATE_GUIDANCE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} ${ENTERPRISE_UX_SOURCE_GUIDANCE} ${ENTERPRISE_UX_ANSWER_STRUCTURE} ${RESEARCH_DOMAIN_SOURCE_GUIDANCE} ${RESEARCH_DOMAIN_ANSWER_STRUCTURE} ${EXACT_FACT_COVERAGE_GUIDANCE} ${COMPLETENESS_REPAIR_GUIDANCE} ${REQUESTED_ITEM_LEDGER_GUIDANCE} For financial-filing revisions, first resolve private recovery-note conflicts into primary/context-only/include-with-caveat/exclude decisions, then ensure the public ledger contains every primary or include-with-caveat fact. Do not output “not recovered” for a fact that appears in recovery notes or evidence with a specific filing citation unless the revised answer gives the precise source contradiction. Do not look up benchmark rubrics, answer keys, or evaluation artifacts.
Return only the revised user-facing answer. Do not mention the revision process or internal checklist. Do not output diagnostic sections named "Structured Judge Analysis", "Judge Verification", "Participants", "Workspace Sandboxes", "Evidence", or "Artifacts" unless the user explicitly asks for diagnostics.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt ?? "Not provided"}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${analysis ? JSON.stringify(analysis, null, 2) : "No structured analysis provided to revise phase."}\n\n## Participant Answers\n${participantSummaries}\n\n## Evidence\n${evidenceText}\n\n## Original Draft\n${draft}\n\n## Issues to Fix\n${issues}`,
      }],
      tools: undefined,
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    if (evidence) this.mergeEvidence(evidence, result.evidence);

    return result.answer;
  }

  async hardenWithVerificationIssues(
    draft: string,
    verification: JudgeVerification,
    prompt: string,
    evidence: EvidencePool,
    recoveryNotes = "",
    analysis?: StructuredJudgeAnalysis,
    participants: ParticipantOutput[] = [],
  ): Promise<string> {
    const issues = [
      ...verification.unsupportedClaims.map((c) => `Unsupported claim: ${c}`),
      ...verification.missingContradictions.map((c) => `Missing contradiction: ${c}`),
      ...verification.citationIssues.map((c) => `Citation issue: ${c}`),
      ...verification.remainingCaveats.map((c) => `Caveat: ${c}`),
    ].join("\n");
    if (!issues.trim()) return draft;

    const participantSummaries = participants.length > 0
      ? participants.map(formatParticipantForJudge).join("\n\n")
      : "No participant answers provided to final hardening phase.";
    const evidenceText = evidence.entries.length > 0
      ? evidence.entries.map(formatEvidenceLine).join("\n")
      : "No evidence available.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: FINAL_HARDEN] You are performing the final user-facing hardening pass after verification found concrete unresolved issues.
Your job is to integrate the listed verification issues into the main answer, not to append an audit report.

Rules:
- For every listed issue, either add the concrete fact/detail directly to the relevant section/table/ledger, or explicitly reject it in the answer with a source-based reason.
- If an issue contains exact values, periods, source names, formulas, or caveats, preserve those specifics in the main answer unless contradicted by stronger source evidence already present.
- Treat the issue list as a mandatory private checklist: before returning, every issue must be visibly resolved in the user-facing answer by an added/edited sentence, row, or formula. Do not rely on the reader inferring resolution from separately listed components.
- Do not create a section named "Verification Gaps", "Judge Verification", "Structured Judge Analysis", "Participants", "Workspace Sandboxes", "Evidence", or "Artifacts".
- Do not output or preserve internal-audit phrases such as "Internal Fusion Requirement Checklist", "still needs review", "best current synthesis", "citation/source issue", "remaining caveat", or "verification issue"; rewrite them as ordinary inline source/confidence notes or remove them.
- Do not say the issue still needs review when the issue itself contains a source-backed candidate fact. Include the candidate with confidence/scope caveats instead.
- For source-heavy prompts, add or update a compact requested-item/evidence coverage ledger with columns like item, finding/value, formula/status, source, confidence/limit.
- For strategic corporate-filing prompts, each major section must start with a finding sentence before sources, tables, or ledgers; the final conclusion should synthesize mechanisms, not just restate table rows.
- For corporate-filing prompts, include source-backed financing mix, equity issuance/ATM/forward-sale settlements and outstanding capacity, loan terms, segment trends, geographic or property concentration, ownership/control constraints, impairment timing, capital-mix ratios, and management-disclosed causes when those facts appear in recovery notes, participants, evidence, or verification issues.
- If evidence contains multiple candidates for the same financing fact, prefer latest-period SEC filing tables or named property/loan/equity-program rows over older quarters, supplements, or prose summaries; keep the weaker candidate only as context unless there is a source-based reason to prefer it.
- When source-backed component values support a useful aggregate or ratio, include a clearly scoped calculation row while also separating actual cash/proceeds from outstanding forward capacity, unused capacity, context-only figures, or non-cash accounting effects.
- If both debt financing and equity/ATM/forward-sale financing inputs are present, compute a debt-to-total-capital, equity-to-total-capital, or debt/equity mix ratio from the non-overlapping values and explain whether it supports balance-sheet discipline or capital pressure.
- If gross amount and company-share/proportionate-share amount are both present, compute the company-share percentage and explicitly connect minority/economic share to control, disposition, or recovery-strategy limits when strategy or risk is at issue.
- If old and new rates, spreads, margins, coupons, borrowing capacity, or guarantees are both present, compute the absolute basis-point or dollar delta and include it next to the old/new comparison.
- For corporate-filing prompts, if the answer already contains cash consideration plus paydown/payoff/note funding, add the combined cash deployment formula; if a verification issue asks for a caveated aggregate from those components, add that exact aggregate/formula in the relevant ledger or acquisition section even when another leverage or purchase-price-less-debt lens is also retained.
- If it contains equity proceeds already received plus outstanding forward-sale aggregate value/net value, add the combined non-overlapping capital raised/contracted formula and, when the prompt asks issuance/financing scale, a total issued/forward-sale exposure formula; keep unused capacity separate.
- If a strategy/risk issue names geographic concentration, timing urgency, capital velocity, control/minority constraints, disposition/recovery decision rights, market pressure, investor liquidity, fee/AUM decline, structured-financing headwinds, liquidity pressure, or management-disclosed causes, add an explicit analytical sentence using those terms in the overall judgment or relevant risk section. A table-only mention is insufficient.
- For segment or platform deterioration, add a named-driver sentence covering every retrieved driver family; if only one family is source-backed, say that limitation explicitly instead of implying a broader mechanism.
- If participant unique insights explain a causal mechanism, such as why shortened hold periods imply accelerated exits or why a low company-share/proportionate-share figure limits control over troubled assets, preserve that mechanism in prose even when the exact number already appears in a table.
- If a caveated fact is supported enough to include but not enough to state unconditionally, include it with words like "if non-overlapping", "scope caveat", "source-backed but not a literal cash-flow statement", or "not established beyond the retrieved filings" rather than omitting it.
- Preserve the existing answer's useful structure and citations.
- Before returning, scan the answer for internal headings or audit prose and delete/rewrite them.
- Do not use tools. Do not look up benchmark rubrics, answer keys, local scoring JSON, prior benchmark outputs, or evaluation artifacts.

${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE}
${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE}
${FINANCIAL_FILING_SOURCE_GUIDANCE} ${FINANCIAL_FILING_ANSWER_STRUCTURE}
${FINANCIAL_FILING_ADJACENT_FACT_GUIDANCE}
${FINANCIAL_FILING_SYNTHESIS_DEPTH_GUIDANCE}
${FINANCIAL_FILING_SCOPE_ARBITRATION_GUIDANCE}
${FINANCIAL_FILING_FACT_RETENTION_GUIDANCE}
${FINANCIAL_FILING_REPAIR_SETTLEMENT_GUIDANCE}
${EXACT_FACT_COVERAGE_GUIDANCE}
${COMPLETENESS_REPAIR_GUIDANCE}
${REQUESTED_ITEM_LEDGER_GUIDANCE}

Return only the hardened user-facing answer.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${analysis ? JSON.stringify(analysis, null, 2) : "No structured analysis provided."}\n\n## Participant Answers\n${participantSummaries}\n\n## Evidence\n${evidenceText}\n\n## Current User-Facing Answer\n${draft}\n\n## Verification Issues To Integrate Into Main Answer\n${issues}`,
      }],
      tools: undefined,
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);
    return result.answer;
  }
}
