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
/**
 * Waits until the camera has stopped moving.
 *
 * `settleMs` is a fixed wait, and a fixed wait is a bet on how fast the
 * machine is. The camera is the player's own eyes and it *eases* — toward the
 * thing they walked up to, down into a crouch, out of a stance — so a frame
 * taken while an ease is still running is a frame of a camera in a place it
 * was never going to stop.
 *
 * That is not hypothetical. The `assembled` baseline caught the SM-01 mid
 * head-turn: the diff against a later run showed the whole machine doubled at
 * an offset, twelve per cent of the frame, with no content changed at all.
 * Under software rendering the frame rate swings by an order of magnitude, so
 * whether 900 ms is enough depends on what else the machine was doing.
 *
 * Polls the live camera until two consecutive reads agree to within a
 * millimetre, then gives up rather than failing: a caller that cannot get a
 * still camera still deserves its screenshot, and the tolerance below is far
 * tighter than anything a baseline can see.
 */
export async function waitForCameraStill(page: Page, timeoutMs = 4000): Promise<void> {
  const read = (): Promise<[number, number, number] | null> =>
    page.evaluate(() => {
      const three = window.__someMore?.three as unknown as
        | { camera?: { position: { x: number; y: number; z: number } } }
        | undefined;
      const p = three?.camera?.position;
      return p ? ([p.x, p.y, p.z] as [number, number, number]) : null;
    });

  let previous = await read();
  if (previous === null) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await page.waitForTimeout(120);
    const next = await read();
    if (next === null) return;
    const moved = Math.hypot(next[0] - previous[0], next[1] - previous[1], next[2] - previous[2]);
    if (moved < 0.001) return;
    previous = next;
  }
}

export async function driveRitual(
  page: Page,
  visit: StageVisitor,
  settleMs = 900,
  onRoast?: (outcome: RoastOutcome) => void,
): Promise<void> {
  const at = async (stage: StageId): Promise<void> => {
    await page.waitForTimeout(settleMs);
    await waitForCameraStill(page);
    await visit(stage, page);
  };

  await at('arrival');

  // Arrive without the walk-in animation: the walk is wall-clock driven, and
  // the acceptance test already proves it works.
  await act(page, 'arrive');
  await at('at-fire');

  /*
   * The pit may be banked.
   *
   * A campsite you have used before is found the way you left it: grey ash,
   * no flame, and two hundred degrees underneath. Any suite that navigates
   * twice — the offline one boots cold after a warm visit — meets it on the
   * second run, and a split log on a cold bed does nothing at all, which is
   * the whole point of the wood the catalogue describes. So wake it the way a
   * person does before driving the ritual.
   */
  const banked = await page.evaluate(() => {
    const fire = (window.__someMore!.store.state.ritual as unknown as {
      fire: { ashCover: number; flame: number };
    }).fire;
    return fire.ashCover > 0.5 && fire.flame < 0.05;
  });
  // Worth saying out loud in every suite: a run that woke last night's coals
  // and a run that walked in on a burning fire are two different nights.
  // eslint-disable-next-line no-console
  console.log(`pit on arrival: ${banked ? 'banked — waking it' : 'burning'}`);
  if (banked) {
    await act(page, 'rake');
    await act(page, 'rake');
    await act(page, 'fan');
    // Dry fine fuel, standing in for an armful brought back from the treeline.
    await act(page, 'layFuel', 'pine', 'tinder', 0.05, 0.4, 0.02);
    await act(page, 'layFuel', 'pine', 'tinder', 0.05, 2.5, 0.02);
    for (let i = 0; i < 3; i += 1) {
      await act(page, 'layFuel', 'birch', 'kindling', 0.09, i * 2.1, 0.04);
    }
    await act(page, 'advanceSeconds', 3);
    await act(page, 'fan');
    await advanceUntil(page, 'r.fire.flame > 0.5', 'last night’s coals catching', 300);
    // Kindling does not last. What it leaves behind is a bed a real log will
    // take from, and a real log alight is what "the fire is back" means.
    await act(page, 'layFuel', 'pine', 'log', 0.11, 1.1, 0.1);
    await advanceUntil(
      page,
      "r.fire.logs.some((l) => l.grade === 'log' && l.ignition > 0.5)",
      'a split log properly alight',
      400,
    );
  }

  await act(page, 'rake');
  await act(page, 'addLog', 'oak');
  await at('fire-tended');

  /*
   * The ember bed is the roasting surface the thermal model is tuned for —
   * and a bed is not ready because it exists, it is ready because it is hot.
   *
   * The mass and the temperature are both in here because a fire woken from
   * last night's coals passes "low flame, some coals" almost immediately and
   * is still building. Half a bed radiates about half as much, and roasting
   * over it browns a fifth of what an established fire does — which is the
   * right behaviour and the wrong moment to start. A player who knows what
   * they are doing waits for the bed. So does this.
   */
  await advanceUntil(
    page,
    'r.fire.flame < 0.2 && r.fire.emberMass > 0.45 && r.fire.emberTemp > 540',
    'a bed hot enough to cook on',
    900,
  );
  await at('ember-bed');

  // --- Roasting, driven with the keyboard --------------------------------
  // ArrowUp closes the distance, ArrowRight turns the stick — the same
  // accessibility path the acceptance suite proves works, used here because
  // key presses reach the same control as a drag without depending on
  // pointer timing.
  /*
   * What the fire was actually like when the roasting started.
   *
   * Printed because "the roast came out pale" is unactionable and "the roast
   * came out pale over a bed of 0.33 at 480 degrees in a four-metre wind" is
   * a diagnosis. Two suites drive the same ritual over two different fires —
   * one walked in on, one woken from last night's coals — and the difference
   * between them lives here.
   */
  // eslint-disable-next-line no-console
  console.log(
    'roasting over: ' +
      JSON.stringify(
        await page.evaluate(() => {
          const r = window.__someMore!.store.state.ritual as unknown as {
            fire: { flame: number; emberMass: number; emberTemp: number; ashCover: number; windSpeed: number; oxygen: number };
            weather: { kind: string; precipitation: number; temperatureC: number };
          };
          return {
            ember: Number(r.fire.emberMass.toFixed(2)),
            temp: Math.round(r.fire.emberTemp),
            flame: Number(r.fire.flame.toFixed(2)),
            ash: Number(r.fire.ashCover.toFixed(2)),
            wind: Number(r.fire.windSpeed.toFixed(2)),
            weather: r.weather.kind,
            rain: Number(r.weather.precipitation.toFixed(2)),
            airC: Math.round(r.weather.temperatureC),
          };
        }),
      ),
  );

  await act(page, 'beginRoasting');
  for (let i = 0; i < 6; i += 1) await page.keyboard.press('ArrowUp');
  await at('roasting');

  /*
   * Turned until it is roasted, not for a fixed count of turns.
   *
   * Thirty-eight seconds is a golden marshmallow over a bed at six hundred and
   * sixty degrees and a pale one over a bed at five hundred and fifty woken
   * from last night's coals in light rain — and the person holding the stick
   * would simply have held it there longer. Turning to a result rather than to
   * a stopwatch is what anybody does, and it keeps this driver measuring the
   * ritual instead of measuring the weather.
   */
  for (let turn = 0; turn < 90; turn += 1) {
    await page.keyboard.press('ArrowRight');
    await act(page, 'advanceSeconds', 1.6);
    if (turn < 11) continue;
    const done = await page.evaluate(() => {
      const m = (window.__someMore!.store.state.ritual as unknown as {
        marshmallow: { patches: { brown: number; char: number }[]; burning: boolean };
      }).marshmallow;
      const mean = (pick: (p: { brown: number; char: number }) => number) =>
        m.patches.reduce((total, p) => total + pick(p), 0) / m.patches.length;
      return { brown: mean((p) => p.brown), char: mean((p) => p.char), burning: m.burning };
    });
    // Golden, or starting to catch. Either way it comes off the fire.
    if (done.burning || done.char > 0.18 || done.brown > 0.34) break;
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
