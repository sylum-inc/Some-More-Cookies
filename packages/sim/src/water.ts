/**
 * The water at a campsite (spec §5.2, §5.4).
 *
 * Several environments in the catalogue are shorelines, lakes, creeks or
 * swamps, and several are emphatically not — a salt flat, a rail siding, a
 * mesa. The activities that need water (stone skipping, fishing) therefore
 * cannot assume it exists, and this module is where that question is answered
 * once: `WaterFeatureSpec` is structurally identical to `WaterFeature` in
 * `@somemore/content`'s scene manifest, so `EnvironmentManifest.scene.water`
 * can be passed straight in, and `undefined` — a dry site — is a first-class
 * value everywhere downstream.
 *
 * The surface itself is a real state: flow and wind make chop, chop makes a
 * stone skip badly and a float hard to read, and a still night makes a mirror.
 * It is deliberately **rng-free**: the surface is an analytic function of
 * position and elapsed time, so a stone thrown at a given moment meets exactly
 * the water it would have met on any other device (ADR-0001), and the skip
 * count that comes out of it is physics rather than a roll.
 *
 * This package does not import content: content depends on `sim`, and that
 * dependency must not invert.
 */

import { approach, clamp, clamp01, lerp, smoothstep } from './math.js';
import { fbm1D, hashString, hashToUnit, mixSeeds, valueNoise1D } from './rng.js';
import type { WaterBasin } from './locomotion.js';

/* -------------------------------------------------------------------------- */
/* Content-shaped input                                                       */
/* -------------------------------------------------------------------------- */

/** Mirrors the content schema exactly. */
export type WaterKind =
  | 'none'
  | 'creek'
  | 'river'
  | 'lake'
  | 'tarn'
  | 'sea'
  | 'blackwater'
  | 'hot-spring'
  | 'ephemeral-sheet';

/** Mirrors the content schema exactly. */
export type WaterFlow = 'still' | 'slow' | 'lapping' | 'running' | 'rushing' | 'tidal' | 'seeping';

/**
 * A body of water at a campsite.
 *
 * `fishable` and `skippable` are content's answer, not a derived guess: the
 * beck at Foxglove Fells holds trout but is far too small and broken to skip a
 * stone on, and the tarn at Meltwater Cirque is the reverse. Nothing here
 * second-guesses that.
 */
export interface WaterFeatureSpec {
  readonly kind: WaterKind;
  readonly label: string;
  /** Approximate width/extent in metres. */
  readonly widthM: number;
  readonly flow: WaterFlow;
  /** 0 = opaque, 1 = glass. */
  readonly clarity: number;
  readonly fishable: boolean;
  readonly skippable: boolean;
  readonly note: string;
}

/**
 * The weather the surface feels. `WeatherState` satisfies this structurally;
 * restated so the water does not depend on the weather model's internals.
 */
export interface WaterWeather {
  readonly precipitation: number;
  readonly windSpeed: number;
  readonly temperatureC: number;
}

/* -------------------------------------------------------------------------- */
/* Flow character                                                             */
/* -------------------------------------------------------------------------- */

interface FlowCharacter {
  /** Chop with no wind at all, 0..1. */
  readonly baseChop: number;
  /** Surface current, m/s. */
  readonly currentMs: number;
  /** How much of a wind's energy this body can convert into chop. */
  readonly windCoupling: number;
}

const FLOW: Record<WaterFlow, FlowCharacter> = {
  still: { baseChop: 0.02, currentMs: 0, windCoupling: 1 },
  seeping: { baseChop: 0.03, currentMs: 0.05, windCoupling: 0.2 },
  // A slow river's surface is smoother than a lake's shore, which is
  // counter-intuitive until you have stood at both: the river is moving as one
  // body, the lake is being pushed about by whatever air is over it.
  slow: { baseChop: 0.05, currentMs: 0.45, windCoupling: 0.8 },
  // Low on purpose. Loonwater's own note says the narrows are "an absolutely
  // perfect mirror" on a still night — `lapping` is what a breeze makes of it,
  // not a floor it never gets below.
  lapping: { baseChop: 0.06, currentMs: 0.15, windCoupling: 1 },
  running: { baseChop: 0.45, currentMs: 1.1, windCoupling: 0.5 },
  rushing: { baseChop: 0.78, currentMs: 2.4, windCoupling: 0.35 },
  // The sea is never still, even on a windless night: the swell came from
  // somewhere else.
  tidal: { baseChop: 0.38, currentMs: 0.7, windCoupling: 1.1 },
};

/**
 * How much wind a body of water can turn into chop.
 *
 * Fetch: wind needs distance to build waves. A two-metre seep stays flat in a
 * gale; seven hundred metres of lake does not. This is why the same weather
 * produces a mirror at one campsite and a mess at another.
 */
export function fetchFactor(widthM: number): number {
  return smoothstep(2, 260, widthM);
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** A ring spreading from something that touched the surface. */
export interface Ripple {
  x: number;
  z: number;
  /** Seconds since it was made. */
  age: number;
  /** 0..1 how hard the thing hit. */
  strength: number;
}

/** Where the water is, relative to the fire at the origin. */
export interface Shore {
  /** Bearing from the fire, radians. */
  readonly bearing: number;
  /** Metres from the fire to the water's edge. */
  readonly distanceM: number;
  /** Height of the surface relative to the clearing, metres (negative). */
  readonly surfaceY: number;
}

export interface WaterState {
  readonly spec: WaterFeatureSpec;
  readonly shore: Shore;
  /** Seed for the surface's own texture. Stable per campsite. */
  readonly seed: number;
  /** 0..1 how broken the surface is right now. */
  chop: number;
  /** 0..1 how close to a perfect mirror it is. */
  glass: number;
  /** Surface current, m/s. */
  currentMs: number;
  /** Bounded — the surface forgets, like a surface does. */
  ripples: Ripple[];
  elapsed: number;
}

/** As many rings as the surface will hold before the oldest is dropped. */
const MAX_RIPPLES = 12;
/** Seconds a ring takes to fade out entirely. */
const RIPPLE_LIFE = 6;

/**
 * Where the water sits at this campsite.
 *
 * Derived from the seed alone, so the shore is in the same place on every
 * visit and on every device — and far enough out that the fire, the machine
 * and the walk between them are unaffected by it.
 */
export function shoreFor(campsiteSeed: number, walkableRadiusM: number): Shore {
  const seed = mixSeeds(campsiteSeed, hashString('water-shore'));
  const bearing = hashToUnit(seed, 1) * Math.PI * 2;
  // Out past the fireside furniture, inside the walkable bound.
  const distanceM = clamp(walkableRadiusM * 0.62, 3.4, 9.5);
  return { bearing, distanceM, surfaceY: -0.16 };
}

/**
 * The shape of the ground under and around this water.
 *
 * Handed to `terrainHeight` so the bed, the shore and the walk into the
 * shallows are the same ground function the renderer draws and the player
 * walks on. Narrow water gets a channel with a far bank; open water gets
 * everything past the shore line.
 */
export function basinFor(spec: WaterFeatureSpec, shore: Shore): WaterBasin {
  const narrow = spec.widthM < 8;
  return {
    bearing: shore.bearing,
    distanceM: shore.distanceM,
    // Shallow on purpose: the campsite bound stops anyone well short of open
    // water, so the only water a player can stand in is the margin.
    depthM: narrow ? 0.42 : 0.62,
    ...(narrow ? { halfWidthM: Math.max(0.8, spec.widthM / 2) } : {}),
  };
}

export function createWater(
  spec: WaterFeatureSpec,
  options: { campsiteSeed: number | string; walkableRadiusM?: number },
): WaterState {
  const seed =
    typeof options.campsiteSeed === 'string'
      ? hashString(options.campsiteSeed)
      : options.campsiteSeed >>> 0;
  const character = FLOW[spec.flow];
  return {
    spec,
    shore: shoreFor(seed, options.walkableRadiusM ?? 13),
    seed: mixSeeds(seed, hashString('water-surface')),
    chop: character.baseChop,
    glass: 1 - character.baseChop,
    currentMs: character.currentMs,
    ripples: [],
    elapsed: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Advances the surface one fixed timestep.
 *
 * No `Rng`: the gusting comes from `fbm1D` over elapsed time, which is
 * deterministic and identical everywhere. That matters because the skipping
 * model reads this surface, and a stone's fate must not depend on which random
 * stream happened to be drawn from first (ADR-0006).
 */
export function stepWater(state: WaterState, dt: number, weather?: WaterWeather): void {
  state.elapsed += dt;

  const character = FLOW[state.spec.flow];
  const fetch = fetchFactor(state.spec.widthM);
  const wind = weather ? weather.windSpeed : 0;
  const rain = weather ? clamp01(weather.precipitation) : 0;

  // Wind builds chop over fetch; rain stipples the surface without really
  // moving it, which is why a rainy night is still a mirror underneath.
  const windChop = smoothstep(0.8, 9, wind) * fetch * character.windCoupling;
  const target = clamp01(character.baseChop + windChop * 0.85 + rain * 0.18);

  // Gusts have texture, and water has inertia: it takes a while to get up and
  // longer to lie down again.
  const gust = fbm1D(state.seed ^ 0x51d3, state.elapsed * 0.19, 3);
  const gusted = clamp01(target * lerp(0.82, 1.22, gust));
  state.chop = clamp01(approach(state.chop, gusted, gusted > state.chop ? 0.5 : 0.22, dt));
  state.glass = clamp01(1 - state.chop * 1.35);
  state.currentMs = character.currentMs;

  for (let i = state.ripples.length - 1; i >= 0; i--) {
    const ripple = state.ripples[i] as Ripple;
    ripple.age += dt;
    if (ripple.age > RIPPLE_LIFE) state.ripples.splice(i, 1);
  }
}

/** Records something touching the surface: a stone, a float, a fish. */
export function disturbWater(state: WaterState, x: number, z: number, strength: number): void {
  state.ripples.push({ x, z, age: 0, strength: clamp01(strength) });
  if (state.ripples.length > MAX_RIPPLES) state.ripples.shift();
}

/** 0..1 how present a ring still is. */
export function ripplePresence(ripple: Ripple): number {
  return clamp01(1 - ripple.age / RIPPLE_LIFE) * ripple.strength;
}

/* -------------------------------------------------------------------------- */
/* The surface itself                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Surface height at a point, in metres above the mean level.
 *
 * Analytic, so the simulation and the renderer agree exactly — the same reason
 * `terrainHeight` is analytic in `locomotion.ts`. A stone bounces off the
 * water the player can see, not off a flat plane underneath it.
 */
export function waveHeight(state: WaterState, x: number, z: number): number {
  if (state.chop <= 0.001) return 0;
  const t = state.elapsed;
  const amplitude = state.chop * 0.09;
  const primary = Math.sin(x * 1.9 + t * 2.1) * 0.6;
  const secondary = Math.sin(z * 2.7 - t * 1.55) * 0.4;
  const texture = valueNoise1D(state.seed, x * 3.1 + z * 2.3 + t * 0.9) - 0.5;
  return (primary + secondary + texture * 0.8) * amplitude;
}

/**
 * Local surface slope at a point, in radians.
 *
 * This is what actually decides a skip: the stone does not meet a flat plane,
 * it meets whatever face of whatever wavelet happens to be there. On glass the
 * slope is nearly zero and the throw is all that matters; in chop it is a real
 * perturbation on every single bounce, which is why a rough lake eats skips.
 */
export function waveSlope(state: WaterState, x: number, z: number): number {
  if (state.chop <= 0.001) return 0;
  const epsilon = 0.12;
  const dx = waveHeight(state, x + epsilon, z) - waveHeight(state, x - epsilon, z);
  return Math.atan2(dx, 2 * epsilon);
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

/** Whether a stone can be skipped here at all. Content's answer, not a guess. */
export function canSkipStones(spec: WaterFeatureSpec | null | undefined): boolean {
  return Boolean(spec && spec.kind !== 'none' && spec.skippable);
}

/** Whether there is anything in here to catch. */
export function canFish(spec: WaterFeatureSpec | null | undefined): boolean {
  return Boolean(spec && spec.kind !== 'none' && spec.fishable);
}

/** A short, human phrase. Never a number. */
export function describeWater(state: WaterState): string {
  if (state.chop < 0.06) return `${state.spec.label}, dead flat`;
  if (state.chop < 0.2) return `${state.spec.label}, barely moving`;
  if (state.chop < 0.45) return `${state.spec.label}, ruffled`;
  if (state.chop < 0.7) return `${state.spec.label}, choppy`;
  return `${state.spec.label}, broken right up`;
}
