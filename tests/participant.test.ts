import { describe, it, expect, vi } from "vitest";
import { ParticipantRunner } from "../src/participant.js";
import type { ModelCaller, ModelCallResult, FusionErrorType } from "../src/types.js";

function fakeCaller(answer: string, model?: string): ModelCaller {
  return {
    async call(request) {
      return {
        answer,
        model: model ?? request.model,
        tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      };
    },
  };
}

function failingCaller(errorType: FusionErrorType): ModelCaller {
  return {
    async call() {
      throw Object.assign(new Error(`${errorType} error`), { errorType });
    },
  };
}

describe("ParticipantRunner", () => {
  it("calls model and returns output", async () => {
    const runner = new ParticipantRunner(fakeCaller("Hello from participant"));
    const output = await runner.run(
      { model: "openai/gpt-4.1" },
      "What is 2+2?",
      [],
      [],
    );

    expect(output.answer).toBe("Hello from participant");
    expect(output.model).toBe("openai/gpt-4.1");
    expect(output.slotIndex).toBe(0);
    expect(output.error).toBeUndefined();
    expect(output.tokens.input).toBe(100);
  });

  it("uses fallback on objective failure", async () => {
    let callCount = 0;
    const caller: ModelCaller = {
      async call(request) {
        callCount++;
        if (request.model === "anthropic/claude-opus-4-5") {
          throw Object.assign(new Error("429 rate limited"), { errorType: "rate_limit" });
        }
        return {
          answer: "Fallback answer",
          model: request.model,
          tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 },
          cost: 0.005,
        };
      },
    };

    const runner = new ParticipantRunner(caller);
    const output = await runner.run(
      { model: "anthropic/claude-opus-4-5", fallbacks: ["openai/gpt-4.1"] },
      "test",
      [],
      [],
      0,
      ["google/gemini-2.5-flash"],
    );

    expect(output.answer).toBe("Fallback answer");
    expect(output.model).toBe("openai/gpt-4.1");
    expect(output.fallbackUsed).toBe("openai/gpt-4.1");
    expect(callCount).toBe(2);
  });

  it("uses default fallbacks when slot has no fallbacks", async () => {
    const caller: ModelCaller = {
      async call(request) {
        if (request.model === "anthropic/claude-opus-4-5") {
          throw Object.assign(new Error("quota exceeded"), { errorType: "quota" });
        }
        return {
          answer: "Default fallback answer",
          model: request.model,
          tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 },
          cost: 0.005,
        };
      },
    };

    const runner = new ParticipantRunner(caller);
    const output = await runner.run(
      { model: "anthropic/claude-opus-4-5" },
      "test",
      [],
      [],
      0,
      ["google/gemini-2.5-flash"],
    );

    expect(output.answer).toBe("Default fallback answer");
    expect(output.model).toBe("google/gemini-2.5-flash");
  });

  it("errors when all models fail", async () => {
    const caller = failingCaller("rate_limit");
    const runner = new ParticipantRunner(caller);
    const output = await runner.run(
      { model: "a/model1", fallbacks: ["a/model2"] },
      "test",
      [],
      [],
    );

    expect(output.error).toBeDefined();
    expect(output.error).toContain("rate_limit");
    expect(output.answer).toBe("");
  });

  it("does not fallback on non-objective failure", async () => {
    let callCount = 0;
    const caller: ModelCaller = {
      async call() {
        callCount++;
        throw Object.assign(new Error("bad output"), { errorType: "unknown" });
      },
    };

    const runner = new ParticipantRunner(caller);
    const output = await runner.run(
      { model: "a/model1", fallbacks: ["a/model2"] },
      "test",
      [],
      [],
    );

    // unknown is not objective, so should not try fallback
    expect(callCount).toBe(1);
    expect(output.error).toBeDefined();
  });
});
