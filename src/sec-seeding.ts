import type { EvidenceEntry, FusionObligation, ObligationPlan } from "./types.js";
import { extractFocusedExcerpt } from "./text-excerpt.js";
import { secHtmlTablesToMarkdown, secHtmlToReadableText } from "./web.js";

export interface SecSeedOptions {
  maxFilings?: number;
  maxCharsPerFiling?: number;
  maxReportFiles?: number;
  userAgent?: string;
}

interface CompanyTickerEntry {
  cik_str: number;
  ticker: string;
  title: string;
}

interface SecFilingCandidate {
  form: string;
  filingDate: string;
  reportDate?: string;
  accessionNumber: string;
  primaryDocument: string;
  url: string;
  selectionScore?: number;
}

interface SecDateTarget {
  year: number;
  quarter?: number;
  form?: "10-Q" | "10-K";
}

const DEFAULT_USER_AGENT = "Pi-Fusion/0.1 (https://github.com/aa2246740/pi-fusion; aa2246740@users.noreply.github.com)";

function defaultUserAgent(): string {
  return process.env.PI_FUSION_SEC_USER_AGENT?.trim() || DEFAULT_USER_AGENT;
}

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function normalizeCompanyName(value: string): string {
  return value
    .toLowerCase()
    .replace(/\b(incorporated|inc|corp|corporation|company|co|trust|reit|ltd|limited|plc|holdings|holding|group|the)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function companyNameCandidates(prompt: string, obligations?: ObligationPlan): string[] {
  const names: string[] = [];
  for (const obligation of obligations?.obligations ?? []) {
    for (const entity of obligation.entities ?? []) {
      if (/fund|portfolio|segment|property|road|loan|debt|margin|impairment/i.test(entity)) continue;
      names.push(entity);
    }
  }

  const quoted = [...prompt.matchAll(/["“”']([^"“”']{3,80})["“”']/g)].map((match) => match[1]);
  names.push(...quoted);

  const titleCase = [...prompt.matchAll(/\b([A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){0,5})\b/g)].map((match) => match[1]);
  names.push(...titleCase.filter((name) => /Realty|REIT|Trust|Inc|Corp|Corporation|Company|Holdings|Group/i.test(name)));

  const seen = new Set<string>();
  return names
    .map((name) => name.replace(/'s\b/i, "").trim())
    .filter((name) => name.length >= 3)
    .filter((name) => {
      const key = normalizeCompanyName(name);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function promptLooksSecRelevant(prompt: string, obligations?: ObligationPlan): boolean {
  const promptText = prompt.toLowerCase();
  if (/\b(10-k|10-q|sec|edgar|filing|filings|form 10|annual report|quarterly report|operating margin|segment|term loan|impairment|debt|sofr|reit|portfolio)\b/.test(promptText)) return true;

  const obligationText = JSON.stringify(obligations ?? {}).toLowerCase();
  // Obligation planning may generically suggest "official filings" for product
  // or vendor descriptions. Do not let that alone trigger SEC seeding; require
  // finance/SEC-specific terms from the plan.
  if (/\b(10-k|10-q|sec|edgar|form 10|annual report|quarterly report|operating margin|term loan|impairment|sofr|reit)\b/.test(obligationText)) return true;

  const text = `${promptText}\n${obligationText}`;
  // Product-comparison and procurement prompts often mention purchase price as a
  // TCO input. Treat it as SEC-relevant only when the surrounding prompt is about
  // corporate transactions or financing rather than buying a product.
  return /\bpurchase price\b/.test(text) && /\b(acquisition|acquire|acquired|assumed debt|debt assumption|consolidation|controlling interest|portfolio)\b/.test(text);
}

async function fetchJson<T>(url: string, signal?: AbortSignal, userAgent = DEFAULT_USER_AGENT): Promise<T> {
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": userAgent,
      "accept": "application/json,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`SEC request failed ${response.status}: ${url}`);
  return await response.json() as T;
}

async function fetchText(url: string, signal?: AbortSignal, userAgent = DEFAULT_USER_AGENT): Promise<string> {
  const response = await fetch(url, {
    signal,
    headers: {
      "user-agent": userAgent,
      "accept": "text/html,text/plain,*/*",
    },
  });
  if (!response.ok) throw new Error(`SEC request failed ${response.status}: ${url}`);
  return await response.text();
}

function industryDisambiguationScore(entryTitle: string, prompt: string): number {
  const title = entryTitle.toLowerCase();
  const text = prompt.toLowerCase();
  let score = 0;

  if (/\b(real estate|reit|property|properties|retail center|shopping center|mortgage|lease|leasing|portfolio)\b/.test(text)) {
    if (/\b(realty|real estate|reit|properties|property|trust)\b/.test(title)) score += 45;
    if (/\b(pharma|pharmaceutical|therapeutics|biotech|biosciences|drug|medicine)\b/.test(title)) score -= 35;
  }
  if (/\b(pharma|pharmaceutical|therapeutics|biotech|clinical|drug|medicine|fda)\b/.test(text)) {
    if (/\b(pharma|pharmaceutical|therapeutics|biotech|biosciences|drug)\b/.test(title)) score += 45;
  }
  if (/\b(bank|banking|bancorp|deposit|loan portfolio|credit union)\b/.test(text)) {
    if (/\b(bank|bancorp|financial|credit)\b/.test(title)) score += 35;
  }
  if (/\b(oil|gas|energy|drilling|pipeline|utility|utilities|renewable)\b/.test(text)) {
    if (/\b(energy|oil|gas|pipeline|utility|utilities|resources)\b/.test(title)) score += 35;
  }

  return score;
}

function chooseCompany(entries: CompanyTickerEntry[], prompt: string, obligations?: ObligationPlan): CompanyTickerEntry | undefined {
  const candidates = companyNameCandidates(prompt, obligations).map((name) => ({ raw: name, normalized: normalizeCompanyName(name) }));
  if (!candidates.length) return undefined;
  const fullPrompt = `${prompt}\n${JSON.stringify(obligations ?? {})}`;

  let best: { entry: CompanyTickerEntry; score: number } | undefined;
  for (const entry of entries) {
    const title = normalizeCompanyName(entry.title);
    const ticker = entry.ticker.toLowerCase();
    let score = industryDisambiguationScore(entry.title, fullPrompt);
    for (const candidate of candidates) {
      if (!candidate.normalized) continue;
      if (title === candidate.normalized) score += 100;
      else if (title.includes(candidate.normalized) || candidate.normalized.includes(title)) score += Math.min(80, 20 + candidate.normalized.length);
      if (ticker === candidate.raw.toLowerCase()) score += 100;
    }
    if (!best || score > best.score) best = { entry, score };
  }
  return best && best.score >= 25 ? best.entry : undefined;
}

function focusForObligations(prompt: string, obligations?: ObligationPlan): string {
  const terms = new Set<string>();
  for (const obligation of obligations?.obligations ?? []) {
    terms.add(obligation.description);
    for (const entity of obligation.entities ?? []) terms.add(entity);
    for (const evidence of obligation.expectedEvidence ?? []) terms.add(evidence);
  }
  terms.add(prompt);
  return [...terms].join("; ").slice(0, 4_000);
}

interface FilingReportCandidate {
  shortName: string;
  longName: string;
  htmlFileName: string;
  score: number;
}

function decodeXml(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ")
    .trim();
}

function reportScore(name: string, focus: string): number {
  const text = `${name}\n${focus}`.toLowerCase();
  const report = name.toLowerCase();
  let score = 0;
  if (/condensed consolidated statements? of operations|consolidated statements? of operations/.test(report)) score += 16;
  if (/statements? of changes in (shareholders'? )?equity/.test(report)) score += 14;
  if (/segment|reportable segment/.test(report)) score += 12;
  if (/segment reporting.*tables?/.test(report)) score += 18;
  if (/debt|loan|credit|borrowing|mortgage|note payable/.test(report)) score += 12;
  if (/summary of consolidated indebtedness|unsecured notes payable|unsecured line of credit|term loan|scheduled principal repayments/.test(report)) score += 18;
  if (/impair|held for sale|fair value/.test(report)) score += 10;
  if (/nonrecurring basis|assets? held for sale|property dispositions?|reduced holding period|shortened holding period/.test(report)) score += 20;
  if (/acquisition|business combination|purchase|consolidation/.test(report)) score += 10;
  if (/equity|stockholder|common share|atm|forward sale/.test(report)) score += 8;
  if (/shareholders'? equity.*additional information|noncontrolling interests/.test(report)) score += 16;
  if (/revenue|operating income|income statement|operations/.test(report)) score += 7;
  if (/real estate|property|portfolio|investment management/.test(report)) score += 6;
  for (const token of focus.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 5)) {
    if (report.includes(token)) score += 1;
  }
  if (/additional information/.test(report) && !/summary/.test(report)) score -= 4;
  if (/parenthetical|document and entity|cover|signature|exhibit|calculation of filing fee/i.test(report)) score -= 8;
  return score;
}

function buildSecEvidenceContent(
  html: string,
  focus: string,
  options: { maxChars: number; windowChars: number; maxSnippets: number; maxTables: number; maxTableChars: number },
): string {
  const tables = secHtmlTablesToMarkdown(html, options.maxTables)?.slice(0, options.maxTableChars);
  const readableText = secHtmlToReadableText(html);
  const excerpt = extractFocusedExcerpt(readableText, focus, {
    maxChars: options.maxChars,
    windowChars: options.windowChars,
    maxSnippets: options.maxSnippets,
  });

  if (tables && excerpt.trim()) {
    return `${tables}\n\nFocused SEC text excerpts:\n${excerpt}`;
  }
  return tables || excerpt;
}

function secDateTargets(prompt: string, obligations?: ObligationPlan): SecDateTarget[] {
  const text = `${prompt}\n${JSON.stringify(obligations ?? {})}`;
  const targets: SecDateTarget[] = [];

  const add = (target: SecDateTarget) => {
    if (target.year < 2000 || target.year > 2100) return;
    if (targets.some((existing) => existing.year === target.year && existing.quarter === target.quarter && existing.form === target.form)) return;
    targets.push(target);
  };

  for (const match of text.matchAll(/\bQ([1-4])\s*(?:FY\s*)?(20\d{2})\b/gi)) {
    add({ quarter: Number(match[1]), year: Number(match[2]), form: "10-Q" });
  }
  for (const match of text.matchAll(/\b(20\d{2})\s*Q([1-4])\b/gi)) {
    add({ year: Number(match[1]), quarter: Number(match[2]), form: "10-Q" });
  }
  for (const match of text.matchAll(/\b(20\d{2})\s*(?:form\s*)?10-?K\b/gi)) {
    add({ year: Number(match[1]), form: "10-K" });
  }
  for (const match of text.matchAll(/\b(?:form\s*)?10-?K\s*(?:for|in|FY)?\s*(20\d{2})\b/gi)) {
    add({ year: Number(match[1]), form: "10-K" });
  }
  for (const match of text.matchAll(/\b(20\d{2})\s*(?:form\s*)?10-?Q\b/gi)) {
    add({ year: Number(match[1]), form: "10-Q" });
  }
  for (const match of text.matchAll(/\b(?:form\s*)?10-?Q\s*(?:for|in|FY)?\s*(20\d{2})\b/gi)) {
    add({ year: Number(match[1]), form: "10-Q" });
  }
  for (const match of text.matchAll(/\b(20\d{2})\b/g)) {
    add({ year: Number(match[1]) });
  }

  return targets.slice(0, 12);
}

function quarterEnd(year: number, quarter: number): string | undefined {
  if (quarter === 1) return `${year}-03-31`;
  if (quarter === 2) return `${year}-06-30`;
  if (quarter === 3) return `${year}-09-30`;
  if (quarter === 4) return `${year}-12-31`;
  return undefined;
}

function compactDate(value?: string): string {
  return String(value ?? "").replace(/[^0-9]/g, "");
}

function filingSelectionScore(filing: SecFilingCandidate, targets: SecDateTarget[], index: number): number {
  let score = Math.max(0, 1000 - index);
  const reportYear = Number(filing.reportDate?.slice(0, 4));
  const filingYear = Number(filing.filingDate?.slice(0, 4));
  const docDate = compactDate(filing.primaryDocument);

  for (const target of targets) {
    if (target.form && filing.form !== target.form) continue;
    if (target.quarter) {
      const end = quarterEnd(target.year, target.quarter);
      if (filing.form === "10-Q") score += 25;
      if (filing.reportDate === end) score += 5000;
      if (end && docDate.includes(compactDate(end))) score += 3500;
      if (reportYear === target.year) score += 700;
      continue;
    }

    if (target.form === "10-K") {
      if (filing.form === "10-K") score += 700;
      if (reportYear === target.year) score += 4500;
      if (filingYear === target.year + 1) score += 1800;
      if (docDate.includes(`${target.year}1231`)) score += 3000;
      continue;
    }

    if (target.form === "10-Q") {
      if (filing.form === "10-Q") score += 500;
      if (reportYear === target.year) score += 2500;
      if (filingYear === target.year) score += 900;
      if (docDate.includes(String(target.year))) score += 1000;
      continue;
    }

    if (reportYear === target.year) score += 1800;
    if (filingYear === target.year) score += 700;
    if (filing.form === "10-K" && filingYear === target.year + 1) score += 500;
    if (docDate.includes(String(target.year))) score += 900;
  }

  return score;
}

function parseFilingSummaryReports(xml: string, focus: string, limit: number): FilingReportCandidate[] {
  const reports: FilingReportCandidate[] = [];
  for (const match of xml.matchAll(/<Report\b[\s\S]*?<\/Report>/gi)) {
    const block = match[0];
    const shortName = decodeXml(block.match(/<ShortName>([\s\S]*?)<\/ShortName>/i)?.[1] ?? "");
    const longName = decodeXml(block.match(/<LongName>([\s\S]*?)<\/LongName>/i)?.[1] ?? "");
    const htmlFileName = decodeXml(block.match(/<HtmlFileName>([\s\S]*?)<\/HtmlFileName>/i)?.[1] ?? "");
    if (!htmlFileName || !/\.html?$/i.test(htmlFileName)) continue;
    const score = reportScore(`${shortName} ${longName}`, focus);
    if (score <= 0) continue;
    reports.push({ shortName, longName, htmlFileName, score });
  }
  reports.sort((a, b) => b.score - a.score || a.htmlFileName.localeCompare(b.htmlFileName));
  return reports.slice(0, limit);
}

function filingCandidates(submissions: any, cik: number, maxFilings: number, targets: SecDateTarget[] = []): SecFilingCandidate[] {
  const recent = submissions?.filings?.recent;
  if (!recent) return [];
  const forms: string[] = recent.form ?? [];
  const dates: string[] = recent.filingDate ?? [];
  const reportDates: string[] = recent.reportDate ?? [];
  const accessions: string[] = recent.accessionNumber ?? [];
  const docs: string[] = recent.primaryDocument ?? [];
  const cikNoZeros = String(cik);
  const candidates: SecFilingCandidate[] = [];
  for (let i = 0; i < forms.length; i++) {
    const form = forms[i];
    if (form !== "10-Q" && form !== "10-K" && form !== "8-K") continue;
    const accessionNumber = accessions[i];
    const primaryDocument = docs[i];
    if (!accessionNumber || !primaryDocument) continue;
    const accessionCompact = accessionNumber.replace(/-/g, "");
    const candidate: SecFilingCandidate = {
      form,
      filingDate: dates[i],
      reportDate: reportDates[i],
      accessionNumber,
      primaryDocument,
      url: `https://www.sec.gov/Archives/edgar/data/${cikNoZeros}/${accessionCompact}/${primaryDocument}`,
    };
    candidate.selectionScore = filingSelectionScore(candidate, targets, i);
    candidates.push(candidate);
  }
  candidates.sort((a, b) => (b.selectionScore ?? 0) - (a.selectionScore ?? 0) || b.filingDate.localeCompare(a.filingDate));
  return candidates.slice(0, maxFilings);
}

export async function seedSecEvidenceFromPrompt(
  prompt: string,
  obligations: ObligationPlan | undefined,
  options: SecSeedOptions & { signal?: AbortSignal } = {},
): Promise<EvidenceEntry[]> {
  if (!promptLooksSecRelevant(prompt, obligations)) return [];

  const maxFilings = options.maxFilings ?? 8;
  const maxCharsPerFiling = options.maxCharsPerFiling ?? 16_000;
  const maxReportFiles = options.maxReportFiles ?? 24;
  const userAgent = options.userAgent ?? defaultUserAgent();

  const entries = await fetchJson<Record<string, CompanyTickerEntry>>(
    "https://www.sec.gov/files/company_tickers.json",
    options.signal,
    userAgent,
  );
  const company = chooseCompany(Object.values(entries), prompt, obligations);
  if (!company) return [];

  const cikPadded = String(company.cik_str).padStart(10, "0");
  const submissions = await fetchJson<any>(
    `https://data.sec.gov/submissions/CIK${cikPadded}.json`,
    options.signal,
    userAgent,
  );

  const focus = focusForObligations(prompt, obligations);
  const targets = secDateTargets(prompt, obligations);
  const filings = filingCandidates(submissions, company.cik_str, maxFilings, targets);
  const evidence: EvidenceEntry[] = [];

  evidence.push({
    id: `sec-company-${stableHash(`${company.cik_str}:${company.ticker}`)}`,
    source: "web_fetch",
    url: `https://data.sec.gov/submissions/CIK${cikPadded}.json`,
    title: `SEC submissions for ${company.title} (${company.ticker})`,
    snippet: `Matched company ${company.title} (${company.ticker}), CIK ${company.cik_str}. Recent filings selected: ${filings.map((f) => `${f.form} ${f.filingDate} ${f.accessionNumber}`).join("; ")}`,
    fullContent: JSON.stringify({ company, filings }, null, 2),
    participantSlotIndex: -1,
    fetchedAt: Date.now(),
  });

  let reportFilesAdded = 0;
  for (const filing of filings) {
    try {
      const text = await fetchText(filing.url, options.signal, userAgent);
      const excerpt = buildSecEvidenceContent(text, focus, {
        maxChars: maxCharsPerFiling,
        windowChars: 1_600,
        maxSnippets: 10,
        maxTables: 12,
        maxTableChars: 48_000,
      });
      evidence.push({
        id: `sec-filing-${stableHash(filing.url)}`,
        source: "web_fetch",
        url: filing.url,
        title: `${company.title} ${filing.form} filed ${filing.filingDate}`,
        snippet: excerpt.slice(0, 2_500),
        fullContent: excerpt,
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      });

      if ((filing.form === "10-Q" || filing.form === "10-K") && reportFilesAdded < maxReportFiles) {
        try {
          const baseUrl = filing.url.slice(0, filing.url.lastIndexOf("/") + 1);
          const summaryXml = await fetchText(`${baseUrl}FilingSummary.xml`, options.signal, userAgent);
          const reports = parseFilingSummaryReports(summaryXml, focus, Math.min(6, maxReportFiles - reportFilesAdded));
          for (const report of reports) {
            const reportUrl = `${baseUrl}${report.htmlFileName}`;
            const reportText = await fetchText(reportUrl, options.signal, userAgent);
            const reportFocus = `${focus}; ${report.shortName}; ${report.longName}`;
            const reportExcerpt = buildSecEvidenceContent(reportText, reportFocus, {
              maxChars: 12_000,
              windowChars: 1_000,
              maxSnippets: 6,
              maxTables: 6,
              maxTableChars: 24_000,
            });
            evidence.push({
              id: `sec-report-${stableHash(reportUrl)}`,
              source: "web_fetch",
              url: reportUrl,
              title: `${company.title} ${filing.form} ${report.shortName || report.longName} filed ${filing.filingDate}`,
              snippet: reportExcerpt.slice(0, 4_500),
              fullContent: reportExcerpt,
              participantSlotIndex: -1,
              fetchedAt: Date.now(),
            });
            reportFilesAdded++;
            if (reportFilesAdded >= maxReportFiles) break;
          }
        } catch {
          // Interactive report files are opportunistic; main filing evidence remains available.
        }
      }
    } catch (error) {
      evidence.push({
        id: `sec-filing-error-${stableHash(filing.url)}`,
        source: "web_fetch",
        url: filing.url,
        title: `${company.title} ${filing.form} filed ${filing.filingDate} fetch error`,
        snippet: error instanceof Error ? error.message : String(error),
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      });
    }
  }

  return evidence;
}
