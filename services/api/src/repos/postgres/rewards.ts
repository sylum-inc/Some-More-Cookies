import type { RewardClaim, RewardDefinition, RewardGrant } from '@somemore/protocol';
import { ApiError } from '../../errors.js';
import { PgError, UNIQUE_VIOLATION, type PgClient, type PgPool } from '../../db/wire/index.js';
import type {
  RewardClaimRepository,
  RewardDefinitionRepository,
  RewardGrantRepository,
} from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `reward_definitions`. Seeded from `domain/seed.ts` at boot. */
export function createPostgresRewardDefinitionRepository(pool: PgPool): RewardDefinitionRepository {
  const table = new DocTable<RewardDefinition>(pool, {
    table: 'reward_definitions',
    entityName: 'reward',
    primaryKey: ['id'],
    keyOf: (r) => [r.id],
    project: (r) => ({ code: r.code }),
  });

  return {
    async list() {
      return table.all('seq');
    },
    async getByCode(code) {
      return table.first('code = $1', [code]);
    },
    async get(rewardId) {
      return table.find([rewardId]);
    },
    /**
     * `globalClaimed` is incremented through this path, so the read-modify-write
     * has to hold a row lock — otherwise two simultaneous grants of the same
     * legendary reward both read the same count and the global limit leaks.
     */
    async update(rewardId, mutate) {
      return table.mutate([rewardId], mutate);
    },
  };
}

/**
 * Idempotent catalog seeding. Reward definitions are code, not user data: a
 * redeploy must not duplicate them, and must not clobber `globalClaimed`.
 */
export async function seedRewardDefinitions(client: PgClient, seed: readonly RewardDefinition[]): Promise<void> {
  for (const definition of seed) {
    await client.query(
      `INSERT INTO somemore.reward_definitions (id, code, doc)
       VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (id) DO NOTHING`,
      [definition.id, definition.code, definition],
    );
  }
}

/**
 * Backs `reward_grants`.
 *
 * `reward_grants_one_live_per_account_reward` is the database's own claim-once
 * rule. When two requests race, one INSERT wins and the other gets a unique
 * violation, which becomes the same `reward_already_claimed` the sequential
 * path produces — so a player never ends up holding two of a one-per-player
 * reward, no matter how the requests interleave.
 */
export function createPostgresRewardGrantRepository(pool: PgPool): RewardGrantRepository {
  const table = new DocTable<RewardGrant>(pool, {
    table: 'reward_grants',
    entityName: 'reward grant',
    primaryKey: ['id'],
    keyOf: (g) => [g.id],
    project: (g) => ({
      account_id: g.accountId,
      reward_id: g.rewardId,
      status: g.status,
      granted_at: g.grantedAt,
    }),
  });

  return {
    async create(grant) {
      try {
        return await table.insert(grant);
      } catch (error) {
        const constraint =
          error instanceof PgError
            ? error.constraint
            : error instanceof ApiError &&
                typeof error.details === 'object' &&
                error.details !== null &&
                'constraint' in error.details
              ? error.details.constraint
              : null;
        if (constraint === 'reward_grants_one_live_per_account_reward') {
          throw new ApiError('reward_already_claimed', 'You have already claimed that reward.', {
            details: { rewardCode: grant.rewardCode },
            cause: error,
          });
        }
        throw error;
      }
    },

    async get(grantId) {
      return table.find([grantId]);
    },

    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'seq');
    },

    async countForAccountAndReward(accountId, rewardId) {
      return table.count("account_id = $1 AND reward_id = $2 AND status <> 'revoked'", [accountId, rewardId]);
    },

    async update(grantId, mutate) {
      return table.mutate([grantId], mutate);
    },

    /**
     * Merge support. Moved grants are stamped `merged_in`, which lifts them out
     * of the claim-once index: the surviving account may legitimately end up
     * holding the same stamp twice, once earned per device.
     */
    async reassignAccount(fromAccountId, toAccountId) {
      const result = await pool.query(
        `UPDATE somemore.reward_grants
            SET account_id = $2,
                merged_in = true,
                doc = jsonb_set(doc, '{accountId}', to_jsonb($2::text), true)
          WHERE account_id = $1`,
        [fromAccountId, toAccountId],
      );
      return result.rowCount;
    },
  };
}

/** Backs `reward_claims`: the audited path for real-world perks. */
export function createPostgresRewardClaimRepository(pool: PgPool): RewardClaimRepository {
  const table = new DocTable<RewardClaim>(pool, {
    table: 'reward_claims',
    entityName: 'reward claim',
    primaryKey: ['id'],
    keyOf: (c) => [c.id],
    project: (c) => ({
      account_id: c.accountId,
      reward_id: c.rewardId,
      state: c.state,
      client_nonce: c.antiAbuse.clientNonce,
      requested_at: c.requestedAt,
    }),
  });

  return {
    async create(claim) {
      try {
        return await table.insert(claim);
      } catch (error) {
        const constraint =
          error instanceof PgError
            ? error.constraint
            : error instanceof ApiError &&
                typeof error.details === 'object' &&
                error.details !== null &&
                'constraint' in error.details
              ? error.details.constraint
              : null;
        if (constraint === 'reward_claims_one_open_per_account_reward') {
          throw new ApiError('reward_already_claimed', 'You already have a claim open for that reward.', {
            details: { rewardCode: claim.rewardCode },
            cause: error,
          });
        }
        throw error;
      }
    },

    async get(claimId) {
      return table.find([claimId]);
    },

    async listByAccount(accountId) {
      return table.list('account_id = $1', [accountId], 'seq');
    },

    async findByAccountAndReward(accountId, rewardId) {
      return table.first("account_id = $1 AND reward_id = $2 AND state <> 'rejected'", [accountId, rewardId], 'seq');
    },

    async findByNonce(nonce) {
      return table.first('client_nonce = $1', [nonce], 'seq');
    },

    async countSince(accountId, sinceIso) {
      return table.count('account_id = $1 AND requested_at >= $2::timestamptz', [accountId, sinceIso]);
    },

    async update(claimId, mutate) {
      return table.mutate([claimId], mutate);
    },
  };
}
