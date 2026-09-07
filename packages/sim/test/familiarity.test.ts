import { describe, expect, it } from 'vitest';
import {
  NO_FAMILIARITY,
  createWildlife,
  createWildlifeInput,
  easedShyness,
  mergeFamiliarity,
  rememberCalmNight,
  rememberOffering,
  rememberPhotograph,
  stepWildlife,
  Rng,
  vec3,
  type Familiarity,
  type WildlifeSpecies,
} from '../src/index.js';

/**
 * What an animal remembers about you.
 *
 * The model already carried `individual.visits` and handed it to the
 * significance model so a sighting could be told as a first meeting or a
 * fourth. It changed nothing about the animal: a fox that had watched you sit
 * still by the same fire nine nights running bolted at exactly the distance it
 * bolted on the first, and nine visits bought a different sentence and nothing
 * else. These are about whether it buys anything now.
 */

const FOX: WildlifeSpecies = {
  id: 'fox',
  label: 'a fox',
  shyness: 0.7,
  curiosity: 0.5,
  window: ['early-night'],
  attractedBy: ['firelight'],
  repelledBy: ['sudden-movement'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['prints in the ash'],
  note: 'It keeps the fire between you.',
};

describe('the two layers', () => {
  it('lets a species floor travel and an individual bond stay put', () => {
    /*
     * The claim behind having two of them: being good with foxes is worth
     * something at a fire you have never sat at, and it is worth less than
     * this fox knowing you.
     */
    const floor: Familiarity = { species: { fox: 1 }, individuals: {} };
    const bond: Familiarity = { species: {}, individuals: { 'fox:a1': 1 } };

    const stranger = easedShyness(0.7, 'fox', 'fox:a1', NO_FAMILIARITY);
    const known = easedShyness(0.7, 'fox', 'fox:a1', floor);
    const friend = easedShyness(0.7, 'fox', 'fox:a1', bond);

    expect(known).toBeLessThan(stranger);
    expect(friend).toBeLessThan(known);

    // And the bond does not follow you to another fox.
    expect(easedShyness(0.7, 'fox', 'fox:b2', bond)).toBe(stranger);
    // While the floor does.
    expect(easedShyness(0.7, 'fox', 'fox:b2', floor)).toBe(known);
  });

  it('never makes an animal tame', () => {
    // §7: not collectible pets. Maxing both layers takes the edge off and
    // leaves a wild animal; a shy species stays shy.
    const everything: Familiarity = { species: { fox: 1 }, individuals: { 'fox:a1': 1 } };
    const eased = easedShyness(0.9, 'fox', 'fox:a1', everything);
    expect(eased).toBeGreaterThan(0.4);
    expect(eased).toBeLessThan(0.9);
  });

  it('cannot go below nothing or above everything', () => {
    const everything: Familiarity = { species: { fox: 1 }, individuals: { 'fox:a1': 1 } };
    expect(easedShyness(0.1, 'fox', 'fox:a1', everything)).toBeGreaterThanOrEqual(0);
    expect(easedShyness(1, 'fox', 'fox:a1', NO_FAMILIARITY)).toBeLessThanOrEqual(1);
  });
});

describe('what earns it', () => {
  it('is a night that ended without the animal running', () => {
    const after = rememberCalmNight(NO_FAMILIARITY, 'fox', 'fox:a1');
    expect(after.individuals['fox:a1']).toBeGreaterThan(0);
    // And the species floor moves too, by much less: being good with foxes is
    // a lot of evenings with a lot of foxes, not one good night.
    expect(after.species['fox']).toBeGreaterThan(0);
    expect(after.species['fox']).toBeLessThan(after.individuals['fox:a1'] as number);
  });

  it('is also a photograph of something that did not bolt at being taken', () => {
    const after = rememberPhotograph(NO_FAMILIARITY, 'fox', 'fox:a1');
    expect(after.individuals['fox:a1']).toBeGreaterThan(0);
    // Worth less than a whole evening of being tolerated, which is right.
    const night = rememberCalmNight(NO_FAMILIARITY, 'fox', 'fox:a1');
    expect(after.individuals['fox:a1']).toBeLessThan(night.individuals['fox:a1'] as number);
  });

  it('is most of all a s’more that something carried off, and only for that one', () => {
    /*
     * The one earn that costs the player the thing the whole ritual was for,
     * and the one that moves nothing but the bond with the animal that took
     * it. §7: not collectible pets and no feeding quest — a mechanic where
     * food bought general tameness would be a feeding quest with the word
     * filed off, and being good with foxes has to stay a lot of evenings with
     * a lot of foxes.
     */
    const after = rememberOffering(NO_FAMILIARITY, 'fox:a1');
    const night = rememberCalmNight(NO_FAMILIARITY, 'fox', 'fox:a1');
    expect(after.individuals['fox:a1']).toBeGreaterThan(night.individuals['fox:a1'] as number);
    expect(after.species, 'feeding one animal made the whole species tamer').toEqual({});
  });

  it('does not pay a player for leaving the tab open', () => {
    /*
     * The client saves on a timer, so merging has to take the larger of each
     * rather than adding. Adding would make a night's familiarity a function
     * of how long the page was left running.
     */
    const tonight = rememberCalmNight(NO_FAMILIARITY, 'fox', 'fox:a1');
    let known = mergeFamiliarity(NO_FAMILIARITY, tonight);
    for (let save = 0; save < 20; save++) known = mergeFamiliarity(known, tonight);
    expect(known.individuals['fox:a1']).toBeCloseTo(tonight.individuals['fox:a1'] as number, 10);
  });

  it('adds up across nights, though', () => {
    let known = NO_FAMILIARITY;
    let last = 0;
    for (let night = 0; night < 4; night++) {
      known = mergeFamiliarity(known, rememberCalmNight(known, 'fox', 'fox:a1'));
      const now = known.individuals['fox:a1'] as number;
      expect(now).toBeGreaterThan(last);
      last = now;
    }
  });
});

describe('an animal that knows you', () => {
  /** Runs a whole evening at a campsite and reports what the place learned. */
  function evening(playerSpeed: number): Familiarity {
    const state = createWildlife({ campsiteSeed: 'learner', roster: [FOX] });
    const rng = new Rng('evening');
    const input = createWildlifeInput({
      playerSpeed,
      noise: playerSpeed * 0.4,
      playerPosition: vec3(0, 0, 0),
      cues: { firelight: 1, stillness: playerSpeed === 0 ? 1 : 0 },
      window: 'early-night',
      stillnessRate: 4,
    });
    for (let step = 0; step < 30_000; step++) stepWildlife(state, input, 1 / 30, rng);
    return state.familiarity;
  }

  it('learns from a quiet evening and nothing from a loud one', () => {
    /*
     * The whole mechanic in one comparison. Same campsite, same foxes, same
     * length of evening; one player sat still by the fire and the other
     * blundered about.
     *
     * The credit is for an animal that never startled, not for time spent
     * nearby — one that fled learned the opposite about you, and paying for
     * the minutes it spent frightened would teach a player that standing over
     * a nervous fox is how you befriend it.
     */
    const quiet = evening(0);
    const loud = evening(2.2);

    const bonds = Object.values(quiet.individuals);
    expect(bonds.length, 'a whole quiet evening taught the place nothing').toBeGreaterThan(0);
    expect(Math.max(...bonds)).toBeGreaterThan(0.1);
    expect(quiet.species['fox']).toBeGreaterThan(0);

    expect(
      Object.keys(loud.individuals),
      'blundering about all evening made friends anyway',
    ).toHaveLength(0);
  });

  it('starts a campsite knowing nothing about you', () => {
    const state = createWildlife({ campsiteSeed: 'stranger', roster: [FOX] });
    expect(state.familiarity).toEqual(NO_FAMILIARITY);
  });

  it('takes what the caller restored as its starting point', () => {
    // The two layers arrive from two places — the species floor from the
    // Passport, the bonds from this campsite's memory — and the model does not
    // care which was which.
    const known: Familiarity = { species: { fox: 0.4 }, individuals: { 'fox:a1': 0.6 } };
    const state = createWildlife({ campsiteSeed: 'remembered', roster: [FOX], familiarity: known });
    expect(state.familiarity).toEqual(known);
  });
});
