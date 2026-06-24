/**
 * Pi Fusion shared types
 */

import type { WorkspaceChangeSet, WorkspaceSandbox } from "./workspace-sandbox.js";

// === Configuration ===

export interface ModelSlot {
  model: string; // provider/model-id
  fallbacks?: string[]; // replaces defaultFallbacks when set
}

export type WebPolicy = "required" | "optional" | "off";

export interface McpWebBackendConfig {
  type: "mcp";
  /** Backward-compatible alias for searchServerName. */
  serverName: string;
  searchServerName?: string;
  fetchServerName?: string;
  searchTool?: string;
  fetchTool?: string;
  statusTool?: string;
  fetchFallback?: "off" | "hardened_scraper";
  hardenedScraperPath?: string;
  searchProvider?: "auto" | "glm" | "minimax";
  searchStrategy?: "fallback" | "prefer_glm" | "prefer_minimax";
  maxResults?: number;
  configPaths?: string[];
}

export type WebBackendConfig = McpWebBackendConfig;

export interface RetryPolicy {
  /** Number of retries after the initial attempt, before falling back. */
  maxRetries: number;
  /** Delay before the first retry. */
  initialDelayMs: number;
  /** Maximum delay between retries. */
  maxDelayMs: number;
  /** Exponential backoff multiplier. */
  backoffMultiplier: number;
  /** Randomize each delay by +/- this ratio to avoid provider thundering herds. */
  jitterRatio: number;
}

export type BashPolicy = "off" | "sandboxed";

export interface ToolPolicy {
  /** Sandboxed local bash for arithmetic/table processing. Never exposes a raw host shell. */
  bash?: BashPolicy;
}

export interface GlobalFusionConfig {
  participants: ModelSlot[];
  judge: ModelSlot;
  defaultFallbacks: string[];
  webPolicy: WebPolicy;
  webBackend?: WebBackendConfig;
  retryPolicy?: RetryPolicy;
  toolPolicy?: ToolPolicy;
  monitorDefault: boolean;
  confirmBeforeRun: boolean;
}

// === Fusion Run ===

export type FusionMode = "quality" | "fast";

export interface FusionInput {
  prompt: string;
  mode: FusionMode;
  monitor: boolean;
  /** Optional pre-run evidence collected by the Pi extension, such as user-approved local files. */
  initialEvidence?: EvidenceEntry[];
  /**
   * Optional isolated workspace support for project-sized tasks.
   *
   * Pi itself has no built-in sandbox; this copies the source workspace into
   * Pi Fusion-owned participant sandboxes and only exposes those copies through
   * scoped workspace tools.
   */
  workspace?: WorkspaceRunInput;
}

export interface WorkspaceRunInput {
  enabled: boolean;
  sourceRoot: string;
  root: string;
}

export interface ParticipantWorkspaceContext {
  sandbox: WorkspaceSandbox;
  sourceRoot: string;
  baselineSha256: string;
  fileCount: number;
  skippedCount: number;
}

export interface WorkspaceChangedFile {
  op: "add" | "modify" | "delete";
  path: string;
  size?: number;
}

export interface ParticipantWorkspaceSummary {
  sandboxId: string;
  root: string;
  sourceRoot: string;
  baselineSha256: string;
  fileCount: number;
  skippedCount: number;
  changedFiles: WorkspaceChangedFile[];
  changeSet?: WorkspaceChangeSet;
  error?: string;
}

export interface WorkspaceRunSummary {
  enabled: boolean;
  sourceRoot: string;
  root: string;
  baselineSha256: string;
  fileCount: number;
  skippedCount: number;
  participantCount: number;
}

// === Participant ===

export interface TokenUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface ParticipantOutput {
  slotIndex: number;
  model: string;
  answer: string;
  evidence: EvidenceEntry[];
  tokens: TokenUsage;
  cost: number;
  fallbackUsed?: string;
  workspace?: ParticipantWorkspaceSummary;
  error?: string;
}

export type ParticipantStatus =
  | { state: "pending"; slotIndex: number; model: string }
  | { state: "running"; slotIndex: number; model: string; startedAt: number }
  | { state: "success"; slotIndex: number; output: ParticipantOutput }
  | { state: "failed"; slotIndex: number; error: string; errorType: FusionErrorType }
  | { state: "retrying"; slotIndex: number; nextModel: string; previousError: string }
  | { state: "awaiting-recovery"; slotIndex: number; failedModels: string[]; lastError: string }
  | { state: "skipped"; slotIndex: number; reason: string }
  | { state: "replaced"; slotIndex: number; newModel: string };

// === Errors ===

// === Model Caller ===

export interface ModelCallRequest {
  model: string;
  systemPrompt: string;
  messages: Array<{ role: string; content: string }>;
  tools?: string[];
  toolContext?: {
    participantSlotIndex?: number;
    judge?: boolean;
    workspace?: ParticipantWorkspaceContext;
  };
  onEvidence?: (entry: EvidenceEntry) => void;
  signal?: AbortSignal;
}

export class FusionError extends Error {
  errorType: FusionErrorType;
  constructor(message: string, errorType: FusionErrorType) {
    super(message);
    this.name = "FusionError";
    this.errorType = errorType;
  }
}

export interface ModelCallResult {
  answer: string;
  model: string;
  tokens: TokenUsage;
  cost: number;
  evidence?: EvidenceEntry[];
}

export interface ModelCaller {
  call(request: ModelCallRequest): Promise<ModelCallResult>;
}

export type FusionErrorType =
  | "rate_limit"
  | "quota"
  | "timeout"
  | "network"
  | "empty_response"
  | "context_limit"
  | "provider_error"
  | "unknown";

// === Evidence ===

export interface EvidenceEntry {
  id: string;
  source: "web_search" | "web_fetch" | "file_read" | "bash";
  query?: string;
  url?: string;
  title?: string;
  snippet: string;
  fullContent?: string;
  participantSlotIndex: number;
  fetchedAt: number;
}

export interface EvidencePool {
  entries: EvidenceEntry[];
}

export interface EvidenceSummary {
  totalEntries: number;
  sources: Array<{
    id: string;
    source: string;
    title?: string;
    url?: string;
    usedBySlots: number[];
  }>;
}

// === Obligation Planning ===

export interface FusionObligation {
  id: string;
  kind: "metric" | "comparison" | "source" | "calculation" | "recommendation" | "caveat" | "other";
  description: string;
  entities?: string[];
  timePeriod?: string;
  expectedEvidence?: string[];
  preferredSourceTypes?: string[];
  status?: "unknown" | "supported" | "missing" | "not_publicly_available";
}

export interface ObligationPlan {
  obligations: FusionObligation[];
  notes?: string[];
}

// === Judge ===

export interface StructuredJudgeAnalysis {
  consensus: string[];
  contradictions: Array<{
    topic: string;
    stances: Array<{ slotIndex: number; stance: string }>;
  }>;
  coverageGaps: string[];
  uniqueInsights: Array<{
    slotIndex: number;
    insight: string;
  }>;
  blindSpots: string[];
  sourceConfidence: Array<{
    claim: string;
    supportedBy: string[];
    confidence: "high" | "medium" | "low";
  }>;
}

export interface JudgeVerification {
  unsupportedClaims: string[];
  missingContradictions: string[];
  citationIssues: string[];
  remainingCaveats: string[];
  pass: boolean;
}

// === Fusion Result ===

export interface FusionResult {
  finalAnswer: string;
  judgeAnalysis: StructuredJudgeAnalysis;
  judgeVerification?: JudgeVerification; // quality mode only
  obligationPlan?: ObligationPlan;
  judgeRecoveryNotes?: string;
  participants: ParticipantStatus[];
  evidence: EvidenceSummary;
  evidencePool?: EvidencePool;
  workspace?: WorkspaceRunSummary;
  artifactsPath: string;
  mode: FusionMode;
  totalCost: number;
  totalTokens: TokenUsage;
}
