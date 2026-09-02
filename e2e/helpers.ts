import type { Page } from '@playwright/test';

export const SHOTS = 'artifacts/screenshots';

/** The window handle the client exposes for inspection and testing. */
export interface SomeMoreHandle {
  actions: Record<string, (...args: unknown[]) => unknown>;
  store: { state: Record<string, unknown> };
  environments: readonly { id: string; name: string }[];
  three?: { scene: unknown; camera: unknown };
  /** The player being simulated, when a spec needs to look at somebody. */
  player?: import('@somemore/sim').PlayerState;
  /** The shared fire, present only when a link brought this page to one. */
  campfire?: import('../apps/web/src/net/campfire.js').Campfire;
}


declare global {
  interface Window {
    __someMore?: SomeMoreHandle;
  }
}

/**
 * Invokes one of the ritual actions the interface itself calls.
 * These are the real simulation entry points, not stubs.
 */
export function act(page: Page, name: string, ...args: unknown[]): Promise<unknown> {
  return page.evaluate(
    ([n, a]) => window.__someMore!.actions[n as string]!(...(a as unknown[])),
    [name, args] as const,
  );
}

/** A compact readout of the world, used for assertions and for logging. */
export function readWorld(page: Page): Promise<{
  stage: string;
  flame: number;
  ember: number;
  brown: number;
  char: number;
  machineStage: string;
  frost: number;
  sandwichClass: string | null;
  sandwichCaption: string | null;
  eaten: number;
}> {
  return page.evaluate(() => {
    const r = window.__someMore!.store.state.ritual as Record<string, never>;
    const anyR = r as unknown as {
      stage: string;
      fire: { flame: number; emberMass: number };
      marshmallow: { patches: { brown: number; char: number }[] };
      machine: { stage: string; frost: number };
      sandwich: { class: string; caption: string } | null;
      bite: { eaten: number };
    };
    const patches = anyR.marshmallow.patches;
    const mean = (pick: (p: { brown: number; char: number }) => number) =>
      patches.reduce((total, p) => total + pick(p), 0) / patches.length;
    return {
      stage: anyR.stage,
      flame: Number(anyR.fire.flame.toFixed(3)),
      ember: Number(anyR.fire.emberMass.toFixed(3)),
      brown: Number(mean((p) => p.brown).toFixed(3)),
      char: Number(mean((p) => p.char).toFixed(3)),
      machineStage: anyR.machine.stage,
      frost: Number(anyR.machine.frost.toFixed(3)),
      sandwichClass: anyR.sandwich?.class ?? null,
      sandwichCaption: anyR.sandwich?.caption ?? null,
      eaten: Number(anyR.bite.eaten.toFixed(3)),
    };
  });
}

/** Polls a predicate in the page. Simulation timing is not wall-clock exact. */
export async function waitForWorld(
  page: Page,
  predicate: string,
  label: string,
  timeoutMs = 180_000,
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const ok = await page.evaluate((source) => {
      const ritual = window.__someMore!.store.state.ritual as unknown as Record<string, unknown>;
      // eslint-disable-next-line no-new-func
      return Boolean(new Function('r', `return ${source};`)(ritual));
    }, predicate);
    if (ok) return;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for ${label} (${predicate})`);
}

/** Captures a stage screenshot into the artifacts directory. */
export async function capture(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

/**
 * Advances the simulation by a number of seconds through the real model,
 * then lets a frame render so the screenshot shows the new state.
 */
export async function advanceSeconds(page: Page, seconds: number): Promise<void> {
  await act(page, 'advanceSeconds', seconds);
  await page.waitForTimeout(500);
}

/** Fast-forwards in small slices until a condition holds. */
export async function advanceUntil(
  page: Page,
  predicate: string,
  label: string,
  maxSeconds = 600,
): Promise<void> {
  for (let advanced = 0; advanced < maxSeconds; advanced += 3) {
    const ok = await page.evaluate((source) => {
      const ritual = window.__someMore!.store.state.ritual as unknown as Record<string, unknown>;
      // eslint-disable-next-line no-new-func
      return Boolean(new Function('r', `return ${source};`)(ritual));
    }, predicate);
    if (ok) {
      await page.waitForTimeout(300);
      return;
    }
    await act(page, 'advanceSeconds', 3);
  }
  /*
   * Say what it *did* reach.
   *
   * A timeout that reports only the predicate it wanted sends whoever reads it
   * off guessing, and the fire has a dozen numbers any one of which could be
   * the reason. This is the cheapest possible improvement to every future
   * failure in this file.
   */
  const reached = await page.evaluate(() => {
    const r = window.__someMore!.store.state.ritual as unknown as {
      stage: string;
      fire: { flame: number; emberMass: number; emberTemp: number; ashCover: number; oxygen: number; logs: { grade: string; mass: number }[] };
    };
    return {
      stage: r.stage,
      flame: Number(r.fire.flame.toFixed(3)),
      emberMass: Number(r.fire.emberMass.toFixed(3)),
      emberTemp: Math.round(r.fire.emberTemp),
      ashCover: Number(r.fire.ashCover.toFixed(2)),
      oxygen: Number(r.fire.oxygen.toFixed(2)),
      fuel: r.fire.logs.map((l) => `${l.grade}:${l.mass.toFixed(2)}`),
    };
  });
  throw new Error(
    `Fast-forwarded ${maxSeconds}s without reaching ${label} (${predicate}). Reached ${JSON.stringify(reached)}`,
  );
}

/** Runs the SM-01 through its full ritual, one control at a time. */
export async function runMachine(page: Page, onStage?: (name: string) => Promise<void>): Promise<void> {
  await advanceUntil(page, 'r.machine.door > 0.9', 'door open');
  await act(page, 'machine', { type: 'load' });
  await act(page, 'machine', { type: 'close-door' });
  await advanceUntil(page, "r.machine.stage === 'door-closed'", 'door closed');
  await act(page, 'machine', { type: 'engage-latch' });
  await act(page, 'machine', { type: 'set-program', program: 'standard' });
  await act(page, 'machine', { type: 'confirm' });
  await onStage?.('armed');
  await act(page, 'machine', { type: 'pull-lever' });

  // The run itself is fast-forwarded through the real model. Under a software
  // renderer the fixed-timestep clamp lets simulated time fall behind
  // wall-clock, so waiting in real time would be measuring the renderer, not
  // the machine. Each stage is still rendered and screenshotted at the state
  // the model actually reaches.
  await advanceUntil(page, "r.machine.stage === 'processing'", 'processing');
  await advanceSeconds(page, 6);
  await onStage?.('processing');
  await advanceUntil(page, "r.machine.stage === 'freezing'", 'freezing');
  await advanceSeconds(page, 9);
  await onStage?.('freezing');
  await advanceUntil(page, "r.machine.stage === 'complete'", 'complete');
  await onStage?.('complete');
  await act(page, 'machine', { type: 'release-latch' });
  await act(page, 'machine', { type: 'open-door' });
  await waitForWorld(page, "r.stage === 'reveal'", 'reveal');
}

/* -------------------------------------------------------------------------- */
/* Reading the layout rather than the text                                    */
/* -------------------------------------------------------------------------- */

/**
 * The heads-up channels, by test id.
 *
 * Every one of these is absolutely positioned by percentage, which is a fine
 * way to lay out a HUD and a bad way to find out that two of them overlap:
 * both elements are present, both have the right text, every assertion about
 * them passes, and one is sitting on top of the other. That is exactly how the
 * notice came to cover the reach prompt — 19% against 18%, on a button five
 * percent tall — and it was found by opening a screenshot rather than by any
 * test in the suite.
 */
export const HUD_CHANNELS = [
  'guidance',
  'notice',
  'reach',
  'subtitle',
  'survey',
  'corner-controls',
  'photo-control',
] as const;

export interface HudBox {
  id: string;
  box: { x: number; y: number; width: number; height: number };
}

/**
 * Every HUD channel currently visible, with its box.
 *
 * Off-screen elements are skipped, and that is not a technicality: the
 * machine's state caption is positioned outside the viewport on purpose so a
 * screen reader has a second channel without a caption appearing over the
 * panel it describes. It reports a box at y = -1, and comparing it against
 * anything is meaningless.
 */
export async function hudBoxes(page: Page): Promise<HudBox[]> {
  const size = page.viewportSize() ?? { width: 1280, height: 720 };
  const found: HudBox[] = [];
  for (const id of HUD_CHANNELS) {
    const locator = page.getByTestId(id);
    if ((await locator.count()) === 0) continue;
    const box = await locator.first().boundingBox();
    if (!box || box.width <= 0 || box.height <= 0) continue;
    const onScreen =
      box.x + box.width > 0 && box.y + box.height > 0 && box.x < size.width && box.y < size.height;
    if (onScreen) found.push({ id, box });
  }
  return found;
}

/** Every pair of visible channels that shares pixels. */
export function hudCollisions(boxes: readonly HudBox[]): string[] {
  const hit = (a: HudBox['box'], b: HudBox['box']): boolean =>
    a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;
  const collisions: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i] as HudBox;
      const b = boxes[j] as HudBox;
      if (hit(a.box, b.box)) {
        collisions.push(
          `${a.id} (${Math.round(a.box.x)},${Math.round(a.box.y)} ${Math.round(a.box.width)}x${Math.round(a.box.height)}) ` +
            `over ${b.id} (${Math.round(b.box.x)},${Math.round(b.box.y)} ${Math.round(b.box.width)}x${Math.round(b.box.height)})`,
        );
      }
    }
  }
  return collisions;
}
