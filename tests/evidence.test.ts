import { describe, it, expect } from "vitest";
import { EvidenceCollector } from "../src/evidence.js";
import type { EvidenceEntry } from "../src/types.js";

function fakeEntry(overrides: Partial<EvidenceEntry> = {}): EvidenceEntry {
  return {
    id: `ev-${Math.random().toString(36).slice(2, 8)}`,
    source: "web_search",
    query: "test query",
    snippet: "test snippet",
    participantSlotIndex: 0,
    fetchedAt: Date.now(),
    ...overrides,
  };
}

describe("EvidenceCollector", () => {
  it("adds and retrieves entries", () => {
    const collector = new EvidenceCollector();
    const entry = fakeEntry();
    collector.add(entry);

    const pool = collector.getPool();
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0]).toBe(entry);
  });

  it("deduplicates by URL for web_fetch", () => {
    const collector = new EvidenceCollector();
    collector.add(fakeEntry({ source: "web_fetch", url: "https://example.com/article", snippet: "first" }));
    collector.add(fakeEntry({ source: "web_fetch", url: "https://example.com/article", snippet: "second" }));

    const pool = collector.getPool();
    expect(pool.entries).toHaveLength(1);
    expect(pool.entries[0].snippet).toBe("first"); // keeps first
  });

  it("deduplicates by query for web_search", () => {
    const collector = new EvidenceCollector();
    collector.add(fakeEntry({ source: "web_search", query: "exact same query", snippet: "first" }));
    collector.add(fakeEntry({ source: "web_search", query: "exact same query", snippet: "second" }));

    const pool = collector.getPool();
    expect(pool.entries).toHaveLength(1);
  });

  it("keeps entries from different URLs", () => {
    const collector = new EvidenceCollector();
    collector.add(fakeEntry({ source: "web_fetch", url: "https://a.com" }));
    collector.add(fakeEntry({ source: "web_fetch", url: "https://b.com" }));

    expect(collector.getPool().entries).toHaveLength(2);
  });

  it("keeps entries from different participants", () => {
    const collector = new EvidenceCollector();
    collector.add(fakeEntry({ source: "web_search", query: "same query", participantSlotIndex: 0 }));
    collector.add(fakeEntry({ source: "web_search", query: "same query", participantSlotIndex: 1 }));

    // Different participants means different dedup key
    expect(collector.getPool().entries).toHaveLength(2);
  });

  it("generates summary with source grouping", () => {
    const collector = new EvidenceCollector();
    collector.add(fakeEntry({ id: "ev1", source: "web_search", url: "https://a.com", title: "Article A", participantSlotIndex: 0 }));
    collector.add(fakeEntry({ id: "ev2", source: "web_fetch", url: "https://a.com", title: "Article A", participantSlotIndex: 1 }));
    collector.add(fakeEntry({ id: "ev3", source: "file_read", snippet: "local file", participantSlotIndex: 0 }));

    const summary = collector.getSummary();
    expect(summary.totalEntries).toBe(3);
    // Two entries share the same url, so they should be grouped
    const sourceA = summary.sources.find((s) => s.url === "https://a.com");
    expect(sourceA).toBeDefined();
    expect(sourceA!.usedBySlots).toContain(0);
    expect(sourceA!.usedBySlots).toContain(1);
  });

  it("returns empty pool when no entries added", () => {
    const collector = new EvidenceCollector();
    const pool = collector.getPool();
    expect(pool.entries).toHaveLength(0);
    expect(collector.getSummary().totalEntries).toBe(0);
  });
});
