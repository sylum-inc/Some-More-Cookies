/**
 * The night going by.
 *
 * The only progression this product has. Nothing here unlocks anything or
 * scores anything — the tests are about whether an evening has a shape you can
 * feel: the sky moving, the cold coming on, the animals keeping hours, and
 * first light arriving before you were quite ready for it.
 */
import { describe, expect, it } from 'vitest';
import {
  createRitual,
  describeWindow,
  nightChill,
  nightProgress,
  stepRitual,
  windowAt,
} from '../src/ritual.js';
import { nightEpoch, sunState } from '../src/astronomy.js';
import { SIM_DT } from '../src/types.js';

function night(overrides: Partial<Parameters<typeof createRitual>[0]> = {}) {
  return createRitual({
    campsiteSeed: 'arc',
    environmentId: 'pinewood',
    // A real date, at this campsite's own small hours, the way the client does.
    skyEpochMs: nightEpoch(new Date(Date.UTC(2026, 2, 14, 20, 0, 0)), -73),
    ...overrides,
  });
}

function run(ritual: ReturnType<typeof createRitual>, seconds: number): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) stepRitual(ritual, SIM_DT);
}

describe('the shape of a night', () => {
  it('runs from dusk to first light in about an hour', () => {
    // Fourteen minutes to a window, five windows, so a whole night is about
    // seventy minutes and a session that starts after dark is shorter still.
    expect(windowAt('dusk', 0)).toBe('dusk');
    expect(windowAt('dusk', 60 * 50)).toBe('pre-dawn');
    expect(windowAt('dusk', 60 * 57)).toBe('dawn');
    // And stays there. The night does not loop.
    expect(windowAt('dusk', 60 * 300)).toBe('dawn');
  });

  it('places a session inside the night rather than at one instant of it', () => {
    expect(nightProgress('dusk', 0)).toBe(0);
    expect(nightProgress('dusk', 56 * 60)).toBeCloseTo(1, 3);
    // Arriving late starts you late.
    expect(nightProgress('deep-night', 0)).toBeCloseTo(0.5, 3);
  });

  it('gets colder as it goes, worst before it gets light, easing at dawn', () => {
    expect(nightChill(0)).toBeCloseTo(0, 3);
    expect(nightChill(0.5)).toBeLessThan(-2);
    expect(nightChill(0.85)).toBeLessThan(nightChill(0.5));
    // Dawn takes the edge off it, and never puts it back above dusk.
    expect(nightChill(1)).toBeGreaterThan(nightChill(0.85));
    expect(nightChill(1)).toBeLessThan(0);
  });

  it('the cold reaches the weather, and the fire feels it', () => {
    const ritual = night();
    run(ritual, 90);
    const early = ritual.weather.temperatureC;
    run(ritual, 45 * 60);
    const late = ritual.weather.temperatureC;
    expect(late).toBeLessThan(early - 3);
    // The fire is told, because the fire is what the cold is about.
    expect(ritual.fire.config.ambientC).toBeCloseTo(late, 5);
  });

  it('says so, once, as each part of the night turns over', () => {
    const ritual = night();
    const said: string[] = [];
    for (let i = 0; i < 60 * 60 * 75; i++) {
      stepRitual(ritual, SIM_DT);
      if (ritual.windowChangedTo) {
        const line = describeWindow(ritual.windowChangedTo);
        if (line) said.push(line);
      }
    }
    /*
     * Three, not four: a session starts after dark by default, so dusk is
     * something you arrived after rather than something that happens to you.
     * Starting at dusk gets you the fourth, which the line below checks.
     */
    expect(said).toHaveLength(3);
    expect(new Set(said).size).toBe(3);
    expect(said[said.length - 1]).toMatch(/grey in the east/);
    // Dusk is where a night starts, so it is not something that happens to you.
    expect(describeWindow('dusk')).toBeNull();

    const fromDusk = night({ startWindow: 'dusk' });
    const early: string[] = [];
    for (let i = 0; i < 60 * 60 * 75; i++) {
      stepRitual(fromDusk, SIM_DT);
      if (fromDusk.windowChangedTo) {
        const line = describeWindow(fromDusk.windowChangedTo);
        if (line) early.push(line);
      }
    }
    expect(early).toHaveLength(4);
    expect(early[0]).toMatch(/last of the light/);
  });

  it('the sky actually moves, and never puts the sun up over the campfire', () => {
    const ritual = night();
    const first = { ...ritual.stargazing.sky.moon };
    run(ritual, 56 * 60);
    const last = ritual.stargazing.sky.moon;
    // Six hours of sky: the moon has gone a long way, not fifteen degrees.
    expect(Math.abs(last.altitude - first.altitude) + Math.abs(last.azimuth - first.azimuth)).toBeGreaterThan(0.5);

    // And the one thing the sky model must never do (spec §5.5): the world is
    // always night. Checked across the whole arc, not only at the ends.
    for (let i = 0; i <= 12; i++) {
      const at = new Date(
        ritual.stargazing.epochMs + ((i / 12) * 56 * 60) * 1000 * ritual.stargazing.timeScale,
      );
      const sun = sunState(at, 44, -73);
      expect(sun.altitude).toBeLessThan(-0.05);
    }
  });

  it('is the same night twice, given the same campsite', () => {
    const a = night();
    const b = night();
    run(a, 40 * 60);
    run(b, 40 * 60);
    expect(a.window).toBe(b.window);
    expect(a.weather.temperatureC).toBe(b.weather.temperatureC);
    expect(a.stargazing.sky.moon.altitude).toBe(b.stargazing.sky.moon.altitude);
  });
});
