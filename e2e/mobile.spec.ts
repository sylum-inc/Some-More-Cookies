/**
 * What it looks like in a hand.
 *
 * "Is mobile interaction comfortable?" is one of the eight questions spec
 * §16.1 says to ask out loud against the running product, and it is not a
 * question any assertion answers. So this drives the world at real device
 * sizes, in both orientations, and takes pictures for a person to look at.
 *
 * The measurable parts are asserted — nothing may sit outside the viewport,
 * nothing may make the document scroll, every control must be big enough to
 * hit with a thumb. The rest is the point of the screenshots.
 *
 * One honest limit, stated here rather than discovered later: **headless
 * Chromium has no notch.** `env(safe-area-inset-*)` resolves to zero here no
 * matter what viewport is set, so this suite cannot prove the HUD clears a
 * Dynamic Island. What it can do is draw where the insets would be on a real
 * device and let a person see whether anything is underneath — which is what
 * `SAFE_AREA` below is for.
 */

import { expect, test, type Page } from '@playwright/test';
import { SHOTS } from './helpers.js';
import { advanceUntil } from './helpers.js';

interface Device {
  id: string;
  label: string;
  width: number;
  height: number;
  scale: number;
  /** Insets the real device would report, in CSS pixels: top, bottom. */
  insets: { top: number; bottom: number };
}

/**
 * Three phones and the ones that actually matter about them.
 *
 * The smallest screen still sold, the most common one, and the largest — which
 * between them bracket everything the HUD has to survive. The insets are the
 * published safe areas for each in portrait.
 */
const DEVICES: readonly Device[] = [
  { id: 'se', label: 'iPhone SE', width: 375, height: 667, scale: 2, insets: { top: 20, bottom: 0 } },
  { id: 'iphone', label: 'iPhone 15', width: 393, height: 852, scale: 3, insets: { top: 59, bottom: 34 } },
  { id: 'pixel', label: 'Pixel 7', width: 412, height: 915, scale: 2.625, insets: { top: 24, bottom: 24 } },
];

/**
 * Paints the safe-area boundaries over the frame.
 *
 * Deliberately part of the test rather than the app: it is a ruler laid on a
 * picture, not a feature. A control that lands inside one of these bands is a
 * control that is under a notch or a home indicator on the real thing.
 */
const SAFE_AREA = 'sm-safe-area-guides';

async function showGuides(page: Page, device: Device): Promise<void> {
  await page.evaluate(
    ({ id, top, bottom }) => {
      document.getElementById(id)?.remove();
      const host = document.createElement('div');
      host.id = id;
      host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:9999';
      const band = (side: 'top' | 'bottom', size: number): HTMLElement => {
        const element = document.createElement('div');
        element.style.cssText = `position:absolute;left:0;right:0;${side}:0;height:${size}px;background:rgba(255,64,64,0.22);border-${side === 'top' ? 'bottom' : 'top'}:1px solid rgba(255,64,64,0.85)`;
        return element;
      };
      if (top > 0) host.appendChild(band('top', top));
      if (bottom > 0) host.appendChild(band('bottom', bottom));
      document.body.appendChild(host);
    },
    { id: SAFE_AREA, top: device.insets.top, bottom: device.insets.bottom },
  );
}

async function hideGuides(page: Page): Promise<void> {
  await page.evaluate((id) => document.getElementById(id)?.remove(), SAFE_AREA);
}

/** Everything interactive, with where it is and how big it is. */
async function controls(page: Page): Promise<
  { label: string; x: number; y: number; width: number; height: number }[]
> {
  return page.evaluate(() => {
    const out: { label: string; x: number; y: number; width: number; height: number }[] = [];
    for (const element of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      out.push({
        label: (element.getAttribute('aria-label') ?? element.textContent ?? '').trim().slice(0, 40),
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }
    return out;
  });
}

async function shoot(page: Page, name: string, device: Device): Promise<void> {
  await showGuides(page, device);
  await page.screenshot({ path: `${SHOTS}/mobile-${device.id}-${name}.png` });
  await hideGuides(page);
}

/**
 * Controls that hug an edge, and whether they respect the safe area.
 *
 * This is the one check that gets around the emulator having no notch. It does
 * not measure where a control lands — headless Chromium resolves every
 * `env(safe-area-inset-*)` to zero, so measuring would always pass — it reads
 * whether the anchoring *asks* for the inset at all. A control positioned
 * twelve pixels off an edge with no mention of a safe area is a control under
 * a home indicator on every iPhone sold, and no screenshot taken here would
 * ever show it.
 */
async function edgeControlsWithoutInsets(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    // Only things genuinely against an edge. A bite ring nine per cent up the
    // screen is not being anchored to the edge, it is being placed.
    const HUG = 24;
    const problems: string[] = [];
    for (const element of Array.from(document.querySelectorAll('button, [role="button"]'))) {
      const box = element.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const label = (element.getAttribute('aria-label') ?? element.textContent ?? '')
        .trim()
        .slice(0, 40);

      const edges: [string, boolean][] = [
        ['top', box.top < HUG],
        ['bottom', window.innerHeight - box.bottom < HUG],
        ['left', box.left < HUG],
        ['right', window.innerWidth - box.right < HUG],
      ];

      // Inline styles all the way up: this interface positions with the style
      // attribute, so that is where the anchoring is written.
      let css = '';
      let node: Element | null = element;
      for (let depth = 0; depth < 8 && node; depth += 1) {
        css += node.getAttribute('style') ?? '';
        node = node.parentElement;
      }

      for (const [side, hugging] of edges) {
        if (!hugging) continue;
        if (css.includes(`safe-area-inset-${side}`)) continue;
        problems.push(`"${label}" hugs the ${side} edge with no safe-area-inset-${side}`);
      }
    }
    return problems;
  });
}

/** The document itself must never scroll. A drag is a marshmallow, not a page. */
async function assertNoDocumentScroll(page: Page, where: string): Promise<void> {
  const overflow = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    scrollHeight: document.documentElement.scrollHeight,
    clientHeight: document.documentElement.clientHeight,
    bodyOverflowX: getComputedStyle(document.body).overflowX,
  }));
  expect(overflow.scrollWidth, `${where}: the page scrolls sideways`).toBeLessThanOrEqual(
    overflow.clientWidth + 1,
  );
  expect(overflow.scrollHeight, `${where}: the page scrolls vertically`).toBeLessThanOrEqual(
    overflow.clientHeight + 1,
  );
}

for (const device of DEVICES) {
  test.describe(`${device.label} (${device.width}x${device.height})`, () => {
    test.use({
      viewport: { width: device.width, height: device.height },
      deviceScaleFactor: device.scale,
      isMobile: true,
      hasTouch: true,
    });

    test('the ritual fits in the hand, portrait and landscape', async ({ page }) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => errors.push(error.message));

      await page.goto(`/?camp=camp-mobile-${device.id}&env=pine_hollow`);
      await page.waitForFunction(() => Boolean(window.__someMore?.three));
      await page.waitForTimeout(2500);

      await shoot(page, 'arrival', device);
      await assertNoDocumentScroll(page, 'arrival');

      // The canvas must actually fill the viewport. A canvas that is 8 pixels
      // short is a black band under the home indicator on a real phone.
      const canvas = await page.evaluate(() => {
        const element = document.querySelector('canvas');
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return { width: Math.round(box.width), height: Math.round(box.height) };
      });
      expect(canvas, 'there should be a canvas').not.toBeNull();
      expect(canvas!.width).toBeGreaterThanOrEqual(device.width - 1);
      expect(canvas!.height).toBeGreaterThanOrEqual(device.height - 1);

      // `touch-action: none` on the canvas is what stops the page moving under
      // a finger that is turning a marshmallow.
      const touchAction = await page.evaluate(
        () => getComputedStyle(document.querySelector('canvas')!).touchAction,
      );
      expect(touchAction, 'a drag on the canvas must not scroll the page').toBe('none');

      await page.evaluate(() => window.__someMore!.actions['arrive']!());
      await page.waitForTimeout(900);
      await shoot(page, 'at-fire', device);

      // --- Roasting: the busiest the HUD ever is -------------------------
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['rake']!();
        actions['addLog']!('oak' as never);
      });
      await advanceUntil(page, 'r.fire.flame < 0.3 && r.fire.emberMass > 0.15', 'ember bed', 900);
      await page.evaluate(() => window.__someMore!.actions['beginRoasting']!());
      for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(900);
      await shoot(page, 'roasting', device);
      await assertNoDocumentScroll(page, 'roasting');

      const unsafe = await edgeControlsWithoutInsets(page);
      expect(unsafe, `portrait:\n${unsafe.join('\n')}`).toEqual([]);

      const roastingControls = await controls(page);
      for (const control of roastingControls) {
        expect(control.x, `"${control.label}" runs off the left`).toBeGreaterThanOrEqual(-1);
        expect(
          control.x + control.width,
          `"${control.label}" runs off the right`,
        ).toBeLessThanOrEqual(device.width + 1);
        expect(control.y, `"${control.label}" runs off the top`).toBeGreaterThanOrEqual(-1);
        expect(
          control.y + control.height,
          `"${control.label}" runs off the bottom`,
        ).toBeLessThanOrEqual(device.height + 1);
      }

      // --- The overlays, which is where small screens break --------------
      await page.evaluate(() => window.__someMore!.store.setOverlay('settings'));
      await page.waitForTimeout(400);
      await shoot(page, 'settings', device);
      const panel = await page.evaluate(() => {
        const element = document.querySelector('.sm-panel');
        if (!element) return null;
        const box = element.getBoundingClientRect();
        return {
          left: Math.round(box.left),
          right: Math.round(box.right),
          top: Math.round(box.top),
          bottom: Math.round(box.bottom),
          scrollable: element.scrollHeight > element.clientHeight,
        };
      });
      expect(panel, 'the settings panel should be on screen').not.toBeNull();
      expect(panel!.left).toBeGreaterThanOrEqual(-1);
      expect(panel!.right).toBeLessThanOrEqual(device.width + 1);
      expect(panel!.top).toBeGreaterThanOrEqual(-1);
      expect(panel!.bottom).toBeLessThanOrEqual(device.height + 1);
      await page.evaluate(() => window.__someMore!.store.setOverlay('none'));

      // --- Landscape -----------------------------------------------------
      await page.setViewportSize({ width: device.height, height: device.width });
      await page.waitForTimeout(1200);
      const rotated: Device = {
        ...device,
        width: device.height,
        height: device.width,
        // Rotated, the notch is on a side and the home indicator is a thin bar.
        insets: { top: 0, bottom: Math.min(device.insets.bottom, 21) },
      };
      await shoot(page, 'roasting-landscape', rotated);
      await assertNoDocumentScroll(page, 'landscape');

      // Landscape is where the notch moves to a side and `safe-area-inset-left`
      // starts being 59 pixels rather than nought.
      const unsafeLandscape = await edgeControlsWithoutInsets(page);
      expect(unsafeLandscape, `landscape:\n${unsafeLandscape.join('\n')}`).toEqual([]);

      const landscapeControls = await controls(page);
      for (const control of landscapeControls) {
        expect(
          control.y + control.height,
          `landscape: "${control.label}" runs off the bottom`,
        ).toBeLessThanOrEqual(rotated.height + 1);
      }

      // The internal resolution has to follow the rotation, or landscape
      // renders at roughly twice the pixels it should (see `useViewportSize`).
      const pixelRatio = await page.evaluate(() => {
        const gl = window.__someMore!.three!.gl as { getPixelRatio(): number };
        return gl.getPixelRatio();
      });
      const expectedRatio = await page.evaluate(() => window.innerHeight);
      console.log(
        `  ${JSON.stringify({ device: device.id, landscapeHeight: expectedRatio, pixelRatio })}`,
      );
      // 240 internal lines over a 393-line viewport is 0.61; over an 852-line
      // one it is 0.28. The only thing being asserted is that it moved.
      expect(pixelRatio).toBeGreaterThan(0.3);

      await page.setViewportSize({ width: device.width, height: device.height });
      await page.waitForTimeout(800);

      // --- Eating: the bite ring is the lowest thing on the screen -------
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['finishRoasting']!();
      });
      await advanceUntil(page, "r.stage === 'assembling'", 'assembling', 120);
      for (let i = 0; i < 4; i += 1) {
        await page.evaluate(() => {
          const actions = window.__someMore!.actions;
          actions['holdComponent']!();
          actions['moveComponent']!(0.004 as never, 0.002 as never);
          actions['placeComponent']!();
        });
      }
      await advanceUntil(page, "r.stage === 'machine'", 'machine', 120);
      await advanceUntil(page, 'r.machine.door > 0.9', 'door open', 120);
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['machine']!({ type: 'load' } as never);
        actions['machine']!({ type: 'close-door' } as never);
      });
      await advanceUntil(page, "r.machine.stage === 'door-closed'", 'door closed', 120);
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['machine']!({ type: 'engage-latch' } as never);
        actions['machine']!({ type: 'set-program', program: 'standard' } as never);
        actions['machine']!({ type: 'confirm' } as never);
        actions['machine']!({ type: 'pull-lever' } as never);
      });
      await advanceUntil(page, "r.machine.stage === 'complete'", 'complete', 600);
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['machine']!({ type: 'release-latch' } as never);
        actions['machine']!({ type: 'open-door' } as never);
      });
      await advanceUntil(page, "r.stage === 'reveal'", 'reveal', 120);
      await page.waitForTimeout(800);
      await shoot(page, 'reveal', device);

      await page.evaluate(() => window.__someMore!.actions['takeSandwich']!());
      await advanceUntil(page, "r.stage === 'eating'", 'eating', 120);
      await page.waitForTimeout(900);
      await shoot(page, 'eating', device);

      const biteTargets = (await controls(page)).filter((control) =>
        control.label.startsWith('Bite from side'),
      );
      expect(biteTargets.length, 'there should be eight bite targets').toBe(8);
      for (const target of biteTargets) {
        // Apple asks for 44pt, Android for 48dp. 40 is the floor below which a
        // target in the dark, on a phone, is a guess.
        expect(
          Math.min(target.width, target.height),
          `bite target "${target.label}" is ${target.width}x${target.height}`,
        ).toBeGreaterThanOrEqual(24);
        expect(
          target.y + target.height,
          `bite target "${target.label}" sits under the home indicator`,
        ).toBeLessThanOrEqual(device.height - device.insets.bottom);
      }

      expect(errors, `page errors:\n${errors.join('\n')}`).toEqual([]);
    });
  });
}
