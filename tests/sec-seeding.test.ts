import { describe, expect, it, vi, afterEach } from "vitest";
import { seedSecEvidenceFromPrompt } from "../src/sec-seeding.js";

describe("SEC evidence seeding", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("skips prompts that do not look SEC/filing related", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const evidence = await seedSecEvidenceFromPrompt("What is the best lunch near me?", undefined);
    expect(evidence).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not let generic official-filings obligations trigger SEC seeding", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "In one short sentence, say what Pi Fusion does.",
      { obligations: [{ id: "describe", kind: "other", description: "Describe Pi Fusion", entities: ["Pi Fusion"], expectedEvidence: ["functional description"], preferredSourceTypes: ["vendor docs", "official filings"] }] },
    );

    expect(evidence).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not treat product-comparison purchase price/TCO prompts as SEC relevant", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Compare Dell Precision 5690, HP ZBook Fury G11, and Lenovo ThinkPad P1 Gen 7 workstation laptops for GPU, RAM, warranty, battery lifecycle, and 5-year TCO including purchase price.",
      { obligations: [{ id: "tco", kind: "calculation", description: "Compare 5-year TCO", entities: ["Dell Precision 5690", "HP ZBook Fury G11", "Lenovo ThinkPad P1 Gen 7"], expectedEvidence: ["purchase price", "warranty costs", "battery replacement"] }] },
    );

    expect(evidence).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("matches a company and returns focused filing evidence", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("company_tickers.json")) {
        return new Response(JSON.stringify({
          "0": { cik_str: 1234567, ticker: "XRET", title: "EXAMPLE RETAIL REIT INC" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0001234567.json")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["10-Q"],
            filingDate: ["2024-04-30"],
            accessionNumber: ["0000123456-24-000001"],
            primaryDocument: ["xret-20240331.htm"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response(`${"intro ".repeat(1000)}Retail Segment total revenues 123.456 operating income 45.678 Services Segment total revenues 98.765 operating income 12.345${"tail ".repeat(1000)}`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Analyze Example Retail REIT Inc Q1 2024 10-Q segment operating margin for Retail Segment and Services Segment",
      { obligations: [{ id: "segment", kind: "metric", description: "Retail Segment operating margin", entities: ["Example Retail REIT Inc", "Retail Segment"], expectedEvidence: ["total revenues", "operating income"] }] },
    );

    expect(evidence.length).toBeGreaterThanOrEqual(2);
    expect(evidence[0].title).toContain("SEC submissions");
    expect(evidence[1].fullContent).toContain("123.456");
  });

  it("uses industry context to disambiguate short company names", async () => {
    const fetchedUrls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      if (url.endsWith("company_tickers.json")) {
        return new Response(JSON.stringify({
          "0": { cik_str: 1111111, ticker: "NSRX", title: "NORTHSTAR PHARMACEUTICALS INC" },
          "1": { cik_str: 2222222, ticker: "NSRT", title: "NORTHSTAR REALTY TRUST" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0002222222.json")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["10-Q"],
            filingDate: ["2025-10-30"],
            accessionNumber: ["0002222222-25-000001"],
            primaryDocument: ["nsrt-20250930.htm"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0001111111.json")) {
        throw new Error("wrong company selected");
      }
      return new Response("Retail portfolio revenue $10 million operating income $2 million", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Analyze Northstar's real estate portfolio operating margin and debt strategy",
      { obligations: [{ id: "margin", kind: "metric", description: "Calculate real estate portfolio operating margin", entities: ["Northstar"], expectedEvidence: ["revenue", "operating income"] }] },
    );

    expect(evidence[0].title).toContain("NORTHSTAR REALTY TRUST");
    expect(fetchedUrls.some((url) => url.includes("CIK0001111111"))).toBe(false);
  });

  it("prioritizes filings that match years and quarters in the prompt", async () => {
    const fetchedUrls: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      fetchedUrls.push(url);
      if (url.endsWith("company_tickers.json")) {
        return new Response(JSON.stringify({
          "0": { cik_str: 3333333, ticker: "DATE", title: "DATE AWARE REALTY TRUST" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0003333333.json")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["10-Q", "10-Q", "10-K", "10-Q"],
            filingDate: ["2026-04-30", "2025-10-30", "2026-02-15", "2024-04-30"],
            reportDate: ["2026-03-31", "2025-09-30", "2025-12-31", "2024-03-31"],
            accessionNumber: ["0003333333-26-000001", "0003333333-25-000003", "0003333333-26-000010", "0003333333-24-000001"],
            primaryDocument: ["date-20260331.htm", "date-20250930.htm", "date-20251231.htm", "date-20240331.htm"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      return new Response("Segment revenue and operating income details", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Analyze Date Aware Realty Trust Q1 2024 Form 10-Q margin and 2025 Form 10-K debt disclosures",
      { obligations: [{ id: "dates", kind: "metric", description: "Q1 2024 margin and 2025 debt", entities: ["Date Aware Realty Trust"], expectedEvidence: ["Q1 2024 Form 10-Q", "2025 Form 10-K"] }] },
      { maxFilings: 2 },
    );

    const companyEntry = evidence[0];
    expect(companyEntry.fullContent).toContain("0003333333-24-000001");
    expect(companyEntry.fullContent).toContain("0003333333-26-000010");
    expect(companyEntry.fullContent).not.toContain("0003333333-26-000001");
    expect(fetchedUrls.some((url) => url.includes("000333333326000001"))).toBe(false);
    expect(fetchedUrls.some((url) => url.includes("000333333324000001"))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes("000333333326000010"))).toBe(true);
  });

  it("prefers numeric segment summary reports over additional-information reports", async () => {
    const fetchedReports: string[] = [];
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("company_tickers.json")) {
        return new Response(JSON.stringify({
          "0": { cik_str: 8888888, ticker: "SEGS", title: "SEGMENT SUMMARY REIT INC" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0008888888.json")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["10-Q"],
            filingDate: ["2025-04-30"],
            accessionNumber: ["0008888888-25-000001"],
            primaryDocument: ["segs-20250331.htm"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("FilingSummary.xml")) {
        return new Response(`<?xml version="1.0"?><FilingSummary><MyReports>
          <Report><ShortName>Segment Reporting - Additional Information</ShortName><LongName>Segment Reporting - Additional Information (Details)</LongName><HtmlFileName>R91.htm</HtmlFileName></Report>
          <Report><ShortName>Segment Reporting - Summary of Segment Information</ShortName><LongName>Segment Reporting - Summary of Segment Information (Details)</LongName><HtmlFileName>R92.htm</HtmlFileName></Report>
        </MyReports></FilingSummary>`, { status: 200 });
      }
      if (url.endsWith("R91.htm") || url.endsWith("R92.htm")) {
        fetchedReports.push(url);
        return new Response("Segment total revenues $120.0 million operating income $30.0 million", { status: 200 });
      }
      return new Response("generic filing text", { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Analyze Segment Summary REIT Inc segment revenue and operating income",
      { obligations: [{ id: "segment", kind: "metric", description: "segment revenue and operating income", entities: ["Segment Summary REIT Inc"], expectedEvidence: ["segment reporting", "total revenues", "operating income"] }] },
      { maxReportFiles: 1 },
    );

    expect(fetchedReports[0]).toContain("R92.htm");
    expect(evidence.some((entry) => entry.title?.includes("Summary of Segment Information"))).toBe(true);
  });

  it("adds targeted SEC interactive report evidence when FilingSummary is available", async () => {
    const fetchSpy = vi.fn(async (url: string) => {
      if (url.endsWith("company_tickers.json")) {
        return new Response(JSON.stringify({
          "0": { cik_str: 4444444, ticker: "XINT", title: "EXAMPLE INTERACTIVE REIT INC" },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.includes("CIK0004444444.json")) {
        return new Response(JSON.stringify({
          filings: { recent: {
            form: ["10-Q"],
            filingDate: ["2025-10-30"],
            accessionNumber: ["0004444444-25-000001"],
            primaryDocument: ["xint-20250930.htm"],
          } },
        }), { status: 200, headers: { "content-type": "application/json" } });
      }
      if (url.endsWith("FilingSummary.xml")) {
        return new Response(`<?xml version="1.0"?><FilingSummary><MyReports>
          <Report><ShortName>Segment Reporting</ShortName><LongName>Segment Reporting - Summary of Segment Information</LongName><HtmlFileName>R10.htm</HtmlFileName></Report>
          <Report><ShortName>Debt Details</ShortName><LongName>Debt and Credit Facility Details</LongName><HtmlFileName>R20.htm</HtmlFileName></Report>
          <Report><ShortName>Signatures</ShortName><LongName>Signatures</LongName><HtmlFileName>R99.htm</HtmlFileName></Report>
        </MyReports></FilingSummary>`, { status: 200 });
      }
      if (url.endsWith("R10.htm")) {
        return new Response(`${"intro ".repeat(500)}Retail Segment total revenues $120.0 million operating income $30.0 million${"tail ".repeat(500)}`, { status: 200 });
      }
      if (url.endsWith("R20.htm")) {
        return new Response(`${"intro ".repeat(500)}Unsecured term loan $200.0 million SOFR + 1.20% maturity 2030${"tail ".repeat(500)}`, { status: 200 });
      }
      if (url.endsWith("R99.htm")) {
        throw new Error("signatures report should not be fetched");
      }
      return new Response(`${"intro ".repeat(500)}Generic filing document for Example Interactive REIT${"tail ".repeat(500)}`, { status: 200 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const evidence = await seedSecEvidenceFromPrompt(
      "Analyze Example Interactive REIT Inc segment operating margin and term loan debt",
      { obligations: [{ id: "segment", kind: "metric", description: "Calculate Retail Segment operating margin and term loan debt", entities: ["Example Interactive REIT Inc"], expectedEvidence: ["segment reporting", "term loan"] }] },
      { maxReportFiles: 4 },
    );

    expect(evidence.some((entry) => entry.id.startsWith("sec-report-") && entry.title?.includes("Segment Reporting"))).toBe(true);
    expect(evidence.some((entry) => entry.id.startsWith("sec-report-") && entry.snippet.includes("$200.0 million"))).toBe(true);
  });
});
