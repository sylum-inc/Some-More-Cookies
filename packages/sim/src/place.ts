/**
 * What a campsite is like, said when it is true.
 *
 * Every environment in the catalogue carries a paragraph of sensory writing
 * about itself: what the ground is, what shape the land is in, what the wind
 * does here and what it moves through, how cold it gets and what the frost is
 * like, whether there are insects, how the place sounds, and three or four
 * things you might hear a long way off. `WeatherCharacter`'s own docstring
 * says it "drives subtitles, Passport lines and the fire's exposure feel".
 * It drove nothing. Twelve campsites' worth of writing, in the manifests,
 * unreachable.
 *
 * The rule here is that a place remarks on itself only when the remark is
 * *true right now*: the wind note when the wind actually gets up, the cold
 * note when the night actually turns cold, the frost note when it actually
 * freezes. Each one lands once. A campsite that recited its own description on
 * arrival would be a loading screen with trees.
 */

import { clamp01 } from './math.js';
import type { Rng } from './rng.js';

/** Something you might hear a long way off. Content data. */
export interface DistantSoundSpec {
  readonly id: string;
  readonly label: string;
  /** Relative likelihood among this site's distant events. Positive. */
  readonly weight: number;
  /** Minimum seconds between two firings, so it stays rare. */
  readonly minGapSeconds: number;
  readonly note: string;
}

/** The campsite's own words about itself, from its manifest. */
export interface PlaceNotes {
  readonly ground?: string;
  readonly elevation?: string;
  readonly temperature?: string;
  readonly wind?: string;
  readonly exposure?: string;
  readonly insects?: string;
  readonly reverb?: string;
  /** Typical overnight low and high, °C. */
  readonly nightRangeC?: { readonly min: number; readonly max: number };
  readonly distant?: readonly DistantSoundSpec[];
}

export interface PlaceState {
  /** Remarks already made. Nothing is said twice. */
  readonly said: Set<string>;
  /** Seconds until this campsite may be heard from a distance again. */
  untilDistant: number;
  /** When each distant sound was last heard, so a rare one stays rare. */
  readonly lastHeard: Map<string, number>;
  /** Set for one step when the place has something to say. */
  remark: { id: string; telling: string } | null;
  /** Set for one step when something is heard a long way off. */
  heard: DistantSoundSpec | null;
  elapsed: number;
}

export function createPlace(): PlaceState {
  return {
    said: new Set<string>(),
    // Not immediately: a distant sound in the first ten seconds reads as a
    // cue rather than as a place carrying on with its evening.
    untilDistant: 95,
    lastHeard: new Map<string, number>(),
    remark: null,
    heard: null,
    elapsed: 0,
  };
}

/** Everything the remarks are conditioned on. Read-only, passed in each step. */
export interface PlaceConditions {
  /** Seconds since the session began. */
  elapsed: number;
  /** Which part of the night it is. */
  deepNight: boolean;
  temperatureC: number;
  windSpeed: number;
  precipitation: number;
  /** How far the player is from the fire, metres. */
  distanceFromFire: number;
  /** Whether the fire is currently being knocked about by the weather. */
  fireHarried: boolean;
}

/**
 * The one remark this campsite has earned the right to make right now.
 *
 * Ordered by how much it matters that you hear it: the ground under your feet
 * when you arrive, then the weather when the weather does something, then the
 * quiet things. Only ever one per step, and never the same one twice.
 */
function nextRemark(
  notes: PlaceNotes,
  said: ReadonlySet<string>,
  now: PlaceConditions,
): { id: string; telling: string } | null {
  const unsaid = (id: string, telling: string | undefined): { id: string; telling: string } | null =>
    telling && telling.length > 0 && !said.has(id) ? { id, telling } : null;

  // Frost first: it is the one that changes what you do next.
  if (now.temperatureC <= 0.5) {
    const frost = unsaid('frost', notes.temperature);
    if (frost && said.has('temperature')) return { id: 'frost', telling: frost.telling };
  }
  // The ground, once you have stood on it for a moment.
  if (now.elapsed > 8) {
    const ground = unsaid('ground', notes.ground);
    if (ground) return ground;
  }
  // The shape of the land, once you have walked through some of it.
  if (now.distanceFromFire > 5.5) {
    const elevation = unsaid('elevation', notes.elevation);
    if (elevation) return elevation;
  }
  // The wind, when the wind does something.
  if (now.windSpeed > 3.1) {
    const wind = unsaid('wind', notes.wind);
    if (wind) return wind;
  }
  // What this place does to a fire, when it is doing it.
  if (now.fireHarried) {
    const exposure = unsaid('exposure', notes.exposure);
    if (exposure) return exposure;
  }
  // The cold, when the night has actually turned cold.
  if (now.deepNight || (notes.nightRangeC && now.temperatureC <= notes.nightRangeC.min + 1.5)) {
    const temperature = unsaid('temperature', notes.temperature);
    if (temperature) return temperature;
  }
  // And the insects, on the kind of night that has any.
  if (now.temperatureC > 11 && now.windSpeed < 1.3 && now.precipitation < 0.05 && now.elapsed > 150) {
    const insects = unsaid('insects', notes.insects);
    if (insects) return insects;
  }
  return null;
}

/**
 * Advances the campsite's own voice by one step.
 *
 * Deterministic given the same conditions and the same random stream, like
 * everything else in this package: two clients at one fire hear the same owl.
 */
export function stepPlace(
  place: PlaceState,
  notes: PlaceNotes,
  now: PlaceConditions,
  dt: number,
  rng: Rng,
): void {
  place.elapsed += dt;
  place.remark = null;
  place.heard = null;

  const remark = nextRemark(notes, place.said, now);
  if (remark) {
    place.said.add(remark.id);
    place.remark = remark;
    return;
  }

  // Something a long way off. Never in the same breath as a remark: two
  // pieces of prose at once is a paragraph, and a night is not a paragraph.
  const distant = notes.distant ?? [];
  if (distant.length === 0) return;
  place.untilDistant -= dt;
  if (place.untilDistant > 0) return;

  const eligible = distant.filter((sound) => {
    const last = place.lastHeard.get(sound.id);
    return last === undefined || place.elapsed - last >= sound.minGapSeconds;
  });
  if (eligible.length === 0) {
    // Nothing is due. Ask again shortly rather than every step.
    place.untilDistant = 20;
    return;
  }
  const picked = rng.weightedPick(eligible, (sound) => Math.max(0.0001, sound.weight));
  if (!picked) return;
  place.lastHeard.set(picked.id, place.elapsed);
  place.heard = picked;
  // Rare on purpose. A campsite that produces a distant sound every minute is
  // a campsite with a sound effect, not a campsite in a landscape.
  place.untilDistant = rng.range(115, 290);
}

/**
 * The lines the survey should read out about this place right now.
 *
 * Different from the remarks above, which are said once as they become true.
 * A player who asks what is around them is asking now, and should be told
 * whatever is true now — including things they have already been told.
 */
export function surveyPlace(notes: PlaceNotes, now: PlaceConditions): string[] {
  const lines: string[] = [];
  if (notes.ground) lines.push(notes.ground);
  if (notes.elevation) lines.push(notes.elevation);
  if (notes.wind && now.windSpeed > 2.2) lines.push(notes.wind);
  if (notes.temperature && (now.deepNight || now.temperatureC < 6)) lines.push(notes.temperature);
  if (notes.insects && now.temperatureC > 11 && now.windSpeed < 1.6) lines.push(notes.insects);
  if (notes.reverb) lines.push(notes.reverb);
  return lines;
}

/**
 * How cold it is here, against what this campsite calls cold.
 *
 * Named for the place rather than `coldness`, which the SM-01 already owns and
 * means something entirely different by.
 */
export function nightColdness(notes: PlaceNotes, temperatureC: number): number {
  const range = notes.nightRangeC;
  if (!range || range.max <= range.min) return clamp01((10 - temperatureC) / 18);
  return clamp01((range.max - temperatureC) / (range.max - range.min));
}
