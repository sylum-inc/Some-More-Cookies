/**
 * Firewood, and going to get it (spec §4.1, §5.2).
 *
 * The catalogue has always described where the wood at each campsite comes
 * from — hemlock deadfall off a wet slope, a split-maple stack inside a hollow
 * cedar, driftwood dried against a warm vent — and has always said how damp
 * each of those is. None of it reached the player. There was one woodpile at
 * camp, it was infinite, everything in it was as dry as everything else, and
 * the only decision it offered was which species to take.
 *
 * So: the sources become *places*. They sit out around the clearing at
 * distances the campsite's own weights decide, each holding what the catalogue
 * says it holds, at the moisture the catalogue says it is, and the sentence
 * describing it is what you are told when you pick some up. Coming back with
 * an armful is a walk you took, and the wet slope's wood is genuinely worse
 * fuel than the stack in the hollow tree — which is the environment's own
 * best-kept secret, finally worth keeping.
 *
 * Nothing here can strand a player. The pile at camp never empties, every
 * patch has enough for a night, and gathering is optional in the sense that a
 * fire can be run off the pile alone — it will just be a duller fire, made of
 * one wood, and you will not have been anywhere.
 */

import { clamp, clamp01, lerp } from './math.js';
import { FUEL_GRADES, woodType, type FuelGrade } from './fire.js';
import type { Rng } from './rng.js';

/** How many pieces of fuel fit in two arms. */
export const MAX_ARMFUL = 5;

/** A place at this campsite where there is wood. */
export interface FuelPatch {
  readonly id: string;
  readonly woodId: string;
  /**
   * What you get here. A patch yields one grade, because a drift line of
   * finger-thick sticks and a stack of split logs are different places.
   */
  readonly grade: FuelGrade;
  /** Where it is, metres from the fire pit. */
  readonly x: number;
  readonly z: number;
  /** How wet a piece from here is when you pick it up, before weather. */
  readonly moisture: number;
  /** The catalogue's own sentence about this wood. Said once, on the first pick. */
  readonly foundAs: string;
  /** Short label for the reach prompt. */
  readonly label: string;
  /** Pieces here when you arrived, so the renderer can thin what it draws. */
  readonly stock: number;
  /** Pieces left here tonight. */
  remaining: number;
  /** Whether the player has already been told what this place is. */
  introduced: boolean;
}

/** A piece of fuel in your arms. */
export interface CarriedFuel {
  readonly id: string;
  readonly woodId: string;
  readonly grade: FuelGrade;
  moisture: number;
}

export interface GatheringState {
  patches: FuelPatch[];
  /** What you are carrying. The last thing picked up is on top. */
  armful: CarriedFuel[];
  /** Pieces gathered tonight, for the Passport's account of the evening. */
  gathered: number;
}

/** The catalogue's shape, restated so the simulation does not import content. */
export interface FuelSourceSpec {
  readonly woodId: string;
  readonly weight: number;
  readonly foundAs: string;
  readonly moistureBias: number;
}

/**
 * How far out a source sits.
 *
 * Weight is availability, and at a real campsite the plentiful thing is the
 * thing underfoot: the commonest wood is a few steps away and the good stuff
 * is a walk. Bounded so nothing is ever outside the walkable world.
 */
function distanceFor(weight: number, radius: number): number {
  const plentiful = clamp01((weight - 1) / 5);
  return clamp(lerp(radius * 0.62, radius * 0.2, plentiful), 2.6, radius - 1.4);
}

/**
 * Splits a source into the places you would actually find that wood.
 *
 * Every source yields split logs somewhere. The commoner ones also leave the
 * small stuff lying about — twigs and finger-thick sticks, which is what a
 * fire has to be started with and what the pile at camp does not have.
 */
function gradesFor(source: FuelSourceSpec, index: number): FuelGrade[] {
  if (source.weight >= 4) return ['tinder', 'kindling', 'log'];
  if (source.weight >= 2 || index === 0) return ['kindling', 'log'];
  return ['log'];
}

/** How much of a grade is lying at one place. Generous: this is not survival. */
function stockFor(grade: FuelGrade, weight: number): number {
  const base = grade === 'tinder' ? 14 : grade === 'kindling' ? 12 : 7;
  return Math.round(base * clamp(0.7 + weight * 0.2, 0.8, 2));
}

export interface GatheringOptions {
  sources: readonly FuelSourceSpec[];
  /** Walkable radius of the campsite, metres. */
  radius: number;
  /**
   * Air humidity at the moment the campsite is built, 0..1.
   *
   * Applied once rather than continuously: what is lying on the ground when
   * you arrive is as wet as the last few days made it, and the weather that
   * blows through tonight wets what is *out* — which is the pit's business,
   * not this module's.
   */
  humidity: number;
  rng: Rng;
}

export function createGathering(options: GatheringOptions): GatheringState {
  const { sources, radius, humidity, rng } = options;
  const patches: FuelPatch[] = [];
  let index = 0;
  for (const source of sources) {
    const wood = woodType(source.woodId);
    // Spread around the clearing rather than clustered: the golden angle keeps
    // successive sources on genuinely different bearings, and a little jitter
    // per campsite stops every site in the catalogue having the same map.
    const bearing = index * 2.399963229728653 + rng.range(-0.3, 0.3);
    const distance = distanceFor(source.weight, radius);
    for (const grade of gradesFor(source, index)) {
      // Small stuff is scattered nearer than the fallen trunk it came off.
      const pull = grade === 'tinder' ? 0.78 : grade === 'kindling' ? 0.88 : 1;
      const spread = rng.range(-0.5, 0.5);
      const angle = bearing + (grade === 'log' ? 0 : grade === 'kindling' ? 0.24 : -0.24);
      const r = clamp(distance * pull + spread, 2.4, radius - 1.2);
      patches.push({
        id: `fuel-${source.woodId}-${grade}`,
        woodId: wood.id,
        grade,
        x: Math.cos(angle) * r,
        z: Math.sin(angle) * r,
        // Thin fuel off the ground dries faster and wets faster than a log.
        moisture: clamp01(
          wood.defaultMoisture +
            source.moistureBias +
            humidity * (grade === 'log' ? 0.16 : 0.28) -
            (grade === 'tinder' ? 0.04 : 0),
        ),
        foundAs: source.foundAs,
        label: FUEL_GRADES[grade].label,
        stock: stockFor(grade, source.weight),
        remaining: stockFor(grade, source.weight),
        introduced: false,
      });
    }
    index++;
  }
  return { patches, armful: [], gathered: 0 };
}

export function patchAt(state: GatheringState, patchId: string): FuelPatch | null {
  return state.patches.find((patch) => patch.id === patchId) ?? null;
}

/** What happened when you reached for some wood. */
export interface GatherResult {
  taken: CarriedFuel | null;
  /** Said once per place: the catalogue's sentence about it. */
  introduction: string | null;
  /** True when your arms are already full. */
  full: boolean;
  /** True when there is nothing left at this place tonight. */
  empty: boolean;
}

let carriedCounter = 0;

/** Test seam: carried-fuel ids have to be reproducible. */
export function resetCarriedIds(): void {
  carriedCounter = 0;
}

/**
 * Picks up one piece.
 *
 * One piece per reach rather than a whole armful at a stroke, because the
 * armful is the decision: five pieces, and the walk back is the same length
 * whatever you filled them with.
 */
export function gatherFrom(state: GatheringState, patchId: string): GatherResult {
  const patch = patchAt(state, patchId);
  if (!patch) return { taken: null, introduction: null, full: false, empty: true };
  if (state.armful.length >= MAX_ARMFUL) {
    return { taken: null, introduction: null, full: true, empty: false };
  }
  if (patch.remaining <= 0) {
    return { taken: null, introduction: null, full: false, empty: true };
  }
  patch.remaining -= 1;
  state.gathered += 1;
  const taken: CarriedFuel = {
    id: `carried-${++carriedCounter}`,
    woodId: patch.woodId,
    grade: patch.grade,
    moisture: patch.moisture,
  };
  state.armful.push(taken);
  const introduction = patch.introduced ? null : patch.foundAs;
  patch.introduced = true;
  return { taken, introduction, full: false, empty: false };
}

/** Takes the top piece out of your arms. Null when you are carrying nothing. */
export function takeFromArmful(state: GatheringState, id?: string): CarriedFuel | null {
  if (state.armful.length === 0) return null;
  const index = id === undefined ? state.armful.length - 1 : state.armful.findIndex((p) => p.id === id);
  if (index < 0) return null;
  const [piece] = state.armful.splice(index, 1);
  return piece ?? null;
}

/** Whether there is anything in your arms of a given grade. */
export function carrying(state: GatheringState, grade: FuelGrade): number {
  let count = 0;
  for (const piece of state.armful) if (piece.grade === grade) count++;
  return count;
}

/**
 * What you are carrying, in a phrase.
 *
 * Counted by grade rather than listed, because that is how an armful of wood
 * presents itself to the person holding it.
 */
export function describeArmful(state: GatheringState): string {
  if (state.armful.length === 0) return 'Nothing in your arms.';
  const counts = new Map<FuelGrade, number>();
  for (const piece of state.armful) counts.set(piece.grade, (counts.get(piece.grade) ?? 0) + 1);
  const parts: string[] = [];
  for (const grade of ['log', 'kindling', 'tinder'] as const) {
    const n = counts.get(grade);
    if (!n) continue;
    if (grade === 'log') parts.push(n === 1 ? 'a split log' : `${n} split logs`);
    else if (grade === 'kindling') parts.push(n === 1 ? 'a stick of kindling' : `${n} sticks of kindling`);
    else parts.push(n === 1 ? 'a handful of tinder' : `${n} handfuls of tinder`);
  }
  if (parts.length === 1) return `Carrying ${parts[0]}.`;
  const last = parts.pop();
  return `Carrying ${parts.join(', ')} and ${last}.`;
}
