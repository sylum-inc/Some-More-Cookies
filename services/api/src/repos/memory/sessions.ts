import type { AuthorityRecord, Session } from '@somemore/protocol';
import type { AuthorityRepository, SessionRepository } from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `sessions` and `session_presence`. */
export function createMemorySessionRepository(): SessionRepository {
  const table = new MemoryTable<Session>('session', (s) => s.id);
  return {
    async create(session) {
      return table.insert(session);
    },
    async get(sessionId) {
      return table.find(sessionId);
    },
    async listByCampsite(campsiteId) {
      return table.filter((s) => s.campsiteId === campsiteId);
    },
    async findActiveByCampsite(campsiteId) {
      return table.first((s) => s.campsiteId === campsiteId && (s.state === 'lobby' || s.state === 'active'));
    },
    async update(sessionId, mutate) {
      return table.mutate(sessionId, mutate);
    },
  };
}

/** Backs `object_authority`. */
export function createMemoryAuthorityRepository(): AuthorityRepository {
  const table = new MemoryTable<AuthorityRecord>('authority record', (r) => `${r.sessionId}:${r.objectId}`);
  return {
    async get(sessionId, objectId) {
      return table.find(`${sessionId}:${objectId}`);
    },
    async put(record) {
      return table.put(record);
    },
    async listBySession(sessionId) {
      return table.filter((r) => r.sessionId === sessionId);
    },
    async releaseAllHeldBy(sessionId, accountId, at) {
      const released: AuthorityRecord[] = [];
      for (const record of table.filter((r) => r.sessionId === sessionId && r.holderAccountId === accountId)) {
        released.push(
          table.put({
            ...record,
            holderAccountId: null,
            grantedAt: at,
            expiresAt: null,
            sequence: record.sequence + 1,
          }),
        );
      }
      return released;
    },
  };
}
