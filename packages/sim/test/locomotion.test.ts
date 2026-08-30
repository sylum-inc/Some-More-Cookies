import { describe, expect, it } from 'vitest';
import {
  approachPoint,
  bearingFromFire,
  createPlayer,
  createWorld,
  distanceFromFire,
  eyePosition,
  focused,
  LOCOMOTION,
  lookDirection,
  reachable,
  stepPlayer,
  terrainHeight,
  terrainNormal,
  type MoveIntent,
  type PlayerState,
  type WalkableWorld,
} from '../src/locomotion.js';
import { SIM_DT, vec3 } from '../src/types.js';

const WORLD: WalkableWorld = createWorld({
  seed: 1234,
  radius: 12,
  obstacles: [
    { id: 'fire', x: 0, z: 0, radius: 0.55, soft: true },
    { id: 'machine', x: -2.75, z: 1.75, radius: 0.6 },
    { id: 'stump', x: 1.42, z: 1.32, radius: 0.3 },
  ],
  interactables: [
    { id: 'fire', x: 0, z: 0, reach: 1.3 },
    { id: 'woodpile', x: 1.7, z: -0.9, reach: 1.0 },
    { id: 'machine', x: -2.75, z: 1.75, reach: 1.4 },
    { id: 'stump', x: 1.42, z: 1.32, reach: 0.9 },
  ],
});

function walk(player: PlayerState, intent: MoveIntent, seconds: number, world = WORLD): PlayerState {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) stepPlayer(player, world, intent, SIM_DT);
  return player;
}

describe('terrain', () => {
  it('is flat in the clearing so the fire and the player stand level', () => {
    for (const [x, z] of [[0, 0], [1, 1], [2, -2], [3, 0]] as const) {
      expect(Math.abs(terrainHeight(x, z, 1234))).toBeLessThan(1e-9);
    }
  });

  it('undulates further out', () => {
    let variation = 0;
    for (let i = 0; i < 40; i++) {
      const angle = (i / 40) * Math.PI * 2;
      variation += Math.abs(terrainHeight(Math.cos(angle) * 12, Math.sin(angle) * 12, 1234));
    }
    expect(variation / 40).toBeGreaterThan(0.05);
  });

  it('is continuous — no cliffs between adjacent samples', () => {
    let worst = 0;
    for (let x = -14; x <= 14; x += 0.25) {
      for (let z = -14; z <= 14; z += 2) {
        const a = terrainHeight(x, z, 99);
        const b = terrainHeight(x + 0.25, z, 99);
        worst = Math.max(worst, Math.abs(a - b));
      }
    }
    expect(worst).toBeLessThan(0.2);
  });

  it('is deterministic and seed-dependent', () => {
    expect(terrainHeight(8, 5, 1)).toBe(terrainHeight(8, 5, 1));
    expect(terrainHeight(8, 5, 1)).not.toBe(terrainHeight(8, 5, 2));
  });

  it('produces normalised normals pointing upward', () => {
    for (const [x, z] of [[0, 0], [7, 3], [-11, 6]] as const) {
      const n = terrainNormal(x, z, 5);
      expect(Math.hypot(n.x, n.y, n.z)).toBeCloseTo(1, 5);
      expect(n.y).toBeGreaterThan(0.5);
    }
  });
});

describe('walking', () => {
  it('starts still', () => {
    const player = createPlayer(vec3(2, 0, 1));
    expect(player.speed).toBe(0);
    expect(player.moveTarget).toBeNull();
  });

  it('walks toward a tapped point and stops there', () => {
    // Open ground: tapping into a stump is the collision test's job, not this one.
    const player = createPlayer(vec3(3, 0, -3));
    walk(player, { target: vec3(5, 0, -5) }, 8);
    expect(Math.hypot(player.position.x - 5, player.position.z + 5)).toBeLessThan(0.3);
    expect(player.moveTarget).toBeNull();
    expect(player.speed).toBeLessThan(0.1);
  });

  it('turns to face where it is walking', () => {
    const player = createPlayer(vec3(3, 0, 0), 0);
    walk(player, { target: vec3(3, 0, 4) }, 3);
    // Heading toward +Z means a facing near +PI/2.
    expect(Math.abs(player.facing - Math.PI / 2)).toBeLessThan(0.4);
  });

  it('walks at a campsite amble, never a sprint', () => {
    // Around the clearing rather than through the fire, which slows you on purpose.
    const player = createPlayer(vec3(6, 0, -6));
    walk(player, { target: vec3(-6, 0, -6) }, 4);
    expect(player.speed).toBeGreaterThan(0.5);
    expect(player.speed).toBeLessThanOrEqual(LOCOMOTION.walkSpeed + 0.01);
  });

  it('accepts direct steering', () => {
    const player = createPlayer(vec3(4, 0, 0), 0);
    walk(player, { move: { forward: 1, strafe: 0 } }, 2);
    expect(player.position.x).toBeGreaterThan(4.5);
  });

  it('direct steering overrides a stale tap', () => {
    const player = createPlayer(vec3(4, 0, 0), 0);
    stepPlayer(player, WORLD, { target: vec3(-4, 0, 0) }, SIM_DT);
    expect(player.moveTarget).not.toBeNull();
    stepPlayer(player, WORLD, { move: { forward: 1, strafe: 0 } }, SIM_DT);
    expect(player.moveTarget).toBeNull();
  });

  it('records distance walked', () => {
    const player = createPlayer(vec3(5, 0, -5));
    walk(player, { target: vec3(-5, 0, -5) }, 12);
    expect(player.distanceWalked).toBeGreaterThan(6);
  });

  it('walking into the fire is slowed but not blocked outright', () => {
    // The soft obstacle is deliberate: heat and hesitation, not a wall.
    const around = createPlayer(vec3(6, 0, -6));
    walk(around, { target: vec3(-6, 0, -6) }, 8);
    const through = createPlayer(vec3(6, 0, 0));
    walk(through, { target: vec3(-6, 0, 0) }, 8);
    expect(through.distanceWalked).toBeLessThan(around.distanceWalked);
    expect(through.distanceWalked).toBeGreaterThan(1);
  });

  it('follows the ground', () => {
    const player = createPlayer(vec3(0, 0, 0));
    walk(player, { target: vec3(11, 0, 3) }, 14);
    expect(player.position.y).toBeCloseTo(
      terrainHeight(player.position.x, player.position.z, WORLD.seed, WORLD.amplitude),
      6,
    );
  });

  it('is deterministic', () => {
    const a = walk(createPlayer(vec3(4, 0, 2)), { target: vec3(-3, 0, -1) }, 6);
    const b = walk(createPlayer(vec3(4, 0, 2)), { target: vec3(-3, 0, -1) }, 6);
    expect(a.position).toEqual(b.position);
    expect(a.facing).toBe(b.facing);
  });
});

describe('looking', () => {
  it('applies yaw and pitch', () => {
    const player = createPlayer(vec3(2, 0, 0), 0);
    stepPlayer(player, WORLD, { look: { yaw: 0.5, pitch: 0.2 } }, SIM_DT);
    expect(player.facing).toBeCloseTo(0.5, 5);
    expect(player.pitch).toBeCloseTo(0.2, 5);
  });

  it('clamps pitch so the view never flips over', () => {
    const player = createPlayer(vec3(2, 0, 0));
    for (let i = 0; i < 100; i++) stepPlayer(player, WORLD, { look: { yaw: 0, pitch: 0.3 } }, SIM_DT);
    expect(player.pitch).toBeLessThanOrEqual(LOCOMOTION.maxPitch);
    for (let i = 0; i < 200; i++) stepPlayer(player, WORLD, { look: { yaw: 0, pitch: -0.3 } }, SIM_DT);
    expect(player.pitch).toBeGreaterThanOrEqual(LOCOMOTION.minPitch);
  });

  it('wraps yaw rather than growing without bound', () => {
    const player = createPlayer(vec3(2, 0, 0));
    for (let i = 0; i < 400; i++) stepPlayer(player, WORLD, { look: { yaw: 0.2, pitch: 0 } }, SIM_DT);
    expect(player.facing).toBeGreaterThanOrEqual(0);
    expect(player.facing).toBeLessThan(Math.PI * 2);
  });

  /*
   * A delta describes a movement that already happened. Holding one across
   * every fixed step of a frame turns the player once per step, so one drag of
   * a thumb turns you as far as the renderer is slow — at 60 fps that is one
   * step and invisible, and under a software renderer it is dozens. The caller
   * was clearing it *after* `advance` returned, which is after all of them.
   */
  it('spends a look delta on the step that applies it', () => {
    const player = createPlayer(vec3(2, 0, 0), 0);
    const intent: MoveIntent = { look: { yaw: 0.5, pitch: 0.1 } };
    for (let i = 0; i < 12; i += 1) stepPlayer(player, WORLD, intent, SIM_DT);
    expect(player.facing).toBeCloseTo(0.5, 5);
    expect(player.pitch).toBeCloseTo(0.1, 5);
    expect(intent.look).toEqual({ yaw: 0, pitch: 0 });
  });

  /*
   * A held key is the opposite: a rate, applied every step, so that turning
   * takes the same time on a fast machine and a slow one.
   */
  it('turns at a rate for as long as a look key is held', () => {
    const player = createPlayer(vec3(2, 0, 0), 0);
    const intent: MoveIntent = { lookRate: { yaw: 1.8, pitch: 0 } };
    // One second of held key, at the fixed timestep.
    for (let i = 0; i < 60; i += 1) stepPlayer(player, WORLD, intent, SIM_DT);
    expect(player.facing).toBeCloseTo(1.8, 2);

    // Twice as many half-length steps is the same turn, which is the whole
    // point of a rate.
    const other = createPlayer(vec3(2, 0, 0), 0);
    for (let i = 0; i < 120; i += 1) stepPlayer(other, WORLD, { lookRate: { yaw: 1.8, pitch: 0 } }, SIM_DT / 2);
    expect(other.facing).toBeCloseTo(player.facing, 5);
  });

  it('stops turning when the rate goes to zero', () => {
    const player = createPlayer(vec3(2, 0, 0), 0);
    for (let i = 0; i < 30; i += 1) stepPlayer(player, WORLD, { lookRate: { yaw: 1.8, pitch: 0 } }, SIM_DT);
    const held = player.facing;
    for (let i = 0; i < 60; i += 1) stepPlayer(player, WORLD, { lookRate: { yaw: 0, pitch: 0 } }, SIM_DT);
    expect(player.facing).toBe(held);
  });

  it('produces a unit look direction', () => {
    const player = createPlayer(vec3(2, 0, 0), 1.1);
    player.pitch = -0.4;
    const d = lookDirection(player);
    expect(Math.hypot(d.x, d.y, d.z)).toBeCloseTo(1, 6);
  });
});

describe('collision', () => {
  it('cannot walk through the machine', () => {
    const player = createPlayer(vec3(-1, 0, 1.75));
    walk(player, { target: vec3(-4.5, 0, 1.75) }, 10);
    const distance = Math.hypot(player.position.x + 2.75, player.position.z - 1.75);
    expect(distance).toBeGreaterThanOrEqual(0.6 + LOCOMOTION.bodyRadius - 0.02);
  });

  it('slides around an obstacle rather than sticking to it', () => {
    const player = createPlayer(vec3(-2.75, 0, 4));
    walk(player, { target: vec3(-2.75, 0, -1) }, 12);
    // Blocked head-on, it should still have made progress past the machine.
    expect(player.position.z).toBeLessThan(3.5);
  });

  it('the fire pushes back softly instead of stopping dead', () => {
    const player = createPlayer(vec3(2.2, 0, 0));
    walk(player, { target: vec3(0, 0, 0) }, 8);
    const distance = distanceFromFire(player);
    expect(distance).toBeGreaterThan(0.5);
    expect(distance).toBeLessThan(1.4);
  });

  it('stays inside the campsite', () => {
    const player = createPlayer(vec3(0, 0, 0));
    walk(player, { target: vec3(400, 0, 400) }, 40);
    expect(Math.hypot(player.position.x, player.position.z)).toBeLessThanOrEqual(WORLD.radius);
  });

  it('never ends up inside a hard obstacle from any approach', () => {
    for (let i = 0; i < 16; i++) {
      const angle = (i / 16) * Math.PI * 2;
      const player = createPlayer(vec3(-2.75 + Math.cos(angle) * 3, 0, 1.75 + Math.sin(angle) * 3));
      walk(player, { target: vec3(-2.75, 0, 1.75) }, 10);
      const distance = Math.hypot(player.position.x + 2.75, player.position.z - 1.75);
      expect(distance, `approach angle ${i}`).toBeGreaterThan(0.6);
    }
  });
});

describe('stillness and disturbance', () => {
  it('walking disturbs', () => {
    const player = createPlayer(vec3(6, 0, 0));
    walk(player, { target: vec3(-6, 0, 0) }, 3);
    expect(player.disturbance).toBeGreaterThan(0.4);
    expect(player.stillnessSeconds).toBe(0);
  });

  it('standing still banks stillness — the mechanic wildlife reads', () => {
    const player = createPlayer(vec3(4, 0, 0));
    walk(player, { target: vec3(2, 0, 0) }, 4);
    walk(player, {}, 30);
    expect(player.disturbance).toBeLessThan(0.08);
    expect(player.stillnessSeconds).toBeGreaterThan(20);
  });

  it('noise breaks stillness even without moving', () => {
    const player = createPlayer(vec3(4, 0, 0));
    walk(player, {}, 20);
    expect(player.stillnessSeconds).toBeGreaterThan(10);
    walk(player, { noise: 1 }, 1);
    expect(player.stillnessSeconds).toBe(0);
  });

  it('disturbance rises fast and falls slow', () => {
    const player = createPlayer(vec3(4, 0, 0));
    walk(player, { noise: 1 }, 0.5);
    const peak = player.disturbance;
    expect(peak).toBeGreaterThan(0.7);
    walk(player, {}, 0.5);
    expect(player.disturbance).toBeGreaterThan(peak * 0.5);
  });
});

describe('reach', () => {
  it('offers what is within arm’s reach, nearest first', () => {
    const player = createPlayer(vec3(1.9, 0, -0.7), 0);
    const results = reachable(player, WORLD);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.interactable.id).toBe('woodpile');
  });

  it('offers nothing when standing in the open', () => {
    const player = createPlayer(vec3(9, 0, 9));
    expect(reachable(player, WORLD)).toHaveLength(0);
    expect(focused(player, WORLD)).toBeNull();
  });

  it('prefers what the player is looking at over what is merely nearest', () => {
    // Between the stump and the fire, looking at the fire.
    const player = createPlayer(vec3(0.95, 0, 0.85), Math.atan2(-0.85, -0.95));
    expect(focused(player, WORLD)?.id).toBe('fire');
  });

  it('respects a facing arc', () => {
    const world = createWorld({
      seed: 1,
      interactables: [{ id: 'panel', x: 2, z: 0, reach: 2, arc: 0.5 }],
    });
    const facing = createPlayer(vec3(0, 0, 0), 0);
    expect(reachable(facing, world)).toHaveLength(1);
    const turnedAway = createPlayer(vec3(0, 0, 0), Math.PI);
    expect(reachable(turnedAway, world)).toHaveLength(0);
  });

  it('an approach point stands beside a thing, not on top of it', () => {
    const player = createPlayer(vec3(5, 0, 0));
    const point = approachPoint({ id: 'machine', x: -2.75, z: 1.75, reach: 1.4 }, player);
    const distance = Math.hypot(point.x + 2.75, point.z - 1.75);
    expect(distance).toBeCloseTo(0.85, 5);
  });
});

describe('camera support', () => {
  it('puts the eye at head height above the ground', () => {
    const player = createPlayer(vec3(8, 0, 4));
    player.position.y = terrainHeight(8, 4, WORLD.seed, WORLD.amplitude);
    const eye = eyePosition(player);
    expect(eye.y - player.position.y).toBeCloseTo(LOCOMOTION.eyeHeight, 2);
  });

  it('lowers the eye when seated', () => {
    const player = createPlayer(vec3(2, 0, 0));
    const standing = eyePosition(player).y;
    player.seated = true;
    expect(eyePosition(player).y).toBeLessThan(standing);
  });

  it('bobs only while walking', () => {
    const still = createPlayer(vec3(4, 0, 0));
    walk(still, {}, 2);
    const before = still.bobPhase;
    walk(still, {}, 2);
    expect(still.bobPhase).toBe(before);
  });

  it('reports bearing and distance from the fire', () => {
    const player = createPlayer(vec3(0, 0, 2));
    expect(bearingFromFire(player)).toBeCloseTo(Math.PI / 2, 5);
    expect(distanceFromFire(player)).toBeCloseTo(2, 5);
  });
});
