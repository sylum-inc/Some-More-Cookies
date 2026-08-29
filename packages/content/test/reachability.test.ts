import { describe, expect, it } from 'vitest';

import {
  ENVIRONMENTS,
  REGIONS,
  discoveryOrder,
  effectiveDiscoveryWeight,
  environmentIds,
  selectEnvironment,
  unreachableEnvironments,
  type RegionId,
} from '@somemore/content';

/**
 * Spec §5.4: "Every player must eventually be able to discover every core
 * environment — region never locks content."
 *
 * This file is the proof. Three independent arguments, because this is the
 * invariant most likely to be broken by a well-meaning live-ops weight edit:
 *
 *  1. Analytic — no environment has a non-positive effective weight anywhere.
 *  2. Exhaustive by simulated play — a player in each region, drawing without
 *     replacement, always finishes with the whole catalogue.
 *  3. Statistical — across many independent seeds, the *first* environment a
 *     player in each region meets covers the entire catalogue, so nothing is
 *     merely reachable-in-theory-after-everything-else.
 */

const SEEDS_PER_REGION = 600;

describe('no-lock guarantee (spec §5.4)', () => {
  it('reports no unreachable environment in any region', () => {
    for (const region of REGIONS) {
      expect(unreachableEnvironments(region)).toEqual([]);
    }
  });

  it('gives every environment a positive weight in every region', () => {
    for (const region of REGIONS) {
      for (const environment of ENVIRONMENTS) {
        expect(effectiveDiscoveryWeight(environment, region)).toBeGreaterThan(0);
      }
    }
  });

  it('lets a player in any region eventually discover the entire catalogue', () => {
    const expected = [...environmentIds()].sort();

    for (const region of REGIONS) {
      // Simulate an actual player: draw, remember, draw again, until the
      // catalogue stops offering anything new. This uses the same
      // `selectEnvironment` the client calls, not a test-only shortcut.
      const discovered: string[] = [];
      let guard = 0;
      while (discovered.length < ENVIRONMENTS.length) {
        const picked = selectEnvironment({
          seed: `${region}:visit-${discovered.length}`,
          region,
          discoveredIds: discovered,
        });
        expect(discovered).not.toContain(picked.id);
        discovered.push(picked.id);
        guard += 1;
        expect(guard).toBeLessThanOrEqual(ENVIRONMENTS.length);
      }
      expect([...discovered].sort()).toEqual(expected);
    }
  });

  it('covers the whole catalogue as a *first* environment, in every region, across many seeds', () => {
    for (const region of REGIONS) {
      const firsts = new Set<string>();
      for (let seed = 0; seed < SEEDS_PER_REGION; seed++) {
        firsts.add(selectEnvironment({ seed: `${region}#${seed}`, region }).id);
      }
      // Every environment turns up as somebody's first campsite in this
      // region. Nothing is gated behind having already seen something else.
      expect([...firsts].sort()).toEqual([...environmentIds()].sort());
    }
  });

  it('covers the whole catalogue from an unknown region — the permission-denied path', () => {
    // Spec §5.5: declining location must not be a degraded experience.
    const firsts = new Set<string>();
    for (let seed = 0; seed < SEEDS_PER_REGION; seed++) {
      firsts.add(selectEnvironment({ seed: `unknown#${seed}` }).id);
    }
    expect([...firsts].sort()).toEqual([...environmentIds()].sort());
  });

  it('cannot be locked out by a saturated affinity table', () => {
    // The worst case content could express: one environment maxed everywhere,
    // every other environment at the floor. Even then, everything is drawable.
    const favourite = ENVIRONMENTS[0];
    if (!favourite) throw new Error('empty catalogue');
    const skewed = ENVIRONMENTS.map((environment) => ({
      ...environment,
      discovery: {
        ...environment.discovery,
        affinities: Object.fromEntries(
          REGIONS.map((region) => [region, environment.id === favourite.id ? 4 : 0.25] as const),
        ),
      },
    }));

    for (const region of REGIONS) {
      expect(unreachableEnvironments(region, skewed)).toEqual([]);
      const firsts = new Set<string>();
      for (let seed = 0; seed < 4000; seed++) {
        firsts.add(selectEnvironment({ seed: `skew#${region}#${seed}`, region, catalogue: skewed }).id);
      }
      expect(firsts.size).toBe(ENVIRONMENTS.length);
    }
  });

  it('always yields a complete permutation from discoveryOrder', () => {
    const expected = [...environmentIds()].sort();
    for (const region of REGIONS) {
      for (let seed = 0; seed < 100; seed++) {
        const order = discoveryOrder({ seed: `perm#${seed}`, region });
        expect(order.map((environment) => environment.id).sort()).toEqual(expected);
      }
    }
  });
});

describe('regional affinity only tilts, never gates', () => {
  it('keeps every region within a bounded spread of outcomes', () => {
    for (const region of REGIONS) {
      const weights = ENVIRONMENTS.map((environment) => effectiveDiscoveryWeight(environment, region));
      const min = Math.min(...weights);
      const max = Math.max(...weights);
      // A rarest-to-commonest ratio beyond this would make "eventually" a lie
      // in practice even though it is true in theory.
      expect(max / min).toBeLessThanOrEqual(20);
    }
  });

  it('favours the environments a region is supposed to favour', () => {
    const strongest = (region: RegionId): string => {
      let best = ENVIRONMENTS[0];
      if (!best) throw new Error('empty catalogue');
      for (const environment of ENVIRONMENTS) {
        if (effectiveDiscoveryWeight(environment, region) > effectiveDiscoveryWeight(best, region)) {
          best = environment;
        }
      }
      return best.id;
    };

    expect(strongest('arid-interior')).toBe('lantern_mesa');
    expect(strongest('boreal')).toBe('loonwater_narrows');
    expect(strongest('humid-subtropical')).toBe('cicada_bottoms');
    expect(strongest('maritime-east')).toBe('foxglove_fells');
  });
});
