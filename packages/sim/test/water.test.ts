import { describe, expect, it } from 'vitest';
import {
  canFish,
  canSkipStones,
  createWater,
  describeWater,
  disturbWater,
  fetchFactor,
  ripplePresence,
  shoreFor,
  stepWater,
  waveHeight,
  waveSlope,
  type WaterFeatureSpec,
} from '../src/water.js';
import { SIM_DT } from '../src/types.js';

/**
 * These specs are the shape `EnvironmentManifest.scene.water` already has, and
 * they are copied from the catalogue rather than invented — Loonwater Narrows,
 * Meltwater Cirque, Cicada Bottoms and Ashfall Barrens really do differ on
 * `skippable` and `fishable`, which is the whole reason this module exists.
 */
const NARROWS: WaterFeatureSpec = {
  kind: 'lake',
  label: 'The narrows',
  widthM: 700,
  flow: 'lapping',
  clarity: 0.7,
  fishable: true,
  skippable: true,
  note: '',
};

const TARN: WaterFeatureSpec = {
  kind: 'tarn',
  label: 'The tarn',
  widthM: 90,
  flow: 'still',
  clarity: 0.97,
  fishable: false,
  skippable: true,
  note: '',
};

const BOTTOMS: WaterFeatureSpec = {
  kind: 'blackwater',
  label: 'The bottoms',
  widthM: 120,
  flow: 'still',
  clarity: 0.05,
  fishable: true,
  skippable: false,
  note: '',
};

const SEEP: WaterFeatureSpec = {
  kind: 'hot-spring',
  label: 'The seep and the box',
  widthM: 2.2,
  flow: 'seeping',
  clarity: 0.8,
  fishable: false,
  skippable: false,
  note: '',
};

const CALM = { precipitation: 0, windSpeed: 0, temperatureC: 12 };
const GALE = { precipitation: 0, windSpeed: 8, temperatureC: 12 };

function settle(spec: WaterFeatureSpec, weather = CALM, seconds = 120) {
  const water = createWater(spec, { campsiteSeed: 991, walkableRadiusM: 13 });
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepWater(water, SIM_DT, weather);
  return water;
}

describe('what content says about the water', () => {
  it('answers the skip and fish questions from the manifest, not from a guess', () => {
    // The tarn is too cold and too young for fish but perfect for stones; the
    // bottoms are the exact reverse. Nothing here second-guesses that.
    expect(canSkipStones(TARN)).toBe(true);
    expect(canFish(TARN)).toBe(false);
    expect(canSkipStones(BOTTOMS)).toBe(false);
    expect(canFish(BOTTOMS)).toBe(true);
  });

  it('treats a dry site as an ordinary, correct answer', () => {
    expect(canSkipStones(undefined)).toBe(false);
    expect(canFish(null)).toBe(false);
    expect(canSkipStones({ ...NARROWS, kind: 'none' })).toBe(false);
  });
});

describe('the surface', () => {
  it('needs fetch to build chop: a gale does far more to a lake than to a seep', () => {
    expect(fetchFactor(2.2)).toBeLessThan(0.02);
    expect(fetchFactor(700)).toBe(1);

    const lake = settle(NARROWS, GALE);
    const seep = settle(SEEP, GALE);
    expect(lake.chop).toBeGreaterThan(0.4);
    expect(seep.chop).toBeLessThan(0.1);
  });

  it('is a mirror on a still night and broken in a wind', () => {
    const still = settle(TARN, CALM);
    const blown = settle(NARROWS, GALE);
    expect(still.glass).toBeGreaterThan(0.95);
    expect(blown.glass).toBeLessThan(0.1);
    expect(describeWater(still)).toContain('dead flat');
    expect(describeWater(blown)).toContain('broken');

    // A 90 m tarn in the same gale is ruffled, not broken up: it has a
    // fourteenth of the lake's fetch, and the model says so.
    const smallWater = settle(TARN, GALE);
    expect(smallWater.chop).toBeGreaterThan(still.chop);
    expect(smallWater.chop).toBeLessThan(settle(NARROWS, GALE).chop * 0.5);
  });

  it('is flat where it is flat: no slope worth speaking of on glass', () => {
    const still = settle(TARN, CALM);
    const blown = settle(NARROWS, GALE);
    let stillWorst = 0;
    let blownWorst = 0;
    for (let i = 0; i < 200; i++) {
      const x = i * 0.13;
      stillWorst = Math.max(stillWorst, Math.abs(waveSlope(still, x, x * 0.7)));
      blownWorst = Math.max(blownWorst, Math.abs(waveSlope(blown, x, x * 0.7)));
    }
    expect(stillWorst).toBeLessThan(0.02);
    // Chop is a real perturbation on a bounce, not a cosmetic one.
    expect(blownWorst).toBeGreaterThan(0.15);
  });

  it('is analytic and rng-free: two independent surfaces agree exactly', () => {
    // This is what lets the skipping model be physics rather than a roll.
    const a = settle(NARROWS, GALE, 37);
    const b = settle(NARROWS, GALE, 37);
    expect(a.chop).toBe(b.chop);
    for (const [x, z] of [
      [0, 0],
      [3.2, -1.1],
      [17.5, 4.25],
    ] as const) {
      expect(waveHeight(a, x, z)).toBe(waveHeight(b, x, z));
      expect(waveSlope(a, x, z)).toBe(waveSlope(b, x, z));
    }
  });

  it('remembers a ring for a few seconds and then forgets it', () => {
    const water = settle(TARN, CALM, 1);
    disturbWater(water, 2, 3, 1);
    expect(water.ripples).toHaveLength(1);
    expect(ripplePresence(water.ripples[0]!)).toBeCloseTo(1, 5);
    for (let i = 0; i < Math.round(4 / SIM_DT); i++) stepWater(water, SIM_DT, CALM);
    expect(ripplePresence(water.ripples[0]!)).toBeLessThan(0.4);
    for (let i = 0; i < Math.round(4 / SIM_DT); i++) stepWater(water, SIM_DT, CALM);
    expect(water.ripples).toHaveLength(0);
  });

  it('holds a bounded number of rings however much is thrown at it', () => {
    const water = settle(TARN, CALM, 1);
    for (let i = 0; i < 200; i++) disturbWater(water, i, i, 1);
    expect(water.ripples.length).toBeLessThanOrEqual(12);
  });
});

describe('the shore', () => {
  it('is in the same place on every visit to the same campsite', () => {
    expect(shoreFor(4242, 13)).toEqual(shoreFor(4242, 13));
    expect(shoreFor(4242, 13).bearing).not.toBe(shoreFor(99, 13).bearing);
  });

  it('stays inside the walkable campsite', () => {
    for (const radius of [8, 13, 16]) {
      const shore = shoreFor(4242, radius);
      expect(shore.distanceM).toBeLessThan(radius);
      expect(shore.distanceM).toBeGreaterThan(3);
    }
  });
});
