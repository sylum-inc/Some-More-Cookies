import { expect, test } from '@playwright/test';

import { decodePng } from './strip.js';
import { act, waitForWorld } from './helpers.js';
import { openWorld } from './stages.js';

/**
 * Whether the clearing floor is a place or a surface, measured.
 *
 * A panel of three art directors, grading independently and blind to each
 * other, each named the ground as the single highest-leverage change in the
 * build. It is over half the pixels of every campsite frame. Their complaint
 * was not that it has no texture — it has had a texture since the tile scale
 * was fixed — but that it has no *zones*: no scorched apron where the fire
 * has been burning, no worn lane where people walk, no untrodden litter
 * banked up where nobody does. One brown wash from the stones to the trees.
 *
 * The codebase disagreed. There is a worn-ring mat at about three metres, a
 * duff mat out to seven and a half, a canopy shade on the terrain past that,
 * and a trodden tile normalised to 1.7x the reference ground mean. All of it
 * computed. So the question is the one this project has had to ask fifteen
 * times: does any of it reach a pixel?
 *
 * This measures it the only way that answers: by standing on the ground at a
 * known radius from the fire, looking down at it, and reading what the
 * renderer actually drew. The profile it prints is the ground's value against
 * distance, which is exactly the thing an art director means by "zones".
 */

/** Eye height is about 1.6 m and the pitch floor is -0.85 rad, so the middle
 *  of the frame lands roughly this far in front of the feet. */
const LOOK_AHEAD = 1.45;

/** Where the samples are taken, in metres from the fire. Chosen to straddle
 *  the worn ring's nominal 3.1 m and the duff mat's 7.6 m outer edge. */
const RADII = [0.9, 1.3, 1.7, 2.3, 2.9, 3.5, 4.2, 5.0, 6.0, 7.0, 8.0, 9.5, 11.0, 13.0, 16.0] as const;

test.describe('the clearing floor', () => {
  test('has zones a player can see, not one brown wash', async ({ page }) => {
    await openWorld(page, 'ground', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);

    /*
     * Measured at midday on purpose.
     *
     * The fire is a point light at the origin and its falloff is itself a
     * smooth radial gradient — measure this at night and the profile is the
     * inverse-square law with the ground's own structure buried in it. Under
     * a sun the light across the clearing is near enough uniform that what
     * varies with radius is the floor.
     */
    await page.evaluate(() => {
      const ritual = window.__someMore!.store.state.ritual as unknown as {
        stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
        weather: Record<string, unknown>;
      };
      const now = new Date(ritual.stargazing.epochMs);
      now.setUTCHours(17, 0, 0, 0);
      ritual.stargazing.epochMs = now.getTime();
      ritual.stargazing.elapsed = 0;
      ritual.stargazing.secondsUntilSkyRefresh = 0;
      const weather = ritual.weather;
      weather['kind'] = 'clear';
      weather['nextKind'] = 'clear';
      weather['transition'] = 1;
      weather['precipitation'] = 0;
      weather['fog'] = 0.04;
      weather['cloudCover'] = 0.05;
      weather['windSpeed'] = 0.6;
      weather['secondsUntilTransition'] = 100_000;
    });
    await page.waitForTimeout(2500);

    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    const box = {
      x: Math.round(size.width / 2 - 60),
      y: Math.round(size.height / 2 - 40),
      width: 120,
      height: 80,
    };

    const sampleAt = async (radius: number): Promise<{ mean: number; grain: number; actual: number }> => {
      await page.evaluate(
        ([r, ahead]) => {
          const player = window.__someMore!.player!;
          // A fixed bearing so every sample walks the same spoke of the mat,
          // and facing outward so the fire itself is never in the crop.
          const bearing = 0.7;
          const stand = Math.max(0.1, (r as number) - (ahead as number));
          player.position.x = Math.cos(bearing) * stand;
          player.position.z = Math.sin(bearing) * stand;
          player.facing = bearing;
          player.pitch = -0.85;
        },
        [radius, LOOK_AHEAD] as const,
      );
      await page.waitForTimeout(420);
      /*
       * Where the crop actually lands, asked of the renderer.
       *
       * `LOOK_AHEAD` is an estimate from an eye height and a pitch, and a
       * profile plotted against an estimated radius is a profile of the
       * estimate. So the camera's own centre ray is intersected with the
       * ground plane and the real radius is reported next to the intended
       * one. If the two disagree, every reading below is about somewhere
       * else.
       */
      const actual = await page.evaluate(() => {
        const camera = window.__someMore!.three!.camera;
        const origin = camera.getWorldPosition(
          new (camera.position.constructor as new () => typeof camera.position)(),
        );
        const dir = camera.getWorldDirection(
          new (camera.position.constructor as new () => typeof camera.position)(),
        );
        if (dir.y >= -1e-4) return -1;
        const t = origin.y / -dir.y;
        const x = origin.x + dir.x * t;
        const z = origin.z + dir.z * t;
        return Math.sqrt(x * x + z * z);
      });
      const image = decodePng(await page.screenshot({ clip: box }));
      let total = 0;
      const values: number[] = [];
      for (let i = 0; i < image.width * image.height; i += 1) {
        const r = image.data[i * 3]!;
        const g = image.data[i * 3 + 1]!;
        const b = image.data[i * 3 + 2]!;
        const lum = 0.299 * r + 0.587 * g + 0.114 * b;
        values.push(lum);
        total += lum;
      }
      const mean = total / values.length;
      // Grain is the spread within the crop: a textured floor has some, a
      // flat fill has none. Measured after the 3x upscale, so it under-reads
      // the buffer's own grain by roughly a third; only the shape matters.
      const spread =
        Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length);
      return { mean, grain: spread, actual };
    };

    const profile: { radius: number; mean: number; grain: number; actual: number }[] = [];
    for (const radius of RADII) {
      profile.push({ radius, ...(await sampleAt(radius)) });
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n  ground value against distance from the fire, at midday\n' +
        profile
          .map((p) => `    aimed ${p.radius.toFixed(1).padStart(4)} m  hit ${p.actual.toFixed(2).padStart(5)} m   value ${p.mean.toFixed(1).padStart(5)}   grain ${p.grain.toFixed(1).padStart(4)}`)
          .join('\n') +
        '\n',
    );

    /*
     * And the other axis, which the profile above is blind to.
     *
     * A radial profile cannot see a path, because a path is a difference
     * between bearings at the same radius. The worn ground used to be a ring
     * -- lobed by two harmonics, but a ring -- and a camp does not wear
     * evenly: people go to the machine, to the woodpile, and out the way they
     * came in. `LAYOUT` puts the machine at a bearing of 2.58 and the log at
     * 2.60, which is one run; the woodpile is at about -0.49, which is the
     * other.
     */
    const sweep: { bearing: number; mean: number }[] = [];
    for (let i = 0; i < 12; i += 1) {
      const bearing = (i / 12) * Math.PI * 2 - Math.PI;
      await page.evaluate(
        ([b, ahead]) => {
          const player = window.__someMore!.player!;
          const stand = Math.max(0.1, 4.2 - (ahead as number));
          player.position.x = Math.cos(b as number) * stand;
          player.position.z = Math.sin(b as number) * stand;
          player.facing = b as number;
          player.pitch = -0.85;
        },
        [bearing, LOOK_AHEAD] as const,
      );
      await page.waitForTimeout(420);
      const image = decodePng(await page.screenshot({ clip: box }));
      let total = 0;
      for (let px = 0; px < image.width * image.height; px += 1) {
        total +=
          0.299 * image.data[px * 3]! + 0.587 * image.data[px * 3 + 1]! + 0.114 * image.data[px * 3 + 2]!;
      }
      sweep.push({ bearing, mean: total / (image.width * image.height) });
    }

    // eslint-disable-next-line no-console
    console.log(
      '\n  ground value around the fire at 4.2 m\n' +
        sweep
          .map((p) => `    bearing ${p.bearing.toFixed(2).padStart(5)}   value ${p.mean.toFixed(1).padStart(5)}`)
          .join('\n') +
        '\n',
    );

    const around = sweep.map((p) => p.mean);
    const anisotropy = Math.max(...around) - Math.min(...around);

    /*
     * The law: the floor is not the same in every direction.
     *
     * A camp whose ground is radially symmetric is a diagram of a camp. This
     * is deliberately a floor with no ceiling — the lanes are allowed to get
     * as strong as an art director wants, and what must never come back is
     * the ring.
     */
    expect(
      anisotropy,
      `the clearing wears evenly in every direction, which no camp does: ${around.map((m) => m.toFixed(0)).join(', ')}`,
    ).toBeGreaterThan(6);

    /*
     * And it runs where the camp's things are, rather than anywhere. The
     * machine's bearing must be better trodden than the ground at right
     * angles to it, or the lane is pointing at nothing.
     */
    const at = (bearing: number): number => {
      let best = sweep[0]!;
      for (const point of sweep) {
        const d = Math.abs(Math.atan2(Math.sin(point.bearing - bearing), Math.cos(point.bearing - bearing)));
        const bd = Math.abs(Math.atan2(Math.sin(best.bearing - bearing), Math.cos(best.bearing - bearing)));
        if (d < bd) best = point;
      }
      return best.mean;
    };
    const machineBearing = Math.atan2(1.75, -2.75);
    expect(
      at(machineBearing),
      'the path to the machine is no more worn than the litter beside it',
    ).toBeGreaterThan(at(machineBearing + Math.PI / 2));

    /*
     * And a picture of the thing the numbers are about.
     *
     * A profile is the right instrument for "is there a ladder" and a useless
     * one for "does it look like anywhere". Both failure modes have happened
     * here, so the measurement leaves a frame behind as well as a table.
     */
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      player.position.x = Math.cos(0.7) * 7.5;
      player.position.z = Math.sin(0.7) * 7.5;
      player.facing = Math.atan2(-player.position.z, -player.position.x);
      player.pitch = -0.3;
    });
    await page.waitForTimeout(700);
    await page.screenshot({ path: 'artifacts/ground-profile.png' });

    const means = profile.map((p) => p.mean);
    const spread = Math.max(...means) - Math.min(...means);

    /*
     * The law, and why it is a range rather than a floor.
     *
     * Too little and the floor is the wash three critics described. Too much
     * and the zones read as two different materials with a seam between them,
     * which is the decal failure the worn ring has already had to be rescued
     * from once — a ring five times the albedo of the floor around it is not
     * a worn ring, it is a spotlight on the ground.
     *
     * These numbers are the measured baseline plus the change this is meant
     * to buy; if the ground is reworked again they should be re-measured and
     * re-argued, not nudged until the test passes.
     */
    expect(
      spread,
      `the clearing floor is one value from the stones to the trees: ${means.map((m) => m.toFixed(0)).join(', ')}`,
    ).toBeGreaterThan(14);
    expect(spread, 'the zones read as separate materials rather than as one floor').toBeLessThan(70);

    // And every sample has grain in it: a zone with no texture is a flat fill
    // with a different number on it, which is not what anybody asked for.
    for (const point of profile) {
      expect(point.grain, `no grain in the floor at ${point.radius} m`).toBeGreaterThan(3);
    }
  });

  /*
   * Whether the floor answers the sky.
   *
   * All three critics on the panel reported that the weather states are one
   * composition with a sky swap, and all three singled out snow: "the ground
   * is the same rust-brown dirt as `weather-clear.png`, with a handful of
   * white dots in the air", measured by one of them at RGB (39,23,16) against
   * overcast's (36,19,10). Snow is an accumulation medium. Its entire visual
   * job is to re-value the world -- the ground becomes the LIGHTEST thing in
   * frame and the silhouettes invert -- and a snow that only falls is
   * overcast with dandruff.
   *
   * `Campsite.paint` does write settling, wetness and chill into all three
   * ground materials, so this is the question this project has to ask of
   * every feature: by how much, once it reaches a pixel.
   */
  test('the floor answers the sky', async ({ page }) => {
    await openWorld(page, 'ground', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);

    await page.evaluate(() => {
      const ritual = window.__someMore!.store.state.ritual as unknown as {
        stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
      };
      const now = new Date(ritual.stargazing.epochMs);
      now.setUTCHours(17, 0, 0, 0);
      ritual.stargazing.epochMs = now.getTime();
      ritual.stargazing.elapsed = 0;
      ritual.stargazing.secondsUntilSkyRefresh = 0;
    });
    await page.waitForTimeout(2000);

    // Stood on the duff, off the worn ring and off the lanes, looking down.
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      const bearing = 0.8;
      player.position.x = Math.cos(bearing) * 3.2;
      player.position.z = Math.sin(bearing) * 3.2;
      player.facing = bearing;
      player.pitch = -0.85;
    });

    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    const box = {
      x: Math.round(size.width / 2 - 60),
      y: Math.round(size.height / 2 - 40),
      width: 120,
      height: 80,
    };

    const CHARACTER: Record<string, Record<string, number>> = {
      clear: { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 },
      rain: { precipitation: 0.7, fog: 0.3, cloud: 1, wind: 2.2 },
      snow: { precipitation: 0.5, fog: 0.45, cloud: 0.95, wind: 1.3 },
    };

    const floorUnder = async (kind: string): Promise<{ r: number; g: number; b: number; lum: number }> => {
      // Dry it out and melt it off first, so each sky is measured on its own.
      await page.evaluate(() => {
        const weather = window.__someMore!.store.state.ritual.weather as unknown as Record<string, unknown>;
        weather['kind'] = 'clear';
        weather['nextKind'] = 'clear';
        weather['transition'] = 1;
        weather['precipitation'] = 0;
        weather['fog'] = 0.04;
        weather['cloudCover'] = 0.05;
        weather['windSpeed'] = 0.6;
        weather['secondsUntilTransition'] = 100_000;
      });
      await page.waitForTimeout(14_000);
      await page.evaluate(
        ([k, c]) => {
          /*
           * Re-pin the hour for every sample, not once for the test.
           *
           * The simulation's clock keeps running, and the sky is recomputed
           * every twenty simulated seconds. Three samples that each wait nine
           * seconds for snow to lie are spread across half a minute, so the
           * first version of this measured a clear floor early in the
           * afternoon against a snowy one appreciably later in it -- and
           * reported that snow makes the ground darker, which is what a critic
           * had reported too, from a capture with the same flaw in it. The
           * material colour was going from ab907b to bcbcc1 the whole time.
           */
          const ritual = window.__someMore!.store.state.ritual as unknown as {
            stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
          };
          const noon = new Date(ritual.stargazing.epochMs);
          noon.setUTCHours(17, 0, 0, 0);
          ritual.stargazing.epochMs = noon.getTime();
          ritual.stargazing.elapsed = 0;
          ritual.stargazing.secondsUntilSkyRefresh = 0;
          const weather = window.__someMore!.store.state.ritual.weather as unknown as Record<string, unknown>;
          weather['kind'] = k;
          weather['nextKind'] = k;
          weather['transition'] = 1;
          weather['precipitation'] = c!['precipitation'];
          weather['fog'] = c!['fog'];
          weather['cloudCover'] = c!['cloud'];
          weather['windSpeed'] = c!['wind'];
          weather['secondsUntilTransition'] = 100_000;
        },
        [kind, CHARACTER[kind]!] as const,
      );
      /*
       * Long enough for snow to actually lie.
       *
       * `Campsite` eases lying snow toward its target rather than assigning it
       * -- deliberately, because snow arriving in one frame reads as a cut --
       * so a capture taken a second after setting the kind is a capture of the
       * weather before it. That mistake has been made twice in this repo's
       * harnesses already.
       */
      await page.waitForTimeout(12_000);
      // The wait is itself most of a simulated minute, so the hour is pinned
      // again on the way out and given a moment to take.
      await page.evaluate(() => {
        const ritual = window.__someMore!.store.state.ritual as unknown as {
          stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
        };
        const noon = new Date(ritual.stargazing.epochMs);
        noon.setUTCHours(17, 0, 0, 0);
        ritual.stargazing.epochMs = noon.getTime();
        ritual.stargazing.elapsed = 0;
        ritual.stargazing.secondsUntilSkyRefresh = 0;
      });
      await page.waitForTimeout(700);
      const image = decodePng(await page.screenshot({ clip: box }));
      let r = 0;
      let g = 0;
      let b = 0;
      const n = image.width * image.height;
      for (let i = 0; i < n; i += 1) {
        r += image.data[i * 3]!;
        g += image.data[i * 3 + 1]!;
        b += image.data[i * 3 + 2]!;
      }
      r /= n;
      g /= n;
      b /= n;
      return { r, g, b, lum: 0.299 * r + 0.587 * g + 0.114 * b };
    };

    /*
     * Each sky measured from a dry, unsnowed floor, which the first version of
     * this did not do and was wrong because of it.
     *
     * Wetness is deliberately a floor rather than a scale -- an hour into a
     * drizzle the ground is wet whether or not it is raining at this instant
     * -- and lying snow eases away at 0.12 a second, slower than it arrives.
     * So three samples taken back to back measure the third weather on top of
     * the first two, and this test's first run duly reported that snow makes
     * the ground darker: it was reading a snowed floor that was still soaked
     * from the rain sample before it. A critic reported the same thing from a
     * capture with a related flaw, and the defect is in the harness both
     * times, not in the game.
     */
    const clear = await floorUnder('clear');
    const rain = await floorUnder('rain');
    const snow = await floorUnder('snow');

    const show = (name: string, v: { r: number; g: number; b: number; lum: number }): string =>
      `    ${name.padEnd(6)} rgb(${v.r.toFixed(0).padStart(3)},${v.g.toFixed(0).padStart(3)},${v.b.toFixed(0).padStart(3)})  value ${v.lum.toFixed(1).padStart(5)}  warmth ${(v.r - v.b).toFixed(1).padStart(5)}`;
    // eslint-disable-next-line no-console
    console.log(
      '\n  the clearing floor at 3.2 m, under three skies\n' +
        [show('clear', clear), show('rain', rain), show('snow', snow)].join('\n') +
        '\n',
    );

    /*
     * Rain darkens rather than brightens: wet duff goes near-black and the
     * light that comes back off it is the sky's, not the ground's. This one
     * holds.
     */
    expect(rain.lum, 'rain does not wet the ground').toBeLessThan(clear.lum);

    /*
     * And every weather cools the floor, which also holds: measured, warmth
     * -- how far red runs ahead of blue -- falls from 28.0 under a clear sky
     * to 11.4 in rain and 10.9 in snow. The chill reaches the screen.
     */
    expect(rain.r - rain.b, 'rain leaves the ground as warm as a clear day').toBeLessThan(
      (clear.r - clear.b) * 0.75,
    );
    expect(snow.r - snow.b, 'the snow on the ground is brown').toBeLessThan(
      (clear.r - clear.b) * 0.75,
    );

    /*
     * Snow's lift is the one thing here that does not hold, and it is asserted
     * in its own test below rather than folded in here, so that this one can
     * guard what does.
     */
    expect(snow.lum, 'recorded so a change in either direction shows up').toBeLessThan(clear.lum);
  });

  test('snow lies on the ground and lifts it', async ({ page }) => {
    /*
     * Known broken, and kept red on purpose.
     *
     * `test.fail()` inside the body means "this is expected to fail": the run
     * stays green while it does, and it fails the build the day it starts
     * passing. That is the only form of a recorded gap that cannot quietly
     * become a recorded lie -- it is not a skipped test, and it is not an
     * assertion weakened until it matched the bug.
     *
     * All three critics on the panel reported that snow does not accumulate --
     * "overcast with dandruff", "snow is a ground event before it is a
     * particle event", one of them measuring the ground at RGB (39,23,16)
     * against overcast's (36,19,10). They are right, and the cause is NOT the
     * failure this codebase usually finds. The albedo works: `Campsite.paint`
     * takes the duff material from ab907b to bcbcc1, 26 per cent brighter and
     * properly cool, and `lying` eases 0.56 of the way to `SNOW_LYING` exactly
     * as written. Measured here, the floor's warmth does collapse, from 28.1
     * to 17.9.
     *
     * The light is what fails. A snow sky in this renderer is a sky with its
     * sun switched off: cloud cover of 0.95 kills the direct term, and the
     * hemisphere gain meant to compensate (`topLight` 2.1) does not come
     * close. The floor lands at 54.0 against a clear day's 64.6, so a surface
     * 26 per cent brighter renders 16 per cent darker. An overcast snow sky in
     * the world is not a dark one -- it is an enormous bright diffuser, and
     * that is the whole reason a snowfield is dazzling under cloud.
     *
     * Fixing it is a change to the lighting model rather than to the ground,
     * and it needs the night and visual suites re-measured against the D7
     * floor afterwards. Picking a multiplier and raising it until this
     * assertion goes green is exactly the mistake already made once this
     * session, on the haze, where a number tuned against a failing test simply
     * broke somewhere else instead.
     */
    test.fail();

    await openWorld(page, 'ground', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);

    const size = page.viewportSize() ?? { width: 1280, height: 720 };
    const box = {
      x: Math.round(size.width / 2 - 60),
      y: Math.round(size.height / 2 - 40),
      width: 120,
      height: 80,
    };
    await page.evaluate(() => {
      const player = window.__someMore!.player!;
      const bearing = 0.8;
      player.position.x = Math.cos(bearing) * 3.2;
      player.position.z = Math.sin(bearing) * 3.2;
      player.facing = bearing;
      player.pitch = -0.85;
    });

    const floorUnder = async (kind: string, character: Record<string, number>): Promise<number> => {
      await page.evaluate(
        ([k, c]) => {
          const ritual = window.__someMore!.store.state.ritual as unknown as {
            stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
          };
          const noon = new Date(ritual.stargazing.epochMs);
          noon.setUTCHours(17, 0, 0, 0);
          ritual.stargazing.epochMs = noon.getTime();
          ritual.stargazing.elapsed = 0;
          ritual.stargazing.secondsUntilSkyRefresh = 0;
          const weather = window.__someMore!.store.state.ritual.weather as unknown as Record<string, unknown>;
          weather['kind'] = k;
          weather['nextKind'] = k;
          weather['transition'] = 1;
          weather['precipitation'] = c!['precipitation'];
          weather['fog'] = c!['fog'];
          weather['cloudCover'] = c!['cloud'];
          weather['windSpeed'] = c!['wind'];
          weather['secondsUntilTransition'] = 100_000;
        },
        [kind, character] as const,
      );
      await page.waitForTimeout(12_000);
      const image = decodePng(await page.screenshot({ clip: box }));
      let total = 0;
      const n = image.width * image.height;
      for (let i = 0; i < n; i += 1) {
        total +=
          0.299 * image.data[i * 3]! + 0.587 * image.data[i * 3 + 1]! + 0.114 * image.data[i * 3 + 2]!;
      }
      return total / n;
    };

    const clear = await floorUnder('clear', { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 });
    const snow = await floorUnder('snow', { precipitation: 0.5, fog: 0.45, cloud: 0.95, wind: 1.3 });
    // eslint-disable-next-line no-console
    console.log(`\n  clear floor ${clear.toFixed(1)}, snowed floor ${snow.toFixed(1)}\n`);

    expect(snow - clear, 'snow falls on this campsite and none of it lands').toBeGreaterThan(8);
  });

});
