/**
 * What each thing in the world looks like on the heads-up display.
 *
 * The HUD used to be words. Walking up to the woodpile said "Take a log",
 * walking up to the machine said "The SM-01", and on a phone that produced
 * seven separate blocks of text stacked over the campsite — which is both a
 * lot of reading for something you do with a thumb, and a look with no
 * identity: grey boxes of system font over a hand-made world.
 *
 * So the world's nouns and verbs get pictures, and the only text left on
 * screen is the text that *is* the product: the campsite's own prose, which
 * nobody would want as an icon.
 *
 * This module is the mapping and nothing else — pure, so the whole vocabulary
 * can be checked for holes without a browser. A reach id with no sprite is a
 * player walking up to something and being shown nothing, so the test asserts
 * every id the world can produce has one.
 */

import type { SpriteName } from './sprites/atlas.js';

/**
 * The sprite for a thing you have walked up to.
 *
 * Keyed by the `Interactable` ids `locomotion` produces. Objects rather than
 * verbs on purpose: a picture of the thing is unambiguous, where a picture of
 * an action needs a caption to say what it acts on.
 */
export const REACH_SPRITES: Record<string, SpriteName> = {
  fire: 'verb-poke',
  woodpile: 'obj-log',
  marshmallows: 'obj-marshmallow',
  machine: 'obj-machine',
  plate: 'obj-plate',
  'log-seat': 'obj-seat',
  radio: 'obj-radio',
  torch: 'obj-torch',
  stones: 'obj-stone',
  'water-edge': 'obj-rod',
  rod: 'obj-rod',
};

/**
 * How the fire is doing, as one of four pictures.
 *
 * Four states, not a gauge. §5.3 forbids anything a player can read as a
 * score, and a bar that empties is a score however it is drawn — so this is a
 * picture of a fire that looks like the fire looks, and the player reads it
 * the way they read the actual pit.
 */
export function fireSprite(fire: { flame: number; emberMass: number }): SpriteName {
  if (fire.flame > 0.35) return 'state-fire-good';
  if (fire.flame > 0.08) return 'state-fire-low';
  if (fire.emberMass > 0.02) return 'state-fire-embers';
  return 'state-fire-out';
}

/** Which part of the day, for the corner glyph. */
export function timeSprite(window: string): SpriteName {
  switch (window) {
    case 'dawn':
      return 'state-time-dawn';
    case 'morning':
    case 'midday':
    case 'afternoon':
      return 'state-time-day';
    case 'dusk':
      return 'state-time-dusk';
    default:
      return 'state-time-night';
  }
}

/** What the sky is doing. */
export function weatherSprite(kind: string): SpriteName {
  switch (kind) {
    case 'light-rain':
    case 'rain':
      return 'state-weather-rain';
    case 'snow':
    case 'snow-squall':
      return 'state-weather-snow';
    case 'storm':
      return 'state-weather-storm';
    case 'fog':
      return 'state-weather-fog';
    case 'high-cloud':
    case 'overcast':
      return 'state-weather-cloud';
    case 'wind':
    case 'clear':
    default:
      return 'state-weather-clear';
  }
}

/**
 * The animal in a sighting, when one is known, so the subtitle can carry a
 * face rather than only a name.
 *
 * Falls back to a generic bird rather than to nothing: a species this table
 * has never heard of is still an animal, and showing no picture at the moment
 * something appears is worse than showing an approximate one.
 */
export function lifeSprite(speciesId: string): SpriteName {
  const id = speciesId.toLowerCase();
  if (id.includes('fox')) return 'life-fox';
  if (id.includes('owl')) return 'life-owl';
  if (id.includes('deer') && !id.includes('mouse')) return 'life-deer';
  if (id.includes('mouse') || id.includes('vole')) return 'life-mouse';
  if (id.includes('squirrel') || id.includes('chipmunk')) return 'life-squirrel';
  if (id.includes('moth')) return 'life-moth';
  if (id.includes('fish') || id.includes('trout')) return 'life-fish';
  return 'life-bird';
}

/**
 * The marshmallow itself, as one of six pictures.
 *
 * The heat readout used to be the word "browning" over an amber bar that
 * filled — a meter, forbidden by §5.3, and colour doing the work twice while
 * §12 asks for a channel that is not colour. A picture of the marshmallow is
 * how a person reads doneness at an actual fire, so it is how they read it
 * here; the word stays underneath as the channel that survives a colourblind
 * player and a screen reader alike.
 *
 * `burning` overrides the band, because a marshmallow that has caught is not a
 * hotter marshmallow — it is a different event, and it is the one the player
 * has about two seconds to act on.
 */
export function roastSprite(band: string, burning = false): SpriteName {
  if (burning) return 'state-roast-burning';
  switch (band) {
    case 'warm':
      return 'state-roast-warm';
    case 'toasting':
      return 'state-roast-toasting';
    case 'browning':
      return 'state-roast-browning';
    case 'scorching':
      return 'state-roast-scorching';
    case 'burning':
      return 'state-roast-burning';
    default:
      return 'state-roast-cold';
  }
}

/**
 * Which side of the sandwich a bite target is, as a picture of that bite.
 *
 * The eight targets used to be circles containing the numerals 1 to 8, which
 * is a counter on screen and reads as a progress bar broken into pieces. Each
 * is now the sandwich seen from above with the bite taken out of the direction
 * the target actually aims at, so the row communicates *where* rather than
 * *how many* — and a thumb can find the far side without counting to six.
 */
const BITE_SIDES: readonly SpriteName[] = [
  'bite-n',
  'bite-ne',
  'bite-e',
  'bite-se',
  'bite-s',
  'bite-sw',
  'bite-w',
  'bite-nw',
];

export function biteSprite(index: number): SpriteName {
  return BITE_SIDES[((index % BITE_SIDES.length) + BITE_SIDES.length) % BITE_SIDES.length]!;
}

/** How much of the s'more is left, read off the s'more and not off a count. */
export function sandwichSprite(bites: number, finished: boolean): SpriteName {
  if (finished) return 'state-bite-crumbs';
  if (bites >= 5) return 'state-bite-half';
  if (bites >= 1) return 'state-bite-nibbled';
  return 'state-bite-whole';
}
