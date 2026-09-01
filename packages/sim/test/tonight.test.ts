/**
 * That the roll reaches the world, and that it never rewrites it.
 *
 * Each of these functions hands a system an adjusted version of the content it
 * was going to be built from anyway, which makes the important properties easy
 * to state: a campsite that declares nothing about a dial gets its manifest
 * back untouched, and no adjustment can give a campsite weather, an animal or
 * a station its author did not put there.
 */

import { describe, expect, it } from 'vitest';
import {
  tonightsStillness,
  tonightsUndergrowth,
  varyRadioProfile,
  varyRoster,
  varyWater,
  varyWeatherProfile,
} from '../src/tonight.js';
import { NO_VARIATIONS, rollVariations, type SeededVariationSpec } from '../src/variation.js';
import { DEFAULT_WEATHER_PROFILE, type WeatherProfile } from '../src/weather.js';
import type { RadioProfileSpec } from '../src/radio.js';
import type { WaterFeatureSpec } from '../src/water.js';
import type { WildlifeSpecies } from '../src/wildlife.js';

const spec = (id: string, min: number, max: number): SeededVariationSpec => ({
  id,
  label: id,
  range: { min, max },
  unit: 'normalised',
  note: '',
});

/** Seeds that put a role near each end, found by searching rather than assumed. */
function seedsFor(specs: SeededVariationSpec[], role: Parameters<ReturnType<typeof rollVariations>['role']>[0]) {
  let low = 1;
  let high = 1;
  let lowest = Infinity;
  let highest = -Infinity;
  for (let seed = 1; seed < 500; seed++) {
    const value = rollVariations(specs, seed).role(role);
    if (value === null) continue;
    if (value < lowest) {
      lowest = value;
      low = seed;
    }
    if (value > highest) {
      highest = value;
      high = seed;
    }
  }
  return { low: rollVariations(specs, low), high: rollVariations(specs, high) };
}

const HAZE = [spec('marine_layer', 0, 1)];
const STORM = [spec('storm_distance', 20, 140)];
const RECEPTION = [spec('band_conditions', 0.3, 1)];
const LEVEL = [spec('creek_level', 0.35, 1)];
const COMPANY = [spec('jay_boldness', 0.3, 1)];

describe('the weather a campsite gets tonight', () => {
  it('is the campsite’s own profile when it declares no weather variation', () => {
    expect(varyWeatherProfile(DEFAULT_WEATHER_PROFILE, NO_VARIATIONS)).toBe(DEFAULT_WEATHER_PROFILE);
  });

  it('makes fog likelier on a hazy roll and clear likelier on a bright one', () => {
    const { low, high } = seedsFor(HAZE, 'air-haze');
    const foggy = varyWeatherProfile(DEFAULT_WEATHER_PROFILE, high);
    const bright = varyWeatherProfile(DEFAULT_WEATHER_PROFILE, low);
    expect(foggy.weights.fog!).toBeGreaterThan(bright.weights.fog!);
    expect(bright.weights.clear!).toBeGreaterThan(foggy.weights.clear!);
  });

  /*
   * The one property that keeps a variation from becoming a rewrite.
   *
   * A salt flat's manifest gives fog a weight of zero because it does not fog.
   * A haze roll of one must not turn that into a foggy night, or §5.4 stops
   * being "what is different tonight" and becomes "what campsite is this".
   */
  it('cannot give a campsite weather its manifest rules out', () => {
    const dry: WeatherProfile = {
      ...DEFAULT_WEATHER_PROFILE,
      weights: { clear: 6, 'high-cloud': 2, fog: 0 },
    };
    for (let seed = 1; seed < 200; seed++) {
      const varied = varyWeatherProfile(dry, rollVariations(HAZE, seed));
      expect(varied.weights.fog ?? 0).toBe(0);
      expect(varied.weights['light-rain']).toBeUndefined();
    }
  });

  it('turns the sky over faster when the storm is near', () => {
    const { low, high } = seedsFor(STORM, 'storm-distance');
    // High roll = far away = a slower night.
    const near = varyWeatherProfile(DEFAULT_WEATHER_PROFILE, low);
    const far = varyWeatherProfile(DEFAULT_WEATHER_PROFILE, high);
    expect(near.transitionSeconds).toBeLessThan(far.transitionSeconds);
    expect(near.weights['light-rain']!).toBeGreaterThan(far.weights['light-rain']!);
  });

  it('keeps the rare sky rare', () => {
    for (let seed = 1; seed < 200; seed++) {
      const varied = varyWeatherProfile(
        DEFAULT_WEATHER_PROFILE,
        rollVariations([spec('aurora_strength', 0, 1)], seed),
      );
      expect(varied.skyEventChance).toBeLessThanOrEqual(DEFAULT_WEATHER_PROFILE.skyEventChance * 1.9);
      expect(varied.skyEventChance).toBeGreaterThan(0);
    }
  });
});

describe('the dial tonight', () => {
  const dial: RadioProfileSpec = {
    stations: [],
    baseReception: 0.5,
    receptionNote: '',
    betweenStations: 'hiss',
  };

  it('is untouched where the campsite says nothing about the band', () => {
    expect(varyRadioProfile(dial, NO_VARIATIONS)).toBe(dial);
  });

  it('is better on a good night than a bad one, and never dead on either', () => {
    const { low, high } = seedsFor(RECEPTION, 'reception');
    const good = varyRadioProfile(dial, high);
    const bad = varyRadioProfile(dial, low);
    expect(good.baseReception).toBeGreaterThan(bad.baseReception);
    // A dial with nothing on it is a broken radio, not a variation.
    expect(bad.baseReception).toBeGreaterThan(0.25);
    expect(good.baseReception).toBeLessThanOrEqual(1);
  });
});

describe('the water tonight', () => {
  const creek: WaterFeatureSpec = {
    kind: 'creek',
    label: 'the creek',
    widthM: 4,
    flow: 'running',
    clarity: 0.7,
    fishable: true,
    skippable: false,
    note: '',
  };

  it('is untouched where the campsite says nothing about its level', () => {
    expect(varyWater(creek, NO_VARIATIONS)).toBe(creek);
  });

  it('is higher on a high roll, and never dries up entirely', () => {
    const { low, high } = seedsFor(LEVEL, 'water-level');
    expect(varyWater(creek, high).widthM).toBeGreaterThan(varyWater(creek, low).widthM);
    for (let seed = 1; seed < 200; seed++) {
      expect(varyWater(creek, rollVariations(LEVEL, seed)).widthM).toBeGreaterThan(2.5);
    }
  });

  it('keeps everything else about the feature exactly as authored', () => {
    const varied = varyWater(creek, rollVariations(LEVEL, 17));
    expect({ ...varied, widthM: creek.widthM }).toEqual(creek);
  });

  it('reads stillness as the middle where the campsite has no opinion', () => {
    expect(tonightsStillness(NO_VARIATIONS)).toBe(0.5);
  });
});

describe('what else is out tonight', () => {
  const roster: WildlifeSpecies[] = [
    {
      id: 'jay',
      label: 'a grey jay',
      shyness: 0.5,
      curiosity: 0.5,
      window: ['dusk'],
      attractedBy: [],
      repelledBy: [],
      canPersist: true,
      investigatesObjects: true,
      traces: [],
      note: '',
    },
  ];

  it('is the campsite’s own roster when nothing says otherwise', () => {
    expect(varyRoster(roster, NO_VARIATIONS)).toBe(roster);
  });

  it('is bolder on a lively night and shyer on a quiet one', () => {
    const { low, high } = seedsFor(COMPANY, 'company');
    expect(varyRoster(roster, high)[0]!.shyness).toBeLessThan(varyRoster(roster, low)[0]!.shyness);
    expect(varyRoster(roster, high)[0]!.curiosity).toBeGreaterThan(varyRoster(roster, low)[0]!.curiosity);
  });

  /*
   * An animal that never comes is a disappointment, not a variation. The
   * wildlife model already has half a dozen good reasons for one not to
   * appear; tonight's roll is not allowed to be a seventh.
   */
  it('never moves an animal far enough to make it unfindable', () => {
    for (let seed = 1; seed < 200; seed++) {
      const varied = varyRoster(roster, rollVariations(COMPANY, seed))[0]!;
      expect(Math.abs(varied.shyness - 0.5)).toBeLessThanOrEqual(0.13);
    }
  });

  /*
   * The catalogue has six species at 0.88 shyness or above, and one — the
   * black bear, which is in the roster as *sign* rather than as a bear — at
   * exactly 1.00. A flat shift would have rounded all six up to "you will only
   * ever hear it" on a quiet night, and dragged the bear down off its ceiling
   * on a lively one. An authored extreme is a statement about what this animal
   * is, and it is not tonight's to argue with.
   */
  it('leaves an animal authored at the end of the scale exactly where it is', () => {
    const extremes: WildlifeSpecies[] = [
      { ...roster[0]!, id: 'sign', shyness: 1, curiosity: 0 },
      { ...roster[0]!, id: 'tame', shyness: 0, curiosity: 1 },
    ];
    for (let seed = 1; seed < 200; seed++) {
      const varied = varyRoster(extremes, rollVariations(COMPANY, seed));
      expect(varied[0]!.shyness).toBe(1);
      expect(varied[0]!.curiosity).toBe(0);
      expect(varied[1]!.shyness).toBe(0);
      expect(varied[1]!.curiosity).toBe(1);
    }
  });

  it('barely moves the ones that are nearly there, and never past the end', () => {
    const owl: WildlifeSpecies[] = [{ ...roster[0]!, id: 'saw_whet_owl', shyness: 0.95 }];
    let widest = 0;
    for (let seed = 1; seed < 300; seed++) {
      const varied = varyRoster(owl, rollVariations(COMPANY, seed))[0]!;
      expect(varied.shyness).toBeLessThan(1);
      expect(varied.shyness).toBeGreaterThan(0.9);
      widest = Math.max(widest, Math.abs(varied.shyness - 0.95));
    }
    // About two hundredths: a rare bird being slightly rarer.
    expect(widest).toBeLessThan(0.03);
  });

  it('adds nothing to the roster and takes nothing off it', () => {
    const varied = varyRoster(roster, rollVariations(COMPANY, 3));
    expect(varied.map((s) => s.id)).toEqual(['jay']);
  });
});

describe('the low scatter tonight', () => {
  it('is exactly the manifest’s density where nothing varies it', () => {
    expect(tonightsUndergrowth(NO_VARIATIONS)).toBe(1);
    expect(tonightsUndergrowth()).toBe(1);
  });

  it('stays inside a range that still leaves a campsite in the picture', () => {
    for (let seed = 1; seed < 300; seed++) {
      const factor = tonightsUndergrowth(rollVariations([spec('grass_height', 0.6, 1.4)], seed));
      expect(factor).toBeGreaterThan(0.6);
      expect(factor).toBeLessThan(1.4);
    }
  });
});
