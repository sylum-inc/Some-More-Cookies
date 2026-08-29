import type { Account, Identity } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type {
  AccountRepository,
  IdentityRepository,
  MagicLinkRecord,
  MagicLinkRepository,
} from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `accounts`. */
export function createPostgresAccountRepository(pool: PgPool): AccountRepository {
  const table = new DocTable<Account>(pool, {
    table: 'accounts',
    entityName: 'account',
    primaryKey: ['id'],
    keyOf: (a) => [a.id],
    project: (a) => ({
      status: a.status,
      anonymous: a.anonymous,
      merged_into_account_id: a.mergedIntoAccountId,
      created_at: a.createdAt,
      updated_at: a.updatedAt,
    }),
  });

  return {
    async create(account) {
      return table.insert(account);
    },
    async get(accountId) {
      return table.find([accountId]);
    },
    async update(accountId, mutate) {
      return table.mutate([accountId], mutate);
    },
    async count() {
      return table.count();
    },
  };
}

/** Backs `identities`. */
export function createPostgresIdentityRepository(pool: PgPool): IdentityRepository {
  const table = new DocTable<Identity>(pool, {
    table: 'identities',
    entityName: 'identity',
    primaryKey: ['id'],
    keyOf: (i) => [i.id],
    project: (i) => ({
      account_id: i.accountId,
      provider: i.provider,
      subject: i.subject,
      email: i.email,
      email_verified: i.emailVerified,
      created_at: i.createdAt,
    }),
  });

  return {
    async create(identity) {
      // `identities_provider_subject_unique` is the real guard; this read keeps
      // the error shape identical to the in-memory repository, which callers
      // (and their tests) already depend on.
      const clash = await table.first('provider = $1 AND subject = $2', [identity.provider, identity.subject]);
      if (clash !== null) {
        throw Object.assign(new Error('identity already exists'), { code: 'identity_exists' });
      }
      try {
        return await table.insert(identity);
      } catch (error) {
        // Lost the race between the check above and the insert.
        throw Object.assign(new Error('identity already exists'), { code: 'identity_exists', cause: error });
      }
    },

    async get(identityId) {
      return table.find([identityId]);
    },

    async findByProviderSubject(provider, subject) {
      return table.first('provider = $1 AND subject = $2', [provider, subject]);
    },

    async findVerifiedByEmail(email) {
      return table.first('email_verified AND lower(email) = lower($1)', [email]);
    },

    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'seq');
    },

    async update(identityId, mutate) {
      return table.mutate([identityId], mutate);
    },

    async reassignAccount(fromAccountId, toAccountId) {
      return table.reassign('account_id', 'accountId', fromAccountId, toAccountId);
    },

    async countAccountsByAnonymousSubject(subject) {
      const row = await pool.maybeOne<{ n: number }>(
        `SELECT count(DISTINCT account_id)::int AS n
           FROM somemore.identities
          WHERE provider = 'anonymous' AND subject = $1`,
        [subject],
      );
      return row?.n ?? 0;
    },
  };
}

/** Backs `magic_links`. */
export function createPostgresMagicLinkRepository(pool: PgPool): MagicLinkRepository {
  const table = new DocTable<MagicLinkRecord>(pool, {
    table: 'magic_links',
    entityName: 'magic link',
    primaryKey: ['token'],
    keyOf: (m) => [m.token],
    project: (m) => ({
      email: m.email,
      requested_by_account_id: m.requestedByAccountId,
      created_at: m.createdAt,
      expires_at: m.expiresAt,
      consumed_at: m.consumedAt,
    }),
  });

  return {
    async create(record) {
      return table.insert(record);
    },

    async get(token) {
      return table.find([token]);
    },

    /**
     * Consume-once. `consumed_at IS NULL` in the UPDATE predicate is what makes
     * this safe: two clients following the same emailed link race in the
     * database, and exactly one of them gets a row back.
     *
     * `$2::text::timestamptz` rather than `$2::timestamptz`: the same parameter
     * is also written into the document as a string, and Postgres refuses to
     * deduce two types for one placeholder.
     */
    async consume(token, at) {
      const row = await pool.maybeOne<{ doc: MagicLinkRecord }>(
        `UPDATE somemore.magic_links
            SET consumed_at = $2::text::timestamptz,
                doc = jsonb_set(doc, '{consumedAt}', to_jsonb($2::text), true)
          WHERE token = $1 AND consumed_at IS NULL
        RETURNING doc`,
        [token, at],
      );
      return row === null ? null : row.doc;
    },
  };
}
