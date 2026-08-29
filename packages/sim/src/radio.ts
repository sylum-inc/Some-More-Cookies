/**
 * The radio (spec §8).
 *
 * Tuning is analogue and tactile: a dial position, a selectivity curve, static
 * between stations, bleed from strong neighbours, slow thermal drift, and
 * reception that answers to the weather and to where the campsite sits.
 *
 * Because there are no audio assets, a station's *content* is a deterministic
 * schedule of segments — a music bed, a station ident, a spoken-word cue, a
 * silence, a burst of interference — which the audio engine realises later.
 * The schedule is a pure function of the station's seed and a segment index,
 * and every station's clock advances whether or not anyone is listening. Tune
 * away and come back and the station has *moved on*; it does not restart. That
 * is the whole trick, and it is what makes the dial feel like a place rather
 * than a menu.
 *
 * Optional codes and clues ride on broadcasts. They are strictly optional
 * (§8): a station with no codes behaves identically in every other respect,
 * and nothing anywhere in the product requires having heard one.
 *
 * `RadioStationSpec` and `RadioProfileSpec` are structurally identical to
 * `RadioStation` and `RadioProfile` in `@somemore/content`'s schema, so
 * `EnvironmentManifest.radio` can be handed straight to {@link createRadio}.
 * This package does not import the content package: content depends on `sim`,
 * and that dependency must not invert.
 */

import { clamp, clamp01, lerp, smoothstep } from './math.js';
import { Rng, fbm1D, hashString, mixSeeds } from './rng.js';

/* -------------------------------------------------------------------------- */
/* Content-shaped input                                                       */
/* -------------------------------------------------------------------------- */

export type RadioBand = 'fm' | 'am' | 'shortwave';

export type StationCharacter =
  | 'lofi'
  | 'ambient'
  | 'environmental'
  | 'strange'
  | 'community'
  | 'weather-service';

/** One station on the dial. Mirrors the content schema exactly. */
export interface RadioStationSpec {
  readonly id: string;
  /** Dial position. MHz on FM, kHz on AM and shortwave. */
  readonly dial: number;
  readonly band: RadioBand;
  readonly name: string;
  readonly character: StationCharacter;
  /** 0..1 signal quality here. Low is atmosphere, not punishment. */
  readonly reception: number;
  readonly note: string;
}

/** A campsite's dial. Mirrors the content schema exactly. */
export interface RadioProfileSpec {
  readonly stations: readonly RadioStationSpec[];
  /** 0..1 baseline reception before per-station quality. */
  readonly baseReception: number;
  readonly receptionNote: string;
  /** What the empty dial sounds like between stations. */
  readonly betweenStations: string;
}

/**
 * The weather the aerial feels. `WeatherState` from `./weather.js` satisfies
 * this structurally; restated so the radio does not depend on that model.
 */
export interface RadioWeather {
  readonly precipitation: number;
  readonly windSpeed: number;
  readonly fog: number;
  readonly cloudCover: number;
}

/* -------------------------------------------------------------------------- */
/* Band plans                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The physical shape of a band.
 *
 * `halfWidth` is the offset in dial units at which a station has fallen to
 * about a third of its strength — the selectivity of the receiver, and the
 * reason the dial has to be turned *carefully*.
 */
export interface BandPlan {
  readonly band: RadioBand;
  min: number;
  max: number;
  /** Smallest meaningful movement of the dial. */
  readonly step: number;
  readonly halfWidth: number;
  /** 0..1 how noisy this band is when empty. */
  readonly noiseFloor: number;
}

const DEFAULT_BANDS: Record<RadioBand, BandPlan> = {
  fm: { band: 'fm', min: 87.5, max: 108, step: 0.1, halfWidth: 0.16, noiseFloor: 0.85 },
  am: { band: 'am', min: 520, max: 1710, step: 9, halfWidth: 6, noiseFloor: 0.95 },
  shortwave: { band: 'shortwave', min: 2300, max: 26100, step: 5, halfWidth: 4, noiseFloor: 1 },
};

export const RADIO_BANDS: readonly RadioBand[] = ['fm', 'am', 'shortwave'];

/**
 * Builds the band plans for a profile, widening each band to cover every
 * station the content actually places on it.
 *
 * Content is allowed to put a weather station at 162.475 "on FM" or a beacon
 * at 310 "on AM"; the receiver simply has more dial than a domestic one, which
 * is true of the sort of radio that ends up at a campsite anyway.
 */
export function planBands(profile: RadioProfileSpec): Record<RadioBand, BandPlan> {
  const plans: Record<RadioBand, BandPlan> = {
    fm: { ...(DEFAULT_BANDS.fm as BandPlan) },
    am: { ...(DEFAULT_BANDS.am as BandPlan) },
    shortwave: { ...(DEFAULT_BANDS.shortwave as BandPlan) },
  };
  for (const station of profile.stations) {
    const plan = plans[station.band];
    const margin = plan.halfWidth * 6;
    if (station.dial - margin < plan.min) plan.min = station.dial - margin;
    if (station.dial + margin > plan.max) plan.max = station.dial + margin;
  }
  return plans;
}

/** The bands this profile actually uses, in dial order. */
export function availableBands(profile: RadioProfileSpec): readonly RadioBand[] {
  return RADIO_BANDS.filter((band) => profile.stations.some((station) => station.band === band));
}

/* -------------------------------------------------------------------------- */
/* Programming                                                                */
/* -------------------------------------------------------------------------- */

export type SegmentKind = 'music-bed' | 'ident' | 'spoken' | 'silence' | 'interference' | 'code' | 'carrier';

/**
 * One block of a station's output.
 *
 * `seed` is handed to the audio engine so a music bed can be synthesised
 * deterministically — the same segment sounds the same to every player at the
 * same campsite, which is what makes a station worth mentioning to a friend.
 */
export interface ProgrammeSegment {
  readonly index: number;
  readonly kind: SegmentKind;
  readonly durationSeconds: number;
  /** A short label for subtitles and the Passport. Never a quest hint. */
  readonly label: string;
  /** Deterministic seed for whatever synthesises this segment. */
  readonly seed: number;
  /** 0..1 how energetic the bed is, for the audio engine's benefit. */
  readonly intensity: number;
  /** Set only when a clue rides on this segment. Always optional (§8). */
  readonly code: RadioCode | null;
}

/** An optional clue carried on a broadcast. Never gates anything. */
export interface RadioCode {
  readonly id: string;
  readonly kind: 'numbers' | 'morse' | 'callsign' | 'phrase' | 'timestamp';
  /** What is actually said or sent. */
  readonly text: string;
  /** 0..1 how often it may surface. */
  readonly frequency: number;
}

interface CharacterProfile {
  /** Relative weights for a normal slot. */
  readonly weights: Partial<Record<SegmentKind, number>>;
  /** Seconds, min/max, per kind. */
  readonly bedSeconds: readonly [number, number];
  readonly spokenSeconds: readonly [number, number];
  readonly silenceSeconds: readonly [number, number];
  /** Every Nth segment is an ident. 0 = never. */
  readonly identEvery: number;
  /** 0..1 chance a slot becomes a code segment when codes are available. */
  readonly codeChance: number;
  readonly intensity: readonly [number, number];
}

const CHARACTERS: Record<StationCharacter, CharacterProfile> = {
  lofi: {
    weights: { 'music-bed': 10, spoken: 1, silence: 1 },
    bedSeconds: [150, 320],
    spokenSeconds: [8, 24],
    silenceSeconds: [3, 9],
    identEvery: 7,
    codeChance: 0.02,
    intensity: [0.25, 0.55],
  },
  ambient: {
    weights: { 'music-bed': 14, silence: 2, spoken: 1 },
    bedSeconds: [220, 480],
    spokenSeconds: [6, 16],
    silenceSeconds: [6, 20],
    identEvery: 11,
    codeChance: 0.02,
    intensity: [0.12, 0.4],
  },
  environmental: {
    weights: { spoken: 8, silence: 5, carrier: 2, 'music-bed': 1 },
    bedSeconds: [40, 90],
    spokenSeconds: [25, 95],
    silenceSeconds: [8, 30],
    identEvery: 5,
    codeChance: 0.08,
    intensity: [0.1, 0.3],
  },
  strange: {
    weights: { carrier: 7, silence: 5, interference: 4, spoken: 3, 'music-bed': 2 },
    bedSeconds: [30, 120],
    spokenSeconds: [10, 40],
    silenceSeconds: [10, 60],
    identEvery: 0,
    codeChance: 0.35,
    intensity: [0.05, 0.35],
  },
  community: {
    weights: { spoken: 9, 'music-bed': 6, silence: 2, interference: 1 },
    bedSeconds: [90, 210],
    spokenSeconds: [30, 130],
    silenceSeconds: [2, 8],
    identEvery: 6,
    codeChance: 0.03,
    intensity: [0.3, 0.7],
  },
  'weather-service': {
    weights: { spoken: 12, silence: 3 },
    bedSeconds: [20, 40],
    spokenSeconds: [35, 80],
    silenceSeconds: [3, 10],
    identEvery: 8,
    codeChance: 0.05,
    intensity: [0.08, 0.2],
  },
};

const LABELS: Record<SegmentKind, readonly string[]> = {
  'music-bed': ['a slow instrumental', 'something with a lot of tape hiss', 'a long, unhurried record', 'a warm loop'],
  ident: ['the station name, once', 'a station ident recorded a long time ago', 'a callsign and nothing else'],
  spoken: ['someone talking, unhurried', 'a list read in order', 'a forecast', 'a long pause, then more of it'],
  silence: ['nothing at all', 'dead air', 'a held silence'],
  interference: ['a wash of interference', 'something beating against the carrier', 'a burst of noise'],
  code: ['a sequence, read out', 'a pattern under the signal'],
  carrier: ['an unmodulated carrier', 'a carrier and a room tone'],
};

/** The station's own seed — stable per campsite, per station. */
function stationSeed(campsiteSeed: number, stationId: string): number {
  return mixSeeds(campsiteSeed, hashString(`radio:${stationId}`));
}

/**
 * Generates segment `index` of a station's programming.
 *
 * Pure: `(stationSeed, index)` fully determines the segment. There is no
 * hidden cursor, so any point in a station's history can be recomputed and two
 * players at the same campsite hear the same broadcast.
 */
export function programmeSegment(
  station: RadioStationSpec,
  seed: number,
  index: number,
  codes: readonly RadioCode[] = [],
): ProgrammeSegment {
  const rng = new Rng(mixSeeds(seed, index * 0x9e37 + 1));
  // A character this build does not know about must not take the whole
  // campsite down with it: live-ops can ship a station type before the client
  // that understands it, and an unfamiliar station should simply sound
  // ordinary rather than throw on the first segment.
  const profile = CHARACTERS[station.character] ?? CHARACTERS.ambient;

  let kind: SegmentKind;
  if (profile.identEvery > 0 && index % profile.identEvery === 0) {
    kind = 'ident';
  } else if (codes.length > 0 && rng.chance(profile.codeChance)) {
    kind = 'code';
  } else {
    const entries = Object.entries(profile.weights) as [SegmentKind, number][];
    const picked = rng.weightedPick(entries, ([, weight]) => weight);
    kind = picked ? picked[0] : 'music-bed';
  }

  let duration: number;
  switch (kind) {
    case 'music-bed':
      duration = rng.range(profile.bedSeconds[0], profile.bedSeconds[1]);
      break;
    case 'spoken':
      duration = rng.range(profile.spokenSeconds[0], profile.spokenSeconds[1]);
      break;
    case 'silence':
      duration = rng.range(profile.silenceSeconds[0], profile.silenceSeconds[1]);
      break;
    case 'ident':
      duration = rng.range(5, 13);
      break;
    case 'interference':
      duration = rng.range(3, 22);
      break;
    case 'carrier':
      duration = rng.range(20, 140);
      break;
    default:
      duration = rng.range(18, 55);
      break;
  }

  let code: RadioCode | null = null;
  if (kind === 'code' && codes.length > 0) {
    code = rng.weightedPick(codes, (candidate) => Math.max(candidate.frequency, 0.0001)) ?? null;
  }

  const pool = LABELS[kind];
  const label = code ? code.text : rng.pick(pool) ?? (pool[0] as string);

  return {
    index,
    kind,
    durationSeconds: duration,
    label,
    seed: mixSeeds(seed, index),
    intensity:
      kind === 'silence' || kind === 'carrier'
        ? 0
        : rng.range(profile.intensity[0], profile.intensity[1]),
    code,
  };
}

/* -------------------------------------------------------------------------- */
/* Runtime state                                                              */
/* -------------------------------------------------------------------------- */

/** A station as it exists in this session: a spec plus a running clock. */
export interface StationRuntime {
  readonly spec: RadioStationSpec;
  readonly seed: number;
  readonly codes: readonly RadioCode[];
  /** Seconds since this station started broadcasting for this session. */
  clock: number;
  /** Seconds into the current segment. */
  segmentElapsed: number;
  segment: ProgrammeSegment;
}

export type RadioEventKind = 'segment' | 'code' | 'locked' | 'lost';

export interface RadioEvent {
  readonly kind: RadioEventKind;
  readonly at: number;
  readonly stationId: string;
  readonly stationName: string;
  readonly character: StationCharacter;
  readonly dial: number;
  readonly band: RadioBand;
  /** 0..1 how cleanly it was coming through when this happened. */
  readonly clarity: number;
  readonly segment: ProgrammeSegment | null;
  readonly code: RadioCode | null;
}

export interface RadioOptions {
  readonly campsiteSeed: number | string;
  /** Optional clues, keyed by station id. Absent means the station has none. */
  readonly codes?: Readonly<Record<string, readonly RadioCode[]>>;
  readonly band?: RadioBand;
  readonly dial?: number;
  /** How far into their night the stations already are when you switch on. */
  readonly startOffsetSeconds?: number;
  /** Clarity at which a station counts as received. */
  readonly lockThreshold?: number;
}

export interface RadioReadout {
  stationId: string | null;
  stationName: string | null;
  character: StationCharacter | null;
  /** 0..1 raw strength of the strongest station at this dial position. */
  strength: number;
  /** 0..1 how cleanly it is coming through once noise and bleed are counted. */
  clarity: number;
  /** 0..1 hiss. What you hear when the dial is between stations. */
  hiss: number;
  /** 0..1 signal from *other* stations muscling in. */
  bleed: number;
  bleedFromId: string | null;
  /** 0..1 mains and machinery hum riding on the signal. */
  hum: number;
  /** Signed dial-units offset from the station's centre — drives the whistle. */
  detune: number;
  segmentKind: SegmentKind | null;
  segmentLabel: string | null;
  /** True when nothing is receivable here at all. */
  betweenStations: boolean;
}

export interface RadioState {
  on: boolean;
  band: RadioBand;
  /** Where the dial is set. */
  dial: number;
  /** 0..1. */
  volume: number;
  readonly profile: RadioProfileSpec;
  readonly bands: Record<RadioBand, BandPlan>;
  readonly stations: StationRuntime[];
  readonly seed: number;
  readonly lockThreshold: number;
  elapsed: number;
  /** Analogue thermal drift, in dial units. Small, slow, never annoying. */
  drift: number;
  reception: RadioReadout;
  /** The station currently locked, for enter/leave events. */
  lockedStationId: string | null;
  /** Segment index last announced, so a segment fires once. */
  lastSegmentIndex: number;
  events: RadioEvent[];
}

function emptyReadout(): RadioReadout {
  return {
    stationId: null,
    stationName: null,
    character: null,
    strength: 0,
    clarity: 0,
    hiss: 1,
    bleed: 0,
    bleedFromId: null,
    hum: 0,
    detune: 0,
    segmentKind: null,
    segmentLabel: null,
    betweenStations: true,
  };
}

export function createRadio(profile: RadioProfileSpec, options: RadioOptions): RadioState {
  const seed =
    typeof options.campsiteSeed === 'string' ? hashString(options.campsiteSeed) : options.campsiteSeed >>> 0;
  const bands = planBands(profile);
  const offset = options.startOffsetSeconds ?? 0;

  const stations: StationRuntime[] = profile.stations.map((spec) => {
    const stationOwnSeed = stationSeed(seed, spec.id);
    const codes = options.codes?.[spec.id] ?? [];
    const runtime: StationRuntime = {
      spec,
      seed: stationOwnSeed,
      codes,
      clock: 0,
      segmentElapsed: 0,
      segment: programmeSegment(spec, stationOwnSeed, 0, codes),
    };
    // Stations were on the air before the player arrived.
    if (offset > 0) advanceStation(runtime, offset);
    return runtime;
  });

  const band = options.band ?? (availableBands(profile)[0] ?? 'fm');
  const plan = bands[band];
  return {
    on: false,
    band,
    dial: options.dial ?? (plan.min + plan.max) / 2,
    volume: 0.6,
    profile,
    bands,
    stations,
    seed,
    lockThreshold: options.lockThreshold ?? 0.34,
    elapsed: 0,
    drift: 0,
    reception: emptyReadout(),
    lockedStationId: null,
    lastSegmentIndex: -1,
    events: [],
  };
}

/** Advances one station's programming, rolling into new segments as needed. */
function advanceStation(runtime: StationRuntime, dt: number): void {
  runtime.clock += dt;
  runtime.segmentElapsed += dt;
  // A guard rather than an `if`: a large catch-up may span several segments.
  let guard = 0;
  while (runtime.segmentElapsed >= runtime.segment.durationSeconds && guard++ < 4096) {
    runtime.segmentElapsed -= runtime.segment.durationSeconds;
    runtime.segment = programmeSegment(runtime.spec, runtime.seed, runtime.segment.index + 1, runtime.codes);
  }
}

/* -------------------------------------------------------------------------- */
/* Reception                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The receiver's selectivity curve.
 *
 * A Gaussian core gives the sharp "it's right *here*" of a well-tuned station;
 * a Lorentzian tail is what lets a strong neighbour bleed through from further
 * up the dial. Real receivers do both, and the difference is audible.
 */
export function selectivity(offset: number, halfWidth: number): number {
  const x = Math.abs(offset) / Math.max(halfWidth, 1e-6);
  const core = Math.exp(-x * x * 1.1);
  const tail = 0.16 / (1 + x * x * 3.2);
  return clamp01(core * 0.88 + tail);
}

/** How much of a band the weather takes away. Never all of it. */
export function weatherReception(band: RadioBand, weather: RadioWeather | undefined): number {
  if (!weather) return 1;
  const rain = clamp01(weather.precipitation);
  const wind = smoothstep(2, 9, weather.windSpeed);
  const fog = clamp01(weather.fog);
  const cloud = clamp01(weather.cloudCover);
  switch (band) {
    case 'fm':
      // Line of sight: rain fade, and an aerial in a moving tree.
      return clamp(1 - rain * 0.4 - wind * 0.3 + fog * 0.04, 0.12, 1.05);
    case 'am':
      // Ground wave survives weather; lightning does not leave it alone.
      return clamp(1 - rain * 0.22 - wind * 0.08 + cloud * 0.06 + fog * 0.06, 0.2, 1.1);
    default:
      // Shortwave cares about the ionosphere, and a storm is loud on it.
      return clamp(1 - rain * 0.3 - wind * 0.05 + cloud * 0.1, 0.15, 1.12);
  }
}

/** Crash static from a storm overhead: precipitation and wind together. */
function stormCrash(weather: RadioWeather | undefined, elapsed: number, band: RadioBand): number {
  if (!weather) return 0;
  const storminess = clamp01(weather.precipitation) * smoothstep(2.5, 6, weather.windSpeed);
  if (storminess <= 0) return 0;
  const bandGain = band === 'fm' ? 0.35 : 1;
  // Deterministic bursts rather than a constant hiss — crashes, not noise.
  const burst = Math.max(0, fbm1D(0x5c9a, elapsed * 1.6, 3) - 0.55) / 0.45;
  return clamp01(storminess * burst * bandGain);
}

/** The signal a single station is putting into the receiver right now. */
export interface StationSignal {
  readonly station: RadioStationSpec;
  /** Signed dial-units from the tuned position to the station. */
  readonly offset: number;
  /** 0..1 selectivity at that offset. */
  readonly kernel: number;
  /** 0..1 station quality before selectivity. */
  readonly quality: number;
  /** 0..1 what actually arrives. */
  readonly strength: number;
}

export interface RadioConditions {
  readonly weather?: RadioWeather;
  /** 0..1 electrical noise from the SM-01's compressor and the like. */
  readonly machineNoise?: number;
  /** 0..1 extra site attenuation — standing behind a ridge, say. */
  readonly occlusion?: number;
}

/** Everything arriving at the current dial position, strongest first. */
export function stationSignals(state: RadioState, conditions: RadioConditions = {}): StationSignal[] {
  const plan = state.bands[state.band];
  const tuned = state.dial + state.drift;
  const weatherFactor = weatherReception(state.band, conditions.weather);
  const occlusion = 1 - clamp01(conditions.occlusion ?? 0) * 0.8;
  const signals: StationSignal[] = [];
  for (const runtime of state.stations) {
    if (runtime.spec.band !== state.band) continue;
    const offset = runtime.spec.dial - tuned;
    const kernel = selectivity(offset, plan.halfWidth);
    const quality = clamp01(
      clamp01(runtime.spec.reception) * lerp(0.55, 1, clamp01(state.profile.baseReception)) * weatherFactor * occlusion,
    );
    signals.push({ station: runtime.spec, offset, kernel, quality, strength: kernel * quality });
  }
  signals.sort((a, b) => b.strength - a.strength);
  return signals;
}

/** Computes what the listener hears without mutating anything. */
export function receptionAt(state: RadioState, conditions: RadioConditions = {}): RadioReadout {
  if (!state.on) return emptyReadout();
  const plan = state.bands[state.band];
  const signals = stationSignals(state, conditions);
  const best = signals[0] ?? null;
  if (!best || best.strength <= 0.001) {
    const readout = emptyReadout();
    readout.hiss = clamp01(plan.noiseFloor);
    readout.hum = clamp01(conditions.machineNoise ?? 0);
    return readout;
  }

  let bleed = 0;
  let bleedFromId: string | null = null;
  for (const signal of signals) {
    if (signal.station.id === best.station.id) continue;
    if (signal.strength > bleed) {
      bleed = signal.strength;
      bleedFromId = signal.station.id;
    }
  }
  // Everything else that is not the tuned station adds to the mush.
  let interference = 0;
  for (const signal of signals) {
    if (signal.station.id === best.station.id) continue;
    interference += signal.strength;
  }

  const crash = stormCrash(conditions.weather, state.elapsed, state.band);
  const hum = clamp01((conditions.machineNoise ?? 0) * 0.8 + (state.band === 'am' ? 0.12 : 0.04));
  // Capture effect: a strong signal buries the mush; a weak one drowns in it.
  // The second term keeps a genuinely weak station *listenable* rather than
  // unreachable — a 0.2-reception carrier is atmosphere, not punishment (§8).
  const capture = best.strength / (best.strength + interference * 0.7 + 0.12);
  const clarity = clamp01(capture * (0.35 + 0.65 * best.strength) * (1 - crash * 0.7));
  const hiss = clamp01((1 - best.strength) * plan.noiseFloor * (1 - clarity * 0.55) + crash * 0.6);

  const runtime = state.stations.find((candidate) => candidate.spec.id === best.station.id) ?? null;
  const locked = clarity >= state.lockThreshold;

  return {
    stationId: locked ? best.station.id : null,
    stationName: locked ? best.station.name : null,
    character: locked ? best.station.character : null,
    strength: best.strength,
    clarity,
    hiss,
    bleed,
    bleedFromId,
    hum,
    detune: -best.offset,
    segmentKind: locked && runtime ? runtime.segment.kind : null,
    segmentLabel: locked && runtime ? runtime.segment.label : null,
    betweenStations: !locked,
  };
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

function push(state: RadioState, event: RadioEvent): void {
  state.events.push(event);
}

/**
 * Advances the radio by one fixed timestep.
 *
 * Every station's programming advances whether or not it is tuned — that is
 * what gives the dial continuity.
 */
export function stepRadio(state: RadioState, dt: number, conditions: RadioConditions = {}): void {
  state.elapsed += dt;

  // Slow analogue drift: a fraction of a channel over many minutes.
  const plan = state.bands[state.band];
  state.drift = (fbm1D(0x7a31, state.elapsed * 0.006, 2) - 0.5) * plan.halfWidth * 0.35;

  for (const runtime of state.stations) advanceStation(runtime, dt);

  if (!state.on) {
    state.reception = emptyReadout();
    if (state.lockedStationId !== null) state.lockedStationId = null;
    return;
  }

  const before = state.lockedStationId;
  const readout = receptionAt(state, conditions);
  state.reception = readout;

  if (readout.stationId !== before) {
    if (before !== null) {
      const previous = state.stations.find((candidate) => candidate.spec.id === before);
      if (previous) {
        push(state, {
          kind: 'lost',
          at: state.elapsed,
          stationId: previous.spec.id,
          stationName: previous.spec.name,
          character: previous.spec.character,
          dial: previous.spec.dial,
          band: previous.spec.band,
          clarity: 0,
          segment: null,
          code: null,
        });
      }
    }
    state.lockedStationId = readout.stationId;
    state.lastSegmentIndex = -1;
    if (readout.stationId !== null) {
      const runtime = state.stations.find((candidate) => candidate.spec.id === readout.stationId);
      if (runtime) {
        push(state, {
          kind: 'locked',
          at: state.elapsed,
          stationId: runtime.spec.id,
          stationName: runtime.spec.name,
          character: runtime.spec.character,
          dial: runtime.spec.dial,
          band: runtime.spec.band,
          clarity: readout.clarity,
          segment: runtime.segment,
          code: runtime.segment.code,
        });
      }
    }
  }

  if (state.lockedStationId !== null) {
    const runtime = state.stations.find((candidate) => candidate.spec.id === state.lockedStationId);
    if (runtime && runtime.segment.index !== state.lastSegmentIndex) {
      state.lastSegmentIndex = runtime.segment.index;
      push(state, {
        kind: 'segment',
        at: state.elapsed,
        stationId: runtime.spec.id,
        stationName: runtime.spec.name,
        character: runtime.spec.character,
        dial: runtime.spec.dial,
        band: runtime.spec.band,
        clarity: readout.clarity,
        segment: runtime.segment,
        code: runtime.segment.code,
      });
      // A clue only counts if it was actually audible. Optional, always (§8).
      if (runtime.segment.code && readout.clarity >= state.lockThreshold) {
        push(state, {
          kind: 'code',
          at: state.elapsed,
          stationId: runtime.spec.id,
          stationName: runtime.spec.name,
          character: runtime.spec.character,
          dial: runtime.spec.dial,
          band: runtime.spec.band,
          clarity: readout.clarity,
          segment: runtime.segment,
          code: runtime.segment.code,
        });
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Player intents                                                             */
/* -------------------------------------------------------------------------- */

export function setRadioPower(state: RadioState, on: boolean): void {
  state.on = on;
  if (!on) {
    state.reception = emptyReadout();
    state.lockedStationId = null;
    state.lastSegmentIndex = -1;
  }
}

/** Sets the dial directly, clamped to the band. */
export function tuneTo(state: RadioState, dial: number): void {
  const plan = state.bands[state.band];
  state.dial = clamp(dial, plan.min, plan.max);
}

/**
 * Turns the dial by a fraction of a knob rotation.
 *
 * `amount` is in knob turns, not frequency, which is what makes tuning tactile:
 * the same gesture covers a different span on each band.
 */
export function turnDial(state: RadioState, amount: number): void {
  const plan = state.bands[state.band];
  tuneTo(state, state.dial + amount * (plan.max - plan.min) * 0.08);
}

/** Switches band, parking the dial in the middle of the new one. */
export function setBand(state: RadioState, band: RadioBand): void {
  if (state.band === band) return;
  state.band = band;
  const plan = state.bands[band];
  state.dial = clamp(state.dial, plan.min, plan.max);
  state.lockedStationId = null;
  state.lastSegmentIndex = -1;
}

/** Where a station actually sits, for a "seek" affordance or a test. */
export function stationDial(state: RadioState, stationId: string): number | null {
  const runtime = state.stations.find((candidate) => candidate.spec.id === stationId);
  return runtime ? runtime.spec.dial : null;
}

/** Tunes exactly onto a station, switching band if necessary. */
export function tuneToStation(state: RadioState, stationId: string): boolean {
  const runtime = state.stations.find((candidate) => candidate.spec.id === stationId);
  if (!runtime) return false;
  setBand(state, runtime.spec.band);
  state.band = runtime.spec.band;
  tuneTo(state, runtime.spec.dial);
  return true;
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

export function drainRadioEvents(state: RadioState): RadioEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

/** What a station is playing right now, whether or not anyone is listening. */
export function currentSegment(state: RadioState, stationId: string): ProgrammeSegment | null {
  const runtime = state.stations.find((candidate) => candidate.spec.id === stationId);
  return runtime ? runtime.segment : null;
}

/** How far into the current segment a station is, in seconds. */
export function segmentProgress(state: RadioState, stationId: string): number {
  const runtime = state.stations.find((candidate) => candidate.spec.id === stationId);
  return runtime ? runtime.segmentElapsed : 0;
}

/**
 * The next few segments a station will play.
 *
 * Handed to the audio engine so it can pre-synthesise a bed rather than glitch
 * at a boundary. It is *not* a programme guide for the player: no UI in this
 * product tells anyone what is coming up.
 */
export function upcomingSegments(state: RadioState, stationId: string, count = 3): ProgrammeSegment[] {
  const runtime = state.stations.find((candidate) => candidate.spec.id === stationId);
  if (!runtime) return [];
  const segments: ProgrammeSegment[] = [];
  for (let i = 1; i <= count; i++) {
    segments.push(programmeSegment(runtime.spec, runtime.seed, runtime.segment.index + i, runtime.codes));
  }
  return segments;
}

/** A short line for subtitles. Describes sound, never instructs. */
export function describeReception(state: RadioState): string {
  const readout = state.reception;
  if (!state.on) return '';
  if (readout.betweenStations) {
    return readout.hiss > 0.75 ? state.profile.betweenStations : 'Something almost coming through.';
  }
  return `${readout.stationName ?? ''} — ${readout.segmentLabel ?? ''}`.trim();
}
