import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  SeedSchema,
  SemVerSchema,
  TimestampSchema,
  UnitIntervalSchema,
  Vec3Schema,
  withIdempotency,
} from './common.js';

/* -------------------------------------------------------------------------- */
/* Privacy & membership                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Campsites are PRIVATE BY DEFAULT. Widening privacy is always an explicit,
 * owner-only act; nothing in the product ever silently publishes a campsite.
 */
export const CampsitePrivacyValues = ['private', 'invite_only', 'friends', 'public'] as const;
export const CampsitePrivacySchema = z.enum(CampsitePrivacyValues);
export type CampsitePrivacy = z.infer<typeof CampsitePrivacySchema>;

export const MemberRoleValues = ['owner', 'cohost', 'guest', 'viewer'] as const;
export const MemberRoleSchema = z.enum(MemberRoleValues);
export type MemberRole = z.infer<typeof MemberRoleSchema>;

/** Capability ranking used by the authorization checks in the service. */
export const ROLE_RANK: Readonly<Record<MemberRole, number>> = Object.freeze({
  viewer: 0,
  guest: 1,
  cohost: 2,
  owner: 3,
});

export function roleAtLeast(role: MemberRole, minimum: MemberRole): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[minimum];
}

export const CampsiteMemberSchema = z.object({
  accountId: IdSchema,
  role: MemberRoleSchema,
  joinedAt: TimestampSchema,
  lastSeenAt: TimestampSchema.nullable().default(null),
  /** How they got in — useful for abuse review and for the passport stamp. */
  joinedVia: z.enum(['owner', 'invite_link', 'camp_code', 'qr', 'friend', 'restore']).default('owner'),
  banned: z.boolean().default(false),
});
export type CampsiteMember = z.infer<typeof CampsiteMemberSchema>;

/** Six-character human-speakable code, unambiguous alphabet (no I/O/0/1). */
export const CampCodeSchema = z.string().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);

export const CampsiteInviteSchema = z.object({
  id: IdSchema,
  campsiteId: IdSchema,
  /** Opaque link token; the camp code is the short spoken form. */
  token: z.string().min(16).max(128),
  campCode: CampCodeSchema,
  createdBy: IdSchema,
  createdAt: TimestampSchema,
  expiresAt: TimestampSchema,
  maxUses: PositiveIntSchema.max(100).default(10),
  uses: NonNegativeIntSchema.default(0),
  revokedAt: TimestampSchema.nullable().default(null),
  /** Role granted on redemption; never `owner`. */
  grantsRole: z.enum(['cohost', 'guest', 'viewer']).default('guest'),
});
export type CampsiteInvite = z.infer<typeof CampsiteInviteSchema>;

/* -------------------------------------------------------------------------- */
/* The SM-01                                                                   */
/* -------------------------------------------------------------------------- */

/** `SM01-` + 4 + 4 alphanumerics, stamped on the machine's brass plate. */
export const MachineSerialSchema = z.string().regex(/^SM01-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

export const MachineComponentValues = ['drum', 'press', 'chiller', 'dispenser', 'hopper', 'belt'] as const;
export const MachineComponentSchema = z.enum(MachineComponentValues);
export type MachineComponent = z.infer<typeof MachineComponentSchema>;

/** 0 = factory fresh, 1 = please stop feeding me marshmallows. */
export const MachineWearSchema = z.object({
  drum: UnitIntervalSchema.default(0),
  press: UnitIntervalSchema.default(0),
  chiller: UnitIntervalSchema.default(0),
  dispenser: UnitIntervalSchema.default(0),
  hopper: UnitIntervalSchema.default(0),
  belt: UnitIntervalSchema.default(0),
});
export type MachineWear = z.infer<typeof MachineWearSchema>;

export const MaintenanceKindValues = [
  'clean',
  'lubricate',
  'replace_part',
  'descale',
  'firmware_update',
  'recalibrate',
  'factory_reset',
] as const;
export const MaintenanceKindSchema = z.enum(MaintenanceKindValues);

export const MaintenanceEventSchema = z.object({
  id: IdSchema,
  kind: MaintenanceKindSchema,
  at: TimestampSchema,
  performedBy: IdSchema,
  component: MachineComponentSchema.nullable().default(null),
  wearBefore: UnitIntervalSchema,
  wearAfter: UnitIntervalSchema,
  notes: z.string().max(280).default(''),
});
export type MaintenanceEvent = z.infer<typeof MaintenanceEventSchema>;

/**
 * Quirks are the machine's personality: earned, not configured. A quirk is
 * acquired from a specific history of runs (an over-chilled batch, a jam that
 * was cleared with a mallet) and is part of what makes a player's SM-01 theirs.
 */
export const QuirkSeverityValues = ['charming', 'minor', 'major'] as const;
export const QuirkSeveritySchema = z.enum(QuirkSeverityValues);

export const MachineQuirkSchema = z.object({
  code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  name: z.string().min(1).max(80),
  description: z.string().max(240).default(''),
  severity: QuirkSeveritySchema,
  acquiredAt: TimestampSchema,
  acquiredFromRunId: IdSchema.nullable().default(null),
  /** Some quirks buff the output; the sim reads these multipliers. */
  effects: z
    .object({
      chillBiasSeconds: z.number().min(-60).max(60).default(0),
      pressBiasN: z.number().min(-200).max(200).default(0),
      jamChanceDelta: z.number().min(-0.5).max(0.5).default(0),
      flavorTag: z.string().max(40).nullable().default(null),
    })
    .prefault({}),
});
export type MachineQuirk = z.infer<typeof MachineQuirkSchema>;

/** The serialized SM-01 that lives at a campsite. One machine per campsite. */
export const SM01Schema = z.object({
  model: z.literal('SM-01'),
  serialNumber: MachineSerialSchema,
  firmwareVersion: SemVerSchema,
  installedAt: TimestampSchema,
  wear: MachineWearSchema,
  cyclesRun: NonNegativeIntSchema.default(0),
  jamsCleared: NonNegativeIntSchema.default(0),
  lastRunAt: TimestampSchema.nullable().default(null),
  lastServicedAt: TimestampSchema.nullable().default(null),
  maintenanceHistory: z.array(MaintenanceEventSchema).max(500).default([]),
  quirks: z.array(MachineQuirkSchema).max(32).default([]),
  /** Cosmetic finish applied by the owner; unlocked through rewards. */
  finishCode: z.string().max(64).default('factory_enamel'),
  operational: z.boolean().default(true),
});
export type SM01 = z.infer<typeof SM01Schema>;

/* -------------------------------------------------------------------------- */
/* World traces & landmarks                                                    */
/* -------------------------------------------------------------------------- */

export const TraceKindValues = [
  'ash',
  'footprint',
  'carving',
  'spill',
  'scorch',
  'wrapper',
  'log_stack',
  'stone_ring',
  'chalk',
  'melt_puddle',
] as const;
export const TraceKindSchema = z.enum(TraceKindValues);
export type TraceKind = z.infer<typeof TraceKindSchema>;

/**
 * A trace is a persistent mark a player left on the world. Traces decay
 * exponentially: `intensity(t) = intensity0 * exp(-decayRatePerHour * hours)`.
 * A trace that is witnessed by enough distinct players before it fades can be
 * promoted to a Landmark, which stops decaying and gets a name.
 */
export const WorldTraceSchema = z.object({
  id: IdSchema,
  campsiteId: IdSchema,
  kind: TraceKindSchema,
  position: Vec3Schema,
  rotationY: z.number().min(-Math.PI * 2).max(Math.PI * 2).default(0),
  scale: z.number().min(0.05).max(20).default(1),
  createdBy: IdSchema,
  createdAt: TimestampSchema,
  /** Intensity as of `lastDecayedAt`; the read model applies further decay. */
  intensity: UnitIntervalSchema,
  decayRatePerHour: z.number().min(0).max(10),
  lastDecayedAt: TimestampSchema,
  /** Distinct accounts that have seen/reinforced it — the promotion quorum. */
  witnessAccountIds: z.array(IdSchema).max(64).default([]),
  text: z.string().max(120).nullable().default(null),
  promotedLandmarkId: IdSchema.nullable().default(null),
});
export type WorldTrace = z.infer<typeof WorldTraceSchema>;

export const LandmarkPermanenceValues = ['session', 'persistent', 'canonical'] as const;
export const LandmarkPermanenceSchema = z.enum(LandmarkPermanenceValues);

export const LandmarkSchema = z.object({
  id: IdSchema,
  campsiteId: IdSchema,
  originTraceId: IdSchema.nullable().default(null),
  name: z.string().min(1).max(80),
  kind: TraceKindSchema,
  position: Vec3Schema,
  promotedAt: TimestampSchema,
  promotedBy: IdSchema,
  permanence: LandmarkPermanenceSchema.default('persistent'),
  /** How many players have referenced it since promotion. */
  citations: NonNegativeIntSchema.default(0),
  description: z.string().max(240).default(''),
});
export type Landmark = z.infer<typeof LandmarkSchema>;

/** Server-enforced rule for promoting a trace into a landmark. */
export const LandmarkPromotionRuleSchema = z.object({
  minIntensity: UnitIntervalSchema.default(0.5),
  minDistinctWitnesses: PositiveIntSchema.default(2),
  minAgeMinutes: NonNegativeIntSchema.default(0),
  maxLandmarksPerCampsite: PositiveIntSchema.default(24),
});
export type LandmarkPromotionRule = z.infer<typeof LandmarkPromotionRuleSchema>;

export const DEFAULT_LANDMARK_PROMOTION_RULE: LandmarkPromotionRule = Object.freeze({
  minIntensity: 0.5,
  minDistinctWitnesses: 2,
  minAgeMinutes: 0,
  maxLandmarksPerCampsite: 24,
});

/** Pure decay function — shared by the sim, the client preview and the API. */
export function decayedIntensity(
  intensity: number,
  decayRatePerHour: number,
  elapsedMs: number,
): number {
  if (elapsedMs <= 0) return intensity;
  const hours = elapsedMs / 3_600_000;
  const value = intensity * Math.exp(-decayRatePerHour * hours);
  return value < 1e-6 ? 0 : Math.min(1, value);
}

/** Below this, a trace is swept away by the wind. */
export const TRACE_SWEEP_THRESHOLD = 0.02;

/* -------------------------------------------------------------------------- */
/* Campsite                                                                    */
/* -------------------------------------------------------------------------- */

export const CampsiteSchema = z.object({
  id: IdSchema,
  /** Which authored environment this instance is a copy of. */
  environmentId: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  seed: SeedSchema,
  ownerAccountId: IdSchema,
  name: z.string().min(1).max(60),
  privacy: CampsitePrivacySchema.default('private'),
  campCode: CampCodeSchema,
  members: z.array(CampsiteMemberSchema).max(64),
  machine: SM01Schema,
  traces: z.array(WorldTraceSchema).max(2000).default([]),
  landmarks: z.array(LandmarkSchema).max(64).default([]),
  promotionRule: LandmarkPromotionRuleSchema.prefault({}),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  lastActiveAt: TimestampSchema,
  revision: NonNegativeIntSchema,
  schemaVersion: SemVerSchema,
  archivedAt: TimestampSchema.nullable().default(null),
});
export type Campsite = z.infer<typeof CampsiteSchema>;

/** Trimmed campsite for lists and for members who may not see everything. */
export const CampsiteSummarySchema = CampsiteSchema.pick({
  id: true,
  environmentId: true,
  name: true,
  privacy: true,
  ownerAccountId: true,
  createdAt: true,
  lastActiveAt: true,
}).extend({
  memberCount: NonNegativeIntSchema,
  machineSerial: MachineSerialSchema,
});
export type CampsiteSummary = z.infer<typeof CampsiteSummarySchema>;

export const CreateCampsiteRequestSchema = withIdempotency(
  z.object({
    name: z.string().min(1).max(60),
    environmentId: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/).default('pine_hollow'),
    seed: SeedSchema.optional(),
    privacy: CampsitePrivacySchema.default('private'),
  }),
);
export type CreateCampsiteRequest = z.infer<typeof CreateCampsiteRequestSchema>;

export const UpdateCampsiteRequestSchema = z.object({
  name: z.string().min(1).max(60).optional(),
  privacy: CampsitePrivacySchema.optional(),
  machineFinishCode: z.string().max(64).optional(),
  expectedRevision: NonNegativeIntSchema.optional(),
});
export type UpdateCampsiteRequest = z.infer<typeof UpdateCampsiteRequestSchema>;

export const CreateInviteRequestSchema = withIdempotency(
  z.object({
    ttlMinutes: PositiveIntSchema.max(60 * 24 * 30).default(60 * 24),
    maxUses: PositiveIntSchema.max(100).default(10),
    grantsRole: z.enum(['cohost', 'guest', 'viewer']).default('guest'),
  }),
);
export type CreateInviteRequest = z.infer<typeof CreateInviteRequestSchema>;

export const RecordMaintenanceRequestSchema = withIdempotency(
  z.object({
    kind: MaintenanceKindSchema,
    component: MachineComponentSchema.optional(),
    notes: z.string().max(280).default(''),
  }),
);
export type RecordMaintenanceRequest = z.infer<typeof RecordMaintenanceRequestSchema>;

export const CreateTraceRequestSchema = withIdempotency(
  z.object({
    kind: TraceKindSchema,
    position: Vec3Schema,
    rotationY: z.number().min(-Math.PI * 2).max(Math.PI * 2).default(0),
    scale: z.number().min(0.05).max(20).default(1),
    intensity: UnitIntervalSchema.default(1),
    decayRatePerHour: z.number().min(0).max(10).default(0.05),
    text: z.string().max(120).optional(),
  }),
);
export type CreateTraceRequest = z.infer<typeof CreateTraceRequestSchema>;

export const PromoteLandmarkRequestSchema = withIdempotency(
  z.object({
    name: z.string().min(1).max(80),
    description: z.string().max(240).default(''),
    permanence: LandmarkPermanenceSchema.default('persistent'),
  }),
);
export type PromoteLandmarkRequest = z.infer<typeof PromoteLandmarkRequestSchema>;

/** Read model for the live world: traces with decay already applied. */
export const WorldStateSchema = z.object({
  campsiteId: IdSchema,
  observedAt: TimestampSchema,
  traces: z.array(WorldTraceSchema.extend({ currentIntensity: UnitIntervalSchema })),
  landmarks: z.array(LandmarkSchema),
  sweptTraceIds: z.array(IdSchema),
});
export type WorldState = z.infer<typeof WorldStateSchema>;
