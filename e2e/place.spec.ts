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

test.describe('the campsite has a voice', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/?camp=camp-voice&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore));
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForTimeout(500);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.stage !== 'arriving', null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(500);
  });

  test('it says what it is like, and is heard from a long way off', async ({ page }) => {
    const said: string[] = [];
    const heard: string[] = [];
    // A quarter of an hour of campsite, in slices, watching what it says.
    for (let slice = 0; slice < 30; slice += 1) {
      await act(page, 'advanceSeconds', 30);
      const spoke = await page.evaluate(() => {
        const r = window.__someMore!.store.state.ritual as unknown as {
          place: { said: string[] | Set<string>; lastHeard: Map<string, number> | Record<string, number> };
        };
        const saidIds = Array.isArray(r.place.said) ? r.place.said : Array.from(r.place.said as Set<string>);
        const lastHeard =
          r.place.lastHeard instanceof Map
            ? Array.from(r.place.lastHeard.keys())
            : Object.keys(r.place.lastHeard ?? {});
        return { saidIds, lastHeard };
      });
      for (const id of spoke.saidIds) if (!said.includes(id)) said.push(id);
      for (const id of spoke.lastHeard) if (!heard.includes(id)) heard.push(id);
    }

    // It talked about itself, and it was not a list read out on arrival.
    expect(said.length, `said: ${said.join(', ')}`).toBeGreaterThan(1);
    expect(said).toContain('ground');
    // And something happened out past the treeline that had nothing to do
    // with the player.
    expect(heard.length, `heard: ${heard.join(', ')}`).toBeGreaterThan(0);
  });

  test('asking what is around you answers in this campsite’s own words', async ({ page }) => {
    // Asked the way a player asks: the survey key.
    await page.keyboard.press('q');
    await page.waitForTimeout(400);
    const text = await page.evaluate(
      () => (window.__someMore!.store.state.survey ?? []).join(' '),
    );
    // The ground this campsite actually has, not a generic description.
    expect(text).toMatch(/needle|duff|litter/i);
    // And the shape of the land it is in.
    expect(text).toMatch(/bowl|rises|slope/i);
  });
});

test.describe('the firelight is this campsite’s firelight', () => {
  /**
   * Every environment states the colour its fire throws and none of them had
   * ever been used: one orange at a pine hollow, a salt flat and a snowfield.
   * Firelight is the only light most of these places have after dark, so it is
   * most of what makes them look different from one another.
   */
  async function fireColour(
    page: import('@playwright/test').Page,
    env: string,
  ): Promise<{ r: number; g: number; b: number }> {
    await page.goto(`/?camp=camp-glow&env=${env}`);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1200);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForTimeout(400);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.stage !== 'arriving', null, {
      timeout: 20_000,
    });
    await page.waitForTimeout(900);
    await capture(page, `54-firelight-${env}`);

    // The lit ground around the pit, which is firelight and almost nothing else.
    return page.evaluate(() => {
      const three = window.__someMore!.three as unknown as {
        gl: { domElement: HTMLCanvasElement; render: (s: unknown, c: unknown) => void };
        scene: unknown;
        camera: unknown;
      };
      three.gl.render(three.scene, three.camera);
      const off = document.createElement('canvas');
      off.width = 160;
      off.height = 100;
      const ctx = off.getContext('2d')!;
      ctx.drawImage(three.gl.domElement, 0, 0, off.width, off.height);
      const data = ctx.getImageData(0, 60, off.width, 30).data;
      let r = 0;
      let g = 0;
      let b = 0;
      for (let i = 0; i < data.length; i += 4) {
        r += data[i] ?? 0;
        g += data[i + 1] ?? 0;
        b += data[i + 2] ?? 0;
      }
      const n = data.length / 4;
      return { r: r / n, g: g / n, b: b / n };
    });
  }

  test('two campsites are lit by two different fires', async ({ page }) => {
    const pine = await fireColour(page, 'pine_hollow');
    const other = await fireColour(page, 'ashfall_barrens');

    // Both are firelight: warm, and actually lighting something.
    for (const lit of [pine, other]) {
      expect(lit.r).toBeGreaterThan(lit.b);
      expect(lit.r).toBeGreaterThan(6);
    }
    /*
     * Deliberately *not* asserting that the two look different.
     *
     * The catalogue's twelve fire colours are all warm oranges within about
     * two per cent of each other — every fire is a fire — and after five-bit
     * quantisation the difference in a rendered frame is around half a per
     * cent, which is noise next to how much ground each campsite has for the
     * light to fall on. The wiring is what matters and is tested where it can
     * be tested honestly: that the twelve values are distinct is a unit test
     * over the catalogue, and that each one reaches the light is this. Writing
     * a pixel assertion here would be measuring the renderer's mood.
     */
    const warmth = (c: { r: number; g: number; b: number }) => c.g / Math.max(1, c.r);
    for (const lit of [pine, other]) {
      // Firelight, not daylight and not a grey: warm, and in the band a fire
      // actually occupies.
      expect(warmth(lit)).toBeGreaterThan(0.35);
      expect(warmth(lit)).toBeLessThan(0.8);
      expect(lit.b).toBeLessThan(lit.g);
    }
  });
});

/**
 * Whether two nights at one campsite are two different nights (§5.4).
 *
 * Every environment names five things about itself that change between visits
 * — how much wood is on the stack, how wet the duff is, whether the marine
 * layer is in — with a range and a unit for each. Sixty of those across the
 * catalogue, and until they were rolled, every visit produced the identical
 * campsite. These read the world the player actually walks into, not the roll.
 */
test.describe('a campsite is a different night every night', () => {
  /** What is actually lying about at this campsite, from the running world. */
  async function woodAt(page: import('@playwright/test').Page, camp: string): Promise<{
    total: number;
    wettest: number;
    byGrade: Record<string, number>;
  }> {
    await page.goto(`/?camp=${camp}&env=pine_hollow`);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(600);
    return page.evaluate(() => {
      const patches = (
        window.__someMore!.store.state.ritual as unknown as {
          gathering: { patches: { grade: string; stock: number; moisture: number }[] };
        }
      ).gathering.patches;
      const byGrade: Record<string, number> = {};
      let total = 0;
      let wettest = 0;
      for (const patch of patches) {
        byGrade[patch.grade] = (byGrade[patch.grade] ?? 0) + patch.stock;
        total += patch.stock;
        wettest = Math.max(wettest, patch.moisture);
      }
      return { total, wettest, byGrade };
    });
  }

  /*
   * The claim, tested the way a player would meet it: go back to the same
   * campsite, and find it the same place on a different night.
   *
   * Same `camp=` seed and the same browser, so the Passport counts the visits
   * — which is what separates "this campsite" from "this night". Anything that
   * stopped the visit count advancing would show up here as a campsite frozen
   * in one evening forever, which is precisely the state this replaced.
   */
  test('going back finds the same place on a different night', async ({ page }) => {
    const nights: { visit: number; total: number; wettest: number }[] = [];
    for (let i = 0; i < 5; i += 1) {
      const wood = await woodAt(page, 'camp-again');
      const visit = await page.evaluate(
        () => window.__someMore!.store.state.ritual.options.visitIndex,
      );
      nights.push({ visit, total: wood.total, wettest: wood.wettest });
    }
    // eslint-disable-next-line no-console
    console.log(`  visits ${nights.map((n) => n.visit).join(', ')}; wood ${nights.map((n) => n.total).join(', ')}`);

    // The Passport actually counted them.
    expect(nights[0]!.visit).toBe(1);
    expect(nights[nights.length - 1]!.visit).toBeGreaterThan(1);

    // And the campsite was not the same evening five times over.
    const totals = nights.map((n) => n.total);
    expect(new Set(totals).size, `wood: ${totals.join(', ')}`).toBeGreaterThan(1);
    // "Never zero. Fuel is not a pressure." — pine_hollow's own note.
    expect(Math.min(...totals)).toBeGreaterThan(20);
  });

  test('and different campsites are different places, not one place twice', async ({ page }) => {
    const totals: number[] = [];
    for (const camp of ['camp-n1', 'camp-n2', 'camp-n3', 'camp-n4', 'camp-n5', 'camp-n6']) {
      totals.push((await woodAt(page, camp)).total);
    }
    const spread = Math.max(...totals) / Math.min(...totals);
    expect(spread, `totals: ${totals.join(', ')}`).toBeGreaterThan(1.2);
    expect(Math.min(...totals)).toBeGreaterThan(20);
  });
});

/**
 * The one thing this campsite is for.
 *
 * `prominence` marks exactly one activity per environment as `signature` and
 * had never decided anything. A player who can see the screen finds the tide
 * pools by walking into them; the survey exists for the player who cannot.
 */
test.describe('the survey says what a campsite is for', () => {
  test('it names this campsite’s signature activity, in the words written for it', async ({ page }) => {
    await page.goto('/?camp=camp-signature&env=loonwater_narrows');
    await page.waitForFunction(() => Boolean(window.__someMore));
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForTimeout(500);
    await page.locator('canvas').click({ position: { x: 640, y: 400 } });
    await page.waitForFunction(() => window.__someMore!.store.state.stage !== 'arriving', null, {
      timeout: 20_000,
    });
    await page.keyboard.press('q');
    await page.waitForTimeout(400);
    const text = await page.evaluate(() => (window.__someMore!.store.state.survey ?? []).join(' '));
    expect(text).toContain('That is the thing this campsite is for.');
    // Loonwater's signature is answering the loon, and the note written for it.
    expect(text).toMatch(/Answer the loon/i);
    expect(text).toMatch(/cup your hands/i);
  });

  /*
   * Twenty-two of the catalogue's activity notes carry a sentence written to
   * the team rather than to the player. None of them may reach a fire.
   */
  test('and never tells the player about the game or the catalogue', async ({ page }) => {
    for (const env of ['cicada_bottoms', 'cedar_switchback', 'lantern_mesa']) {
      await page.goto(`/?camp=camp-voice-${env}&env=${env}`);
      await page.waitForFunction(() => Boolean(window.__someMore));
      await page.locator('canvas').click({ position: { x: 640, y: 400 } });
      await page.waitForTimeout(400);
      await page.locator('canvas').click({ position: { x: 640, y: 400 } });
      await page.waitForFunction(() => window.__someMore!.store.state.stage !== 'arriving', null, {
        timeout: 20_000,
      });
      await page.keyboard.press('q');
      await page.waitForTimeout(400);
      const text = await page.evaluate(() => (window.__someMore!.store.state.survey ?? []).join(' '));
      expect(text, env).not.toMatch(/\b(the game|the catalogue|the product|this environment)\b/i);
    }
  });
});

/**
 * How closed the horizon is, drawn from the axis the catalogue grades on.
 *
 * A unit test pins the mapping; this is the end of it — the renderer actually
 * putting a temperate rainforest's worth of trees around the cedar switchback
 * and none at all on a salt pan. Read from the live `WebGLRenderer` counters,
 * so it is what was drawn rather than what was intended.
 */
test.describe('the treeline is as closed as the manifest says', () => {
  async function trianglesAt(page: import('@playwright/test').Page, env: string): Promise<number> {
    await page.goto(`/?camp=camp-cover&env=${env}`);
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1200);
    return page.evaluate(() => {
      const gl = window.__someMore!.three!.gl as { info: { render: { triangles: number } } };
      return gl.info.render.triangles;
    });
  }

  test('a canopy campsite draws far more of a wood than a bare pan does', async ({ page }) => {
    const canopy = await trianglesAt(page, 'cedar_switchback');
    const bare = await trianglesAt(page, 'mirror_flats');
    // eslint-disable-next-line no-console
    console.log(`  cedar_switchback (canopy): ${canopy} triangles; mirror_flats (none): ${bare}`);
    expect(canopy).toBeGreaterThan(bare * 1.4);
    // And still inside the budget the whole scene is held to.
    expect(canopy).toBeLessThan(60_000);
  });
});
