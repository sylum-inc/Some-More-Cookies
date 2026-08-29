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
  },
};

export function woodType(id: string): WoodType {
  return WOOD_TYPES[id] ?? (WOOD_TYPES['pine'] as WoodType);
}

/** A single piece of fuel in the pit. */
export interface Log {
  readonly id: string;
  readonly woodId: string;
  /** Remaining mass, 0..1-ish relative to a standard split log. */
  mass: number;
  /** 0 = bone dry, 1 = soaked. Must boil off before the log burns properly. */
  moisture: number;
  /** How alight this log is, 0..1. */
  ignition: number;
  /**
   * How well placed it is for airflow, 0..1. Set when the player positions or
   * rakes it. Stacked-with-gaps burns; smothered chokes.
   */
  placement: number;
  /** Accumulated seconds this log has been burning — drives visual charring. */
  burnedFor: number;
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
  /** Rolling counter used to schedule crackles deterministically. */
  crackleAccumulator: number;
  /** Crackles emitted on the most recent step — read by audio and particles. */
  cracklesThisStep: number;
  config: FireConfig;
}

let logCounter = 0;

export function createLog(woodId: string, options?: Partial<Log>): Log {
  const wood = woodType(woodId);
  return {
    id: options?.id ?? `log-${++logCounter}`,
    woodId: wood.id,
    mass: options?.mass ?? 1,
    moisture: options?.moisture ?? wood.defaultMoisture,
    ignition: options?.ignition ?? 0,
    placement: options?.placement ?? 0.6,
    burnedFor: options?.burnedFor ?? 0,
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
  // over the next few minutes — which is roughly when a player reaches the
  // roasting stage, and is how the "coals are better" discovery presents
  // itself without ever being taught.
  fire.logs.push(createLog('oak', { mass: 0.36, moisture: 0.04, ignition: 0.95, burnedFor: 240 }));
  fire.logs.push(createLog('pine', { mass: 0.2, moisture: 0.03, ignition: 0.9, burnedFor: 180 }));
  fire.emberMass = 0.55;
  fire.emberTemp = 620;
  fire.oxygen = 0.72;
  fire.combustion = 0.004;
  fire.flame = 0.85;
  fire.flameHeight = 0.7;
  fire.elapsed = 260;
  return fire;
}

export function addLog(fire: FireState, woodId: string, placement = 0.6): Log {
  const log = createLog(woodId, { placement });
  fire.logs.push(log);
  return log;
}

/**
 * Raking the coals: spreads the ember bed, admits air, and briefly lifts
 * oxygen. Costs a little ember temperature because coals get exposed.
 */
export function rakeEmbers(fire: FireState, strength = 1): void {
  const s = clamp01(strength);
  fire.bellows = clamp01(fire.bellows + 0.55 * s);
  fire.emberTemp = lerp(fire.emberTemp, fire.emberTemp * 0.94 + 60, s * 0.5);
  for (const log of fire.logs) {
    // Rearranging fuel improves airflow around it.
    log.placement = clamp01(log.placement + 0.18 * s);
  }
}

/** Blowing or fanning: a short, strong oxygen impulse. */
export function fanFire(fire: FireState, strength = 1): void {
  fire.bellows = clamp01(fire.bellows + 0.8 * clamp01(strength));
}

/** Repositions one log's airflow quality. */
export function repositionLog(fire: FireState, logId: string, placement: number): void {
  const log = fire.logs.find((l) => l.id === logId);
  if (log) log.placement = clamp01(placement);
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

  // --- Oxygen ----------------------------------------------------------
  // Airflow comes from fuel placement plus wind, and is choked by piling too
  // much fuel into the pit at once.
  let placementSum = 0;
  let massSum = 0;
  for (const log of fire.logs) {
    placementSum += log.placement * log.mass;
    massSum += log.mass;
  }
  const placementQuality = massSum > 0 ? placementSum / massSum : 0.7;
  const crowding = smoothstep(2.2, 4.6, massSum); // too much fuel smothers
  const windAssist = smoothstep(0, 2.6, fire.windSpeed) * 0.28;
  const targetOxygen = clamp01(0.35 + placementQuality * 0.45 + windAssist - crowding * 0.42);
  fire.bellows = approach(fire.bellows, 0, 1.1, dt);
  fire.oxygen = clamp01(approach(fire.oxygen, targetOxygen, 0.55, dt) + fire.bellows * 0.35);

  // --- Fuel ------------------------------------------------------------
  // Heat available to dry and ignite fuel comes from embers and current burn.
  // The combustion coupling is strong because a burning fire is overwhelmingly
  // its own heat source — too weak a coupling and an established fire quietly
  // decays to coals, which would break the product's opening image.
  const ambientHeat = clamp01(fire.emberMass * 1.1 + fire.combustion * 45);
  let combustion = 0;
  let smokeGen = 0;

  for (const log of fire.logs) {
    if (log.mass <= 0) continue;
    const wood = woodType(log.woodId);

    // Wet wood must dry before it will burn. This is the whole reason damp
    // fuel "steals" a fire: the energy goes into evaporation, not flame.
    if (log.moisture > 0) {
      const dryingRate = 0.02 * ambientHeat * (0.5 + fire.oxygen * 0.5);
      log.moisture = Math.max(0, log.moisture - dryingRate * dt);
      // Damp wood smokes heavily while it dries.
      smokeGen += log.moisture * wood.smokiness * log.ignition * 1.6;
    }

    const dryness = 1 - log.moisture;
    // A log that is already alight largely keeps itself alight: without this
    // self-sustaining term, fuel can only ever be as lit as its surroundings,
    // and a fire can never be more than its embers.
    const ignitionDrive =
      wood.ignitability * ambientHeat * dryness * (0.35 + fire.oxygen * 0.65) +
      log.ignition * 0.55 * dryness * (0.4 + fire.oxygen * 0.6) -
      log.moisture * 0.6;
    log.ignition = clamp01(approach(log.ignition, clamp01(ignitionDrive), 0.22, dt));

    if (log.ignition > 0.03) {
      const rate = wood.burnRate * log.ignition * (0.4 + fire.oxygen * 0.9) * dryness;
      const consumed = Math.min(log.mass, rate * dt);
      log.mass -= consumed;
      log.burnedFor += dt;
      combustion += (consumed / dt) * wood.heatOutput;
      // Part of the consumed mass becomes coals rather than ash.
      fire.emberMass += consumed * wood.emberYield;
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
  const emberBurn = fire.emberMass * 0.0009 * (0.5 + fire.oxygen * 0.8);
  fire.emberMass = Math.max(0, fire.emberMass - emberBurn * dt);

  const emberTargetTemp =
    fire.emberMass <= 0.001
      ? config.ambientC
      : lerp(320, 780, clamp01(fire.emberMass * 0.9 + fire.oxygen * 0.35)) +
        fire.combustion * 220 +
        smoothstep(0, 3, fire.windSpeed) * 90;
  fire.emberTemp = approach(fire.emberTemp, emberTargetTemp, 0.09, dt);

  // --- Flame -----------------------------------------------------------
  const flameTarget = clamp01(fire.combustion * 240 * (0.45 + fire.oxygen * 0.75));
  fire.flame = approach(fire.flame, flameTarget, 2.2, dt);
  // Flicker is noise-driven so it is organic but reproducible.
  const flicker = fbm1D(0xf1a3, fire.elapsed * 3.1, 3) * 0.16;
  fire.flameHeight = clamp(
    (0.16 + fire.flame * 0.72) * (1 + flicker - 0.08) * (1 - smoothstep(1.8, 5, fire.windSpeed) * 0.3),
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
}

export function fireSignals(fire: FireState): FireSignals {
  let fuelLoad = 0;
  for (const log of fire.logs) fuelLoad += log.mass;
  return {
    intensity: fire.flame,
    emberHeat: clamp01((fire.emberTemp - fire.config.ambientC) / 800),
    fuelLoad: clamp01(fuelLoad / 3),
    windSpeed: fire.windSpeed,
    crackleRate: clamp01(fire.cracklesThisStep > 0 ? 1 : fire.flame * 0.7),
    smoke: fire.smoke,
    flameHeight: fire.flameHeight,
    colorBias: clamp01(fire.flame * 0.85 + 0.1),
  };
}

/** Total light output, used to drive the fire's dynamic light. */
export function fireLightIntensity(fire: FireState): number {
  return clamp01(fire.flame * 0.8 + clamp01(fire.emberMass) * 0.3);
}

/** True when only coals remain — the best roasting condition. */
export function isEmberBed(fire: FireState): boolean {
  return fire.flame < 0.22 && fire.emberMass > 0.15;
}
