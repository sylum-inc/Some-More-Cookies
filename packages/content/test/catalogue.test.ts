import { describe, expect, it } from 'vitest';

import { QUIRK_POOL, WOOD_TYPES } from '@somemore/sim';
import {
  DEFAULT_ENVIRONMENT_ID,
  DYNAMIC_LIGHT_BUDGET,
  ENVIRONMENTS,
  MAX_CATALOGUE_SIZE,
  MID_TIER_DRAW_CALL_BUDGET,
  MID_TIER_TRIANGLE_BUDGET,
  MIN_CATALOGUE_SIZE,
  REGIONS,
  REVERB_SPACES,
  SKY_EVENTS,
  WEATHER_KINDS,
  assertValidCatalogue,
  environmentIds,
  getEnvironment,
  hasEnvironment,
  hexToLinearRgb,
  listEnvironments,
  requireEnvironment,
  validateCatalogue,
  validateEnvironment,
} from '@somemore/content';

describe('catalogue shape', () => {
  it('ships 10–12 environments (spec §5.4)', () => {
    expect(ENVIRONMENTS.length).toBeGreaterThanOrEqual(MIN_CATALOGUE_SIZE);
    expect(ENVIRONMENTS.length).toBeLessThanOrEqual(MAX_CATALOGUE_SIZE);
  });

  it('has no duplicate ids', () => {
    const ids = environmentIds();
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('uses ids the protocol can persist as an environmentId', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.id).toMatch(/^[a-z0-9_]+$/);
      expect(environment.id.length).toBeLessThanOrEqual(64);
    }
  });

  it('contains the protocol default environment', () => {
    expect(hasEnvironment(DEFAULT_ENVIRONMENT_ID)).toBe(true);
  });

  it('keeps a shore environment, which the sandwich classifier looks for', () => {
    // packages/sim/src/sandwich.ts awards the Driftwood class when the
    // environment id contains "shore".
    expect(ENVIRONMENTS.some((environment) => environment.id.includes('shore'))).toBe(true);
  });

  it('has unique, non-empty names and taglines', () => {
    const names = ENVIRONMENTS.map((environment) => environment.name);
    const taglines = ENVIRONMENTS.map((environment) => environment.tagline);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(taglines).size).toBe(taglines.length);
  });
});

describe('validation', () => {
  it('passes for the whole catalogue', () => {
    expect(validateCatalogue(ENVIRONMENTS)).toEqual([]);
    expect(() => assertValidCatalogue(ENVIRONMENTS)).not.toThrow();
  });

  it('passes for each manifest individually', () => {
    for (const environment of ENVIRONMENTS) {
      expect(validateEnvironment(environment)).toEqual([]);
    }
  });

  it('rejects a manifest with a bad id', () => {
    const broken = { ...(ENVIRONMENTS[0] as object), id: 'Pine Hollow' };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('.id'))).toBe(true);
  });

  it('rejects a zero discovery weight — that would lock an environment out', () => {
    const base = ENVIRONMENTS[0];
    if (!base) throw new Error('empty catalogue');
    const broken = { ...base, discovery: { ...base.discovery, weight: 0 } };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('discovery.weight'))).toBe(true);
  });

  it('rejects a regional affinity outside the clamp band', () => {
    const base = ENVIRONMENTS[0];
    if (!base) throw new Error('empty catalogue');
    const broken = {
      ...base,
      discovery: { ...base.discovery, affinities: { ...base.discovery.affinities, boreal: 0 } },
    };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('affinities.boreal'))).toBe(true);
  });

  it('rejects a secret that claims to gate something', () => {
    const base = ENVIRONMENTS[0];
    const secret = base?.secrets[0];
    if (!base || !secret) throw new Error('missing fixture');
    const broken = {
      ...base,
      secrets: [{ ...secret, gatesNothing: false }, ...base.secrets.slice(1)],
    };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('secrets[0].gatesNothing'))).toBe(true);
  });

  it('rejects a one-time secret that leaves no evidence behind', () => {
    const base = ENVIRONMENTS[0];
    const secret = base?.secrets[0];
    if (!base || !secret) throw new Error('missing fixture');
    const broken = {
      ...base,
      secrets: [{ ...secret, oneTime: true, leavesEvidence: null }, ...base.secrets.slice(1)],
    };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('secrets[0].leavesEvidence'))).toBe(true);
  });

  it('rejects an unknown wood id', () => {
    const base = ENVIRONMENTS[0];
    const source = base?.fuel.sources[0];
    if (!base || !source) throw new Error('missing fixture');
    const broken = { ...base, fuel: { ...base.fuel, sources: [{ ...source, woodId: 'ironwood' }] } };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('sources[0].woodId'))).toBe(true);
  });

  it('rejects a weather weight that is not a WeatherKind', () => {
    const base = ENVIRONMENTS[0];
    if (!base) throw new Error('empty catalogue');
    const broken = {
      ...base,
      weather: { ...base.weather, weights: { ...base.weather.weights, drizzle: 2 } },
    };
    const issues = validateEnvironment(broken);
    expect(issues.some((issue) => issue.path.endsWith('weights.drizzle'))).toBe(true);
  });

  it('rejects a catalogue with duplicate ids', () => {
    const first = ENVIRONMENTS[0];
    if (!first) throw new Error('empty catalogue');
    const issues = validateCatalogue([...ENVIRONMENTS.slice(0, 11), first]);
    expect(issues.some((issue) => issue.message.includes('duplicate environment id'))).toBe(true);
  });

  it('rejects a catalogue that is too small', () => {
    const issues = validateCatalogue(ENVIRONMENTS.slice(0, 3));
    expect(issues.some((issue) => issue.path === 'catalogue')).toBe(true);
  });

  it('throws with every problem listed', () => {
    expect(() => assertValidCatalogue([])).toThrow(/failed validation/);
  });
});

describe('fuels', () => {
  it('only references woods that exist in WOOD_TYPES', () => {
    const known = new Set(Object.keys(WOOD_TYPES));
    for (const environment of ENVIRONMENTS) {
      expect(environment.fuel.sources.length).toBeGreaterThanOrEqual(1);
      for (const source of environment.fuel.sources) {
        expect(known.has(source.woodId)).toBe(true);
        expect(source.weight).toBeGreaterThan(0);
        expect(Number.isFinite(source.weight)).toBe(true);
      }
    }
  });

  it('never lists the same wood twice at one campsite', () => {
    for (const environment of ENVIRONMENTS) {
      const ids = environment.fuel.sources.map((source) => source.woodId);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it('exercises every wood type somewhere in the catalogue', () => {
    const used = new Set(
      ENVIRONMENTS.flatMap((environment) => environment.fuel.sources.map((source) => source.woodId)),
    );
    for (const woodId of Object.keys(WOOD_TYPES)) {
      expect(used.has(woodId)).toBe(true);
    }
  });
});

describe('weather profiles', () => {
  it('weights only valid WeatherKinds, all positive', () => {
    for (const environment of ENVIRONMENTS) {
      const entries = Object.entries(environment.weather.weights);
      expect(entries.length).toBeGreaterThan(0);
      for (const [kind, weight] of entries) {
        expect(WEATHER_KINDS).toContain(kind);
        expect(typeof weight).toBe('number');
        expect(weight as number).toBeGreaterThan(0);
      }
    }
  });

  it('lists only real sky events, and never "none"', () => {
    for (const environment of ENVIRONMENTS) {
      for (const event of environment.weather.skyEvents) {
        expect(SKY_EVENTS).toContain(event);
        expect(event).not.toBe('none');
      }
    }
  });

  it('keeps exposure, sky-event chance and transition times sane', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.weather.exposure).toBeGreaterThanOrEqual(0);
      expect(environment.weather.exposure).toBeLessThanOrEqual(1);
      expect(environment.weather.skyEventChance).toBeGreaterThanOrEqual(0);
      expect(environment.weather.skyEventChance).toBeLessThanOrEqual(1);
      expect(environment.weather.transitionSeconds).toBeGreaterThan(0);
    }
  });

  it('gives each environment a distinct weather profile id', () => {
    const ids = ENVIRONMENTS.map((environment) => environment.weather.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('audio', () => {
  it('only uses reverb spaces the audio engine can build', () => {
    for (const environment of ENVIRONMENTS) {
      expect(REVERB_SPACES).toContain(environment.ambience.reverb);
    }
  });

  it('uses more than one reverb space across the catalogue', () => {
    const spaces = new Set(ENVIRONMENTS.map((environment) => environment.ambience.reverb));
    expect(spaces.size).toBeGreaterThanOrEqual(4);
  });

  it('gives every environment at least two distant sound events', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.ambience.distantEvents.length).toBeGreaterThanOrEqual(2);
      for (const event of environment.ambience.distantEvents) {
        expect(event.weight).toBeGreaterThan(0);
        expect(event.minGapSeconds).toBeGreaterThan(0);
      }
    }
  });
});

describe('content minimums', () => {
  it('gives every environment at least two secrets, all optional and gating nothing', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.secrets.length).toBeGreaterThanOrEqual(2);
      expect(environment.secrets.length).toBeLessThanOrEqual(4);
      for (const secret of environment.secrets) {
        expect(secret.optional).toBe(true);
        expect(secret.gatesNothing).toBe(true);
        if (secret.oneTime) {
          expect(typeof secret.leavesEvidence).toBe('string');
          expect((secret.leavesEvidence ?? '').length).toBeGreaterThan(0);
        } else {
          expect(secret.leavesEvidence).toBeNull();
        }
      }
    }
  });

  it('gives every environment at least one wildlife entry', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.wildlife.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every environment at least one individually persistent animal', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.wildlife.some((entry) => entry.canPersist)).toBe(true);
    }
  });

  it('gives every environment at least one radio station', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.radio.stations.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('gives every environment a signature activity and fire tending', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.activities.some((activity) => activity.prominence === 'signature')).toBe(true);
      expect(environment.activities.some((activity) => activity.id === 'fire-tending')).toBe(true);
    }
  });

  it('gives every environment at least two procedural variations and two invariants', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.procedural.variations.length).toBeGreaterThanOrEqual(2);
      expect(environment.procedural.invariants.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('SM-01 flavour', () => {
  it('only weights quirks that exist in QUIRK_POOL', () => {
    const known = new Set(QUIRK_POOL.map((quirk) => quirk.id));
    for (const environment of ENVIRONMENTS) {
      const entries = Object.entries(environment.machine.quirkWeights);
      expect(entries.length).toBeGreaterThan(0);
      for (const [quirkId, weight] of entries) {
        expect(known.has(quirkId)).toBe(true);
        expect(weight).toBeGreaterThan(0);
      }
    }
  });
});

describe('performance hints', () => {
  it('stays inside the mid-tier budgets from ARCHITECTURE.md §10', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.performance.midTierDrawCalls).toBeLessThanOrEqual(MID_TIER_DRAW_CALL_BUDGET);
      expect(environment.performance.midTierTriangles).toBeLessThanOrEqual(MID_TIER_TRIANGLE_BUDGET);
      expect(environment.performance.dynamicLights).toBeLessThanOrEqual(DYNAMIC_LIGHT_BUDGET);
      expect(environment.performance.lowTierCuts.length).toBeGreaterThanOrEqual(2);
    }
  });
});

describe('variety across the launch set (spec §5.4)', () => {
  it('covers warm and cold', () => {
    const bands = new Set(ENVIRONMENTS.map((environment) => environment.character.temperature));
    expect(bands.has('hot') || bands.has('warm')).toBe(true);
    expect(bands.has('cold') || bands.has('freezing')).toBe(true);
    expect(bands.size).toBeGreaterThanOrEqual(4);
  });

  it('covers wet and dry', () => {
    const bands = new Set(ENVIRONMENTS.map((environment) => environment.character.moisture));
    expect(bands.has('wet') || bands.has('damp')).toBe(true);
    expect(bands.has('arid') || bands.has('dry')).toBe(true);
    expect(bands.size).toBeGreaterThanOrEqual(4);
  });

  it('covers a range of altitudes', () => {
    const bands = new Set(ENVIRONMENTS.map((environment) => environment.character.altitude));
    expect(bands.size).toBeGreaterThanOrEqual(4);
  });

  it('covers a range of tree cover including none and canopy', () => {
    const covers = new Set(ENVIRONMENTS.map((environment) => environment.character.treeCover));
    expect(covers.has('none')).toBe(true);
    expect(covers.has('canopy')).toBe(true);
    expect(covers.size).toBeGreaterThanOrEqual(4);
  });

  it('includes environments with and without water, and several kinds of it', () => {
    const kinds = ENVIRONMENTS.map((environment) => environment.character.water);
    expect(kinds.filter((kind) => kind === 'none').length).toBeGreaterThanOrEqual(2);
    expect(new Set(kinds.filter((kind) => kind !== 'none')).size).toBeGreaterThanOrEqual(7);
  });

  it('gives every environment its own ground material', () => {
    const grounds = ENVIRONMENTS.map((environment) => environment.scene.ground);
    expect(new Set(grounds).size).toBe(ENVIRONMENTS.length);
  });

  it('keeps the eeriness mean where CONCEPTS.md says it is', () => {
    const levels = ENVIRONMENTS.map((environment) => environment.character.eeriness);
    const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    expect(mean).toBeCloseTo(3.2, 1);
  });

  it('spans eeriness without ever losing the cozy end', () => {
    const levels = ENVIRONMENTS.map((environment) => environment.character.eeriness);
    expect(Math.min(...levels)).toBeLessThanOrEqual(2);
    expect(Math.max(...levels)).toBeGreaterThanOrEqual(4);
    // A catalogue that skewed strange would fight the mood calibration (§2.2).
    const mean = levels.reduce((sum, level) => sum + level, 0) / levels.length;
    expect(mean).toBeLessThanOrEqual(3.6);
  });

  it('varies draw distance enormously, which is what makes places feel different', () => {
    const distances = ENVIRONMENTS.map((environment) => environment.scene.drawDistanceM);
    expect(Math.min(...distances)).toBeLessThanOrEqual(50);
    expect(Math.max(...distances)).toBeGreaterThanOrEqual(200);
  });
});

describe('lookup helpers', () => {
  it('lists every environment', () => {
    expect(listEnvironments()).toHaveLength(ENVIRONMENTS.length);
    expect(environmentIds()).toHaveLength(ENVIRONMENTS.length);
  });

  it('finds an environment by id', () => {
    const found = getEnvironment(DEFAULT_ENVIRONMENT_ID);
    expect(found?.id).toBe(DEFAULT_ENVIRONMENT_ID);
    expect(requireEnvironment(DEFAULT_ENVIRONMENT_ID)).toBe(found);
  });

  it('returns undefined for an unknown id and throws only when required', () => {
    expect(getEnvironment('atlantis')).toBeUndefined();
    expect(() => requireEnvironment('atlantis')).toThrow(/Unknown environment id/);
  });
});

describe('palette helper', () => {
  it('converts every authored night palette colour to linear RGB in range', () => {
    for (const environment of ENVIRONMENTS) {
      const palette = environment.scene.nightPalette;
      const colours = [
        palette.zenith,
        palette.horizon,
        palette.ground,
        palette.foliage,
        palette.rock,
        palette.fireGlow,
        palette.moonlight,
        palette.shadow,
        ...(palette.water ? [palette.water] : []),
      ];
      for (const colour of colours) {
        const [r, g, b] = hexToLinearRgb(colour);
        for (const channel of [r, g, b]) {
          expect(Number.isFinite(channel)).toBe(true);
          expect(channel).toBeGreaterThanOrEqual(0);
          expect(channel).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('regions', () => {
  it('only references known regions in affinity hints', () => {
    for (const environment of ENVIRONMENTS) {
      for (const region of Object.keys(environment.discovery.affinities)) {
        expect(REGIONS).toContain(region);
      }
    }
  });
});
