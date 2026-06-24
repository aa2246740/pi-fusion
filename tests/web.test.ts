import { describe, it, expect } from "vitest";
import { dataUnhcrDownloadUrlForDetails, extractMcpText, isLikelyPdfFetchUrl, isSecInteractiveReportUrl, parseFetchResultFromMcpText, parseSearchResultsFromMcpText, rankSearchResultsForQuery, secHtmlToReadableText } from "../src/web.js";

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

  it("falls back to a single text result when output is not JSON", () => {
    const results = parseSearchResultsFromMcpText("plain text search summary", 5);
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toContain("plain text");
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
});
