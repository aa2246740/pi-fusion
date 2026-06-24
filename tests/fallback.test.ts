import { describe, it, expect } from "vitest";
import { FallbackResolver } from "../src/fallback.js";
import type { ModelSlot, FusionErrorType } from "../src/types.js";

describe("FallbackResolver", () => {
  const defaultFallbacks = ["google/gemini-2.5-flash", "deepseek/deepseek-r1"];

  it("returns slot fallbacks when present, ignoring defaults", () => {
    const resolver = new FallbackResolver(defaultFallbacks);
    const slot: ModelSlot = {
      model: "anthropic/claude-opus-4-5",
      fallbacks: ["openai/gpt-4.1"],
    };
    expect(resolver.resolve(slot)).toEqual(["openai/gpt-4.1"]);
  });

  it("returns default fallbacks when slot has none", () => {
    const resolver = new FallbackResolver(defaultFallbacks);
    const slot: ModelSlot = { model: "anthropic/claude-opus-4-5" };
    expect(resolver.resolve(slot)).toEqual(["google/gemini-2.5-flash", "deepseek/deepseek-r1"]);
  });

  it("returns empty chain when neither slot nor defaults have fallbacks", () => {
    const resolver = new FallbackResolver([]);
    const slot: ModelSlot = { model: "anthropic/claude-opus-4-5" };
    expect(resolver.resolve(slot)).toEqual([]);
  });

  it("classifies objective failures correctly", () => {
    const resolver = new FallbackResolver([]);
    const objectiveFailures: FusionErrorType[] = [
      "rate_limit",
      "quota",
      "timeout",
      "network",
      "empty_response",
      "context_limit",
      "provider_error",
    ];
    for (const errorType of objectiveFailures) {
      expect(resolver.isObjectiveFailure(errorType)).toBe(true);
    }
  });

  it("rejects unknown as objective failure", () => {
    const resolver = new FallbackResolver([]);
    expect(resolver.isObjectiveFailure("unknown")).toBe(false);
  });

  it("builds full retry chain: slot fallbacks + primary is not included", () => {
    const resolver = new FallbackResolver(defaultFallbacks);
    const slot: ModelSlot = {
      model: "anthropic/claude-opus-4-5",
      fallbacks: ["openai/gpt-4.1"],
    };
    const chain = resolver.resolve(slot);
    // Should not include the primary model
    expect(chain).not.toContain("anthropic/claude-opus-4-5");
    expect(chain).toEqual(["openai/gpt-4.1"]);
  });
});
