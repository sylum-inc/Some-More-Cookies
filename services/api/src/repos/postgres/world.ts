import type { Landmark, WorldTrace } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import { absorbCampsiteMemory, type StoredCampsiteMemory } from '../../domain/memoryMerge.js';
import type {
  CampsiteMemoryRepository,
  LandmarkRepository,
  WorldTraceRepository,
} from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `world_traces`. Decay is computed on read; the sweep deletes. */
export function createPostgresTraceRepository(pool: PgPool): WorldTraceRepository {
  const table = new DocTable<WorldTrace>(pool, {
    table: 'world_traces',
    entityName: 'trace',
    primaryKey: ['id'],
    keyOf: (t) => [t.id],
    project: (t) => ({
      campsite_id: t.campsiteId,
      created_at: t.createdAt,
      last_decayed_at: t.lastDecayedAt,
      promoted_landmark_id: t.promotedLandmarkId,
    }),
  });

  return {
    async create(trace) {
      return table.insert(trace);
    },
    async get(traceId) {
      return table.find([traceId]);
    },
    async listByCampsite(campsiteId) {
      return table.list('campsite_id = $1', [campsiteId], 'seq');
    },
    async update(traceId, mutate) {
      return table.mutate([traceId], mutate);
    },
    async delete(traceId) {
      await table.remove([traceId]);
    },
  };
}

/** Backs `landmarks`. A promoted landmark never decays. */
export function createPostgresLandmarkRepository(pool: PgPool): LandmarkRepository {
  const table = new DocTable<Landmark>(pool, {
    table: 'landmarks',
    entityName: 'landmark',
    primaryKey: ['id'],
    keyOf: (l) => [l.id],
    project: (l) => ({
      campsite_id: l.campsiteId,
      origin_trace_id: l.originTraceId,
      promoted_at: l.promotedAt,
    }),
  });

  return {
    async create(landmark) {
      return table.insert(landmark);
    },
    async get(landmarkId) {
      return table.find([landmarkId]);
    },
    async listByCampsite(campsiteId) {
      return table.list('campsite_id = $1', [campsiteId], 'seq');
    },
    async update(landmarkId, mutate) {
      return table.mutate([landmarkId], mutate);
    },
  };
}

/**
 * Backs `campsite_memories`. One row per `(account, campsite)`.
 *
 * `merge` is the interesting method. The in-memory version is atomic because
 * nothing interleaves inside one JavaScript turn; here the same guarantee
 * needs a transaction, and specifically an insert-then-lock rather than a
 * read-then-write:
 *
 *   INSERT ... ON CONFLICT DO NOTHING   -- claim the row, or find it claimed
 *   SELECT ... FOR UPDATE               -- now there is definitely a row to lock
 *   UPDATE
 *
 * `SELECT ... FOR UPDATE` alone locks nothing when the row does not exist yet,
 * which is exactly the case two devices hit on a campsite's first sync — both
 * would see nothing, both would insert, and one would lose a unique violation
 * or, worse, a night.
 */
export function createPostgresCampsiteMemoryRepository(pool: PgPool): CampsiteMemoryRepository {
  const table = new DocTable<StoredCampsiteMemory>(pool, {
    table: 'campsite_memories',
    entityName: 'campsite memory',
    primaryKey: ['account_id', 'campsite_id'],
    keyOf: (m) => [m.accountId, m.campsiteId],
    project: (m) => ({
      environment_id: m.environmentId,
      last_visit_at: m.lastVisitAt,
      updated_at: m.updatedAt,
    }),
  });

  return {
    async get(accountId, campsiteId) {
      return table.find([accountId, campsiteId]);
    },

    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'seq');
    },

    async merge(accountId, campsiteId, mutate) {
      return pool.transaction(async (tx) => {
        const existing = await tx.maybeOne<{ doc: StoredCampsiteMemory }>(
          `SELECT doc FROM somemore.campsite_memories
             WHERE account_id = $1 AND campsite_id = $2 FOR UPDATE`,
          [accountId, campsiteId],
        );
        if (existing === null) {
          // Claim the row first so there is something for a concurrent caller
          // to block on, then take the lock and carry on as if it had been
          // there all along. `DO NOTHING` means the loser of the race falls
          // through to the same locked read.
          const seeded = mutate(null);
          await tx.query(
            `INSERT INTO somemore.campsite_memories
               (account_id, campsite_id, environment_id, last_visit_at, updated_at, doc)
             VALUES ($1, $2, $3, $4, $5, $6::jsonb)
             ON CONFLICT (account_id, campsite_id) DO NOTHING`,
            [
              accountId,
              campsiteId,
              seeded.environmentId,
              seeded.lastVisitAt,
              seeded.updatedAt,
              seeded as unknown as Record<string, unknown>,
            ],
          );
          const claimed = await tx.maybeOne<{ doc: StoredCampsiteMemory }>(
            `SELECT doc FROM somemore.campsite_memories
               WHERE account_id = $1 AND campsite_id = $2 FOR UPDATE`,
            [accountId, campsiteId],
          );
          // Ours: nobody else got there first, and the seed is already stored.
          if (claimed !== null && claimed.doc.revision === seeded.revision) {
            return structuredClone(seeded);
          }
          // Somebody else claimed it in between; fold into what they wrote.
          const next = mutate(claimed === null ? null : claimed.doc);
          await table.put(next, tx);
          return structuredClone(next);
        }
        const next = mutate(existing.doc);
        await table.put(next, tx);
        return structuredClone(next);
      });
    },

    async reassignAccount(fromAccountId, toAccountId) {
      const rows = await table.list('account_id = $1', [fromAccountId], 'seq');
      const nowMs = Date.now();
      let moved = 0;
      for (const memory of rows) {
        await pool.transaction(async (tx) => {
          const existing = await tx.maybeOne<{ doc: StoredCampsiteMemory }>(
            `SELECT doc FROM somemore.campsite_memories
               WHERE account_id = $1 AND campsite_id = $2 FOR UPDATE`,
            [toAccountId, memory.campsiteId],
          );
          const next =
            existing === null
              ? { ...memory, accountId: toAccountId }
              : absorbCampsiteMemory(existing.doc, memory, nowMs);
          await table.put(next, tx);
          await tx.query(
            `DELETE FROM somemore.campsite_memories WHERE account_id = $1 AND campsite_id = $2`,
            [fromAccountId, memory.campsiteId],
          );
        });
        moved += 1;
      }
      return moved;
    },
  };
}
