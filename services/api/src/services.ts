import type { AnalyticsService } from './domain/analytics.js';
import type { CampsiteService } from './domain/campsites.js';
import type { CommerceService } from './domain/commerce.js';
import type { IdentityService } from './domain/identity.js';
import type { ModerationService } from './domain/moderation.js';
import type { PassportService } from './domain/passport.js';
import type { RewardsService } from './domain/rewards.js';
import type { SandwichService } from './domain/sandwiches.js';
import type { SessionService } from './domain/sessions.js';
import type { WorldStateService } from './domain/worldState.js';

/** What this deployment can actually do, surfaced at `GET /v1/meta`. */
export interface Capabilities {
  readonly paymentProvider: 'stripe' | 'fake';
  readonly paymentsConfigured: boolean;
  readonly mailer: string;
  readonly persistence: 'memory' | 'postgres';
}

/**
 * The nine domain modules. Route handlers may only reach the domain through
 * this registry; nothing outside `domain/` touches a repository directly.
 */
export interface ServiceRegistry {
  readonly identity: IdentityService;
  readonly passports: PassportService;
  readonly campsites: CampsiteService;
  readonly sessions: SessionService;
  readonly worldState: WorldStateService;
  readonly sandwiches: SandwichService;
  readonly rewards: RewardsService;
  readonly commerce: CommerceService;
  readonly moderation: ModerationService;
  readonly analytics: AnalyticsService;
  readonly capabilities: Capabilities;
}
