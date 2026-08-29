import type { RewardClaim, RewardDefinition, RewardGrant } from '@somemore/protocol';
import type {
  RewardClaimRepository,
  RewardDefinitionRepository,
  RewardGrantRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';

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
