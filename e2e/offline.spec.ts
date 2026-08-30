/**
 * Can a person with aeroplane mode on make a s'more?
 *
 * That is the whole question. "Does a service worker register" is not it, and
 * a green suite that only answers the second one is how a product ships an
 * offline claim it cannot keep.
 *
 * The shape of the test is the shape of the real thing:
 *
 *  1. Visit once with a connection. This is the only moment a network exists.
 *  2. Turn it off at the browser context, so nothing — page, worker, fetch,
 *     preload — has a route out. The test proves that before it proves
 *     anything else, by making a request and requiring it to fail.
 *  3. Open the app again in a *new document*, which is what a cold launch is.
 *  4. Walk in, tend the fire, roast, assemble, run the SM-01, and eat.
 *
 * Everything the ritual needs is already client-side (ARCHITECTURE §1.5), so
 * if this ever fails it is because something in the shell reached for the
 * network and did not degrade — which is exactly the defect worth catching.
 */

import { expect, test, type Page } from '@playwright/test';
import { capture } from './helpers.js';
import { driveRitual, openWorld, readRoast, type StageId } from './stages.js';

/** Waits until a worker is installed, activated and actually in charge. */
async function waitForWorker(page: Page): Promise<void> {
  await page.waitForFunction(
    async () => {
      if (!('serviceWorker' in navigator)) return false;
      const registration = await navigator.serviceWorker.ready;
      return Boolean(registration.active) && navigator.serviceWorker.controller !== null;
    },
    undefined,
    { timeout: 30_000 },
  );
}

/** What the worker actually holds. */
async function cacheContents(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const names = (await caches.keys()).filter((name) => name.startsWith('some-more-'));
    const out: string[] = [];
    for (const name of names) {
      const cache = await caches.open(name);
      for (const request of await cache.keys()) out.push(new URL(request.url).pathname);
    }
    return out.sort();
  });
}

test.describe('offline', () => {
  test('a cold boot with no network at all reaches a finished sandwich', async ({
    context,
    page,
  }) => {
    const errors: string[] = [];

    // --- 1. The one visit that has a connection --------------------------
    await openWorld(page, 'camp-offline');
    await waitForWorker(page);

    const cached = await cacheContents(page);
    console.log(`  precached ${cached.length} entries`);
    // Both spellings: `/` is what a launch requests and what the worker's
    // navigation handler looks for; `/index.html` is what a static host may
    // hand a direct link. A build that precaches assets and forgets the shell
    // is an offline boot that fetches the one page it cannot fetch.
    expect(cached, 'the shell must be held').toContain('/');
    expect(cached, 'the shell must be held under its file name too').toContain('/index.html');
    expect(
      cached.some((path) => path.startsWith('/assets/') && path.endsWith('.js')),
      'the application code must be held',
    ).toBe(true);
    expect(cached, 'the manifest must be held').toContain('/manifest.webmanifest');
    expect(
      cached.some((path) => path.endsWith('.map')),
      'source maps must not be held: seven megabytes nothing offline reads',
    ).toBe(false);

    // --- 2. Off, and proven off ------------------------------------------
    await context.setOffline(true);

    const cold = await context.newPage();
    // Only uncaught exceptions. Console errors are expected and are not
    // failures: with the network gone, every request the shell makes for the
    // service logs one, which is exactly the degradation being tested.
    cold.on('pageerror', (error) => errors.push(error.message));

    // --- 3. A cold launch ------------------------------------------------
    await openWorld(cold, 'camp-offline');

    const reachable = await cold.evaluate(async () => {
      try {
        // Cache-busted so nothing can answer it but the network.
        await fetch(`/v1/meta?cachebust=${Date.now()}`, { cache: 'no-store' });
        return true;
      } catch {
        return false;
      }
    });
    expect(reachable, 'the network must genuinely be gone for this to mean anything').toBe(false);

    // The world is really here, not a shell of one: the renderer exists, the
    // simulation is running, and the campsite came from the local catalogue.
    await expect
      .poll(() => cold.evaluate(() => Boolean(window.__someMore?.three)))
      .toBe(true);
    const environment = await cold.evaluate(
      () => window.__someMore!.store.state['environmentId'] as string,
    );
    expect(environment).toBe('pine_hollow');

    await capture(cold, 'offline-arrival');

    // --- 4. The whole ritual, with the radio off -------------------------
    let roast: Awaited<ReturnType<typeof readRoast>> | null = null;
    const seen: StageId[] = [];
    await driveRitual(
      cold,
      async (stage: StageId) => {
        seen.push(stage);
        if (stage === 'reveal' || stage === 'roasted' || stage === 'bitten') {
          await capture(cold, `offline-${stage}`);
        }
      },
      600,
      (outcome) => {
        roast = outcome;
      },
    );

    expect(seen).toContain('reveal');
    expect(seen).toContain('bitten');

    // Browning is the evidence that roasting happened rather than that a
    // stage label changed. Same reason `stages.ts` reports it.
    expect(roast, 'the roast should have been measured').not.toBeNull();
    const measured = roast as unknown as { brown: number; spread: number };
    expect(measured.brown, `mean browning was ${measured.brown}`).toBeGreaterThan(0.15);

    const world = await cold.evaluate(() => {
      const ritual = window.__someMore!.store.state['ritual'] as unknown as {
        stage: string;
        sandwich: { class: string; caption: string; layers?: unknown[] } | null;
        bite: { eaten: number };
      };
      const passport = window.__someMore!.store.state['passport'] as unknown as {
        entries: unknown[];
        sandwichCount: number;
      };
      return {
        stage: ritual.stage,
        sandwichClass: ritual.sandwich?.class ?? null,
        caption: ritual.sandwich?.caption ?? null,
        eaten: ritual.bite.eaten,
        entries: passport.entries.length,
        sandwichCount: passport.sandwichCount,
      };
    });

    console.log(
      `  offline sandwich: ${world.sandwichClass} — "${world.caption}", ${Math.round(world.eaten * 100)}% eaten`,
    );

    expect(world.sandwichClass, 'a real sandwich, made with no network').not.toBeNull();
    expect(world.eaten).toBeGreaterThan(0);
    // The Passport is device-local first (ARCHITECTURE §7), so it records the
    // sandwich whether or not the service ever hears about it.
    expect(world.entries).toBeGreaterThan(0);
    expect(world.sandwichCount).toBeGreaterThan(0);

    // A failed upload is expected and must be quiet. An uncaught exception is
    // not: "degrade, never block" (ARCHITECTURE §1, principle 5).
    expect(errors, `page errors while offline:\n${errors.join('\n')}`).toEqual([]);

    await context.setOffline(false);
  });

  test('the accessibility settings survive a cold offline boot', async ({ context, page }) => {
    // Every knob in spec §12 is only worth having if it is still there the
    // next time the app opens — which, installed, is usually offline.
    await openWorld(page, 'camp-offline-a11y');
    await waitForWorker(page);

    await page.evaluate(() => {
      const store = window.__someMore!.store as unknown as {
        updateAccessibility: (partial: Record<string, unknown>) => void;
        updateRender: (partial: Record<string, unknown>) => void;
      };
      store.updateAccessibility({
        textScale: 1.6,
        highContrast: true,
        simplifiedGestures: true,
        virtualJoystick: true,
        autoRotate: 1.2,
        assemblyAssist: 1,
      });
      store.updateRender({ reducedMotion: true });
    });

    await context.setOffline(true);
    const cold = await context.newPage();
    await openWorld(cold, 'camp-offline-a11y');

    const settings = await cold.evaluate(() => {
      const state = window.__someMore!.store.state as unknown as {
        accessibility: Record<string, unknown>;
        render: Record<string, unknown>;
      };
      return { accessibility: state.accessibility, render: state.render };
    });

    expect(settings.accessibility['textScale']).toBe(1.6);
    expect(settings.accessibility['highContrast']).toBe(true);
    expect(settings.accessibility['simplifiedGestures']).toBe(true);
    expect(settings.accessibility['virtualJoystick']).toBe(true);
    expect(settings.accessibility['autoRotate']).toBe(1.2);
    expect(settings.accessibility['assemblyAssist']).toBe(1);
    expect(settings.render['reducedMotion']).toBe(true);

    await context.setOffline(false);
  });

  test('the manifest and its icons are real files that really decode', async ({ page }) => {
    await page.goto('/');

    const manifest = await page.evaluate(async () => {
      const response = await fetch('/manifest.webmanifest');
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    });
    expect(manifest.status).toBe(200);
    expect(manifest.body['name']).toBe('Some More');
    // The night from `ui/styles.ts`, not an approximation of it.
    expect(manifest.body['theme_color']).toBe('#0a0d12');
    expect(manifest.body['background_color']).toBe('#0a0d12');
    expect(manifest.body['start_url']).toBe('/');

    const icons = manifest.body['icons'] as { src: string; sizes: string; purpose: string }[];
    // Chromium will not consider a site installable without both of these.
    const sizes = icons.map((icon) => icon.sizes);
    expect(sizes).toContain('192x192');
    expect(sizes).toContain('512x512');
    expect(icons.some((icon) => icon.purpose === 'maskable')).toBe(true);

    /*
     * Decoded, not merely fetched.
     *
     * A 200 with the right content-length proves the build wrote *a* file. The
     * PNG encoder here is hand-rolled (there are no binary assets and no image
     * dependency, ADR-0002), so the only honest check is whether a browser can
     * turn the bytes back into pixels of the right size — and whether those
     * pixels are a campfire rather than a flat rectangle.
     */
    const decoded = await page.evaluate(
      async (paths: string[]) => {
        const results: {
          path: string;
          width: number;
          height: number;
          distinctColours: number;
          brightest: number;
        }[] = [];
        for (const path of paths) {
          const blob = await (await fetch(path)).blob();
          const bitmap = await createImageBitmap(blob);
          const canvas = document.createElement('canvas');
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
          const ctx = canvas.getContext('2d');
          if (!ctx) throw new Error('no 2d context');
          ctx.drawImage(bitmap, 0, 0);
          const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
          const seen = new Set<number>();
          let brightest = 0;
          for (let i = 0; i < data.length; i += 4) {
            const r = data[i] ?? 0;
            const g = data[i + 1] ?? 0;
            const b = data[i + 2] ?? 0;
            seen.add((r << 16) | (g << 8) | b);
            const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            if (luminance > brightest) brightest = luminance;
          }
          results.push({
            path,
            width: bitmap.width,
            height: bitmap.height,
            distinctColours: seen.size,
            brightest,
          });
        }
        return results;
      },
      [
        '/icons/icon-48.png',
        '/icons/icon-192.png',
        '/icons/icon-512.png',
        '/icons/maskable-512.png',
        '/icons/apple-touch-icon.png',
      ],
    );

    const expected: Record<string, number> = {
      '/icons/icon-48.png': 48,
      '/icons/icon-192.png': 192,
      '/icons/icon-512.png': 512,
      '/icons/maskable-512.png': 512,
      '/icons/apple-touch-icon.png': 180,
    };
    for (const result of decoded) {
      console.log(
        `  ${result.path}: ${result.width}x${result.height}, ${result.distinctColours} colours, peak luminance ${Math.round(result.brightest)}`,
      );
      expect(result.width, result.path).toBe(expected[result.path]);
      expect(result.height, result.path).toBe(expected[result.path]);
      // A campfire on a night field: more than a handful of colours, and a
      // genuinely bright core. A blank or a solid fill fails both.
      expect(result.distinctColours, `${result.path} is not a picture`).toBeGreaterThan(8);
      expect(result.brightest, `${result.path} has no fire in it`).toBeGreaterThan(180);
    }
  });

  test('the install offer stays out of the ritual', async ({ page }) => {
    await openWorld(page, 'camp-offline-invite');
    await waitForWorker(page);

    // Chromium will not raise `beforeinstallprompt` for a test run, so the
    // event is delivered by hand. Everything downstream of it — the capture,
    // the gating, the dismissal — is the real code path.
    await page.evaluate(() => {
      const event = new Event('beforeinstallprompt', { cancelable: true }) as Event & {
        prompt?: () => Promise<void>;
        userChoice?: Promise<{ outcome: string }>;
      };
      event.prompt = async () => undefined;
      event.userChoice = Promise.resolve({ outcome: 'accepted' });
      window.dispatchEvent(event);
    });

    await expect
      .poll(() => page.evaluate(() => window.__someMorePwa?.getSnapshot().installAvailable))
      .toBe(true);

    const notice = page.locator('[data-testid="pwa-notice"]');

    // On the trail, at the fire, over the coals, at the table, at the machine
    // and at the moment the door opens: nothing, at any of them.
    await expect(notice, 'nothing may be offered on arrival').toHaveCount(0);

    await page.evaluate(() => window.__someMore!.actions['arrive']!());
    await expect(notice, 'nothing at the fire').toHaveCount(0);

    await page.evaluate(() => {
      window.__someMore!.actions['beginRoasting']!();
    });
    await page.waitForTimeout(1500);
    await expect(notice, 'nothing over a roasting marshmallow').toHaveCount(0);

    // Straight to the end of the run, through the real model.
    await page.evaluate(() => window.__someMore!.actions['finishRoasting']!());
    await page.evaluate(() => window.__someMore!.actions['advanceSeconds']!(3 as never));
    await expect(notice, 'nothing at the assembly table').toHaveCount(0);

    for (let i = 0; i < 4; i += 1) {
      await page.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['holdComponent']!();
        actions['moveComponent']!(0.004 as never, 0.002 as never);
        actions['placeComponent']!();
      });
    }
    await page.evaluate(() => window.__someMore!.actions['advanceSeconds']!(4 as never));
    await expect(notice, 'nothing at the SM-01').toHaveCount(0);
  });
});
