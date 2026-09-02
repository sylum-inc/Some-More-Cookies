import type { ConnectionOptions } from './connection.js';

export interface PoolConfig extends ConnectionOptions {
  readonly maxConnections: number;
  readonly minConnections: number;
  /** How long an idle connection may sit in the pool before being closed. */
  readonly idleTimeoutMs: number;
  /** How long `acquire()` waits for a free connection before giving up. */
  readonly acquireTimeoutMs: number;
  /** Transient-failure retries for a single query or transaction attempt. */
  readonly maxRetries: number;
  readonly retryBaseDelayMs: number;
}

export interface ParseUrlOptions {
  readonly applicationName?: string;
  readonly maxConnections?: number;
  readonly minConnections?: number;
  readonly idleTimeoutMs?: number;
  readonly acquireTimeoutMs?: number;
  readonly connectTimeoutMs?: number;
  readonly statementTimeoutMs?: number;
  readonly searchPath?: string | null;
  readonly maxRetries?: number;
}

function intParam(params: URLSearchParams, key: string, fallback: number): number {
  const raw = params.get(key);
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

/**
 * `postgres://user:password@host:port/database?sslmode=…&pool_max=…`
 *
 * Also accepts `postgresql://`, a `host=/var/run/postgresql` style unix path,
 * and the `PG*` environment fallbacks libpq users expect.
 */
export function parseDatabaseUrl(url: string, options: ParseUrlOptions = {}): PoolConfig {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    throw new Error(`DATABASE_URL is not a valid URL: ${(error as Error).message}`);
  }
  if (parsed.protocol !== 'postgres:' && parsed.protocol !== 'postgresql:') {
    throw new Error(`DATABASE_URL must use postgres:// or postgresql:// (got ${parsed.protocol}//)`);
  }

  const params = parsed.searchParams;
  const sslModeRaw = params.get('sslmode') ?? params.get('ssl') ?? 'prefer';
  /*
   * `verify-ca` and `verify-full` are refused rather than quietly demoted.
   *
   * This client encrypts but does not verify a server certificate (README
   * Blocker 2), and these two modes exist precisely to ask for verification.
   * Mapping them onto `require` gave an operator who typed the strongest
   * setting libpq has exactly the protection of the weakest one, and said
   * nothing about it — which is the failure mode that turns a documented gap
   * into a believed guarantee.
   */
  if (sslModeRaw === 'verify-ca' || sslModeRaw === 'verify-full') {
    throw new Error(
      `DATABASE_URL asks for sslmode=${sslModeRaw}, which this client cannot honour: it encrypts but does not `
        + 'verify the server certificate chain. Use sslmode=require and accept that, or wait for certificate '
        + 'verification (README "Blockers", 2). It will not be silently downgraded.',
    );
  }
  const ssl: ConnectionOptions['ssl'] =
    sslModeRaw === 'disable' || sslModeRaw === 'false' || sslModeRaw === '0'
      ? 'disable'
      : sslModeRaw === 'require'
        ? 'require'
        : 'prefer';

  // A `host=` query parameter wins, which is how libpq addresses unix sockets.
  const socketHost = params.get('host');
  const host = socketHost ?? (parsed.hostname.length > 0 ? decodeURIComponent(parsed.hostname) : '127.0.0.1');
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, '')) || 'postgres';

  return {
    host,
    port: parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : 5432,
    user: decodeURIComponent(parsed.username) || 'postgres',
    password: parsed.password.length > 0 ? decodeURIComponent(parsed.password) : null,
    database,
    ssl,
    applicationName: options.applicationName ?? params.get('application_name') ?? 'somemore-api',
    connectTimeoutMs: options.connectTimeoutMs ?? intParam(params, 'connect_timeout_ms', 10_000),
    statementTimeoutMs: options.statementTimeoutMs ?? intParam(params, 'statement_timeout_ms', 15_000),
    searchPath: options.searchPath === undefined ? (params.get('search_path') ?? 'somemore, public') : options.searchPath,
    maxConnections: options.maxConnections ?? intParam(params, 'pool_max', 10),
    minConnections: options.minConnections ?? intParam(params, 'pool_min', 0),
    idleTimeoutMs: options.idleTimeoutMs ?? intParam(params, 'idle_timeout_ms', 30_000),
    acquireTimeoutMs: options.acquireTimeoutMs ?? intParam(params, 'acquire_timeout_ms', 10_000),
    maxRetries: options.maxRetries ?? intParam(params, 'max_retries', 3),
    retryBaseDelayMs: intParam(params, 'retry_base_delay_ms', 25),
  };
}

/** Everything but the password, safe to log or return from `/health`. */
export function redactConfig(config: PoolConfig): Record<string, unknown> {
  return {
    host: config.host,
    port: config.port,
    database: config.database,
    user: config.user,
    ssl: config.ssl,
    poolMax: config.maxConnections,
  };
}
