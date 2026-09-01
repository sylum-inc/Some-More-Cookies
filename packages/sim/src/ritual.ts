/**
 * The ritual state machine (spec §1).
 *
 *   arrive → tend fire → roast → assemble → load → operate SM-01 →
 *   transform → reveal → inspect / photograph / share / save / order / eat
 *
 * This binds every subsystem into one advanceable session. It is the object
 * the renderer reads and the multiplayer layer replicates inputs into, and it
 * is what the headless tests drive to prove the whole loop works without a
 * browser.
 *
 * The campsite stays open before and after: `stage` never forces the player
 * forward, it only records where they are in the ritual.
 */

import {
  createEstablishedFire,
  fanFire,
  fireSignals,
  rakeEmbers,
  bankFire,
  createBankedFire,
  repositionLog,
  type FuelGrade,
  type LogSpot,
  type LogPlacement,
  type Log,
  stepFire,
  addLog,
  type FireSignals,
  type FireState,
} from './fire.js';
import {
  createMarshmallow,
  stepRoast,
  summariseRoast,
  blowOut,
  type MarshmallowState,
  type RoastInput,
  type RoastSummary,
} from './roasting.js';
import {
  createAssembly,
  isComplete as assemblyComplete,
  place,
  pickUp,
  moveHeld,
  stepAssembly,
  summariseAssembly,
  nextComponent,
  type AssemblyState,
  type AssemblySummary,
  type ComponentKind,
} from './assembly.js';
import {
  createMachine,
  performAction,
  recordRun,
  stepMachine,
  type MachineAction,
  type MachineState,
} from './machine.js';
import { deriveSandwich, createBiteState, takeBite, type BiteState, type SandwichRecord } from './sandwich.js';
import {
  focused,
  reachable,
  type Interactable,
  type PlayerState,
  type WalkableWorld,
} from './locomotion.js';
import {
  placeLandmarks,
  landmarkAt,
  type LandmarkSpec,
  type PlacedLandmark,
  type Occupied,
} from './landmarks.js';
import {
  createGathering,
  gatherFrom,
  takeFromArmful,
  type GatheringState,
  type FuelSourceSpec,
  type GatherResult,
} from './gathering.js';
import { describeWeatherChange, type WeatherKind, createWeather, stepWeather, weatherFireEffect, type WeatherProfile, type WeatherState, DEFAULT_WEATHER_PROFILE } from './weather.js';
import {
  createWildlife,
  createWildlifeInput,
  drainWildlifeEvents,
  presentAnimals,
  stepWildlife,
  wildlifeEvidence,
  wildlifeSignals,
  type ActivityWindow,
  type WildlifeAnimal,
  type WildlifeCueField,
  type WildlifeEvent,
  type WildlifeInput,
  type WildlifeObject,
  type WildlifeSignals,
  type WildlifeSpecies,
  type WildlifeState,
} from './wildlife.js';
import {
  createRadio,
  drainRadioEvents,
  receptionAt,
  setBand,
  setRadioPower,
  stepRadio,
  turnDial,
  tuneTo,
  type RadioBand,
  type RadioConditions,
  type RadioEvent,
  type RadioReadout,
  type RadioProfileSpec,
  type RadioState,
} from './radio.js';
import {
  createDiscovery,
  createObservation,
  discoveryEvidence,
  discoverySignals,
  drainDiscoveryEvents,
  stepDiscovery,
  type DiscoveryEvent,
  type DiscoveryObservation,
  type DiscoveryRecord,
  type DiscoverySignals,
  type DiscoveryState,
  type SecretDefinition,
} from './discovery.js';
import {
  canFish,
  canSkipStones,
  createWater,
  describeWater,
  disturbWater,
  stepWater,
  type WaterFeatureSpec,
  type WaterState,
} from './water.js';
import {
  createSkipping,
  drainSkipEvents,
  pickUpStone,
  skipEvidence,
  stepSkipping,
  summariseSkip,
  throwStone as throwStoneAction,
  type SkipEvent,
  type SkippingState,
  type Stone,
  type ThrowInput,
} from './skipping.js';
import {
  aimTorch as aimTorchAction,
  createTorch,
  focusTorch as focusTorchAction,
  stepTorch,
  stowTorch,
  switchTorch,
  takeTorch,
  torchCue,
  type TorchState,
} from './torch.js';
import {
  createSeat,
  settlingGain,
  sitDown as sitDownAction,
  standUp as standUpAction,
  stepSeat,
  stillnessGain,
  type SeatState,
} from './sitting.js';
import {
  aimSky as aimSkyAction,
  createStargazing,
  drainStargazingEvents,
  setBinoculars as setBinocularsAction,
  setPosture,
  stargazingEvidence,
  stepStargazing,
  describeSkyMoment,
  skySignals,
  type SkySignals,
  type StargazingEvent,
  type StargazingState,
} from './stargazing.js';
import {
  cast as castAction,
  createFishing,
  describeCatch,
  drainFishingEvents,
  fishingEvidence,
  fishingSignals,
  type FishingSignals,
  playFish,
  releaseFish,
  stepFishing,
  stowRod,
  strike,
  takeRod,
  type FishingConditions,
  type FishingEvent,
  type FishingState,
} from './fishing.js';
import { createTrace, type Trace } from './significance.js';
import { Rng, hashString, mixSeeds } from './rng.js';
import { clamp, clamp01, smoothstep } from './math.js';
import { vec3, type Vec3, SIM_DT } from './types.js';

export type RitualStage =
  | 'arriving'
  | 'at-fire'
  | 'roasting'
  | 'assembling'
  | 'machine'
  | 'reveal'
  | 'eating'
  | 'after';

export interface RitualOptions {
  campsiteSeed: number | string;
  environmentId: string;
  weatherProfile?: WeatherProfile;
  /** Accessibility assists. */
  assemblyAssist?: number;
  /** Automatic marshmallow rotation, rad/s. 0 disables (the default). */
  autoRotate?: number;
  /** Epoch ms used for sandwich records. Injected so tests are deterministic. */
  now?: number;
  /**
   * Content this campsite is populated from. Every field is optional: a
   * campsite with no roster simply has no animals tonight, which is a real
   * thing that happens and not an error.
   */
  world?: RitualWorldContent;
  /** Which visit to this campsite this is. 1 is the first. */
  visitIndex?: number;
  /** Visits already banked for known individuals, keyed by individual id. */
  priorVisits?: Readonly<Record<string, number>>;
  /** What this player already found here, restored from the Passport. */
  knownSecrets?: readonly DiscoveryRecord[];
  /** Which part of the night the session opens in. */
  startWindow?: ActivityWindow;
  /**
   * Approximate latitude and longitude, for the sky.
   *
   * Coarse on purpose: precise location is never required (§5.5), and the
   * defaults are the curated night's, which the spec requires to be as good
   * as the real thing rather than a degraded fallback.
   */
  latitudeDeg?: number;
  longitudeDeg?: number;
  /** Walkable radius, so the shore can be placed inside the campsite. */
  walkableRadiusM?: number;
  /** Constellations this player has already picked out here. */
  knownConstellations?: readonly string[];
  /**
   * Epoch ms the sky is computed for. Injected, never read from a clock.
   *
   * Deliberately separate from `now`, which timestamps records: the world is
   * always night, and a session at five in the afternoon must not put the sun
   * over the campfire. Use `nightEpoch()` to get today's real date at the
   * campsite's own two in the morning. Omitted or zero uses the curated night,
   * which §5.5 requires to be as good as the real thing.
   */
  skyEpochMs?: number;
}

/**
 * The slice of an environment manifest the world systems read.
 *
 * These are the manifest's own types: `EnvironmentManifest` from
 * `@somemore/content` satisfies this structurally, so a caller passes the
 * manifest straight through with no adapter (see the notes on
 * `WildlifeSpecies`, `RadioProfileSpec` and `SecretDefinition`).
 */
export interface RitualWorldContent {
  readonly wildlife?: readonly WildlifeSpecies[];
  readonly radio?: RadioProfileSpec;
  readonly secrets?: readonly SecretDefinition[];
  /**
   * The water, from `EnvironmentManifest.scene.water`.
   *
   * Omitted for a dry site, which is a real and common answer — a salt flat, a
   * mesa, a rail siding. Everything downstream treats `null` water as "there
   * is nothing here to skip a stone on", never as an error.
   */
  readonly water?: WaterFeatureSpec;
  /** `EnvironmentManifest.scene.skyOpenness` — how much sky this place has. */
  readonly skyOpenness?: number;
  /**
   * `EnvironmentManifest.fuel.sources` — where the wood at this campsite is.
   *
   * Twelve environments have described their own firewood since the catalogue
   * was written and none of it reached anybody: one pile at camp, infinite,
   * uniformly dry. These become the places you walk to.
   */
  readonly fuel?: readonly FuelSourceSpec[];
  /**
   * `EnvironmentManifest.scene.landmarks` — the named things that make this
   * campsite this campsite, described in the catalogue and, until they were
   * placed, standing nowhere.
   */
  readonly landmarks?: readonly LandmarkSpec[];
  /** Bearing of the trail in, so signage stands where you come past it. */
  readonly trailBearing?: number;
  /** Where the client's own props already stand, so nothing is placed inside one. */
  readonly occupied?: readonly Occupied[];
}

/** A campsite with nothing on the dial. Silence is a valid radio profile. */
const SILENT_DIAL: RadioProfileSpec = {
  stations: [],
  baseReception: 0.4,
  receptionNote: 'nothing carries this far in',
  betweenStations: 'hiss',
};

/**
 * What the client knows and the simulation cannot derive.
 *
 * Locomotion, the camera and the UI live outside the deterministic core, so
 * the ritual cannot read them; instead the client writes this object once per
 * frame via {@link setPresence} and every world system reads it. Everything
 * here is an *observation*, never a command: nothing in this shape can make an
 * animal appear or a secret surface, it can only describe the night.
 */
export interface PresenceInput {
  /** Player speed, m/s. */
  speed: number;
  /** Where the player is, for flight bearings. */
  position: Vec3;
  /** 0..1 light being swept about — a flashlight looking for something. */
  lightSweep: number;
  /** 0..1 impulse this step: a camera flash, standing up too fast, a shout. */
  startle: number;
  /** 0..1 voices. Multiplayer and spatial voice write this. */
  voices: number;
  /** Named places the player is currently inside. */
  places: string[];
  /** What the player is looking at closely, if anything. */
  inspecting: string | null;
  /** Subjects photographed since the last step. Drained each step. */
  photographed: string[];
  /** Unattended objects an animal might investigate. */
  objects: WildlifeObject[];
  /**
   * Whether the player is sitting down.
   *
   * `PlayerState.seated` lives in locomotion, which the deterministic core
   * cannot read, so the client mirrors it here and the seat model in
   * `sitting.ts` does the rest. Sitting is the strongest generator of
   * stillness in the product (§7), so it has to reach the world systems.
   */
  seated: boolean;
  /** Which seat, when seated. */
  seatId: string | null;
}

function createPresence(): PresenceInput {
  return {
    speed: 0,
    position: vec3(0, 0, 0),
    lightSweep: 0,
    startle: 0,
    voices: 0,
    places: [],
    inspecting: null,
    photographed: [],
    objects: [],
    seated: false,
    seatId: null,
  };
}

/** The order the night moves through. */
const WINDOW_ORDER: readonly ActivityWindow[] = ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'];

/** Real minutes of play before the night moves on one window. */
const WINDOW_SECONDS = 14 * 60;

/**
 * How much of a real night a session carries you across.
 *
 * Six hours over the fifty-six minutes it takes to cross the four window
 * boundaries: late evening when you arrive, first light by the time you are
 * finishing. Deliberately short of a whole night at both ends — the world is
 * always night (§5.5), and a session that ran to sunrise would put the sun up
 * over the campfire, which is the one thing the sky model must never do.
 */
const NIGHT_SPAN_MS = 6 * 3600 * 1000;

/**
 * Where in the night a session starts and where it has got to.
 *
 * 0 is the start of dusk and 1 is full dawn; the windows divide it evenly.
 * The same number drives the sky, the cold, and which animals are about, so
 * they cannot drift apart.
 */
export function nightProgress(startWindow: ActivityWindow, elapsedSeconds: number): number {
  const start = Math.max(0, WINDOW_ORDER.indexOf(startWindow));
  const span = (WINDOW_ORDER.length - 1) * WINDOW_SECONDS;
  return clamp01((start * WINDOW_SECONDS + elapsedSeconds) / span);
}

/**
 * How much colder it is than the weather alone would make it.
 *
 * The cold comes on through the night and is worst just before it gets light,
 * which is both true and the reason a fire matters more at four in the morning
 * than it did at ten. It eases a little at dawn, the way it does.
 */
export function nightChill(progress: number): number {
  return -7.5 * smoothstep(0, 0.82, progress) + 1.8 * smoothstep(0.84, 1, progress);
}

/** Said once, as the night turns over into its next part. */
export function describeWindow(window: ActivityWindow): string | null {
  switch (window) {
    case 'early-night':
      return 'The last of the light has gone out of the sky.';
    case 'deep-night':
      return 'It is properly late now, and properly cold.';
    case 'pre-dawn':
      return 'The coldest part of it. Everything has gone quiet.';
    case 'dawn':
      return 'There is grey in the east. That went quickly.';
    case 'dusk':
    default:
      return null;
  }
}

export interface RitualState {
  stage: RitualStage;
  fire: FireState;
  /** Where the wood is, and what is in your arms. */
  gathering: GatheringState;
  /** The named things at this campsite, and where they turned out to be. */
  landmarks: PlacedLandmark[];
  weather: WeatherState;
  marshmallow: MarshmallowState;
  assembly: AssemblyState;
  machine: MachineState;
  bite: BiteState;
  /** The animals that live here and the ones passing through tonight. */
  wildlife: WildlifeState;
  /** The camp radio. Off until someone switches it on. */
  radio: RadioState;
  /** What this campsite is quietly willing the player to notice. */
  discovery: DiscoveryState;
  /**
   * The water, or null at a dry site.
   *
   * Null is the common case and is never an error: eleven of the twelve
   * launch environments differ on this and three have no water at all.
   */
  water: WaterState | null;
  /** Stones on the shore, and one in the air. */
  skipping: SkippingState;
  /** The torch. Nothing until somebody picks it up off the log. */
  torch: TorchState;
  /** The rod, the float, and a great deal of nothing happening. */
  fishing: FishingState;
  /** Lying back, binoculars, and the actual sky for the actual date. */
  stargazing: StargazingState;
  /** Sitting down, and settling. */
  seat: SeatState;
  /**
   * Whether a throw that genuinely ran has already happened tonight.
   *
   * Internal to the significance model, which is invisible by rule (§6.4).
   * It is a "has this happened before" flag of exactly the kind wildlife keeps
   * in `visits` — not a best, not a tally, and never read by any interface.
   */
  skippedBefore: boolean;
  /** Seconds spent standing at the water's edge. Dwell, for the same model. */
  shoreSeconds: number;
  /**
   * Traces the significance model decided were worth keeping.
   *
   * The score behind each decision is never stored and never surfaced
   * (spec §6.4) — only the disposition, which persistence reads.
   */
  traces: Trace[];
  /** Written by the client once per frame; read by every world system. */
  presence: PresenceInput;
  /** Recent world events, for audio, subtitles and the Passport. Bounded. */
  wildlifeEvents: WildlifeEvent[];
  discoveryEvents: DiscoveryEvent[];
  radioEvents: RadioEvent[];
  skipEvents: SkipEvent[];
  fishingEvents: FishingEvent[];
  skyEvents: StargazingEvent[];
  /**
   * The weather saying what it is about to do, in words, bounded.
   *
   * A change takes the best part of a minute to arrive, so this lands while
   * there is still time to bank the fire and bring the wood in off the stones.
   * That is the whole difference between weather you respond to and weather
   * that happens to you.
   */
  weatherEvents: { at: number; kind: WeatherKind; telling: string }[];
  /** Reused observation object, so discovery allocates nothing per frame. */
  observationScratch: DiscoveryObservation;
  /** Which part of the night it is. */
  window: ActivityWindow;
  /**
   * The part of the night it has just turned into, for one step.
   *
   * The only progression this product has is the night going by, and until
   * this existed the player was never told it had. It is a remark, not a
   * milestone: nothing unlocks, nothing is scored, and staying out is not
   * rewarded — the night simply moves, and you can feel it.
   */
  windowChangedTo: ActivityWindow | null;
  sandwich: SandwichRecord | null;
  /** Where the player is holding the marshmallow. */
  roastInput: RoastInput;
  /** Sandwiches made this session — the index used for record ids. */
  sandwichCount: number;
  /** Seconds since the session began. */
  elapsed: number;
  /**
   * Fixed steps taken. Drives the per-step random streams, so it is part of
   * the simulation's identity and must be replicated, not recomputed.
   */
  tick: number;
  /** Seconds the sandwich has been out of the machine, for melting cues. */
  sandwichAge: number;
  rng: Rng;
  /** The campsite's numeric seed. `options.campsiteSeed` may be a string. */
  readonly seed: number;
  /** Per-subsystem random streams, reseeded each step rather than rebuilt. */
  readonly streams: Map<string, Rng>;
  options: Required<
    Omit<
      RitualOptions,
      'weatherProfile' | 'world' | 'priorVisits' | 'knownSecrets' | 'knownConstellations'
    >
  > & {
    weatherProfile: WeatherProfile;
    world: RitualWorldContent;
  };
  /** Stage-change flag for one step, consumed by audio and UI. */
  stageChangedTo: RitualStage | null;
}

export function createRitual(options: RitualOptions): RitualState {
  const seed = typeof options.campsiteSeed === 'string' ? hashString(options.campsiteSeed) : options.campsiteSeed;
  const rng = new Rng(seed);
  const weatherProfile = options.weatherProfile ?? DEFAULT_WEATHER_PROFILE;
  const weather = createWeather(weatherProfile, rng.split('weather'));
  const world = options.world ?? {};
  const walkableRadiusM = options.walkableRadiusM ?? 13;
  const fireConfig = { ambientC: weather.temperatureC, exposure: weatherProfile.exposure };
  /*
   * A campsite you have used before is found the way you left it.
   *
   * First visit: somebody's fire is going when you walk in, which is the
   * product's opening image and stays exactly as it was. Every visit after
   * that, the pit is yours and it is banked — grey, cold-looking, nothing
   * moving, and two hundred degrees under the ash. Finding that out is the
   * first thing you do, and it is the only opening that could not be had on a
   * first visit, which is the point: it is a reason to come back.
   */
  const returning = (options.visitIndex ?? 1) > 1;
  const fire = returning ? createBankedFire(fireConfig) : createEstablishedFire(fireConfig);
  // Built before the state object so the landmarks can be put at the water.
  const water = world.water ? createWater(world.water, { campsiteSeed: seed, walkableRadiusM }) : null;

  return {
    stage: 'arriving',
    fire,
    landmarks: placeLandmarks({
      landmarks: world.landmarks ?? [],
      radius: walkableRadiusM,
      trailBearing: world.trailBearing ?? 0.69,
      // Stepping stones go at the water, which means the water has to exist
      // before the things that stand beside it are placed.
      ...(water ? { shore: { bearing: water.shore.bearing, distanceM: water.shore.distanceM } } : {}),
      ...(world.occupied ? { occupied: world.occupied } : {}),
      rng: rng.split('landmarks'),
    }),
    gathering: createGathering({
      sources: world.fuel ?? [],
      radius: walkableRadiusM,
      humidity: weather.humidity,
      rng: rng.split('gathering'),
    }),
    weather,
    marshmallow: createMarshmallow(),
    assembly: createAssembly({ assist: options.assemblyAssist ?? 0.5 }),
    machine: createMachine(seed, options.environmentId),
    bite: createBiteState(),
    wildlife: createWildlife({
      campsiteSeed: seed,
      roster: world.wildlife ?? [],
      priorVisits: options.priorVisits,
    }),
    radio: createRadio(world.radio ?? SILENT_DIAL, {
      campsiteSeed: seed,
      // The stations were on the air before anyone arrived.
      startOffsetSeconds: rng.split('radio-clock').range(0, 3600),
    }),
    discovery: createDiscovery({
      campsiteSeed: seed,
      secrets: world.secrets ?? [],
      visitIndex: options.visitIndex ?? 1,
      known: options.knownSecrets,
    }),
    // A dry campsite simply has no water. Every activity that needs it checks
    // first, and none of them treats its absence as a failure.
    water,
    skipping: createSkipping(seed),
    torch: createTorch(),
    fishing: createFishing(),
    stargazing: createStargazing({
      /*
       * Wound back to the start of the night, so the session's own arc runs
       * forward across it rather than sitting at two in the morning forever.
       * `skyEpochMs` is the middle of the night by construction — see
       * `nightEpoch` — so half the span back from it is late evening.
       */
      epochMs:
        (options.skyEpochMs ?? 0) > 0
          ? (options.skyEpochMs as number) -
            NIGHT_SPAN_MS / 2 +
            nightProgress(options.startWindow ?? 'dusk', 0) * NIGHT_SPAN_MS
          : 0,
      // Six hours of sky over fifty-six minutes of session.
      timeScale: NIGHT_SPAN_MS / ((WINDOW_ORDER.length - 1) * WINDOW_SECONDS * 1000),
      latitudeDeg: options.latitudeDeg ?? 44,
      longitudeDeg: options.longitudeDeg ?? -73,
      skyOpenness: world.skyOpenness ?? 0.6,
      known: options.knownConstellations ?? [],
    }),
    seat: createSeat(),
    skippedBefore: false,
    shoreSeconds: 0,
    traces: [],
    presence: createPresence(),
    wildlifeEvents: [],
    discoveryEvents: [],
    radioEvents: [],
    skipEvents: [],
    fishingEvents: [],
    skyEvents: [],
    weatherEvents: [],
    observationScratch: createObservation(),
    window: options.startWindow ?? 'early-night',
    windowChangedTo: null,
    sandwich: null,
    roastInput: { position: vec3(0, 0.45, 0.75), rotation: 0, blow: 0 },
    sandwichCount: 0,
    elapsed: 0,
    tick: 0,
    sandwichAge: 0,
    rng,
    seed,
    streams: new Map(),
    options: {
      campsiteSeed: seed,
      environmentId: options.environmentId,
      assemblyAssist: options.assemblyAssist ?? 0.5,
      autoRotate: options.autoRotate ?? 0,
      now: options.now ?? 0,
      visitIndex: options.visitIndex ?? 1,
      startWindow: options.startWindow ?? 'early-night',
      latitudeDeg: options.latitudeDeg ?? 44,
      longitudeDeg: options.longitudeDeg ?? -73,
      walkableRadiusM,
      skyEpochMs: options.skyEpochMs ?? 0,
      weatherProfile,
      world,
    },
    stageChangedTo: null,
  };
}

/**
 * A named random stream for this step.
 *
 * `Rng.split(name)` derives a child from the parent's *current* state, and
 * nothing in the ritual ever draws from the parent — so splitting the same
 * name every step produced the identical child every step, and every
 * stochastic subsystem was frozen on one sample for the whole session. The
 * tick is mixed in, which restores real variation while keeping each
 * subsystem's stream independent of what the others happened to draw: a
 * roasting step consumes exactly the same fire randomness as a step spent
 * standing in the dark, so replay does not depend on stage order (ADR-0006).
 */
function stream(ritual: RitualState, name: string): Rng {
  const cached = ritual.streams.get(name);
  const seed = mixSeeds(mixSeeds(ritual.seed, hashString(name)), ritual.tick);
  if (cached === undefined) {
    const created = new Rng(seed);
    ritual.streams.set(name, created);
    return created;
  }
  // Re-seeded rather than reallocated: the sequence is identical either way,
  // and the perf harness measures `stepRitual`'s per-step allocation.
  cached.setState(seed);
  return cached;
}

/** Stages that need both hands: roasting, assembling, and the machine. */
function isTwoHanded(stage: RitualStage): boolean {
  return stage === 'roasting' || stage === 'assembling' || stage === 'machine' || stage === 'eating';
}

function setStage(ritual: RitualState, stage: RitualStage): void {
  if (ritual.stage === stage) return;
  ritual.stage = stage;
  ritual.stageChangedTo = stage;
}

/** Advances every subsystem by one fixed timestep. */
export function stepRitual(ritual: RitualState, dt: number = SIM_DT): void {
  ritual.tick++;
  ritual.elapsed += dt;
  ritual.stageChangedTo = null;

  /*
   * The cold coming on.
   *
   * Handed to the weather rather than applied after it, so that the fire, the
   * fuel drying at the pit edge, the audio and anything else reading the
   * temperature all see one number. It is what makes the fire matter more at
   * four in the morning than it did at ten — the same fire, the same wood, a
   * night that has got about eight degrees harder to sit out in.
   */
  ritual.weather.nightChill = nightChill(nightProgress(ritual.options.startWindow, ritual.elapsed));

  // Weather first: it feeds the fire.
  stepWeather(ritual.weather, dt, stream(ritual, 'weather-step'));
  const effect = weatherFireEffect(ritual.weather);
  ritual.fire.config.ambientC = effect.ambientC;
  // The fire is the only thing that knows what rain does to a fire, so the
  // weather hands it the number and stays out of it. Ash sheds most of it,
  // which is why banking is the answer to a shower rather than standing there
  // watching it go out.
  ritual.fire.rain = clamp01(ritual.weather.precipitation);
  if (ritual.weather.changedTo) {
    const telling = describeWeatherChange(ritual.weather.kind, ritual.weather.changedTo);
    if (telling) {
      ritual.weatherEvents.push({
        at: ritual.elapsed,
        kind: ritual.weather.changedTo,
        telling,
      });
      trimTail(ritual.weatherEvents, 32);
    }
  }

  stepFire(ritual.fire, dt, stream(ritual, 'fire'));

  if (ritual.stage === 'roasting') {
    // Accessibility: automatic rotation removes the dexterity requirement
    // without changing what the player can achieve.
    if (ritual.options.autoRotate > 0) {
      ritual.roastInput.rotation += ritual.options.autoRotate * dt;
    }
    stepRoast(ritual.marshmallow, ritual.fire, ritual.roastInput, dt, stream(ritual, 'roast'));
  }

  if (ritual.stage === 'assembling') {
    stepAssembly(ritual.assembly, dt, stream(ritual, 'assembly'));
  }

  if (ritual.stage === 'machine' || ritual.stage === 'reveal') {
    stepMachine(ritual.machine, dt);
    // The sandwich exists the moment the machine finishes, but the player
    // does not see it until the door opens — the reveal happens in world.
    if (ritual.machine.stage === 'revealed' && !ritual.sandwich) {
      ritual.sandwich = buildSandwich(ritual);
      setStage(ritual, 'reveal');
    }
  }

  if (ritual.stage === 'eating' || ritual.stage === 'after') {
    ritual.sandwichAge += dt;
  }

  stepWorld(ritual, dt);
}

/* -------------------------------------------------------------------------- */
/* The world around the ritual                                                */
/* -------------------------------------------------------------------------- */

// Reused every step so the world systems allocate nothing per frame.
const wildlifeScratch: WildlifeInput = createWildlifeInput();
const radioScratch: { weather: RadioConditions['weather']; machineNoise: number } = {
  weather: undefined,
  machineNoise: 0,
};
// Mutable so the fishing model allocates nothing per frame either.
const fishingScratch: { -readonly [K in keyof FishingConditions]: FishingConditions[K] } = {
  window: 'early-night',
  calm: 0,
  precipitation: 0,
  disturbance: 0,
};

/** How loud the SM-01 is right now, 0..1. */
export function machineNoise(machine: MachineState): number {
  return clamp01(machine.compressor * 0.75 + machine.fan * 0.3 + machine.vapour * 0.2);
}

/**
 * Which part of the night it is.
 *
 * A session drifts forward through the windows rather than sitting in one:
 * stay out long enough and the animals that come change, which is the only
 * "progression" this product has and is never announced.
 */
export function windowAt(startWindow: ActivityWindow, elapsedSeconds: number): ActivityWindow {
  const start = Math.max(0, WINDOW_ORDER.indexOf(startWindow));
  const advanced = Math.floor(elapsedSeconds / WINDOW_SECONDS);
  const index = Math.min(WINDOW_ORDER.length - 1, start + advanced);
  return WINDOW_ORDER[index] ?? startWindow;
}

/**
 * The cues the world is giving off this step.
 *
 * Everything here is derived from state that already exists — a fire that is
 * actually burning, a machine that is actually running, a marshmallow that is
 * actually hot. Nothing is set because a stage says so, which is why walking
 * away from a roaring fire genuinely quietens the camp.
 */
export function worldCues(ritual: RitualState, out: WildlifeCueField = {}): WildlifeCueField {
  const fire = ritual.fire;
  const weather = ritual.weather;
  const machine = ritual.machine;
  const reception = ritual.radio.reception;

  out.firelight = clamp01(fire.flame * 1.2);
  out['ember-glow'] = clamp01((fire.emberTemp - 200) / 600) * clamp01(fire.emberMass * 2);
  out.smoke = clamp01(fire.smoke);
  out.warmth = clamp01(fire.flame * 0.6 + clamp01(fire.emberMass * 1.5) * 0.4);
  // Sugar that is browning is sugar you can smell from thirty metres.
  out['marshmallow-smell'] = ritual.stage === 'roasting' ? browningSmell(ritual.marshmallow) : 0;
  out['food-smell'] = clamp01(
    Math.max(out['marshmallow-smell'] ?? 0, ritual.stage === 'assembling' ? 0.45 : 0),
  );
  out.crumbs = ritual.stage === 'eating' || ritual.stage === 'after' ? 0.6 : 0;
  // The torch is the real source now. `presence.lightSweep` is still honoured
  // so a caller with its own light (a headlamp, another player's torch) can
  // contribute, but the client no longer has to invent this number — and no
  // longer invents it from walking speed, which frightened the wildlife with a
  // torch that was switched off.
  out.flashlight = clamp01(Math.max(ritual.presence.lightSweep, torchCue(ritual.torch)));
  out['radio-music'] = ritual.radio.on ? clamp01(reception.clarity * ritual.radio.volume) : 0;
  out.voices = clamp01(ritual.presence.voices);
  out.footsteps = clamp01(ritual.presence.speed / 1.6);
  out['machine-hum'] = clamp01(machine.fan * 0.8 + machine.compressor * 0.4);
  out['compressor-noise'] = clamp01(machine.compressor);
  out['vapour-plume'] = clamp01(machine.vapour);
  out.rain = clamp01(weather.precipitation);
  out.wind = clamp01(weather.windSpeed / 9);
  out['cold-air'] = clamp01((8 - weather.temperatureC) / 18);
  out['open-sky'] = clamp01(1 - weather.cloudCover * 0.95) * (ritual.options.world.skyOpenness ?? 0.6);
  out.moonlight = clamp01((1 - weather.cloudCover) * ritual.stargazing.sky.moon.illumination * 0.9);
  // Water cues, for the species that live at the edge of it. Absent entirely
  // at a dry site, which is exactly right: nothing is drawn to a water's edge
  // that is not there.
  const water = ritual.water;
  out['water-edge'] = water ? 1 : 0;
  out.splashing = water ? clamp01(splashing(ritual)) : 0;
  return out;
}

/**
 * 0..1 how much the water is being disturbed by us right now.
 *
 * A stone in the air, a float going in, a fish being played. Derived from
 * state that is actually true rather than set because an activity is open —
 * the same discipline as the rest of `worldCues`.
 */
function splashing(ritual: RitualState): number {
  const water = ritual.water;
  if (!water) return 0;
  let strongest = 0;
  for (const ripple of water.ripples) {
    const presence = clamp01(1 - ripple.age / 6) * ripple.strength;
    if (presence > strongest) strongest = presence;
  }
  return strongest;
}

function stepWorld(ritual: RitualState, dt: number): void {
  const presence = ritual.presence;
  const previousWindow = ritual.window;
  ritual.window = windowAt(ritual.options.startWindow, ritual.elapsed);
  ritual.windowChangedTo = ritual.window === previousWindow ? null : ritual.window;

  if (presence.places.includes('water-edge')) ritual.shoreSeconds += dt;

  // --- sitting -------------------------------------------------------------
  // Stepped before the wildlife, because settling is an input to it. The seat
  // follows the client's `seated` flag rather than owning it, so the one place
  // that decides whether the player is sitting is still locomotion.
  if (presence.seated && !ritual.seat.seated) sitDownAction(ritual.seat, presence.seatId);
  else if (!presence.seated && ritual.seat.seated) standUpAction(ritual.seat);
  stepSeat(ritual.seat, dt, ritual.wildlife.disturbance);

  // --- the torch -----------------------------------------------------------
  //
  // You cannot hold a torch and a marshmallow, and you cannot work the SM-01's
  // latch one-handed with a light in the other. Entering a stage that has both
  // your hands in it puts the torch back on the log, which is a real
  // constraint rather than a render trick — the wildlife cue, the HUD and the
  // renderer all stop seeing it at the same moment, and the shader stops
  // carrying an eleventh dynamic light through the reveal.
  if (ritual.torch.held && isTwoHanded(ritual.stage)) stowTorch(ritual.torch);

  // Its sweep is measured from the aim it was actually given, and feeds the
  // `flashlight` cue through `worldCues`.
  stepTorch(ritual.torch, dt);

  // --- the water -----------------------------------------------------------
  if (ritual.water) stepWater(ritual.water, dt, ritual.weather);

  // --- a stone in the air --------------------------------------------------
  if (ritual.water) stepSkipping(ritual.skipping, dt, ritual.water);

  // --- the sky -------------------------------------------------------------
  stepStargazing(
    ritual.stargazing,
    dt,
    { cloudCover: ritual.weather.cloudCover },
    stream(ritual, 'stargazing'),
  );

  // --- the line in the water ----------------------------------------------
  if (ritual.water) {
    fishingScratch.window = ritual.window;
    fishingScratch.calm = ritual.wildlife.calm;
    fishingScratch.precipitation = ritual.weather.precipitation;
    fishingScratch.disturbance = ritual.wildlife.disturbance;
    stepFishing(ritual.fishing, dt, ritual.water, fishingScratch, stream(ritual, 'fishing'));
  }

  // --- radio ---------------------------------------------------------------
  radioScratch.weather = ritual.weather;
  radioScratch.machineNoise = machineNoise(ritual.machine);
  stepRadio(ritual.radio, dt, radioScratch);

  // --- wildlife ------------------------------------------------------------
  wildlifeScratch.playerSpeed = presence.speed;
  wildlifeScratch.playerPosition = presence.position;
  wildlifeScratch.lightSweep = clamp01(presence.lightSweep);
  wildlifeScratch.startle = clamp01(presence.startle);
  wildlifeScratch.window = ritual.window;
  wildlifeScratch.objects = presence.objects;
  wildlifeScratch.weather = ritual.weather;
  // Sitting is the strongest stillness there is, and it settles the camp
  // around you as well as settling you (spec §7).
  wildlifeScratch.stillnessRate = stillnessGain(ritual.seat);
  wildlifeScratch.settleRate = settlingGain(ritual.seat);
  wildlifeScratch.cues = worldCues(ritual, wildlifeScratch.cues as WildlifeCueField);
  // Broadband noise the animals hear as one thing: us, the radio, the machine.
  wildlifeScratch.noise = clamp01(
    (wildlifeScratch.cues['radio-music'] ?? 0) * 0.7 +
      (wildlifeScratch.cues['compressor-noise'] ?? 0) * 0.8 +
      (wildlifeScratch.cues.voices ?? 0) * 0.6 +
      (wildlifeScratch.cues.footsteps ?? 0) * 0.4,
  );
  stepWildlife(ritual.wildlife, wildlifeScratch, dt, stream(ritual, 'wildlife'));

  // --- discovery -----------------------------------------------------------
  const observation = ritual.observationScratch;
  observation.places = presence.places;
  observation.stillnessSeconds = ritual.wildlife.stillnessSeconds;
  observation.weatherKind = ritual.weather.kind;
  observation.skyEvent = ritual.weather.skyEvent;
  observation.radio = ritual.radio.on
    ? {
        stationId: ritual.radio.reception.stationId,
        dial: ritual.radio.dial,
        band: ritual.radio.band,
        clarity: ritual.radio.reception.clarity,
      }
    : null;
  observation.photographed = presence.photographed;
  observation.wildlife = ritual.wildlife.animals.map((animal) => ({
    speciesId: animal.species.id,
    persistent: animal.individual.persistent,
  }));
  observation.inspecting = presence.inspecting;
  observation.window = ritual.window;
  observation.fireIntensity = clamp01(ritual.fire.flame);
  stepDiscovery(ritual.discovery, observation, dt, stream(ritual, 'discovery'));

  harvestWorldEvents(ritual);

  // One-step inputs are consumed, not latched: a camera flash startles once.
  presence.startle = 0;
  if (presence.photographed.length > 0) presence.photographed = [];
}

/**
 * Turns this step's world events into traces.
 *
 * The significance model decides; nothing here inspects the score it used, and
 * `Trace` carries only a disposition and a lifetime. A `fade` trace is still
 * created — a faint mark in the grass is part of the world too.
 */
function harvestWorldEvents(ritual: RitualState): void {
  const now = ritual.options.now + ritual.elapsed * 1000;

  for (const event of drainWildlifeEvents(ritual.wildlife)) {
    ritual.wildlifeEvents.push(event);
    if (event.kind !== 'appeared' && event.kind !== 'left-trace') continue;
    ritual.traces.push(
      createTrace(
        `wildlife:${event.individualId}:${Math.round(event.at * 60)}`,
        wildlifeEvidence(event, {
          photographed: ritual.presence.photographed.includes(event.speciesId),
        }),
        now,
        {
          speciesId: event.speciesId,
          speciesLabel: event.speciesLabel,
          individualId: event.individualId,
          trace: event.trace,
          visits: event.visits,
        },
      ),
    );
  }

  for (const event of drainDiscoveryEvents(ritual.discovery)) {
    ritual.discoveryEvents.push(event);
    if (event.kind !== 'discovered') continue;
    ritual.traces.push(
      createTrace(`secret:${event.secretId}`, discoveryEvidence(event), now, {
        secretId: event.secretId,
        title: event.title,
        telling: event.telling,
        evidence: event.evidence,
      }),
    );
  }

  ritual.radioEvents.push(...drainRadioEvents(ritual.radio));

  // --- a stone --------------------------------------------------------------
  // A throw becomes a trace when it ends, and only when it ends: the skips
  // themselves are sounds, not memories.
  for (const event of drainSkipEvents(ritual.skipping)) {
    ritual.skipEvents.push(event);
    if (event.kind !== 'sunk' && event.kind !== 'shore') continue;
    const summary = summariseSkip(ritual.skipping);
    ritual.traces.push(
      createTrace(
        `skip:${ritual.skipping.throws}:${Math.round(event.at)}`,
        skipEvidence(summary, {
          // The first throw of the night that genuinely ran. Not a best, not a
          // tally — the same question wildlife asks with `visits`.
          isFirst: summary.skips >= 3 && !ritual.skippedBefore,
          interactionCount: Math.max(1, ritual.skipping.throws),
          duringWorldEvent: ritual.weather.skyEvent !== 'none',
          photographed: ritual.presence.photographed.includes('water'),
          // Time spent at the water, not time the stone was airborne — the
          // evening is the thing, not the throw.
          dwellSeconds: ritual.shoreSeconds,
        }),
        now,
        {
          skips: summary.skips,
          distanceM: summary.distanceM,
          telling: summary.telling,
          water: ritual.water ? ritual.water.spec.label : null,
          window: ritual.window,
        },
      ),
    );
    if (summary.skips >= 3) ritual.skippedBefore = true;
  }

  // --- the sky --------------------------------------------------------------
  for (const event of drainStargazingEvents(ritual.stargazing)) {
    ritual.skyEvents.push(event);
    if (event.kind !== 'recognised' && event.kind !== 'meteor-seen') continue;
    ritual.traces.push(
      createTrace(
        `sky:${event.kind}:${event.subjectId ?? Math.round(event.at * 60)}`,
        stargazingEvidence(event, { dwellSeconds: ritual.stargazing.lookingSeconds }),
        now,
        { subjectId: event.subjectId, label: event.label, telling: describeSkyMoment(event) },
      ),
    );
  }

  // --- the line -------------------------------------------------------------
  for (const event of drainFishingEvents(ritual.fishing)) {
    ritual.fishingEvents.push(event);
    if (event.kind !== 'landed') continue;
    const caught = ritual.fishing.caught[ritual.fishing.caught.length - 1];
    ritual.traces.push(
      createTrace(
        `fish:${Math.round(event.at * 60)}`,
        fishingEvidence(event, {
          isFirst: ritual.fishing.caught.length <= 1,
          interactionCount: Math.max(1, ritual.fishing.casts),
          dwellSeconds: caught ? caught.playedSeconds : 0,
        }),
        now,
        { label: event.label, telling: caught ? describeCatch(caught) : event.label },
      ),
    );
  }

  // Event logs are readouts for audio and the UI, not history: they are bound
  // so a long session cannot grow them without limit.
  trimTail(ritual.wildlifeEvents, 64);
  trimTail(ritual.discoveryEvents, 64);
  trimTail(ritual.radioEvents, 64);
  trimTail(ritual.skipEvents, 64);
  trimTail(ritual.fishingEvents, 64);
  trimTail(ritual.skyEvents, 64);
}

function trimTail(list: unknown[], limit: number): void {
  if (list.length > limit) list.splice(0, list.length - limit);
}

/** 0..1 how strongly the marshmallow currently smells of caramel. */
function browningSmell(marshmallow: MarshmallowState): number {
  let strongest = 0;
  for (const patch of marshmallow.patches) {
    const value = patch.brown + patch.aflame * 0.5;
    if (value > strongest) strongest = value;
  }
  return clamp01(strongest);
}

function buildSandwich(ritual: RitualState): SandwichRecord {
  ritual.sandwichCount++;
  return deriveSandwich({
    roast: summariseRoast(ritual.marshmallow),
    assembly: summariseAssembly(ritual.assembly),
    machine: recordRun(ritual.machine),
    environmentId: ritual.options.environmentId,
    campsiteSeed: ritual.options.campsiteSeed,
    createdAt: ritual.options.now + ritual.elapsed * 1000,
    index: ritual.sandwichCount,
  });
}

// --- Player intents --------------------------------------------------------
// Each is a small, replicable action (ADR-0006): multiplayer sends these, not
// simulation state.

export function arrive(ritual: RitualState): void {
  setStage(ritual, 'at-fire');
}

/** Everything a player can do to a fire with their hands. */
export type FireAction =
  | { type: 'add-log'; woodId: string; grade?: FuelGrade; spot?: LogPlacement; moisture?: number }
  /** Arranging: the drag that moves one piece of fuel, or tips it up. */
  | { type: 'move-log'; logId: string; spot: Partial<LogSpot> }
  | { type: 'rake' }
  /** Raking ash up over the coals, against rain or against tomorrow. */
  | { type: 'bank'; strength?: number }
  | { type: 'fan'; strength?: number };

export function tendFire(ritual: RitualState, action: FireAction): void {
  if (action.type === 'add-log') {
    const log = addLog(ritual.fire, action.woodId, {
      ...(action.grade === undefined ? {} : { grade: action.grade }),
      ...(action.spot === undefined ? {} : { spot: action.spot }),
      ...(action.moisture === undefined ? {} : { moisture: action.moisture }),
    });
    if (action.moisture === undefined) {
      // Wet weather means the wood you find is damp.
      const effect = weatherFireEffect(ritual.weather);
      log.moisture = clamp01(log.moisture + effect.fuelMoisture * 0.4);
    }
  } else if (action.type === 'move-log') {
    repositionLog(ritual.fire, action.logId, action.spot);
  } else if (action.type === 'rake') {
    rakeEmbers(ritual.fire, 1);
  } else if (action.type === 'bank') {
    bankFire(ritual.fire, action.strength ?? 1);
  } else {
    fanFire(ritual.fire, action.strength ?? 1);
  }
  if (ritual.stage === 'arriving') setStage(ritual, 'at-fire');
}

/**
 * Picking up one piece of wood from a place that has wood.
 *
 * Returns what happened rather than throwing or silently doing nothing: the
 * interface needs to be able to say "your arms are full" and "there is nothing
 * left here", and it needs the catalogue's sentence about this place the first
 * time you take something from it.
 */
/**
 * What the world is offering, given what is in the player's hands.
 *
 * `focused` answers "what is nearest and most looked at", which is right for
 * almost everything and wrong for exactly one case: a player who has carried
 * an armful of wood across the clearing and is standing over the pit did not
 * do that in order to be offered a marshmallow. Hands full of firewood, the
 * fire wins.
 *
 * Lives here rather than in `locomotion` because it is the only reach rule
 * that depends on the ritual, and both the interface and the world loop have
 * to agree about it or the prompt and the act would say different things.
 */
export function offered(
  ritual: RitualState,
  player: PlayerState,
  world: WalkableWorld,
): Interactable | null {
  if (ritual.gathering.armful.length > 0) {
    for (const candidate of reachable(player, world)) {
      if (candidate.interactable.id === 'fire') return candidate.interactable;
    }
  }
  return focused(player, world);
}

/**
 * Walking up to one of the named things at this campsite.
 *
 * Returns the catalogue's own sentence about it, once. The second time you
 * come to the bear box you get its name and nothing else, because you have
 * already been told what it is and being told again is how a world stops
 * feeling like a place and starts feeling like a database.
 */
export function visitLandmark(ritual: RitualState, id: string): { label: string; telling: string | null } | null {
  const landmark = landmarkAt(ritual.landmarks, id);
  if (!landmark) return null;
  const telling = landmark.introduced ? null : landmark.note;
  landmark.introduced = true;
  if (ritual.stage === 'arriving') setStage(ritual, 'at-fire');
  return { label: landmark.label, telling };
}

export function gatherFuel(ritual: RitualState, patchId: string): GatherResult {
  const result = gatherFrom(ritual.gathering, patchId);
  if (result.taken && ritual.stage === 'arriving') setStage(ritual, 'at-fire');
  return result;
}

/**
 * Laying a piece from your arms onto the fire.
 *
 * The wood you are holding is wood you went and got, and it is as wet as the
 * place you got it from — so this is the path by which a wet slope's deadfall
 * actually behaves like a wet slope's deadfall. Everything else about it goes
 * through the same `add-log` the woodpile uses.
 */
export function layFuel(
  ritual: RitualState,
  options: { id?: string; spot?: LogPlacement } = {},
): Log | null {
  const piece = takeFromArmful(ritual.gathering, options.id);
  if (!piece) return null;
  tendFire(ritual, {
    type: 'add-log',
    woodId: piece.woodId,
    grade: piece.grade,
    moisture: piece.moisture,
    ...(options.spot ? { spot: options.spot } : {}),
  });
  const logs = ritual.fire.logs;
  return logs[logs.length - 1] ?? null;
}

export function beginRoasting(ritual: RitualState): void {
  ritual.marshmallow = createMarshmallow();
  setStage(ritual, 'roasting');
}

/** Positions the marshmallow. This is the core tactile input. */
export function moveMarshmallow(ritual: RitualState, position: Vec3, rotation: number, blow = 0): void {
  ritual.roastInput.position.x = position.x;
  ritual.roastInput.position.y = position.y;
  ritual.roastInput.position.z = position.z;
  if (ritual.options.autoRotate <= 0) ritual.roastInput.rotation = rotation;
  ritual.roastInput.blow = clamp01(blow);
}

export function blowOutMarshmallow(ritual: RitualState): boolean {
  return blowOut(ritual.marshmallow);
}

/**
 * Finishes roasting and moves to assembly. A fallen marshmallow simply means
 * taking another one — never a restart (spec §4.2).
 */
export function finishRoasting(ritual: RitualState): boolean {
  if (ritual.marshmallow.fallen) {
    beginRoasting(ritual);
    return false;
  }
  const summary = summariseRoast(ritual.marshmallow);
  // Peak surface temperature drives how much the chocolate softens.
  ritual.assembly = createAssembly({
    assist: ritual.options.assemblyAssist,
    marshmallowTempC: clamp(summary.peakTempC, 20, 260),
  });
  setStage(ritual, 'assembling');
  return true;
}

export function holdComponent(ritual: RitualState, kind?: ComponentKind): ComponentKind | null {
  return pickUp(ritual.assembly, kind);
}

export function moveComponent(ritual: RitualState, offset: Vec3, rotation: number): void {
  moveHeld(ritual.assembly, offset, rotation);
}

export function placeComponent(ritual: RitualState): boolean {
  const placed = place(ritual.assembly, stream(ritual, 'place'));
  if (!placed) return false;
  if (assemblyComplete(ritual.assembly)) setStage(ritual, 'machine');
  return true;
}

export function pendingComponent(ritual: RitualState): ComponentKind | null {
  return nextComponent(ritual.assembly);
}

export function operateMachine(ritual: RitualState, action: MachineAction): boolean {
  if (ritual.stage !== 'machine' && ritual.stage !== 'reveal' && ritual.stage !== 'after') {
    setStage(ritual, 'machine');
  }
  return performAction(ritual.machine, action);
}

/** Takes the sandwich off the tray and moves to eating. */
export function takeSandwich(ritual: RitualState): SandwichRecord | null {
  if (!ritual.sandwich) return null;
  performAction(ritual.machine, { type: 'take-sandwich' });
  ritual.bite = createBiteState();
  ritual.sandwichAge = 0;
  setStage(ritual, 'eating');
  return ritual.sandwich;
}

export function bite(ritual: RitualState, position: number): BiteState | null {
  if (!ritual.sandwich) return null;
  const state = takeBite(ritual.bite, ritual.sandwich, position, stream(ritual, 'bite'));
  if (state.finished) setStage(ritual, 'after');
  return state;
}

/* -------------------------------------------------------------------------- */
/* World intents                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Writes what the client knows into the simulation.
 *
 * Called once per frame with whatever changed. Fields left out keep their
 * previous value, except `startle` and `photographed`, which are one-step
 * impulses the step consumes.
 */
export function setPresence(ritual: RitualState, update: Partial<PresenceInput>): void {
  const presence = ritual.presence;
  if (update.speed !== undefined) presence.speed = update.speed;
  if (update.position) {
    presence.position.x = update.position.x;
    presence.position.y = update.position.y;
    presence.position.z = update.position.z;
  }
  if (update.lightSweep !== undefined) presence.lightSweep = clamp01(update.lightSweep);
  if (update.voices !== undefined) presence.voices = clamp01(update.voices);
  if (update.startle !== undefined) presence.startle = Math.max(presence.startle, clamp01(update.startle));
  if (update.places) presence.places = [...update.places];
  if (update.inspecting !== undefined) presence.inspecting = update.inspecting;
  if (update.objects) presence.objects = [...update.objects];
  if (update.seated !== undefined) presence.seated = update.seated;
  if (update.seatId !== undefined) presence.seatId = update.seatId;
  if (update.photographed) presence.photographed = [...presence.photographed, ...update.photographed];
}

/**
 * Records that something was photographed.
 *
 * The flash is what startles: taking a picture of a shy animal is a real
 * trade, and the model makes it one rather than warning about it.
 */
export function photograph(ritual: RitualState, subjects: readonly string[], flash = false): void {
  if (subjects.length === 0) return;
  ritual.presence.photographed = [...ritual.presence.photographed, ...subjects];
  if (flash) ritual.presence.startle = 1;
}

/* -------------------------------------------------------------------------- */
/* Secondary activities (spec §5.2)                                           */
/*                                                                            */
/* Every one of these is reached by walking up to a thing and touching it —   */
/* there is no activity menu, and none of these intents opens one. They are   */
/* the same shape as `tendFire` and `turnRadioDial`: small, replicable player */
/* actions (ADR-0006), and nothing here gates, scores or unlocks anything.    */
/* -------------------------------------------------------------------------- */

// --- Sitting ---------------------------------------------------------------

/**
 * Sits down.
 *
 * The client owns `PlayerState.seated`; this mirrors it into the world systems
 * so the seat model can settle. Called from `setPresence` as well, so a client
 * that only writes presence still gets the whole mechanic.
 */
export function sitOnSeat(ritual: RitualState, seatId: string | null = 'log-seat'): void {
  ritual.presence.seated = true;
  ritual.presence.seatId = seatId;
  sitDownAction(ritual.seat, seatId);
}

export function standFromSeat(ritual: RitualState): void {
  ritual.presence.seated = false;
  ritual.presence.seatId = null;
  standUpAction(ritual.seat);
}

// --- The torch -------------------------------------------------------------

/** Picks the torch up off the log. It comes on with it. */
export function takeTorchFromLog(ritual: RitualState): void {
  takeTorch(ritual.torch);
}

/** Puts it back. */
export function putTorchDown(ritual: RitualState): void {
  stowTorch(ritual.torch);
}

/** The switch. Returns whether it is now lit. */
export function toggleTorch(ritual: RitualState, on?: boolean): boolean {
  return switchTorch(ritual.torch, on);
}

/**
 * Points the beam. Absolute yaw/pitch in the world's frame.
 *
 * The client calls this once per frame with where the player is looking; the
 * torch model measures the sweep from it, which is what the wildlife feel.
 */
export function pointTorch(ritual: RitualState, yaw: number, pitch: number): void {
  aimTorchAction(ritual.torch, yaw, pitch);
}

/** Twists the head from flood to spot. */
export function setTorchFocus(ritual: RitualState, focus: number): void {
  focusTorchAction(ritual.torch, focus);
}

// --- Stone skipping --------------------------------------------------------

/** Whether there is water here worth throwing a stone at. */
export function stonesCanSkip(ritual: RitualState): boolean {
  return ritual.water !== null && canSkipStones(ritual.water.spec);
}

/** Picks a stone up off the shore. Omitting the id takes the next one along. */
export function takeStone(ritual: RitualState, stoneId?: string): Stone | null {
  if (!stonesCanSkip(ritual)) return null;
  return pickUpStone(ritual.skipping, stoneId);
}

/**
 * Throws it.
 *
 * `from` is the hand. Returns false when there is no water, nothing in hand,
 * or one already in the air — never because the throw was a bad one, because
 * there is no such thing (§5.2, and the same rule as a fallen marshmallow).
 */
export function skipStone(ritual: RitualState, input: ThrowInput, from: Vec3): boolean {
  const water = ritual.water;
  if (!water || !canSkipStones(water.spec)) return false;
  const thrown = throwStoneAction(ritual.skipping, input, from, water);
  if (thrown) {
    // A thrown stone is a noise at the water's edge, whatever it does next.
    ritual.presence.startle = Math.max(ritual.presence.startle, 0.12);
  }
  return thrown;
}

// --- Fishing ---------------------------------------------------------------

/** Whether there is anything in this water to catch. */
export function waterHoldsFish(ritual: RitualState): boolean {
  return ritual.water !== null && canFish(ritual.water.spec);
}

/** Picks the rod up off the log. */
export function takeFishingRod(ritual: RitualState): void {
  if (waterHoldsFish(ritual)) takeRod(ritual.fishing);
}

/** Leans it back. Anything on the line simply goes, at no cost. */
export function stowFishingRod(ritual: RitualState): void {
  stowRod(ritual.fishing);
}

/** Casts. There is no target and no accuracy requirement. */
export function castLine(ritual: RitualState, power: number, bearing: number): boolean {
  const water = ritual.water;
  if (!water || !canFish(water.spec)) return false;
  return castAction(ritual.fishing, water, power, bearing);
}

/** Strikes. Missing costs nothing at all. */
export function strikeLine(ritual: RitualState): boolean {
  return strike(ritual.fishing);
}

/** Winds in, or gives line. `pull` 0..1. */
export function playLine(ritual: RitualState, pull: number, dt: number = SIM_DT): void {
  playFish(ritual.fishing, pull, dt);
}

/** Puts it back in the water. The only thing you can do with one. */
export function releaseCatch(ritual: RitualState): void {
  releaseFish(ritual.fishing);
}

// --- Stargazing ------------------------------------------------------------

/** Lies back, or gets up. */
export function lieBack(ritual: RitualState, reclined = true): void {
  setPosture(ritual.stargazing, reclined ? 'reclined' : 'standing');
}

/** Raises or lowers the binoculars. */
export function raiseBinoculars(ritual: RitualState, up: boolean): void {
  setBinocularsAction(ritual.stargazing, up);
}

/** Looks at a patch of sky. Azimuth from north and altitude, radians. */
export function lookAtSky(ritual: RitualState, azimuth: number, altitude: number): void {
  aimSkyAction(ritual.stargazing, azimuth, altitude);
}

/** Ripples the surface directly — a hand in the water, a dropped stick. */
export function touchWater(ritual: RitualState, x: number, z: number, strength = 0.4): void {
  if (ritual.water) disturbWater(ritual.water, x, z, strength);
}

export function toggleRadio(ritual: RitualState, on?: boolean): boolean {
  const next = on ?? !ritual.radio.on;
  setRadioPower(ritual.radio, next);
  return ritual.radio.on;
}

/** Turns the dial by a delta in dial units — the tactile input. */
export function turnRadioDial(ritual: RitualState, amount: number): void {
  turnDial(ritual.radio, amount);
}

/** Sets the dial absolutely. Used by the keyboard path and by replay. */
export function setRadioDial(ritual: RitualState, dial: number): void {
  tuneTo(ritual.radio, dial);
}

export function setRadioBand(ritual: RitualState, band: RadioBand): void {
  setBand(ritual.radio, band);
}

export function setRadioVolume(ritual: RitualState, volume: number): void {
  ritual.radio.volume = clamp01(volume);
}

/**
 * What the radio is receiving right now, weather and machine noise included.
 *
 * Allocates. `stepWorld` has already computed exactly this into
 * `ritual.radio.reception` for the current step, so a per-frame caller — the
 * audio bridge, principally — should read that field instead of calling this
 * (ARCHITECTURE §10: no per-frame allocation). This exists for callers asking
 * a one-off question, and for tests.
 */
export function radioReadout(ritual: RitualState): RadioReadout {
  return receptionAt(ritual.radio, {
    weather: ritual.weather,
    machineNoise: machineNoise(ritual.machine),
  });
}

/** The reception the current step actually used. Allocates nothing. */
export function currentReception(ritual: RitualState): RadioReadout {
  return ritual.radio.reception;
}

/**
 * The animals in the world right now, nearest first.
 *
 * Allocates a copy and sorts it. Use {@link animalsPresentInto} on a per-frame
 * path; `ritual.wildlife.animals` is the live array if order does not matter.
 */
export function animalsPresent(ritual: RitualState): readonly WildlifeAnimal[] {
  return presentAnimals(ritual.wildlife);
}

/**
 * The same list, written into an array the caller owns.
 *
 * The array is reused between frames, so a caller holding it must not keep a
 * reference to its contents past the frame.
 */
export function animalsPresentInto(ritual: RitualState, out: WildlifeAnimal[]): WildlifeAnimal[] {
  out.length = 0;
  for (const animal of ritual.wildlife.animals) out.push(animal);
  out.sort((a, b) => a.distanceM - b.distanceM);
  return out;
}

// --- Readouts --------------------------------------------------------------

export interface RitualSignals {
  fire: FireSignals;
  stage: RitualStage;
  roast: RoastSummary | null;
  assembly: AssemblySummary | null;
  machineProgress: number;
  weatherLabel: string;
  wildlife: WildlifeSignals;
  discovery: DiscoverySignals;
  window: ActivityWindow;
  /** 0..1 what the radio is actually delivering. 0 when it is off. */
  radioClarity: number;
  radioStationName: string | null;
  /** The sky, as far as anyone standing here can tell. */
  sky: SkySignals;
  /** The line in the water, or null where there is none. */
  fishing: FishingSignals | null;
  /** How the water is behaving, in words. Null at a dry site. */
  waterLabel: string | null;
  /** True while the torch is lit. */
  torchOn: boolean;
  /** 0..1 how settled a seated player is. Never rendered as a number. */
  settled: number;
}

export function ritualSignals(ritual: RitualState): RitualSignals {
  return {
    fire: fireSignals(ritual.fire),
    stage: ritual.stage,
    roast: ritual.stage === 'roasting' || ritual.stage === 'assembling' ? summariseRoast(ritual.marshmallow) : null,
    assembly: ritual.stage === 'assembling' ? summariseAssembly(ritual.assembly) : null,
    machineProgress: ritual.machine.progress,
    weatherLabel: ritual.weather.kind,
    wildlife: wildlifeSignals(ritual.wildlife),
    discovery: discoverySignals(ritual.discovery),
    window: ritual.window,
    radioClarity: ritual.radio.on ? ritual.radio.reception.clarity : 0,
    radioStationName: ritual.radio.on ? ritual.radio.reception.stationName : null,
    sky: skySignals(ritual.stargazing, ritual.weather.cloudCover),
    fishing: ritual.water ? fishingSignals(ritual.fishing) : null,
    waterLabel: ritual.water ? describeWater(ritual.water) : null,
    torchOn: ritual.torch.held && ritual.torch.on,
    settled: ritual.seat.settled,
  };
}

/**
 * Runs the whole ritual headlessly from a scripted timeline.
 *
 * This is how the loop is proven without a browser, and how roasting is tuned
 * (risk R1) — drive real input timelines and inspect the outcome spread.
 */
export interface ScriptedStep {
  /** Seconds to advance before applying the action. */
  wait?: number;
  action?: (ritual: RitualState) => void;
}

export function runScript(ritual: RitualState, steps: readonly ScriptedStep[]): RitualState {
  for (const step of steps) {
    const seconds = step.wait ?? 0;
    const count = Math.round(seconds / SIM_DT);
    for (let i = 0; i < count; i++) stepRitual(ritual, SIM_DT);
    step.action?.(ritual);
  }
  return ritual;
}
