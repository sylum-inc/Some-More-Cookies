/**
 * `@somemore/sim` — the deterministic simulation core.
 *
 * Pure TypeScript: no DOM, no Three.js, no wall clock, no unseeded randomness
 * (ADR-0001). Renderers, audio and networking read from this package; nothing
 * here reads from them.
 */

export * from './types.js';
export * from './math.js';
export * from './rng.js';
export * from './time.js';
export * from './fire.js';
export * from './heatfield.js';
export * from './roasting.js';
export * from './assembly.js';
export * from './machine.js';
export * from './sandwich.js';
export * from './weather.js';
export * from './astronomy.js';
export * from './locomotion.js';
export * from './activity.js';
export * from './water.js';
export * from './skipping.js';
export * from './torch.js';
export * from './sitting.js';
export * from './stargazing.js';
export * from './fishing.js';
export * from './wildlife.js';
export * from './radio.js';
export * from './discovery.js';
export * from './ritual.js';

// Significance is exported deliberately narrowly: the internal score must
// never reach a renderer or a UI (spec §6.4 — never expose a memory score).
export {
  createEvidence,
  decideTrace,
  createTrace,
  tracePresence,
  activeTraces,
  expiredTraces,
  describeReturn,
  type TraceKind,
  type SignificanceEvidence,
  type TraceDisposition,
  type TraceDecision,
  type Trace,
  type ReturnObservation,
} from './significance.js';
