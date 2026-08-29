import type { Page } from '@playwright/test';

export const SHOTS = 'artifacts/screenshots';

/** The window handle the client exposes for inspection and testing. */
export interface SomeMoreHandle {
  actions: Record<string, (...args: unknown[]) => unknown>;
  store: { state: Record<string, unknown> };
  environments: readonly { id: string; name: string }[];
  three?: { scene: unknown; camera: unknown };
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
  throw new Error(`Fast-forwarded ${maxSeconds}s without reaching ${label} (${predicate})`);
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
