import { z } from 'zod';

import { IdSchema, TimestampSchema } from './common.js';

/**
 * What an operator is allowed to do (README, Blocker 9).
 *
 * Before this there was one shared secret. Holding it meant you could draft a
 * document, publish it to every player, mint a hundred thousand codes, advance
 * somebody's order and refund it — all the same permission, held by everyone
 * who had the string, with no way to take it back from one person.
 *
 * These are capabilities rather than roles because the blocker's own complaint
 * was the absence of "separation between 'may draft' and 'may mint 100,000
 * codes'". A role model that named those two the same thing would have answered
 * the letter of it and not the point. Roles exist below, as *bundles* of these,
 * because granting six things one at a time is how people end up granting all
 * of them.
 */
export const OperatorCapabilityValues = [
  /** Write and validate content documents. Nothing a player can see changes. */
  'content:draft',
  /** Publish a document, and roll a release back. Every player sees this. */
  'content:publish',
  /** Open a print run and mint codes into it. */
  'codes:mint',
  /** Advance an order through fulfillment. */
  'commerce:fulfill',
  /** Refund an order past the point a customer may refund their own. */
  'commerce:refund',
  /** Act on a moderation report. */
  'moderation:action',
  /** Review a held high-value reward claim. */
  'rewards:review',
  /** Grant and revoke the capabilities above. */
  'operators:grant',
] as const;

export const OperatorCapabilitySchema = z.enum(OperatorCapabilityValues);
export type OperatorCapability = z.infer<typeof OperatorCapabilitySchema>;

/**
 * Named bundles, for granting.
 *
 * Convenience only — nothing authorizes on a role, everything authorizes on a
 * capability. A bundle that drifts from what a job actually needs is a bundle
 * somebody widens; a capability is the thing that gets checked.
 */
export const OPERATOR_ROLES = Object.freeze({
  /** Writes content. Cannot publish it, cannot mint anything. */
  author: ['content:draft'] as readonly OperatorCapability[],
  /** Publishes what authors write, and can take it back. */
  editor: ['content:draft', 'content:publish'] as readonly OperatorCapability[],
  /** The print runs. Deliberately not bundled with anything else. */
  printer: ['codes:mint'] as readonly OperatorCapability[],
  /** Orders: moves them, and makes them right when they go wrong. */
  fulfilment: ['commerce:fulfill', 'commerce:refund'] as readonly OperatorCapability[],
  /** Reports and held claims. */
  support: ['moderation:action', 'rewards:review'] as readonly OperatorCapability[],
  /** Everything, including handing it out. There should be very few. */
  admin: [...OperatorCapabilityValues] as readonly OperatorCapability[],
});

export type OperatorRole = keyof typeof OPERATOR_ROLES;
export const OperatorRoleSchema = z.enum(
  Object.keys(OPERATOR_ROLES) as [OperatorRole, ...OperatorRole[]],
);

/** One capability held by one account, and who gave it to them. */
export const OperatorGrantSchema = z.object({
  accountId: IdSchema,
  capability: OperatorCapabilitySchema,
  /** The account that granted it, or `null` when it came from the bootstrap. */
  grantedByAccountId: IdSchema.nullable(),
  grantedAt: TimestampSchema,
  /** Set rather than deleted, so a revocation is a fact and not an absence. */
  revokedAt: TimestampSchema.nullable().default(null),
});
export type OperatorGrant = z.infer<typeof OperatorGrantSchema>;

export const GrantOperatorRequestSchema = z
  .object({
    accountId: IdSchema,
    /** Either an explicit list, or a role to expand. */
    capabilities: z.array(OperatorCapabilitySchema).min(1).max(16).optional(),
    role: OperatorRoleSchema.optional(),
  })
  .refine((body) => body.capabilities !== undefined || body.role !== undefined, {
    message: 'Give either capabilities or a role.',
  });
export type GrantOperatorRequest = z.infer<typeof GrantOperatorRequestSchema>;

export const RevokeOperatorRequestSchema = z.object({
  accountId: IdSchema,
  capabilities: z.array(OperatorCapabilitySchema).min(1).max(16),
});
export type RevokeOperatorRequest = z.infer<typeof RevokeOperatorRequestSchema>;

/** Expands a role, or passes an explicit list through. */
export function capabilitiesFor(request: GrantOperatorRequest): readonly OperatorCapability[] {
  if (request.capabilities !== undefined) return request.capabilities;
  return OPERATOR_ROLES[request.role as OperatorRole];
}
