import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { FusionEngine } from "../src/engine.js";
import { writeSandboxFile } from "../src/workspace-sandbox.js";
import type {
  ModelCaller,
  GlobalFusionConfig,
  FusionInput,
  StructuredJudgeAnalysis,
  JudgeVerification,
  ModelCallResult,
} from "../src/types.js";

const ANALYSIS: StructuredJudgeAnalysis = {
  consensus: ["Both agree on X"],
  contradictions: [],
  coverageGaps: [],
  uniqueInsights: [],
  blindSpots: [],
  sourceConfidence: [],
};

const VERIFICATION_PASS: JudgeVerification = {
  unsupportedClaims: [],
  missingContradictions: [],
  citationIssues: [],
  remainingCaveats: [],
  pass: true,
};

function makeConfig(overrides: Partial<GlobalFusionConfig> = {}): GlobalFusionConfig {
  return {
    participants: [
      { model: "openai/gpt-4.1" },
      { model: "anthropic/claude-sonnet-4-5" },
    ],
    judge: { model: "anthropic/claude-opus-4-5" },
    defaultFallbacks: [],
    webPolicy: "off",
    retryPolicy: { maxRetries: 0, initialDelayMs: 0, maxDelayMs: 0, backoffMultiplier: 1, jitterRatio: 0 },
    monitorDefault: false,
    confirmBeforeRun: false,
    ...overrides,
  };
}

function makeCaller(responses: Record<string, string> = {}): ModelCaller {
  return {
    async call(request) {
      const sys = request.systemPrompt;
      let key = "participant";
      if (sys.includes("[PHASE: ANALYSIS]")) key = "analysis";
      else if (sys.includes("[PHASE: DRAFT]")) key = "draft";
      else if (sys.includes("[PHASE: VERIFY_REPAIR]")) key = "repair";
      else if (sys.includes("[PHASE: VERIFY]")) key = "verify";
      else if (sys.includes("[PHASE: REVISE]")) key = "revise";
      else if (sys.includes("[PHASE: FINAL_HARDEN]")) key = "harden";

      const answer = responses[key] ?? `Answer from ${request.model} for ${key}`;
      return {
        answer,
        model: request.model,
        tokens: { input: 100, output: 200, cacheRead: 0, cacheWrite: 0 },
        cost: 0.01,
      };
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let i = 0; i < 50; i++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition was not met");
}

describe("FusionEngine", () => {
  it("creates isolated writable workspace sandboxes for participants", async () => {
    const sourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-source-"));
    const sandboxRoot = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-workspaces-"));
    await fs.mkdir(path.join(sourceRoot, "src"), { recursive: true });
    await fs.writeFile(path.join(sourceRoot, "src", "app.ts"), "export const value = 1;\n", "utf-8");

    const seen: Array<{ slotIndex: number; tools?: string[]; root?: string }> = [];
    const caller: ModelCaller = {
      async call(request) {
        const isParticipant = !request.systemPrompt.includes("[PHASE:");
        if (isParticipant) {
          const workspace = request.toolContext?.workspace;
          const slotIndex = request.toolContext?.participantSlotIndex ?? -1;
          seen.push({ slotIndex, tools: request.tools, root: workspace?.sandbox.root });
          expect(workspace).toBeDefined();
          await writeSandboxFile(workspace!.sandbox, `notes/p${slotIndex + 1}.md`, `participant ${slotIndex + 1} notes`);
          return {
            answer: `participant ${slotIndex + 1} used workspace`,
            model: request.model,
            tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
            cost: 0,
          };
        }

        return {
          answer: request.systemPrompt.includes("[PHASE: ANALYSIS]") ? JSON.stringify(ANALYSIS) : "final",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };

    try {
      const engine = new FusionEngine(caller);
      const result = await engine.run(makeConfig(), {
        prompt: "Inspect this project and propose changes",
        mode: "fast",
        monitor: false,
        workspace: { enabled: true, sourceRoot, root: sandboxRoot },
      });

      expect(seen).toHaveLength(2);
      expect(seen.every((entry) => entry.tools?.includes("workspace_read"))).toBe(true);
      expect(seen.every((entry) => entry.tools?.includes("workspace_write"))).toBe(true);
      expect(new Set(seen.map((entry) => entry.root)).size).toBe(2);
      await expect(fs.access(path.join(sourceRoot, "notes", "p1.md"))).rejects.toThrow();

      const successful = result.participants.filter((p) => p.state === "success");
      expect(successful).toHaveLength(2);
      for (const status of successful) {
        expect(status.output.workspace?.changedFiles).toEqual([
          expect.objectContaining({ op: "add", path: `notes/p${status.slotIndex + 1}.md` }),
        ]);
      }
      expect(result.workspace?.participantCount).toBe(2);
    } finally {
      await fs.rm(sourceRoot, { recursive: true, force: true });
      await fs.rm(sandboxRoot, { recursive: true, force: true });
    }
  });

  it("emits progress events before long participant calls finish", async () => {
    const events: Array<{ phase: string; state: string; slotIndex?: number; completedParticipants?: number }> = [];
    const pendingParticipants = new Map<string, ReturnType<typeof deferred<ModelCallResult>>>();
    const caller: ModelCaller = {
      async call(request) {
        const isParticipant = !request.systemPrompt.includes("[PHASE:");
        if (isParticipant) {
          const pending = deferred<ModelCallResult>();
          pendingParticipants.set(request.model, pending);
          return await pending.promise;
        }
        const key = request.systemPrompt.includes("[PHASE: ANALYSIS]") ? "analysis" : request.systemPrompt.includes("[PHASE: DRAFT]") ? "draft" : "other";
        return {
          answer: key === "analysis" ? JSON.stringify(ANALYSIS) : "judge answer",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };

    const engine = new FusionEngine(caller);
    const run = engine.run(
      makeConfig(),
      { prompt: "test", mode: "fast", monitor: false },
      { onProgress: (event) => events.push(event) },
    );

    await waitFor(() => pendingParticipants.size === 2);
    expect(events).toContainEqual(expect.objectContaining({ phase: "planning", state: "started" }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "participants", state: "started", slotIndex: 0 }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "participants", state: "started", slotIndex: 1 }));

    for (const [model, pending] of pendingParticipants) {
      pending.resolve({
        answer: `participant answer from ${model}`,
        model,
        tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        cost: 0,
      });
    }

    await run;
    expect(events).toContainEqual(expect.objectContaining({ phase: "participants", state: "completed", completedParticipants: 2 }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "judging", state: "started" }));
    expect(events).toContainEqual(expect.objectContaining({ phase: "complete", state: "completed" }));
  });

  it("aborts long model calls with the configured timeout", async () => {
    const previous = process.env.PI_FUSION_MODEL_CALL_TIMEOUT_MS;
    process.env.PI_FUSION_MODEL_CALL_TIMEOUT_MS = "20";
    const caller: ModelCaller = {
      async call(request) {
        return await new Promise<ModelCallResult>((_resolve, reject) => {
          const abort = () => reject(request.signal?.reason ?? new Error("aborted"));
          if (request.signal?.aborted) abort();
          request.signal?.addEventListener("abort", abort, { once: true });
        });
      },
    };

    try {
      const engine = new FusionEngine(caller);
      const result = await engine.run(makeConfig(), {
        prompt: "this call hangs",
        mode: "quality",
        monitor: false,
      });

      expect(result.participants.every((status) => status.state === "failed")).toBe(true);
      expect(result.finalAnswer).toContain("Fusion quorum not met");
    } finally {
      if (previous === undefined) delete process.env.PI_FUSION_MODEL_CALL_TIMEOUT_MS;
      else process.env.PI_FUSION_MODEL_CALL_TIMEOUT_MS = previous;
    }
  });

  it("includes pre-run local evidence in participant context and the evidence pool", async () => {
    const seenMessages: string[] = [];
    const caller: ModelCaller = {
      async call(request) {
        seenMessages.push(request.messages.map((m) => m.content).join("\n"));
        const key = request.systemPrompt.includes("[PHASE: ANALYSIS]") ? "analysis" : request.systemPrompt.includes("[PHASE: DRAFT]") ? "draft" : "participant";
        return {
          answer: key === "analysis" ? JSON.stringify(ANALYSIS) : key === "draft" ? "Draft" : "Participant answer",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0,
        };
      },
    };
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "Use the handoff file",
      mode: "fast",
      monitor: false,
      initialEvidence: [{
        id: "file-1",
        source: "file_read",
        title: "Local file: __external__/handoff.md",
        url: "file://__external__/handoff.md",
        snippet: "handoff content",
        fullContent: "handoff content",
        participantSlotIndex: -1,
        fetchedAt: 1,
      }],
    });

    expect(result.evidence.totalEntries).toBe(1);
    expect(result.evidence.sources[0].id).toBe("file-1");
    expect(seenMessages.some((message) => message.includes("[file-1]") && message.includes("handoff content"))).toBe(true);
  });

  it("runs quality mode fusion - verification passes", async () => {
    const caller = makeCaller({
      analysis: JSON.stringify(ANALYSIS),
      draft: "Drafted answer",
      verify: JSON.stringify(VERIFICATION_PASS),
    });
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "What is the best approach?",
      mode: "quality",
      monitor: false,
    });

    // Verification passed, so draft is used directly
    expect(result.finalAnswer).toBe("Drafted answer");
    expect(result.mode).toBe("quality");
    expect(result.participants).toHaveLength(2);
    expect(result.participants.filter((p) => p.state === "success")).toHaveLength(2);
    expect(result.judgeAnalysis.consensus).toContain("Both agree on X");
    expect(result.judgeVerification).toBeDefined();
    expect(result.judgeVerification!.pass).toBe(true);
    expect(result.artifactsPath).toBeDefined();
  });

  it("runs quality mode fusion - verification fails, revision happens", async () => {
    const VERIFICATION_FAIL: JudgeVerification = {
      unsupportedClaims: ["bad claim"],
      missingContradictions: [],
      citationIssues: [],
      remainingCaveats: [],
      pass: false,
    };
    const caller = makeCaller({
      analysis: JSON.stringify(ANALYSIS),
      draft: "Drafted answer",
      verify: JSON.stringify(VERIFICATION_FAIL),
      repair: "Repair notes with exact sourced facts",
      revise: "Revised and improved answer",
      harden: [
        "Hardened answer with integrated final gaps",
        "",
        "## Verification Gaps Still Needing Review",
        "",
        "- Unsupported or weakly supported claim: bad claim",
        "",
        "## Final Notes",
        "",
        "Keep this user-facing note.",
      ].join("\n"),
    });
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "What is the best approach?",
      mode: "quality",
      monitor: false,
    });

    expect(result.finalAnswer).toContain("Hardened answer with integrated final gaps");
    expect(result.finalAnswer).toContain("Keep this user-facing note.");
    expect(result.finalAnswer).not.toContain("Verification Gaps Still Needing Review");
    expect(result.finalAnswer).not.toContain("Unsupported or weakly supported claim: bad claim");
    expect(result.judgeVerification!.pass).toBe(false);
    expect(result.judgeRecoveryNotes).toContain("Repair notes with exact sourced facts");
  });

  it("runs fast mode fusion (no verify/revise)", async () => {
    const caller = makeCaller({
      analysis: JSON.stringify(ANALYSIS),
      draft: "Fast final answer",
    });
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "Quick question",
      mode: "fast",
      monitor: false,
    });

    expect(result.finalAnswer).toBe("Fast final answer");
    expect(result.mode).toBe("fast");
    expect(result.judgeVerification).toBeUndefined();
  });

  it("enforces fusion quorum: at least 2 successful participants", async () => {
    let callCount = 0;
    const caller: ModelCaller = {
      async call(request) {
        callCount++;
        if (request.model === "openai/gpt-4.1") {
          throw Object.assign(new Error("429"), { errorType: "rate_limit" });
        }
        return {
          answer: request.systemPrompt.includes("[PHASE:") ? "judge output" : "participant answer",
          model: request.model,
          tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 },
          cost: 0.005,
        };
      },
    };

    const engine = new FusionEngine(caller);
    const result = await engine.run(
      makeConfig({ defaultFallbacks: [] }),
      { prompt: "test", mode: "fast", monitor: false },
    );

    // Only 1 participant succeeded, quorum not met
    expect(result.finalAnswer).toContain("quorum");
    expect(result.participants.filter((p) => p.state === "success")).toHaveLength(1);
    expect(result.participants.filter((p) => p.state === "failed")).toHaveLength(1);
  });

  it("handles participant skip when recovery is available", async () => {
    let participantCalls = 0;
    const caller: ModelCaller = {
      async call(request) {
        if (!request.systemPrompt.includes("[PHASE:") && request.model === "openai/gpt-4.1") {
          participantCalls++;
          throw Object.assign(new Error("quota"), { errorType: "quota" });
        }
        return {
          answer: request.systemPrompt.includes("[PHASE: ANALYSIS]")
            ? JSON.stringify(ANALYSIS)
            : request.systemPrompt.includes("[PHASE: DRAFT]")
              ? "Final answer"
              : "participant ok",
          model: request.model,
          tokens: { input: 50, output: 100, cacheRead: 0, cacheWrite: 0 },
          cost: 0.005,
        };
      },
    };

    const engine = new FusionEngine(caller);
    // Run with skip-on-failure mode
    const result = await engine.run(
      makeConfig({ defaultFallbacks: [] }),
      { prompt: "test", mode: "fast", monitor: false },
      { onParticipantFailed: "skip" },
    );

    // One skipped, one succeeded, quorum met (skipped doesn't count as success but 1 success + skip means we proceed differently)
    expect(result.participants.some((p) => p.state === "skipped")).toBe(true);
  });

  it("produces evidence summary in result", async () => {
    const caller = makeCaller({
      analysis: JSON.stringify(ANALYSIS),
      draft: "Answer with evidence",
    });
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "test",
      mode: "fast",
      monitor: false,
    });

    expect(result.evidence).toBeDefined();
    expect(result.evidence.totalEntries).toBeGreaterThanOrEqual(0);
  });

  it("passes sandboxed bash to participants and retrieval judge phases only", async () => {
    const seen: Array<{ phase: string; tools?: string[] }> = [];
    const caller: ModelCaller = {
      async call(request) {
        const phase = request.systemPrompt.includes("[PHASE: PLAN]") ? "plan"
          : request.systemPrompt.includes("[PHASE: ANALYSIS]") ? "analysis"
            : request.systemPrompt.includes("[PHASE: RECOVER]") ? "recover"
              : request.systemPrompt.includes("[PHASE: DRAFT]") ? "draft"
                : "participant";
        seen.push({ phase, tools: request.tools });
        return {
          answer: phase === "plan"
            ? JSON.stringify({
              obligations: [{
                id: "o1",
                kind: "topic",
                description: "Cover the requested test topic",
              }],
            })
            : phase === "analysis" ? JSON.stringify(ANALYSIS) : "ok",
          model: request.model,
          tokens: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
          cost: 0.01,
        };
      },
    };
    const engine = new FusionEngine(caller);
    await engine.run(makeConfig({ webPolicy: "off" }), {
      prompt: "test",
      mode: "fast",
      monitor: false,
    });

    expect(seen.filter((entry) => entry.phase === "participant").every((entry) => entry.tools?.includes("bash"))).toBe(true);
    expect(seen.find((entry) => entry.phase === "analysis")?.tools).toContain("bash");
    expect(seen.find((entry) => entry.phase === "recover")?.tools).toContain("bash");
    expect(seen.find((entry) => entry.phase === "draft")?.tools).toBeUndefined();
  });

  it("tracks total cost and tokens", async () => {
    const caller = makeCaller({
      analysis: JSON.stringify(ANALYSIS),
      draft: "Answer",
    });
    const engine = new FusionEngine(caller);
    const result = await engine.run(makeConfig(), {
      prompt: "test",
      mode: "fast",
      monitor: false,
    });

    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.totalTokens.input).toBeGreaterThan(0);
    expect(result.totalTokens.output).toBeGreaterThan(0);
  });
});
