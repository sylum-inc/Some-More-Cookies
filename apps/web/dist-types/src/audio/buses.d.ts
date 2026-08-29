/**
 * Submix bus definitions and the pure mixer state machine.
 *
 * The state machine deliberately knows nothing about WebAudio: it holds
 * volumes, mute and the reduced-intensity flag, and notifies listeners. The
 * engine subscribes and pushes the resulting gains onto real `GainNode`s. That
 * split means bus/mute/accessibility behaviour is fully testable headlessly,
 * and it means volumes set before the context exists are not lost.
 */
import type { IntensityShaping } from './envelopes.js';
export declare const BUS_NAMES: readonly ["ambience", "fire", "machine", "foley", "ui", "voice"];
export type BusName = (typeof BUS_NAMES)[number];
/** What each bus is for, surfaced in the accessibility settings UI. */
export declare const BUS_DESCRIPTIONS: Readonly<Record<BusName, string>>;
export declare const DEFAULT_BUS_VOLUMES: Readonly<Record<BusName, number>>;
export declare function isBusName(value: string): value is BusName;
/**
 * Slider position (0..1) to linear gain. A squared curve tracks perceived
 * loudness far better than a linear fader: 0.5 lands near -12 dB.
 */
export declare function volumeToGain(volume: number): number;
/** Inverse of `volumeToGain`, for restoring a slider from a stored gain. */
export declare function gainToVolume(gain: number): number;
export interface MixerSnapshot {
    master: number;
    muted: boolean;
    reducedIntensity: boolean;
    buses: Record<BusName, number>;
}
export type MixerChange = BusName | 'master' | 'mute' | 'reducedIntensity';
export type MixerListener = (change: MixerChange, state: MixerState) => void;
export declare class MixerState {
    private readonly volumes;
    private master;
    private mutedFlag;
    private reducedFlag;
    private readonly listeners;
    constructor(initial?: Partial<MixerSnapshot>);
    subscribe(listener: MixerListener): () => void;
    private emit;
    /** Returns true when the value actually changed (so callers can skip work). */
    setBusVolume(bus: BusName, volume: number): boolean;
    getBusVolume(bus: BusName): number;
    /** Linear gain for the bus's own `GainNode`. */
    busGain(bus: BusName): number;
    setMasterVolume(volume: number): boolean;
    getMasterVolume(): number;
    /** Linear gain for the master `GainNode`, mute folded in. */
    masterGain(): number;
    setMuted(muted: boolean): boolean;
    toggleMute(): boolean;
    get muted(): boolean;
    setReducedAudioIntensity(reduced: boolean): boolean;
    get reducedAudioIntensity(): boolean;
    /** Peak/attack shaping every one-shot must run its envelope through. */
    get shaping(): IntensityShaping;
    /** Total linear gain a sound on `bus` ends up with. */
    effectiveGain(bus: BusName): number;
    /** True when nothing on this bus can be heard — lets callers skip synthesis entirely. */
    isSilent(bus: BusName): boolean;
    snapshot(): MixerSnapshot;
    /** Apply a stored snapshot (e.g. from localStorage). Unknown buses are ignored. */
    restore(snapshot: Partial<MixerSnapshot>): void;
    reset(): void;
}
//# sourceMappingURL=buses.d.ts.map