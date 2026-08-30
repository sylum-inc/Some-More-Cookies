import type { Server } from 'node:http';
import { systemClock, type Clock } from './clock.js';
import { loadConfig, type ApiConfig, type ConfigWarning } from './config.js';
import { createLogger, type Logger } from './logging.js';
import { idFactory, type IdFactory } from './ids.js';
import { createConsoleMailer, type Mailer } from './mailer.js';
import { createMemoryRateLimiter, createPostgresRateLimiter, type RateLimiter } from './ratelimit.js';
import { createTokenSigner } from './auth/tokens.js';
import { createIdempotencyLayer } from './idempotency.js';
import { createFakePaymentProvider } from './payments/fake.js';
import { createStripePaymentProvider } from './payments/stripe.js';
import type { PaymentProvider } from './payments/types.js';
import { createInMemoryRepositories } from './repos/memory/index.js';
import { createDatabase, type Database } from './db/index.js';
import type { Repositories } from './repos/interfaces.js';
import { seedProducts, seedPromotions, seedRewards } from './domain/seed.js';
import { createAnalyticsService } from './domain/analytics.js';
import { createCampsiteService } from './domain/campsites.js';
import { createCodesService } from './domain/codes.js';
import { createLiveOpsService } from './domain/liveops.js';
import { createCommerceService } from './domain/commerce.js';
import { createIdentityService } from './domain/identity.js';
import { createModerationService } from './domain/moderation.js';
import { createPassportService } from './domain/passport.js';
import { createRewardsService } from './domain/rewards.js';
import { createSandwichService } from './domain/sandwiches.js';
import { createSessionService } from './domain/sessions.js';
import { createWorldStateService } from './domain/worldState.js';
import { createMediaService } from './domain/media.js';
import { createLocalMediaStorage } from './media/local.js';
import { createS3MediaStorage } from './media/s3.js';
import { createUploadTicketSigner } from './media/ticket.js';
import type { MediaStorage } from './media/types.js';
import type { DomainDeps } from './domain/types.js';
import { createCodeSigner, createOperatorGate } from './codes/signing.js';
import { Router } from './http/router.js';
import { createApiServer } from './http/server.js';
import { buildRoutes } from './routes/index.js';
import type { ServiceRegistry } from './services.js';

export interface AppOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly clock?: Clock;
  readonly ids?: IdFactory;
  readonly repositories?: Repositories;
  /**
   * An already-open database to use instead of the one `DATABASE_URL` would
   * open. Tests share one across a file so each case is not paying for a fresh
   * pool and a fresh migration run.
   */
  readonly database?: Database;
  /** Overrides the limiter the database would otherwise choose. For tests. */
  readonly rateLimiter?: RateLimiter;
  readonly mailer?: Mailer;
  readonly payments?: PaymentProvider;
  readonly logger?: Logger;
  /** Injected by the media tests so an adapter can be driven directly. */
  readonly mediaStorage?: MediaStorage;
}

export interface App {
  readonly server: Server;
  readonly router: Router;
  /**
   * The bearer-token check, exposed so the realtime transport can perform the
   * *same* one rather than growing a second auth model (`RealtimeDeps`).
   */
  readonly authenticate: (token: string, now: Date) => Promise<{ accountId: string }>;
  readonly services: ServiceRegistry;
  readonly repos: Repositories;
  /** Non-null when this deployment is backed by Postgres. */
  readonly database: Database | null;
  readonly config: ApiConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly mailer: Mailer;
  readonly payments: PaymentProvider;
  readonly mediaStorage: MediaStorage;
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

  /*
   * Storage selection, in one place:
   *   explicit repositories  -> whatever the caller injected (tests)
   *   an injected database   -> its Postgres repositories
   *   DATABASE_URL is set    -> Postgres, migrated and seeded on first query
   *   otherwise              -> in memory, having warned about it
   */
  const seed = { products: seedProducts(), promotions: seedPromotions(), rewards: seedRewards() };

  let database: Database | null = null;
  if (options.repositories === undefined) {
    if (options.database !== undefined) {
      database = options.database;
    } else if (config.databaseUrl !== null) {
      database = createDatabase({
        url: config.databaseUrl,
        logger,
        seed,
        autoMigrate: config.databaseAutoMigrate,
        pool: {
          maxConnections: config.databasePoolMax,
          minConnections: config.databasePoolMin,
          idleTimeoutMs: config.databaseIdleTimeoutMs,
          acquireTimeoutMs: config.databaseAcquireTimeoutMs,
          connectTimeoutMs: config.databaseConnectTimeoutMs,
          statementTimeoutMs: config.databaseStatementTimeoutMs,
        },
      });
    }
  }

  const repos = options.repositories ?? database?.repos ?? createInMemoryRepositories(seed);

  const mailer = options.mailer ?? createConsoleMailer(logger);
  /*
   * The limiter follows the database, exactly as the repositories do.
   *
   * With Postgres it is a shared budget across every instance (Blocker 11);
   * without one it is the in-memory counter, which is the right answer for a
   * single node and for the tests and is what it always was. One question,
   * asked in one place, and the two implementations are the same fixed-window
   * arithmetic so the tests mean something either way.
   */
  const rateLimiter =
    options.rateLimiter ??
    (database !== null ? createPostgresRateLimiter(database.pool, clock) : createMemoryRateLimiter(clock));
  const tokens = createTokenSigner(config.authTokenSecret, config.authTokenTtlSeconds);

  const payments: PaymentProvider =
    options.payments ??
    (config.paymentProvider === 'stripe'
      ? createStripePaymentProvider({ config, clock, logger: logger.child({ component: 'stripe' }) })
      : createFakePaymentProvider({ clock }));

  /*
   * Object storage, selected in one place by one question, exactly as the
   * repositories are: which adapter, and does it have what it needs? The
   * local adapter is a real store rather than a stand-in, so the default is a
   * working upload path rather than a disabled one — and it says in the boot
   * warnings and at `/v1/meta` precisely what kind of store it is.
   */
  const mediaStorage: MediaStorage =
    options.mediaStorage ??
    (config.mediaStorage === 's3'
      ? createS3MediaStorage({
          bucket: config.mediaBucket,
          region: config.mediaS3Region,
          accessKeyId: config.mediaS3AccessKeyId,
          secretAccessKey: config.mediaS3SecretAccessKey,
          endpoint: config.mediaS3Endpoint,
          forcePathStyle: config.mediaS3ForcePathStyle,
          publicBaseUrl: config.mediaPublicBaseUrl,
          clock,
          logger: logger.child({ component: 's3' }),
        })
      : createLocalMediaStorage({
          root: config.mediaLocalRoot,
          bucket: config.mediaBucket,
          logger: logger.child({ component: 'media' }),
        }));

  const deps: DomainDeps = { repos, clock, ids, logger, config, payments, mailer, rateLimiter, tokens };

  const codeSigner = createCodeSigner({ config, logger });
  const operators = createOperatorGate(config);

  const passports = createPassportService(deps);
  const identity = createIdentityService(deps, passports);
  const campsites = createCampsiteService(deps, passports, codeSigner);
  const worldState = createWorldStateService(deps, campsites, passports);
  const sessions = createSessionService(deps, campsites);
  const rewards = createRewardsService(deps, passports);
  const sandwiches = createSandwichService(deps, campsites, passports, rewards);
  const commerce = createCommerceService(deps, rewards);
  const moderation = createModerationService(deps);
  const analytics = createAnalyticsService(deps);
  const liveOps = createLiveOpsService(deps);
  const codes = createCodesService(deps, codeSigner, rewards);
  const media = createMediaService(
    deps,
    {
      storage: mediaStorage,
      tickets: createUploadTicketSigner(config.authTokenSecret),
      ticketTtlSeconds: config.mediaUploadTtlSeconds,
      maxBytes: config.mediaMaxBytes,
    },
    passports,
  );

  const services: ServiceRegistry = {
    identity,
    passports,
    campsites,
    sessions,
    worldState,
    media,
    sandwiches,
    rewards,
    commerce,
    moderation,
    analytics,
    liveOps,
    codes,
    operators,
    capabilities: {
      paymentProvider: payments.name,
      paymentsConfigured: payments.isConfigured(),
      identityProviders: config.allowUnverifiedOidc
        ? (['apple', 'google', 'email'] as const)
        : (['email'] as const),
      mailer: mailer.name,
      persistence: database === null ? 'memory' : 'postgres',
      liveOpsAuthoring: operators.isConfigured(),
      codeVerification: codeSigner.isConfigured(),
      codeMinting: codeSigner.canMint(),
      mediaStorage: mediaStorage.name,
      mediaConfigured: mediaStorage.isConfigured(),
      mediaBucket: mediaStorage.bucket,
      mediaMaxBytes: config.mediaMaxBytes,
      mediaUnavailableReason: mediaStorage.unavailableReason(),
    },
    database,
  };

  const router = new Router(buildRoutes(services));
  const idempotency = createIdempotencyLayer({ repo: repos.idempotency, clock, config, logger });

  async function authenticate(token: string, now: Date) {
    const payload = tokens.verify(token, now);
    const account = await identity.requireActiveAccount(payload.sub);
    return {
      accountId: account.id,
      token,
      issuedAt: new Date(payload.iat * 1000),
      expiresAt: new Date(payload.exp * 1000),
    };
  }

  const server = createApiServer({
    router,
    config,
    clock,
    logger,
    idempotency,
    authenticate,
  });

  return {
    server,
    router,
    authenticate,
    services,
    repos,
    database,
    config,
    clock,
    logger,
    mailer,
    payments,
    mediaStorage,
    rateLimiter,
    warnings,
  };
}
