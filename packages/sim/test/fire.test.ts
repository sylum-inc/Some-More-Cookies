import { describe, expect, it } from 'vitest';
import {
  addLog,
  createEstablishedFire,
  createFire,
  createLog,
  fanFire,
  fireLightIntensity,
  fireSignals,
  isEmberBed,
  rakeEmbers,
  repositionLog,
  stepFire,
  WOOD_TYPES,
  woodType,
  type FireState,
} from '../src/fire.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

function run(fire: FireState, seconds: number, rng = new Rng(1)): FireState {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i++) stepFire(fire, SIM_DT, rng);
  return fire;
}

describe('wood types', () => {
  it('falls back to pine for an unknown id', () => {
    expect(woodType('unobtainium').id).toBe('pine');
  });

  it('has coherent physical relationships', () => {
    // Denser hardwoods should burn slower and leave more coals than softwoods.
    const oak = WOOD_TYPES['oak']!;
    const pine = WOOD_TYPES['pine']!;
    expect(oak.burnRate).toBeLessThan(pine.burnRate);
    expect(oak.emberYield).toBeGreaterThan(pine.emberYield);
    expect(oak.heatOutput).toBeGreaterThan(pine.heatOutput);
    // Softwood catches more easily.
    expect(pine.ignitability).toBeGreaterThan(oak.ignitability);
  });

  it('gives every wood type sane bounds', () => {
    for (const wood of Object.values(WOOD_TYPES)) {
      expect(wood.burnRate).toBeGreaterThan(0);
      expect(wood.emberYield).toBeGreaterThanOrEqual(0);
      expect(wood.emberYield).toBeLessThanOrEqual(1);
      expect(wood.defaultMoisture).toBeGreaterThanOrEqual(0);
      expect(wood.defaultMoisture).toBeLessThan(1);
    }
  });
});

describe('fire simulation', () => {
  it('is deterministic', () => {
    const a = run(createEstablishedFire(), 30, new Rng(5));
    const b = run(createEstablishedFire(), 30, new Rng(5));
    expect(a.flame).toBe(b.flame);
    expect(a.emberMass).toBe(b.emberMass);
    expect(a.emberTemp).toBe(b.emberTemp);
  });

  it('an established fire is already burning', () => {
    const fire = createEstablishedFire();
    expect(fire.flame).toBeGreaterThan(0.3);
    expect(fire.emberMass).toBeGreaterThan(0.2);
  });

  it('an empty pit produces no flame', () => {
    const fire = run(createFire(), 20);
    expect(fire.flame).toBeLessThan(0.05);
    expect(fire.emberMass).toBe(0);
  });

  it('consumes fuel over time', () => {
    const fire = createEstablishedFire();
    const before = fire.logs.reduce((t, l) => t + l.mass, 0);
    run(fire, 60);
    const after = fire.logs.reduce((t, l) => t + l.mass, 0);
    expect(after).toBeLessThan(before);
  });

  it('converts burned fuel into an ember bed', () => {
    const fire = createFire();
    addLog(fire, 'oak');
    fire.emberMass = 0.3;
    fire.emberTemp = 600;
    const before = fire.emberMass;
    run(fire, 120);
    expect(fire.emberMass).toBeGreaterThan(before * 0.5);
  });

  it('removes fully spent logs', () => {
    const fire = createFire();
    const log = createLog('aspen', { mass: 0.02, moisture: 0, ignition: 1 });
    fire.logs.push(log);
    fire.emberMass = 0.5;
    fire.emberTemp = 700;
    run(fire, 90);
    expect(fire.logs.find((l) => l.id === log.id)).toBeUndefined();
  });

  describe('moisture', () => {
    it('wet wood resists burning and smokes', () => {
      const dry = createFire();
      dry.emberMass = 0.5;
      dry.emberTemp = 650;
      addLog(dry, 'birch').moisture = 0.02;

      const wet = createFire();
      wet.emberMass = 0.5;
      wet.emberTemp = 650;
      addLog(wet, 'birch').moisture = 0.95;

      run(dry, 45);
      run(wet, 45);

      expect(wet.logs[0]!.ignition).toBeLessThan(dry.logs[0]!.ignition);
      expect(wet.flame).toBeLessThan(dry.flame);
    });

    it('wet wood dries out and eventually catches', () => {
      const fire = createFire();
      fire.emberMass = 0.8;
      fire.emberTemp = 700;
      const log = addLog(fire, 'pine');
      log.moisture = 0.8;
      run(fire, 200);
      expect(log.moisture).toBeLessThan(0.8);
    });
  });

  describe('oxygen', () => {
    it('good placement raises oxygen over smothered placement', () => {
      const airy = createEstablishedFire();
      for (const l of airy.logs) l.placement = 1;
      const smothered = createEstablishedFire();
      for (const l of smothered.logs) l.placement = 0;
      run(airy, 20);
      run(smothered, 20);
      expect(airy.oxygen).toBeGreaterThan(smothered.oxygen);
    });

    it('piling on too much fuel chokes the fire', () => {
      const normal = createEstablishedFire();
      const crowded = createEstablishedFire();
      for (let i = 0; i < 6; i++) addLog(crowded, 'oak', 0.6);
      run(normal, 25);
      run(crowded, 25);
      expect(crowded.oxygen).toBeLessThan(normal.oxygen);
    });

    it('fanning gives a temporary oxygen boost that decays', () => {
      const fire = createEstablishedFire();
      run(fire, 10);
      const base = fire.oxygen;
      fanFire(fire, 1);
      run(fire, 0.5);
      expect(fire.oxygen).toBeGreaterThan(base);
      run(fire, 15);
      expect(fire.oxygen).toBeLessThan(base + 0.15);
    });

    it('raking improves log placement', () => {
      const fire = createEstablishedFire();
      for (const l of fire.logs) l.placement = 0.2;
      rakeEmbers(fire, 1);
      expect(fire.logs.every((l) => l.placement > 0.2)).toBe(true);
    });

    it('repositionLog clamps to a valid range', () => {
      const fire = createEstablishedFire();
      const id = fire.logs[0]!.id;
      repositionLog(fire, id, 5);
      expect(fire.logs[0]!.placement).toBe(1);
      repositionLog(fire, id, -3);
      expect(fire.logs[0]!.placement).toBe(0);
    });

    it('ignores an unknown log id', () => {
      const fire = createEstablishedFire();
      expect(() => repositionLog(fire, 'nope', 0.5)).not.toThrow();
    });
  });

  it('is forgiving — embers persist long after flames die', () => {
    // Spec §4.1: the fire must never go out irrecoverably during a session.
    const fire = createEstablishedFire();
    fire.logs = [];
    run(fire, 300);
    expect(fire.emberMass).toBeGreaterThan(0.05);
    expect(fire.emberTemp).toBeGreaterThan(200);
  });

  it('reports an ember bed once flames die down', () => {
    const fire = createEstablishedFire();
    fire.logs = [];
    run(fire, 120);
    expect(isEmberBed(fire)).toBe(true);
  });

  it('wind stays bounded and responds to exposure', () => {
    const sheltered = createFire({ exposure: 0.05 });
    const exposed = createFire({ exposure: 1 });
    run(sheltered, 120);
    run(exposed, 120);
    expect(sheltered.windSpeed).toBeLessThan(exposed.windSpeed);
    expect(exposed.windSpeed).toBeLessThan(6);
    expect(sheltered.windSpeed).toBeGreaterThanOrEqual(0);
  });

  it('emits crackles while burning', () => {
    const fire = createEstablishedFire();
    const rng = new Rng(3);
    let crackles = 0;
    for (let i = 0; i < 60 * 30; i++) {
      stepFire(fire, SIM_DT, rng);
      crackles += fire.cracklesThisStep;
    }
    expect(crackles).toBeGreaterThan(10);
  });

  it('signals stay normalised', () => {
    const fire = createEstablishedFire();
    for (let i = 0; i < 600; i++) {
      stepFire(fire, SIM_DT, new Rng(i));
      const s = fireSignals(fire);
      for (const key of ['intensity', 'emberHeat', 'fuelLoad', 'smoke', 'colorBias'] as const) {
        expect(s[key]).toBeGreaterThanOrEqual(0);
        expect(s[key]).toBeLessThanOrEqual(1);
      }
      expect(fireLightIntensity(fire)).toBeGreaterThanOrEqual(0);
      expect(fireLightIntensity(fire)).toBeLessThanOrEqual(1);
    }
  });

  it('never produces NaN', () => {
    const fire = createEstablishedFire();
    for (let i = 0; i < 60 * 120; i++) stepFire(fire, SIM_DT, new Rng(i % 100));
    expect(Number.isFinite(fire.flame)).toBe(true);
    expect(Number.isFinite(fire.emberTemp)).toBe(true);
    expect(Number.isFinite(fire.emberMass)).toBe(true);
    expect(Number.isFinite(fire.flameHeight)).toBe(true);
  });
});
