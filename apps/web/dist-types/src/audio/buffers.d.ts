/**
 * Shared, lazily-built `AudioBuffer` bank.
 *
 * Every layer needs noise, and generating a 4-second pink-noise loop costs a
 * couple of hundred thousand operations. The bank builds each buffer once, on
 * first use, and hands the same object to fire, ambience, machine and foley.
 */
import type { NoiseKind } from './noise.js';
export interface NoiseBankOptions {
    /** Length of each looping texture. Long enough that the loop is not audible. */
    loopSeconds: number;
    /** Crossfade applied across the loop seam, in seconds. */
    loopFadeSeconds: number;
    /** Number of distinct one-shot grains, spread from dull to bright. */
    grainCount: number;
    grainSeconds: number;
    seed: number;
}
export declare const DEFAULT_NOISE_BANK_OPTIONS: Readonly<NoiseBankOptions>;
export declare class NoiseBank {
    private readonly ctx;
    private readonly options;
    private readonly rng;
    private readonly loops;
    private readonly loopEnds;
    private readonly velvets;
    private grains;
    constructor(ctx: BaseAudioContext, options?: Partial<NoiseBankOptions>);
    private fill;
    /** A seamless looping mono texture of the given colour. */
    loop(kind: NoiseKind): AudioBuffer;
    /** The `loopEnd` seconds to pair with `loop(kind)` so the seam stays inaudible. */
    loopEnd(kind: NoiseKind): number;
    private buildGrains;
    /** One of `grainCount` percussive noise grains, ordered dull -> bright. */
    grain(index: number): AudioBuffer;
    /** Pick the grain closest to a 0..1 brightness. */
    grainForBrightness(brightness: number): AudioBuffer;
    get grainCount(): number;
    /** A looping velvet-noise buffer at a given impulse density. */
    velvet(densityHz: number): AudioBuffer;
    dispose(): void;
}
//# sourceMappingURL=buffers.d.ts.map