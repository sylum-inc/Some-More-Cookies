import { beforeEach, describe, expect, it } from 'vitest';
import {
  createGathering,
  carrying,
  describeArmful,
  gatherFrom,
  patchAt,
  resetCarriedIds,
  takeFromArmful,
  MAX_ARMFUL,
  type FuelSourceSpec,
} from '../src/gathering.js';
import { createRitual, gatherFuel, layFuel, stepRitual, tendFire } from '../src/ritual.js';
import { isBanked, spotFrom } from '../src/fire.js';
import { Rng } from '../src/rng.js';
import {
  NO_VARIATIONS,
  rollVariations,
  type SeededVariationSpec,
} from '../src/variation.js';
import { SIM_DT } from '../src/types.js';

/** A campsite whose wood is described the way the catalogue describes wood. */
const SOURCES: FuelSourceSpec[] = [
  {
    woodId: 'pine',
    weight: 4,
    foundAs: 'Hemlock deadfall from the slope, everywhere, and damp all the way through.',
    moistureBias: 0.22,
  },
  {
    woodId: 'oak',
    weight: 2,
    foundAs: 'Split maple from a stack inside the hollow cedar, dry because the tree is a roof.',
    moistureBias: -0.12,
  },
];

function build(humidity = 0.4) {
  return createGathering({ sources: SOURCES, radius: 13, humidity, rng: new Rng(7) });
}

beforeEach(() => resetCarriedIds());

describe('where the wood is', () => {
  it('turns each source into places, inside the campsite', () => {
    const state = build();
    expect(state.patches.length).toBeGreaterThan(2);
    for (const patch of state.patches) {
      const distance = Math.hypot(patch.x, patch.z);
      expect(distance).toBeGreaterThan(2);
      expect(distance).toBeLessThan(13);
    }
  });

  it('puts the plentiful wood near and the good wood out at the edge', () => {
    const state = build();
    const near = state.patches.find((p) => p.woodId === 'pine' && p.grade === 'log')!;
    const far = state.patches.find((p) => p.woodId === 'oak' && p.grade === 'log')!;
    expect(Math.hypot(near.x, near.z)).toBeLessThan(Math.hypot(far.x, far.z));
  });

  it('only the commoner wood leaves small stuff lying about', () => {
    const state = build();
    const grades = (woodId: string) =>
      state.patches.filter((p) => p.woodId === woodId).map((p) => p.grade);
    // The slope is covered in it, so there are twigs and sticks as well as limbs.
    expect(grades('pine')).toContain('tinder');
    expect(grades('pine')).toContain('kindling');
    // The stack in the hollow tree is split logs. Nobody splits tinder.
    expect(grades('oak')).not.toContain('tinder');
  });

  it('carries the catalogue’s own moisture through to what you pick up', () => {
    const state = build(0.4);
    const slope = state.patches.find((p) => p.woodId === 'pine' && p.grade === 'log')!;
    const shed = state.patches.find((p) => p.woodId === 'oak' && p.grade === 'log')!;
    // The wet slope's deadfall is genuinely wetter than the stack in the tree,
    // which is the environment's own best-kept secret and was, until this
    // existed, told to nobody.
    expect(slope.moisture).toBeGreaterThan(shed.moisture + 0.25);
  });

  it('a damp night makes everything on the ground wetter', () => {
    const dry = build(0.1);
    const wet = build(0.95);
    const pick = (state: ReturnType<typeof build>) =>
      state.patches.find((p) => p.woodId === 'pine' && p.grade === 'log')!.moisture;
    expect(pick(wet)).toBeGreaterThan(pick(dry));
  });
});

describe('an armful', () => {
  it('holds five pieces and then no more', () => {
    const state = build();
    const patch = state.patches[0]!;
    for (let i = 0; i < MAX_ARMFUL; i++) {
      expect(gatherFrom(state, patch.id).taken).not.toBeNull();
    }
    const overflow = gatherFrom(state, patch.id);
    expect(overflow.taken).toBeNull();
    expect(overflow.full).toBe(true);
    expect(state.armful).toHaveLength(MAX_ARMFUL);
  });

  it('introduces a place once and then stops explaining itself', () => {
    const state = build();
    const patch = state.patches[0]!;
    expect(gatherFrom(state, patch.id).introduction).toBe(patch.foundAs);
    expect(gatherFrom(state, patch.id).introduction).toBeNull();
  });

  it('runs a place down and says so', () => {
    const state = build();
    const patch = patchAt(state, state.patches.find((p) => p.grade === 'log')!.id)!;
    let guard = 0;
    while (patch.remaining > 0 && guard++ < 200) {
      if (state.armful.length >= MAX_ARMFUL) state.armful.length = 0;
      gatherFrom(state, patch.id);
    }
    const result = gatherFrom(state, patch.id);
    expect(result.empty).toBe(true);
    expect(result.taken).toBeNull();
  });

  it('is described the way an armful presents itself, not as a list', () => {
    const state = build();
    expect(describeArmful(state)).toBe('Nothing in your arms.');
    const tinder = state.patches.find((p) => p.grade === 'tinder')!;
    const logs = state.patches.find((p) => p.grade === 'log')!;
    gatherFrom(state, tinder.id);
    gatherFrom(state, tinder.id);
    gatherFrom(state, logs.id);
    expect(carrying(state, 'tinder')).toBe(2);
    expect(describeArmful(state)).toBe('Carrying a split log and 2 handfuls of tinder.');
  });

  it('hands back the last thing you picked up first', () => {
    const state = build();
    const tinder = state.patches.find((p) => p.grade === 'tinder')!;
    const logs = state.patches.find((p) => p.grade === 'log')!;
    gatherFrom(state, tinder.id);
    const last = gatherFrom(state, logs.id).taken!;
    expect(takeFromArmful(state)!.id).toBe(last.id);
    expect(takeFromArmful(state)!.grade).toBe('tinder');
    expect(takeFromArmful(state)).toBeNull();
  });

  it('ignores a place that is not there', () => {
    const state = build();
    expect(gatherFrom(state, 'fuel-nowhere-log').taken).toBeNull();
    expect(patchAt(state, 'fuel-nowhere-log')).toBeNull();
  });
});

describe('what you carry back is what you found', () => {
  it('puts the place’s own moisture on the fire, not the wood type’s default', () => {
    const ritual = createRitual({
      campsiteSeed: 'gather',
      environmentId: 'pinewood',
      world: { fuel: SOURCES },
    });
    const slope = ritual.gathering.patches.find((p) => p.woodId === 'pine' && p.grade === 'log')!;
    gatherFuel(ritual, slope.id);
    const laid = layFuel(ritual, { spot: { x: 0.1, z: 0 } })!;
    expect(laid.woodId).toBe('pine');
    expect(laid.moisture).toBeCloseTo(slope.moisture, 6);
    expect(ritual.gathering.armful).toHaveLength(0);
  });

  it('laying with nothing in your arms does nothing at all', () => {
    const ritual = createRitual({ campsiteSeed: 'gather', environmentId: 'pinewood', world: { fuel: SOURCES } });
    const before = ritual.fire.logs.length;
    expect(layFuel(ritual)).toBeNull();
    expect(ritual.fire.logs).toHaveLength(before);
  });
});

describe('coming back to a campsite you have used', () => {
  it('finds the pit banked rather than burning', () => {
    const first = createRitual({ campsiteSeed: 'return', environmentId: 'pinewood', visitIndex: 1 });
    const again = createRitual({ campsiteSeed: 'return', environmentId: 'pinewood', visitIndex: 2 });
    expect(first.fire.flame).toBeGreaterThan(0.5);
    expect(isBanked(first.fire)).toBe(false);
    expect(again.fire.flame).toBe(0);
    expect(isBanked(again.fire)).toBe(true);
    // Cold to look at, and not cold.
    expect(again.fire.emberTemp).toBeGreaterThan(200);
  });

  it('can be woken with what the campsite has lying about', () => {
    const ritual = createRitual({
      campsiteSeed: 'return',
      environmentId: 'pinewood',
      visitIndex: 2,
      world: { fuel: SOURCES },
    });
    const seconds = (n: number) => {
      for (let i = 0; i < Math.round(n / SIM_DT); i++) stepRitual(ritual, SIM_DT);
    };
    const tinder = ritual.gathering.patches.find((p) => p.grade === 'tinder')!;
    const kindling = ritual.gathering.patches.find((p) => p.grade === 'kindling')!;

    // Out for an armful, back to the pit, rake the ash off it, lay the fine
    // stuff on the coals and blow.
    for (let i = 0; i < 2; i++) gatherFuel(ritual, tinder.id);
    for (let i = 0; i < 3; i++) gatherFuel(ritual, kindling.id);
    expect(ritual.gathering.armful).toHaveLength(5);

    tendFire(ritual, { type: 'rake' });
    tendFire(ritual, { type: 'rake' });
    for (let i = 0; i < 5; i++) layFuel(ritual, { spot: spotFrom(0.06 + i * 0.01, i * 1.2, 0) });
    expect(ritual.gathering.armful).toHaveLength(0);
    tendFire(ritual, { type: 'fan' });
    seconds(3);
    tendFire(ritual, { type: 'fan' });
    seconds(3);
    tendFire(ritual, { type: 'fan' });
    seconds(20);

    // It is alight, and the bed is hotter than the one you found.
    expect(ritual.fire.flame).toBeGreaterThan(0.5);
    expect(ritual.fire.emberTemp).toBeGreaterThan(420);
    expect(isBanked(ritual.fire)).toBe(false);
  });
});

/**
 * What the campsite's own roll does to the wood lying about (§5.4).
 *
 * Seven campsites declare a fuel stock — "3..14 rounds", "6..20 pieces",
 * "kindling left by the last person: 2..10" — and every one of their notes
 * says "Never zero". Until these were rolled they were never anything else
 * either: the same count, the same wetness, every visit.
 */
describe('what tonight left lying about', () => {
  const sources: FuelSourceSpec[] = [
    { woodId: 'pine', weight: 5, foundAs: 'Dry twigs under the young firs.', moistureBias: 0 },
    { woodId: 'oak', weight: 2, foundAs: 'Split rounds behind the post.', moistureBias: 0.05 },
  ];

  const build = (variations: ReturnType<typeof rollVariations>) =>
    createGathering({ sources, radius: 13, humidity: 0.4, variations, rng: new Rng(7) });

  /** The seed whose roll puts a role nearest each end of its range. */
  const endsFor = (specs: SeededVariationSpec[], role: 'fuel-stock' | 'fuel-size' | 'fuel-wetness') => {
    let low = 1;
    let high = 1;
    let lowest = Infinity;
    let highest = -Infinity;
    for (let seed = 1; seed < 400; seed++) {
      const value = rollVariations(specs, seed).role(role);
      if (value === null) continue;
      if (value < lowest) [lowest, low] = [value, seed];
      if (value > highest) [highest, high] = [value, seed];
    }
    return { low: rollVariations(specs, low), high: rollVariations(specs, high) };
  };

  const stack: SeededVariationSpec[] = [
    { id: 'firewood_stack', label: 'stack', range: { min: 3, max: 14 }, unit: 'rounds', note: '' },
  ];
  const wetness: SeededVariationSpec[] = [
    { id: 'duff_wetness', label: 'duff', range: { min: 0.1, max: 0.6 }, unit: 'normalised', note: '' },
  ];
  const size: SeededVariationSpec[] = [
    { id: 'driftwood_size', label: 'size', range: { min: 0.4, max: 1.4 }, unit: 'relative mass', note: '' },
  ];

  const total = (state: ReturnType<typeof createGathering>) =>
    state.patches.reduce((sum, patch) => sum + patch.stock, 0);

  it('is the same campsite it always was when nothing varies it', () => {
    const plain = createGathering({ sources, radius: 13, humidity: 0.4, rng: new Rng(7) });
    const explicit = build(NO_VARIATIONS);
    expect(total(explicit)).toBe(total(plain));
  });

  it('leaves more wood about on a plentiful night than a lean one', () => {
    const { low, high } = endsFor(stack, 'fuel-stock');
    expect(total(build(high))).toBeGreaterThan(total(build(low)) * 1.5);
  });

  /*
   * "Never zero. Fuel is not a pressure (§4.1)." — pine_hollow's own note on
   * its firewood stack, and the reason the lean end has a floor rather than
   * running down to nothing.
   */
  it('never leaves a night short of wood, on any roll', () => {
    for (let seed = 1; seed < 200; seed++) {
      const state = build(rollVariations(stack, seed));
      for (const patch of state.patches) expect(patch.stock).toBeGreaterThanOrEqual(2);
      expect(total(state)).toBeGreaterThan(20);
    }
  });

  it('makes gathered wood wetter on a wet night', () => {
    const { low, high } = endsFor(wetness, 'fuel-wetness');
    const dryNight = build(low).patches[0]!;
    const wetNight = build(high).patches[0]!;
    expect(wetNight.moisture).toBeGreaterThan(dryNight.moisture + 0.12);
    expect(wetNight.moisture).toBeLessThanOrEqual(1);
  });

  /*
   * "Some nights the beach gives you a log; some nights, kindling and
   * patience." — longlight_shore's own note on `driftwood_size`, which is a
   * shift between grades rather than a change in how much there is.
   */
  it('gives you logs some nights and sticks and patience others', () => {
    const { low, high } = endsFor(size, 'fuel-size');
    const byGrade = (state: ReturnType<typeof createGathering>, grade: string) =>
      state.patches.filter((p) => p.grade === grade).reduce((sum, p) => sum + p.stock, 0);
    const bigNight = build(high);
    const smallNight = build(low);
    expect(byGrade(bigNight, 'log')).toBeGreaterThan(byGrade(smallNight, 'log'));
    expect(byGrade(smallNight, 'kindling')).toBeGreaterThan(byGrade(bigNight, 'kindling'));
  });
});

/**
 * The property the whole of §5.4 rests on: coming back is coming back to a
 * different night.
 *
 * `campsiteSeed` is deliberately stable — it is stored on the device, because
 * the campsite you visited last week has to be the same campsite. So the roll
 * cannot come from it alone, or "what is different tonight" would be the same
 * thing every night. It comes from the campsite *and which visit this is*.
 */
describe('coming back to a campsite', () => {
  const world = {
    fuel: [
      { woodId: 'pine', weight: 5, foundAs: 'Dry twigs under the young firs.', moistureBias: 0 },
      { woodId: 'oak', weight: 2, foundAs: 'Split rounds behind the post.', moistureBias: 0.05 },
    ],
    variations: [
      { id: 'firewood_stack', label: 'Firewood', range: { min: 3, max: 14 }, unit: 'rounds', note: '' },
      { id: 'duff_wetness', label: 'Duff', range: { min: 0.1, max: 0.6 }, unit: 'normalised', note: '' },
    ],
  };

  const nightOf = (visitIndex: number) => {
    const ritual = createRitual({ campsiteSeed: 'the-same-place', environmentId: 'pine_hollow', world, visitIndex });
    return {
      stock: ritual.gathering.patches.reduce((sum, patch) => sum + patch.stock, 0),
      moisture: ritual.gathering.patches[0]?.moisture ?? 0,
    };
  };

  it('is the same place, and a different night', () => {
    const nights = [1, 2, 3, 4, 5, 6].map(nightOf);
    const stocks = nights.map((night) => night.stock);
    expect(new Set(stocks).size, `stocks: ${stocks.join(', ')}`).toBeGreaterThan(3);
    const moistures = nights.map((night) => night.moisture);
    expect(Math.max(...moistures) - Math.min(...moistures)).toBeGreaterThan(0.05);
  });

  it('is the same night again if you replay the same visit', () => {
    expect(nightOf(4)).toEqual(nightOf(4));
  });

  /*
   * A shared world is rebuilt from the wire's seed with no visit index, so
   * every client rolls visit one — two people at one fire are at one fire.
   */
  it('is one night for everybody who was rebuilt from the same seed', () => {
    const asShared = () =>
      createRitual({ campsiteSeed: 'shared-fire', environmentId: 'pine_hollow', world });
    const a = asShared().gathering.patches.map((p) => [p.stock, p.moisture]);
    const b = asShared().gathering.patches.map((p) => [p.stock, p.moisture]);
    expect(a).toEqual(b);
  });

  it('never leaves a returning player short of wood', () => {
    for (let visit = 1; visit <= 40; visit++) {
      expect(nightOf(visit).stock, `visit ${visit}`).toBeGreaterThan(20);
    }
  });
});
