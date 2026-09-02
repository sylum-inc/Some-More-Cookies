import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  TimestampSchema,
  UnitIntervalSchema,
  withIdempotency,
} from './common.js';
import { RaritySchema } from './passport.js';

/* -------------------------------------------------------------------------- */
/* Definitions                                                                 */
/* -------------------------------------------------------------------------- */

export const RewardKindValues = ['stamp', 'points', 'cosmetic', 'unlock', 'patch', 'perk'] as const;
export const RewardKindSchema = z.enum(RewardKindValues);
export type RewardKind = z.infer<typeof RewardKindSchema>;

/**
 * `standard` rewards are cosmetic/in-world and are granted optimistically.
 * `high` rewards cost real money to honour (a free kit, an event ticket, a
 * discount code) and MUST pass server-side validation, claim-once semantics
 * and anti-abuse checks before they are fulfilled.
 */
export const RewardValueTierValues = ['standard', 'high'] as const;
export const RewardValueTierSchema = z.enum(RewardValueTierValues);
export type RewardValueTier = z.infer<typeof RewardValueTierSchema>;

export const RewardPrerequisiteSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('stamp'), code: z.string().max(64), count: PositiveIntSchema.default(1) }),
  z.object({ kind: z.literal('sandwiches_made'), count: PositiveIntSchema }),
  z.object({ kind: z.literal('min_sandwich_score'), score: UnitIntervalSchema }),
  z.object({ kind: z.literal('points'), points: PositiveIntSchema }),
  z.object({ kind: z.literal('account_age_hours'), hours: PositiveIntSchema }),
  z.object({ kind: z.literal('linked_identity'), provider: z.enum(['apple', 'google', 'email']) }),
]);
export type RewardPrerequisite = z.infer<typeof RewardPrerequisiteSchema>;

export const RewardDefinitionSchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
  kind: RewardKindSchema,
  name: z.string().min(1).max(80),
  description: z.string().max(280).default(''),
  rarity: RaritySchema.default('common'),
  valueTier: RewardValueTierSchema.default('standard'),
  points: NonNegativeIntSchema.default(0),
  /** Payload interpreted by the granting domain (cosmetic code, perk sku…). */
  payloadCode: z.string().max(64).nullable().default(null),
  prerequisites: z.array(RewardPrerequisiteSchema).max(8).default([]),
  perAccountLimit: PositiveIntSchema.default(1),
  globalLimit: PositiveIntSchema.nullable().default(null),
  globalClaimed: NonNegativeIntSchema.default(0),
  availableFrom: TimestampSchema.nullable().default(null),
  availableUntil: TimestampSchema.nullable().default(null),
  active: z.boolean().default(true),
});
export type RewardDefinition = z.infer<typeof RewardDefinitionSchema>;

/* -------------------------------------------------------------------------- */
/* Grants                                                                      */
/* -------------------------------------------------------------------------- */

export const RewardSourceSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gameplay'), sandwichId: IdSchema.optional(), campsiteId: IdSchema.optional() }),
  z.object({ type: z.literal('promotion'), promotionCode: z.string().max(64) }),
  z.object({ type: z.literal('order'), orderId: IdSchema }),
  z.object({ type: z.literal('referral'), referrerAccountId: IdSchema }),
  z.object({ type: z.literal('admin'), actor: z.string().max(64), reason: z.string().max(200) }),
  /**
   * Redeemed from a signed physical or event code. `batchId` + `codeRef` is the
   * provenance a fraud reviewer needs: which print run, which code in it.
   */
  z.object({ type: z.literal('code'), batchId: IdSchema, codeRef: z.string().max(128) }),
]);
export type RewardSource = z.infer<typeof RewardSourceSchema>;

export const RewardGrantStatusValues = ['granted', 'revoked', 'consumed'] as const;
export const RewardGrantStatusSchema = z.enum(RewardGrantStatusValues);

export const RewardGrantSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  rewardId: IdSchema,
  rewardCode: z.string().max(64),
  kind: RewardKindSchema,
  valueTier: RewardValueTierSchema,
  points: NonNegativeIntSchema.default(0),
  status: RewardGrantStatusSchema.default('granted'),
  source: RewardSourceSchema,
  grantedAt: TimestampSchema,
  revokedAt: TimestampSchema.nullable().default(null),
  consumedAt: TimestampSchema.nullable().default(null),
  /** Set when the grant was redeemed against an order. */
  redeemedOnOrderId: IdSchema.nullable().default(null),
});
export type RewardGrant = z.infer<typeof RewardGrantSchema>;

/* -------------------------------------------------------------------------- */
/* High-value claims                                                           */
/* -------------------------------------------------------------------------- */

export const AntiAbuseSignalValues = [
  'device_shared_across_accounts',
  'claim_velocity_exceeded',
  'account_too_young',
  'duplicate_client_nonce',
  'prerequisites_unmet',
  'ip_reputation',
  'emulator_suspected',
  'unlinked_account',
] as const;
export const AntiAbuseSignalSchema = z.enum(AntiAbuseSignalValues);
export type AntiAbuseSignal = z.infer<typeof AntiAbuseSignalSchema>;

export const AntiAbuseContextSchema = z.object({
  deviceId: z.string().min(8).max(128),
  /** Salted hash — we never persist raw client IPs against a claim. */
  ipHash: z.string().length(64),
  clientNonce: z.string().min(8).max(128),
  riskScore: UnitIntervalSchema,
  signals: z.array(AntiAbuseSignalSchema).max(16).default([]),
  claimsInWindow: NonNegativeIntSchema.default(0),
  accountsOnDevice: PositiveIntSchema.default(1),
  duplicateOfClaimId: IdSchema.nullable().default(null),
});
export type AntiAbuseContext = z.infer<typeof AntiAbuseContextSchema>;

export const ClaimStateValues = [
  'pending',
  'validating',
  'approved',
  'rejected',
  'fulfilled',
  'expired',
] as const;
export const ClaimStateSchema = z.enum(ClaimStateValues);
export type ClaimState = z.infer<typeof ClaimStateSchema>;

/** Legal transitions for a high-value reward claim. */
export const CLAIM_TRANSITIONS: Readonly<Record<ClaimState, readonly ClaimState[]>> = Object.freeze({
  pending: ['validating', 'rejected', 'expired'],
  validating: ['approved', 'rejected', 'expired'],
  approved: ['fulfilled', 'rejected', 'expired'],
  rejected: [],
  fulfilled: [],
  expired: [],
});

export function canTransitionClaim(from: ClaimState, to: ClaimState): boolean {
  return CLAIM_TRANSITIONS[from].includes(to);
}

export const RewardClaimSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  rewardId: IdSchema,
  rewardCode: z.string().max(64),
  state: ClaimStateSchema,
  requestedAt: TimestampSchema,
  updatedAt: TimestampSchema,
  decidedAt: TimestampSchema.nullable().default(null),
  expiresAt: TimestampSchema,
  antiAbuse: AntiAbuseContextSchema,
  rejectionReason: z.string().max(200).nullable().default(null),
  grantId: IdSchema.nullable().default(null),
  /** Opaque reference into whatever honours the perk (voucher id, ticket id). */
  fulfillmentRef: z.string().max(128).nullable().default(null),
  idempotencyKey: z.string().max(200),
});
export type RewardClaim = z.infer<typeof RewardClaimSchema>;

export const ClaimRewardRequestSchema = withIdempotency(
  z.object({
    rewardCode: z.string().min(1).max(64),
    deviceId: z.string().min(8).max(128),
    clientNonce: z.string().min(8).max(128),
    /** Optional evidence pointer; the server re-derives everything it trusts. */
    sandwichId: IdSchema.optional(),
  }),
);
export type ClaimRewardRequest = z.infer<typeof ClaimRewardRequestSchema>;

export const ClaimRewardResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('granted'), grant: RewardGrantSchema, claim: RewardClaimSchema.nullable() }),
  z.object({ status: z.literal('pending_review'), claim: RewardClaimSchema }),
  z.object({
    status: z.literal('rejected'),
    claim: RewardClaimSchema,
    signals: z.array(AntiAbuseSignalSchema),
  }),
]);
export type ClaimRewardResult = z.infer<typeof ClaimRewardResultSchema>;
