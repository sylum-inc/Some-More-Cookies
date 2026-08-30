import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { afterAll } from 'vitest';
import { SCHEMA_VERSION } from '@somemore/protocol';
import { createApp, type App } from '../src/app.js';
import { createManualClock } from '../src/clock.js';
import { createMemoryRateLimiter } from '../src/ratelimit.js';
import { createFakePaymentProvider, type FakePaymentProvider } from '../src/payments/fake.js';
import { createLogger, silentLogger } from '../src/logging.js';
import type { Mailer, OutboundMail } from '../src/mailer.js';
import { createDatabase, parseDatabaseUrl, PgPool, truncateData, type Database } from '../src/db/index.js';
import { seedPostgresCatalog } from '../src/repos/postgres/index.js';
import { seedProducts, seedPromotions, seedRewards } from '../src/domain/seed.js';
import type { OperatorCapability, OperatorRole } from '@somemore/protocol';

export const TEST_START = '2026-08-29T12:00:00.000Z';

/* -------------------------------------------------------------------------- */
/* Which backend this run is exercising                                        */
/* -------------------------------------------------------------------------- */

/*
 * The suite runs twice against the same assertions: once on the in-memory
 * repositories and once on Postgres. `DATABASE_URL` is the only switch.
 *
 * Vitest runs test files in parallel workers, so each worker gets its own
 * database (`<name>_w<pool id>`) rather than fighting over one. Within a
 * worker, files run one at a time and every case starts from a truncated
 * schema, which is the closest thing to the in-memory "new Map()" that a real
 * database can offer.
 */
const ADMIN_DATABASE_URL = process.env['DATABASE_URL'] ?? null;

export const PERSISTENCE: 'memory' | 'postgres' = ADMIN_DATABASE_URL === null ? 'memory' : 'postgres';

const SEED = { products: seedProducts(), promotions: seedPromotions(), rewards: seedRewards() };

function workerDatabaseName(base: string): string {
  const worker = process.env['VITEST_POOL_ID'] ?? process.env['VITEST_WORKER_ID'] ?? '1';
  return `${base}_w${worker}`;
}

/** `CREATE DATABASE` if it is not already there, then hand back its URL. */
async function ensureWorkerDatabase(adminUrl: string): Promise<string> {
  const adminConfig = parseDatabaseUrl(adminUrl, { maxConnections: 1, searchPath: null });
  const name = workerDatabaseName(adminConfig.database);
  const admin = new PgPool(adminConfig);
  try {
    const existing = await admin.maybeOne<{ ok: number }>(
      'SELECT 1 AS ok FROM pg_database WHERE datname = $1',
      [name],
    );
    if (existing === null) {
      // Racing workers are fine: one wins, the rest see 42P04 and move on.
      try {
        await admin.query(`CREATE DATABASE "${name}"`);
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code !== '42P04') throw error;
      }
    }
  } finally {
    await admin.end();
  }
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  return url.toString();
}

let databasePromise: Promise<Database> | null = null;

/** One migrated database per worker, opened lazily and shared by every case. */
async function sharedDatabase(): Promise<Database> {
  if (ADMIN_DATABASE_URL === null) throw new Error('no DATABASE_URL');
  databasePromise ??= (async () => {
    const url = await ensureWorkerDatabase(ADMIN_DATABASE_URL);
    const database = createDatabase({
      url,
      logger: silentLogger,
      seed: SEED,
      pool: { maxConnections: 12, statementTimeoutMs: 20_000 },
    });
    await database.ready();
    return database;
  })();
  return databasePromise;
}

afterAll(async () => {
  if (databasePromise === null) return;
  const database = await databasePromise.catch(() => null);
  databasePromise = null;
  if (database !== null) await database.close();
});

export interface TestMailer extends Mailer {
  readonly sent: OutboundMail[];
  lastToken(): string | null;
}

function createTestMailer(): TestMailer {
  const sent: OutboundMail[] = [];
  return {
    name: 'test',
    outbox: sent,
    sent,
    async send(mail) {
      sent.push(mail);
    },
    lastToken() {
      for (let i = sent.length - 1; i >= 0; i -= 1) {
        const token = sent[i]?.magicLinkToken;
        if (token !== undefined) return token;
      }
      return null;
    },
  };
}

export interface ApiResponse<T = any> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface RequestOptions {
  readonly method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  readonly body?: unknown;
  readonly token?: string | null;
  readonly headers?: Record<string, string>;
  readonly rawBody?: string;
}

export interface TestHarness {
  readonly app: App;
  readonly baseUrl: string;
  /** Which storage backend this run is exercising. */
  readonly persistence: 'memory' | 'postgres';
  readonly clock: ReturnType<typeof createManualClock>;
  readonly payments: FakePaymentProvider;
  readonly mailer: TestMailer;
  request<T = any>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

/**
 * Makes an account an operator (README, Blocker 9).
 *
 * Straight through the directory rather than over HTTP, because almost every
 * test that needs this is testing something else and the grant is setup. The
 * bootstrap route and the capability check on the grant route have their own
 * tests in `operators.test.ts`, which is where that path is the subject.
 */
export async function grantOperator(
  api: TestHarness,
  accountId: string,
  request: { role?: OperatorRole; capabilities?: OperatorCapability[] },
): Promise<void> {
  await api.app.services.operatorDirectory.grant(
    { accountId, ...request } as never,
    'acct_test_bootstrap',
  );
}

export interface StartTestApiOptions {
  /**
   * Truncate the database before booting. On by default so every case starts
   * from nothing, exactly as it would with a fresh set of Maps. Pass `false` to
   * model a process restart against a database that is already populated.
   */
  readonly resetDatabase?: boolean;
  /**
   * Boot without a payment provider, the way a deployment with no processor
   * credentials actually runs. The order path still works end to end; only the
   * payment intent is refused, which is the state a client must be able to
   * report honestly.
   */
  readonly paymentsConfigured?: boolean;
}

/** Boot the real HTTP server on an ephemeral port and drive it with `fetch`. */
export async function startTestApi(
  env: Record<string, string> = {},
  options: StartTestApiOptions = {},
): Promise<TestHarness> {
  const clock = createManualClock(TEST_START);
  const configured = createFakePaymentProvider({ clock, webhookSecret: 'whsec_test' });
  const payments: FakePaymentProvider =
    options.paymentsConfigured === false ? { ...configured, isConfigured: () => false } : configured;
  const mailer = createTestMailer();
  // Silent by default; pass LOG_LEVEL to a single `startTestApi` call when a
  // failing case needs the server's own account of what went wrong.
  const levels = ['debug', 'info', 'warn', 'error', 'silent'] as const;
  const requested = levels.find((level) => level === env['LOG_LEVEL']);
  const logger = createLogger({ logLevel: requested ?? 'silent' });

  let database: Database | undefined;
  if (ADMIN_DATABASE_URL !== null) {
    database = await sharedDatabase();
    if (options.resetDatabase !== false) {
      await truncateData(database.pool);
      await database.pool.withClient((client) => seedPostgresCatalog(client, SEED));
    }
  }

  /*
   * The limiter is the in-memory one in tests, on both backends, and that is a
   * deliberate seam rather than a shortcut.
   *
   * The Postgres limiter takes its window from the database's `now()` — one
   * clock that no instance can push around, which is the point of a shared
   * budget — so the manual clock these tests advance to prove a window rolls
   * over cannot move it. Injecting the in-memory limiter keeps every *route*
   * test deterministic on both backends, and the Postgres limiter's own window
   * behaviour is asserted directly against a real database in
   * `postgres.test.ts`. Two questions, tested where each can actually be
   * answered.
   */
  const app = createApp({
    rateLimiter: createMemoryRateLimiter(clock),
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUTH_TOKEN_SECRET: 'test-token-secret-do-not-ship',
      IP_HASH_SALT: 'test-ip-salt',
      PAYMENT_PROVIDER: 'fake',
      ...env,
    },
    clock,
    payments,
    mailer,
    logger,
    ...(database === undefined ? {} : { database }),
  });

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
    persistence: PERSISTENCE,
    clock,
    payments,
    mailer,

    async request(path, options = {}) {
      const headers: Record<string, string> = { ...(options.headers ?? {}) };
      let body: string | undefined;
      if (options.rawBody !== undefined) {
        body = options.rawBody;
        headers['content-type'] ??= 'application/json';
      } else if (options.body !== undefined) {
        body = JSON.stringify(options.body);
        headers['content-type'] = 'application/json';
      }
      if (options.token !== undefined && options.token !== null) {
        headers['authorization'] = `Bearer ${options.token}`;
      }
      const response = await fetch(`${baseUrl}${path}`, {
        method: options.method ?? (body === undefined ? 'GET' : 'POST'),
        headers,
        body,
      });
      const text = await response.text();
      const parsed = text.length === 0 ? null : (JSON.parse(text) as unknown);
      return { status: response.status, body: parsed as any, headers: response.headers };
    },

    async close() {
      await new Promise<void>((resolve, reject) =>
        app.server.close((error) => (error === undefined ? resolve() : reject(error))),
      );
      // The database is shared across the file; `afterAll` closes it.
    },
  };
}

export function key(prefix = 'idem'): string {
  return `${prefix}-${randomUUID()}`;
}

export interface Player {
  readonly accountId: string;
  readonly token: string;
  readonly deviceId: string;
}

export async function bootstrap(api: TestHarness, displayName = 'Camper'): Promise<Player> {
  const deviceId = `device-${randomUUID()}`;
  const response = await api.request('/v1/auth/anonymous', {
    method: 'POST',
    body: {
      device: { deviceId, platform: 'ios', appVersion: '0.3.0', locale: 'en-US' },
      displayName,
    },
  });
  if (response.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(response.body)}`);
  return { accountId: response.body.account.id, token: response.body.auth.token, deviceId };
}

export async function createCampsite(
  api: TestHarness,
  player: Player,
  overrides: Record<string, unknown> = {},
): Promise<any> {
  const response = await api.request('/v1/campsites', {
    method: 'POST',
    token: player.token,
    body: { idempotencyKey: key('camp'), name: 'Pine Hollow', ...overrides },
  });
  if (response.status !== 201) throw new Error(`createCampsite failed: ${JSON.stringify(response.body)}`);
  return response.body;
}

/** A well-made sandwich: golden roast, tidy assembly, clean machine run. */
export function sandwichPayload(campsiteId: string, machineSerial: string, overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key('swh'),
    campsiteId,
    name: 'The First One',
    roast: {
      durationMs: 92_000,
      averageDistanceCm: 21.5,
      minimumDistanceCm: 12,
      rotations: 14.5,
      evenness: 0.94,
      peakSurfaceTempC: 172,
      charFraction: 0.06,
      meltFraction: 0.82,
      ignited: false,
      flareUps: 0,
      blownOut: false,
      dropped: false,
      grade: 'golden',
      simVersion: '0.4.1',
    },
    assembly: {
      alignment: 0.95,
      chocolateCoverage: 0.92,
      grahamIntegrity: 1,
      squish: 0.35,
      heatTransfer: 0.9,
      layerOrderCorrect: true,
      assembledInSeconds: 11.2,
      defects: [],
      score: 0.94,
    },
    machineRun: {
      machineSerial,
      program: 'classic',
      startedAt: TEST_START,
      completedAt: TEST_START,
      chillSeconds: 42,
      pressForceN: 310,
      churnRpm: 120,
      coreTempC: -6.5,
      outcome: 'success',
      anomalies: [],
      quirkCodesApplied: [],
      wearDelta: { drum: 0.001, press: 0.002, chiller: 0.0015, dispenser: 0.0005, hopper: 0.0004, belt: 0.0009 },
      firmwareVersion: '2.1.0',
    },
    flavorTags: ['campfire'],
    photoIds: [],
    ...overrides,
  };
}

export const US_ADDRESS = {
  name: 'Rowan Ash',
  line1: '18 Kindling Lane',
  city: 'Bend',
  region: 'OR',
  postalCode: '97701',
  country: 'US',
};

export { SCHEMA_VERSION };
