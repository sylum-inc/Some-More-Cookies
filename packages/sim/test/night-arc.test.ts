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
  stepRitual,
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

  it('says so, once, as each part of the day turns over', () => {
    /*
     * Every part now, not only the night's four.
     *
     * Dusk in particular says something it never used to. While the world was
     * always night, dusk was only ever where a session began — something you
     * arrived after rather than something that happened to you. Now that the
     * sky goes all the way round it is a thing a player can sit through and
     * wait for, and it is the moment the evening comes back.
     */
    const ritual = night({ startWindow: 'dusk' });
    const said: string[] = [];
    for (let i = 0; i < 60 * 60 * 150; i++) {
      stepRitual(ritual, SIM_DT);
      if (ritual.windowChangedTo) {
        const line = describeWindow(ritual.windowChangedTo);
        if (line) said.push(line);
      }
    }

    // A whole turn of the sky, so every window but the one it began in.
    expect(said.length).toBeGreaterThanOrEqual(7);
    expect(said[0]).toMatch(/last of the light/);
    // Starting at dusk means dusk is not announced — you were already in it —
    // but coming back round to it a day later is announced.
    expect(said.filter((line) => /before dark/.test(line))).toHaveLength(1);
    expect(said.some((line) => /grey in the east/.test(line))).toBe(true);
    expect(said.some((line) => /straight down/.test(line))).toBe(true);

    // Nothing is said twice in a row, and nothing carries a number or a verdict.
    for (let i = 1; i < said.length; i++) expect(said[i]).not.toBe(said[i - 1]);
    for (const line of said) {
      expect(line, 'a window reported a number').not.toMatch(/\d/);
      expect(line.toLowerCase()).not.toMatch(/score|complete|failed|missed/);
    }
  });

  it('the sky moves, and the sun really does come up', () => {
    /*
     * This test used to assert the opposite, and was right to at the time: the
     * world was always night, `curatedSky` pinned the hour at two in the
     * morning, and a sun over the campfire would have been the sky model's one
     * unforgivable bug.
     *
     * The world is not always night any more. What the rule protected — never
     * a blazing sun over a campfire ritual — is now held somewhere better: the
     * *ritual* is refused outside the dark, so the sun coming up ends the
     * evening instead of shining into it.
     */
    const ritual = night();
    const first = { ...ritual.stargazing.sky.moon };
    run(ritual, 56 * 60);
    const last = ritual.stargazing.sky.moon;
    // The sky is going somewhere, and not by fifteen degrees.
    expect(
      Math.abs(last.altitude - first.altitude) + Math.abs(last.azimuth - first.azimuth),
    ).toBeGreaterThan(0.5);

    // Sampled across a whole turn: it is genuinely dark for part of it and
    // genuinely light for another part.
    const altitudes: number[] = [];
    for (let i = 0; i <= 36; i++) {
      const at = new Date(
        ritual.stargazing.epochMs + (i / 36) * 150 * 60 * 1000 * ritual.stargazing.timeScale,
      );
      altitudes.push(sunState(at, 44, -73).altitude);
    }
    expect(Math.min(...altitudes), 'it was never properly dark').toBeLessThan(-0.3);
    expect(Math.max(...altitudes), 'the sun never came up').toBeGreaterThan(0.3);
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
