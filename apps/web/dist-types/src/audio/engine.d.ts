/**
 * `AudioEngine` — the single entry point for the game.
 *
 * Lifecycle: constructing an engine touches nothing. No AudioContext exists
 * until `resume()` is called from a real user gesture, which is both what
 * browsers require and what makes the whole module importable in Node. Volumes,
 * mute, the reduced-intensity flag and the ambience profile can all be set
 * before the context exists and are applied when the graph is built.
 *
 * Graph:
 *
 *   layer -> [spatial emitter] -> bus gain -+-> master gain -> limiter -> out
 *                                           |
 *                                           +-> reverb send -> convolver ---^
 *
 * The limiter is a safety net, not a mix tool: it exists so that no combination
 * of simulation state can produce a painful peak.
 */
import type { AmbienceConditions, AmbienceProfile, AmbienceOptions } from './ambience.js';
import { NightAmbience } from './ambience.js';
import type { NoiseBankOptions } from './buffers.js';
import type { BusName, MixerSnapshot } from './buses.js';
import { MixerState } from './buses.js';
import type { AudioContextFactory } from './context.js';
import type { FireAudioState, FireBedOptions } from './fire.js';
import { FireBed } from './fire.js';
import type { FoleyOptions, SizzleState } from './foley.js';
import { FoleyKit } from './foley.js';
import { type SpaceType } from './impulse.js';
import type { MachineKitOptions } from './machine.js';
import { MachineKit } from './machine.js';
import type { ReverbOptions } from './reverb.js';
import { ReverbBus } from './reverb.js';
import type { Rng } from './rng.js';
import type { SpatialOptions, SpatialQuality, Vec3 } from './spatial.js';
import { SpatialEmitter } from './spatial.js';
export type EngineStatus = 'idle' | 'running' | 'suspended' | 'closed' | 'unsupported';
export interface AudioEngineOptions {
    /** Injected for tests, or to pin a sample rate. Defaults to the platform constructor. */
    contextFactory?: AudioContextFactory;
    sampleRate?: number;
    /** Number or string; strings are hashed. Makes a campsite sound identical everywhere. */
    seed?: number | string;
    spatialQuality?: SpatialQuality;
    /** Place the fire and the machine in 3D rather than connecting them dry to their bus. */
    spatialiseLayers?: boolean;
    ambienceProfile?: AmbienceProfile;
    reverb?: Partial<ReverbOptions>;
    mixer?: Partial<MixerSnapshot>;
    noiseBank?: Partial<NoiseBankOptions>;
    fire?: Partial<FireBedOptions>;
    ambience?: Partial<AmbienceOptions>;
    machine?: Partial<MachineKitOptions>;
    foley?: Partial<FoleyOptions>;
    /** Internal scheduling timer, in ms. 0 disables it so a host can drive `pump` itself. */
    pumpIntervalMs?: number;
}
export declare class AudioEngine {
    readonly mixer: MixerState;
    private readonly options;
    private readonly seed;
    private readonly impulses;
    private ctx;
    private rngValue;
    private bank;
    private masterGain;
    private limiter;
    private busGains;
    private reverbBus;
    private fireLayer;
    private ambienceLayer;
    private machineLayer;
    private foleyLayer;
    private fireEmitterValue;
    private machineEmitterValue;
    private readonly emitters;
    private readonly pumpables;
    private pumpTimer;
    private statusValue;
    private ambienceProfileValue;
    private unsubscribeMixer;
    constructor(options?: AudioEngineOptions);
    get status(): EngineStatus;
    get context(): AudioContext | null;
    get initialized(): boolean;
    static get supported(): boolean;
    get fire(): FireBed | null;
    get ambience(): NightAmbience | null;
    get machine(): MachineKit | null;
    get foley(): FoleyKit | null;
    get reverb(): ReverbBus | null;
    get rng(): Rng;
    /** The `GainNode` for a bus, or null before the graph exists. */
    busInput(bus: BusName): GainNode | null;
    get fireEmitter(): SpatialEmitter | null;
    get machineEmitter(): SpatialEmitter | null;
    /**
     * Create the context if needed and start (or restart) audio. Must be called
     * from a user gesture the first time. Returns false when WebAudio is
     * unavailable — the game must remain fully playable in that case.
     */
    resume(): Promise<boolean>;
    suspend(): Promise<void>;
    /** Tear everything down. The engine can be `resume()`d again afterwards. */
    close(): Promise<void>;
    private build;
    private onMixerChange;
    private applyLimiterSettings;
    setBusVolume(bus: BusName, volume: number): void;
    getBusVolume(bus: BusName): number;
    setMasterVolume(volume: number): void;
    getMasterVolume(): number;
    setMuted(muted: boolean): void;
    toggleMute(): boolean;
    get muted(): boolean;
    /**
     * Accessibility: tames sudden loud transients. Peaks are scaled, attacks are
     * stretched, and the safety limiter clamps earlier and harder.
     */
    setReducedAudioIntensity(reduced: boolean): void;
    get reducedAudioIntensity(): boolean;
    snapshot(): MixerSnapshot;
    get ambienceProfile(): Readonly<AmbienceProfile>;
    /** Swap campsite. Applies the profile's reverb space too. */
    setAmbienceProfile(profile: AmbienceProfile): void;
    setSpace(space: SpaceType, wet?: number): void;
    /** Convenience passthrough; no-op before `resume()`. */
    setFireState(state: Partial<FireAudioState>): void;
    setAmbienceConditions(conditions: Partial<AmbienceConditions>): void;
    setSizzleState(state: Partial<SizzleState>): void;
    /** Start the continuous beds. Safe to call repeatedly. */
    startBeds(): void;
    stopBeds(): void;
    /** Move the listener. `forward`/`up` need not be orthonormal. */
    listenerUpdate(position: Vec3, forward: Vec3, up: Vec3): void;
    setFirePosition(x: number, y: number, z: number): void;
    setMachinePosition(x: number, y: number, z: number): void;
    /**
     * A positioned source on `bus`. Anything can be connected to `emitter.input`,
     * including a remote player's `MediaStream` via `attachMediaStream` — which is
     * how multiplayer spatial voice will attach to this same panner path.
     */
    createEmitter(bus: BusName, options?: Partial<SpatialOptions>): SpatialEmitter | null;
    releaseEmitter(emitter: SpatialEmitter): void;
    get emitterCount(): number;
    /**
     * Drive every stochastic layer's look-ahead scheduling. Called automatically
     * on a timer; a host that prefers to own the loop can pass
     * `pumpIntervalMs: 0` and call this itself. Returns the number of events
     * scheduled across all layers.
     */
    pump(now?: number): number;
    private startPumpTimer;
    private stopPumpTimer;
}
//# sourceMappingURL=engine.d.ts.map