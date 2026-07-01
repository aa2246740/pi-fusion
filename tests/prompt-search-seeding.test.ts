import { describe, it, expect, afterEach } from "vitest";
import {
  buildPromptDirectSourceUrls,
  buildPromptOnlyFacetQueries,
  buildPromptSearchQueries,
  seedPromptSearchEvidence,
} from "../src/prompt-search-seeding.js";
import type { ObligationPlan } from "../src/types.js";
import type { WebBackend } from "../src/web.js";

const PLAN: ObligationPlan = {
  obligations: [
    {
      id: "maternal-mortality",
      kind: "metric",
      description: "Report maternal mortality rates for both settings.",
      entities: ["Cox's Bazar Rohingya refugees", "Mae La Karen refugees"],
      timePeriod: "2017-2023",
      expectedEvidence: ["maternal mortality rate values"],
      preferredSourceTypes: ["UNHCR health information system data"],
      status: "unknown",
    },
    {
      id: "recommendation",
      kind: "recommendation",
      description: "Give a final recommendation.",
      status: "unknown",
    },
  ],
};

describe("prompt search seeding", () => {
  afterEach(() => {
    delete process.env.PI_FUSION_PROMPT_SEARCH_SEEDING;
  });

  it("builds focused queries from obligation entities and metrics", () => {
    const queries = buildPromptSearchQueries(
      "Compare maternal health outcomes for refugee camp settings.",
      PLAN,
      { maxQueries: 8 },
    );

    expect(queries.length).toBeGreaterThan(1);
    expect(queries.some((query) => query.includes("Cox's Bazar Rohingya refugees"))).toBe(true);
    expect(queries.some((query) => query.includes("Mae La Karen refugees"))).toBe(true);
    expect(queries.some((query) => query.includes("maternal mortality"))).toBe(true);
    expect(queries.every((query) => query.length <= 260)).toBe(true);
  });

  it("balances query slots across product-spec topics instead of letting TCO crowd out specs", () => {
    const productPlan: ObligationPlan = {
      obligations: [
        {
          id: "gpu-dell",
          kind: "metric",
          description: "Determine GPU rendering performance for Dell Precision 5690.",
          entities: ["Dell Precision 5690"],
          expectedEvidence: ["available GPU options", "VRAM", "GPU power limits"],
          status: "unknown",
        },
        {
          id: "thermal-hp",
          kind: "metric",
          description: "Evaluate HP ZBook Fury G11 thermal management under sustained rendering loads.",
          entities: ["HP ZBook Fury G11"],
          expectedEvidence: ["cooling design", "sustained performance evidence"],
          status: "unknown",
        },
        {
          id: "ram-lenovo",
          kind: "metric",
          description: "Determine Lenovo ThinkPad P1 Gen 7 RAM expandability toward 128GB.",
          entities: ["Lenovo ThinkPad P1 Gen 7"],
          expectedEvidence: ["maximum supported RAM", "LPCAMM2 details"],
          status: "unknown",
        },
        {
          id: "support-uae",
          kind: "metric",
          description: "Identify UAE enterprise support options.",
          entities: ["Dell", "HP", "Lenovo"],
          expectedEvidence: ["onsite support availability", "warranty/service plans"],
          status: "unknown",
        },
        {
          id: "five-year-tco",
          kind: "metric",
          description: "Address initial purchase/configuration cost as a factor in 5-year TCO.",
          entities: [
            "Dell Precision 5690",
            "HP ZBook Fury G11",
            "Lenovo ThinkPad P1 Gen 7",
            "Case ID: 00000000-0000-4000-8000-000000000000",
          ],
          timePeriod: "5 years",
          expectedEvidence: ["typical configuration price", "8-unit fleet scaling"],
          status: "unknown",
        },
      ],
    };

    const queries = buildPromptSearchQueries(
      "Compare Dell Precision 5690, HP ZBook Fury G11, and Lenovo ThinkPad P1 Gen 7 for a Dubai architecture firm.",
      productPlan,
      { maxQueries: 15 },
    );

    expect(queries).toHaveLength(15);
    expect(queries.some((query) => /\bGPU\b|VRAM|TGP/i.test(query))).toBe(true);
    expect(queries.some((query) => /thermal|sustained|operating temperature/i.test(query))).toBe(true);
    expect(queries.some((query) => /RAM|memory|LPCAMM|SODIMM/i.test(query))).toBe(true);
    expect(queries.some((query) => /UAE|onsite|warranty|SLA/i.test(query))).toBe(true);
    expect(queries.some((query) => /TCO|price|cost|5 years/i.test(query))).toBe(true);
    expect(queries.some((query) => /Case ID|00000000-0000-4000-8000-000000000000/i.test(query))).toBe(false);
    for (const product of ["Dell Precision 5690", "HP ZBook Fury G11", "Lenovo ThinkPad P1 Gen 7"]) {
      expect(queries.filter((query) => query.includes(product)).length).toBeGreaterThanOrEqual(5);
    }
  });

  it("adds public-health source-targeted facets for exact indicator prompts", () => {
    const queries = buildPromptSearchQueries(
      "Analyze antenatal care, skilled birth attendance, postpartum hemorrhage, neonatal mortality, midwife ratios, and EmONC access for Cox's Bazar Rohingya refugees versus Mae La Karen refugees using UNHCR HIS and MSF reports.",
      PLAN,
      { maxQueries: 14 },
    );

    expect(queries.some((query) => /site:unhcr\.org/i.test(query))).toBe(true);
    expect(queries.some((query) => /site:msf\.org/i.test(query))).toBe(true);
    expect(queries.some((query) => /ANC4|antenatal care 4\+/i.test(query))).toBe(true);
    expect(queries.some((query) => /postpartum|PPH|hemorrhage|haemorrhage/i.test(query))).toBe(true);
    expect(queries.some((query) => /EmONC|referral|transport/i.test(query))).toBe(true);
  });

  it("adds prompt-derived direct public-health source candidates for named refugee settings", () => {
    const urls = buildPromptDirectSourceUrls(
      "Analyze maternal mortality, ANC4, skilled birth attendance, PPH, and neonatal mortality for Cox's Bazar Rohingya refugees versus Mae La Karen refugees using UNHCR HIS, MSF, UNFPA, MPMSR, and SMRU sources.",
    );

    expect(urls.slice(0, 8).some((url) => /CXB-Health-Sector-Bulletin/i.test(url))).toBe(true);
    expect(urls.slice(0, 8).some((url) => /mpmsr_annual_report_2021\.pdf/i.test(url))).toBe(true);
    expect(urls.slice(0, 8).some((url) => /PMC9024274/i.test(url))).toBe(true);
    expect(urls.slice(0, 8).some((url) => /PMC7888086/i.test(url))).toBe(true);
    expect(urls.slice(0, 8).some((url) => /PMC11091483|journal\.pone\.0072721/i.test(url))).toBe(true);
    expect(urls.some((url) => /unfpa\.org\/coxs-bazar-bangladesh/i.test(url))).toBe(true);
    expect(urls.some((url) => /mpmsr_annual_report_2021\.pdf/i.test(url))).toBe(true);
    expect(urls.some((url) => /pmc\.ncbi\.nlm\.nih\.gov\/articles\/PMC4332741/i.test(url))).toBe(true);
    expect(urls.some((url) => /frontiersin\.org\/journals\/public-health/i.test(url))).toBe(true);
    expect(urls.some((url) => /gh\.bmj\.com\/content\/7\/4\/e008110/i.test(url))).toBe(true);
    expect(urls.some((url) => /journals\.plos\.org\/plosone\/article/i.test(url))).toBe(true);
  });

  it("adds finance facets for SEC filing extraction tasks", () => {
    const financePlan: ObligationPlan = {
      obligations: [
        {
          id: "segment-margin",
          kind: "calculation",
          description: "Calculate Q1 2024 Core Portfolio and Funds operating margins.",
          entities: ["Acadia", "Core Portfolio", "Funds segment"],
          timePeriod: "Q1 2024",
          expectedEvidence: ["segment revenue", "operating income"],
          preferredSourceTypes: ["SEC filings"],
          status: "unknown",
        },
        {
          id: "renaissance-debt",
          kind: "calculation",
          description: "Calculate 2025 net debt increase from term loan drawdown and Renaissance principal paydown.",
          entities: ["Acadia", "Renaissance Portfolio"],
          timePeriod: "2025",
          expectedEvidence: ["term loan drawdown", "principal paydown", "mortgage debt"],
          preferredSourceTypes: ["SEC filings"],
          status: "unknown",
        },
      ],
    };

    const queries = buildPromptSearchQueries(
      "Analyze Acadia Q1 2024 segment margins, Renaissance Portfolio purchase price and debt assumption, impairments, term loan drawdown, and 2025 principal paydown.",
      financePlan,
      { maxQueries: 20 },
    );

    expect(queries.some((query) => /site:sec\.gov/i.test(query))).toBe(true);
    expect(queries.some((query) => /Q1 2024.*segment.*operating income/i.test(query))).toBe(true);
    expect(queries.some((query) => /Renaissance Portfolio/i.test(query) && /purchase price/i.test(query) && /mortgage|debt/i.test(query))).toBe(true);
    expect(queries.some((query) => /term loan.*principal paydown/i.test(query))).toBe(true);
  });

  it("adds finance direct SEC follow-ups for portfolio-strategy filing prompts", () => {
    const urls = buildPromptDirectSourceUrls(
      "Analyze whether Acadia's evolving portfolio strategy demonstrates effective capital allocation and risk management across its diversified real estate platform. Calculate Q1 2024 Core Portfolio and Funds margins, examine the Renaissance Portfolio acquisition, impairment charges across Fund III and Fund IV, and evaluate term loan drawdown and principal paydown in 2025.",
    );
    const decoded = urls.map((url) => decodeURIComponent(url).replace(/\+/g, " ")).join("\n");

    expect(decoded).toContain('"Acadia Realty Trust" "REIT" "10-K"');
    expect(decoded).toContain('"Renaissance Portfolio" "loss on change in control"');
    expect(decoded).toContain('"Renaissance Portfolio" "SOFR" "spread"');
    expect(decoded).toContain('"Renaissance Portfolio" "modified" "loans" "SOFR"');
    expect(decoded).toContain('"mortgages payable" "Renaissance Portfolio" "interest rate" "maturity"');
    expect(decoded).toContain('"property mortgage" "reduced interest rate" "basis points" "paydown"');
    expect(decoded).toContain('"Renaissance Portfolio" "primarily located" "Washington"');
    expect(decoded).toContain('"term loan" "SOFR" "maturity"');
    expect(decoded).toContain('"ATM Program" "settled forward shares" "proceeds"');
    expect(decoded).toContain('"ATM forward sale agreements" "aggregate net value" "settlement"');
    expect(decoded).toContain('"ATM Forward Sale Agreements" "Aggregate Value" "Average Net Share Price" "Aggregate Net Value"');
    expect(decoded).toContain('"common shares offered" "aggregate value" "aggregate net value" "ATM"');
    expect(decoded).toContain('"physically settled" "forward sale agreements" "net proceeds"');
    expect(decoded).toContain('"Investment Management" "operating income" "Three Months Ended September 30"');
    expect(decoded).toContain('"Investment Management" "fee income" "assets under management" "structured financing"');
    expect(decoded).toContain('"REIT Portfolio" "Rental Revenue" "Three Months Ended September 30"');
    expect(decoded).toContain('"REIT" "IM" "Rental revenue" "Operating income" "Increase Decrease"');
    expect(decoded).toContain('"2024 Form 10-K" "portfolio strategy"');
    expect(decoded).not.toContain("May 29 2030");
    expect(decoded).not.toContain("March 2025");
  });

  it("adds affiliate marketplace and partner-program facets", () => {
    const affiliatePlan: ObligationPlan = {
      obligations: [
        {
          id: "supermoney-affiliate",
          kind: "source",
          description: "Determine how SuperMoney affiliates or publishers use its marketplace.",
          entities: ["SuperMoney", "credit cards", "personal loans"],
          expectedEvidence: ["affiliate program", "publisher tools", "soft credit check"],
          preferredSourceTypes: ["official product pages"],
          status: "unknown",
        },
        {
          id: "novae-products",
          kind: "source",
          description: "Determine what Novae provides for debt relief, trust and will, life insurance, and business credit.",
          entities: ["Novae", "debt relief", "trust and will", "business credit"],
          expectedEvidence: ["official products", "partner program"],
          preferredSourceTypes: ["official product pages"],
          status: "unknown",
        },
      ],
    };

    const queries = buildPromptSearchQueries(
      "Explain how a credit repair affiliate company might use SuperMoney and Novae for financial services pages.",
      affiliatePlan,
      { maxQueries: 12 },
    );

    expect(queries.some((query) => /site:supermoney\.com/i.test(query))).toBe(true);
    expect(queries.some((query) => /site:novae\.com/i.test(query))).toBe(true);
    expect(queries.some((query) => /publisher|affiliate|partner/i.test(query))).toBe(true);
    expect(queries.some((query) => /soft credit check|marketplace/i.test(query))).toBe(true);
  });

  it("adds direct affiliate marketplace and partner-program source candidates", () => {
    const urls = buildPromptDirectSourceUrls(
      "Map how SuperMoney publisher tools and Novae trust, will, life insurance, debt relief, and business credit products fit an affiliate referral strategy.",
    );

    expect(urls.some((url) => /supermoney\.com\/monetize/i.test(url))).toBe(true);
    expect(urls.some((url) => /help\.supermoney\.com\/article\/47/i.test(url))).toBe(true);
    expect(urls.some((url) => /novaemoney\.com\/base\/wills/i.test(url))).toBe(true);
    expect(urls.some((url) => /novaemoney\.com\/base\/life-insurance/i.test(url))).toBe(true);
    expect(urls.some((url) => /novaemoney\.com\/base\/cobrand-program/i.test(url))).toBe(true);
  });

  it("does not treat ordinary finance trust/will wording as affiliate source intent", () => {
    const prompt = "Analyze Acadia Realty Trust filings and explain what changed in Q1 2024; the answer will need 10-Q and 10-K evidence.";
    const urls = buildPromptDirectSourceUrls(prompt);
    const queries = buildPromptSearchQueries(prompt, undefined, { maxQueries: 12 });

    expect(urls.some((url) => /supermoney|novae/i.test(url))).toBe(false);
    expect(queries.some((query) => /site:supermoney\.com|site:novae\.com/i.test(query))).toBe(false);
    expect(queries.some((query) => /site:sec\.gov/i.test(query))).toBe(true);
  });

  it("strips benchmark harness text from prompt-targeted queries", () => {
    const queries = buildPromptSearchQueries(
      "/pi-fusion --quality DRACO 10-case benchmark generation. Case 1/1. Protocol: use public evidence only. Task: Analyze Acadia Realty Trust Q1 2024 Core Portfolio and Funds operating margins from SEC filings.",
      undefined,
      { maxQueries: 8 },
    );

    expect(queries.length).toBeGreaterThan(0);
    expect(queries.some((query) => /Acadia Realty Trust|Q1 2024|Core Portfolio/i.test(query))).toBe(true);
    expect(queries.every((query) => !/DRACO|benchmark generation|Protocol|Case 1\/1/i.test(query))).toBe(true);
  });

  it("adds SEC efts direct searches and follows accessions to FilingSummary report tables", async () => {
    const fetchedUrls: string[] = [];
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: false,
      supportsFetch: true,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        throw new Error("should not search");
      },
      async fetch(url) {
        fetchedUrls.push(url);
        if (/efts\.sec\.gov/i.test(url)) {
          return {
            url,
            title: "SEC search",
            text: JSON.stringify({
              hits: {
                hits: [{
                  _id: "0000950170-24-050536:akr-20240331.htm",
                  _source: { ciks: ["0000899629"], form: "10-Q" },
                }],
              },
            }),
          };
        }
        if (/FilingSummary\.xml/i.test(url)) {
          return {
            url,
            title: "FilingSummary",
            text: `<FilingSummary><MyReports>
              <Report><HtmlFileName>R22.htm</HtmlFileName><ShortName>Segment Reporting</ShortName><LongName>Segment Reporting</LongName></Report>
              <Report><HtmlFileName>R38.htm</HtmlFileName><ShortName>Segment Reporting (Tables)</ShortName><LongName>Segment Reporting Tables</LongName></Report>
              <Report><HtmlFileName>R70.htm</HtmlFileName><ShortName>Summary of Consolidated Indebtedness</ShortName><LongName>Debt Tables</LongName></Report>
              <Report><HtmlFileName>R80.htm</HtmlFileName><ShortName>Management's Discussion and Analysis</ShortName><LongName>Results of Operations and Liquidity</LongName></Report>
              <Report><HtmlFileName>R81.htm</HtmlFileName><ShortName>Stockholders' Equity</ShortName><LongName>ATM Forward Sale Agreements and Common Share Issuance</LongName></Report>
              <Report><HtmlFileName>R82.htm</HtmlFileName><ShortName>Rental Revenue</ShortName><LongName>REIT Portfolio Rental Revenue Same-Property NOI</LongName></Report>
            </MyReports></FilingSummary>`,
          };
        }
        return {
          url,
          title: "SEC report",
          text: "Core Portfolio revenue operating income Funds segment revenue operating income term loan debt table.",
        };
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Analyze Acadia Realty Trust Q1 2024 Core Portfolio and Funds operating margins, Renaissance Portfolio debt, term loan, and impairments using SEC filings.",
      undefined,
      backend,
      { maxQueries: 0, timeoutMs: 1000 },
    );

    expect(fetchedUrls.some((url) => /efts\.sec\.gov\/LATEST\/search-index/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/akr-20240331\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /sec\.gov\/ix\?doc=\/Archives\/edgar\/data\/899629\/000095017024050536\/akr-20240331\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/FilingSummary\.xml/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/R38\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/R70\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/R80\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/R81\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /000095017024050536\/R82\.htm/i.test(url))).toBe(true);
    expect(entries.some((entry) => /R38\.htm/i.test(entry.url ?? ""))).toBe(true);
    expect(entries.some((entry) => /segment reporting summary segment information Core Portfolio Funds/i.test(entry.query ?? ""))).toBe(true);
    expect(entries.some((entry) => /debt term loan borrowing principal paydown/i.test(entry.query ?? ""))).toBe(true);
  });

  it("filters SEC efts follow-up accessions to the prompt company when display names are available", async () => {
    const fetchedUrls: string[] = [];
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: false,
      supportsFetch: true,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        throw new Error("should not search");
      },
      async fetch(url) {
        fetchedUrls.push(url);
        if (/efts\.sec\.gov/i.test(url)) {
          return {
            url,
            title: "SEC search",
            text: JSON.stringify({
              hits: {
                hits: [
                  {
                    _id: "0000950170-24-050536:akr-20240331.htm",
                    _source: { ciks: ["0000899629"], form: "10-Q", display_names: ["ACADIA REALTY TRUST (AKR) (CIK 0000899629)"] },
                  },
                  {
                    _id: "0000912242-24-000083:mac-20240331x10qexhibit105.htm",
                    _source: { ciks: ["0000912242"], form: "EX-10.5", display_names: ["MACERICH CO (MAC) (CIK 0000912242)"] },
                  },
                ],
              },
            }),
          };
        }
        return {
          url,
          title: "SEC document",
          text: "Core Portfolio revenue operating income Funds segment revenue operating income.",
        };
      },
    };

    await seedPromptSearchEvidence(
      "Analyze Acadia Realty Trust Q1 2024 Core Portfolio and Funds operating margins, Renaissance Portfolio debt, term loan, and impairments using SEC filings.",
      undefined,
      backend,
      { maxQueries: 0, timeoutMs: 1000 },
    );

    expect(fetchedUrls.some((url) => /899629\/000095017024050536\/akr-20240331\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /912242\/000091224224000083/i.test(url))).toBe(false);
    expect(fetchedUrls.some((url) => /mac-20240331x10qexhibit105/i.test(url))).toBe(false);
  });

  it("prioritizes SEC efts follow-ups for latest quarterly filing trend evidence", async () => {
    const fetchedUrls: string[] = [];
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: false,
      supportsFetch: true,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        throw new Error("should not search");
      },
      async fetch(url) {
        fetchedUrls.push(url);
        if (/efts\.sec\.gov/i.test(url)) {
          return {
            url,
            title: "SEC search",
            text: JSON.stringify({
              hits: {
                hits: [
                  {
                    _id: "0001193125-25-256341:akr-20250930.htm",
                    _source: { ciks: ["0000899629"], form: "10-Q", display_names: ["ACADIA REALTY TRUST (AKR) (CIK 0000899629)"] },
                  },
                  {
                    _id: "0000950170-25-100264:akr-20250630.htm",
                    _source: { ciks: ["0000899629"], form: "10-Q", display_names: ["ACADIA REALTY TRUST (AKR) (CIK 0000899629)"] },
                  },
                ],
              },
            }),
          };
        }
        if (/FilingSummary\.xml/i.test(url)) {
          return {
            url,
            title: "FilingSummary",
            text: `<FilingSummary><MyReports>
              <Report><HtmlFileName>R80.htm</HtmlFileName><ShortName>Management's Discussion and Analysis</ShortName><LongName>Results of Operations and Liquidity</LongName></Report>
              <Report><HtmlFileName>R82.htm</HtmlFileName><ShortName>Rental Revenue</ShortName><LongName>REIT Portfolio Rental Revenue Same-Property NOI</LongName></Report>
            </MyReports></FilingSummary>`,
          };
        }
        return {
          url,
          title: "SEC report",
          text: "Investment Management operating income decreased; REIT Portfolio rental revenue increased for the three months ended September 30.",
        };
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Analyze Acadia Realty Trust Investment Management operating income and REIT Portfolio rental revenue for the three months ended September 30 using SEC filings.",
      undefined,
      backend,
      { maxQueries: 0, timeoutMs: 1000 },
    );

    expect(fetchedUrls.some((url) => /899629\/000119312525256341\/akr-20250930\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /899629\/000119312525256341\/FilingSummary\.xml/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /899629\/000119312525256341\/R80\.htm/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /899629\/000119312525256341\/R82\.htm/i.test(url))).toBe(true);
    expect(entries.some((entry) => /000119312525256341\/R80\.htm/i.test(entry.url ?? ""))).toBe(true);
  });

  it("adds ERP UX facets and direct official source candidates", () => {
    const prompt = "Compare SAP Fiori and Oracle NetSuite UX patterns for inventory, work orders, global search, dashboards, object pages, wizards, and ERP adoption.";
    const queries = buildPromptSearchQueries(prompt, undefined, { maxQueries: 12 });
    const promptOnlyQueries = buildPromptOnlyFacetQueries(prompt);
    const urls = buildPromptDirectSourceUrls(prompt);

    expect(promptOnlyQueries.some((query) => /site:sap\.com\/design-system\/fiori-design-web/i.test(query))).toBe(true);
    expect(queries.some((query) => /site:sap\.com\/design-system\/fiori-design-web/i.test(query))).toBe(true);
    expect(queries.some((query) => /site:docs\.oracle\.com\/en\/cloud\/saas\/netsuite/i.test(query))).toBe(true);
    expect(queries.some((query) => /site:nngroup\.com/i.test(query))).toBe(true);
    expect(urls.some((url) => /sap\.com\/design-system\/fiori-design-web/i.test(url))).toBe(true);
    expect(urls.some((url) => /docs\.oracle\.com\/en\/cloud\/saas\/netsuite/i.test(url))).toBe(true);
    expect(urls.some((url) => /nngroup\.com\/articles\/wizards/i.test(url))).toBe(true);
    expect(urls.some((url) => /prosci\.com\/blog\/the-case-for-change-management/i.test(url))).toBe(true);
  });

  it("seeds search and fetch evidence with a web backend", async () => {
    const calls: string[] = [];
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: true,
      supportsFetch: true,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search(query) {
        calls.push(query);
        return [{
          title: "Official report",
          url: "https://example.org/report",
          snippet: "Maternal mortality and skilled birth attendance values.",
        }];
      },
      async fetch(url) {
        return {
          url,
          title: "Official report",
          text: "Full report text with maternal mortality values and definitions.",
        };
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Compare maternal health outcomes for refugee camp settings.",
      PLAN,
      backend,
      { maxQueries: 1, maxResultsPerQuery: 1, fetchTopPerQuery: 1, timeoutMs: 1000 },
    );

    expect(calls).toHaveLength(1);
    expect(entries.map((entry) => entry.source)).toEqual(["web_search", "web_fetch"]);
    expect(entries[0].snippet).toContain("Official report");
    expect(entries[1].fullContent).toContain("Full report text");
  });

  it("filters browser fallback noise from search evidence", async () => {
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: true,
      supportsFetch: false,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        return [
          {
            title: "Apple Safari",
            url: "https://www.apple.com/support/safari/",
            snippet: "Learn how to use Safari.",
          },
          {
            title: "Microsoft Edge",
            url: "https://support.microsoft.com/en-us/microsoft-edge",
            snippet: "Update Microsoft Edge and manage browser settings.",
          },
          {
            title: "Google Chrome",
            url: "https://support.google.com/chrome/answer/95346",
            snippet: "Turn JavaScript on or off.",
          },
          {
            title: "Firefox Browser",
            url: "https://support.mozilla.org/en-US/products/firefox",
            snippet: "Firefox browser support.",
          },
          {
            title: "Mozilla Firefox",
            url: "https://support.mozilla.org/en-US/kb/javascript-settings-for-interactive-web-pages",
            snippet: "JavaScript settings and preferences for interactive web pages.",
          },
          {
            title: "Opera",
            url: "https://help.opera.com/latest/web-preferences",
            snippet: "Manage JavaScript and browser web preferences.",
          },
          {
            title: "Maternal health report",
            url: "https://example.org/maternal-health",
            snippet: "Antenatal care and neonatal mortality values.",
          },
        ];
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Compare maternal health outcomes for refugee camp settings.",
      PLAN,
      backend,
      { maxQueries: 1, maxResultsPerQuery: 2, fetchTopPerQuery: 0, timeoutMs: 1000 },
    );

    expect(entries).toHaveLength(1);
    expect(entries[0].snippet).not.toContain("Apple Safari");
    expect(entries[0].snippet).toContain("Maternal health report");
  });

  it("seeds direct prompt-derived sources even when search is unavailable", async () => {
    const fetchedUrls: string[] = [];
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: false,
      supportsFetch: true,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        throw new Error("should not search");
      },
      async fetch(url) {
        fetchedUrls.push(url);
        return {
          url,
          title: "Direct source",
          text: `Direct source text for ${url}`,
        };
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Analyze maternal mortality and antenatal care for Cox's Bazar Rohingya refugees versus Mae La Karen refugees using UNFPA, MPMSR, and SMRU sources.",
      PLAN,
      backend,
      { maxQueries: 0, timeoutMs: 1000 },
    );

    expect(fetchedUrls.length).toBeGreaterThan(2);
    expect(fetchedUrls.some((url) => /unfpa\.org|rohingyaresponse\.org/i.test(url))).toBe(true);
    expect(fetchedUrls.some((url) => /pmc\.ncbi\.nlm\.nih\.gov/i.test(url))).toBe(true);
    expect(entries.every((entry) => entry.source === "web_fetch")).toBe(true);
    expect(entries[0].fullContent).toContain("## Focus:");
    expect(entries[0].query).toContain("antenatal care ANC4");
    expect(entries[0].query).toContain("neonatal mortality");
  });

  it("balances direct prompt-derived sources across compared public-health settings", () => {
    const urls = buildPromptDirectSourceUrls(
      "Analyze maternal mortality and antenatal care for Cox's Bazar Rohingya refugees versus Mae La Karen refugees using UNFPA, MPMSR, and SMRU sources.",
    );

    expect(urls.slice(0, 4).some((url) => /coxs-bazar|rohingya|unfpa/i.test(url))).toBe(true);
    expect(urls.slice(0, 4).some((url) => /PMC11091483|journals\.plos|PMC4332741|pubmed\.ncbi/i.test(url))).toBe(true);
    expect(urls.findIndex((url) => /PMC4332741|pubmed\.ncbi|journals\.plos/i.test(url))).toBeLessThan(6);
  });

  it("does not seed provider error text as search evidence", async () => {
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: true,
      supportsFetch: false,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        return [{
          title: "Search result",
          snippet: "MCP error -429: {\"error\":{\"code\":\"1310\",\"message\":\"您已达到每周/每月使用上限\"}}",
          provider: "glm",
        }];
      },
    };

    const entries = await seedPromptSearchEvidence(
      "Compare maternal health outcomes for refugee camp settings.",
      PLAN,
      backend,
      { maxQueries: 1, timeoutMs: 1000 },
    );

    expect(entries).toEqual([]);
  });

  it("can be disabled with an environment variable", async () => {
    process.env.PI_FUSION_PROMPT_SEARCH_SEEDING = "0";
    const backend: WebBackend = {
      name: "fake",
      supportsSearch: true,
      supportsFetch: false,
      async status() {
        return { ok: true, backend: "fake", message: "ok", tools: [] };
      },
      async search() {
        throw new Error("should not search");
      },
    };

    await expect(seedPromptSearchEvidence("question", PLAN, backend)).resolves.toEqual([]);
  });
});
