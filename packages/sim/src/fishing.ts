/**
 * Fishing (spec §5.2).
 *
 * > Slow, mostly uneventful, and that is the point. Casting, the line in the
 * > water, patience, and occasionally something. **This must never become a
 * > minigame with a score.**
 *
 * So the design constraints here are unusual, and they are load-bearing:
 *
 * 1. **The mean gap between bites is minutes, not seconds.** A cast that
 *    produces nothing at all is the normal outcome and is not a failure state.
 *    Nothing in the model gets more generous the longer you go without one:
 *    there is no pity timer, because a pity timer is a promise, and a promise
 *    is an obligation.
 * 2. **Patience is the only skill, and it is shared with the rest of the
 *    camp.** Bite rate rises with the same stillness the wildlife model reads,
 *    so sitting down by the water with a line out is *literally* the same
 *    mechanic as sitting down by the fire (see `sitting.ts`).
 * 3. **Losing one costs nothing.** There is no tackle to lose, no bait to run
 *    out of, no penalty of any kind. A fish that comes off is a story.
 * 4. **There is no score.** No total, no biggest, no personal best, no
 *    species list to complete. `activity.assertNoScoring` is run against every
 *    public readout in this module's tests, precisely because `personalBest`
 *    is the single most natural thing for somebody to add here later.
 *
 * Water comes from `water.ts`, which is content's answer about whether there
 * is anything here to catch at all — several campsites have no water and
 * several have water with nothing in it.
 */

import { approach, clamp, clamp01, lerp, smoothstep } from './math.js';
import { Rng, hashString, mixSeeds } from './rng.js';
import { createEvidence, type SignificanceEvidence } from './significance.js';
import { disturbWater, type WaterFeatureSpec, type WaterKind, type WaterState } from './water.js';
import type { ActivityWindow } from './wildlife.js';

/* -------------------------------------------------------------------------- */
/* What lives in what                                                         */
/* -------------------------------------------------------------------------- */

/**
 * A fish, described rather than catalogued.
 *
 * There is no id a compendium could key on and no rank. `presence` is how
 * common it is here — used to decide what turns up and, invisibly, how much
 * the significance model cares. It is never shown.
 */
export interface FishKind {
  readonly label: string;
  /** Relative likelihood in this water. Positive. */
  readonly presence: number;
  /** Rough mass in kilograms, which is what the rod actually feels. */
  readonly massKg: number;
  /** How hard it fights, 0..1. */
  readonly fight: number;
  readonly note: string;
}

/**
 * What is in each kind of water.
 *
 * Data, in the same spirit as `MARKINGS` in `wildlife.ts`: environments
 * describe their water in prose, not in species tables, so the roster is
 * inferred from the water's kind and the site's own note carries the colour.
 */
const RESIDENTS: Partial<Record<WaterKind, readonly FishKind[]>> = {
  lake: [
    { label: 'a smallmouth', presence: 5, massKg: 0.7, fight: 0.7, note: 'All shoulders, and it goes straight down.' },
    { label: 'a walleye', presence: 3, massKg: 1.1, fight: 0.4, note: 'Comes up like a wet sack and then wakes up at the net.' },
    { label: 'a perch', presence: 6, massKg: 0.2, fight: 0.2, note: 'Barred, spiny, and much too small.' },
    { label: 'something much larger', presence: 0.4, massKg: 6.5, fight: 0.95, note: 'It moves off without hurrying and there is nothing you can do about it.' },
  ],
  river: [
    { label: 'a channel cat', presence: 5, massKg: 1.8, fight: 0.6, note: 'Dark, whiskered, and heavier than it looks.' },
    { label: 'a shiner', presence: 6, massKg: 0.1, fight: 0.1, note: 'Silver, and off the hook before it clears the water.' },
    { label: 'the thing that rolls after midnight', presence: 0.3, massKg: 9, fight: 1, note: 'You never see it. You only feel the river change its mind.' },
  ],
  creek: [
    { label: 'a small trout', presence: 6, massKg: 0.15, fight: 0.45, note: 'Spotted, cold, and back in the water in four seconds.' },
    { label: 'a chub', presence: 4, massKg: 0.2, fight: 0.2, note: 'Blunt-nosed and entirely unbothered.' },
  ],
  blackwater: [
    { label: 'a bluegill', presence: 6, massKg: 0.2, fight: 0.3, note: 'Comes up sideways, the way they do.' },
    { label: 'a bowfin', presence: 1.6, massKg: 2.4, fight: 0.85, note: 'Prehistoric, furious, and best admired from a distance.' },
    { label: 'a warmouth', presence: 3, massKg: 0.25, fight: 0.3, note: 'Red-eyed, out of a hollow log.' },
  ],
  sea: [
    { label: 'a surfperch', presence: 5, massKg: 0.5, fight: 0.5, note: 'Comes in on the back of a wave and fights the whole way.' },
    { label: 'a small rockfish', presence: 3, massKg: 0.8, fight: 0.4, note: 'Orange, indignant, and let straight back.' },
    { label: 'a length of kelp', presence: 4, massKg: 0.6, fight: 0.05, note: 'For a moment it was the fish of your life.' },
  ],
  tarn: [],
  'hot-spring': [],
  'ephemeral-sheet': [],
  none: [],
};

/** What could be caught in this water. Empty is a real, correct answer. */
export function residentsOf(spec: WaterFeatureSpec): readonly FishKind[] {
  if (!spec.fishable) return [];
  return RESIDENTS[spec.kind] ?? [];
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type FishingPhase =
  /** The rod is leaning against the log. */
  | 'stowed'
  /** In hand, nothing in the water. */
  | 'ready'
  /** Mid-cast. */
  | 'casting'
  /** The line is out. This is where almost all of the time goes. */
  | 'soaking'
  /** Something is interested. A short window, easily missed. */
  | 'nibble'
  /** On. */
  | 'playing'
  /** In hand, being looked at, about to go back. */
  | 'landed';

export interface HookedFish {
  readonly kind: FishKind;
  /** Metres of line still out. */
  distanceM: number;
  /** 0..1. Over 1 for too long and the line parts, which is fine. */
  tension: number;
  /** Seconds it has been on. */
  seconds: number;
}

/**
 * One fish, brought in and let go.
 *
 * There is no weight class, no rank, and no id to tick off. What is kept is
 * what a person would actually remember: what it was, when, and what it was
 * like.
 */
export interface FishRecord {
  readonly label: string;
  readonly note: string;
  /** Seconds into the session. */
  readonly at: number;
  /** Seconds it was on the line. */
  readonly playedSeconds: number;
}

export type FishingEventKind = 'cast' | 'nibble' | 'missed' | 'hooked' | 'lost' | 'landed' | 'released';

export interface FishingEvent {
  readonly kind: FishingEventKind;
  readonly at: number;
  readonly label: string;
  /** 0..1 how unusual. Zero for the ordinary business of fishing. */
  readonly rarity: number;
}

export interface FishingState {
  phase: FishingPhase;
  /** Metres out. Set by the cast. */
  castDistanceM: number;
  /** Where the float is, in the water's frame. */
  floatX: number;
  floatZ: number;
  /** Seconds the line has been in the water on this cast. */
  soakSeconds: number;
  /** 0..1 how much the float is dipping right now. The only readout there is. */
  bob: number;
  /** Seconds left in the current nibble window. */
  nibbleSeconds: number;
  /** What is interested, held between the nibble and the strike. */
  interested: FishKind | null;
  hooked: HookedFish | null;
  /** Brought in this session. Not a total, not a score. */
  readonly caught: FishRecord[];
  /** Casts made. Repeated interaction is a significance input, not a stat. */
  casts: number;
  events: FishingEvent[];
  elapsed: number;
  /** Seconds of cast animation left. */
  castSeconds: number;
}

export function createFishing(): FishingState {
  return {
    phase: 'stowed',
    castDistanceM: 0,
    floatX: 0,
    floatZ: 0,
    soakSeconds: 0,
    bob: 0,
    nibbleSeconds: 0,
    interested: null,
    hooked: null,
    caught: [],
    casts: 0,
    events: [],
    elapsed: 0,
    castSeconds: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Bite rate — deliberately, structurally slow                                */
/* -------------------------------------------------------------------------- */

/**
 * Mean seconds between bites for a line sitting in perfect conditions.
 *
 * Three minutes. That is the number this whole activity turns on, and it is
 * chosen rather than tuned: a bite has to be rare enough that the time in
 * between is the experience.
 */
export const BEST_CASE_GAP_SECONDS = 180;

/** Which parts of the night the fish are moving. */
const WINDOW_ACTIVITY: Record<ActivityWindow, number> = {
  dusk: 1,
  'early-night': 0.85,
  'deep-night': 0.6,
  'pre-dawn': 0.95,
  dawn: 1,
};

export interface FishingConditions {
  /** Which part of the night. */
  readonly window: ActivityWindow;
  /** 0..1 the wildlife model's own calm. Patience is the only skill. */
  readonly calm: number;
  /** 0..1 precipitation. Rain is genuinely good fishing. */
  readonly precipitation: number;
  /** 0..1 how disturbed the camp is — a compressor cycle puts them down. */
  readonly disturbance: number;
}

/**
 * Expected bites per second for a line in the water.
 *
 * Exported so the relationship is directly assertable rather than only
 * observable through sampling — the same reason `speciesAppearanceRate` is
 * public in `wildlife.ts`.
 *
 * Note there is no term for how long you have gone without one. A model that
 * gets kinder the longer you wait is a slot machine wearing a hat.
 */
export function biteRate(
  water: WaterState,
  conditions: FishingConditions,
  soakSeconds: number,
): number {
  const residents = residentsOf(water.spec);
  if (residents.length === 0) return 0;

  // A line that has just landed has spooked whatever was under it.
  const settled = smoothstep(0, 22, soakSeconds);
  const window = WINDOW_ACTIVITY[conditions.window];
  const patience = lerp(0.35, 1.25, clamp01(conditions.calm));
  const rain = 1 + clamp01(conditions.precipitation) * 0.4;
  // Chop hides the line, which helps, up to the point where nothing can find it.
  const surface = lerp(0.85, 1.15, smoothstep(0, 0.35, water.chop)) * (1 - smoothstep(0.55, 0.95, water.chop) * 0.5);
  const quiet = clamp01(1 - conditions.disturbance * 0.8);

  return (1 / BEST_CASE_GAP_SECONDS) * settled * window * patience * rain * surface * quiet;
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                    */
/* -------------------------------------------------------------------------- */

/** Picks the rod up off the log. */
export function takeRod(state: FishingState): void {
  if (state.phase === 'stowed') state.phase = 'ready';
}

/** Leans it back against the log. Anything on the line simply goes. */
export function stowRod(state: FishingState): void {
  state.phase = 'stowed';
  state.hooked = null;
  state.interested = null;
  state.nibbleSeconds = 0;
  state.soakSeconds = 0;
  state.bob = 0;
}

/**
 * Casts.
 *
 * `power` 0..1 decides how far out. There is no accuracy requirement and no
 * target: the whole of the water is a fine place to put a float.
 */
export function cast(state: FishingState, water: WaterState, power: number, bearing: number): boolean {
  if (state.phase !== 'ready' && state.phase !== 'soaking' && state.phase !== 'landed') return false;
  const distance = lerp(3, 16, clamp01(power));
  state.castDistanceM = distance;
  state.floatX = Math.cos(bearing) * distance;
  state.floatZ = Math.sin(bearing) * distance;
  state.soakSeconds = 0;
  state.bob = 0;
  state.interested = null;
  state.hooked = null;
  state.nibbleSeconds = 0;
  state.castSeconds = 0.9;
  state.phase = 'casting';
  state.casts += 1;
  disturbWater(water, state.floatX, state.floatZ, 0.35);
  state.events.push({ kind: 'cast', at: state.elapsed, label: 'the float lands', rarity: 0 });
  return true;
}

/**
 * Strikes.
 *
 * Inside the nibble window it hooks; outside it, nothing happens and the fish
 * goes on about its evening. Missing costs nothing — the line stays in the
 * water and the next one is along whenever it is along.
 */
export function strike(state: FishingState): boolean {
  if (state.phase !== 'nibble' || !state.interested) {
    if (state.phase === 'soaking') {
      // Striking at nothing. Perfectly normal; it just resettles the float.
      state.soakSeconds = Math.max(0, state.soakSeconds - 6);
    }
    return false;
  }
  const kind = state.interested;
  state.hooked = { kind, distanceM: state.castDistanceM, tension: 0.25, seconds: 0 };
  state.interested = null;
  state.nibbleSeconds = 0;
  state.phase = 'playing';
  state.events.push({ kind: 'hooked', at: state.elapsed, label: kind.label, rarity: rarityOf(kind) });
  return true;
}

/**
 * Winds in, or gives line.
 *
 * `pull` 0..1: hard reeling brings it closer and raises the tension, easing
 * off lets the tension fall. Break it and it is gone, with no penalty beyond
 * the fish being gone.
 */
export function playFish(state: FishingState, pull: number, dt: number): void {
  const hooked = state.hooked;
  if (state.phase !== 'playing' || !hooked) return;
  const effort = clamp01(pull);
  hooked.seconds += dt;
  hooked.distanceM = Math.max(0, hooked.distanceM - effort * 1.4 * dt);
  // The fish fights back hardest when it is being hauled.
  const load = effort * (0.55 + hooked.kind.fight * 0.95) - 0.35;
  hooked.tension = clamp(hooked.tension + load * dt * 1.5, 0, 1.6);
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/** Seconds a nibble stays available before it thinks better of it. */
const NIBBLE_WINDOW = 2.1;
/** Seconds of over-tension the line will take before it parts. */
const BREAK_SECONDS = 1.6;

export function stepFishing(
  state: FishingState,
  dt: number,
  water: WaterState,
  conditions: FishingConditions,
  rng: Rng,
): void {
  state.elapsed += dt;

  switch (state.phase) {
    case 'stowed':
    case 'ready':
    case 'landed':
      state.bob = approach(state.bob, 0, 3, dt);
      return;

    case 'casting': {
      state.castSeconds -= dt;
      if (state.castSeconds <= 0) state.phase = 'soaking';
      return;
    }

    case 'soaking': {
      state.soakSeconds += dt;
      // The float rides the chop. This is the whole of the readout, and it is
      // deliberately the same signal a real float gives: mostly nothing.
      state.bob = clamp01(water.chop * 0.5 + Math.sin(state.elapsed * 1.7) * 0.05 + 0.05);
      const rate = biteRate(water, conditions, state.soakSeconds);
      if (rate > 0 && rng.chance(rate * dt)) {
        const kind = rng.weightedPick(residentsOf(water.spec), (fish) => fish.presence);
        if (kind) {
          state.interested = kind;
          state.nibbleSeconds = NIBBLE_WINDOW;
          state.phase = 'nibble';
          disturbWater(water, state.floatX, state.floatZ, 0.2);
          state.events.push({ kind: 'nibble', at: state.elapsed, label: 'the float dips', rarity: 0 });
        }
      }
      return;
    }

    case 'nibble': {
      state.soakSeconds += dt;
      state.nibbleSeconds -= dt;
      // The float goes under, comes half back, goes under again.
      state.bob = clamp01(0.55 + Math.sin(state.elapsed * 9) * 0.45);
      if (state.nibbleSeconds <= 0) {
        state.interested = null;
        state.phase = 'soaking';
        state.events.push({ kind: 'missed', at: state.elapsed, label: 'and it is gone', rarity: 0 });
      }
      return;
    }

    case 'playing': {
      const hooked = state.hooked;
      if (!hooked) {
        state.phase = 'soaking';
        return;
      }
      hooked.seconds += dt;
      state.bob = 1;
      // Left alone, a hooked fish takes line back.
      hooked.distanceM = Math.min(state.castDistanceM + 4, hooked.distanceM + hooked.kind.fight * 0.5 * dt);
      hooked.tension = clamp(hooked.tension - 0.35 * dt, 0, 1.6);
      disturbWater(water, state.floatX * 0.5, state.floatZ * 0.5, 0.25);

      if (hooked.tension > 1) {
        // Over-tension is survivable for a moment and then it is not.
        hooked.seconds += dt;
        if (hooked.tension > 1 + BREAK_SECONDS * 0.2) {
          state.hooked = null;
          state.phase = 'soaking';
          state.soakSeconds = 0;
          state.events.push({ kind: 'lost', at: state.elapsed, label: hooked.kind.label, rarity: 0 });
          return;
        }
      }

      if (hooked.distanceM <= 0.35) {
        state.caught.push({
          label: hooked.kind.label,
          note: hooked.kind.note,
          at: state.elapsed,
          playedSeconds: hooked.seconds,
        });
        state.phase = 'landed';
        state.hooked = null;
        state.events.push({
          kind: 'landed',
          at: state.elapsed,
          label: hooked.kind.label,
          rarity: rarityOf(hooked.kind),
        });
      }
      return;
    }

    default:
      return;
  }
}

/**
 * Puts it back.
 *
 * There is no other option, and there is no field anywhere for keeping one.
 * The fish goes back in the water and the rod goes back in your hands.
 */
export function releaseFish(state: FishingState): void {
  if (state.phase !== 'landed') return;
  state.phase = 'ready';
  state.events.push({ kind: 'released', at: state.elapsed, label: 'back it goes', rarity: 0 });
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

function rarityOf(kind: FishKind): number {
  // Rare in the water means rare to have met. Never exposed as a number.
  return clamp01(1 - smoothstep(0.2, 6, kind.presence));
}

export function drainFishingEvents(state: FishingState): FishingEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

export interface FishingSignals {
  phase: FishingPhase;
  /** 0..1 the float's movement. The only thing a fisher actually watches. */
  bob: number;
  /** True while there is a window to strike into. */
  striking: boolean;
  /** 0..1 how hard the rod is loaded, or 0 when nothing is on. */
  load: number;
  /** What is on the end, once it is on. Null otherwise. */
  onTheLine: string | null;
  /** Seconds the line has been in the water. Time, not progress. */
  soakSeconds: number;
}

/**
 * Signals for the interface.
 *
 * Deliberately reports no total and no best: `caught` has a length and this
 * readout does not tell anyone what it is. There is no denominator anywhere in
 * this product (§5.3).
 */
export function fishingSignals(state: FishingState): FishingSignals {
  return {
    phase: state.phase,
    bob: state.bob,
    striking: state.phase === 'nibble',
    load: state.hooked ? clamp01(state.hooked.tension) : 0,
    onTheLine: state.hooked ? state.hooked.kind.label : null,
    soakSeconds: state.soakSeconds,
  };
}

/**
 * Turns a landed fish into evidence for the significance model.
 *
 * The rarity is how uncommon the fish is in this water — the same shape as
 * wildlife's shyness. The value behind the decision never leaves the model.
 */
export function fishingEvidence(
  event: FishingEvent,
  overrides: Partial<SignificanceEvidence> = {},
): SignificanceEvidence {
  return createEvidence('wildlife-encounter', {
    rarity: event.rarity,
    ...overrides,
  });
}

/** A warm, factual line. Never a verdict, never a measurement. */
export function describeCatch(record: FishRecord): string {
  return `${record.label.charAt(0).toUpperCase()}${record.label.slice(1)}. ${record.note}`;
}

/** A stable per-water RNG stream, for varying presentation without disturbing the model. */
export function fishingStream(campsiteSeed: number, label: string): Rng {
  return new Rng(mixSeeds(campsiteSeed, hashString(`fishing:${label}`)));
}
