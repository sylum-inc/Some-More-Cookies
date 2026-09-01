/**
 * The named things that make a campsite that campsite (spec §5.4).
 *
 * Every environment lists three or four landmarks and describes each one
 * exactly: site post 11 with its violet laminated card, an olive-drab bear box
 * dented on the top left, a dead pine caught in the crotch of a living one at
 * fifteen degrees, three flat stones across the narrow point with the middle
 * one wobbling. Until this existed none of them was anywhere. Twelve campsites
 * written as distinct places and rendered as one clearing with a machine in it.
 *
 * The catalogue says what they are and not where, because where is a property
 * of the campsite the seed built rather than of the environment. So they are
 * placed here, deterministically, by what kind of thing they are: signage
 * where you would come in past it, built things at the edge of the firelight,
 * natural ones out at the treeline, water ones at the water. The same list
 * decides where they are drawn and where you can walk up to them, so what you
 * see and what you can touch cannot drift apart.
 */

import { clamp } from './math.js';
import type { Rng } from './rng.js';

export type LandmarkKind = 'natural' | 'built' | 'abandoned' | 'signage' | 'water' | 'sky' | 'camp';

/** The catalogue's shape, restated so the simulation does not import content. */
export interface LandmarkSpec {
  readonly id: string;
  readonly label: string;
  readonly kind: LandmarkKind;
  readonly note: string;
}

export interface PlacedLandmark {
  readonly id: string;
  readonly label: string;
  readonly kind: LandmarkKind;
  readonly note: string;
  readonly x: number;
  readonly z: number;
  /** Which way it faces. Signage faces the way you come in. */
  readonly rotation: number;
  /** Seed for the shape, so two posts at two campsites are not one post. */
  readonly seed: number;
  /** Whether the player has walked up to this one tonight. */
  introduced: boolean;
}

/** Somewhere a landmark must not be put: the fire, the machine, the table. */
export interface Occupied {
  readonly x: number;
  readonly z: number;
  readonly radius: number;
}

/**
 * How far out each kind of thing stands, as a fraction of the walkable radius.
 *
 * Not decoration: a sign you pass on the way in and a snag out at the treeline
 * are different distances because they are different things, and a campsite
 * where everything sits at the same radius reads as a menu.
 */
const DISTANCE: Record<LandmarkKind, number> = {
  signage: 0.46,
  built: 0.3,
  camp: 0.34,
  abandoned: 0.64,
  natural: 0.8,
  water: 0.7,
  sky: 0,
};

/** How much room each kind needs to itself. */
const CLEARANCE: Record<LandmarkKind, number> = {
  signage: 0.8,
  built: 1.2,
  camp: 1.2,
  abandoned: 1.4,
  natural: 1.8,
  water: 1.4,
  sky: 0,
};

/** Nothing goes nearer the fire than this, whatever its kind says. */
const FIRE_CLEARANCE = 2.3;

export interface LandmarkOptions {
  landmarks: readonly LandmarkSpec[];
  /** Walkable radius of the campsite, metres. */
  radius: number;
  /** Bearing of the trail in, so signage is on the way in and not behind you. */
  trailBearing: number;
  /** Where the water is, if there is any. */
  shore?: { bearing: number; distanceM: number };
  /** Things already standing at this campsite. */
  occupied?: readonly Occupied[];
  rng: Rng;
}

/** True when nothing already claims this spot. */
function isClear(
  x: number,
  z: number,
  clearance: number,
  occupied: readonly Occupied[],
  placed: readonly PlacedLandmark[],
): boolean {
  if (Math.hypot(x, z) < FIRE_CLEARANCE) return false;
  for (const thing of occupied) {
    if (Math.hypot(thing.x - x, thing.z - z) < thing.radius + clearance) return false;
  }
  for (const other of placed) {
    if (Math.hypot(other.x - x, other.z - z) < clearance + CLEARANCE[other.kind]) return false;
  }
  return true;
}

export function placeLandmarks(options: LandmarkOptions): PlacedLandmark[] {
  const { landmarks, radius, trailBearing, shore, rng } = options;
  const occupied = options.occupied ?? [];
  const placed: PlacedLandmark[] = [];

  landmarks.forEach((spec, index) => {
    // Overhead things — an aurora, a flight path, a particular star — are
    // landmarks you look at, not landmarks you walk to.
    if (spec.kind === 'sky') return;

    const wantsWater = spec.kind === 'water' && shore !== undefined;
    const distance = wantsWater
      ? Math.max(2.6, shore.distanceM - 0.9)
      : clamp(radius * DISTANCE[spec.kind], 2.6, radius - 1.2);

    // A ring of candidate bearings, walked from the one this kind wants, so
    // placement is deterministic and a crowded campsite still finds room.
    const preferred = wantsWater
      ? shore.bearing
      : spec.kind === 'signage'
        ? trailBearing
        : trailBearing + Math.PI * 0.55 + index * 1.31 + rng.range(-0.25, 0.25);

    for (let attempt = 0; attempt < 24; attempt++) {
      // Alternate either side of the preferred bearing rather than sweeping
      // one way, so a thing that cannot go exactly where it wants ends up
      // beside it instead of on the far side of the campsite.
      const swing = (Math.ceil(attempt / 2) * 0.42) * (attempt % 2 === 0 ? 1 : -1);
      const bearing = preferred + swing;
      const pull = attempt < 12 ? 1 : 0.82;
      const x = Math.cos(bearing) * distance * pull;
      const z = Math.sin(bearing) * distance * pull;
      if (!isClear(x, z, CLEARANCE[spec.kind], occupied, placed)) continue;
      placed.push({
        id: spec.id,
        label: spec.label,
        kind: spec.kind,
        note: spec.note,
        x,
        z,
        // Signage faces whoever is arriving; everything else faces the fire,
        // because a camp is arranged around its fire.
        rotation: spec.kind === 'signage' ? trailBearing + Math.PI : Math.atan2(-z, -x),
        seed: Math.floor(rng.range(1, 100000)),
        introduced: false,
      });
      return;
    }
  });

  return placed;
}

export function landmarkAt(landmarks: readonly PlacedLandmark[], id: string): PlacedLandmark | null {
  return landmarks.find((landmark) => landmark.id === id) ?? null;
}
