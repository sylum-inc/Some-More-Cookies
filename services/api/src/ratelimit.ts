import type { Clock } from './clock.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly count: number;
}

/**
 * A fixed-window counter, shared or not.
 *
 * **Asynchronous on purpose, and that is the whole of Blocker 11.** It used to
 * be synchronous, which is a decision rather than a detail: a synchronous
 * interface cannot have a shared implementation, so every instance of this
 * service counted in its own memory and two instances were two budgets. The
 * consequence was never severe — reward claim-once is a partial unique index
 * and holds across instances regardless, so a second instance could only let
 * somebody claim slightly *faster* than intended, not twice — but "the limiter
 * is per-process" was true of every limit in the service, including anonymous
 * signups and telemetry ingest.
 *
 * Two implementations behind it now: the in-memory one, still the right answer
 * for one node and for tests, and `createPostgresRateLimiter`, which counts in
 * a table with an atomic upsert so every instance shares one budget.
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
  peek(key: string, limit: number, windowSeconds: number): Promise<RateLimitDecision>;
  reset(key?: string): Promise<void>;
}

interface Window {
  count: number;
  resetAt: number;
}

export function createMemoryRateLimiter(clock: Clock): RateLimiter {
  const windows = new Map<string, Window>();

  function windowFor(key: string, windowSeconds: number): Window {
    const nowMs = clock.now().getTime();
    const existing = windows.get(key);
    if (existing !== undefined && existing.resetAt > nowMs) return existing;
    const fresh: Window = { count: 0, resetAt: nowMs + windowSeconds * 1000 };
    windows.set(key, fresh);
    return fresh;
  }

  return {
    async consume(key, limit, windowSeconds) {
      const win = windowFor(key, windowSeconds);
      win.count += 1;
      return {
        allowed: win.count <= limit,
        remaining: Math.max(0, limit - win.count),
        resetAt: new Date(win.resetAt),
        count: win.count,
      };
    },
    async peek(key, limit, windowSeconds) {
      const win = windowFor(key, windowSeconds);
      return {
        allowed: win.count < limit,
        remaining: Math.max(0, limit - win.count),
        resetAt: new Date(win.resetAt),
        count: win.count,
      };
    },
    async reset(key) {
      if (key === undefined) windows.clear();
      else windows.delete(key);
    },
  };
}

/**
 * The same counter, in Postgres, so every instance shares one budget.
 *
 * One statement per `consume`, and the arithmetic happens inside it: a
 * read-then-write would be two round trips with a race between them, which is
 * the bug this exists to not have. `ON CONFLICT DO UPDATE` with the window
 * check in the `SET` means an expired window is reset and a live one is
 * incremented in the same atomic step, and `RETURNING` hands back what the row
 * became rather than what it was.
 *
 * `peek` is a plain read and is deliberately *not* atomic with anything: it is
 * used to decide whether to show a softer refusal, never to authorise.
 *
 * Rows are swept opportunistically rather than on a timer, because a timer is
 * a lifecycle to own and a sweep that runs on roughly one call in two hundred
 * costs nothing measurable and keeps the table proportional to live keys. The
 * key space is accounts and salted address hashes, so without a sweep it grows
 * forever.
 */
export function createPostgresRateLimiter(
  pool: { query<Row = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<{ rows: Row[] }> },
  clock: Clock,
  options: { sweepEvery?: number } = {},
): RateLimiter {
  const sweepEvery = options.sweepEvery ?? 200;
  let calls = 0;

  async function maybeSweep(): Promise<void> {
    calls += 1;
    if (calls % sweepEvery !== 0) return;
    try {
      await pool.query('DELETE FROM rate_limit_windows WHERE reset_at <= now()');
    } catch {
      // A sweep that fails is a table that is briefly larger. It must never
      // turn into a failed request.
    }
  }

  function decide(limit: number, count: number, resetAt: Date): RateLimitDecision {
    return { allowed: count <= limit, remaining: Math.max(0, limit - count), resetAt, count };
  }

  return {
    async consume(key, limit, windowSeconds) {
      const result = await pool.query<{ count: string | number; reset_at: Date | string }>(
        `INSERT INTO rate_limit_windows (key, count, reset_at)
         VALUES ($1, 1, now() + ($2 || ' seconds')::interval)
         ON CONFLICT (key) DO UPDATE SET
           count = CASE WHEN rate_limit_windows.reset_at > now() THEN rate_limit_windows.count + 1 ELSE 1 END,
           reset_at = CASE WHEN rate_limit_windows.reset_at > now() THEN rate_limit_windows.reset_at
                           ELSE now() + ($2 || ' seconds')::interval END
         RETURNING count, reset_at`,
        [key, String(windowSeconds)],
      );
      void maybeSweep();
      const row = result.rows[0];
      if (row === undefined) {
        // Cannot happen with RETURNING on an upsert; if it ever does, refusing
        // to count is safer than pretending the budget is untouched.
        return decide(limit, limit + 1, clock.now());
      }
      return decide(limit, Number(row.count), new Date(row.reset_at));
    },

    async peek(key, limit, windowSeconds) {
      const result = await pool.query<{ count: string | number; reset_at: Date | string }>(
        'SELECT count, reset_at FROM rate_limit_windows WHERE key = $1 AND reset_at > now()',
        [key],
      );
      const row = result.rows[0];
      if (row === undefined) {
        return decide(limit, 0, new Date(clock.now().getTime() + windowSeconds * 1000));
      }
      const count = Number(row.count);
      return { allowed: count < limit, remaining: Math.max(0, limit - count), resetAt: new Date(row.reset_at), count };
    },

    async reset(key) {
      if (key === undefined) await pool.query('DELETE FROM rate_limit_windows');
      else await pool.query('DELETE FROM rate_limit_windows WHERE key = $1', [key]);
    },
  };
}
