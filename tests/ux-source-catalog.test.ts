import { describe, expect, it } from "vitest";
import { seedUxSourceCatalog } from "../src/ux-source-catalog.js";

describe("UX source catalog", () => {
  it("adds compact canonical sources for ERP UX prompts", () => {
    const evidence = seedUxSourceCatalog("Compare SAP S/4HANA, NetSuite, and Dynamics ERP adoption, navigation, and training.");
    expect(evidence.some((entry) => entry.title?.includes("SAP Fiori"))).toBe(true);
    expect(evidence.some((entry) => entry.title?.includes("Dynamics 365"))).toBe(true);
    expect(evidence.some((entry) => entry.title?.includes("NetSuite"))).toBe(true);
    expect(evidence.some((entry) => entry.title?.includes("Prosci"))).toBe(true);
    expect(evidence.some((entry) => entry.title?.includes("Hidden Navigation"))).toBe(true);
    expect(evidence.length).toBeLessThanOrEqual(10);
  });

  it("does not add sources for unrelated prompts", () => {
    expect(seedUxSourceCatalog("Summarize a quarterly revenue filing")).toEqual([]);
  });
});
