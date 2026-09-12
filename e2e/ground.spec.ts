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
});
