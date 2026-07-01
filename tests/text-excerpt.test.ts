import { describe, expect, it } from "vitest";
import { extractFocusedExcerpt, focusTermsFromText } from "../src/text-excerpt.js";

describe("focused text excerpts", () => {
  it("extracts useful focus terms", () => {
    expect(focusTermsFromText("Retail Segment revenue and operating income; Asset acquisition purchase price")).toContain("Retail Segment revenue and operating income");
  });

  it("returns targeted snippets for long text", () => {
    const text = `${"intro ".repeat(1000)}Retail Segment total revenues were $123.456 million and operating income was $45.678 million.${" middle ".repeat(1000)}Services Segment total revenues were $98.765 million.${" end ".repeat(1000)}`;
    const excerpt = extractFocusedExcerpt(text, "Retail Segment total revenues operating income", { maxChars: 2000, windowChars: 120, maxSnippets: 2 });
    expect(excerpt).toContain("focused excerpts");
    expect(excerpt).toContain("$123.456 million");
    expect(excerpt.length).toBeLessThanOrEqual(2100);
  });

  it("prefers later dense numeric windows over first generic entity mention", () => {
    const text = `${"Acme appears in intro. ".repeat(300)}${"filler ".repeat(300)}Segment table: Acme Core Portfolio total revenues $53.538 million operating income $17.352 million; Funds total revenues $37.818 million operating income $6.424 million.${" tail ".repeat(300)}`;
    const excerpt = extractFocusedExcerpt(text, "Acme; Core Portfolio revenues; Funds revenues; operating income", { maxChars: 1800, windowChars: 180, maxSnippets: 1 });
    expect(excerpt).toContain("$53.538 million");
    expect(excerpt).toContain("$6.424 million");
  });

  it("prefers numeric public-health metric windows over navigation boilerplate", () => {
    const nav = "Main navigation UNFPA maternal health birth care donate subscribe privacy notice ".repeat(120);
    const report = "Table 4: antenatal care ANC4 coverage was 71.6% in 2019; neonatal mortality was 27 per 1,000 live births and facility delivery increased over time.";
    const text = `${nav}${" filler ".repeat(250)}${report}${" tail ".repeat(200)}`;
    const excerpt = extractFocusedExcerpt(text, "UNFPA maternal birth care ANC4 neonatal mortality facility delivery", { maxChars: 1800, windowChars: 180, maxSnippets: 1 });
    expect(excerpt).toContain("71.6%");
    expect(excerpt).toContain("27 per 1,000");
    expect(excerpt).not.toContain("donate subscribe privacy");
  });

  it("keeps a complete high-score later snippet instead of prefix-truncating it", () => {
    const generic = "Renaissance Portfolio debt table mentions loans and SOFR without the exact modified spread. ".repeat(160);
    const target = "The venture modified the property mortgage loans to reduce the interest rate to SOFR + 1.85% while preserving the scheduled maturity and lender terms.";
    const text = `${generic}${" filler ".repeat(180)}${target}${" tail ".repeat(120)}`;
    const excerpt = extractFocusedExcerpt(text, "modified property mortgage loans reduce interest rate SOFR spread", { maxChars: 1100, windowChars: 320, maxSnippets: 4 });
    expect(excerpt).toContain("SOFR + 1.85%");
    expect(excerpt).toContain("modified the property mortgage loans");
    expect(excerpt.length).toBeLessThanOrEqual(1100);
  });

  it("falls back to head and tail when focus is absent", () => {
    const text = `${"head ".repeat(1000)}${"tail ".repeat(1000)}`;
    const excerpt = extractFocusedExcerpt(text, undefined, { maxChars: 1000 });
    expect(excerpt).toContain("use web_fetch with a focus query");
  });
});
