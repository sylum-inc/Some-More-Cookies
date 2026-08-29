import type { Page } from '@playwright/test';
import { act, advanceUntil } from './helpers.js';

/**
 * One shared, deterministic drive of the whole ritual.
 *
 * `ritual.spec.ts` is the *acceptance* test: it uses real pointer drags at real
 * speed because it is asserting that a person can do this. The performance and
 * visual-regression suites need something different — the same stages, reached
 * the same way every run, as fast as the model allows — so they share this
 * driver instead.
 *
 * Everything here goes through the same `window.__someMore.actions` the
 * interface itself calls, plus real keyboard input for roasting. Nothing is
 * stubbed; `advanceSeconds` runs the real `stepRitual` at the real fixed
 * timestep (see `main.tsx`), it does not skip simulation.
 *
 * Determinism caveat, stated here because the visual baselines depend on it:
 * the render loop advances the simulation by *wall-clock* delta, so the fire's
 * flicker phase at the instant of a screenshot is not reproducible. Stage
 * *state* is reproducible; the exact pixels of the flames are not. The visual
 * suite's tolerances are set from measured run-to-run noise for that reason.
 */

export const STAGE_IDS = [
  'arrival',
  'at-fire',
  'fire-tended',
  'ember-bed',
  'roasting',
  'roasted',
  'assembling',
  'assembled',
  'machine-idle',
  'machine-armed',
  'processing',
  'freezing',
  'complete',
  'reveal',
  'eating',
  'bitten',
] as const;

export type StageId = (typeof STAGE_IDS)[number];

/** Called once the world has settled into each stage. */
export type StageVisitor = (stage: StageId, page: Page) => Promise<void>;

/**
 * What the roast actually achieved.
 *
 * Read and reported by the suites that use this driver, because a roasting
 * stage that quietly stops roasting is the exact way a visual baseline and a
 * performance sample become pictures of nothing while still passing. Browning
 * is the outcome; `rotation` is the input that produces an even one.
 */
export interface RoastOutcome {
  stage: string;
  rotation: number;
  brown: number;
  char: number;
  /** Highest minus lowest patch browning: a turned marshmallow evens out. */
  spread: number;
}

export async function readRoast(page: Page): Promise<RoastOutcome> {
  return page.evaluate(() => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const r = (window as any).__someMore.store.state.ritual;
    const patches: { brown: number; char: number }[] = r.marshmallow.patches;
    const mean = (pick: (p: { brown: number; char: number }) => number) =>
      patches.reduce((total, p) => total + pick(p), 0) / patches.length;
    const browns = patches.map((p) => p.brown);
    const round = (v: number) => Math.round(v * 10000) / 10000;
    return {
      stage: r.stage,
      rotation: round(r.roastInput.rotation),
      brown: round(mean((p) => p.brown)),
      char: round(mean((p) => p.char)),
      spread: round(Math.max(...browns) - Math.min(...browns)),
    };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

/** Loads the world with a pinned campsite and environment and waits for WebGL. */
export async function openWorld(page: Page, camp: string, env = 'pine_hollow'): Promise<void> {
  await page.goto(`/?camp=${camp}&env=${env}`);
  await page.waitForFunction(() => Boolean(window.__someMore?.three));
  // Procedural textures are generated on first use; give the first frames time
  // to build them so the first capture is not of a half-dressed world.
  await page.waitForTimeout(2500);
}

/**
 * Drives the ritual through every stage, calling `visit` at each one.
 *
 * `settleMs` is real time spent rendering before the visitor runs, so a
 * screenshot or a `renderer.info` read sees a fully composed frame rather than
 * the first frame after a state change.
 */
export async function driveRitual(
  page: Page,
  visit: StageVisitor,
  settleMs = 900,
  onRoast?: (outcome: RoastOutcome) => void,
): Promise<void> {
  const at = async (stage: StageId): Promise<void> => {
    await page.waitForTimeout(settleMs);
    await visit(stage, page);
  };

  await at('arrival');

  // Arrive without the walk-in animation: the walk is wall-clock driven, and
  // the acceptance test already proves it works.
  await act(page, 'arrive');
  await at('at-fire');

  await act(page, 'rake');
  await act(page, 'addLog', 'oak');
  await at('fire-tended');

  // The ember bed is the roasting surface the thermal model is tuned for.
  await advanceUntil(page, 'r.fire.flame < 0.2 && r.fire.emberMass > 0.2', 'ember bed', 900);
  await at('ember-bed');

  // --- Roasting, driven with the keyboard --------------------------------
  // ArrowUp closes the distance, ArrowRight turns the stick — the same
  // accessibility path the acceptance suite proves works, used here because
  // key presses reach the same control as a drag without depending on
  // pointer timing.
  await act(page, 'beginRoasting');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowUp');
  await at('roasting');

  for (let turn = 0; turn < 24; turn += 1) {
    await page.keyboard.press('ArrowRight');
    await act(page, 'advanceSeconds', 1.6);
  }
  // Measured, not assumed. See `RoastOutcome`: the suites that use this driver
  // report the result so a roasting stage that has stopped roasting shows up as
  // a number rather than as a slightly different picture nobody looks at.
  onRoast?.(await readRoast(page));
  await at('roasted');

  // --- Assembly ----------------------------------------------------------
  await act(page, 'finishRoasting');
  await advanceUntil(page, "r.stage === 'assembling'", 'assembling');
  const offsets: [number, number][] = [
    [0.004, 0.002],
    [-0.005, 0.003],
    [0.003, -0.004],
    [0.004, 0.002],
  ];
  for (let i = 0; i < offsets.length; i += 1) {
    await act(page, 'holdComponent');
    await act(page, 'moveComponent', offsets[i]![0], offsets[i]![1]);
    if (i === 1) await at('assembling');
    await act(page, 'placeComponent');
  }
  await at('assembled');

  // --- The SM-01 ---------------------------------------------------------
  await advanceUntil(page, "r.stage === 'machine'", 'machine');
  await advanceUntil(page, 'r.machine.door > 0.9', 'door open');
  await at('machine-idle');

  await act(page, 'machine', { type: 'load' });
  await act(page, 'machine', { type: 'close-door' });
  await advanceUntil(page, "r.machine.stage === 'door-closed'", 'door closed');
  await act(page, 'machine', { type: 'engage-latch' });
  await act(page, 'machine', { type: 'set-program', program: 'standard' });
  await act(page, 'machine', { type: 'confirm' });
  await at('machine-armed');

  await act(page, 'machine', { type: 'pull-lever' });
  await advanceUntil(page, "r.machine.stage === 'processing'", 'processing');
  await act(page, 'advanceSeconds', 6);
  await at('processing');

  await advanceUntil(page, "r.machine.stage === 'freezing'", 'freezing');
  await act(page, 'advanceSeconds', 9);
  await at('freezing');

  await advanceUntil(page, "r.machine.stage === 'complete'", 'complete');
  await at('complete');

  await act(page, 'machine', { type: 'release-latch' });
  await act(page, 'machine', { type: 'open-door' });
  await advanceUntil(page, "r.stage === 'reveal'", 'reveal');
  await act(page, 'advanceSeconds', 2);
  await at('reveal');

  // --- Eating ------------------------------------------------------------
  await act(page, 'takeSandwich');
  await advanceUntil(page, "r.stage === 'eating'", 'eating');
  await act(page, 'advanceSeconds', 3);
  await at('eating');

  await act(page, 'bite', 0);
  await act(page, 'bite', 1);
  await at('bitten');
}
