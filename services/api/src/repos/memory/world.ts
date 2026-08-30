import type { Landmark, WorldTrace } from '@somemore/protocol';
import { absorbCampsiteMemory, type StoredCampsiteMemory } from '../../domain/memoryMerge.js';
import type {
  CampsiteMemoryRepository,
  LandmarkRepository,
  WorldTraceRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `world_traces`. */
export function createMemoryTraceRepository(): WorldTraceRepository {
  const table = new MemoryTable<WorldTrace>('trace', (t) => t.id);
  return {
    async create(trace) {
      return table.insert(trace);
    },
    async get(traceId) {
      return table.find(traceId);
    },
    async listByCampsite(campsiteId) {
      return table.filter((t) => t.campsiteId === campsiteId);
    },
    async update(traceId, mutate) {
      return table.mutate(traceId, mutate);
    },
    async delete(traceId) {
      table.remove(traceId);
    },
  };
}

/** Backs `landmarks`. */
export function createMemoryLandmarkRepository(): LandmarkRepository {
  const table = new MemoryTable<Landmark>('landmark', (l) => l.id);
  return {
    async create(landmark) {
      return table.insert(landmark);
    },
    async get(landmarkId) {
      return table.find(landmarkId);
    },
    async listByCampsite(campsiteId) {
      return table.filter((l) => l.campsiteId === campsiteId);
    },
    async update(landmarkId, mutate) {
      return table.mutate(landmarkId, mutate);
    },
  };
}

/**
 * Backs `campsite_memories`. One row per `(account, campsite)`.
 *
 * `merge` is atomic here for free — nothing interleaves inside a single
 * JavaScript turn — which is exactly the semantics the Postgres adapter has to
 * reproduce with a row lock.
 */
export function createMemoryCampsiteMemoryRepository(): CampsiteMemoryRepository {
  const table = new MemoryTable<StoredCampsiteMemory>(
    'campsite memory',
    (m) => `${m.accountId}:${m.campsiteId}`,
  );

  return {
    async get(accountId, campsiteId) {
      return table.find(`${accountId}:${campsiteId}`);
    },
    async listByAccount(accountId) {
      return table.filter((m) => m.accountId === accountId);
    },
    async merge(accountId, campsiteId, mutate) {
      const current = table.find(`${accountId}:${campsiteId}`);
      return table.put(mutate(current));
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const memory of table.filter((m) => m.accountId === fromAccountId)) {
        table.remove(`${memory.accountId}:${memory.campsiteId}`);
        // The surviving account may already remember this campsite from its
        // own device, so this is a merge and not a move. Absorbing without
        // merging would drop one side's nights, and "a merge is never a reset".
        const existing = table.find(`${toAccountId}:${memory.campsiteId}`);
        table.put(
          existing === null
            ? { ...memory, accountId: toAccountId }
            : absorbCampsiteMemory(existing, memory, Date.now()),
        );
        moved += 1;
      }
      return moved;
    },
  };
}
