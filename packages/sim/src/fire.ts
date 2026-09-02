/**
 * The campfire.
 *
 * The fire looks crunchy and PS1 on the surface but behaves systemically
 * underneath (spec §4.1). It is deliberately *forgiving*: this is not a
 * survival game, so the ember bed always allows recovery and fuel is never
 * scarce.
 *
 * The model's one real teaching point is that **embers roast better than
 * flames** — steady, low, wide, wind-boosted heat versus a hot, tall,
 * unstable, wind-deflected column. Nothing tells the player this; the fire
 * and the marshmallow simply behave that way (spec deviation D4).
 */

import { approach, clamp, clamp01, lerp, smoothstep } from './math.js';
import { fbm1D, type Rng } from './rng.js';

/** A species of firewood. Content data, not engine code. */
export interface WoodType {
  readonly id: string;
  readonly label: string;
  /** Heat released per unit mass burned. */
  readonly heatOutput: number;
  /** Mass consumed per second at full oxygen when fully alight. A split
   * log holds a flame for roughly ten minutes at these rates. */
  readonly burnRate: number;
  /** Fraction of consumed mass that becomes ember bed rather than ash. */
  readonly emberYield: number;
  /** How readily it catches from ambient heat. */
  readonly ignitability: number;
  /** Smoke produced while damp and burning. */
  readonly smokiness: number;
  /** Visual/audible spark and pop character. */
  readonly sparkiness: number;
  /** Default moisture when found at a campsite (0 = kiln dry, 1 = soaked). */
  readonly defaultMoisture: number;
  /**
   * Split-face colour, so a woodpile is visibly mixed.
   *
   * The pile has always handed you the species of the individual log you
   * reached for -- that is what `onPick` does -- but every log was drawn in the
   * same material, so the most consequential choice at the campsite was
   * indistinguishable from a random one. Pale woods here are the light, fast,
   * poor-ember ones and dark woods are the dense, slow, good-ember ones, which
   * is both true of real wood and the whole lesson this system has to teach.
   */
  readonly bark: number;
  /**
   * What it is like in your hands, said once when you pick it up.
   *
   * Deliberately sensory rather than numeric. The player is meant to end up
   * knowing that the heavy dark one makes the bed worth roasting over, and to
   * know it from having handled it rather than from having read a burn rate.
   */
  readonly note: string;
}

export const WOOD_TYPES: Record<string, WoodType> = {
  pine: {
    id: 'pine',
    label: 'Pine',
    heatOutput: 1.05,
    burnRate: 0.0042,
    emberYield: 0.2,
    ignitability: 1.35,
    smokiness: 0.55,
    sparkiness: 1.5,
    defaultMoisture: 0.2,
    bark: 0x6b4a32,
    note:
      'Light, and sticky with resin. It will take from almost nothing, and be gone about as quickly.',
  },
  oak: {
    id: 'oak',
    label: 'Oak',
    heatOutput: 1.3,
    burnRate: 0.0019,
    emberYield: 0.46,
    ignitability: 0.6,
    smokiness: 0.25,
    sparkiness: 0.4,
    defaultMoisture: 0.24,
    bark: 0x4a3a2a,
    note:
      'Heavy for its size. It will not take on a cold fire — but it leaves a bed worth roasting over.',
  },
  birch: {
    id: 'birch',
    label: 'Birch',
    heatOutput: 1.12,
    burnRate: 0.0031,
    emberYield: 0.3,
    ignitability: 1.15,
    smokiness: 0.3,
    sparkiness: 0.7,
    defaultMoisture: 0.22,
    bark: 0xcfc7b2,
    note:
      'Paper bark, peeling off in your hand. Lights easily and burns clean.',
  },
  driftwood: {
    id: 'driftwood',
    label: 'Driftwood',
    heatOutput: 0.95,
    burnRate: 0.0029,
    emberYield: 0.26,
    ignitability: 0.95,
    smokiness: 0.4,
    // Salt-laden driftwood spits and throws coloured flame.
    sparkiness: 1.8,
    defaultMoisture: 0.38,
    bark: 0x9a9a94,
    note:
      'Silvered and salt-dry. Burns with odd colours in it.',
  },
  aspen: {
    id: 'aspen',
    label: 'Aspen',
    heatOutput: 0.86,
    burnRate: 0.0045,
    emberYield: 0.16,
    ignitability: 1.25,
    smokiness: 0.35,
    sparkiness: 0.5,
    defaultMoisture: 0.26,
    bark: 0xb9ae96,
    note:
      'So light it hardly feels like wood. Good for getting a fire started and for little else.',
  },
  mesquite: {
    id: 'mesquite',
    label: 'Mesquite',
    heatOutput: 1.4,
    burnRate: 0.0015,
    emberYield: 0.55,
    ignitability: 0.45,
    smokiness: 0.2,
    sparkiness: 0.3,
    defaultMoisture: 0.18,
    bark: 0x33251c,
    note:
      'Dense as stone, and about as reluctant. Nothing makes better coals.',
  },
};

export function woodType(id: string): WoodType {
  return WOOD_TYPES[id] ?? (WOOD_TYPES['pine'] as WoodType);
}

/**
 * How finely divided a piece of fuel is.
 *
 * Not a species — a birch log and a birch twig are the same wood. Grade is
 * what decides whether a piece will take from a bed of coals sitting at two
 * hundred degrees or wants a fire that is already going, and it is the reason
 * you cannot wake last night's embers by dropping a split log on them.
 */
export type FuelGrade = 'tinder' | 'kindling' | 'log';

export interface GradeCharacter {
  /** Mass of one piece, relative to a standard split log. */
  readonly mass: number;
  /** Multiplier on the wood's own ignitability. */
  readonly catches: number;
  /** Multiplier on burn rate. Thin fuel has far more surface per unit mass. */
  readonly burns: number;
  /** What you would call an armful of it. */
  readonly label: string;
}

export const FUEL_GRADES: Record<FuelGrade, GradeCharacter> = {
  tinder: { mass: 0.03, catches: 3.4, burns: 7, label: 'tinder' },
  kindling: { mass: 0.16, catches: 1.9, burns: 2.6, label: 'kindling' },
  log: { mass: 1, catches: 1, burns: 1, label: 'a split log' },
};

export function fuelGrade(grade: FuelGrade): GradeCharacter {
  return FUEL_GRADES[grade] ?? FUEL_GRADES.log;
}

/** The pit, in metres. Every spot is relative to its centre. */
export const PIT = {
  /** Radius of the glowing bed. Fuel inside this lights. */
  bedRadius: 0.2,
  /** Inner face of the stone ring — the far edge of anywhere wood can go. */
  ringRadius: 0.42,
} as const;

/** How close two pieces have to be before they start smothering each other. */
const CROWD_RADIUS = 0.16;

/** How close a piece has to land to another before it ends up resting on it. */
const SUPPORT_RADIUS = 0.19;

/**
 * Where a piece of fuel sits in the pit, and how it lies.
 *
 * This is the whole of the arranging verb. Airflow, the heat a piece receives,
 * and whether it dries or burns are all read off these four numbers every
 * step — none of them is a quality the player sets directly any more. Move the
 * wood and the fire changes, which is the only honest way to teach that how
 * you build a fire *is* the fire.
 */
export interface LogSpot {
  /** Metres from the pit centre along X. */
  x: number;
  /** Metres from the pit centre along Z. */
  z: number;
  /** Bearing the piece lies along, radians. */
  angle: number;
  /**
   * 0 = flat on the bed. 1 = one end up on the pile, leaned in over the coals.
   *
   * Leaned wood has air under it and its raised end stands in the flame
   * column; flat wood in a heap has neither. A ring of leaned logs is a tepee
   * and draws like a chimney. The same logs knocked flat make an ember bed.
   */
  lean: number;
}

/** A spot at a bearing and distance from the centre of the pit. */
export function spotFrom(radius: number, bearing: number, lean = 0): LogSpot {
  return {
    x: Math.cos(bearing) * radius,
    z: Math.sin(bearing) * radius,
    // Wood laid on a bed lies across the radius; wood leaned in points at the
    // middle. Everything between is between.
    angle: bearing + lerp(Math.PI / 2, Math.PI, clamp01(lean)),
    lean: clamp01(lean),
  };
}

/**
 * The lean a piece of fuel takes when you set it down here.
 *
 * You never choose a lean. You choose where to put the wood, and the wood does
 * what wood does: laid across another piece it ends up propped on it, laid on
 * bare ash it lies flat. Which means building a tepee is the same action as
 * leaning three logs against each other — the thing a person would say they
 * were doing — rather than a mode, a control, or a number anyone has to know
 * about.
 */
export function restingLean(fire: FireState, x: number, z: number, ignoreId?: string): number {
  const r = Math.hypot(x, z);
  let support = 0;
  for (const other of fire.logs) {
    if (other.id === ignoreId || other.mass <= 0.02) continue;
    const d = Math.hypot(other.spot.x - x, other.spot.z - z);
    if (d >= SUPPORT_RADIUS) continue;
    // Wood laid inside another piece rides up over it; wood laid outside it
    // mostly just lies alongside.
    const inward = r < Math.hypot(other.spot.x, other.spot.z) ? 1 : 0.55;
    support += other.mass * (1 - d / SUPPORT_RADIUS) * inward;
  }
  return clamp01(support * 1.15);
}

/**
 * Where a piece lands when it is dropped in without aim.
 *
 * On the fire, which is what a person tossing a log on a fire is aiming at.
 * The first version spread successive pieces around the pit on a golden angle
 * so nothing ever touched anything, and the result was a fire made of lone
 * flat logs with an airflow of about a quarter — every one of them smouldering
 * at a third alight for twenty minutes and never really burning. That is what
 * a badly built fire *should* look like, and it is not what you get for
 * throwing a log on one.
 *
 * So it goes near what is already burning, offset enough not to stack straight
 * on top of it. `restingLean` then does the rest: the piece comes to rest
 * against the pile the way wood does, and a fire you never think about is a
 * reasonable fire. Arranging it deliberately is still better, and heaping it
 * all in one place is still worse.
 */
export function freeSpot(fire: FireState, lean = 0.45): LogSpot {
  let x = 0;
  let z = 0;
  let mass = 0;
  for (const log of fire.logs) {
    if (log.mass <= 0.02) continue;
    x += log.spot.x * log.mass;
    z += log.spot.z * log.mass;
    mass += log.mass;
  }
  const centreX = mass > 0 ? x / mass : 0;
  const centreZ = mass > 0 ? z / mass : 0;
  // Successive pieces go round the pile rather than onto the same point, so an
  // armful thrown on in one go still ends up as a stack and not as a column.
  const bearing = fire.logs.length * 2.399963229728653;
  const offset = SUPPORT_RADIUS * 0.62;
  const spotX = centreX + Math.cos(bearing) * offset;
  const spotZ = centreZ + Math.sin(bearing) * offset;
  const radius = Math.min(PIT.bedRadius * 0.92, Math.hypot(spotX, spotZ));
  const heading = Math.atan2(spotZ, spotX);
  return spotFrom(radius, heading, lean);
}

/** A single piece of fuel in the pit. */
export interface Log {
  readonly id: string;
  readonly woodId: string;
  /** Split log, kindling, or a handful of twigs. */
  readonly grade: FuelGrade;
  /** Remaining mass, 0..1-ish relative to a standard split log. */
  mass: number;
  /** 0 = bone dry, 1 = soaked. Must boil off before the piece burns properly. */
  moisture: number;
  /** How alight this piece is, 0..1. */
  ignition: number;
  /** Where it lies. The only part of a piece of fuel the player sets. */
  spot: LogSpot;
  /** Accumulated seconds this piece has been burning — drives visual charring. */
  burnedFor: number;
  /**
   * Read off `spot` and the neighbours every step. Never set by hand.
   *
   * `airflow` is how freely air reaches it, `heat` the share of the bed's heat
   * fierce enough to light it, and `radiance` the gentler share that merely
   * dries it. The gap between the last two is the drying rack: radiant heat
   * carries out to the stones, ignition heat does not.
   */
  airflow: number;
  heat: number;
  radiance: number;
  /** Steam coming off it, 0..1. Read by the renderer and by audio. */
  steam: number;
}

/**
 * How the fuel in the pit is stacked, in a word.
 *
 * The player never sees a number for airflow. They see wood, and they get told
 * — once, when it changes — what they have built. This is the vocabulary.
 */
export type Arrangement = 'empty' | 'tepee' | 'cabin' | 'heaped' | 'spread';

export function describeArrangement(fire: FireState): Arrangement {
  let mass = 0;
  let leanSum = 0;
  let airSum = 0;
  for (const log of fire.logs) {
    if (log.mass <= 0.02) continue;
    mass += log.mass;
    leanSum += log.spot.lean * log.mass;
    airSum += log.airflow * log.mass;
  }
  if (mass <= 0.02) return 'empty';
  const lean = leanSum / mass;
  const air = airSum / mass;
  if (lean > 0.55) return 'tepee';
  if (lean < 0.28) return air < 0.3 ? 'heaped' : 'spread';
  return 'cabin';
}

/** Said once, when the shape of the fire changes. Never a number. */
export function arrangementNote(arrangement: Arrangement): string {
  switch (arrangement) {
    case 'tepee':
      return 'The wood leans together over the coals. It draws like a chimney.';
    case 'cabin':
      return 'Stacked with the gaps left in. It will burn a long time like this.';
    case 'heaped':
      return 'Piled on top of itself. There is no air in there.';
    case 'spread':
      return 'Laid out flat and wide. Low heat, and a good bed under it.';
    case 'empty':
    default:
      return 'Nothing but coals in the pit.';
  }
}

export interface FireConfig {
  /** Ambient air temperature in °C. */
  ambientC: number;
  /** How much wind the pit is exposed to, 0..1 (a sheltered hollow is low). */
  exposure: number;
  /** Radius of the ember bed in metres. */
  emberRadius: number;
}

export const DEFAULT_FIRE_CONFIG: FireConfig = {
  ambientC: 14,
  exposure: 0.55,
  emberRadius: 0.34,
};

export interface FireState {
  logs: Log[];
  /** Mass of glowing coals. */
  emberMass: number;
  /** Ember bed temperature, °C. Coals sit far hotter than flame air. */
  emberTemp: number;
  /** Airflow available to the fire, 0..1. */
  oxygen: number;
  /** Instantaneous combustion rate — the driver of flame size. */
  combustion: number;
  /** Smoothed flame intensity, 0..1. */
  flame: number;
  /** Flame column height in metres. */
  flameHeight: number;
  /** Visible smoke, 0..1. */
  smoke: number;
  /** Wind speed in m/s at the pit. */
  windSpeed: number;
  /** Wind direction in radians (world Y rotation). */
  windDirection: number;
  /** Seconds since this fire was lit. */
  elapsed: number;
  /** Poke/fan impulse that temporarily boosts oxygen. */
  bellows: number;
  /**
   * Ash raked up over the coals, 0..1.
   *
   * Banking is the real technique and it does real work here. Ash starves the
   * flame, holds the heat down in the bed, and keeps the rain off it. It is
   * how a fire survives a shower without you standing over it, and how it
   * survives the night to be woken tomorrow. Some of it accumulates on its
   * own, which is why a fire left alone for ten minutes wants raking — but
   * never enough on its own to cost you the evening, only its pace.
   */
  ashCover: number;
  /**
   * How much of the fuel is leaned into a cone over the bed, 0..1.
   *
   * The fire's shape, in one number: a chimney at 1, a flat bed at 0. Drives
   * flame height, and trades against the coals a fire leaves behind.
   */
  draught: number;
  /**
   * Rain falling into the pit, 0..1. Written by the caller each step.
   *
   * The fire is the only thing that knows what rain does to a fire, so the
   * weather hands it the number and stays out of the rest.
   */
  rain: number;
  /** Rolling counter used to schedule crackles deterministically. */
  crackleAccumulator: number;
  /** Crackles emitted on the most recent step — read by audio and particles. */
  cracklesThisStep: number;
  config: FireConfig;
}

/**
 * How far ash builds on its own.
 *
 * Deliberately short of the point where coals stop being roastable: neglect
 * should make a fire sluggish and ask for a rake, never take the night away
 * from someone who forgot about it (spec §4.1).
 */
const NATURAL_ASH_CEILING = 0.38;

let logCounter = 0;

export function createLog(woodId: string, options?: Partial<Log>): Log {
  const wood = woodType(woodId);
  const grade = options?.grade ?? 'log';
  return {
    id: options?.id ?? `log-${++logCounter}`,
    woodId: wood.id,
    grade,
    mass: options?.mass ?? fuelGrade(grade).mass,
    moisture: options?.moisture ?? wood.defaultMoisture,
    ignition: options?.ignition ?? 0,
    spot: options?.spot ?? spotFrom(0.1, 0, 0.45),
    burnedFor: options?.burnedFor ?? 0,
    airflow: 0.5,
    heat: 0,
    radiance: 0,
    steam: 0,
  };
}

/** Resets the log id counter — tests need reproducible ids. */
export function resetLogIds(): void {
  logCounter = 0;
}

export function createFire(config: Partial<FireConfig> = {}): FireState {
  const merged = { ...DEFAULT_FIRE_CONFIG, ...config };
  return {
    logs: [],
    emberMass: 0,
    emberTemp: merged.ambientC,
    oxygen: 0.7,
    combustion: 0,
    flame: 0,
    flameHeight: 0,
    smoke: 0,
    windSpeed: 0.6,
    windDirection: 0,
    elapsed: 0,
    bellows: 0,
    ashCover: 0,
    draught: 0,
    rain: 0,
    crackleAccumulator: 0,
    cracklesThisStep: 0,
    config: merged,
  };
}

/**
 * Starts a fire that has already been burning for a while — used when a player
 * arrives at a campsite where the fire is established, and when restoring a
 * persisted campsite.
 */
export function createEstablishedFire(config: Partial<FireConfig> = {}): FireState {
  const fire = createFire(config);
  // Sized so the fire is lively on arrival and settles to a proper ember bed
  // after two or three minutes — roughly when a player who has looked around
  // reaches the roasting stage. It has to fit inside the 5-8 minute ritual:
  // a five-minute wait for coals would be a chore. Flame brightness comes
  // from burn *rate*, not fuel mass, so a smaller load burns just as
  // brightly, for less long.
  // Leaned in against each other over the bed: what a fire someone has been
  // tending for a few minutes actually looks like.
  fire.logs.push(
    createLog('oak', {
      mass: 0.2,
      moisture: 0.04,
      ignition: 0.95,
      burnedFor: 300,
      spot: spotFrom(0.12, 0.4, 0.5),
    }),
  );
  fire.logs.push(
    createLog('pine', {
      mass: 0.1,
      moisture: 0.03,
      ignition: 0.9,
      burnedFor: 240,
      spot: spotFrom(0.12, 3.6, 0.5),
    }),
  );
  fire.emberMass = 0.55;
  fire.emberTemp = 620;
  fire.oxygen = 0.72;
  fire.combustion = 0.004;
  fire.flame = 0.85;
  fire.flameHeight = 0.7;
  fire.elapsed = 260;
  // A fire someone has been tending for a few minutes has a little ash under
  // it, but not enough to be asking for anything yet.
  fire.ashCover = 0.05;
  return fire;
}

/**
 * The pit as you find it when you come back to a campsite you have used.
 *
 * Cold to look at: grey ash, no flame, nothing moving, and a player who has
 * never done this will reasonably conclude the fire is out. It is not. There
 * are a few coals in there still holding two hundred degrees under the cover
 * they were left under, and finding them is the first thing you do tonight —
 * rake the ash back, blow on what is underneath until it colours, and give it
 * something fine enough to catch.
 */
export function createBankedFire(config: Partial<FireConfig> = {}): FireState {
  const fire = createFire(config);
  fire.emberMass = 0.13;
  fire.emberTemp = 232;
  fire.ashCover = 0.94;
  fire.oxygen = 0.24;
  fire.flame = 0;
  fire.flameHeight = 0;
  fire.combustion = 0;
  return fire;
}

/** Where a piece of fuel is being put, with the parts the wood decides left out. */
export type LogPlacement = { x: number; z: number; angle?: number; lean?: number };

export interface AddFuelOptions {
  grade?: FuelGrade;
  /**
   * Where it goes. Omitted means dropped in without aim.
   *
   * A lean is not required and is usually wrong to give: laying wood down is
   * choosing a place, and how it ends up lying is a question about what is
   * already in the pit. Pass one only to describe a fire that is already built.
   */
  spot?: LogPlacement;
  moisture?: number;
  mass?: number;
}

export function addLog(fire: FireState, woodId: string, options: AddFuelOptions = {}): Log {
  const grade = options.grade ?? 'log';
  // A piece put down without a spot still lands somewhere real, and a piece
  // put down without a lean still lies the way the wood already in the pit
  // makes it lie.
  const placed = options.spot ?? freeSpot(fire, 0);
  const lean = placed.lean ?? restingLean(fire, placed.x, placed.z);
  const spot: LogSpot = {
    x: placed.x,
    z: placed.z,
    angle: placed.angle ?? Math.atan2(placed.z, placed.x) + lerp(Math.PI / 2, Math.PI, lean),
    lean: clamp01(lean),
  };
  const log = createLog(woodId, {
    grade,
    spot,
    ...(options.moisture === undefined ? {} : { moisture: options.moisture }),
    ...(options.mass === undefined ? {} : { mass: options.mass }),
  });
  fire.logs.push(log);
  return log;
}

/**
 * Raking the coals: pulls the ash back off the bed, spreads it, admits air,
 * and knocks the stack down flat.
 *
 * The flattening is not incidental. Raking is what you do when you have
 * finished getting a fire going and want something to cook over: it trades a
 * tall drawing flame for a low wide bed, which is the trade the whole roasting
 * model is built on. It also costs a little ember temperature, because coals
 * that were insulated are now in the open air.
 */
export function rakeEmbers(fire: FireState, strength = 1): void {
  const s = clamp01(strength);
  fire.bellows = clamp01(fire.bellows + 0.55 * s);
  fire.ashCover = clamp01(fire.ashCover - 0.55 * s);
  fire.emberTemp = lerp(fire.emberTemp, fire.emberTemp * 0.94 + 60, s * 0.5);
  for (const log of fire.logs) {
    log.spot.lean = clamp01(log.spot.lean - 0.24 * s);
    // Spread outward a little, the way a rake actually moves a pile.
    const r = Math.hypot(log.spot.x, log.spot.z);
    if (r > 1e-4) {
      const grown = Math.min(PIT.ringRadius * 0.72, r + 0.028 * s);
      log.spot.x = (log.spot.x / r) * grown;
      log.spot.z = (log.spot.z / r) * grown;
    }
  }
}

/**
 * Banking: raking ash up over the coals.
 *
 * What you do when the rain comes in, and what you do before you go to bed. It
 * starves the flame within a minute or so, holds the heat down in the bed, and
 * keeps water off it. A banked fire is not a dead fire — it is a fire you have
 * put away, and it is waiting for you.
 */
export function bankFire(fire: FireState, strength = 1): void {
  const s = clamp01(strength);
  fire.ashCover = clamp01(fire.ashCover + 0.45 * s);
  fire.bellows = 0;
}

/**
 * Blowing or fanning: a short, strong oxygen impulse — and, on coals that are
 * not buried, the heat that comes with it.
 *
 * The second half is why anyone kneels down and blows on a fire: air on coals
 * makes them glow hotter, right then, which is what gets fine fuel to take.
 */
export function fanFire(fire: FireState, strength = 1): void {
  const s = clamp01(strength);
  fire.bellows = clamp01(fire.bellows + 0.8 * s);
  const reaches = 1 - fire.ashCover * 0.8;
  if (fire.emberMass > 0.01) {
    fire.emberTemp = Math.min(860, fire.emberTemp + 58 * s * reaches);
  }
}

/**
 * Moves one piece of fuel. The arranging verb, as the player performs it.
 *
 * Takes a partial spot so a drag can move a log across the pit without
 * deciding anything about its lean, and a nudge can tip it up without moving
 * it. Positions are clamped inside the stone ring, because outside it the pit
 * has no opinion about the wood at all.
 */
export function repositionLog(fire: FireState, logId: string, spot: Partial<LogSpot>): void {
  const log = fire.logs.find((l) => l.id === logId);
  if (!log) return;

  let x = spot.x ?? log.spot.x;
  let z = spot.z ?? log.spot.z;
  const r = Math.hypot(x, z);
  if (r > PIT.ringRadius) {
    x = (x / r) * PIT.ringRadius;
    z = (z / r) * PIT.ringRadius;
  }

  // A move that says only where means the wood lies however the wood already
  // in the pit makes it lie: across the pile it rides up, on bare ash it lies
  // down. Nobody sets a lean; they set a place.
  const lean = spot.lean === undefined ? restingLean(fire, x, z, log.id) : clamp01(spot.lean);
  const angle = spot.angle ?? Math.atan2(z, x) + lerp(Math.PI / 2, Math.PI, lean);
  log.spot = { x, z, angle, lean };
}

/**
 * Advances the fire by one fixed timestep.
 *
 * `rng` is used only for stochastic crackles and spark timing; the energetic
 * model itself is fully deterministic given the same inputs.
 */
export function stepFire(fire: FireState, dt: number, rng: Rng): void {
  const { config } = fire;
  fire.elapsed += dt;
  fire.cracklesThisStep = 0;

  // --- Wind ------------------------------------------------------------
  // Value noise rather than random walk, so gusts have shape and replay
  // identically.
  const gust = fbm1D(0x5eed, fire.elapsed * 0.16, 3);
  const targetWind = lerp(0.15, 3.4, gust) * config.exposure;
  fire.windSpeed = approach(fire.windSpeed, targetWind, 0.7, dt);
  fire.windDirection += (fbm1D(0xa11e, fire.elapsed * 0.05, 2) - 0.5) * 0.35 * dt;

  // --- Geometry --------------------------------------------------------
  // Everything the player controls about a piece of fuel is read off where
  // they put it, here, once a step. Nothing below is stored between steps.
  let airSum = 0;
  let massSum = 0;
  let draughtSum = 0;
  for (const log of fire.logs) {
    const spot = log.spot;
    const r = Math.hypot(spot.x, spot.z);

    // Over the coals, where wood lights. Falls away fast: the difference
    // between the middle of the pit and the stones around it is the
    // difference between burning and not.
    const overBed = 1 - smoothstep(PIT.bedRadius * 0.5, PIT.ringRadius, r);
    // Radiant heat carries much further than the heat that will light a log.
    // That gap is the drying rack, and it is just part of the pit: wood parked
    // out on the stones dries there for as long as you leave it and never
    // catches.
    const reach = 1 - smoothstep(PIT.bedRadius, PIT.ringRadius * 1.7, r);

    // Neighbours smother. Wood packed flat together has no air in it; wood
    // leaned up keeps a gap under itself however tightly it is stacked.
    let smother = 0;
    for (const other of fire.logs) {
      if (other === log) continue;
      const d = Math.hypot(other.spot.x - spot.x, other.spot.z - spot.z);
      if (d >= CROWD_RADIUS) continue;
      smother += other.mass * (1 - d / CROWD_RADIUS) * (1 - other.spot.lean * 0.6);
    }

    // Flat wood lies down in the coals; leaned wood stands up in the flame.
    // Both are in the heat — the difference between them is air, not warmth,
    // and air is `airflow` below.
    log.heat = clamp01(overBed * (0.9 + spot.lean * 0.14));
    log.radiance = clamp01(reach * 0.92 + log.heat * 0.08);
    /*
     * Air, and what takes it away.
     *
     * The baseline is what a piece lying by itself on an open bed gets, which
     * is plenty: it is in the open air. The first calibration started it at
     * 0.3 and read every unobstructed log as half strangled — one split log
     * dropped on a healthy fire sat at a third alight for twenty minutes and
     * never properly burned, which is not what happens when you put a log on a
     * fire. Leaning adds to it, because a chimney draws. Neighbours take it
     * away, because that is what smothering is. And ash over the top takes
     * nearly all of it, which is why banking a fire that still has wood
     * burning on it works at all.
     */
    log.airflow = clamp01(0.5 + spot.lean * 0.36 - smother * 0.5) * (1 - fire.ashCover * 0.72);

    airSum += log.airflow * log.mass;
    massSum += log.mass;
    draughtSum += spot.lean * overBed * log.mass;
  }
  fire.draught = massSum > 0 ? clamp01(draughtSum / massSum) : 0;

  // --- Ash -------------------------------------------------------------
  // Ash builds under a fire that has been burning a while and quietly chokes
  // it. Capped well short of putting anything out: neglect costs you the pace
  // of your evening, never the evening.
  const emberBurn =
    fire.emberMass * 0.0009 * (0.5 + fire.oxygen * 0.8) * (1 - fire.ashCover * 0.85);
  if (fire.ashCover < NATURAL_ASH_CEILING) {
    fire.ashCover = Math.min(NATURAL_ASH_CEILING, fire.ashCover + emberBurn * 2 * dt);
  }

  // --- Oxygen ----------------------------------------------------------
  // Airflow comes from how the fuel is stacked plus wind, is choked by piling
  // too much into the pit at once, and is smothered by ash over the bed.
  const placementQuality = massSum > 0 ? airSum / massSum : 0.7;
  const crowding = smoothstep(2.2, 4.6, massSum); // too much fuel smothers
  const windAssist = smoothstep(0, 2.6, fire.windSpeed) * 0.28;
  const targetOxygen = clamp01(
    0.35 + placementQuality * 0.45 + windAssist - crowding * 0.42 - fire.ashCover * 0.6,
  );
  fire.bellows = approach(fire.bellows, 0, 1.1, dt);
  // Fanning a buried bed does very little, which is why you rake first.
  fire.oxygen = clamp01(
    approach(fire.oxygen, targetOxygen, 0.55, dt) + fire.bellows * 0.35 * (1 - fire.ashCover * 0.8),
  );

  // --- Fuel ------------------------------------------------------------
  // Heat available to dry and ignite fuel comes from embers and current burn.
  // The combustion coupling is strong because a burning fire is overwhelmingly
  // its own heat source — too weak a coupling and an established fire quietly
  // decays to coals, which would break the product's opening image.
  //
  // How hot the bed is matters as much as how much of it there is: this is
  // what separates coals you can wake from coals you cannot, and it is the
  // reason blowing on them works.
  const bedHeat = clamp01((fire.emberTemp - 190) / 520);
  const ambientHeat = clamp01(
    (fire.emberMass * 1.3 + fire.combustion * 52) * (0.4 + bedHeat * 0.8),
  );
  // Rain reaching the fire. A bed under ash sheds nearly all of it, which is
  // the whole reason banking is the answer to a shower rather than standing
  // over the pit watching it go grey.
  const wetting = fire.rain * (1 - fire.ashCover * 0.92);
  let combustion = 0;
  let smokeGen = 0;

  for (const log of fire.logs) {
    if (log.mass <= 0) continue;
    const wood = woodType(log.woodId);
    const grade = fuelGrade(log.grade);

    // Rain soaks whatever is not already alight. Wood standing in the flame
    // is safe; wood parked at the edge to dry is exactly what gets wet again,
    // which is a lesson best learned once.
    if (wetting > 0) {
      log.moisture = clamp01(
        log.moisture + wetting * 0.028 * (1 - log.ignition) * (1 - log.heat * 0.6) * dt,
      );
    }

    // Wet wood must dry before it will burn. This is the whole reason damp
    // fuel "steals" a fire: the energy goes into evaporation, not flame. How
    // fast depends on where it is sitting — which is the point of the rack.
    if (log.moisture > 0) {
      // Cold air carries less away. A log that dried in four minutes at dusk
      // takes six at four in the morning, which is a small thing that adds up
      // to the fire being more work as the night goes on.
      const airBite = clamp(0.72 + (config.ambientC + 6) / 46, 0.7, 1.12);
      const dryingRate =
        0.022 * ambientHeat * log.radiance * (0.5 + fire.oxygen * 0.5) * Math.sqrt(grade.burns) * airBite;
      log.moisture = Math.max(0, log.moisture - dryingRate * dt);
      // Damp wood smokes heavily while it dries.
      smokeGen += log.moisture * wood.smokiness * log.ignition * 1.6;
      // And steams visibly, which is the only honest way to show a number
      // that otherwise lives entirely in the model.
      log.steam = approach(log.steam, clamp01(log.moisture * ambientHeat * log.radiance * 2.4), 1.4, dt);
    } else {
      log.steam = approach(log.steam, 0, 0.9, dt);
    }

    const dryness = 1 - log.moisture;
    // A log that is already alight largely keeps itself alight: without this
    // self-sustaining term, fuel can only ever be as lit as its surroundings,
    // and a fire can never be more than its embers.
    const ignitionDrive =
      wood.ignitability * grade.catches * ambientHeat * log.heat * dryness * (0.35 + fire.oxygen * 0.65) +
      log.ignition * 0.55 * dryness * (0.4 + fire.oxygen * 0.6) -
      log.moisture * 0.6;
    log.ignition = clamp01(approach(log.ignition, clamp01(ignitionDrive), 0.22, dt));

    if (log.ignition > 0.03) {
      const rate =
        wood.burnRate *
        grade.burns *
        log.ignition *
        (0.4 + fire.oxygen * 0.9) *
        dryness *
        (0.55 + log.airflow * 0.75);
      const consumed = Math.min(log.mass, rate * dt);
      log.mass -= consumed;
      log.burnedFor += dt;
      combustion += (consumed / dt) * wood.heatOutput;
      // Part of the consumed mass becomes coals rather than ash — but wood
      // standing up in the column burns hot and fast and leaves less behind
      // than the same wood lying flat. Tepee to get it going; knock it down
      // to get something worth roasting over.
      fire.emberMass += consumed * wood.emberYield * (1 - log.spot.lean * 0.35);
      smokeGen += consumed * wood.smokiness * 6;
    }
  }

  // Spent logs collapse into the bed rather than lingering as zero-mass ghosts.
  if (fire.logs.length > 0) {
    fire.logs = fire.logs.filter((log) => log.mass > 0.004);
  }

  fire.combustion = approach(fire.combustion, combustion, 3, dt);

  // --- Embers ----------------------------------------------------------
  // Coals burn away slowly; wind makes them glow hotter but spends them faster.
  // Coals are the long-lived part of a fire; they must outlast a whole
  // session so a player who lets the flames die still has something to roast
  // over (spec §4.1 — the fire never goes out irrecoverably).
  fire.emberMass = Math.max(0, fire.emberMass - emberBurn * dt);

  const openTargetTemp =
    fire.emberMass <= 0.001
      ? config.ambientC
      : lerp(320, 780, clamp01(fire.emberMass * 0.9 + fire.oxygen * 0.35)) +
        fire.combustion * 220 +
        smoothstep(0, 3, fire.windSpeed) * 90;
  // Ash is a blanket. Under it a bed loses very little of what it has, which
  // is the entire reason there is anything to wake in the morning.
  const bankedFloor =
    fire.emberMass <= 0.001 ? config.ambientC : lerp(config.ambientC, 540, clamp01(fire.emberMass * 2.4));
  const emberTargetTemp = lerp(openTargetTemp, Math.max(openTargetTemp, bankedFloor), fire.ashCover);
  fire.emberTemp = approach(fire.emberTemp, emberTargetTemp, 0.09, dt);

  // Rain spitting on open coals. Under ash it barely reaches them.
  if (wetting > 0) {
    // Hard enough to be a problem and nowhere near hard enough to be a
    // disaster: an open bed in a downpour settles a couple of hundred degrees
    // down and comes straight back, so rain costs you the pace of your evening
    // and never the evening (spec §4.1).
    fire.emberTemp = Math.max(config.ambientC, fire.emberTemp - wetting * 17 * dt);
    fire.flame = clamp01(fire.flame - wetting * 0.22 * dt);
  }

  // --- Flame -----------------------------------------------------------
  const flameTarget = clamp01(fire.combustion * 240 * (0.45 + fire.oxygen * 0.75));
  fire.flame = approach(fire.flame, flameTarget, 2.2, dt);
  // Flicker is noise-driven so it is organic but reproducible.
  const flicker = fbm1D(0xf1a3, fire.elapsed * 3.1, 3) * 0.16;
  fire.flameHeight = clamp(
    (0.16 + fire.flame * 0.72) *
      // A chimney pulls the flame up; a flat bed spreads it out.
      (1 + fire.draught * 0.34) *
      (1 + flicker - 0.08) *
      (1 - smoothstep(1.8, 5, fire.windSpeed) * 0.3),
    0,
    1.5,
  );

  fire.smoke = clamp01(approach(fire.smoke, clamp01(smokeGen), 0.8, dt));

  // --- Crackles --------------------------------------------------------
  // A Poisson-ish process: accumulate expected events and emit whole ones.
  let sparkiness = 0;
  for (const log of fire.logs) sparkiness += woodType(log.woodId).sparkiness * log.ignition * log.mass;
  const crackleRate = (0.8 + sparkiness * 2.4) * (0.3 + fire.flame * 1.1) * (0.6 + fire.oxygen * 0.6);
  fire.crackleAccumulator += crackleRate * dt;
  while (fire.crackleAccumulator >= 1) {
    fire.crackleAccumulator -= 1;
    // Randomised so crackles do not fall on a metronome.
    if (rng.chance(0.85)) fire.cracklesThisStep++;
  }
}

/** Normalised signals the renderer and audio engine consume. */
export interface FireSignals {
  intensity: number;
  emberHeat: number;
  fuelLoad: number;
  windSpeed: number;
  crackleRate: number;
  smoke: number;
  flameHeight: number;
  /** Light colour temperature hint, 0 = deep ember red, 1 = bright yellow. */
  colorBias: number;
  /** Ash over the bed, 0..1 — the renderer greys the coals under it. */
  ashCover: number;
  /** How much the stack is leaned into a chimney, 0..1. */
  draught: number;
  /** The most any one piece is steaming, 0..1. */
  steam: number;
}

export function fireSignals(fire: FireState): FireSignals {
  let fuelLoad = 0;
  let steam = 0;
  for (const log of fire.logs) {
    fuelLoad += log.mass;
    if (log.steam > steam) steam = log.steam;
  }
  return {
    intensity: fire.flame,
    emberHeat: clamp01((fire.emberTemp - fire.config.ambientC) / 800),
    fuelLoad: clamp01(fuelLoad / 3),
    windSpeed: fire.windSpeed,
    crackleRate: clamp01(fire.cracklesThisStep > 0 ? 1 : fire.flame * 0.7),
    smoke: fire.smoke,
    flameHeight: fire.flameHeight,
    colorBias: clamp01(fire.flame * 0.85 + 0.1),
    ashCover: fire.ashCover,
    draught: fire.draught,
    steam,
  };
}

/** Total light output, used to drive the fire's dynamic light. */
export function fireLightIntensity(fire: FireState): number {
  return clamp01(fire.flame * 0.8 + clamp01(fire.emberMass) * 0.3);
}

/**
 * True when only coals remain — the best roasting condition.
 *
 * A banked bed does not count. Coals under ash are being kept, not offered:
 * you rake them open before you cook over them, the same as anyone would.
 */
export function isEmberBed(fire: FireState): boolean {
  return fire.flame < 0.22 && fire.emberMass > 0.15 && fire.ashCover < 0.45;
}

/**
 * True when there is heat left in the pit but nothing to see.
 *
 * What you are looking at when you arrive at a site you used last night, and
 * the one state a player has to be told about, because a grey pit reads as a
 * dead one and this one is not.
 */
export function isBanked(fire: FireState): boolean {
  return fire.flame < 0.05 && fire.ashCover > 0.5 && fire.emberTemp > 120;
}
