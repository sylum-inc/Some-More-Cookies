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
});
