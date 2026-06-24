import type { EvidenceEntry, EvidencePool, EvidenceSummary } from "./types.js";

function dedupKey(entry: EvidenceEntry): string {
  if (entry.source === "web_fetch" && entry.url) {
    return `fetch:${entry.participantSlotIndex}:${entry.url}`;
  }
  if (entry.source === "web_search" && entry.query) {
    return `search:${entry.participantSlotIndex}:${entry.query}`;
  }
  // file_read or entries without url/query are never deduped
  return `unique:${entry.id}`;
}

export class EvidenceCollector {
  private entries: EvidenceEntry[] = [];
  private seen = new Set<string>();

  add(entry: EvidenceEntry): boolean {
    const key = dedupKey(entry);
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    this.entries.push(entry);
    return true;
  }

  addMany(entries: EvidenceEntry[]): number {
    let added = 0;
    for (const entry of entries) {
      if (this.add(entry)) added++;
    }
    return added;
  }

  getPool(): EvidencePool {
    return { entries: [...this.entries] };
  }

  getSummary(): EvidenceSummary {
    // Group by URL or by entry id for entries without URL
    const urlGroups = new Map<string, { entry: EvidenceEntry; slots: Set<number> }>();

    for (const entry of this.entries) {
      const key = entry.url ?? entry.id;
      const existing = urlGroups.get(key);
      if (existing) {
        existing.slots.add(entry.participantSlotIndex);
      } else {
        urlGroups.set(key, { entry, slots: new Set([entry.participantSlotIndex]) });
      }
    }

    const sources = Array.from(urlGroups.values()).map(({ entry, slots }) => ({
      id: entry.id,
      source: entry.source,
      title: entry.title,
      url: entry.url,
      usedBySlots: Array.from(slots).sort(),
    }));

    return {
      totalEntries: this.entries.length,
      sources,
    };
  }
}
