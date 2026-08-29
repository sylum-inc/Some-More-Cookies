import type { AnalyticsService } from './domain/analytics.js';
import type { CampsiteService } from './domain/campsites.js';
import type { CodesService } from './domain/codes.js';
import type { LiveOpsService } from './domain/liveops.js';
import type { CommerceService } from './domain/commerce.js';
import type { IdentityService } from './domain/identity.js';
import type { ModerationService } from './domain/moderation.js';
import type { PassportService } from './domain/passport.js';
import type { RewardsService } from './domain/rewards.js';
import type { SandwichService } from './domain/sandwiches.js';
import type { SessionService } from './domain/sessions.js';
import type { WorldStateService } from './domain/worldState.js';
import type { OperatorGate } from './codes/signing.js';
import type { Database } from './db/index.js';

/** What this deployment can actually do, surfaced at `GET /v1/meta`. */
export interface Capabilities {
  readonly paymentProvider: 'stripe' | 'fake';
  readonly paymentsConfigured: boolean;
  readonly mailer: string;
  readonly persistence: 'memory' | 'postgres';
  /** Can this deployment author content, or only serve what was published? */
  readonly liveOpsAuthoring: boolean;
  /** Can it verify scanned codes, and can it mint new ones? */
  readonly codeVerification: boolean;
  readonly codeMinting: boolean;
}

/**
 * The domain modules. Route handlers may only reach the domain through
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
  readonly liveOps: LiveOpsService;
  readonly codes: CodesService;
  /**
   * Operator authentication for live-ops writes. A shared secret standing in
   * for the staff identity provider we do not have (README, Blocker 9).
   */
  readonly operators: OperatorGate;
  readonly capabilities: Capabilities;
  /**
   * The open database, when there is one. Only `/health` reads it, and only to
   * report reachability — no route may reach a repository through this.
   */
  readonly database: Database | null;
}
