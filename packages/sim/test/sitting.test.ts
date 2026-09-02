import { describe, expect, it } from 'vitest';
import {
  SEATED_STILLNESS_GAIN,
  SETTLE_SECONDS,
  createSeat,
  describeSeat,
  settlingGain,
  sitDown,
  standUp,
  stepSeat,
  stillnessGain,
} from '../src/sitting.js';
import {
  createWildlife,
  createWildlifeInput,
  speciesAppearanceRate,
  stepWildlife,
  type WildlifeSpecies,
} from '../src/wildlife.js';
import { assertNoScoring } from '../src/activity.js';
import { Rng } from '../src/rng.js';
import { SIM_DT } from '../src/types.js';

function sitFor(seconds: number, disturbance = 0) {
  const seat = createSeat();
  sitDown(seat, 'log-seat');
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepSeat(seat, SIM_DT, disturbance);
  return seat;
}

describe('settling', () => {
  it('is not instant: sitting down does not immediately make you still', () => {
    const justSat = sitFor(1);
    expect(justSat.settled).toBeLessThan(0.05);
    const shifted = sitFor(SETTLE_SECONDS * 0.4);
    expect(shifted.settled).toBeLessThan(0.5);
  });

  it('completes over about half a minute of actually sitting there', () => {
    const settled = sitFor(SETTLE_SECONDS * 2.5);
    expect(settled.settled).toBeGreaterThan(0.9);
    expect(stillnessGain(settled)).toBeGreaterThan(SEATED_STILLNESS_GAIN * 0.9);
  });

  it('is lost the instant you stand up', () => {
    const seat = sitFor(SETTLE_SECONDS * 3);
    expect(seat.settled).toBeGreaterThan(0.9);
    standUp(seat);
    expect(seat.settled).toBe(0);
    expect(seat.seatedSeconds).toBe(0);
    expect(stillnessGain(seat)).toBe(1);
  });

  it('is lost by moving along the log, same as standing', () => {
    const seat = sitFor(SETTLE_SECONDS * 3);
    sitDown(seat, 'other-end-of-the-log');
    expect(seat.settled).toBe(0);
  });

  it('does not happen at all through a racket', () => {
    const quiet = sitFor(SETTLE_SECONDS * 2, 0);
    const noisy = sitFor(SETTLE_SECONDS * 2, 0.8);
    expect(noisy.settled).toBeLessThan(quiet.settled * 0.4);
  });

  it('never makes standing still worse', () => {
    // Assists change dexterity, never outcomes (§12) — and the same principle
    // applies here: sitting is an addition, not a tax on not sitting.
    const standing = createSeat();
    stepSeat(standing, SIM_DT, 0);
    expect(stillnessGain(standing)).toBe(1);
    expect(settlingGain(standing)).toBe(1);
  });

  it('replays identically', () => {
    expect(sitFor(40, 0.1)).toEqual(sitFor(40, 0.1));
  });
});

/* -------------------------------------------------------------------------- */
/* The thing this is actually for                                             */
/* -------------------------------------------------------------------------- */

const FLYING_SQUIRREL: WildlifeSpecies = {
  id: 'flying-squirrel',
  label: 'Flying squirrel',
  shyness: 0.86,
  curiosity: 0.7,
  window: ['deep-night'],
  attractedBy: ['stillness', 'quiet'],
  repelledBy: ['flashlight', 'voices'],
  canPersist: true,
  investigatesObjects: true,
  traces: ['a scatter of bark at the base of a trunk'],
  note: '',
};

/** Runs a quiet camp for `seconds` and reports the calm reached. */
function quietFor(seconds: number, options: { stillnessRate?: number; settleRate?: number } = {}) {
  const state = createWildlife({ campsiteSeed: 7, roster: [FLYING_SQUIRREL] });
  const input = createWildlifeInput({
    window: 'deep-night',
    playerSpeed: 0,
    noise: 0,
    ...options,
  });
  const rng = new Rng(99);
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepWildlife(state, input, SIM_DT, rng);
  return state;
}

describe('what sitting is for', () => {
  it('is the strongest generator of stillness there is', () => {
    // Standing motionless works. Sitting works far faster, which is the whole
    // difference between an endurance test and an evening by a fire.
    const standing = quietFor(60);
    const seated = quietFor(60, { stillnessRate: SEATED_STILLNESS_GAIN });
    expect(seated.stillnessSeconds).toBeGreaterThan(standing.stillnessSeconds * 2);
    expect(seated.calm).toBeGreaterThan(standing.calm);
  });

  it('brings the shy species within reach in a minute rather than three', () => {
    // This is the payoff, stated as a number the wildlife model itself
    // produces: `speciesAppearanceRate` is public precisely so this is
    // assertable rather than only observable through sampling.
    const input = createWildlifeInput({ window: 'deep-night' });

    const standing = quietFor(60);
    const seated = quietFor(60, { stillnessRate: SEATED_STILLNESS_GAIN, settleRate: 2.2 });

    const standingRate = speciesAppearanceRate(standing, FLYING_SQUIRREL, input);
    const seatedRate = speciesAppearanceRate(seated, FLYING_SQUIRREL, input);
    expect(seatedRate).toBeGreaterThan(standingRate * 3);
  });

  it('cannot conjure an animal on its own', () => {
    // Sitting raises the *rate*; it never sets anything present. A settled
    // player in a windy camp with a torch going still sees nothing.
    const state = createWildlife({ campsiteSeed: 7, roster: [FLYING_SQUIRREL] });
    const input = createWildlifeInput({
      window: 'deep-night',
      stillnessRate: SEATED_STILLNESS_GAIN,
      settleRate: 2.2,
      lightSweep: 1,
      cues: { flashlight: 1 },
    });
    const rng = new Rng(3);
    for (let i = 0; i < Math.round(600 / SIM_DT); i++) stepWildlife(state, input, SIM_DT, rng);
    expect(speciesAppearanceRate(state, FLYING_SQUIRREL, input)).toBe(0);
    expect(state.animals).toHaveLength(0);
  });

  it('settles the camp around you as well as settling you', () => {
    const noisy = createWildlifeInput({ playerSpeed: 1.4, noise: 0.7, window: 'deep-night' });
    const quiet = createWildlifeInput({ playerSpeed: 0, noise: 0, window: 'deep-night' });
    const seatedQuiet = createWildlifeInput({
      playerSpeed: 0,
      noise: 0,
      window: 'deep-night',
      settleRate: 2.2,
    });

    const run = (after: ReturnType<typeof createWildlifeInput>) => {
      const state = createWildlife({ campsiteSeed: 7, roster: [FLYING_SQUIRREL] });
      const rng = new Rng(5);
      for (let i = 0; i < Math.round(20 / SIM_DT); i++) stepWildlife(state, noisy, SIM_DT, rng);
      for (let i = 0; i < Math.round(8 / SIM_DT); i++) stepWildlife(state, after, SIM_DT, rng);
      return state.disturbance;
    };

    expect(run(seatedQuiet)).toBeLessThan(run(quiet));
  });
});

describe('nothing is banked', () => {
  it('exposes no score, currency or completion', () => {
    const seat = sitFor(120);
    assertNoScoring('seat', {
      seated: seat.seated,
      seatId: seat.seatId,
      seatedSeconds: seat.seatedSeconds,
      settled: seat.settled,
      totalSeatedSeconds: seat.totalSeatedSeconds,
    });
  });

  it('describes settling in words, never as a meter', () => {
    expect(describeSeat(createSeat())).toBe('');
    const line = describeSeat(sitFor(SETTLE_SECONDS * 3));
    expect(line).not.toMatch(/\d/);
    expect(line).not.toMatch(/%/);
  });
});
