import { describe, expect, it } from 'vitest';
import {
  SIM_DT,
  beginRoasting,
  createRitual,
  describeDaybreak,
  describeFailingFire,
  stepRitual,
  tendFire,
  type RitualState,
} from '../src/index.js';

/**
 * The night running out.
 *
 * It never used to. `windowAt` walks dusk to dawn and then clamps there, so a
 * session left running sat in a permanent sunrise: every activity available for
 * ever, nothing competing with anything, and no evening to spend well or badly.
 * A night that cannot end is a night in which no choice costs anything — which
 * is why the fire burning down, the wood being a walk away and the secondary
 * activities taking real minutes all added up to nothing at all.
 */

function night(): RitualState {
  return createRitual({
    campsiteSeed: 'one-night',
    environmentId: 'pine_hollow',
    now: 0,
    walkableRadiusM: 20,
  });
}

/** Runs the world forward the way the render loop does. */
function pass(ritual: RitualState, minutes: number): void {
  const steps = Math.round((minutes * 60) / SIM_DT);
  for (let step = 0; step < steps; step++) stepRitual(ritual, SIM_DT);
}

describe('the night runs out', () => {
  it('ends, which it did not before', () => {
    const ritual = night();
    expect(ritual.nightOver).toBe(false);
    pass(ritual, 60);
    expect(ritual.nightOver, 'an hour in and it is still night').toBe(true);
  });

  it('leaves an evening long enough to have one', () => {
    /*
     * The night has to be long enough that a player doing the thing the
     * product is about is never racing, and short enough that a player who
     * spends it somewhere else feels that. Half an hour in, it is still night.
     */
    const ritual = night();
    pass(ritual, 30);
    expect(ritual.nightOver, 'the night was over before anyone could use it').toBe(false);
  });

  it('turns over once, and never back', () => {
    /*
     * A latch rather than a flag true for one step, because the client reads
     * the world once a frame over a simulation that may have stepped many
     * times since — and a line said once a night is exactly the kind that
     * gets missed. So what is counted here is the *edge*, and that the state
     * never goes back.
     */
    const ritual = night();
    let daybreaks = 0;
    let was = ritual.nightOver;
    for (let step = 0; step < Math.round((70 * 60) / SIM_DT); step++) {
      stepRitual(ritual, SIM_DT);
      if (ritual.nightOver && !was) daybreaks += 1;
      was = ritual.nightOver;
    }
    expect(daybreaks, 'the sun came up more than once').toBe(1);
    expect(ritual.nightOver, 'it went back to being night').toBe(true);
  });

  it('does not start the ritual again in the morning', () => {
    // The one place this is enforced rather than described.
    const ritual = night();
    pass(ritual, 60);
    beginRoasting(ritual);
    expect(ritual.stage, 'the ritual restarted after the night ended').not.toBe('roasting');
  });

  it('takes nothing out of your hands', () => {
    /*
     * A marshmallow on a stick at daybreak is still yours to finish. Ending
     * the night is not the same as confiscating the evening, and a game that
     * snatches something mid-action to enforce a clock has picked the clock
     * over the person holding it.
     */
    const ritual = night();
    pass(ritual, 20);
    beginRoasting(ritual);
    expect(ritual.stage).toBe('roasting');
    pass(ritual, 40);
    expect(ritual.nightOver).toBe(true);
    expect(ritual.stage, 'the night ending took the marshmallow away').toBe('roasting');
    expect(ritual.marshmallow).not.toBeNull();
  });

  it('says something about the light rather than about the evening', () => {
    /*
     * No summary, no tally, no verdict on how the night went — the same
     * sentence whether you made a sandwich or spent the whole night at the
     * water, because the world does not know which of those was the point.
     */
    const said = describeDaybreak();
    expect(said.length).toBeGreaterThan(20);
    expect(said, 'daybreak reported a number').not.toMatch(/\d/);
    expect(said.toLowerCase()).not.toMatch(/score|complete|finish|failed|missed/);
  });
});

describe('the fire asking for you', () => {
  it('says so while there is still something to save', () => {
    /*
     * The point of saying it at all. A fire that has already gone out is a
     * rebuild; a fire that has dropped its flame over a live bed is a log.
     * Firing at the second and not the first is the difference between a
     * mechanic and a gotcha.
     */
    const ritual = night();
    let saidAt: { flame: number; ember: number } | null = null;
    for (let step = 0; step < Math.round((30 * 60) / SIM_DT); step++) {
      stepRitual(ritual, SIM_DT);
      if (ritual.fireLow && saidAt === null) {
        saidAt = { flame: ritual.fire.flame, ember: ritual.fire.emberMass };
      }
    }
    expect(saidAt, 'the fire went down and never mentioned it').not.toBeNull();
    expect(saidAt!.ember, 'it waited until there was nothing left to save').toBeGreaterThan(0.02);
  });

  it('does not nag', () => {
    // Latched on the way down and released well above where it is set, so a
    // fire hovering at the line is one remark rather than one every few
    // seconds. Counted as edges, which is what the client turns into lines.
    const ritual = night();
    let remarks = 0;
    let was = false;
    for (let step = 0; step < Math.round((45 * 60) / SIM_DT); step++) {
      stepRitual(ritual, SIM_DT);
      if (ritual.fireLow && !was) remarks += 1;
      was = ritual.fireLow;
    }
    expect(remarks, `the fire mentioned itself ${remarks} times`).toBeLessThanOrEqual(2);
  });

  it('says it again the next time, once the fire has actually come back', () => {
    /*
     * The other half of not nagging, and the half a latch gets wrong: it has
     * to release. A fire brought back up and then let go again is a second
     * evening's worth of the same mistake, and the world should say so — but
     * only after it genuinely came back, not the moment a fan raised the
     * flame for two seconds.
     */
    const ritual = night();
    let steps = 0;
    while (!ritual.fireLow && steps++ < Math.round((30 * 60) / SIM_DT)) stepRitual(ritual, SIM_DT);
    expect(ritual.fireLow, 'the fire never dropped at all').toBe(true);

    // A poke and a proper armful of wood, which is what bringing it back is.
    tendFire(ritual, { type: 'rake' });
    for (const grade of ['tinder', 'kindling', 'kindling', 'log'] as const) {
      tendFire(ritual, { type: 'add-log', woodId: 'pine', grade, moisture: 0.08 });
      pass(ritual, 0.5);
    }
    let back = 0;
    while (ritual.fireLow && back++ < Math.round((6 * 60) / SIM_DT)) stepRitual(ritual, SIM_DT);
    expect(ritual.fireLow, 'a fire brought back up was still asking for help').toBe(false);

    // And it drops again, and says so again.
    let again = 0;
    while (!ritual.fireLow && again++ < Math.round((30 * 60) / SIM_DT)) stepRitual(ritual, SIM_DT);
    expect(ritual.fireLow, 'the second time it went out, nothing was said').toBe(true);
  });

  it('describes the pit rather than instructing the player', () => {
    for (const fire of [
      { emberMass: 0.4, ashCover: 0.1 },
      { emberMass: 0.05, ashCover: 0.1 },
      { emberMass: 0.3, ashCover: 0.8 },
    ]) {
      const said = describeFailingFire(fire);
      expect(said.length).toBeGreaterThan(15);
      expect(said).not.toMatch(/\d/);
      // Never "add a log" — the player knows what a fire wants.
      expect(said.toLowerCase()).not.toMatch(/you should|add a|go and|hurry/);
    }
  });
});
