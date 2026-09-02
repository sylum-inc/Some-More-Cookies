import type { OperatorGrant } from '@somemore/protocol';

import type { PgPool } from '../../db/wire/index.js';
import type { OperatorGrantRepository } from '../interfaces.js';
import { DocTable } from './support.js';

/**
 * Backs `operator_capabilities` (README, Blocker 9).
 *
 * One row per (account, capability). Granting is an upsert rather than an
 * insert, because granting somebody something they already hold is not an error
 * — and because a re-grant after a revocation has to clear the revocation
 * rather than leave a live row that says it was taken away.
 *
 * Revoking sets `revoked_at` instead of deleting: a revocation is a fact about
 * a person and a moment, and a missing row cannot say when or by whom.
 */
export function createPostgresOperatorGrantRepository(pool: PgPool): OperatorGrantRepository {
  const table = new DocTable<OperatorGrant>(pool, {
    table: 'operator_capabilities',
    entityName: 'operator capability',
    primaryKey: ['account_id', 'capability'],
    keyOf: (g) => [g.accountId, g.capability],
    project: (g) => ({ revoked_at: g.revokedAt }),
  });

  return {
    async listFor(accountId) {
      return table.list('account_id = $1 AND revoked_at IS NULL', [accountId], 'capability');
    },
    async listAll() {
      return table.list('revoked_at IS NULL', [], 'account_id, capability');
    },
    async grant(grant) {
      const stored: OperatorGrant = { ...grant, revokedAt: null };
      await pool.query(
        `INSERT INTO operator_capabilities (account_id, capability, revoked_at, doc)
         VALUES ($1, $2, NULL, $3)
         ON CONFLICT (account_id, capability) DO UPDATE SET revoked_at = NULL, doc = EXCLUDED.doc`,
        [stored.accountId, stored.capability, stored as unknown as Record<string, unknown>],
      );
      return stored;
    },
    async revoke(accountId, capabilities, atIso) {
      /*
       * `atIso` arrives as text and is cast at each use rather than left for
       * Postgres to infer. A bare `$3` here is read as a timestamptz by the
       * column assignment and as text by `to_jsonb`, and one placeholder
       * inferred two ways is rejected outright ("inconsistent types deduced for
       * parameter $3") — a failure only a real server produces, which is why
       * the Postgres suite exists alongside the memory one. `::text::timestamptz`
       * is the same pin the session and magic-link adapters use.
       *
       * `doc` is rewritten alongside the column so the two never disagree:
       * every read in this adapter returns the document, and a row whose column
       * says revoked while its document says live is a bug that surfaces only
       * in whichever of the two a future reader happens to trust.
       */
      const result = await pool.query<{ account_id: string }>(
        `UPDATE operator_capabilities
            SET revoked_at = $3::text::timestamptz,
                doc = jsonb_set(doc, '{revokedAt}', to_jsonb($3::text))
          WHERE account_id = $1
            AND capability = ANY($2::text[])
            AND revoked_at IS NULL
          RETURNING account_id`,
        [accountId, [...capabilities], atIso],
      );
      return result.rows.length;
    },
  };
}
