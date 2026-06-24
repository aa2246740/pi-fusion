import type { ModelSlot, FusionErrorType } from "./types.js";

const OBJECTIVE_FAILURE_TYPES = new Set<FusionErrorType>([
  "rate_limit",
  "quota",
  "timeout",
  "network",
  "empty_response",
  "context_limit",
  "provider_error",
]);

export class FallbackResolver {
  private defaultFallbacks: string[];

  constructor(defaultFallbacks: string[]) {
    this.defaultFallbacks = [...defaultFallbacks];
  }

  /**
   * Returns the effective fallback chain for a Model Slot.
   * Slot fallbacks replace default fallbacks (not append).
   */
  resolve(slot: ModelSlot): string[] {
    if (slot.fallbacks && slot.fallbacks.length > 0) {
      return [...slot.fallbacks];
    }
    return [...this.defaultFallbacks];
  }

  /**
   * Returns true if the error type is an objective invocation failure
   * that should trigger fallback. Returns false for unknown/quality failures.
   */
  isObjectiveFailure(errorType: FusionErrorType): boolean {
    return OBJECTIVE_FAILURE_TYPES.has(errorType);
  }
}
