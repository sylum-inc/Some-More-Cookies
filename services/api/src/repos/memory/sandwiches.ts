import type { SandwichRecord } from '@somemore/protocol';
import type { SandwichRepository } from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `sandwich_records`. */
export function createMemorySandwichRepository(): SandwichRepository {
  const table = new MemoryTable<SandwichRecord>('sandwich', (s) => s.id);
  return {
    async create(record) {
      return table.insert(record);
    },
    async get(sandwichId) {
      return table.find(sandwichId);
    },
    async listByAccount(accountId) {
      return table
        .filter((s) => s.accountId === accountId)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    },
    async countByAccount(accountId) {
      return table.filter((s) => s.accountId === accountId).length;
    },
    async bestScoreForAccount(accountId) {
      return table
        .filter((s) => s.accountId === accountId)
        .reduce((best, s) => Math.max(best, s.overallScore), 0);
    },
    async update(sandwichId, mutate) {
      return table.mutate(sandwichId, mutate);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const record of table.filter((s) => s.accountId === fromAccountId)) {
        table.put({ ...record, accountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
  };
}
