import { describe, expect, it } from 'vitest';
import {
  createAssembly,
  isComplete,
  moveHeld,
  nextComponent,
  pickUp,
  place,
  STACK_ORDER,
  stepAssembly,
  summariseAssembly,
  type AssemblyState,
} from '../src/assembly.js';
import { Rng } from '../src/rng.js';
import { SIM_DT, vec3 } from '../src/types.js';

function build(assembly: AssemblyState, offsets: number[], rng = new Rng(1)): AssemblyState {
  STACK_ORDER.forEach((kind, i) => {
    pickUp(assembly, kind);
    const o = offsets[i] ?? 0;
    moveHeld(assembly, vec3(o, 0.01, 0), 0);
    place(assembly, rng);
  });
  return assembly;
}

describe('assembly order', () => {
  it('follows the traditional stack', () => {
    expect(STACK_ORDER).toEqual(['graham-bottom', 'chocolate', 'marshmallow', 'graham-top']);
  });

  it('reports the next component in order', () => {
    const a = createAssembly();
    expect(nextComponent(a)).toBe('graham-bottom');
    pickUp(a);
    place(a, new Rng(1));
    expect(nextComponent(a)).toBe('chocolate');
  });

  it('refuses to pick up out of order', () => {
    const a = createAssembly();
    expect(pickUp(a, 'graham-top')).toBeNull();
    expect(pickUp(a, 'graham-bottom')).toBe('graham-bottom');
  });

  it('is complete only after all four layers', () => {
    const a = createAssembly();
    expect(isComplete(a)).toBe(false);
    build(a, [0, 0, 0, 0]);
    expect(isComplete(a)).toBe(true);
    expect(nextComponent(a)).toBeNull();
  });

  it('placing nothing returns null', () => {
    expect(place(createAssembly(), new Rng(1))).toBeNull();
  });

  it('moving with nothing held is a no-op', () => {
    const a = createAssembly();
    expect(() => moveHeld(a, vec3(1, 1, 1), 1)).not.toThrow();
    expect(a.heldOffset.x).toBe(0);
  });
});

describe('magnetic assist', () => {
  it('pulls a nearby component toward alignment', () => {
    const a = createAssembly({ assist: 1 });
    pickUp(a);
    moveHeld(a, vec3(0.02, 0.01, 0), 0);
    const before = Math.abs(a.heldOffset.x);
    for (let i = 0; i < 30; i++) stepAssembly(a, SIM_DT, new Rng(1));
    expect(Math.abs(a.heldOffset.x)).toBeLessThan(before);
  });

  it('does not reach outside its radius', () => {
    const a = createAssembly({ assist: 1 });
    pickUp(a);
    // Well beyond magnetRadius — the magnet must not grab from across the table.
    moveHeld(a, vec3(0.3, 0.01, 0), 0);
    for (let i = 0; i < 60; i++) stepAssembly(a, SIM_DT, new Rng(1));
    expect(a.heldOffset.x).toBeCloseTo(0.3, 5);
  });

  it('never snaps perfectly, even at maximum assist', () => {
    // Spec §4.3: every sandwich should feel slightly handmade. A perfectly
    // aligned stack would be a worse object.
    const a = createAssembly({ assist: 1 });
    pickUp(a);
    moveHeld(a, vec3(0.03, 0.01, 0), 0);
    for (let i = 0; i < 60 * 10; i++) stepAssembly(a, SIM_DT, new Rng(1));
    const residual = Math.hypot(a.heldOffset.x, a.heldOffset.z);
    expect(residual).toBeGreaterThan(0);
    expect(residual).toBeGreaterThanOrEqual(a.tuning.residualOffset * 0.99);
  });

  it('assists more when accessibility assist is higher', () => {
    const weak = createAssembly({ assist: 0.15 });
    const strong = createAssembly({ assist: 1 });
    for (const a of [weak, strong]) {
      pickUp(a);
      moveHeld(a, vec3(0.03, 0.01, 0), 0);
      for (let i = 0; i < 30; i++) stepAssembly(a, SIM_DT, new Rng(1));
    }
    expect(Math.abs(strong.heldOffset.x)).toBeLessThan(Math.abs(weak.heldOffset.x));
  });

  it('with no assist, placement is entirely the player', () => {
    const a = createAssembly({ assist: 0 });
    pickUp(a);
    moveHeld(a, vec3(0.02, 0.01, 0), 0);
    for (let i = 0; i < 60; i++) stepAssembly(a, SIM_DT, new Rng(1));
    expect(a.heldOffset.x).toBeCloseTo(0.02, 6);
  });

  it('eases rotation toward a comfortable quarter turn', () => {
    const a = createAssembly({ assist: 1 });
    pickUp(a);
    moveHeld(a, vec3(0.005, 0.01, 0), 0.35);
    for (let i = 0; i < 120; i++) stepAssembly(a, SIM_DT, new Rng(1));
    expect(Math.abs(a.heldRotation)).toBeLessThan(0.35);
  });
});

describe('materials respond', () => {
  it('chocolate softens against a hot marshmallow', () => {
    const hot = createAssembly({ marshmallowTempC: 200 });
    const cold = createAssembly({ marshmallowTempC: 20 });
    for (const a of [hot, cold]) {
      pickUp(a);
      place(a, new Rng(1));
      pickUp(a);
      place(a, new Rng(1));
      for (let i = 0; i < 60 * 5; i++) stepAssembly(a, SIM_DT, new Rng(1));
    }
    const hotChoc = hot.components.find((c) => c.kind === 'chocolate')!;
    const coldChoc = cold.components.find((c) => c.kind === 'chocolate')!;
    expect(hotChoc.softness).toBeGreaterThan(coldChoc.softness);
  });

  it('the top cracker squishes the marshmallow', () => {
    const a = createAssembly({ marshmallowTempC: 180 });
    build(a, [0, 0, 0, 0]);
    const marshmallow = a.components.find((c) => c.kind === 'marshmallow')!;
    expect(marshmallow.squish).toBeGreaterThan(0);
  });

  it('a hotter marshmallow squishes more', () => {
    const hot = createAssembly({ marshmallowTempC: 220 });
    const cool = createAssembly({ marshmallowTempC: 40 });
    build(hot, [0, 0, 0, 0]);
    build(cool, [0, 0, 0, 0]);
    const hotSquish = hot.components.find((c) => c.kind === 'marshmallow')!.squish;
    const coolSquish = cool.components.find((c) => c.kind === 'marshmallow')!.squish;
    expect(hotSquish).toBeGreaterThan(coolSquish);
  });

  it('graham crackers shed crumbs', () => {
    const a = createAssembly();
    build(a, [0, 0, 0, 0]);
    const grahams = a.components.filter((c) => c.kind.startsWith('graham'));
    expect(grahams.every((g) => g.crumbs > 0)).toBe(true);
  });

  it('dropping from height produces more crumbs and tilt', () => {
    const gentle = createAssembly();
    pickUp(gentle);
    moveHeld(gentle, vec3(0, 0.001, 0), 0);
    const gentleC = place(gentle, new Rng(4))!;

    const dropped = createAssembly();
    pickUp(dropped);
    moveHeld(dropped, vec3(0, 0.2, 0), 0);
    const droppedC = place(dropped, new Rng(4))!;

    expect(droppedC.crumbs).toBeGreaterThan(gentleC.crumbs);
    expect(Math.abs(droppedC.tilt)).toBeGreaterThan(Math.abs(gentleC.tilt));
  });
});

describe('summary', () => {
  it('records misalignment', () => {
    const neat = summariseAssembly(build(createAssembly({ assist: 0 }), [0, 0, 0, 0]));
    const messy = summariseAssembly(build(createAssembly({ assist: 0 }), [0.03, -0.025, 0.04, -0.03]));
    expect(messy.misalignment).toBeGreaterThan(neat.misalignment);
    expect(messy.tidiness).toBeLessThan(neat.tidiness);
  });

  it('labels a lopsided stack without scolding', () => {
    const messy = summariseAssembly(build(createAssembly({ assist: 0 }), [0.05, -0.05, 0.06, -0.05]));
    expect(messy.label).toBe('Gloriously lopsided');
  });

  it('handles an empty assembly', () => {
    const s = summariseAssembly(createAssembly());
    expect(s.label).toBe('Unassembled');
    expect(s.misalignment).toBe(0);
    expect(s.tidiness).toBe(1);
  });

  it('keeps every value in range', () => {
    const s = summariseAssembly(build(createAssembly({ assist: 0 }), [0.09, -0.08, 0.1, -0.07]));
    for (const key of ['squish', 'crumbs', 'smear', 'tidiness'] as const) {
      expect(s[key]).toBeGreaterThanOrEqual(0);
      expect(s[key]).toBeLessThanOrEqual(1);
    }
  });

  it('is deterministic for the same seed', () => {
    const a = summariseAssembly(build(createAssembly(), [0.01, 0.02, 0.01, 0.005], new Rng(9)));
    const b = summariseAssembly(build(createAssembly(), [0.01, 0.02, 0.01, 0.005], new Rng(9)));
    expect(a).toEqual(b);
  });

  it('produces different objects for different seeds — every sandwich is handmade', () => {
    const a = summariseAssembly(build(createAssembly(), [0.01, 0.02, 0.01, 0.005], new Rng(1)));
    const b = summariseAssembly(build(createAssembly(), [0.01, 0.02, 0.01, 0.005], new Rng(2)));
    expect(a.lean).not.toBe(b.lean);
  });
});
