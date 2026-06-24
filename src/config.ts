import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BashPolicy, GlobalFusionConfig, ModelSlot, RetryPolicy, ToolPolicy, WebBackendConfig, WebPolicy } from "./types.js";

const CONFIG_FILE = "config.json";

const VALID_WEB_POLICIES = new Set<string>(["required", "optional", "off"]);
const VALID_WEB_BACKEND_TYPES = new Set<string>(["mcp"]);
const VALID_SEARCH_PROVIDERS = new Set<string>(["auto", "glm", "minimax"]);
const VALID_SEARCH_STRATEGIES = new Set<string>(["fallback", "prefer_glm", "prefer_minimax"]);
const VALID_FETCH_FALLBACKS = new Set<string>(["off", "hardened_scraper"]);
const VALID_BASH_POLICIES = new Set<string>(["off", "sandboxed"]);

function isNonEmptyString(v: unknown): v is string {
  return typeof v === "string" && v.trim().length > 0;
}

function isValidModelSlot(slot: unknown): slot is ModelSlot {
  if (!slot || typeof slot !== "object") return false;
  const s = slot as Record<string, unknown>;
  if (!isNonEmptyString(s.model)) return false;
  if (s.fallbacks !== undefined) {
    if (!Array.isArray(s.fallbacks) || !s.fallbacks.every((f) => isNonEmptyString(f))) return false;
  }
  return true;
}

function validateRetryPolicy(value: unknown): RetryPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("retryPolicy must be an object when provided");
  }
  const policy = value as Record<string, unknown>;
  const maxRetries = policy.maxRetries ?? 5;
  const initialDelayMs = policy.initialDelayMs ?? 5_000;
  const maxDelayMs = policy.maxDelayMs ?? 120_000;
  const backoffMultiplier = policy.backoffMultiplier ?? 2;
  const jitterRatio = policy.jitterRatio ?? 0.2;

  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 10) {
    throw new Error("retryPolicy.maxRetries must be an integer between 0 and 10");
  }
  if (typeof initialDelayMs !== "number" || !Number.isInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 600_000) {
    throw new Error("retryPolicy.initialDelayMs must be an integer between 0 and 600000");
  }
  if (typeof maxDelayMs !== "number" || !Number.isInteger(maxDelayMs) || maxDelayMs < 0 || maxDelayMs > 900_000) {
    throw new Error("retryPolicy.maxDelayMs must be an integer between 0 and 900000");
  }
  if (typeof backoffMultiplier !== "number" || backoffMultiplier < 1 || backoffMultiplier > 10) {
    throw new Error("retryPolicy.backoffMultiplier must be a number between 1 and 10");
  }
  if (typeof jitterRatio !== "number" || jitterRatio < 0 || jitterRatio > 1) {
    throw new Error("retryPolicy.jitterRatio must be a number between 0 and 1");
  }

  return { maxRetries, initialDelayMs, maxDelayMs, backoffMultiplier, jitterRatio };
}

function validateToolPolicy(value: unknown): ToolPolicy | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("toolPolicy must be an object when provided");
  }
  const policy = value as Record<string, unknown>;
  if (policy.bash !== undefined && !VALID_BASH_POLICIES.has(policy.bash as string)) {
    throw new Error(`Invalid toolPolicy.bash: ${String(policy.bash)}`);
  }
  return {
    ...(policy.bash !== undefined ? { bash: policy.bash as BashPolicy } : {}),
  };
}

function validateWebBackendConfig(value: unknown): WebBackendConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object") {
    throw new Error("webBackend must be an object when provided");
  }
  const backend = value as Record<string, unknown>;
  const type = backend.type ?? "mcp";
  if (!VALID_WEB_BACKEND_TYPES.has(type as string)) {
    throw new Error(`Invalid webBackend.type: ${String(type)}`);
  }
  const serverName = isNonEmptyString(backend.serverName)
    ? backend.serverName
    : isNonEmptyString(backend.searchServerName)
      ? backend.searchServerName
      : undefined;
  if (!serverName) {
    throw new Error("webBackend.serverName or webBackend.searchServerName must be a non-empty string");
  }
  if (backend.searchServerName !== undefined && !isNonEmptyString(backend.searchServerName)) {
    throw new Error("webBackend.searchServerName must be a non-empty string when provided");
  }
  if (backend.fetchServerName !== undefined && !isNonEmptyString(backend.fetchServerName)) {
    throw new Error("webBackend.fetchServerName must be a non-empty string when provided");
  }
  if (backend.searchTool !== undefined && !isNonEmptyString(backend.searchTool)) {
    throw new Error("webBackend.searchTool must be a non-empty string when provided");
  }
  if (backend.fetchTool !== undefined && !isNonEmptyString(backend.fetchTool)) {
    throw new Error("webBackend.fetchTool must be a non-empty string when provided");
  }
  if (backend.statusTool !== undefined && !isNonEmptyString(backend.statusTool)) {
    throw new Error("webBackend.statusTool must be a non-empty string when provided");
  }
  if (backend.fetchFallback !== undefined && !VALID_FETCH_FALLBACKS.has(backend.fetchFallback as string)) {
    throw new Error(`Invalid webBackend.fetchFallback: ${String(backend.fetchFallback)}`);
  }
  if (backend.hardenedScraperPath !== undefined && !isNonEmptyString(backend.hardenedScraperPath)) {
    throw new Error("webBackend.hardenedScraperPath must be a non-empty string when provided");
  }
  if (backend.searchProvider !== undefined && !VALID_SEARCH_PROVIDERS.has(backend.searchProvider as string)) {
    throw new Error(`Invalid webBackend.searchProvider: ${String(backend.searchProvider)}`);
  }
  if (backend.searchStrategy !== undefined && !VALID_SEARCH_STRATEGIES.has(backend.searchStrategy as string)) {
    throw new Error(`Invalid webBackend.searchStrategy: ${String(backend.searchStrategy)}`);
  }
  if (backend.maxResults !== undefined) {
    if (typeof backend.maxResults !== "number" || !Number.isInteger(backend.maxResults) || backend.maxResults < 1 || backend.maxResults > 20) {
      throw new Error("webBackend.maxResults must be an integer between 1 and 20");
    }
  }
  if (backend.configPaths !== undefined) {
    if (!Array.isArray(backend.configPaths) || !backend.configPaths.every(isNonEmptyString)) {
      throw new Error("webBackend.configPaths must be an array of non-empty strings");
    }
  }

  return {
    type: "mcp",
    serverName: serverName as string,
    ...(backend.searchServerName !== undefined ? { searchServerName: backend.searchServerName as string } : {}),
    ...(backend.fetchServerName !== undefined ? { fetchServerName: backend.fetchServerName as string } : {}),
    ...(backend.searchTool !== undefined ? { searchTool: backend.searchTool as string } : {}),
    ...(backend.fetchTool !== undefined ? { fetchTool: backend.fetchTool as string } : {}),
    ...(backend.statusTool !== undefined ? { statusTool: backend.statusTool as string } : {}),
    ...(backend.fetchFallback !== undefined ? { fetchFallback: backend.fetchFallback as WebBackendConfig["fetchFallback"] } : {}),
    ...(backend.hardenedScraperPath !== undefined ? { hardenedScraperPath: backend.hardenedScraperPath as string } : {}),
    ...(backend.searchProvider !== undefined ? { searchProvider: backend.searchProvider as WebBackendConfig["searchProvider"] } : {}),
    ...(backend.searchStrategy !== undefined ? { searchStrategy: backend.searchStrategy as WebBackendConfig["searchStrategy"] } : {}),
    ...(backend.maxResults !== undefined ? { maxResults: backend.maxResults as number } : {}),
    ...(backend.configPaths !== undefined ? { configPaths: backend.configPaths as string[] } : {}),
  };
}

function validateConfig(config: unknown): GlobalFusionConfig {
  if (!config || typeof config !== "object") {
    throw new Error("Config must be an object");
  }
  const c = config as Record<string, unknown>;

  // participants
  if (!Array.isArray(c.participants) || c.participants.length === 0) {
    throw new Error("Config must have at least one participant with a model");
  }
  for (const p of c.participants) {
    if (!isValidModelSlot(p)) {
      throw new Error("Each participant must have a non-empty model");
    }
  }

  // judge
  if (!isValidModelSlot(c.judge)) {
    throw new Error("Judge must have a non-empty model");
  }

  // webPolicy
  const wp = c.webPolicy ?? "optional";
  if (!VALID_WEB_POLICIES.has(wp as string)) {
    throw new Error(`Invalid webPolicy: ${wp}`);
  }

  const defaultFallbacks = Array.isArray(c.defaultFallbacks)
    ? (c.defaultFallbacks as unknown[])
    : [];
  if (!defaultFallbacks.every(isNonEmptyString)) {
    throw new Error("defaultFallbacks must contain only non-empty model strings");
  }

  const webBackend = validateWebBackendConfig(c.webBackend);
  const retryPolicy = validateRetryPolicy(c.retryPolicy);
  const toolPolicy = validateToolPolicy(c.toolPolicy);

  return {
    participants: c.participants as ModelSlot[],
    judge: c.judge as ModelSlot,
    defaultFallbacks: defaultFallbacks as string[],
    webPolicy: wp as WebPolicy,
    ...(webBackend ? { webBackend } : {}),
    ...(retryPolicy ? { retryPolicy } : {}),
    ...(toolPolicy ? { toolPolicy } : {}),
    monitorDefault: typeof c.monitorDefault === "boolean" ? c.monitorDefault : false,
    confirmBeforeRun: typeof c.confirmBeforeRun === "boolean" ? c.confirmBeforeRun : true,
  };
}

export class ConfigManager {
  private dir: string;

  constructor(configDir: string) {
    this.dir = configDir;
  }

  private get filePath(): string {
    return path.join(this.dir, CONFIG_FILE);
  }

  async exists(): Promise<boolean> {
    try {
      await fs.access(this.filePath);
      return true;
    } catch {
      return false;
    }
  }

  async load(): Promise<GlobalFusionConfig> {
    const raw = await fs.readFile(this.filePath, "utf-8");
    const parsed = JSON.parse(raw);
    return validateConfig(parsed);
  }

  async save(config: GlobalFusionConfig): Promise<void> {
    const validated = validateConfig(config);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(validated, null, 2), "utf-8");
  }

  async saveRaw(rawJson: string): Promise<void> {
    const parsed = JSON.parse(rawJson);
    const validated = validateConfig(parsed);
    await fs.mkdir(this.dir, { recursive: true });
    await fs.writeFile(this.filePath, JSON.stringify(validated, null, 2), "utf-8");
  }
}
