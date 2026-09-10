import { test, type Page } from '@playwright/test';
import { epochForWindow, type ActivityWindow, type WeatherKind } from '@somemore/sim';
import { act, advanceSeconds, waitForWorld } from './helpers.js';
import { captureStrip } from './strip.js';
import { driveRitual, openWorld } from './stages.js';

/**
 * Every screen in the game, captured for a person to look at.
 *
 * Not a test. It asserts nothing and cannot fail on a pixel — its whole job is
 * to produce `artifacts/gallery/`, one PNG per thing a player can be looking
 * at, so an art director can grade the game rather than a developer grading
 * their own work. The visual suite next door is the regression net; this is
 * the contact sheet.
 *
 * Kept deliberately wide. A HUD that reads beautifully at the fire and falls
 * apart out at the treeline in the rain has not been reviewed, and the only
 * way to know is to have the frame in front of you.
 */
/**
 * The sim's own weather character table, restated.
 *
 * Duplicated rather than imported because it is not exported, and a harness
 * reaching into a module's privates to set nine numbers is worse than one that
 * says which nine it means. It lives out here rather than inside the
 * `page.evaluate` because the spec needs it too: it is what the harness waits
 * for the world to agree with before taking a picture.
 */
const WEATHER_CHARACTER: Record<
  string,
  { precipitation: number; fog: number; cloud: number; wind: number }
> = {
  clear: { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 },
  'high-cloud': { precipitation: 0, fog: 0.06, cloud: 0.4, wind: 0.9 },
  overcast: { precipitation: 0, fog: 0.12, cloud: 0.92, wind: 1.2 },
  'light-rain': { precipitation: 0.3, fog: 0.2, cloud: 0.95, wind: 1.4 },
  rain: { precipitation: 0.7, fog: 0.3, cloud: 1, wind: 2.2 },
  storm: { precipitation: 1, fog: 0.35, cloud: 1, wind: 4.4 },
  fog: { precipitation: 0.02, fog: 0.9, cloud: 0.7, wind: 0.35 },
  snow: { precipitation: 0.5, fog: 0.45, cloud: 0.95, wind: 1.3 },
  'snow-squall': { precipitation: 0.9, fog: 0.75, cloud: 1, wind: 4.8 },
  // The one whose entire signature is the wind, and the one the
  // first version of this helper forgot: it set every scalar the
  // weather derives except the one that makes a gale a gale, so the
  // wind frame captured as a slightly dimmer clear night.
  wind: { precipitation: 0, fog: 0.03, cloud: 0.3, wind: 4.2 },
};

/**
 * Put the sky and the weather where a capture wants them.
 *
 * Hoisted out of the contact-sheet test so the motion sheets can reach it: a
 * storm that does not reach the ground is a still-frame complaint, and a storm
 * that does not *move* is one only a strip can show.
 */
async function setSky(page: Page, hour: ActivityWindow, weather: WeatherKind): Promise<void> {
  const epoch = epochForWindow(Date.now(), 44, -73, hour);
  const expected = WEATHER_CHARACTER[weather] ?? WEATHER_CHARACTER.clear!;
  await page.evaluate(
    ([epochMs, kind, expected]) => {
      const ritual = window.__someMore!.store.state.ritual as unknown as {
        stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
        weather: Record<string, unknown>;
      };
      ritual.stargazing.epochMs = epochMs as number;
      ritual.stargazing.elapsed = 0;
      /*
       * And make it look again.
       *
       * The sky is recomputed every twenty *simulated* seconds, not every
       * frame — it is real astronomy and there is no point running it at
       * sixty hertz. Moving the epoch without clearing this counter is
       * therefore a write that has no effect for the next twenty seconds,
       * which is longer than any of these captures wait: the first version
       * of this helper set seven different hours and produced seven
       * identical night frames, and the measurement that found it was
       * sampling the sky pixel of each one.
       */
      ritual.stargazing.secondsUntilSkyRefresh = 0;
      /*
       * The kind AND everything derived from it.
       *
       * `stepWeather` eases the scalars toward their target rather than
       * assigning them — precipitation, fog and cloud all have time
       * constants of several seconds, so setting only `kind` and waiting a
       * second and a half changes the HUD's weather glyph and almost
       * nothing else. The first version of this captured nine weather
       * states that were pixel-for-pixel the same clear night with a
       * different icon in the corner, and the grade of that set was a
       * grade of this helper rather than of the game.
       *
       * The character table is the sim's own; it is duplicated here rather
       * than imported because it is not exported, and a harness reaching
       * into a module's privates to set nine numbers is worse than a
       * harness that states which nine it means.
       */
      const character = expected;
      ritual.weather.kind = kind;
      ritual.weather.nextKind = kind;
      ritual.weather.transition = 1;
      ritual.weather.precipitation = character.precipitation;
      ritual.weather.fog = character.fog;
      ritual.weather.cloudCover = character.cloud;
      ritual.weather.windSpeed = character.wind;
      // Far enough out that nothing rolls a new sky mid-capture.
      ritual.weather.secondsUntilTransition = 100_000;
    },
    [epoch, weather, expected] as const,
  );
  /*
   * Wait for the WORLD to agree, not for a stopwatch.
   *
   * A fixed 1400 ms was not enough and the way that showed is worth
   * recording: a grader reported that the snow frame contained no snow and
   * carried the *storm* glyph, and the fog frame carried the *rain* glyph
   * — each one exactly one state behind its own filename. The captures
   * were of the previous weather with the next weather's name on them,
   * which is the third time in this session that a harness has handed a
   * reviewer a picture of something other than what it claimed.
   *
   * So it waits on the thing it actually set. The scalars ease at a rate
   * of a few tenths per second, so agreement is checked against them
   * rather than against the kind alone — the kind flips instantly and is
   * exactly what made the old wait look sufficient.
   */
  await page.waitForFunction(
    (want) => {
      const weather = window.__someMore!.store.state.ritual.weather as unknown as {
        kind: string;
        precipitation: number;
        cloudCover: number;
        fog: number;
      };
      return (
        weather.kind === want.kind &&
        Math.abs(weather.precipitation - want.precipitation) < 0.05 &&
        Math.abs(weather.cloudCover - want.cloud) < 0.05 &&
        Math.abs(weather.fog - want.fog) < 0.05
      );
    },
    {
      kind: weather as string,
      precipitation: expected.precipitation,
      cloud: expected.cloud,
      fog: expected.fog,
    },
    { timeout: 20_000 },
  );
  // And then a moment for the scene to draw what it now agrees about:
  // snow accumulating on the ground eases in over a couple of seconds by
  // design, so that the clearing whitens rather than snapping.
  await page.waitForTimeout(2600);
}

/**
 * Stand a given distance from whatever the scene calls `match`, looking at it.
 *
 * The contact sheet used to reach the treeline by writing two hard-coded
 * coordinates into the player, which works exactly as long as nobody moves the
 * treeline. Everything worth photographing out here already has a name in the
 * scene graph — `woodpile`, `shore`, `radio`, `sm-01`, each landmark by its own
 * id, each curio as `look:<secret>` — so the frame can be composed from the
 * world rather than from a guess about it, and a capture that finds nothing
 * says so instead of quietly photographing a patch of dirt.
 *
 * Returns false when there is no such thing in this campsite, because the
 * catalogue does not put every landmark in every clearing and a sheet that
 * demanded one would fail on the seed rather than on the game.
 */
async function standNear(
  page: Page,
  match: string,
  options: { distance?: number; pitch?: number; height?: number } = {},
): Promise<boolean> {
  return page.evaluate(
    ([pattern, distance, pitch]) => {
      const scene = window.__someMore!.three!.scene as unknown as {
        traverse(fn: (o: Record<string, unknown>) => void): void;
      };
      const player = window.__someMore!.player!;
      const wanted = new RegExp(pattern as string);
      let best: { x: number; z: number } | null = null;
      scene.traverse((o) => {
        if (best !== null || o['visible'] !== true) return;
        if (!wanted.test(String(o['name'] ?? ''))) return;
        const e = (o['matrixWorld'] as { elements: number[] } | undefined)?.elements;
        if (e === undefined) return;
        best = { x: e[12]!, z: e[14]! };
      });
      if (best === null) return false;
      const target = best as { x: number; z: number };
      // Approached from the fire's side, so the campsite is behind the camera
      // and the thing being looked at is lit the way a player walking out to
      // it would find it.
      const bearing = Math.atan2(target.z, target.x);
      player.position.x = target.x - Math.cos(bearing) * (distance as number);
      player.position.z = target.z - Math.sin(bearing) * (distance as number);
      player.facing = bearing;
      player.pitch = pitch as number;
      return true;
    },
    [match, options.distance ?? 2.4, options.pitch ?? -0.08] as const,
  );
}

test.describe('gallery', () => {
  test('captures every screen', async ({ page }) => {
    const shot = async (name: string): Promise<void> => {
      await page.screenshot({ path: `artifacts/gallery/${name}.png` });
    };

    await openWorld(page, 'gallery');

    // --- the ritual, stage by stage ---------------------------------------
    await driveRitual(page, async (stage) => {
      await shot(`ritual-${stage}`);
    });

    // --- the overlays -----------------------------------------------------
    for (const [name, open] of [
      ['passport', () => page.getByRole('button', { name: /passport/i }).click()],
      ['settings', () => page.getByRole('button', { name: /settings/i }).click()],
    ] as const) {
      await open();
      await page.waitForTimeout(700);
      await shot(`overlay-${name}`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }

    // The spoken survey: the one thing a player can ask the world.
    await page.keyboard.press('q');
    await page.waitForTimeout(700);
    await shot('overlay-survey');
    await page.keyboard.press('q');
    await page.waitForTimeout(300);

    // --- out in the world -------------------------------------------------
    await openWorld(page, 'gallery-wood');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire');
    await page.waitForTimeout(900);
    await shot('world-at-fire-night');

    // Walking out to the treeline, away from the firelight, which is where the
    // legibility of the whole thing is actually decided.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 9.5;
      p.position.z = 4.2;
      p.facing = Math.atan2(p.position.z, p.position.x);
      p.pitch = -0.12;
    });
    await page.waitForTimeout(900);
    await shot('world-treeline');

    // With the torch, which is what you take when you go out for wood.
    await page.evaluate(() => window.__someMore!.actions['takeTorch']?.());
    await page.waitForTimeout(900);
    await shot('world-torch');

    // Looking up. The sky is a third of the product and never gets reviewed.
    await page.evaluate(() => {
      window.__someMore!.player!.pitch = 0.62;
    });
    await page.waitForTimeout(700);
    await shot('world-sky');

    /*
     * Pins the sky to an hour and a sky, by name.
     *
     * Both halves of this were guessed before and both guesses were wrong. The
     * hours were "advance forty-five minutes and call it dusk", which reached
     * `midday` twice and captured the second one under the dusk filename — an
     * art review read those two frames and reported, correctly, that there was
     * no dusk in the build. And the weather was whatever the seed happened to
     * be doing, which across the whole run was overcast: an overcast sky is
     * flat by construction, the ramp desaturates its horizon to nothing on
     * purpose, and every hour therefore graded as the same grey frame.
     *
     * So the contact sheet chooses. `epochForWindow` is the same solver the
     * campsite itself uses to decide what time a visit starts, and the weather
     * is set on both sides of its own transition so `stepWeather` has nothing
     * left to ease toward and holds. Coverage is the whole job of a gallery;
     * leaving the sky to chance is how a third of it went unreviewed.
     */
    // `hour` rather than `window`, because inside `page.evaluate` below the
    // name `window` means the browser's.
    const set = (hour: ActivityWindow, weather: WeatherKind): Promise<void> => setSky(page, hour, weather);

    /*
     * Lying back, which is the one thing the sky was built for.
     *
     * `world-sky` above is a standing player craning their neck, and it was
     * the only frame of the sky in the whole sheet — so a grade of "the night
     * sky is unbuilt" was made against the least favourable possible view of
     * it. Stargazing tips the head all the way back and widens the lens, which
     * is when the constellations, the Milky Way and the moon's halo are
     * actually on screen together.
     */
    await page.evaluate(() => window.__someMore!.actions['lieBack']?.(true));
    await page.waitForTimeout(2200);
    await shot('world-stargazing');
    await page.evaluate(() => window.__someMore!.actions['lieBack']?.(false));
    await page.waitForTimeout(600);

    // --- the hours --------------------------------------------------------
    /*
     * The sun goes all the way round now, so the HUD has to survive daylight
     * as well as a dark clearing.
     *
     * The weather is forced clear for this stretch, which is not cheating.
     * The first grade of this gallery reported midday and dusk as the same
     * flat grey frame, and the reason turned out to be that the seed drew
     * overcast and held it for the whole run: an overcast sky *is* flat, the
     * ramp desaturates the horizon to nothing on purpose, and there is no
     * sunset to be seen under a lid. A contact sheet that can only ever show
     * one weather cannot review the sky, so this stretch pins the one
     * condition where the hours differ from each other, and the weather gets
     * reviewed separately below.
     */
    await openWorld(page, 'gallery-hours');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire');
    // Clear, so the hours differ from each other at all. Weather gets its own
    // set below, at one fixed hour, so a grade can tell a change of sky from a
    // change of time.
    for (const hour of ['pre-dawn', 'dawn', 'morning', 'midday', 'afternoon', 'dusk', 'early-night'] as const) {
      await set(hour, 'clear');
      await shot(`hour-${hour}`);
    }

    // --- the sky doing something ------------------------------------------
    // And then the weather, at one fixed hour, so a grade can tell a change of
    // sky from a change of time.
    for (const kind of ['clear', 'high-cloud', 'overcast', 'light-rain', 'rain', 'fog', 'storm', 'snow', 'wind'] as const) {
      await set('dusk', kind);
      await shot(`weather-${kind}`);
    }

    /* --- the half of the game that is not the sandwich ---------------------
     *
     * Five frames out of forty-seven covered everything a player does between
     * fires: walking out, the treeline, the curios, the wildlife, the wood
     * trip, the landmarks, the radio, the creek. That is a whole half of the
     * product graded by five pictures, which is the same gap the motion strips
     * were built to close and has the same consequence — an ungraded half
     * looks exactly like an unbuilt one.
     *
     * Composed from the scene graph rather than from coordinates, so these
     * survive the campsite being rearranged. Where a campsite genuinely does
     * not contain the thing, the frame is skipped and said out loud rather
     * than captured as an empty patch of dirt with a confident filename.
     */
    await setSky(page, 'early-night', 'clear');
    // The shot that says whether this is a place: eight metres out, looking
    // back at your own fire with the dark behind you.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 6.4;
      p.position.z = 5.2;
      p.facing = Math.atan2(-p.position.z, -p.position.x);
      p.pitch = -0.05;
    });
    await page.waitForTimeout(900);
    await shot('explore-looking-back');

    for (const [name, match, options] of [
      ['woodpile', 'woodpile', { distance: 2.2 }],
      ['creek', 'shore', { distance: 1.6, pitch: -0.2 }],
      ['radio', 'radio', { distance: 1.2, pitch: -0.3 }],
      ['machine', 'sm-01', { distance: 2.6 }],
      ['curio', '^look:', { distance: 1.4, pitch: -0.35 }],
      ['landmark', '^(?!look:|sm-01|shore|radio|woodpile|torch|sandwich|wildlife|night-sky|milky-way|offering|placed-stack|assembly-table|campfire-people$)[a-z][a-z0-9-]{3,}$', { distance: 4.5 }],
      ['wildlife', 'wildlife', { distance: 3.5, pitch: -0.1 }],
    ] as const) {
      const found = await standNear(page, match, options);
      if (!found) {
        // eslint-disable-next-line no-console
        console.log(`  no "${name}" in this campsite; frame skipped rather than faked`);
        continue;
      }
      await page.waitForTimeout(800);
      await shot(`explore-${name}`);
    }

    // The ground itself, close, in daylight — the largest surface in the game
    // and the one an art director called "one flat colour with one dither
    // pattern on it".
    await setSky(page, 'midday', 'clear');
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 3.2;
      p.position.z = 2.4;
      p.facing = 2.1;
      p.pitch = -0.55;
    });
    await page.waitForTimeout(900);
    await shot('explore-ground-close');
    // And up into the canopy from under it.
    await page.evaluate(() => {
      window.__someMore!.player!.pitch = 0.7;
    });
    await page.waitForTimeout(700);
    await shot('explore-canopy');

    /* --- a phone -----------------------------------------------------------
     *
     * Two frames out of forty-seven, on a build that ships as an installable
     * PWA and whose risk register targets four-to-five-year-old phones. The
     * one portrait frame that existed was graded "letterboxes the world down
     * to a strip in which the fire is the only content", and nobody has looked
     * at it since. The drawn overlays and the whole HUD were sized for this
     * screen and have never been graded on one.
     */
    await setSky(page, 'early-night', 'clear');
    for (const [name, width, height] of [
      ['portrait', 393, 852],
      ['landscape', 852, 393],
    ] as const) {
      await page.setViewportSize({ width, height });
      await page.waitForTimeout(900);
      await page.evaluate(() => {
        const p = window.__someMore!.player!;
        p.position.x = 1.5;
        p.position.z = 1.2;
        p.facing = Math.atan2(-p.position.z, -p.position.x);
        p.pitch = -0.08;
      });
      await page.waitForTimeout(700);
      await shot(`phone-${name}`);
      // The overlays at the size they were designed for and never seen at.
      await page.getByRole('button', { name: /settings/i }).click();
      await page.waitForTimeout(700);
      await shot(`phone-${name}-settings`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
      await page.getByRole('button', { name: /passport/i }).click();
      await page.waitForTimeout(700);
      await shot(`phone-${name}-passport`);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(400);
    }
  });
  /**
   * The half of this build a still frame cannot show.
   *
   * Everything the camera learned this session happens between frames: the
   * head trailing a fast turn on a spring and coming back past where it
   * stopped, the thing in the player's hands lagging half a second behind
   * their eyes, the stride's figure-eight, a flame bending into a gale. A
   * contact sheet of one frame each grades none of it, and an ungraded thing
   * looks exactly like a thing that was never built — which this codebase has
   * now proved ten times over.
   *
   * So: strips. Eight frames, read left to right and then down, at the moment
   * where the input has just stopped and the body is still catching up, which
   * is the only part of a spring worth looking at.
   */
  test('captures motion as contact strips', async ({ page }) => {
    await openWorld(page, 'gallery-motion');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);
    await page.waitForTimeout(1200);

    const strip = (name: string, drive: () => Promise<void>, every = 90): Promise<void> =>
      captureStrip(page, `artifacts/gallery/motion-${name}.png`, drive, { every });

    /*
     * A whip-pan, sampled after the input stops.
     *
     * The look lag is an underdamped spring: it trails about three degrees at
     * a hard turn and then overshoots and returns, which is the term that
     * makes a fast look feel like a head rather than a mouse. Held for a fifth
     * of a second and then released — the release is the picture.
     */
    await strip('whip-pan', async () => {
      await page.keyboard.down('ArrowRight');
      await page.waitForTimeout(220);
      await page.keyboard.up('ArrowRight');
    }, 70);

    // Walking: the stride's bob, the dip as weight lands, the lens widening.
    await strip('walk', async () => {
      await page.keyboard.down('w');
      await page.waitForTimeout(900);
    }, 80);
    await page.keyboard.up('w');
    await page.waitForTimeout(600);

    // The fire at conversational distance, over most of a second.
    await strip('fire', async () => {
      await page.waitForTimeout(200);
    }, 110);

    /*
     * A gale, which is the weather state whose entire signature is motion:
     * the flame's lean, sparks going sideways, the canopy moving. A still of
     * this is a slightly dimmer clear night, which is exactly the mistake an
     * earlier version of the weather harness made.
     */
    await setSky(page, 'dusk', 'storm');
    await strip('storm', async () => {
      await page.waitForTimeout(400);
    }, 110);
    await setSky(page, 'early-night', 'clear');

    /*
     * And the arm, which is the largest motion term in the build and the one
     * with nowhere else to be seen. The hand is only in the frame while
     * something is in it, so this has to come after the whole ritual.
     */
    await driveRitual(page, async () => {});
    await act(page, 'takeSandwich');
    await waitForWorld(page, "r.stage === 'eating'", 'eating', 40_000);
    await page.waitForTimeout(4000);
    await strip('held-swing', async () => {
      await page.keyboard.down('ArrowLeft');
      await page.waitForTimeout(240);
      await page.keyboard.up('ArrowLeft');
    }, 70);
  });
});
