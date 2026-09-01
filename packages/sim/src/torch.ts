/**
 * The flashlight (spec §5.2, §7).
 *
 * This is not a lighting effect with a switch. It is a mechanic, and the
 * mechanic is a trade:
 *
 * > `PresenceInput.lightSweep` feeds the wildlife model's `flashlight` cue,
 * > and several species are repelled by it. Finding something with the torch
 * > and scaring it off with the same torch is the trade.
 *
 * So the two things that matter are both physical: **where the beam is
 * pointing** (which decides what you can see, through {@link illumination})
 * and **how much it is moving** (which decides how much the animals mind,
 * through {@link torchCue}). A beam held steady on a fox is a much smaller
 * intrusion than one raked across the treeline, and holding still is exactly
 * what the rest of the world already rewards.
 *
 * Note what is deliberately absent: **there is no battery.** A torch that runs
 * down is an obligation, and no secondary activity generates obligation
 * (§5.2). Nothing here can be exhausted, and there is no field on any shape
 * where a charge level could be added quietly.
 */

import { angleDelta, approach, clamp, clamp01, lerp, smoothstep } from './math.js';
import { SIM_DT, type Vec3 } from './types.js';

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

/** Beam shape, wide-flood to tight-spot. Twisting the head is the only control. */
export const TORCH_BEAM = {
  /** Cone half-angle when flooded, radians (~32°). */
  floodAngle: 0.56,
  /** Cone half-angle when focused, radians (~8°). */
  spotAngle: 0.14,
  /** Useful reach when flooded, metres. */
  floodRangeM: 7,
  /** Useful reach when focused, metres. */
  spotRangeM: 21,
} as const;

/** Angular speed at which the beam counts as being swept about, rad/s. */
const SWEEP_FULL = 2.1;
const SWEEP_START = 0.18;

/**
 * How far back the beam's speed is measured over, in seconds.
 *
 * The aim reaches the model as a series of reports, and on a slow renderer
 * those reports are a staircase: drag-to-look is applied in the first fixed
 * step of a frame and spent (`locomotion.ts`), so a smooth quarter-turn on a
 * phone drawing fifteen frames a second arrives as one big jump followed by
 * three steps of nothing. Measured one step at a time, that read as a beam
 * that was mostly still — the wildlife minded a raked torch less the slower
 * the machine drawing it. Measured over the last third of a second, the same
 * turn is the same speed however it was chopped up. An animal's sense of
 * "that light is moving" is not sixteen milliseconds long either.
 */
const SWEEP_WINDOW_SECONDS = 0.3;
const SWEEP_WINDOW_STEPS = Math.round(SWEEP_WINDOW_SECONDS / SIM_DT);

/** Seconds of a held beam before it reads as *held* rather than passing over. */
const STEADY_FULL_SECONDS = 2.4;

export interface TorchState {
  /** Whether it has been picked up at all. Nothing works until it has. */
  held: boolean;
  on: boolean;
  /** Where the beam points, radians. Yaw 0 looks along +X, as elsewhere. */
  yaw: number;
  pitch: number;
  /** 0 = flooded, 1 = focused. */
  focus: number;
  /** Cone half-angle, radians. Derived from focus. */
  beamAngle: number;
  /** Useful reach, metres. Derived from focus. */
  rangeM: number;
  /** 0..1 how much the beam is being moved right now. */
  sweep: number;
  /** Seconds the beam has been held on one place. Resets when it moves. */
  steadySeconds: number;
  /** Angular speed of the beam over the last {@link SWEEP_WINDOW_SECONDS}, rad/s. */
  slewRate: number;
  /**
   * Radians the beam has been aimed through since the last step, so the slew
   * rate is measured from the aim it was given, never trusted from outside.
   */
  pendingMove: number;
  /** Per-step angular speeds over the window, a ring; `recentIndex` is next. */
  recentRates: number[];
  recentIndex: number;
  elapsed: number;
}

export function createTorch(): TorchState {
  return {
    held: false,
    on: false,
    yaw: 0,
    pitch: -0.1,
    focus: 0.35,
    beamAngle: lerp(TORCH_BEAM.floodAngle, TORCH_BEAM.spotAngle, 0.35),
    rangeM: lerp(TORCH_BEAM.floodRangeM, TORCH_BEAM.spotRangeM, 0.35),
    sweep: 0,
    steadySeconds: 0,
    slewRate: 0,
    pendingMove: 0,
    recentRates: new Array<number>(SWEEP_WINDOW_STEPS).fill(0),
    recentIndex: 0,
    elapsed: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                    */
/* -------------------------------------------------------------------------- */

/** Picks it up off the log. It comes on, because nobody picks up a dead torch. */
export function takeTorch(torch: TorchState): void {
  torch.held = true;
  torch.on = true;
}

/** Puts it back down. */
export function stowTorch(torch: TorchState): void {
  torch.held = false;
  torch.on = false;
  torch.sweep = 0;
  torch.steadySeconds = 0;
}

/** The switch. Returns the new state. */
export function switchTorch(torch: TorchState, on?: boolean): boolean {
  if (!torch.held) return false;
  torch.on = on ?? !torch.on;
  if (!torch.on) {
    torch.sweep = 0;
    torch.steadySeconds = 0;
  }
  return torch.on;
}

/** Twists the head. 0 floods, 1 focuses to a spot that reaches the treeline. */
export function focusTorch(torch: TorchState, focus: number): void {
  torch.focus = clamp01(focus);
  torch.beamAngle = lerp(TORCH_BEAM.floodAngle, TORCH_BEAM.spotAngle, torch.focus);
  torch.rangeM = lerp(TORCH_BEAM.floodRangeM, TORCH_BEAM.spotRangeM, torch.focus);
}

/**
 * Points the beam.
 *
 * Absolute, because the beam is attached to a hand attached to a player whose
 * facing the client already owns. The *rate* of change is what the model cares
 * about, and it is measured here rather than trusted from outside — which is
 * what stops the light sweep being faked (the client used to derive it from
 * walking speed, which meant walking about with the torch off still frightened
 * the wildlife).
 */
export function aimTorch(torch: TorchState, yaw: number, pitch: number): void {
  const nextPitch = clamp(pitch, -1.35, 1.35);
  torch.pendingMove += Math.hypot(angleDelta(torch.yaw, yaw), nextPitch - torch.pitch);
  torch.yaw = yaw;
  torch.pitch = nextPitch;
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Advances the torch one fixed timestep.
 *
 * Deterministic and clock-free: the sweep is measured from how far the aim
 * moved, averaged over the last {@link SWEEP_WINDOW_SECONDS} of steps, so a
 * replay of the same aim timeline produces the same disturbance and therefore
 * the same wildlife (ADR-0006).
 */
export function stepTorch(torch: TorchState, dt: number): void {
  torch.elapsed += dt;

  torch.recentRates[torch.recentIndex] = dt > 0 ? torch.pendingMove / dt : 0;
  torch.recentIndex = (torch.recentIndex + 1) % torch.recentRates.length;
  torch.pendingMove = 0;
  let total = 0;
  for (const rate of torch.recentRates) total += rate;
  torch.slewRate = total / torch.recentRates.length;

  if (!torch.on) {
    torch.sweep = approach(torch.sweep, 0, 6, dt);
    torch.steadySeconds = 0;
    return;
  }

  const target = smoothstep(SWEEP_START, SWEEP_FULL, torch.slewRate);
  // Rises immediately and falls off over about a second: an animal that has
  // just been swept over does not relax the instant the beam stops.
  torch.sweep = clamp01(approach(torch.sweep, target, target > torch.sweep ? 12 : 1.1, dt));

  if (torch.slewRate < SWEEP_START) {
    torch.steadySeconds += dt;
  } else {
    torch.steadySeconds = 0;
  }
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How much light lands on a point, 0..1.
 *
 * Cone plus inverse-ish falloff plus a soft edge, which is what a torch beam
 * actually looks like. A focused beam reaches three times as far and lights a
 * much smaller circle, so finding something at the treeline is a real act of
 * aiming rather than a radius check.
 */
export function illumination(torch: TorchState, from: Vec3, target: Vec3): number {
  if (!torch.on || !torch.held) return 0;
  const dx = target.x - from.x;
  const dy = target.y - from.y;
  const dz = target.z - from.z;
  const distance = Math.hypot(dx, dy, dz);
  if (distance < 1e-4) return 1;
  if (distance > torch.rangeM) return 0;

  const cosPitch = Math.cos(torch.pitch);
  const bx = Math.cos(torch.yaw) * cosPitch;
  const by = Math.sin(torch.pitch);
  const bz = Math.sin(torch.yaw) * cosPitch;
  const cosAngle = (dx * bx + dy * by + dz * bz) / distance;
  if (cosAngle <= 0) return 0;

  const angle = Math.acos(clamp(cosAngle, -1, 1));
  // Soft edge: the beam has a hot centre and a penumbra, not a hard circle.
  const cone = 1 - smoothstep(torch.beamAngle * 0.55, torch.beamAngle, angle);
  if (cone <= 0) return 0;
  const falloff = 1 - smoothstep(torch.rangeM * 0.45, torch.rangeM, distance);
  return clamp01(cone * falloff);
}

/**
 * The `flashlight` cue this torch is producing, 0..1.
 *
 * A lit torch is never zero — light in a dark camp is light — but a *swept*
 * one is far worse, which is the whole trade. Species with `flashlight` in
 * `repelledBy` read this through `worldCues`, and repulsion in the wildlife
 * model is worst-case rather than averaged, so sweeping the treeline really
 * does empty it.
 */
export function torchCue(torch: TorchState): number {
  if (!torch.held || !torch.on) return 0;
  return clamp01(0.26 + torch.sweep * 0.74);
}

/**
 * 0..1 how much the beam is being held on one spot.
 *
 * The counterpart to {@link torchCue}: this is what makes patient use of the
 * torch different from raking it about, and it is what the renderer uses to
 * let eyeshine resolve into an animal.
 */
export function torchSteadiness(torch: TorchState): number {
  if (!torch.held || !torch.on) return 0;
  return smoothstep(0, STEADY_FULL_SECONDS, torch.steadySeconds);
}

/** A short line for the subtitle layer. Audible/visible parity (§12). */
export function describeTorch(torch: TorchState): string {
  if (!torch.held) return '';
  if (!torch.on) return '[the torch is off]';
  return torch.focus > 0.6 ? '[a narrow beam, out to the trees]' : '[a wide beam, close in]';
}
