import { describe, expect, it } from 'vitest';
import {
  lightningStrike,
  luminance,
  mix,
  skyAt,
  skyLook,
  weatherLook,
} from '../src/render/daylight.js';

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

  /*
   * And the assertion that would have caught the ghost trees, which did not
   * exist.
   *
   * The three tests above state the law against `sky` and `horizon`, which are
   * the two colours the ramp happens to name. Neither of them is the sky a
   * *tree* is seen against. The dome ramped from the horizon to the zenith over
   * eight degrees, so everything above eight degrees was painted flat zenith; a
   * conifer crown at this campsite's ring sits seven to eighteen degrees up; and
   * distance fog resolved to the horizon whatever the height. Each of those was
   * defensible alone, and together they drew pale cutouts standing in front of a
   * darker sky at every hour of the day, with the suite green throughout.
   *
   * Measured on the shipped midday capture: crowns at 169-183 against a sky at
   * 100.7. Measured against the ramp's own numbers — before even accounting for
   * the dome's missing colour-space encode, which doubled it — the fog overshot
   * the sky at the treeline by 43.8 at midday, 39.1 at mid-morning and 55.3 at
   * dusk out of 255. This test fails by every one of those margins on the code
   * it was written against.
   *
   * `skyAt` is the dome's own fragment arithmetic, exported so the question a
   * screenshot answers can be put to the module directly.
   */
  /** Every elevation a fogged pixel in this game can be at, as sin(elevation). */
  const TREELINE = [0, 2, 4, 6, 8, 10, 12, 14, 16, 18].map((deg) => Math.sin((deg * Math.PI) / 180));

  it('never draws a fogged tree brighter than the sky immediately behind it', () => {
    for (const place of PLACES) {
      for (const altitude of [-40, -18, -12, -6, -2, 0, 4, 10, 25, 45, 60]) {
        for (const cloud of [0, 0.3, 0.5, 0.92, 1]) {
          for (const gloom of [0, 0.34, 1]) {
            const look = skyLook(altitude, place.night, cloud, gloom);
            const fog = luminance(look.fog);
            for (const h of TREELINE) {
              const sky = luminance(skyAt(look, h));
              expect(
                fog,
                `${place.name} ${altitude}deg cloud ${cloud} gloom ${gloom}: fog ${(fog * 255).toFixed(1)} over sky ${(sky * 255).toFixed(1)} at sin ${h.toFixed(3)}`,
              ).toBeLessThanOrEqual(sky + 0.006);
            }
          }
        }
      }
    }
  });

  it('paints the dome and the fog out of the same numbers', () => {
    // Not a tautology: the point is that `haze` is a real third stop and not a
    // second name for one of the other two. If it ever collapses back onto the
    // horizon in daylight, the eight-degree band is back and so are the ghosts.
    const noon = skyLook(45, PLACES[0]!.night);
    expect(luminance(noon.haze)).toBeLessThan(luminance(noon.horizon) - 0.02);
    expect(luminance(noon.haze)).toBeGreaterThan(luminance(noon.sky) + 0.02);
    // And at night there is no scattered sunlight, so there is no third stop:
    // the campsite keeps exactly the fog its manifest asked for.
    const night = skyLook(-40, PLACES[0]!.night);
    expect(night.haze).toBe(night.horizon);
    expect(night.fog).toBe(PLACES[0]!.night.fog);
  });

  it('darkens the ceiling without touching the strip under it', () => {
    /*
     * Which is what lets "the storm is the darkest state" survive the D7 floor.
     * The lid comes down on the zenith; the horizon and the fog — the two
     * colours the far side of the clearing actually resolves to, and the ones
     * `e2e/night.spec.ts` measures — are left exactly where they were.
     */
    for (const altitude of [-40, -6, 0, 20, 50]) {
      const calm = skyLook(altitude, PLACES[0]!.night, 1, 0);
      const lid = skyLook(altitude, PLACES[0]!.night, 1, 1);
      expect(luminance(lid.sky), `${altitude}deg`).toBeLessThan(luminance(calm.sky) + 1e-9);
      expect(lid.horizon, `${altitude}deg: the horizon moved`).toBe(calm.horizon);
      expect(lid.fog, `${altitude}deg: the fog moved`).toBe(calm.fog);
    }
    // And it is a real difference rather than a rounding one, wherever there is
    // a sky to darken at all.
    expect(luminance(skyLook(50, PLACES[0]!.night, 1, 1).sky)).toBeLessThan(
      luminance(skyLook(50, PLACES[0]!.night, 1, 0).sky) * 0.55,
    );
  });
});

describe('the nine weather states, on the ground and the props', () => {
  /*
   * The lowest-scoring group in the art grade, and the charge was that the
   * states are indistinguishable. Measured off the contact sheet, the near
   * ground ran from 17.6 to 29.8 out of 255 across all nine — twelve steps of
   * separation for nine conditions — with snow at 20.0 sitting between storm at
   * 19.6 and rain at 21.4.
   *
   * Everything weather did went through `cloudCover`, `fog` and
   * `precipitation`, and all three of those are sky terms: they move the dome,
   * the draw distance and a particle emitter, and nothing in the chain ever
   * reached an albedo. `weatherLook` is the missing half, so this is where "can
   * a player name the weather from the picture" becomes a question with an
   * answer rather than a screenshot to squint at.
   */
  const KINDS = [
    'clear', 'high-cloud', 'overcast', 'light-rain', 'rain',
    'storm', 'fog', 'snow', 'snow-squall', 'wind',
  ] as const;

  /** The sim's own character table, for the scalars each kind settles at. */
  const CHARACTER: Record<string, { precipitation: number; windSpeed: number }> = {
    clear: { precipitation: 0, windSpeed: 0.66 },
    'high-cloud': { precipitation: 0, windSpeed: 0.99 },
    overcast: { precipitation: 0, windSpeed: 1.32 },
    'light-rain': { precipitation: 0.3, windSpeed: 1.54 },
    rain: { precipitation: 0.7, windSpeed: 2.42 },
    storm: { precipitation: 1, windSpeed: 4.84 },
    fog: { precipitation: 0.02, windSpeed: 0.39 },
    snow: { precipitation: 0.5, windSpeed: 1.43 },
    'snow-squall': { precipitation: 0.9, windSpeed: 5.28 },
    wind: { precipitation: 0, windSpeed: 4.62 },
  };

  const settled = (kind: string) =>
    weatherLook({ kind, nextKind: kind, transition: 1, ...CHARACTER[kind]! });

  it('gives every kind a signature that is not the sky', () => {
    /*
     * A fingerprint per kind over the surface properties only — nothing in it
     * touches the dome. Two kinds sharing one is a pair a player cannot tell
     * apart on the ground, which is exactly the complaint.
     */
    const seen = new Map<string, string>();
    for (const kind of KINDS) {
      const s = settled(kind);
      const print = [
        s.wet.toFixed(2), s.settling.toFixed(2), s.groundValue.toFixed(2),
        s.chill.toFixed(2), s.topLight.toFixed(2), s.puddles.toFixed(2),
        s.shear.toFixed(2), s.lightning,
      ].join('/');
      const clash = seen.get(print);
      expect(clash, `${kind} and ${clash} are the same weather on the ground`).toBeUndefined();
      seen.set(print, kind);
    }
  });

  it('wets the ground for rain and whitens it for snow, and never both', () => {
    for (const kind of ['light-rain', 'rain', 'storm'] as const) {
      expect(settled(kind).wet, kind).toBeGreaterThan(0.25);
      expect(settled(kind).settling, kind).toBe(0);
      expect(settled(kind).puddles, kind).toBeGreaterThan(0.1);
    }
    for (const kind of ['snow', 'snow-squall'] as const) {
      expect(settled(kind).settling, kind).toBeGreaterThan(0.4);
      expect(settled(kind).wet, kind).toBe(0);
      expect(settled(kind).puddles, kind).toBe(0);
      // The whole palette cool and high-key, which is the other half of snow.
      expect(settled(kind).chill, kind).toBe(1);
      expect(settled(kind).topLight, kind).toBeGreaterThan(1.9);
    }
    for (const kind of ['clear', 'high-cloud', 'wind'] as const) {
      expect(settled(kind).wet, kind).toBe(0);
      expect(settled(kind).settling, kind).toBe(0);
    }
  });

  it('puts white on the upward faces rather than on the whole prop', () => {
    /*
     * `topColor` and `topLight` drive the hemisphere light, which shades by the
     * surface normal's Y and by nothing else — so they are the log top, the
     * stone tops, the machine's roof and the crowns, with the sides left alone.
     * Snow drives them white and hard; rain drives them a cold steel blue at
     * about two thirds of that; a clear night leaves the sky exactly as it is.
     */
    expect(settled('clear').topColor).toBe(0);
    expect(settled('clear').topLight).toBe(1);
    for (const kind of ['snow', 'snow-squall'] as const) {
      const s = settled(kind);
      expect(luminance(s.topColor), kind).toBeGreaterThan(0.85);
    }
    for (const kind of ['rain', 'storm', 'light-rain'] as const) {
      const s = settled(kind);
      expect(luminance(s.topColor), kind).toBeLessThan(0.75);
      expect(s.topLight, kind).toBeGreaterThan(1.2);
      // Cold, not neutral: blue above red is the whole of a wet sheen.
      expect(s.topColor & 0xff, kind).toBeGreaterThan((s.topColor >> 16) & 0xff);
    }
  });

  it('makes the storm the darkest state in the set, and not by crushing the ground', () => {
    const storm = settled('storm');
    for (const kind of KINDS) {
      if (kind === 'storm') continue;
      expect(storm.gloom, `${kind} had a heavier lid than the storm`).toBeGreaterThan(
        settled(kind).gloom,
      );
    }
    /*
     * D7 is a floor and "darkest" is not a licence to go through it. What makes
     * the storm dark is the ceiling, the chroma out of everything, and the fire
     * being the only warm thing left — the ground itself keeps better than three
     * quarters of its albedo in every state in the set.
     */
    for (const kind of KINDS) {
      expect(settled(kind).groundValue, kind).toBeGreaterThan(0.75);
    }
  });

  it('leans the falling weather by the state rather than by the gust', () => {
    /*
     * The lean used to be the instantaneous wind speed, and the simulation's
     * gust term swings between roughly half and one and a half of the base at
     * all times — so a downpour on a lull sheared less than a drizzle on a gust,
     * and the picture said nothing about which weather it was.
     */
    expect(settled('storm').shear).toBeGreaterThan(settled('rain').shear);
    expect(settled('rain').shear).toBeGreaterThan(settled('light-rain').shear);
    expect(settled('snow-squall').shear).toBeGreaterThan(settled('snow').shear);
    // A gale with no cloud in it still lays everything over: this is the only
    // signature `wind` has, and it had none at all before.
    expect(settled('wind').shear).toBeGreaterThan(0.6);
    // And fog is the stillest thing there is.
    expect(settled('fog').shear).toBeLessThan(0.1);
  });

  it('never lets a gust turn a calm kind into a gale', () => {
    /*
     * The other half of the same idea, and the bug it was written for.
     *
     * `shear` deliberately takes the greater of the kind's lean and the live
     * wind, because a lull in a storm should still lay the rain over. That is
     * right for drawing the lean of something already falling, and wrong for
     * deciding whether anything is in the air at all: `Campsite` was keying
     * windblown litter on `shear`, and the gust term reaches up to roughly one
     * and a half of the base, so a clear night with an authored shear of 0.08
     * crossed the threshold several times a minute and drew warm diagonal
     * streaks across the stars. `gale` is the same blend with the gust floor
     * removed, and is what anything asking "is this a gale" must read.
     *
     * The law: no wind speed, however absurd, may lift a calm kind's `gale`.
     */
    for (const kind of KINDS) {
      const calm = weatherLook({ kind, nextKind: kind, transition: 1, ...CHARACTER[kind]!, windSpeed: 0 });
      for (const windSpeed of [3, 6, 12, 40]) {
        const gusting = weatherLook({
          kind, nextKind: kind, transition: 1, ...CHARACTER[kind]!, windSpeed,
        });
        expect(gusting.gale, `${kind} at ${windSpeed} m/s`).toBeCloseTo(calm.gale, 6);
        // The lean itself is still allowed to answer the wind.
        expect(gusting.shear).toBeGreaterThanOrEqual(gusting.gale - 1e-9);
      }
    }

    /*
     * And the separation the threshold depends on: the two states that are
     * meant to blow are clear of it, and everything a player would call calm
     * is well under. If a kind is ever re-authored across 0.6, this fails and
     * whoever moved it has to decide on purpose whether litter now flies in it.
     */
    expect(settled('wind').gale).toBeGreaterThan(0.6);
    expect(settled('storm').gale).toBeGreaterThan(0.6);
    for (const kind of ['clear', 'high-cloud', 'overcast', 'light-rain', 'rain', 'fog', 'snow']) {
      expect(settled(kind).gale, kind).toBeLessThan(0.6);
    }
  });

  it('only the storm flashes, and the flash is a shape rather than a roll', () => {
    for (const kind of KINDS) {
      expect(settled(kind).lightning, kind).toBe(kind === 'storm');
    }
    // Two strikes close together, then a long wait: the second is the same
    // bolt's afterglow.
    expect(lightningStrike(0)).toBeCloseTo(1, 5);
    expect(lightningStrike(0.19)).toBeCloseTo(0.55, 5);
    expect(lightningStrike(4)).toBe(0);
    // Deterministic in elapsed time, so it cannot fire twice in a frame.
    expect(lightningStrike(8.5)).toBe(lightningStrike(0));
    // Bounded, because it is added to an ambient intensity and mixed into a sky.
    for (let t = 0; t < 17; t += 0.011) {
      expect(lightningStrike(t)).toBeGreaterThanOrEqual(0);
      expect(lightningStrike(t)).toBeLessThanOrEqual(1);
    }
  });

  it('arrives over a transition rather than between two frames', () => {
    const dry = weatherLook({ kind: 'clear', nextKind: 'rain', transition: 0, precipitation: 0 });
    const half = weatherLook({ kind: 'clear', nextKind: 'rain', transition: 0.5, precipitation: 0.35 });
    const wet = weatherLook({ kind: 'rain', nextKind: 'rain', transition: 1, precipitation: 0.7 });
    expect(dry.wet).toBe(0);
    expect(half.wet).toBeGreaterThan(dry.wet);
    expect(half.wet).toBeLessThan(wet.wet);
    expect(half.puddles).toBeLessThan(wet.puddles);
  });

  it('does not fall over on a weather kind it has never heard of', () => {
    const look = weatherLook({ kind: 'ash-fall', nextKind: 'ash-fall', transition: 1 });
    expect(look.gloom).toBe(0);
    expect(look.settling).toBe(0);
    expect(Number.isFinite(look.shear)).toBe(true);
  });
});
