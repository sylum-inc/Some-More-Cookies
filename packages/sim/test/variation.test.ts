/**
 * The roll that makes two visits to one campsite two different nights.
 *
 * The properties that matter here are not "the numbers look plausible" — they
 * are the ones the rest of the product leans on: a seed replays a night
 * exactly, a manifest gaining a variation does not disturb the ones it already
 * had, and a campsite that declares nothing about a dial is left alone rather
 * than nudged toward some invented middle.
 */

import { describe, expect, it } from 'vitest';
import {
  NO_VARIATIONS,
  VARIATION_ROLES,
  nudge,
  rollVariations,
  scale,
  type SeededVariationSpec,
} from '../src/variation.js';

const spec = (
  id: string,
  min: number,
  max: number,
  unit = 'normalised',
): SeededVariationSpec => ({ id, label: id, range: { min, max }, unit, note: '' });

const PINE: SeededVariationSpec[] = [
  spec('creek_level', 0.35, 1),
  spec('firewood_stack', 3, 14, 'rounds'),
  spec('undergrowth_density', 0.7, 1.3, 'multiplier'),
  spec('neighbour_presence', 0, 1, 'probability'),
  spec('duff_wetness', 0.1, 0.6),
];

describe('rolling a campsite’s variations', () => {
  it('replays a night exactly from its seed', () => {
    const a = rollVariations(PINE, 4242);
    const b = rollVariations(PINE, 4242);
    expect(a.rolled.map((r) => r.value)).toEqual(b.rolled.map((r) => r.value));
  });

  it('is a different night on a different seed', () => {
    const a = rollVariations(PINE, 1);
    const b = rollVariations(PINE, 2);
    expect(a.rolled.map((r) => r.value)).not.toEqual(b.rolled.map((r) => r.value));
  });

  it('keeps every value inside the range its manifest declares', () => {
    for (let seed = 1; seed < 300; seed++) {
      for (const entry of rollVariations(PINE, seed).rolled) {
        expect(entry.value).toBeGreaterThanOrEqual(entry.spec.range.min);
        expect(entry.value).toBeLessThanOrEqual(entry.spec.range.max);
      }
    }
  });

  /*
   * The reason each variation draws from a stream named after itself.
   *
   * With one shared stream, adding a sixth variation to a manifest — or
   * reordering the five that are there — would silently change what every
   * later one rolled, and a campsite somebody had visited would come back a
   * different place for a reason nobody could find.
   */
  it('does not disturb a campsite’s other variations when one is added', () => {
    const before = rollVariations(PINE, 99);
    const after = rollVariations([spec('a_new_one', 0, 5), ...PINE], 99);
    for (const entry of before.rolled) {
      expect(after.at(entry.spec.id)?.value).toBe(entry.value);
    }
  });

  it('does not disturb them when they are reordered either', () => {
    const forward = rollVariations(PINE, 7);
    const backward = rollVariations([...PINE].reverse(), 7);
    for (const entry of forward.rolled) {
      expect(backward.at(entry.spec.id)?.value).toBe(entry.value);
    }
  });

  it('spreads across the whole range over many nights', () => {
    const values: number[] = [];
    for (let seed = 1; seed < 400; seed++) {
      const stack = rollVariations(PINE, seed).at('firewood_stack');
      if (stack) values.push(stack.value);
    }
    expect(Math.min(...values)).toBeLessThan(4.5);
    expect(Math.max(...values)).toBeGreaterThan(12.5);
  });
});

describe('roles', () => {
  it('averages the variations that carry one', () => {
    // Both of these are `undergrowth`, so the role is the mean of where each
    // landed in its own range — which is the whole reason a role is read as a
    // position rather than as a value: a grass height in multiples and a moss
    // coverage in multiples are not on the same scale as each other, let alone
    // as a tide in metres.
    const set = rollVariations([spec('grass_height', 0.6, 1.4), spec('moss_density', 0.7, 1.3)], 5);
    const grass = set.at('grass_height')!.position;
    const moss = set.at('moss_density')!.position;
    expect(set.role('undergrowth')).toBeCloseTo((grass + moss) / 2, 9);
  });

  it('reads an inverted variation the other way up', () => {
    // `tide_state` is metres from the log: further out is *less* water.
    const far = rollVariations([{ ...spec('tide_state', 46, 46, 'metres from the log') }], 3);
    const near = rollVariations([{ ...spec('tide_state', 12, 12, 'metres from the log') }], 3);
    // Both are single-point ranges, so position is whatever was rolled; what
    // is being asserted is the mapping, so use a range and check both ends.
    expect(far.at('tide_state')?.value).toBe(46);
    expect(near.at('tide_state')?.value).toBe(12);

    const wide = rollVariations([spec('tide_state', 0, 1, 'metres from the log')], 11);
    const position = wide.at('tide_state')!.position;
    expect(wide.role('water-level')).toBeCloseTo(1 - position, 6);
  });

  it('reports a role no variation carries as absent, not as a middle', () => {
    const set = rollVariations([spec('firewood_stack', 3, 14, 'rounds')], 12);
    expect(set.role('fuel-stock')).not.toBeNull();
    expect(set.role('reception')).toBeNull();
    expect(set.roleOr('reception', 0.31)).toBe(0.31);
  });

  it('leaves a campsite that declares nothing exactly where it was', () => {
    expect(NO_VARIATIONS.rolled).toEqual([]);
    expect(scale(NO_VARIATIONS, 'undergrowth', 0.5)).toBe(1);
    expect(nudge(NO_VARIATIONS, 'fuel-wetness', 0.4)).toBe(0);
    for (const role of ['fuel-stock', 'air-haze', 'company', 'reception'] as const) {
      expect(NO_VARIATIONS.role(role)).toBeNull();
    }
  });

  it('reads an unmapped variation as driving nothing', () => {
    const set = rollVariations([spec('cairn_state', 0, 1, 'variant')], 8);
    expect(set.at('cairn_state')?.role).toBeNull();
    expect(set.rolled).toHaveLength(1);
  });

  it('scales inside its swing and nudges inside its amount, on every seed', () => {
    let lowest = Infinity;
    let highest = -Infinity;
    for (let seed = 1; seed < 400; seed++) {
      const set = rollVariations([spec('grass_height', 0.6, 1.4, 'multiplier')], seed);
      const factor = scale(set, 'undergrowth', 0.4);
      expect(factor).toBeGreaterThanOrEqual(0.6 - 1e-9);
      expect(factor).toBeLessThanOrEqual(1.4 + 1e-9);
      expect(Math.abs(nudge(set, 'undergrowth', 0.11))).toBeLessThanOrEqual(0.11 + 1e-9);
      lowest = Math.min(lowest, factor);
      highest = Math.max(highest, factor);
    }
    // And actually uses the swing rather than hovering around 1.
    expect(lowest).toBeLessThan(0.63);
    expect(highest).toBeGreaterThan(1.37);
  });

  it('rises with the roll, never falls with it', () => {
    const sets = [1, 2, 3, 4, 5, 6, 7, 8]
      .map((seed) => rollVariations([spec('grass_height', 0.6, 1.4, 'multiplier')], seed))
      .sort((a, b) => (a.role('undergrowth') ?? 0) - (b.role('undergrowth') ?? 0));
    const factors = sets.map((set) => scale(set, 'undergrowth', 0.4));
    for (let i = 1; i < factors.length; i++) {
      expect(factors[i]!).toBeGreaterThanOrEqual(factors[i - 1]!);
    }
  });
});

describe('the role table', () => {
  it('maps only to roles that exist, and gives a reason for each', () => {
    for (const [id, mapping] of Object.entries(VARIATION_ROLES)) {
      if (mapping === null) continue;
      expect(mapping.because.length, `${id} should say why`).toBeGreaterThan(8);
    }
  });

  it('wires substantially more than it leaves alone', () => {
    const entries = Object.values(VARIATION_ROLES);
    const wired = entries.filter((m) => m !== null).length;
    expect(wired).toBeGreaterThan(entries.length * 0.7);
  });
});
