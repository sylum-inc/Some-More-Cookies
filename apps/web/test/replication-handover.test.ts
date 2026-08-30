/**
 * Taking the sandwich is a ritual intent, not a machine control.
 *
 * `machine_control: take_sandwich` used to replay through `operateMachine`,
 * which moves the machine and nothing else — no bite state, no `sandwichAge`
 * reset, no move to the `eating` stage. Both mappings (the client's and the
 * server-side replay helper's) had the same gap, so they agreed with each
 * other and the drift test passed. But a player taking their *own* sandwich
 * calls `takeSandwich`, so the acting client did one thing and every other
 * client did another, at exactly the moment the ritual hands over the product
 * it is named after.
 *
 * This is the test that fails without the fix.
 */

import { describe, expect, it } from 'vitest';
import {
  createRitual,
  operateMachine,
  stepRitual,
  SIM_DT,
  type RitualState,
} from '@somemore/sim';
import { applyIntent } from '../src/net/replication.js';

/** Drives a ritual all the way to a finished sandwich sitting on the tray. */
function ritualWithASandwichOnTheTray(): RitualState {
  const ritual = createRitual({ campsiteSeed: 'take-it', environmentId: 'pine_hollow' });
  const settle = (seconds: number): void => {
    for (let i = 0; i < Math.round(seconds / SIM_DT); i += 1) stepRitual(ritual, SIM_DT);
  };

  settle(20);
  operateMachine(ritual, { type: 'load' });
  operateMachine(ritual, { type: 'close-door' });
  settle(6);
  operateMachine(ritual, { type: 'engage-latch' });
  operateMachine(ritual, { type: 'set-program', program: 'soft-set' });
  operateMachine(ritual, { type: 'confirm' });
  operateMachine(ritual, { type: 'pull-lever' });
  settle(40);
  operateMachine(ritual, { type: 'release-latch' });
  operateMachine(ritual, { type: 'open-door' });
  settle(4);
  return ritual;
}

describe('replicating the moment the sandwich changes hands', () => {
  it('moves the receiving client to eating, not merely the machine', () => {
    const ritual = ritualWithASandwichOnTheTray();
    expect(ritual.sandwich).not.toBeNull();
    expect(ritual.stage).toBe('reveal');

    applyIntent(ritual, { kind: 'machine_control', control: 'take_sandwich' });

    // The whole point: everyone watching sees the ritual move on, not just a
    // tray that quietly emptied.
    expect(ritual.stage).toBe('eating');
    expect(ritual.machine.hasSandwich).toBe(false);
    expect(ritual.sandwichAge).toBe(0);
    expect(ritual.bite.bites).toBe(0);
    expect(ritual.bite.eaten).toBe(0);
    expect(ritual.bite.finished).toBe(false);
  });

  it('leaves every other machine control alone', () => {
    // The same journey, stopped one step short: everything up to and including
    // opening the door replays through `operateMachine` exactly as before, and
    // none of it moves the ritual on.
    const ritual = ritualWithASandwichOnTheTray();
    expect(ritual.stage).toBe('reveal');

    // Opening the door is a machine control and only a machine control: it
    // must not carry the ritual forward the way taking the sandwich does.
    applyIntent(ritual, { kind: 'machine_control', control: 'open_door' });
    expect(ritual.stage).toBe('reveal');
    expect(ritual.sandwichAge).toBe(0);
  });

  it('is harmless when there is no sandwich to take', () => {
    const ritual = createRitual({ campsiteSeed: 'take-it-3', environmentId: 'pine_hollow' });
    for (let i = 0; i < Math.round(20 / SIM_DT); i += 1) stepRitual(ritual, SIM_DT);

    // A replayed intent must never be able to fabricate a stage transition.
    applyIntent(ritual, { kind: 'machine_control', control: 'take_sandwich' });
    expect(ritual.stage).not.toBe('eating');
    expect(ritual.sandwich).toBeNull();
  });
});
