import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  SemVerSchema,
  TimestampSchema,
  UnitIntervalSchema,
  withIdempotency,
} from './common.js';
import { MachineSerialSchema } from './campsite.js';
import { RaritySchema } from './passport.js';

/* -------------------------------------------------------------------------- */
/* Roast                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The client simulates the roast at 60–120 Hz; only this summary is durable.
 * The raw telemetry stream is sampled into analytics separately and is never
 * the source of truth for a sandwich record.
 */
export const RoastGradeValues = ['raw', 'pale', 'golden', 'toasted', 'charred', 'cremated'] as const;
export const RoastGradeSchema = z.enum(RoastGradeValues);
export type RoastGrade = z.infer<typeof RoastGradeSchema>;

export const RoastTelemetrySummarySchema = z.object({
  durationMs: NonNegativeIntSchema.max(60 * 60 * 1000),
  averageDistanceCm: z.number().min(0).max(200),
  minimumDistanceCm: z.number().min(0).max(200),
  rotations: z.number().min(0).max(1000),
  /** How uniformly the surface browned: 1 = a perfect even skin. */
  evenness: UnitIntervalSchema,
  peakSurfaceTempC: z.number().min(0).max(600),
  charFraction: UnitIntervalSchema,
  meltFraction: UnitIntervalSchema,
  ignited: z.boolean(),
  flareUps: NonNegativeIntSchema.max(100),
  blownOut: z.boolean().default(false),
  dropped: z.boolean().default(false),
  grade: RoastGradeSchema,
  /** Sim build that produced these numbers — required to replay a roast. */
  simVersion: SemVerSchema,
});
export type RoastTelemetrySummary = z.infer<typeof RoastTelemetrySummarySchema>;

/* -------------------------------------------------------------------------- */
/* Assembly                                                                    */
/* -------------------------------------------------------------------------- */

export const AssemblyDefectValues = [
  'crooked_stack',
  'cracked_graham',
  'chocolate_gap',
  'squeeze_out',
  'cold_center',
  'ash_contamination',
  'upside_down',
] as const;
export const AssemblyDefectSchema = z.enum(AssemblyDefectValues);

export const AssemblyQualitySchema = z.object({
  alignment: UnitIntervalSchema,
  chocolateCoverage: UnitIntervalSchema,
  grahamIntegrity: UnitIntervalSchema,
  squish: UnitIntervalSchema,
  heatTransfer: UnitIntervalSchema,
  layerOrderCorrect: z.boolean(),
  assembledInSeconds: z.number().min(0).max(3600),
  defects: z.array(AssemblyDefectSchema).max(8).default([]),
  /** Weighted composite the machine reads before deciding on the run. */
  score: UnitIntervalSchema,
});
export type AssemblyQuality = z.infer<typeof AssemblyQualitySchema>;

/* -------------------------------------------------------------------------- */
/* Machine run                                                                 */
/* -------------------------------------------------------------------------- */

export const MachineProgramValues = ['classic', 'double_churn', 'quick_freeze', 'slow_set', 'experimental'] as const;
export const MachineProgramSchema = z.enum(MachineProgramValues);
export type MachineProgram = z.infer<typeof MachineProgramSchema>;

export const MachineRunOutcomeValues = ['success', 'partial', 'jam', 'aborted'] as const;
export const MachineRunOutcomeSchema = z.enum(MachineRunOutcomeValues);

export const MachineAnomalyValues = [
  'chill_undershoot',
  'chill_overshoot',
  'press_slip',
  'belt_stall',
  'hopper_empty',
  'door_opened',
  'quirk_triggered',
] as const;
export const MachineAnomalySchema = z.enum(MachineAnomalyValues);

/** What the SM-01 did with the hot s'more it was fed. */
export const MachineRunSchema = z.object({
  runId: IdSchema,
  machineSerial: MachineSerialSchema,
  program: MachineProgramSchema,
  startedAt: TimestampSchema,
  completedAt: TimestampSchema,
  chillSeconds: z.number().min(0).max(3600),
  pressForceN: z.number().min(0).max(5000),
  churnRpm: z.number().min(0).max(600),
  coreTempC: z.number().min(-40).max(80),
  outcome: MachineRunOutcomeSchema,
  anomalies: z.array(MachineAnomalySchema).max(16).default([]),
  quirkCodesApplied: z.array(z.string().max(64)).max(16).default([]),
  /** Wear this single run added to each component. */
  wearDelta: z.object({
    drum: z.number().min(0).max(1),
    press: z.number().min(0).max(1),
    chiller: z.number().min(0).max(1),
    dispenser: z.number().min(0).max(1),
    hopper: z.number().min(0).max(1),
    belt: z.number().min(0).max(1),
  }),
  firmwareVersion: SemVerSchema,
});
export type MachineRun = z.infer<typeof MachineRunSchema>;

/* -------------------------------------------------------------------------- */
/* Sandwich record                                                             */
/* -------------------------------------------------------------------------- */

export const SandwichShareStateValues = ['private', 'link', 'campsite', 'public'] as const;
export const SandwichShareStateSchema = z.enum(SandwichShareStateValues);

export const FlavorTagSchema = z.string().min(1).max(40).regex(/^[a-z0-9_]+$/);

/**
 * The canonical record of one produced roasted-marshmallow ice cream sandwich.
 * Immutable once written except for the small mutable tail (name, share state,
 * photos, consumedAt) — everything else is the provenance of that object.
 */
export const SandwichRecordSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  campsiteId: IdSchema,
  sessionId: IdSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  schemaVersion: SemVerSchema,
  name: z.string().max(60).nullable().default(null),
  roast: RoastTelemetrySummarySchema,
  assembly: AssemblyQualitySchema,
  machineRun: MachineRunSchema,
  /** 0..1 composite the passport ranks by; derived server-side, never client. */
  overallScore: UnitIntervalSchema,
  rarity: RaritySchema,
  flavorTags: z.array(FlavorTagSchema).max(12).default([]),
  photoIds: z.array(IdSchema).max(24).default([]),
  heroPhotoId: IdSchema.nullable().default(null),
  shareState: SandwichShareStateSchema.default('private'),
  savedToPassport: z.boolean().default(true),
  consumedAt: TimestampSchema.nullable().default(null),
  /** Set when this exact sandwich was the basis for a real-world order. */
  orderId: IdSchema.nullable().default(null),
});
export type SandwichRecord = z.infer<typeof SandwichRecordSchema>;

/**
 * Clients submit the produced sandwich; the server derives `overallScore`,
 * `rarity`, ids and timestamps. Anything score-bearing that the client sends
 * is ignored — see `scoreSandwich`.
 */
export const CreateSandwichRequestSchema = withIdempotency(
  z.object({
    campsiteId: IdSchema,
    sessionId: IdSchema.optional(),
    name: z.string().max(60).optional(),
    roast: RoastTelemetrySummarySchema,
    assembly: AssemblyQualitySchema,
    machineRun: MachineRunSchema.omit({ runId: true }),
    flavorTags: z.array(FlavorTagSchema).max(12).default([]),
    photoIds: z.array(IdSchema).max(24).default([]),
  }),
);
export type CreateSandwichRequest = z.infer<typeof CreateSandwichRequestSchema>;

export const UpdateSandwichRequestSchema = z.object({
  name: z.string().max(60).nullable().optional(),
  shareState: SandwichShareStateSchema.optional(),
  heroPhotoId: IdSchema.nullable().optional(),
  savedToPassport: z.boolean().optional(),
  consumed: z.boolean().optional(),
});
export type UpdateSandwichRequest = z.infer<typeof UpdateSandwichRequestSchema>;

/**
 * Authoritative scoring. Lives in the protocol so the client can show a
 * prediction and the server can compute the value of record — with the server
 * always winning.
 */
export function scoreSandwich(input: {
  roast: RoastTelemetrySummary;
  assembly: AssemblyQuality;
  machineRun: Pick<MachineRun, 'outcome' | 'anomalies'>;
}): number {
  const gradeWeight: Record<RoastGrade, number> = {
    raw: 0.15,
    pale: 0.45,
    golden: 1,
    toasted: 0.85,
    charred: 0.4,
    cremated: 0.05,
  };
  const roastScore =
    gradeWeight[input.roast.grade] * 0.6 +
    input.roast.evenness * 0.3 +
    (input.roast.dropped ? 0 : 0.1);
  const outcomeWeight = { success: 1, partial: 0.6, jam: 0.25, aborted: 0 }[input.machineRun.outcome];
  const anomalyPenalty = Math.min(0.3, input.machineRun.anomalies.length * 0.06);
  const raw = roastScore * 0.45 + input.assembly.score * 0.35 + (outcomeWeight - anomalyPenalty) * 0.2;
  return Math.max(0, Math.min(1, Number(raw.toFixed(4))));
}

export function rarityForScore(score: number): z.infer<typeof RaritySchema> {
  if (score >= 0.95) return 'legendary';
  if (score >= 0.85) return 'rare';
  if (score >= 0.65) return 'uncommon';
  return 'common';
}
