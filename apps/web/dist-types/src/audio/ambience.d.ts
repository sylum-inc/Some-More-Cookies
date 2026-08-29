/**
 * Night ambience.
 *
 * Layers, all synthesised:
 *
 *  - wind      : pink noise through a slowly-swept band-pass, plus a brighter
 *                "through the trees" band. A gust LFO modulates level and
 *                cutoff together, which is what makes wind read as wind rather
 *                than as noise.
 *  - water     : a distant brook or lake edge — brown noise for the body and a
 *                band-passed layer for surface detail, distance-filtered.
 *  - insects   : band-passed pulse trains. Several voices, each slightly
 *                detuned, each gated by its own Poisson process. They fall
 *                silent when it is cold, when it rains, in strong wind and when
 *                the player is loud — which is exactly what real crickets do
 *                and is a genuinely useful gameplay signal.
 *  - birds     : occasional FM calls (loon, owl, nightjar) placed far away.
 *  - room tone : a very quiet low-passed bed that stops the mix feeling dead.
 *
 * The whole thing is configured by an `AmbienceProfile`, which is plain data so
 * environment manifests can define a campsite's sound without code.
 */
import type { SpaceType } from './impulse.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
export interface WindCharacter {
    /** Base level, 0..1. */
    level: number;
    /** Depth of the gust modulation, 0..1. */
    gustiness: number;
    /** Gust LFO rate in Hz. Exposed ridges gust faster than sheltered hollows. */
    gustRateHz: number;
    /** Centre of the main wind band. */
    cutoffHz: number;
    /** 0 = wide/airy, 1 = narrow/whistling. */
    bandwidth: number;
    /** Amount of the brighter leaf-rustle band, 0..1. */
    throughTrees: number;
}
export interface InsectCharacter {
    /** 0..1; scales both the number of voices and their level. */
    density: number;
    /** Chirp carrier frequency. Field crickets sit near 4.5 kHz. */
    baseHz: number;
    /** Per-voice detune spread. */
    detuneCents: number;
    /** Pulses per second inside one chirp. */
    chirpRateHz: number;
    /** Pulses per chirp. */
    pulsesPerChirp: number;
    /** Chirps per minute per voice at full activity. */
    chirpsPerMinute: number;
    /** Below this they stop entirely. */
    minTemperatureC: number;
    /** Player loudness (0..1) at which they begin to hush. */
    loudnessThreshold: number;
}
export interface WaterCharacter {
    enabled: boolean;
    level: number;
    /** 0 = at your feet, 1 = far across the lake. Drives a low-pass. */
    distance: number;
    /** 0..1; a brook is bright, a lake edge is not. */
    brightness: number;
}
export type BirdKind = 'loon' | 'owl' | 'nightjar';
export declare const BIRD_KINDS: readonly BirdKind[];
export interface BirdCharacter {
    enabled: boolean;
    /** Calls per minute across all kinds, at full activity. */
    callsPerMinute: number;
    kinds: readonly BirdKind[];
    /** Level of a call, 0..1. These are distant by design. */
    level: number;
}
export interface RoomToneCharacter {
    level: number;
    cutoffHz: number;
}
export interface ReverbCharacter {
    space: SpaceType;
    wet: number;
}
export interface AmbienceProfile {
    id: string;
    wind: WindCharacter;
    insects: InsectCharacter;
    water: WaterCharacter;
    birds: BirdCharacter;
    roomTone: RoomToneCharacter;
    reverb: ReverbCharacter;
}
export declare const DEFAULT_AMBIENCE_PROFILE: Readonly<AmbienceProfile>;
export interface AmbienceProfileInput {
    id?: string;
    wind?: Partial<WindCharacter>;
    insects?: Partial<InsectCharacter>;
    water?: Partial<WaterCharacter>;
    birds?: Partial<BirdCharacter>;
    roomTone?: Partial<RoomToneCharacter>;
    reverb?: Partial<ReverbCharacter>;
}
/**
 * Merge a manifest fragment over a base profile and clamp everything into a
 * safe range. This is the only supported way to build a profile — a manifest
 * cannot produce a painful mix by writing `level: 40`.
 */
export declare function resolveAmbienceProfile(input?: AmbienceProfileInput, base?: AmbienceProfile): AmbienceProfile;
/** Ready-made campsites. Manifests may reference these by key and override fields. */
export declare const AMBIENCE_PRESETS: Readonly<Record<string, AmbienceProfile>>;
export interface AmbienceConditions {
    temperatureC: number;
    /** How loud the player is being, 0..1 (shouting, chopping, machinery nearby). */
    playerLoudness: number;
    /** Weather wind, 0..1. Scales the wind layer over the profile's base level. */
    windSpeed: number;
    /** 0..1 across 24 h, 0 = midnight. */
    timeOfDay: number;
    /** Rain / dew, 0..1. */
    wetness: number;
}
export declare const DEFAULT_AMBIENCE_CONDITIONS: Readonly<AmbienceConditions>;
/**
 * 1 deep at night, 0 in the middle of the day, with dusk/dawn ramps.
 * `timeOfDay` is 0..1 with 0 at midnight.
 */
export declare function nightFactor(timeOfDay: number): number;
/**
 * Insect chorus level, 0..1. Zero means "do not synthesise at all".
 *
 * Crickets stridulate faster and louder when warm, stop when cold, are drowned
 * by wind and rain, and — the gameplay-relevant part — go quiet when something
 * loud happens nearby, resuming a beat later.
 */
export declare function insectActivity(profile: AmbienceProfile, conditions: AmbienceConditions): number;
/** Bird calls per second. */
export declare function birdCallRate(profile: AmbienceProfile, conditions: AmbienceConditions): number;
/** Wind bed level, 0..1, combining the campsite's character with the weather. */
export declare function windLevel(profile: AmbienceProfile, conditions: AmbienceConditions): number;
/** Wind band centre in Hz — a stronger wind whistles higher. */
export declare function windCutoff(profile: AmbienceProfile, conditions: AmbienceConditions): number;
export interface BirdCallSpec {
    /** Carrier frequency envelope, in Hz. */
    startHz: number;
    peakHz: number;
    endHz: number;
    durationSeconds: number;
    /** FM modulator ratio and index. */
    modRatio: number;
    modIndex: number;
    vibratoHz: number;
    vibratoCents: number;
    /** Number of repeats and the gap between them. */
    repeats: number;
    gapSeconds: number;
    /** Band-pass placed after the call to sit it in the distance. */
    filterHz: number;
    peak: number;
}
export declare const BIRD_SPECS: Readonly<Record<BirdKind, BirdCallSpec>>;
export interface AmbienceOptions {
    /** Maximum simultaneous insect voices at density 1. */
    maxInsectVoices: number;
    lookaheadSeconds: number;
    smoothingSeconds: number;
}
export declare const DEFAULT_AMBIENCE_OPTIONS: Readonly<AmbienceOptions>;
/** How many insect voices a given activity level should run. */
export declare function insectVoiceCount(activity: number, maxVoices: number): number;
export declare class NightAmbience implements PumpableLayer {
    private readonly deps;
    private readonly options;
    private profileValue;
    private readonly conditionsValue;
    private readonly output;
    private readonly windGain;
    private readonly windFilter;
    private readonly leafGain;
    private readonly leafFilter;
    private readonly gustLfo;
    private readonly gustLevelDepth;
    private readonly gustCutoffDepth;
    private readonly waterGain;
    private readonly waterFilter;
    private readonly waterDetailGain;
    private readonly waterDetailFilter;
    private readonly roomToneGain;
    private readonly roomToneFilter;
    private readonly insectBus;
    private readonly insectVoices;
    private readonly birdBus;
    private readonly birdScheduler;
    private readonly window;
    private readonly eventTimes;
    private readonly sources;
    private activityValue;
    private activeInsectVoices;
    private started;
    private disposed;
    private callsScheduled;
    constructor(deps: LayerDeps, profile?: AmbienceProfile, options?: Partial<AmbienceOptions>);
    private buildInsectVoice;
    get profile(): Readonly<AmbienceProfile>;
    get conditions(): Readonly<AmbienceConditions>;
    /** Current insect chorus level, 0..1. Zero means fully silent. */
    get insectActivityLevel(): number;
    get insectVoicesActive(): number;
    get birdCallsScheduled(): number;
    get running(): boolean;
    private startLoop;
    start(): void;
    stop(fadeSeconds?: number): void;
    /** Swap campsite character. Continuous layers glide; nothing restarts. */
    setProfile(profile: AmbienceProfile): void;
    /** Hot path. Allocation-free partial update. */
    setConditions(next: Partial<AmbienceConditions>): void;
    private applyProfile;
    private applyConditions;
    pump(now: number): number;
    /**
     * One cricket chirp: a band-passed pulse train. The oscillator is a triangle
     * (odd harmonics, dry and insect-like); the gain envelope is `pulsesPerChirp`
     * fast blips at `chirpRateHz`.
     */
    private spawnChirp;
    /**
     * A distant bird call: a two-operator FM pair with a swept carrier, followed
     * by a band-pass. Cheap, and far more evocative than a filtered noise burst.
     */
    private spawnBirdCall;
    dispose(): void;
}
//# sourceMappingURL=ambience.d.ts.map