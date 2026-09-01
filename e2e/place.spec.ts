/**
 * Whether this campsite is *this* campsite.
 *
 * Every environment in the catalogue is written as a distinct place — a
 * five-beat arrival, three or four named landmarks each described exactly, its
 * own firewood, its own ground and wind and cold. For most of this project's
 * life all twelve of them rendered as the same clearing with a machine in it,
 * and the writing sat in the manifests where nobody could reach it. These
 * tests are about whether a player meets any of it.
 */
import { expect, test } from '@playwright/test';
import { act, capture } from './helpers.js';

interface LandmarkReadout {
  id: string;
  label: string;
  kind: string;
  note: string;
  x: number;
  z: number;
  introduced: boolean;
}

function readLandmarks(page: import('@playwright/test').Page): Promise<LandmarkReadout[]> {
  return page.evaluate(
    () =>
      (window.__someMore!.store.state.ritual as unknown as { landmarks: LandmarkReadout[] }).landmarks.map(
        (l) => ({ id: l.id, label: l.label, kind: l.kind, note: l.note, x: l.x, z: l.z, introduced: l.introduced }),
      ) as unknown as LandmarkReadout[],
  );
}

test.describe('the arrival is this campsite’s arrival', () => {
  test('the walk in is told in the words the manifest wrote for this place', async ({ page }) => {
    await page.goto('/?camp=camp-place&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1400);

    // Before you tap: the path in.
    const body = page.locator('body');
    await expect(body).toContainText('gravel spur', { timeout: 10_000 });
    await capture(page, '50-arrival-approach');

    // Walking: the beats, in order, one at a time.
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    const beats: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      const stage = await page.evaluate(() => window.__someMore!.store.state.ritual.stage);
      if (stage !== 'arriving') break;
      const line = await page.evaluate(
        () => document.querySelector('[data-testid="arrival-beat"]')?.textContent ?? '',
      );
      if (line.length > 0 && beats[beats.length - 1] !== line) {
        beats.push(line);
        if (beats.length === 2) await capture(page, '51-arrival-beat');
      }
      await page.waitForTimeout(400);
    }

    // Four beats were written for this place. A player should meet them.
    expect(beats.length, `beats seen: ${JSON.stringify(beats)}`).toBeGreaterThanOrEqual(3);
    const all = beats.join(' ');
    // The creek you hear before you see anything, and the reflector that is
    // the first thing to resolve out of the dark. Pine Hollow's own words.
    expect(all).toMatch(/creek|white noise/i);
    expect(all).toMatch(/reflector|needles|bowl/i);

    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage !== 'arriving', null, {
      timeout: 40_000,
    });
  });

  test('the walk in can be skipped by anybody who has seen it', async ({ page }) => {
    await page.goto('/?camp=camp-skip&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1400);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForTimeout(600);
    // A second tap goes straight in. Nobody is held in a title sequence.
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage !== 'arriving', null, {
      timeout: 8_000,
    });
  });
});

test.describe('the named things', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?camp=camp-place&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore));
    /*
     * Walked in and then skipped, which is the real route.
     *
     * `arrive` moves the simulation's stage and leaves the interface where it
     * was — the title card up, the world still "arriving" — so nothing that
     * depends on being at the campsite is offered. Tapping twice is what a
     * player who has seen the walk does.
     */
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForTimeout(500);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.stage !== 'arriving', null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
  });

  test('every landmark the catalogue names is somewhere you can walk to', async ({ page }) => {
    const landmarks = await readLandmarks(page);
    expect(landmarks.length).toBeGreaterThan(2);

    const walkable = await page.evaluate(() => window.__someMore!.store.state.ritual.options.walkableRadiusM ?? 13);
    for (const landmark of landmarks) {
      const distance = Math.hypot(landmark.x, landmark.z);
      expect(distance, `${landmark.id} is in the fire`).toBeGreaterThan(2.2);
      expect(distance, `${landmark.id} is outside the campsite`).toBeLessThan(walkable);
      // Each one carries the sentence the catalogue wrote about it.
      expect(landmark.note.length, `${landmark.id} has nothing to say`).toBeGreaterThan(20);
    }

    // And they are the campsite's own, not a generic set.
    const labels = landmarks.map((l) => l.label).join(' | ');
    expect(labels).toMatch(/post|box|snag|stone/i);
  });

  test('walking up to one tells you what it is, once', async ({ page }) => {
    const landmarks = await readLandmarks(page);
    const target = [...landmarks].sort((a, b) => Math.hypot(a.x, a.z) - Math.hypot(b.x, b.z))[0]!;


    // Stand at it, the way a player would after walking over.
    await page.evaluate((spot) => {
      const p = window.__someMore!.player!;
      const t = spot as { x: number; z: number };
      const bearing = Math.atan2(t.z, t.x);
      p.position.x = t.x - Math.cos(bearing) * 1.1;
      p.position.z = t.z - Math.sin(bearing) * 1.1;
      p.facing = bearing;
      p.pitch = -0.1;
    }, { x: target.x, z: target.z });
    await page.waitForTimeout(700);

    // The world offers it by name.
    await expect(page.getByTestId('reach')).toBeVisible();
    await expect(page.getByTestId('reach')).toContainText(new RegExp(target.label.split(' ')[0]!, 'i'));
    await page.getByTestId('reach').click();
    await page.waitForTimeout(300);

    // And says the sentence written for it.
    await expect(page.getByTestId('notice')).toContainText(target.note.slice(0, 24));
    await capture(page, '52-landmark');

    const after = await readLandmarks(page);
    expect(after.find((l) => l.id === target.id)!.introduced).toBe(true);
  });

  test('they are things you can see, not only things you are told about', async ({ page }) => {
    // With the torch, because everything past the firelight needs one and
    // going out to look at the campsite is exactly what it is for.
    await act(page, 'takeTorch');
    await act(page, 'toggleTorch', true);

    const landmarks = await readLandmarks(page);
    for (const kind of ['signage', 'built', 'natural']) {
      const target = landmarks.find((l) => l.kind === kind);
      if (!target) continue;
      await page.evaluate((spot) => {
        const p = window.__someMore!.player!;
        const t = spot as { x: number; z: number };
        const bearing = Math.atan2(t.z, t.x);
        // Standing back far enough to see the whole of it.
        p.position.x = t.x - Math.cos(bearing) * 2.4;
        p.position.z = t.z - Math.sin(bearing) * 2.4;
        p.facing = bearing;
        p.pitch = -0.08;
      }, { x: target.x, z: target.z });
      await page.waitForTimeout(700);
      await capture(page, `53-landmark-${kind}`);
    }

    // Every placeable landmark is drawn: the scene names its meshes after the
    // landmark ids, so a landmark that was placed and never rendered — which
    // is the failure this whole change exists to end — shows up here.
    const drawn = await page.evaluate(() => {
      const scene = (window.__someMore!.three as unknown as { scene: { children: unknown[] } }).scene;
      const names: string[] = [];
      const walk = (node: unknown): void => {
        const n = node as { name?: string; children?: unknown[] };
        if (n.name) names.push(n.name);
        for (const child of n.children ?? []) walk(child);
      };
      walk(scene);
      return names;
    });
    for (const landmark of landmarks) {
      if (landmark.kind === 'sky') continue;
      expect(drawn, `${landmark.id} was placed and never drawn`).toContain(landmark.id);
    }
  });
});
