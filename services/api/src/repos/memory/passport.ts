import type { CampfirePassport, PhotoRef } from '@somemore/protocol';
import type { PassportRepository, PhotoRepository } from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `passports` plus its child collection tables. */
export function createMemoryPassportRepository(): PassportRepository {
  const table = new MemoryTable<CampfirePassport>('passport', (p) => p.accountId);
  return {
    async create(passport) {
      return table.insert(passport);
    },
    async get(accountId) {
      return table.find(accountId);
    },
    async update(accountId, mutate) {
      return table.mutate(accountId, mutate);
    },
    async findByHandle(handle) {
      const normalized = handle.toLowerCase();
      return table.first((p) => p.handle !== null && p.handle.toLowerCase() === normalized);
    },
    async delete(accountId) {
      table.remove(accountId);
    },
  };
}

/** Backs `photos`. Metadata and storage keys only — never image bytes. */
export function createMemoryPhotoRepository(): PhotoRepository {
  const table = new MemoryTable<PhotoRef>('photo', (p) => p.id);
  return {
    async create(photo) {
      return table.insert(photo);
    },
    async get(photoId) {
      return table.find(photoId);
    },
    async listByAccount(accountId) {
      return table.filter((p) => p.ownerAccountId === accountId);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const photo of table.filter((p) => p.ownerAccountId === fromAccountId)) {
        table.put({ ...photo, ownerAccountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
  };
}
