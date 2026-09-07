/**
 * What an animal remembers about you, in two layers.
 *
 * The wildlife model already carries `individual.visits` and hands it to the
 * significance model so a sighting can be told as a first meeting or a fourth.
 * It changes nothing about the animal. A fox that has watched you sit still by
 * the same fire nine nights running bolts at exactly the distance it bolted on
 * the first, and the only thing nine visits buys is a different sentence.
 *
 * Two layers, because the two things a person actually learns are different
 * things. You get better at *being around foxes* — quieter, slower, further
 * back — and that travels with you to a campsite you have never seen. And a
 * particular fox at a particular fire gets used to *you*, which does not
 * travel anywhere, and is the deeper of the two. So: a shallow floor per
 * species, kept in the Passport; a real bond per individual, kept with the
 * campsite it belongs to.
 *
 * Neither is a number the player is shown. What familiarity does is let an
 * animal stand its ground where it would have run, which is the only readout
 * this ever gets: it came closer, and it stayed.
 */

import { clamp01 } from './math.js';

export interface Familiarity {
  /** Per species, everywhere you go. Shallow, and it travels with you. */
  readonly species: Readonly<Record<string, number>>;
  /** Per individual, at the campsite it lives at. Deeper, and it stays there. */
  readonly individuals: Readonly<Record<string, number>>;
}

export const NO_FAMILIARITY: Familiarity = { species: {}, individuals: {} };

/**
 * How far a species floor can take the edge off, in shyness units.
 *
 * Small on purpose. Being good with foxes is worth something at a fire you
 * have never sat at, and it is not worth as much as this fox knowing you.
 */
const SPECIES_WEIGHT = 0.12;

/** And how far an individual bond can, which is rather more. */
const INDIVIDUAL_WEIGHT = 0.3;

/** What one calm night with an animal is worth to the bond with it. */
const NIGHT_EARNS = 0.22;

/**
 * What it is worth to the species floor.
 *
 * A fifth, so that being good with foxes is the slow accumulation of a lot of
 * evenings with a lot of foxes rather than something a single night buys.
 */
const SPECIES_SHARE = 0.2;

/** And what a photograph taken without startling the subject is worth. */
const PHOTO_EARNS = 0.12;

/**
 * How shy this animal is of *this* player, given what it remembers.
 *
 * Takes the shyness the model already computed rather than the raw species
 * value, so boldness, curiosity and everything else stay exactly as they were
 * and this is the last word rather than a competing one.
 */
export function easedShyness(
  shyness: number,
  speciesId: string,
  individualId: string,
  familiarity: Familiarity = NO_FAMILIARITY,
): number {
  const floor = clamp01(familiarity.species[speciesId] ?? 0);
  const bond = clamp01(familiarity.individuals[individualId] ?? 0);
  return clamp01(shyness - floor * SPECIES_WEIGHT - bond * INDIVIDUAL_WEIGHT);
}

/**
 * A night that ended without the animal running.
 *
 * The whole earn condition, and it is deliberately not "time spent nearby":
 * an animal that fled is an animal that learned the opposite, and crediting
 * the minutes it spent being frightened of you would teach the player that
 * standing over a nervous fox is how you befriend it.
 */
export function rememberCalmNight(
  familiarity: Familiarity,
  speciesId: string,
  individualId: string,
): Familiarity {
  return earn(familiarity, speciesId, individualId, NIGHT_EARNS);
}

/**
 * A photograph of something that did not startle at being photographed.
 *
 * `photograph(ritual, subjects, flash)` already makes the flash a real trade —
 * it sets `presence.startle`, and a startled animal leaves. So this is only
 * ever reached by a picture taken carefully, which is the point: the
 * photograph mechanic and the recognition mechanic are the same mechanic seen
 * from two ends.
 */
export function rememberPhotograph(
  familiarity: Familiarity,
  speciesId: string,
  individualId: string,
): Familiarity {
  return earn(familiarity, speciesId, individualId, PHOTO_EARNS);
}

function earn(
  familiarity: Familiarity,
  speciesId: string,
  individualId: string,
  amount: number,
): Familiarity {
  const bond = clamp01((familiarity.individuals[individualId] ?? 0) + amount);
  const floor = clamp01((familiarity.species[speciesId] ?? 0) + amount * SPECIES_SHARE);
  return {
    species: { ...familiarity.species, [speciesId]: floor },
    individuals: { ...familiarity.individuals, [individualId]: bond },
  };
}

/**
 * Merges what was learned tonight into what was known before.
 *
 * Takes the larger of each, rather than adding: this runs every time the
 * client saves, which is on a timer, and a night's worth of familiarity must
 * not be worth more to a player who left the tab open.
 */
export function mergeFamiliarity(known: Familiarity, tonight: Familiarity): Familiarity {
  const species = { ...known.species };
  for (const [id, value] of Object.entries(tonight.species)) {
    species[id] = Math.max(species[id] ?? 0, value);
  }
  const individuals = { ...known.individuals };
  for (const [id, value] of Object.entries(tonight.individuals)) {
    individuals[id] = Math.max(individuals[id] ?? 0, value);
  }
  return { species, individuals };
}
