/**
 * Foley: cooking, handling and movement.
 *
 * The marshmallow sizzle is the only continuous layer here — it tracks the
 * surface state of the thing on the stick and has to respond smoothly, because
 * it is the player's main non-visual feedback on how close they are to a
 * perfect toast. Everything else is a one-shot built from the shared
 * `Synth` primitives.
 */
import type { LayerDeps, PumpableLayer } from './layer.js';
/** Surface state of whatever is being cooked. All 0..1. */
export interface SizzleState {
    /** How hot the surface currently is. */
    heat: number;
    /** How much water is left in the surface. Dries out as it cooks. */
    moisture: number;
    /** How far the sugar has caramelised. Adds dry, brittle micro-crackle. */
    browning: number;
    /** How close the surface is to igniting. Adds a low roar underneath. */
    scorch: number;
}
export declare const DEFAULT_SIZZLE_STATE: Readonly<SizzleState>;
export interface SizzleParams {
    /** Broadband steam hiss level. */
    hissGain: number;
    hissCenterHz: number;
    hissQ: number;
    /** Rate of tiny bursting-bubble pops, events/second. */
    popRatePerSecond: number;
    popPeakGain: number;
    popCenterHz: number;
    /** Low roar that appears once the surface is close to catching. */
    scorchGain: number;
}
export declare function createSizzleParams(): SizzleParams;
/**
 * Pure mapping from surface state to sizzle synthesis parameters.
 *
 * The physics being modelled: sizzle is water boiling out of the surface, so it
 * needs *both* heat and moisture and it dies as the surface dries. A dry,
 * browning surface is quieter but much brighter and drier — the hiss narrows
 * and moves up, and the pops get sparser and sharper. Right at the edge of
 * ignition a low roar joins underneath.
 */
export declare function sizzleParams(state: SizzleState, out: SizzleParams): SizzleParams;
export type FootstepMaterial = 'pineNeedles' | 'gravel' | 'wetGrass' | 'snow' | 'woodDeck';
export declare const FOOTSTEP_MATERIALS: readonly FootstepMaterial[];
export interface FootstepSpec {
    /** Low body of the step. */
    bodyHz: number;
    bodyPeak: number;
    bodyDecay: number;
    /** The granular layer: how many micro-grains, spread over how long. */
    grains: number;
    spreadSeconds: number;
    grainCenterHz: number;
    grainQ: number;
    grainDecay: number;
    grainPeak: number;
    /** 0 = dull/damp, 1 = bright/dry. Picks the grain from the bank. */
    brightness: number;
    /** Resonant partials of the surface itself; empty for soft ground. */
    partials: readonly number[];
}
export declare const FOOTSTEP_SPECS: Readonly<Record<FootstepMaterial, FootstepSpec>>;
export declare function footstepSpec(material: FootstepMaterial): FootstepSpec;
export declare function isFootstepMaterial(value: string): value is FootstepMaterial;
export type StickAction = 'pickUp' | 'putDown' | 'rotate' | 'tap';
export declare const STICK_ACTIONS: readonly StickAction[];
export interface FoleyOptions {
    lookaheadSeconds: number;
    smoothingSeconds: number;
}
export declare const DEFAULT_FOLEY_OPTIONS: Readonly<FoleyOptions>;
export declare class FoleyKit implements PumpableLayer {
    private readonly deps;
    private readonly options;
    private readonly output;
    private readonly synth;
    private readonly sizzleStateValue;
    private readonly sizzleParamsValue;
    private readonly sizzleGain;
    private readonly sizzleFilter;
    private readonly scorchGain;
    private readonly scorchFilter;
    private sizzleSources;
    private readonly popScheduler;
    private readonly window;
    private readonly eventTimes;
    private sizzling;
    private disposed;
    constructor(deps: LayerDeps, options?: Partial<FoleyOptions>);
    get sizzleState(): Readonly<SizzleState>;
    get sizzleParameters(): Readonly<SizzleParams>;
    get sizzleRunning(): boolean;
    /** Begin the continuous sizzle bed. Idempotent. */
    startSizzle(): void;
    stopSizzle(fadeSeconds?: number): void;
    /** Hot path. Partial update, allocation-free. */
    setSizzleState(next: Partial<SizzleState>): void;
    private applySizzle;
    pump(now: number): number;
    /**
     * Ignition. A fast broadband swell that opens upward as the flame front
     * expands, plus a low pressure pulse. Not an explosion — this is a
     * marshmallow catching, or kindling taking.
     */
    ignitionWhoosh(scale?: number, when?: number): number;
    /** Blowing a flame out: a breathy puff, then the flame dying. */
    blowOut(strength?: number, when?: number): number;
    /**
     * Graham cracker. Brittle laminated biscuit: one decisive snap along the
     * score line, then crumbs. The snap is a hard modal tick; the crumble is a
     * scatter of small grains over the next ~180 ms.
     */
    grahamSnap(when?: number): number;
    /**
     * Chocolate. Denser and more homogeneous than biscuit: a single clean, high,
     * short fracture with a brief glassy ring and almost no crumble.
     */
    chocolateFracture(when?: number): number;
    /** A soft wet squish — low, dull, slow-ish, with a couple of wet ticks. */
    squish(strength?: number, when?: number): number;
    /** Handling the roasting stick: wood on wood, wood on hand, wood on ground. */
    stickHandling(action?: StickAction, when?: number): number;
    /**
     * One footstep. `intensity` scales weight (a walk vs a stomp) and the grain
     * layer is scattered stochastically so no two steps are identical.
     */
    footstep(material?: FootstepMaterial, intensity?: number, when?: number): number;
    dispose(): void;
}
//# sourceMappingURL=foley.d.ts.map