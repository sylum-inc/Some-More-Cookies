import { describe, expect, it } from 'vitest';

import {
  DISCOVERY_STREAM,
  ENVIRONMENTS,
  MAX_REGION_AFFINITY,
  MIN_REGION_AFFINITY,
  REGIONS,
  discoveryOrder,
  discoveryProbabilities,
  effectiveDiscoveryWeight,
  environmentIds,
  selectEnvironment,
  type EnvironmentManifest,
} from '@somemore/content';

describe('effective discovery weight', () => {
  it('is strictly positive for every environment in every region', () => {
    for (const region of REGIONS) {
      for (const environment of ENVIRONMENTS) {
        expect(effectiveDiscoveryWeight(environment, region)).toBeGreaterThan(0);
      }
    }
  });

  it('defaults an unspecified region to a multiplier of one', () => {
    const environment = ENVIRONMENTS[0];
    if (!environment) throw new Error('empty catalogue');
    const stripped: EnvironmentManifest = {
      ...environment,
      discovery: { ...environment.discovery, affinities: {} },
    };
    for (const region of REGIONS) {
      expect(effectiveDiscoveryWeight(stripped, region)).toBeCloseTo(environment.discovery.weight, 10);
    }
  });

  it('clamps a hostile affinity into the band rather than zeroing the weight', () => {
    const environment = ENVIRONMENTS[0];
    if (!environment) throw new Error('empty catalogue');
    const sabotaged: EnvironmentManifest = {
      ...environment,
      discovery: { ...environment.discovery, affinities: { boreal: 0, 'arid-interior': 1e9 } },
    };
    expect(effectiveDiscoveryWeight(sabotaged, 'boreal')).toBeCloseTo(
      environment.discovery.weight * MIN_REGION_AFFINITY,
      10,
    );
    expect(effectiveDiscoveryWeight(sabotaged, 'arid-interior')).toBeCloseTo(
      environment.discovery.weight * MAX_REGION_AFFINITY,
      10,
    );
  });

  it('survives NaN in the affinity table', () => {
    const environment = ENVIRONMENTS[0];
    if (!environment) throw new Error('empty catalogue');
    const broken: EnvironmentManifest = {
      ...environment,
      discovery: { ...environment.discovery, affinities: { boreal: Number.NaN } },
    };
    expect(effectiveDiscoveryWeight(broken, 'boreal')).toBeCloseTo(environment.discovery.weight, 10);
  });
});

describe('selectEnvironment', () => {
  it('is deterministic for a given seed', () => {
    for (const seed of ['camp-1', 'camp-2', 42, 999_999]) {
      const a = selectEnvironment({ seed });
      const b = selectEnvironment({ seed });
      expect(a.id).toBe(b.id);
    }
  });

  it('is deterministic for a given seed and region', () => {
    for (const region of REGIONS) {
      const a = selectEnvironment({ seed: 'stable-seed', region });
      const b = selectEnvironment({ seed: 'stable-seed', region });
      expect(a.id).toBe(b.id);
    }
  });

  it('always returns a member of the catalogue', () => {
    const ids = new Set(environmentIds());
    for (let seed = 0; seed < 400; seed++) {
      expect(ids.has(selectEnvironment({ seed }).id)).toBe(true);
    }
  });

  it('never returns an already-discovered environment while any remain', () => {
    const discovered = environmentIds().slice(0, ENVIRONMENTS.length - 1);
    for (let seed = 0; seed < 300; seed++) {
      const picked = selectEnvironment({ seed, discoveredIds: discovered });
      expect(discovered).not.toContain(picked.id);
    }
  });

  it('falls back to the full catalogue once everything is discovered', () => {
    const discovered = environmentIds();
    const picked = selectEnvironment({ seed: 'all-found', discoveredIds: discovered });
    expect(discovered).toContain(picked.id);
  });

  it('ignores unknown ids in the discovered list', () => {
    const a = selectEnvironment({ seed: 'x' });
    const b = selectEnvironment({ seed: 'x', discoveredIds: ['not_an_environment'] });
    expect(a.id).toBe(b.id);
  });

  it('accepts a custom catalogue', () => {
    const single = ENVIRONMENTS.slice(3, 4);
    const only = single[0];
    if (!only) throw new Error('missing fixture');
    for (let seed = 0; seed < 20; seed++) {
      expect(selectEnvironment({ seed, catalogue: single }).id).toBe(only.id);
    }
  });

  it('throws only on an empty catalogue', () => {
    expect(() => selectEnvironment({ seed: 1, catalogue: [] })).toThrow(/empty/);
  });

  it('uses a named RNG stream so other systems cannot desynchronise it', () => {
    expect(DISCOVERY_STREAM).toBe('environment-discovery');
  });
});

describe('discoveryProbabilities', () => {
  it('sums to one and assigns a positive share to every environment', () => {
    for (const region of REGIONS) {
      const probabilities = discoveryProbabilities(region);
      expect(probabilities.size).toBe(ENVIRONMENTS.length);
      let total = 0;
      for (const [, share] of probabilities) {
        expect(share).toBeGreaterThan(0);
        total += share;
      }
      expect(total).toBeCloseTo(1, 10);
    }
  });

  it('keeps rarity weights sane — nothing dominates and nothing is vanishing', () => {
    for (const region of REGIONS) {
      for (const [, share] of discoveryProbabilities(region)) {
        // No environment is a near-certainty, and none is a lottery ticket.
        expect(share).toBeLessThan(0.35);
        expect(share).toBeGreaterThan(0.01);
      }
    }
  });

  it('lets region weight the ordering without changing what is available', () => {
    const arid = discoveryProbabilities('arid-interior');
    const boreal = discoveryProbabilities('boreal');
    expect((arid.get('lantern_mesa') ?? 0)).toBeGreaterThan(boreal.get('lantern_mesa') ?? 0);
    expect((boreal.get('loonwater_narrows') ?? 0)).toBeGreaterThan(arid.get('loonwater_narrows') ?? 0);
    // …and both are still non-zero in both regions.
    expect(boreal.get('lantern_mesa') ?? 0).toBeGreaterThan(0);
    expect(arid.get('loonwater_narrows') ?? 0).toBeGreaterThan(0);
  });
});

describe('discoveryOrder', () => {
  it('is a full permutation of the catalogue for any seed and region', () => {
    const expected = [...environmentIds()].sort();
    for (const region of REGIONS) {
      for (let seed = 0; seed < 40; seed++) {
        const order = discoveryOrder({ seed, region });
        expect(order).toHaveLength(ENVIRONMENTS.length);
        expect(order.map((environment) => environment.id).sort()).toEqual(expected);
      }
    }
  });

  it('is deterministic', () => {
    const a = discoveryOrder({ seed: 'trip', region: 'highland' }).map((environment) => environment.id);
    const b = discoveryOrder({ seed: 'trip', region: 'highland' }).map((environment) => environment.id);
    expect(a).toEqual(b);
  });

  it('produces different orders for different seeds', () => {
    const orders = new Set(
      Array.from({ length: 30 }, (_, seed) =>
        discoveryOrder({ seed }).map((environment) => environment.id).join(','),
      ),
    );
    expect(orders.size).toBeGreaterThan(20);
  });

  it('agrees with selectEnvironment on the first draw', () => {
    for (const region of REGIONS) {
      for (let seed = 0; seed < 25; seed++) {
        const first = discoveryOrder({ seed, region })[0];
        expect(first?.id).toBe(selectEnvironment({ seed, region }).id);
      }
    }
  });
});
