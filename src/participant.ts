import type {
  ModelSlot,
  ModelCaller,
  ModelCallRequest,
  ParticipantOutput,
  TokenUsage,
  EvidenceEntry,
  RetryPolicy,
} from "./types.js";
import { FallbackResolver } from "./fallback.js";
import { callModelWithRetry, classifyModelError, NO_MODEL_RETRY_POLICY } from "./retry.js";

const FUSION_BASELINE_INSTRUCTIONS = `You are a Symmetric Participant in a multi-model deliberation.
Answer the user's question independently. Use any available tools to gather information.
When web tools are available, use web_search to find candidate sources, then use web_fetch on the most authoritative URLs before making precise factual, product, legal, financial, or citation-sensitive claims. For long filings, reports, PDFs, or documentation pages, call web_fetch with focused terms for the exact metric/entity you need instead of relying on the document opening.
Prefer primary/official sources and cite source IDs or URLs explicitly.
Be thorough: cover multiple angles, cite sources when possible, and distinguish facts from assumptions.
Do not reference other models or participants.`;

function formatProvidedEvidence(evidence: EvidenceEntry[]): string {
  if (evidence.length === 0) return "";
  const lines = evidence.map((entry) => {
    const source = entry.url ? `${entry.title ?? entry.source} (${entry.url})` : (entry.title ?? entry.source);
    return `- [${entry.id}] ${source}: ${entry.snippet}`;
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
    const promptWithEvidence = `${prompt}${formatProvidedEvidence(evidence)}`;

    for (let i = 0; i < allModels.length; i++) {
      const model = allModels[i];
      const request: ModelCallRequest = {
        model,
        systemPrompt: FUSION_BASELINE_INSTRUCTIONS,
        messages: [{ role: "user", content: promptWithEvidence }],
        tools: tools.length > 0 ? tools : undefined,
        toolContext: { participantSlotIndex: slotIndex },
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
