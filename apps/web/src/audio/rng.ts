/**
 * Deterministic, allocation-free pseudo-random source.
 *
 * Every stochastic element of the engine (crackle timing, insect gating, bird
 * calls, impulse-response noise) draws from a seeded stream so that a given
 * campsite sounds the same on every machine and so tests can assert exact
 * schedules.
 */

export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  /** Uniform in [min, max). */
  range(min: number, max: number): number;
  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number;
  /** True with probability `p`. */
  bool(p: number): boolean;
  /** Approximately standard-normal (sum of 3 uniforms, cheap and bounded). */
  gaussian(): number;
  /** Uniform element of `list`; returns `fallback` for an empty list. */
  pick<T>(list: ArrayLike<T>, fallback: T): T;
  /** Restart the stream. */
  reseed(seed: number): void;
  /** Current internal state, for snapshotting. */
  readonly state: number;
}

/** mulberry32 — tiny, fast, statistically fine for audio jitter. */
export function createRng(seed = 0x9e3779b9): Rng {
  let s = (seed >>> 0) || 0x9e3779b9;

  const next = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };

  return {
    next,
    range: (min, max) => min + (max - min) * next(),
    int: (min, max) => {
      const lo = Math.ceil(min);
      const hi = Math.floor(max);
      if (hi < lo) return lo;
      return lo + Math.floor(next() * (hi - lo + 1));
    },
    bool: (p) => next() < p,
    gaussian: () => (next() + next() + next() - 1.5) * 1.1547,
    pick: <T,>(list: ArrayLike<T>, fallback: T): T => {
      if (list.length === 0) return fallback;
      const value = list[Math.floor(next() * list.length)];
      return value === undefined ? fallback : value;
    },
    reseed: (value: number) => {
      s = (value >>> 0) || 0x9e3779b9;
    },
    get state() {
      return s;
    },
  };
}

/**
 * Hash an arbitrary string (a campsite id, a bus name) into a 32-bit seed so
 * content manifests can drive deterministic variation without shipping seeds.
 */
export function hashSeed(text: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}

/**
 * Time until the next event of a homogeneous Poisson process of rate
 * `ratePerSecond`. This is the exact inverse-CDF sample, `-ln(U)/λ`.
 *
 * A rate of zero (or less) yields `Infinity`, which the schedulers read as
 * "never" — that is how a dead fire stops crackling without a special case.
 */
export function poissonInterval(ratePerSecond: number, rng: Rng): number {
  if (!(ratePerSecond > 0)) return Number.POSITIVE_INFINITY;
  // 1 - next() keeps the sample in (0, 1] so log() never hits -Infinity.
  return -Math.log(1 - rng.next()) / ratePerSecond;
}

/** Expected number of Poisson events across `seconds`. Used for tests and for budgeting voices. */
export function poissonExpectedCount(ratePerSecond: number, seconds: number): number {
  if (!(ratePerSecond > 0) || !(seconds > 0)) return 0;
  return ratePerSecond * seconds;
}
