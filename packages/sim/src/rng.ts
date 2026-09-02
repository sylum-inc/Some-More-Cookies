/**
 * Seeded, splittable pseudo-random number generation.
 *
 * Determinism is load-bearing (ADR-0001, ADR-0006): multiplayer replicates
 * inputs rather than state, and sandwich records are re-derived server-side to
 * validate real-world rewards. `Math.random` is therefore banned everywhere in
 * `packages/sim`.
 *
 * Streams are *splittable*: a subsystem derives its own stream from a parent
 * seed by name, so adding a die roll to the fire model cannot shift the
 * sequence the wildlife model observes.
 */

const UINT32 = 0x100000000;

/** FNV-1a over a string — used to turn stream names into seeds. */
export function hashString(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    // 32-bit FNV prime multiply, kept in range with Math.imul.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Mixes two 32-bit values into one, so seeds combine without clustering. */
export function mixSeeds(a: number, b: number): number {
  let h = (a ^ Math.imul(b ^ (b >>> 16), 0x45d9f3b)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/**
 * A deterministic random source. Small, allocation-free per call, and
 * serialisable so a simulation can be snapshotted and resumed exactly.
 */
export class Rng {
  private state: number;

  constructor(seed: number | string) {
    const numeric = typeof seed === 'string' ? hashString(seed) : seed >>> 0;
    // A zero state would stick, so nudge it.
    this.state = numeric === 0 ? 0x9e3779b9 : numeric >>> 0;
  }

  /** Raw 32-bit unsigned value. SplitMix32. */
  nextUint32(): number {
    this.state = (this.state + 0x9e3779b9) >>> 0;
    let z = this.state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return (z ^ (z >>> 15)) >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    return this.nextUint32() / UINT32;
  }

  /** Uniform in [min, max). */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    if (max < min) return min;
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with the given probability. */
  chance(probability: number): boolean {
    return this.next() < probability;
  }

  /**
   * Approximately standard-normal via the central limit theorem (sum of 4
   * uniforms). Cheaper than Box–Muller and bounded, which matters for
   * simulation values that must not spike to absurd magnitudes.
   */
  normal(mean = 0, stdDev = 1): number {
    const sum = this.next() + this.next() + this.next() + this.next();
    return mean + (sum - 2) * 1.4142135623730951 * stdDev;
  }

  /** Uniform pick. Returns undefined only for an empty list. */
  pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.floor(this.next() * items.length)];
  }

  /**
   * Weighted pick. Non-finite or negative weights are treated as zero so bad
   * content data degrades to "never chosen" instead of corrupting the draw.
   */
  weightedPick<T>(items: readonly T[], weightOf: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) {
      const w = weightOf(item);
      if (Number.isFinite(w) && w > 0) total += w;
    }
    if (total <= 0) return undefined;
    let roll = this.next() * total;
    for (const item of items) {
      const w = weightOf(item);
      if (!Number.isFinite(w) || w <= 0) continue;
      roll -= w;
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** In-place Fisher–Yates. */
  shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = items[i] as T;
      const b = items[j] as T;
      items[i] = b;
      items[j] = a;
    }
    return items;
  }

  /**
   * Derives an independent named stream. Two subsystems that split by
   * different names can never consume each other's sequence.
   */
  split(name: string): Rng {
    return new Rng(mixSeeds(this.state, hashString(name)));
  }

  /** Snapshot / restore, so a simulation can be saved mid-session exactly. */
  getState(): number {
    return this.state;
  }

  setState(state: number): void {
    this.state = state >>> 0;
  }

  clone(): Rng {
    const copy = new Rng(1);
    copy.setState(this.state);
    return copy;
  }
}

/** Creates the root RNG for a campsite visit. */
export function createRng(seed: number | string): Rng {
  return new Rng(seed);
}

/**
 * Deterministic value noise in 1D — used for wind gusts, flicker and other
 * signals that must look organic but replay identically.
 */
export function valueNoise1D(seed: number, x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const a = hashToUnit(seed, i);
  const b = hashToUnit(seed, i + 1);
  // Smoothstep interpolation keeps the derivative continuous, so gusts ease
  // rather than kink.
  const t = f * f * (3 - 2 * f);
  return a + (b - a) * t;
}

/** Deterministic [0,1) hash of an integer coordinate. */
export function hashToUnit(seed: number, x: number): number {
  return mixSeeds(seed, x | 0) / UINT32;
}

/** Sums octaves of value noise for a richer signal (wind, flame motion). */
export function fbm1D(seed: number, x: number, octaves = 3, gain = 0.5, lacunarity = 2): number {
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += valueNoise1D(seed + o * 1013, x * frequency) * amplitude;
    norm += amplitude;
    amplitude *= gain;
    frequency *= lacunarity;
  }
  return norm > 0 ? sum / norm : 0;
}
