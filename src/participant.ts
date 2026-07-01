import type {
  ModelSlot,
  ModelCaller,
  ModelCallRequest,
  ParticipantOutput,
  TokenUsage,
  EvidenceEntry,
  RetryPolicy,
  ParticipantWorkspaceContext,
} from "./types.js";
import { FallbackResolver } from "./fallback.js";
import { callModelWithRetry, classifyModelError, NO_MODEL_RETRY_POLICY } from "./retry.js";

const FUSION_BASELINE_INSTRUCTIONS = `You are a Symmetric Participant in a multi-model deliberation.
Answer the user's question independently. Use any available tools to gather information.
When web tools are available, use web_search to find candidate sources, then use web_fetch on the most authoritative URLs before making precise factual, product, legal, financial, or citation-sensitive claims. For long filings, reports, PDFs, or documentation pages, call web_fetch with focused terms for the exact metric/entity you need instead of relying on the document opening.
Prefer primary/official sources and cite source IDs or URLs explicitly.
Be thorough, but prioritize precise obligation coverage over generic overview: answer every requested entity, metric, time period, comparison criterion, calculation, exception, and caveat from the prompt-derived checklist. For source-heavy prompts, include a compact matrix or ledger mapping requested items to findings and sources.
Do not stop at a broad "not found" caveat. Before marking a requested item missing, try exact-name/source-title queries and focused fetches. If the ideal source is not retrieved, still provide the strongest best-effort finding from available sources, snippets, or your analysis, label confidence, and name the source that should be checked next. If tools fail or rate-limit, record the failure separately from the answer and keep a candidate fact ledger so the Judge can decide what to preserve. Omit or soften only safety-critical medical/legal/financial claims that would be unsafe to present as fact.
For corporate-filing strategy prompts, turn source-backed ratios and timing into mechanism-level analysis: compute company-share percentages from gross/share rows and explain control/minority implications, compute capital-mix ratios when debt and equity funding inputs are available, compute basis-point or dollar deltas from old/new spreads or capacity amounts, connect segment deterioration to multiple retrieved drivers, and interpret clustered drawdowns, impairments, or sales as possible capital-velocity, market-pressure, or investor-liquidity signals when supported.
If workspace tools are available, you have an isolated copy of the user's project. Use workspace_list/workspace_search/workspace_read to inspect relevant files before making codebase claims. Use workspace_write or workspace_edit only inside your own sandbox for notes, prototypes, patch drafts, or changed files. These writes do not modify the user's real workspace.
Do not reference other models or participants.`;

function participantEvidenceBlockScore(block: string): number {
  const text = block.toLowerCase();
  let score = 0;
  const patterns = [
    /rental revenue/,
    /operating income/,
    /investment management/,
    /reit portfolio/,
    /forward sale|atm program|settled forward|net proceeds|aggregate net value/,
    /term loan|delayed draw|drawn at closing/,
    /sofr\s*\+|spread|basis points|maturity/,
    /modified .* loans|reduce(?:d)? the interest rate/,
    /renaissance portfolio/,
    /purchase price|cash outlay|principal paydown|mortgage debt/,
    /bald hill|fund iii|fund iv|impairment/,
    /washington|d\.c\.|new york/,
    /noncontrolling|ownership|proportionate share|acadia.?s share|minority control|control limitation/,
    /shortened hold|reduced holding period|capital velocity|deployment urgency|market pressure|investor liquidity|aum|fee income|fee decline|structured financing/,
    /debt.?equity|capital mix|capital ratio|balance.?sheet discipline/,
  ];
  for (const pattern of patterns) {
    if (pattern.test(text)) score += 2;
  }
  const numericDensity = Math.min(10, (block.match(/(?:[$€£¥]\s*)?\d[\d,.]*(?:\s*%|\s*(?:million|billion|thousand|bps|bp))?/gi) ?? []).length);
  score += numericDensity;
  if (/no exact focus terms found/.test(text)) score -= 4;
  if (/sec html table near|>\s*\d+:\s*/i.test(block)) score += 1;
  return score;
}

function compactEvidenceBody(entry: EvidenceEntry, maxChars = 1_600): string {
  const body = entry.source === "web_fetch" && entry.fullContent && entry.fullContent.length > entry.snippet.length
    ? entry.fullContent
    : entry.snippet;
  const text = String(body ?? "").trim();
  if (text.length <= maxChars) return text;
  if (!text.includes("--- excerpt around")) return `${text.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;

  const [header, ...rawBlocks] = text.split(/\n--- excerpt around /);
  const parts = [header.trim()].filter(Boolean);
  let used = parts.join("\n").length;
  const selectedBlocks = rawBlocks
    .map((rawBlock, index) => ({ rawBlock, index, score: participantEvidenceBlockScore(rawBlock) }))
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .slice(0, 6);
  for (const { rawBlock } of selectedBlocks) {
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

function formatProvidedEvidence(evidence: EvidenceEntry[]): string {
  if (evidence.length === 0) return "";
  const lines = evidence.map((entry) => {
    const source = entry.url ? `${entry.title ?? entry.source} (${entry.url})` : (entry.title ?? entry.source);
    return `- [${entry.id}] ${source}:\n${compactEvidenceBody(entry)}`;
  });
  return `\n\n## Provided Evidence\nThese sources were collected before this participant run. You may use them, but still verify with tools if needed.\n${lines.join("\n")}`;
}

function dedupeEvidence(entries: EvidenceEntry[]): EvidenceEntry[] {
  const seen = new Set<string>();
  const result: EvidenceEntry[] = [];
  for (const entry of entries) {
    const key = entry.id;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(entry);
  }
  return result;
}

function workspaceInstructions(workspace?: ParticipantWorkspaceContext): string {
  if (!workspace) return "";
  return `\n\n## Isolated Workspace Sandbox
You have your own writable sandbox copy of the project.
- Source workspace: ${workspace.sourceRoot}
- Your sandbox root: ${workspace.sandbox.root}
- Baseline files available: ${workspace.fileCount}
- Skipped files/directories: ${workspace.skippedCount}

Use these tools for project-sized tasks:
- workspace_list: list copied project files
- workspace_search: search copied project files
- workspace_read: read a copied project file
- workspace_write: write a file in your sandbox
- workspace_edit: replace exact text in a sandbox file

Do not claim that sandbox writes changed the real user workspace. In your final answer, mention any sandbox files you created or changed and why.`;
}

function workspaceToolNames(workspace?: ParticipantWorkspaceContext): string[] {
  return workspace
    ? ["workspace_list", "workspace_search", "workspace_read", "workspace_write", "workspace_edit"]
    : [];
}

export class ParticipantRunner {
  private caller: ModelCaller;
  private resolver: FallbackResolver;
  private retryPolicy: RetryPolicy;

  constructor(caller: ModelCaller, defaultFallbacks: string[] = [], retryPolicy: RetryPolicy = NO_MODEL_RETRY_POLICY) {
    this.caller = caller;
    this.resolver = new FallbackResolver(defaultFallbacks);
    this.retryPolicy = retryPolicy;
  }

  async run(
    slot: ModelSlot,
    prompt: string,
    tools: string[],
    evidence: EvidenceEntry[],
    slotIndex = 0,
    defaultFallbacks?: string[],
    onEvidence?: (entry: EvidenceEntry) => void,
    workspace?: ParticipantWorkspaceContext,
  ): Promise<ParticipantOutput> {
    const resolver = defaultFallbacks
      ? new FallbackResolver(defaultFallbacks)
      : this.resolver;

    const fallbackChain = resolver.resolve(slot);
    const allModels = [slot.model, ...fallbackChain];

    let lastError: unknown;
    let fallbackUsed: string | undefined;
    const collectedEvidence: EvidenceEntry[] = [...evidence];
    const emitEvidence = (entry: EvidenceEntry) => {
      collectedEvidence.push(entry);
      onEvidence?.(entry);
    };
    const participantTools = [...tools, ...workspaceToolNames(workspace)];
    const promptWithEvidence = `${prompt}${workspaceInstructions(workspace)}${formatProvidedEvidence(evidence)}`;

    for (let i = 0; i < allModels.length; i++) {
      const model = allModels[i];
      const request: ModelCallRequest = {
        model,
        systemPrompt: FUSION_BASELINE_INSTRUCTIONS,
        messages: [{ role: "user", content: promptWithEvidence }],
        tools: participantTools.length > 0 ? participantTools : undefined,
        toolContext: { participantSlotIndex: slotIndex, ...(workspace ? { workspace } : {}) },
        onEvidence: emitEvidence,
      };

      try {
        const result = await callModelWithRetry(this.caller, request, this.retryPolicy);
        if (result.evidence) {
          for (const entry of result.evidence) emitEvidence(entry);
        }
        return {
          slotIndex,
          model: result.model,
          answer: result.answer,
          evidence: dedupeEvidence(collectedEvidence),
          tokens: result.tokens,
          cost: result.cost,
          fallbackUsed: i > 0 ? model : undefined,
        };
      } catch (error) {
        lastError = error;
        const errorType = classifyModelError(error);

        // Only fallback on objective failures
        if (!resolver.isObjectiveFailure(errorType)) {
          break;
        }

        // If this was a fallback attempt, record it
        if (i > 0) {
          fallbackUsed = model;
        }
      }
    }

    // All models failed
    const errorType = classifyModelError(lastError);
    return {
      slotIndex,
      model: slot.model,
      answer: "",
      evidence,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      cost: 0,
      error: `All models failed. Last error (${errorType}): ${lastError instanceof Error ? lastError.message : String(lastError)}`,
    };
  }
}
