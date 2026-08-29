import type { SandwichRecord } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { SandwichRepository } from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `sandwich_records`. The score is a column so the best of an account
 *  is an index lookup, not a scan of every sandwich they ever pressed. */
export function createPostgresSandwichRepository(pool: PgPool): SandwichRepository {
  const table = new DocTable<SandwichRecord>(pool, {
    table: 'sandwich_records',
    entityName: 'sandwich',
    primaryKey: ['id'],
    keyOf: (s) => [s.id],
    project: (s) => ({
      account_id: s.accountId,
      campsite_id: s.campsiteId,
      overall_score: s.overallScore,
      created_at: s.createdAt,
    }),
  });

  return {
    async create(record) {
      return table.insert(record);
    },

    async get(sandwichId) {
      return table.find([sandwichId]);
    },

    /** Newest first, matching the in-memory ordering exactly. */
    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'created_at DESC, seq');
    },

    async countByAccount(accountId) {
      return table.count('account_id = $1', [accountId]);
    },

    async bestScoreForAccount(accountId) {
      const row = await pool.maybeOne<{ best: number | null }>(
        `SELECT max(overall_score) AS best FROM somemore.sandwich_records WHERE account_id = $1`,
        [accountId],
      );
      // The in-memory version reduces from 0, so an account with no sandwiches
      // has a best score of 0 rather than null.
      return row?.best === null || row?.best === undefined ? 0 : Number(row.best);
    },

    async update(sandwichId, mutate) {
      return table.mutate([sandwichId], mutate);
    },

    async reassignAccount(fromAccountId, toAccountId) {
      return table.reassign('account_id', 'accountId', fromAccountId, toAccountId);
    },
  };
}
