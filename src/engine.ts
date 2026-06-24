import type {
  GlobalFusionConfig,
  FusionInput,
  FusionResult,
  FusionMode,
  ParticipantStatus,
  ParticipantOutput,
  ModelCaller,
  TokenUsage,
  EvidenceSummary,
  StructuredJudgeAnalysis,
  JudgeVerification,
  ObligationPlan,
} from "./types.js";
import { ParticipantRunner } from "./participant.js";
import { JudgeRunner } from "./judge.js";
import { EvidenceCollector } from "./evidence.js";
import { ObligationPlanner, formatObligationPlanForModel } from "./obligations.js";
import { seedSecEvidenceFromPrompt } from "./sec-seeding.js";
import { seedUxSourceCatalog } from "./ux-source-catalog.js";
import { FallbackResolver } from "./fallback.js";
import {
  callModelWithRetry,
  classifyModelError,
  DEFAULT_MODEL_RETRY_POLICY,
  normalizeRetryPolicy,
} from "./retry.js";
import type { WebBackend } from "./web.js";

export interface FusionRunOptions {
  /** If set to "skip", failed participants are automatically skipped instead of pausing */
  onParticipantFailed?: "pause" | "skip";
}

export interface FusionEngineDependencies {
  webBackend?: WebBackend;
}

const FUSION_QUORUM_ERROR = "Fusion quorum not met: fewer than 2 Participant Runs succeeded. Returning the only successful participant's raw answer (not a judged Fusion Result).";

export class FusionEngine {
  private caller: ModelCaller;
  private deps: FusionEngineDependencies;

  constructor(caller: ModelCaller, deps: FusionEngineDependencies = {}) {
    this.caller = caller;
    this.deps = deps;
  }

  async run(
    config: GlobalFusionConfig,
    input: FusionInput,
    options: FusionRunOptions = {},
  ): Promise<FusionResult> {
    const evidence = new EvidenceCollector();
    for (const entry of input.initialEvidence ?? []) evidence.add(entry);
    const retryPolicy = normalizeRetryPolicy(config.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY);
    const retryingCaller: ModelCaller = {
      call: (request) => callModelWithRetry(this.caller, request, retryPolicy),
    };
    const participantRunner = new ParticipantRunner(this.caller, config.defaultFallbacks, retryPolicy);
    const toolNames = await this.prepareTools(config);

    // Phase 0: Build a prompt-derived obligation checklist. This is best-effort
    // and must use only the explicit user prompt, never benchmark rubrics or
    // answer keys. It makes exact-number/source-heavy prompts less likely to
    // collapse into a high-level synthesis.
    let obligationPlan: ObligationPlan | undefined;
    let obligationText = "";
    try {
      const planner = new ObligationPlanner(retryingCaller, config.judge.model);
      obligationPlan = await planner.plan(input.prompt);
      obligationText = formatObligationPlanForModel(obligationPlan);
    } catch {
      // Planning is an optimization, not a hard dependency.
      obligationPlan = undefined;
      obligationText = "";
    }

    try {
      const seeded = await seedSecEvidenceFromPrompt(input.prompt, obligationPlan, { signal: undefined });
      for (const entry of seeded) evidence.add(entry);
    } catch {
      // SEC seeding is best-effort. Models can still use web tools.
    }
    for (const entry of seedUxSourceCatalog(input.prompt)) evidence.add(entry);

    const participantPrompt = obligationText ? `${input.prompt}\n${obligationText}` : input.prompt;
    const seededEvidence = evidence.getPool().entries;

    // Phase 1: Run all participants in parallel
    const participantPromises = config.participants.map((slot, index) =>
      participantRunner.run(
        slot,
        participantPrompt,
        toolNames,
        seededEvidence,
        index,
        config.defaultFallbacks,
        (entry) => evidence.add(entry),
      ),
    );

    const participantOutputs = await Promise.all(participantPromises);

    // Phase 2: Build participant statuses
    const participantStatuses: ParticipantStatus[] = participantOutputs.map((output) => {
      if (output.error) {
        if (options.onParticipantFailed === "skip") {
          return {
            state: "skipped" as const,
            slotIndex: output.slotIndex,
            reason: output.error,
          };
        }
        return {
          state: "failed" as const,
          slotIndex: output.slotIndex,
          error: output.error,
          errorType: "provider_error" as const,
        };
      }
      return {
        state: "success" as const,
        slotIndex: output.slotIndex,
        output,
      };
    });

    // Phase 3: Check quorum
    const successfulParticipants = participantOutputs.filter((o) => !o.error);
    const skippedCount = participantStatuses.filter((s) => s.state === "skipped").length;

    if (successfulParticipants.length < 2) {
      // Quorum not met
      const quorumResult = successfulParticipants.length === 1
        ? successfulParticipants[0].answer
        : "";

      return {
        finalAnswer: successfulParticipants.length === 1
          ? `${FUSION_QUORUM_ERROR}\n\n---\n\n${quorumResult}`
          : FUSION_QUORUM_ERROR,
        judgeAnalysis: {
          consensus: [],
          contradictions: [],
          coverageGaps: [],
          uniqueInsights: [],
          blindSpots: [],
          sourceConfidence: [],
        },
        obligationPlan,
        participants: participantStatuses,
        evidence: evidence.getSummary(),
        evidencePool: evidence.getPool(),
        artifactsPath: "", // will be set by artifacts module
        mode: input.mode,
        totalCost: participantOutputs.reduce((sum, o) => sum + o.cost, 0),
        totalTokens: sumTokens(participantOutputs),
      };
    }

    // Phase 4: Judge. Retry transient failures for each Judge Model, and if the
    // model still fails (or quota is exhausted), restart judging with the next
    // fallback model. Restarting avoids mixing analysis/draft phases across
    // different judge models.
    const evidencePool = evidence.getPool();
    const judgeModels = [config.judge.model, ...new FallbackResolver(config.defaultFallbacks).resolve(config.judge)];
    let analysis: StructuredJudgeAnalysis | undefined;
    let finalAnswer: string | undefined;
    let verification: JudgeVerification | undefined;
    let judgeRecoveryNotes: string | undefined;
    let lastJudgeError: unknown;

    for (const judgeModel of judgeModels) {
      const judgeRunner = new JudgeRunner(retryingCaller, judgeModel, toolNames, obligationText);
      try {
        analysis = await judgeRunner.analyze(input.prompt, successfulParticipants, evidencePool);
        judgeRecoveryNotes = await judgeRunner.recoverObligations(input.prompt, analysis, successfulParticipants, evidencePool);

        if (input.mode === "fast") {
          // Fast mode: analysis → recovery → draft (used as final)
          finalAnswer = await judgeRunner.draft(input.prompt, analysis, successfulParticipants, evidencePool, judgeRecoveryNotes);
        } else {
          // Quality mode: analysis → recovery → draft → verify → revise
          const draft = await judgeRunner.draft(input.prompt, analysis, successfulParticipants, evidencePool, judgeRecoveryNotes);
          verification = await judgeRunner.verify(draft, analysis, evidencePool, judgeRecoveryNotes);

          if (verification.pass) {
            finalAnswer = draft;
          } else {
            finalAnswer = await judgeRunner.revise(draft, verification, input.prompt, evidencePool, judgeRecoveryNotes);
          }
        }
        break;
      } catch (error) {
        lastJudgeError = error;
        const errorType = classifyModelError(error);
        if (!["rate_limit", "quota", "timeout", "network", "empty_response", "context_limit", "provider_error"].includes(errorType)) {
          throw error;
        }
      }
    }

    if (!analysis || finalAnswer === undefined) {
      throw lastJudgeError instanceof Error ? lastJudgeError : new Error(String(lastJudgeError ?? "All judge models failed"));
    }

    // Phase 5: Build result
    const allOutputs = [...successfulParticipants];
    const totalCost = allOutputs.reduce((sum, o) => sum + o.cost, 0);

    return {
      finalAnswer,
      judgeAnalysis: analysis,
      judgeVerification: verification,
      obligationPlan,
      judgeRecoveryNotes,
      participants: participantStatuses,
      evidence: evidence.getSummary(),
      evidencePool: evidence.getPool(),
      artifactsPath: "", // will be set by artifacts module
      mode: input.mode,
      totalCost,
      totalTokens: sumTokens(allOutputs),
    };
  }

  private async prepareTools(config: GlobalFusionConfig): Promise<string[]> {
    const tools: string[] = [];

    if (config.webPolicy !== "off") {
      const backend = this.deps.webBackend;
      if (!backend) {
        if (config.webPolicy === "required") {
          throw new Error("Web policy is required, but no web backend is configured or available.");
        }
      } else {
        const status = await backend.status();
        if (!status.ok) {
          if (config.webPolicy === "required") {
            throw new Error(`Web backend required but unavailable: ${status.message}`);
          }
        } else {
          if (backend.supportsSearch) tools.push("web_search");
          if (backend.supportsFetch) tools.push("web_fetch");
        }
      }
    }

    if ((config.toolPolicy?.bash ?? "sandboxed") === "sandboxed") {
      tools.push("bash");
    }

    return tools;
  }
}

function sumTokens(outputs: ParticipantOutput[]): TokenUsage {
  return outputs.reduce(
    (acc, o) => ({
      input: acc.input + o.tokens.input,
      output: acc.output + o.tokens.output,
      cacheRead: acc.cacheRead + o.tokens.cacheRead,
      cacheWrite: acc.cacheWrite + o.tokens.cacheWrite,
    }),
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  );
}
