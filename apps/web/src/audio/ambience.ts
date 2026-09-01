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

import { clamp, clamp01, lerp, mapExp, smoothstep } from './math.js';
import { safeFrequency } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { SpaceType } from './impulse.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import { LookaheadWindow, PoissonScheduler } from './voices.js';

/* -------------------------------------------------------------------------- */
/* Profile                                                                     */
/* -------------------------------------------------------------------------- */

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

export const BIRD_KINDS: readonly BirdKind[] = ['loon', 'owl', 'nightjar'];

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

export const DEFAULT_AMBIENCE_PROFILE: Readonly<AmbienceProfile> = Object.freeze<AmbienceProfile>({
  id: 'default',
  wind: { level: 0.32, gustiness: 0.5, gustRateHz: 0.08, cutoffHz: 480, bandwidth: 0.35, throughTrees: 0.4 },
  insects: {
    density: 0.55,
    baseHz: 4500,
    detuneCents: 45,
    chirpRateHz: 22,
    pulsesPerChirp: 4,
    chirpsPerMinute: 42,
    minTemperatureC: 9,
    loudnessThreshold: 0.45,
  },
  water: { enabled: false, level: 0.25, distance: 0.6, brightness: 0.4 },
  birds: { enabled: true, callsPerMinute: 1.6, kinds: BIRD_KINDS, level: 0.22 },
  roomTone: { level: 0.05, cutoffHz: 260 },
  reverb: { space: 'openForest', wet: 0.35 },
});

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
export function resolveAmbienceProfile(
  input: AmbienceProfileInput = {},
  base: AmbienceProfile = DEFAULT_AMBIENCE_PROFILE,
): AmbienceProfile {
  const wind = { ...base.wind, ...input.wind };
  const insects = { ...base.insects, ...input.insects };
  const water = { ...base.water, ...input.water };
  const birds = { ...base.birds, ...input.birds };
  const roomTone = { ...base.roomTone, ...input.roomTone };
  const reverb = { ...base.reverb, ...input.reverb };

  return {
    id: input.id ?? base.id,
    wind: {
      level: clamp01(wind.level),
      gustiness: clamp01(wind.gustiness),
      gustRateHz: clamp(wind.gustRateHz, 0.005, 2),
      cutoffHz: safeFrequency(wind.cutoffHz),
      bandwidth: clamp01(wind.bandwidth),
      throughTrees: clamp01(wind.throughTrees),
    },
    insects: {
      density: clamp01(insects.density),
      baseHz: safeFrequency(insects.baseHz),
      detuneCents: clamp(insects.detuneCents, 0, 600),
      chirpRateHz: clamp(insects.chirpRateHz, 1, 80),
      pulsesPerChirp: Math.round(clamp(insects.pulsesPerChirp, 1, 16)),
      chirpsPerMinute: clamp(insects.chirpsPerMinute, 0, 600),
      minTemperatureC: clamp(insects.minTemperatureC, -40, 40),
      loudnessThreshold: clamp01(insects.loudnessThreshold),
    },
    water: {
      enabled: water.enabled === true,
      level: clamp01(water.level),
      distance: clamp01(water.distance),
      brightness: clamp01(water.brightness),
    },
    birds: {
      enabled: birds.enabled === true,
      callsPerMinute: clamp(birds.callsPerMinute, 0, 60),
      kinds: birds.kinds.length > 0 ? [...birds.kinds] : BIRD_KINDS,
      level: clamp01(birds.level),
    },
    roomTone: { level: clamp01(roomTone.level), cutoffHz: safeFrequency(roomTone.cutoffHz) },
    reverb: { space: reverb.space, wet: clamp01(reverb.wet) },
  };
}

/**
 * A campsite's own soundscape, as the catalogue describes it.
 *
 * Structural rather than an import of `@somemore/content`, so the audio layer
 * keeps knowing nothing about the content package.
 */
export interface CampsiteAmbienceSpec {
  readonly wind: {
    readonly character: string;
    readonly baseLevel: number;
    readonly gustiness: number;
    /** What the wind is moving *through* — needles, grass, tin, nothing. */
    readonly material: string;
  };
  readonly insectDensity: number;
  readonly waterPresence: number;
  readonly reverb: string;
  /** Approximate dBFS of the quiet floor. Silence is used deliberately (§2.3). */
  readonly nightFloorDb: number;
}

/** How each wind character behaves, beyond its level and its gustiness. */
const WIND_CHARACTER: Record<string, { gustRateHz: number; cutoffHz: number; bandwidth: number }> = {
  still: { gustRateHz: 0.02, cutoffHz: 300, bandwidth: 0.2 },
  breathing: { gustRateHz: 0.05, cutoffHz: 420, bandwidth: 0.3 },
  steady: { gustRateHz: 0.03, cutoffHz: 520, bandwidth: 0.42 },
  gusting: { gustRateHz: 0.16, cutoffHz: 620, bandwidth: 0.5 },
  onshore: { gustRateHz: 0.07, cutoffHz: 340, bandwidth: 0.55 },
  channelled: { gustRateHz: 0.1, cutoffHz: 760, bandwidth: 0.3 },
  katabatic: { gustRateHz: 0.04, cutoffHz: 260, bandwidth: 0.6 },
  buffeting: { gustRateHz: 0.26, cutoffHz: 700, bandwidth: 0.58 },
};

/**
 * How much of the wind you hear is the wind *in something*.
 *
 * The manifests describe the material in prose — "pine needles, thirty feet
 * up", "dry grass and the tarp", "bare rock, nothing to catch it" — because it
 * is written for a person. This reads the nouns out of it, and a site whose
 * wind moves through nothing sounds like wind moving through nothing.
 */
function throughTreesFor(material: string): number {
  const text = material.toLowerCase();
  if (/needle|pine|fir|spruce|conifer|canopy|crown/.test(text)) return 0.72;
  if (/leaf|leaves|aspen|birch|willow|cottonwood/.test(text)) return 0.58;
  if (/grass|sedge|reed|bracken|scrub|brush/.test(text)) return 0.34;
  if (/tarp|canvas|tin|metal|wire|line/.test(text)) return 0.2;
  if (/rock|stone|sand|snow|ice|nothing|bare/.test(text)) return 0.08;
  return 0.4;
}

/** Reverb wetness per space. A snowfield eats sound; a canyon hands it back. */
const REVERB_WET: Record<string, number> = {
  openForest: 0.35,
  clearing: 0.3,
  canyon: 0.52,
  snowfield: 0.18,
  indoorSmall: 0.44,
};

function isSpaceType(value: string): value is SpaceType {
  return value in REVERB_WET;
}

/**
 * Turns a campsite's written soundscape into a mix.
 *
 * Every environment in the catalogue has had one of these since the content
 * was authored — a wind character and what it moves through, an insect
 * density, how much of the bed is moving water, the reverb space, and the
 * level of the quiet floor. The audio bridge used a single hardcoded preset
 * for all of them, so twelve campsites written to sound completely different
 * from one another sounded like one campsite.
 */
export function ambienceFromCampsite(id: string, spec: CampsiteAmbienceSpec): AmbienceProfile {
  const character = WIND_CHARACTER[spec.wind.character] ?? WIND_CHARACTER['breathing']!;
  const water = clamp01(spec.waterPresence);
  const insects = clamp01(spec.insectDensity);
  // dBFS to a linear room-tone level, floored so "silent" is still a floor
  // and not an absence — §2.3 uses silence deliberately, which means it has
  // to be a chosen quietness rather than nothing at all.
  const floor = clamp(Math.pow(10, clamp(spec.nightFloorDb, -80, -20) / 20) * 2.2, 0.004, 0.12);

  return resolveAmbienceProfile({
    id,
    wind: {
      level: clamp01(spec.wind.baseLevel),
      gustiness: clamp01(spec.wind.gustiness),
      gustRateHz: character.gustRateHz,
      cutoffHz: character.cutoffHz,
      bandwidth: character.bandwidth,
      throughTrees: throughTreesFor(spec.wind.material),
    },
    insects: {
      density: insects,
      // A dense chorus is not merely louder, it is busier.
      chirpsPerMinute: 18 + insects * 62,
    },
    water: {
      enabled: water > 0.02,
      level: water * 0.6,
      // A lot of water is close water.
      distance: clamp01(0.8 - water * 0.5),
      brightness: clamp01(0.25 + water * 0.35),
    },
    roomTone: { level: floor },
    ...(isSpaceType(spec.reverb) ? { reverb: { space: spec.reverb, wet: REVERB_WET[spec.reverb]! } } : {}),
  });
}

/** Ready-made campsites. Manifests may reference these by key and override fields. */
export const AMBIENCE_PRESETS: Readonly<Record<string, AmbienceProfile>> = Object.freeze({
  lakeside: resolveAmbienceProfile({
    id: 'lakeside',
    wind: { level: 0.36, gustiness: 0.42, gustRateHz: 0.06, cutoffHz: 380, throughTrees: 0.25 },
    water: { enabled: true, level: 0.34, distance: 0.45, brightness: 0.3 },
    insects: { density: 0.7, chirpsPerMinute: 52 },
    birds: { enabled: true, callsPerMinute: 2.2, kinds: ['loon', 'owl'], level: 0.26 },
    reverb: { space: 'clearing', wet: 0.32 },
  }),
  pineRidge: resolveAmbienceProfile({
    id: 'pineRidge',
    wind: { level: 0.52, gustiness: 0.75, gustRateHz: 0.13, cutoffHz: 620, bandwidth: 0.5, throughTrees: 0.8 },
    insects: { density: 0.3, chirpsPerMinute: 26 },
    birds: { enabled: true, callsPerMinute: 1.1, kinds: ['owl', 'nightjar'], level: 0.2 },
    reverb: { space: 'openForest', wet: 0.4 },
  }),
  canyonMouth: resolveAmbienceProfile({
    id: 'canyonMouth',
    wind: { level: 0.6, gustiness: 0.85, gustRateHz: 0.09, cutoffHz: 850, bandwidth: 0.72, throughTrees: 0.1 },
    insects: { density: 0.18, baseHz: 5200, chirpsPerMinute: 18 },
    birds: { enabled: true, callsPerMinute: 0.7, kinds: ['owl'], level: 0.24 },
    reverb: { space: 'canyon', wet: 0.5 },
  }),
  winterHollow: resolveAmbienceProfile({
    id: 'winterHollow',
    wind: { level: 0.28, gustiness: 0.6, gustRateHz: 0.05, cutoffHz: 300, throughTrees: 0.12 },
    // Nothing chirps below freezing; `insectActivity` returns 0 and the layer
    // stays genuinely silent rather than being faded out.
    insects: { density: 0.2, minTemperatureC: 6 },
    birds: { enabled: true, callsPerMinute: 0.4, kinds: ['owl'], level: 0.18 },
    roomTone: { level: 0.03, cutoffHz: 180 },
    reverb: { space: 'snowfield', wet: 0.22 },
  }),
});

/* -------------------------------------------------------------------------- */
/* Conditions and the pure activity curves                                     */
/* -------------------------------------------------------------------------- */

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

export const DEFAULT_AMBIENCE_CONDITIONS: Readonly<AmbienceConditions> = Object.freeze({
  temperatureC: 14,
  playerLoudness: 0,
  windSpeed: 0.3,
  timeOfDay: 0.05,
  wetness: 0,
});

/**
 * 1 deep at night, 0 in the middle of the day, with dusk/dawn ramps.
 * `timeOfDay` is 0..1 with 0 at midnight.
 */
export function nightFactor(timeOfDay: number): number {
  const t = timeOfDay - Math.floor(timeOfDay);
  const dawn = smoothstep(0.22, 0.34, t); // fading out through sunrise
  const dusk = smoothstep(0.72, 0.86, t); // fading back in at sunset
  return clamp01(1 - dawn + dusk);
}

/**
 * Insect chorus level, 0..1. Zero means "do not synthesise at all".
 *
 * Crickets stridulate faster and louder when warm, stop when cold, are drowned
 * by wind and rain, and — the gameplay-relevant part — go quiet when something
 * loud happens nearby, resuming a beat later.
 */
export function insectActivity(profile: AmbienceProfile, conditions: AmbienceConditions): number {
  const insects = profile.insects;
  if (insects.density <= 0) return 0;
  const warmth = smoothstep(insects.minTemperatureC, insects.minTemperatureC + 7, conditions.temperatureC);
  if (warmth <= 0) return 0;
  const quiet = 1 - smoothstep(insects.loudnessThreshold, insects.loudnessThreshold + 0.25, conditions.playerLoudness);
  const calm = 1 - 0.75 * smoothstep(0.45, 1, conditions.windSpeed);
  const dry = 1 - 0.65 * clamp01(conditions.wetness);
  const night = lerp(0.25, 1, nightFactor(conditions.timeOfDay));
  return clamp01(insects.density * warmth * quiet * calm * dry * night);
}

/** Bird calls per second. */
export function birdCallRate(profile: AmbienceProfile, conditions: AmbienceConditions): number {
  const birds = profile.birds;
  if (!birds.enabled || birds.callsPerMinute <= 0 || birds.kinds.length === 0) return 0;
  const night = lerp(0.35, 1, nightFactor(conditions.timeOfDay));
  const calm = 1 - 0.6 * smoothstep(0.55, 1, conditions.windSpeed);
  const quiet = 1 - smoothstep(0.6, 0.95, conditions.playerLoudness);
  return Math.max(0, (birds.callsPerMinute / 60) * night * calm * quiet);
}

/** Wind bed level, 0..1, combining the campsite's character with the weather. */
export function windLevel(profile: AmbienceProfile, conditions: AmbienceConditions): number {
  return clamp01(profile.wind.level * lerp(0.35, 1.6, clamp01(conditions.windSpeed)));
}

/** Wind band centre in Hz — a stronger wind whistles higher. */
export function windCutoff(profile: AmbienceProfile, conditions: AmbienceConditions): number {
  return safeFrequency(profile.wind.cutoffHz * lerp(0.7, 1.9, clamp01(conditions.windSpeed)));
}

/* -------------------------------------------------------------------------- */
/* Bird call synthesis specs (pure data)                                       */
/* -------------------------------------------------------------------------- */

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

export const BIRD_SPECS: Readonly<Record<BirdKind, BirdCallSpec>> = Object.freeze({
  // The classic wail: a rising, wavering glide that falls away at the end.
  loon: {
    startHz: 380,
    peakHz: 640,
    endHz: 300,
    durationSeconds: 1.6,
    modRatio: 2.01,
    modIndex: 55,
    vibratoHz: 5.5,
    vibratoCents: 35,
    repeats: 1,
    gapSeconds: 0,
    filterHz: 1400,
    peak: 0.5,
  },
  // Two soft, almost sine-pure hoots.
  owl: {
    startHz: 330,
    peakHz: 300,
    endHz: 270,
    durationSeconds: 0.42,
    modRatio: 1,
    modIndex: 12,
    vibratoHz: 0,
    vibratoCents: 0,
    repeats: 2,
    gapSeconds: 0.55,
    filterHz: 900,
    peak: 0.45,
  },
  // A dry mechanical trill, high and buzzy.
  nightjar: {
    startHz: 1450,
    peakHz: 1520,
    endHz: 1380,
    durationSeconds: 1.1,
    modRatio: 0.02,
    modIndex: 420,
    vibratoHz: 0,
    vibratoCents: 0,
    repeats: 1,
    gapSeconds: 0,
    filterHz: 2600,
    peak: 0.3,
  },
});

/* -------------------------------------------------------------------------- */
/* Audio layer                                                                 */
/* -------------------------------------------------------------------------- */

export interface AmbienceOptions {
  /** Maximum simultaneous insect voices at density 1. */
  maxInsectVoices: number;
  lookaheadSeconds: number;
  smoothingSeconds: number;
}

export const DEFAULT_AMBIENCE_OPTIONS: Readonly<AmbienceOptions> = Object.freeze({
  maxInsectVoices: 5,
  lookaheadSeconds: 0.5,
  smoothingSeconds: 0.6,
});

/** How many insect voices a given activity level should run. */
export function insectVoiceCount(activity: number, maxVoices: number): number {
  if (activity <= 0) return 0;
  return Math.max(1, Math.round(clamp01(activity) * Math.max(1, maxVoices)));
}

interface InsectVoice {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  readonly pan: StereoPannerNode | null;
  readonly scheduler: PoissonScheduler;
  detuneCents: number;
  busyUntil: number;
}

export class NightAmbience implements PumpableLayer {
  private readonly options: AmbienceOptions;
  private profileValue: AmbienceProfile;
  private readonly conditionsValue: AmbienceConditions = { ...DEFAULT_AMBIENCE_CONDITIONS };

  private readonly output: GainNode;
  private readonly windGain: GainNode;
  private readonly windFilter: BiquadFilterNode;
  private readonly leafGain: GainNode;
  private readonly leafFilter: BiquadFilterNode;
  private readonly gustLfo: OscillatorNode;
  private readonly gustLevelDepth: GainNode;
  private readonly gustCutoffDepth: GainNode;
  private readonly waterGain: GainNode;
  private readonly waterFilter: BiquadFilterNode;
  private readonly waterDetailGain: GainNode;
  private readonly waterDetailFilter: BiquadFilterNode;
  private readonly roomToneGain: GainNode;
  private readonly roomToneFilter: BiquadFilterNode;
  private readonly insectBus: GainNode;
  private readonly insectVoices: InsectVoice[] = [];
  private readonly birdBus: GainNode;
  private readonly birdScheduler: PoissonScheduler;
  private readonly window: LookaheadWindow;
  private readonly eventTimes = new Float64Array(8);
  private readonly sources: AudioBufferSourceNode[] = [];

  private activityValue = 0;
  private activeInsectVoices = 0;
  private started = false;
  private disposed = false;
  private callsScheduled = 0;

  constructor(
    private readonly deps: LayerDeps,
    profile: AmbienceProfile = DEFAULT_AMBIENCE_PROFILE,
    options: Partial<AmbienceOptions> = {},
  ) {
    this.options = { ...DEFAULT_AMBIENCE_OPTIONS, ...options };
    this.profileValue = profile;
    const ctx = deps.ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);

    // --- wind -------------------------------------------------------------
    this.windFilter = ctx.createBiquadFilter();
    this.windFilter.type = 'bandpass';
    this.windFilter.frequency.value = profile.wind.cutoffHz;
    this.windFilter.Q.value = lerp(0.35, 3.5, profile.wind.bandwidth);
    this.windGain = ctx.createGain();
    this.windGain.gain.value = 0;
    this.windFilter.connect(this.windGain);
    this.windGain.connect(this.output);

    this.leafFilter = ctx.createBiquadFilter();
    this.leafFilter.type = 'bandpass';
    this.leafFilter.frequency.value = 3200;
    this.leafFilter.Q.value = 0.8;
    this.leafGain = ctx.createGain();
    this.leafGain.gain.value = 0;
    this.leafFilter.connect(this.leafGain);
    this.leafGain.connect(this.output);

    this.gustLfo = ctx.createOscillator();
    this.gustLfo.type = 'sine';
    this.gustLfo.frequency.value = profile.wind.gustRateHz;
    this.gustLevelDepth = ctx.createGain();
    this.gustLevelDepth.gain.value = 0;
    this.gustCutoffDepth = ctx.createGain();
    this.gustCutoffDepth.gain.value = 0;
    this.gustLfo.connect(this.gustLevelDepth);
    this.gustLfo.connect(this.gustCutoffDepth);
    this.gustLevelDepth.connect(this.windGain.gain);
    this.gustLevelDepth.connect(this.leafGain.gain);
    this.gustCutoffDepth.connect(this.windFilter.frequency);

    // --- water ------------------------------------------------------------
    this.waterFilter = ctx.createBiquadFilter();
    this.waterFilter.type = 'lowpass';
    this.waterFilter.frequency.value = 900;
    this.waterFilter.Q.value = 0.7;
    this.waterGain = ctx.createGain();
    this.waterGain.gain.value = 0;
    this.waterFilter.connect(this.waterGain);
    this.waterGain.connect(this.output);

    this.waterDetailFilter = ctx.createBiquadFilter();
    this.waterDetailFilter.type = 'bandpass';
    this.waterDetailFilter.frequency.value = 2200;
    this.waterDetailFilter.Q.value = 1.1;
    this.waterDetailGain = ctx.createGain();
    this.waterDetailGain.gain.value = 0;
    this.waterDetailFilter.connect(this.waterDetailGain);
    this.waterDetailGain.connect(this.output);

    // --- room tone --------------------------------------------------------
    this.roomToneFilter = ctx.createBiquadFilter();
    this.roomToneFilter.type = 'lowpass';
    this.roomToneFilter.frequency.value = profile.roomTone.cutoffHz;
    this.roomToneGain = ctx.createGain();
    this.roomToneGain.gain.value = 0;
    this.roomToneFilter.connect(this.roomToneGain);
    this.roomToneGain.connect(this.output);

    // --- insects / birds --------------------------------------------------
    this.insectBus = ctx.createGain();
    this.insectBus.gain.value = 0;
    this.insectBus.connect(this.output);
    for (let i = 0; i < this.options.maxInsectVoices; i += 1) {
      this.insectVoices.push(this.buildInsectVoice(i));
    }

    this.birdBus = ctx.createGain();
    this.birdBus.gain.value = 0;
    this.birdBus.connect(this.output);
    this.birdScheduler = new PoissonScheduler(deps.rng);

    this.window = new LookaheadWindow(this.options.lookaheadSeconds);
  }

  private buildInsectVoice(index: number): InsectVoice {
    const ctx = this.deps.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = this.profileValue.insects.baseHz;
    filter.Q.value = 12;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);

    const factory = ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode };
    let pan: StereoPannerNode | null = null;
    if (typeof factory.createStereoPanner === 'function') {
      pan = factory.createStereoPanner();
      // Spread the chorus across the field deterministically.
      pan.pan.value = this.options.maxInsectVoices <= 1 ? 0 : (index / (this.options.maxInsectVoices - 1)) * 1.5 - 0.75;
      gain.connect(pan);
      pan.connect(this.insectBus);
    } else {
      gain.connect(this.insectBus);
    }

    return {
      gain,
      filter,
      pan,
      scheduler: new PoissonScheduler(this.deps.rng),
      detuneCents: (this.deps.rng.next() * 2 - 1) * this.profileValue.insects.detuneCents,
      busyUntil: 0,
    };
  }

  get profile(): Readonly<AmbienceProfile> {
    return this.profileValue;
  }

  get conditions(): Readonly<AmbienceConditions> {
    return this.conditionsValue;
  }

  /** Current insect chorus level, 0..1. Zero means fully silent. */
  get insectActivityLevel(): number {
    return this.activityValue;
  }

  get insectVoicesActive(): number {
    return this.activeInsectVoices;
  }

  get birdCallsScheduled(): number {
    return this.callsScheduled;
  }

  get running(): boolean {
    return this.started;
  }

  private startLoop(buffer: AudioBuffer, target: AudioNode, loopEnd: number, rate: number, when: number): void {
    const source = this.deps.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = loopEnd;
    source.playbackRate.value = rate;
    source.connect(target);
    source.start(when, this.deps.rng.range(0, Math.max(loopEnd - 0.01, 0.01)));
    this.sources.push(source);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const bank = this.deps.bank;
    const now = this.deps.ctx.currentTime;

    this.startLoop(bank.loop('pink'), this.windFilter, bank.loopEnd('pink'), 1, now);
    this.startLoop(bank.loop('white'), this.leafFilter, bank.loopEnd('white'), 1, now);
    this.startLoop(bank.loop('brown'), this.waterFilter, bank.loopEnd('brown'), 1.1, now);
    this.startLoop(bank.loop('pink'), this.waterDetailFilter, bank.loopEnd('pink'), 0.9, now);
    this.startLoop(bank.loop('brown'), this.roomToneFilter, bank.loopEnd('brown'), 0.7, now);
    this.gustLfo.start(now);

    this.window.reset(now);
    this.applyProfile();
    this.applyConditions();
  }

  stop(fadeSeconds = 1): void {
    if (!this.started) return;
    this.started = false;
    const now = this.deps.ctx.currentTime;
    const end = now + Math.max(fadeSeconds, 0.01);
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(0, end);
    for (let i = 0; i < this.sources.length; i += 1) safeStop(this.sources[i], end);
    this.sources.length = 0;
    safeStop(this.gustLfo, end);
    this.birdScheduler.setRate(0, now);
    for (let i = 0; i < this.insectVoices.length; i += 1) {
      this.insectVoices[i]?.scheduler.setRate(0, now);
    }
  }

  /** Swap campsite character. Continuous layers glide; nothing restarts. */
  setProfile(profile: AmbienceProfile): void {
    this.profileValue = profile;
    for (let i = 0; i < this.insectVoices.length; i += 1) {
      const voice = this.insectVoices[i];
      if (voice) voice.detuneCents = (this.deps.rng.next() * 2 - 1) * profile.insects.detuneCents;
    }
    this.applyProfile();
    this.applyConditions();
  }

  /** Hot path. Allocation-free partial update. */
  setConditions(next: Partial<AmbienceConditions>): void {
    if (next.temperatureC !== undefined) this.conditionsValue.temperatureC = next.temperatureC;
    if (next.playerLoudness !== undefined) this.conditionsValue.playerLoudness = clamp01(next.playerLoudness);
    if (next.windSpeed !== undefined) this.conditionsValue.windSpeed = clamp01(next.windSpeed);
    if (next.timeOfDay !== undefined) this.conditionsValue.timeOfDay = next.timeOfDay;
    if (next.wetness !== undefined) this.conditionsValue.wetness = clamp01(next.wetness);
    this.applyConditions();
  }

  private applyProfile(): void {
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const p = this.profileValue;
    this.windFilter.Q.setTargetAtTime(lerp(0.35, 3.5, p.wind.bandwidth), now, 0.4);
    this.gustLfo.frequency.setTargetAtTime(p.wind.gustRateHz, now, 1);
    this.roomToneFilter.frequency.setTargetAtTime(p.roomTone.cutoffHz, now, 0.5);
    this.roomToneGain.gain.setTargetAtTime(p.roomTone.level, now, 0.5);
    for (let i = 0; i < this.insectVoices.length; i += 1) {
      const voice = this.insectVoices[i];
      if (!voice) continue;
      voice.filter.frequency.setTargetAtTime(safeFrequency(p.insects.baseHz, ctx.sampleRate), now, 0.3);
    }
  }

  private applyConditions(): void {
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const tc = this.options.smoothingSeconds;
    const p = this.profileValue;
    const c = this.conditionsValue;

    const level = windLevel(p, c);
    const cutoff = windCutoff(p, c);
    this.windGain.gain.setTargetAtTime(level * 0.6, now, tc);
    this.windFilter.frequency.setTargetAtTime(cutoff, now, tc);
    this.leafGain.gain.setTargetAtTime(level * p.wind.throughTrees * 0.35, now, tc);
    this.leafFilter.frequency.setTargetAtTime(safeFrequency(2600 + 2200 * clamp01(c.windSpeed), ctx.sampleRate), now, tc);

    // Gusts scale with both the campsite's gustiness and the current wind.
    const gustDepth = p.wind.gustiness * level * 0.45;
    this.gustLevelDepth.gain.setTargetAtTime(gustDepth * 0.6, now, tc);
    this.gustCutoffDepth.gain.setTargetAtTime(cutoff * 0.5 * p.wind.gustiness, now, tc);

    if (p.water.enabled) {
      const near = 1 - p.water.distance;
      this.waterGain.gain.setTargetAtTime(p.water.level * 0.5, now, tc);
      this.waterFilter.frequency.setTargetAtTime(safeFrequency(mapExp(near, 320, 1800), ctx.sampleRate), now, tc);
      this.waterDetailGain.gain.setTargetAtTime(p.water.level * p.water.brightness * near * 0.28, now, tc);
      this.waterDetailFilter.frequency.setTargetAtTime(safeFrequency(mapExp(p.water.brightness, 1200, 4200), ctx.sampleRate), now, tc);
    } else {
      this.waterGain.gain.setTargetAtTime(0, now, tc);
      this.waterDetailGain.gain.setTargetAtTime(0, now, tc);
    }

    this.activityValue = insectActivity(p, c);
    this.activeInsectVoices = insectVoiceCount(this.activityValue, this.options.maxInsectVoices);
    this.insectBus.gain.setTargetAtTime(this.activityValue * 0.18, now, 0.35);
    const perVoiceRate = (p.insects.chirpsPerMinute / 60) * (this.activityValue > 0 ? 1 : 0);
    for (let i = 0; i < this.insectVoices.length; i += 1) {
      const voice = this.insectVoices[i];
      if (!voice) continue;
      voice.scheduler.setRate(i < this.activeInsectVoices ? perVoiceRate : 0, now);
    }

    const birdRate = birdCallRate(p, c);
    this.birdBus.gain.setTargetAtTime(p.birds.level, now, 0.5);
    this.birdScheduler.setRate(birdRate, now);
  }

  pump(now: number): number {
    if (!this.started || this.disposed) return 0;
    const horizon = this.window.advance(now);
    if (horizon === null) return 0;

    let scheduled = 0;
    for (let v = 0; v < this.insectVoices.length; v += 1) {
      const voice = this.insectVoices[v];
      if (!voice) continue;
      const count = voice.scheduler.collect(horizon, this.eventTimes);
      for (let i = 0; i < count; i += 1) {
        this.spawnChirp(voice, this.eventTimes[i] ?? now);
      }
      scheduled += count;
    }

    const birds = this.birdScheduler.collect(horizon, this.eventTimes);
    for (let i = 0; i < birds; i += 1) {
      this.spawnBirdCall(this.eventTimes[i] ?? now);
    }
    this.callsScheduled += birds;
    return scheduled + birds;
  }

  /**
   * One cricket chirp: a band-passed pulse train. The oscillator is a triangle
   * (odd harmonics, dry and insect-like); the gain envelope is `pulsesPerChirp`
   * fast blips at `chirpRateHz`.
   */
  private spawnChirp(voice: InsectVoice, time: number): void {
    if (time < voice.busyUntil) return;
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const insects = this.profileValue.insects;

    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = safeFrequency(insects.baseHz, ctx.sampleRate);
    osc.detune.value = voice.detuneCents + rng.range(-12, 12);
    osc.connect(voice.filter);

    const pulses = insects.pulsesPerChirp;
    const period = 1 / Math.max(insects.chirpRateHz, 1);
    const pulseLength = period * 0.55;
    const shaping = this.deps.mixer.shaping;
    const peak = Math.min(0.6 * shaping.peakScale, shaping.ceiling);
    const param = voice.gain.gain;

    param.cancelScheduledValues(time);
    param.setValueAtTime(0, time);
    for (let i = 0; i < pulses; i += 1) {
      const start = time + i * period;
      param.setValueAtTime(0, start);
      param.linearRampToValueAtTime(peak * rng.range(0.7, 1), start + pulseLength * 0.25);
      param.linearRampToValueAtTime(0, start + pulseLength);
    }
    const end = time + pulses * period;
    param.setValueAtTime(0, end);

    osc.start(time);
    osc.stop(end + 0.02);
    voice.busyUntil = end;
  }

  /**
   * A distant bird call: a two-operator FM pair with a swept carrier, followed
   * by a band-pass. Cheap, and far more evocative than a filtered noise burst.
   */
  private spawnBirdCall(time: number): void {
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const kinds = this.profileValue.birds.kinds;
    const kind = rng.pick(kinds, 'owl');
    const spec = BIRD_SPECS[kind];
    const shaping = this.deps.mixer.shaping;

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = safeFrequency(spec.filterHz * rng.range(0.9, 1.1), ctx.sampleRate);
    filter.Q.value = 1.2;
    const out = ctx.createGain();
    out.gain.value = 1;
    filter.connect(out);
    out.connect(this.birdBus);

    const detune = rng.range(-60, 60);
    let cursor = time;
    for (let r = 0; r < spec.repeats; r += 1) {
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.detune.value = detune;
      const amp = ctx.createGain();
      amp.gain.value = 0;
      carrier.connect(amp);
      amp.connect(filter);

      const modulator = ctx.createOscillator();
      modulator.type = 'sine';
      modulator.frequency.value = safeFrequency(spec.startHz * spec.modRatio, ctx.sampleRate);
      const modDepth = ctx.createGain();
      modDepth.gain.value = spec.modIndex;
      modulator.connect(modDepth);
      modDepth.connect(carrier.frequency);

      const dur = spec.durationSeconds;
      const f = carrier.frequency;
      f.setValueAtTime(spec.startHz, cursor);
      f.linearRampToValueAtTime(spec.peakHz, cursor + dur * 0.35);
      f.linearRampToValueAtTime(spec.endHz, cursor + dur);

      const peak = Math.min(spec.peak * shaping.peakScale * rng.range(0.75, 1), shaping.ceiling);
      amp.gain.setValueAtTime(0, cursor);
      amp.gain.linearRampToValueAtTime(peak, cursor + dur * 0.18 * shaping.attackScale);
      amp.gain.setTargetAtTime(0, cursor + dur * 0.5, dur * 0.28);
      amp.gain.setValueAtTime(0, cursor + dur + 0.15);

      carrier.start(cursor);
      carrier.stop(cursor + dur + 0.2);
      modulator.start(cursor);
      modulator.stop(cursor + dur + 0.2);
      cursor += dur + spec.gapSeconds;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(0.05);
    this.disposed = true;
    for (let i = 0; i < this.insectVoices.length; i += 1) {
      const voice = this.insectVoices[i];
      if (!voice) continue;
      safeDisconnect(voice.filter);
      safeDisconnect(voice.gain);
      if (voice.pan) safeDisconnect(voice.pan);
    }
    this.insectVoices.length = 0;
    safeDisconnect(this.windFilter);
    safeDisconnect(this.windGain);
    safeDisconnect(this.leafFilter);
    safeDisconnect(this.leafGain);
    safeDisconnect(this.gustLfo);
    safeDisconnect(this.gustLevelDepth);
    safeDisconnect(this.gustCutoffDepth);
    safeDisconnect(this.waterFilter);
    safeDisconnect(this.waterGain);
    safeDisconnect(this.waterDetailFilter);
    safeDisconnect(this.waterDetailGain);
    safeDisconnect(this.roomToneFilter);
    safeDisconnect(this.roomToneGain);
    safeDisconnect(this.insectBus);
    safeDisconnect(this.birdBus);
    safeDisconnect(this.output);
  }
}
