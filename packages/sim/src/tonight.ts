/**
 * Tonight's roll, applied to the specs the world is built from (spec §5.4).
 *
 * `variation.ts` decides *what* is different about this visit; this decides
 * *how* the difference gets in. The trick is that none of it reaches into a
 * running system: each function here takes the content spec a system is about
 * to be constructed from and returns an adjusted copy of it. The weather model
 * does not know that tonight is a foggy one — it is handed a campsite whose
 * fog is likelier, and behaves exactly as it always has.
 *
 * That keeps three things true at once. The systems stay unaware of §5.4 and
 * stay testable in isolation; the adjustment is a pure function of the roll,
 * so a seed replays a night exactly (ADR-0001); and every adjustment is
 * bounded and *conservative*, because a variation is meant to make a place
 * worth returning to, not to make it unrecognisable. A campsite that declares
 * no variation for a role gets its manifest back untouched.
 */

import { clamp, clamp01, lerp } from './math.js';
import type { RadioProfileSpec } from './radio.js';
import { NO_VARIATIONS, scale, type VariationSet } from './variation.js';
import type { WaterFeatureSpec } from './water.js';
import type { WeatherKind, WeatherProfile } from './weather.js';
import type { WildlifeSpecies } from './wildlife.js';

/**
 * Fog, cloud and how far off the weather is.
 *
 * Three roles land here. `air-haze` leans the campsite's own weather weights
 * toward fog and overcast — leans, never forces: a haze roll of 1 at a place
 * whose manifest gives fog a weight of zero still produces no fog, because the
 * manifest is the authority on what weather this place *has*. `storm-distance`
 * is read as "how far off it is", so a near storm turns the weather over
 * faster and makes rain likelier. `sky-activity` is the aurora and the rest of
 * the rare sky, and only ever multiplies a chance the campsite already has.
 */
export function varyWeatherProfile(profile: WeatherProfile, set: VariationSet): WeatherProfile {
  const haze = set.role('air-haze');
  const storm = set.role('storm-distance');
  const sky = set.role('sky-activity');
  if (haze === null && storm === null && sky === null) return profile;

  const weights: Partial<Record<WeatherKind, number>> = { ...profile.weights };
  const lean = (kind: WeatherKind, factor: number): void => {
    const current = weights[kind];
    if (current === undefined || current <= 0) return;
    weights[kind] = current * factor;
  };
  if (haze !== null) {
    lean('fog', lerp(0.45, 2.4, haze));
    lean('overcast', lerp(0.7, 1.5, haze));
    lean('clear', lerp(1.35, 0.6, haze));
  }
  if (storm !== null) {
    // High roll = far away.
    const near = 1 - storm;
    lean('light-rain', lerp(0.6, 1.9, near));
    lean('wind', lerp(0.75, 1.5, near));
  }

  return {
    ...profile,
    weights,
    ...(sky === null ? {} : { skyEventChance: clamp01(profile.skyEventChance * lerp(0.5, 1.9, sky)) }),
    ...(storm === null
      ? {}
      : {
          // A storm two hours out changes the sky slowly; one over the next
          // ridge changes it while you watch.
          transitionSeconds: clamp(profile.transitionSeconds * lerp(0.62, 1.3, storm), 70, 500),
        }),
  };
}

/**
 * What the aerial can hear tonight.
 *
 * `am_skip`, `band_conditions` and `inversion_strength` all say the same thing
 * in three vocabularies — an inversion layer, ionospheric skip and a quiet
 * magnetometer are each "the band is long tonight". The floor is deliberately
 * well above zero: a dial with nothing on it is not a variation, it is a
 * broken radio.
 */
export function varyRadioProfile(spec: RadioProfileSpec, set: VariationSet): RadioProfileSpec {
  const reception = set.role('reception');
  if (reception === null) return spec;
  return { ...spec, baseReception: clamp(spec.baseReception * lerp(0.68, 1.32, reception), 0.12, 1) };
}

/**
 * How much water there is.
 *
 * `widthM` is the manifest's word for how much of this feature there is, and
 * it is what the shore, the basin the player wades into and the fetch the wind
 * blows across are all derived from — so a high creek genuinely does raise the
 * water bed, which is `creek_level`'s note verbatim.
 */
export function varyWater(spec: WaterFeatureSpec, set: VariationSet): WaterFeatureSpec {
  const level = set.role('water-level');
  if (level === null) return spec;
  return { ...spec, widthM: Math.max(0.6, spec.widthM * lerp(0.72, 1.28, level)) };
}

/**
 * How much else is out tonight.
 *
 * `shyness` is the roster's own word for rarity, so `company` moves it — and
 * moves it *gently*, an eighth at most. A fox that never comes is a
 * disappointment rather than a variation, and the wildlife model already has
 * every other reason an animal might not appear.
 *
 * The shift is scaled by `headroom`, which is the point of this function
 * rather than a detail of it. An animal authored at the end of the scale is
 * making a statement — `black_bear_sign` is shyness 1.00 because a bear is a
 * thing you find the sign of and never the bear, and something at 0 walks up
 * to you — and a night's roll has no business arguing with either. So the
 * extremes do not move at all, the middle moves by an eighth, and everything
 * in between moves by how much room it has: the saw-whet owl at 0.95 shifts by
 * about two hundredths, which is a rare bird being slightly rarer rather than
 * a rare bird becoming impossible.
 */
export function varyRoster(
  roster: readonly WildlifeSpecies[],
  set: VariationSet,
): readonly WildlifeSpecies[] {
  const company = set.role('company');
  if (company === null || roster.length === 0) return roster;
  const shyer = lerp(0.125, -0.125, company);
  return roster.map((species) => ({
    ...species,
    shyness: clamp01(species.shyness + shyer * headroom(species.shyness)),
    curiosity: clamp01(species.curiosity - shyer * 0.6 * headroom(species.curiosity)),
  }));
}

/** 1 in the middle of a 0..1 dial, 0 at either end, and smooth between. */
function headroom(value: number): number {
  return clamp01(4 * value * (1 - value));
}

/**
 * How still the surface lies, 0..1, for `createWater`.
 *
 * Returned rather than folded into the spec because stillness is not a
 * property of the water feature — a tarn is a tarn on every visit; what
 * changes is whether tonight's is a mirror. Defaults to 0.5, which leaves the
 * surface exactly where the flow character puts it.
 */
export function tonightsStillness(set: VariationSet): number {
  return set.roleOr('water-stillness', 0.5);
}

/**
 * How thick the low scatter is, as a multiplier on the manifest's densities.
 *
 * Read by the client rather than the simulation, because the understorey is
 * drawn and never simulated. Bounded either side of 1 so that a thin night
 * still has ground cover and a thick one still has a campsite in it.
 */
export function tonightsUndergrowth(set: VariationSet = NO_VARIATIONS): number {
  return scale(set, 'undergrowth', 0.38);
}
