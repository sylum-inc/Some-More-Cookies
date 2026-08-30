import { expect, test } from '@playwright/test';
import { act, advanceUntil, capture, readWorld, waitForWorld } from './helpers.js';

/**
 * §12, driven rather than read.
 *
 * Every other suite here reaches the world through `window.__someMore.actions`
 * — the same functions the interface calls, which is exactly the right way to
 * test the *simulation* and exactly the wrong way to find out whether anybody
 * can reach it. Assembly and the SM-01 had been green in `acceptance` and
 * `visual` since they were built, and neither had a keyboard path at all: the
 * assembly stage is a pointer drag, and the machine's controls are meshes
 * inside a canvas. A test that calls `holdComponent()` cannot see that, in the
 * same way that a test that builds its own `Rng` could not see defect #11.
 *
 * So the rule for this file: **once the ritual reaches a stage under audit,
 * nothing but `page.keyboard` may touch it.** Fast-forwarding the model is
 * still allowed — waiting out fifty seconds of refrigeration is measuring
 * SwiftShader, not accessibility.
 */

const CAMP = '/?camp=camp-access&env=pine_hollow';

async function boot(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(CAMP);
  await page.waitForFunction(() => Boolean(window.__someMore?.three));
  await page.waitForTimeout(1200);
}

/** The parts of the world this suite asserts on. */
function readAssembly(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const r = window.__someMore!.store.state.ritual as unknown as {
      stage: string;
      assembly: {
        heldKind: string | null;
        heldOffset: { x: number; z: number };
        heldRotation: number;
        components: { kind: string; offset: { x: number; z: number }; rotation: number; placed: boolean }[];
      };
      machine: { stage: string; door: number; latch: number; program: string; frost: number };
      sandwich: { class: string } | null;
    };
    return {
      stage: r.stage,
      heldKind: r.assembly.heldKind,
      heldOffset: { x: Number(r.assembly.heldOffset.x.toFixed(4)), z: Number(r.assembly.heldOffset.z.toFixed(4)) },
      heldRotation: Number(r.assembly.heldRotation.toFixed(4)),
      placed: r.assembly.components.filter((c) => c.placed).length,
      offsets: r.assembly.components
        .filter((c) => c.placed)
        .map((c) => Number(Math.hypot(c.offset.x, c.offset.z).toFixed(4))),
      machineStage: r.machine.stage,
      machineDoor: Number(r.machine.door.toFixed(3)),
      program: r.machine.program,
      sandwichClass: r.sandwich?.class ?? null,
    };
  });
}

test.describe('the ritual, on the keyboard alone', () => {
  test('a person who cannot use a pointer can still make a sandwich', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    await boot(page);

    // Arriving and roasting already had keyboard paths; they are driven here
    // too, because "the keyboard path exists" has to be true of the whole walk
    // and not of the two stages somebody remembered.
    await page.keyboard.press('Enter');
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);

    await act(page, 'rake');
    await advanceUntil(page, 'r.fire.flame < 0.2 && r.fire.emberMass > 0.2', 'ember bed', 900);
    await act(page, 'beginRoasting');
    await waitForWorld(page, "r.stage === 'roasting'", 'roasting');

    // Roast it on the arrow keys, turning as you go, the way the settings
    // screen says you can.
    for (let i = 0; i < 8; i += 1) {
      await page.keyboard.press('ArrowUp');
      for (let turn = 0; turn < 4; turn += 1) await page.keyboard.press('ArrowRight');
      await act(page, 'advanceSeconds', 8);
    }
    /*
     * Both halves of the drag, asserted separately.
     *
     * `rotation` is the one that can be pinned exactly: since `applyRoastPose`
     * runs on the press rather than on the next frame, thirty-two ArrowRight
     * presses are thirty-two quarter-turns whatever the renderer is doing.
     * Browning is a consequence of where the marshmallow ended up in the heat
     * and stays a floor rather than a figure.
     */
    const roasted = await readWorld(page);
    const turned = await page.evaluate(
      () => (window.__someMore!.store.state.ritual as unknown as { roastInput: { rotation: number } }).roastInput.rotation,
    );
    expect(turned, 'the arrow keys did not turn the marshmallow').toBeGreaterThan(6);
    expect(roasted.brown, 'the arrow keys did not move the marshmallow into the heat').toBeGreaterThan(0.15);

    await act(page, 'finishRoasting');
    await waitForWorld(page, "r.stage === 'assembling'", 'assembling');

    // --- Assembly, keyboard only -----------------------------------------
    // Four components. Each one is picked up, shifted somewhere deliberate,
    // turned, and set down — which is the whole of §4.3 and is not a "Build"
    // button (§1.3).
    const nudges: readonly (readonly [string, number])[] = [
      ['ArrowRight', 2],
      ['ArrowUp', 3],
      ['ArrowLeft', 2],
      ['ArrowDown', 1],
    ];
    for (let piece = 0; piece < 4; piece += 1) {
      await page.keyboard.press('Enter');
      const held = await readAssembly(page);
      expect(held.heldKind, `piece ${piece} did not come off the plate`).not.toBeNull();

      const [key, times] = nudges[piece]!;
      for (let i = 0; i < times; i += 1) await page.keyboard.press(key);
      await page.keyboard.press(piece % 2 === 0 ? ']' : '[');
      const moved = await readAssembly(page);
      expect(Math.hypot(moved.heldOffset.x, moved.heldOffset.z)).toBeGreaterThan(0);
      expect(Math.abs(moved.heldRotation)).toBeGreaterThan(0);

      await page.keyboard.press('Enter');
      await page.waitForTimeout(250);
      expect((await readAssembly(page)).placed).toBe(piece + 1);
    }
    await capture(page, 'a11y-01-assembled-on-the-keyboard');

    // Placement genuinely mattered: the stack is not four pieces stacked
    // perfectly on top of each other, it is handmade.
    const stacked = await readAssembly(page);
    expect(Math.max(...stacked.offsets)).toBeGreaterThan(0);

    await advanceUntil(page, "r.stage === 'machine'", 'machine');
    await advanceUntil(page, 'r.machine.door > 0.9', 'door open');

    // --- The SM-01, keyboard only ----------------------------------------
    // One key per control. Twelve stages, still twelve stages.
    await page.keyboard.press('l');
    await page.keyboard.press('d');
    await advanceUntil(page, "r.machine.stage === 'door-closed'", 'door closed');
    await page.keyboard.press('x');
    await page.keyboard.press('3');
    expect((await readAssembly(page)).program).toBe('deep-freeze');
    await page.keyboard.press('2');
    expect((await readAssembly(page)).program).toBe('standard');
    await page.keyboard.press('Enter');
    await capture(page, 'a11y-02-machine-armed-on-the-keyboard');
    await page.keyboard.press('p');

    await advanceUntil(page, "r.machine.stage === 'processing'", 'processing');
    await advanceUntil(page, "r.machine.stage === 'freezing'", 'freezing');
    await advanceUntil(page, "r.machine.stage === 'complete'", 'complete');
    await page.keyboard.press('x');
    await page.keyboard.press('d');
    await waitForWorld(page, "r.stage === 'reveal'", 'reveal');

    // Taking it off the tray is already a real button, so it is reached the
    // way a keyboard reaches a button.
    await page.getByRole('button', { name: 'Take it' }).focus();
    await page.keyboard.press('Enter');
    await waitForWorld(page, "r.stage === 'eating'", 'eating');
    await capture(page, 'a11y-03-reveal-on-the-keyboard');

    const finished = await readAssembly(page);
    expect(finished.sandwichClass).not.toBeNull();
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('turning your head without a pointer', () => {
  /*
   * `player.facing` moves in exactly two ways: a pointer look delta, and
   * walking toward a tapped point. Both are pointer input. So a keyboard
   * player could cross the campsite and never change which way they were
   * facing — and everything §5.2 offers is aimed: the sky, the torch, the
   * water you fish in, the animal at the treeline.
   */
  test('the arrow keys look, and WASD does not', async ({ page }) => {
    await boot(page);
    await page.keyboard.press('Enter');
    await waitForWorld(page, "r.stage === 'at-fire'", 'arrival', 40_000);

    const pose = () =>
      page.evaluate(() => {
        const p = window.__someMore!.player!;
        return { facing: Number(p.facing.toFixed(4)), pitch: Number(p.pitch.toFixed(4)) };
      });

    const before = await pose();

    await page.keyboard.down('ArrowRight');
    await page.waitForTimeout(700);
    await page.keyboard.up('ArrowRight');
    const turned = await pose();
    expect(turned.facing, 'holding a look key did not turn the player').not.toBeCloseTo(before.facing, 2);

    // And it stops when the key does, rather than turning forever.
    await page.waitForTimeout(600);
    expect((await pose()).facing).toBeCloseTo(turned.facing, 4);

    await page.keyboard.down('ArrowUp');
    await page.waitForTimeout(500);
    await page.keyboard.up('ArrowUp');
    const raised = await pose();
    expect(raised.pitch, 'holding a look key did not raise the view').toBeGreaterThan(turned.pitch);

    // Walking is still walking: WASD moves without steering.
    const walkFrom = await pose();
    await page.keyboard.down('w');
    await page.waitForTimeout(500);
    await page.keyboard.up('w');
    expect((await pose()).facing).toBeCloseTo(walkFrom.facing, 4);
  });
});

test.describe('what a screen reader is given', () => {
  test('subtitles are announced, not merely drawn', async ({ page }) => {
    await boot(page);
    // The subtitle region is the text channel for anything audible (§12). It
    // is a live region or it reaches nobody who is not watching that corner.
    await page.evaluate(() => window.__someMore!.store.setSubtitle('[a relay clicks twice]'));
    const subtitle = page.getByTestId('subtitle');
    await expect(subtitle).toHaveAttribute('role', 'status');
    await expect(subtitle).toHaveAttribute('aria-live', 'polite');
    await expect(subtitle).toContainText('relay');

    // The guidance line changes without any focus moving, so it needs the
    // same treatment.
    await expect(page.getByTestId('guidance')).toHaveAttribute('aria-live', 'polite');
  });

  test('every overlay names itself and can be shut from the keyboard', async ({ page }) => {
    await boot(page);
    for (const [button, name] of [
      ['Settings', 'Settings'],
      ['Passport', 'Campfire Passport'],
    ] as const) {
      await page.getByRole('button', { name: button }).click();
      await expect(page.getByRole('dialog', { name })).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog', { name })).toHaveCount(0);
    }
  });
});

test.describe('the assists a player can actually reach', () => {
  /*
   * Both of these were implemented, persisted and honoured by the input layer,
   * and had no control anywhere — the only way to switch them on was to write
   * them into `localStorage`, which is what the offline suite was doing. An
   * assist nobody can find is not an assist.
   */
  test('simplified gestures and the joystick are on the settings screen', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();

    const simplified = page.getByRole('checkbox', { name: /Simplified gestures/ });
    const joystick = page.getByRole('checkbox', { name: /Walk with a joystick/ });
    await expect(simplified).toBeVisible();
    await expect(joystick).toBeVisible();

    await simplified.check();
    await joystick.check();
    const stored = await page.evaluate(() =>
      JSON.parse(localStorage.getItem('some-more/settings/v1') ?? '{}'),
    );
    expect(stored.accessibility.simplifiedGestures).toBe(true);
    expect(stored.accessibility.virtualJoystick).toBe(true);

    // Simplified gestures means the fire is tended by controls rather than by
    // reaching for it, wherever the player happens to be standing.
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Add wood' })).toBeVisible();
  });

  test('the keys are written down somewhere a player can read them', async ({ page }) => {
    await boot(page);
    await page.getByRole('button', { name: 'Settings' }).click();
    const dialog = page.getByRole('dialog', { name: 'Settings' });
    await expect(dialog).toContainText('SM-01: load, door, latch');
    await expect(dialog).toContainText('Assemble: pick up, set down');
  });
});

/*
 * Audit A4. Every overlay named itself and closed on Escape, and not one of
 * them moved focus — nothing in `apps/web/src` called `.focus()` at all. So
 * somebody opening the Passport on a keyboard was not taken to it, and could
 * Tab straight back out into the campsite behind a panel covering the screen.
 * `Scan` and `Terminal` are the sharp cases: a code entry form and a checkout.
 */
test.describe('an overlay is a place you are taken to', () => {
  for (const [button, name] of [
    ['Passport', 'Campfire Passport'],
    ['Settings', 'Settings'],
  ] as const) {
    test(`${name} takes focus, keeps it, and gives it back`, async ({ page }) => {
      await boot(page);
      const opener = page.getByRole('button', { name: button });
      await opener.focus();
      await page.keyboard.press('Enter');

      const dialog = page.getByRole('dialog', { name });
      await expect(dialog).toBeVisible();
      await expect(dialog).toHaveAttribute('aria-modal', 'true');

      const inside = () =>
        dialog.evaluate((el) => el.contains(document.activeElement) && document.activeElement !== document.body);
      expect(await inside(), 'focus was not moved into the dialog').toBe(true);

      // Round the whole cycle and back — more presses than the panel has
      // controls, so a trap that only holds for one lap would fail here.
      for (let i = 0; i < 40; i += 1) await page.keyboard.press('Tab');
      expect(await inside(), 'Tab escaped the dialog').toBe(true);

      // Backwards too, which is the half that is usually forgotten.
      for (let i = 0; i < 8; i += 1) await page.keyboard.press('Shift+Tab');
      expect(await inside(), 'Shift+Tab escaped the dialog').toBe(true);

      await page.keyboard.press('Escape');
      await expect(dialog).toBeHidden();
      expect(
        await opener.evaluate((el) => el === document.activeElement),
        'focus was not returned to the control that opened it',
      ).toBe(true);
    });
  }
});

/*
 * Audit A5. §3.2 makes the SM-01's colour semantic — amber working, blue
 * transforming, pulsing amber a fault — and `indicatorColor()` was the only
 * place that lived. `displayText()` is drawn as a texture *inside the canvas*,
 * so it was never a second channel. §12: no information through one channel.
 */
test.describe('the machine says what it is doing', () => {
  test('narrates its own state in words, and names its colour', async ({ page }) => {
    await boot(page);
    const said = page.getByTestId('machine-state');

    // Before anything is loaded.
    await expect(said).toHaveText(/machine is (open and empty|ready)/i);

    // Drive it to the two stages whose only other channel is a colour.
    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      a['arrive']!();
      a['beginRoasting']!();
      a['finishRoasting']!();
    });
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
    await expect(said).toHaveText(/not yet latched/i);

    await page.evaluate(() => {
      const a = window.__someMore!.actions;
      a['machine']!({ type: 'engage-latch' });
      a['machine']!({ type: 'set-program', program: 'standard' });
      a['machine']!({ type: 'confirm' });
      a['machine']!({ type: 'pull-lever' });
    });
    await page.waitForFunction(
      () => window.__someMore!.store.state.ritual.machine.stage === 'processing',
      null,
      { timeout: 30_000 },
    );
    // Amber, said out loud rather than only shown.
    await expect(said).toHaveText(/amber/i);

    // Fast-forwarded through the real model rather than waited out. In chunks,
    // because how long the amber stretch runs is the program's business and
    // this test is about what the machine *says*, not how long it takes.
    for (let i = 0; i < 40; i += 1) {
      const stage = await page.evaluate(() => {
        window.__someMore!.actions['advanceSeconds']!(5);
        return window.__someMore!.store.state.ritual.machine.stage;
      });
      if (stage === 'freezing') break;
    }
    await page.waitForFunction(
      () => window.__someMore!.store.state.ritual.machine.stage === 'freezing',
      null,
      { timeout: 30_000 },
    );
    await expect(said).toHaveText(/blue/i);
  });

  test('the canvas is not an anonymous rectangle', async ({ page }) => {
    await boot(page);
    const label = await page.evaluate(() => document.querySelector('canvas')?.getAttribute('aria-label'));
    expect(label, 'the largest element on the page has no accessible name').toBeTruthy();
    expect(label).toMatch(/campsite/i);
  });
});
