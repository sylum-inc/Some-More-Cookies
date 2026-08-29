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
export type NoiseKind = 'white' | 'pink' | 'brown' | 'blue' | 'velvet';
/** Uniform white noise in [-1, 1). Flat spectrum, the base for everything else. */
export declare function fillWhiteNoise(out: Float32Array, rng: Rng): Float32Array;
/**
 * Pink (1/f) noise via Paul Kellet's economical filter bank. This is the
 * workhorse for wind and the fire roar: white noise sounds like a hiss, pink
 * sounds like moving air.
 */
export declare function fillPinkNoise(out: Float32Array, rng: Rng): Float32Array;
/**
 * Brown (1/f^2) noise via a leaky integrator. Used for the deep fire rumble and
 * distant thunder-ish weight; almost all of its energy is under 200 Hz.
 */
export declare function fillBrownNoise(out: Float32Array, rng: Rng): Float32Array;
/** Blue (f) noise — a first difference of white. Bright, used for frost ticks and fizz. */
export declare function fillBlueNoise(out: Float32Array, rng: Rng): Float32Array;
/**
 * Velvet noise: sparse +/-1 impulses on a randomised grid. Perceptually smooth
 * but extremely cheap to convolve, and it makes very convincing sizzle and
 * refrigerant gurgle when band-passed.
 */
export declare function fillVelvetNoise(out: Float32Array, rng: Rng, densityHz: number, sampleRate: number): Float32Array;
/**
 * A single crackle/tick grain: noise shaped by a linear attack and an
 * exponential tail, peak-normalised. `brightness` in 0..1 crossfades the source
 * from brown (dull woody pop) to blue (sharp resinous snap).
 */
export declare function fillGrain(out: Float32Array, rng: Rng, sampleRate: number, attackSeconds: number, decaySeconds: number, brightness?: number): Float32Array;
/**
 * A jittered impulse train — the skeleton of a cricket chirp before band-pass
 * filtering. `jitter` (0..1) randomises each impulse position within its slot.
 */
export declare function fillImpulseTrain(out: Float32Array, sampleRate: number, rateHz: number, jitter: number, rng: Rng): Float32Array;
/** Allocating convenience wrapper. Prefer the `fill*` functions in hot paths. */
export declare function generateNoise(kind: NoiseKind, length: number, options?: {
    rng?: Rng;
    sampleRate?: number;
    densityHz?: number;
}): Float32Array;
/**
 * Cross-fade the first and last `fadeSamples` of a buffer into each other so it
 * can be played on a looping `AudioBufferSourceNode` without a seam click.
 * Operates in place and shortens the *usable* region to `length - fadeSamples`;
 * callers should set `loopEnd` accordingly (see `loopEndFor`).
 */
export declare function crossfadeLoopInPlace(out: Float32Array, fadeSamples: number): Float32Array;
/** The `loopEnd` (in seconds) that pairs with `crossfadeLoopInPlace`. */
export declare function loopEndFor(lengthSamples: number, fadeSamples: number, sampleRate: number): number;
export declare function peakOf(data: ArrayLike<number>): number;
export declare function rmsOf(data: ArrayLike<number>, start?: number, length?: number): number;
/** Fraction of adjacent sample pairs that change sign — a cheap brightness proxy. */
export declare function zeroCrossingRate(data: ArrayLike<number>): number;
/** RMS of `windows` equal slices — the shape of a decay curve. */
export declare function windowedRms(data: ArrayLike<number>, windows: number): Float32Array;
/** Pearson correlation of two equal-length signals; used to check stereo decorrelation. */
export declare function correlation(a: ArrayLike<number>, b: ArrayLike<number>): number;
/** Scale in place so the peak equals `target`. A silent buffer is left alone. */
export declare function normalizeInPlace(out: Float32Array, target?: number): Float32Array;
//# sourceMappingURL=noise.d.ts.map