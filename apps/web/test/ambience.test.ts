/**
 * What a campsite sounds like.
 *
 * Every environment in the catalogue has had a written soundscape since the
 * content was authored — a wind character and what that wind moves through, an
 * insect density, how much of the bed is moving water, a reverb space, and the
 * level of its quiet floor. The audio bridge used one hardcoded preset for all
 * twelve of them, so a snowfield with no insects and a canyon with a river in
 * it came out as the same bed of pine wind.
 */
import { describe, expect, it } from 'vitest';
import { ambienceFromCampsite, type CampsiteAmbienceSpec } from '../src/audio/ambience.js';
import { listEnvironments, getEnvironment } from '@somemore/content';

const PINE: CampsiteAmbienceSpec = {
  wind: { character: 'breathing', baseLevel: 0.22, gustiness: 0.3, material: 'pine needles, thirty feet up' },
  insectDensity: 0.45,
  waterPresence: 0.55,
  reverb: 'openForest',
  nightFloorDb: -52,
};

const SNOWFIELD: CampsiteAmbienceSpec = {
  wind: { character: 'katabatic', baseLevel: 0.5, gustiness: 0.16, material: 'bare rock and old snow, nothing to catch it' },
  insectDensity: 0,
  waterPresence: 0,
  reverb: 'snowfield',
  nightFloorDb: -68,
};

describe('a campsite’s own soundscape', () => {
  it('sounds like two different places', () => {
    const pine = ambienceFromCampsite('pine', PINE);
    const snow = ambienceFromCampsite('snow', SNOWFIELD);

    // Wind through needles is a different sound from wind over bare rock.
    expect(pine.wind.throughTrees).toBeGreaterThan(snow.wind.throughTrees + 0.4);
    // A snowfield in winter has no chorus, and a wood in summer does.
    expect(pine.insects.density).toBeGreaterThan(0.3);
    expect(snow.insects.density).toBe(0);
    // A creek behind the site is in the mix; a dry site has no water at all.
    expect(pine.water.enabled).toBe(true);
    expect(snow.water.enabled).toBe(false);
    // And snow eats sound where a forest merely absorbs it.
    expect(snow.reverb.space).toBe('snowfield');
    expect(snow.reverb.wet).toBeLessThan(pine.reverb.wet);
    // A quieter stated floor is a quieter floor.
    expect(snow.roomTone.level).toBeLessThan(pine.roomTone.level);
  });

  it('reads the wind’s material out of the prose it was written in', () => {
    const through = (material: string) =>
      ambienceFromCampsite('x', { ...PINE, wind: { ...PINE.wind, material } }).wind.throughTrees;
    expect(through('pine needles, thirty feet up')).toBeGreaterThan(through('dry grass and the tarp'));
    expect(through('dry grass and the tarp')).toBeGreaterThan(through('bare rock, nothing to catch it'));
    // Something nobody anticipated still lands somewhere reasonable.
    expect(through('the ironwork of the bridge')).toBeGreaterThan(0);
    expect(through('the ironwork of the bridge')).toBeLessThan(1);
  });

  it('keeps every campsite in the catalogue inside a safe mix', () => {
    for (const summary of listEnvironments()) {
      const environment = getEnvironment(summary.id);
      if (!environment) continue;
      const profile = ambienceFromCampsite(environment.id, {
        wind: environment.ambience.wind,
        insectDensity: environment.ambience.insectDensity,
        waterPresence: environment.ambience.waterPresence,
        reverb: environment.ambience.reverb,
        nightFloorDb: environment.ambience.nightFloorDb,
      });
      for (const level of [profile.wind.level, profile.insects.density, profile.water.level, profile.roomTone.level]) {
        expect(level).toBeGreaterThanOrEqual(0);
        expect(level).toBeLessThanOrEqual(1);
      }
      // A campsite that is never audible is not a soundscape.
      expect(profile.roomTone.level).toBeGreaterThan(0);
      expect(profile.wind.cutoffHz).toBeGreaterThan(20);
    }
  });

  it('the twelve of them are genuinely not one campsite', () => {
    const fingerprints = new Set<string>();
    for (const summary of listEnvironments()) {
      const environment = getEnvironment(summary.id);
      if (!environment) continue;
      const p = ambienceFromCampsite(environment.id, {
        wind: environment.ambience.wind,
        insectDensity: environment.ambience.insectDensity,
        waterPresence: environment.ambience.waterPresence,
        reverb: environment.ambience.reverb,
        nightFloorDb: environment.ambience.nightFloorDb,
      });
      fingerprints.add(
        [
          p.wind.level.toFixed(2),
          p.wind.throughTrees.toFixed(2),
          p.insects.density.toFixed(2),
          p.water.level.toFixed(2),
          p.reverb.space,
        ].join('/'),
      );
    }
    // Not a single one of them collapses onto another.
    expect(fingerprints.size).toBe(listEnvironments().length);
  });
});
