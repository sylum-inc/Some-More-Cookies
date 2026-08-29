/**
 * Procedural noise generation.
 *
 * No audio assets exist in this project, so every "recorded" texture in the
 * game — fire roar, wind, hiss, gravel, frost — starts life as one of these
 * buffers. All generators write into a caller-owned `Float32Array` so buffers
 * can be built once at init and reused; the `generateNoise` convenience wrapper
 * is the only allocating entry point.
 */

import type { Rng } from './rng.js';
import { createRng } from './rng.js';

export type NoiseKind = 'white' | 'pink' | 'brown' | 'blue' | 'velvet';

/** Uniform white noise in [-1, 1). Flat spectrum, the base for everything else. */
export function fillWhiteNoise(out: Float32Array, rng: Rng): Float32Array {
  for (let i = 0; i < out.length; i += 1) {
    out[i] = rng.next() * 2 - 1;
  }
  return out;
}

/**
 * Pink (1/f) noise via Paul Kellet's economical filter bank. This is the
 * workhorse for wind and the fire roar: white noise sounds like a hiss, pink
 * sounds like moving air.
 */
export function fillPinkNoise(out: Float32Array, rng: Rng): Float32Array {
  let b0 = 0;
  let b1 = 0;
  let b2 = 0;
  let b3 = 0;
  let b4 = 0;
  let b5 = 0;
  let b6 = 0;
  for (let i = 0; i < out.length; i += 1) {
    const w = rng.next() * 2 - 1;
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    out[i] = (b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362) * 0.11;
    b6 = w * 0.115926;
  }
  return normalizeInPlace(out, 0.95);
}

/**
 * Brown (1/f^2) noise via a leaky integrator. Used for the deep fire rumble and
 * distant thunder-ish weight; almost all of its energy is under 200 Hz.
 */
export function fillBrownNoise(out: Float32Array, rng: Rng): Float32Array {
  let last = 0;
  for (let i = 0; i < out.length; i += 1) {
    const w = rng.next() * 2 - 1;
    last = (last + 0.02 * w) * 0.998;
    out[i] = last;
  }
  return normalizeInPlace(out, 0.95);
}

/** Blue (f) noise — a first difference of white. Bright, used for frost ticks and fizz. */
export function fillBlueNoise(out: Float32Array, rng: Rng): Float32Array {
  let prev = rng.next() * 2 - 1;
  for (let i = 0; i < out.length; i += 1) {
    const w = rng.next() * 2 - 1;
    out[i] = w - prev;
    prev = w;
  }
  return normalizeInPlace(out, 0.95);
}

/**
 * Velvet noise: sparse +/-1 impulses on a randomised grid. Perceptually smooth
 * but extremely cheap to convolve, and it makes very convincing sizzle and
 * refrigerant gurgle when band-passed.
 */
export function fillVelvetNoise(
  out: Float32Array,
  rng: Rng,
  densityHz: number,
  sampleRate: number,
): Float32Array {
  out.fill(0);
  const spacing = Math.max(1, Math.round(sampleRate / Math.max(densityHz, 1)));
  for (let start = 0; start < out.length; start += spacing) {
    const offset = start + Math.floor(rng.next() * spacing);
    if (offset < out.length) {
      out[offset] = rng.next() < 0.5 ? -1 : 1;
    }
  }
  return out;
}

/**
 * A single crackle/tick grain: noise shaped by a linear attack and an
 * exponential tail, peak-normalised. `brightness` in 0..1 crossfades the source
 * from brown (dull woody pop) to blue (sharp resinous snap).
 */
export function fillGrain(
  out: Float32Array,
  rng: Rng,
  sampleRate: number,
  attackSeconds: number,
  decaySeconds: number,
  brightness = 0.5,
): Float32Array {
  const attackSamples = Math.max(1, Math.round(attackSeconds * sampleRate));
  const tau = Math.max(decaySeconds, 1e-4) * sampleRate;
  const b = brightness < 0 ? 0 : brightness > 1 ? 1 : brightness;

  let low = 0;
  let prev = rng.next() * 2 - 1;
  for (let i = 0; i < out.length; i += 1) {
    const w = rng.next() * 2 - 1;
    low = low * 0.86 + w * 0.14;
    const high = w - prev;
    prev = w;
    const source = low * (1 - b) * 3.2 + high * b * 0.5;
    const env =
      i < attackSamples ? i / attackSamples : Math.exp(-(i - attackSamples) / tau);
    out[i] = source * env;
  }
  return normalizeInPlace(out, 1);
}

/**
 * A jittered impulse train — the skeleton of a cricket chirp before band-pass
 * filtering. `jitter` (0..1) randomises each impulse position within its slot.
 */
export function fillImpulseTrain(
  out: Float32Array,
  sampleRate: number,
  rateHz: number,
  jitter: number,
  rng: Rng,
): Float32Array {
  out.fill(0);
  if (!(rateHz > 0)) return out;
  const period = sampleRate / rateHz;
  const j = jitter < 0 ? 0 : jitter > 1 ? 1 : jitter;
  for (let k = 0; ; k += 1) {
    const base = k * period;
    if (base >= out.length) break;
    const index = Math.round(base + (rng.next() - 0.5) * period * j);
    if (index >= 0 && index < out.length) out[index] = 1;
  }
  return out;
}

/** Allocating convenience wrapper. Prefer the `fill*` functions in hot paths. */
export function generateNoise(
  kind: NoiseKind,
  length: number,
  options: { rng?: Rng; sampleRate?: number; densityHz?: number } = {},
): Float32Array {
  const out = new Float32Array(Math.max(0, Math.floor(length)));
  const rng = options.rng ?? createRng(0x5eed);
  switch (kind) {
    case 'white':
      return fillWhiteNoise(out, rng);
    case 'pink':
      return fillPinkNoise(out, rng);
    case 'brown':
      return fillBrownNoise(out, rng);
    case 'blue':
      return fillBlueNoise(out, rng);
    case 'velvet':
      return fillVelvetNoise(out, rng, options.densityHz ?? 900, options.sampleRate ?? 48000);
    default:
      return fillWhiteNoise(out, rng);
  }
}

/**
 * Cross-fade the first and last `fadeSamples` of a buffer into each other so it
 * can be played on a looping `AudioBufferSourceNode` without a seam click.
 * Operates in place and shortens the *usable* region to `length - fadeSamples`;
 * callers should set `loopEnd` accordingly (see `loopEndFor`).
 */
export function crossfadeLoopInPlace(out: Float32Array, fadeSamples: number): Float32Array {
  const n = out.length;
  const fade = Math.min(Math.max(0, Math.floor(fadeSamples)), Math.floor(n / 2));
  for (let i = 0; i < fade; i += 1) {
    const t = i / fade;
    const head = out[i] ?? 0;
    const tail = out[n - fade + i] ?? 0;
    // Equal-power crossfade keeps perceived level constant across the seam.
    out[i] = head * Math.sqrt(t) + tail * Math.sqrt(1 - t);
  }
  return out;
}

/** The `loopEnd` (in seconds) that pairs with `crossfadeLoopInPlace`. */
export function loopEndFor(lengthSamples: number, fadeSamples: number, sampleRate: number): number {
  const fade = Math.min(Math.max(0, Math.floor(fadeSamples)), Math.floor(lengthSamples / 2));
  return Math.max(0, (lengthSamples - fade) / Math.max(sampleRate, 1));
}

/* ------------------------------------------------------------------ */
/* Analysis helpers — used for normalisation and for meaningful tests. */
/* ------------------------------------------------------------------ */

export function peakOf(data: ArrayLike<number>): number {
  let peak = 0;
  for (let i = 0; i < data.length; i += 1) {
    const v = Math.abs(data[i] ?? 0);
    if (v > peak) peak = v;
  }
  return peak;
}

export function rmsOf(data: ArrayLike<number>, start = 0, length = data.length - start): number {
  const from = Math.max(0, Math.floor(start));
  const to = Math.min(data.length, from + Math.max(0, Math.floor(length)));
  if (to <= from) return 0;
  let sum = 0;
  for (let i = from; i < to; i += 1) {
    const v = data[i] ?? 0;
    sum += v * v;
  }
  return Math.sqrt(sum / (to - from));
}

/** Fraction of adjacent sample pairs that change sign — a cheap brightness proxy. */
export function zeroCrossingRate(data: ArrayLike<number>): number {
  if (data.length < 2) return 0;
  let crossings = 0;
  let prev = data[0] ?? 0;
  for (let i = 1; i < data.length; i += 1) {
    const cur = data[i] ?? 0;
    if ((prev < 0 && cur >= 0) || (prev >= 0 && cur < 0)) crossings += 1;
    prev = cur;
  }
  return crossings / (data.length - 1);
}

/** RMS of `windows` equal slices — the shape of a decay curve. */
export function windowedRms(data: ArrayLike<number>, windows: number): Float32Array {
  const count = Math.max(1, Math.floor(windows));
  const out = new Float32Array(count);
  const size = data.length / count;
  for (let w = 0; w < count; w += 1) {
    const start = Math.floor(w * size);
    const end = Math.min(data.length, Math.floor((w + 1) * size));
    out[w] = rmsOf(data, start, end - start);
  }
  return out;
}

/** Pearson correlation of two equal-length signals; used to check stereo decorrelation. */
export function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let sa = 0;
  let sb = 0;
  for (let i = 0; i < n; i += 1) {
    sa += a[i] ?? 0;
    sb += b[i] ?? 0;
  }
  const ma = sa / n;
  const mb = sb / n;
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i += 1) {
    const x = (a[i] ?? 0) - ma;
    const y = (b[i] ?? 0) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  const den = Math.sqrt(da * db);
  return den === 0 ? 0 : num / den;
}

/** Scale in place so the peak equals `target`. A silent buffer is left alone. */
export function normalizeInPlace(out: Float32Array, target = 1): Float32Array {
  const peak = peakOf(out);
  if (peak <= 0) return out;
  const scale = target / peak;
  for (let i = 0; i < out.length; i += 1) {
    out[i] = (out[i] ?? 0) * scale;
  }
  return out;
}
