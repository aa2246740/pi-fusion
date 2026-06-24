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

  it("falls back to head and tail when focus is absent", () => {
    const text = `${"head ".repeat(1000)}${"tail ".repeat(1000)}`;
    const excerpt = extractFocusedExcerpt(text, undefined, { maxChars: 1000 });
    expect(excerpt).toContain("use web_fetch with a focus query");
  });
});
