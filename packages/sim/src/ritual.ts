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
  strikeSpark,
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
import { NEW_HEARTH, restHearth, wakeFire, wetnessOf, type Hearth } from './hearth.js';
import { rememberOffering, type Familiarity } from './familiarity.js';
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
  type MachineFlavourSpec,
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
  createPlace,
  stepPlace,
  type PlaceNotes,
  type PlaceState,
  type PlaceConditions,
} from './place.js';
import { placeCurios, curioAt, type PlacedCurio } from './curios.js';
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
import { sunState } from './astronomy.js';
import { createEvidence, createTrace, type Trace } from './significance.js';
import { rollVariations, type SeededVariationSpec, type VariationSet } from './variation.js';
import {
  tonightsStillness,
  varyRadioProfile,
  varyRoster,
  varyWater,
  varyWeatherProfile,
} from './tonight.js';
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
  /**
   * The pit as this player left it, and how long ago.
   *
   * Omitted on a first night, and omitted by every caller that has no memory
   * to restore — a test, a link somebody shared — which is the same thing as
   * arriving somewhere nobody has camped.
   */
  hearth?: Hearth;
  /** Hours since this player last left this campsite. */
  hoursAway?: number;
  /** Visits already banked for known individuals, keyed by individual id. */
  priorVisits?: Readonly<Record<string, number>>;
  /**
   * What the animals here already know of this player.
   *
   * Two layers restored from two places: the species floor travels with the
   * Passport, the individual bonds belong to this campsite's memory.
   */
  familiarity?: Familiarity;
  /** What this player already found here, restored from the Passport. */
  knownSecrets?: readonly DiscoveryRecord[];
/**
   * Which part of the day the session opens in.
   *
   * Defaults to `early-night`, which is where a session has always effectively
   * opened: the old clock wound back three hours from two in the morning, so a
   * player arrived at about eleven, into the dark, with the fire already the
   * brightest thing in the frame. That arrival *is* the product's look, and
   * `dusk` — which the sun-based clock briefly made the default — replaced it
   * with a light sky the fire had to compete with.
   *
   * Nothing is lost by starting after dusk now that the sky comes round: a
   * player who wants a whole evening can wait for the next one.
   */
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
  /**
   * `EnvironmentManifest.machine` — what this site's SM-01 tends to be like.
   *
   * Recognition, never difficulty: the campsite whose manifest says damp gets
   * into the door gasket gets a unit whose door is more likely to stick, and
   * finding the same fault on your second visit is the point of it.
   */
  readonly machine?: MachineFlavourSpec;
  /**
   * What this campsite is like, in its own words.
   *
   * `WeatherCharacter`, `AmbienceProfile` and the scene's ground and elevation
   * notes, which between them are a paragraph of sensory writing per
   * environment that had never been read out to anybody — plus
   * `character.eeriness`, which decides how often and how unpredictably this
   * campsite is heard from a long way off.
   */
  readonly place?: PlaceNotes;
  /**
   * `EnvironmentManifest.procedural.variations` — what is different tonight.
   *
   * Five per campsite, sixty across the catalogue, each with a range and a
   * note saying what it should drive, and until they were rolled every visit
   * to a campsite was the identical visit. See `variation.ts` for the roll and
   * `tonight.ts` for how it reaches the systems.
   */
  readonly variations?: readonly SeededVariationSpec[];
  /**
   * `EnvironmentManifest.activities` — what there is to do here, and which of
   * it this campsite is *for*.
   *
   * `prominence` is the field that matters: it marks the one activity a
   * campsite exists to offer, and the survey is the only place a player who
   * cannot see the screen could ever learn it. `note` must already have been
   * put through the catalogue's own `inWorld` filter before it arrives here —
   * this package cannot depend on `@somemore/content`, and the raw notes are
   * half design commentary.
   */
  readonly activities?: readonly ActivityHint[];
  /** Where the client's own props already stand, so nothing is placed inside one. */
  readonly occupied?: readonly Occupied[];
}

/** One entry from a campsite's activity list, in the words a player may hear. */
export interface ActivityHint {
  readonly id: string;
  readonly label: string;
  readonly prominence: 'available' | 'notable' | 'signature';
  /** Already filtered for author asides. Empty is a valid and common answer. */
  readonly note: string;
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

/** The parts of the day the ritual belongs to. Everything else is daylight. */
const NIGHT_WINDOWS: ReadonlySet<ActivityWindow> = new Set<ActivityWindow>([
  'dusk',
  'early-night',
  'deep-night',
  'pre-dawn',
]);

/**
 * Whether it is dark enough to be the evening rather than the day after it.
 *
 * `dawn` is deliberately not night. It is the turn — the world says "that is
 * the night gone" there — and it is the first window in which the ritual is
 * refused.
 */
export function isNight(window: ActivityWindow): boolean {
  return NIGHT_WINDOWS.has(window);
}

/**
 * What time of day it is, from where the sun actually is.
 *
 * This replaces a stopwatch. `windowAt` counted fourteen-minute windows from
 * whichever one the session started in and clamped at dawn for ever, while the
 * astronomy module advanced a real sun on its own schedule — two clocks, and
 * they disagreed. Measured: the stopwatch declared the night over with the sun
 * still 7.6° below the horizon and every star at full brightness, so the world
 * said "the sky has gone grey behind the trees" into a pitch-black sky.
 *
 * Altitude alone cannot tell morning from afternoon — the sun is at the same
 * height either side of noon — so which half of the sky it is in says which
 * way it is going. Which half that is was established against the model rather
 * than assumed: the first version had it backwards and labelled a climbing sun
 * `dusk`, and `windowFromSun` was walking the day in reverse. `sunclock.test.ts`
 * checks the two agree by sampling the real sun an hour apart and comparing
 * the direction it actually moved, so nobody has to reason about the
 * convention again.
 */
/** Whether a body at this azimuth is on its way up. See `windowFromSun`. */
export function isRising(azimuthRad: number): boolean {
  return Math.sin(azimuthRad) < 0;
}

export function windowFromSun(altitudeRad: number, azimuthRad: number): ActivityWindow {
  const altitude = Number.isFinite(altitudeRad) ? (altitudeRad * 180) / Math.PI : -90;
  const rising = isRising(azimuthRad);
  if (altitude > 20) return 'midday';
  if (rising) {
    if (altitude < -18) return 'deep-night';
    if (altitude < -6) return 'pre-dawn';
    if (altitude < 3) return 'dawn';
    return 'morning';
  }
  if (altitude > 3) return 'afternoon';
  if (altitude > -6) return 'dusk';
  if (altitude > -18) return 'early-night';
  return 'deep-night';
}

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
 * When the sun is actually in a given window, on a given date and at a given
 * place.
 *
 * `startWindow` used to wind a stopwatch. Now that the sun is the clock it has
 * to place the *sun*, and the obvious way to do that — map each window to a
 * clock hour — is wrong, because the same hour is a different part of the day
 * in a different month. Half past eight in the evening is dusk in August, full
 * dark in March and broad daylight in June. Asking for dusk and being given
 * night is not a rounding error; it is the wrong window.
 *
 * So it is solved rather than tabulated: walk the real sky in five-minute
 * steps, find the stretch that is the window being asked for, and start in the
 * middle of it. Two days of scanning, so a window that straddles midnight is
 * still found whole, and the midpoint so a session does not begin half a step
 * from the next boundary.
 *
 * This runs once, when a campsite is made.
 */
function epochForWindow(
  baseMs: number,
  latitudeDeg: number,
  longitudeDeg: number,
  window: ActivityWindow,
): number {
  const base = new Date(baseMs);
  // Start half a day early so the first run of any window is a complete one.
  const from = Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate()) - 12 * 3600_000;
  const STEP_MS = 5 * 60_000;
  const STEPS = (48 * 3600_000) / STEP_MS;

  let runStart = -1;
  let previous = false;
  for (let i = 0; i <= STEPS; i++) {
    const at = from + i * STEP_MS;
    const sun = sunState(new Date(at), latitudeDeg, longitudeDeg);
    const inside = windowFromSun(sun.altitude, sun.azimuth) === window;
    if (inside && !previous) runStart = at;
    // The first run that both began and ended inside the scan is the one.
    if (!inside && previous && runStart > from) return runStart + (at - runStart) / 2;
    previous = inside;
  }
  // A window this date never reaches — a polar summer has no deep night — so
  // the campsite gets the date it was given and whatever sky that is.
  return baseMs;
}

/**
 * Hours of dark at the reference latitude, and how long that should take.
 *
 * The night is the product, so its length is chosen and the rest of the cycle
 * follows from it: about an hour of play from dusk to first light, which is
 * what it has always been and what "leaves an evening long enough to have one"
 * measures. A whole turn of the sky is therefore a little over two hours, most
 * of it daylight — which is the price of a wasted night, and a payable one.
 */
/**
 * The date a campsite gets when nobody says otherwise.
 *
 * A real one, so the fallback sky is a real sky — mid-August at the reference
 * latitude, which is the same night `curatedSky` is built on and a good one:
 * clear, a modest moon, the Perseids running.
 */
const REFERENCE_NIGHT = Date.UTC(2024, 7, 12);

const DARK_HOURS = 10.2;
const NIGHT_MINUTES = 60;
const SKY_TIME_SCALE = (DARK_HOURS * 3600 * 1000) / (NIGHT_MINUTES * 60 * 1000);

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

/**
 * How far through the dark it is, 0 at dusk and 1 at first light.
 *
 * Taken from the sun rather than from elapsed session time, for the same
 * reason the window is. During daylight this sits at one end or the other and
 * `airChill` overrides it anyway, which is why it does not need a day branch.
 */
export function nightProgressFromSun(altitudeRad: number, azimuthRad: number): number {
  const altitude = Number.isFinite(altitudeRad) ? (altitudeRad * 180) / Math.PI : -90;
  const rising = isRising(azimuthRad);
  // 0 with the sun just above the horizon, 1 with it deep under.
  const depth = clamp01((3 - altitude) / 21);
  return rising ? clamp01(1 - depth * 0.5) : clamp01(depth * 0.5);
}

/**
 * What the air is doing to the temperature, given the hour.
 *
 * The night curve is unchanged: the cold comes on through the dark, is worst
 * just before it gets light, and eases at dawn. What is new is that the day
 * exists, and a day is warmer than the baseline rather than merely less cold —
 * so a player who waits out an afternoon is genuinely warm, and the fire is
 * something they keep for later rather than something they need.
 *
 * `daylight` is the sun model's own 0..1 term, which crosses from nothing to
 * everything between six degrees below the horizon and six above.
 */
export function airChill(daylight: number, progress: number): number {
  const cold = nightChill(progress);
  return cold + (DAY_WARMTH - cold) * clamp01(daylight);
}

/** How much warmer than the weather's own baseline a sunlit afternoon is. */
const DAY_WARMTH = 3;

/**
 * What the world says when the fire has got away from you.
 *
 * An observation about the pit, not an instruction and not an alarm: a player
 * who would rather stay at the water is allowed to, and the line does not
 * follow them there a second time.
 */
export function describeFailingFire(fire: { emberMass: number; ashCover: number }): string {
  if (fire.ashCover > 0.6) return 'The fire has gone down to a grey lid with the heat still under it.';
  if (fire.emberMass > 0.25) return 'The flames have dropped away. There is a good bed of coals under there and nothing on top of them.';
  return 'The fire is down to a few coals.';
}

/**
 * What the world says as the light comes up.
 *
 * Never a score and never a summary of the evening. It is an observation, and
 * it is the same observation whether you made a sandwich or spent the whole
 * night at the water — because the world does not know which of those was the
 * point, and neither does this.
 */
export function describeDaybreak(): string {
  return 'The sky has gone grey behind the trees, and the cold has that early edge to it. That is the night gone.';
}

/**
 * What took the s'more.
 *
 * Names the animal and says nothing about what it means. There is no thank
 * you, no acknowledgement, no counter going up — an animal that took food off
 * a stump is not grateful and does not know it has been given anything, and a
 * line that implied otherwise would turn the one place the ritual touches the
 * wildlife model into a transaction. §5.3: nothing here is a score.
 */
export function describeOffering(taken: { readonly label: string }): string {
  return `${capitalise(taken.label)} took it, and went with it into the dark.`;
}

function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Said once, as the night turns over into its next part. */
export function describeWindow(window: ActivityWindow): string | null {
  switch (window) {
    case 'dawn':
      return 'There is grey in the east. That went quickly.';
    case 'morning':
      return 'The sun is properly up, and the cold is coming out of everything.';
    case 'midday':
      return 'The light is straight down and the wood has gone quiet. Not much moves at this hour.';
    case 'afternoon':
      return 'The shadows have started to lean the other way.';
    case 'dusk':
      /*
       * Dusk speaks now, and did not used to.
       *
       * While the night was the whole world, dusk was only ever where a
       * session began — something you arrived after rather than something that
       * happened to you, so it said nothing. With the sky going all the way
       * round it is something a player can sit through and wait for, and it is
       * the moment the evening comes back. It carries that without instructing:
       * a player knows what dark is for here.
       *
       * A session that *starts* at dusk still hears nothing, because
       * `windowChangedTo` only fires on a change.
       */
      return 'The light is going out of the day. Whatever you meant to do before dark, it is now.';
    case 'early-night':
      return 'The last of the light has gone out of the sky.';
    case 'deep-night':
      return 'It is properly late now, and properly cold.';
    case 'pre-dawn':
      return 'The coldest part of it. Everything has gone quiet.';
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
  /** Things you find by crouching over them (see `curios.ts`). */
  curios: PlacedCurio[];
  /** The campsite's own voice: what it has said about itself, and when. */
  place: PlaceState;
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
  /**
   * What was different about tonight (§5.4).
   *
   * Kept on the state rather than consumed and thrown away, because the client
   * reads two of these roles itself — the understorey it draws and the
   * treeline it draws are not simulated — and because the Passport's account
   * of an evening should be able to say what the evening was like.
   */
  readonly variations: VariationSet;
  options: Required<
    Omit<
      RitualOptions,
      | 'weatherProfile'
      | 'world'
      | 'priorVisits'
      | 'knownSecrets'
      | 'knownConstellations'
      // Inputs, not settings: what they produce is `hearth` below, and keeping
      // the raw pair here as well would be two answers to one question.
      | 'hearth'
      | 'hoursAway'
      // Restored input too: what it becomes lives on `wildlife.familiarity`,
      // which grows over the evening, and two copies would disagree by dawn.
      | 'familiarity'
    >
  > & {
    weatherProfile: WeatherProfile;
    world: RitualWorldContent;
  };
  /**
   * The pit as tonight found it: what was left here, after the night between.
   *
   * Kept on the state rather than derived on demand because the client has to
   * bank it again on the way out, and banking has to know what it is replacing
   * — a cold pit that stays cold counts a visit down, and one that is alight
   * again stops counting at all.
   */
  hearth: Hearth;
  /**
   * Whether the night has run out.
   *
   * Latched: once it is morning it stays morning, and nothing in a session
   * turns it back into night.
   */
  nightOver: boolean;
  /**
   * Whether the fire has dropped to needing you, over a bed still worth
   * saving.
   *
   * The fire has always burned down — left alone it loses its flame inside
   * five minutes and is a bare bed by morning — and nothing ever said so. That
   * was survivable while the night was endless: you would notice eventually,
   * and eventually was free. With the night finite, a fire that went out while
   * you were at the water is twenty minutes you cannot have back, and the
   * difference between a mechanic and a gotcha is whether the world mentioned
   * it.
   *
   * Latched, and released well above where it is set, so a fire hovering at
   * the line is one remark rather than one every four seconds. A *state* and
   * not a one-step flag, for the same reason `offeringTaken` is: the client
   * reads the world once a frame over a simulation that may have stepped many
   * times since, and a rare thing true for exactly one step is a line the
   * player is not guaranteed to be shown.
   */
  fireLow: boolean;
  /**
   * The sandwich set down and walked away from, if there is one.
   *
   * The whole ritual — gather, roast, assemble, transform, reveal — produced
   * exactly one object, and its only use was to disappear into the player.
   * The most elaborate system in the product terminated in nothing and
   * connected to nothing else in it.
   *
   * Left out, it becomes an unattended thing that smells of food, in a model
   * that has always known what animals do about those. Cleared when something
   * takes it.
   */
  offering: {
    readonly id: string;
    readonly x: number;
    readonly z: number;
    /** The s'more itself, so what is lying there is the one you made. */
    readonly sandwich: SandwichRecord;
  } | null;
  /**
   * What took the last offering, and it stays set.
   *
   * Not a one-step flag, and that is deliberate rather than lazy. The client
   * reads the world once a frame while the simulation steps thirty times a
   * second and can be fast-forwarded through a whole evening in one call — so
   * anything true for exactly one step is a line the player is not guaranteed
   * to be told. Every other rare thing here is read the same way, from a log
   * or a count against a remembered one (see `discoveryEvents` in `App`).
   */
  offeringTaken: { readonly speciesId: string; readonly individualId: string; readonly label: string } | null;
  /** How many have been carried off this session. Rises once each time. */
  offeringsTaken: number;
  /** How many of those the campsite has already written down. */
  offeringsTraced: number;
  /** Stage-change flag for one step, consumed by audio and UI. */
  stageChangedTo: RitualStage | null;
}

export function createRitual(options: RitualOptions): RitualState {
  const seed = typeof options.campsiteSeed === 'string' ? hashString(options.campsiteSeed) : options.campsiteSeed;
  const rng = new Rng(seed);
  const world = options.world ?? {};
  /*
   * What is different about tonight, decided before anything is built.
   *
   * Rolled from the campsite's seed *and which visit this is*, and the second
   * half of that is the whole point. `campsiteSeed` is stable — it is stored
   * on the device and reused, because a campsite you have been to before has
   * to be the same campsite — so rolling from it alone would have produced the
   * same night every night, which is exactly the thing `procedural` exists to
   * stop. The manifests are explicit about it: "fully reshuffled between
   * visits", "same fox, different hour", "people have been here since you were
   * last here". What stays fixed between visits is `invariants`, and those are
   * not rolled at all.
   *
   * Still deterministic, and still the same night for everybody at one fire: a
   * shared world is rebuilt from the wire's seed with no visit index (see
   * `timeline.ts`), so every client rolls visit one and rolls it identically.
   *
   * Each variation then draws from a stream named after itself, so a manifest
   * gaining a sixth cannot disturb the five it already had (ADR-0001).
   */
  const variations = rollVariations(
    world.variations ?? [],
    mixSeeds(seed, options.visitIndex ?? 1),
  );
  const authoredWeather = options.weatherProfile ?? DEFAULT_WEATHER_PROFILE;
  const weatherProfile = varyWeatherProfile(authoredWeather, variations);
  const weather = createWeather(weatherProfile, rng.split('weather'));
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
  /*
   * A campsite you have used before is found the way you left it.
   *
   * This used to be a coin with two sides: first visit, somebody's fire is
   * going; every visit after that, a banked pit at a fixed two hundred
   * degrees. Whether last night ended with the coals buried under a careful
   * cover of ash or with bare flame left burning in the rain made no
   * difference to what you walked back into — the whole of what the fire model
   * simulates stopped mattering the moment the tab closed.
   *
   * Now the pit is the one you left, cooled by the night in between and by
   * whatever fell on it. `restHearth` is where that happens; this only has to
   * decide between the opening image and your own hearth.
   */
  const rested = options.hearth
    ? restHearth(options.hearth, {
        hours: options.hoursAway ?? 0,
        ambientC: weather.temperatureC,
        wetness: wetnessOf(weatherProfile),
        rng: rng.split('hearth'),
      })
    : null;
  const returning = (options.visitIndex ?? 1) > 1;
  const fire = rested
    ? wakeFire(rested, fireConfig)
    : returning
      ? createBankedFire(fireConfig)
      : createEstablishedFire(fireConfig);

  // Built before the state object so the landmarks can be put at the water.
  const water = world.water
    ? createWater(varyWater(world.water, variations), {
        campsiteSeed: seed,
        walkableRadiusM,
        stillness: tonightsStillness(variations),
      })
    : null;

  const landmarks = placeLandmarks({
    landmarks: world.landmarks ?? [],
    radius: walkableRadiusM,
    trailBearing: world.trailBearing ?? 0.69,
    // Stepping stones go at the water, which means the water has to exist
    // before the things that stand beside it are placed.
    ...(water ? { shore: { bearing: water.shore.bearing, distanceM: water.shore.distanceM } } : {}),
    ...(world.occupied ? { occupied: world.occupied } : {}),
    rng: rng.split('landmarks'),
  });

  /*
   * And the small things you only find by crouching over them.
   *
   * After the landmarks, and handed them, because most of these secrets
   * describe something that sits on or under a thing the manifest already
   * names — so a curio has to know where those ended up in order to stand
   * beside one rather than inside it.
   */
  const curios = placeCurios({
    secrets: world.secrets ?? [],
    radius: walkableRadiusM,
    trailBearing: world.trailBearing ?? 0.69,
    landmarks,
    ...(world.occupied ? { occupied: world.occupied } : {}),
    rng: rng.split('curios'),
  });

  return {
    stage: 'arriving',
    fire,
    place: createPlace(),
    landmarks,
    curios,
    gathering: createGathering({
      sources: world.fuel ?? [],
      radius: walkableRadiusM,
      humidity: weather.humidity,
      variations,
      rng: rng.split('gathering'),
    }),
    weather,
    marshmallow: createMarshmallow(),
    assembly: createAssembly({ assist: options.assemblyAssist ?? 0.5 }),
    machine: createMachine(seed, options.environmentId, world.machine ?? {}),
    bite: createBiteState(),
    wildlife: createWildlife({
      campsiteSeed: seed,
      roster: varyRoster(world.wildlife ?? [], variations),
      priorVisits: options.priorVisits,
      ...(options.familiarity ? { familiarity: options.familiarity } : {}),
      /*
       * Animals arrive from outside the campsite and leave by going out of
       * it. The default 30 m was chosen when nowhere was bigger than that,
       * and a campsite you can walk 34 m across would have had deer
       * materialising and evaporating within arm's reach of a standing
       * player. The margin keeps the edge of the world and the edge of the
       * roster from being the same circle.
       */
      departureRadiusM: Math.max(30, walkableRadiusM * 1.35),
    }),
    radio: createRadio(varyRadioProfile(world.radio ?? SILENT_DIAL, variations), {
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
      /*
       * Tonight's real date, at the hour the session asked to start at.
       *
       * This used to wind a stopwatch back from the middle of the night, and
       * to fall back to epoch zero when no date was supplied — which put a
       * test's sun somewhere in 1970 and, now that the sun is the clock, meant
       * a ritual created without a date started at an arbitrary time of day.
       */
      epochMs: epochForWindow(
        (options.skyEpochMs ?? 0) > 0 ? (options.skyEpochMs as number) : REFERENCE_NIGHT,
        options.latitudeDeg ?? 44,
        options.longitudeDeg ?? -73,
        options.startWindow ?? 'early-night',
      ),
      timeScale: SKY_TIME_SCALE,
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
    variations,
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
    hearth: rested ?? NEW_HEARTH,
    nightOver: false,
    fireLow: false,
    offering: null,
    offeringTaken: null,
    offeringsTaken: 0,
    offeringsTraced: 0,
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
  const sun = ritual.stargazing.sky.sun;
  ritual.weather.nightChill = airChill(
    sun.daylight,
    nightProgressFromSun(sun.altitude, sun.azimuth),
  );

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
    const telling = describeWeatherChange(
      ritual.weather.kind,
      ritual.weather.changedTo,
      ritual.stargazing.sky.sun.daylight,
    );
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

/** Reused so the campsite's own voice allocates nothing per frame. */
const placeScratch: PlaceConditions = {
  elapsed: 0,
  deepNight: false,
  temperatureC: 12,
  windSpeed: 0,
  precipitation: 0,
  distanceFromFire: 0,
  fireHarried: false,
};

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
  /*
   * A whole s'more sitting on the ground outsmells everything else here, and
   * `food-smell` is what half this roster is `attractedBy`. This is the line
   * that makes leaving one out an act rather than a discard: the camp starts
   * smelling of food to exactly the animals that care about that.
   */
  out['food-smell'] = clamp01(
    Math.max(
      out['marshmallow-smell'] ?? 0,
      ritual.stage === 'assembling' ? 0.45 : 0,
      ritual.offering ? 0.8 : 0,
    ),
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

/**
 * The two beats the campsite does not talk over.
 *
 * `arriving` has its own five written beats, and the elevation remark's
 * condition — "more than five and a half metres from the fire" — is true of
 * every frame of the walk in, so the campsite's own description landed on the
 * title card underneath them.
 *
 * `reveal` is the same mistake at the other end of the night. Walking to the
 * SM-01 is walking away from the fire, so the same remark comes due; it then
 * arrives while the player is looking into the open chamber at the thing the
 * whole hour has been building to, and a note about the shape of the ground is
 * not what that moment is for. Both were found by opening the screenshots.
 *
 * Nothing else is gated. Roasting, assembling and working the machine are all
 * *being at the campsite*, and the wind note landing while you are tending a
 * fire in that wind is the entire point of the remark system.
 */
const SILENT_STAGES: ReadonlySet<RitualStage> = new Set<RitualStage>(['arriving', 'reveal']);

/** The campsite's own voice, conditioned on the night the player is in. */
function stepThePlace(ritual: RitualState, dt: number): void {
  const presence = ritual.presence;
  placeScratch.elapsed = ritual.elapsed;
  placeScratch.deepNight = ritual.window === 'deep-night' || ritual.window === 'pre-dawn';
  placeScratch.temperatureC = ritual.weather.temperatureC;
  placeScratch.windSpeed = ritual.weather.windSpeed;
  placeScratch.precipitation = ritual.weather.precipitation;
  placeScratch.distanceFromFire = Math.hypot(presence.position.x, presence.position.z);
  // "Harried" means the weather is actually taking the fire apart, which is
  // when a campsite's own line about how exposed it is means anything.
  placeScratch.fireHarried =
    ritual.fire.rain > 0.25 || (ritual.fire.windSpeed > 3.4 && ritual.fire.flame > 0.15);
  stepPlace(ritual.place, ritual.options.world.place ?? {}, placeScratch, dt, stream(ritual, 'place'));
}

function stepWorld(ritual: RitualState, dt: number): void {
  const presence = ritual.presence;
  const previousWindow = ritual.window;
  /*
   * What time it is, from the sun rather than from a stopwatch.
   *
   * The sky is stepped further down this function, so this reads the one the
   * last step left — a thirtieth of a second stale, against a sun that takes
   * an hour to cross a window boundary.
   */
  ritual.window = windowFromSun(
    ritual.stargazing.sky.sun.altitude,
    ritual.stargazing.sky.sun.azimuth,
  );
  ritual.windowChangedTo = ritual.window === previousWindow ? null : ritual.window;

  /*
   * And whether the evening is over — a phase, not a terminus.
   *
   * It used to latch: once it was morning it was morning for ever, because the
   * clock stopped at dawn and there was nothing after it. The sky goes all the
   * way round now, so a player who waits out a day gets another night and
   * another evening. What a wasted night costs is therefore a whole turn of
   * the sky rather than the session, which is a real price and a payable one.
   */
  ritual.nightOver = !isNight(ritual.window);

  /*
   * And the fire asking for you.
   *
   * Set while there is still something to save — a bed this warm takes a log,
   * not a rebuild — which is the whole point of saying anything at all. Held
   * until the fire is genuinely back up, well above where it is set, so a fire
   * hovering at the line is not a state that flickers.
   */
  if (ritual.fire.flame < 0.12 && ritual.fire.emberMass > 0.02) ritual.fireLow = true;
  else if (ritual.fire.flame > 0.3) ritual.fireLow = false;

  /*
   * The campsite, remarking on itself when the remark is true — once you are
   * actually here.
   *
   * Silent through `arriving`, which is not a fussy detail. The walk in has
   * its own five beats, written for it; and the elevation remark's condition
   * is "more than five and a half metres from the fire", which is true of
   * every single frame of the approach. So the campsite's own description
   * arrived on the title card, in a box, underneath the arrival beat and on
   * top of the title — two pieces of prose about the same place at once,
   * before the player had done anything. `place.ts`'s own rule is that a
   * campsite reciting its own description on arrival would be a loading screen
   * with trees. Found by looking at the picture; no assertion in the suite
   * knew where on the screen those two lines were.
   *
   * Stepped here rather than at the top because it is conditioned on the
   * window, the weather and where the player is standing, all of which this
   * function has just settled.
   */
  if (SILENT_STAGES.has(ritual.stage)) {
    ritual.place.remark = null;
    ritual.place.heard = null;
  } else {
    stepThePlace(ritual, dt);
  }

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
  /*
   * The offering joins whatever else is lying about the camp.
   *
   * Rebuilt each step rather than pushed once, because `presence.objects` is
   * the caller's list and this must not quietly grow it. `food` and `portable`
   * are both true, which is the whole of why something comes for it — the
   * steal chance in `stepWildlife` is built from exactly those two.
   */
  wildlifeScratch.objects = ritual.offering
    ? [
        ...presence.objects,
        {
          id: ritual.offering.id,
          position: vec3(ritual.offering.x, 0.3, ritual.offering.z),
          portable: true,
          food: true,
        },
      ]
    : presence.objects;
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
  // What the camera caught this step, so an animal photographed without
  // bolting comes to know the person holding it.
  wildlifeScratch.photographed = presence.photographed;
  stepWildlife(ritual.wildlife, wildlifeScratch, dt, stream(ritual, 'wildlife'));

  /*
   * And something carrying it off.
   *
   * The bond with *that animal* moves, and the species floor does not — which
   * is the honest reading of what leaving food out does. It is not how you
   * befriend a species; it is how one particular animal learns that this camp
   * is worth coming back to. §7 is explicit that these are not collectible
   * pets and there is no feeding quest, and a mechanic where food bought
   * general tameness would be exactly that.
   */
  if (ritual.offering && ritual.wildlife.takenObjectIds.includes(ritual.offering.id)) {
    /*
     * Matched on the target rather than on `tookObject` alone: anything the
     * player left lying about the camp is stealable, so an animal that
     * carried off a dropped torch three minutes ago still reads as a thief,
     * and crediting it for the s'more would credit the wrong animal.
     * `targetObjectId` survives the steal, so this is exact.
     */
    const offeringId = ritual.offering.id;
    const thief =
      ritual.wildlife.animals.find(
        (animal) => animal.tookObject && animal.targetObjectId === offeringId,
      ) ?? null;
    ritual.offering = null;
    if (thief) {
      ritual.offeringTaken = {
        speciesId: thief.species.id,
        individualId: thief.individual.id,
        label: thief.species.label,
      };
      ritual.offeringsTaken++;
      ritual.wildlife.familiarity = rememberOffering(
        ritual.wildlife.familiarity,
        thief.individual.id,
      );
    }
  }

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

  /*
   * The s'more that walked off.
   *
   * A `sandwich` trace rather than a `wildlife-encounter` one, because what
   * the campsite is keeping is the thing the whole ritual made and where it
   * ended up — not another sighting. It is the only path by which the deepest
   * system in the product leaves a mark on the place, which is worth the
   * kind's weight in the significance model.
   */
  if (ritual.offeringTaken && ritual.offeringsTraced < ritual.offeringsTaken) {
    const taken = ritual.offeringTaken;
    ritual.offeringsTraced = ritual.offeringsTaken;
    ritual.traces.push(
      createTrace(
        `offering:${taken.individualId}:${Math.round(ritual.elapsed * 60)}`,
        createEvidence('sandwich', {
          rarity: 0.55,
          isFirst: ritual.offeringsTaken <= 1,
          photographed: ritual.presence.photographed.includes(taken.speciesId),
          dwellSeconds: ritual.wildlife.stillnessSeconds,
        }),
        now,
        {
          speciesId: taken.speciesId,
          speciesLabel: taken.label,
          individualId: taken.individualId,
          telling: describeOffering(taken),
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
  | { type: 'strike' }
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
  } else if (action.type === 'strike') {
    /*
     * A light held to whatever is in the pit.
     *
     * Only reachable when nothing is alight, and it needs tinder — so the
     * verb is the end of a sequence (find dry fuel, lay it, light it) rather
     * than a button that produces fire. `strikeSpark` decides whether it
     * catches, from how wet the driest thing in there is.
     */
    strikeSpark(ritual.fire, stream(ritual, 'strike'));
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
  /*
   * With the line out, the rod is what you are doing, wherever you are
   * looking: eyes on the float, the prompt read "Pick up a stone", and the
   * strike was only ever offered while facing the rod itself.
   */
  if (ritual.fishing.phase !== 'stowed' && ritual.fishing.phase !== 'ready') {
    for (const candidate of reachable(player, world)) {
      if (candidate.interactable.id === 'rod') return candidate.interactable;
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
  /*
   * Not in the morning.
   *
   * The one place the night ending is enforced rather than merely described:
   * you cannot start the evening's ritual after the evening. Everything
   * already in flight is left alone — a marshmallow on a stick at daybreak is
   * still yours to finish — because taking something out of somebody's hands
   * is a different thing from the night being over.
   */
  if (ritual.nightOver) return;
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

/** The id the offering carries into the wildlife model's object list. */
export const OFFERING_ID = 'offering:sandwich';

/** How far from the middle of the pit a s'more has to land to survive. */
const PIT_CLEARANCE_M = 0.95;

/**
 * Sets the sandwich down and walks away from it.
 *
 * The other thing a s'more can be for. Everything the ritual does produced one
 * object whose only use was to vanish into the player, and nothing in the rest
 * of the product ever touched it — the deepest system here terminated in
 * nothing and connected to nothing.
 *
 * What it becomes is an unattended thing that smells of food, in a model that
 * has always known exactly what animals do about those: `WildlifeObject`
 * carries `portable` and `food`, and the steal chance is built from both.
 * Nothing new was needed for something to take it.
 *
 * Refused once it has been bitten, because half a s'more left on a stump is
 * litter rather than an offering. Not refused at daybreak, though: this is the
 * tail of a ritual already begun rather than a new one, and the last thing you
 * do before you go is exactly when a person would do it.
 */
export function leaveSandwich(ritual: RitualState, x: number, z: number): boolean {
  if (!ritual.sandwich || ritual.offering !== null) return false;
  if (ritual.bite.bites > 0) return false;
  /*
   * Not in the fire.
   *
   * Where it lands is the player's, but "on the coals" is not a placement
   * anybody means — and it has to be refused here rather than in the interface
   * because at a shared fire the position arrives over the wire from somebody
   * else's client, and §9's rule is that no message exists that can destroy
   * another player's work.
   */
  const distance = Math.hypot(x, z);
  const clear = Math.max(distance, PIT_CLEARANCE_M);
  const bearing = distance > 1e-4 ? { x: x / distance, z: z / distance } : { x: 1, z: 0 };
  ritual.offering = {
    id: OFFERING_ID,
    x: bearing.x * clear,
    z: bearing.z * clear,
    sandwich: ritual.sandwich,
  };
  ritual.sandwich = null;
  setStage(ritual, 'after');
  return true;
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
 * Crouches over one of the campsite's small things, or straightens up again.
 *
 * The whole of the discovery model's `inspecting` condition, which nothing in
 * the product could satisfy before this existed. It is a *posture*, not a
 * press: `stepDiscovery` wants the condition held continuously for five to
 * twelve seconds depending on how rare the thing is, and lets it drain at one
 * and a half times that rate when it lapses. A verb that set `inspecting` for
 * one frame would discover nothing, ever, and would have shipped green.
 *
 * So the client latches it and keeps writing it through `setPresence` until
 * the player walks away, stands up, or looks at something else — and this
 * only says which thing is being looked at.
 *
 * Returns the curio, so the caller can say its name.
 */
export function lookCloser(ritual: RitualState, secretId: string): PlacedCurio | null {
  const curio = curioAt(ritual.curios, secretId);
  if (!curio) return null;
  curio.looked = true;
  ritual.presence.inspecting = secretId;
  return curio;
}

/** Straightens up. Anything held stops being held. */
export function stopLooking(ritual: RitualState): void {
  ritual.presence.inspecting = null;
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
