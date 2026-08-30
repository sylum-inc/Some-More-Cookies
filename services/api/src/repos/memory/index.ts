import type { Product, Promotion, RewardDefinition } from '@somemore/protocol';
import type { Repositories } from '../interfaces.js';
import {
  createMemoryAccountRepository,
  createMemoryIdentityRepository,
  createMemoryMagicLinkRepository,
} from './identity.js';
import { createMemoryPassportRepository, createMemoryPhotoRepository } from './passport.js';
import { createMemoryCampsiteRepository, createMemoryInviteRepository } from './campsites.js';
import {
  createMemoryCampsiteMemoryRepository,
  createMemoryLandmarkRepository,
  createMemoryTraceRepository,
} from './world.js';
import { createMemoryAuthorityRepository, createMemorySessionRepository } from './sessions.js';
import { createMemorySandwichRepository } from './sandwiches.js';
import {
  createMemoryRewardClaimRepository,
  createMemoryRewardDefinitionRepository,
  createMemoryRewardGrantRepository,
} from './rewards.js';
import {
  createMemoryCartRepository,
  createMemoryIdempotencyRepository,
  createMemoryOrderRepository,
  createMemoryProductRepository,
  createMemoryPromotionRepository,
} from './commerce.js';
import {
  createMemoryCodeBatchRepository,
  createMemoryCodeRedemptionRepository,
  createMemoryContentDocumentRepository,
  createMemoryContentReleaseRepository,
} from './liveops.js';
import { createMemoryModerationRepository } from './moderation.js';
import { createMemoryAnalyticsRepository } from './analytics.js';

export interface MemoryRepositorySeed {
  readonly products?: readonly Product[];
  readonly promotions?: readonly Promotion[];
  readonly rewards?: readonly RewardDefinition[];
}

/**
 * The complete in-memory implementation of every repository interface. It is
 * what the tests and `npm run api` use; the Postgres adapter implements the
 * same interfaces against `sql/schema.sql`.
 */
export function createInMemoryRepositories(seed: MemoryRepositorySeed = {}): Repositories {
  return {
    accounts: createMemoryAccountRepository(),
    identities: createMemoryIdentityRepository(),
    magicLinks: createMemoryMagicLinkRepository(),
    passports: createMemoryPassportRepository(),
    photos: createMemoryPhotoRepository(),
    campsites: createMemoryCampsiteRepository(),
    invites: createMemoryInviteRepository(),
    traces: createMemoryTraceRepository(),
    landmarks: createMemoryLandmarkRepository(),
    campsiteMemories: createMemoryCampsiteMemoryRepository(),
    sessions: createMemorySessionRepository(),
    authority: createMemoryAuthorityRepository(),
    sandwiches: createMemorySandwichRepository(),
    rewardDefinitions: createMemoryRewardDefinitionRepository(seed.rewards ?? []),
    rewardGrants: createMemoryRewardGrantRepository(),
    rewardClaims: createMemoryRewardClaimRepository(),
    contentDocuments: createMemoryContentDocumentRepository(),
    contentReleases: createMemoryContentReleaseRepository(),
    codeBatches: createMemoryCodeBatchRepository(),
    codeRedemptions: createMemoryCodeRedemptionRepository(),
    products: createMemoryProductRepository(seed.products ?? []),
    carts: createMemoryCartRepository(),
    orders: createMemoryOrderRepository(),
    promotions: createMemoryPromotionRepository(seed.promotions ?? []),
    idempotency: createMemoryIdempotencyRepository(),
    moderation: createMemoryModerationRepository(),
    analytics: createMemoryAnalyticsRepository(),
  };
}
