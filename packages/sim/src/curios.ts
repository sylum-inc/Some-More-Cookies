/**
 * The things at a campsite that you find by looking at them.
 *
 * Twenty-eight of the catalogue's forty-seven secrets carry a `notes` or a
 * `strange-objects` channel, and `defaultConditions` infers
 * `{ kind: 'inspecting', targetId: secret.id }` for both — a condition that
 * nothing in the product ever satisfied, because nothing ever wrote
 * `presence.inspecting`. They were undiscoverable by construction: a shelf of
 * shift entries stopping mid-sentence with the pencil still in the fold,
 * written, tested, validated, and impossible to meet.
 *
 * The gap was spatial. A secret has an id, a title, the prose of how you
 * stumble into it and the prose of what it says — and nowhere to be. The
 * condition wants you to be *inspecting the secret*, which only means
 * anything if the secret is a thing standing somewhere. So the thing is
 * placed here, the way landmarks are: from the campsite's own seed, at a
 * fraction of its radius, out of the fire and clear of everything else, the
 * same on every device and on every visit.
 *
 * Nothing is authored for this. The label is the secret's own title — "The
 * tackle cans", "The cache logbook", "The thirty-second stake" — which was
 * already written to be read by a player, and the shape follows the channel.
 * A campsite gains its curios by having secrets, not by anyone adding a
 * second list that could disagree with the first.
 */

import { clamp } from './math.js';
import type { Rng } from './rng.js';
import type { Occupied } from './landmarks.js';
import type { PlacedLandmark } from './landmarks.js';
import type { MysteryChannel, SecretDefinition } from './discovery.js';

/**
 * What kind of thing it is to crouch over.
 *
 * Four, because four covers what the catalogue actually describes and a
 * fifth would be a shape nobody wrote. `notes` are things with writing on
 * them; `strange-objects` are things somebody left.
 */
export type CurioShape = 'tin' | 'board' | 'stake' | 'slab';

export interface PlacedCurio {
  readonly secretId: string;
  /** The secret's own title, which was already written for a player to read. */
  readonly label: string;
  readonly shape: CurioShape;
  readonly x: number;
  readonly z: number;
  readonly rotation: number;
  /** Seed for the shape, so two tins at two campsites are not one tin. */
  readonly seed: number;
  /** Whether the player has crouched over this one tonight. */
  looked: boolean;
}

export interface CurioOptions {
  readonly secrets: readonly SecretDefinition[];
  /** Walkable radius of the campsite, metres. */
  readonly radius: number;
  readonly trailBearing: number;
  /** The fire, the machine, the table, the seat, the woodpile. */
  readonly occupied?: readonly Occupied[];
  /** Placed first, so a curio never stands inside a landmark. */
  readonly landmarks?: readonly PlacedLandmark[];
  readonly rng: Rng;
}

/** Channels whose default condition is `inspecting`, and so need a thing. */
const LOOKED_AT: readonly MysteryChannel[] = ['notes', 'strange-objects', 'serial-numbers', 'diagnostics'];

/** Nothing goes nearer the fire than this, matching the landmarks' own rule. */
const FIRE_CLEARANCE = 2.3;

/** A curio is small; it needs less room than a snag and more than none. */
const CLEARANCE = 0.9;

/**
 * How far out each shape sits, as a fraction of the walkable radius.
 *
 * Things with writing on them are near the camp, because they are things
 * somebody at the camp wrote or read. Things somebody left are further out,
 * because that is what makes them worth walking to.
 */
const DISTANCE: Record<CurioShape, number> = {
  board: 0.34,
  tin: 0.44,
  slab: 0.58,
  stake: 0.68,
};

/** Whether this secret is one you find by looking at something. */
export function isLookedAt(secret: SecretDefinition): boolean {
  return secret.channels.some((channel) => LOOKED_AT.includes(channel));
}

/**
 * Words the catalogue already uses for these things, and what they look like.
 *
 * Every one of these is lifted out of a title somebody wrote — "The tackle
 * cans", "The thirty-second stake", "The gauge board reads high", "The sixth
 * cairn". Reading them is not authoring: the alternative is picking the shape
 * from the channel alone, which puts a plank shelf under a label that says
 * *tin*, and a player who is told to look closely at a tin and shown a shelf
 * has been told the world is arbitrary.
 *
 * A title with no such word falls back to the channel, which is where every
 * one of these started.
 */
const SHAPE_WORDS: Readonly<Record<CurioShape, readonly string[]>> = {
  tin: ['tin', 'tins', 'can', 'cans', 'tub', 'float', 'jar', 'bottle', 'kettle'],
  board: ['board', 'shelf', 'shelves', 'plank', 'planks', 'logbook', 'register', 'ledger', 'table', 'bench'],
  stake: ['stake', 'marker', 'mark', 'pole', 'sign', 'post', 'arrow'],
  slab: ['stone', 'slab', 'plate', 'cairn', 'lintel', 'rock', 'seam'],
};

function namedShape(title: string): CurioShape | null {
  const words = title.toLowerCase().split(/[^a-z]+/);
  for (const [shape, list] of Object.entries(SHAPE_WORDS)) {
    if (list.some((word) => words.includes(word))) return shape as CurioShape;
  }
  return null;
}

function shapeFor(secret: SecretDefinition, rng: Rng): CurioShape {
  const writing = secret.channels.includes('notes');
  /*
   * Two shapes per family, picked from the campsite's own stream so a
   * campsite's curios differ from each other without differing between
   * devices. Drawn whether or not the title names a shape, so that editing a
   * secret's title never moves a *different* secret's curio.
   */
  const guess: CurioShape = writing ? (rng.chance(0.5) ? 'board' : 'slab') : rng.chance(0.5) ? 'tin' : 'stake';
  return namedShape(secret.title) ?? guess;
}

function isClear(
  x: number,
  z: number,
  occupied: readonly Occupied[],
  landmarks: readonly PlacedLandmark[],
  placed: readonly PlacedCurio[],
): boolean {
  if (Math.hypot(x, z) < FIRE_CLEARANCE) return false;
  for (const thing of occupied) {
    if (Math.hypot(thing.x - x, thing.z - z) < thing.radius + CLEARANCE) return false;
  }
  /*
   * Beside a landmark rather than inside it.
   *
   * Deliberately a smaller margin than the landmarks keep from each other:
   * most of these secrets describe a thing that is *on* or *under* something
   * the manifest already names — a shelf above the bench, the underside of
   * the table, a tin under a stepping stone — so standing them off by a
   * couple of metres reads right, and standing them off by four would put
   * them in the middle of nowhere.
   */
  for (const landmark of landmarks) {
    if (Math.hypot(landmark.x - x, landmark.z - z) < 1.6) return false;
  }
  for (const other of placed) {
    if (Math.hypot(other.x - x, other.z - z) < CLEARANCE * 2) return false;
  }
  return true;
}

/**
 * Puts every secret that is found by looking somewhere you can look at it.
 *
 * The same ring-of-candidate-bearings walk `placeLandmarks` uses, so a
 * crowded campsite still finds room and the result is deterministic. A curio
 * that cannot be fitted in twenty-four attempts is dropped, which is the
 * landmarks' behaviour too — and is safe here because the secret stays
 * findable through any other channel it carries.
 */
export function placeCurios(options: CurioOptions): PlacedCurio[] {
  const { secrets, radius, trailBearing, rng } = options;
  const occupied = options.occupied ?? [];
  const landmarks = options.landmarks ?? [];
  const placed: PlacedCurio[] = [];

  secrets.filter(isLookedAt).forEach((secret, index) => {
    const shape = shapeFor(secret, rng);
    /*
     * Jittered, because the distance is a property of the shape and three
     * boards at one campsite would otherwise stand on a perfect circle at
     * exactly the same range — which reads as a placement rule rather than as
     * things people left in different years.
     */
    const distance = clamp(radius * DISTANCE[shape] * rng.range(0.78, 1.18), 2.6, radius - 1.4);
    // Away from the trail, so the walk in does not trip over every one of
    // them before the fire has been reached.
    const preferred = trailBearing + Math.PI * 0.4 + index * 1.77 + rng.range(-0.3, 0.3);

    for (let attempt = 0; attempt < 24; attempt++) {
      const swing = Math.ceil(attempt / 2) * 0.42 * (attempt % 2 === 0 ? 1 : -1);
      const bearing = preferred + swing;
      const pull = attempt < 12 ? 1 : 0.84;
      const x = Math.cos(bearing) * distance * pull;
      const z = Math.sin(bearing) * distance * pull;
      if (!isClear(x, z, occupied, landmarks, placed)) continue;
      placed.push({
        secretId: secret.id,
        label: secret.title,
        shape,
        x,
        z,
        // Facing the fire, because a camp is arranged around its fire.
        rotation: Math.atan2(-z, -x),
        seed: Math.floor(rng.range(1, 100000)),
        looked: false,
      });
      return;
    }
  });

  return placed;
}

export function curioAt(curios: readonly PlacedCurio[], secretId: string): PlacedCurio | null {
  return curios.find((curio) => curio.secretId === secretId) ?? null;
}
