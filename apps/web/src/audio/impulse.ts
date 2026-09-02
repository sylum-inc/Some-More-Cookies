/**
 * Procedural impulse responses.
 *
 * A convolution reverb normally ships as a WAV file. We have no assets, so each
 * space is described as data and rendered to a stereo IR in JS: exponentially
 * decaying, progressively damped, optionally sparse noise, with a handful of
 * discrete early reflections stamped on top. The result is cached per
 * (space, sampleRate) because generation costs a few million operations.
 */

import { clamp, clamp01, lerp } from './math.js';
import { createRng, hashSeed } from './rng.js';

export type SpaceType = 'openForest' | 'clearing' | 'canyon' | 'snowfield' | 'indoorSmall';

export const SPACE_TYPES: readonly SpaceType[] = [
  'openForest',
  'clearing',
  'canyon',
  'snowfield',
  'indoorSmall',
];

export interface EarlyReflection {
  /** Delay from the direct sound, in seconds. */
  timeSeconds: number;
  /** Linear gain, may be negative for a polarity flip. */
  gain: number;
}

export interface ImpulseSpec {
  /** Total IR length in seconds. */
  durationSeconds: number;
  /** 1 means "reaches -60 dB exactly at the end"; >1 decays sooner, <1 later. */
  decay: number;
  /** Silence before the tail starts — reads as room size. */
  preDelaySeconds: number;
  /** High-frequency absorption of the tail, 0..1. Foliage and snow are high. */
  damping: number;
  /** Tail density, 0..1. Low values give a sparse, grainy, outdoors tail. */
  diffusion: number;
  /** Channel decorrelation, 0..1. 0 is mono, 1 is fully independent. */
  stereoWidth: number;
  /** Overall IR gain applied after peak normalisation. */
  gain: number;
  earlyReflections: readonly EarlyReflection[];
}

export interface GeneratedImpulse {
  sampleRate: number;
  length: number;
  /** Always exactly two channels. */
  channels: readonly [Float32Array, Float32Array];
}

/**
 * Space definitions. These are plain data so an environment manifest can
 * override them without touching code.
 */
export const SPACE_PRESETS: Readonly<Record<SpaceType, ImpulseSpec>> = Object.freeze({
  // Trunks give discrete reflections, leaves eat the top end.
  openForest: {
    durationSeconds: 1.9,
    decay: 1.05,
    preDelaySeconds: 0.012,
    damping: 0.72,
    diffusion: 0.55,
    stereoWidth: 0.9,
    gain: 0.5,
    earlyReflections: [
      { timeSeconds: 0.017, gain: 0.42 },
      { timeSeconds: 0.031, gain: -0.3 },
      { timeSeconds: 0.053, gain: 0.22 },
      { timeSeconds: 0.089, gain: -0.14 },
    ],
  },
  // Open sky above, a ring of trees far off: short, airy, wide.
  clearing: {
    durationSeconds: 1.15,
    decay: 1.25,
    preDelaySeconds: 0.009,
    damping: 0.5,
    diffusion: 0.35,
    stereoWidth: 1,
    gain: 0.42,
    earlyReflections: [
      { timeSeconds: 0.024, gain: 0.28 },
      { timeSeconds: 0.061, gain: -0.16 },
    ],
  },
  // Hard rock walls: long, bright, with unmistakable discrete slapbacks.
  canyon: {
    durationSeconds: 3.6,
    decay: 0.8,
    preDelaySeconds: 0.045,
    damping: 0.24,
    diffusion: 0.7,
    stereoWidth: 0.85,
    gain: 0.6,
    earlyReflections: [
      { timeSeconds: 0.092, gain: 0.5 },
      { timeSeconds: 0.176, gain: -0.34 },
      { timeSeconds: 0.263, gain: 0.24 },
      { timeSeconds: 0.401, gain: -0.16 },
    ],
  },
  // Fresh snow is the most absorbent natural surface there is.
  snowfield: {
    durationSeconds: 0.55,
    decay: 1.7,
    preDelaySeconds: 0.006,
    damping: 0.9,
    diffusion: 0.2,
    stereoWidth: 0.7,
    gain: 0.3,
    earlyReflections: [{ timeSeconds: 0.013, gain: 0.12 }],
  },
  // The SM-01 shed: small, boxy, dense.
  indoorSmall: {
    durationSeconds: 0.42,
    decay: 1.15,
    preDelaySeconds: 0.004,
    damping: 0.45,
    diffusion: 0.88,
    stereoWidth: 0.5,
    gain: 0.55,
    earlyReflections: [
      { timeSeconds: 0.005, gain: 0.55 },
      { timeSeconds: 0.009, gain: -0.42 },
      { timeSeconds: 0.014, gain: 0.33 },
      { timeSeconds: 0.021, gain: -0.26 },
      { timeSeconds: 0.033, gain: 0.18 },
    ],
  },
});

/**
 * Mixing time: how long the diffuse tail takes to build to full density.
 *
 * In a real space the reverberant field is not instantaneous — energy arrives
 * as discrete early reflections first and only becomes a dense diffuse tail
 * once it has bounced enough times. Modelling that build-up is what lets the
 * early reflections actually be heard as distinct events instead of being
 * buried under a tail that starts at full level.
 */
export function mixingTimeSeconds(spec: ImpulseSpec): number {
  let lastReflection = 0;
  for (let i = 0; i < spec.earlyReflections.length; i += 1) {
    const reflection = spec.earlyReflections[i];
    if (reflection && reflection.timeSeconds > lastReflection) lastReflection = reflection.timeSeconds;
  }
  const fromReflections = lastReflection * 1.5;
  const fromSize = spec.durationSeconds * 0.08;
  return Math.max(fromReflections, fromSize, 0.005);
}

export function impulseSampleCount(spec: ImpulseSpec, sampleRate: number): number {
  return Math.max(1, Math.round(Math.max(spec.durationSeconds, 0.01) * sampleRate));
}

/**
 * Envelope of the diffuse tail at normalised position `t` (0..1 across the IR).
 * Exponential decay times a gentle end-taper so the IR reaches exactly zero and
 * cannot click at the convolution boundary.
 */
export function tailEnvelope(t: number, decay: number): number {
  const x = clamp01(t);
  // decay === 1 -> exp(-6.9078) === -60 dB at the tail end.
  const exponential = Math.exp(-x * 6.907755 * Math.max(decay, 0.05));
  const taper = Math.pow(1 - x, 0.35);
  return exponential * taper;
}

function renderChannel(
  out: Float32Array,
  spec: ImpulseSpec,
  sampleRate: number,
  seed: number,
): Float32Array {
  const rng = createRng(seed);
  const length = out.length;
  const preDelay = Math.min(length - 1, Math.max(0, Math.round(spec.preDelaySeconds * sampleRate)));
  const damping = clamp01(spec.damping);
  const diffusion = clamp01(spec.diffusion);
  // Sparse tails read as "outdoors": each sample survives with this probability.
  const density = lerp(0.12, 1, diffusion);

  const mixingSamples = Math.max(1, mixingTimeSeconds(spec) * sampleRate);

  out.fill(0);
  let low = 0;
  for (let i = preDelay; i < length; i += 1) {
    const elapsed = i - preDelay;
    const t = elapsed / Math.max(1, length - preDelay);
    // Damping deepens over time: high frequencies die before low ones.
    const cutoff = lerp(0.95, 0.04, damping * (0.3 + 0.7 * t));
    const white = rng.next() * 2 - 1;
    low += cutoff * (white - low);
    const shaped = lerp(white, low, damping);
    const gate = density >= 1 || rng.next() < density ? 1 : 0;
    // Energy build-up: reflection density grows roughly linearly with time
    // until the field is fully mixed, so the tail ramps in rather than
    // starting at full level and burying the early reflections.
    const buildUp = elapsed >= mixingSamples ? 1 : elapsed / mixingSamples;
    out[i] = shaped * gate * buildUp * tailEnvelope(t, spec.decay);
  }

  // Early reflections ride on top of the diffuse tail, each with a tiny
  // per-channel time offset so the pair widens rather than centring.
  const jitter = spec.stereoWidth * 0.0012;
  for (let r = 0; r < spec.earlyReflections.length; r += 1) {
    const reflection = spec.earlyReflections[r];
    if (!reflection) continue;
    const time = spec.preDelaySeconds + reflection.timeSeconds + (rng.next() - 0.5) * jitter;
    const index = Math.round(time * sampleRate);
    if (index >= 0 && index < length) {
      out[index] = (out[index] ?? 0) + reflection.gain;
      // A one-sample smear stops the reflection reading as a digital tick.
      if (index + 1 < length) out[index + 1] = (out[index + 1] ?? 0) + reflection.gain * 0.45;
    }
  }
  return out;
}

/**
 * Render a stereo impulse response for `spec`. Deterministic for a given seed,
 * so two clients in the same clearing convolve identically.
 */
export function generateImpulseResponse(
  spec: ImpulseSpec,
  sampleRate: number,
  seed = 0x1a2b3c4d,
): GeneratedImpulse {
  const length = impulseSampleCount(spec, sampleRate);
  const left = new Float32Array(length);
  const right = new Float32Array(length);

  renderChannel(left, spec, sampleRate, seed >>> 0);
  const width = clamp01(spec.stereoWidth);
  if (width <= 0) {
    right.set(left);
  } else {
    const independent = new Float32Array(length);
    renderChannel(independent, spec, sampleRate, (seed ^ 0x9e3779b9) >>> 0);
    for (let i = 0; i < length; i += 1) {
      right[i] = lerp(left[i] ?? 0, independent[i] ?? 0, width);
    }
  }

  // Normalise the pair together so the stereo image is preserved, then apply
  // the preset's gain. Convolver output is otherwise wildly level-dependent on
  // IR length.
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const l = Math.abs(left[i] ?? 0);
    const r = Math.abs(right[i] ?? 0);
    if (l > peak) peak = l;
    if (r > peak) peak = r;
  }
  if (peak > 0) {
    const scale = clamp(spec.gain, 0, 4) / peak;
    for (let i = 0; i < length; i += 1) {
      left[i] = (left[i] ?? 0) * scale;
      right[i] = (right[i] ?? 0) * scale;
    }
  }

  return { sampleRate, length, channels: [left, right] };
}

/**
 * Memoises generated IRs. Keyed on space + sample rate + seed, so switching
 * campsites back and forth never re-renders.
 */
export class ImpulseCache {
  private readonly entries = new Map<string, GeneratedImpulse>();

  constructor(private readonly overrides: Partial<Record<SpaceType, ImpulseSpec>> = {}) {}

  specFor(space: SpaceType): ImpulseSpec {
    return this.overrides[space] ?? SPACE_PRESETS[space];
  }

  get(space: SpaceType, sampleRate: number, seed = hashSeed(space)): GeneratedImpulse {
    const key = `${space}:${Math.round(sampleRate)}:${seed >>> 0}`;
    const existing = this.entries.get(key);
    if (existing) return existing;
    const created = generateImpulseResponse(this.specFor(space), sampleRate, seed);
    this.entries.set(key, created);
    return created;
  }

  has(space: SpaceType, sampleRate: number, seed = hashSeed(space)): boolean {
    return this.entries.has(`${space}:${Math.round(sampleRate)}:${seed >>> 0}`);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}
