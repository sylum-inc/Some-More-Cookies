import { describe, expect, it } from 'vitest';
import { createEstablishedFire, createFire, stepFire, type FireState } from '../src/fire.js';
import {
  blowOut,
  createMarshmallow,
  patchColor,
  ROAST_TUNING,
  stepRoast,
  summariseRoast,
  type MarshmallowState,
} from '../src/roasting.js';
import { Rng } from '../src/rng.js';
import { SIM_DT, vec3 } from '../src/types.js';

/** A hot fire with flames. */
function flamingFire(): FireState {
  const fire = createEstablishedFire();
  const rng = new Rng(1);
  for (let i = 0; i < 60 * 5; i++) stepFire(fire, SIM_DT, rng);
  return fire;
}

/** A burned-down bed of coals — the better roasting surface. */
function emberFire(): FireState {
  const fire = createFire();
  fire.logs = [];
  fire.emberMass = 0.75;
  fire.emberTemp = 700;
  fire.oxygen = 0.7;
  const rng = new Rng(2);
  for (let i = 0; i < 60 * 3; i++) stepFire(fire, SIM_DT, rng);
  return fire;
}

interface RoastOptions {
  seconds: number;
  /** Horizontal distance from the fire centre. */
  radius?: number;
  height?: number;
  /** Rotation speed, rad/s. 0 = never turned. */
  spin?: number;
  seed?: number;
  marshmallow?: MarshmallowState;
}

function roast(fire: FireState, options: RoastOptions): MarshmallowState {
  const m = options.marshmallow ?? createMarshmallow();
  const rng = new Rng(options.seed ?? 7);
  const fireRng = new Rng(99);
  const radius = options.radius ?? 0.3;
  const height = options.height ?? 0.12;
  const steps = Math.round(options.seconds / SIM_DT);
  let rotation = 0;
  const position = vec3(radius, height, 0);
  for (let i = 0; i < steps; i++) {
    stepFire(fire, SIM_DT, fireRng);
    rotation += (options.spin ?? 0) * SIM_DT;
    stepRoast(m, fire, { position, rotation, blow: 0 }, SIM_DT, rng);
  }
  return m;
}

describe('marshmallow construction', () => {
  it('builds the configured patch grid', () => {
    const m = createMarshmallow();
    expect(m.patches).toHaveLength(ROAST_TUNING.longitudeCount * ROAST_TUNING.latitudeCount);
  });

  it('supports a reduced grid for low-end devices', () => {
    const m = createMarshmallow({ longitudeCount: 6, latitudeCount: 3 });
    expect(m.patches).toHaveLength(18);
  });

  it('starts cold, pale and moist', () => {
    const m = createMarshmallow();
    for (const p of m.patches) {
      expect(p.brown).toBe(0);
      expect(p.char).toBe(0);
      expect(p.moisture).toBeGreaterThan(0);
      expect(p.temperatureC).toBeLessThan(30);
    }
  });

  it('has unit-length normals', () => {
    for (const p of createMarshmallow().patches) {
      const len = Math.hypot(p.normal.x, p.normal.y, p.normal.z);
      expect(len).toBeCloseTo(1, 5);
    }
  });
});

describe('roasting behaviour', () => {
  it('is deterministic', () => {
    const a = summariseRoast(roast(emberFire(), { seconds: 60, spin: 1, seed: 3 }));
    const b = summariseRoast(roast(emberFire(), { seconds: 60, spin: 1, seed: 3 }));
    expect(a.brown).toBe(b.brown);
    expect(a.char).toBe(b.char);
    expect(a.evenness).toBe(b.evenness);
  });

  it('browns a marshmallow held over coals', () => {
    const m = roast(emberFire(), { seconds: 90, radius: 0.16, height: 0.12, spin: 0.9 });
    const s = summariseRoast(m);
    expect(s.brown).toBeGreaterThan(0.3);
  });

  it('leaves a marshmallow held far away almost untouched', () => {
    const s = summariseRoast(roast(emberFire(), { seconds: 90, radius: 1.6, height: 0.6, spin: 1 }));
    expect(s.brown).toBeLessThan(0.05);
    expect(s.descriptors).toContain('pale');
  });

  it('takes real time — no instant browning', () => {
    // Roasting must never collapse into a moment; the ritual is 5-8 minutes
    // and roasting is a meaningful part of it.
    const short = summariseRoast(roast(emberFire(), { seconds: 8, radius: 0.16, spin: 1 }));
    expect(short.brown).toBeLessThan(0.2);
  });

  describe('moisture stall', () => {
    it('holds the surface near boiling until it dries', () => {
      const m = roast(emberFire(), { seconds: 12, radius: 0.14, spin: 0 });
      // The fire is at the origin and the marshmallow at +x, so the patches
      // facing the heat are the ones whose normals point back toward it.
      const facing = m.patches.filter((p) => p.normal.x < -0.7);
      // Patches facing the coals should be hot but still short of browning,
      // because the water has to leave first.
      const anyStalled = facing.some((p) => p.temperatureC > 70 && p.temperatureC < 160 && p.brown < 0.2);
      expect(anyStalled).toBe(true);
    });

    it('dries the surface before browning accelerates', () => {
      const m = roast(emberFire(), { seconds: 75, radius: 0.15, spin: 1 });
      const browned = m.patches.filter((p) => p.brown > 0.3);
      expect(browned.length).toBeGreaterThan(0);
      for (const p of browned) expect(p.moisture).toBeLessThan(0.15);
    });
  });

  describe('rotation', () => {
    it('an unturned marshmallow browns one-sidedly', () => {
      const m = roast(emberFire(), { seconds: 80, radius: 0.15, spin: 0 });
      const s = summariseRoast(m);
      expect(s.sidedness).toBeGreaterThan(0.2);
      expect(s.evenness).toBeLessThan(0.85);
    });

    it('a steadily turned marshmallow browns evenly', () => {
      const turned = summariseRoast(roast(emberFire(), { seconds: 80, radius: 0.15, spin: 1.2 }));
      const still = summariseRoast(roast(emberFire(), { seconds: 80, radius: 0.15, spin: 0 }));
      expect(turned.evenness).toBeGreaterThan(still.evenness);
      expect(turned.sidedness).toBeLessThan(still.sidedness);
    });

    it('records how much the player actually turned it', () => {
      const m = roast(emberFire(), { seconds: 30, spin: 2 });
      expect(m.rotationTravel).toBeGreaterThan(50);
    });

    it('sugar conducts poorly, so the cold side stays behind', () => {
      // This is the property that makes rotation matter at all.
      const m = roast(emberFire(), { seconds: 60, radius: 0.15, spin: 0 });
      const facing = m.patches.filter((p) => p.normal.x < -0.8);
      const away = m.patches.filter((p) => p.normal.x > 0.8);
      const facingBrown = facing.reduce((t, p) => t + p.brown, 0) / Math.max(1, facing.length);
      const awayBrown = away.reduce((t, p) => t + p.brown, 0) / Math.max(1, away.length);
      expect(facingBrown).toBeGreaterThan(awayBrown + 0.15);
    });
  });

  describe('embers versus flames', () => {
    it('flames char faster than coals for the same browning', () => {
      // The design claim (spec deviation D4): embers are the better surface.
      const overFlames = summariseRoast(
        roast(flamingFire(), { seconds: 55, radius: 0.05, height: 0.35, spin: 1 }),
      );
      const overCoals = summariseRoast(
        roast(emberFire(), { seconds: 55, radius: 0.14, height: 0.1, spin: 1 }),
      );
      // Over flames, char relative to browning should be worse.
      const flameRatio = overFlames.char / Math.max(0.01, overFlames.brown);
      const emberRatio = overCoals.char / Math.max(0.01, overCoals.brown);
      expect(emberRatio).toBeLessThan(flameRatio);
    });

    it('coals give a much wider window between golden and charred', () => {
      // This is what "embers are the better roasting surface" actually means:
      // not that the result is more even (sitting inside the flame column
      // heats every side at once, so that is *more* even), but that there is
      // real time to work in between golden and ruined.
      const window = (fire: FireState, radius: number, height: number) => {
        const m = createMarshmallow();
        const rng = new Rng(7);
        const fireRng = new Rng(99);
        const position = vec3(radius, height, 0);
        let rotation = 0;
        let golden = -1;
        let charred = -1;
        for (let i = 0; i < 60 * 240; i++) {
          stepFire(fire, SIM_DT, fireRng);
          rotation += 1 * SIM_DT;
          stepRoast(m, fire, { position, rotation, blow: 0 }, SIM_DT, rng);
          const s = summariseRoast(m);
          if (golden < 0 && s.brown >= 0.5) golden = m.elapsed;
          if (charred < 0 && s.char >= 0.3) charred = m.elapsed;
          if (golden >= 0 && charred >= 0) break;
        }
        // Not reaching a threshold within the window means "effectively
        // never" — over well-turned coals, charring genuinely does not happen.
        return {
          golden: golden < 0 ? Infinity : golden,
          charred: charred < 0 ? Infinity : charred,
        };
      };

      const coals = window(emberFire(), 0.15, 0.1);
      const flames = window(flamingFire(), 0.02, 0.22);

      // Both routes can reach golden.
      expect(coals.golden).toBeLessThan(180);
      expect(flames.golden).toBeLessThan(180);
      // Over flames, charring follows golden closely — blink and it is an Ember.
      expect(flames.charred).toBeLessThan(180);
      expect(flames.charred - flames.golden).toBeLessThan(45);
      // Over steadily turned coals it does not char at all within the window.
      const coalsWindow = coals.charred - coals.golden;
      const flamesWindow = flames.charred - flames.golden;
      expect(coalsWindow).toBeGreaterThan(flamesWindow);
    });
  });

  describe('ignition', () => {
    it('catches fire when held in the flames too long', () => {
      const m = roast(flamingFire(), { seconds: 150, radius: 0.02, height: 0.22, spin: 0.5 });
      expect(m.ignitionCount).toBeGreaterThan(0);
    });

    it('can be blown out, leaving a charred shell', () => {
      const fire = flamingFire();
      const m = createMarshmallow();
      const rng = new Rng(7);
      const fireRng = new Rng(99);
      const position = vec3(0.02, 0.22, 0);
      let rotation = 0;
      // Hold it in the flames until it actually catches.
      for (let i = 0; i < 60 * 200 && !m.burning; i++) {
        stepFire(fire, SIM_DT, fireRng);
        rotation += 0.5 * SIM_DT;
        stepRoast(m, fire, { position, rotation, blow: 0 }, SIM_DT, rng);
      }
      expect(m.burning).toBe(true);
      expect(blowOut(m)).toBe(true);
      expect(m.burning).toBe(false);
      expect(m.patches.every((p) => p.aflame === 0)).toBe(true);
      const s = summariseRoast(m);
      expect(s.char).toBeGreaterThan(0.1);
    });

    it('blowing out an unlit marshmallow is a harmless no-op', () => {
      expect(blowOut(createMarshmallow())).toBe(false);
    });

    it('produces an ember descriptor rather than a failure', () => {
      // Spec §4.2: there is no hard failure; a burned marshmallow is a story.
      const m = roast(flamingFire(), { seconds: 160, radius: 0.02, height: 0.22, spin: 0.4 });
      const s = summariseRoast(m);
      expect(s.descriptors).toContain('ember');
      expect(s.label.length).toBeGreaterThan(0);
    });
  });

  describe('melting', () => {
    it('accumulates melt with heat soak', () => {
      const cold = roast(emberFire(), { seconds: 40, radius: 1.5, height: 0.8 });
      const hot = roast(emberFire(), { seconds: 40, radius: 0.13, height: 0.08, spin: 1 });
      expect(hot.melt).toBeGreaterThan(cold.melt);
    });

    it('falls off the stick when it melts through', () => {
      const m = roast(flamingFire(), { seconds: 400, radius: 0.02, height: 0.2, spin: 1 });
      expect(m.fallen).toBe(true);
      expect(summariseRoast(m).label).toBe('Lost to the fire');
    });

    it('stops tracking position once fallen', () => {
      const m = createMarshmallow();
      m.fallen = true;
      const before = { ...m.position };
      stepRoast(m, emberFire(), { position: vec3(9, 9, 9), rotation: 5 }, SIM_DT, new Rng(1));
      expect(m.position).toEqual(before);
    });
  });

  describe('summary', () => {
    it('describes an evenly golden roast', () => {
      const s = summariseRoast(roast(emberFire(), { seconds: 95, radius: 0.155, height: 0.1, spin: 1.1 }));
      expect(s.brown).toBeGreaterThan(0.3);
      expect(s.label.length).toBeGreaterThan(0);
      expect(s.descriptors.length).toBeGreaterThan(0);
    });

    it('keeps every value in a sane range', () => {
      const s = summariseRoast(roast(emberFire(), { seconds: 60, spin: 1 }));
      for (const key of ['brown', 'char', 'blister', 'evenness', 'sidedness'] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(1);
      }
      expect(Number.isFinite(s.peakTempC)).toBe(true);
    });

    it('handles a marshmallow that was never near the fire', () => {
      const s = summariseRoast(createMarshmallow());
      expect(s.brown).toBe(0);
      expect(s.peakTempC).toBeGreaterThan(0);
      expect(s.descriptors).toContain('pale');
    });
  });

  describe('patch colour', () => {
    it('runs cream → gold → dark as browning increases', () => {
      const m = createMarshmallow();
      const p = m.patches[0]!;
      const out: [number, number, number] = [0, 0, 0];
      p.brown = 0;
      const pale = [...patchColor(p, out)] as [number, number, number];
      p.brown = 0.5;
      const gold = [...patchColor(p, out)] as [number, number, number];
      p.brown = 1;
      const dark = [...patchColor(p, out)] as [number, number, number];
      expect(pale[0]).toBeGreaterThan(gold[0]);
      expect(gold[0]).toBeGreaterThan(dark[0]);
    });

    it('darkens toward black with char', () => {
      const p = createMarshmallow().patches[0]!;
      const out: [number, number, number] = [0, 0, 0];
      p.brown = 0.6;
      p.char = 1;
      const [r, g, b] = patchColor(p, out);
      expect(r).toBeLessThan(0.25);
      expect(g).toBeLessThan(0.25);
      expect(b).toBeLessThan(0.25);
    });

    it('glows while aflame', () => {
      const p = createMarshmallow().patches[0]!;
      const out: [number, number, number] = [0, 0, 0];
      p.char = 1;
      const dark = [...patchColor(p, out)] as [number, number, number];
      p.aflame = 1;
      const lit = patchColor(p, out);
      expect(lit[0]).toBeGreaterThan(dark[0]);
    });

    it('stays within [0,1]', () => {
      const p = createMarshmallow().patches[0]!;
      const out: [number, number, number] = [0, 0, 0];
      p.brown = 1;
      p.char = 0.4;
      p.aflame = 1;
      for (const c of patchColor(p, out)) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    });
  });

  it('never produces NaN over a long session', () => {
    const m = roast(flamingFire(), { seconds: 300, radius: 0.08, height: 0.2, spin: 0.7 });
    for (const p of m.patches) {
      expect(Number.isFinite(p.temperatureC)).toBe(true);
      expect(Number.isFinite(p.brown)).toBe(true);
      expect(Number.isFinite(p.char)).toBe(true);
    }
    expect(Number.isFinite(m.melt)).toBe(true);
  });
});
