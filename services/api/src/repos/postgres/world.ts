import type { Landmark, WorldTrace } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { LandmarkRepository, WorldTraceRepository } from '../interfaces.js';
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
