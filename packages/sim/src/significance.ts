/**
 * The invisible significance model (spec §6.4).
 *
 * Campsites remember meaningful history, most traces fade, important memories
 * survive in the Passport, and a tiny number of especially meaningful moments
 * become permanent landmarks.
 *
 * The hard rule: **never expose a memory score.** No numbers, no percentage,
 * no UI. Players should only ever experience this as *the world remembered
 * the right things*. Everything here is therefore internal, and the public
 * surface returns decisions ("keep", "fade", "landmark"), never values.
 */

import { clamp01, smoothstep } from './math.js';

export type TraceKind =
  | 'moved-object'
  | 'photo'
  | 'discovery'
  | 'note'
  | 'machine-run'
  | 'wildlife-encounter'
  | 'environmental'
  | 'sandwich'
  | 'visitor'
  | 'world-event';

/** The raw evidence the model weighs. All of it is behaviour, not opinion. */
export interface SignificanceEvidence {
  kind: TraceKind;
  /** How unusual this thing is, 0..1 (a rare wildlife visit scores high). */
  rarity: number;
  /** True when this is the first of its kind for this player. */
  isFirst: boolean;
  /** How many times the player has returned to or interacted with it. */
  interactionCount: number;
  /** Whether the player photographed it — a strong signal of caring. */
  photographed: boolean;
  /** Whether it happened while friends were present. */
  social: boolean;
  /** Whether it coincided with a world event (meteor shower, storm). */
  duringWorldEvent: boolean;
  /** Whether the player explicitly asked to keep it. Always decisive. */
  explicitlyPreserved: boolean;
  /** Seconds the player spent near/with it. */
  dwellSeconds: number;
}

export function createEvidence(kind: TraceKind, overrides: Partial<SignificanceEvidence> = {}): SignificanceEvidence {
  return {
    kind,
    rarity: 0.2,
    isFirst: false,
    interactionCount: 1,
    photographed: false,
    social: false,
    duringWorldEvent: false,
    explicitlyPreserved: false,
    dwellSeconds: 0,
    ...overrides,
  };
}

/**
 * Internal score. Deliberately **not exported** from the package index — the
 * only way out of this module is a `TraceDecision`, so no UI can accidentally
 * render a number.
 */
function score(evidence: SignificanceEvidence): number {
  if (evidence.explicitlyPreserved) return 1;

  const rarity = clamp01(evidence.rarity) * 0.28;
  const first = evidence.isFirst ? 0.22 : 0;
  // Repeated returns matter, with diminishing returns — visiting something
  // twice says far more than the tenth visit does.
  const repetition = smoothstep(1, 8, evidence.interactionCount) * 0.16;
  const photo = evidence.photographed ? 0.16 : 0;
  const social = evidence.social ? 0.12 : 0;
  const worldEvent = evidence.duringWorldEvent ? 0.1 : 0;
  const dwell = smoothstep(5, 90, evidence.dwellSeconds) * 0.1;

  // Some kinds carry inherent weight: a sandwich is the point of the product,
  // and a note is something a person chose to write.
  const kindWeight: Record<TraceKind, number> = {
    sandwich: 0.16,
    note: 0.14,
    photo: 0.12,
    discovery: 0.12,
    'wildlife-encounter': 0.08,
    'world-event': 0.1,
    'machine-run': 0.04,
    'moved-object': 0.02,
    environmental: 0,
    visitor: 0.06,
  };

  return clamp01(rarity + first + repetition + photo + social + worldEvent + dwell + kindWeight[evidence.kind]);
}

export type TraceDisposition = 'fade' | 'keep' | 'passport' | 'landmark';

export interface TraceDecision {
  disposition: TraceDisposition;
  /**
   * Seconds until this trace is fully faded. `Infinity` for landmarks.
   * Exposed because persistence needs it; it is a *duration*, not a score,
   * and is never shown to the player.
   */
  lifetimeSeconds: number;
}

const DAY = 86400;

/**
 * Decides what happens to a trace.
 *
 * The thresholds are deliberately steep at the top: landmarks must be rare
 * enough that a campsite accumulating history for years still feels like a
 * campsite rather than a museum.
 */
export function decideTrace(evidence: SignificanceEvidence): TraceDecision {
  const value = score(evidence);

  if (evidence.explicitlyPreserved || value >= 0.92) {
    return { disposition: 'landmark', lifetimeSeconds: Infinity };
  }
  if (value >= 0.62) {
    // Survives in the Passport even after the world forgets it.
    return { disposition: 'passport', lifetimeSeconds: 90 * DAY };
  }
  if (value >= 0.32) {
    return { disposition: 'keep', lifetimeSeconds: 14 * DAY };
  }
  return { disposition: 'fade', lifetimeSeconds: 2 * DAY };
}

export interface Trace {
  readonly id: string;
  readonly kind: TraceKind;
  /** Epoch milliseconds. */
  readonly createdAt: number;
  readonly lifetimeSeconds: number;
  readonly disposition: TraceDisposition;
  /** Free-form payload, interpreted by whichever system created it. */
  readonly payload: Readonly<Record<string, unknown>>;
}

export function createTrace(
  id: string,
  evidence: SignificanceEvidence,
  createdAt: number,
  payload: Record<string, unknown> = {},
): Trace {
  const decision = decideTrace(evidence);
  return {
    id,
    kind: evidence.kind,
    createdAt,
    lifetimeSeconds: decision.lifetimeSeconds,
    disposition: decision.disposition,
    payload,
  };
}

/**
 * How present a trace still is, 0..1.
 *
 * Fading is gentle and never punishing: a trace at 0.3 is a faint mark in the
 * grass, not a broken thing needing repair (spec §6.3).
 */
export function tracePresence(trace: Trace, now: number): number {
  if (!Number.isFinite(trace.lifetimeSeconds)) return 1;
  const ageSeconds = (now - trace.createdAt) / 1000;
  if (ageSeconds <= 0) return 1;
  // Holds full strength for the first 20% of its life, then eases out.
  const t = ageSeconds / trace.lifetimeSeconds;
  return clamp01(1 - smoothstep(0.2, 1, t));
}

/** Traces that have fully faded, for the world-state cleanup job. */
export function expiredTraces(traces: readonly Trace[], now: number): Trace[] {
  return traces.filter((trace) => tracePresence(trace, now) <= 0.001);
}

/** Traces still worth rendering, strongest first. */
export function activeTraces(traces: readonly Trace[], now: number, limit = 64): Trace[] {
  return traces
    .map((trace) => ({ trace, presence: tracePresence(trace, now) }))
    .filter((entry) => entry.presence > 0.001)
    .sort((a, b) => b.presence - a.presence)
    .slice(0, limit)
    .map((entry) => entry.trace);
}

/**
 * What the world shows a returning player (spec §6.3).
 *
 * Never punishing: everything here is a warm observation, not a chore.
 */
export interface ReturnObservation {
  readonly id: string;
  readonly line: string;
}

export function describeReturn(
  secondsAway: number,
  traces: readonly Trace[],
  now: number,
): ReturnObservation[] {
  const observations: ReturnObservation[] = [];
  const hours = secondsAway / 3600;

  if (hours > 8) observations.push({ id: 'fire-out', line: 'The fire has gone out. The coals are cold.' });
  else if (hours > 1) observations.push({ id: 'fire-low', line: 'The fire has burned down to coals.' });

  if (hours > 24) observations.push({ id: 'leaves', line: 'Leaves have collected against the log.' });
  if (hours > 72) observations.push({ id: 'tracks', line: 'Something small crossed the clearing while you were gone.' });

  const landmarks = traces.filter((t) => t.disposition === 'landmark');
  if (landmarks.length > 0) {
    observations.push({ id: 'landmark', line: 'Everything you left on purpose is still here.' });
  }

  const faded = traces.filter((t) => {
    const presence = tracePresence(t, now);
    return presence > 0 && presence < 0.35;
  });
  if (faded.length > 2) {
    observations.push({ id: 'fading', line: 'Some of your marks have started to soften.' });
  }

  return observations;
}
