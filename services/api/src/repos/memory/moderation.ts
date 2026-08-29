import type { Block, ModerationReport } from '@somemore/protocol';
import type { ModerationRepository } from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `moderation_reports` and `account_blocks`. */
export function createMemoryModerationRepository(): ModerationRepository {
  const reports = new MemoryTable<ModerationReport>('report', (r) => r.id);
  const blocks = new MemoryTable<Block>('block', (b) => `${b.blockerAccountId}:${b.blockedAccountId}`);
  return {
    async createReport(report) {
      return reports.insert(report);
    },
    async getReport(reportId) {
      return reports.find(reportId);
    },
    async listReportsByReporter(accountId) {
      return reports.filter((r) => r.reporterAccountId === accountId);
    },
    async updateReport(reportId, mutate) {
      return reports.mutate(reportId, mutate);
    },
    async createBlock(block) {
      return blocks.put(block);
    },
    async deleteBlock(blockerAccountId, blockedAccountId) {
      return blocks.remove(`${blockerAccountId}:${blockedAccountId}`);
    },
    async listBlocks(blockerAccountId) {
      return blocks.filter((b) => b.blockerAccountId === blockerAccountId);
    },
    async isBlocked(blockerAccountId, blockedAccountId) {
      return blocks.find(`${blockerAccountId}:${blockedAccountId}`) !== null;
    },
  };
}
