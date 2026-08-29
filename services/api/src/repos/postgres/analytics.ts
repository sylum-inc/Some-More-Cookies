import type { IngestedEvent } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { AnalyticsRepository } from '../interfaces.js';

/**
 * Backs `analytics_events`.
 *
 * De-duplication is the client-minted event id and an `ON CONFLICT DO NOTHING`,
 * which is exactly the contract the warehouse loader relies on: a retried batch
 * is free, and a batch that half-succeeded can simply be sent again.
 */
export function createPostgresAnalyticsRepository(pool: PgPool): AnalyticsRepository {
  return {
    async append(events) {
      if (events.length === 0) return { accepted: 0, duplicates: 0 };
      return pool.transaction(async (tx) => {
        let accepted = 0;
        const seenInBatch = new Set<string>();
        for (const event of events) {
          // A batch may repeat an id inside itself; the in-memory reference
          // counts the second occurrence as a duplicate, and so does this.
          if (seenInBatch.has(event.id)) continue;
          seenInBatch.add(event.id);
          const result = await tx.query(
            `INSERT INTO somemore.analytics_events (id, name, account_id, occurred_at, doc)
             VALUES ($1, $2, $3, $4::timestamptz, $5::jsonb)
             ON CONFLICT (id) DO NOTHING`,
            [event.id, event.name, event.accountId, event.occurredAt, event],
          );
          accepted += result.rowCount;
        }
        return { accepted, duplicates: events.length - accepted };
      });
    },

    /** The last `limit` events in ingest order, oldest first. */
    async list(limit = 100) {
      const rows = await pool.many<{ doc: IngestedEvent }>(
        'SELECT doc FROM (SELECT seq, doc FROM somemore.analytics_events ORDER BY seq DESC LIMIT $1) t ORDER BY seq',
        [limit],
      );
      return rows.map((row) => row.doc);
    },

    async count() {
      const row = await pool.maybeOne<{ n: number }>('SELECT count(*)::int AS n FROM somemore.analytics_events');
      return row?.n ?? 0;
    },

    /**
     * Merge support: events keep pointing at a live account, and remember which
     * account they were originally attributed to.
     */
    async remapAccount(fromAccountId, toAccountId) {
      const result = await pool.query(
        `UPDATE somemore.analytics_events
            SET account_id = $2,
                doc = doc || jsonb_build_object('accountId', $2::text, 'remappedFromAccountId', $1::text)
          WHERE account_id = $1`,
        [fromAccountId, toAccountId],
      );
      return result.rowCount;
    },
  };
}
