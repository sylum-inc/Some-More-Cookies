import { describe, expect, it } from 'vitest';

import { QUIRK_POOL, VARIATION_ROLES, WOOD_TYPES } from '@somemore/sim';
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
  hasAuthorAside,
  hexToLinearRgb,
  inWorld,
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

describe('what makes each campsite itself', () => {
  /**
   * These are the fields that reach a player as the difference between one
   * place and another. Each of them was, for most of this project's life,
   * written and wired to nothing — so what is being guarded here is not the
   * values but the fact that they are *not all the same value*. A catalogue
   * whose twelve campsites agree about everything is a catalogue with one
   * campsite in it.
   */
  it('gives every campsite its own firelight', () => {
    const glows = new Set(ENVIRONMENTS.map((e) => e.scene.nightPalette.fireGlow));
    expect(glows.size).toBeGreaterThan(ENVIRONMENTS.length / 2);
    for (const environment of ENVIRONMENTS) {
      // Firelight, in a form three.js can take straight from the manifest.
      expect(environment.scene.nightPalette.fireGlow).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('gives every campsite its own arrival, in five beats', () => {
    for (const environment of ENVIRONMENTS) {
      const arrival = environment.arrival;
      for (const beat of [arrival.approach, arrival.firstHeard, arrival.firstSeen, arrival.underfoot, arrival.arrivalBeat]) {
        expect(beat.length, `${environment.id} has a beat nobody wrote`).toBeGreaterThan(30);
      }
      expect(arrival.walkSeconds.min).toBeGreaterThan(0);
    }
    // And no two campsites open on the same line.
    const openings = new Set(ENVIRONMENTS.map((e) => e.arrival.firstHeard));
    expect(openings.size).toBe(ENVIRONMENTS.length);
  });

  it('gives every campsite named things with something to say', () => {
    for (const environment of ENVIRONMENTS) {
      expect(environment.scene.landmarks.length, `${environment.id} has no landmarks`).toBeGreaterThan(1);
      for (const landmark of environment.scene.landmarks) {
        expect(landmark.note.length, `${landmark.id} has nothing to say`).toBeGreaterThan(20);
        expect(landmark.label.length).toBeGreaterThan(2);
      }
    }
  });

  it('gives every campsite a soundscape of its own', () => {
    const fingerprints = new Set(
      ENVIRONMENTS.map((e) =>
        [
          e.ambience.wind.character,
          e.ambience.wind.baseLevel.toFixed(2),
          e.ambience.insectDensity.toFixed(2),
          e.ambience.waterPresence.toFixed(2),
          e.ambience.reverb,
        ].join('/'),
      ),
    );
    expect(fingerprints.size).toBe(ENVIRONMENTS.length);
    for (const environment of ENVIRONMENTS) {
      expect(environment.ambience.distantEvents.length, `${environment.id} is never heard from`).toBeGreaterThan(1);
      expect(environment.ambience.wind.material.length).toBeGreaterThan(4);
    }
  });

  it('gives every campsite an opinion about its own SM-01', () => {
    for (const environment of ENVIRONMENTS) {
      expect(Object.keys(environment.machine.quirkWeights).length, `${environment.id} has no opinion`).toBeGreaterThan(0);
      expect(environment.machine.flavourNote.length).toBeGreaterThan(30);
      expect(environment.machine.stickerHint.length).toBeGreaterThan(4);
      expect(environment.machine.frostNote.length).toBeGreaterThan(20);
    }
  });
});

/**
 * The half of ARCHITECTURE §9.1 that a schema cannot enforce.
 *
 * A field can be validated into existence — `validate.ts` does that — without
 * anything ever reading it. These tests are the other half: they hold the
 * catalogue and the code that consumes it against each other, so that a new
 * variation, a new activity note or a campsite whose cover contradicts its sky
 * is a failing test rather than a paragraph nobody sees.
 */
describe('every authored field reaches somebody', () => {
  /*
   * The guard on §5.4.
   *
   * `VARIATION_ROLES` in `packages/sim` is exhaustive over the catalogue by
   * construction: a variation is either mapped to a dial the simulation turns
   * or explicitly recorded as driving nothing. Adding one to a manifest
   * without deciding which it is fails here rather than shipping as another
   * range that never gets rolled.
   */
  it('has decided what each of its sixty variations does', () => {
    const undecided: string[] = [];
    for (const environment of ENVIRONMENTS) {
      for (const variation of environment.procedural.variations) {
        if (!(variation.id in VARIATION_ROLES)) undecided.push(`${environment.id}/${variation.id}`);
      }
    }
    expect(undecided, 'unmapped variations — add them to VARIATION_ROLES').toEqual([]);
  });

  it('carries no role mapping for a variation no campsite declares', () => {
    const declared = new Set(
      ENVIRONMENTS.flatMap((environment) => environment.procedural.variations.map((v) => v.id)),
    );
    const orphaned = Object.keys(VARIATION_ROLES).filter((id) => !declared.has(id));
    expect(orphaned, 'role mappings for variations nothing declares').toEqual([]);
  });

  it('actually turns most of what it declares', () => {
    const all = ENVIRONMENTS.flatMap((environment) => environment.procedural.variations);
    const wired = all.filter((v) => VARIATION_ROLES[v.id] != null);
    expect(wired.length / all.length).toBeGreaterThan(0.7);
  });

  it('gives every campsite at least one variation that does something', () => {
    for (const environment of ENVIRONMENTS) {
      const wired = environment.procedural.variations.filter((v) => VARIATION_ROLES[v.id] != null);
      expect(wired.length, `${environment.id} varies nothing`).toBeGreaterThanOrEqual(3);
    }
  });

  /*
   * The two axes that describe the same thing from opposite sides.
   *
   * `treeCover` says how much canopy there is; `skyOpenness` says how much sky
   * is left. They are authored independently and they had better agree, or the
   * renderer is reading one of them and drawing a place the other describes.
   */
  it('keeps a campsite’s canopy and its sky openness in agreement', () => {
    const CEILING: Record<string, number> = {
      none: 1.01,
      sparse: 1.01,
      open: 0.95,
      moderate: 0.85,
      dense: 0.55,
      canopy: 0.3,
    };
    const FLOOR: Record<string, number> = {
      none: 0.7,
      sparse: 0.55,
      open: 0.4,
      moderate: 0.2,
      dense: 0.05,
      canopy: 0,
    };
    for (const environment of ENVIRONMENTS) {
      const cover = environment.character.treeCover;
      const sky = environment.scene.skyOpenness;
      expect(sky, `${environment.id} is ${cover} but claims ${sky} sky`).toBeLessThanOrEqual(
        CEILING[cover] as number,
      );
      expect(sky, `${environment.id} is ${cover} but claims only ${sky} sky`).toBeGreaterThanOrEqual(
        FLOOR[cover] as number,
      );
    }
  });

  it('spans the cover axis rather than clustering on one value', () => {
    const covers = new Set(ENVIRONMENTS.map((environment) => environment.character.treeCover));
    expect(covers.size).toBeGreaterThanOrEqual(4);
  });
});

/**
 * What a player is actually told, out of notes written in two voices.
 *
 * About a fifth of the catalogue's activity notes carry a sentence addressed
 * to the team rather than to the person at the fire — "the most patient
 * activity in the game and people love it", "the reference implementation",
 * "the shot this environment exists to produce". Those are worth keeping: they
 * are the clearest record anywhere of what each campsite is *for*. They must
 * not be read out at a campfire, and once the client started showing activity
 * notes as notices, they were.
 *
 * These pin the split, so that what a player hears is something a person read.
 */
const ARTEFACT = /\b(the game|the catalogue|the product|this environment)\b/i;

describe('the voice a note is written in', () => {
  it('never tells a player about the game, the catalogue or the product', () => {
    const leaked: string[] = [];
    for (const environment of ENVIRONMENTS) {
      for (const activity of environment.activities) {
        const shown = inWorld(activity.note);
        if (/\b(the game|the catalogue|the product|this environment)\b/i.test(shown)) {
          leaked.push(`${environment.id}/${activity.id}: ${shown}`);
        }
      }
    }
    expect(leaked).toEqual([]);
  });

  it('leaves the great majority of every note intact', () => {
    let kept = 0;
    let total = 0;
    for (const environment of ENVIRONMENTS) {
      for (const activity of environment.activities) {
        total += activity.note.length;
        kept += inWorld(activity.note).length;
      }
    }
    expect(kept / total).toBeGreaterThan(0.82);
  });

  /*
   * Silence is a valid answer, and the catalogue does not currently need it.
   *
   * Four notes used to be a single sentence that was half description and half
   * appraisal — "firelight on straight trunks is the most forgiving light in
   * the catalogue" — and the filter, which works a sentence at a time, took
   * the whole thing. Splitting each into two sentences kept both halves and
   * gave the player the first. So every activity in the catalogue now has
   * something a person at a fire may hear, and a new one that does not is a
   * sentence away from having one.
   */
  it('leaves every activity with something a player may hear', () => {
    const silent = ENVIRONMENTS.flatMap((environment) =>
      environment.activities
        .filter((activity) => inWorld(activity.note).length === 0)
        .map((activity) => `${environment.id}/${activity.id}`),
    );
    expect(
      silent,
      'these notes are entirely design commentary — split the description out into its own sentence',
    ).toEqual([]);
  });

  it('leaves every signature activity with something to say', () => {
    for (const environment of ENVIRONMENTS) {
      const signature = environment.activities.find((a) => a.prominence === 'signature');
      expect(signature, `${environment.id} has no signature activity`).toBeDefined();
      expect(
        inWorld(signature!.note).length,
        `${environment.id}'s signature activity says nothing a player may hear`,
      ).toBeGreaterThan(20);
      expect(signature!.label.length).toBeGreaterThan(3);
    }
  });

  /*
   * The activity notes were where this was found; they were not where it
   * lived.
   *
   * The first pass filtered `activities[].note` and stopped there, and the
   * end-to-end survey test promptly read a player two sentences from the
   * cicada bottoms' own ambience prose: "that silence is the eeriest sound in
   * the game", and "which is why the environment feels sheltered". The problem
   * was never the activity list — it is that *every* authored string can end
   * up in front of somebody, and 386 of them do.
   *
   * So this covers all of them: the ground and elevation notes, the weather
   * character, the ambience, every distant sound, all five arrival beats,
   * every landmark, every firewood source, every animal, the SM-01's own
   * flavour, and the activities. `worldContent.ts` is where the filter is
   * applied on the way to the simulation, and `App.tsx` applies it to the
   * arrival, which the simulation never sees.
   */
  it('keeps the artefact out of all 386 player-facing strings', () => {
    const leaked: string[] = [];
    let checked = 0;
    let fieldsWereStrings = 0;
    for (const environment of ENVIRONMENTS) {
      const fields: [string, string][] = [
        ['scene.groundNote', environment.scene.groundNote],
        ['scene.elevationNote', environment.scene.elevationNote],
        ['weatherCharacter.temperatureNote', environment.weatherCharacter.temperatureNote],
        ['weatherCharacter.windNote', environment.weatherCharacter.windNote],
        ['weatherCharacter.exposureNote', environment.weatherCharacter.exposureNote],
        ['ambience.insectNote', environment.ambience.insectNote],
        ['ambience.reverbNote', environment.ambience.reverbNote],
        ['arrival.approach', environment.arrival.approach],
        ['arrival.firstHeard', environment.arrival.firstHeard],
        ['arrival.firstSeen', environment.arrival.firstSeen],
        ['arrival.underfoot', environment.arrival.underfoot],
        ['arrival.arrivalBeat', environment.arrival.arrivalBeat],
        ['machine.flavourNote', environment.machine.flavourNote],
        ['machine.frostNote', environment.machine.frostNote],
        ['machine.stickerHint', environment.machine.stickerHint],
        ...environment.ambience.distantEvents.map(
          (event, i): [string, string] => [`ambience.distantEvents[${i}]`, event.note],
        ),
        ...environment.scene.landmarks.map(
          (landmark, i): [string, string] => [`scene.landmarks[${i}]`, landmark.note],
        ),
        ...environment.fuel.sources.map(
          (source, i): [string, string] => [`fuel.sources[${i}]`, source.foundAs],
        ),
        ...environment.wildlife.map(
          (species): [string, string] => [`wildlife.${species.id}`, species.note],
        ),
        ...environment.activities.map(
          (activity): [string, string] => [`activities.${activity.id}`, activity.note],
        ),
      ];
      for (const [path, text] of fields) {
        checked++;
        // A typo in the list above would silently check nothing — the first
        // draft of this test read `weatherCharacter.frostNote`, which is not a
        // field, and got `undefined` twelve times.
        if (typeof text === 'string' && text.length > 0) fieldsWereStrings++;
        const shown = inWorld(text);
        if (ARTEFACT.test(shown)) leaked.push(`${environment.id}/${path}: ${shown}`);
        // And nothing may be filtered away to nothing: an authored string that
        // is entirely commentary leaves a player with silence where the
        // catalogue promised a sentence. Split it in the manifest instead.
        if (shown.length === 0) leaked.push(`${environment.id}/${path}: (nothing left)`);
      }
    }
    expect(checked).toBeGreaterThan(350);
    expect(fieldsWereStrings, 'a field name in this list does not exist').toBe(checked);
    expect(leaked).toEqual([]);
  });

  it('does not cut a sticker in half at an abbreviation', () => {
    // "DEPT. OF PARKS · CLEARED, ..." was split after "DEPT." by a naive
    // sentence rule, and the filter kept the abbreviation and dropped the
    // sticker.
    expect(inWorld('DEPT. OF PARKS · CLEARED, and a stamp under it.')).toBe(
      'DEPT. OF PARKS · CLEARED, and a stamp under it.',
    );
  });

  it('is a no-op on a note written entirely in the world', () => {
    const clean = 'Dry twigs under the young firs, always.';
    expect(inWorld(clean)).toBe(clean);
    expect(hasAuthorAside(clean)).toBe(false);
  });

  it('finds the aside where there is one', () => {
    expect(hasAuthorAside('Two returns. This is the reason the audio engine exists.')).toBe(true);
    expect(inWorld('Two returns. This is the reason the audio engine exists.')).toBe('Two returns.');
  });
});
