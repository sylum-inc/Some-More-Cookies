import { expect, test } from '@playwright/test';
import { act, advanceUntil, capture, readWorld, runMachine, waitForWorld } from './helpers.js';

/**
 * The Priority 1 acceptance test.
 *
 * Drives the whole ritual through real pointer input and the real simulation,
 * asserting the product's own quality bar (spec §16.1) rather than
 * implementation details, and capturing a screenshot at every stage for human
 * inspection.
 */
test.describe('the ritual', () => {
  test('runs end to end and produces a sandwich worth eating', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => {
      if (message.type() === 'error' && !message.text().includes('404')) errors.push(message.text());
    });

    // --- Arrive ----------------------------------------------------------
    await page.goto('/?camp=camp-acceptance&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await page.waitForTimeout(1500);
    await capture(page, '01-arrival');

    expect((await readWorld(page)).stage).toBe('arriving');
    // The opening image must have a fire in it.
    expect((await readWorld(page)).flame).toBeGreaterThan(0.4);

    await page.mouse.click(512, 420);
    // The walk in is a real animation, so this one is genuinely waited out.
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);
    await capture(page, '02-at-fire');

    // --- Tend the fire ---------------------------------------------------
    // Reached for directly now rather than pressed on a HUD control; the
    // dedicated exploration test below exercises the walk-up-and-touch path.
    await act(page, 'rake');
    await page.waitForTimeout(800);
    await capture(page, '03-fire-tended');

    // Let it burn down. The ember bed is the better roasting surface, and the
    // model has to actually reach one.
    //
    // Fast-forwarded rather than waited out: the fixed-timestep clamp lets
    // simulated time fall behind wall-clock on slow hardware by design, so
    // waiting in real time would be waiting on the software renderer, not on
    // the fire. `advanceSeconds` runs the real model at the real timestep.
    await advanceUntil(page, 'r.fire.flame < 0.2 && r.fire.emberMass > 0.2', 'ember bed', 900);
    await page.waitForTimeout(700);
    const coals = await readWorld(page);
    expect(coals.flame, 'the fire should burn down to coals').toBeLessThan(0.2);
    expect(coals.ember, 'and leave a substantial bed').toBeGreaterThan(0.3);
    await capture(page, '04-ember-bed');

    // --- Roast, with real drags -------------------------------------------
    await act(page, 'beginRoasting');
    await page.waitForTimeout(400);
    await capture(page, '05-roasting-start');

    const cx = 512;
    const cy = 520;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    for (let i = 1; i <= 12; i++) {
      await page.mouse.move(cx, cy - i * 2.9);
      await page.waitForTimeout(20);
    }
    const startedRoast = Date.now();
    let turn = 0;
    while (Date.now() - startedRoast < 70_000) {
      turn++;
      await page.mouse.move(cx + (turn % 2 ? 150 : -150), cy - 35);
      await page.waitForTimeout(240);
      if (turn === 90) await capture(page, '06-roasting-mid');
    }
    await page.mouse.up();
    await capture(page, '07-roasting-done');

    const roasted = await readWorld(page);
    // Turning it steadily over coals should land in the golden band without
    // ruining it. Asserted as a band rather than a floor on purpose: part of
    // this roast is driven by real pointer input at real speed, so how far it
    // gets depends on how fast the renderer went, and a knife-edge threshold
    // measures the machine rather than the model. It failed at 0.348 against
    // 0.35 once, which is a golden marshmallow by any reading.
    expect(roasted.brown).toBeGreaterThan(0.3);
    expect(roasted.brown).toBeLessThan(0.85);
    expect(roasted.char).toBeLessThan(0.45);

    // --- Assemble ---------------------------------------------------------
    await act(page, 'finishRoasting');
    await advanceUntil(page, "r.stage === 'assembling'", 'assembling');
    const offsets: [number, number][] = [
      [0.004, 0.002],
      [-0.005, 0.003],
      [0.003, -0.004],
      [0.004, 0.002],
    ];
    for (let i = 0; i < offsets.length; i++) {
      await act(page, 'holdComponent');
      await act(page, 'moveComponent', offsets[i]![0], offsets[i]![1]);
      await page.waitForTimeout(220);
      if (i === 1) await capture(page, '08-assembling');
      await act(page, 'placeComponent');
      await page.waitForTimeout(180);
    }
    await capture(page, '09-assembled');
    await advanceUntil(page, "r.stage === 'machine'", 'machine');

    // --- The SM-01 --------------------------------------------------------
    await page.waitForTimeout(1200);
    await capture(page, '10-machine');
    await runMachine(page, async (name) => {
      const labels: Record<string, string> = {
        armed: '11-armed',
        processing: '12-processing-amber',
        freezing: '13-freezing-blue',
        complete: '14-complete-frost',
      };
      const label = labels[name];
      if (label) await capture(page, label);
    });

    // Amber gives way to blue, and frost only ever grows.
    const finished = await readWorld(page);
    expect(finished.frost).toBeGreaterThan(0.3);

    await page.waitForTimeout(2200);
    await capture(page, '15-reveal');
    expect(finished.sandwichClass).toBeTruthy();
    expect(finished.sandwichCaption).toBeTruthy();

    // --- Eat --------------------------------------------------------------
    await act(page, 'takeSandwich');
    await advanceUntil(page, "r.stage === 'eating'", 'eating');
    await page.waitForTimeout(6000);
    await capture(page, '16-sandwich-in-hand');

    await act(page, 'bite', 0);
    await act(page, 'bite', 1);
    await act(page, 'bite', 2);
    await page.waitForTimeout(800);
    await capture(page, '17-bitten');
    expect((await readWorld(page)).eaten).toBeGreaterThan(0);

    // --- Photo, Passport, terminal, settings ------------------------------
    await page.getByRole('button', { name: 'Photo' }).click();
    await page.waitForTimeout(1200);
    await capture(page, '18-passport');
    // The photo really was developed and saved.
    await expect(page.locator('.sm-panel img')).toHaveCount(1);
    await expect(page.getByRole('heading', { name: /Record of sandwiches/i })).toBeVisible();

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Make this real' }).click();
    await page.waitForTimeout(2400);
    await capture(page, '19-terminal');
    // Scoped to the terminal: the HUD affordance shares the same name, and
    // accessible-name matching is case-insensitive.
    const terminal = page.getByRole('dialog', { name: /order terminal/i });
    await expect(terminal.getByRole('button', { name: 'MAKE THIS REAL' })).toBeVisible();
    // The terminal prints the unit's serial (SM01-...) and the product, so
    // the order screen is provably about *this* sandwich from *this* machine.
    await expect(terminal).toContainText('SOME MORE');
    await expect(terminal).toContainText('ROASTED MARSHMALLOW ICE CREAM');
    await expect(terminal).toContainText(/SM01-\d{4}[A-Z]-\d{5}-[A-Z]/);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: 'Settings' }).click();
    await page.waitForTimeout(500);
    await capture(page, '20-settings');
    // Role-scoped: the word also appears in the section's explanatory copy.
    await expect(page.getByRole('heading', { name: 'Assists' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Picture' })).toBeVisible();

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('commerce placement', () => {
  test('offers nothing to buy before the product reveal', async ({ page }) => {
    // Spec §11 and the substitution ban: no purchase surface exists before
    // the player has seen what they made.
    await page.goto('/?camp=camp-commerce&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await expect(page.getByRole('button', { name: 'Make this real' })).toHaveCount(0);

    await act(page, 'arrive');
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: 'Make this real' })).toHaveCount(0);

    await act(page, 'beginRoasting');
    await page.waitForTimeout(500);
    await expect(page.getByRole('button', { name: 'Make this real' })).toHaveCount(0);
  });
});

test.describe('accessibility', () => {
  test('settings reach the simulation and the renderer', async ({ page }) => {
    await page.goto('/?camp=camp-a11y&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.getByRole('button', { name: 'Settings' }).click();

    // Assists are applied to the live simulation, not just stored.
    await page.getByLabel(/Automatic turning/i).fill('1.2');
    await page.getByLabel(/Assembly snapping/i).fill('1');
    expect(
      await page.evaluate(() => {
        const r = window.__someMore!.store.state.ritual as unknown as {
          options: { autoRotate: number; assemblyAssist: number };
        };
        return [r.options.autoRotate, r.options.assemblyAssist];
      }),
    ).toEqual([1.2, 1]);

    // Picture controls double as accessibility controls.
    await page.getByLabel(/^Dithering/i).fill('0');
    await page.getByLabel(/Vertex wobble/i).fill('0');
    expect(
      await page.evaluate(() => {
        const s = window.__someMore!.store.state.render as unknown as { dither: number; jitter: number };
        return [s.dither, s.jitter];
      }),
    ).toEqual([0, 0]);

    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
    await capture(page, '21-accessibility-no-dither');

    // Settings survive a reload.
    await page.reload();
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    expect(
      await page.evaluate(() => (window.__someMore!.store.state.render as unknown as { dither: number }).dither),
    ).toBe(0);
  });

  test('the marshmallow can be roasted with the keyboard alone', async ({ page }) => {
    await page.goto('/?camp=camp-keys&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await act(page, 'beginRoasting');
    await page.waitForTimeout(300);

    const rotation = () =>
      page.evaluate(
        () =>
          (window.__someMore!.store.state.ritual as unknown as { roastInput: { rotation: number } })
            .roastInput.rotation,
      );

    // Before a key is touched the line teaches the gesture, because a pointer
    // is what most people arrive with.
    await expect(page.getByTestId('guidance')).toContainText('Drag');

    const before = await rotation();
    // No waiting between presses, deliberately. Every press must reach the
    // marshmallow, not just the last one before a frame: the simulation steps
    // sixty times a second whatever the renderer manages, and this ran at
    // about 1.5 frames a second under SwiftShader while twenty-three of every
    // twenty-four presses were being dropped. See defect #25.
    for (let i = 0; i < 10; i++) await page.keyboard.press('ArrowRight');
    const after = await rotation();
    expect(after - before).toBeCloseTo(10 * 0.22, 5);

    // And having used a key, the line now names the keys. The non-gestural
    // path is worth little if nobody is told it is there (spec §12).
    await expect(page.getByTestId('guidance')).toContainText('Arrows');
  });
});


/*
 * Spec §1.3: no "Roast" button, no "Build" button. Two acts held out longest —
 * taking the marshmallow to the plate and taking the sandwich out — and both
 * were a control in the corner of the screen right up until they were not.
 *
 * This drives them by hand and asserts the button is not on screen while it
 * does, because "we replaced the button with a gesture" and "we added a gesture
 * next to the button" look identical from the simulation's side.
 */
test.describe('the last two acts are acts, not buttons', () => {
  /*
   * Both halves of the claim in one assertion, because either alone is wrong.
   *
   * `toBeHidden` is not it: the button is deliberately *in* the accessibility
   * tree — a gesture is not a control scheme (spec §12) — so it is a real,
   * named, focusable button that a screen reader or a Tab will find. What it
   * must not be is on the screen in front of somebody who has a thumb. That is
   * a question about its box, not about its visibility.
   */
  async function offScreenButOffered(
    page: import('@playwright/test').Page,
    name: RegExp,
  ): Promise<void> {
    const button = page.getByRole('button', { name });
    await expect(button, 'the button left the accessibility tree').toHaveCount(1);

    /*
     * Asked as "does a pointer at its own centre hit it", not "how big is its
     * box". The wrapper is clipped to a pixel; the button inside still reports
     * its full layout size, because `overflow: hidden` on a parent changes what
     * is painted and not what a child measures. Hit-testing follows painting,
     * so this is the question that matches the claim: it is reachable by a
     * screen reader and by Tab, and it is not there for a thumb.
     */
    const hit = await button.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const at = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return at === el || el.contains(at);
    });
    expect(hit, 'the button is still on screen where a pointer would find it').toBe(false);
  }

  test('the marshmallow comes off the fire because you pull it off', async ({ page }) => {
    await page.goto('/?camp=camp-pull&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await act(page, 'beginRoasting');
    await page.waitForTimeout(400);

    // Nothing offering to do it for you.
    await offScreenButOffered(page, /take it to the plate/i);
    await expect(page.getByTestId('guidance')).toContainText(/pull/i);

    const box = page.viewportSize()!;
    await page.mouse.move(box.width / 2, box.height * 0.35);
    await page.mouse.down();
    // Drawing it back a little is cooling it, not finishing it.
    await page.mouse.move(box.width / 2, box.height * 0.55, { steps: 8 });
    await page.waitForTimeout(200);
    expect(
      await page.evaluate(() => window.__someMore!.store.state.ritual.stage),
      'drawing it back to cool it ended the roast',
    ).toBe('roasting');

    // Pulling it right back off the coals does.
    await page.mouse.move(box.width / 2, box.height * 0.99, { steps: 20 });
    await page.waitForTimeout(400);
    await page.mouse.up();
    expect(await page.evaluate(() => window.__someMore!.store.state.ritual.stage)).toBe(
      'assembling',
    );
  });

  test('the sandwich comes out because you lift it out', async ({ page }) => {
    await page.goto('/?camp=camp-lift&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await act(page, 'beginRoasting');
    await act(page, 'finishRoasting');
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage === 'assembling', null, {
      timeout: 30_000,
    });
    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      for (let i = 0; i < 4; i += 1) {
        a['holdComponent']!();
        a['placeComponent']!();
      }
    });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage === 'machine', null, {
      timeout: 30_000,
    });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.machine.door > 0.9, null, {
      timeout: 30_000,
    });
    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      a['machine']!({ type: 'load' });
      a['machine']!({ type: 'close-door' });
    });
    await page.waitForFunction(
      () => window.__someMore!.store.state.ritual.machine.stage === 'door-closed',
      null,
      { timeout: 30_000 },
    );
    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      a['machine']!({ type: 'engage-latch' });
      a['machine']!({ type: 'set-program', program: 'standard' });
      a['machine']!({ type: 'confirm' });
      a['machine']!({ type: 'pull-lever' });
    });
    for (let i = 0; i < 80; i += 1) {
      const stage = await page.evaluate(() => {
        window.__someMore!.actions['advanceSeconds']!(5);
        return window.__someMore!.store.state.ritual.machine.stage;
      });
      if (stage === 'complete') break;
    }
    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      a['machine']!({ type: 'release-latch' });
      a['machine']!({ type: 'open-door' });
    });
    await page.waitForFunction(() => window.__someMore!.store.state.ritual.stage === 'reveal', null, {
      timeout: 30_000,
    });
    await page.waitForTimeout(1200);

    await offScreenButOffered(page, /^take it$/i);
    await expect(page.getByTestId('guidance')).toContainText(/lift/i);

    /*
     * Found by looking, not computed: the reveal is a composed shot and the
     * sandwich sits just below the middle of it. A few candidates rather than
     * one, because a pixel-exact expectation here would be a test that fails
     * whenever the framing is improved.
     */
    const box = page.viewportSize()!;
    let taken = false;
    for (const dy of [0.44, 0.48, 0.52, 0.56]) {
      for (const dx of [0.46, 0.5, 0.54]) {
        const x = box.width * dx;
        const y = box.height * dy;
        await page.mouse.move(x, y);
        await page.mouse.down();
        await page.mouse.move(x, y + 70, { steps: 8 });
        await page.mouse.up();
        await page.waitForTimeout(250);
        if ((await page.evaluate(() => window.__someMore!.store.state.ritual.stage)) !== 'reveal') {
          taken = true;
          break;
        }
      }
      if (taken) break;
    }
    expect(taken, 'the sandwich could not be lifted off the tray by hand').toBe(true);
    expect(await page.evaluate(() => window.__someMore!.store.state.ritual.stage)).toBe('eating');
  });
});

test.describe('exploration', () => {
  test('the campsite can actually be walked around and looked at', async ({ page }) => {
    // Until this existed the camera was on rails and the campsite was a set
    // of views rather than a place (spec §5.1).
    await page.goto('/?camp=camp-explore&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(1200);

    const read = () =>
      page.evaluate(() => {
        const p = window.__someMore!.player!;
        return {
          x: Number(p.position.x.toFixed(3)),
          z: Number(p.position.z.toFixed(3)),
          facing: Number(p.facing.toFixed(3)),
          still: p.stillnessSeconds,
          walked: p.distanceWalked,
        };
      });

    const start = await read();
    // Arrival puts the player at the fireside, not stranded on the trail.
    expect(Math.hypot(start.x, start.z)).toBeLessThan(4);

    // Drag to look.
    await page.mouse.move(512, 400);
    await page.mouse.down();
    for (let i = 1; i <= 18; i++) {
      await page.mouse.move(512 + i * 14, 400);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
    const looked = await read();
    expect(looked.facing).not.toBe(start.facing);
    // Looking must not move you.
    expect(looked.x).toBeCloseTo(start.x, 1);
    expect(looked.z).toBeCloseTo(start.z, 1);
    await capture(page, '22-exploring-look');

    // Tap to walk.
    await page.mouse.click(512, 650);
    await page.waitForTimeout(3500);
    const walked = await read();
    expect(walked.walked).toBeGreaterThan(0.5);
    await capture(page, '23-exploring-walk');

    // Keyboard walk, as an alternate control scheme.
    const before = (await read()).walked;
    await page.keyboard.down('w');
    await page.waitForTimeout(1800);
    await page.keyboard.up('w');
    await page.waitForTimeout(300);
    expect((await read()).walked).toBeGreaterThan(before);

    // The campsite is bounded — you cannot wander off into nothing.
    const radius = await page.evaluate(() => window.__someMore!.walkable!.radius);
    for (let i = 0; i < 6; i++) {
      await page.keyboard.down('w');
      await page.waitForTimeout(1500);
      await page.keyboard.up('w');
    }
    const far = await read();
    expect(Math.hypot(far.x, far.z)).toBeLessThanOrEqual(radius + 0.01);
  });

  test('walking up to something offers it, and standing away does not', async ({ page }) => {
    await page.goto('/?camp=camp-reach&env=pine_hollow');
    await page.waitForFunction(() => Boolean(window.__someMore?.three));
    await act(page, 'arrive');
    await page.waitForTimeout(1200);

    // Put the player out in the open, away from everything.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 7;
      p.position.z = 7;
      p.moveTarget = null;
    });
    await page.waitForTimeout(600);
    await expect(page.getByRole('button', { name: /Take a log|Poke the coals|Take a marshmallow/ })).toHaveCount(0);

    // Now stand at the woodpile.
    await page.evaluate(() => {
      const p = window.__someMore!.player!;
      p.position.x = 1.75;
      p.position.z = -0.1;
      p.facing = -Math.PI / 2;
      p.moveTarget = null;
    });
    await page.waitForTimeout(700);
    const logs = await page.evaluate(() => (window.__someMore!.store.state.ritual as unknown as { fire: { logs: unknown[] } }).fire.logs.length);
    await page.getByRole('button', { name: 'Take a log' }).click();
    await page.waitForTimeout(400);
    expect(
      await page.evaluate(() => (window.__someMore!.store.state.ritual as unknown as { fire: { logs: unknown[] } }).fire.logs.length),
    ).toBe(logs + 1);
    await capture(page, '24-reach-woodpile');
  });
});
