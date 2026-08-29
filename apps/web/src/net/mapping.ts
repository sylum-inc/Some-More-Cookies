/**
 * Translating the simulation's language into the wire contract.
 *
 * The client and the service were built from the same specification but
 * without a seam between them, and they did not end up speaking quite the
 * same language. The clearest example is the machine's programs: the dial in
 * the world reads STANDARD / SOFT SET / DEEP FREEZE, while the wire contract
 * enumerates `classic` / `slow_set` / `quick_freeze` and two more. Neither is
 * wrong — one is the product's language and one is the API's — but something
 * has to reconcile them, and doing it in one explicit, tested table is far
 * safer than letting each call site guess.
 *
 * Everything here is pure so the mapping can be asserted without a network.
 */

import type { SandwichRecord } from '@somemore/sim';
import {
  AssemblyQualitySchema,
  MachineRunSchema,
  RoastTelemetrySummarySchema,
  SCHEMA_VERSION,
  type AssemblyQuality,
  type MachineProgram as WireProgram,
  type MachineRun,
  type RoastGrade,
  type RoastTelemetrySummary,
} from '@somemore/protocol';

/**
 * The dial positions, as the machine and the wire each name them.
 *
 * `deep-freeze` maps to `quick_freeze` rather than `slow_set` because the
 * program's *behaviour* is a harder, colder run — the wire name reads
 * backwards, but the semantics line up.
 */
export const PROGRAM_TO_WIRE: Readonly<Record<'soft-set' | 'standard' | 'deep-freeze', WireProgram>> = {
  standard: 'classic',
  'soft-set': 'slow_set',
  'deep-freeze': 'quick_freeze',
};

export function wireProgram(program: string): WireProgram {
  return PROGRAM_TO_WIRE[program as keyof typeof PROGRAM_TO_WIRE] ?? 'classic';
}

/**
 * The roast's descriptive class, as a wire grade.
 *
 * The simulation deliberately refuses to rank a roast (spec §4.5 — outcomes
 * are described, never scored), so this is a *description*, not a judgement:
 * it reports how far the browning went, and the server does its own scoring.
 */
export function roastGrade(brown: number, char: number, flameSeconds: number): RoastGrade {
  if (char > 0.72 || flameSeconds > 12) return 'cremated';
  if (char > 0.32) return 'charred';
  if (brown > 0.68) return 'toasted';
  if (brown > 0.32) return 'golden';
  if (brown > 0.08) return 'pale';
  return 'raw';
}

export function toRoastTelemetry(sandwich: SandwichRecord, minimumDistanceCm: number): RoastTelemetrySummary {
  const roast = sandwich.roast;
  return RoastTelemetrySummarySchema.parse({
    durationMs: Math.round(roast.seconds * 1000),
    // The simulation records distance in metres; the wire wants centimetres.
    averageDistanceCm: clamp((minimumDistanceCm + 30) / 2, 0, 200),
    minimumDistanceCm: clamp(minimumDistanceCm, 0, 200),
    rotations: clamp(roast.rotationTravel / (Math.PI * 2), 0, 1000),
    evenness: unit(roast.evenness),
    peakSurfaceTempC: clamp(roast.peakTempC, 0, 600),
    charFraction: unit(roast.char),
    meltFraction: unit(roast.melt / 2),
    ignited: roast.ignitionCount > 0,
    flareUps: Math.min(100, roast.ignitionCount),
    blownOut: roast.ignitionCount > 0 && roast.flameSeconds < 12,
    dropped: roast.fallen,
    grade: roastGrade(roast.brown, roast.char, roast.flameSeconds),
    simVersion: SCHEMA_VERSION,
  });
}

export function toAssemblyQuality(sandwich: SandwichRecord): AssemblyQuality {
  const assembly = sandwich.assembly;
  // Named from the wire contract's own vocabulary rather than invented here —
  // the last time these were guessed, the server rejected the record.
  const defects: AssemblyQuality['defects'] = [];
  if (assembly.tidiness < 0.35) defects.push('crooked_stack');
  if (assembly.crumbs > 0.6) defects.push('cracked_graham');
  if (assembly.squish > 0.75) defects.push('squeeze_out');
  if (sandwich.roast.peakTempC < 90) defects.push('cold_center');
  return AssemblyQualitySchema.parse({
    // Misalignment is metres of offset; alignment is its inverse, normalised
    // against the point where a stack visibly leans.
    alignment: unit(1 - assembly.misalignment / 0.05),
    chocolateCoverage: unit(1 - assembly.smear * 0.4),
    grahamIntegrity: unit(1 - assembly.crumbs * 0.6),
    squish: unit(assembly.squish),
    heatTransfer: unit(assembly.squish * 0.6 + assembly.smear * 0.4),
    layerOrderCorrect: true,
    assembledInSeconds: clamp(assembly.seconds, 0, 3600),
    defects: defects.slice(0, 8),
    score: unit(assembly.tidiness),
  });
}

export function toMachineRun(sandwich: SandwichRecord, runId: string, startedAt: Date): MachineRun {
  const machine = sandwich.machine;
  const completed = new Date(startedAt.getTime() + machine.durationSeconds * 1000);
  return MachineRunSchema.parse({
    runId,
    machineSerial: machine.serial,
    program: wireProgram(machine.program),
    startedAt: startedAt.toISOString(),
    completedAt: completed.toISOString(),
    chillSeconds: clamp(machine.durationSeconds, 0, 3600),
    // The simulation does not model press force or churn speed; these are
    // derived from the program's firmness so the record stays coherent
    // rather than inventing precision it does not have.
    pressForceN: clamp(180 + machine.firmness * 220, 0, 5000),
    churnRpm: clamp(90 + machine.firmness * 60, 0, 600),
    coreTempC: clamp(machine.minChamberTempC, -40, 80),
    outcome: 'success',
    anomalies: [],
    quirkCodesApplied: machine.quirkIds.slice(0, 16),
    // The unit's firmware. The simulation does not model revisions yet, so
    // every unit reports the shipping build rather than inventing a version
    // the machine could not tell you.
    firmwareVersion: SCHEMA_VERSION,
    wearDelta: {
      drum: wear(machine.durationSeconds, 0.00004),
      press: wear(machine.durationSeconds, 0.00003),
      chiller: wear(machine.durationSeconds, 0.00006),
      dispenser: wear(machine.durationSeconds, 0.00002),
      hopper: wear(machine.durationSeconds, 0.00001),
      belt: wear(machine.durationSeconds, 0.00002),
    },
  });
}

/** The full create-sandwich body, ready to post. */
export function toCreateSandwichRequest(options: {
  sandwich: SandwichRecord;
  campsiteId: string;
  runId: string;
  startedAt: Date;
  minimumDistanceCm: number;
  idempotencyKey: string;
  sessionId?: string;
}): Record<string, unknown> {
  return {
    idempotencyKey: options.idempotencyKey,
    campsiteId: options.campsiteId,
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    roast: toRoastTelemetry(options.sandwich, options.minimumDistanceCm),
    assembly: toAssemblyQuality(options.sandwich),
    machineRun: toMachineRun(options.sandwich, options.runId, options.startedAt),
  };
}

function unit(value: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

function wear(seconds: number, rate: number): number {
  return Math.min(1, Math.max(0, seconds * rate));
}
