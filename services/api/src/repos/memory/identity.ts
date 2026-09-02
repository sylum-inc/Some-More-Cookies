import type { Account, Identity } from '@somemore/protocol';
import type {
  AccountRepository,
  IdentityRepository,
  MagicLinkRecord,
  MagicLinkRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `accounts` (see sql/schema.sql). */
export function createMemoryAccountRepository(): AccountRepository {
  const table = new MemoryTable<Account>('account', (a) => a.id);
  return {
    async create(account) {
      return table.insert(account);
    },
    async get(accountId) {
      return table.find(accountId);
    },
    async update(accountId, mutate) {
      return table.mutate(accountId, mutate);
    },
    async count() {
      return table.size;
    },
  };
}

/** Backs `identities`. */
export function createMemoryIdentityRepository(): IdentityRepository {
  const table = new MemoryTable<Identity>('identity', (i) => i.id);
  return {
    async create(identity) {
      const clash = table.first((i) => i.provider === identity.provider && i.subject === identity.subject);
      if (clash !== null) {
        // Mirrors the UNIQUE (provider, subject) constraint in Postgres.
        throw Object.assign(new Error('identity already exists'), { code: 'identity_exists' });
      }
      return table.insert(identity);
    },
    async get(identityId) {
      return table.find(identityId);
    },
    async findByProviderSubject(provider, subject) {
      return table.first((i) => i.provider === provider && i.subject === subject);
    },
    async findVerifiedByEmail(email) {
      const normalized = email.toLowerCase();
      return table.first((i) => i.emailVerified && i.email !== null && i.email.toLowerCase() === normalized);
    },
    async listByAccount(accountId) {
      return table.filter((i) => i.accountId === accountId);
    },
    async update(identityId, mutate) {
      return table.mutate(identityId, mutate);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const identity of table.filter((i) => i.accountId === fromAccountId)) {
        table.put({ ...identity, accountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
    async countAccountsByAnonymousSubject(subject) {
      const accounts = new Set(
        table.filter((i) => i.provider === 'anonymous' && i.subject === subject).map((i) => i.accountId),
      );
      return accounts.size;
    },
  };
}

/** Backs `magic_links`. */
export function createMemoryMagicLinkRepository(): MagicLinkRepository {
  const table = new MemoryTable<MagicLinkRecord>('magic link', (m) => m.token);
  return {
    async create(record) {
      return table.insert(record);
    },
    async get(token) {
      return table.find(token);
    },
    async consume(token, at) {
      const record = table.find(token);
      if (record === null || record.consumedAt !== null) return null;
      return table.mutate(token, (current) => ({ ...current, consumedAt: at }));
    },
  };
}
