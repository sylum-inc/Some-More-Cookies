/**
 * Pure scalar helpers shared by every synthesis module.
 *
 * Nothing in this file touches WebAudio, allocates, or depends on globals, so
 * it is safe to import (and exhaustively test) in a plain Node process.
 */

export const TWO_PI = Math.PI * 2;

/** Smallest gain we ever hand to `exponentialRampToValueAtTime` (0 is illegal). */
export const MIN_GAIN = 1e-4;

/** Clamp `value` into `[min, max]`. NaN collapses to `min` so bad sim state can never blow up a gain. */
export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  if (value < min) return min;
  if (value > max) return max;
  return value;
}

export function clamp01(value: number): number {
  return clamp(value, 0, 1);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function inverseLerp(a: number, b: number, value: number): number {
  if (a === b) return 0;
  return (value - a) / (b - a);
}

export function mapRange(
  value: number,
  inMin: number,
  inMax: number,
  outMin: number,
  outMax: number,
  clampOutput = true,
): number {
  const t = inverseLerp(inMin, inMax, value);
  const mapped = lerp(outMin, outMax, clampOutput ? clamp01(t) : t);
  return Number.isFinite(mapped) ? mapped : outMin;
}

/**
 * Map a normalised 0..1 control onto a frequency-style range logarithmically,
 * which is how ears actually hear "twice as bright".
 */
export function mapExp(t01: number, min: number, max: number): number {
  const lo = Math.max(min, 1e-6);
  const hi = Math.max(max, lo + 1e-6);
  return lo * Math.pow(hi / lo, clamp01(t01));
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * (3 - 2 * t);
}

export function smootherstep(edge0: number, edge1: number, x: number): number {
  const t = clamp01(inverseLerp(edge0, edge1, x));
  return t * t * t * (t * (t * 6 - 15) + 10);
}

export function dbToGain(db: number): number {
  return Math.pow(10, db / 20);
}

export function gainToDb(gain: number): number {
  return 20 * Math.log10(Math.max(Math.abs(gain), 1e-7));
}

export function semitonesToRatio(semitones: number): number {
  return Math.pow(2, semitones / 12);
}

export function centsToRatio(cents: number): number {
  return Math.pow(2, cents / 1200);
}

export function midiToHz(midi: number): number {
  return 440 * Math.pow(2, (midi - 69) / 12);
}

/** Frame-rate independent approach; `rate` is the fraction closed per second. */
export function approach(current: number, target: number, rate: number, dt: number): number {
  if (dt <= 0) return current;
  const k = 1 - Math.exp(-Math.max(rate, 0) * dt);
  return current + (target - current) * k;
}

export function moveTowards(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maxDelta) return target;
  return current + Math.sign(delta) * maxDelta;
}

/**
 * Constant-power stereo pan. Writes into `out` (length >= 2) so the hot path
 * never allocates a tuple. Returns `out` for convenience.
 */
export function equalPowerGains(pan: number, out: Float32Array | number[]): Float32Array | number[] {
  const p = clamp(pan, -1, 1);
  const angle = ((p + 1) * Math.PI) / 4;
  out[0] = Math.cos(angle);
  out[1] = Math.sin(angle);
  return out;
}

/** Positive modulo — safe for negative indices. */
export function wrapIndex(index: number, length: number): number {
  if (length <= 0) return 0;
  const i = Math.trunc(index) % length;
  return i < 0 ? i + length : i;
}

/** Defensive read for `noUncheckedIndexedAccess`. */
export function at<T>(list: ArrayLike<T>, index: number, fallback: T): T {
  if (index < 0 || index >= list.length) return fallback;
  const value = list[index];
  return value === undefined ? fallback : value;
}

/** Wrapping read — never returns undefined for a non-empty list. */
export function cyclicAt<T>(list: ArrayLike<T>, index: number, fallback: T): T {
  if (list.length === 0) return fallback;
  return at(list, wrapIndex(index, list.length), fallback);
}
