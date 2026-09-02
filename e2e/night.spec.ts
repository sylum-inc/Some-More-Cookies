/**
 * Can you see anything?
 *
 * Measuring the running product found the campsite unnavigable once the fire
 * burned down to coals: mean frame luminance around 3/255 and roughly one
 * pixel in a thousand above the visible floor, with the entire lower half of
 * the frame — the ground you walk on — at pure black.
 *
 * The cause was not the light levels on their own. The PS1 pipeline quantises
 * colour to 5 bits per channel (ADR-0003), so anything below about 8/255
 * snaps to zero: a night lit to 3/255 does not render as a very dark night,
 * it renders as nothing at all. The night now sits above that floor, lit by
 * the real moon for the date, and this test is what stops it sliding back
 * under.
 *
 * It deliberately asserts a *band*, not a minimum. A campsite at midnight
 * that reads as brightly as one at dusk has lost the thing the whole product
 * is about, so being too bright fails too.
 */

import { expect, test } from '@playwright/test';
import { advanceSeconds, waitForWorld } from './helpers.js';

/** Mean luminance and the fraction of pixels above the quantisation floor. */
async function measure(page: import('@playwright/test').Page): Promise<{
  mean: number;
  litFraction: number;
  groundMean: number;
}> {
  return page.evaluate(() => {
    const three = window.__someMore?.three as
      | { gl: { domElement: HTMLCanvasElement; render: (s: unknown, c: unknown) => void }; scene: unknown; camera: unknown }
      | undefined;
    if (!three) throw new Error('no renderer');
    // A WebGL drawing buffer is cleared once composited, so the frame has to
    // be re-rendered synchronously before it can be read.
    three.gl.render(three.scene, three.camera);
    const off = document.createElement('canvas');
    off.width = 160;
    off.height = 100;
    const ctx = off.getContext('2d');
    if (!ctx) throw new Error('no 2d context');
    ctx.drawImage(three.gl.domElement, 0, 0, off.width, off.height);
    const data = ctx.getImageData(0, 0, off.width, off.height).data;

    let sum = 0;
    let lit = 0;
    let groundSum = 0;
    let groundCount = 0;
    for (let i = 0; i < data.length; i += 4) {
      const pixel = i / 4;
      const y = Math.floor(pixel / off.width);
      const l = 0.2126 * (data[i] ?? 0) + 0.7152 * (data[i + 1] ?? 0) + 0.0722 * (data[i + 2] ?? 0);
      sum += l;
      if (l > 8) lit++;
      // The band just below the horizon: the ground you would be walking on,
      // rather than the very near foreground that is always in shadow.
      if (y > off.height * 0.5 && y < off.height * 0.8) {
        groundSum += l;
        groundCount++;
      }
    }
    const n = data.length / 4;
    return {
      mean: sum / n,
      litFraction: lit / n,
      groundMean: groundSum / Math.max(1, groundCount),
    };
  });
}

test.describe('the night is dark and legible', () => {
  test('the ground is visible by moonlight once the fire is out', async ({ page }) => {
    await page.goto('/?camp=camp-night&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1500);

    // Walked in the way a player walks in: the arrival is a real animation
    // that moves the camera, so skipping it would measure the wrong frame.
    await page.mouse.click(512, 420);
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);
    await page.waitForTimeout(1200);

    const lit = await measure(page);
    // A burning fire is the brightest thing in the world, and by a long way.
    expect(lit.mean).toBeGreaterThan(5);

    // Burn it down to nothing. Twenty-five simulated minutes with no fuel is
    // well past coals.
    await advanceSeconds(page, 1500);
    await page.waitForTimeout(1200);
    const dark = await measure(page);
    // Kept deliberately: the numbers below say the night is legible, and this
    // is the frame a person can look at to check that they agree.
    await page.screenshot({ path: 'artifacts/screenshots/night-dark.png' });

    // The fire was the light: losing it must be a large, obvious loss.
    expect(dark.mean).toBeLessThan(lit.mean);

    // But the world must not vanish. The ground you walk on has to survive
    // 5-bit quantisation, or exploring at night is exploring a black screen.
    expect(dark.groundMean).toBeGreaterThan(2.5);
    expect(dark.litFraction).toBeGreaterThan(0.002);

    // And it must still be night. A moonlit wood that reads as daylight is a
    // different product.
    expect(dark.mean).toBeLessThan(30);
  });

  /**
   * The same question, asked where the fire is not.
   *
   * The test above measures the frame from beside the pit, where a burning
   * fire — or, once it is out, a bed of coals — is still doing most of the
   * lighting. It passed while a player who walked out to the treeline for
   * firewood was looking at four to seven out of 255: under the eight that
   * five-bit quantisation can represent at all, which is to say a black
   * rectangle. Going out for wood is now something the game asks people to
   * do, so the far side of the clearing has to be somewhere you can be.
   *
   * The player is placed rather than walked, deliberately: what is being
   * measured is the renderer, the walk is tested elsewhere, and putting the
   * camera exactly where the defect was is the point.
   */
  test('the far side of the clearing is a dark wood, not a black rectangle', async ({ page }) => {
    await page.goto('/?camp=camp-night&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1500);
    await page.mouse.click(512, 420);
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);
    await page.waitForTimeout(1200);

    // Out to the treeline, looking away from camp, with the fire burned out.
    await advanceSeconds(page, 1500);
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 9.5;
      p.position.z = 4.2;
      p.facing = Math.atan2(p.position.z, p.position.x);
      p.pitch = -0.18;
    });
    await page.waitForTimeout(1200);

    const away = await measure(page);
    await page.screenshot({ path: 'artifacts/screenshots/night-treeline.png' });

    // Above the floor the pipeline can actually represent, and enough of the
    // frame with it that the wood has shapes in it.
    expect(away.groundMean).toBeGreaterThan(6);
    expect(away.mean).toBeGreaterThan(6);
    expect(away.litFraction).toBeGreaterThan(0.08);
    // Still night, and still darker than standing at a fire.
    expect(away.mean).toBeLessThan(30);
  });

  /**
   * The night going by, in pictures.
   *
   * A session carries six hours of sky across about an hour of playing, so the
   * moon genuinely crosses and goes down and the cold genuinely arrives. The
   * one thing that must never happen is the sun coming up over the campfire,
   * and the only honest way to check that is to look.
   */
  test('the sky moves through the night and never turns into a morning', async ({ page }) => {
    await page.goto('/?camp=camp-arc&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1500);
    await page.mouse.click(512, 420);
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);
    await page.waitForTimeout(1200);

    const readSky = () =>
      page.evaluate(() => {
        const r = window.__someMore!.store.state.ritual as unknown as {
          window: string;
          weather: { temperatureC: number };
          stargazing: { sky: { moon: { altitude: number; azimuth: number } } };
        };
        return {
          window: r.window,
          tempC: r.weather.temperatureC,
          moonAltitude: r.stargazing.sky.moon.altitude,
          moonAzimuth: r.stargazing.sky.moon.azimuth,
        };
      });

    const shots: { window: string; tempC: number; moonAltitude: number; mean: number }[] = [];
    for (let step = 0; step < 4; step++) {
      const sky = await readSky();
      const frame = await measure(page);
      shots.push({ ...sky, mean: frame.mean });
      await page.screenshot({ path: `artifacts/screenshots/night-arc-${step}-${sky.window}.png` });
      // Fourteen minutes: one whole part of the night.
      await advanceSeconds(page, 14 * 60);
      await page.waitForTimeout(900);
    }

    const windows = shots.map((s) => s.window);
    // The night moved. It did not sit at one hour of one evening for an hour.
    expect(new Set(windows).size).toBeGreaterThan(2);
    expect(windows[windows.length - 1]).toBe('dawn');

    // It got colder doing it.
    expect(shots[shots.length - 1]!.tempC).toBeLessThan(shots[0]!.tempC - 2);

    // The moon is somewhere else than it was.
    const moonMoved = Math.abs(shots[shots.length - 1]!.moonAltitude - shots[0]!.moonAltitude);
    expect(moonMoved).toBeGreaterThan(0.15);

    // And at no point did it become daytime.
    for (const shot of shots) expect(shot.mean).toBeLessThan(34);
  });
});
