export interface FocusedExcerptOptions {
  maxChars?: number;
  windowChars?: number;
  maxSnippets?: number;
}

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_WINDOW_CHARS = 1_200;
const DEFAULT_MAX_SNIPPETS = 8;
const WEAK_SINGLE_WORD_ANCHORS = new Set([
  "about",
  "bazar",
  "birth",
  "care",
  "camp",
  "data",
  "funding",
  "health",
  "karen",
  "maternal",
  "refugee",
  "refugees",
  "report",
  "rohingya",
  "source",
  "study",
  "unfpa",
  "unhcr",
  "using",
  "women",
]);

const SIGNAL_PATTERN = /\b(?:20\d{2}|19\d{2}|anc\s*4\+?|anc4|sba|nmr|mmr|pph|c?emonc|rate|ratio|coverage|incidence|mortality|deaths?|births?|delivery|delivered|facility|attendance|visits?|postpartum|ha?emorrhage|midwi(?:fe|ves)|referral|transport|caesarean|cesarean|c-section|revenue|income|margin|debt|loan|price|impairment|shares|throughput|latency|benchmark|warranty|support)\b|%|per\s+(?:1,?000|100,?000)\b/gi;
const BOILERPLATE_PATTERN = /\b(?:main navigation|skip to main content|donate|cookie|privacy notice|subscribe|newsletter|share on|follow us|all rights reserved|related content|long list|pagination|footer menus|learn more footer)\b/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function termPattern(term: string, flags = "i"): RegExp {
  return new RegExp(escapeRegExp(term).replace(/\\\s\+/g, "\\s+"), flags);
}

function isWeakAnchor(term: string): boolean {
  const normalized = term.toLowerCase().replace(/[^a-z0-9+]+/g, " ").trim();
  if (!normalized || normalized.includes(" ")) return false;
  if (/^\d{4}$/.test(normalized)) return false;
  return WEAK_SINGLE_WORD_ANCHORS.has(normalized);
}

function weightedTermCoverage(window: string, terms: string[]): number {
  return terms.reduce((score, term) => {
    if (!termPattern(term).test(window)) return score;
    if (term.includes(" ")) return score + 1.4;
    if (isWeakAnchor(term)) return score + 0.25;
    return score + 1;
  }, 0);
}

function countMatches(window: string, pattern: RegExp): number {
  const matches = window.match(pattern);
  return matches ? matches.length : 0;
}

function windowScore(window: string, terms: string[], termIndex: number): number {
  const numericDensity = Math.min(10, (window.match(/(?:[$€£¥]\s*)?\d[\d,.]*(?:\s*%|\s*(?:million|billion|thousand|bps|bp|per\s+(?:1,?000|100,?000)))?/gi) ?? []).length);
  const signalDensity = Math.min(14, countMatches(window, SIGNAL_PATTERN));
  const boilerplatePenalty = Math.min(18, countMatches(window, BOILERPLATE_PATTERN) * 3);
  const emptyMetricPenalty = numericDensity === 0 && signalDensity < 2 ? 10 : 0;
  return weightedTermCoverage(window, terms) * 8 + numericDensity * 5 + signalDensity * 2 - boilerplatePenalty - emptyMetricPenalty - termIndex * 0.05;
}

export function focusTermsFromText(focus: string | undefined): string[] {
  const raw = String(focus ?? "").trim();
  if (!raw) return [];

  const quoted = [...raw.matchAll(/["“”']([^"“”']{3,80})["“”']/g)].map((m) => m[1]);
  const phrases = raw
    .split(/[;\n]|,\s+(?=[A-Z0-9$])/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 4 && part.length <= 100);
  const words = raw
    .split(/[^A-Za-z0-9$%.+\-]+/)
    .map((word) => word.trim())
    .filter((word) => word.length >= 4 && !/^(what|when|where|which|with|from|that|this|have|does|were|their|about|using|calculate|analysis|source|sources|value|values)$/i.test(word));

  const seen = new Set<string>();
  const result: string[] = [];
  for (const term of [...quoted, ...phrases, ...words]) {
    const normalized = term.replace(/\s+/g, " ").trim();
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }
  return result.slice(0, 32);
}

export function extractFocusedExcerpt(text: string, focus?: string, options: FocusedExcerptOptions = {}): string {
  const source = String(text ?? "");
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const hasFocus = Boolean(String(focus ?? "").trim());
  if (source.length <= maxChars && !hasFocus) return source;

  const terms = focusTermsFromText(focus);
  if (!terms.length) {
    const head = source.slice(0, Math.floor(maxChars * 0.7));
    const tail = source.slice(-Math.floor(maxChars * 0.25));
    return `${head}\n\n[... omitted ${source.length - head.length - tail.length} chars; use web_fetch with a focus query to retrieve targeted excerpts ...]\n\n${tail}`;
  }

  const windowChars = options.windowChars ?? DEFAULT_WINDOW_CHARS;
  const maxSnippets = options.maxSnippets ?? DEFAULT_MAX_SNIPPETS;
  const candidates: Array<{ start: number; end: number; term: string; score: number }> = [];
  const scoringTerms = terms.slice(0, 48);

  for (let termIndex = 0; termIndex < terms.length; termIndex++) {
    const term = terms[termIndex];
    if (isWeakAnchor(term)) continue;
    const pattern = termPattern(term, "gi");
    let matchesForTerm = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const start = Math.max(0, match.index - windowChars);
      const end = Math.min(source.length, match.index + match[0].length + windowChars);
      const window = source.slice(start, end);
      candidates.push({ start, end, term, score: windowScore(window, scoringTerms, termIndex) });
      matchesForTerm++;
      if (matchesForTerm >= 80) break;
    }
  }

  candidates.sort((a, b) => b.score - a.score || a.start - b.start);
  const snippets: Array<{ start: number; end: number; term: string; score: number }> = [];
  for (const candidate of candidates) {
    if (snippets.some((snippet) => Math.max(snippet.start, candidate.start) < Math.min(snippet.end, candidate.end))) continue;
    snippets.push(candidate);
    if (snippets.length >= maxSnippets) break;
  }

  if (!snippets.length) {
    if (source.length <= maxChars) return source;
    const head = source.slice(0, Math.floor(maxChars * 0.55));
    const tail = source.slice(-Math.floor(maxChars * 0.25));
    return `${head}\n\n[... omitted ${source.length - head.length - tail.length} chars; no exact focus terms found: ${terms.slice(0, 10).join(", ")} ...]\n\n${tail}`;
  }

  const render = (selected: typeof snippets, clippedBodyChars?: number): string => {
    const ordered = [...selected].sort((a, b) => a.start - b.start);
    const parts: string[] = [
      `[focused excerpts for: ${terms.slice(0, 12).join(", ")}]`,
      `[source length: ${source.length} chars; returning ${ordered.length} targeted snippets]`,
    ];
    for (const snippet of ordered) {
      const body = source.slice(snippet.start, snippet.end);
      const clippedBody = clippedBodyChars && body.length > clippedBodyChars
        ? `${body.slice(0, clippedBodyChars)}\n[excerpt truncated]`
        : body;
      parts.push(`\n--- excerpt around "${snippet.term}" at char ${snippet.start}-${snippet.end} ---\n${clippedBody}`);
    }
    return parts.join("\n");
  };

  const joined = render(snippets);
  if (joined.length <= maxChars) return joined;

  const selectedByScore = [...snippets].sort((a, b) => b.score - a.score || a.start - b.start);
  const kept: typeof snippets = [];
  for (const candidate of selectedByScore) {
    const trial = render([...kept, candidate]);
    if (trial.length <= maxChars) kept.push(candidate);
  }
  if (kept.length) return render(kept);

  const best = selectedByScore[0];
  const headerReserve = 260;
  const clippedBodyChars = Math.max(400, maxChars - headerReserve);
  return render([best], clippedBodyChars);
}
