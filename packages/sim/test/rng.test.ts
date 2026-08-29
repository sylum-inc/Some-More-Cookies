import { describe, expect, it } from 'vitest';
import { Rng, createRng, fbm1D, hashString, mixSeeds, valueNoise1D } from '../src/rng.js';

describe('Rng', () => {
  it('is deterministic for a given seed', () => {
    const a = new Rng(1234);
    const b = new Rng(1234);
    const seqA = Array.from({ length: 50 }, () => a.next());
    const seqB = Array.from({ length: 50 }, () => b.next());
    expect(seqA).toEqual(seqB);
  });

  it('produces different sequences for different seeds', () => {
    const a = new Rng(1);
    const b = new Rng(2);
    expect(a.next()).not.toBe(b.next());
  });

  it('accepts string seeds', () => {
    expect(new Rng('campsite-a').next()).toBe(new Rng('campsite-a').next());
    expect(new Rng('campsite-a').next()).not.toBe(new Rng('campsite-b').next());
  });

  it('never returns a zero state that would stick', () => {
    const rng = new Rng(0);
    const values = new Set(Array.from({ length: 20 }, () => rng.next()));
    expect(values.size).toBeGreaterThan(15);
  });

  it('stays within [0,1)', () => {
    const rng = new Rng(99);
    for (let i = 0; i < 2000; i++) {
      const v = rng.next();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('is roughly uniform', () => {
    const rng = new Rng(7);
    const buckets = new Array(10).fill(0) as number[];
    const n = 40000;
    for (let i = 0; i < n; i++) {
      const idx = Math.floor(rng.next() * 10);
      buckets[idx] = (buckets[idx] ?? 0) + 1;
    }
    for (const count of buckets) {
      // Each bucket should hold ~10%; allow a generous band.
      expect(count).toBeGreaterThan(n * 0.085);
      expect(count).toBeLessThan(n * 0.115);
    }
  });

  it('range and int respect bounds', () => {
    const rng = new Rng(11);
    for (let i = 0; i < 500; i++) {
      const r = rng.range(-3, 7);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThan(7);
      const n = rng.int(2, 5);
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(5);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('int handles an inverted range without throwing', () => {
    expect(new Rng(1).int(5, 2)).toBe(5);
  });

  describe('split', () => {
    it('produces independent streams', () => {
      const parent = new Rng(42);
      const fire = parent.split('fire');
      const wildlife = parent.split('wildlife');
      expect(fire.next()).not.toBe(wildlife.next());
    });

    it('gives the same stream for the same name and parent state', () => {
      const a = new Rng(42).split('fire');
      const b = new Rng(42).split('fire');
      expect(a.next()).toBe(b.next());
    });

    it('insulates one subsystem from another consuming values', () => {
      // This is the property that makes adding a die roll to one system safe:
      // it must not shift what another system observes.
      const parentA = new Rng(5);
      const fireA = parentA.split('fire');

      const parentB = new Rng(5);
      const fireB = parentB.split('fire');
      // A different subsystem consumes heavily from its own stream.
      const other = parentB.split('wildlife');
      for (let i = 0; i < 100; i++) other.next();

      expect(fireA.next()).toBe(fireB.next());
    });
  });

  it('snapshots and restores exactly', () => {
    const rng = new Rng(3);
    for (let i = 0; i < 10; i++) rng.next();
    const saved = rng.getState();
    const expected = Array.from({ length: 5 }, () => rng.next());
    rng.setState(saved);
    expect(Array.from({ length: 5 }, () => rng.next())).toEqual(expected);
  });

  it('clones without sharing state', () => {
    const rng = new Rng(8);
    const copy = rng.clone();
    expect(copy.next()).toBe(rng.next());
  });

  describe('weightedPick', () => {
    it('respects weights', () => {
      const rng = new Rng(17);
      const items = [
        { id: 'common', w: 9 },
        { id: 'rare', w: 1 },
      ];
      let common = 0;
      for (let i = 0; i < 5000; i++) {
        if (rng.weightedPick(items, (x) => x.w)?.id === 'common') common++;
      }
      expect(common / 5000).toBeGreaterThan(0.85);
      expect(common / 5000).toBeLessThan(0.95);
    });

    it('ignores negative and non-finite weights instead of corrupting the draw', () => {
      const rng = new Rng(2);
      const items = [
        { id: 'bad', w: -5 },
        { id: 'nan', w: Number.NaN },
        { id: 'good', w: 1 },
      ];
      for (let i = 0; i < 200; i++) {
        expect(rng.weightedPick(items, (x) => x.w)?.id).toBe('good');
      }
    });

    it('returns undefined when every weight is zero', () => {
      expect(new Rng(1).weightedPick([{ w: 0 }], (x) => x.w)).toBeUndefined();
    });
  });

  it('pick returns undefined for an empty list', () => {
    expect(new Rng(1).pick([])).toBeUndefined();
  });

  it('shuffle is a permutation and is deterministic', () => {
    const source = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = new Rng(4).shuffle([...source]);
    const b = new Rng(4).shuffle([...source]);
    expect(a).toEqual(b);
    expect([...a].sort((x, y) => x - y)).toEqual(source);
  });

  it('normal is centred and bounded', () => {
    const rng = new Rng(21);
    let total = 0;
    const n = 20000;
    for (let i = 0; i < n; i++) {
      const v = rng.normal(0, 1);
      total += v;
      // Central-limit-of-4 is bounded, which is the point: no absurd spikes.
      expect(Math.abs(v)).toBeLessThan(3);
    }
    expect(Math.abs(total / n)).toBeLessThan(0.05);
  });
});

describe('hashing', () => {
  it('hashString is stable and distinct', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
  });

  it('mixSeeds is order-sensitive and well-distributed', () => {
    expect(mixSeeds(1, 2)).not.toBe(mixSeeds(2, 1));
    const values = new Set<number>();
    for (let i = 0; i < 1000; i++) values.add(mixSeeds(7, i));
    expect(values.size).toBe(1000);
  });
});

describe('noise', () => {
  it('valueNoise1D is continuous and deterministic', () => {
    const a = valueNoise1D(1, 3.25);
    expect(valueNoise1D(1, 3.25)).toBe(a);
    // A tiny step in x should give a tiny step in output.
    expect(Math.abs(valueNoise1D(1, 3.2501) - a)).toBeLessThan(0.01);
  });

  it('valueNoise1D stays within [0,1)', () => {
    for (let i = 0; i < 500; i++) {
      const v = valueNoise1D(9, i * 0.37);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });

  it('fbm1D stays normalised', () => {
    for (let i = 0; i < 300; i++) {
      const v = fbm1D(3, i * 0.21, 4);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it('fbm1D with zero octaves does not divide by zero', () => {
    expect(fbm1D(1, 1, 0)).toBe(0);
  });
});

describe('createRng', () => {
  it('matches the constructor', () => {
    expect(createRng('x').next()).toBe(new Rng('x').next());
  });
});
