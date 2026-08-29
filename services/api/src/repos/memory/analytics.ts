import type { IngestedEvent } from '@somemore/protocol';
import type { AnalyticsRepository } from '../interfaces.js';

/**
 * Backs `analytics_events`. In production this is a thin write-ahead buffer in
 * front of the warehouse; the id-based de-duplication below is the same
 * behaviour the warehouse loader relies on.
 */
export function createMemoryAnalyticsRepository(): AnalyticsRepository {
  const seen = new Set<string>();
  const rows: IngestedEvent[] = [];
  return {
    async append(events) {
      let accepted = 0;
      let duplicates = 0;
      for (const event of events) {
        if (seen.has(event.id)) {
          duplicates += 1;
          continue;
        }
        seen.add(event.id);
        rows.push(structuredClone(event));
        accepted += 1;
      }
      return { accepted, duplicates };
    },
    async list(limit = 100) {
      return rows.slice(-limit).map((row) => structuredClone(row));
    },
    async count() {
      return rows.length;
    },
    async remapAccount(fromAccountId, toAccountId) {
      let remapped = 0;
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i];
        if (row === undefined || row.accountId !== fromAccountId) continue;
        rows[i] = { ...row, accountId: toAccountId, remappedFromAccountId: fromAccountId };
        remapped += 1;
      }
      return remapped;
    },
  };
}
