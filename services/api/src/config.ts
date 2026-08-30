import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

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

  /**
   * Postgres connection string. Present => durable storage; absent => the
   * in-memory repositories, which is what `npm run api` gets with no database.
   */
  readonly databaseUrl: string | null;
  /** Apply pending migrations on first use. */
  readonly databaseAutoMigrate: boolean;
  readonly databasePoolMax: number;
  readonly databasePoolMin: number;
  readonly databaseIdleTimeoutMs: number;
  readonly databaseAcquireTimeoutMs: number;
  readonly databaseConnectTimeoutMs: number;
  readonly databaseStatementTimeoutMs: number;

  readonly paymentProvider: 'stripe' | 'fake';
  readonly stripeSecretKey: string | null;
  readonly stripePublishableKey: string | null;
  readonly stripeWebhookSecret: string | null;
  readonly stripeApiBase: string;

  /**
   * Object storage for photos.
   *
   * `local` is a working adapter that writes to `mediaLocalRoot`; `s3` is the
   * S3-compatible one, which reports `not_configured` without credentials
   * rather than pretending (README, Blocker 3).
   */
  readonly mediaStorage: 'local' | 's3';
  readonly mediaBucket: string;
  readonly mediaKeyPrefix: string;
  /** Directory the local adapter writes to. Ephemeral by default, like memory. */
  readonly mediaLocalRoot: string;
  /** Hard ceiling on one photo. Also the per-route body limit on the upload. */
  readonly mediaMaxBytes: number;
  /** How long an upload ticket stands. Short: it is an offer, not a session. */
  readonly mediaUploadTtlSeconds: number;
  readonly mediaS3Region: string | null;
  readonly mediaS3AccessKeyId: string | null;
  readonly mediaS3SecretAccessKey: string | null;
  readonly mediaS3Endpoint: string | null;
  readonly mediaS3ForcePathStyle: boolean;
  /** CDN origin photos are read through, when there is one. */
  readonly mediaPublicBaseUrl: string | null;

  readonly idempotencyTtlSeconds: number;
  readonly maxBodyBytes: number;

  /** Claim-once + velocity limits for high-value rewards. */
  readonly rewardClaimWindowSeconds: number;
  readonly rewardClaimsPerWindow: number;
  readonly magicLinksPerWindow: number;

  /**
   * Live-ops authoring. Absent => the content service is read-only and says so
   * (there is no staff identity provider yet; see README Blocker 9).
   */
  readonly liveOpsToken: string | null;
  /**
   * Browser origins allowed to make **credentialed** cross-origin calls.
   *
   * Exact origins, comma-separated, no wildcards: `Access-Control-Allow-Origin`
   * is echoed back only for a match. Empty is the correct default and means
   * "same origin only" — a browser client served from somewhere else has to be
   * named, deliberately, by whoever runs the deployment. The public read
   * routes are separate and always answer `*`; see `http/server.ts`.
   */
  readonly corsAllowedOrigins: readonly string[];

  /**
   * Ed25519 key material for physical/event codes. Absent => scanning is
   * switched off with a structured `not_configured`, never a fake success.
   */
  readonly codeSigningKeyId: string | null;
  readonly codeSigningPrivateKey: string | null;
  /** `keyId -> base64 public key`, so old print runs verify after a rotation. */
  readonly codeVerifyPublicKeys: Readonly<Record<string, string>>;

  /** Redemption limits. Someone will scrape codes off Instagram; see codes.ts. */
  readonly codeRedemptionWindowSeconds: number;
  readonly codeRedemptionsPerWindow: number;
  readonly codeFailuresPerWindow: number;
  /** Redemptions per batch per window above which a run is flagged for review. */
  readonly codeBatchVelocityFlag: number;
}

function envString(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (raw === undefined) return null;
  const trimmed = raw.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function envBool(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = envString(env, key);
  if (raw === null) return fallback;
  return !['0', 'false', 'no', 'off'].includes(raw.toLowerCase());
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const raw = envString(env, key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * `keyId:base64,keyId:base64` — the shape a secret store can hold as one
 * string. Malformed entries are dropped here and reported by the signer, which
 * is the only thing that can say whether the material is a usable key.
 */
function parseKeyList(raw: string | null): Record<string, string> {
  if (raw === null) return {};
  const out: Record<string, string> = {};
  for (const entry of raw.split(',')) {
    const trimmed = entry.trim();
    if (trimmed.length === 0) continue;
    const separator = trimmed.indexOf(':');
    if (separator <= 0) continue;
    const keyId = trimmed.slice(0, separator).trim();
    const material = trimmed.slice(separator + 1).trim();
    if (keyId.length === 0 || material.length === 0) continue;
    out[keyId] = material;
  }
  return out;
}

export interface ConfigWarning {
  readonly code:
    | 'ephemeral_auth_secret'
    | 'fake_payments'
    | 'console_mailer'
    | 'ephemeral_ip_salt'
    | 'memory_persistence'
    | 'live_ops_read_only'
    | 'codes_not_configured'
    | 'local_media_storage'
    | 'media_not_configured';
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

  const databaseUrl = envString(env, 'DATABASE_URL');
  if (databaseUrl === null) {
    warnings.push({
      code: 'memory_persistence',
      message:
        'DATABASE_URL is not set; using the in-memory repositories. Every restart is a factory reset. '
        + 'See README "Running Postgres locally".',
    });
  }

  const corsAllowedOrigins = (envString(env, 'CORS_ALLOWED_ORIGINS') ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin.length > 0);

  const liveOpsToken = envString(env, 'LIVE_OPS_TOKEN');
  if (liveOpsToken === null) {
    warnings.push({
      code: 'live_ops_read_only',
      message:
        'LIVE_OPS_TOKEN is not set; the content service is read-only. Publishing, rollback and code minting '
        + 'answer 503 service_not_configured. See README "Blockers".',
    });
  }

  const codeSigningPrivateKey = envString(env, 'CODE_SIGNING_PRIVATE_KEY');
  const codeVerifyPublicKeys = parseKeyList(envString(env, 'CODE_VERIFY_PUBLIC_KEYS'));
  if (codeSigningPrivateKey === null && Object.keys(codeVerifyPublicKeys).length === 0) {
    warnings.push({
      code: 'codes_not_configured',
      message:
        'No Ed25519 code keys configured (CODE_SIGNING_PRIVATE_KEY / CODE_VERIFY_PUBLIC_KEYS); QR and package '
        + 'codes cannot be minted or verified. Scanning is disabled rather than permissive.',
    });
  }

  const mediaStorageRaw = envString(env, 'MEDIA_STORAGE');
  const mediaStorage: ApiConfig['mediaStorage'] = mediaStorageRaw === 's3' ? 's3' : 'local';
  const mediaS3AccessKeyId = envString(env, 'MEDIA_S3_ACCESS_KEY_ID');
  const mediaS3SecretAccessKey = envString(env, 'MEDIA_S3_SECRET_ACCESS_KEY');
  const mediaS3Region = envString(env, 'MEDIA_S3_REGION');
  if (mediaStorage === 'local') {
    warnings.push({
      code: 'local_media_storage',
      message:
        'MEDIA_STORAGE is local; photo bytes go to a directory on this machine. That is a real, working '
        + 'store for one instance with a volume, and it is not shared between instances and does not '
        + 'survive a rescheduled container. See README "Blockers".',
    });
  } else if (mediaS3AccessKeyId === null || mediaS3SecretAccessKey === null || mediaS3Region === null) {
    warnings.push({
      code: 'media_not_configured',
      message:
        'MEDIA_STORAGE=s3 with no credentials (MEDIA_S3_REGION / MEDIA_S3_ACCESS_KEY_ID / '
        + 'MEDIA_S3_SECRET_ACCESS_KEY); photo uploads answer not_configured and the client keeps photos '
        + 'on the device. Nothing pretends an upload succeeded.',
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
    databaseUrl,
    databaseAutoMigrate: envBool(env, 'DATABASE_AUTO_MIGRATE', true),
    databasePoolMax: envInt(env, 'DATABASE_POOL_MAX', 10),
    databasePoolMin: envInt(env, 'DATABASE_POOL_MIN', 0),
    databaseIdleTimeoutMs: envInt(env, 'DATABASE_IDLE_TIMEOUT_MS', 30_000),
    databaseAcquireTimeoutMs: envInt(env, 'DATABASE_ACQUIRE_TIMEOUT_MS', 10_000),
    databaseConnectTimeoutMs: envInt(env, 'DATABASE_CONNECT_TIMEOUT_MS', 10_000),
    databaseStatementTimeoutMs: envInt(env, 'DATABASE_STATEMENT_TIMEOUT_MS', 15_000),
    paymentProvider,
    stripeSecretKey,
    stripePublishableKey: envString(env, 'STRIPE_PUBLISHABLE_KEY'),
    stripeWebhookSecret: envString(env, 'STRIPE_WEBHOOK_SECRET'),
    stripeApiBase: envString(env, 'STRIPE_API_BASE') ?? 'https://api.stripe.com',
    mediaStorage,
    mediaBucket: envString(env, 'MEDIA_BUCKET') ?? 'somemore-media-dev',
    mediaKeyPrefix: envString(env, 'MEDIA_KEY_PREFIX') ?? 'campsites',
    /*
     * A temp directory by default, for the same reason storage defaults to
     * memory: a fresh checkout should work with nothing installed, and it
     * should be obvious that nothing survives. Point it at a volume in
     * anything that is meant to keep photographs.
     */
    mediaLocalRoot: envString(env, 'MEDIA_LOCAL_ROOT') ?? path.join(tmpdir(), 'somemore-media'),
    mediaMaxBytes: envInt(env, 'MEDIA_MAX_BYTES', 8 * 1024 * 1024),
    mediaUploadTtlSeconds: envInt(env, 'MEDIA_UPLOAD_TTL_SECONDS', 15 * 60),
    mediaS3Region,
    mediaS3AccessKeyId,
    mediaS3SecretAccessKey,
    mediaS3Endpoint: envString(env, 'MEDIA_S3_ENDPOINT'),
    mediaS3ForcePathStyle: envBool(env, 'MEDIA_S3_FORCE_PATH_STYLE', true),
    mediaPublicBaseUrl: envString(env, 'MEDIA_PUBLIC_BASE_URL'),
    idempotencyTtlSeconds: envInt(env, 'IDEMPOTENCY_TTL_SECONDS', 60 * 60 * 24),
    maxBodyBytes: envInt(env, 'MAX_BODY_BYTES', 512 * 1024),
    rewardClaimWindowSeconds: envInt(env, 'REWARD_CLAIM_WINDOW_SECONDS', 60 * 60),
    rewardClaimsPerWindow: envInt(env, 'REWARD_CLAIMS_PER_WINDOW', 3),
    magicLinksPerWindow: envInt(env, 'MAGIC_LINKS_PER_WINDOW', 5),
    liveOpsToken,
    corsAllowedOrigins,
    codeSigningKeyId: envString(env, 'CODE_SIGNING_KEY_ID'),
    codeSigningPrivateKey,
    codeVerifyPublicKeys,
    codeRedemptionWindowSeconds: envInt(env, 'CODE_REDEMPTION_WINDOW_SECONDS', 60 * 60),
    codeRedemptionsPerWindow: envInt(env, 'CODE_REDEMPTIONS_PER_WINDOW', 10),
    codeFailuresPerWindow: envInt(env, 'CODE_FAILURES_PER_WINDOW', 20),
    codeBatchVelocityFlag: envInt(env, 'CODE_BATCH_VELOCITY_FLAG', 200),
  };

  return { config, warnings };
}
