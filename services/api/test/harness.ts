import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { SCHEMA_VERSION } from '@somemore/protocol';
import { createApp, type App } from '../src/app.js';
import { createManualClock } from '../src/clock.js';
import { createFakePaymentProvider, type FakePaymentProvider } from '../src/payments/fake.js';
import { createLogger } from '../src/logging.js';
import type { Mailer, OutboundMail } from '../src/mailer.js';

export const TEST_START = '2026-08-29T12:00:00.000Z';

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
  readonly clock: ReturnType<typeof createManualClock>;
  readonly payments: FakePaymentProvider;
  readonly mailer: TestMailer;
  request<T = any>(path: string, options?: RequestOptions): Promise<ApiResponse<T>>;
  close(): Promise<void>;
}

/** Boot the real HTTP server on an ephemeral port and drive it with `fetch`. */
export async function startTestApi(env: Record<string, string> = {}): Promise<TestHarness> {
  const clock = createManualClock(TEST_START);
  const payments = createFakePaymentProvider({ clock, webhookSecret: 'whsec_test' });
  const mailer = createTestMailer();
  const logger = createLogger({ logLevel: 'silent' });

  const app = createApp({
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
  });

  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    app,
    baseUrl,
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
