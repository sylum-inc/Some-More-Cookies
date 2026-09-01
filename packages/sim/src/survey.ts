/**
 * What is around you, in words (audit A5, spec §12).
 *
 * The product narrates *change*: the guidance line, the heat reading, the
 * subtitles, and the machine's own live region all say what just happened. None
 * of that answers the question somebody who cannot see the screen actually has
 * on arriving, which is "what is here". A campsite you can only learn about by
 * bumping into things is not a place you can be in.
 *
 * So this is the survey: asked for, never volunteered, and composed from the
 * same world the renderer draws — the walkable world's own interactables, the
 * fire's own state, the animals the simulation says are present. Nothing here
 * is a second description that could drift from the first.
 *
 * Pure and DOM-free, so it can be read in a unit test rather than only heard.
 *
 * Two deliberate restraints:
 *
 *  - **It does not give bearings in degrees.** "Behind you and to the left" is
 *    what a person at a fire would say, and a number would be precision this
 *    world does not have.
 *  - **It does not list everything.** A survey that reads out twenty things is
 *    one nobody listens to twice. Things in reach come first, because they are
 *    what you can act on; then the fire, because it is why you are here; then
 *    what is close enough to walk to; then the night around it.
 */

import { isEmberBed } from './fire.js';
import { surveyPlace } from './place.js';
import { focused, reachable, type PlayerState, type WalkableWorld } from './locomotion.js';
import { animalsPresent, type RitualState } from './ritual.js';

/** What each thing is called when it is being pointed out rather than used. */
const NAMES: Record<string, string> = {
  fire: 'the fire',
  woodpile: 'the woodpile',
  machine: 'the SM-01',
  marshmallows: 'the bag of marshmallows',
  plate: 'the plate',
  'log-seat': 'the log',
  radio: 'the radio',
  torch: 'the torch',
  stones: 'a scatter of flat stones',
  'water-edge': 'the water',
  rod: 'the fishing rod',
};

function nameOf(id: string): string {
  return NAMES[id] ?? id.replace(/-/g, ' ');
}

/**
 * What the named places are called out loud.
 *
 * The presence model's ids are identifiers — `water-edge`, `fireside` — and
 * the first version of this read one straight into a sentence: "You are in
 * water-edge." A survey is prose or it is nothing, so an id with no phrasing
 * here is left out rather than mangled into English.
 */
const PLACES: Record<string, string> = {
  fireside: 'by the fire',
  'water-edge': "at the water's edge",
};

/**
 * Where something is, relative to where the player is facing.
 *
 * Eight compass points of the player's own body rather than of the world,
 * because "north" means nothing standing at a fire in the dark.
 */
export function relativeBearing(player: PlayerState, x: number, z: number): string {
  const angle = Math.atan2(z - player.position.z, x - player.position.x);
  let delta = angle - player.facing;
  while (delta > Math.PI) delta -= Math.PI * 2;
  while (delta < -Math.PI) delta += Math.PI * 2;
  const eighth = Math.PI / 8;
  if (Math.abs(delta) <= eighth) return 'straight ahead';
  if (Math.abs(delta) >= Math.PI - eighth) return 'behind you';
  if (delta > 0) {
    return delta < Math.PI / 2 - eighth ? 'ahead and to your right' : delta < Math.PI / 2 + eighth ? 'to your right' : 'behind you and to the right';
  }
  const d = -delta;
  return d < Math.PI / 2 - eighth ? 'ahead and to your left' : d < Math.PI / 2 + eighth ? 'to your left' : 'behind you and to the left';
}

/** Paces rather than metres, for the same reason bearings are not degrees. */
function paces(distance: number): string {
  const steps = Math.max(1, Math.round(distance / 0.75));
  if (distance < 1.2) return 'right here';
  return `about ${steps} ${steps === 1 ? 'pace' : 'paces'} away`;
}

function fireLine(ritual: RitualState): string {
  const fire = ritual.fire;
  if (fire.flame < 0.02 && fire.emberMass < 0.05) return 'The fire is out. The pit is cold.';
  if (isEmberBed(fire)) {
    return fire.emberMass > 0.6
      ? 'The fire has burned down to a deep bed of coals, which is what you want.'
      : 'The fire has burned down to coals, and they are getting thin.';
  }
  if (fire.flame > 0.7) return 'The fire is burning hard, with flames well up.';
  return 'The fire is burning, but it has not settled into coals yet.';
}

export interface SurveyOptions {
  /** Named places the player is standing in, from the presence model. */
  places?: readonly string[];
  /** How far out to mention things that are not in reach, in metres. */
  radius?: number;
}

/**
 * The survey, as an ordered list of sentences.
 *
 * A list rather than one string so the caller can decide how to present it —
 * read aloud as a block, or shown a line at a time — without either of them
 * having to split prose back apart.
 */
export function surveySurroundings(
  ritual: RitualState,
  player: PlayerState,
  world: WalkableWorld,
  options: SurveyOptions = {},
): string[] {
  const lines: string[] = [];
  const radius = options.radius ?? 7;

  // 1. What is in reach, because it is what you can act on this second.
  const inReach = reachable(player, world).map((r) => r.interactable);
  const here = focused(player, world);
  if (here !== null) {
    lines.push(`You are standing at ${nameOf(here.id)}.`);
  } else if (inReach.length > 0) {
    lines.push(`Within reach: ${inReach.map((i) => nameOf(i.id)).join(', ')}.`);
  }

  // 2. The fire, because it is why anybody is here.
  lines.push(fireLine(ritual));

  // 3. What is close enough to walk to, nearest first, and never everything.
  const reachIds = new Set(inReach.map((i) => i.id));
  const near = world.interactables
    .filter((i) => !reachIds.has(i.id))
    .map((i) => ({
      i,
      d: Math.hypot(i.x - player.position.x, i.z - player.position.z),
    }))
    .filter((entry) => entry.d <= radius)
    .sort((a, b) => a.d - b.d)
    .slice(0, 5);
  for (const entry of near) {
    lines.push(
      `${capitalise(nameOf(entry.i.id))} is ${relativeBearing(player, entry.i.x, entry.i.z)}, ${paces(entry.d)}.`,
    );
  }

  // 3b. What this place is actually like — its own words, and only the ones
  //     that are true at this moment. A survey that recited the whole
  //     paragraph every time would be a brochure.
  for (const line of surveyPlace(ritual.options.world.place ?? {}, {
    elapsed: ritual.elapsed,
    deepNight: ritual.window === 'deep-night' || ritual.window === 'pre-dawn',
    temperatureC: ritual.weather.temperatureC,
    windSpeed: ritual.weather.windSpeed,
    precipitation: ritual.weather.precipitation,
    distanceFromFire: Math.hypot(player.position.x, player.position.z),
    fireHarried: false,
  })) {
    lines.push(line);
  }

  /*
   * 3c. What this campsite is *for*.
   *
   * Every environment marks exactly one activity `signature`, and until this
   * line existed the field decided nothing: a player found the tide pools, or
   * the slot that answers you back, or the box you can sit in, by walking into
   * it or not at all. That is a fine way to find a thing when you can see the
   * screen. The survey exists for the player who cannot, and "what is here"
   * without "and here is the thing this place was built around" is a list of
   * furniture.
   *
   * Last of the place lines rather than first: what is in reach is what you
   * can act on this second, and this is what you might plan the evening
   * around.
   */
  const signature = (ritual.options.world.activities ?? []).find(
    (activity) => activity.prominence === 'signature',
  );
  if (signature) {
    lines.push(`${capitalise(signature.label)}. That is the thing this campsite is for.`);
    if (signature.note.length > 0) lines.push(signature.note);
  }

  // 4. Where you are standing, if the world has a name for it.
  const spoken = (options.places ?? []).map((id) => PLACES[id]).filter((name): name is string => name !== undefined);
  if (spoken.length > 0) lines.push(`You are ${spoken.join(' and ')}.`);

  // 5. The night around it. Weather before wildlife: it is what you would
  //    notice first, and it is the thing that changes how everything else
  //    behaves.
  lines.push(weatherLine(ritual));

  // Already nearest-first, so the closest thing in the dark is the one worth
  // mentioning — and only one of them, because a list of animals is a list.
  const closest = animalsPresent(ritual)[0];
  if (closest !== undefined) {
    lines.push(
      closest.distanceM > 9
        ? 'Something is moving out past the treeline, well back.'
        : `Something is at the edge of the light, ${paces(closest.distanceM)}.`,
    );
  }

  return lines;
}

function weatherLine(ritual: RitualState): string {
  const w = ritual.weather;
  if (w.precipitation > 0.45) return 'It is raining hard enough to hear it on the fire.';
  if (w.precipitation > 0.08) return 'It is spitting with rain.';
  if (w.windSpeed > 6) return 'The wind is up, and the fire is leaning with it.';
  if (w.cloudCover > 0.7) return 'The sky is covered over. No stars tonight.';
  if (w.cloudCover < 0.25) return 'The sky is clear, and the stars are out.';
  return 'The night is still.';
}

function capitalise(text: string): string {
  return text.length === 0 ? text : `${text[0]!.toUpperCase()}${text.slice(1)}`;
}
