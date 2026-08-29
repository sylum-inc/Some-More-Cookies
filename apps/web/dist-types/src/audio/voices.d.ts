/**
 * Voice pooling and stochastic scheduling.
 *
 * WebAudio forces one allocation per one-shot: `AudioBufferSourceNode` and
 * `OscillatorNode` are single-use by spec. Everything *else* — the gain,
 * filter and panner each shot runs through — is pooled here and reused, and the
 * per-frame update path (`FireBed.update`, `NightAmbience.update`) allocates
 * nothing at all: it writes into pre-built parameter objects and calls
 * `setTargetAtTime`.
 */
import type { Rng } from './rng.js';
export interface PoolStats {
    created: number;
    inUse: number;
    free: number;
    highWater: number;
}
/** A minimal free-list pool. No allocation on acquire once warm. */
export declare class ObjectPool<T> {
    private readonly factory;
    private readonly onRelease;
    private readonly maxSize;
    private readonly free;
    private createdCount;
    private inUseCount;
    private highWaterMark;
    constructor(factory: () => T, onRelease?: ((item: T) => void) | null, warmCount?: number, maxSize?: number);
    acquire(): T;
    release(item: T): void;
    get stats(): PoolStats;
    /** Drop cached items (e.g. when the AudioContext is closed). */
    clear(): void;
}
/**
 * Homogeneous Poisson process over the audio clock.
 *
 * `collect` writes the absolute times of every event up to `horizon` into a
 * caller-owned `Float64Array`, so the scheduling loop is allocation-free. If
 * more events fall inside the horizon than the array can hold, the surplus is
 * dropped and counted in `dropped` — that is the voice budget doing its job
 * when the fire is roaring.
 */
export declare class PoissonScheduler {
    private readonly rng;
    private nextTime;
    private ratePerSecond;
    private droppedCount;
    constructor(rng: Rng);
    /** Arm the process at `now`; the first event lands one interval later. */
    reset(now: number): void;
    /**
     * Change the rate. A process that was stopped is re-armed from `now`; a
     * running process keeps its pending event unless it now sits implausibly far
     * in the future for the new rate (which would make a sudden flare-up feel
     * laggy), in which case it is resampled.
     */
    setRate(ratePerSecond: number, now: number): void;
    get rate(): number;
    get dropped(): number;
    /** Absolute time of the next pending event (`Infinity` when stopped). */
    peek(): number;
    collect(horizon: number, out: Float64Array): number;
}
/**
 * Look-ahead window driver. The audio clock runs ahead of the game loop, so all
 * stochastic events are scheduled into `[now, now + lookahead]` and the pump
 * only needs to run every `intervalSeconds`.
 */
export declare class LookaheadWindow {
    lookaheadSeconds: number;
    readonly maxCatchUpSeconds: number;
    private horizon;
    constructor(lookaheadSeconds?: number, maxCatchUpSeconds?: number);
    reset(now: number): void;
    /**
     * Advance the window to `now`. Returns the new horizon, or `null` when there
     * is nothing to do yet. Large gaps (tab was backgrounded) are truncated to
     * `maxCatchUpSeconds` so we never dump a thousand queued crackles at once.
     */
    advance(now: number): number | null;
    get currentHorizon(): number;
}
/**
 * A reusable gain+filter chain for one-shot grains. The source node is created
 * per shot (WebAudio requires it) but is thrown away immediately; the chain
 * behind it survives for the life of the engine.
 */
export interface GrainVoice {
    readonly gain: GainNode;
    readonly filter: BiquadFilterNode;
    /** Null when the platform lacks `StereoPannerNode` (older Safari). */
    readonly pan: StereoPannerNode | null;
    /** Audio-clock time at which this voice becomes reusable. */
    busyUntil: number;
}
export declare class GrainVoicePool {
    private readonly ctx;
    private readonly destination;
    private readonly size;
    private readonly voices;
    constructor(ctx: BaseAudioContext, destination: AudioNode, size: number);
    private build;
    /**
     * Pick a voice that is free at `time`, otherwise steal the one that frees up
     * soonest. Stealing is audible only under extreme density, where a dropped
     * tail is far less noticeable than a missing crackle.
     */
    acquire(time: number): GrainVoice;
    get activeCount(): number;
    get capacity(): number;
    dispose(): void;
}
//# sourceMappingURL=voices.d.ts.map