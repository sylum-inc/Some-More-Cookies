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
    await page.getByRole('button', { name: 'Rake coals' }).click();
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
    // Turning it steadily over coals should reach golden without ruining it.
    expect(roasted.brown).toBeGreaterThan(0.35);
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

    const before = await page.evaluate(
      () => (window.__someMore!.store.state.ritual as unknown as { roastInput: { rotation: number } }).roastInput.rotation,
    );
    for (let i = 0; i < 10; i++) {
      await page.keyboard.press('ArrowRight');
      await page.waitForTimeout(60);
    }
    const after = await page.evaluate(
      () => (window.__someMore!.store.state.ritual as unknown as { roastInput: { rotation: number } }).roastInput.rotation,
    );
    expect(after).toBeGreaterThan(before);
  });
});
