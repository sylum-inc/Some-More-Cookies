import { PgConnection, type QueryResult } from './connection.js';
import type { SqlParameter } from './codec.js';
import { PgConnectionError, isRetryable } from './errors.js';
import { redactConfig, type PoolConfig } from './url.js';

export interface PoolLogger {
  debug(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

const NULL_LOGGER: PoolLogger = { debug() {}, warn() {}, error() {} };

/** A connection checked out of the pool. Every method is transaction-safe. */
export interface PgClient {
  query<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParameter[]): Promise<QueryResult<Row>>;
  /** One row or `null`. Throws if the statement returns more than one row. */
  maybeOne<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParameter[]): Promise<Row | null>;
  many<Row = Record<string, unknown>>(sql: string, params?: readonly SqlParameter[]): Promise<Row[]>;
  /** Multi-statement simple query. Used by migrations. */
  simple(sql: string): Promise<QueryResult[]>;
}

interface Slot {
  readonly connection: PgConnection;
  idleSince: number;
  leased: boolean;
}

/**
 * A small, honest connection pool.
 *
 * It does four things: caps concurrency, hands out healthy connections, retires
 * broken ones, and retries transient failures. It does not do read replicas,
 * prepared-statement caching or load balancing, because this service does not
 * need them and pretending otherwise would be dead code.
 */
export class PgPool {
  private readonly slots: Slot[] = [];
  private readonly waiters: Array<{
    resolve: (slot: Slot) => void;
    reject: (error: unknown) => void;
    timer: NodeJS.Timeout;
  }> = [];
  private counter = 0;
  /**
   * Resolves when the database is ready to serve application queries (schema
   * migrated, catalog seeded). Bootstrap work passes `skipGate` so it can run
   * through the very pool it is opening.
   */
  private gate: Promise<void> | null = null;
  /** Connections whose handshake is still in flight; they count against max. */
  private opening = 0;
  private closed = false;
  private sweeper: NodeJS.Timeout | null = null;

  readonly config: PoolConfig;
  private readonly logger: PoolLogger;

  constructor(config: PoolConfig, logger: PoolLogger = NULL_LOGGER) {
    this.config = config;
    this.logger = logger;
  }

  get stats(): { total: number; idle: number; leased: number; waiting: number; opening: number } {
    const leased = this.slots.filter((s) => s.leased).length;
    return {
      total: this.slots.length,
      idle: this.slots.length - leased,
      leased,
      waiting: this.waiters.length,
      opening: this.opening,
    };
  }

  private startSweeper(): void {
    if (this.sweeper !== null || this.config.idleTimeoutMs <= 0) return;
    this.sweeper = setInterval(() => this.sweepIdle(), Math.max(1000, this.config.idleTimeoutMs / 2));
    this.sweeper.unref?.();
  }

  private sweepIdle(): void {
    const cutoff = Date.now() - this.config.idleTimeoutMs;
    for (let i = this.slots.length - 1; i >= 0; i -= 1) {
      const slot = this.slots[i];
      if (slot === undefined || slot.leased) continue;
      if (this.slots.length - this.slots.filter((s) => s.leased).length <= this.config.minConnections) break;
      if (slot.idleSince > cutoff && slot.connection.isUsable) continue;
      slot.connection.end();
      this.slots.splice(i, 1);
    }
  }

  private async open(): Promise<Slot> {
    this.counter += 1;
    const connection = new PgConnection(this.config, `pg-${this.counter}`);
    this.opening += 1;
    try {
      await connection.connect();
    } finally {
      this.opening -= 1;
    }
    if (this.closed) {
      connection.end();
      throw new PgConnectionError('postgres: the pool has been closed');
    }
    const slot: Slot = { connection, idleSince: Date.now(), leased: true };
    this.slots.push(slot);
    this.startSweeper();
    this.logger.debug('db.connection_opened', {
      ...redactConfig(this.config),
      id: connection.id,
      serverVersion: connection.describe().serverVersion,
    });
    return slot;
  }

  private release(slot: Slot): void {
    slot.leased = false;
    slot.idleSince = Date.now();
    if (!slot.connection.isUsable) {
      this.discard(slot);
      return;
    }
    const waiter = this.waiters.shift();
    if (waiter !== undefined) {
      clearTimeout(waiter.timer);
      slot.leased = true;
      waiter.resolve(slot);
    }
  }

  private discard(slot: Slot): void {
    const index = this.slots.indexOf(slot);
    if (index !== -1) this.slots.splice(index, 1);
    // Hanging up on a connection does not stop the query behind it; the backend
    // keeps working until it notices the socket is gone. Ask it to stop.
    if (slot.leased) slot.connection.cancelInFlight();
    slot.connection.end();
    // Someone waiting can now have the capacity this slot was occupying.
    const waiter = this.waiters.shift();
    if (waiter === undefined) return;
    clearTimeout(waiter.timer);
    this.open().then(waiter.resolve, waiter.reject);
  }

  /**
   * Hold every application query until `promise` settles. Used to run
   * migrations on first use without making the composition root async.
   */
  setReadyGate(promise: Promise<void>): void {
    this.gate = promise.then(
      () => {
        this.gate = null;
      },
      (error: unknown) => {
        // Keep failing fast rather than silently serving an unmigrated schema.
        this.gate = Promise.reject(error instanceof Error ? error : new Error(String(error)));
        this.gate.catch(() => {});
        throw error;
      },
    );
    this.gate.catch(() => {});
  }

  private async acquire(skipGate = false): Promise<Slot> {
    if (this.closed) throw new PgConnectionError('postgres: the pool has been closed');
    if (!skipGate && this.gate !== null) await this.gate;

    const free = this.slots.find((slot) => !slot.leased && slot.connection.isUsable);
    if (free !== undefined) {
      free.leased = true;
      return free;
    }
    // Retire anything that died while idle before deciding we are at capacity.
    for (const dead of this.slots.filter((slot) => !slot.leased && !slot.connection.isUsable)) {
      const index = this.slots.indexOf(dead);
      if (index !== -1) this.slots.splice(index, 1);
    }
    if (this.slots.length + this.opening < this.config.maxConnections) return this.open();

    return new Promise<Slot>((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(
          new PgConnectionError(
            `postgres: timed out after ${this.config.acquireTimeoutMs}ms waiting for a pooled connection ` +
              `(pool_max=${this.config.maxConnections})`,
          ),
        );
      }, this.config.acquireTimeoutMs);
      timer.unref?.();
      this.waiters.push({ resolve, reject, timer });
    });
  }

  private clientFor(connection: PgConnection): PgClient {
    return {
      query: (sql, params) => connection.query(sql, params ?? []),
      simple: (sql) => connection.simple(sql),
      async maybeOne(sql, params) {
        const result = await connection.query(sql, params ?? []);
        if (result.rows.length > 1) {
          throw new Error(`postgres: expected at most one row, got ${result.rows.length}`);
        }
        return (result.rows[0] ?? null) as never;
      },
      async many(sql, params) {
        const result = await connection.query(sql, params ?? []);
        return result.rows as never;
      },
    };
  }

  /** Check out a connection, run `fn`, always give the connection back. */
  async withClient<T>(fn: (client: PgClient) => Promise<T>, options: { skipGate?: boolean } = {}): Promise<T> {
    const slot = await this.acquire(options.skipGate === true);
    try {
      return await fn(this.clientFor(slot.connection));
    } catch (error) {
      if (error instanceof PgConnectionError) {
        this.discard(slot);
        throw error;
      }
      throw error;
    } finally {
      if (this.slots.includes(slot)) this.release(slot);
    }
  }

  async query<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParameter[] = [],
  ): Promise<QueryResult<Row>> {
    return this.retrying(() => this.withClient((client) => client.query<Row>(sql, params)));
  }

  async maybeOne<Row = Record<string, unknown>>(
    sql: string,
    params: readonly SqlParameter[] = [],
  ): Promise<Row | null> {
    return this.retrying(() => this.withClient((client) => client.maybeOne<Row>(sql, params)));
  }

  async many<Row = Record<string, unknown>>(sql: string, params: readonly SqlParameter[] = []): Promise<Row[]> {
    return this.retrying(() => this.withClient((client) => client.many<Row>(sql, params)));
  }

  /**
   * BEGIN / COMMIT / ROLLBACK around `fn`, retried on serialization failures
   * and deadlocks. The callback must not escape its client.
   */
  async transaction<T>(fn: (client: PgClient) => Promise<T>, isolation?: 'read committed' | 'repeatable read' | 'serializable'): Promise<T> {
    return this.retrying(async () => {
      const slot = await this.acquire();
      const client = this.clientFor(slot.connection);
      let entered = false;
      try {
        await client.query(isolation === undefined ? 'BEGIN' : `BEGIN ISOLATION LEVEL ${isolation}`);
        entered = true;
        const value = await fn(client);
        await client.query('COMMIT');
        return value;
      } catch (error) {
        if (entered && slot.connection.isUsable) {
          try {
            await client.query('ROLLBACK');
          } catch (rollbackError) {
            this.logger.warn('db.rollback_failed', { message: (rollbackError as Error).message });
            this.discard(slot);
          }
        }
        throw error;
      } finally {
        if (this.slots.includes(slot)) this.release(slot);
      }
    });
  }

  private async retrying<T>(attempt: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let tries = 0; tries <= this.config.maxRetries; tries += 1) {
      try {
        return await attempt();
      } catch (error) {
        if (this.closed || !isRetryable(error)) throw error;
        lastError = error;
        const delay = this.config.retryBaseDelayMs * 2 ** tries + Math.floor(Math.random() * 10);
        this.logger.warn('db.retrying', {
          attempt: tries + 1,
          delayMs: delay,
          message: (error as Error).message,
        });
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, delay);
          timer.unref?.();
        });
      }
    }
    throw lastError;
  }

  /** Cheap liveness probe used by `/health`. Never leaks the connection URL. */
  async ping(): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
    const startedAt = Date.now();
    try {
      await this.withClient((client) => client.query('SELECT 1 AS ok'), { skipGate: true });
      return { ok: true, latencyMs: Date.now() - startedAt };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  }

  async end(): Promise<void> {
    this.closed = true;
    if (this.sweeper !== null) clearInterval(this.sweeper);
    this.sweeper = null;
    for (const waiter of this.waiters.splice(0)) {
      clearTimeout(waiter.timer);
      waiter.reject(new PgConnectionError('postgres: the pool has been closed'));
    }
    for (const slot of this.slots.splice(0)) slot.connection.end();
  }
}
