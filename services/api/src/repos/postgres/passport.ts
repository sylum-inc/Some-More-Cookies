import type { CampfirePassport, PhotoRef } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { PassportRepository, PhotoRepository } from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `passports` plus its child collections, which live in the document. */
export function createPostgresPassportRepository(pool: PgPool): PassportRepository {
  const table = new DocTable<CampfirePassport>(pool, {
    table: 'passports',
    entityName: 'passport',
    primaryKey: ['account_id'],
    keyOf: (p) => [p.accountId],
    project: (p) => ({ handle: p.handle, updated_at: p.updatedAt }),
  });

  return {
    async create(passport) {
      return table.insert(passport);
    },
    async get(accountId) {
      return table.find([accountId]);
    },
    async update(accountId, mutate) {
      return table.mutate([accountId], mutate);
    },
    async findByHandle(handle) {
      return table.first('handle IS NOT NULL AND lower(handle) = lower($1)', [handle]);
    },
    async delete(accountId) {
      await table.remove([accountId]);
    },
  };
}

/** Backs `photos`. Metadata and storage keys only — never image bytes. */
export function createPostgresPhotoRepository(pool: PgPool): PhotoRepository {
  const table = new DocTable<PhotoRef>(pool, {
    table: 'photos',
    entityName: 'photo',
    primaryKey: ['id'],
    keyOf: (p) => [p.id],
    project: (p) => ({
      owner_account_id: p.ownerAccountId,
      campsite_id: p.campsiteId,
      sandwich_id: p.sandwichId,
      created_at: p.createdAt,
    }),
  });

  return {
    async create(photo) {
      return table.insert(photo);
    },
    async get(photoId) {
      return table.find([photoId]);
    },
    async listByAccount(accountId) {
      return table.list('owner_account_id = $1', [accountId], 'seq');
    },
    async delete(photoId) {
      await table.remove([photoId]);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      return table.reassign('owner_account_id', 'ownerAccountId', fromAccountId, toAccountId);
    },
  };
}
