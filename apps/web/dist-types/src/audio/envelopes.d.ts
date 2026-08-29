/**
 * Envelope maths, split into a pure half (value-at-time, durations) that tests
 * can assert, and a thin applicator half that writes automation onto an
 * `AudioParam`.
 */
export interface AdsrEnvelope {
    /** Seconds from 0 to peak. */
    attack: number;
    /** Seconds from peak down to `sustain`. */
    decay: number;
    /** Held level, 0..1. */
    sustain: number;
    /** Seconds from the level at release down to 0. */
    release: number;
}
export interface PercussiveEnvelope {
    /** Seconds from 0 to `peak`. */
    attack: number;
    /** Exponential decay time-constant in seconds. */
    decay: number;
    /** Peak linear gain. */
    peak: number;
}
/** Decibels below peak at which we consider an exponential tail finished. */
export declare const TAIL_FLOOR_DB = 60;
/**
 * Convert "I want it to fall 60 dB in `seconds`" into the time-constant that
 * `setTargetAtTime` expects. exp(-t/tau) = 10^(-60/20) => tau = t / ln(1000).
 */
export declare function timeConstantForDecay(seconds: number, floorDb?: number): number;
/** How long an exponential tail with this time-constant takes to reach the floor. */
export declare function tailSeconds(timeConstant: number, floorDb?: number): number;
export declare function expDecayValue(peak: number, timeConstant: number, t: number): number;
/** Linear attack into an exponential tail — the shape of every click, tick and pop here. */
export declare function percussiveValueAt(env: PercussiveEnvelope, t: number): number;
/** Total audible length of a percussive hit. */
export declare function percussiveDuration(env: PercussiveEnvelope, floorDb?: number): number;
/**
 * ADSR level at time `t` (seconds since note-on). Pass `releaseAt` to model a
 * key-up; before that moment the envelope behaves as if held.
 */
export declare function adsrValueAt(env: AdsrEnvelope, t: number, releaseAt?: number): number;
export declare function adsrDuration(env: AdsrEnvelope, holdSeconds: number): number;
/**
 * Reduced-audio-intensity shaping. Sudden loud transients are the accessibility
 * problem (startle, pain, misophonia), so we cut the peak and stretch the
 * attack rather than simply turning everything down.
 */
export interface IntensityShaping {
    /** Multiplier applied to transient peaks. */
    peakScale: number;
    /** Multiplier applied to attack times (slower = less startling). */
    attackScale: number;
    /** Hard ceiling on any one-shot's linear peak gain. */
    ceiling: number;
}
export declare const FULL_INTENSITY: IntensityShaping;
export declare const REDUCED_INTENSITY: IntensityShaping;
export declare function shapingFor(reduced: boolean): IntensityShaping;
/** Apply intensity shaping to a percussive envelope. Returns a new envelope. */
export declare function shapePercussive(env: PercussiveEnvelope, shaping: IntensityShaping): PercussiveEnvelope;
/** Minimal structural view of the bits of `AudioParam` the engine writes. */
export interface AutomatableParam {
    value: number;
    setValueAtTime(value: number, startTime: number): unknown;
    linearRampToValueAtTime(value: number, endTime: number): unknown;
    exponentialRampToValueAtTime(value: number, endTime: number): unknown;
    setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
    cancelScheduledValues(startTime: number): unknown;
}
/**
 * Schedule a percussive envelope onto a gain param starting at `startTime`.
 * Uses a linear attack (safe from zero) and `setTargetAtTime` for the tail,
 * then a final `setValueAtTime(0)` so the param is provably silent and the
 * voice can be recycled.
 *
 * Returns the absolute time at which the voice is finished.
 */
export declare function applyPercussive(param: AutomatableParam, startTime: number, env: PercussiveEnvelope, floorDb?: number): number;
/**
 * Schedule an ADSR attack/decay/sustain from `startTime`. Release is scheduled
 * separately by `applyRelease` so held sounds (fan, compressor) can end when
 * the simulation says so.
 */
export declare function applyAttackHold(param: AutomatableParam, startTime: number, env: AdsrEnvelope, peak: number): void;
/** Ramp a held voice down to silence; returns the time it is finished. */
export declare function applyRelease(param: AutomatableParam, startTime: number, releaseSeconds: number): number;
/** Smoothly steer a continuously-modulated param without zipper noise. */
export declare function glideTo(param: AutomatableParam, target: number, now: number, smoothingSeconds: number): void;
/** Clamp a mapped control into a sane audio band before it reaches a filter. */
export declare function safeFrequency(hz: number, sampleRate?: number): number;
//# sourceMappingURL=envelopes.d.ts.map