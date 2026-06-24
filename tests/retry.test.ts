import { describe, it, expect, vi } from "vitest";
import { callModelWithRetry, classifyModelError, isRetryableModelError, retryDelayMs } from "../src/retry.js";
import type { ModelCaller } from "../src/types.js";

describe("retry", () => {
  it("classifies quota before rate limits so callers can fall back immediately", () => {
    expect(classifyModelError(new Error("429 insufficient quota / billing limit"))).toBe("quota");
    expect(classifyModelError(Object.assign(new Error("429 rate limit"), { errorType: "provider_error" }))).toBe("rate_limit");
    expect(isRetryableModelError("quota", new Error("insufficient quota"))).toBe(false);
  });

  it("retries transient rate limits with backoff", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const caller: ModelCaller = {
      async call(request) {
        calls++;
        if (calls < 3) throw Object.assign(new Error("429 rate limit"), { errorType: "rate_limit" });
        return {
          answer: "ok",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };

    const promise = callModelWithRetry(caller, {
      model: "p/m",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    }, { maxRetries: 5, initialDelayMs: 10, maxDelayMs: 100, backoffMultiplier: 2, jitterRatio: 0 });

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(20);
    const result = await promise;
    expect(result.answer).toBe("ok");
    expect(calls).toBe(3);
    vi.useRealTimers();
  });

  it("does not retry provider moderation failures", async () => {
    let calls = 0;
    const caller: ModelCaller = {
      async call() {
        calls++;
        throw new Error("422 input new_sensitive (1026)");
      },
    };

    await expect(callModelWithRetry(caller, {
      model: "p/m",
      systemPrompt: "",
      messages: [{ role: "user", content: "hi" }],
    }, { maxRetries: 5, initialDelayMs: 1, maxDelayMs: 1, backoffMultiplier: 1, jitterRatio: 0 })).rejects.toThrow(/new_sensitive/);
    expect(calls).toBe(1);
  });

  it("classifies provider terminated as transient timeout", () => {
    expect(classifyModelError(new Error("terminated"))).toBe("timeout");
    expect(isRetryableModelError("timeout", new Error("terminated"))).toBe(true);
  });

  it("calculates capped exponential retry delays", () => {
    const policy = { maxRetries: 5, initialDelayMs: 5_000, maxDelayMs: 20_000, backoffMultiplier: 2, jitterRatio: 0 };
    expect(retryDelayMs(policy, 1)).toBe(5_000);
    expect(retryDelayMs(policy, 2)).toBe(10_000);
    expect(retryDelayMs(policy, 3)).toBe(20_000);
    expect(retryDelayMs(policy, 4)).toBe(20_000);
  });
});
