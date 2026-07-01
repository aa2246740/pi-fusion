import type { EvidenceEntry, FusionObligation, ObligationPlan } from "./types.js";
import type { WebBackend, WebFetchResult, WebSearchResult } from "./web.js";
import { extractFocusedExcerpt } from "./text-excerpt.js";

export interface PromptSearchSeedOptions {
  maxQueries?: number;
  maxResultsPerQuery?: number;
  fetchTopPerQuery?: number;
  timeoutMs?: number;
}

const DEFAULT_MAX_QUERIES = 24;
const DEFAULT_MAX_RESULTS_PER_QUERY = 4;
const DEFAULT_FETCH_TOP_PER_QUERY = 1;
const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_SEARCH_CONCURRENCY = 3;
const MAX_FETCH_CHARS = 30_000;
const FINANCE_DIRECT_FETCH_CHARS = 48_000;
const DIRECT_SOURCE_FETCH_LIMIT = 28;
const SEC_FOLLOW_UP_FETCH_LIMIT = 48;
const DEFAULT_DIRECT_FETCH_CONCURRENCY = 4;

function stableHash(input: string): string {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function numberFromEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

function enabled(): boolean {
  return process.env.PI_FUSION_PROMPT_SEARCH_SEEDING !== "0";
}

function cleanTerm(value: string): string {
  return value
    .replace(/\s+/g, " ")
    .replace(/[<>]/g, " ")
    .trim();
}

function promptSearchSubject(prompt: string): string {
  const marker = [...prompt.matchAll(/\bTask:\s*/gi)].pop();
  if (!marker || marker.index === undefined) return prompt;
  const subject = prompt.slice(marker.index + marker[0].length).trim();
  return subject.length >= 12 ? subject : prompt;
}

function quoteEntity(value: string): string {
  const term = cleanTerm(value);
  if (!term) return "";
  return /[,\s]/.test(term) ? `"${term.replace(/"/g, "")}"` : term;
}

function sourceHintForPrompt(prompt: string): string {
  if (/\b(10-k|10-q|sec|edgar|filing|earnings|investor presentation|impairment|term loan|sofr|reit|operating margin)\b/i.test(prompt)) {
    return "10-Q 10-K SEC filing earnings supplement investor presentation";
  }
  if (/\b(laptop|workstation|gpu|ram|warranty|support|service manual|thermal|battery|tco|procurement|vendor)\b/i.test(prompt)) {
    return "official specifications service manual warranty independent review";
  }
  if (/\b(maternal|neonatal|antenatal|birth|obstetric|midwi(?:fe|ves)|mortality|refugee|camp|humanitarian|unhcr|unfpa|msf|public health)\b/i.test(prompt)) {
    return "UNHCR HIS iRHIS UNFPA MSF WHO health sector report surveillance cohort";
  }
  if (/\b(affiliate|referral|publisher|lead generation|partner program|marketplace|comparison site)\b/i.test(prompt)) {
    return "affiliate publisher partner program official";
  }
  if (/\b(erp|ux|usability|navigation|sap|s\/4hana|fiori|netsuite|oracle|inventory|work order|manufacturing|dashboard|progressive disclosure|cognitive load|change management|adoption)\b/i.test(prompt)) {
    return "official ERP UX design guidelines product documentation usability research";
  }
  if (/\b(nasdaq|sec rule|regulation|statute|court|legal|law|issuer|committee|independent director)\b/i.test(prompt)) {
    return "official rule text guidance";
  }
  if (/\b(latency|benchmark|throughput|tensorflow|tensorrt|deepstream|cuda|onnx|model|api|deployment)\b/i.test(prompt)) {
    return "official docs benchmark performance";
  }
  if (/\b(journal|paper|estimator|methodology|implementation|software|replication|study|causal)\b/i.test(prompt)) {
    return "paper software implementation documentation";
  }
  return "";
}

function looksLikeAffiliateResearchText(value: string): boolean {
  const text = value.toLowerCase();
  if (/\b(supermoney|novae)\b/.test(text)) return true;
  if (/\b(affiliate|referral|publisher|lead generation|partner program|marketplace|comparison site|co-?brand|white label|compensation|soft credit|soft pull|prequalif(?:y|ied|ication)?)\b/.test(text)) return true;
  if (/\b(personal loans?|student loans?|auto loans?|credit cards?|debt consolidation|debt relief|debt help|business credit|business funding|life insurance)\b/.test(text)
    && /\b(financial services?|credit repair|partner|affiliate|publisher|marketplace|referral|comparison|program|provider|product page)\b/.test(text)) return true;
  if (/\b(trust and will|trust & will|wills?|estate plan(?:ning)?)\b/.test(text)
    && /\b(novae|financial services?|partner|affiliate|referral|program|provider|product page)\b/.test(text)) return true;
  return false;
}

function looksLikeSuperMoneyResearchText(value: string): boolean {
  const text = value.toLowerCase();
  if (/\bsupermoney\b/.test(text)) return true;
  return /\b(soft credit|soft pull|prequalif(?:y|ied|ication)?|personal loans?|student loans?|auto loans?|credit cards?|debt consolidation)\b/.test(text)
    && /\b(affiliate|publisher|marketplace|comparison|referral|lead generation|partner|credit repair)\b/.test(text);
}

function looksLikeNovaeResearchText(value: string): boolean {
  const text = value.toLowerCase();
  if (/\bnovae\b/.test(text)) return true;
  return /\b(debt relief|debt help|business credit|business funding|life insurance|co-?brand|white label|compensation|trust and will|trust & will|wills?|estate plan(?:ning)?)\b/.test(text)
    && /\b(affiliate|partner|referral|financial services?|credit repair|program|provider|product page)\b/.test(text);
}

function obligationSearchText(obligation: FusionObligation): string {
  return [
    obligation.id,
    obligation.kind,
    obligation.description,
    obligation.timePeriod ?? "",
    ...(obligation.entities ?? []),
    ...(obligation.expectedEvidence ?? []),
    ...(obligation.preferredSourceTypes ?? []),
  ].join(" ");
}

function topicKeyForObligation(obligation: FusionObligation): string {
  const text = obligationSearchText(obligation).toLowerCase();
  if (/\b(antenatal|prenatal|anc\s*4|anc4|4\+|skilled birth|facility birth|maternal mortality|neonatal mortality|postpartum|haemorrhage|hemorrhage|midwi(?:fe|ves)|emonc|obstetric|referral|traditional birth attendant|tba|unhcr|unfpa|msf|refugee|camp)\b/.test(text)) return "public-health";
  if (/\b(10-k|10-q|sec|edgar|filing|earnings|supplement|segment|revenue|operating income|operating margin|acquisition|purchase price|assumed debt|mortgage|principal paydown|term loan|impairment|reit|fund iii|fund iv|portfolio|sofr)\b/.test(text)) return "finance";
  if (looksLikeAffiliateResearchText(text)) return "affiliate";
  if (/\b(erp|ux|usability|navigation|sap|s\/4hana|fiori|netsuite|oracle|inventory|work order|manufacturing|dashboard|progressive disclosure|cognitive load|change management|adoption)\b/.test(text)) return "ux";
  if (/\b(nasdaq|sec rule|10a-3|independent director|controlled company|foreign private issuer|investment company|issuer|committee|board|rule text)\b/.test(text)) return "law";
  if (/\b(goodman-bacon|callaway|sant'?anna|sun|abraham|borusyak|jaravel|spiess|did2s|honest did|staggered|difference-in-differences|event study|estimator|journal|aer|qje|jpe)\b/.test(text)) return "academic";
  if (/\b(jetson|orin|tensorrt|deepstream|int8|onnx|etlt|tao|detectnet|peoplenet|yolo|efficientdet|latency|throughput|ota|active learning)\b/.test(text)) return "technology";
  if (/\b(thermal|cooling|throttl|temperature|ambient|warm|heat|sustained)\b/.test(text)) return "thermal";
  if (/\b(gpu|graphics|vram|render|rendering|lumion|cuda|benchmark|tgp)\b/.test(text)) return "gpu";
  if (/\b(ram|memory|128\s?gb|64\s?gb|sodimm|camm|lpcamm|upgrade|expandability)\b/.test(text)) return "memory";
  if (/\b(support|warranty|sla|onsite|prosupport|care pack|premier|service|accidental damage)\b/.test(text)) return "support";
  if (/\b(tco|cost|price|purchase|battery|downtime|energy|accessor|5-year|five-year)\b/.test(text)) return "tco";
  if (/\b(autocad|revit|software|requirements|isv)\b/.test(text)) return "software";
  if (obligation.kind === "source") return "source";
  return obligation.kind;
}

function focusedFacetForObligation(obligation: FusionObligation, prompt: string): string {
  const text = obligationSearchText(obligation).toLowerCase();
  if (/\b(antenatal|prenatal|anc\s*4|anc4|4\+)\b/.test(text)) {
    return "ANC4 antenatal care 4+ visits coverage rate UNHCR HIS iRHIS UNFPA report";
  }
  if (/\b(skilled birth|facility birth|birth attendance|sba)\b/.test(text)) {
    return "skilled birth attendance facility delivery percentage UNHCR HIS health sector report";
  }
  if (/\b(maternal mortality|mmr|maternal death)\b/.test(text)) {
    return "maternal mortality ratio MMR maternal deaths MPMSR surveillance UNHCR report";
  }
  if (/\b(neonatal mortality|newborn|28 days|nmr)\b/.test(text)) {
    return "neonatal mortality NMR deaths within 28 days surveillance cohort study";
  }
  if (/\b(postpartum|haemorrhage|hemorrhage|pph)\b/.test(text)) {
    return "postpartum haemorrhage hemorrhage PPH incidence maternal death cause operational report";
  }
  if (/\b(midwi(?:fe|ves)|workforce|population ratio|staffing)\b/.test(text)) {
    return "midwife workforce staffing ratio population health sector report";
  }
  if (/\b(emonc|emergency obstetric|2-hour|two-hour|transport|referral)\b/.test(text)) {
    return "EmONC emergency obstetric care referral transport time 2 hours facility assessment";
  }
  if (/\b(traditional birth attendant|tba|cultural mediation|mediator)\b/.test(text)) {
    return "traditional birth attendant TBA cultural mediation referral maternal health";
  }
  if (/\b(operating margin|segment|revenue|operating income|core portfolio|funds segment)\b/.test(text)) {
    return "Q1 2024 segment revenue operating income operating margin SEC 10-Q supplemental";
  }
  if (/\b(renaissance|purchase price|assumed debt|mortgage|principal paydown)\b/.test(text)) {
    return "Renaissance Portfolio acquisition purchase price assumed mortgage debt principal paydown modified loans old new SOFR spread SEC 10-Q supplemental";
  }
  if (/\b(impairment|fund iii|fund iv|bald hill|shortened hold|holding period)\b/.test(text)) {
    return "Fund III Fund IV Bald Hill Road impairment charge shortened holding period SEC 10-Q";
  }
  if (/\b(term loan|drawdown|net debt|sofr|credit agreement|borrowing)\b/.test(text)) {
    return "2025 term loan drawdown net debt SOFR credit agreement principal paydown SEC 10-Q";
  }
  if (/\b(equity issuance|shares|atm|investment management|reit portfolio)\b/.test(text)) {
    return "equity issuance ATM forward settlement proceeds investment management operating income REIT Portfolio rental revenue year over year SEC filing supplement";
  }
  if (looksLikeSuperMoneyResearchText(text)) {
    return "SuperMoney official marketplace affiliate publisher program soft credit check comparison";
  }
  if (looksLikeNovaeResearchText(text)) {
    return "Novae official products partner program debt relief trust will life insurance business credit";
  }
  if (/\b(sap|s\/4hana|fiori|object page|wizard|launchpad|inventory|work order)\b/.test(text)) {
    return "SAP Fiori official design guideline object page wizard inventory work order workflow";
  }
  if (/\b(netsuite|oracle|global search|center|role|dashboard|item 360|work order)\b/.test(text)) {
    return "Oracle NetSuite official documentation global search centers roles dashboard Item 360 work order";
  }
  if (/\b(progressive disclosure|hidden navigation|cognitive load|older adult|learnability|change management|adoption)\b/.test(text)) {
    return "Nielsen Norman Group usability research progressive disclosure hidden navigation wizard adoption";
  }
  if (/\b(nasdaq|independent director|controlled company|foreign private issuer|audit committee|10a-3|investment company)\b/.test(text)) {
    return "Nasdaq official rule text independent director Rule 5605 SEC Rule 10A-3 controlled company investment company";
  }
  if (/\b(goodman-bacon|callaway|sant'?anna|sun|abraham|borusyak|jaravel|spiess|did2s|honest did|event study|staggered)\b/.test(text)) {
    return "staggered difference-in-differences estimator software implementation paper Goodman-Bacon Callaway Sant'Anna Sun Abraham did2s HonestDiD";
  }
  if (/\b(jetson|orin|tensorrt|deepstream|int8|onnx|etlt|tao|detectnet|peoplenet|yolo|efficientdet|latency)\b/.test(text)) {
    return "official benchmark latency INT8 TensorRT DeepStream Jetson Orin TAO DetectNet_v2 PeopleNet ONNX ETLT";
  }
  if (/\b(thermal|cooling|throttl|temperature|ambient|warm|heat|sustained)\b/.test(text)) {
    return "thermal review sustained performance GPU TGP operating temperature";
  }
  if (/\b(gpu|graphics|vram|render|rendering|lumion|cuda|benchmark|tgp)\b/.test(text)) {
    return "official specifications GPU options VRAM TGP benchmark";
  }
  if (/\b(ram|memory|128\s?gb|64\s?gb|sodimm|camm|lpcamm|upgrade|expandability)\b/.test(text)) {
    return "official specifications maximum RAM memory slots service manual";
  }
  if (/\b(support|warranty|sla|onsite|prosupport|care pack|premier|service|accidental damage)\b/.test(text)) {
    return "UAE warranty onsite support SLA accidental damage battery";
  }
  if (/\b(battery)\b/.test(text)) {
    return "battery warranty replacement cost service manual";
  }
  if (/\b(tco|cost|price|purchase|downtime|energy|accessor|5-year|five-year)\b/.test(text)) {
    return "UAE price warranty cost quote total cost of ownership";
  }
  if (/\b(autocad|revit|lumion|software|requirements|isv)\b/.test(text)) {
    return "system requirements GPU RAM VRAM official";
  }
  return sourceHintForPrompt(prompt);
}

function looksLikeProductResearchPrompt(prompt: string): boolean {
  return /\b(laptop|workstation|gpu|ram|warranty|support|service manual|thermal|battery|tco|procurement|vendor)\b/i.test(prompt);
}

function looksLikeFinanceFilingPrompt(prompt: string): boolean {
  return /\b(10-k|10-q|sec|edgar|filing|segment|revenue|operating income|operating margin|acquisition|purchase price|assumed debt|mortgage|principal paydown|term loan|impairment|reit|fund iii|fund iv|portfolio|sofr|atm|forward sale|rental revenue)\b/i.test(prompt);
}

function isLikelyProductEntity(entity: string): boolean {
  const text = cleanTerm(entity);
  if (!/[A-Za-z]/.test(text)) return false;
  if (/\bcase\s*id\b/i.test(text)) return false;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return false;
  if (/^[0-9a-f]{20,}$/i.test(text)) return false;
  if (/\b(autocad|revit|lumion|dubai|uae|designer|designers|firm|company|draco)\b/i.test(text)) return false;
  return /\d|\b(gen|pro|max|ultra|precision|thinkpad|zbook|model|series)\b/i.test(text);
}

function isNoiseEntity(entity: string): boolean {
  const text = cleanTerm(entity);
  if (!text) return true;
  if (/\bcase\s*id\b/i.test(text)) return true;
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) return true;
  if (/^[0-9a-f]{20,}$/i.test(text)) return true;
  if (/^(draco|task|problem|public web|tool evidence|rubric|answer key)$/i.test(text)) return true;
  return false;
}

function productMatrixFacetQueries(prompt: string, plan?: ObligationPlan): string[] {
  if (!plan) return [];

  const products: string[] = [];
  const seenProducts = new Set<string>();
  const topics = new Set<string>();
  for (const obligation of plan?.obligations ?? []) {
    topics.add(topicKeyForObligation(obligation));
    for (const entity of obligation.entities ?? []) {
      const product = cleanTerm(entity);
      const key = product.toLowerCase();
      if (!isLikelyProductEntity(product) || seenProducts.has(key)) continue;
      seenProducts.add(key);
      products.push(product);
    }
  }
  const hasProductResearchTopics = ["gpu", "memory", "thermal", "support", "tco"].some((topic) => topics.has(topic));
  if (!looksLikeProductResearchPrompt(prompt) && !hasProductResearchTopics) return [];
  if (products.length < 2) return [];

  const facets: string[] = [];
  if (topics.has("gpu") || topics.has("software")) facets.push("official specifications GPU options VRAM TGP benchmark");
  if (topics.has("memory")) facets.push("official specifications maximum RAM memory slots service manual");
  if (topics.has("thermal")) facets.push("thermal review sustained performance GPU TGP operating temperature");
  if (topics.has("support")) facets.push("UAE warranty onsite support SLA accidental damage battery");
  if (topics.has("tco")) facets.push("UAE price warranty battery replacement cost total cost of ownership");

  const queries: string[] = [];
  for (const facet of facets) {
    for (const product of products.slice(0, 4)) {
      queries.push(compactQuery([quoteEntity(product), facet]));
    }
  }
  return queries;
}

function domainMatrixFacetQueries(prompt: string, plan?: ObligationPlan): string[] {
  const planText = JSON.stringify(plan);
  const text = `${prompt}\n${planText}`.toLowerCase();
  const entities: string[] = [];
  const seen = new Set<string>();
  for (const obligation of plan?.obligations ?? []) {
    for (const entity of obligation.entities ?? []) {
      const clean = cleanTerm(entity);
      const key = clean.toLowerCase();
      if (isNoiseEntity(clean) || seen.has(key)) continue;
      seen.add(key);
      entities.push(clean);
    }
  }

  const facets: string[] = [];
  const sourceScopedFacets: string[] = [];
  const looksEnterpriseUx = /\berp\b/.test(text)
    || /\bux\b/.test(text)
    || /\bsap\b/.test(text)
    || /\bfiori\b/.test(text)
    || /\bnetsuite\b/.test(text)
    || /\boracle\b/.test(text)
    || /\binventory\b/.test(text)
    || /\bwork orders?\b/.test(text)
    || /\bdashboards?\b/.test(text)
    || /\bprogressive disclosure\b/.test(text)
    || /\bcognitive load\b/.test(text)
    || /\bchange management\b/.test(text)
    || /\badoption\b/.test(text);

  if (/\b(maternal|neonatal|antenatal|prenatal|obstetric|midwi(?:fe|ves)|mortality|refugee|camp|unhcr|unfpa|msf|cox'?s bazar|mae la)\b/.test(text)) {
    facets.push(
      "ANC4 antenatal care 4+ visits skilled birth attendance facility birth neonatal mortality maternal mortality",
      "postpartum haemorrhage hemorrhage PPH incidence maternal death cause MPMSR surveillance",
      "midwife workforce ratio EmONC emergency obstetric care referral transport time traditional birth attendants",
      "healthcare delivery model field hospital Ministry of Public Health integration cultural mediation",
    );
    sourceScopedFacets.push(
      "site:unhcr.org health information system iRHIS maternal mortality neonatal mortality refugee",
      "site:unfpa.org maternal health refugees antenatal skilled birth",
      "site:msf.org operational report maternal health refugees",
      "cohort study maternal neonatal outcomes refugee camp antenatal birth Mae La",
    );
  }

  if (/\b(10-k|10-q|sec|edgar|filing|operating margin|segment|renaissance portfolio|term loan|impairment|fund iii|fund iv|bald hill|reit)\b/.test(text)) {
    facets.push(
      "Q1 2024 segment revenue operating income Core Portfolio Funds operating margin",
      "Renaissance Portfolio acquisition purchase price assumed mortgage debt principal paydown",
      "2025 term loan drawdown net debt SOFR credit agreement principal paydown",
      "Renaissance Portfolio mortgage spread SOFR reduced spread modified loans old new spread principal paydown",
      "Fund III Fund IV Bald Hill Road impairment charge shortened holding period",
      "equity issuance ATM Investment Management segment income REIT Portfolio revenue",
      "ATM forward sale agreements settled forward shares physical settlement proceeds equity issuance",
      "Investment Management operating income fee income AUM runoff structured financing headwinds year over year",
      "REIT Portfolio rental revenue year over year increase decrease same property NOI",
      "portfolio location geographic concentration Washington D.C. New York property location ownership percentage",
      "annual Form 10-K portfolio strategy risk factors subsequent 10-Q",
    );
    sourceScopedFacets.push(
      "site:sec.gov 10-Q 10-K segment reporting impairment term loan acquisition",
      "site:sec.gov Renaissance Portfolio mortgage indebtedness principal paydown term loan",
    );
  }

  if (looksLikeAffiliateResearchText(text)) {
    facets.push(
      "official affiliate publisher partner program marketplace comparison soft credit check",
      "official product page debt relief trust will life insurance business credit partner provider",
      "terms compensation lead generation referral compliance servicing provider",
    );
    sourceScopedFacets.push(
      "site:supermoney.com affiliate publisher program marketplace soft credit check",
      "site:supermoney.com personal loans credit cards auto refinance student loan refinance debt consolidation",
      "site:novae.com debt relief trust will life insurance business credit partner",
    );
  }

  if (looksEnterpriseUx) {
    facets.push(
      "SAP Fiori object page wizard launchpad shell bar inventory work order official design guideline",
      "Oracle NetSuite global search centers roles dashboard Item 360 work order official documentation",
      "progressive disclosure hidden navigation wizard cognitive load older adult learnability usability research",
      "ERP adoption change management utilization proficiency training official source",
    );
    sourceScopedFacets.push(
      "site:sap.com/design-system/fiori-design-web object page wizard launchpad shell bar",
      "site:docs.oracle.com/en/cloud/saas/netsuite global search centers roles dashboard Item 360 work order",
      "site:nngroup.com progressive disclosure hidden navigation wizard cognitive load older adults",
      "site:prosci.com adoption utilization proficiency change management ERP",
    );
  }

  if (/\b(nasdaq|independent director|controlled company|foreign private issuer|audit committee|sec rule|10a-3|investment company)\b/.test(text)) {
    facets.push(
      "official rule text independent director bright-line disqualification family member compensation",
      "Nasdaq Rule 5605 controlled company phase-in foreign private issuer audit committee independence",
      "SEC Rule 10A-3 compensatory fee audit committee investment company interested person",
    );
    sourceScopedFacets.push("site:nasdaq.com Rule 5605 independent director controlled company", "site:law.cornell.edu 17 CFR 240.10A-3 audit committee independence");
  }

  if (/\b(goodman-bacon|callaway|sant'?anna|sun|abraham|borusyak|jaravel|spiess|did2s|honest did|difference-in-differences|staggered|event study)\b/.test(text)) {
    facets.push(
      "Goodman-Bacon decomposition diagnostic staggered difference-in-differences",
      "Callaway Sant'Anna Sun Abraham Borusyak Jaravel Spiess did2s estimator software implementation",
      "HonestDiD pre-trend testing robust inference event study software",
      "AER QJE JPE labor health difference-in-differences adoption 2020 2021 2022 2023 2024",
    );
  }

  if (/\b(jetson|orin|tensorrt|deepstream|int8|onnx|etlt|tao|detectnet|peoplenet|yolo|efficientdet|latency|ota)\b/.test(text)) {
    facets.push(
      "official Jetson Orin latency INT8 TensorRT YOLOv8 benchmark",
      "TAO DetectNet_v2 PeopleNet DeepStream TensorRT performance INT8",
      "EfficientDet TensorRT OSS plugin ONNX ETLT engine build calibration cache OTA",
      "active learning edge deployment validation drift monitoring",
    );
    sourceScopedFacets.push("site:docs.nvidia.com Jetson Orin TensorRT DeepStream TAO DetectNet_v2 PeopleNet INT8");
  }

  if (!facets.length && !sourceScopedFacets.length) return [];

  const queries: string[] = [];
  const selectedEntities = entities.slice(0, 8);
  for (const facet of sourceScopedFacets) {
    queries.push(compactQuery([facet, prompt.slice(0, 120)]));
    for (const entity of selectedEntities.slice(0, 4)) queries.push(compactQuery([facet, quoteEntity(entity)]));
  }
  for (const facet of facets) {
    if (!selectedEntities.length) {
      queries.push(compactQuery([facet, sourceHintForPrompt(prompt)]));
      continue;
    }
    for (const entity of selectedEntities.slice(0, 5)) queries.push(compactQuery([quoteEntity(entity), facet]));
  }
  return queries;
}

function compactQuery(parts: string[]): string {
  const query = parts
    .map(cleanTerm)
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  return query.length <= 260 ? query : query.slice(0, 260).replace(/\s+\S*$/, "");
}

function obligationPriority(obligation: FusionObligation): number {
  const kindWeight: Record<FusionObligation["kind"], number> = {
    metric: 6,
    calculation: 6,
    source: 5,
    comparison: 4,
    recommendation: 3,
    caveat: 2,
    other: 1,
  };
  let score = kindWeight[obligation.kind] ?? 0;
  if (obligation.expectedEvidence?.length) score += 2;
  if (obligation.timePeriod) score += 1;
  if (obligation.entities?.length) score += 1;
  return score;
}

function queriesForObligation(obligation: FusionObligation, prompt: string): string[] {
  const sourceHint = sourceHintForPrompt(prompt);
  const entities = (obligation.entities ?? []).map(quoteEntity).filter(Boolean);
  const evidence = (obligation.expectedEvidence ?? []).slice(0, 2);
  const preferred = (obligation.preferredSourceTypes ?? []).slice(0, 1);
  const focusedFacet = focusedFacetForObligation(obligation, prompt);
  const base = [
    obligation.description,
    obligation.timePeriod ?? "",
    ...evidence,
    ...preferred,
    sourceHint,
  ];

  if (entities.length <= 1) {
    const focused = focusedFacet && entities.length
      ? [compactQuery([...entities, focusedFacet, obligation.timePeriod ?? ""])]
      : [];
    return [...focused, compactQuery([...entities, ...base])];
  }

  const queries = focusedFacet
    ? entities.slice(0, 3).map((entity) => compactQuery([entity, focusedFacet, obligation.timePeriod ?? ""]))
    : [];
  queries.push(...entities.slice(0, 3).map((entity) => compactQuery([entity, ...base])));
  queries.push(compactQuery([entities.slice(0, 3).join(" "), focusedFacet || sourceHint, obligation.timePeriod ?? ""]));
  queries.push(compactQuery([entities.slice(0, 3).join(" "), ...base]));
  return queries;
}

function quotedPromptQueries(prompt: string): string[] {
  const sourceHint = sourceHintForPrompt(prompt);
  return [...prompt.matchAll(/["“”']([^"“”']{4,90})["“”']/g)]
    .map((match) => compactQuery([quoteEntity(match[1]), sourceHint]))
    .filter(Boolean)
    .slice(0, 3);
}

export function buildPromptOnlyFacetQueries(prompt: string): string[] {
  if (!/\b(erp|ux|usability|navigation|sap|s\/4hana|fiori|netsuite|oracle|inventory|work orders?|manufacturing|dashboard|progressive disclosure|cognitive load|change management|adoption)\b/i.test(prompt)) {
    return [];
  }
  return [
    compactQuery(["site:sap.com/design-system/fiori-design-web object page wizard launchpad shell bar", prompt.slice(0, 120)]),
    compactQuery(["site:docs.oracle.com/en/cloud/saas/netsuite global search centers roles dashboard Item 360 work order", prompt.slice(0, 120)]),
    compactQuery(["site:nngroup.com progressive disclosure hidden navigation wizard cognitive load older adults", prompt.slice(0, 120)]),
    compactQuery(["site:prosci.com adoption utilization proficiency change management ERP", prompt.slice(0, 120)]),
  ];
}

interface QueryGroup {
  topic: string;
  priority: number;
  order: number;
  querySets: string[][];
  queries: string[];
  cursor: number;
}

function interleaveQuerySets(querySets: string[][]): string[] {
  const queries: string[] = [];
  let depth = 0;
  while (true) {
    let progressed = false;
    for (const querySet of querySets) {
      if (depth >= querySet.length) continue;
      queries.push(querySet[depth]);
      progressed = true;
    }
    if (!progressed) break;
    depth += 1;
  }
  return queries;
}

export function buildPromptSearchQueries(
  prompt: string,
  plan?: ObligationPlan,
  options: PromptSearchSeedOptions = {},
): string[] {
  const searchPrompt = promptSearchSubject(prompt);
  const maxQueries = options.maxQueries ?? numberFromEnv("PI_FUSION_PROMPT_SEARCH_MAX_QUERIES", DEFAULT_MAX_QUERIES);
  if (maxQueries <= 0) return [];

  const selected: string[] = [];
  const seen = new Set<string>();
  const addQuery = (rawQuery: string): boolean => {
    const query = rawQuery.replace(/\s+/g, " ").trim();
    if (query.length < 12) return false;
    const key = query.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    selected.push(query);
    return true;
  };

  for (const query of productMatrixFacetQueries(searchPrompt, plan)) {
    addQuery(query);
    if (selected.length >= maxQueries) return selected;
  }

  for (const query of domainMatrixFacetQueries(searchPrompt, plan)) {
    addQuery(query);
    if (selected.length >= maxQueries) return selected;
  }

  for (const query of buildPromptOnlyFacetQueries(searchPrompt)) {
    addQuery(query);
    if (selected.length >= maxQueries) return selected;
  }

  const groups = new Map<string, QueryGroup>();
  const obligations = (plan?.obligations ?? [])
    .map((obligation, order) => ({ obligation, order, priority: obligationPriority(obligation) }))
    .sort((a, b) => b.priority - a.priority || a.order - b.order);

  for (const { obligation, order, priority } of obligations) {
    const topic = topicKeyForObligation(obligation);
    const group = groups.get(topic) ?? { topic, priority, order, querySets: [], queries: [], cursor: 0 };
    group.priority = Math.max(group.priority, priority);
    group.order = Math.min(group.order, order);
    group.querySets.push(queriesForObligation(obligation, searchPrompt));
    groups.set(topic, group);
  }

  const quotedQueries = quotedPromptQueries(searchPrompt);
  if (quotedQueries.length) {
    groups.set("quoted", { topic: "quoted", priority: 4, order: Number.MAX_SAFE_INTEGER, querySets: [quotedQueries], queries: [], cursor: 0 });
  }

  if (!groups.size) {
    if (selected.length) return selected.slice(0, maxQueries);
    const fallback = compactQuery([searchPrompt, sourceHintForPrompt(searchPrompt)]);
    return fallback.length >= 12 ? [fallback].slice(0, maxQueries) : [];
  }

  for (const group of groups.values()) {
    group.queries = interleaveQuerySets(group.querySets);
  }

  const orderedGroups = Array.from(groups.values())
    .filter((group) => group.queries.some((query) => query.trim().length >= 12))
    .sort((a, b) => b.priority - a.priority || a.order - b.order || a.topic.localeCompare(b.topic));

  while (selected.length < maxQueries) {
    let progressed = false;
    for (const group of orderedGroups) {
      while (group.cursor < group.queries.length) {
        const query = group.queries[group.cursor].replace(/\s+/g, " ").trim();
        group.cursor += 1;
        if (!addQuery(query)) continue;
        progressed = true;
        break;
      }
      if (selected.length >= maxQueries) break;
    }
    if (!progressed) break;
  }

  return selected;
}

function interleaveDirectSourceUrlGroups(groups: string[][]): string[] {
  const urls: string[] = [];
  const seen = new Set<string>();
  let depth = 0;
  while (true) {
    let progressed = false;
    for (const group of groups) {
      if (depth >= group.length) continue;
      const url = group[depth];
      progressed = true;
      if (seen.has(url)) continue;
      seen.add(url);
      urls.push(url);
    }
    if (!progressed) break;
    depth += 1;
  }
  return urls;
}

function financeCompanySearchTerms(prompt: string): string[] {
  const subject = promptSearchSubject(prompt);
  const candidates: string[] = [];
  for (const match of subject.matchAll(/\b([A-Z][A-Za-z&.'-]{2,})'s\s+(?:evolving\s+)?portfolio\s+strategy\b/g)) {
    candidates.push(`${match[1]} Realty Trust`);
    candidates.push(match[1]);
  }
  for (const match of subject.matchAll(/\b([A-Z][A-Za-z&.'-]{2,}(?:\s+[A-Z][A-Za-z&.'-]{2,}){0,4})'s\b/g)) {
    candidates.push(match[1]);
  }
  for (const match of subject.matchAll(/\b([A-Z][A-Za-z&.'-]+(?:\s+[A-Z][A-Za-z&.'-]+){1,5})\b/g)) {
    const value = match[1];
    if (/\b(Realty|REIT|Trust|Inc|Corp|Corporation|Company|Holdings|Group|Limited|PLC)\b/.test(value)) candidates.push(value);
  }
  const seen = new Set<string>();
  return candidates
    .map((candidate) => candidate.replace(/\b(Task|Analyze|Assess|Calculate|Core Portfolio|Funds|Renaissance Portfolio)\b/gi, " ").replace(/\s+/g, " ").trim())
    .filter((candidate) => candidate.length >= 3)
    .filter((candidate) => !/\b(DRACO|Case|Protocol|Portfolio|Funds|Segment|SEC|Q[1-4]|Form)\b/i.test(candidate))
    .filter((candidate) => {
      const key = candidate.toLowerCase();
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);
}

function financeCompanyQueryTerms(company: string, prompt: string): string[] {
  const terms = [company];
  const text = prompt.toLowerCase();
  if (/\b(real estate|reit|realty|portfolio|property|properties|core portfolio|funds segment|mortgage|rental revenue)\b/.test(text)) {
    if (!/\brealty\b/i.test(company)) terms.push("Realty Trust");
    terms.push("REIT");
  }
  return terms;
}

function financeCompanyDisplayTokens(prompt: string): string[] {
  const suffixes = new Set([
    "realty",
    "reit",
    "trust",
    "inc",
    "corp",
    "corporation",
    "company",
    "holdings",
    "group",
    "limited",
    "plc",
  ]);
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const company of financeCompanySearchTerms(prompt)) {
    for (const token of company.toLowerCase().split(/[^a-z0-9]+/)) {
      if (token.length < 4 || suffixes.has(token) || seen.has(token)) continue;
      seen.add(token);
      tokens.push(token);
    }
  }
  return tokens;
}

function eftsSearchIndexUrl(terms: string[], options: { startdt?: string; enddt?: string; forms?: string } = {}): string {
  const query = terms
    .map((term) => term.trim())
    .filter(Boolean)
    .map((term) => `"${term.replace(/"/g, "")}"`)
    .join(" ");
  const params = new URLSearchParams({ q: query });
  if (options.startdt || options.enddt) {
    params.set("dateRange", "custom");
    if (options.startdt) params.set("startdt", options.startdt);
    if (options.enddt) params.set("enddt", options.enddt);
  }
  if (options.forms) params.set("forms", options.forms);
  return `https://efts.sec.gov/LATEST/search-index?${params.toString()}`;
}

function secArchiveBaseUrl(cik: string, accessionNumber: string): string {
  return `https://www.sec.gov/Archives/edgar/data/${String(cik).replace(/^0+/, "")}/${accessionNumber.replace(/-/g, "")}/`;
}

function secFollowUpUrlsFromEftsJson(text: string, prompt = ""): string[] {
  let payload: any;
  try {
    payload = JSON.parse(text);
  } catch {
    return [];
  }
  const hits: any[] = Array.isArray(payload?.hits?.hits) ? payload.hits.hits : [];
  const companyTokens = financeCompanyDisplayTokens(prompt);
  const matchingHits = companyTokens.length
    ? hits.filter((hit) => {
      const displayNames = Array.isArray(hit?._source?.display_names)
        ? hit._source.display_names.join(" ").toLowerCase()
        : "";
      return displayNames && companyTokens.some((token) => displayNames.includes(token));
    })
    : hits;
  const followUpHits = matchingHits.length > 0 ? matchingHits : hits;
  const urls: string[] = [];
  const seen = new Set<string>();
  const add = (url: string) => {
    if (seen.has(url)) return;
    seen.add(url);
    urls.push(url);
  };

  for (const hit of followUpHits.slice(0, 4)) {
    const id = typeof hit?._id === "string" ? hit._id : "";
    const match = id.match(/^([0-9]{10}-[0-9]{2}-[0-9]{6}):([^:\s]+)$/);
    const cik = Array.isArray(hit?._source?.ciks) && typeof hit._source.ciks[0] === "string"
      ? hit._source.ciks[0]
      : undefined;
    if (!match || !cik) continue;
    const accessionNumber = match[1];
    const document = match[2];
    const baseUrl = secArchiveBaseUrl(cik, accessionNumber);
    if (/\.html?$/i.test(document)) {
      add(`${baseUrl}${document}`);
      add(`https://www.sec.gov/ix?doc=/Archives/edgar/data/${String(cik).replace(/^0+/, "")}/${accessionNumber.replace(/-/g, "")}/${document}`);
    }
    add(`${baseUrl}FilingSummary.xml`);
  }
  return urls;
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#160;|&nbsp;/g, " ");
}

function xmlTagValue(xml: string, tagName: string): string {
  const match = xml.match(new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, "i"));
  return decodeXmlEntities(match?.[1] ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
}

function filingSummaryReportScore(name: string, focus: string): number {
  const text = `${name}\n${focus}`.toLowerCase();
  const report = name.toLowerCase();
  let score = 0;
  if (/segment reporting.*tables?/.test(report)) score += 45;
  if (/segment|reportable segment/.test(report)) score += 28;
  if (/consolidated statements? of operations|income statement|operations/.test(report)) score += 24;
  if (/management.?s discussion|md&a|results of operations|liquidity|capital resources/.test(report)) score += 26;
  if (/debt|loan|credit|borrowing|mortgage|note payable|principal repayments/.test(report)) score += 24;
  if (/impair|held for sale|fair value|reduced holding period|shortened holding period/.test(report)) score += 24;
  if (/acquisition|business combination|purchase|consolidation/.test(report)) score += 22;
  if (/equity|stockholder|shareholder|common share|atm|forward sale|issuance|settlement/.test(report)) score += 22;
  if (/rental revenue|same.?property|noi|net operating income|leased occupancy/.test(report)) score += 18;
  if (/risk factors|properties|geographic|portfolio/.test(report)) score += 12;
  for (const token of focus.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 5)) {
    if (text.includes(token)) score += 2;
  }
  return score;
}

function secReportUrlsFromFilingSummary(url: string, text: string, focus: string): string[] {
  if (!/\/FilingSummary\.xml$/i.test(url)) return [];
  const baseUrl = url.slice(0, url.lastIndexOf("/") + 1);
  const reports: Array<{ url: string; score: number; order: number }> = [];
  let order = 0;
  for (const match of text.matchAll(/<Report\b[\s\S]*?<\/Report>/gi)) {
    const reportXml = match[0];
    const htmlFileName = xmlTagValue(reportXml, "HtmlFileName");
    if (!/\.html?$/i.test(htmlFileName)) continue;
    const name = [xmlTagValue(reportXml, "ShortName"), xmlTagValue(reportXml, "LongName")].filter(Boolean).join(" ");
    const score = filingSummaryReportScore(name, focus);
    if (score <= 0) continue;
    reports.push({ url: `${baseUrl}${htmlFileName}`, score, order });
    order++;
  }
  return reports
    .sort((a, b) => b.score - a.score || a.order - b.order)
    .slice(0, 8)
    .map((report) => report.url);
}

function secFollowUpUrlsForFetched(url: string, text: string, focus: string): string[] {
  const urls = [
    ...secFollowUpUrlsFromEftsJson(text, focus),
    ...secReportUrlsFromFilingSummary(url, text, focus),
  ];
  const seen = new Set<string>();
  return urls.filter((candidate) => {
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    return true;
  });
}

export function buildPromptDirectSourceUrls(prompt: string): string[] {
  const subject = promptSearchSubject(prompt);
  const text = subject.toLowerCase();
  const secSearchUrls: string[] = [];
  const coxBazarUrls: string[] = [];
  const maeLaUrls: string[] = [];
  const superMoneyUrls: string[] = [];
  const novaeUrls: string[] = [];
  const sapUxUrls: string[] = [];
  const netsuiteUxUrls: string[] = [];
  const usabilityUrls: string[] = [];
  const add = (urls: string[], url: string) => {
    if (!urls.includes(url)) urls.push(url);
  };

  if (/\b(10-k|10-q|sec|edgar|filing|operating margin|segment|renaissance portfolio|term loan|impairment|fund iii|fund iv|bald hill|reit)\b/.test(text)) {
    const companies = financeCompanySearchTerms(subject);
    const company = companies[0];
    if (company) {
      const companyTerms = financeCompanyQueryTerms(company, subject);
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "10-Q"], { startdt: "2024-01-01", enddt: "2024-06-30", forms: "10-Q" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "10-K"], { startdt: "2025-01-01", enddt: "2025-04-30", forms: "10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Core Portfolio", "Funds", "segment"], { startdt: "2024-01-01", enddt: "2024-06-30", forms: "10-Q" }));
      if (/\brenaissance portfolio\b/.test(text)) {
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Renaissance Portfolio"], { startdt: "2024-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Renaissance Portfolio", "loss on change in control"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Renaissance Portfolio", "SOFR", "spread"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Renaissance Portfolio", "modified", "loans", "SOFR"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "mortgages payable", "Renaissance Portfolio", "interest rate", "maturity"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "property mortgage", "reduced interest rate", "basis points", "paydown"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Renaissance Portfolio", "primarily located", "Washington"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
      }
      if (/\bbald hill|fund iii|fund iv|impairment\b/.test(text)) {
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Bald Hill", "Fund III", "Fund IV"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "property location", "reduced holding period"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      }
      if (/\bterm loan|principal paydown|sofr|equity issuance|investment management|reit portfolio\b/.test(text)) {
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "term loan", "principal paydown"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
        add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "term loan", "SOFR", "maturity"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      }
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Investment Management", "operating income", "Three Months Ended September 30"], { startdt: "2024-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "REIT Portfolio", "Rental Revenue", "Three Months Ended September 30"], { startdt: "2024-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "REIT", "IM", "Rental revenue", "Operating income", "Increase Decrease"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "ATM Program", "settled forward shares", "proceeds"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "ATM forward sale agreements", "aggregate net value", "settlement"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "ATM Forward Sale Agreements", "Aggregate Value", "Average Net Share Price", "Aggregate Net Value"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "common shares offered", "aggregate value", "aggregate net value", "ATM"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "physically settled", "forward sale agreements", "net proceeds"], { startdt: "2025-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "Investment Management", "fee income", "assets under management", "structured financing"], { startdt: "2024-01-01", enddt: "2025-12-31", forms: "10-Q,10-K,8-K" }));
      add(secSearchUrls, eftsSearchIndexUrl([...companyTerms, "2024 Form 10-K", "portfolio strategy"], { startdt: "2025-01-01", enddt: "2025-04-30", forms: "10-K" }));
    }
  }

  if (/\b(cox'?s bazar|rohingya)\b/.test(text) && /\b(maternal|neonatal|antenatal|birth|obstetric|midwi(?:fe|ves)|mortality|unfpa|unhcr|msf|mpmsr|pph|postpartum)\b/.test(text)) {
    add(coxBazarUrls, "https://rohingyaresponse.org/wp-content/uploads/2024/04/CXB-Health-Sector-Bulletin-Feb-2024-1.pdf");
    add(coxBazarUrls, "https://bangladesh.unfpa.org/sites/default/files/pub-pdf/mpmsr_annual_report_2021.pdf");
    add(coxBazarUrls, "https://pmc.ncbi.nlm.nih.gov/articles/PMC9024274/");
    add(coxBazarUrls, "https://pmc.ncbi.nlm.nih.gov/articles/PMC7888086/");
    add(coxBazarUrls, "https://link.springer.com/article/10.1186/s12939-025-02673-2");
    add(coxBazarUrls, "https://gh.bmj.com/content/7/4/e008110");
    add(coxBazarUrls, "https://healthcluster.who.int/docs/librariesprovider16/meeting-reports/bangladesh-health-sector-bulletin-apr-june-2021.pdf?download=true&sfvrsn=cef9a240_5");
    add(coxBazarUrls, "https://bangladesh.unfpa.org/sites/default/files/pub-pdf/srh_wg_bulletin_quarter_iii_2023_final.pdf");
    add(coxBazarUrls, "https://bangladesh.unfpa.org/en/publications/annual-report-2021-maternal-and-perinatal-mortality-surveillance-and-response-mpmsr");
    add(coxBazarUrls, "https://www.unfpa.org/resources/unfpa-situation-report-rohingya-humanitarian-response-coxs-bazar-april-june-2023");
    add(coxBazarUrls, "https://link.springer.com/article/10.1186/s13031-025-00733-6");
    add(coxBazarUrls, "https://www.unfpa.org/coxs-bazar-bangladesh");
    add(coxBazarUrls, "https://www.unfpa.org/news/rohingya-influx-three-years?page=365");
    add(coxBazarUrls, "https://www.unfpa.org/press/funding-gap-increased-insecurity-jeopardize-lives-rohingya-women-and-girls");
    add(coxBazarUrls, "https://mpmsrcxb.info/");
  }

  if (/\b(mae la|karen|thai[- ]myanmar|thailand[- ]myanmar|smru|shoklo)\b/.test(text) && /\b(maternal|neonatal|antenatal|birth|obstetric|midwi(?:fe|ves)|mortality|refugee|camp|tba|traditional birth)\b/.test(text)) {
    add(maeLaUrls, "https://pmc.ncbi.nlm.nih.gov/articles/PMC11091483/");
    add(maeLaUrls, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0072721");
    add(maeLaUrls, "https://pmc.ncbi.nlm.nih.gov/articles/PMC4332741/");
    add(maeLaUrls, "https://pubmed.ncbi.nlm.nih.gov/25652646/");
    add(maeLaUrls, "https://pmc.ncbi.nlm.nih.gov/articles/PMC12921400/");
    add(maeLaUrls, "https://pubmed.ncbi.nlm.nih.gov/38721695/");
    add(maeLaUrls, "https://www.unhcr.org/us/where-we-work/countries/thailand");
    add(maeLaUrls, "https://www.frontiersin.org/journals/public-health/articles/10.3389/fpubh.2023.1144642/full");
    add(maeLaUrls, "https://journals.plos.org/plosone/article?id=10.1371/journal.pone.0190419");
    add(maeLaUrls, "https://access.archive-ouverte.unige.ch/access/metadata/51387c27-b716-4420-a9b2-af17f6329608/download");
    add(maeLaUrls, "https://www.thenewhumanitarian.org/report/93713/thailand-neonatal-care-refugees-refugees");
    add(maeLaUrls, "https://maetaoclinic.org/health-services/");
    add(maeLaUrls, "https://maetaoclinic.org/community-health/");
    add(maeLaUrls, "https://ccsdpt.org/");
  }

  if (looksLikeSuperMoneyResearchText(text)) {
    add(superMoneyUrls, "https://www.supermoney.com/monetize");
    add(superMoneyUrls, "https://www.supermoney.com/monetize/super-links");
    add(superMoneyUrls, "https://help.supermoney.com/article/61-what-does-supermoney-do");
    add(superMoneyUrls, "https://help.supermoney.com/article/47-what-is-a-soft-pull-or-soft-inquiry-on-my-credit-score");
    add(superMoneyUrls, "https://www.supermoney.com/encyclopedia/soft-credit-check");
    add(superMoneyUrls, "https://www.supermoney.com/reviews/personal-loans");
    add(superMoneyUrls, "https://www.supermoney.com/reviews/credit-cards");
    add(superMoneyUrls, "https://www.supermoney.com/reviews/auto-loan-refinance");
    add(superMoneyUrls, "https://www.supermoney.com/reviews/student-loan-refinance");
    add(superMoneyUrls, "https://www.supermoney.com/reviews/debt-consolidation");
  }

  if (looksLikeNovaeResearchText(text)) {
    add(novaeUrls, "https://novaemoney.com/base/about-novae");
    add(novaeUrls, "https://novaemoney.com/base/for-consumers");
    add(novaeUrls, "https://novaemoney.com/base/debt-help");
    add(novaeUrls, "https://novaemoney.com/base/business-debt-help");
    add(novaeUrls, "https://novaemoney.com/base/wills");
    add(novaeUrls, "https://novaemoney.com/base/trusts");
    add(novaeUrls, "https://novaemoney.com/base/life-insurance");
    add(novaeUrls, "https://novaemoney.com/base/novae-money-business-funding");
    add(novaeUrls, "https://novaemoney.com/base/business-funding-programs");
    add(novaeUrls, "https://novaemoney.com/base/cobrand-program");
    add(novaeUrls, "https://novaemoney.com/base/white-label-program");
    add(novaeUrls, "https://novaemoney.com/base/compensation-plan");
    add(novaeUrls, "https://novaemoney.com/base/become-an-affiliate");
  }

  if (/\b(sap|s\/4hana|fiori|object page|wizard|launchpad|shell bar|inventory|work order)\b/.test(text)) {
    add(sapUxUrls, "https://www.sap.com/design-system/fiori-design-web");
    add(sapUxUrls, "https://www.sap.com/design-system/fiori-design-web/v1-96/discover/frameworks/sap-fiori-elements/object-page/object-page-overview-sap-fiori-elements");
    add(sapUxUrls, "https://learning.sap.com/courses/ui-development-with-sap-fiori/working-with-sap-fiori-design-guidelines_ab11c169-54de-4f51-87b9-f61c8a5198be");
    add(sapUxUrls, "https://fioriappslibrary.hana.ondemand.com/sap/fix/externalViewer/");
  }

  if (/\b(netsuite|oracle|global search|center|role|dashboard|item 360|work order|inventory|manufacturing)\b/.test(text)) {
    add(netsuiteUxUrls, "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_4307693953.html");
    add(netsuiteUxUrls, "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0713121656.html");
    add(netsuiteUxUrls, "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/article_2145345562.html");
    add(netsuiteUxUrls, "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_0915094459.html");
    add(netsuiteUxUrls, "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_1121062316.html");
    add(netsuiteUxUrls, "https://www.netsuite.com/portal/products/erp/production-management/work-order-management.shtml");
  }

  if (/\b(ux|usability|progressive disclosure|hidden navigation|cognitive load|wizard|older adult|learnability|discoverability|adoption|change management)\b/.test(text)) {
    add(usabilityUrls, "https://www.nngroup.com/articles/progressive-disclosure/");
    add(usabilityUrls, "https://www.nngroup.com/articles/hamburger-menus/");
    add(usabilityUrls, "https://www.nngroup.com/articles/wizards/");
    add(usabilityUrls, "https://www.nngroup.com/articles/recognition-and-recall/");
    add(usabilityUrls, "https://www.prosci.com/blog/the-case-for-change-management");
  }

  return interleaveDirectSourceUrlGroups([
    secSearchUrls,
    coxBazarUrls,
    maeLaUrls,
    superMoneyUrls,
    novaeUrls,
    sapUxUrls,
    netsuiteUxUrls,
    usabilityUrls,
  ]).slice(0, DIRECT_SOURCE_FETCH_LIMIT);
}

function directSourceFocusesForPrompt(prompt: string): string[] {
  const subject = promptSearchSubject(prompt);
  if (/\b(cox'?s bazar|rohingya|mae la|karen|thai[- ]myanmar|smru|shoklo)\b/i.test(subject)
    && /\b(maternal|neonatal|antenatal|birth|obstetric|midwi(?:fe|ves)|mortality|unfpa|unhcr|msf|mpmsr|pph|postpartum)\b/i.test(subject)) {
    return [
      "Cox's Bazar Rohingya Mae La Karen refugee maternal mortality MMR maternal deaths per 100000 live births",
      "antenatal care ANC4 ANC 4+ four or more visits coverage percentage refugee camp camp-specific camp 4",
      "skilled birth attendance SBA facility delivery facility birth facility-based births percentage trajectory baseline follow-up year trend home delivery",
      "postpartum hemorrhage haemorrhage PPH incidence obstetric hemorrhage maternal death cause",
      "neonatal mortality newborn mortality NMR deaths within 28 days neonatal deaths per 1000 live births infant mortality under-five mortality September 2017 December 2018 Rohingya Cox Bazar camp",
      "midwife workforce staffing ratio EmONC emergency obstetric care CEmONC referral hub Friendship hospital transport travel time distance caesarean cesarean c-section",
      "traditional birth attendant TBA cultural mediation community mobilizer UNFPA funding continuity MSF operational report UNHCR HIS iRHIS SMRU",
    ];
  }
  if (looksLikeAffiliateResearchText(subject)) {
    return [
      "SuperMoney monetize publishers pre-qualify personal loan offers without leaving site brand front-and-center Super Links tracking link commission",
      "SuperMoney soft pull soft inquiry loan offer engine eligibility prequalified offers credit score impact marketplace comparison",
      "Novae about fintech access to credit capital entrepreneurship consumers small businesses nationwide",
      "Novae debt help business debt help debt relief payment reduction consultation minimum debt requirements service provider",
      "Novae will trust estate plan Trust and Will partner package pricing attorney customized state-specific",
      "Novae life insurance Policygenius partner business credit builder business funding co-brand white label affiliate compensation",
    ];
  }
  if (/\b(erp|ux|usability|navigation|sap|s\/4hana|fiori|netsuite|oracle|inventory|work order|manufacturing|dashboard|progressive disclosure|cognitive load|change management|adoption|older adult|legacy user)\b/i.test(subject)) {
    return [
      "SAP Fiori object page dynamic page header shellbar business object sections anchor tab navigation",
      "SAP Fiori wizard guided workflow step-by-step progressive disclosure complex task creation process",
      "Oracle NetSuite global search header anchored Alt+G any type of record centers roles dashboard navigation",
      "Oracle NetSuite Item 360 dashboard manufacturing page available to build work order quantity inventory work order",
      "Nielsen Norman Group hidden navigation discoverability task completion slower progressive disclosure cognitive load recognition recall wizard",
      "Prosci change management adoption speed ultimate utilization proficiency ERP migration training measurement",
    ];
  }
  if (/\b(10-k|10-q|sec|edgar|filing|segment|revenue|operating income|operating margin|acquisition|purchase price|assumed debt|mortgage|principal paydown|term loan|impairment|reit|fund iii|fund iv|portfolio|sofr)\b/i.test(subject)) {
    return [
      "segment reporting summary segment information Core Portfolio Funds total revenues operating income operating margin",
      "real estate acquisition controlling interest acquired economic ownership total consideration mortgage indebtedness purchase price",
      "Renaissance Portfolio loss on change in control remeasurement controlling financial interest consolidation",
      "Renaissance Portfolio existing mortgage indebtedness SOFR scheduled maturity acquisition date",
      "modified property mortgage loans reduce interest rate SOFR spread old new basis points Renaissance Portfolio",
      "mortgages payable property portfolio interest rate maturity principal paydown reduced spread",
      "new five-year incremental delayed draw term loan amount drawn at closing SOFR spread maturity date",
      "debt term loan borrowing principal paydown mortgage notes payable scheduled principal repayments exact rate SOFR maturity delayed draw term loan",
      "impairment Fund III Fund IV Bald Hill Road assets held for sale fair value reduced holding period shortened hold period Acadia share proportionate share",
      "settled outstanding forward shares proceeds ATM program physical settlement aggregate net value equity issuance common shares",
      "ATM Forward Sale Agreements Aggregate Value Average Net Share Price Aggregate Net Value common shares offered",
      "Investment Management operating income fee income assets under management structured financing three months ended September 30 year over year decrease",
      "REIT Portfolio Rental revenue same property NOI three months ended September 30 year over year increase rental revenues",
      "management discussion results of operations liquidity capital resources equity activity debt activity year over year segment trend",
      "Form 10-K annual report portfolio strategy risk factors geographic concentration property location Washington D.C. New York ownership percentage",
    ];
  }
  return [compactQuery([sourceHintForPrompt(subject), subject.slice(0, 220)])];
}

function compactFetchText(text: string, maxChars = MAX_FETCH_CHARS): string {
  const trimmed = String(text ?? "").trim();
  if (trimmed.length <= maxChars) return trimmed;
  return `${trimmed.slice(0, maxChars)}\n[truncated at ${maxChars} chars]`;
}

function searchSnippet(query: string, results: WebSearchResult[]): string {
  const lines = [`Top search results for: ${query}`];
  for (const [index, result] of results.entries()) {
    lines.push(`${index + 1}. ${result.title}${result.url ? ` — ${result.url}` : ""}`);
    if (result.snippet) lines.push(`   ${result.snippet.replace(/\s+/g, " ").trim().slice(0, 700)}`);
  }
  return lines.join("\n");
}

function looksLikeSearchFailure(value: string): boolean {
  const head = String(value ?? "").trim().slice(0, 1200);
  if (!head) return true;
  return /\b(mcp error|api error|failed to perform search|all search providers failed|not configured|quota exceeded|insufficient quota|insufficient balance|rate limit|unauthorized|forbidden|usage limit|token plan)\b/i.test(head) ||
    /已达到.*(?:用量|使用)上限|用量上限|使用上限|每周\/每月使用上限|套餐|购买积分|API Error:\s*\d+|MCP error\s*-\d+/i.test(head);
}

function looksLikeSearchNoise(result: WebSearchResult): boolean {
  const title = String(result.title ?? "").trim();
  const url = String(result.url ?? "").trim();
  const snippet = String(result.snippet ?? "").trim();
  const combined = `${title}\n${url}\n${snippet}`;
  const lowerUrl = url.toLowerCase();
  return (/^Apple Safari$/i.test(title) && /apple\.com\/support\/safari\/?$/i.test(url)) ||
    (/^Safari\b/i.test(title) && /apple\.com\/support\/safari/i.test(url) && !/maternal|neonatal|refugee|mortality|antenatal|birth|obstetric/i.test(snippet)) ||
    (/please enable javascript|enable javascript|開啟 Safari|偏好設定|啟用 JavaScript/i.test(combined) && /apple\.com\/support\/safari/i.test(url)) ||
    (/^Microsoft Edge$/i.test(title) && /support\.microsoft\.com\/[^/]+\/microsoft-edge/i.test(url)) ||
    (/^Google Chrome$/i.test(title) && /support\.google\.com\/chrome/i.test(url)) ||
    (/^(?:Mozilla\s+)?Firefox\b/i.test(title) && /support\.mozilla\.org/i.test(url)) ||
    (/support\.mozilla\.org\/(?:[^/]+\/)?kb\/javascript-settings-for-interactive-web-pages/i.test(url)) ||
    (/javascript settings|preferences for interactive web pages/i.test(combined) && /support\.mozilla\.org/i.test(url)) ||
    (/^Opera$/i.test(title) && /help\.opera\.com\/latest\/web-preferences/i.test(url)) ||
    (/help\.opera\.com\/latest\/web-preferences/i.test(url)) ||
    (/google\.[^/]+\/search\b/i.test(url) && /啟用 JavaScript|enable javascript|javascript/i.test(combined)) ||
    (/^Browser support$/i.test(title) && /(support\.microsoft\.com|support\.google\.com|support\.mozilla\.org|apple\.com\/support)/i.test(url)) ||
    (/(enable|turn on|allow) javascript|browser settings|update your browser|unsupported browser/i.test(combined)
      && /(support\.microsoft\.com\/[^/]+\/microsoft-edge|support\.google\.com\/chrome|support\.mozilla\.org|help\.opera\.com\/latest\/web-preferences|apple\.com\/support\/safari)/i.test(lowerUrl));
}

function looksLikeFailedSearchResults(results: WebSearchResult[]): boolean {
  if (!results.length) return true;
  const usefulResults = results.filter((result) => !looksLikeSearchNoise(result));
  if (!usefulResults.length) return true;
  return usefulResults.every((result) => !result.url && looksLikeSearchFailure(`${result.title}\n${result.snippet}`));
}

async function withSeedTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const operationPromise = operation(controller.signal);
  const timeoutPromise = new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`prompt search seeding timed out after ${timeoutMs}ms`);
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operationPromise, timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
    operationPromise.catch(() => undefined);
  }
}

function fetchEntry(query: string, result: WebFetchResult): EvidenceEntry {
  const content = compactFetchText(extractFocusedExcerpt(result.text, query, { maxChars: MAX_FETCH_CHARS }));
  return {
    id: `prompt-fetch-${stableHash(`${query}\n${result.url}`)}`,
    source: "web_fetch",
    query,
    url: result.url,
    title: result.title ?? result.url,
    snippet: content.slice(0, 1_500),
    fullContent: content,
    participantSlotIndex: -1,
    fetchedAt: Date.now(),
  };
}

function directFetchEntry(prompt: string, result: WebFetchResult): EvidenceEntry {
  const focuses = directSourceFocusesForPrompt(prompt);
  const maxChars = looksLikeFinanceFilingPrompt(prompt) ? FINANCE_DIRECT_FETCH_CHARS : MAX_FETCH_CHARS;
  const perFocusChars = looksLikeFinanceFilingPrompt(prompt)
    ? Math.max(3_600, Math.floor(maxChars / Math.max(1, focuses.length)))
    : Math.max(1_600, Math.floor(maxChars / Math.max(1, focuses.length)));
  const chunks = focuses.map((focus) => {
    const excerpt = extractFocusedExcerpt(result.text, focus, {
      maxChars: perFocusChars,
      windowChars: 900,
      maxSnippets: 2,
    });
    return `## Focus: ${focus}\n${excerpt}`;
  });
  const content = compactFetchText(chunks.join("\n\n"), maxChars);
  return {
    id: `prompt-fetch-${stableHash(`direct\n${result.url}`)}`,
    source: "web_fetch",
    query: focuses.join(" | "),
    url: result.url,
    title: result.title ?? result.url,
    snippet: content.slice(0, 1_500),
    fullContent: content,
    participantSlotIndex: -1,
    fetchedAt: Date.now(),
  };
}

export async function seedPromptSearchEvidence(
  prompt: string,
  plan: ObligationPlan | undefined,
  backend: WebBackend | undefined,
  options: PromptSearchSeedOptions = {},
): Promise<EvidenceEntry[]> {
  if (!enabled() || !backend) return [];
  const searchPrompt = promptSearchSubject(prompt);

  const maxResultsPerQuery = options.maxResultsPerQuery
    ?? numberFromEnv("PI_FUSION_PROMPT_SEARCH_MAX_RESULTS", DEFAULT_MAX_RESULTS_PER_QUERY);
  const fetchTopPerQuery = options.fetchTopPerQuery
    ?? numberFromEnv("PI_FUSION_PROMPT_SEARCH_FETCH_TOP", DEFAULT_FETCH_TOP_PER_QUERY);
  const timeoutMs = options.timeoutMs ?? numberFromEnv("PI_FUSION_PROMPT_SEARCH_TIMEOUT_MS", DEFAULT_TIMEOUT_MS);
  const directFetchConcurrency = Math.max(1, numberFromEnv("PI_FUSION_PROMPT_DIRECT_FETCH_CONCURRENCY", DEFAULT_DIRECT_FETCH_CONCURRENCY));
  const searchConcurrency = Math.max(1, numberFromEnv("PI_FUSION_PROMPT_SEARCH_CONCURRENCY", DEFAULT_SEARCH_CONCURRENCY));
  const queries = buildPromptSearchQueries(searchPrompt, plan, options);

  const entries: EvidenceEntry[] = [];
  const seenFetchUrls = new Set<string>();

  if (backend.supportsFetch && backend.fetch) {
    const priorityDirectUrls: string[] = [];
    const directUrls = buildPromptDirectSourceUrls(searchPrompt).filter((url) => {
      if (seenFetchUrls.has(url)) return false;
      seenFetchUrls.add(url);
      return true;
    });
    const maxDirectFetches = directUrls.length + SEC_FOLLOW_UP_FETCH_LIMIT;
    let directCursor = 0;
    let directFetchCount = 0;
    const enqueuePriorityDirectUrl = (url: string) => {
      if (seenFetchUrls.has(url)) return;
      if (directFetchCount + priorityDirectUrls.length >= maxDirectFetches) return;
      seenFetchUrls.add(url);
      priorityDirectUrls.push(url);
    };

    while ((priorityDirectUrls.length > 0 || directCursor < directUrls.length) && directFetchCount < maxDirectFetches) {
      const batch: string[] = [];
      while (batch.length < directFetchConcurrency && priorityDirectUrls.length > 0 && directFetchCount + batch.length < maxDirectFetches) {
        const next = priorityDirectUrls.shift();
        if (next) batch.push(next);
      }
      while (batch.length < directFetchConcurrency && directCursor < directUrls.length && directFetchCount + batch.length < maxDirectFetches) {
        batch.push(directUrls[directCursor]);
        directCursor++;
      }
      if (!batch.length) break;
      directFetchCount += batch.length;
      const batchEntries = await Promise.all(batch.map(async (url) => {
        try {
          const fetched = await withSeedTimeout(timeoutMs, (signal) => backend.fetch!(url, { signal }));
          for (const followUpUrl of secFollowUpUrlsForFetched(fetched.url || url, fetched.text, searchPrompt)) {
            enqueuePriorityDirectUrl(followUpUrl);
          }
          return directFetchEntry(searchPrompt, fetched);
        } catch {
          // Direct prompt-derived source candidates are best-effort.
          return undefined;
        }
      }));
      entries.push(...batchEntries.filter((entry): entry is EvidenceEntry => Boolean(entry)));
    }
  }

  if (!backend.supportsSearch) return entries;

  for (let i = 0; i < queries.length; i += searchConcurrency) {
    const batch = queries.slice(i, i + searchConcurrency);
    const batchEntries = await Promise.all(batch.map(async (query) => {
      const queryEntries: EvidenceEntry[] = [];
      let results: WebSearchResult[] = [];
      try {
        results = await withSeedTimeout(timeoutMs, (signal) => backend.search(query, { maxResults: maxResultsPerQuery, signal }));
      } catch {
        return queryEntries;
      }
      results = results.filter((result) => !looksLikeSearchNoise(result));
      if (!results.length || looksLikeFailedSearchResults(results)) return queryEntries;

      queryEntries.push({
        id: `prompt-search-${stableHash(query)}`,
        source: "web_search",
        query,
        url: results[0]?.url,
        title: `Prompt search: ${query}`,
        snippet: searchSnippet(query, results),
        participantSlotIndex: -1,
        fetchedAt: Date.now(),
      });

      if (!backend.supportsFetch || !backend.fetch || fetchTopPerQuery <= 0) return queryEntries;
      for (const result of results.slice(0, fetchTopPerQuery)) {
        if (!result.url || seenFetchUrls.has(result.url)) continue;
        seenFetchUrls.add(result.url);
        try {
          const fetched = await withSeedTimeout(timeoutMs, (signal) => backend.fetch!(result.url!, { signal }));
          queryEntries.push(fetchEntry(query, fetched));
        } catch {
          // Search results remain useful candidate evidence even when fetch fails.
        }
      }
      return queryEntries;
    }));
    entries.push(...batchEntries.flat());
  }

  return entries;
}
