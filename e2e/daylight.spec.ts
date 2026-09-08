import { expect, test } from '@playwright/test';
import { act, capture } from './helpers.js';

/**
 * The sun coming up, on screen.
 *
 * The unit tests hold the colour ramp. This is the half only a browser
 * answers: whether the scene the ramp drives actually looks like the hour it
 * claims to be, and whether the campsite survives being lit by something other
 * than its own fire. Every frame is captured for a person to look at, because
 * "does daylight ruin the look" is not a question a number settles.
 */
test.describe('the sun comes up', () => {
  test('walks a whole cycle and stays legible at every hour', async ({ page }) => {
    await page.goto('/?camp=daylight&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(600);

    const readings: { minute: number; alt: number; mean: number; sky: string }[] = [];
    // Six hours of sky per fifty-six minutes of session, so four hours of
    // stepping covers a full turn and then some.
    for (let minute = 0; minute <= 240; minute += 20) {
      await page.waitForTimeout(500);
      const shot = await page.evaluate(() => {
        const three = window.__someMore!.three!;
        const sky = window.__someMore!.store.state.ritual.stargazing.sky;
        three.gl.render(three.scene, three.camera);
        const canvas = three.gl.domElement;
        const scratch = document.createElement('canvas');
        scratch.width = 160;
        scratch.height = 90;
        const ctx = scratch.getContext('2d')!;
        ctx.drawImage(canvas, 0, 0, scratch.width, scratch.height);
        const data = ctx.getImageData(0, 0, scratch.width, scratch.height).data;
        let total = 0;
        for (let i = 0; i < data.length; i += 4) {
          total += (data[i]! * 0.2126 + data[i + 1]! * 0.7152 + data[i + 2]! * 0.0722) / 255;
        }
        const background = three.scene.background as { getHexString?: () => string } | null;
        return {
          alt: (sky.sun.altitude * 180) / Math.PI,
          mean: total / (data.length / 4),
          sky: background?.getHexString?.() ?? '??????',
        };
      });
      readings.push({ minute, ...shot });
      await capture(page, `daylight-${String(minute).padStart(3, '0')}`);
      await act(page, 'advanceSeconds', 20 * 60);
    }

    // eslint-disable-next-line no-console
    for (const r of readings) {
      // eslint-disable-next-line no-console
      console.log(
        `  min ${String(r.minute).padStart(3)} | sun ${r.alt.toFixed(1).padStart(6)}° |` +
          ` frame ${r.mean.toFixed(3)} | sky #${r.sky}`,
      );
    }

    const night = readings.filter((r) => r.alt < -12);
    const day = readings.filter((r) => r.alt > 15);
    expect(night.length, 'the probe never saw a night').toBeGreaterThan(0);
    expect(day.length, 'the sun never came up').toBeGreaterThan(0);

    // The claim: a player who waits sees a different world, not a tweaked one.
    const darkest = Math.min(...night.map((r) => r.mean));
    const brightest = Math.max(...day.map((r) => r.mean));
    expect(brightest, 'daylight was not brighter than night').toBeGreaterThan(darkest * 3);

    // And it is still a picture, not a white or black rectangle. The floor is
    // the same one `night.spec.ts` holds: a dark wood, never a void.
    for (const r of readings) {
      expect(r.mean, `the frame went black at minute ${r.minute}`).toBeGreaterThan(0.01);
      expect(r.mean, `the frame blew out at minute ${r.minute}`).toBeLessThan(0.92);
    }
  });
});
