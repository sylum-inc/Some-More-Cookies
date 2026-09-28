import { expect, test, type Page } from '@playwright/test';
import { epochForWindow, type ActivityWindow } from '@somemore/sim';

import { act, waitForWorld } from './helpers.js';
import { openWorld } from './stages.js';
import { decodePng } from './strip.js';

/**
 * Nothing on the screen outshines the fire.
 *
 * The heads-up display is drawn by the browser rather than the renderer, so no
 * light in the scene ever touched it, and measured across the contact sheet it
 * was the brightest thing on screen in nearly every frame: the reach plate's
 * marshmallow at luminance 241.1 against a fire of 237-246 on a clear night
 * and 209-218 in fog, rain, storm and snow. An art director on the panel said
 * it in one line — "the brightest, hottest thing in a game about a campfire
 * is an inventory chip" — and two others made the same complaint in other
 * words.
 *
 * `ui/hudKey.ts` now dims the chrome to a ceiling under the fire. This is the
 * measurement that holds it, in the three conditions that matter: a clear
 * night, where the HUD is supposed to be quietest; midday, where the fire is
 * weakest against the sky; and snow, which was the worst frame in the sheet.
 *
 * Measured on the screen rather than asserted on the stylesheet, because the
 * stylesheet cannot tell you what a CSS filter actually does to a pixel —
 * whether `brightness()` multiplies sRGB or linear light is exactly the kind
 * of thing this project keeps discovering the hard way.
 */

/** Mirrors `HUD_CEILING` in `apps/web/src/ui/hudKey.ts`, plus rounding. */
const CEILING: Record<'day' | 'twilight' | 'night', number> = { day: 190, twilight: 182, night: 170 };
const TOLERANCE = 6;

/** Two steps of a five-bit channel: "a clear two steps below the fire's core". */
const FIRE_MARGIN = 16;

/** Every painted HUD surface: plates, buttons, the status cluster. */
const CHROME = [
  '[data-testid="status-cluster"]',
  '[data-testid="corner-controls"] button',
  '[data-testid="reach"]',
  '[data-testid="photo-control"]',
  '[data-testid="binoculars"]',
  '[data-testid="leave-control"]',
  '[data-testid="notice"]',
  '[data-testid="guidance"]',
  '[data-testid="subtitle"]',
  '[data-testid="heat"]',
].join(', ');

async function setHour(page: Page, hour: ActivityWindow): Promise<void> {
  const epoch = epochForWindow(Date.now(), 44, -73, hour);
  await page.evaluate((epochMs) => {
    const ritual = window.__someMore!.store.state.ritual as unknown as {
      stargazing: { epochMs: number; elapsed: number; secondsUntilSkyRefresh: number };
    };
    ritual.stargazing.epochMs = epochMs;
    ritual.stargazing.elapsed = 0;
    ritual.stargazing.secondsUntilSkyRefresh = 0;
  }, epoch);
  await page.waitForFunction((want) => window.__someMore!.store.state.ritual.window === want, hour, {
    timeout: 20_000,
  });
}

async function setWeather(page: Page, kind: string, c: Record<string, number>): Promise<void> {
  await page.evaluate(
    ([k, character]) => {
      const weather = window.__someMore!.store.state.ritual.weather as unknown as Record<string, unknown>;
      weather['kind'] = k;
      weather['nextKind'] = k;
      weather['transition'] = 1;
      weather['precipitation'] = character!['precipitation'];
      weather['fog'] = character!['fog'];
      weather['cloudCover'] = character!['cloud'];
      weather['windSpeed'] = character!['wind'];
      weather['secondsUntilTransition'] = 100_000;
    },
    [kind, c] as const,
  );
}

/** Stand where the ritual stands, looking at the fire. */
async function faceTheFire(page: Page): Promise<void> {
  await page.evaluate(() => {
    const player = window.__someMore!.player!;
    const bearing = 0.9;
    player.position.x = Math.cos(bearing) * 2.2;
    player.position.z = Math.sin(bearing) * 2.2;
    player.facing = Math.atan2(-player.position.z, -player.position.x);
    player.pitch = -0.2;
  });
}

interface Reading {
  hud: number;
  fire: number;
  plates: number;
}

async function read(page: Page): Promise<Reading> {
  const layout = await page.evaluate((selector) => {
    const rects = [...document.querySelectorAll(selector)]
      .map((el) => el.getBoundingClientRect())
      .filter((r) => r.width > 4 && r.height > 4)
      .map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
    const camera = window.__someMore!.three!.camera;
    const flame = camera.position.clone().set(0, 0.45, 0).project(camera);
    return { rects, flame: { x: flame.x, y: flame.y, z: flame.z } };
  }, CHROME);

  const png = await page.screenshot();
  const image = decodePng(png);
  const luma = (x: number, y: number): number => {
    const i = (y * image.width + x) * 3;
    return 0.299 * image.data[i]! + 0.587 * image.data[i + 1]! + 0.114 * image.data[i + 2]!;
  };

  let hud = 0;
  for (const r of layout.rects) {
    for (let y = Math.max(0, Math.floor(r.y)); y < Math.min(image.height, Math.ceil(r.y + r.h)); y += 1) {
      for (let x = Math.max(0, Math.floor(r.x)); x < Math.min(image.width, Math.ceil(r.x + r.w)); x += 1) {
        hud = Math.max(hud, luma(x, y));
      }
    }
  }

  // The fire's peak, in a box round where the flame projects. The 99.5th
  // percentile rather than the maximum, so one spark does not stand in for
  // the flame.
  const cx = Math.round(((layout.flame.x + 1) / 2) * image.width);
  const cy = Math.round(((1 - layout.flame.y) / 2) * image.height);
  const values: number[] = [];
  for (let y = Math.max(0, cy - 110); y < Math.min(image.height, cy + 90); y += 1) {
    for (let x = Math.max(0, cx - 80); x < Math.min(image.width, cx + 80); x += 1) values.push(luma(x, y));
  }
  values.sort((a, b) => a - b);
  const fire = values[Math.floor(values.length * 0.995)] ?? 0;
  return { hud, fire, plates: layout.rects.length };
}

test.describe('the heads-up display', () => {
  test('never outshines the fire', async ({ page }) => {
    await openWorld(page, 'hud', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);

    // A frame to look at as well as numbers to assert: the default at-fire
    // view is where the reach plate and its brackets are on screen.
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'artifacts/hud-at-fire.png' });

    const conditions: { label: string; window: ActivityWindow; regime: keyof typeof CEILING; weather: string; c: Record<string, number> }[] = [
      { label: 'clear night', window: 'early-night', regime: 'night', weather: 'clear', c: { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 } },
      { label: 'midday', window: 'midday', regime: 'day', weather: 'clear', c: { precipitation: 0, fog: 0.04, cloud: 0.05, wind: 0.6 } },
      { label: 'snow at dusk', window: 'dusk', regime: 'twilight', weather: 'snow', c: { precipitation: 0.5, fog: 0.45, cloud: 0.95, wind: 1.3 } },
    ];

    const lines: string[] = [];
    for (const condition of conditions) {
      await setHour(page, condition.window);
      await setWeather(page, condition.weather, condition.c);
      await faceTheFire(page);
      await page.waitForTimeout(4000);
      const r = await read(page);
      lines.push(
        `    ${condition.label.padEnd(13)} hud ${r.hud.toFixed(1).padStart(5)} (${r.plates} plates, ceiling ${CEILING[condition.regime]})   fire ${r.fire.toFixed(1).padStart(5)}   lead ${(r.fire - r.hud).toFixed(1).padStart(6)}`,
      );

      expect(r.plates, `${condition.label}: no HUD plates found to measure`).toBeGreaterThan(0);
      expect(r.hud, `${condition.label}: the HUD's brightest ink is over its ceiling`).toBeLessThanOrEqual(
        CEILING[condition.regime] + TOLERANCE,
      );
      expect(r.fire - r.hud, `${condition.label}: the HUD is within two steps of the fire, or brighter`).toBeGreaterThanOrEqual(
        FIRE_MARGIN,
      );
    }
    // eslint-disable-next-line no-console
    console.log(`\n  the HUD against the fire\n${lines.join('\n')}\n`);
  });

  test('comes up to full brightness for a player using it from the keyboard', async ({ page }) => {
    /*
     * "Recessive by default, brightening only on touch" -- and a keyboard
     * player must never have to find a focused control inside a dimmed panel.
     * So keyboard focus lifts the filter on the container that holds it, and
     * a pointer click does not leave it lifted afterwards (which is why the
     * rule keys on `:focus-visible` and not `:focus-within`).
     */
    await openWorld(page, 'hud', 'pine_hollow', 'mid');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);

    const filterOf = (): Promise<string> =>
      page.evaluate(() => getComputedStyle(document.querySelector('[data-testid="corner-controls"]')!).filter);

    expect(await filterOf(), 'the corner controls are not dimmed at rest').toMatch(/brightness/);

    await page.getByRole('button', { name: /settings/i }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    expect(await filterOf(), 'keyboard focus did not bring the controls up').toBe('none');
  });
});
