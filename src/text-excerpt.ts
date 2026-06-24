export interface FocusedExcerptOptions {
  maxChars?: number;
  windowChars?: number;
  maxSnippets?: number;
}

const DEFAULT_MAX_CHARS = 12_000;
const DEFAULT_WINDOW_CHARS = 1_200;
const DEFAULT_MAX_SNIPPETS = 8;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    const pattern = new RegExp(escapeRegExp(term).replace(/\\\s\+/g, "\\s+"), "gi");
    let matchesForTerm = 0;
    for (const match of source.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const start = Math.max(0, match.index - windowChars);
      const end = Math.min(source.length, match.index + match[0].length + windowChars);
      const window = source.slice(start, end);
      const distinctTerms = scoringTerms.reduce((count, scoringTerm) => {
        const scoringPattern = new RegExp(escapeRegExp(scoringTerm).replace(/\\\s\+/g, "\\s+"), "i");
        return count + (scoringPattern.test(window) ? 1 : 0);
      }, 0);
      const numericDensity = Math.min(8, (window.match(/(?:[$€£¥]\s*)?\d[\d,.]*(?:\s*%|\s*(?:million|billion|thousand|bps|bp))?/gi) ?? []).length);
      candidates.push({ start, end, term, score: distinctTerms * 10 + numericDensity * 2 - termIndex * 0.05 });
      matchesForTerm++;
      if (matchesForTerm >= 20) break;
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

  snippets.sort((a, b) => a.start - b.start);
  const parts: string[] = [
    `[focused excerpts for: ${terms.slice(0, 12).join(", ")}]`,
    `[source length: ${source.length} chars; returning ${snippets.length} targeted snippets]`,
  ];
  for (const snippet of snippets) {
    parts.push(`\n--- excerpt around "${snippet.term}" at char ${snippet.start}-${snippet.end} ---\n${source.slice(snippet.start, snippet.end)}`);
  }

  const joined = parts.join("\n");
  if (joined.length <= maxChars) return joined;
  return `${joined.slice(0, maxChars)}\n\n[focused excerpts truncated at ${maxChars} chars]`;
}
