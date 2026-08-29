/**
 * SM-01 machine kit — late-1990s industrial refrigeration.
 *
 * The design brief for this kit: nothing here should sound like a game. Real
 * appliances of that era are built from a small number of physical events —
 * a solenoid throwing, a contactor closing, an induction motor pulling in, air
 * moving through a squirrel-cage fan, refrigerant finding its way through a
 * capillary — and each of those has a recognisable acoustic signature.
 *
 * Techniques used here:
 *
 *  - **Modal synthesis** for metal. A noise excitation is fed through parallel
 *    high-Q band-passes tuned to *inharmonic* partials. Harmonic partials sound
 *    like a bell or a note; inharmonic ones sound like a struck steel panel.
 *  - **Two-stage transients.** Heavy mechanisms travel before they arrive. The
 *    latch is a bright travel/scrape transient, a gap, then the thunk. That gap
 *    is most of what makes it read as heavy.
 *  - **Contact bounce.** Relay contacts chatter for a millisecond or two. Three
 *    decaying micro-ticks is the difference between "relay" and "click".
 *  - **Slip and drift.** An induction motor never sits exactly on its nominal
 *    frequency and never holds it exactly. The hum glides in during start-up
 *    and then drifts by a fraction of a percent forever.
 *  - **Electrical vs mechanical.** The hum has both a mechanical fundamental
 *    and a mains-ripple component at twice line frequency; keeping them
 *    separate (and slightly out of tune with each other) is what stops it
 *    sounding like a synthesiser pad.
 */
import type { LayerDeps, PumpableLayer } from './layer.js';
export interface RelayCharacter {
    id: string;
    /** Low thump of the coil pulling the armature in. */
    coilHz: number;
    coilPeak: number;
    /** Bright band where the contacts actually snap. */
    contactHz: number;
    contactQ: number;
    contactPeak: number;
    /** Exponential decay time-constant of the contact tick. */
    decay: number;
    /** Number of bounce ticks after the first contact. */
    bounces: number;
    /** Spacing between bounces, in seconds. */
    bounceSpacing: number;
}
/**
 * Five physically distinguishable relays. The player is expected to learn these
 * by ear (which one just fired tells you what the machine is doing), so they
 * differ in register, brightness, bounce count and decay — not just in pitch.
 */
export declare const RELAY_CHARACTERS: readonly RelayCharacter[];
export declare function relayCharacter(index: number): RelayCharacter;
export declare const RELAY_COUNT: number;
export type BeepKind = 'confirm' | 'deny' | 'nudge' | 'tick';
export declare const BEEP_KINDS: readonly BeepKind[];
export interface BeepSpec {
    /** Frequencies of each repeat, in order. */
    steps: readonly number[];
    /** Length of one beep. */
    durationSeconds: number;
    /** Silence between beeps. */
    gapSeconds: number;
    peak: number;
    /** Low-pass placed after the oscillator; keeps a square from being shrill. */
    filterHz: number;
    wave: OscillatorType;
}
/**
 * A deliberately small, restrained utility set. All of these are low-mid, short
 * and quiet: a panel beeper from 1997, not a notification sound.
 */
export declare const BEEP_SPECS: Readonly<Record<BeepKind, BeepSpec>>;
export interface FanCurve {
    cutoffHz: number;
    level: number;
    bladeHz: number;
    bladeLevel: number;
}
export declare function createFanCurve(): FanCurve;
/** Nominal fan speed at full tilt, in RPM, and the blade count of an SM-01 impeller. */
export declare const FAN_MAX_RPM = 1450;
export declare const FAN_BLADES = 7;
/**
 * Fan speed (0..1) to synthesis parameters. Air noise rises faster than the
 * blade tone at the bottom of the range and the blade tone dominates at the top,
 * which is how a squirrel-cage blower actually behaves.
 */
export declare function fanCurve(targetSpeed: number, out?: FanCurve): FanCurve;
/** Frost tick rate (events/second) from frost coverage. Superlinear: frost accelerates. */
export declare function frostTickRate(intensity: number): number;
/** Relative amplitudes of the compressor's mechanical partials. */
export declare const COMPRESSOR_HARMONICS: readonly {
    ratio: number;
    gain: number;
}[];
/**
 * A 4-pole induction motor on a 60 Hz supply runs a little under 30 rev/s under
 * load; mains ripple sits at twice line frequency. Returns both, in Hz.
 */
export declare function compressorFrequencies(mainsHz?: number, slip?: number): {
    mechanicalHz: number;
    rippleHz: number;
};
export interface MachineKitOptions {
    mainsHz: number;
    /** Seconds a fan ramp takes to reach its target. */
    fanRampSeconds: number;
    /** Frequency of the CRT whine. Real flyback is 15.7 kHz; that is painful and
     *  inaudible to many adults, so we voice it an octave down where it still
     *  reads as "a monitor is on in here". */
    crtWhineHz: number;
    crtWhineGain: number;
    lookaheadSeconds: number;
}
export declare const DEFAULT_MACHINE_OPTIONS: Readonly<MachineKitOptions>;
export declare class MachineKit implements PumpableLayer {
    private readonly deps;
    private readonly options;
    private readonly output;
    private readonly synth;
    private readonly fanState;
    private compressor;
    private compressorPitch;
    private fan;
    private fanFilter;
    private fanBlade;
    private fanBladeGain;
    private crt;
    private readonly frostScheduler;
    private readonly frostWindow;
    private readonly frostTimes;
    private frostIntensityValue;
    private compressorRunningValue;
    private fanSpeedValue;
    private crtOnValue;
    private disposed;
    constructor(deps: LayerDeps, options?: Partial<MachineKitOptions>);
    /** Never schedule in the past; a few ms of slack avoids glitching. */
    private at;
    /**
     * Heavy two-stage latch.
     *
     * Stage 1 (t+0): the handle travels — a short bright scrape, band-passed
     * around 2.6 kHz and swept downward as the mechanism moves.
     * Stage 2 (t+70 ms): arrival — a 90→52 Hz thunk, a broadband impact and a
     * long inharmonic steel-panel ring. The 70 ms gap is what sells the mass.
     */
    latchClunk(when?: number): number;
    /** Small crisp panel switch: one sharp tick with a short plastic-body ping. */
    switchDetent(when?: number): number;
    /** One of `RELAY_COUNT` distinguishable relays: coil thump, contact snap, bounce. */
    relayClick(index?: number, when?: number): number;
    get compressorRunning(): boolean;
    /**
     * Start-up: contactor clunk, then the motor pulls in — the mechanical
     * fundamental glides up from roughly half speed to running speed over ~1.1 s
     * while a broadband surge fades away, leaving a settled hum with harmonics,
     * mains ripple and a permanent slow pitch drift.
     */
    compressorStart(when?: number): void;
    /** Shut-down: contactor drops out, the hum droops and dies, refrigerant equalises. */
    compressorStop(when?: number): void;
    get fanSpeed(): number;
    get fanParams(): Readonly<FanCurve>;
    /**
     * Broadband air noise whose cutoff and level ramp to `targetSpeed`, plus a
     * faint blade-passing tone at `blades * rpm / 60`.
     */
    fanRamp(targetSpeed: number, rampSeconds?: number): void;
    /**
     * Refrigerant moving through the capillary: a band-passed velvet-noise hiss
     * with a wandering centre, plus a handful of descending resonant "bloops"
     * where liquid slugs pass a bend.
     */
    refrigerantFlow(when?: number, durationSeconds?: number): number;
    get frostIntensity(): number;
    /**
     * Frost growth. Sets a Poisson rate for tiny high-frequency ticks; the ticks
     * themselves are scheduled by `pump`. 0 stops it entirely.
     */
    frostCrackle(intensity: number): void;
    pump(now: number): number;
    /**
     * A heavy insulated door: the magnetic gasket peeling off the frame (a low
     * swept squelch), the latch releasing, then air rushing in to fill the void.
     */
    doorOpen(when?: number): number;
    /** A soft pressurised exhale: fast attack, long fall, filter sweeping down. */
    vaporRelease(when?: number, strength?: number): number;
    /**
     * Completion. Deliberately not a jingle: two warm low partials, the second a
     * perfect fourth below the first, with a soft attack, a long decay and a
     * quiet relay click underneath — the sound of a machine finishing a cycle and
     * dropping its contactor, not a reward.
     */
    completionTone(when?: number): number;
    /** A restrained utility beep. */
    beep(kind?: BeepKind, when?: number): number;
    get crtOn(): boolean;
    /**
     * The panel CRT. Voiced at ~8.4 kHz rather than a true 15.7 kHz flyback:
     * the real frequency is inaudible to many adults and painful to the rest,
     * and this reads as the same thing at a tenth of the annoyance. Kept very
     * quiet, with a slow amplitude wobble so it never sits perfectly still.
     */
    crtWhine(on: boolean): void;
    dispose(): void;
}
//# sourceMappingURL=machine.d.ts.map