/**
 * Stone skipping (spec §5.2).
 *
 * The skip count is **not rolled**. A stone is thrown with a speed, an
 * elevation, a tilt and a spin; it flies ballistically; and every time it meets
 * the water the collision is resolved from the angle its face presents to the
 * flow, the speed it arrives at, and the slope of whatever wavelet is actually
 * there. Whether it skips again, and how many times, falls out of that.
 *
 * The physics follows the shape of the real result (Bocquet, *The physics of
 * stone skipping*, 2003) rather than its full derivation:
 *
 * - There is a **magic angle**. A stone whose face meets the water at about
 *   20° gets the most lift for the least energy; steeper and it ploughs in,
 *   flatter and it slaps and dies. {@link MAGIC_ATTACK_RAD} is that angle and
 *   {@link bounceQuality} is the curve around it.
 * - There is a **minimum speed**. Below it the reaction force cannot lift the
 *   stone's weight, and it simply sinks — which is why the last few skips
 *   crowd together and then stop.
 * - **Spin is stability, not lift.** A fast-spinning stone holds its attitude
 *   through a bounce; a slow one is turned by the impact and by the water's
 *   own slope, and once its leading edge drops it knifes in.
 *
 * The water is read through `water.ts`, which is analytic and rng-free, so the
 * whole model is: same throw + same water + same moment ⇒ same number of
 * skips, on every device (ADR-0001). There is no `Rng` anywhere in this file
 * and there must never be one.
 *
 * Nothing here is scored. A stone that sinks on the first touch produces the
 * same shape of result as one that skipped eleven times, and neither unlocks,
 * grants or completes anything (spec §5.2 — see `activity.ts`).
 */

import { clamp, clamp01, lerp, smoothstep } from './math.js';
import { createEvidence, type SignificanceEvidence } from './significance.js';
import { vec3, type Vec3 } from './types.js';
import { disturbWater, waveHeight, waveSlope, type WaterState } from './water.js';

/* -------------------------------------------------------------------------- */
/* Constants — the physics, named                                             */
/* -------------------------------------------------------------------------- */

const GRAVITY = 9.81;

/** Mild quadratic-ish air drag, as a fraction of speed lost per second. */
const AIR_DRAG = 0.035;

/** The angle of attack that skips best. 20°, as measured. */
export const MAGIC_ATTACK_RAD = 0.349;

/** Width of the usable band around the magic angle, radians. */
const ATTACK_TOLERANCE = 0.2;

/** Below this the reaction force cannot lift the stone. Metres per second. */
export const MIN_SKIP_SPEED = 2.2;

/** Past this the stone is presenting its face like a spade. Radians. */
const PLOUGH_ATTACK_RAD = 1.15;

/** Below this the leading edge is down and the stone knifes in. Radians. */
const KNIFE_TILT_RAD = -0.06;

/** Spin at which gyroscopic stability is about half. Radians per second. */
const SPIN_HALF_STABLE = 12;

/** Hard cap so a pathological throw cannot spin the loop forever. */
const MAX_SKIPS = 64;

/**
 * How much water there is to skip along, metres.
 *
 * Not simply the width: you skip *along* a creek pool or a river bank rather
 * than across it, and content's `widthM` is the body's extent, not the throw's
 * runway. A lake is all runway; a four-metre slot in a gorge gives you the
 * length of the pool.
 */
export function skipRunwayM(spec: { readonly widthM: number }): number {
  return Math.max(spec.widthM, 18);
}

/** Seconds a stone may be in the air before it is called done. */
const MAX_FLIGHT_SECONDS = 12;

/* -------------------------------------------------------------------------- */
/* The throw                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * What the player actually does with their arm.
 *
 * Every field is 0..1 so the same throw can be produced by a drag, by the
 * keyboard, or by the single-input simplified path (spec §12) without any of
 * them knowing the units underneath.
 */
export interface ThrowInput {
  /** How hard. 0 is a lob, 1 is everything you have. */
  readonly power: number;
  /** How high. 0 is flat along the surface, 1 is up over the water. */
  readonly elevation: number;
  /** How the stone is cocked in the hand. 0 is edge-on, 1 is face-up. */
  readonly tilt: number;
  /** How much wrist. 0 is none, 1 is a hard flick. */
  readonly spin: number;
  /** Which way, radians. Bearing in the world's frame. */
  readonly bearing: number;
}

/** A sensible throw, for the keyboard path to start from and nudge. */
export function createThrow(overrides: Partial<ThrowInput> = {}): ThrowInput {
  // `tilt` 0.32 is the magic angle. A default that is already right would make
  // the sweet spot invisible, so this is *near* it and not on it.
  return { power: 0.7, elevation: 0.16, tilt: 0.36, spin: 0.6, bearing: 0, ...overrides };
}

/** Launch speed, m/s. A hard throw is about 16 m/s, which is a real throw. */
export function throwSpeed(power: number): number {
  return lerp(4, 17, clamp01(power));
}

/** Launch angle above the horizontal, radians. */
export function throwElevation(elevation: number): number {
  return lerp(-0.03, 0.38, clamp01(elevation));
}

/**
 * The stone's tilt out of the hand, radians.
 *
 * The range deliberately covers *both* ways of getting it wrong. At the bottom
 * the leading edge is fractionally down and the stone knifes straight in; at
 * the top it is cocked back like a spade and ploughs. The magic angle sits at
 * about a third of the way along, which is where it belongs: findable, and not
 * where a thumb naturally lands.
 */
export function throwTilt(tilt: number): number {
  return lerp(-0.1, 1.3, clamp01(tilt));
}

/** Spin, radians per second. A good flick is around 60–90. */
export function throwSpin(spin: number): number {
  return lerp(0, 95, clamp01(spin));
}

/* -------------------------------------------------------------------------- */
/* The stone                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A stone off the shore.
 *
 * Real stones differ, and picking a good one is half of skipping. These are
 * derived from the shore, never rolled at throw time, so the flat one stays
 * the flat one.
 */
export interface Stone {
  readonly id: string;
  /** Mass in kilograms. A good skipper is 30–100 g. */
  readonly massKg: number;
  /** Radius in metres. */
  readonly radiusM: number;
  /**
   * 0 = a lump, 1 = a perfect disc. Flatness scales the lift the face can
   * generate, so a round stone needs a much better throw to skip at all.
   */
  readonly flatness: number;
  /** What it looks like in the hand. */
  readonly note: string;
}

/**
 * Picks the stones lying on this shore.
 *
 * Deterministic from the campsite seed: the same handful is there on every
 * visit, which is a small thing that makes a shore a place rather than a
 * spawner.
 */
export function shoreStones(campsiteSeed: number, count = 5): Stone[] {
  const stones: Stone[] = [];
  for (let i = 0; i < count; i++) {
    // A cheap, stable hash per index — no Rng, so the shore is the shore.
    const a = ((campsiteSeed ^ (i * 0x9e3779b9)) >>> 0) / 0x100000000;
    const b = ((campsiteSeed ^ (i * 0x85ebca6b + 0x27d4eb2f)) >>> 0) / 0x100000000;
    const c = ((campsiteSeed ^ (i * 0xc2b2ae35 + 0x165667b1)) >>> 0) / 0x100000000;
    const flatness = clamp01(0.25 + a * 0.75);
    stones.push({
      id: `stone-${i}`,
      massKg: lerp(0.028, 0.14, b),
      radiusM: lerp(0.025, 0.055, c),
      flatness,
      note:
        flatness > 0.82
          ? 'flat as a coin, and it fits your thumb'
          : flatness > 0.55
            ? 'flat enough, with one good edge'
            : flatness > 0.35
              ? 'thicker than it looked'
              : 'a lump, really',
    });
  }
  return stones;
}

/** The best stone on this shore. Finding it is the reward for looking. */
export function bestStone(stones: readonly Stone[]): Stone | null {
  let best: Stone | null = null;
  for (const stone of stones) {
    if (!best || stone.flatness > best.flatness) best = stone;
  }
  return best;
}

/* -------------------------------------------------------------------------- */
/* Bounce mechanics — public so the physics is directly assertable            */
/* -------------------------------------------------------------------------- */

/**
 * How well a face meeting the water at `attack` radians converts speed into
 * lift, 0..1.
 *
 * Peaked at the magic angle, and zero at or below zero attack, where the
 * leading edge is buried and the stone is a knife rather than a wing.
 */
export function bounceQuality(attack: number): number {
  if (attack <= 0) return 0;
  if (attack >= PLOUGH_ATTACK_RAD) return 0;
  const d = attack - MAGIC_ATTACK_RAD;
  return Math.exp(-(d * d) / (2 * ATTACK_TOLERANCE * ATTACK_TOLERANCE));
}

/**
 * How firmly spin holds the stone's attitude through an impact, 0..1.
 *
 * This is the whole role of spin: a stone with none of it gets turned by the
 * first bounce and dives on the second, however well it was thrown.
 */
export function gyroscopicStability(spinRadPerSec: number): number {
  const s = Math.abs(spinRadPerSec);
  return s / (s + SPIN_HALF_STABLE);
}

/**
 * How much of the arriving velocity is aimed *under* the stone's own face,
 * 0 (safe) to 1 (it submerges), given the face angle and the incidence.
 *
 * This is the second half of the real criterion and the reason a high lob
 * fails: the face can be at a perfect twenty degrees and still be useless if
 * the stone is falling almost straight down onto it, because the water closes
 * over the leading edge before the underside has generated anything.
 */
export function submersionRisk(attack: number, incidence: number): number {
  if (attack <= 0) return 1;
  return smoothstep(attack * 0.8, attack * 2.6, incidence);
}

/**
 * Whether a stone arriving at this speed can be lifted at all, 0..1.
 *
 * Below `MIN_SKIP_SPEED` the answer is flatly no, which is what ends every
 * throw eventually and why the skips crowd together at the end.
 */
export function liftAvailable(speedMs: number, flatness: number): number {
  const speed = smoothstep(MIN_SKIP_SPEED * 0.72, MIN_SKIP_SPEED * 2.4, speedMs);
  // A round stone has much less face to lift with — but "a lump, really" still
  // skips twice for somebody who throws it properly, which is true and is the
  // difference between a stone that is worse and a stone that is disallowed.
  return speed * lerp(0.25, 1, smoothstep(0.12, 0.75, flatness));
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

export type SkipPhase =
  /** Nothing in hand. */
  | 'idle'
  /** A stone picked up, weighed, not yet thrown. */
  | 'held'
  /** In the air. */
  | 'flying'
  /** It went in. Every throw ends here or at `shore`. */
  | 'sunk'
  /** It made the far bank, which at a creek is most of them. */
  | 'shore';

export type SkipEventKind = 'picked-up' | 'thrown' | 'skip' | 'sunk' | 'shore';

export interface SkipEvent {
  readonly kind: SkipEventKind;
  readonly at: number;
  /** Which bounce this was, 1-based. 0 for non-bounce events. */
  readonly index: number;
  /** Where it happened. */
  readonly position: Vec3;
  /** Impact speed, m/s. Drives how loud the plip is. */
  readonly speedMs: number;
  /** Metres from the thrower. */
  readonly distanceM: number;
}

/** One bounce, kept so the throw can be described afterwards. */
export interface SkipBounce {
  readonly index: number;
  readonly x: number;
  readonly z: number;
  readonly speedMs: number;
  /** Metres since the previous touch — these shorten toward the end. */
  readonly gapM: number;
}

export interface SkippingState {
  phase: SkipPhase;
  /** Stones on this shore. The same ones every visit. */
  readonly stones: readonly Stone[];
  /** What is in the hand. */
  held: Stone | null;
  position: Vec3;
  velocity: Vec3;
  /** Face angle relative to horizontal, radians. */
  tilt: number;
  /** Radians per second. Decays through the flight and hard at each bounce. */
  spin: number;
  /** Bounces so far this throw. */
  skips: number;
  bounces: SkipBounce[];
  /** Where it left the hand. */
  origin: Vec3;
  /** Seconds in the air this throw. */
  flightSeconds: number;
  /** Metres travelled from the hand when it finally stopped. */
  distanceM: number;
  /** The chop the water had at the moment of release. Kept for the record. */
  chopAtRelease: number;
  /** Throws made this session, so the significance model can tell a first. */
  throws: number;
  events: SkipEvent[];
  elapsed: number;
}

export function createSkipping(campsiteSeed: number): SkippingState {
  return {
    phase: 'idle',
    stones: shoreStones(campsiteSeed),
    held: null,
    position: vec3(),
    velocity: vec3(),
    tilt: 0,
    spin: 0,
    skips: 0,
    bounces: [],
    origin: vec3(),
    flightSeconds: 0,
    distanceM: 0,
    chopAtRelease: 0,
    throws: 0,
    events: [],
    elapsed: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Picks a stone up off the shore.
 *
 * `stoneId` omitted takes the next one along, so the keyboard path and the
 * simplified single-input path can both work by simply reaching down again.
 */
export function pickUpStone(state: SkippingState, stoneId?: string): Stone | null {
  if (state.phase === 'flying') return null;
  if (state.stones.length === 0) return null;
  let stone: Stone | undefined;
  if (stoneId) {
    stone = state.stones.find((candidate) => candidate.id === stoneId);
  } else {
    const current = state.held ? state.stones.indexOf(state.held) : -1;
    stone = state.stones[(current + 1) % state.stones.length];
  }
  if (!stone) return null;
  state.held = stone;
  state.phase = 'held';
  state.events.push({
    kind: 'picked-up',
    at: state.elapsed,
    index: 0,
    position: vec3(state.origin.x, state.origin.y, state.origin.z),
    speedMs: 0,
    distanceM: 0,
  });
  return stone;
}

/** Puts it back down. No stone is consumed by throwing it; the shore is a shore. */
export function dropStone(state: SkippingState): void {
  if (state.phase === 'flying') return;
  state.held = null;
  state.phase = 'idle';
}

/**
 * Throws.
 *
 * `from` is the hand: the shore position and about chest height. Returns
 * false when there is nothing in hand or one is already in the air — never
 * because the throw was "bad", because there is no such thing.
 */
export function throwStone(
  state: SkippingState,
  input: ThrowInput,
  from: Vec3,
  water: WaterState,
): boolean {
  if (state.phase === 'flying') return false;
  const stone = state.held ?? state.stones[0];
  if (!stone) return false;

  state.held = stone;
  const speed = throwSpeed(input.power);
  const elevation = throwElevation(input.elevation);
  const horizontal = Math.cos(elevation) * speed;

  state.position.x = from.x;
  state.position.y = from.y;
  state.position.z = from.z;
  state.origin.x = from.x;
  state.origin.y = from.y;
  state.origin.z = from.z;
  state.velocity.x = Math.cos(input.bearing) * horizontal;
  state.velocity.y = Math.sin(elevation) * speed;
  state.velocity.z = Math.sin(input.bearing) * horizontal;
  state.tilt = throwTilt(input.tilt);
  state.spin = throwSpin(input.spin);
  state.skips = 0;
  state.bounces = [];
  state.flightSeconds = 0;
  state.distanceM = 0;
  state.chopAtRelease = water.chop;
  state.throws += 1;
  state.phase = 'flying';
  state.events.push({
    kind: 'thrown',
    at: state.elapsed,
    index: 0,
    position: vec3(from.x, from.y, from.z),
    speedMs: speed,
    distanceM: 0,
  });
  return true;
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Advances a stone in flight by one fixed timestep.
 *
 * Deliberately takes no `Rng`. Everything stochastic-looking about a throw —
 * the wavelet it happens to land on, the way a badly spun stone wanders — is
 * an analytic function of where and when it touched down.
 */
export function stepSkipping(state: SkippingState, dt: number, water: WaterState): void {
  state.elapsed += dt;
  if (state.phase !== 'flying') return;

  state.flightSeconds += dt;

  // --- Ballistic flight ---------------------------------------------------
  state.velocity.y -= GRAVITY * dt;
  const drag = 1 - AIR_DRAG * dt;
  state.velocity.x *= drag;
  state.velocity.y *= drag;
  state.velocity.z *= drag;
  // Spin bleeds slowly in air and hard on contact.
  state.spin *= 1 - 0.06 * dt;

  state.position.x += state.velocity.x * dt;
  state.position.y += state.velocity.y * dt;
  state.position.z += state.velocity.z * dt;

  state.distanceM = Math.hypot(
    state.position.x - state.origin.x,
    state.position.z - state.origin.z,
  );

  // --- Did it run out of water? -------------------------------------------
  if (state.distanceM > skipRunwayM(water.spec)) {
    finish(state, 'shore', 0);
    return;
  }
  if (state.flightSeconds > MAX_FLIGHT_SECONDS) {
    finish(state, 'sunk', 0);
    return;
  }

  // --- Contact ------------------------------------------------------------
  const surface = water.shore.surfaceY + waveHeight(water, state.position.x, state.position.z);
  if (state.position.y > surface || state.velocity.y >= 0) return;

  resolveBounce(state, water, surface);
}

/**
 * Resolves one meeting between the stone and the water.
 *
 * This is the whole model. Read it as: how much face is presented, how fast is
 * it arriving, how much lift does that buy, and did the impact leave the stone
 * pointing anywhere useful for the next one.
 */
function resolveBounce(state: SkippingState, water: WaterState, surfaceY: number): void {
  const stone = state.held ?? state.stones[0];
  const flatness = stone ? stone.flatness : 0.6;

  const vx = state.velocity.x;
  const vy = state.velocity.y;
  const vz = state.velocity.z;
  const horizontal = Math.hypot(vx, vz);
  const speed = Math.hypot(horizontal, vy);

  // Incidence: how steeply it is coming down onto the surface.
  const incidence = Math.atan2(-vy, Math.max(horizontal, 1e-4));
  // The face meets the flow at its own tilt plus that incidence, tipped again
  // by whatever the surface is doing right there. On glass the last term is
  // zero and the throw is all that matters.
  const slope = waveSlope(water, state.position.x, state.position.z);
  // The *face* angle. Bocquet's magic angle is a property of how the stone is
  // held, not of how it is falling — an earlier version added the incidence in
  // here, which had the perverse effect of making round stones skip better
  // than flat ones, because their feeble bounces kept the next incidence small.
  const attack = state.tilt + slope;

  const quality = bounceQuality(attack) * (1 - submersionRisk(attack, incidence));
  const lift = liftAvailable(speed, flatness);

  const index = state.skips + 1;
  const previous = state.bounces[state.bounces.length - 1];
  const gapM = previous
    ? Math.hypot(state.position.x - previous.x, state.position.z - previous.z)
    : Math.hypot(state.position.x - state.origin.x, state.position.z - state.origin.z);

  disturbWater(water, state.position.x, state.position.z, clamp01(speed / 14));

  // A stone with its nose down, or presenting a spade, goes in. So does one
  // arriving too slowly to be lifted.
  const knifed = state.tilt < KNIFE_TILT_RAD;
  const ploughed = attack >= PLOUGH_ATTACK_RAD;
  // Restitution, not propulsion: a skip returns part of the vertical speed the
  // stone arrived with. This is what makes the hops shorten of their own
  // accord and the last few crowd together, and it is why a stone never gains
  // height across a throw.
  const bounceVy = Math.abs(vy) * (0.18 + 0.42 * quality) * lift;
  const energyLoss = clamp01(0.05 + (1 - quality) * 0.46 + water.chop * 0.14 + incidence * 0.3);
  const nextHorizontal = horizontal * (1 - energyLoss);

  if (knifed || ploughed || bounceVy < 0.13 || nextHorizontal < 0.75 || index > MAX_SKIPS) {
    state.bounces.push({ index, x: state.position.x, z: state.position.z, speedMs: speed, gapM });
    state.position.y = surfaceY;
    finish(state, 'sunk', speed);
    return;
  }

  // It skipped.
  state.skips = index;
  state.bounces.push({ index, x: state.position.x, z: state.position.z, speedMs: speed, gapM });
  const scale = horizontal > 1e-4 ? nextHorizontal / horizontal : 0;
  state.velocity.x = vx * scale;
  state.velocity.z = vz * scale;
  state.velocity.y = bounceVy;
  state.position.y = surfaceY + 0.001;

  // Attitude after the impact. A well-spun stone comes off pointing much where
  // it went in; a poorly spun one is turned by the water, and by the third or
  // fourth bounce that is what ends the throw.
  const stability = gyroscopicStability(state.spin);
  const kick = (1 - stability) * 0.19 + water.chop * 0.22 + (1 - quality) * 0.1;
  // Deterministic, position-derived sign: the wavelet it hit, not a die.
  const direction = Math.sign(slope !== 0 ? slope : Math.sin(state.position.x * 7.3 + state.position.z * 4.1));
  state.tilt = clamp(state.tilt + kick * (direction || 1), -0.6, 1.4);
  state.spin *= 0.87;

  state.events.push({
    kind: 'skip',
    at: state.elapsed,
    index,
    position: vec3(state.position.x, surfaceY, state.position.z),
    speedMs: speed,
    distanceM: state.distanceM,
  });
}

function finish(state: SkippingState, phase: 'sunk' | 'shore', speed: number): void {
  state.phase = phase;
  state.velocity.x = 0;
  state.velocity.y = 0;
  state.velocity.z = 0;
  state.events.push({
    kind: phase === 'sunk' ? 'sunk' : 'shore',
    at: state.elapsed,
    index: state.skips,
    position: vec3(state.position.x, state.position.y, state.position.z),
    speedMs: speed,
    distanceM: state.distanceM,
  });
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

export function drainSkipEvents(state: SkippingState): SkipEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

/**
 * What a throw was.
 *
 * Facts about a thing that happened, never a verdict on it — there is no
 * rating here and `activity.assertNoScoring` is what keeps one out.
 */
export interface SkipSummary {
  /** How many times it touched and came back off. */
  readonly skips: number;
  /** Metres from the hand to where it finally went in. */
  readonly distanceM: number;
  /** Seconds it was out there. */
  readonly flightSeconds: number;
  /** 0..1 how flat the water was when it left the hand. */
  readonly glass: number;
  /** Whether it made the far bank instead of sinking. */
  readonly reachedShore: boolean;
  /** A warm, factual line. */
  readonly telling: string;
}

export function summariseSkip(state: SkippingState): SkipSummary {
  return {
    skips: state.skips,
    distanceM: state.distanceM,
    flightSeconds: state.flightSeconds,
    glass: clamp01(1 - state.chopAtRelease * 1.35),
    reachedShore: state.phase === 'shore',
    telling: describeSkip(state),
  };
}

/**
 * A line for the subtitle layer and the Passport.
 *
 * Notice there is no "good throw" or "bad throw" anywhere in it. A stone that
 * went straight in is described as exactly that, warmly, and the world moves
 * on (spec §5.3 — no checklists, no verdicts).
 */
export function describeSkip(state: SkippingState): string {
  if (state.phase === 'shore') return 'It made the far bank.';
  switch (state.skips) {
    case 0:
      return 'Straight in.';
    case 1:
      return 'One, and gone.';
    case 2:
      return 'Two.';
    case 3:
    case 4:
      return `${state.skips}, and a good sound off the last one.`;
    default:
      return `${state.skips}, the last few almost too fast to count.`;
  }
}

/**
 * Turns a throw into evidence for the significance model.
 *
 * A long run of skips across dead-flat water in the middle of the night is a
 * thing a person remembers, and this is where that becomes true of the world
 * as well. The score behind the decision is never stored and never shown
 * (spec §6.4) — this hands over evidence and the model decides.
 *
 * `rarity` is built from what actually made the moment: how many times it
 * skipped, and how still the water was to skip on. Neither is exposed anywhere
 * a player can see.
 */
export function skipEvidence(
  summary: SkipSummary,
  overrides: Partial<SignificanceEvidence> = {},
): SignificanceEvidence {
  const run = smoothstep(3, 12, summary.skips);
  const mirror = smoothstep(0.4, 0.98, summary.glass);
  return createEvidence('environmental', {
    rarity: clamp01(run * 0.75 + run * mirror * 0.25),
    dwellSeconds: summary.flightSeconds,
    ...overrides,
  });
}
