/**
 * The fire bed.
 *
 * Four continuous layers plus a stochastic crackle stream:
 *
 *  - roar   : looping pink noise through a resonant low-pass. Cutoff and gain
 *             track `intensity`; this is the body of the flame.
 *  - hiss    : looping white noise through a high-pass. Steam and wood gas
 *             escaping — loudest on a well-fuelled, moderately hot fire.
 *  - rumble : looping brown noise through a low-pass around 60-140 Hz. Only a
 *             well-fed fire has it, and it is what makes a fire feel *big*.
 *  - embers : sparse velvet noise, band-passed high. Audible when flames drop
 *             and the coal bed is doing the work.
 *  - crackle: Poisson-scheduled noise grains, band-passed, with a fast attack
 *             and an exponential tail. Rate, brightness and level all move.
 *
 * Wind is a modulator rather than a layer: an LFO at `windFlutterHz` with depth
 * `windFlutterDepth` is summed into the roar gain and the roar cutoff, which is
 * what a gust actually does to a flame.
 */
import type { LayerDeps, PumpableLayer } from './layer.js';
/**
 * Normalised simulation state. Everything is 0..1 and is clamped on entry, so
 * the simulation is free to overshoot without producing a hostile noise.
 */
export interface FireAudioState {
    /** Flame size / combustion vigour. */
    intensity: number;
    /** How hot the coal bed is. Drives crackle brightness and the ember fizz. */
    emberHeat: number;
    /** How much unburnt fuel is stacked on. Drives rumble and hiss. */
    fuelLoad: number;
    /** Local wind. Modulates everything and raises the crackle rate. */
    windSpeed: number;
    /** Fuel dryness / resin content, i.e. how *snappy* this wood is. */
    crackleRate: number;
}
export declare const DEFAULT_FIRE_STATE: Readonly<FireAudioState>;
/** The audio-side parameters `mapFireState` produces. Mutated in place; never re-allocated. */
export interface FireVoiceParams {
    roarGain: number;
    roarCutoffHz: number;
    roarQ: number;
    hissGain: number;
    hissCutoffHz: number;
    rumbleGain: number;
    rumbleCutoffHz: number;
    emberGain: number;
    emberCenterHz: number;
    crackleRatePerSecond: number;
    cracklePeakGain: number;
    crackleCenterHz: number;
    crackleBrightness: number;
    windFlutterDepth: number;
    windFlutterHz: number;
}
export declare function createFireVoiceParams(): FireVoiceParams;
/** Upper bound on the Poisson rate, so a runaway sim value cannot melt the CPU. */
export declare const MAX_CRACKLE_RATE = 40;
/**
 * Pure mapping from simulation state to synthesis parameters.
 *
 * Deliberately allocation-free: the caller owns `out`, which lets the engine
 * call this every frame from the render loop without producing garbage.
 */
export declare function mapFireState(state: FireAudioState, out: FireVoiceParams): FireVoiceParams;
export interface FireBedOptions {
    /** Concurrent crackle voices. Beyond this, the newest crackle steals the oldest. */
    crackleVoices: number;
    /** How far ahead of the audio clock crackles are scheduled. */
    lookaheadSeconds: number;
    /** Smoothing constant for continuous parameter moves. */
    smoothingSeconds: number;
}
export declare const DEFAULT_FIRE_BED_OPTIONS: Readonly<FireBedOptions>;
export declare class FireBed implements PumpableLayer {
    private readonly deps;
    private readonly options;
    private readonly stateValue;
    private readonly paramsValue;
    private readonly output;
    private readonly roarGain;
    private readonly roarFilter;
    private readonly hissGain;
    private readonly hissFilter;
    private readonly rumbleGain;
    private readonly rumbleFilter;
    private readonly emberGain;
    private readonly emberFilter;
    private readonly windLfo;
    private readonly windGainDepth;
    private readonly windCutoffDepth;
    private readonly sources;
    private readonly crackleVoices;
    private readonly scheduler;
    private readonly window;
    /** Pre-allocated: `collect` writes event times here, never into a fresh array. */
    private readonly eventTimes;
    private readonly crackleEnv;
    private started;
    private disposed;
    private crackleCount;
    constructor(deps: LayerDeps, options?: Partial<FireBedOptions>);
    get state(): Readonly<FireAudioState>;
    get params(): Readonly<FireVoiceParams>;
    get running(): boolean;
    /** Total crackles scheduled since construction — a cheap diagnostic. */
    get cracklesScheduled(): number;
    private startLoop;
    start(): void;
    stop(fadeSeconds?: number): void;
    /**
     * Hot path. Called every simulation frame; allocates nothing. Partial state
     * is merged so callers can push only what changed.
     */
    setState(next: Partial<FireAudioState>): void;
    /**
     * Schedule crackles into the look-ahead window. Safe to call at any rate;
     * `LookaheadWindow` collapses long gaps so a backgrounded tab does not
     * produce a burst on return.
     */
    pump(now: number): number;
    /** Fire a single crackle immediately — used by gameplay pokes (a log settling). */
    crackleNow(scale?: number): void;
    private spawnCrackle;
    dispose(): void;
}
//# sourceMappingURL=fire.d.ts.map