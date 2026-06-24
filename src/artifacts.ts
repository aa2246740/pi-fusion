import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FusionResult, ParticipantStatus, ParticipantWorkspaceSummary } from "./types.js";

function generateRunId(): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${date}-${rand}`;
}

function formatParticipant(p: ParticipantStatus): string {
  switch (p.state) {
    case "success": {
      const o = p.output;
      const workspaceLines = o.workspace
        ? [
          ``,
          `## Workspace Sandbox`,
          ``,
          `Sandbox: ${o.workspace.sandboxId}`,
          `Root: ${o.workspace.root}`,
          `Baseline files: ${o.workspace.fileCount}`,
          `Skipped files: ${o.workspace.skippedCount}`,
          o.workspace.error ? `Workspace summary error: ${o.workspace.error}` : `Changed files: ${o.workspace.changedFiles.length}`,
          ...o.workspace.changedFiles.map((file) => `- ${file.op} ${file.path}${file.size !== undefined ? ` (${file.size} bytes)` : ""}`),
        ]
        : [];
      return [
        `# Participant ${p.slotIndex + 1} — ${o.model}`,
        ``,
        `## Status: SUCCESS`,
        `Tokens: input=${o.tokens.input} output=${o.tokens.output} cacheRead=${o.tokens.cacheRead} cacheWrite=${o.tokens.cacheWrite}`,
        `Cost: $${o.cost.toFixed(4)}`,
        o.fallbackUsed ? `Fallback used: ${o.fallbackUsed}` : "",
        ``,
        `## Answer`,
        ``,
        o.answer,
        ...workspaceLines,
      ].filter(Boolean).join("\n");
    }
    case "failed":
      return [
        `# Participant ${p.slotIndex + 1}`,
        ``,
        `## Status: FAILED`,
        `Error type: ${p.errorType}`,
        `Error: ${p.error}`,
      ].join("\n");
    case "skipped":
      return [
        `# Participant ${p.slotIndex + 1}`,
        ``,
        `## Status: SKIPPED`,
        `Reason: ${p.reason}`,
      ].join("\n");
    case "awaiting-recovery":
      return [
        `# Participant ${p.slotIndex + 1}`,
        ``,
        `## Status: AWAITING RECOVERY`,
        `Failed models: ${p.failedModels.join(", ")}`,
        `Last error: ${p.lastError}`,
      ].join("\n");
    default:
      return `# Participant ${(p as any).slotIndex + 1}\n\nStatus: ${(p as any).state}`;
  }
}

function summarizeWorkspace(summary: ParticipantWorkspaceSummary): Omit<ParticipantWorkspaceSummary, "changeSet"> {
  const { changeSet: _changeSet, ...rest } = summary;
  return rest;
}

export class ArtifactWriter {
  private baseDir: string;

  constructor(baseDir: string) {
    this.baseDir = baseDir;
  }

  async write(result: FusionResult): Promise<string> {
    const runId = generateRunId();
    const runDir = path.join(this.baseDir, "runs", runId);
    await fs.mkdir(runDir, { recursive: true });

    // Final answer
    await fs.writeFile(path.join(runDir, "final-answer.md"), result.finalAnswer, "utf-8");

    // Judge analysis
    await fs.writeFile(
      path.join(runDir, "judge-analysis.json"),
      JSON.stringify(result.judgeAnalysis, null, 2),
      "utf-8",
    );

    // Prompt-derived obligation plan and judge recovery notes.
    if (result.obligationPlan) {
      await fs.writeFile(
        path.join(runDir, "obligation-plan.json"),
        JSON.stringify(result.obligationPlan, null, 2),
        "utf-8",
      );
    }
    if (result.judgeRecoveryNotes) {
      await fs.writeFile(path.join(runDir, "judge-recovery-notes.md"), result.judgeRecoveryNotes, "utf-8");
    }

    // Judge verification (quality mode only)
    if (result.judgeVerification) {
      await fs.writeFile(
        path.join(runDir, "judge-verification.json"),
        JSON.stringify(result.judgeVerification, null, 2),
        "utf-8",
      );
    }

    // Participants
    const workspaceSummaries: Array<Omit<ParticipantWorkspaceSummary, "changeSet">> = [];
    for (const p of result.participants) {
      const index = "slotIndex" in p ? (p as any).slotIndex : 0;
      await fs.writeFile(
        path.join(runDir, `participant-${index + 1}.md`),
        formatParticipant(p),
        "utf-8",
      );
      if (p.state === "success" && p.output.workspace) {
        workspaceSummaries.push(summarizeWorkspace(p.output.workspace));
        if (p.output.workspace.changeSet) {
          await fs.writeFile(
            path.join(runDir, `participant-${index + 1}-changeset.json`),
            JSON.stringify(p.output.workspace.changeSet, null, 2),
            "utf-8",
          );
        }
      }
    }

    if (result.workspace || workspaceSummaries.length > 0) {
      await fs.writeFile(
        path.join(runDir, "participant-sandboxes.json"),
        JSON.stringify(
          {
            workspace: result.workspace,
            participants: workspaceSummaries,
          },
          null,
          2,
        ),
        "utf-8",
      );
    }

    // Evidence
    await fs.writeFile(
      path.join(runDir, "evidence-summary.json"),
      JSON.stringify(result.evidence, null, 2),
      "utf-8",
    );
    // Backward-compatible alias for earlier artifacts.
    await fs.writeFile(
      path.join(runDir, "evidence.json"),
      JSON.stringify(result.evidence, null, 2),
      "utf-8",
    );
    if (result.evidencePool) {
      await fs.writeFile(
        path.join(runDir, "evidence-pool.json"),
        JSON.stringify(result.evidencePool, null, 2),
        "utf-8",
      );
    }

    // Run metadata
    await fs.writeFile(
      path.join(runDir, "run.json"),
      JSON.stringify(
        {
          runId,
          mode: result.mode,
          totalCost: result.totalCost,
          totalTokens: result.totalTokens,
          obligationCount: result.obligationPlan?.obligations.length ?? 0,
          workspaceEnabled: Boolean(result.workspace?.enabled),
          workspaceSourceRoot: result.workspace?.sourceRoot,
          workspaceRoot: result.workspace?.root,
          workspaceChangedFileCount: result.participants
            .filter((p) => p.state === "success")
            .reduce((sum, p) => sum + (p.output.workspace?.changedFiles.length ?? 0), 0),
          hasJudgeRecoveryNotes: Boolean(result.judgeRecoveryNotes),
          participantCount: result.participants.length,
          successfulCount: result.participants.filter((p) => p.state === "success").length,
          skippedCount: result.participants.filter((p) => p.state === "skipped").length,
          failedCount: result.participants.filter((p) => p.state === "failed").length,
          timestamp: new Date().toISOString(),
        },
        null,
        2,
      ),
      "utf-8",
    );

    return runDir;
  }
}
