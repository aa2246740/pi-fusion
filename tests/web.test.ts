import { describe, it, expect } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createMcpWebBackend, dataUnhcrDownloadUrlForDetails, extractMcpText, isLikelyPdfFetchUrl, isSecInteractiveReportUrl, parseFetchResultFromMcpText, parseSearchResultsFromMcpText, rankSearchResultsForQuery, secHtmlTablesToMarkdown, secHtmlToReadableText } from "../src/web.js";

describe("web backend helpers", () => {
  it("extracts text content from MCP tool results", () => {
    const text = extractMcpText({
      content: [
        { type: "text", text: "[provider: minimax]\n" },
        { type: "text", text: "{\"organic\":[]}" },
      ],
    });
    expect(text).toContain("provider: minimax");
    expect(text).toContain("organic");
  });

  it("parses unified-search organic results", () => {
    const results = parseSearchResultsFromMcpText(`[provider: minimax]\n{
      "organic": [
        {"title": "Official Spec", "link": "https://example.com/spec", "snippet": "A useful source", "date": "2026-01-01"},
        {"title": "Second", "link": "https://example.com/second", "snippet": "Another source"}
      ]
    }`, 1);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Official Spec");
    expect(results[0].url).toBe("https://example.com/spec");
    expect(results[0].provider).toBe("minimax");
  });

  it("filters browser-support noise from parsed search results", () => {
    const results = parseSearchResultsFromMcpText(`[provider: minimax]\n{
      "organic": [
        {"title": "Apple Safari", "link": "https://www.apple.com/support/safari/", "snippet": "開啟 Safari 並前往偏好設定，勾選啟用 JavaScript。"},
        {"title": "Microsoft Edge", "link": "https://support.microsoft.com/en-us/microsoft-edge", "snippet": "Update Microsoft Edge and manage browser settings."},
        {"title": "Google Chrome", "link": "https://support.google.com/chrome/answer/95346", "snippet": "Turn JavaScript on or off."},
        {"title": "Firefox Browser", "link": "https://support.mozilla.org/en-US/products/firefox", "snippet": "Firefox browser support."},
        {"title": "Mozilla Firefox", "link": "https://support.mozilla.org/en-US/kb/javascript-settings-for-interactive-web-pages", "snippet": "JavaScript settings and preferences for interactive web pages."},
        {"title": "Opera", "link": "https://help.opera.com/latest/web-preferences", "snippet": "Manage JavaScript and web preferences."},
        {"title": "啟用 JavaScript 才能使用搜尋功能", "link": "https://www.google.com/search?q=Acadia+Realty+Trust", "snippet": "請啟用 JavaScript 後再搜尋。"},
        {"title": "Rohingya maternal health report", "link": "https://example.org/rohingya-health", "snippet": "Antenatal care and neonatal mortality indicators."}
      ]
    }`, 5);

    expect(results).toHaveLength(1);
    expect(results[0].title).toBe("Rohingya maternal health report");
  });

  it("falls back to a single text result when output is not JSON", () => {
    const results = parseSearchResultsFromMcpText("plain text search summary", 5);
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("plain text");
  });

  it("does not convert search quota failures into evidence results", () => {
    const results = parseSearchResultsFromMcpText(
      "[provider: minimax] Failed to perform search: API Error: 2056-已达到 Token Plan 用量上限：请升级 Token Plan 套餐或购买积分补充用量。",
      5,
    );

    expect(results).toEqual([]);
  });

  it("does not convert MCP search error text into evidence results", () => {
    const results = parseSearchResultsFromMcpText(
      '[provider: glm]\n\nMCP error -429: {"error":{"code":"1310","message":"您已达到每周/每月使用上限，您的限额将在 2026-07-16 14:30:11 重置。"}}',
      5,
    );

    expect(results).toEqual([]);
  });

  it("reranks parsed results by generic query-term relevance", () => {
    const ranked = rankSearchResultsForQuery([
      { title: "Official annual report", url: "https://official.example.org/report", snippet: "general service overview" },
      { title: "Neonatal mortality surveillance audit", url: "https://data.example.org/audit", snippet: "maternal and neonatal mortality registry" },
    ], "neonatal mortality surveillance");

    expect(ranked[0].title).toBe("Neonatal mortality surveillance audit");
  });

  it("boosts authoritative global-health sources for public-health search results", () => {
    const ranked = rankSearchResultsForQuery([
      { title: "Popular summary", url: "https://random-blog.example/maternal-health", snippet: "maternal mortality and refugee health overview with many query terms" },
      { title: "UNHCR health information system report", url: "https://data.unhcr.org/en/documents/details/123", snippet: "Rohingya refugee maternal health indicator dashboard" },
    ], "Rohingya refugee maternal mortality UNHCR health information system");

    expect(ranked[0].url).toContain("data.unhcr.org");
  });

  it("demotes off-topic tech documentation for public-health queries", () => {
    const ranked = rankSearchResultsForQuery([
      { title: "MapObjectCollectionItem ReportingServices Method", url: "https://msdn.microsoft.com/library/reportingservices", snippet: "health information system report indicator collection documentation" },
      { title: "UNHCR refugee health information system dashboard", url: "https://data.unhcr.org/en/documents/details/123", snippet: "maternal health indicators for refugee camps" },
    ], "UNHCR health information system maternal mortality refugee camp");

    expect(ranked[0].url).toContain("data.unhcr.org");
  });

  it("recognizes SEC interactive report URLs and preserves table cells", () => {
    expect(isSecInteractiveReportUrl("https://www.sec.gov/Archives/edgar/data/899629/000119312525256341/R19.htm")).toBe(true);
    expect(isSecInteractiveReportUrl("https://www.sec.gov/Archives/edgar/data/899629/000119312525256341/akr-20250930.htm")).toBe(false);
    expect(isSecInteractiveReportUrl("https://example.com/Archives/edgar/data/899629/000119312525256341/R19.htm")).toBe(false);

    const text = secHtmlToReadableText(`<table><tr><th>Owner</th><th>Total</th></tr><tr><td>Fund III</td><td>$7,240</td></tr></table>`);
    expect(text).toContain("Owner | Total");
    expect(text).toContain("Fund III | $7,240");
  });

  it("extracts readable markdown from SEC filing HTML tables", () => {
    const html = `
      <p>The following tables set forth certain segment information for the Company (in thousands):</p>
      <table>
        <tr><td>&#xa0;</td><td colspan="10">As of or for the Three Months Ended March 31, 2024</td></tr>
        <tr><td>&#xa0;</td><td>Core<br>Portfolio</td><td>Funds</td><td>Structured<br>Financing</td><td>Unallocated</td><td>Total</td></tr>
        <tr><td>Total Revenues</td><td>53,538</td><td>37,818</td><td>&#x2014;</td><td>&#x2014;</td><td>91,356</td></tr>
        <tr><td>Operating income</td><td>17,352</td><td>6,424</td><td>&#x2014;</td><td>(</td><td>9,768</td><td>)</td><td>14,008</td></tr>
      </table>
    `;

    const markdown = secHtmlTablesToMarkdown(html);
    expect(markdown).toContain('SEC HTML table near "The following tables set forth certain segment information"');
    expect(markdown).toContain("| Core Portfolio | Funds | Structured Financing | Unallocated | Total |");
    expect(markdown).toContain("| Total Revenues | 53,538 | 37,818 | — | — | 91,356 |");
    expect(markdown).toContain("| Operating income | 17,352 | 6,424 | — | (9,768) | 14,008 |");
  });

  it("does not label distant unrelated SEC tables as near an exact filing term", () => {
    const html = `
      <p>The $250.0 Million Term Loan bears interest at SOFR + 1.20% and matures on May 29, 2030.</p>
      ${"<p>unrelated narrative</p>".repeat(6000)}
      <table>
        <tr><td>Number of Shares</td><td>Aggregate Net Value</td></tr>
        <tr><td>ATM Forward Sale Agreements</td><td>258,642</td></tr>
      </table>
    `;

    const markdown = secHtmlTablesToMarkdown(html);
    expect(markdown).not.toContain('SEC HTML table near "SOFR + 1.20"');
    expect(markdown).not.toContain('SEC HTML table near "May 29, 2030"');
    expect(markdown).toContain('SEC HTML table near "forward sale"');
  });

  it("detects likely PDF and humanitarian document-download fetch URLs", () => {
    expect(isLikelyPdfFetchUrl("https://example.org/report.pdf")).toBe(true);
    expect(isLikelyPdfFetchUrl("https://data.unhcr.org/en/documents/download/84918")).toBe(true);
    expect(isLikelyPdfFetchUrl("https://reliefweb.int/attachments/abc/report")).toBe(true);
    expect(isLikelyPdfFetchUrl("https://data.unhcr.org/en/documents/details/84918")).toBe(false);
    expect(isLikelyPdfFetchUrl("https://example.org/page.html")).toBe(false);
  });

  it("derives attached PDF download URLs for UNHCR document details pages", () => {
    expect(dataUnhcrDownloadUrlForDetails("https://data.unhcr.org/en/documents/details/84918")).toBe("https://data.unhcr.org/en/documents/download/84918");
    expect(dataUnhcrDownloadUrlForDetails("https://data.unhcr.org/es/documents/details/111234")).toBe("https://data.unhcr.org/es/documents/download/111234");
    expect(dataUnhcrDownloadUrlForDetails("https://data.unhcr.org/en/situations/myanmar_refugees")).toBeUndefined();
  });

  it("parses Zhipu webReader nested JSON string output", () => {
    const fetched = parseFetchResultFromMcpText(
      `"{\\"title\\":\\"Example Domain\\",\\"url\\":\\"https://example.com\\",\\"content\\":\\"Readable page text\\",\\"metadata\\":{\\"lang\\":\\"en\\"}}"`,
      "https://example.com",
    );

    expect(fetched.title).toBe("Example Domain");
    expect(fetched.url).toBe("https://example.com");
    expect(fetched.text).toBe("Readable page text");
    expect(fetched.metadata?.lang).toBe("en");
  });

  it("loads hardened scraper fallback when the run cwd has no node_modules", async () => {
    const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "pi-fusion-web-"));
    const scraperRoot = path.join(tmp, "pi-scraper-hardened");
    const toolPath = path.join(scraperRoot, "src", "tools", "web-scrape.ts");
    const isolatedCwd = path.join(tmp, "scratch-cwd");
    await fs.mkdir(path.dirname(toolPath), { recursive: true });
    await fs.mkdir(isolatedCwd, { recursive: true });
    await fs.writeFile(toolPath, `
      export const webScrapeTool = {
        async execute(_toolCallId, params) {
          return {
            content: [{ type: "text", text: "fallback ok" }],
            details: {
              finalUrl: params.url,
              mode: "fake",
              responseId: "fake-response",
              data: {
                title: "Fake scraped page",
                markdown: "Fake markdown from hardened scraper fallback"
              }
            }
          };
        }
      };
    `);

    const originalCwd = process.cwd();
    const backend = createMcpWebBackend({
      searchServerName: "missing-search",
      fetchServerName: "missing-fetch",
      fetchFallback: "hardened_scraper",
      hardenedScraperPath: scraperRoot,
      configPaths: [path.join(tmp, "missing-mcp.json")],
    });

    try {
      process.chdir(isolatedCwd);
      const fetched = await backend.fetch("https://example.test/page");
      expect(fetched.title).toBe("Fake scraped page");
      expect(fetched.text).toContain("Fake markdown");
      expect(fetched.metadata?.fallback).toBe("hardened_scraper");
    } finally {
      process.chdir(originalCwd);
      await backend.close();
      await fs.rm(tmp, { recursive: true, force: true });
    }
  });
});
