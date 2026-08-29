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
export declare function createRng(seed?: number): Rng;
/**
 * Hash an arbitrary string (a campsite id, a bus name) into a 32-bit seed so
 * content manifests can drive deterministic variation without shipping seeds.
 */
export declare function hashSeed(text: string): number;
/**
 * Time until the next event of a homogeneous Poisson process of rate
 * `ratePerSecond`. This is the exact inverse-CDF sample, `-ln(U)/λ`.
 *
 * A rate of zero (or less) yields `Infinity`, which the schedulers read as
 * "never" — that is how a dead fire stops crackling without a special case.
 */
export declare function poissonInterval(ratePerSecond: number, rng: Rng): number;
/** Expected number of Poisson events across `seconds`. Used for tests and for budgeting voices. */
export declare function poissonExpectedCount(ratePerSecond: number, seconds: number): number;
//# sourceMappingURL=rng.d.ts.map