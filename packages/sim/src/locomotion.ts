/**
 * Player locomotion and the walkable campsite (spec §5.1).
 *
 * "Campsites are compact but genuinely explorable" — a walkable area with real
 * corners, not a corridor and not an open world. Until this module existed the
 * camera was on rails, moving between fixed poses per ritual stage, which made
 * the campsite a set of views rather than a place.
 *
 * Player position is simulation state, not presentation state, because it is
 * gameplay-meaningful: it decides which side of the fire the marshmallow is
 * held from, how much a player is disturbing the wildlife, what is within
 * reach, and — once multiplayer lands — it is one of the inputs replicated to
 * other clients (ADR-0006). So it lives here, under the same rules as
 * everything else: deterministic, fixed timestep, no wall clock.
 */

import { approach, clamp, clamp01, lerp, smoothstep, TAU, wrapAngle } from './math.js';
import { hashToUnit } from './rng.js';
import { vec3, type Vec3 } from './types.js';

// --- Terrain ---------------------------------------------------------------

/**
 * Ground height at a point.
 *
 * Analytic and pure so the simulation and the renderer agree exactly. An
 * earlier version baked per-vertex randomness into the mesh, which meant the
 * player's feet and the visible ground could disagree — invisible at a
 * standstill, and a floating or sunken camera as soon as anyone walked.
 *
 * The clearing is deliberately flat: the fire, the machine and the player all
 * stand on level ground, and the undulation only starts further out.
 */
export function terrainHeight(
  x: number,
  z: number,
  seed: number,
  amplitude = 0.7,
  basin?: WaterBasin,
): number {
  const distance = Math.sqrt(x * x + z * z);
  const flatten = smoothstep(3.5, 9.5, distance);
  const base =
    flatten <= 0
      ? 0
      : (Math.sin(x * 0.35) * Math.cos(z * 0.28) * 0.5 +
          // Two octaves of interpolated value noise, evaluated analytically.
          (valueNoise2D(seed, x * 0.22, z * 0.22) * 0.6 +
            valueNoise2D(seed ^ 0x9e37, x * 0.55, z * 0.55) * 0.25 -
            0.42)) *
        amplitude *
        flatten;

  if (!basin) return base;
  return lerp(base, -basin.depthM, basinDepth(basin, x, z));
}

/**
 * Where the ground goes down to meet the water.
 *
 * Without this the water surface is a plane laid over undulating ground and
 * the shore is wherever the noise happens to poke through — which reads as
 * flooding, not as a lakeshore. The bed is part of the terrain because the
 * player walks on it: wading in at the edge has to be the same ground function
 * the simulation and the renderer both use, for exactly the reason
 * `terrainHeight` is analytic in the first place.
 *
 * It is deliberately shallow. The campsite bound stops a player well before
 * the middle of a lake, so the only water anyone can stand in is the margin,
 * and the margin is ankle-deep.
 */
export interface WaterBasin {
  /** Direction from the fire toward the water, radians. */
  readonly bearing: number;
  /** Metres from the fire to the water's edge. */
  readonly distanceM: number;
  /** How far below the clearing's datum the bed settles. */
  readonly depthM: number;
  /**
   * Half-width of a channel, metres, for a creek or a beck. Omitted for open
   * water, where everything past the shore line is water.
   */
  readonly halfWidthM?: number;
}

/** 0 on dry land, 1 in open water. */
function basinDepth(basin: WaterBasin, x: number, z: number): number {
  const along = x * Math.cos(basin.bearing) + z * Math.sin(basin.bearing);
  const past = smoothstep(basin.distanceM - 0.6, basin.distanceM + 6, along);
  if (basin.halfWidthM === undefined) return past;
  // A creek is a channel, not a half-plane: it has a far bank.
  const across = Math.abs(along - basin.distanceM - basin.halfWidthM);
  const inChannel = 1 - smoothstep(basin.halfWidthM * 0.55, basin.halfWidthM * 1.25, across);
  return Math.min(past, inChannel);
}

/** Smooth 2D value noise. Deterministic, no tables, no allocation. */
function valueNoise2D(seed: number, x: number, z: number): number {
  const xi = Math.floor(x);
  const zi = Math.floor(z);
  const xf = x - xi;
  const zf = z - zi;
  const u = xf * xf * (3 - 2 * xf);
  const v = zf * zf * (3 - 2 * zf);
  const corner = (cx: number, cz: number) => hashToUnit(seed, (cx * 73856093) ^ (cz * 19349663));
  const a = corner(xi, zi);
  const b = corner(xi + 1, zi);
  const c = corner(xi, zi + 1);
  const d = corner(xi + 1, zi + 1);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

/** Surface normal, for foot placement and for leaning props into the slope. */
export function terrainNormal(
  x: number,
  z: number,
  seed: number,
  amplitude = 0.7,
  epsilon = 0.15,
  basin?: WaterBasin,
): Vec3 {
  const hx =
    terrainHeight(x + epsilon, z, seed, amplitude, basin) -
    terrainHeight(x - epsilon, z, seed, amplitude, basin);
  const hz =
    terrainHeight(x, z + epsilon, seed, amplitude, basin) -
    terrainHeight(x, z - epsilon, seed, amplitude, basin);
  const nx = -hx / (2 * epsilon);
  const nz = -hz / (2 * epsilon);
  const length = Math.sqrt(nx * nx + 1 + nz * nz);
  return vec3(nx / length, 1 / length, nz / length);
}

// --- The walkable world ----------------------------------------------------

/** A thing you cannot walk through. Circles: cheap, deterministic, enough. */
export interface Obstacle {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  readonly radius: number;
  /**
   * Soft obstacles push back rather than stopping dead — used for the fire,
   * where walking into it should feel like heat and hesitation rather than a
   * wall.
   */
  readonly soft?: boolean;
}

/** Something the player can reach and act on when close enough. */
export interface Interactable {
  readonly id: string;
  readonly x: number;
  readonly z: number;
  /** How close the player must be, in metres. */
  readonly reach: number;
  /** Facing tolerance in radians; omit to allow any facing. */
  readonly arc?: number;
}

export interface WalkableWorld {
  /** Campsite radius in metres, from the environment manifest. */
  readonly radius: number;
  readonly seed: number;
  readonly amplitude: number;
  readonly obstacles: readonly Obstacle[];
  readonly interactables: readonly Interactable[];
  /** The ground going down to the water, at a campsite that has any. */
  readonly basin?: WaterBasin;
}

export function createWorld(options: {
  radius?: number;
  seed: number;
  amplitude?: number;
  obstacles?: readonly Obstacle[];
  interactables?: readonly Interactable[];
  basin?: WaterBasin;
}): WalkableWorld {
  return {
    radius: options.radius ?? 14,
    seed: options.seed,
    amplitude: options.amplitude ?? 0.7,
    obstacles: options.obstacles ?? [],
    interactables: options.interactables ?? [],
    ...(options.basin ? { basin: options.basin } : {}),
  };
}

// --- The player ------------------------------------------------------------

export const LOCOMOTION = {
  /** A campsite amble, not a sprint. Metres per second. */
  walkSpeed: 1.45,
  /** Slower when picking a way around the fire. */
  carefulSpeed: 0.8,
  /** How quickly the player reaches walking speed. */
  acceleration: 7,
  /** How quickly they stop. */
  damping: 9,
  /** Turn rate when walking to a tapped point, radians/second. */
  turnRate: 5.5,
  /** Eye height above the ground, standing. */
  eyeHeight: 1.58,
  /**
   * Stance heights, as a fraction of `eyeHeight`.
   *
   * These exist so that getting close to something is a thing the *body* does.
   * The first playtest of this game found the opposite: six of the eight ritual
   * stages took the camera off the player entirely and eased it to a composed
   * pose, and the result read as a slideshow of screens rather than one
   * campsite. Every one of those framings was defensible on its own and the
   * aggregate was not, which is the sort of thing only a person can notice.
   *
   * So the camera stays on the player's eyes always, and closeness is bought by
   * kneeling: down to roast, down to work at the table. You can still look
   * around from down there, and standing up is always available.
   */
  seatedStance: 0.62,
  kneelingStance: 0.36,
  /** How quickly a stance change eases, per second. */
  stanceRate: 3.4,
  /** Body radius for collision. */
  bodyRadius: 0.28,
  /** How close to a tapped point counts as arrived. */
  arriveDistance: 0.22,
  /** Floor on the approach speed, as a fraction of walking speed. */
  minApproachSpeed: 0.22,
  /** Pitch limits, radians. */
  minPitch: -0.85,
  maxPitch: 0.72,
  /** Head bob amplitude at full walking speed. */
  bobAmplitude: 0.022,
  bobFrequency: 8.4,
} as const;

export interface PlayerState {
  position: Vec3;
  /** Yaw in radians. 0 looks along +X. */
  facing: number;
  /** Pitch in radians, clamped. */
  pitch: number;
  velocity: Vec3;
  /** Tap-to-move destination, or null when steering directly. */
  moveTarget: Vec3 | null;
  speed: number;
  /** Distance walked in total, metres. */
  distanceWalked: number;
  /**
   * How much noise and motion the player is making, 0..1. Wildlife reads this:
   * stillness is a mechanic (spec §7), so it has to be a real quantity.
   */
  disturbance: number;
  /** Seconds spent continuously still and quiet. */
  stillnessSeconds: number;
  /** Head bob phase, for the renderer. */
  bobPhase: number;
  /** Whether the player is currently seated by the fire. */
  seated: boolean;
  /**
   * Whether the player is knelt down over something they are working on.
   *
   * Set by whatever the player is doing rather than by a movement key: you
   * kneel because you started roasting, and you stand because you stopped.
   */
  kneeling: boolean;
  /**
   * Eye height right now, as a fraction of standing, eased toward the stance
   * the flags above ask for. Continuous on purpose — a snap between heights is
   * a cut, and cuts are the thing this is here to remove.
   */
  stance: number;
}

export function createPlayer(position: Vec3, facing = 0): PlayerState {
  return {
    position: vec3(position.x, position.y, position.z),
    facing,
    pitch: 0,
    velocity: vec3(),
    moveTarget: null,
    speed: 0,
    distanceWalked: 0,
    disturbance: 0,
    stillnessSeconds: 0,
    bobPhase: 0,
    seated: false,
    kneeling: false,
    stance: 1,
  };
}

/** The stance the player's current posture asks for. Seated wins over kneeling. */
export function stanceTarget(player: PlayerState): number {
  if (player.seated) return LOCOMOTION.seatedStance;
  if (player.kneeling) return LOCOMOTION.kneelingStance;
  return 1;
}

/**
 * One frame of movement intent.
 *
 * `move` is a direction in the camera's frame (a joystick or WASD); `target`
 * is a tapped world point. Both are supported because the spec asks for
 * tap-to-move plus drag-to-look as the default, with a virtual joystick as an
 * option (spec §Technical Direction).
 */
export interface MoveIntent {
  /** Strafe/forward in the range -1..1, relative to facing. */
  move?: { forward: number; strafe: number };
  /** A tapped destination. Cleared automatically on arrival. */
  target?: Vec3 | null;
  /**
   * Look delta in radians — a movement that has already happened.
   *
   * **Consumed by the step that applies it**, and zeroed in place. A delta is
   * not a rate: a caller that sets it once a frame and lets it stand across
   * every fixed step in that frame turns the player once per step, so one drag
   * of the thumb turns you as far as the renderer is slow. At 60 fps that is
   * one step and invisible; under software rendering it is dozens. Same family
   * as `applyRoastPose` — input belongs on its own clock, not the frame's.
   */
  look?: { yaw: number; pitch: number };
  /**
   * Look *rate* in radians per second, for input that is held rather than
   * moved: the keyboard's look keys, and a right stick later.
   *
   * Kept separate from `look` precisely because the two have different
   * semantics — this one is multiplied by `dt` and applied on every step, and
   * it is the caller's business to clear it when the key comes up.
   */
  lookRate?: { yaw: number; pitch: number };
  /** Extra noise the player is making this frame (shouting, chopping). */
  noise?: number;
  /** Sitting still by the fire. */
  sit?: boolean;
  /** Knelt over something being worked on. Set by the activity, not by a key. */
  kneel?: boolean;
}

const scratchDirection = vec3();

/** Advances the player one fixed timestep. */
export function stepPlayer(player: PlayerState, world: WalkableWorld, intent: MoveIntent, dt: number): void {
  // --- Look ------------------------------------------------------------
  let yaw = 0;
  let pitch = 0;
  if (intent.look) {
    yaw += intent.look.yaw;
    pitch += intent.look.pitch;
    // Spent. See the note on `MoveIntent.look`.
    intent.look.yaw = 0;
    intent.look.pitch = 0;
  }
  if (intent.lookRate) {
    yaw += intent.lookRate.yaw * dt;
    pitch += intent.lookRate.pitch * dt;
  }
  if (yaw !== 0 || pitch !== 0) {
    player.facing = wrapAngle(player.facing + yaw);
    player.pitch = clamp(player.pitch + pitch, LOCOMOTION.minPitch, LOCOMOTION.maxPitch);
  }

  if (intent.sit !== undefined) player.seated = intent.sit;
  if (intent.kneel !== undefined) player.kneeling = intent.kneel;

  // Ease the body toward the posture it has been asked for. Frame-rate
  // independent, so a slow device kneels at the same speed as a fast one.
  const wanted = stanceTarget(player);
  player.stance += (wanted - player.stance) * (1 - Math.exp(-LOCOMOTION.stanceRate * dt));
  if (intent.target !== undefined) {
    player.moveTarget = intent.target ? vec3(intent.target.x, intent.target.y, intent.target.z) : null;
  }

  // --- Desired direction -------------------------------------------------
  let desiredX = 0;
  let desiredZ = 0;
  let desiredSpeed = 0;

  if (player.seated) {
    player.moveTarget = null;
  } else if (intent.move && (intent.move.forward !== 0 || intent.move.strafe !== 0)) {
    // Direct steering overrides a tapped destination — grabbing the stick
    // should always win over a stale tap.
    player.moveTarget = null;
    const cos = Math.cos(player.facing);
    const sin = Math.sin(player.facing);
    desiredX = cos * intent.move.forward - sin * intent.move.strafe;
    desiredZ = sin * intent.move.forward + cos * intent.move.strafe;
    const magnitude = Math.hypot(desiredX, desiredZ);
    if (magnitude > 0) {
      desiredX /= magnitude;
      desiredZ /= magnitude;
      desiredSpeed = LOCOMOTION.walkSpeed * clamp01(magnitude);
    }
  } else if (player.moveTarget) {
    const dx = player.moveTarget.x - player.position.x;
    const dz = player.moveTarget.z - player.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance <= LOCOMOTION.arriveDistance) {
      player.moveTarget = null;
    } else {
      desiredX = dx / distance;
      desiredZ = dz / distance;
      // Ease off approaching the destination so arrival is a stop, not a jolt —
      // but keep a floor under it. A purely asymptotic approach slows so much
      // in the last few centimetres that the player never formally arrives,
      // the destination is never cleared, and they appear to creep forever.
      desiredSpeed =
        LOCOMOTION.walkSpeed *
        Math.max(LOCOMOTION.minApproachSpeed, smoothstep(LOCOMOTION.arriveDistance, 1.1, distance));
      // Turn to face where you are walking.
      const targetFacing = Math.atan2(desiredZ, desiredX);
      let delta = wrapAngle(targetFacing - player.facing);
      if (delta > Math.PI) delta -= TAU;
      player.facing = wrapAngle(player.facing + clamp(delta, -1, 1) * LOCOMOTION.turnRate * dt);
    }
  }

  // --- Velocity ----------------------------------------------------------
  const targetVx = desiredX * desiredSpeed;
  const targetVz = desiredZ * desiredSpeed;
  const rate = desiredSpeed > 0 ? LOCOMOTION.acceleration : LOCOMOTION.damping;
  player.velocity.x = approach(player.velocity.x, targetVx, rate, dt);
  player.velocity.z = approach(player.velocity.z, targetVz, rate, dt);

  let nextX = player.position.x + player.velocity.x * dt;
  let nextZ = player.position.z + player.velocity.z * dt;

  // --- Obstacles ---------------------------------------------------------
  for (const obstacle of world.obstacles) {
    const dx = nextX - obstacle.x;
    const dz = nextZ - obstacle.z;
    const distance = Math.hypot(dx, dz);
    const minimum = obstacle.radius + LOCOMOTION.bodyRadius;
    if (distance >= minimum || distance === 0) continue;
    const pushX = dx / distance;
    const pushZ = dz / distance;
    if (obstacle.soft) {
      // A soft obstacle slows and nudges rather than stopping dead, so
      // walking toward the fire feels like heat and hesitation.
      const overlap = (minimum - distance) / minimum;
      nextX += pushX * overlap * 0.6 * LOCOMOTION.walkSpeed * dt;
      nextZ += pushZ * overlap * 0.6 * LOCOMOTION.walkSpeed * dt;
      player.velocity.x *= 1 - overlap * 0.5;
      player.velocity.z *= 1 - overlap * 0.5;
    } else {
      // Slide along the obstacle instead of sticking to it.
      nextX = obstacle.x + pushX * minimum;
      nextZ = obstacle.z + pushZ * minimum;
      const into = player.velocity.x * pushX + player.velocity.z * pushZ;
      if (into < 0) {
        player.velocity.x -= pushX * into;
        player.velocity.z -= pushZ * into;
      }
    }
  }

  // --- Campsite bounds ---------------------------------------------------
  const fromCentre = Math.hypot(nextX, nextZ);
  const limit = world.radius - LOCOMOTION.bodyRadius;
  if (fromCentre > limit && fromCentre > 0) {
    nextX = (nextX / fromCentre) * limit;
    nextZ = (nextZ / fromCentre) * limit;
    player.velocity.x *= 0.4;
    player.velocity.z *= 0.4;
    player.moveTarget = null;
  }

  const moved = Math.hypot(nextX - player.position.x, nextZ - player.position.z);
  player.position.x = nextX;
  player.position.z = nextZ;
  player.position.y = terrainHeight(nextX, nextZ, world.seed, world.amplitude, world.basin);
  player.distanceWalked += moved;
  player.speed = dt > 0 ? moved / dt : 0;

  // --- Head bob ----------------------------------------------------------
  player.bobPhase = (player.bobPhase + player.speed * LOCOMOTION.bobFrequency * dt) % TAU;

  // --- Disturbance and stillness ----------------------------------------
  // Moving and making noise disturb; standing quiet lets it decay and banks
  // stillness. Wildlife reads both.
  const generated = clamp01(player.speed / LOCOMOTION.walkSpeed) * 0.85 + clamp01(intent.noise ?? 0);
  player.disturbance = clamp01(approach(player.disturbance, clamp01(generated), generated > player.disturbance ? 6 : 0.45, dt));
  if (player.disturbance < 0.08) {
    player.stillnessSeconds += dt;
  } else {
    player.stillnessSeconds = 0;
  }
}

/** Eye position, including head bob. Read by the camera. */
export function eyePosition(player: PlayerState, out: Vec3 = vec3()): Vec3 {
  const bob = Math.sin(player.bobPhase) * LOCOMOTION.bobAmplitude * clamp01(player.speed / LOCOMOTION.walkSpeed);
  const height = LOCOMOTION.eyeHeight * player.stance;
  out.x = player.position.x;
  out.y = player.position.y + height + bob;
  out.z = player.position.z;
  return out;
}

/** Unit vector the player is looking along. */
export function lookDirection(player: PlayerState, out: Vec3 = vec3()): Vec3 {
  const cosPitch = Math.cos(player.pitch);
  out.x = Math.cos(player.facing) * cosPitch;
  out.y = Math.sin(player.pitch);
  out.z = Math.sin(player.facing) * cosPitch;
  return out;
}

/** The bearing of the player around the fire pit at the origin. */
export function bearingFromFire(player: PlayerState): number {
  return Math.atan2(player.position.z, player.position.x);
}

/** Horizontal distance from the fire pit. */
export function distanceFromFire(player: PlayerState): number {
  return Math.hypot(player.position.x, player.position.z);
}

// --- Reach -----------------------------------------------------------------

export interface ReachResult {
  readonly interactable: Interactable;
  readonly distance: number;
  /** How squarely the player is facing it, 0..1. */
  readonly facing: number;
}

/**
 * What the player can act on right now, nearest first.
 *
 * Contextual direct manipulation (spec §Technical Direction) means the world
 * offers what is within arm's reach rather than presenting a menu, so this is
 * what drives the interface's affordances.
 */
export function reachable(player: PlayerState, world: WalkableWorld): ReachResult[] {
  const results: ReachResult[] = [];
  for (const interactable of world.interactables) {
    const dx = interactable.x - player.position.x;
    const dz = interactable.z - player.position.z;
    const distance = Math.hypot(dx, dz);
    if (distance > interactable.reach) continue;

    const angle = Math.atan2(dz, dx);
    let delta = wrapAngle(angle - player.facing);
    if (delta > Math.PI) delta -= TAU;
    const facing = clamp01(1 - Math.abs(delta) / Math.PI);
    if (interactable.arc !== undefined && Math.abs(delta) > interactable.arc) continue;

    results.push({ interactable, distance, facing });
  }
  results.sort((a, b) => a.distance - b.distance);
  return results;
}

/** The single best thing to act on, or null. */
export function focused(player: PlayerState, world: WalkableWorld): Interactable | null {
  const candidates = reachable(player, world);
  if (candidates.length === 0) return null;
  // Prefer what the player is actually looking at over what is merely nearest.
  let best = candidates[0] as ReachResult;
  for (const candidate of candidates) {
    const score = candidate.facing * 2 - candidate.distance / Math.max(0.001, candidate.interactable.reach);
    const bestScore = best.facing * 2 - best.distance / Math.max(0.001, best.interactable.reach);
    if (score > bestScore) best = candidate;
  }
  return best.interactable;
}

/**
 * A walkable destination adjacent to an interactable — where you stand to use
 * a thing, rather than standing on top of it.
 */
export function approachPoint(target: Interactable, from: PlayerState, standoff = 0.85): Vec3 {
  const dx = from.position.x - target.x;
  const dz = from.position.z - target.z;
  const distance = Math.hypot(dx, dz) || 1;
  return vec3(target.x + (dx / distance) * standoff, 0, target.z + (dz / distance) * standoff);
}
