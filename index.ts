/**
 * Pi Fusion Extension
 *
 * Adds /pi-fusion, /pi-fusion-config, and /pi-fusion-doctor commands to Pi.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as os from "node:os";
import * as fs from "node:fs/promises";
import { ConfigManager } from "./src/config.js";
import { FusionEngine, type FusionProgressEvent } from "./src/engine.js";
import { ArtifactWriter } from "./src/artifacts.js";
import { FusionError } from "./src/types.js";
import type {
  EvidenceEntry,
  GlobalFusionConfig,
  ModelCaller,
  ModelCallRequest,
  ModelCallResult,
  TokenUsage,
  FusionResult,
} from "./src/types.js";
import {
  DEFAULT_MCP_WEB_BACKEND,
  createMcpWebBackend,
  discoverMcpWebBackend,
  type WebBackend,
  type WebSearchResult,
} from "./src/web.js";
import { DEFAULT_MODEL_RETRY_POLICY } from "./src/retry.js";
import { formatSandboxBashResult, runSandboxedBash } from "./src/bash.js";
import { extractFocusedExcerpt } from "./src/text-excerpt.js";
import { extractLocalFileReferences, importExternalEvidence } from "./src/workspace-sandbox.js";

function getConfigDir(): string {
  return path.join(os.homedir(), ".pi", "agent", "pi-fusion");
}

function getArtifactsDir(): string {
  // ArtifactWriter appends runs/<run-id>; pass the Pi Fusion base directory.
  return getConfigDir();
}

function splitModelRef(modelRef: string): { provider: string; id: string } {
  const [provider, ...idParts] = modelRef.split("/");
  return { provider, id: idParts.join("/") };
}

function zeroUsage(): TokenUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function addUsage(acc: TokenUsage, usage?: Partial<TokenUsage>): TokenUsage {
  return {
    input: acc.input + (usage?.input ?? 0),
    output: acc.output + (usage?.output ?? 0),
    cacheRead: acc.cacheRead + (usage?.cacheRead ?? 0),
    cacheWrite: acc.cacheWrite + (usage?.cacheWrite ?? 0),
  };
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function extractAssistantText(response: { content: Array<{ type: string; text?: string }> }): string {
  return response.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

function createWebBackendFromConfig(config: GlobalFusionConfig): WebBackend | undefined {
  if (config.webPolicy === "off" || !config.webBackend) return undefined;
  if (config.webBackend.type === "mcp") {
    return createMcpWebBackend(config.webBackend);
  }
  return undefined;
}

function formatWebBackendLabel(config: GlobalFusionConfig): string {
  if (config.webPolicy === "off") return "disabled";
  if (!config.webBackend) return "auto-detect at run time (model fusion still works if none is found)";
  return `${config.webBackend.type}:search=${config.webBackend.searchServerName ?? config.webBackend.serverName}, fetch=${config.webBackend.fetchServerName ?? "same/none"}, fetchFallback=${config.webBackend.fetchFallback ?? "off"}`;
}

function promptLikelyNeedsEvidence(prompt: string): boolean {
  return /\b(current|latest|recent|today|now|202[0-9]|cite|citation|source|sources|evidence|official|web|search|fetch|url|https?:\/\/|compare|price|pricing|vendor|law|legal|regulation|sec|filing|benchmark|data|report|news)\b/i.test(prompt);
}

async function resolveWebBackendFromConfig(config: GlobalFusionConfig): Promise<{ backend?: WebBackend; label: string; autoDetected: boolean; message?: string }> {
  const explicit = createWebBackendFromConfig(config);
  if (explicit) {
    return { backend: explicit, label: formatWebBackendLabel(config), autoDetected: false };
  }
  if (config.webPolicy === "off") {
    return { label: "disabled", autoDetected: false };
  }

  try {
    const discovered = await discoverMcpWebBackend(undefined, { timeoutMs: 4_000 });
    if (discovered) {
      return {
        backend: createMcpWebBackend(discovered.config),
        label: `auto-detected ${discovered.config.type}:search=${discovered.config.searchServerName}/${discovered.config.searchTool}, fetch=${discovered.config.fetchServerName}/${discovered.config.fetchTool}`,
        autoDetected: true,
        message: discovered.message,
      };
    }
  } catch {
    // Discovery is best-effort. Pi Fusion still runs without evidence tools.
  }

  return { label: "not configured or auto-detected (model fusion only)", autoDetected: false };
}

async function handleMissingEvidenceBackend(
  ctx: ExtensionContext,
  prompt: string,
): Promise<{ prompt: string; cancelled: boolean }> {
  if (!promptLikelyNeedsEvidence(prompt)) return { prompt, cancelled: false };

  const choice = await ctx.ui.select(
    "No web/evidence backend was auto-detected. How should Pi Fusion continue?",
    [
      "Continue without web evidence",
      "Add context/evidence notes now",
      "Cancel so I can configure tools or ask Pi for help",
    ],
  );

  if (!choice || choice.startsWith("Continue")) return { prompt, cancelled: false };
  if (choice.startsWith("Cancel")) return { prompt, cancelled: true };

  const extra = await ctx.ui.editor(
    "Paste URLs, excerpts, notes, or instructions to include as extra context for this run:",
    "",
  );
  const trimmed = extra?.trim();
  if (!trimmed) return { prompt, cancelled: false };
  return {
    prompt: `${prompt}\n\nAdditional user-provided context/evidence for this run:\n${trimmed}`,
    cancelled: false,
  };
}

async function collectLocalEvidenceFromPrompt(
  ctx: ExtensionContext,
  prompt: string,
): Promise<{ evidence: EvidenceEntry[]; cancelled: boolean }> {
  const refs = extractLocalFileReferences(prompt);
  if (refs.length === 0) return { evidence: [], cancelled: false };
  if (!ctx.hasUI) return { evidence: [], cancelled: false };

  const evidence: EvidenceEntry[] = [];
  const evidenceRoot = path.join(getConfigDir(), "local-evidence", `${Date.now()}-${stableHash(prompt)}`);
  const seen = new Set<string>();

  for (const ref of refs) {
    let stat;
    try {
      stat = await fs.lstat(ref);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    const realPath = await fs.realpath(ref);
    if (seen.has(realPath)) continue;
    seen.add(realPath);

    const choice = await ctx.ui.select(
      `Pi Fusion found a local file reference:\n${ref}\n\nInclude it as read-only evidence for this run?`,
      ["Include read-only evidence", "Skip this file", "Cancel run"],
    );
    if (!choice || choice === "Skip this file") continue;
    if (choice === "Cancel run") return { evidence, cancelled: true };

    try {
      const imported = await importExternalEvidence({ sourcePath: realPath, evidenceRoot });
      const content = await fs.readFile(imported.sandboxPath, "utf-8");
      evidence.push({
        id: `file-${stableHash(`${imported.modelPath}:${imported.sha256}`)}`,
        source: "file_read",
        url: `file://${imported.modelPath}`,
        title: `Local file: ${imported.modelPath}`,
        snippet: content.slice(0, 2_000),
        fullContent: content,
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      });
    } catch (error) {
      ctx.ui.notify(`Could not import local evidence ${path.basename(ref)}: ${error instanceof Error ? error.message : String(error)}`, "warning");
    }
  }

  return { evidence, cancelled: false };
}

async function buildToolDefinitions(toolNames: string[], webBackend?: WebBackend) {
  if (toolNames.length === 0) return undefined;
  const { Type } = await import("@earendil-works/pi-ai");
  const tools: Array<{ name: string; description: string; parameters: any }> = [];

  if (toolNames.includes("web_search") && webBackend?.supportsSearch) {
    tools.push({
      name: "web_search",
      description: "Search the live web for current, sourceable information. Use concise queries and prefer primary/official sources.",
      parameters: Type.Object({
        query: Type.String({ description: "Search query" }),
      }),
    });
  }

  if (toolNames.includes("web_fetch") && webBackend?.supportsFetch) {
    tools.push({
      name: "web_fetch",
      description: "Fetch a specific web page URL and return readable text for source verification. For long filings, PDFs, docs, or reports, include focus terms to retrieve targeted excerpts around the needed metrics/entities.",
      parameters: Type.Object({
        url: Type.String({ description: "URL to fetch" }),
        focus: Type.Optional(Type.String({ description: "Optional focus query/terms for long documents, e.g. 'Core Portfolio Funds operating income revenue' or 'Renaissance purchase price assumed debt'." })),
      }),
    });
  }

  if (toolNames.includes("bash")) {
    tools.push({
      name: "bash",
      description: "Run a short sandboxed bash command for deterministic calculations or table/JSON processing. No network, local file inspection, package installs, credential access, or filesystem mutation. Use web_search/web_fetch for web access.",
      parameters: Type.Object({
        command: Type.String({ description: "Short bash command. Prefer python3 here-docs for arithmetic. Do not read local files or access the network." }),
        timeoutMs: Type.Optional(Type.Number({ description: "Optional timeout in milliseconds, capped at 30000." })),
      }),
    });
  }

  return tools.length > 0 ? tools : undefined;
}

function evidenceFromSearchResult(
  result: WebSearchResult,
  query: string,
  slotIndex: number,
  index: number,
): EvidenceEntry {
  const stable = stableHash(`${slotIndex}:${query}:${result.url ?? ""}:${result.title}:${index}`);
  return {
    id: `web-${slotIndex >= 0 ? slotIndex + 1 : "judge"}-${stable}`,
    source: "web_search",
    query,
    url: result.url,
    title: result.title,
    snippet: result.snippet,
    participantSlotIndex: slotIndex,
    fetchedAt: Date.now(),
  };
}

async function executeTool(
  webBackend: WebBackend | undefined,
  request: ModelCallRequest,
  toolName: string,
  args: Record<string, unknown>,
): Promise<{ content: string; isError: boolean; evidence: EvidenceEntry[] }> {
  try {
    if (toolName === "bash") {
      const command = typeof args.command === "string" ? args.command : "";
      const timeoutMs = typeof args.timeoutMs === "number" ? args.timeoutMs : undefined;
      const result = await runSandboxedBash(command, { timeoutMs });
      const slotIndex = request.toolContext?.participantSlotIndex ?? -1;
      const id = `bash-${slotIndex >= 0 ? slotIndex + 1 : "judge"}-${stableHash(`${command}:${Date.now()}`)}`;
      const content = formatSandboxBashResult(result);
      const entry: EvidenceEntry = {
        id,
        source: "bash",
        title: "Sandboxed bash result",
        snippet: `Command:\n${command.slice(0, 500)}\n\n${content.slice(0, 1500)}`,
        fullContent: content,
        participantSlotIndex: slotIndex,
        fetchedAt: Date.now(),
      };
      return { content: `[${id}]\n${content}`, isError: result.exitCode !== 0, evidence: [entry] };
    }

    if ((toolName === "web_search" || toolName === "web_fetch") && !webBackend) {
      return { content: "Web backend is not configured.", isError: true, evidence: [] };
    }
    if (toolName === "web_search") {
      const backend = webBackend!;
      const query = typeof args.query === "string" ? args.query.trim() : "";
      if (!query) return { content: "web_search error: query must be a non-empty string", isError: true, evidence: [] };

      const results = await backend.search(query, { signal: request.signal });
      const slotIndex = request.toolContext?.participantSlotIndex ?? -1;
      const evidence = results.map((result, index) => evidenceFromSearchResult(result, query, slotIndex, index));
      const content = evidence.length === 0
        ? `No web search results for: ${query}`
        : evidence.map((entry, index) => {
          const result = results[index];
          return [
            `[${entry.id}] ${entry.title ?? result.title}`,
            entry.url ? `URL: ${entry.url}` : undefined,
            result.date ? `Date: ${result.date}` : undefined,
            `Snippet: ${entry.snippet}`,
          ].filter(Boolean).join("\n");
        }).join("\n\n");
      return { content, isError: false, evidence };
    }

    if (toolName === "web_fetch") {
      const backend = webBackend!;
      if (!backend.fetch) {
        return { content: "web_fetch is not supported by the configured web backend.", isError: true, evidence: [] };
      }
      const url = typeof args.url === "string" ? args.url.trim() : "";
      if (!url) return { content: "web_fetch error: url must be a non-empty string", isError: true, evidence: [] };
      if (url.startsWith("file://")) {
        return {
          content: "web_fetch supports http(s) URLs only. Local files must be imported as user-approved read-only local evidence before the Fusion run; ask the user to include the file or reference it in the prompt.",
          isError: true,
          evidence: [],
        };
      }
      const focus = typeof args.focus === "string" ? args.focus.trim() : undefined;
      const fetched = await backend.fetch(url, { signal: request.signal });
      const returnedText = extractFocusedExcerpt(fetched.text, focus);
      const slotIndex = request.toolContext?.participantSlotIndex ?? -1;
      const id = `fetch-${slotIndex >= 0 ? slotIndex + 1 : "judge"}-${stableHash(url)}`;
      const entry: EvidenceEntry = {
        id,
        source: "web_fetch",
        url,
        title: fetched.title,
        snippet: returnedText.slice(0, 1000),
        fullContent: fetched.text,
        participantSlotIndex: slotIndex,
        fetchedAt: Date.now(),
      };
      return { content: `[${id}] ${fetched.title ?? url}${focus ? `\nFocus: ${focus}` : ""}\n\n${returnedText}`, isError: false, evidence: [entry] };
    }

    return { content: `Unknown tool: ${toolName}`, isError: true, evidence: [] };
  } catch (error) {
    return {
      content: `${toolName} error: ${error instanceof Error ? error.message : String(error)}`,
      isError: true,
      evidence: [],
    };
  }
}

function createModelCaller(ctx: ExtensionContext, webBackend?: WebBackend): ModelCaller {
  return {
    async call(request: ModelCallRequest): Promise<ModelCallResult> {
      const { provider, id } = splitModelRef(request.model);
      const model = ctx.modelRegistry.find(provider, id);
      if (!model) {
        throw new FusionError(`Model not found: ${request.model}`, "provider_error");
      }

      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok || !auth.apiKey) {
        throw new FusionError(
          `No API key for ${request.model}: ${auth.ok ? "missing key" : auth.error}`,
          "provider_error",
        );
      }

      const { complete } = await import("@earendil-works/pi-ai");
      const tools = await buildToolDefinitions(request.tools ?? [], webBackend);
      const messages: any[] = request.messages.map((m) => ({
        role: "user" as const,
        content: [{ type: "text" as const, text: m.content }],
        timestamp: Date.now(),
      }));

      let tokens = zeroUsage();
      let cost = 0;
      const collectedEvidence: EvidenceEntry[] = [];
      const maxToolRounds = 8;

      for (let round = 0; round <= maxToolRounds; round++) {
        const response = await complete(
          model,
          {
            systemPrompt: request.systemPrompt,
            messages,
            ...(tools ? { tools } : {}),
          },
          { apiKey: auth.apiKey, headers: auth.headers, signal: request.signal },
        );

        tokens = addUsage(tokens, response.usage);
        cost += response.usage?.cost?.total ?? 0;

        if (response.stopReason === "error" || response.stopReason === "aborted") {
          throw new FusionError(response.errorMessage ?? `Model call failed: ${request.model}`, response.stopReason === "aborted" ? "timeout" : "provider_error");
        }

        const toolCalls = response.content.filter((c): c is { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> } => c.type === "toolCall");
        if (toolCalls.length === 0) {
          const text = extractAssistantText(response);
          if (!text) throw new FusionError(`Empty response from ${request.model}`, "empty_response");
          return {
            answer: text,
            model: request.model,
            tokens,
            cost,
            evidence: collectedEvidence,
          };
        }

        messages.push(response);
        for (const toolCall of toolCalls) {
          const outcome = await executeTool(webBackend, request, toolCall.name, toolCall.arguments ?? {});
          for (const entry of outcome.evidence) {
            collectedEvidence.push(entry);
            request.onEvidence?.(entry);
          }
          messages.push({
            role: "toolResult" as const,
            toolCallId: toolCall.id,
            toolName: toolCall.name,
            content: [{ type: "text" as const, text: outcome.content }],
            isError: outcome.isError,
            timestamp: Date.now(),
          });
        }
      }

      // Some models keep requesting searches until the tool budget is exhausted.
      // Make the exhaustion visible, then force a final answer from gathered
      // evidence instead of failing the whole Participant Run.
      messages.push({
        role: "user" as const,
        content: [{
          type: "text" as const,
          text: `Tool budget exhausted after ${maxToolRounds + 1} rounds. Do not call tools again. Write your best final answer now using only the gathered tool results and clearly flag any remaining uncertainty.`,
        }],
        timestamp: Date.now(),
      });

      const finalResponse = await complete(
        model,
        { systemPrompt: request.systemPrompt, messages },
        { apiKey: auth.apiKey, headers: auth.headers, signal: request.signal },
      );
      tokens = addUsage(tokens, finalResponse.usage);
      cost += finalResponse.usage?.cost?.total ?? 0;
      const finalText = extractAssistantText(finalResponse);
      if (!finalText) throw new FusionError(`Tool loop exhausted and ${request.model} returned no final answer`, "timeout");
      return {
        answer: finalText,
        model: request.model,
        tokens,
        cost,
        evidence: collectedEvidence,
      };
    },
  };
}

function formatParticipantLine(p: FusionResult["participants"][number]): string {
  const index = "slotIndex" in p ? (p as any).slotIndex : 0;
  const model = "output" in p ? (p as any).output.model : "unknown";
  const icon = p.state === "success" ? "✓" : p.state === "skipped" ? "⊝" : "✗";
  return `- P${index + 1} ${icon} ${p.state} ${model}`;
}

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function createFusionProgressUi(
  ctx: ExtensionContext,
  options: { mode: "quality" | "fast"; totalParticipants: number },
): { onProgress: (event: FusionProgressEvent) => void; setMessage: (message: string) => void; dispose: () => void } {
  const frames = ["-", "\\", "|", "/"];
  const startedAt = Date.now();
  const participantStates = Array.from({ length: options.totalParticipants }, () => "pending");
  let frameIndex = 0;
  let latestMessage = "Starting Pi Fusion";
  let phase = "starting";
  let completedParticipants = 0;
  let disposed = false;

  const render = () => {
    if (disposed) return;
    const frame = frames[frameIndex++ % frames.length];
    const elapsed = formatElapsed(Date.now() - startedAt);
    const compact = `${frame} Pi Fusion ${phase} ${elapsed} | P ${completedParticipants}/${options.totalParticipants}`;
    ctx.ui.setStatus("pi-fusion", compact);

    if (ctx.mode === "tui") {
      ctx.ui.setWidget("pi-fusion-progress", [
        `${frame} Pi Fusion running (${options.mode})`,
        `Elapsed: ${elapsed}`,
        `Stage: ${latestMessage}`,
        `Participants: ${completedParticipants}/${options.totalParticipants}`,
        ...participantStates.map((state, index) => `P${index + 1}: ${state}`),
      ], { placement: "belowEditor" });
    }
  };

  const timer = setInterval(render, 800);
  render();

  return {
    onProgress(event) {
      phase = event.phase;
      latestMessage = event.message;
      if (typeof event.completedParticipants === "number") {
        completedParticipants = event.completedParticipants;
      }
      if (event.phase === "participants" && typeof event.slotIndex === "number") {
        const label = event.model ? `${event.state} ${event.model}` : event.state;
        participantStates[event.slotIndex] = label;
      }
      render();
    },
    setMessage(message) {
      latestMessage = message;
      render();
    },
    dispose() {
      disposed = true;
      clearInterval(timer);
      ctx.ui.setStatus("pi-fusion", undefined);
      if (ctx.mode === "tui") ctx.ui.setWidget("pi-fusion-progress", undefined);
    },
  };
}

export default function (pi: ExtensionAPI) {
  // Register /pi-fusion command
  pi.registerCommand("pi-fusion", {
    description: "Run multi-model deliberation on an important question",
    handler: async (args, ctx) => {
      if (!args || args.trim().length === 0) {
        ctx.ui.notify("Usage: /pi-fusion [--fast] [--monitor] <your question>", "error");
        return;
      }

      // Parse flags. Only the text after /pi-fusion is used; current chat history
      // is intentionally not included.
      let mode: "quality" | "fast" = "quality";
      let monitor = false;
      let prompt = args;

      if (prompt.includes("--fast")) {
        mode = "fast";
        prompt = prompt.replace("--fast", "").trim();
      }
      if (prompt.includes("--monitor")) {
        monitor = true;
        prompt = prompt.replace("--monitor", "").trim();
      }
      if (prompt.includes("--no-monitor")) {
        monitor = false;
        prompt = prompt.replace("--no-monitor", "").trim();
      }

      if (!prompt) {
        ctx.ui.notify("Please provide a question after the flags.", "error");
        return;
      }

      // Load config
      const configMgr = new ConfigManager(getConfigDir());
      if (!(await configMgr.exists())) {
        ctx.ui.notify(
          "No Pi Fusion configuration found. Run /pi-fusion-config first.",
          "error",
        );
        return;
      }

      const config = await configMgr.load();
      if (!prompt.includes("--no-monitor")) {
        monitor = monitor || config.monitorDefault;
      }

      // Run Preview
      const participantList = config.participants
        .map((p, i) => `  P${i + 1}: ${p.model}`)
        .join("\n");
      const resolvedWeb = await resolveWebBackendFromConfig(config);
      const webBackend = resolvedWeb.backend;
      const webBackendLabel = resolvedWeb.label;

      if (!webBackend && config.webPolicy === "required") {
        ctx.ui.notify("Web/evidence policy is required, but no configured or auto-detected backend is available.", "error");
        return;
      }

      if (!webBackend && config.webPolicy === "optional") {
        const missing = await handleMissingEvidenceBackend(ctx, prompt);
        if (missing.cancelled) {
          ctx.ui.notify("Fusion run cancelled. Configure an evidence backend with /pi-fusion-config or ask Pi to help set one up.", "info");
          return;
        }
        prompt = missing.prompt;
      }

      const localEvidence = await collectLocalEvidenceFromPrompt(ctx, prompt);
      if (localEvidence.cancelled) {
        ctx.ui.notify("Fusion run cancelled before local evidence import.", "info");
        return;
      }

      const preview = [
        `Pi Fusion Run Preview`,
        ``,
        `Mode: ${mode}`,
        `Participants:\n${participantList}`,
        `Judge: ${config.judge.model}`,
        `Web policy: ${config.webPolicy}`,
        `Evidence backend: ${webBackendLabel}`,
        `Local evidence: ${localEvidence.evidence.length > 0 ? `${localEvidence.evidence.length} file(s) imported read-only` : "none"}`,
        `Bash tool: ${(config.toolPolicy?.bash ?? "sandboxed") === "sandboxed" ? "sandboxed" : "off"}`,
        `Retries: ${(config.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY).maxRetries} per model before fallback`,
        `Monitor: ${monitor ? "on" : "off"}`,
        ``,
        `Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`,
        ``,
        `This will make ${config.participants.length + (mode === "quality" ? 4 : 2)}+ model calls, plus any enabled tool calls.`,
        `Continue?`,
      ].join("\n");

      if (config.confirmBeforeRun) {
        const confirmed = await ctx.ui.confirm(preview, "This will make multiple model calls and may be expensive.");
        if (!confirmed) {
          ctx.ui.notify("Fusion run cancelled.", "info");
          await webBackend?.close?.();
          return;
        }
      }

      const caller = createModelCaller(ctx, webBackend);

      // Run fusion
      ctx.ui.notify("Starting Pi Fusion run...", "info");
      const progress = createFusionProgressUi(ctx, {
        mode,
        totalParticipants: config.participants.length,
      });

      let result: FusionResult;
      try {
        const engine = new FusionEngine(caller, { webBackend });
        result = await engine.run(
          config,
          { prompt, mode, monitor, initialEvidence: localEvidence.evidence },
          { onProgress: progress.onProgress },
        );
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        ctx.ui.notify(`Fusion run failed: ${msg}`, "error");
        return;
      } finally {
        await webBackend?.close?.();
        progress.dispose();
      }

      // Write artifacts
      ctx.ui.setStatus("pi-fusion", "Pi Fusion writing artifacts...");
      const writer = new ArtifactWriter(getArtifactsDir());
      try {
        const artifactsPath = await writer.write(result);
        result.artifactsPath = artifactsPath;
      } finally {
        ctx.ui.setStatus("pi-fusion", undefined);
      }

      // Format and display Fusion Result
      const lines: string[] = [
        `# Pi Fusion Result`,
        ``,
        result.finalAnswer,
        ``,
        `---`,
        ``,
        `## Structured Judge Analysis`,
        ``,
        `**Consensus:**`,
        ...result.judgeAnalysis.consensus.map((c) => `- ${c}`),
        ``,
      ];

      if (result.judgeAnalysis.contradictions.length > 0) {
        lines.push(`**Contradictions:**`);
        for (const c of result.judgeAnalysis.contradictions) {
          lines.push(`- ${c.topic}: ${c.stances.map((s) => `P${s.slotIndex + 1} says "${s.stance}"`).join("; ")}`);
        }
        lines.push("");
      }

      if (result.judgeAnalysis.coverageGaps.length > 0) {
        lines.push(`**Coverage Gaps:**`);
        for (const g of result.judgeAnalysis.coverageGaps) lines.push(`- ${g}`);
        lines.push("");
      }

      if (result.judgeAnalysis.uniqueInsights.length > 0) {
        lines.push(`**Unique Insights:**`);
        for (const i of result.judgeAnalysis.uniqueInsights) {
          lines.push(`- P${i.slotIndex + 1}: ${i.insight}`);
        }
        lines.push("");
      }

      if (result.judgeAnalysis.blindSpots.length > 0) {
        lines.push(`**Blind Spots:**`);
        for (const b of result.judgeAnalysis.blindSpots) lines.push(`- ${b}`);
        lines.push("");
      }

      if (result.judgeVerification) {
        lines.push(`## Judge Verification`);
        lines.push(`Pass: ${result.judgeVerification.pass ? "✓" : "✗"}`);
        if (result.judgeVerification.unsupportedClaims.length > 0) {
          lines.push(`Unsupported claims: ${result.judgeVerification.unsupportedClaims.join(", ")}`);
        }
        if (result.judgeVerification.remainingCaveats.length > 0) {
          lines.push(`Caveats: ${result.judgeVerification.remainingCaveats.join(", ")}`);
        }
        lines.push("");
      }

      lines.push(`## Participants`);
      for (const p of result.participants) lines.push(formatParticipantLine(p));

      lines.push("");
      lines.push(`## Evidence`);
      lines.push(`Sources: ${result.evidence.totalEntries}`);
      if (result.evidence.sources.length > 0) {
        for (const source of result.evidence.sources.slice(0, 10)) {
          lines.push(`- [${source.id}] ${source.title ?? source.source}${source.url ? ` — ${source.url}` : ""}`);
        }
      }

      lines.push("");
      lines.push(`## Artifacts`);
      lines.push(`- Run directory: ${result.artifactsPath}`);

      lines.push("");
      lines.push(`---`);
      lines.push(`Mode: ${result.mode} | Cost: $${result.totalCost.toFixed(4)} | Tokens: ↑${result.totalTokens.input} ↓${result.totalTokens.output}`);

      pi.sendMessage({
        customType: "pi-fusion-result",
        content: lines.join("\n"),
        display: true,
        details: result,
      });
    },
  });

  // Register /pi-fusion-config command
  pi.registerCommand("pi-fusion-config", {
    description: "Configure Pi Fusion models, fallbacks, evidence tools, and monitor defaults",
    handler: async (_args, ctx) => {
      if (!ctx.isIdle()) {
        const activeChoice = await ctx.ui.select(
          "Pi is currently running another response. Configure Pi Fusion now?",
          [
            "Abort current response and configure",
            "Wait for current response to finish",
            "Configure anyway (current response may continue after config)",
            "Cancel without saving",
          ],
        );
        if (activeChoice === undefined || activeChoice === "Cancel without saving") {
          ctx.ui.notify("Pi Fusion configuration cancelled. No changes were saved.", "info");
          return;
        }
        if (activeChoice === "Abort current response and configure") {
          ctx.abort();
          try {
            await ctx.waitForIdle();
          } catch {
            // Abort is best-effort; continue with config once Pi has accepted it.
          }
        } else if (activeChoice === "Wait for current response to finish") {
          try {
            await ctx.waitForIdle();
          } catch {
            ctx.ui.notify("Still waiting on the current response; configuration cancelled.", "warning");
            return;
          }
        }
      }

      const configMgr = new ConfigManager(getConfigDir());

      // Load existing or start fresh
      let config: GlobalFusionConfig;
      if (await configMgr.exists()) {
        config = await configMgr.load();
        ctx.ui.notify("Loading existing Pi Fusion configuration...", "info");
      } else {
        config = {
          participants: [],
          judge: { model: "" },
          defaultFallbacks: [],
          webPolicy: "optional",
          retryPolicy: DEFAULT_MODEL_RETRY_POLICY,
          toolPolicy: { bash: "sandboxed" },
          monitorDefault: false,
          confirmBeforeRun: true,
        };
        ctx.ui.notify("Creating new Pi Fusion configuration...", "info");
      }

      // Get available models from Pi
      const available = await ctx.modelRegistry.getAvailable();
      const modelList = available.map((m) => `${m.provider}/${m.id}`);

      if (modelList.length === 0) {
        ctx.ui.notify("No models available. Configure API keys in Pi first.", "error");
        return;
      }

      const BACK = "← Back";
      const CANCEL = "Cancel without saving";
      const cancelConfig = () => {
        ctx.ui.notify("Pi Fusion configuration cancelled. No changes were saved.", "info");
      };
      const navOptions = (options: string[], canBack = true) => [
        ...(canBack ? [BACK] : []),
        ...options,
        CANCEL,
      ];
      const isCancel = (choice: string | undefined) => choice === undefined || choice === CANCEL;
      const isBack = (choice: string | undefined) => choice === BACK;
      const clampParticipantCount = (value: number) => Math.max(2, Math.min(8, value));

      type ConfigStep = "count" | "participants" | "judge" | "fallbacks" | "webPolicy" | "webBackend" | "bash" | "monitor" | "confirm" | "review";
      const steps: ConfigStep[] = ["count", "participants", "judge", "fallbacks", "webPolicy", "webBackend", "bash", "monitor", "confirm", "review"];
      let stepIndex = 0;
      let participantCount = clampParticipantCount(config.participants.length || 2);
      let draft: GlobalFusionConfig = {
        ...config,
        participants: config.participants.map((p) => ({ ...p })),
        judge: { ...config.judge },
        defaultFallbacks: [...config.defaultFallbacks],
        retryPolicy: config.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY,
        toolPolicy: { bash: config.toolPolicy?.bash ?? "sandboxed" },
        monitorDefault: config.monitorDefault,
        confirmBeforeRun: config.confirmBeforeRun,
      };

      const goBack = () => {
        stepIndex = Math.max(0, stepIndex - 1);
      };
      const goNext = () => {
        stepIndex = Math.min(steps.length - 1, stepIndex + 1);
      };
      const stepTitle = (title: string) => `Pi Fusion config ${stepIndex + 1}/${steps.length}: ${title}`;

      type ManualMcpResult =
        | { action: "ok"; backend?: GlobalFusionConfig["webBackend"] }
        | { action: "back" }
        | { action: "cancel" };

      async function readAdvancedInput(label: string, placeholder: string): Promise<string | typeof BACK | typeof CANCEL> {
        const value = await ctx.ui.input(`${label}\n(type :back for previous field, :cancel to cancel)`, placeholder);
        if (value === undefined) return CANCEL;
        const trimmed = value.trim();
        if (trimmed === ":back") return BACK;
        if (trimmed === ":cancel") return CANCEL;
        return value;
      }

      async function configureManualMcpBackend(
        existing: GlobalFusionConfig["webBackend"] | undefined,
        policy: GlobalFusionConfig["webPolicy"],
      ): Promise<ManualMcpResult> {
        let subStep = 0;
        let searchServerName = existing?.searchServerName ?? existing?.serverName ?? "";
        let searchTool = existing?.searchTool ?? DEFAULT_MCP_WEB_BACKEND.searchTool ?? "web_search";
        let fetchServerName = existing?.fetchServerName ?? DEFAULT_MCP_WEB_BACKEND.fetchServerName ?? "web-reader";
        let fetchTool = existing?.fetchTool ?? DEFAULT_MCP_WEB_BACKEND.fetchTool ?? "web_fetch";
        let fallback = existing?.fetchFallback ?? "off";

        while (subStep < 5) {
          if (subStep === 0) {
            const value = await readAdvancedInput("Advanced MCP search server name", searchServerName);
            if (value === CANCEL) return { action: "cancel" };
            if (value === BACK) return { action: "back" };
            searchServerName = value.trim();
            if (!searchServerName) {
              if (policy === "required") {
                ctx.ui.notify("Evidence backend is required, but no MCP search server was provided.", "error");
                continue;
              }
              return { action: "ok", backend: undefined };
            }
            subStep++;
            continue;
          }

          if (subStep === 1) {
            const value = await readAdvancedInput("Advanced MCP search tool name", searchTool);
            if (value === CANCEL) return { action: "cancel" };
            if (value === BACK) {
              subStep--;
              continue;
            }
            searchTool = value.trim() || DEFAULT_MCP_WEB_BACKEND.searchTool || "web_search";
            subStep++;
            continue;
          }

          if (subStep === 2) {
            const value = await readAdvancedInput("Advanced MCP fetch/read server name", fetchServerName);
            if (value === CANCEL) return { action: "cancel" };
            if (value === BACK) {
              subStep--;
              continue;
            }
            fetchServerName = value.trim() || DEFAULT_MCP_WEB_BACKEND.fetchServerName || "web-reader";
            subStep++;
            continue;
          }

          if (subStep === 3) {
            const value = await readAdvancedInput("Advanced MCP fetch/read tool name", fetchTool);
            if (value === CANCEL) return { action: "cancel" };
            if (value === BACK) {
              subStep--;
              continue;
            }
            fetchTool = value.trim() || DEFAULT_MCP_WEB_BACKEND.fetchTool || "web_fetch";
            subStep++;
            continue;
          }

          const fallbackChoice = await ctx.ui.select("Local fetch fallback:", navOptions(["off", "hardened_scraper"]));
          if (isCancel(fallbackChoice)) return { action: "cancel" };
          if (isBack(fallbackChoice)) {
            subStep--;
            continue;
          }
          fallback = (fallbackChoice as "off" | "hardened_scraper") ?? "off";
          subStep++;
        }

        const isUnifiedSearch = searchServerName === "unified-search";
        return {
          action: "ok",
          backend: {
            type: "mcp",
            serverName: searchServerName,
            searchServerName,
            searchTool,
            fetchServerName,
            fetchTool,
            fetchFallback: fallback,
            hardenedScraperPath: existing?.hardenedScraperPath,
            ...(existing?.searchProvider ? { searchProvider: existing.searchProvider } : {}),
            ...(existing?.searchStrategy ? { searchStrategy: existing.searchStrategy } : isUnifiedSearch ? { searchStrategy: "prefer_minimax" as const } : {}),
            ...(existing?.statusTool ? { statusTool: existing.statusTool } : isUnifiedSearch ? { statusTool: "search_provider_status" } : {}),
            maxResults: existing?.maxResults ?? DEFAULT_MCP_WEB_BACKEND.maxResults,
          },
        };
      }

      while (true) {
        const step = steps[stepIndex];

        if (step === "count") {
          const choice = await ctx.ui.select(
            stepTitle(`How many participants? Current: ${participantCount}`),
            navOptions(["2", "3", "4", "5", "6", "7", "8"], false),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          participantCount = clampParticipantCount(Number(choice));
          draft.participants = draft.participants.slice(0, participantCount);
          goNext();
          continue;
        }

        if (step === "participants") {
          let participantIndex = 0;
          let wentBack = false;
          while (participantIndex < participantCount) {
            const current = draft.participants[participantIndex]?.model ?? modelList[0];
            const choice = await ctx.ui.select(
              stepTitle(`Select participant ${participantIndex + 1} model (current: ${current})`),
              navOptions(modelList),
            );
            if (isCancel(choice)) {
              cancelConfig();
              return;
            }
            if (isBack(choice)) {
              if (participantIndex === 0) {
                goBack();
                wentBack = true;
                break;
              }
              participantIndex--;
              continue;
            }
            draft.participants[participantIndex] = {
              ...(draft.participants[participantIndex] ?? {}),
              model: choice || current,
            };
            participantIndex++;
          }
          if (wentBack) continue;
          draft.participants = draft.participants.slice(0, participantCount);
          goNext();
          continue;
        }

        if (step === "judge") {
          const currentJudge = draft.judge.model || modelList[0];
          const choice = await ctx.ui.select(
            stepTitle(`Select judge model (current: ${currentJudge})`),
            navOptions(modelList),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          draft.judge = { ...draft.judge, model: choice || currentJudge };
          goNext();
          continue;
        }

        if (step === "fallbacks") {
          let wentBack = false;
          while (true) {
            const current = draft.defaultFallbacks.length > 0 ? draft.defaultFallbacks.join(" → ") : "none";
            const availableToAdd = modelList.filter((model) => !draft.defaultFallbacks.includes(model));
            const options = [
              draft.defaultFallbacks.length > 0 ? `Done (${draft.defaultFallbacks.length} fallback${draft.defaultFallbacks.length === 1 ? "" : "s"})` : "No default fallbacks",
              ...(draft.defaultFallbacks.length > 0 ? ["Remove last fallback", "Clear all fallbacks"] : []),
              ...availableToAdd,
            ];
            const choice = await ctx.ui.select(
              stepTitle(`Default fallback models, in order (current: ${current})`),
              navOptions(options),
            );
            if (isCancel(choice)) {
              cancelConfig();
              return;
            }
            if (isBack(choice)) {
              goBack();
              wentBack = true;
              break;
            }
            if (!choice || choice === "No default fallbacks" || choice.startsWith("Done")) break;
            if (choice === "Remove last fallback") {
              draft.defaultFallbacks.pop();
              continue;
            }
            if (choice === "Clear all fallbacks") {
              draft.defaultFallbacks = [];
              continue;
            }
            draft.defaultFallbacks.push(choice);
          }
          if (wentBack) continue;
          goNext();
          continue;
        }

        if (step === "webPolicy") {
          const choice = await ctx.ui.select(
            stepTitle(`Evidence/web policy (current: ${draft.webPolicy})`),
            navOptions(["optional", "required", "off"]),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          draft.webPolicy = (choice as GlobalFusionConfig["webPolicy"]) ?? "optional";
          if (draft.webPolicy === "off") draft.webBackend = undefined;
          goNext();
          continue;
        }

        if (step === "webBackend") {
          if (draft.webPolicy === "off") {
            draft.webBackend = undefined;
            goNext();
            continue;
          }

          const setupOptions = draft.webBackend
            ? ["Auto-detect at run time", "Keep existing explicit MCP backend", "Advanced/manual MCP setup"]
            : ["Auto-detect at run time", "Advanced/manual MCP setup"];
          const choice = await ctx.ui.select(
            stepTitle("Evidence backend setup"),
            navOptions(setupOptions),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          if (!choice || choice === "Auto-detect at run time") {
            draft.webBackend = undefined;
            goNext();
            continue;
          }
          if (choice === "Keep existing explicit MCP backend") {
            goNext();
            continue;
          }

          const manual = await configureManualMcpBackend(draft.webBackend, draft.webPolicy);
          if (manual.action === "cancel") {
            cancelConfig();
            return;
          }
          if (manual.action === "back") {
            goBack();
            continue;
          }
          draft.webBackend = manual.backend;
          goNext();
          continue;
        }

        if (step === "bash") {
          const choice = await ctx.ui.select(
            stepTitle(`Enable sandboxed bash tool for calculations? Current: ${draft.toolPolicy?.bash ?? "sandboxed"}`),
            navOptions(["sandboxed", "off"]),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          draft.toolPolicy = { bash: (choice as any) ?? "sandboxed" };
          goNext();
          continue;
        }

        if (step === "monitor") {
          const choice = await ctx.ui.select(
            stepTitle(`Enable cmux Fusion Monitor by default? Current: ${draft.monitorDefault ? "yes" : "no"}`),
            navOptions(["no", "yes"]),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          draft.monitorDefault = choice === "yes";
          goNext();
          continue;
        }

        if (step === "confirm") {
          const choice = await ctx.ui.select(
            stepTitle(`Show Run Preview before each run? Current: ${draft.confirmBeforeRun ? "yes" : "no"}`),
            navOptions(["yes", "no"]),
          );
          if (isCancel(choice)) {
            cancelConfig();
            return;
          }
          if (isBack(choice)) {
            goBack();
            continue;
          }
          draft.confirmBeforeRun = choice !== "no";
          goNext();
          continue;
        }

        const newConfig: GlobalFusionConfig = {
          participants: draft.participants,
          judge: draft.judge,
          defaultFallbacks: draft.defaultFallbacks,
          webPolicy: draft.webPolicy,
          ...(draft.webBackend ? { webBackend: draft.webBackend } : {}),
          retryPolicy: draft.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY,
          toolPolicy: draft.toolPolicy ?? { bash: "sandboxed" },
          monitorDefault: draft.monitorDefault,
          confirmBeforeRun: draft.confirmBeforeRun,
        };
        const summary = [
          "Pi Fusion configuration review",
          "",
          `Participants: ${newConfig.participants.map((p, i) => `P${i + 1}=${p.model}`).join(", ")}`,
          `Judge: ${newConfig.judge.model}`,
          `Default fallbacks: ${newConfig.defaultFallbacks.length > 0 ? newConfig.defaultFallbacks.join(" → ") : "none"}`,
          `Evidence policy: ${newConfig.webPolicy}`,
          `Evidence backend: ${newConfig.webBackend ? `${newConfig.webBackend.type}:search=${newConfig.webBackend.searchServerName ?? newConfig.webBackend.serverName}, fetch=${newConfig.webBackend.fetchServerName ?? "same/none"}` : "auto-detect at run time"}`,
          `Bash tool: ${newConfig.toolPolicy?.bash ?? "sandboxed"}`,
          `Monitor default: ${newConfig.monitorDefault ? "on" : "off"}`,
          `Run preview: ${newConfig.confirmBeforeRun ? "yes" : "no"}`,
          "",
          "Save this configuration?",
        ].join("\n");
        const choice = await ctx.ui.select(summary, [
          BACK,
          "Save configuration",
          "Start over from these values",
          CANCEL,
        ]);
        if (isCancel(choice)) {
          cancelConfig();
          return;
        }
        if (isBack(choice)) {
          goBack();
          continue;
        }
        if (choice === "Start over from these values") {
          config = newConfig;
          draft = {
            ...newConfig,
            participants: newConfig.participants.map((p) => ({ ...p })),
            judge: { ...newConfig.judge },
            defaultFallbacks: [...newConfig.defaultFallbacks],
            toolPolicy: { ...(newConfig.toolPolicy ?? { bash: "sandboxed" }) },
          };
          participantCount = clampParticipantCount(draft.participants.length || 2);
          stepIndex = 0;
          continue;
        }

        await configMgr.save(newConfig);
        ctx.ui.notify("Pi Fusion configuration saved.", "info");
        return;
      }
    },
  });

  // Register /pi-fusion-doctor command
  pi.registerCommand("pi-fusion-doctor", {
    description: "Diagnose Pi Fusion configuration and availability",
    handler: async (_args, ctx) => {
      const configMgr = new ConfigManager(getConfigDir());
      const lines: string[] = ["# Pi Fusion Doctor", ""];

      // Config exists?
      const exists = await configMgr.exists();
      lines.push(`Configuration: ${exists ? "✓ found" : "✗ not found"}`);

      if (!exists) {
        lines.push("");
        lines.push("Run /pi-fusion-config to create a configuration.");
        pi.sendMessage({
          customType: "pi-fusion-doctor",
          content: lines.join("\n"),
          display: true,
        });
        return;
      }

      // Load and validate
      let webBackend: WebBackend | undefined;
      try {
        const config = await configMgr.load();
        lines.push(`Participants: ${config.participants.length}`);
        lines.push(`Judge: ${config.judge.model}`);
        lines.push(`Default fallbacks: ${config.defaultFallbacks.length > 0 ? config.defaultFallbacks.join(", ") : "none"}`);
        lines.push(`Web policy: ${config.webPolicy}`);
        const retryPolicy = config.retryPolicy ?? DEFAULT_MODEL_RETRY_POLICY;
        lines.push(`Model retries: ${retryPolicy.maxRetries} max, ${retryPolicy.initialDelayMs}ms initial, ×${retryPolicy.backoffMultiplier}, ${retryPolicy.maxDelayMs}ms cap`);
        lines.push(`Bash tool: ${(config.toolPolicy?.bash ?? "sandboxed") === "sandboxed" ? "sandboxed" : "off"}`);
        lines.push(`Monitor default: ${config.monitorDefault ? "on" : "off"}`);
        lines.push(`Confirm before run: ${config.confirmBeforeRun ? "yes" : "no"}`);
        lines.push("");

        // Check model availability
        const available = await ctx.modelRegistry.getAvailable();
        const availableIds = new Set(available.map((m) => `${m.provider}/${m.id}`));

        lines.push("## Model Availability");

        for (let i = 0; i < config.participants.length; i++) {
          const p = config.participants[i];
          const ok = availableIds.has(p.model);
          lines.push(`P${i + 1}: ${ok ? "✓" : "✗"} ${p.model}`);
          if (p.fallbacks) {
            for (const f of p.fallbacks) {
              lines.push(`  fallback: ${availableIds.has(f) ? "✓" : "✗"} ${f}`);
            }
          }
        }

        const jOk = availableIds.has(config.judge.model);
        lines.push(`Judge: ${jOk ? "✓" : "✗"} ${config.judge.model}`);

        for (const f of config.defaultFallbacks) {
          lines.push(`Default fallback: ${availableIds.has(f) ? "✓" : "✗"} ${f}`);
        }

        // Web backend status
        lines.push("");
        lines.push(`## Web Backend`);
        if (config.webPolicy === "off") {
          lines.push(`Status: disabled by policy`);
        } else {
          const resolved = await resolveWebBackendFromConfig(config);
          webBackend = resolved.backend;
          lines.push(`Backend: ${resolved.label}`);
          if (resolved.message) lines.push(`Discovery: ${resolved.message}`);
          if (!webBackend) {
            lines.push(`Status: optional model-fusion mode; no web evidence tools will be exposed`);
          } else {
            const status = await webBackend.status();
            lines.push(`Status: ${status.ok ? "✓ available" : "✗ unavailable"}`);
            lines.push(`Tools: ${status.tools.length > 0 ? status.tools.join(", ") : "none"}`);
            lines.push(`Details: ${status.message}`);
          }
        }
      } catch (error) {
        lines.push(`Configuration error: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await webBackend?.close?.();
      }

      pi.sendMessage({
        customType: "pi-fusion-doctor",
        content: lines.join("\n"),
        display: true,
      });
    },
  });
}
