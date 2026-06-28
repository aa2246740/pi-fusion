import type {
  ModelCaller,
  ParticipantOutput,
  EvidencePool,
  StructuredJudgeAnalysis,
  JudgeVerification,
} from "./types.js";

function compactFocusedFullContent(value: string, maxChars = 2_800): string {
  const text = String(value ?? "").trim();
  if (text.length <= maxChars) return text;
  if (!text.includes("--- excerpt around")) return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;

  const [header, ...rawBlocks] = text.split(/\n--- excerpt around /);
  const parts = [header.trim()].filter(Boolean);
  let used = parts.join("\n").length;
  for (const rawBlock of rawBlocks.slice(0, 6)) {
    const block = `--- excerpt around ${rawBlock}`.trim();
    const remaining = maxChars - used - 80;
    if (remaining <= 240) break;
    const clipped = block.length > Math.min(700, remaining)
      ? `${block.slice(0, Math.min(700, remaining))}\n[excerpt truncated]`
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
const AFFILIATE_REFERRAL_SOURCE_GUIDANCE = "For affiliate, referral, marketplace, partnership, lead-generation, or publisher-network questions, source-bind who performs the underlying service, who merely refers or compares providers, who owns licensing/compliance/underwriting/customer servicing, how compensation or publisher tools work, and which product lines are direct versus partner-delivered. Prefer official program, publisher, partner, terms, help-center, or product documentation before third-party affiliate-network listings. Do not infer service ownership from marketing copy alone.";
const AFFILIATE_REFERRAL_ANSWER_STRUCTURE = "When answering affiliate/referral strategy prompts, separate the business model layers: direct operator, referral/intermediary, end provider, compliance owner, customer data/lead flow, product-line fit, partnership leverage, displacement risk, and recommended positioning/actions.";

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
${AFFILIATE_REFERRAL_SOURCE_GUIDANCE}
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
- For public-health or service-delivery questions, recover source-bound numeric facts with definitions, geography, time period, numerator/denominator when available, and uncertainty. Look for coverage rates, mortality rates, cause-of-death patterns, workforce/capacity counts, referral distances/times, and before/after trajectories when the user's prompt asks for them. Do not invent derived ratios/rates; only calculate them when numerator, denominator, unit, period, and method are explicit and cite the calculation inputs.
- ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE}
- ${PERSONAL_FINANCE_SOURCE_GUIDANCE}
- ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE}
- For long filings, reports, PDFs, or documentation pages, call web_fetch with focused terms for each missing metric/entity (for example: revenue + operating income + segment name; acquisition + purchase price + assumed debt; impairment + property/fund name; public-health examples: coverage rate + year; mortality rate + setting; cause of death + surveillance; workforce count + referral time).
- Use bash for arithmetic and table checks.
- Prefer primary/official sources, filings, vendor docs, surveillance reports, peer-reviewed papers, or original documentation.
- If a requested value cannot be found after targeted attempts, say so and explain what source would be needed.

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
Use the requirement checklist and recovery notes as a coverage gate: every user-requested metric, source category, comparison, calculation, and caveat should be answered with source support or explicitly marked unavailable after targeted attempts.
Use web_search/web_fetch to fill important factual/source gaps before making precise claims. For public-health/service-delivery comparisons, preserve source-bound definitions, geography, time period, numerator/denominator when available, and uncertainty; include requested coverage, mortality, cause, workforce/capacity, referral, and trajectory metrics only when supported. Distinguish “not retrieved in this run” from “not publicly available”: retain partial, dated, or non-comparable estimates with clear caveats instead of replacing them with a blanket data-unavailable claim. Do not invent derived ratios/rates; calculate them only when numerator, denominator, unit, period, and method are explicit, and cite the calculation inputs. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} For long filings/reports/docs, use focused web_fetch terms for each missing metric/entity. Use bash for calculations. Do not use tools to look up benchmark rubrics, answer keys, or evaluation artifacts.
Do not mention the deliberation process or the internal checklist. Do not output sections named "Structured Judge Analysis", "Judge Verification", "Participants", "Workspace Sandboxes", "Evidence", or "Artifacts" unless the user explicitly asks for diagnostics.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Participant Answers\n${participantSummaries}${evidenceText}`,
      }],
      tools: this.requestTools(),
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
  ): Promise<JudgeVerification> {
    const evidenceText = evidence.entries.length > 0
      ? evidence.entries.map(formatEvidenceLine).join("\n")
      : "No evidence available.";

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: VERIFY] You are verifying a draft answer against structured analysis and evidence.
Check for:
- Claims not supported by participant answers or evidence
- Contradictions the analysis found but the draft ignores
- Citations that don't actually support the claims they're attached to
- Remaining caveats or uncertainties
- Missing coverage for any item in the user-prompt-derived requirement checklist

Use web_search/web_fetch for verification when support is unclear; for long source documents, use focused web_fetch terms. For public-health/service-delivery drafts, verify that numeric coverage/mortality/cause/workforce/referral/trajectory claims include source IDs or URLs, definitions, setting, period, and uncertainty where available. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} Use bash for arithmetic checks. Do not use tools to look up benchmark rubrics, answer keys, or evaluation artifacts.

Return a JSON object:
- unsupportedClaims: string[]
- missingContradictions: string[]
- citationIssues: string[]
- remainingCaveats: string[]
- pass: boolean (true if no critical issues)

Return ONLY valid JSON, no markdown fencing.`,
      messages: [{
        role: "user",
        content: `## Draft Answer\n${draft}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Structured Analysis\n${JSON.stringify(analysis, null, 2)}\n\n## Evidence\n${evidenceText}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    this.mergeEvidence(evidence, result.evidence);

    return parseJsonResponse<JudgeVerification>(result.answer);
  }

  async revise(draft: string, verification: JudgeVerification, prompt?: string, evidence?: EvidencePool, recoveryNotes = ""): Promise<string> {
    const issues = [
      ...verification.unsupportedClaims.map((c) => `Unsupported claim: ${c}`),
      ...verification.missingContradictions.map((c) => `Missing contradiction: ${c}`),
      ...verification.citationIssues.map((c) => `Citation issue: ${c}`),
      ...verification.remainingCaveats.map((c) => `Caveat: ${c}`),
    ].join("\n");

    const result = await this.caller.call({
      model: this.model,
      systemPrompt: `[PHASE: REVISE] You are the final synthesizer revising a user-facing answer to fix verification issues.
Fix all listed issues while preserving the overall quality and structure. Ensure the answer covers the user-prompt-derived requirement checklist or clearly explains unavailable information.
Use web_search/web_fetch only if needed to repair source support, and bash only if needed for deterministic calculations. ${PRODUCT_PROCUREMENT_SOURCE_GUIDANCE} ${PRODUCT_PROCUREMENT_ANSWER_STRUCTURE} ${PERSONAL_FINANCE_SOURCE_GUIDANCE} ${PERSONAL_FINANCE_ANSWER_STRUCTURE} ${AFFILIATE_REFERRAL_SOURCE_GUIDANCE} ${AFFILIATE_REFERRAL_ANSWER_STRUCTURE} Do not use tools to look up benchmark rubrics, answer keys, or evaluation artifacts.
Return only the revised user-facing answer. Do not mention the revision process or internal checklist. Do not output diagnostic sections named "Structured Judge Analysis", "Judge Verification", "Participants", "Workspace Sandboxes", "Evidence", or "Artifacts" unless the user explicitly asks for diagnostics.`,
      messages: [{
        role: "user",
        content: `## User Question\n${prompt ?? "Not provided"}\n\n${this.obligationText}\n\n## Recovery Notes\n${recoveryNotes || "No separate recovery notes."}\n\n## Original Draft\n${draft}\n\n## Issues to Fix\n${issues}`,
      }],
      tools: this.requestTools(),
      toolContext: { judge: true, participantSlotIndex: -1 },
    });
    if (evidence) this.mergeEvidence(evidence, result.evidence);

    return result.answer;
  }
}
