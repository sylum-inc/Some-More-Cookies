import type { Product, Promotion, RewardDefinition } from '@somemore/protocol';
import type { PgClient, PgPool } from '../../db/wire/index.js';
import type { Repositories } from '../interfaces.js';
import {
  createPostgresAccountRepository,
  createPostgresIdentityRepository,
  createPostgresMagicLinkRepository,
} from './identity.js';
import { createPostgresPassportRepository, createPostgresPhotoRepository } from './passport.js';
import { createPostgresCampsiteRepository, createPostgresInviteRepository } from './campsites.js';
import { createPostgresLandmarkRepository, createPostgresTraceRepository } from './world.js';
import { createPostgresAuthorityRepository, createPostgresSessionRepository } from './sessions.js';
import { createPostgresSandwichRepository } from './sandwiches.js';
import {
  createPostgresRewardClaimRepository,
  createPostgresRewardDefinitionRepository,
  createPostgresRewardGrantRepository,
  seedRewardDefinitions,
} from './rewards.js';
import {
  createPostgresCartRepository,
  createPostgresIdempotencyRepository,
  createPostgresOrderRepository,
  createPostgresProductRepository,
  createPostgresPromotionRepository,
  seedProductCatalog,
  seedPromotionCatalog,
} from './commerce.js';
import { createPostgresModerationRepository } from './moderation.js';
import { createPostgresAnalyticsRepository } from './analytics.js';

export interface PostgresRepositorySeed {
  readonly products?: readonly Product[];
  readonly promotions?: readonly Promotion[];
  readonly rewards?: readonly RewardDefinition[];
}

/**
 * The Postgres implementation of every repository interface.
 *
 * It mirrors `../memory/` method for method, including which `ApiError` each
 * failure raises — the whole API test suite runs against both, which is the
 * only way to know that "mirrors" is true rather than intended.
 */
export function createPostgresRepositories(pool: PgPool): Repositories {
  return {
    accounts: createPostgresAccountRepository(pool),
    identities: createPostgresIdentityRepository(pool),
    magicLinks: createPostgresMagicLinkRepository(pool),
    passports: createPostgresPassportRepository(pool),
    photos: createPostgresPhotoRepository(pool),
    campsites: createPostgresCampsiteRepository(pool),
    invites: createPostgresInviteRepository(pool),
    traces: createPostgresTraceRepository(pool),
    landmarks: createPostgresLandmarkRepository(pool),
    sessions: createPostgresSessionRepository(pool),
    authority: createPostgresAuthorityRepository(pool),
    sandwiches: createPostgresSandwichRepository(pool),
    rewardDefinitions: createPostgresRewardDefinitionRepository(pool),
    rewardGrants: createPostgresRewardGrantRepository(pool),
    rewardClaims: createPostgresRewardClaimRepository(pool),
    products: createPostgresProductRepository(pool),
    carts: createPostgresCartRepository(pool),
    orders: createPostgresOrderRepository(pool),
    promotions: createPostgresPromotionRepository(pool),
    idempotency: createPostgresIdempotencyRepository(pool),
    moderation: createPostgresModerationRepository(pool),
    analytics: createPostgresAnalyticsRepository(pool),
  };
}

/**
 * Insert the launch content the service ships with. Idempotent: rows already
 * present are left exactly as they are, so a redeploy never resets inventory or
 * a reward's `globalClaimed` counter.
 */
export async function seedPostgresCatalog(client: PgClient, seed: PostgresRepositorySeed): Promise<void> {
  await seedProductCatalog(client, seed.products ?? []);
  await seedPromotionCatalog(client, seed.promotions ?? []);
  await seedRewardDefinitions(client, seed.rewards ?? []);
}

export { seedProductCatalog, seedPromotionCatalog, seedRewardDefinitions };
