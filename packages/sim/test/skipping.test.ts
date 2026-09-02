import { describe, expect, it } from 'vitest';
import {
  MAGIC_ATTACK_RAD,
  MIN_SKIP_SPEED,
  bestStone,
  bounceQuality,
  createSkipping,
  createThrow,
  describeSkip,
  drainSkipEvents,
  dropStone,
  gyroscopicStability,
  liftAvailable,
  submersionRisk,
  pickUpStone,
  shoreStones,
  skipEvidence,
  skipRunwayM,
  stepSkipping,
  summariseSkip,
  throwSpeed,
  throwStone,
  type SkippingState,
  type ThrowInput,
} from '../src/skipping.js';
import { createWater, stepWater, type WaterFeatureSpec, type WaterWeather } from '../src/water.js';
import { assertNoScoring } from '../src/activity.js';
import { decideTrace } from '../src/significance.js';
import { SIM_DT, vec3 } from '../src/types.js';

const LAKE: WaterFeatureSpec = {
  kind: 'lake',
  label: 'The narrows',
  widthM: 700,
  flow: 'lapping',
  clarity: 0.7,
  fishable: true,
  skippable: true,
  note: '',
};

const STILL_NIGHT: WaterWeather = { precipitation: 0, windSpeed: 0, temperatureC: 8 };
const BLOWING: WaterWeather = { precipitation: 0, windSpeed: 9, temperatureC: 8 };

const SEED = 4242;
/** Chest height at the water's edge. */
const HAND = vec3(0, 1.2, 0);

interface Outcome {
  skips: number;
  distanceM: number;
  phase: SkippingState['phase'];
  chop: number;
  bounces: number;
}

/**
 * Throws one stone and runs it to a standstill through the real fixed-timestep
 * loop. `settleSeconds` lets the surface reach the state the weather implies
 * before the stone leaves the hand, which is what a player would be looking at.
 */
function makeThrow(
  input: Partial<ThrowInput>,
  weather: WaterWeather,
  options: { settleSeconds?: number; spec?: WaterFeatureSpec; seed?: number } = {},
): Outcome {
  const seed = options.seed ?? SEED;
  const water = createWater(options.spec ?? LAKE, { campsiteSeed: seed, walkableRadiusM: 13 });
  const settle = Math.round((options.settleSeconds ?? 90) / SIM_DT);
  for (let i = 0; i < settle; i++) stepWater(water, SIM_DT, weather);

  const skipping = createSkipping(seed);
  const stone = bestStone(skipping.stones);
  pickUpStone(skipping, stone ? stone.id : undefined);
  throwStone(skipping, createThrow(input), HAND, water);

  let guard = 0;
  while (skipping.phase === 'flying' && guard++ < 5000) {
    stepWater(water, SIM_DT, weather);
    stepSkipping(skipping, SIM_DT, water);
  }
  return {
    skips: skipping.skips,
    distanceM: skipping.distanceM,
    phase: skipping.phase,
    chop: water.chop,
    bounces: skipping.bounces.length,
  };
}

/** The throw a person who knows how to skip a stone actually makes. */
const GOOD: Partial<ThrowInput> = { power: 0.9, elevation: 0.08, tilt: 0.32, spin: 0.85 };
/** A lob, cocked back like a frisbee, with no wrist in it. */
const BAD: Partial<ThrowInput> = { power: 0.9, elevation: 0.75, tilt: 0.95, spin: 0.05 };

describe('the bounce, as physics', () => {
  it('has a magic angle at 20 degrees', () => {
    const magic = bounceQuality(MAGIC_ATTACK_RAD);
    expect(magic).toBeCloseTo(1, 6);
    // Falls away on both sides, and is worthless at either extreme.
    expect(bounceQuality(0.05)).toBeLessThan(magic);
    expect(bounceQuality(0.8)).toBeLessThan(magic);
    expect(bounceQuality(0)).toBe(0);
    expect(bounceQuality(-0.2)).toBe(0);
    expect(bounceQuality(1.3)).toBe(0);
  });

  it('cannot lift a stone that is arriving too slowly', () => {
    expect(liftAvailable(MIN_SKIP_SPEED * 0.5, 1)).toBe(0);
    expect(liftAvailable(MIN_SKIP_SPEED * 3, 1)).toBeGreaterThan(0.9);
    // Monotone in speed: faster is never worse.
    let previous = -1;
    for (let v = 0; v < 14; v += 0.5) {
      const lift = liftAvailable(v, 0.9);
      expect(lift).toBeGreaterThanOrEqual(previous);
      previous = lift;
    }
  });

  it('gets far less out of a round stone: flatness is the face doing the work', () => {
    const lump = liftAvailable(12, 0.05);
    const coin = liftAvailable(12, 0.95);
    expect(coin).toBeGreaterThan(0.9);
    expect(lump).toBeLessThan(coin * 0.3);
    // But a lump is worse, not disallowed — thrown well it still skips.
    expect(lump).toBeGreaterThan(0);
  });

  it('treats a steep arrival onto a shallow face as a submersion', () => {
    // The face can be at a perfect twenty degrees and still be useless if the
    // stone is coming down almost vertically onto it.
    expect(submersionRisk(MAGIC_ATTACK_RAD, 0.05)).toBe(0);
    expect(submersionRisk(MAGIC_ATTACK_RAD, 1.2)).toBe(1);
    expect(submersionRisk(-0.1, 0.1)).toBe(1);
  });

  it('treats spin as stability rather than lift', () => {
    expect(gyroscopicStability(0)).toBe(0);
    expect(gyroscopicStability(90)).toBeGreaterThan(0.85);
    expect(gyroscopicStability(12)).toBeCloseTo(0.5, 6);
  });
});

describe('a throw', () => {
  it('skips more when thrown flat at a still lake than steeply into chop', () => {
    // The headline property, and the reason this model exists at all.
    const flatOnGlass = makeThrow(GOOD, STILL_NIGHT);
    const steepIntoChop = makeThrow(BAD, BLOWING);

    expect(flatOnGlass.chop).toBeLessThan(0.25);
    expect(steepIntoChop.chop).toBeGreaterThan(0.6);
    expect(flatOnGlass.skips).toBeGreaterThan(steepIntoChop.skips);
    expect(flatOnGlass.skips).toBeGreaterThanOrEqual(5);
    // The lob into chop makes one or two slaps and goes in.
    expect(steepIntoChop.skips).toBeLessThanOrEqual(2);
  });

  it('is hurt by chop with everything else held identical', () => {
    // Isolates the water: same stone, same arm, same everything.
    const onGlass = makeThrow(GOOD, STILL_NIGHT);
    const inChop = makeThrow(GOOD, BLOWING);
    expect(inChop.chop).toBeGreaterThan(onGlass.chop + 0.5);
    expect(inChop.skips).toBeLessThan(onGlass.skips);
  });

  it('is hurt by throwing it with no wrist on it', () => {
    const spun = makeThrow({ ...GOOD, spin: 0.9 }, STILL_NIGHT);
    const dead = makeThrow({ ...GOOD, spin: 0 }, STILL_NIGHT);
    expect(dead.skips).toBeLessThan(spun.skips);
  });

  it('goes straight in when the stone is cocked back like a spade', () => {
    const ploughed = makeThrow({ ...GOOD, tilt: 1 }, STILL_NIGHT);
    expect(ploughed.skips).toBe(0);
    expect(ploughed.phase).toBe('sunk');
  });

  it('goes straight in when the leading edge is down', () => {
    // The other way of getting it wrong, and the one nobody expects: a stone
    // held edge-first knifes under on the first touch.
    const knifed = makeThrow({ ...GOOD, tilt: 0 }, STILL_NIGHT);
    expect(knifed.skips).toBe(0);
    expect(knifed.phase).toBe('sunk');
  });

  it('has its best angle somewhere findable in the middle of the range', () => {
    // Neither end of the control works, which is what makes finding the middle
    // a real thing rather than "hold the slider at maximum".
    const counts = [0, 0.15, 0.32, 0.5, 0.75, 1].map(
      (tilt) => makeThrow({ ...GOOD, tilt }, STILL_NIGHT).skips,
    );
    const bestAt = counts.indexOf(Math.max(...counts));
    expect(bestAt).toBeGreaterThan(0);
    expect(bestAt).toBeLessThan(counts.length - 1);
    expect(counts[0]).toBe(0);
    expect(counts[counts.length - 1]).toBe(0);
  });

  it('cannot skip at all below the minimum speed', () => {
    // A gentle underarm lob has no lift available to it, whatever the angle.
    expect(throwSpeed(0)).toBeLessThan(MIN_SKIP_SPEED * 2);
    const lob = makeThrow({ ...GOOD, power: 0 }, STILL_NIGHT);
    expect(lob.skips).toBeLessThanOrEqual(1);
  });

  it('crowds its last bounces together as it runs out of speed', () => {
    const water = createWater(LAKE, { campsiteSeed: SEED });
    for (let i = 0; i < 60 / SIM_DT; i++) stepWater(water, SIM_DT, STILL_NIGHT);
    const skipping = createSkipping(SEED);
    pickUpStone(skipping, bestStone(skipping.stones)!.id);
    throwStone(skipping, createThrow(GOOD), HAND, water);
    let guard = 0;
    while (skipping.phase === 'flying' && guard++ < 5000) {
      stepWater(water, SIM_DT, STILL_NIGHT);
      stepSkipping(skipping, SIM_DT, water);
    }
    expect(skipping.bounces.length).toBeGreaterThan(4);
    const first = skipping.bounces[1]!.gapM;
    const last = skipping.bounces[skipping.bounces.length - 1]!.gapM;
    // The pitter-patter at the end is emergent, not scripted.
    expect(last).toBeLessThan(first);
  });

  it('ends somewhere, always', () => {
    // Every throw terminates: no throw can leave a stone flying forever, and
    // there is no state a player can reach that has no ending.
    for (const power of [0, 0.3, 0.6, 1]) {
      for (const tilt of [0, 0.3, 0.6, 1]) {
        for (const spin of [0, 1]) {
          const outcome = makeThrow({ power, tilt, spin, elevation: 0.2 }, STILL_NIGHT, {
            settleSeconds: 20,
          });
          expect(['sunk', 'shore']).toContain(outcome.phase);
        }
      }
    }
  });

  it('runs out of water on a narrow creek pool rather than skipping to Africa', () => {
    const pool: WaterFeatureSpec = { ...LAKE, kind: 'creek', widthM: 4, flow: 'still' };
    expect(skipRunwayM(pool)).toBe(18);
    const outcome = makeThrow(GOOD, STILL_NIGHT, { spec: pool });
    expect(outcome.distanceM).toBeLessThanOrEqual(skipRunwayM(pool) + 1);
  });
});

describe('determinism', () => {
  it('gives the identical outcome for the same seed and the same throw', () => {
    const a = makeThrow(GOOD, STILL_NIGHT);
    const b = makeThrow(GOOD, STILL_NIGHT);
    expect(a).toEqual(b);
  });

  it('gives the identical outcome in choppy water too', () => {
    const a = makeThrow(GOOD, BLOWING);
    const b = makeThrow(GOOD, BLOWING);
    expect(a).toEqual(b);
  });

  it('uses no random source at all: the same throw at two campsites differs only by the water', () => {
    // The stones on two shores differ, so the outcomes may; but running the
    // same campsite twice can never differ, which is the ADR-0001 guarantee.
    const first = makeThrow(GOOD, STILL_NIGHT, { seed: 17 });
    const again = makeThrow(GOOD, STILL_NIGHT, { seed: 17 });
    expect(first).toEqual(again);
  });

  it('puts the same stones on the same shore every visit', () => {
    expect(shoreStones(SEED)).toEqual(shoreStones(SEED));
    expect(shoreStones(SEED)).not.toEqual(shoreStones(SEED + 1));
  });
});

describe('nothing is gated, scored or earned', () => {
  it('exposes no score, unlock or obligation in any readout', () => {
    const skipping = createSkipping(SEED);
    const water = createWater(LAKE, { campsiteSeed: SEED });
    pickUpStone(skipping);
    throwStone(skipping, createThrow(GOOD), HAND, water);
    for (let i = 0; i < 400; i++) stepSkipping(skipping, SIM_DT, water);

    assertNoScoring('summariseSkip', summariseSkip(skipping));
    assertNoScoring('skip events', drainSkipEvents(skipping));
    assertNoScoring('shore stones', shoreStones(SEED));
  });

  it('describes a stone that sank as warmly as one that ran', () => {
    // "A skipping stone that sinks is fine." The line for it is a fact, not a
    // verdict, and there is no failure vocabulary anywhere in the model.
    const sank = createSkipping(SEED);
    expect(describeSkip(sank)).toBe('Straight in.');
    expect(describeSkip(sank).toLowerCase()).not.toMatch(/fail|miss|try again|better|worse|bad/);
  });

  it('never consumes a stone: the shore is still a shore afterwards', () => {
    const skipping = createSkipping(SEED);
    const before = skipping.stones.length;
    const water = createWater(LAKE, { campsiteSeed: SEED });
    for (let i = 0; i < 5; i++) {
      pickUpStone(skipping);
      throwStone(skipping, createThrow(GOOD), HAND, water);
      for (let step = 0; step < 400; step++) stepSkipping(skipping, SIM_DT, water);
    }
    expect(skipping.stones.length).toBe(before);
  });

  it('lets a stone be picked up and put back down freely', () => {
    const skipping = createSkipping(SEED);
    expect(pickUpStone(skipping)).not.toBeNull();
    expect(skipping.phase).toBe('held');
    dropStone(skipping);
    expect(skipping.phase).toBe('idle');
    expect(skipping.held).toBeNull();
  });
});

describe('the significance model', () => {
  it('keeps a long run across dead-flat water and lets an ordinary throw fade', () => {
    // "A good throw at a still lake at 2am is a thing worth remembering."
    const water = createWater(LAKE, { campsiteSeed: SEED });
    for (let i = 0; i < 90 / SIM_DT; i++) stepWater(water, SIM_DT, STILL_NIGHT);
    const skipping = createSkipping(SEED);
    pickUpStone(skipping, bestStone(skipping.stones)!.id);
    throwStone(skipping, createThrow(GOOD), HAND, water);
    let guard = 0;
    while (skipping.phase === 'flying' && guard++ < 5000) {
      stepWater(water, SIM_DT, STILL_NIGHT);
      stepSkipping(skipping, SIM_DT, water);
    }
    const good = summariseSkip(skipping);
    expect(good.skips).toBeGreaterThan(4);

    const kept = decideTrace(
      skipEvidence(good, { isFirst: true, interactionCount: 5, dwellSeconds: 200 }),
    );
    expect(kept.disposition).not.toBe('fade');

    // A two-skip throw on a windy afternoon leaves only a faint mark.
    const ordinary = decideTrace(
      skipEvidence(
        { skips: 2, distanceM: 6, flightSeconds: 1.1, glass: 0.4, reachedShore: false, telling: 'Two.' },
        { interactionCount: 1 },
      ),
    );
    expect(ordinary.disposition).toBe('fade');
  });

  it('never lets the evidence carry the score behind it', () => {
    const evidence = skipEvidence(summariseSkip(createSkipping(SEED)));
    expect(Object.keys(evidence)).not.toContain('score');
    expect(Object.keys(decideTrace(evidence))).toEqual(['disposition', 'lifetimeSeconds']);
  });
});
