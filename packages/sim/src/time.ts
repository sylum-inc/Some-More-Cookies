/**
 * Fixed-timestep clock.
 *
 * Everything in `packages/sim` advances in `SIM_DT` increments, decoupled from
 * render framerate. Determinism depends on this: a variable timestep would
 * make two clients diverge, which would break both multiplayer reconciliation
 * and server-side sandwich verification (ADR-0006).
 */

import { SIM_DT } from './types.js';

export interface FixedClock {
  /** Unconsumed real time, seconds. */
  accumulator: number;
  /** Total simulated seconds. */
  simulatedTime: number;
  /** Steps taken on the most recent advance. */
  stepsLastFrame: number;
  /** Total steps taken. */
  totalSteps: number;
  /** 0..1 position between the last two steps, for render interpolation. */
  alpha: number;
}

export function createClock(): FixedClock {
  return { accumulator: 0, simulatedTime: 0, stepsLastFrame: 0, totalSteps: 0, alpha: 0 };
}

/**
 * Maximum real time consumed in one advance. Prevents the spiral of death
 * where a long frame schedules more steps than the next frame can afford.
 * A tab restored after a minute in the background should resume, not freeze
 * while it simulates the minute it missed.
 */
export const MAX_CATCH_UP_SECONDS = 0.25;

/**
 * Advances the clock and invokes `step` the appropriate number of times.
 * Returns the number of steps taken.
 */
export function advance(clock: FixedClock, realDeltaSeconds: number, step: (dt: number) => void): number {
  const delta = Math.min(Math.max(0, realDeltaSeconds), MAX_CATCH_UP_SECONDS);
  clock.accumulator += delta;
  let steps = 0;
  while (clock.accumulator >= SIM_DT) {
    step(SIM_DT);
    clock.accumulator -= SIM_DT;
    clock.simulatedTime += SIM_DT;
    steps++;
    clock.totalSteps++;
    // Hard ceiling: never spend more than this many steps in one frame.
    if (steps >= 16) {
      clock.accumulator = 0;
      break;
    }
  }
  clock.stepsLastFrame = steps;
  clock.alpha = clock.accumulator / SIM_DT;
  return steps;
}

export { SIM_DT };
