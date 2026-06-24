import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { createJiti } from "jiti";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

export type WebBackendKind = "mcp";
export type UnifiedSearchProvider = "auto" | "glm" | "minimax";
export type UnifiedSearchStrategy = "fallback" | "prefer_glm" | "prefer_minimax";
export type WebFetchFallback = "off" | "hardened_scraper";

export interface WebSearchResult {
  title: string;
  url?: string;
  snippet: string;
  date?: string;
  provider?: string;
  raw?: unknown;
}

export interface WebFetchResult {
  url: string;
  title?: string;
  text: string;
  metadata?: Record<string, unknown>;
  links?: unknown;
  raw?: unknown;
}

export interface WebBackendStatus {
  ok: boolean;
  backend: string;
  message: string;
  tools: string[];
}

export interface WebBackend {
  readonly name: string;
  readonly supportsSearch: boolean;
  readonly supportsFetch: boolean;
  status(): Promise<WebBackendStatus>;
  search(query: string, options?: { maxResults?: number; signal?: AbortSignal }): Promise<WebSearchResult[]>;
  fetch?(url: string, options?: { signal?: AbortSignal }): Promise<WebFetchResult>;
  close?(): Promise<void>;
}

export interface McpWebBackendConfig {
  type: "mcp";
  /** Backward-compatible alias for searchServerName. */
  serverName: string;
  /** MCP server that exposes the configured search tool. Defaults to serverName when omitted. */
  searchServerName?: string;
  /** MCP server that exposes the configured fetch/read tool. */
  fetchServerName?: string;
  searchTool?: string;
  fetchTool?: string;
  statusTool?: string;
  /** Local fallback for web_fetch when the MCP reader is unavailable, quota-limited, or fails. */
  fetchFallback?: WebFetchFallback;
  /** Optional path to the pi-scraper-hardened extension root or web-scrape tool file. */
  hardenedScraperPath?: string;
  searchProvider?: UnifiedSearchProvider;
  searchStrategy?: UnifiedSearchStrategy;
  maxResults?: number;
  configPaths?: string[];
}

interface McpServerDefinition {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  type?: string;
  lifecycle?: string;
}

interface McpConfigFile {
  mcpServers?: Record<string, McpServerDefinition>;
  servers?: Record<string, McpServerDefinition>;
}

interface ConnectedMcpServer {
  client: Client;
  sourcePath: string;
  tools?: string[];
}

export const DEFAULT_MCP_WEB_BACKEND: McpWebBackendConfig = {
  type: "mcp",
  serverName: "web-search",
  searchServerName: "web-search",
  fetchServerName: "web-reader",
  searchTool: "web_search",
  fetchTool: "web_fetch",
  fetchFallback: "off",
  maxResults: 5,
};

export function defaultMcpConfigPaths(): string[] {
  const home = os.homedir();
  return [
    path.join(home, ".config", "mcp", "mcp.json"),
    path.join(home, ".pi", "agent", "mcp.json"),
  ];
}

function expandHome(filePath: string): string {
  if (filePath === "~") return os.homedir();
  if (filePath.startsWith("~/")) return path.join(os.homedir(), filePath.slice(2));
  return filePath;
}

async function readJsonIfExists(filePath: string): Promise<McpConfigFile | undefined> {
  try {
    const raw = await fs.readFile(expandHome(filePath), "utf-8");
    return JSON.parse(raw) as McpConfigFile;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function loadMcpServerDefinition(
  serverName: string,
  configPaths: string[],
): Promise<{ definition: McpServerDefinition; sourcePath: string }> {
  for (const cfgPath of configPaths) {
    const config = await readJsonIfExists(cfgPath);
    const definition = config?.mcpServers?.[serverName] ?? config?.servers?.[serverName];
    if (definition) return { definition, sourcePath: cfgPath };
  }
  throw new Error(`MCP server '${serverName}' not found in ${configPaths.join(", ")}`);
}

function cleanEnv(env: NodeJS.ProcessEnv | Record<string, string | undefined>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string") result[key] = value;
  }
  return result;
}

function textContentPart(part: unknown): string | undefined {
  if (!part || typeof part !== "object") return undefined;
  const record = part as Record<string, unknown>;
  if (record.type === "text" && typeof record.text === "string") return record.text;
  return undefined;
}

export function extractMcpText(result: unknown): string {
  if (!result || typeof result !== "object") return String(result ?? "");
  const record = result as Record<string, unknown>;

  const contentText = Array.isArray(record.content)
    ? record.content.map(textContentPart).filter((p): p is string => Boolean(p)).join("\n")
    : "";

  const structured = record.structuredContent;
  const structuredText = structured && typeof structured === "object"
    ? (structured as Record<string, unknown>).text
    : undefined;

  if (contentText.trim()) return contentText;
  if (typeof structuredText === "string") return structuredText;
  return JSON.stringify(result);
}

function parseProvider(text: string): string | undefined {
  const match = text.match(/^\s*\[provider:\s*([^\]]+)\]/i);
  return match?.[1]?.trim();
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function parseNestedJson(text: string): unknown | undefined {
  let value: unknown = text.trim();
  for (let i = 0; i < 3; i++) {
    if (typeof value !== "string") return value;
    const parsed = tryParseJson(value.trim());
    if (parsed === undefined) break;
    value = parsed;
  }
  return typeof value === "string" ? undefined : value;
}

function parseJsonPayload(text: string): unknown | undefined {
  const nested = parseNestedJson(text);
  if (nested !== undefined) return nested;

  const firstBrace = text.indexOf("{");
  const firstBracket = text.indexOf("[");
  const jsonStartCandidates = [firstBrace, firstBracket].filter((n) => n >= 0);
  if (jsonStartCandidates.length === 0) return undefined;
  const start = Math.min(...jsonStartCandidates);
  const jsonText = text.slice(start).trim();
  const direct = parseNestedJson(jsonText);
  if (direct !== undefined) return direct;

  // Some MCP outputs prepend provider metadata, then include exactly one JSON
  // object. Try the first object span before falling back to plain text.
  if (firstBrace >= 0) {
    const lastBrace = text.lastIndexOf("}");
    if (lastBrace > firstBrace) {
      const objectSpan = text.slice(firstBrace, lastBrace + 1);
      const parsedObject = parseNestedJson(objectSpan);
      if (parsedObject !== undefined) return parsedObject;
    }
  }
  return undefined;
}

function normalizeSearchItem(item: unknown, provider?: string): WebSearchResult | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as Record<string, unknown>;
  const title = typeof record.title === "string" ? record.title : undefined;
  const url = typeof record.link === "string"
    ? record.link
    : typeof record.url === "string"
      ? record.url
      : undefined;
  const snippet = typeof record.snippet === "string"
    ? record.snippet
    : typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : undefined;
  if (!title && !snippet && !url) return undefined;
  return {
    title: title ?? url ?? "Search result",
    url,
    snippet: snippet ?? "",
    date: typeof record.date === "string" ? record.date : undefined,
    provider,
    raw: item,
  };
}

function stableHashForWeb(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

const execFile = promisify(execFileCallback);
const DIRECT_PDF_USER_AGENT = "Pi Fusion evidence PDF fetch contact: local-user";
const DIRECT_SEC_USER_AGENT = "Pi Fusion evidence SEC fetch contact: local-user";

function decodeSecHtmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ");
}

export function secHtmlToReadableText(value: string): string {
  return decodeSecHtmlEntities(String(value ?? "")
    .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\/(?:tr|p|div|table|thead|tbody|tfoot|h[1-6])>/gi, "\n")
    .replace(/<\/(?:td|th)>/gi, " | ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\r/g, "\n"))
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function isSecInteractiveReportUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return /(^|\.)sec\.gov$/i.test(parsed.hostname)
      && /\/Archives\/edgar\/data\/\d+\/\d+\/R\d+\.html?$/i.test(parsed.pathname);
  } catch {
    return false;
  }
}

function secTitleFromHtml(html: string): string | undefined {
  const rawTitle = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]
    ?? html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1];
  const title = rawTitle ? secHtmlToReadableText(rawTitle) : "";
  return title || undefined;
}

async function fetchSecInteractiveReportDirect(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": DIRECT_SEC_USER_AGENT,
      "accept": "text/html,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`SEC direct fetch failed ${response.status}: ${url}`);
  const html = await response.text();
  const text = secHtmlToReadableText(html);
  if (!text.trim() || isLikelyFetchFailureText(text)) throw new Error(`SEC direct fetch returned no readable text: ${url}`);
  return {
    url: response.url || url,
    title: secTitleFromHtml(html),
    text,
    metadata: { fallback: "sec_direct_html" },
  };
}

export function isLikelyPdfFetchUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    const pathname = parsed.pathname.toLowerCase();
    if (/\.pdf$/.test(pathname)) return true;
    if (/\bdata\.unhcr\.org$/i.test(parsed.hostname) && /\/documents\/download\/\d+\b/i.test(pathname)) return true;
    if (/\breliefweb\.int$/i.test(parsed.hostname) && /\/attachments\//i.test(pathname)) return true;
    return false;
  } catch {
    return false;
  }
}

export function dataUnhcrDownloadUrlForDetails(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (!/\bdata\.unhcr\.org$/i.test(parsed.hostname)) return undefined;
    const match = parsed.pathname.match(/\/documents\/details\/(\d+)\b/i);
    if (!match) return undefined;
    const language = parsed.pathname.match(/^\/([a-z]{2})\//i)?.[1] ?? "en";
    return `${parsed.origin}/${language}/documents/download/${match[1]}`;
  } catch {
    return undefined;
  }
}

async function fetchPdfTextDirect(url: string, signal?: AbortSignal): Promise<WebFetchResult> {
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": DIRECT_PDF_USER_AGENT,
      "accept": "application/pdf,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`PDF direct fetch failed ${response.status}: ${url}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  const contentType = response.headers.get("content-type") ?? "";
  if (!/^%PDF/.test(buffer.subarray(0, 8).toString("latin1")) && !/application\/pdf/i.test(contentType)) {
    throw new Error(`PDF direct fetch did not return a PDF: ${url}`);
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-pdf-"));
  const pdfPath = path.join(tmpDir, "source.pdf");
  try {
    await fs.writeFile(pdfPath, buffer);
    const { stdout } = await execFile("pdftotext", ["-layout", "-nopgbrk", pdfPath, "-"], {
      timeout: 30_000,
      maxBuffer: 8 * 1024 * 1024,
    });
    const text = stdout.replace(/\u0000/g, "").replace(/\n{4,}/g, "\n\n\n").trim();
    if (!text) throw new Error(`pdftotext produced no text for ${url}`);
    return {
      url: response.url || url,
      title: path.basename(new URL(response.url || url).pathname) || undefined,
      text,
      metadata: { fallback: "direct_pdf_pdftotext", contentType },
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function appendDataUnhcrAttachedPdfText(fetched: WebFetchResult, requestedUrl: string, signal?: AbortSignal): Promise<WebFetchResult> {
  const detailsDownloadUrl = dataUnhcrDownloadUrlForDetails(fetched.url || requestedUrl);
  const linkedDownloadPath = fetched.text.match(/https?:\/\/data\.unhcr\.org\/[a-z]{2}\/documents\/download\/\d+\b/i)?.[0]
    ?? fetched.text.match(/\/[a-z]{2}\/documents\/download\/\d+\b/i)?.[0];
  const linkedDownloadUrl = linkedDownloadPath
    ? new URL(linkedDownloadPath, fetched.url || requestedUrl).toString()
    : undefined;
  const downloadUrl = detailsDownloadUrl ?? linkedDownloadUrl;
  if (!downloadUrl) return fetched;

  try {
    const pdf = await fetchPdfTextDirect(downloadUrl, signal);
    return {
      ...fetched,
      text: `${fetched.text}\n\n--- Attached PDF text from ${pdf.url} ---\n${pdf.text}`,
      metadata: {
        ...(fetched.metadata ?? {}),
        attachedPdfUrl: pdf.url,
        attachedPdfTextExtractor: pdf.metadata?.fallback,
      },
    };
  } catch {
    return fetched;
  }
}

function hostnameOf(url: string | undefined): string {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return url.toLowerCase();
  }
}

function searchResultQualityScore(result: WebSearchResult): number {
  const host = hostnameOf(result.url);
  let score = 0;
  if (/\.(gov|edu)$/.test(host)) score += 6;
  if (/(dell|hp|lenovo|lumion|autodesk|nvidia|microsoft|apple|samsung|bosch|lg|cat|caterpillar|komatsu|volvo|thermofisher|helmerinc|cdc|nsf|energy)\./.test(host)) score += 5;
  if (/(unhcr|data\.unhcr|msf|doctorswithoutborders|unfpa|who|reliefweb|ncbi\.nlm\.nih|pubmed\.ncbi\.nlm\.nih|thelancet|bmj|plos|biomedcentral|frontiersin|tropmedres|ox\.ac|shoklo-unit)\./.test(host)) score += 5;
  if (/(notebookcheck|storagereview|techpowerup|tomshardware|anandtech|laptopmag|choice\.com\.au)/.test(host)) score += 3;
  if (/(weibo|bilibili|douyin|toutiao|zhihu|sohu|qq\.com|163\.com|sina\.com\.cn|baike\.baidu|csdn|jd\.com|ebay)/.test(host)) score -= 5;
  if (/blog|forum|social|video/.test(host)) score -= 2;
  if (!result.snippet.trim()) score -= 1;
  return score;
}

export function rankSearchResults(results: WebSearchResult[]): WebSearchResult[] {
  return [...results].sort((a, b) => searchResultQualityScore(b) - searchResultQualityScore(a));
}

function queryLooksPublicHealth(query: string): boolean {
  return /\b(maternal|neonatal|antenatal|birth|obstetric|midwi(?:fe|ves)|mortality|refugee|camp|humanitarian|unhcr|unfpa|msf|m[ée]decins sans fronti[èe]res|health information system|public health|skilled birth|postpartum hemorrhage)\b/i.test(query);
}

function queryContextQualityScore(result: WebSearchResult, query: string): number {
  let score = searchResultQualityScore(result);
  if (queryLooksPublicHealth(query)) {
    const host = hostnameOf(result.url);
    const text = `${result.title}\n${result.snippet}\n${result.url ?? ""}`.toLowerCase();
    if (/(microsoft|msdn|technet|docs\.microsoft|ibm|github|thermofisher|benchsci|oracle|sap|autodesk|nvidia|lenovo|dell|hp)\./.test(host)) score -= 10;
    if (/\b(report builder|reportingservices|windows drivers|cloud pak|watson|software|api reference|developer documentation)\b/.test(text)) score -= 6;
  }
  return score;
}

function queryTerms(query: string): string[] {
  const stop = /^(what|when|where|which|with|from|that|this|have|does|were|their|about|using|into|than|then|them|they|there|and|the|for|are|was|data|source|sources)$/i;
  const terms = query
    .split(/[^A-Za-z0-9]+/)
    .map((term) => term.trim().toLowerCase())
    .filter((term) => term.length >= 4 && !stop.test(term));
  return [...new Set(terms)].slice(0, 16);
}

function queryRelevanceScore(result: WebSearchResult, terms: string[]): number {
  if (!terms.length) return 0;
  const title = result.title.toLowerCase();
  const snippet = result.snippet.toLowerCase();
  const url = (result.url ?? "").toLowerCase();
  let score = 0;
  for (const term of terms) {
    if (title.includes(term)) score += 3;
    if (snippet.includes(term)) score += 1;
    if (url.includes(term)) score += 1;
  }
  return score;
}

export function rankSearchResultsForQuery(results: WebSearchResult[], query: string): WebSearchResult[] {
  const terms = queryTerms(query);
  return [...results].sort((a, b) => {
    const aQuality = queryContextQualityScore(a, query);
    const bQuality = queryContextQualityScore(b, query);
    const delta = (queryRelevanceScore(b, terms) + bQuality) - (queryRelevanceScore(a, terms) + aQuality);
    return delta !== 0 ? delta : bQuality - aQuality;
  });
}

export function parseSearchResultsFromMcpText(text: string, maxResults = 5): WebSearchResult[] {
  const provider = parseProvider(text);
  const payload = parseJsonPayload(text);

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const organic = Array.isArray(record.organic)
      ? record.organic
      : Array.isArray(record.results)
        ? record.results
        : Array.isArray(record.items)
          ? record.items
          : undefined;
    if (organic) {
      return rankSearchResults(organic
        .map((item) => normalizeSearchItem(item, provider))
        .filter((item): item is WebSearchResult => Boolean(item)))
        .slice(0, maxResults);
    }
  }

  const trimmed = text.trim();
  if (!trimmed) return [];
  return [{ title: "Search result", snippet: trimmed.slice(0, 4000), provider }];
}

export function parseFetchResultFromMcpText(text: string, requestedUrl: string): WebFetchResult {
  const payload = parseJsonPayload(text);
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const content = typeof record.content === "string"
      ? record.content
      : typeof record.text === "string"
        ? record.text
        : typeof record.markdown === "string"
          ? record.markdown
          : "";
    return {
      url: typeof record.url === "string" ? record.url : requestedUrl,
      title: typeof record.title === "string" ? record.title : undefined,
      text: content || JSON.stringify(payload, null, 2),
      metadata: record.metadata && typeof record.metadata === "object"
        ? record.metadata as Record<string, unknown>
        : undefined,
      links: record.links ?? (record.external && typeof record.external === "object" ? (record.external as Record<string, unknown>).links : undefined),
      raw: payload,
    };
  }

  return {
    url: requestedUrl,
    text: text.trim(),
  };
}

function mcpToolExists(tools: string[], configured: string, aliases: string[] = []): string | undefined {
  if (tools.includes(configured)) return configured;
  return aliases.find((alias) => tools.includes(alias));
}

function requestInitFor(definition: McpServerDefinition): RequestInit | undefined {
  if (!definition.headers) return undefined;
  return { headers: definition.headers };
}

export interface DiscoveredMcpServerTools {
  serverName: string;
  sourcePath: string;
  tools: string[];
  error?: string;
}

export interface DiscoveredMcpWebBackend {
  config: McpWebBackendConfig;
  search: DiscoveredMcpServerTools & { tool: string };
  fetch: DiscoveredMcpServerTools & { tool: string };
  message: string;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function listToolsForMcpServer(serverName: string, configPaths: string[], timeoutMs: number): Promise<DiscoveredMcpServerTools> {
  let client: Client | undefined;
  try {
    const { definition, sourcePath } = await loadMcpServerDefinition(serverName, configPaths);
    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (definition.command) {
      const env = cleanEnv({ ...process.env, ...(definition.env ?? {}) });
      transport = new StdioClientTransport({ command: definition.command, args: definition.args ?? [], env });
    } else if (definition.url) {
      transport = new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: requestInitFor(definition),
      });
    } else {
      throw new Error(`MCP server '${serverName}' in ${sourcePath} must define either command or url`);
    }

    client = new Client({ name: "pi-fusion-discovery", version: "0.1.0" });
    await withTimeout(client.connect(transport), timeoutMs, `connect ${serverName}`);
    const toolList = await withTimeout(client.listTools(), timeoutMs, `list tools for ${serverName}`);
    return { serverName, sourcePath, tools: toolList.tools.map((tool) => tool.name) };
  } catch (error) {
    return { serverName, sourcePath: "unknown", tools: [], error: error instanceof Error ? error.message : String(error) };
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        // Best-effort discovery only.
      }
    }
  }
}

export async function discoverMcpServerTools(
  configPaths: string[] = defaultMcpConfigPaths(),
  options: { timeoutMs?: number; evidenceOnly?: boolean } = {},
): Promise<DiscoveredMcpServerTools[]> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const cfgPath of configPaths) {
    const config = await readJsonIfExists(cfgPath);
    const servers = config?.mcpServers ?? config?.servers ?? {};
    for (const serverName of Object.keys(servers)) {
      if (seen.has(serverName)) continue;
      seen.add(serverName);
      candidates.push(serverName);
    }
  }

  const evidenceName = /web|search|reader|fetch|scrape|crawl|tavily|exa|firecrawl|brave|serp|perplexity|unified/i;
  const ordered = options.evidenceOnly
    ? candidates.filter((name) => evidenceName.test(name))
    : [
      ...candidates.filter((name) => evidenceName.test(name)),
      ...candidates.filter((name) => !evidenceName.test(name)),
    ];

  const results: DiscoveredMcpServerTools[] = [];
  for (const serverName of ordered) {
    results.push(await listToolsForMcpServer(serverName, configPaths, timeoutMs));
  }
  return results;
}

function scoreSearchTool(tool: string): number {
  const name = tool.toLowerCase();
  if (name === "web_search" || name.endsWith("_web_search")) return 100;
  if (/exa|tavily|brave|serp|perplexity/.test(name)) return 90;
  if (name.includes("web") && name.includes("search")) return 90;
  if (name.includes("search") && !name.includes("doc") && !name.includes("repo")) return 75;
  if (name.includes("query")) return 45;
  return 0;
}

function scoreSearchServer(serverName: string): number {
  const name = serverName.toLowerCase();
  if (name === "unified-search") return 60;
  if (name.includes("web") && name.includes("search")) return 55;
  if (/tavily|exa|firecrawl|brave|serp|perplexity/.test(name)) return 50;
  if (name.includes("search")) return 30;
  if (/zread|doc|repo/.test(name)) return -50;
  return 0;
}

function scoreFetchServer(serverName: string): number {
  const name = serverName.toLowerCase();
  if (name === "web-reader") return 60;
  if (name.includes("web") && (name.includes("reader") || name.includes("read"))) return 55;
  if (/fetch|scrape|crawl|firecrawl|reader/.test(name)) return 40;
  if (/zread|doc|repo/.test(name)) return -50;
  return 0;
}

function scoreFetchTool(tool: string): number {
  const name = tool.toLowerCase();
  if (name === "web_fetch" || name.endsWith("_web_fetch")) return 100;
  if (name === "webreader" || name.endsWith("webreader")) return 95;
  if (name.includes("fetch")) return 90;
  if (name.includes("reader") || name.includes("read")) return 80;
  if (name.includes("scrape") || name.includes("crawl")) return 70;
  if (name.includes("url")) return 40;
  return 0;
}

function bestScoredTool(tools: string[], scorer: (tool: string) => number): string | undefined {
  return tools
    .map((tool) => ({ tool, score: scorer(tool) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score || a.tool.localeCompare(b.tool))[0]?.tool;
}

export async function discoverMcpWebBackend(
  configPaths: string[] = defaultMcpConfigPaths(),
  options: { timeoutMs?: number } = {},
): Promise<DiscoveredMcpWebBackend | undefined> {
  const servers = await discoverMcpServerTools(configPaths, { ...options, evidenceOnly: true });
  const usable = servers.filter((server) => !server.error && server.tools.length > 0);
  const searchCandidates = usable
    .map((server) => ({ server, tool: bestScoredTool(server.tools, scoreSearchTool), score: scoreSearchServer(server.serverName) }))
    .filter((item): item is { server: DiscoveredMcpServerTools; tool: string; score: number } => Boolean(item.tool))
    .map((item) => ({ ...item, score: item.score + scoreSearchTool(item.tool) }))
    .sort((a, b) => b.score - a.score || a.server.serverName.localeCompare(b.server.serverName));
  const fetchCandidates = usable
    .map((server) => ({ server, tool: bestScoredTool(server.tools, scoreFetchTool), score: scoreFetchServer(server.serverName) }))
    .filter((item): item is { server: DiscoveredMcpServerTools; tool: string; score: number } => Boolean(item.tool))
    .map((item) => ({ ...item, score: item.score + scoreFetchTool(item.tool) }))
    .sort((a, b) => b.score - a.score || a.server.serverName.localeCompare(b.server.serverName));

  if (searchCandidates.length === 0 || fetchCandidates.length === 0) return undefined;

  const search = searchCandidates[0];
  const fetch = fetchCandidates[0];
  const isUnifiedSearch = search.server.serverName === "unified-search";
  const statusTool = search.server.tools.includes("search_provider_status") ? "search_provider_status" : undefined;
  const config: McpWebBackendConfig = {
    type: "mcp",
    serverName: search.server.serverName,
    searchServerName: search.server.serverName,
    searchTool: search.tool,
    fetchServerName: fetch.server.serverName,
    fetchTool: fetch.tool,
    fetchFallback: "off",
    ...(statusTool ? { statusTool } : {}),
    ...(isUnifiedSearch ? { searchStrategy: "prefer_minimax" as const } : {}),
    maxResults: DEFAULT_MCP_WEB_BACKEND.maxResults,
    configPaths,
  };

  return {
    config,
    search: { ...search.server, tool: search.tool },
    fetch: { ...fetch.server, tool: fetch.tool },
    message: `auto-detected search ${search.server.serverName}/${search.tool} and fetch ${fetch.server.serverName}/${fetch.tool}`,
  };
}

interface HardenedScraperToolResult {
  content?: Array<{ type: string; text?: string }>;
  details?: Record<string, unknown>;
  isError?: boolean;
}

interface HardenedScraperTool {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal,
  ) => Promise<HardenedScraperToolResult>;
}

function defaultHardenedScraperPaths(): string[] {
  const home = os.homedir();
  return [
    process.env.PI_FUSION_HARDENED_SCRAPER_PATH,
    path.join(home, "Documents", "cmux", "hardened-web", "pi-scraper-hardened"),
    path.join(home, "Documents", "hardened-web", "pi-scraper-hardened"),
  ].filter((p): p is string => typeof p === "string" && p.trim().length > 0);
}

function hardenedScraperToolEntry(candidate: string): string {
  const expanded = expandHome(candidate);
  if (expanded.endsWith(".ts") || expanded.endsWith(".js")) return expanded;
  return path.join(expanded, "src", "tools", "web-scrape.ts");
}

async function existingHardenedScraperEntry(configuredPath?: string): Promise<string | undefined> {
  const candidates = configuredPath ? [configuredPath, ...defaultHardenedScraperPaths()] : defaultHardenedScraperPaths();
  const seen = new Set<string>();
  for (const candidate of candidates) {
    const entry = hardenedScraperToolEntry(candidate);
    if (seen.has(entry)) continue;
    seen.add(entry);
    try {
      await fs.access(entry);
      return entry;
    } catch {
      // Try the next configured/default path.
    }
  }
  return undefined;
}

function textFromToolResult(result: HardenedScraperToolResult): string {
  return Array.isArray(result.content)
    ? result.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
    : "";
}

function isLikelyFetchFailureText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return true;
  return /^(fetch failed|scrape failed|web_fetch error|error:|\{\s*"error"\s*:)/i.test(trimmed) ||
    /\b(quota exceeded|insufficient quota|insufficient balance|rate limit|unauthorized|forbidden)\b/i.test(trimmed.slice(0, 1000));
}

export class McpWebBackend implements WebBackend {
  readonly name: string;
  readonly supportsSearch = true;
  readonly supportsFetch = true;

  private config: McpWebBackendConfig;
  private connections = new Map<string, ConnectedMcpServer>();
  private hardenedScraperTool?: HardenedScraperTool;
  private hardenedScraperEntry?: string;

  constructor(config: Partial<McpWebBackendConfig> = {}) {
    const merged: McpWebBackendConfig = { ...DEFAULT_MCP_WEB_BACKEND, ...config, type: "mcp" };
    merged.searchServerName ??= merged.serverName;
    merged.fetchServerName ??= DEFAULT_MCP_WEB_BACKEND.fetchServerName;
    this.config = merged;
    this.name = `mcp-web-evidence(search=${this.searchServerName}, fetch=${this.fetchServerName})`;
  }

  private get searchServerName(): string {
    return this.config.searchServerName ?? this.config.serverName;
  }

  private get fetchServerName(): string {
    return this.config.fetchServerName ?? DEFAULT_MCP_WEB_BACKEND.fetchServerName!;
  }

  private get fetchFallback(): WebFetchFallback {
    return this.config.fetchFallback ?? DEFAULT_MCP_WEB_BACKEND.fetchFallback ?? "off";
  }

  private async hardenedScraperStatus(): Promise<{ ok: boolean; entry?: string; message: string }> {
    if (this.fetchFallback !== "hardened_scraper") {
      return { ok: false, message: "hardened scraper fallback disabled" };
    }
    const entry = await existingHardenedScraperEntry(this.config.hardenedScraperPath);
    if (!entry) {
      return { ok: false, message: "pi-scraper-hardened not found" };
    }
    return { ok: true, entry, message: `hardened scraper available (${entry})` };
  }

  private async loadHardenedScraperTool(): Promise<HardenedScraperTool> {
    if (this.hardenedScraperTool) return this.hardenedScraperTool;
    const status = await this.hardenedScraperStatus();
    if (!status.ok || !status.entry) throw new Error(status.message);

    // pi-scraper-hardened is a Pi-native TypeScript extension. Use jiti here
    // rather than Node's strip-only TypeScript loader, because the scraper code
    // uses TS syntax such as parameter properties.
    const jiti = createJiti(import.meta.url, { moduleCache: true });
    const mod = await jiti.import(status.entry) as Record<string, unknown>;
    const tool = (mod.webScrapeTool ?? (typeof mod.createWebScrapeTool === "function" ? (mod.createWebScrapeTool as () => unknown)() : undefined)) as HardenedScraperTool | undefined;
    if (!tool || typeof tool.execute !== "function") {
      throw new Error(`pi-scraper-hardened web_scrape tool not found at ${status.entry}`);
    }
    this.hardenedScraperEntry = status.entry;
    this.hardenedScraperTool = tool;
    return tool;
  }

  private async fetchWithHardenedScraper(url: string, options: { signal?: AbortSignal } = {}, primaryError?: unknown): Promise<WebFetchResult> {
    const tool = await this.loadHardenedScraperTool();
    const controller = new AbortController();
    const signal = options.signal ?? controller.signal;
    const result = await tool.execute(
      `pi-fusion-fetch-${stableHashForWeb(url)}`,
      {
        url,
        mode: "auto",
        format: "markdown",
        timeoutSeconds: 45,
        maxChars: 25_000,
        onlyMainContent: true,
      },
      signal,
    );
    const details = result.details ?? {};
    const data = details.data && typeof details.data === "object" ? details.data as Record<string, unknown> : {};
    const text = typeof data.markdown === "string"
      ? data.markdown
      : typeof data.text === "string"
        ? data.text
        : typeof data.rawText === "string"
          ? data.rawText
          : textFromToolResult(result);

    if (result.isError || details.error || isLikelyFetchFailureText(text)) {
      const error = details.error && typeof details.error === "object"
        ? (details.error as Record<string, unknown>).message
        : undefined;
      throw new Error(`hardened scraper fetch failed: ${typeof error === "string" ? error : text.slice(0, 500)}`);
    }

    return {
      url: typeof details.finalUrl === "string" ? details.finalUrl : typeof details.url === "string" ? details.url : url,
      title: typeof data.title === "string" ? data.title : undefined,
      text,
      metadata: {
        fallback: "hardened_scraper",
        entry: this.hardenedScraperEntry,
        mode: typeof details.mode === "string" ? details.mode : undefined,
        responseId: typeof details.responseId === "string" ? details.responseId : undefined,
        primaryError: primaryError instanceof Error ? primaryError.message : primaryError ? String(primaryError) : undefined,
      },
      raw: result,
    };
  }

  private async connectServer(serverName: string): Promise<ConnectedMcpServer> {
    const existing = this.connections.get(serverName);
    if (existing) return existing;

    const configPaths = this.config.configPaths ?? defaultMcpConfigPaths();
    const { definition, sourcePath } = await loadMcpServerDefinition(serverName, configPaths);

    let transport: StdioClientTransport | StreamableHTTPClientTransport;
    if (definition.command) {
      const env = cleanEnv({ ...process.env, ...(definition.env ?? {}) });
      transport = new StdioClientTransport({
        command: definition.command,
        args: definition.args ?? [],
        env,
      });
    } else if (definition.url) {
      transport = new StreamableHTTPClientTransport(new URL(definition.url), {
        requestInit: requestInitFor(definition),
      });
    } else {
      throw new Error(`MCP server '${serverName}' in ${sourcePath} must define either command or url`);
    }

    const client = new Client({ name: "pi-fusion", version: "0.1.0" });
    await client.connect(transport);
    const connection = { client, sourcePath };
    this.connections.set(serverName, connection);
    return connection;
  }

  private async listTools(serverName: string): Promise<string[]> {
    const connection = await this.connectServer(serverName);
    if (!connection.tools) {
      const toolList = await connection.client.listTools();
      connection.tools = toolList.tools.map((tool) => tool.name);
    }
    return connection.tools;
  }

  async status(): Promise<WebBackendStatus> {
    const messages: string[] = [];
    const allTools: string[] = [];
    let ok = true;

    try {
      const searchTools = await this.listTools(this.searchServerName);
      allTools.push(...searchTools.map((tool) => `${this.searchServerName}:${tool}`));
      const searchTool = mcpToolExists(searchTools, this.config.searchTool ?? DEFAULT_MCP_WEB_BACKEND.searchTool!, [
        "unified_search_web_search",
        "webSearchPrime",
        "web_search_prime_web_search_prime",
      ]);
      if (searchTool) {
        messages.push(`search ok (${this.searchServerName}:${searchTool})`);
        this.config.searchTool = searchTool;
      } else {
        ok = false;
        messages.push(`search tool '${this.config.searchTool}' not found on ${this.searchServerName}`);
      }

      const statusTool = this.config.statusTool;
      if (statusTool && searchTools.includes(statusTool)) {
        try {
          const searchConnection = await this.connectServer(this.searchServerName);
          const statusResult = await searchConnection.client.callTool({ name: statusTool, arguments: {} });
          const statusText = extractMcpText(statusResult).trim();
          if (statusText) messages.push(`search provider status: ${statusText.slice(0, 500)}`);
        } catch (error) {
          messages.push(`search provider status unavailable: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    } catch (error) {
      ok = false;
      messages.push(`search unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    let mcpFetchOk = false;
    try {
      const fetchTools = await this.listTools(this.fetchServerName);
      allTools.push(...fetchTools.map((tool) => `${this.fetchServerName}:${tool}`));
      const fetchTool = mcpToolExists(fetchTools, this.config.fetchTool ?? DEFAULT_MCP_WEB_BACKEND.fetchTool!, [
        "web_fetch",
        "web_reader_webReader",
        "webReader",
      ]);
      if (fetchTool) {
        mcpFetchOk = true;
        messages.push(`fetch ok (${this.fetchServerName}:${fetchTool})`);
        this.config.fetchTool = fetchTool;
      } else {
        messages.push(`fetch tool '${this.config.fetchTool}' not found on ${this.fetchServerName}`);
      }
    } catch (error) {
      messages.push(`fetch unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const fallbackStatus = await this.hardenedScraperStatus();
    if (fallbackStatus.ok) {
      allTools.push("hardened-scraper:web_scrape");
      messages.push(`fetch fallback ok (${fallbackStatus.message})`);
    } else if (this.fetchFallback !== "off") {
      messages.push(`fetch fallback unavailable: ${fallbackStatus.message}`);
    }

    if (!mcpFetchOk && !fallbackStatus.ok) {
      ok = false;
    }

    return {
      ok,
      backend: this.name,
      message: messages.join("; "),
      tools: allTools,
    };
  }

  async search(query: string, options: { maxResults?: number; signal?: AbortSignal } = {}): Promise<WebSearchResult[]> {
    const trimmedQuery = query.trim();
    if (!trimmedQuery) throw new Error("web_search query must not be empty");
    if (options.signal?.aborted) throw new Error("web_search aborted before start");

    const searchTools = await this.listTools(this.searchServerName);
    const searchTool = mcpToolExists(searchTools, this.config.searchTool ?? DEFAULT_MCP_WEB_BACKEND.searchTool!, [
      "unified_search_web_search",
      "webSearchPrime",
      "web_search_prime_web_search_prime",
    ]);
    if (!searchTool) throw new Error(`web_search tool not found on ${this.searchServerName}`);
    this.config.searchTool = searchTool;

    const args: Record<string, unknown> = searchTool.includes("webSearchPrime") || searchTool.includes("web_search_prime")
      ? { search_query: trimmedQuery, content_size: "medium", location: "us" }
      : { query: trimmedQuery };
    if (this.config.searchProvider && this.config.searchProvider !== "auto" && "query" in args) {
      args.provider = this.config.searchProvider;
    }
    if (this.config.searchStrategy && "query" in args) {
      args.strategy = this.config.searchStrategy;
    }

    const connection = await this.connectServer(this.searchServerName);
    const result = await connection.client.callTool({ name: searchTool, arguments: args });
    const text = extractMcpText(result);

    if (/all search providers failed/i.test(text) || /not configured/i.test(text)) {
      throw new Error(text.trim().slice(0, 1000));
    }

    const maxResults = options.maxResults ?? this.config.maxResults ?? DEFAULT_MCP_WEB_BACKEND.maxResults ?? 5;
    return rankSearchResultsForQuery(parseSearchResultsFromMcpText(text, Math.max(maxResults * 3, maxResults)), trimmedQuery).slice(0, maxResults);
  }

  async fetch(url: string, options: { signal?: AbortSignal } = {}): Promise<WebFetchResult> {
    const trimmedUrl = url.trim();
    if (!trimmedUrl) throw new Error("web_fetch url must not be empty");
    if (options.signal?.aborted) throw new Error("web_fetch aborted before start");

    let primaryError: unknown;
    if (isSecInteractiveReportUrl(trimmedUrl)) {
      try {
        return await fetchSecInteractiveReportDirect(trimmedUrl, options.signal);
      } catch (error) {
        primaryError = error;
      }
    }
    if (isLikelyPdfFetchUrl(trimmedUrl)) {
      try {
        return await fetchPdfTextDirect(trimmedUrl, options.signal);
      } catch (error) {
        primaryError = primaryError ?? error;
      }
    }
    try {
      const fetchTools = await this.listTools(this.fetchServerName);
      const fetchTool = mcpToolExists(fetchTools, this.config.fetchTool ?? DEFAULT_MCP_WEB_BACKEND.fetchTool!, [
        "web_fetch",
        "web_reader_webReader",
        "webReader",
      ]);
      if (!fetchTool) throw new Error(`web_fetch tool not found on ${this.fetchServerName}`);
      this.config.fetchTool = fetchTool;

      const connection = await this.connectServer(this.fetchServerName);
      const result = await connection.client.callTool({
        name: fetchTool,
        arguments: {
          url: trimmedUrl,
          timeout: 30,
          return_format: "markdown",
          with_links_summary: false,
          with_images_summary: false,
        },
      });
      const text = extractMcpText(result);
      const fetched = parseFetchResultFromMcpText(text, trimmedUrl);
      if (isLikelyFetchFailureText(fetched.text)) {
        throw new Error(fetched.text.slice(0, 1000));
      }
      return await appendDataUnhcrAttachedPdfText(fetched, trimmedUrl, options.signal);
    } catch (error) {
      primaryError = primaryError ?? error;
      if (this.fetchFallback === "hardened_scraper") {
        return await this.fetchWithHardenedScraper(trimmedUrl, options, primaryError);
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    const connections = [...this.connections.values()];
    this.connections.clear();
    await Promise.all(connections.map(async (connection) => {
      try {
        await connection.client.close();
      } catch {
        // Ignore close failures; the MCP SDK may already have torn down stdio.
      }
    }));
  }
}

export function createMcpWebBackend(config?: Partial<McpWebBackendConfig>): McpWebBackend {
  return new McpWebBackend(config);
}
