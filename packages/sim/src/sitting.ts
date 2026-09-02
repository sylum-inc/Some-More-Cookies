/**
 * Sitting down (spec §5.1, §5.2, §7).
 *
 * "Arriving early to explore and staying after to sit by the fire are both
 * first-class." This is the model that makes the second half of that true.
 *
 * `PlayerState.seated` already existed and did almost nothing: it stopped the
 * player walking and lowered the camera. But stillness is a *mechanic* — the
 * wildlife model gates rarer species on `calm`, and the discovery model gates
 * quiet secrets on `stillnessSeconds` — and standing perfectly still is a
 * thing a player has to *keep doing*, which is not the same experience as
 * sitting down.
 *
 * So sitting is modelled as **settling**, which is a real, slow, physical
 * thing:
 *
 * - Sitting down does not immediately make you still. You shift, you get
 *   comfortable, and the camp goes back to what it was doing. `settled` builds
 *   over about half a minute.
 * - Once settled, stillness accrues far faster than standing (§7's "quiet
 *   behaviour reveals rarer wildlife" — this is the strongest way to do it),
 *   and the place's own disturbance decays faster.
 * - Standing up costs all of it at once. Not as a punishment — that is simply
 *   what happens when you stand up at 2am with a fox forty feet away.
 *
 * Nothing here is scored, banked or spent. `settled` is a state of the world,
 * not a resource: it cannot be saved, carried between visits, or exchanged for
 * anything, and there is nowhere on these shapes to put such a thing.
 */

import { approach, clamp01, lerp, smoothstep } from './math.js';

/** Seconds of continuous sitting before you are fully settled. */
export const SETTLE_SECONDS = 34;

/**
 * The most stillness a fully settled sitter accrues, as a multiple of what a
 * player standing motionless accrues.
 *
 * 2.6 was chosen against the wildlife model's own numbers, not picked: `calm`
 * is complete at 150 s of stillness, so standing takes two and a half minutes
 * of not moving a muscle, and sitting takes a little under a minute of
 * actually sitting there. The first is an endurance test and the second is an
 * evening by a fire.
 */
export const SEATED_STILLNESS_GAIN = 2.6;

export interface SeatState {
  seated: boolean;
  /** Which seat, so the renderer and the audio bed know where you are. */
  seatId: string | null;
  /** Seconds continuously seated. Zero the instant you stand. */
  seatedSeconds: number;
  /** 0..1 how deeply settled. Builds while seated, lost on standing. */
  settled: number;
  /** Seconds spent seated in total this session. For the significance model. */
  totalSeatedSeconds: number;
  elapsed: number;
}

export function createSeat(): SeatState {
  return {
    seated: false,
    seatId: null,
    seatedSeconds: 0,
    settled: 0,
    totalSeatedSeconds: 0,
    elapsed: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                    */
/* -------------------------------------------------------------------------- */

/** Sits down on a named seat. Idempotent: sitting while seated changes nothing. */
export function sitDown(seat: SeatState, seatId: string | null = 'log-seat'): void {
  if (seat.seated && seat.seatId === seatId) return;
  seat.seated = true;
  seat.seatId = seatId;
  seat.seatedSeconds = 0;
  // Getting up and moving along the log costs the settling, same as standing.
  seat.settled = 0;
}

/**
 * Stands up.
 *
 * The settling goes immediately. This is the one sharp edge in the model and
 * it is the right one: it is why "just sit there" is a real thing to choose,
 * rather than something you toggle on and wander off from.
 */
export function standUp(seat: SeatState): void {
  if (!seat.seated) return;
  seat.seated = false;
  seat.seatId = null;
  seat.seatedSeconds = 0;
  seat.settled = 0;
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Advances the seat one fixed timestep.
 *
 * `disturbance` is the world's own, 0..1 — the same signal the wildlife model
 * keeps. Somebody sitting through a compressor cycle with the radio on is not
 * settling, and this is where that is true.
 */
export function stepSeat(seat: SeatState, dt: number, disturbance = 0): void {
  seat.elapsed += dt;
  if (!seat.seated) {
    seat.settled = approach(seat.settled, 0, 4, dt);
    return;
  }

  seat.seatedSeconds += dt;
  seat.totalSeatedSeconds += dt;

  // A racket in the camp stops you settling, and undoes some of it.
  const quiet = clamp01(1 - clamp01(disturbance) * 1.4);
  const target = smoothstep(0, SETTLE_SECONDS, seat.seatedSeconds) * quiet;
  seat.settled = clamp01(approach(seat.settled, target, target > seat.settled ? 0.1 : 0.6, dt));
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The multiplier on how fast stillness accrues, ≥ 1.
 *
 * Read by the wildlife model through `WildlifeInput.stillnessRate`. Standing
 * still is 1 — sitting never makes standing worse, it only makes sitting
 * better, which is the difference between an assist and a penalty.
 */
export function stillnessGain(seat: SeatState): number {
  return lerp(1, SEATED_STILLNESS_GAIN, clamp01(seat.settled));
}

/**
 * How much faster the camp's own disturbance decays around a settled sitter,
 * as a multiplier ≥ 1.
 *
 * A place settles around somebody who has stopped moving. This is why a fox
 * that was scared off by the walk in comes back for someone who sat down.
 */
export function settlingGain(seat: SeatState): number {
  return lerp(1, 2.2, clamp01(seat.settled));
}

/**
 * A quiet, non-numeric line for the subtitle layer.
 *
 * Never a meter, never a percentage — the player experiences settling as the
 * camp getting quieter around them, not as a bar filling up (§6.4's rule about
 * invisible models, applied to the same instinct).
 */
export function describeSeat(seat: SeatState): string {
  if (!seat.seated) return '';
  if (seat.settled < 0.2) return '';
  if (seat.settled < 0.7) return '[the camp goes quiet]';
  return '[somewhere out past the light, something moves]';
}
