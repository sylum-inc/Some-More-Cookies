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
import { createWeather, stepWeather, weatherFireEffect, type WeatherProfile, type WeatherState, DEFAULT_WEATHER_PROFILE } from './weather.js';
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
import { createTrace, type Trace } from './significance.js';
import { Rng, hashString, mixSeeds } from './rng.js';
import { clamp, clamp01 } from './math.js';
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
  };
}

/** The order the night moves through. */
const WINDOW_ORDER: readonly ActivityWindow[] = ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'];

/** Real minutes of play before the night moves on one window. */
const WINDOW_SECONDS = 14 * 60;

export interface RitualState {
  stage: RitualStage;
  fire: FireState;
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
  /** Reused observation object, so discovery allocates nothing per frame. */
  observationScratch: DiscoveryObservation;
  /** Which part of the night it is. */
  window: ActivityWindow;
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
  options: Required<Omit<RitualOptions, 'weatherProfile' | 'world' | 'priorVisits' | 'knownSecrets'>> & {
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
  const fire = createEstablishedFire({
    ambientC: weather.temperatureC,
    exposure: weatherProfile.exposure,
  });
  const world = options.world ?? {};

  return {
    stage: 'arriving',
    fire,
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
    traces: [],
    presence: createPresence(),
    wildlifeEvents: [],
    discoveryEvents: [],
    radioEvents: [],
    observationScratch: createObservation(),
    window: options.startWindow ?? 'early-night',
    sandwich: null,
    roastInput: { position: vec3(0, 0.45, 0.75), rotation: 0, blow: 0 },
    sandwichCount: 0,
    elapsed: 0,
    tick: 0,
    sandwichAge: 0,
    rng,
    seed,
    options: {
      campsiteSeed: seed,
      environmentId: options.environmentId,
      assemblyAssist: options.assemblyAssist ?? 0.5,
      autoRotate: options.autoRotate ?? 0,
      now: options.now ?? 0,
      visitIndex: options.visitIndex ?? 1,
      startWindow: options.startWindow ?? 'early-night',
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
  return new Rng(mixSeeds(mixSeeds(ritual.seed, hashString(name)), ritual.tick));
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

  // Weather first: it feeds the fire.
  stepWeather(ritual.weather, dt, stream(ritual, 'weather-step'));
  const effect = weatherFireEffect(ritual.weather);
  ritual.fire.config.ambientC = effect.ambientC;
  // Precipitation suppresses flame gently — mood, not jeopardy.
  if (effect.suppression > 0) {
    ritual.fire.flame = clamp01(ritual.fire.flame - effect.suppression * 0.06 * dt);
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
  out.flashlight = clamp01(ritual.presence.lightSweep);
  out['radio-music'] = ritual.radio.on ? clamp01(reception.clarity * ritual.radio.volume) : 0;
  out.voices = clamp01(ritual.presence.voices);
  out.footsteps = clamp01(ritual.presence.speed / 1.6);
  out['machine-hum'] = clamp01(machine.fan * 0.8 + machine.compressor * 0.4);
  out['compressor-noise'] = clamp01(machine.compressor);
  out['vapour-plume'] = clamp01(machine.vapour);
  out.rain = clamp01(weather.precipitation);
  out.wind = clamp01(weather.windSpeed / 9);
  out['cold-air'] = clamp01((8 - weather.temperatureC) / 18);
  out['open-sky'] = clamp01(1 - weather.cloudCover);
  out.moonlight = clamp01((1 - weather.cloudCover) * 0.8);
  return out;
}

function stepWorld(ritual: RitualState, dt: number): void {
  const presence = ritual.presence;
  ritual.window = windowAt(ritual.options.startWindow, ritual.elapsed);

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

  // Event logs are readouts for audio and the UI, not history: they are bound
  // so a long session cannot grow them without limit.
  trimTail(ritual.wildlifeEvents, 64);
  trimTail(ritual.discoveryEvents, 64);
  trimTail(ritual.radioEvents, 64);
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

export function tendFire(
  ritual: RitualState,
  action: { type: 'add-log'; woodId: string; placement?: number } | { type: 'rake' } | { type: 'fan'; strength?: number },
): void {
  if (action.type === 'add-log') {
    const log = addLog(ritual.fire, action.woodId, action.placement ?? 0.6);
    // Wet weather means the wood you find is damp.
    const effect = weatherFireEffect(ritual.weather);
    log.moisture = clamp01(log.moisture + effect.fuelMoisture * 0.4);
  } else if (action.type === 'rake') {
    rakeEmbers(ritual.fire, 1);
  } else {
    fanFire(ritual.fire, action.strength ?? 1);
  }
  if (ritual.stage === 'arriving') setStage(ritual, 'at-fire');
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

/** What the radio is receiving right now, weather and machine noise included. */
export function radioReadout(ritual: RitualState) {
  return receptionAt(ritual.radio, {
    weather: ritual.weather,
    machineNoise: machineNoise(ritual.machine),
  });
}

/** The animals in the world right now, nearest first. */
export function animalsPresent(ritual: RitualState): readonly WildlifeAnimal[] {
  return presentAnimals(ritual.wildlife);
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
