import { describe, expect, it } from 'vitest';
import {
  SIM_DT,
  createRitual,
  isNight,
  isRising,
  nightProgressFromSun,
  stepRitual,
  sunState,
  windowFromSun,
  type ActivityWindow,
  type RitualState,
} from '../src/index.js';

/**
 * One clock, and it is the sun.
 *
 * There used to be two. `windowAt` counted fourteen-minute windows from
 * whichever one the session started in and clamped at dawn for ever, while the
 * astronomy module advanced a real sun on a completely separate schedule — and
 * they disagreed. Measured before this was written: the stopwatch declared the
 * night over with the sun still 7.6° below the horizon and every star at full
 * brightness, so the world said "the sky has gone grey behind the trees" into
 * a pitch-black sky.
 *
 * These are about the stopwatch being gone.
 */

const LAT = 44;
const LON = -73;

describe('which way the sun is going', () => {
  it('agrees with the direction the sun actually moves', () => {
    /*
     * The bug this exists for, and it was a real one: altitude cannot tell
     * morning from afternoon, so the answer comes from which half of the sky
     * the sun is in — and the first version had that backwards, labelled a
     * climbing sun `dusk`, and walked the whole day in reverse.
     *
     * So it is checked against the model rather than against anybody's memory
     * of the azimuth convention: sample the real sun an hour apart and compare
     * `isRising` with whether it actually got higher.
     */
    const base = Date.UTC(2024, 7, 12);
    let checked = 0;
    for (let hour = 0; hour < 48; hour++) {
      const now = sunState(new Date(base + hour * 3600e3), LAT, LON);
      const next = sunState(new Date(base + (hour + 1) * 3600e3), LAT, LON);
      // Skip the two hours a day the sun is turning over, where an hour's
      // sampling genuinely cannot say.
      if (Math.abs(next.altitude - now.altitude) < 0.02) continue;
      checked++;
      expect(
        isRising(now.azimuth),
        `at ${hour}h the sun was ${next.altitude > now.altitude ? 'climbing' : 'falling'}`,
      ).toBe(next.altitude > now.altitude);
    }
    expect(checked, 'the sweep checked nothing').toBeGreaterThan(30);
  });
});

describe('what time of day it is', () => {
  it('walks a whole day in order and comes back round', () => {
    const base = Date.UTC(2024, 7, 12);
    const seen: ActivityWindow[] = [];
    // Twenty-minute samples across two days, so a full turn is covered twice.
    for (let step = 0; step < 144; step++) {
      const sun = sunState(new Date(base + step * 20 * 60e3), LAT, LON);
      const window = windowFromSun(sun.altitude, sun.azimuth);
      if (seen[seen.length - 1] !== window) seen.push(window);
    }
    // Every part of the day happens.
    for (const window of [
      'dawn',
      'morning',
      'midday',
      'afternoon',
      'dusk',
      'early-night',
      'deep-night',
      'pre-dawn',
    ] as const) {
      expect(seen, `${window} never happened in two days`).toContain(window);
    }
    // And it comes round: a day repeats rather than ending.
    expect(seen.length).toBeGreaterThan(9);
  });

  it('never calls a climbing sun an evening, or a falling one a morning', () => {
    // The reverse-order bug, stated as the property it broke.
    const morning: ActivityWindow[] = ['dawn', 'morning'];
    const evening: ActivityWindow[] = ['dusk', 'afternoon'];
    const base = Date.UTC(2024, 7, 12);
    for (let step = 0; step < 72; step++) {
      const at = new Date(base + step * 20 * 60e3);
      const sun = sunState(at, LAT, LON);
      const later = sunState(new Date(at.getTime() + 20 * 60e3), LAT, LON);
      const window = windowFromSun(sun.altitude, sun.azimuth);
      if (later.altitude > sun.altitude + 0.01) {
        expect(evening, `a climbing sun was called ${window}`).not.toContain(window);
      }
      if (later.altitude < sun.altitude - 0.01) {
        expect(morning, `a falling sun was called ${window}`).not.toContain(window);
      }
    }
  });

  it('puts the ritual in the dark and dawn outside it', () => {
    // `dawn` is the turn, not the night: it is the first window in which the
    // evening is over, which is what the world says when it gets there.
    expect(isNight('deep-night')).toBe(true);
    expect(isNight('dusk')).toBe(true);
    expect(isNight('pre-dawn')).toBe(true);
    expect(isNight('dawn')).toBe(false);
    expect(isNight('midday')).toBe(false);
  });

  it('survives a sun that is not a number', () => {
    expect(windowFromSun(Number.NaN, 0)).toBe('deep-night');
    expect(Number.isFinite(nightProgressFromSun(Number.NaN, 0))).toBe(true);
  });
});

describe('a session on that clock', () => {
  function camp(startWindow: ActivityWindow): RitualState {
    return createRitual({
      campsiteSeed: 'clock',
      environmentId: 'pine_hollow',
      walkableRadiusM: 20,
      startWindow,
    });
  }

  function pass(ritual: RitualState, minutes: number): void {
    const steps = Math.round((minutes * 60) / SIM_DT);
    for (let step = 0; step < steps; step++) stepRitual(ritual, SIM_DT);
  }

  it('starts where it was asked to, with no date supplied', () => {
    /*
     * `startWindow` used to wind a stopwatch. Now it names an hour and the sky
     * is built for it — and the fallback used to be epoch zero, which put a
     * test's sun somewhere in 1970 and, once the sun became the clock, started
     * a dateless campsite at an arbitrary time of day.
     */
    expect(camp('deep-night').window).toBe('deep-night');
    expect(camp('midday').window).toBe('midday');
    expect(isNight(camp('early-night').window)).toBe(true);
    expect(isNight(camp('morning').window)).toBe(false);
  });

  it('gets light, and then gets dark again', { timeout: 20_000 }, () => {
    /*
     * The whole of "camp whenever". The night used to end once and stay ended,
     * because the clock stopped at dawn and there was nothing after it. A
     * player who waits out a day now gets another night — so a wasted evening
     * costs a whole turn of the sky rather than the session, which is a real
     * price and a payable one.
     */
    const ritual = camp('deep-night');
    expect(ritual.nightOver).toBe(false);

    pass(ritual, 45);
    expect(ritual.nightOver, 'the sun never came up').toBe(true);

    pass(ritual, 90);
    expect(ritual.nightOver, 'it never got dark again').toBe(false);
  });

  it('leaves an evening long enough to have one', () => {
    // The length the night has always been, and the reason it is chosen rather
    // than inherited from the astronomy: this is the product.
    const ritual = camp('dusk');
    pass(ritual, 30);
    expect(ritual.nightOver, 'the night was over before anyone could use it').toBe(false);
  });

  it('is warm in the day and coldest before it gets light', { timeout: 20_000 }, () => {
    const readings = new Map<ActivityWindow, number>();
    const ritual = camp('dusk');
    for (let minute = 0; minute < 150; minute += 5) {
      readings.set(ritual.window, ritual.weather.nightChill);
      pass(ritual, 5);
    }
    const midday = readings.get('midday');
    const deep = readings.get('deep-night');
    expect(midday, 'the day never happened').toBeDefined();
    expect(deep, 'the night never happened').toBeDefined();
    expect(midday!, 'the middle of the day was not warmer than the middle of the night')
      .toBeGreaterThan(deep!);
    expect(midday!).toBeGreaterThan(0);
    expect(deep!).toBeLessThan(-2);
  });
});
