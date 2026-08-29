import type { Clock } from './clock.js';

export interface RateLimitDecision {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly count: number;
}

/**
 * Fixed-window counter, in memory. Good enough for a single node and for the
 * tests; the Postgres/Redis adapter implements the same interface (see
 * README "Blockers" — no shared cache is provisioned yet).
 */
export interface RateLimiter {
  consume(key: string, limit: number, windowSeconds: number): RateLimitDecision;
  peek(key: string, limit: number, windowSeconds: number): RateLimitDecision;
  reset(key?: string): void;
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
    consume(key, limit, windowSeconds) {
      const win = windowFor(key, windowSeconds);
      win.count += 1;
      return {
        allowed: win.count <= limit,
        remaining: Math.max(0, limit - win.count),
        resetAt: new Date(win.resetAt),
        count: win.count,
      };
    },
    peek(key, limit, windowSeconds) {
      const win = windowFor(key, windowSeconds);
      return {
        allowed: win.count < limit,
        remaining: Math.max(0, limit - win.count),
        resetAt: new Date(win.resetAt),
        count: win.count,
      };
    },
    reset(key) {
      if (key === undefined) windows.clear();
      else windows.delete(key);
    },
  };
}
