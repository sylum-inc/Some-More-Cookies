import { test } from '@playwright/test';
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

    // --- the hours --------------------------------------------------------
    // The sun goes all the way round now, so the HUD has to survive daylight
    // as well as a dark clearing.
    await openWorld(page, 'gallery-hours');
    await act(page, 'arrive');
    await waitForWorld(page, "r.stage === 'at-fire'", 'at fire');
    for (const [name, minutes] of [
      ['dawn', 40],
      ['morning', 15],
      ['midday', 20],
      ['dusk', 45],
    ] as const) {
      await advanceSeconds(page, minutes * 60);
      await page.waitForTimeout(900);
      await shot(`hour-${name}`);
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
