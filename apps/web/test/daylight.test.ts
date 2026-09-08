import { describe, expect, it } from 'vitest';
import { luminance, mix, skyLook } from '../src/render/daylight.js';

/**
 * The sun coming up, as a colour ramp.
 *
 * The simulation has had a real sun the whole time — `sunState` gives its
 * altitude and `stargazing` advances the sky six hours over a session, so it
 * genuinely crosses the horizon around minute fifty-seven. The renderer threw
 * all of it away: `curatedSky()` inside a `useMemo` with no dependencies, one
 * fixed night for ever. The dusk screenshot and the dawn screenshot had the
 * same stars in the same places.
 *
 * These are about the ramp that replaces it, tested here rather than by
 * looking at twelve screenshots, because "is the sky brighter at noon than at
 * midnight" is not a question that needs a browser.
 */

const PINE = { sky: 0x070a0f, fog: 0x0b1016 };

/** Sun altitudes across a whole day, in the order they happen. */
const DAY = [-60, -30, -18, -12, -9, -6, -3, 0, 3, 6, 12, 18, 30, 45, 60];

describe('the sky at an hour', () => {
  it('leaves the campsite its own night', () => {
    /*
     * Twelve environments state a night sky and a night fog, and those are
     * what make a pine hollow look like a pine hollow. Below astronomical
     * twilight the ramp must hand back exactly what the manifest asked for,
     * not a shared dark that makes every campsite the same place.
     */
    const mesa = { sky: 0x120d14, fog: 0x1a1218 };
    expect(skyLook(-40, PINE).sky).toBe(PINE.sky);
    expect(skyLook(-40, PINE).fog).toBe(PINE.fog);
    expect(skyLook(-40, mesa).sky).toBe(mesa.sky);
    expect(skyLook(-90, mesa).sky, 'the sun below the world was not still night').toBe(mesa.sky);
  });

  it('gets lighter all the way up and never doubles back', () => {
    // The one property that matters and the easiest to break by hand-tuning a
    // single stop: the sky may not get darker as the sun rises.
    let lastSky = -1;
    let lastFog = -1;
    for (const altitude of DAY) {
      const look = skyLook(altitude, PINE);
      const sky = luminance(look.sky);
      const fog = luminance(look.fog);
      expect(sky, `the sky got darker as the sun rose, at ${altitude}°`).toBeGreaterThanOrEqual(
        lastSky - 1e-9,
      );
      // The fog too, for the same reason and by the same hand-tuning slip: it
      // is the horizon, and a horizon that dims at noon reads as a storm.
      expect(fog, `the fog got darker as the sun rose, at ${altitude}°`).toBeGreaterThanOrEqual(
        lastFog - 1e-9,
      );
      lastSky = sky;
      lastFog = fog;
    }
  });

  it('is genuinely day at the top and genuinely night at the bottom', () => {
    // The claim the whole thing exists to make. A player who watches the sun
    // come up should be looking at a different picture, not a slightly
    // adjusted one.
    const night = luminance(skyLook(-40, PINE).sky);
    const noon = luminance(skyLook(45, PINE).sky);
    expect(night).toBeLessThan(0.06);
    expect(noon).toBeGreaterThan(0.5);
    expect(noon / Math.max(night, 0.001)).toBeGreaterThan(10);
  });

  it('hands the key light from the moon to the sun without a cut', () => {
    /*
     * A crossfade rather than a switch. At civil twilight both bodies are up
     * and neither is doing much, and swapping between them at a threshold is
     * the kind of pop that makes a sky read as a slideshow.
     */
    let last = -1;
    for (const altitude of DAY) {
      const share = skyLook(altitude, PINE).sunShare;
      expect(share).toBeGreaterThanOrEqual(last - 1e-9);
      expect(share).toBeGreaterThanOrEqual(0);
      expect(share).toBeLessThanOrEqual(1);
      last = share;
    }
    // And it is a ramp, not a step: partway through twilight it is partway.
    const twilight = skyLook(-4, PINE).sunShare;
    expect(twilight).toBeGreaterThan(0.1);
    expect(twilight).toBeLessThan(0.9);
  });

  it('does not light the ground before the sun is anywhere near up', () => {
    // Nautical twilight is dark. A sun eleven degrees under the horizon
    // casting light on the trees would be the whole illusion gone.
    expect(skyLook(-12, PINE).sunIntensity).toBe(0);
    expect(skyLook(-30, PINE).sunIntensity).toBe(0);
    expect(skyLook(-12, PINE).sunDisc).toBe(0);
  });

  it('is warmest on the horizon and whitest overhead', () => {
    // The low sun is the hour the spec calls the campsite's best-looking, and
    // it is warm because of the air it travels through, not because somebody
    // liked orange.
    const warmth = (color: number) => ((color >> 16) & 0xff) - (color & 0xff);
    expect(warmth(skyLook(1, PINE).sunColor)).toBeGreaterThan(
      warmth(skyLook(45, PINE).sunColor),
    );
    expect(warmth(skyLook(6, PINE).sunColor)).toBeGreaterThan(60);
  });

  it('puts the moon away as the sky comes up', () => {
    expect(skyLook(-30, PINE).moonDisc).toBeGreaterThan(0.9);
    expect(skyLook(6, PINE).moonDisc, 'the moon was still hanging there at breakfast').toBe(0);
  });
});

describe('weather over the top of it', () => {
  it('flattens a noon into an overcast one', () => {
    /*
     * Overcast is not "darker": it is the sky and the fog becoming the same
     * thing, and the sun stopping being a disc long before it stops being a
     * light. Getting this wrong looks like night in the middle of the day.
     */
    const clear = skyLook(45, PINE, 0);
    const grey = skyLook(45, PINE, 1);
    expect(luminance(grey.sky)).toBeGreaterThan(0.4);
    // Sky and fog converge.
    const spread = (look: { sky: number; fog: number }) =>
      Math.abs(luminance(look.sky) - luminance(look.fog));
    expect(spread(grey)).toBeLessThan(spread(clear));
    // Direct light drops, fill rises, and there is no disc to see.
    expect(grey.sunIntensity).toBeLessThan(clear.sunIntensity * 0.4);
    expect(grey.ambientIntensity).toBeGreaterThan(clear.ambientIntensity);
    expect(grey.sunDisc).toBeLessThan(0.06);
  });

  it('never turns an overcast day into a night', () => {
    // The failure this guards is real: multiplying everything by (1 - cloud)
    // makes a rainy afternoon darker than midnight.
    for (const cloud of [0, 0.25, 0.5, 0.75, 1]) {
      const noon = luminance(skyLook(40, PINE, cloud).sky);
      const midnight = luminance(skyLook(-40, PINE, 0).sky);
      expect(noon, `an overcast noon at ${cloud} cloud was as dark as night`).toBeGreaterThan(
        midnight * 6,
      );
    }
  });
});

describe('the colour blend underneath it', () => {
  it('returns the ends unchanged and stays in gamut', () => {
    expect(mix(0x000000, 0xffffff, 0)).toBe(0x000000);
    expect(mix(0x000000, 0xffffff, 1)).toBe(0xffffff);
    expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
    // Out-of-range t is clamped rather than producing an impossible colour.
    expect(mix(0x102030, 0x405060, -3)).toBe(0x102030);
    expect(mix(0x102030, 0x405060, 12)).toBe(0x405060);
  });

  it('survives a sun altitude that is not a number', () => {
    // `sunState` reads a real date; a bad one must not paint the sky NaN.
    const look = skyLook(Number.NaN, PINE);
    expect(look.sky).toBe(PINE.sky);
    expect(Number.isFinite(look.sunIntensity)).toBe(true);
  });
});

describe('aerial perspective points the right way', () => {
  /*
   * The rule a whole session of screenshots failed to notice.
   *
   * Distance fog is the sky in front of an object, so a fogged object
   * converges toward the sky it is seen against and can never overshoot past
   * it. The ramp used to carry a `fog` colour authored independently of the
   * sky, which measured on a clear night as a treeline at luminance 32 against
   * a sky at 9 — three and a half times brighter than the thing behind it,
   * warm, at night, from no light source. Every distant tree in the game was a
   * pale cutout in front of a dark sky instead of a dark one behind a bright
   * sky, at every hour.
   *
   * Asserted as a law rather than as a number, because the numbers are meant
   * to be tuned and the law is not.
   */
  const PLACES = [
    { name: 'pine hollow', night: { sky: 0x070a0f, fog: 0x0b1016 } },
    { name: 'mesa', night: { sky: 0x120d14, fog: 0x1a1218 } },
    { name: 'a bright-fogged site', night: { sky: 0x05070a, fog: 0x243040 } },
  ];

  for (const place of PLACES) {
    it(`never makes the far distance brighter than the sky above it at ${place.name}`, () => {
      for (const altitude of [-40, -18, -10, -6, -2, 0, 4, 10, 25, 60]) {
        for (const cloud of [0, 0.5, 1]) {
          const look = skyLook(altitude, place.night, cloud);
          /*
           * The horizon may be brighter than the zenith — that is what a
           * sunset and a hazy noon both are. What may not happen is fog
           * landing outside the range the sky itself spans, because there is
           * nothing for it to be the colour OF.
           */
          const low = Math.min(luminance(look.sky), luminance(look.horizon));
          const high = Math.max(luminance(look.sky), luminance(look.horizon));
          const fog = luminance(look.fog);
          expect(fog, `${altitude}deg cloud ${cloud}: fog below both sky values`).toBeGreaterThanOrEqual(low - 0.02);
          expect(fog, `${altitude}deg cloud ${cloud}: fog brighter than the sky`).toBeLessThanOrEqual(high + 0.02);
        }
      }
    });
  }

  it('keeps the far distance close to the horizon rather than to the zenith', () => {
    // Which is the actual claim: a tree at forty metres is seen against the
    // band just above the treeline, not against the sky straight up.
    for (const altitude of [-20, 0, 30]) {
      const look = skyLook(altitude, PLACES[0]!.night);
      const toHorizon = Math.abs(luminance(look.fog) - luminance(look.horizon));
      const toZenith = Math.abs(luminance(look.fog) - luminance(look.sky));
      expect(toHorizon, `${altitude}deg`).toBeLessThanOrEqual(toZenith + 0.001);
    }
  });
});
