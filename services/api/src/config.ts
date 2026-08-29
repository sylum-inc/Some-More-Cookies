import { randomBytes } from 'node:crypto';

/**
 * All configuration is read from the environment exactly once, at construction
 * time. Nothing in the service reads `process.env` directly — that keeps tests
 * hermetic and makes the "what do we need to go live" list (see README
 * Blockers) exactly equal to the set of fields below with no default.
 */
export interface ApiConfig {
  readonly nodeEnv: 'development' | 'test' | 'production';
  readonly host: string;
  readonly port: number;
  readonly logLevel: 'debug' | 'info' | 'warn' | 'error' | 'silent';

  /** HMAC secret for session tokens. Dev fallback is generated + warned about. */
  readonly authTokenSecret: string;
  readonly authTokenSecretIsEphemeral: boolean;
  readonly authTokenTtlSeconds: number;
  readonly magicLinkTtlSeconds: number;

  /** Salt for hashing client IPs before they touch an anti-abuse record. */
  readonly ipHashSalt: string;

  readonly paymentProvider: 'stripe' | 'fake';
  readonly stripeSecretKey: string | null;
  readonly stripePublishableKey: string | null;
  readonly stripeWebhookSecret: string | null;
  readonly stripeApiBase: string;

  /** Object storage for photos: keys are minted here, bytes never touch us. */
  readonly mediaBucket: string;
  readonly mediaKeyPrefix: string;

  readonly idempotencyTtlSeconds: number;
  readonly maxBodyBytes: number;

  /** Claim-once + velocity limits for high-value rewards. */
  readonly rewardClaimWindowSeconds: number;
  readonly rewardClaimsPerWindow: number;
  readonly magicLinksPerWindow: number;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envString(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface ConfigWarning {
  readonly code: 'ephemeral_auth_secret' | 'fake_payments' | 'console_mailer' | 'ephemeral_ip_salt';
  readonly message: string;
}

export interface LoadedConfig {
  readonly config: ApiConfig;
  readonly warnings: readonly ConfigWarning[];
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): LoadedConfig {
  const warnings: ConfigWarning[] = [];
  const nodeEnvRaw = envString(env, 'NODE_ENV') ?? 'development';
  const nodeEnv: ApiConfig['nodeEnv'] =
    nodeEnvRaw === 'production' || nodeEnvRaw === 'test' ? nodeEnvRaw : 'development';

  let authTokenSecret = envString(env, 'AUTH_TOKEN_SECRET');
  let authTokenSecretIsEphemeral = false;
  if (authTokenSecret === null) {
    if (nodeEnv === 'production') {
      throw new Error('AUTH_TOKEN_SECRET is required in production — refusing to start with a dev fallback.');
    }
    authTokenSecret = randomBytes(32).toString('hex');
    authTokenSecretIsEphemeral = true;
    warnings.push({
      code: 'ephemeral_auth_secret',
      message:
        'AUTH_TOKEN_SECRET is not set; generated an ephemeral development secret. Every restart invalidates all tokens.',
    });
  }

  let ipHashSalt = envString(env, 'IP_HASH_SALT');
  if (ipHashSalt === null) {
    ipHashSalt = randomBytes(16).toString('hex');
    warnings.push({
      code: 'ephemeral_ip_salt',
      message: 'IP_HASH_SALT is not set; using an ephemeral salt. Anti-abuse history will not survive a restart.',
    });
  }

  const stripeSecretKey = envString(env, 'STRIPE_SECRET_KEY');
  const requestedProvider = envString(env, 'PAYMENT_PROVIDER');
  const paymentProvider: ApiConfig['paymentProvider'] =
    requestedProvider === 'stripe' || (requestedProvider === null && stripeSecretKey !== null) ? 'stripe' : 'fake';
  if (paymentProvider === 'fake') {
    warnings.push({
      code: 'fake_payments',
      message:
        'No STRIPE_SECRET_KEY configured; using FakePaymentProvider. No real money can move. See README "Blockers".',
    });
  }

  const logLevelRaw = envString(env, 'LOG_LEVEL') ?? (nodeEnv === 'test' ? 'silent' : 'info');
  const logLevel = (['debug', 'info', 'warn', 'error', 'silent'] as const).find((l) => l === logLevelRaw) ?? 'info';

  const config: ApiConfig = {
    nodeEnv,
    host: envString(env, 'HOST') ?? '127.0.0.1',
    port: envInt(env, 'PORT', 8787),
    logLevel,
    authTokenSecret,
    authTokenSecretIsEphemeral,
    authTokenTtlSeconds: envInt(env, 'AUTH_TOKEN_TTL_SECONDS', 60 * 60 * 24 * 30),
    magicLinkTtlSeconds: envInt(env, 'MAGIC_LINK_TTL_SECONDS', 60 * 15),
    ipHashSalt,
    paymentProvider,
    stripeSecretKey,
    stripePublishableKey: envString(env, 'STRIPE_PUBLISHABLE_KEY'),
    stripeWebhookSecret: envString(env, 'STRIPE_WEBHOOK_SECRET'),
    stripeApiBase: envString(env, 'STRIPE_API_BASE') ?? 'https://api.stripe.com',
    mediaBucket: envString(env, 'MEDIA_BUCKET') ?? 'somemore-media-dev',
    mediaKeyPrefix: envString(env, 'MEDIA_KEY_PREFIX') ?? 'campsites',
    idempotencyTtlSeconds: envInt(env, 'IDEMPOTENCY_TTL_SECONDS', 60 * 60 * 24),
    maxBodyBytes: envInt(env, 'MAX_BODY_BYTES', 512 * 1024),
    rewardClaimWindowSeconds: envInt(env, 'REWARD_CLAIM_WINDOW_SECONDS', 60 * 60),
    rewardClaimsPerWindow: envInt(env, 'REWARD_CLAIMS_PER_WINDOW', 3),
    magicLinksPerWindow: envInt(env, 'MAGIC_LINKS_PER_WINDOW', 5),
  };

  return { config, warnings };
}
