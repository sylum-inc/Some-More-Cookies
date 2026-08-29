/**
 * Pure scalar helpers shared by every synthesis module.
 *
 * Nothing in this file touches WebAudio, allocates, or depends on globals, so
 * it is safe to import (and exhaustively test) in a plain Node process.
 */
export declare const TWO_PI: number;
/** Smallest gain we ever hand to `exponentialRampToValueAtTime` (0 is illegal). */
export declare const MIN_GAIN = 0.0001;
/** Clamp `value` into `[min, max]`. NaN collapses to `min` so bad sim state can never blow up a gain. */
export declare function clamp(value: number, min: number, max: number): number;
export declare function clamp01(value: number): number;
export declare function lerp(a: number, b: number, t: number): number;
export declare function inverseLerp(a: number, b: number, value: number): number;
export declare function mapRange(value: number, inMin: number, inMax: number, outMin: number, outMax: number, clampOutput?: boolean): number;
/**
 * Map a normalised 0..1 control onto a frequency-style range logarithmically,
 * which is how ears actually hear "twice as bright".
 */
export declare function mapExp(t01: number, min: number, max: number): number;
export declare function smoothstep(edge0: number, edge1: number, x: number): number;
export declare function smootherstep(edge0: number, edge1: number, x: number): number;
export declare function dbToGain(db: number): number;
export declare function gainToDb(gain: number): number;
export declare function semitonesToRatio(semitones: number): number;
export declare function centsToRatio(cents: number): number;
export declare function midiToHz(midi: number): number;
/** Frame-rate independent approach; `rate` is the fraction closed per second. */
export declare function approach(current: number, target: number, rate: number, dt: number): number;
export declare function moveTowards(current: number, target: number, maxDelta: number): number;
/**
 * Constant-power stereo pan. Writes into `out` (length >= 2) so the hot path
 * never allocates a tuple. Returns `out` for convenience.
 */
export declare function equalPowerGains(pan: number, out: Float32Array | number[]): Float32Array | number[];
/** Positive modulo — safe for negative indices. */
export declare function wrapIndex(index: number, length: number): number;
/** Defensive read for `noUncheckedIndexedAccess`. */
export declare function at<T>(list: ArrayLike<T>, index: number, fallback: T): T;
/** Wrapping read — never returns undefined for a non-empty list. */
export declare function cyclicAt<T>(list: ArrayLike<T>, index: number, fallback: T): T;
//# sourceMappingURL=math.d.ts.map