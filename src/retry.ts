import type {
  FusionErrorType,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
  RetryPolicy,
} from "./types.js";
import { FusionError } from "./types.js";

export const DEFAULT_MODEL_RETRY_POLICY: RetryPolicy = {
  maxRetries: 5,
  initialDelayMs: 5_000,
  maxDelayMs: 120_000,
  backoffMultiplier: 2,
  jitterRatio: 0.2,
};

export const NO_MODEL_RETRY_POLICY: RetryPolicy = {
  maxRetries: 0,
  initialDelayMs: 0,
  maxDelayMs: 0,
  backoffMultiplier: 1,
  jitterRatio: 0,
};

const ERROR_TYPES = new Set<FusionErrorType>([
  "rate_limit",
  "quota",
  "timeout",
  "network",
  "empty_response",
  "context_limit",
  "provider_error",
  "unknown",
]);

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function explicitErrorType(error: unknown): FusionErrorType | undefined {
  if (error instanceof FusionError) return error.errorType;
  const value = (error as { errorType?: unknown })?.errorType;
  return typeof value === "string" && ERROR_TYPES.has(value as FusionErrorType)
    ? value as FusionErrorType
    : undefined;
}

export function classifyModelError(error: unknown): FusionErrorType {
  const explicit = explicitErrorType(error);
  // Provider wrappers often use a coarse provider_error while preserving the
  // provider's real message. Keep precise explicit types, but refine coarse
  // ones from the message below so 429/quota/timeouts get the right behavior.
  if (explicit && explicit !== "provider_error" && explicit !== "unknown") return explicit;

  const msg = messageOf(error).toLowerCase();

  // Quota/billing exhaustion should fall back immediately, not retry.
  if (
    msg.includes("quota") ||
    msg.includes("insufficient_quota") ||
    msg.includes("insufficient quota") ||
    msg.includes("insufficient balance") ||
    msg.includes("balance") ||
    msg.includes("credit") ||
    msg.includes("billing") ||
    msg.includes("payment required") ||
    msg.includes("usage limit") ||
    msg.includes("monthly limit") ||
    msg.includes("hard limit")
  ) return "quota";

  if (msg.includes("429") || msg.includes("rate limit") || msg.includes("rate_limit") || msg.includes("too many requests")) return "rate_limit";
  if (msg.includes("timeout") || msg.includes("timed out") || msg.includes("deadline") || msg.includes("websocket closed 1006") || msg === "terminated" || msg.includes("terminated")) return "timeout";
  if (
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("econnrefused") ||
    msg.includes("econnreset") ||
    msg.includes("enotfound") ||
    msg.includes("socket") ||
    msg.includes("connection")
  ) return "network";
  if (msg.includes("empty") || msg.includes("no content")) return "empty_response";
  if (msg.includes("context") || msg.includes("too long") || msg.includes("length") || msg.includes("maximum tokens")) return "context_limit";
  if (
    msg.includes("400") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("422") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("529") ||
    msg.includes("content_filter") ||
    msg.includes("new_sensitive") ||
    msg.includes("sensitive") ||
    msg.includes("safety") ||
    msg.includes("unprocessable") ||
    msg.includes("overloaded") ||
    msg.includes("busy") ||
    msg.includes("temporarily unavailable") ||
    msg.includes("try again")
  ) return "provider_error";
  return explicit ?? "unknown";
}

export function isRetryableModelError(errorType: FusionErrorType, error: unknown): boolean {
  const msg = messageOf(error).toLowerCase();

  // These are not fixed by waiting; switch to fallback instead.
  if (errorType === "quota" || errorType === "context_limit") return false;

  // Moderation / invalid-auth / bad-request failures should not be retried with
  // the same payload. They may be handled by fallback or future payload
  // reduction/sanitization logic.
  if (
    msg.includes("new_sensitive") ||
    msg.includes("content_filter") ||
    msg.includes("safety") ||
    msg.includes("policy") ||
    msg.includes("invalid api key") ||
    msg.includes("no api key") ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("401") ||
    msg.includes("403") ||
    msg.includes("400") ||
    msg.includes("422")
  ) return false;

  if (errorType === "rate_limit" || errorType === "timeout" || errorType === "network" || errorType === "empty_response") return true;

  if (errorType === "provider_error") {
    return (
      msg.includes("500") ||
      msg.includes("502") ||
      msg.includes("503") ||
      msg.includes("504") ||
      msg.includes("529") ||
      msg.includes("overloaded") ||
      msg.includes("busy") ||
      msg.includes("temporarily unavailable") ||
      msg.includes("try again") ||
      msg.includes("capacity") ||
      msg.includes("concurrency") ||
      msg.includes("upstream") ||
      msg.includes("websocket closed") ||
      msg.includes("fetch failed")
    );
  }

  return false;
}

export function normalizeRetryPolicy(policy?: Partial<RetryPolicy>): RetryPolicy {
  const merged = { ...DEFAULT_MODEL_RETRY_POLICY, ...(policy ?? {}) };
  return {
    maxRetries: Math.max(0, Math.min(10, Math.floor(merged.maxRetries))),
    initialDelayMs: Math.max(0, Math.min(600_000, Math.floor(merged.initialDelayMs))),
    maxDelayMs: Math.max(0, Math.min(900_000, Math.floor(merged.maxDelayMs))),
    backoffMultiplier: Math.max(1, Math.min(10, merged.backoffMultiplier)),
    jitterRatio: Math.max(0, Math.min(1, merged.jitterRatio)),
  };
}

export function retryDelayMs(policy: RetryPolicy, retryNumber: number): number {
  const normalized = normalizeRetryPolicy(policy);
  if (normalized.maxRetries <= 0) return 0;
  const exponent = Math.max(0, retryNumber - 1);
  const base = normalized.initialDelayMs * normalized.backoffMultiplier ** exponent;
  const capped = Math.min(normalized.maxDelayMs, base);
  if (normalized.jitterRatio <= 0 || capped <= 0) return Math.round(capped);
  const spread = capped * normalized.jitterRatio;
  const jittered = capped + (Math.random() * 2 - 1) * spread;
  return Math.max(0, Math.round(jittered));
}

export function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function callModelWithRetry(
  caller: ModelCaller,
  request: ModelCallRequest,
  retryPolicy?: Partial<RetryPolicy>,
  onRetry?: (event: { model: string; attempt: number; maxRetries: number; delayMs: number; errorType: FusionErrorType; error: unknown }) => void,
): Promise<ModelCallResult> {
  const policy = normalizeRetryPolicy(retryPolicy);
  let failures = 0;
  let lastError: unknown;

  while (true) {
    try {
      return await caller.call(request);
    } catch (error) {
      lastError = error;
      const errorType = classifyModelError(error);
      if (failures < policy.maxRetries && isRetryableModelError(errorType, error)) {
        failures++;
        const delayMs = retryDelayMs(policy, failures);
        onRetry?.({ model: request.model, attempt: failures, maxRetries: policy.maxRetries, delayMs, errorType, error });
        await sleep(delayMs);
        continue;
      }

      if (failures > 0) {
        throw new FusionError(
          `${messageOf(error)} (after ${failures + 1} attempts; retry policy exhausted)`,
          errorType,
        );
      }
      throw error;
    }
  }

  // Unreachable, but keeps TypeScript happy if control-flow analysis changes.
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
