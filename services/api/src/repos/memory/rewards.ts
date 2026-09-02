import type { RewardClaim, RewardDefinition, RewardGrant } from '@somemore/protocol';
import type {
  RewardClaimRepository,
  RewardDefinitionRepository,
  RewardGrantRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';
import { ApiError } from '../../errors.js';

/** Backs `reward_definitions`. Seeded from code at boot (see domain/seed.ts). */
export function createMemoryRewardDefinitionRepository(
  seed: readonly RewardDefinition[] = [],
): RewardDefinitionRepository {
  const table = new MemoryTable<RewardDefinition>('reward', (r) => r.id);
  for (const definition of seed) table.put(definition);
  return {
    async list() {
      return table.all();
    },
    async getByCode(code) {
      return table.first((r) => r.code === code);
    },
    async get(rewardId) {
      return table.find(rewardId);
    },
    async update(rewardId, mutate) {
      return table.mutate(rewardId, mutate);
    },
  };
}

/** Backs `reward_grants`. */
export function createMemoryRewardGrantRepository(): RewardGrantRepository {
  const table = new MemoryTable<RewardGrant>('reward grant', (g) => g.id);
  return {
    async create(grant) {
      /*
       * `reward_grants_one_live_per_account_reward`, by hand.
       *
       * `sql/schema.sql` says at the top that where it declares a UNIQUE
       * constraint the memory implementation enforces the same invariant by
       * hand, and for this one it did not. The audit found that claim-once
       * still held here under a real two-request race — but only because no
       * `await` in that path crosses an I/O boundary, so the two handlers
       * cannot interleave. That is a property of the runtime, not an
       * invariant, and it would have evaporated the first time anything in the
       * claim path started actually waiting for something.
       *
       * A conflict rather than a silent no-op, because that is what Postgres
       * does with a unique violation and the two backends have to be the same
       * thing to be worth testing against.
       */
      const live = table.filter(
        (g) => g.accountId === grant.accountId && g.rewardId === grant.rewardId && g.status !== 'revoked',
      );
      if (grant.status !== 'revoked' && live.length > 0) {
        throw new ApiError(
          'conflict',
          `Account ${grant.accountId} already holds a live grant for reward ${grant.rewardId}.`,
        );
      }
      return table.insert(grant);
    },
    async get(grantId) {
      return table.find(grantId);
    },
    async listByAccount(accountId) {
      return table.filter((g) => g.accountId === accountId);
    },
    async countForAccountAndReward(accountId, rewardId) {
      return table.filter((g) => g.accountId === accountId && g.rewardId === rewardId && g.status !== 'revoked')
        .length;
    },
    async update(grantId, mutate) {
      return table.mutate(grantId, mutate);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const grant of table.filter((g) => g.accountId === fromAccountId)) {
        table.put({ ...grant, accountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
  };
}

/** Backs `reward_claims`. */
export function createMemoryRewardClaimRepository(): RewardClaimRepository {
  const table = new MemoryTable<RewardClaim>('reward claim', (c) => c.id);
  return {
    async create(claim) {
      return table.insert(claim);
    },
    async get(claimId) {
      return table.find(claimId);
    },
    async listByAccount(accountId) {
      return table.filter((c) => c.accountId === accountId);
    },
    async findByAccountAndReward(accountId, rewardId) {
      return table.first((c) => c.accountId === accountId && c.rewardId === rewardId && c.state !== 'rejected');
    },
    async findByNonce(nonce) {
      return table.first((c) => c.antiAbuse.clientNonce === nonce);
    },
    async countSince(accountId, sinceIso) {
      return table.filter((c) => c.accountId === accountId && c.requestedAt >= sinceIso).length;
    },
    async update(claimId, mutate) {
      return table.mutate(claimId, mutate);
    },
  };
}
