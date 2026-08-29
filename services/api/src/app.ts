import type { Server } from 'node:http';
import { systemClock, type Clock } from './clock.js';
import { loadConfig, type ApiConfig, type ConfigWarning } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { idFactory, type IdFactory } from './ids.js';
import { createConsoleMailer, type Mailer } from './mailer.js';
import { createMemoryRateLimiter, type RateLimiter } from './ratelimit.js';
import { createTokenSigner } from './auth/tokens.js';
import { createIdempotencyLayer } from './idempotency.js';
import { createFakePaymentProvider } from './payments/fake.js';
import { createStripePaymentProvider } from './payments/stripe.js';
import type { PaymentProvider } from './payments/types.js';
import { createInMemoryRepositories } from './repos/memory/index.js';
import type { Repositories } from './repos/interfaces.js';
import { seedProducts, seedPromotions, seedRewards } from './domain/seed.js';
import { createAnalyticsService } from './domain/analytics.js';
import { createCampsiteService } from './domain/campsites.js';
import { createCommerceService } from './domain/commerce.js';
import { createIdentityService } from './domain/identity.js';
import { createModerationService } from './domain/moderation.js';
import { createPassportService } from './domain/passport.js';
import { createRewardsService } from './domain/rewards.js';
import { createSandwichService } from './domain/sandwiches.js';
import { createSessionService } from './domain/sessions.js';
import { createWorldStateService } from './domain/worldState.js';
import type { DomainDeps } from './domain/types.js';
import { Router } from './http/router.js';
import { createApiServer } from './http/server.js';
import { buildRoutes } from './routes/index.js';
import type { ServiceRegistry } from './services.js';

export interface AppOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly repositories?: Repositories;
  readonly mailer?: Mailer;
  readonly payments?: PaymentProvider;
  readonly logger?: Logger;
}

export interface App {
  readonly server: Server;
  readonly router: Router;
  readonly services: ServiceRegistry;
  readonly repos: Repositories;
  readonly config: ApiConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mailer: Mailer;
  readonly payments: PaymentProvider;
  readonly rateLimiter: RateLimiter;
  readonly warnings: readonly ConfigWarning[];
}

/**
 * Composition root. Everything is constructed here and injected downward; no
 * module reaches for a global. Tests build an App with a manual clock, a fake
 * payment provider and fresh in-memory repositories.
 */
export function createApp(options: AppOptions = {}): App {
  const { config, warnings } = loadConfig(options.env);
  const logger = options.logger ?? createLogger(config, { service: 'somemore-api' });
  const clock = options.clock ?? systemClock;
  const ids = options.ids ?? idFactory;

  for (const warning of warnings) logger.warn(`config.${warning.code}`, { message: warning.message });

  const repos =
    options.repositories ??
    createInMemoryRepositories({
      products: seedProducts(),
      promotions: seedPromotions(),
      rewards: seedRewards(),
    });

  const mailer = options.mailer ?? createConsoleMailer(logger);
  const rateLimiter = createMemoryRateLimiter(clock);
  const tokens = createTokenSigner(config.authTokenSecret, config.authTokenTtlSeconds);

  const payments: PaymentProvider =
    options.payments ??
    (config.paymentProvider === 'stripe'
      ? createStripePaymentProvider({ config, clock, logger: logger.child({ component: 'stripe' }) })
      : createFakePaymentProvider({ clock }));

  const deps: DomainDeps = { repos, clock, ids, logger, config, payments, mailer, rateLimiter, tokens };

  const passports = createPassportService(deps);
  const identity = createIdentityService(deps, passports);
  const campsites = createCampsiteService(deps, passports);
  const worldState = createWorldStateService(deps, campsites, passports);
  const sessions = createSessionService(deps, campsites);
  const rewards = createRewardsService(deps, passports);
  const sandwiches = createSandwichService(deps, campsites, passports, rewards);
  const commerce = createCommerceService(deps, rewards);
  const moderation = createModerationService(deps);
  const analytics = createAnalyticsService(deps);

  const services: ServiceRegistry = {
    identity,
    passports,
    campsites,
    sessions,
    worldState,
    sandwiches,
    rewards,
    commerce,
    moderation,
    analytics,
    capabilities: {
      paymentProvider: payments.name,
      paymentsConfigured: payments.isConfigured(),
      mailer: mailer.name,
      persistence: options.repositories === undefined ? 'memory' : 'memory',
    },
  };

  const router = new Router(buildRoutes(services));
  const idempotency = createIdempotencyLayer({ repo: repos.idempotency, clock, config, logger });

  const server = createApiServer({
    router,
    config,
    clock,
    logger,
    idempotency,
    async authenticate(token, now) {
      const payload = tokens.verify(token, now);
      const account = await identity.requireActiveAccount(payload.sub);
      return {
        accountId: account.id,
        token,
        issuedAt: new Date(payload.iat * 1000),
        expiresAt: new Date(payload.exp * 1000),
      };
    },
  });

  return { server, router, services, repos, config, clock, logger, mailer, payments, rateLimiter, warnings };
}
