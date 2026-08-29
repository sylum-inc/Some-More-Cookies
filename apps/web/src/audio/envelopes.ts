/**
 * Envelope maths, split into a pure half (value-at-time, durations) that tests
 * can assert, and a thin applicator half that writes automation onto an
 * `AudioParam`.
 */

import { MIN_GAIN, clamp, clamp01 } from './math.js';

export interface AdsrEnvelope {
  /** Seconds from 0 to peak. */
  attack: number;
  /** Seconds from peak down to `sustain`. */
  decay: number;
  /** Held level, 0..1. */
  sustain: number;
  /** Seconds from the level at release down to 0. */
  release: number;
}

export interface PercussiveEnvelope {
  /** Seconds from 0 to `peak`. */
  attack: number;
  /** Exponential decay time-constant in seconds. */
  decay: number;
  /** Peak linear gain. */
  peak: number;
}

/** Decibels below peak at which we consider an exponential tail finished. */
export const TAIL_FLOOR_DB = 60;

/**
 * Convert "I want it to fall 60 dB in `seconds`" into the time-constant that
 * `setTargetAtTime` expects. exp(-t/tau) = 10^(-60/20) => tau = t / ln(1000).
 */
export function timeConstantForDecay(seconds: number, floorDb = TAIL_FLOOR_DB): number {
  const decades = Math.max(floorDb, 1) / 20;
  return Math.max(seconds, 1e-5) / (decades * Math.LN10);
}

/** How long an exponential tail with this time-constant takes to reach the floor. */
export function tailSeconds(timeConstant: number, floorDb = TAIL_FLOOR_DB): number {
  const decades = Math.max(floorDb, 1) / 20;
  return Math.max(timeConstant, 0) * decades * Math.LN10;
}

export function expDecayValue(peak: number, timeConstant: number, t: number): number {
  if (t <= 0) return peak;
  if (timeConstant <= 0) return 0;
  return peak * Math.exp(-t / timeConstant);
}

/** Linear attack into an exponential tail — the shape of every click, tick and pop here. */
export function percussiveValueAt(env: PercussiveEnvelope, t: number): number {
  if (t <= 0) return 0;
  if (t < env.attack) return env.peak * (t / Math.max(env.attack, 1e-9));
  return expDecayValue(env.peak, env.decay, t - env.attack);
}

/** Total audible length of a percussive hit. */
export function percussiveDuration(env: PercussiveEnvelope, floorDb = TAIL_FLOOR_DB): number {
  return Math.max(env.attack, 0) + tailSeconds(env.decay, floorDb);
}

/**
 * ADSR level at time `t` (seconds since note-on). Pass `releaseAt` to model a
 * key-up; before that moment the envelope behaves as if held.
 */
export function adsrValueAt(env: AdsrEnvelope, t: number, releaseAt?: number): number {
  if (t <= 0) return 0;
  const attack = Math.max(env.attack, 0);
  const decay = Math.max(env.decay, 0);
  const sustain = clamp01(env.sustain);
  const release = Math.max(env.release, 0);

  const heldLevel = (time: number): number => {
    if (time < attack) return attack === 0 ? 1 : time / attack;
    const intoDecay = time - attack;
    if (intoDecay < decay) return 1 + (sustain - 1) * (intoDecay / decay);
    return sustain;
  };

  if (releaseAt === undefined || t < releaseAt) return clamp01(heldLevel(t));

  const levelAtRelease = clamp01(heldLevel(releaseAt));
  if (release === 0) return 0;
  const intoRelease = (t - releaseAt) / release;
  return clamp01(levelAtRelease * (1 - intoRelease));
}

export function adsrDuration(env: AdsrEnvelope, holdSeconds: number): number {
  return Math.max(holdSeconds, 0) + Math.max(env.release, 0);
}

/**
 * Reduced-audio-intensity shaping. Sudden loud transients are the accessibility
 * problem (startle, pain, misophonia), so we cut the peak and stretch the
 * attack rather than simply turning everything down.
 */
export interface IntensityShaping {
  /** Multiplier applied to transient peaks. */
  peakScale: number;
  /** Multiplier applied to attack times (slower = less startling). */
  attackScale: number;
  /** Hard ceiling on any one-shot's linear peak gain. */
  ceiling: number;
}

export const FULL_INTENSITY: IntensityShaping = { peakScale: 1, attackScale: 1, ceiling: 1 };
export const REDUCED_INTENSITY: IntensityShaping = { peakScale: 0.55, attackScale: 3.5, ceiling: 0.4 };

export function shapingFor(reduced: boolean): IntensityShaping {
  return reduced ? REDUCED_INTENSITY : FULL_INTENSITY;
}

/** Apply intensity shaping to a percussive envelope. Returns a new envelope. */
export function shapePercussive(env: PercussiveEnvelope, shaping: IntensityShaping): PercussiveEnvelope {
  return {
    attack: env.attack * shaping.attackScale,
    decay: env.decay,
    peak: Math.min(env.peak * shaping.peakScale, shaping.ceiling),
  };
}

/** Minimal structural view of the bits of `AudioParam` the engine writes. */
export interface AutomatableParam {
  value: number;
  setValueAtTime(value: number, startTime: number): unknown;
  linearRampToValueAtTime(value: number, endTime: number): unknown;
  exponentialRampToValueAtTime(value: number, endTime: number): unknown;
  setTargetAtTime(target: number, startTime: number, timeConstant: number): unknown;
  cancelScheduledValues(startTime: number): unknown;
}

/**
 * Schedule a percussive envelope onto a gain param starting at `startTime`.
 * Uses a linear attack (safe from zero) and `setTargetAtTime` for the tail,
 * then a final `setValueAtTime(0)` so the param is provably silent and the
 * voice can be recycled.
 *
 * Returns the absolute time at which the voice is finished.
 */
export function applyPercussive(
  param: AutomatableParam,
  startTime: number,
  env: PercussiveEnvelope,
  floorDb = TAIL_FLOOR_DB,
): number {
  const attack = Math.max(env.attack, 1e-4);
  const peak = Math.max(env.peak, MIN_GAIN);
  const endTime = startTime + percussiveDuration({ ...env, attack }, floorDb);
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(0, startTime);
  param.linearRampToValueAtTime(peak, startTime + attack);
  param.setTargetAtTime(0, startTime + attack, Math.max(env.decay, 1e-4));
  param.setValueAtTime(0, endTime);
  return endTime;
}

/**
 * Schedule an ADSR attack/decay/sustain from `startTime`. Release is scheduled
 * separately by `applyRelease` so held sounds (fan, compressor) can end when
 * the simulation says so.
 */
export function applyAttackHold(
  param: AutomatableParam,
  startTime: number,
  env: AdsrEnvelope,
  peak: number,
): void {
  const level = Math.max(peak, MIN_GAIN);
  const sustainLevel = Math.max(level * clamp01(env.sustain), MIN_GAIN);
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(MIN_GAIN, startTime);
  param.exponentialRampToValueAtTime(level, startTime + Math.max(env.attack, 1e-3));
  param.exponentialRampToValueAtTime(
    sustainLevel,
    startTime + Math.max(env.attack, 1e-3) + Math.max(env.decay, 1e-3),
  );
}

/** Ramp a held voice down to silence; returns the time it is finished. */
export function applyRelease(param: AutomatableParam, startTime: number, releaseSeconds: number): number {
  const end = startTime + Math.max(releaseSeconds, 1e-3);
  param.cancelScheduledValues(startTime);
  param.setValueAtTime(Math.max(param.value, MIN_GAIN), startTime);
  param.exponentialRampToValueAtTime(MIN_GAIN, end);
  param.setValueAtTime(0, end);
  return end;
}

/** Smoothly steer a continuously-modulated param without zipper noise. */
export function glideTo(
  param: AutomatableParam,
  target: number,
  now: number,
  smoothingSeconds: number,
): void {
  param.setTargetAtTime(target, now, Math.max(smoothingSeconds, 1e-3));
}

/** Clamp a mapped control into a sane audio band before it reaches a filter. */
export function safeFrequency(hz: number, sampleRate = 48000): number {
  return clamp(hz, 10, sampleRate * 0.45);
}
