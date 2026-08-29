import type { Landmark, WorldTrace } from '@somemore/protocol';
import type { LandmarkRepository, WorldTraceRepository } from '../interfaces.js';
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
