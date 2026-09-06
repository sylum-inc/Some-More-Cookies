import { describe, expect, it } from 'vitest';
import {
  createRitual,
  lookCloser,
  stopLooking,
  stepRitual,
  hasDiscovered,
  isLookedAt,
  SIM_DT,
  type RitualState,
  type SecretDefinition,
} from '../src/index.js';

/**
 * The twenty-eight secrets that could not be found.
 *
 * `defaultConditions` infers `{ kind: 'inspecting', targetId: secret.id }` for
 * every `notes` and `strange-objects` secret, and nothing in the product ever
 * wrote `presence.inspecting` — so a shelf of shift entries stopping
 * mid-sentence, with the pencil still in the fold, was authored, validated,
 * shipped, and impossible to meet. These are about whether crouching over a
 * thing now finds it, and whether brushing past one still does not.
 */

const SECRETS: readonly SecretDefinition[] = [
  {
    id: 'the_tackle_cans',
    title: 'The tackle cans',
    discovery: 'Three coffee cans on the plank shelf, lids rusted on.',
    telling: 'Split shot, a spool of line gone brittle, and a hook somebody sharpened by hand.',
    channels: ['notes', 'strange-objects'],
    oneTime: false,
    leavesEvidence: null,
    rarity: 0.5,
    optional: true,
    gatesNothing: true,
  },
  {
    id: 'the_thirty_second_stake',
    title: 'The thirty-second stake',
    discovery: 'A survey stake out past the last of them, with a number that does not follow.',
    telling: 'Thirty-one of them run in a line. This one is thirty-two, and it is facing the wrong way.',
    channels: ['strange-objects'],
    oneTime: true,
    leavesEvidence: 'The stake stays leaning where you left it.',
    rarity: 0.2,
    optional: true,
    gatesNothing: true,
  },
  {
    id: 'the_light_on_the_road',
    title: 'The light on the road',
    discovery: 'Something crosses the far side of the bowl, a long way off.',
    telling: 'A lantern, at walking pace, going the other way.',
    channels: ['distant-sounds'],
    oneTime: false,
    leavesEvidence: null,
    rarity: 0.5,
    optional: true,
    gatesNothing: true,
  },
];

function campsite(): RitualState {
  return createRitual({
    campsiteSeed: 'curio-camp',
    environmentId: 'pine_hollow',
    now: 0,
    walkableRadiusM: 34,
    world: {
      secrets: SECRETS,
      landmarks: [],
      trailBearing: 0.69,
      occupied: [{ x: 0, z: 0, radius: 0.62 }],
    },
  });
}

/** Runs the world forward, holding the look the way a crouching player does. */
function crouchFor(ritual: RitualState, seconds: number, secretId: string | null): void {
  for (let step = 0; step < Math.round(seconds / SIM_DT); step++) {
    if (secretId !== null) lookCloser(ritual, secretId);
    stepRitual(ritual, SIM_DT);
  }
}

describe('the things you find by looking', () => {
  it('gives every looked-at secret somewhere to be, and leaves the others alone', () => {
    const ritual = campsite();
    const ids = ritual.curios.map((curio) => curio.secretId);
    expect(ids).toContain('the_tackle_cans');
    expect(ids).toContain('the_thirty_second_stake');
    // A secret you witness rather than examine is not a thing standing in the
    // clearing, and giving it one would be a prop nobody wrote.
    expect(ids).not.toContain('the_light_on_the_road');
    expect(SECRETS.filter(isLookedAt)).toHaveLength(2);
  });

  it('puts them somewhere you can walk to, out of the fire', () => {
    const ritual = campsite();
    for (const curio of ritual.curios) {
      const distance = Math.hypot(curio.x, curio.z);
      expect(distance, `${curio.secretId} is in the fire`).toBeGreaterThan(2.2);
      expect(distance, `${curio.secretId} is outside the campsite`).toBeLessThan(34 - 1.3);
    }
  });

  it('puts them in the same place on every device, and a different one at each campsite', () => {
    const here = campsite().curios.map((c) => `${c.secretId}:${c.x.toFixed(3)}:${c.z.toFixed(3)}`);
    const again = campsite().curios.map((c) => `${c.secretId}:${c.x.toFixed(3)}:${c.z.toFixed(3)}`);
    expect(again).toEqual(here);

    const elsewhere = createRitual({
      campsiteSeed: 'a-different-camp',
      environmentId: 'pine_hollow',
      now: 0,
      walkableRadiusM: 34,
      world: { secrets: SECRETS, landmarks: [], trailBearing: 0.69 },
    }).curios.map((c) => `${c.secretId}:${c.x.toFixed(3)}:${c.z.toFixed(3)}`);
    expect(elsewhere).not.toEqual(here);
  });

  it('carries the title the catalogue already wrote, so nothing new is authored', () => {
    const ritual = campsite();
    expect(ritual.curios.map((c) => c.label)).toContain('The tackle cans');
  });

  it('looks like the thing its title says it is', () => {
    /*
     * A label reading "the tin in the creek" over a plank shelf tells the
     * player the world is arbitrary. The titles were written with the nouns
     * in them; the shape reads those rather than guessing from the channel,
     * which is what put a shelf under the tin in the first place.
     */
    const ritual = campsite();
    const shapeOf = (id: string): string | undefined => ritual.curios.find((c) => c.secretId === id)?.shape;
    expect(shapeOf('the_tackle_cans')).toBe('tin');
    expect(shapeOf('the_thirty_second_stake')).toBe('stake');
  });

  it('does not move one curio because another was renamed', () => {
    /*
     * The shape is drawn from the campsite's stream whether or not the title
     * names one, so a title edit cannot desynchronise the placements that
     * follow it. Without that, renaming the first secret would silently
     * relocate every other curio at the campsite.
     */
    const renamed = SECRETS.map((secret) =>
      secret.id === 'the_tackle_cans' ? { ...secret, title: 'The thing on the shelf' } : secret,
    );
    const before = campsite().curios.find((c) => c.secretId === 'the_thirty_second_stake');
    const after = createRitual({
      campsiteSeed: 'curio-camp',
      environmentId: 'pine_hollow',
      now: 0,
      walkableRadiusM: 34,
      world: { secrets: renamed, landmarks: [], trailBearing: 0.69, occupied: [{ x: 0, z: 0, radius: 0.62 }] },
    }).curios.find((c) => c.secretId === 'the_thirty_second_stake');
    expect(after?.x).toBe(before?.x);
    expect(after?.z).toBe(before?.z);
  });

  it('finds it when you crouch over it and keep looking', () => {
    const ritual = campsite();
    expect(hasDiscovered(ritual.discovery, 'the_tackle_cans')).toBe(false);
    // A common secret asks about eight and a half seconds of a held look.
    crouchFor(ritual, 20, 'the_tackle_cans');
    expect(hasDiscovered(ritual.discovery, 'the_tackle_cans')).toBe(true);
  });

  it('asks longer for a rarer one', () => {
    /*
     * `lerp(12, 5, rarity)`: the common one (rarity 0.5) asks 8.5 seconds and
     * the rare one (0.2) asks 10.6. Nine seconds is past the first and short
     * of the second, which is the whole claim.
     */
    const common = campsite();
    crouchFor(common, 9, 'the_tackle_cans');
    const rare = campsite();
    crouchFor(rare, 9, 'the_thirty_second_stake');
    expect(hasDiscovered(common.discovery, 'the_tackle_cans')).toBe(true);
    expect(hasDiscovered(rare.discovery, 'the_thirty_second_stake')).toBe(false);
    crouchFor(rare, 3, 'the_thirty_second_stake');
    expect(hasDiscovered(rare.discovery, 'the_thirty_second_stake')).toBe(true);
  });

  it('finds nothing at all if you only ever brush past it', () => {
    /*
     * The invariant the hold exists for: attention drains at one and a half
     * times the rate it accumulates, so glancing at a thing on your way to
     * the fire, over and over, never adds up to having looked at it.
     */
    const ritual = campsite();
    for (let cycle = 0; cycle < 200; cycle++) {
      crouchFor(ritual, 2, 'the_tackle_cans');
      stopLooking(ritual);
      crouchFor(ritual, 4, null);
    }
    expect(hasDiscovered(ritual.discovery, 'the_tackle_cans')).toBe(false);
  });

  it('stops looking when you straighten up, and does not quietly keep going', () => {
    const ritual = campsite();
    crouchFor(ritual, 5, 'the_tackle_cans');
    stopLooking(ritual);
    expect(ritual.presence.inspecting).toBeNull();
    crouchFor(ritual, 60, null);
    expect(hasDiscovered(ritual.discovery, 'the_tackle_cans')).toBe(false);
  });

  it('says what it is, so the find can be told rather than logged', () => {
    const ritual = campsite();
    crouchFor(ritual, 20, 'the_tackle_cans');
    const found = ritual.discoveryEvents.filter((event) => event.kind === 'discovered');
    expect(found.map((event) => event.secretId)).toContain('the_tackle_cans');
    const telling = found.find((event) => event.secretId === 'the_tackle_cans')?.telling ?? '';
    expect(telling).toContain('Split shot');
  });

  it('leans in before it tells you, so the wait has a shape', () => {
    const ritual = campsite();
    crouchFor(ritual, 6, 'the_tackle_cans');
    const noticing = ritual.discoveryEvents.filter((event) => event.kind === 'noticing');
    expect(noticing.map((event) => event.secretId)).toContain('the_tackle_cans');
  });
});
