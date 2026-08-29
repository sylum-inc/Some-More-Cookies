/**
 * Wildlife — lightweight ecosystem behaviour (spec §7).
 *
 * Animals respond to sound, fire, food, flashlights, weather and players.
 * Four rules from the spec are load-bearing here and are implemented as
 * mechanism rather than flavour:
 *
 * 1. **Quiet behaviour reveals rarer wildlife.** The model keeps a running
 *    *disturbance* signal from player movement, noise and swept light, and a
 *    *calm* signal from how long the player has been genuinely still. A
 *    species' appearance rate is gated by calm raised to a power derived from
 *    its shyness, floored by its boldness — so a squirrel still turns up while
 *    you are crashing about, and the flying squirrel only ever arrives for a
 *    player who stopped moving. See {@link speciesAppearanceRate}, which is
 *    public precisely so the relationship is testable.
 * 2. **Persistent individuals recur.** Resident individuals for every
 *    `canPersist` species are derived from the campsite seed alone, so the same
 *    fox — same boldness, same notched ear — comes back on the next visit.
 * 3. **Animals investigate or steal objects and leave traces.** Both are
 *    emitted as events. This module never writes storage and never mutates the
 *    objects it is told about; the caller decides what a moved cup means.
 * 4. **Not collectible pets.** There is deliberately no taming meter, no
 *    feeding quest, no compendium and no completion set anywhere in this file,
 *    and no field on any public shape where one could be added quietly.
 *
 * The roster is data. `WildlifeSpecies` is structurally identical to
 * `WildlifeEntry` in `@somemore/content`'s schema, so
 * `EnvironmentManifest.wildlife` can be passed straight in — but this package
 * does not import the content package, because content depends on `sim` and
 * the dependency must not invert.
 */

import { approach, clamp, clamp01, lerp, smoothstep, TAU } from './math.js';
import { Rng, hashString, mixSeeds } from './rng.js';
import { createEvidence, type SignificanceEvidence } from './significance.js';
import { horizontalDistance, vec3, type Vec3 } from './types.js';

/* -------------------------------------------------------------------------- */
/* Content-shaped input                                                       */
/* -------------------------------------------------------------------------- */

/** When an animal is abroad. Mirrors the content schema exactly. */
export type ActivityWindow = 'dusk' | 'early-night' | 'deep-night' | 'pre-dawn' | 'dawn';

/** Everything an animal can notice. Mirrors the content schema exactly. */
export type WildlifeCue =
  | 'stillness'
  | 'quiet'
  | 'firelight'
  | 'ember-glow'
  | 'smoke'
  | 'food-smell'
  | 'marshmallow-smell'
  | 'crumbs'
  | 'flashlight'
  | 'camera-flash'
  | 'radio-music'
  | 'voices'
  | 'footsteps'
  | 'sudden-movement'
  | 'machine-hum'
  | 'compressor-noise'
  | 'vapour-plume'
  | 'warmth'
  | 'rain'
  | 'wind'
  | 'moonlight'
  | 'open-sky'
  | 'water-edge'
  | 'splashing'
  | 'singing'
  | 'shelter'
  | 'cold-air';

/**
 * A roster entry.
 *
 * Structurally compatible with `WildlifeEntry` from `@somemore/content`: an
 * `EnvironmentManifest['wildlife']` array satisfies `readonly
 * WildlifeSpecies[]` without a cast or a conversion step.
 */
export interface WildlifeSpecies {
  readonly id: string;
  readonly label: string;
  /** 0 = walks up to you, 1 = you will only ever hear it. Also *rarity*. */
  readonly shyness: number;
  /** 0 = ignores the camp, 1 = investigates everything. */
  readonly curiosity: number;
  readonly window: readonly ActivityWindow[];
  readonly attractedBy: readonly WildlifeCue[];
  readonly repelledBy: readonly WildlifeCue[];
  readonly canPersist: boolean;
  readonly investigatesObjects: boolean;
  readonly traces: readonly string[];
  readonly note: string;
}

/**
 * The weather an animal feels. `WeatherState` from `./weather.js` satisfies
 * this structurally; it is restated so wildlife does not depend on the weather
 * model's internals.
 */
export interface WildlifeWeather {
  readonly precipitation: number;
  readonly windSpeed: number;
  readonly fog: number;
  readonly temperatureC: number;
}

/* -------------------------------------------------------------------------- */
/* Individuals                                                                */
/* -------------------------------------------------------------------------- */

/**
 * One animal the world can remember.
 *
 * Residents (`persistent: true`) are derived from the campsite seed, so they
 * are the same animals on every visit. There is no taming value here and never
 * will be — `visits` exists so the significance model can tell a first meeting
 * from a tenth one, and is never shown as a counter.
 */
export interface WildlifeIndividual {
  readonly id: string;
  readonly speciesId: string;
  readonly persistent: boolean;
  /** -1 timid .. +1 bold. Shifts this animal off the species baseline. */
  readonly boldness: number;
  /** -1 .. +1 curiosity offset. */
  readonly curiosityBias: number;
  /** The stable detail a player might come to recognise. */
  readonly markings: string;
  /** Visits on which this individual has been seen, including earlier ones. */
  visits: number;
  /** Seconds before it may appear again. */
  cooldown: number;
  present: boolean;
}

const MARKINGS: readonly string[] = [
  'a notch out of one ear',
  'a pale patch on one flank',
  'a shortened tail',
  'one hind leg it favours',
  'unusually dark markings',
  'a scar across the muzzle',
  'a coat that never quite lies flat',
  'noticeably smaller than the others',
];

/** How many residents a persistent species keeps at one campsite. */
function residentCount(seed: number, speciesId: string): number {
  return 1 + (mixSeeds(seed, hashString(`residents:${speciesId}`)) % 2);
}

/**
 * Derives a resident individual purely from the campsite seed and an index.
 *
 * This is the whole of "the same fox comes back": nothing about the session,
 * the clock or the player is mixed in, so two independent sessions at the same
 * campsite produce byte-identical individuals.
 */
function createResident(seed: number, species: WildlifeSpecies, index: number): WildlifeIndividual {
  const rng = new Rng(mixSeeds(seed, hashString(`${species.id}#${index}`)));
  const markings = rng.pick(MARKINGS) ?? (MARKINGS[0] as string);
  return {
    id: `${species.id}:${mixSeeds(seed, hashString(`${species.id}#${index}`)).toString(36)}`,
    speciesId: species.id,
    persistent: true,
    boldness: rng.range(-1, 1),
    curiosityBias: rng.range(-0.5, 0.5),
    markings,
    visits: 0,
    cooldown: 0,
    present: false,
  };
}

/** A passing animal nobody will recognise again. */
function createTransient(species: WildlifeSpecies, ordinal: number, rng: Rng): WildlifeIndividual {
  return {
    id: `${species.id}~${ordinal}`,
    speciesId: species.id,
    persistent: false,
    boldness: rng.range(-0.6, 0.6),
    curiosityBias: rng.range(-0.4, 0.4),
    markings: '',
    visits: 0,
    cooldown: 0,
    present: false,
  };
}

/* -------------------------------------------------------------------------- */
/* Animals in the world                                                       */
/* -------------------------------------------------------------------------- */

export type AnimalPhase =
  | 'absent'
  | 'approaching'
  | 'watching'
  | 'investigating'
  | 'startled'
  | 'fleeing'
  | 'gone';

export interface WildlifeAnimal {
  readonly individual: WildlifeIndividual;
  readonly species: WildlifeSpecies;
  phase: AnimalPhase;
  /** Metres from the fire. */
  distanceM: number;
  /** Radians around the fire. */
  bearing: number;
  position: Vec3;
  /** Net drive: +1 drawn all the way in, -1 leaving as fast as it can. */
  drive: number;
  /** 0..1 how alarmed it currently is. */
  alarm: number;
  /** 0..1 how interested in the camp it currently is. */
  interest: number;
  /** Seconds in the current phase. */
  phaseSeconds: number;
  /** Seconds since it appeared. */
  presentSeconds: number;
  /** Seconds it is willing to stay before drifting off of its own accord. */
  patienceSeconds: number;
  /** The object it is currently working up the nerve to touch. */
  targetObjectId: string | null;
  /** True once it has taken something this visit. */
  tookObject: boolean;
}

/** An unattended thing an animal might investigate or carry off. */
export interface WildlifeObject {
  readonly id: string;
  readonly position: Vec3;
  /** Small enough to be carried away. */
  readonly portable: boolean;
  /** Smells of food. Marshmallow bags, principally. */
  readonly food: boolean;
}

/* -------------------------------------------------------------------------- */
/* Input                                                                      */
/* -------------------------------------------------------------------------- */

/** 0..1 presence of each cue in the world right now. */
export type WildlifeCueField = Partial<Record<WildlifeCue, number>>;

/**
 * What the animals can sense this step.
 *
 * `stillness` and `quiet` are deliberately *not* caller-supplied: the model
 * derives them from the disturbance the player is actually generating, so the
 * stillness mechanic cannot be faked from outside.
 */
export interface WildlifeInput {
  /** Player movement speed, m/s. */
  playerSpeed: number;
  /** 0..1 broadband noise: voices, radio, the SM-01's compressor. */
  noise: number;
  /** 0..1 light being swept about — a flashlight looking for something. */
  lightSweep: number;
  /** 0..1 impulse this step: a camera flash, standing up too fast, a shout. */
  startle: number;
  /** Where the player is, for flight bearings. */
  playerPosition: Vec3;
  /** Cue presences the caller knows about: firelight, smells, crumbs. */
  cues: WildlifeCueField;
  /** Which part of the night it is. */
  window: ActivityWindow;
  /** Unattended objects. Never mutated by this module. */
  objects?: readonly WildlifeObject[];
  weather?: WildlifeWeather;
}

export function createWildlifeInput(overrides: Partial<WildlifeInput> = {}): WildlifeInput {
  return {
    playerSpeed: 0,
    noise: 0,
    lightSweep: 0,
    startle: 0,
    playerPosition: vec3(0, 0, 0),
    cues: {},
    window: 'early-night',
    objects: [],
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Events                                                                     */
/* -------------------------------------------------------------------------- */

export type WildlifeEventKind =
  | 'appeared'
  | 'settled'
  | 'investigated'
  | 'took-object'
  | 'left-trace'
  | 'startled'
  | 'departed';

/**
 * Something worth remembering happened.
 *
 * Events are trace-*worthy*, not traces: this module emits and forgets.
 * Persisting one is the caller's decision, via {@link wildlifeEvidence} and the
 * significance model.
 */
export interface WildlifeEvent {
  readonly kind: WildlifeEventKind;
  readonly at: number;
  readonly speciesId: string;
  readonly speciesLabel: string;
  readonly individualId: string;
  readonly persistent: boolean;
  /** Visits this individual has been seen on, including this one. */
  readonly visits: number;
  /** 0..1 how unusual a sighting this is — the species' shyness. */
  readonly rarity: number;
  readonly position: Vec3;
  /** Set on `left-trace`: the mark it left. */
  readonly trace: string | null;
  /** Set on `investigated` / `took-object`. */
  readonly objectId: string | null;
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export interface WildlifeConfig {
  readonly campsiteSeed: number | string;
  readonly roster: readonly WildlifeSpecies[];
  /** How many animals may be present at once. Kept low: this is a campsite. */
  readonly maxConcurrent?: number;
  /** Where "gone" is. Defaults to 30 m. */
  readonly departureRadiusM?: number;
  /** Visits already banked for known individuals, keyed by individual id. */
  readonly priorVisits?: Readonly<Record<string, number>>;
}

export interface WildlifeState {
  readonly config: Required<Omit<WildlifeConfig, 'priorVisits'>> & { campsiteSeed: number };
  readonly roster: readonly WildlifeSpecies[];
  /** Every individual this campsite can produce, resident and transient. */
  readonly individuals: WildlifeIndividual[];
  readonly animals: WildlifeAnimal[];
  /** 0..1 how much the player is currently disturbing the place. */
  disturbance: number;
  /** Seconds of genuine stillness accumulated. */
  stillnessSeconds: number;
  /** 0..1 stillness shaped into a usable weight. */
  calm: number;
  /** The startle impulse applied this step. */
  startlePulse: number;
  elapsed: number;
  /** Cue field actually used this step, including derived stillness/quiet. */
  cues: WildlifeCueField;
  /** Objects an animal has already carried off, so it does not do it twice. */
  readonly takenObjectIds: string[];
  events: WildlifeEvent[];
  transientOrdinal: number;
}

/** Seconds of stillness at which calm is complete. */
const CALM_FULL_SECONDS = 150;
const CALM_START_SECONDS = 12;

export function createWildlife(config: WildlifeConfig): WildlifeState {
  const seed =
    typeof config.campsiteSeed === 'string' ? hashString(config.campsiteSeed) : config.campsiteSeed >>> 0;
  const individuals: WildlifeIndividual[] = [];
  for (const species of config.roster) {
    if (!species.canPersist) continue;
    const count = residentCount(seed, species.id);
    for (let i = 0; i < count; i++) {
      const resident = createResident(seed, species, i);
      resident.visits = config.priorVisits?.[resident.id] ?? 0;
      individuals.push(resident);
    }
  }
  return {
    config: {
      campsiteSeed: seed,
      roster: config.roster,
      maxConcurrent: config.maxConcurrent ?? 3,
      departureRadiusM: config.departureRadiusM ?? 30,
    },
    roster: config.roster,
    individuals,
    animals: [],
    disturbance: 0,
    stillnessSeconds: 0,
    calm: 0,
    startlePulse: 0,
    elapsed: 0,
    cues: {},
    takenObjectIds: [],
    events: [],
    transientOrdinal: 0,
  };
}

/** The residents of this campsite, whether or not they are here right now. */
export function residents(state: WildlifeState): readonly WildlifeIndividual[] {
  return state.individuals.filter((individual) => individual.persistent);
}

/* -------------------------------------------------------------------------- */
/* Sensing                                                                    */
/* -------------------------------------------------------------------------- */

function cueValue(cues: WildlifeCueField, cue: WildlifeCue): number {
  return clamp01(cues[cue] ?? 0);
}

/** Mean presence of the things a species likes. */
function attraction(species: WildlifeSpecies, cues: WildlifeCueField): number {
  if (species.attractedBy.length === 0) return 0;
  let total = 0;
  for (const cue of species.attractedBy) total += cueValue(cues, cue);
  return total / species.attractedBy.length;
}

/** Strongest presence of the things a species hates. Worst case, not average. */
function repulsion(species: WildlifeSpecies, cues: WildlifeCueField): number {
  let worst = 0;
  for (const cue of species.repelledBy) {
    const value = cueValue(cues, cue);
    if (value > worst) worst = value;
  }
  return worst;
}

function effectiveShyness(animal: { species: WildlifeSpecies; individual: WildlifeIndividual }): number {
  return clamp01(animal.species.shyness - animal.individual.boldness * 0.16);
}

function effectiveCuriosity(animal: { species: WildlifeSpecies; individual: WildlifeIndividual }): number {
  return clamp01(animal.species.curiosity + animal.individual.curiosityBias * 0.2);
}

/** How much the weather itself keeps animals in. Never fully — rain has visitors too. */
function weatherFactor(weather: WildlifeWeather | undefined): number {
  if (!weather) return 1;
  const rain = clamp01(weather.precipitation) * 0.45;
  const wind = smoothstep(3, 9, weather.windSpeed) * 0.3;
  // Fog is a *good* night for wildlife: sound carries oddly and cover is total.
  const fog = clamp01(weather.fog) * 0.12;
  return clamp(1 - rain - wind + fog, 0.15, 1.15);
}

/** Cues the weather supplies directly, unless the caller already said otherwise. */
function applyWeatherCues(cues: WildlifeCueField, weather: WildlifeWeather | undefined): void {
  if (!weather) return;
  if (cues.rain === undefined) cues.rain = clamp01(weather.precipitation);
  if (cues.wind === undefined) cues.wind = smoothstep(1.5, 6, weather.windSpeed);
  if (cues['cold-air'] === undefined) cues['cold-air'] = clamp01((6 - weather.temperatureC) / 14);
}

/* -------------------------------------------------------------------------- */
/* Appearance rate — the stillness mechanic                                   */
/* -------------------------------------------------------------------------- */

/** Mean seconds between visits for a species left entirely to itself. */
function baseGapSeconds(species: WildlifeSpecies): number {
  return lerp(70, 460, clamp01(species.shyness));
}

/**
 * How readily a species will show itself given the current stillness.
 *
 * The floor is what makes this *reveal rarer wildlife* rather than simply
 * "quiet is better": a bold species keeps a large floor and turns up whatever
 * the player is doing, while a shy one has a floor near zero and is reachable
 * only through the `calm` term. Monotone in `calm` for every species, and the
 * *ratio* of rare to common sightings rises with it.
 */
export function stillnessGate(shyness: number, calm: number): number {
  const s = clamp01(shyness);
  const floor = (1 - s) * (1 - s) * 0.9;
  const exponent = 0.6 + s * 5.5;
  return clamp01(floor + (1 - floor) * Math.pow(clamp01(calm), exponent));
}

/**
 * Expected appearances per second for a species under current conditions.
 *
 * Exported so the stillness relationship is directly assertable rather than
 * only observable through sampling.
 */
export function speciesAppearanceRate(
  state: WildlifeState,
  species: WildlifeSpecies,
  input: WildlifeInput,
): number {
  const inWindow = species.window.includes(input.window);
  // Out of window is rare, not impossible — animals keep their own hours.
  const windowFactor = inWindow ? 1 : 0.1;
  const appeal = clamp01(0.3 + attraction(species, state.cues) * 0.8 - repulsion(species, state.cues) * 1.1);
  const gate = stillnessGate(species.shyness, state.calm);
  const quiet = clamp01(1 - state.disturbance * 0.85);
  return (
    (1 / baseGapSeconds(species)) * windowFactor * appeal * gate * quiet * weatherFactor(input.weather)
  );
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

function emit(
  state: WildlifeState,
  kind: WildlifeEventKind,
  animal: WildlifeAnimal,
  extra: { trace?: string | null; objectId?: string | null } = {},
): void {
  state.events.push({
    kind,
    at: state.elapsed,
    speciesId: animal.species.id,
    speciesLabel: animal.species.label,
    individualId: animal.individual.id,
    persistent: animal.individual.persistent,
    visits: animal.individual.visits,
    rarity: clamp01(animal.species.shyness),
    position: vec3(animal.position.x, animal.position.y, animal.position.z),
    trace: extra.trace ?? null,
    objectId: extra.objectId ?? null,
  });
}

function setPosition(animal: WildlifeAnimal): void {
  animal.position.x = Math.sin(animal.bearing) * animal.distanceM;
  animal.position.y = 0;
  animal.position.z = Math.cos(animal.bearing) * animal.distanceM;
}

function setPhase(state: WildlifeState, animal: WildlifeAnimal, phase: AnimalPhase): void {
  if (animal.phase === phase) return;
  animal.phase = phase;
  animal.phaseSeconds = 0;
  if (phase === 'startled') emit(state, 'startled', animal);
  if (phase === 'watching') emit(state, 'settled', animal);
}

/** Chooses which individual turns up, preferring a resident who is due back. */
function chooseIndividual(state: WildlifeState, species: WildlifeSpecies, rng: Rng): WildlifeIndividual {
  if (species.canPersist) {
    const available = state.individuals.filter(
      (individual) =>
        individual.speciesId === species.id && individual.persistent && !individual.present && individual.cooldown <= 0,
    );
    // Residents dominate but do not monopolise — a campsite is not a cast list.
    if (available.length > 0 && rng.chance(0.8)) {
      return available[rng.int(0, available.length - 1)] as WildlifeIndividual;
    }
  }
  const transient = createTransient(species, state.transientOrdinal++, rng);
  state.individuals.push(transient);
  return transient;
}

function spawn(state: WildlifeState, species: WildlifeSpecies, rng: Rng): void {
  const individual = chooseIndividual(state, species, rng);
  individual.present = true;
  individual.visits += 1;
  const shy = clamp01(species.shyness - individual.boldness * 0.16);
  const curiosity = clamp01(species.curiosity + individual.curiosityBias * 0.2);
  const animal: WildlifeAnimal = {
    individual,
    species,
    phase: 'approaching',
    distanceM: state.config.departureRadiusM * rng.range(0.7, 1),
    bearing: rng.range(0, TAU),
    position: vec3(),
    drive: 1,
    alarm: shy * 0.25,
    interest: curiosity,
    phaseSeconds: 0,
    presentSeconds: 0,
    patienceSeconds: lerp(14, 70, curiosity) * rng.range(0.7, 1.4),
    targetObjectId: null,
    tookObject: false,
  };
  setPosition(animal);
  state.animals.push(animal);
  emit(state, 'appeared', animal);
}

function nearestObject(
  animal: WildlifeAnimal,
  state: WildlifeState,
  objects: readonly WildlifeObject[],
): WildlifeObject | null {
  let best: WildlifeObject | null = null;
  let bestDistance = Infinity;
  for (const object of objects) {
    if (state.takenObjectIds.includes(object.id)) continue;
    const d = horizontalDistance(animal.position, object.position);
    if (d < bestDistance) {
      bestDistance = d;
      best = object;
    }
  }
  return best;
}

function advanceDistance(animal: WildlifeAnimal, targetDistance: number, speed: number, dt: number): void {
  const delta = targetDistance - animal.distanceM;
  const step = Math.min(Math.abs(delta), speed * dt);
  animal.distanceM += Math.sign(delta) * step;
  setPosition(animal);
}

function departTrace(state: WildlifeState, animal: WildlifeAnimal, rng: Rng): void {
  if (animal.species.traces.length === 0) return;
  const curiosity = effectiveCuriosity(animal);
  // Something that came right in nearly always leaves a mark; something that
  // watched from the treeline usually does not.
  const chance = clamp01(0.15 + curiosity * 0.4 + (animal.tookObject ? 0.5 : 0) + animal.presentSeconds / 240);
  if (!rng.chance(chance)) return;
  const trace = rng.pick(animal.species.traces) ?? null;
  if (trace) emit(state, 'left-trace', animal, { trace });
}

/** Advances the ecosystem by one fixed timestep. */
export function stepWildlife(state: WildlifeState, input: WildlifeInput, dt: number, rng: Rng): void {
  state.elapsed += dt;

  // --- Disturbance and stillness ----------------------------------------
  state.startlePulse = clamp01(input.startle);
  const target = clamp01(
    clamp01(input.playerSpeed / 2.2) * 0.6 + clamp01(input.noise) * 0.8 + clamp01(input.lightSweep) * 0.7,
  );
  // Rises immediately, falls slowly: the place takes a while to settle again.
  state.disturbance = approach(state.disturbance, target, target > state.disturbance ? 5 : 0.22, dt);
  state.disturbance = clamp01(state.disturbance + state.startlePulse);

  if (state.disturbance < 0.12) {
    state.stillnessSeconds += dt;
  } else {
    // A single loud moment costs real time, which is what makes stillness a
    // mechanic rather than a modifier.
    state.stillnessSeconds = Math.max(0, state.stillnessSeconds - dt * (2 + state.disturbance * 40));
  }
  state.calm = smoothstep(CALM_START_SECONDS, CALM_FULL_SECONDS, state.stillnessSeconds);

  // --- Cue field ---------------------------------------------------------
  const cues: WildlifeCueField = { ...input.cues };
  applyWeatherCues(cues, input.weather);
  // Derived, never caller-supplied.
  cues.stillness = state.calm;
  cues.quiet = clamp01(1 - state.disturbance);
  cues.footsteps = clamp01(Math.max(cues.footsteps ?? 0, input.playerSpeed / 2.2));
  cues['sudden-movement'] = clamp01(Math.max(cues['sudden-movement'] ?? 0, state.startlePulse));
  cues.flashlight = clamp01(Math.max(cues.flashlight ?? 0, input.lightSweep));
  cues.voices = clamp01(Math.max(cues.voices ?? 0, input.noise));
  state.cues = cues;

  const objects = input.objects ?? [];

  // --- Individuals cooling off ------------------------------------------
  for (const individual of state.individuals) {
    if (individual.cooldown > 0) individual.cooldown = Math.max(0, individual.cooldown - dt);
  }

  // --- Appearances -------------------------------------------------------
  if (state.animals.length < state.config.maxConcurrent) {
    for (const species of state.roster) {
      if (state.animals.length >= state.config.maxConcurrent) break;
      if (state.animals.some((animal) => animal.species.id === species.id)) continue;
      const rate = speciesAppearanceRate(state, species, input);
      if (rate > 0 && rng.chance(rate * dt)) spawn(state, species, rng);
    }
  }

  // --- Behaviour ---------------------------------------------------------
  for (const animal of state.animals) {
    animal.phaseSeconds += dt;
    animal.presentSeconds += dt;

    const shy = effectiveShyness(animal);
    const curiosity = effectiveCuriosity(animal);
    const comfort = lerp(1.1, 13, shy);
    const repelled = repulsion(animal.species, cues);
    const attracted = attraction(animal.species, cues);

    // Threat is disturbance weighted by how nervous this animal is, plus
    // anything it specifically dislikes, plus the raw startle impulse.
    const threat = clamp01(
      state.disturbance * (0.35 + shy * 0.95) + state.startlePulse * (0.5 + shy) + repelled * 0.85,
    );
    animal.alarm = approach(animal.alarm, threat, threat > animal.alarm ? 7 : 0.3, dt);
    animal.interest = approach(animal.interest, clamp01(curiosity * 0.55 + attracted * 0.7 - animal.alarm), 0.5, dt);

    const startleThreshold = 0.32 + (1 - shy) * 0.42;
    const fleeing = animal.phase === 'fleeing' || animal.phase === 'gone';
    if (!fleeing && animal.alarm > startleThreshold && animal.phase !== 'startled') {
      setPhase(state, animal, 'startled');
    }

    switch (animal.phase) {
      case 'approaching': {
        const speed = lerp(0.7, 2.2, 1 - shy) * (0.7 + animal.interest * 0.6);
        advanceDistance(animal, comfort, speed, dt);
        animal.drive = 1;
        if (animal.distanceM <= comfort + 0.35) setPhase(state, animal, 'watching');
        break;
      }
      case 'watching': {
        // Small idle drift so a watching animal is never a statue.
        const jitter = Math.sin(state.elapsed * 0.7 + animal.bearing * 3) * 0.12;
        advanceDistance(animal, comfort + jitter, 0.5, dt);
        animal.drive = 0.2;
        const target = animal.species.investigatesObjects ? nearestObject(animal, state, objects) : null;
        if (target && animal.interest > 0.45 && animal.alarm < 0.25) {
          animal.targetObjectId = target.id;
          animal.bearing = Math.atan2(target.position.x, target.position.z);
          setPhase(state, animal, 'investigating');
        } else if (animal.presentSeconds > animal.patienceSeconds) {
          // Leaves of its own accord. Calm departure, not flight.
          departTrace(state, animal, rng);
          setPhase(state, animal, 'fleeing');
        }
        break;
      }
      case 'investigating': {
        const target = objects.find((object) => object.id === animal.targetObjectId) ?? null;
        if (!target || state.takenObjectIds.includes(target.id)) {
          animal.targetObjectId = null;
          setPhase(state, animal, 'watching');
          break;
        }
        const objectDistance = horizontalDistance(vec3(0, 0, 0), target.position);
        advanceDistance(animal, objectDistance, lerp(0.5, 1.6, curiosity), dt);
        animal.drive = 0.6;
        if (Math.abs(animal.distanceM - objectDistance) < 0.4 && animal.phaseSeconds > 0.8) {
          emit(state, 'investigated', animal, { objectId: target.id });
          const stealChance = clamp01((target.portable ? 0.35 : 0) + (target.food ? 0.3 : 0) + curiosity * 0.35);
          if (target.portable && rng.chance(stealChance)) {
            state.takenObjectIds.push(target.id);
            animal.tookObject = true;
            emit(state, 'took-object', animal, { objectId: target.id });
            departTrace(state, animal, rng);
            setPhase(state, animal, 'fleeing');
          } else {
            animal.targetObjectId = null;
            setPhase(state, animal, 'watching');
          }
        }
        break;
      }
      case 'startled': {
        // A beat of absolute stillness, then it commits.
        animal.drive = 0;
        if (animal.phaseSeconds > lerp(0.25, 1.4, 1 - shy)) {
          if (animal.alarm < startleThreshold * 0.5) {
            // The noise stopped in time. It goes back to watching.
            setPhase(state, animal, 'watching');
          } else {
            departTrace(state, animal, rng);
            setPhase(state, animal, 'fleeing');
          }
        }
        break;
      }
      case 'fleeing': {
        animal.drive = -1;
        const speed = animal.alarm > 0.4 ? lerp(3.5, 6.5, 1 - shy) : 1.4;
        advanceDistance(animal, state.config.departureRadiusM + 2, speed, dt);
        if (animal.distanceM >= state.config.departureRadiusM) setPhase(state, animal, 'gone');
        break;
      }
      default:
        break;
    }
  }

  // --- Removal -----------------------------------------------------------
  for (let i = state.animals.length - 1; i >= 0; i--) {
    const animal = state.animals[i] as WildlifeAnimal;
    if (animal.phase !== 'gone') continue;
    emit(state, 'departed', animal);
    animal.individual.present = false;
    // Residents wait a while before coming back so recurrence stays a pleasure.
    animal.individual.cooldown = animal.individual.persistent
      ? lerp(90, 400, clamp01(animal.species.shyness)) * rng.range(0.7, 1.3)
      : Infinity;
    state.animals.splice(i, 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

/** Takes the events emitted since the last drain. */
export function drainWildlifeEvents(state: WildlifeState): WildlifeEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

export interface WildlifeSignals {
  /** Animals currently in the world. */
  present: number;
  /** Closest animal in metres, or Infinity. */
  nearestM: number;
  /** 0..1 how disturbed the place is. */
  disturbance: number;
  /** Seconds of accumulated stillness. */
  stillnessSeconds: number;
  /** 0..1 shaped stillness — what the rare species are gated on. */
  calm: number;
  /** True while something shy is watching from the dark. */
  watched: boolean;
}

export function wildlifeSignals(state: WildlifeState): WildlifeSignals {
  let nearest = Infinity;
  let watched = false;
  for (const animal of state.animals) {
    if (animal.distanceM < nearest) nearest = animal.distanceM;
    if (animal.phase === 'watching' && animal.species.shyness > 0.6) watched = true;
  }
  return {
    present: state.animals.length,
    nearestM: nearest,
    disturbance: state.disturbance,
    stillnessSeconds: state.stillnessSeconds,
    calm: state.calm,
    watched,
  };
}

/** The animals in the world right now, nearest first. */
export function presentAnimals(state: WildlifeState): readonly WildlifeAnimal[] {
  return [...state.animals].sort((a, b) => a.distanceM - b.distanceM);
}

/**
 * Turns a wildlife event into evidence for the significance model.
 *
 * The rarity handed over is the species' shyness: the flying squirrel that
 * only comes for a still player is exactly the sighting a campsite should
 * remember. Nothing here writes anything.
 */
export function wildlifeEvidence(
  event: WildlifeEvent,
  overrides: Partial<SignificanceEvidence> = {},
): SignificanceEvidence {
  return createEvidence('wildlife-encounter', {
    rarity: event.rarity,
    isFirst: event.visits <= 1,
    interactionCount: Math.max(1, event.visits),
    ...overrides,
  });
}

/**
 * A warm, factual line for the Passport — never a compendium entry.
 *
 * Recognition is the point (§7): a resident is described by the detail a
 * player would actually have noticed, and there is no count, no percentage and
 * no "1 of 4" anywhere in it.
 */
export function describeSighting(event: WildlifeEvent): string {
  if (event.persistent && event.visits > 1) {
    return `${event.speciesLabel}, again.`;
  }
  return event.speciesLabel;
}

/** The recognisable detail of a resident, for the same purpose. */
export function describeIndividual(individual: WildlifeIndividual): string {
  return individual.persistent && individual.markings ? individual.markings : '';
}
