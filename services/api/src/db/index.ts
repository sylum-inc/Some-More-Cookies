import type { Repositories } from '../repos/interfaces.js';
import { createPostgresRepositories, seedPostgresCatalog, type PostgresRepositorySeed } from '../repos/postgres/index.js';
import type { Logger } from '../logging.js';
import { migrate } from './migrate.js';
import { PgPool, parseDatabaseUrl, redactConfig, type PoolConfig } from './wire/index.js';

export interface DatabaseOptions {
  readonly url: string;
  readonly logger: Logger;
  readonly seed?: PostgresRepositorySeed;
  /** Apply pending migrations on first use. Default true. */
  readonly autoMigrate?: boolean;
  readonly pool?: {
    readonly maxConnections?: number;
    readonly minConnections?: number;
    readonly idleTimeoutMs?: number;
    readonly acquireTimeoutMs?: number;
    readonly connectTimeoutMs?: number;
    readonly statementTimeoutMs?: number;
    readonly applicationName?: string;
  };
}

/**
 * A connected database: its pool, its repositories, and a health probe that
 * says whether the thing is reachable without saying where it is.
 */
export interface Database {
  readonly kind: 'postgres';
  readonly pool: PgPool;
  readonly repos: Repositories;
  /** Resolves once migrations and seeding have finished (or rejects). */
  ready(): Promise<void>;
  health(): Promise<DatabaseHealth>;
  close(): Promise<void>;
}

export interface DatabaseHealth {
  readonly reachable: boolean;
  readonly latencyMs: number | null;
  /** Pool occupancy — useful on a dashboard, harmless in a public probe. */
  readonly pool: { total: number; idle: number; leased: number; waiting: number };
  /** A category, never a message that could contain host names or a DSN. */
  readonly error: 'unreachable' | 'not_migrated' | null;
}

/**
 * Open the database.
 *
 * Deliberately synchronous: the composition root stays a plain function, and
 * the first query is what waits for migrations. Anything that wants to know
 * whether the schema is up before serving traffic calls `ready()`.
 */
export function createDatabase(options: DatabaseOptions): Database {
  const config: PoolConfig = parseDatabaseUrl(options.url, {
    applicationName: options.pool?.applicationName ?? 'somemore-api',
    ...(options.pool?.maxConnections === undefined ? {} : { maxConnections: options.pool.maxConnections }),
    ...(options.pool?.minConnections === undefined ? {} : { minConnections: options.pool.minConnections }),
    ...(options.pool?.idleTimeoutMs === undefined ? {} : { idleTimeoutMs: options.pool.idleTimeoutMs }),
    ...(options.pool?.acquireTimeoutMs === undefined ? {} : { acquireTimeoutMs: options.pool.acquireTimeoutMs }),
    ...(options.pool?.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: options.pool.connectTimeoutMs }),
    ...(options.pool?.statementTimeoutMs === undefined ? {} : { statementTimeoutMs: options.pool.statementTimeoutMs }),
  });

  const logger = options.logger.child({ component: 'db' });
  const pool = new PgPool(config, {
    debug: (message, fields) => logger.debug(message, fields),
    warn: (message, fields) => logger.warn(message, fields),
    error: (message, fields) => logger.error(message, fields),
  });

  let bootstrapError: unknown = null;
  const bootstrap = (async () => {
    if (options.autoMigrate === false) {
      logger.warn('db.auto_migrate_disabled', {
        message: 'DATABASE_AUTO_MIGRATE=false — the schema is assumed to be current.',
      });
    } else {
      const result = await migrate(pool, {
        logger: {
          debug: (m, f) => logger.debug(m, f),
          warn: (m, f) => logger.warn(m, f),
          info: (m, f) => logger.info(m, f),
        },
      });
      logger.info('db.migrated', {
        version: result.currentVersion,
        applied: result.applied.length,
        alreadyApplied: result.skipped.length,
      });
    }
    // `skipGate` matters: this runs *inside* the promise every other query is
    // waiting on, so going through the front door would deadlock the boot.
    if (options.seed !== undefined) {
      const seed = options.seed;
      await pool.withClient((client) => seedPostgresCatalog(client, seed), { skipGate: true });
    }
    logger.info('db.ready', redactConfig(config));
  })();

  bootstrap.catch((error: unknown) => {
    bootstrapError = error;
    logger.error('db.bootstrap_failed', { message: error instanceof Error ? error.message : String(error) });
  });
  pool.setReadyGate(bootstrap);

  return {
    kind: 'postgres',
    pool,
    repos: createPostgresRepositories(pool),
    ready: () => bootstrap,

    /**
     * Liveness for `/health`. Never returns the host, the database name, the
     * user or a driver message — a probe endpoint is public, and a connection
     * string in a 503 body is how DSNs end up in screenshots.
     */
    async health() {
      const ping = await pool.ping();
      const stats = pool.stats;
      const occupancy = { total: stats.total, idle: stats.idle, leased: stats.leased, waiting: stats.waiting };
      if (!ping.ok) {
        return { reachable: false, latencyMs: null, pool: occupancy, error: 'unreachable' };
      }
      if (bootstrapError !== null) {
        return { reachable: true, latencyMs: ping.latencyMs, pool: occupancy, error: 'not_migrated' };
      }
      return { reachable: true, latencyMs: ping.latencyMs, pool: occupancy, error: null };
    },

    async close() {
      await bootstrap.catch(() => {});
      await pool.end();
    },
  };
}

export { migrate, loadMigrations, listApplied, resetSchema, truncateData, checksumOf } from './migrate.js';
export type { Migration, MigrationResult, AppliedMigration } from './migrate.js';
export * from './wire/index.js';
