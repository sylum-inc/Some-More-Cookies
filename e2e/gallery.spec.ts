import { test } from '@playwright/test';
import { epochForWindow, type ActivityWindow, type WeatherKind } from '@somemore/sim';
import { act, advanceSeconds, waitForWorld } from './helpers.js';
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
    const setSky = async (hour: ActivityWindow, weather: WeatherKind): Promise<void> => {
      const epoch = epochForWindow(Date.now(), 44, -73, hour);
      await page.evaluate(
        ([epochMs, kind]) => {
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
          const CHARACTER: Record<
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
          const character = CHARACTER[kind as string] ?? CHARACTER.clear!;
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
        [epoch, weather] as const,
      );
      await page.waitForTimeout(1400);
    };

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
      await setSky(hour, 'clear');
      await shot(`hour-${hour}`);
    }

    // --- the sky doing something ------------------------------------------
    // And then the weather, at one fixed hour, so a grade can tell a change of
    // sky from a change of time.
    for (const kind of ['clear', 'high-cloud', 'overcast', 'light-rain', 'rain', 'fog', 'storm', 'snow', 'wind'] as const) {
      await setSky('dusk', kind);
      await shot(`weather-${kind}`);
    }

    // --- a phone ----------------------------------------------------------
    // Where a HUD is actually hard, and the size this art direction is for.
    await page.setViewportSize({ width: 393, height: 852 });
    await page.waitForTimeout(900);
    await shot('phone-portrait');
    await page.setViewportSize({ width: 852, height: 393 });
    await page.waitForTimeout(900);
    await shot('phone-landscape');
  });
});
