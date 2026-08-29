import type { Block, ModerationReport } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { ModerationRepository } from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `moderation_reports` and `account_blocks`. */
export function createPostgresModerationRepository(pool: PgPool): ModerationRepository {
  const reports = new DocTable<ModerationReport>(pool, {
    table: 'moderation_reports',
    entityName: 'report',
    primaryKey: ['id'],
    keyOf: (r) => [r.id],
    project: (r) => ({
      reporter_account_id: r.reporterAccountId,
      target_kind: r.target.kind,
      state: r.state,
      priority: r.priority,
      created_at: r.createdAt,
    }),
  });

  const blocks = new DocTable<Block>(pool, {
    table: 'account_blocks',
    entityName: 'block',
    primaryKey: ['blocker_account_id', 'blocked_account_id'],
    keyOf: (b) => [b.blockerAccountId, b.blockedAccountId],
    project: (b) => ({ created_at: b.createdAt }),
  });

  return {
    async createReport(report) {
      return reports.insert(report);
    },
    async getReport(reportId) {
      return reports.find([reportId]);
    },
    async listReportsByReporter(accountId) {
      return reports.list('reporter_account_id = $1', [accountId], 'seq');
    },
    async updateReport(reportId, mutate) {
      return reports.mutate([reportId], mutate);
    },
    /** Blocking twice is not an error; it is the same block. */
    async createBlock(block) {
      return blocks.put(block);
    },
    async deleteBlock(blockerAccountId, blockedAccountId) {
      return blocks.remove([blockerAccountId, blockedAccountId]);
    },
    async listBlocks(blockerAccountId) {
      return blocks.list('blocker_account_id = $1', [blockerAccountId], 'seq');
    },
    async isBlocked(blockerAccountId, blockedAccountId) {
      return (await blocks.find([blockerAccountId, blockedAccountId])) !== null;
    },
  };
}
