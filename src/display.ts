import type { FusionResult } from "./types.js";

function tableCell(value: string | number): string {
  return String(value).replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function participantSummary(result: FusionResult): string {
  const success = result.participants.filter((p) => p.state === "success").length;
  const skipped = result.participants.filter((p) => p.state === "skipped").length;
  const failed = result.participants.filter((p) => p.state === "failed").length;
  const parts = [`${success}/${result.participants.length} success`];
  if (skipped > 0) parts.push(`${skipped} skipped`);
  if (failed > 0) parts.push(`${failed} failed`);
  return parts.join(", ");
}

function verificationSummary(result: FusionResult): string {
  if (!result.judgeVerification) {
    return result.mode === "fast" ? "Skipped in fast mode" : "Not recorded";
  }
  return result.judgeVerification.pass
    ? "Passed"
    : "Needs review; see artifacts";
}

function workspaceSummary(result: FusionResult): string {
  if (!result.workspace) return "Disabled";
  return `Enabled (${result.workspace.participantCount} participant sandboxes)`;
}

function artifactSummary(result: FusionResult): string {
  return result.artifactsPath ? "Saved; path available in message details" : "Not saved";
}

function shouldPrintRunDirectory(): boolean {
  return process.env.PI_FUSION_PRINT_RUN_DIRECTORY === "1";
}

export function formatFusionDisplayResult(result: FusionResult): string {
  const finalAnswer = result.finalAnswer.trim() || "_No final answer generated._";
  const rows: Array<[string, string | number]> = [
    ["Mode", result.mode],
    ["Participants", participantSummary(result)],
    ["Evidence sources", result.evidence.totalEntries],
    ["Judge verification", verificationSummary(result)],
    ["Workspace sandboxes", workspaceSummary(result)],
    ["Artifacts", artifactSummary(result)],
    ["Cost", `$${result.totalCost.toFixed(4)}`],
    ["Tokens", `input ${result.totalTokens.input} / output ${result.totalTokens.output}`],
  ];

  return [
    "# Pi Fusion Result",
    "",
    finalAnswer,
    "",
    "---",
    "",
    "## Run Summary",
    "",
    "| Item | Value |",
    "| --- | --- |",
    ...rows.map(([key, value]) => `| ${tableCell(key)} | ${tableCell(value)} |`),
    "",
    "Internal judge analysis, verification notes, participant answers, evidence pool, and workspace paths were saved as artifacts/details instead of appended to this user-facing answer.",
    ...(shouldPrintRunDirectory() && result.artifactsPath ? ["", `Run directory: ${result.artifactsPath}`] : []),
  ].join("\n");
}
