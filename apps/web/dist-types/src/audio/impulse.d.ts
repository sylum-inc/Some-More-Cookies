/**
 * Procedural impulse responses.
 *
 * A convolution reverb normally ships as a WAV file. We have no assets, so each
 * space is described as data and rendered to a stereo IR in JS: exponentially
 * decaying, progressively damped, optionally sparse noise, with a handful of
 * discrete early reflections stamped on top. The result is cached per
 * (space, sampleRate) because generation costs a few million operations.
 */
export type SpaceType = 'openForest' | 'clearing' | 'canyon' | 'snowfield' | 'indoorSmall';
export declare const SPACE_TYPES: readonly SpaceType[];
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
export declare const SPACE_PRESETS: Readonly<Record<SpaceType, ImpulseSpec>>;
/**
 * Mixing time: how long the diffuse tail takes to build to full density.
 *
 * In a real space the reverberant field is not instantaneous — energy arrives
 * as discrete early reflections first and only becomes a dense diffuse tail
 * once it has bounced enough times. Modelling that build-up is what lets the
 * early reflections actually be heard as distinct events instead of being
 * buried under a tail that starts at full level.
 */
export declare function mixingTimeSeconds(spec: ImpulseSpec): number;
export declare function impulseSampleCount(spec: ImpulseSpec, sampleRate: number): number;
/**
 * Envelope of the diffuse tail at normalised position `t` (0..1 across the IR).
 * Exponential decay times a gentle end-taper so the IR reaches exactly zero and
 * cannot click at the convolution boundary.
 */
export declare function tailEnvelope(t: number, decay: number): number;
/**
 * Render a stereo impulse response for `spec`. Deterministic for a given seed,
 * so two clients in the same clearing convolve identically.
 */
export declare function generateImpulseResponse(spec: ImpulseSpec, sampleRate: number, seed?: number): GeneratedImpulse;
/**
 * Memoises generated IRs. Keyed on space + sample rate + seed, so switching
 * campsites back and forth never re-renders.
 */
export declare class ImpulseCache {
    private readonly overrides;
    private readonly entries;
    constructor(overrides?: Partial<Record<SpaceType, ImpulseSpec>>);
    specFor(space: SpaceType): ImpulseSpec;
    get(space: SpaceType, sampleRate: number, seed?: number): GeneratedImpulse;
    has(space: SpaceType, sampleRate: number, seed?: number): boolean;
    get size(): number;
    clear(): void;
}
//# sourceMappingURL=impulse.d.ts.map