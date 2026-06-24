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
  WorkspaceRunSummary,
  ParticipantWorkspaceSummary,
} from "./types.js";
import * as path from "node:path";
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
import {
  buildChangeSet,
  createWorkspaceBaseline,
  createWorkspaceSandbox,
  workspaceBaselineSha256,
  type WorkspaceBaseline,
  type WorkspaceSandbox,
} from "./workspace-sandbox.js";

export interface FusionRunOptions {
  /** If set to "skip", failed participants are automatically skipped instead of pausing */
  onParticipantFailed?: "pause" | "skip";
  /** Emits coarse-grained progress for terminal/UI feedback during long runs. */
  onProgress?: (event: FusionProgressEvent) => void;
}

export interface FusionEngineDependencies {
  webBackend?: WebBackend;
}

export type FusionProgressPhase =
  | "preparing"
  | "workspace"
  | "planning"
  | "evidence"
  | "participants"
  | "judging"
  | "complete";

export type FusionProgressState = "started" | "progress" | "completed" | "failed";

export interface FusionProgressEvent {
  phase: FusionProgressPhase;
  state: FusionProgressState;
  message: string;
  slotIndex?: number;
  model?: string;
  judgeModel?: string;
  completedParticipants?: number;
  totalParticipants?: number;
}

const FUSION_QUORUM_ERROR = "Fusion quorum not met: fewer than 2 Participant Runs succeeded. Returning the only successful participant's raw answer (not a judged Fusion Result).";

interface WorkspaceRunState {
  baseline: WorkspaceBaseline;
  summary: WorkspaceRunSummary;
  sandboxes: WorkspaceSandbox[];
}

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
    const emitProgress = (event: FusionProgressEvent) => {
      try {
        options.onProgress?.(event);
      } catch {
        // Progress UI must never fail the fusion run.
      }
    };

    const evidence = new EvidenceCollector();
    for (const entry of input.initialEvidence ?? []) evidence.add(entry);
    const retryPolicy = normalizeRetryPolicy(config.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY);
    const retryingCaller: ModelCaller = {
      call: (request) => callModelWithRetry(this.caller, request, retryPolicy),
    };
    const participantRunner = new ParticipantRunner(this.caller, config.defaultFallbacks, retryPolicy);
    emitProgress({ phase: "preparing", state: "started", message: "Preparing tools and run context" });
    const toolNames = await this.prepareTools(config);
    emitProgress({ phase: "preparing", state: "completed", message: `Prepared tools: ${toolNames.length > 0 ? toolNames.join(", ") : "none"}` });

    const workspaceRun = input.workspace?.enabled
      ? await this.prepareWorkspaceRun(input, config.participants.length, emitProgress)
      : undefined;

    // Phase 0: Build a prompt-derived obligation checklist. This is best-effort
    // and must use only the explicit user prompt, never benchmark rubrics or
    // answer keys. It makes exact-number/source-heavy prompts less likely to
    // collapse into a high-level synthesis.
    let obligationPlan: ObligationPlan | undefined;
    let obligationText = "";
    emitProgress({ phase: "planning", state: "started", message: "Building prompt obligation checklist" });
    try {
      const planner = new ObligationPlanner(retryingCaller, config.judge.model);
      obligationPlan = await planner.plan(input.prompt);
      obligationText = formatObligationPlanForModel(obligationPlan);
      emitProgress({ phase: "planning", state: "completed", message: `Planned ${obligationPlan.obligations.length} prompt obligations` });
    } catch {
      // Planning is an optimization, not a hard dependency.
      obligationPlan = undefined;
      obligationText = "";
      emitProgress({ phase: "planning", state: "failed", message: "Obligation planning skipped; continuing without it" });
    }

    emitProgress({ phase: "evidence", state: "started", message: "Collecting seeded evidence" });
    try {
      const seeded = await seedSecEvidenceFromPrompt(input.prompt, obligationPlan, { signal: undefined });
      for (const entry of seeded) evidence.add(entry);
      emitProgress({ phase: "evidence", state: "progress", message: seeded.length > 0 ? `Seeded ${seeded.length} SEC evidence entries` : "No SEC seed evidence needed" });
    } catch {
      // SEC seeding is best-effort. Models can still use web tools.
      emitProgress({ phase: "evidence", state: "failed", message: "SEC seed evidence skipped; continuing" });
    }
    const uxSeeded = seedUxSourceCatalog(input.prompt);
    for (const entry of uxSeeded) evidence.add(entry);
    emitProgress({
      phase: "evidence",
      state: "completed",
      message: `Evidence seed pool ready (${evidence.getPool().entries.length} entries)`,
    });

    const participantPrompt = obligationText ? `${input.prompt}\n${obligationText}` : input.prompt;
    const seededEvidence = evidence.getPool().entries;

    // Phase 1: Run all participants in parallel
    let completedParticipants = 0;
    const totalParticipants = config.participants.length;
    emitProgress({
      phase: "participants",
      state: "started",
      message: `Starting ${totalParticipants} participant model${totalParticipants === 1 ? "" : "s"}`,
      completedParticipants,
      totalParticipants,
    });
    const participantPromises = config.participants.map(async (slot, index) => {
      emitProgress({
        phase: "participants",
        state: "started",
        message: `P${index + 1} started (${slot.model})`,
        slotIndex: index,
        model: slot.model,
        completedParticipants,
        totalParticipants,
      });
      const output = await participantRunner.run(
        slot,
        participantPrompt,
        toolNames,
        seededEvidence,
        index,
        config.defaultFallbacks,
        (entry) => evidence.add(entry),
        workspaceRun ? {
          sandbox: workspaceRun.sandboxes[index],
          sourceRoot: workspaceRun.summary.sourceRoot,
          baselineSha256: workspaceRun.summary.baselineSha256,
          fileCount: workspaceRun.summary.fileCount,
          skippedCount: workspaceRun.summary.skippedCount,
        } : undefined,
      );
      if (workspaceRun) {
        output.workspace = await this.summarizeParticipantWorkspace(workspaceRun.baseline, workspaceRun.sandboxes[index]);
      }
      completedParticipants++;
      emitProgress({
        phase: "participants",
        state: output.error ? "failed" : "completed",
        message: output.error
          ? `P${index + 1} failed (${output.model})`
          : `P${index + 1} completed (${output.model})`,
        slotIndex: index,
        model: output.model,
        completedParticipants,
        totalParticipants,
      });
      return output;
    });

    const participantOutputs = await Promise.all(participantPromises);
    emitProgress({
      phase: "participants",
      state: "completed",
      message: `Participant phase completed (${completedParticipants}/${totalParticipants})`,
      completedParticipants,
      totalParticipants,
    });

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

      const result = {
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
        workspace: workspaceRun?.summary,
        artifactsPath: "", // will be set by artifacts module
        mode: input.mode,
        totalCost: participantOutputs.reduce((sum, o) => sum + o.cost, 0),
        totalTokens: sumTokens(participantOutputs),
      };
      emitProgress({ phase: "complete", state: "completed", message: "Fusion completed without judge quorum" });
      return result;
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
        emitProgress({ phase: "judging", state: "started", message: `Judge analyzing with ${judgeModel}`, judgeModel });
        analysis = await judgeRunner.analyze(input.prompt, successfulParticipants, evidencePool);
        emitProgress({ phase: "judging", state: "progress", message: "Judge recovering missing obligations", judgeModel });
        judgeRecoveryNotes = await judgeRunner.recoverObligations(input.prompt, analysis, successfulParticipants, evidencePool);

        if (input.mode === "fast") {
          // Fast mode: analysis → recovery → draft (used as final)
          emitProgress({ phase: "judging", state: "progress", message: "Judge drafting final answer", judgeModel });
          finalAnswer = await judgeRunner.draft(input.prompt, analysis, successfulParticipants, evidencePool, judgeRecoveryNotes);
        } else {
          // Quality mode: analysis → recovery → draft → verify → revise
          emitProgress({ phase: "judging", state: "progress", message: "Judge drafting final answer", judgeModel });
          const draft = await judgeRunner.draft(input.prompt, analysis, successfulParticipants, evidencePool, judgeRecoveryNotes);
          emitProgress({ phase: "judging", state: "progress", message: "Judge verifying draft", judgeModel });
          verification = await judgeRunner.verify(draft, analysis, evidencePool, judgeRecoveryNotes);

          if (verification.pass) {
            finalAnswer = draft;
          } else {
            emitProgress({ phase: "judging", state: "progress", message: "Judge revising draft after verification", judgeModel });
            finalAnswer = await judgeRunner.revise(draft, verification, input.prompt, evidencePool, judgeRecoveryNotes);
          }
        }
        emitProgress({ phase: "judging", state: "completed", message: `Judge completed with ${judgeModel}`, judgeModel });
        break;
      } catch (error) {
        lastJudgeError = error;
        const errorType = classifyModelError(error);
        emitProgress({ phase: "judging", state: "failed", message: `Judge ${judgeModel} failed (${errorType}); trying fallback if available`, judgeModel });
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

    const result = {
      finalAnswer,
      judgeAnalysis: analysis,
      judgeVerification: verification,
      obligationPlan,
      judgeRecoveryNotes,
      participants: participantStatuses,
      evidence: evidence.getSummary(),
      evidencePool: evidence.getPool(),
      workspace: workspaceRun?.summary,
      artifactsPath: "", // will be set by artifacts module
      mode: input.mode,
      totalCost,
      totalTokens: sumTokens(allOutputs),
    };
    emitProgress({ phase: "complete", state: "completed", message: "Fusion run completed" });
    return result;
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

  private async prepareWorkspaceRun(
    input: FusionInput,
    participantCount: number,
    emitProgress: (event: FusionProgressEvent) => void,
  ): Promise<WorkspaceRunState> {
    if (!input.workspace?.enabled) {
      throw new Error("workspace input is not enabled");
    }

    const root = path.resolve(input.workspace.root);
    const baselineRoot = path.join(root, "baseline");
    emitProgress({ phase: "workspace", state: "started", message: "Copying workspace baseline into Pi Fusion sandbox" });
    const baseline = await createWorkspaceBaseline({
      sourceRoot: input.workspace.sourceRoot,
      baselineRoot,
    });
    const baselineSha256 = workspaceBaselineSha256(baseline);
    emitProgress({
      phase: "workspace",
      state: "progress",
      message: `Workspace baseline ready (${baseline.manifest.files.length} files, ${baseline.manifest.skipped.length} skipped)`,
    });

    const sandboxes: WorkspaceSandbox[] = [];
    for (let i = 0; i < participantCount; i++) {
      sandboxes.push(await createWorkspaceSandbox({
        baseline,
        sandboxRoot: path.join(root, "participants", `p${i + 1}`),
        sandboxId: `p${i + 1}`,
      }));
    }

    const summary: WorkspaceRunSummary = {
      enabled: true,
      sourceRoot: baseline.sourceRoot,
      root,
      baselineSha256,
      fileCount: baseline.manifest.files.length,
      skippedCount: baseline.manifest.skipped.length,
      participantCount,
    };
    emitProgress({ phase: "workspace", state: "completed", message: `Created ${participantCount} participant workspaces` });
    return { baseline, summary, sandboxes };
  }

  private async summarizeParticipantWorkspace(
    baseline: WorkspaceBaseline,
    sandbox: WorkspaceSandbox,
  ): Promise<ParticipantWorkspaceSummary> {
    try {
      const changeSet = await buildChangeSet({ baseline, sandbox });
      return {
        sandboxId: sandbox.sandboxId,
        root: sandbox.root,
        sourceRoot: baseline.sourceRoot,
        baselineSha256: workspaceBaselineSha256(baseline),
        fileCount: baseline.manifest.files.length,
        skippedCount: baseline.manifest.skipped.length,
        changedFiles: changeSet.operations.map((operation) => ({
          op: operation.op,
          path: operation.path,
          ...("size" in operation ? { size: operation.size } : {}),
        })),
        changeSet,
      };
    } catch (error) {
      return {
        sandboxId: sandbox.sandboxId,
        root: sandbox.root,
        sourceRoot: baseline.sourceRoot,
        baselineSha256: workspaceBaselineSha256(baseline),
        fileCount: baseline.manifest.files.length,
        skippedCount: baseline.manifest.skipped.length,
        changedFiles: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
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
