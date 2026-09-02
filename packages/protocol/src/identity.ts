import { z } from 'zod';
import {
  IdSchema,
  LocaleSchema,
  NonNegativeIntSchema,
  PlatformSchema,
  SemVerSchema,
  TimestampSchema,
  withIdempotency,
} from './common.js';

/* -------------------------------------------------------------------------- */
/* Accounts & identities                                                       */
/* -------------------------------------------------------------------------- */

/**
 * A player always has exactly one *account*. An account owns the Campfire
 * Passport, campsites, sandwiches, rewards and orders.
 *
 * An account has one or more *identities* — the ways a human proves they are
 * that account. The first identity is always `anonymous`, minted from a device
 * bootstrap so a player can walk up to the fire and start roasting with zero
 * friction. Later they may attach `apple`, `google` or `email` identities
 * WITHOUT losing progress.
 */
export const AuthProviderValues = ['anonymous', 'apple', 'google', 'email'] as const;
export const AuthProviderSchema = z.enum(AuthProviderValues);
export type AuthProvider = z.infer<typeof AuthProviderSchema>;

export const AccountStatusValues = ['active', 'suspended', 'merged', 'deleted'] as const;
export const AccountStatusSchema = z.enum(AccountStatusValues);
export type AccountStatus = z.infer<typeof AccountStatusSchema>;

export const IdentitySchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  provider: AuthProviderSchema,
  /** Provider-scoped subject: device id, Apple `sub`, Google `sub`, or email. */
  subject: z.string().min(1).max(320),
  email: z.email().max(320).nullable().default(null),
  emailVerified: z.boolean().default(false),
  displayNameHint: z.string().max(80).nullable().default(null),
  createdAt: TimestampSchema,
  lastAuthenticatedAt: TimestampSchema,
});
export type Identity = z.infer<typeof IdentitySchema>;

export const AccountSchema = z.object({
  id: IdSchema,
  status: AccountStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Set when this account was absorbed by another during an identity link. */
  mergedIntoAccountId: IdSchema.nullable().default(null),
  /** True until at least one durable (non-anonymous) identity is attached. */
  anonymous: z.boolean(),
  schemaVersion: SemVerSchema,
});
export type Account = z.infer<typeof AccountSchema>;

/* -------------------------------------------------------------------------- */
/* Bootstrap & tokens                                                          */
/* -------------------------------------------------------------------------- */

export const DeviceInfoSchema = z.object({
  deviceId: z.string().min(8).max(128),
  platform: PlatformSchema,
  appVersion: SemVerSchema,
  locale: LocaleSchema.optional(),
  timeZone: z.string().max(64).optional(),
});
export type DeviceInfo = z.infer<typeof DeviceInfoSchema>;

export const AnonymousBootstrapRequestSchema = z.object({
  device: DeviceInfoSchema,
  displayName: z.string().min(1).max(40).optional(),
});
export type AnonymousBootstrapRequest = z.infer<typeof AnonymousBootstrapRequestSchema>;

export const AuthTokenSchema = z.object({
  token: z.string().min(16),
  accountId: IdSchema,
  issuedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  schemaVersion: SemVerSchema,
});
export type AuthToken = z.infer<typeof AuthTokenSchema>;

export const AuthSessionSchema = z.object({
  account: AccountSchema,
  identities: z.array(IdentitySchema),
  auth: AuthTokenSchema,
});
export type AuthSession = z.infer<typeof AuthSessionSchema>;

/* -------------------------------------------------------------------------- */
/* Linking                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Credential presented when attaching a durable identity to the current
 * account. Apple/Google hand us an OIDC id token; email uses a magic link.
 * We never accept a raw password — there are none in this product.
 */
export const LinkCredentialSchema = z.discriminatedUnion('provider', [
  z.object({
    provider: z.literal('apple'),
    identityToken: z.string().min(8).max(4096),
    nonce: z.string().min(8).max(128),
  }),
  z.object({
    provider: z.literal('google'),
    idToken: z.string().min(8).max(4096),
    nonce: z.string().min(8).max(128),
  }),
  z.object({
    provider: z.literal('email'),
    magicLinkToken: z.string().min(8).max(512),
  }),
]);
export type LinkCredential = z.infer<typeof LinkCredentialSchema>;

/**
 * What to do when the presented identity already belongs to a *different*
 * account (the classic "I played anonymously on the couch and now I'm signing
 * in with the Apple ID I used on the plane" case).
 *
 *  - `abort`               : do nothing, return a `conflict` outcome describing
 *                            both sides so the client can ask the human.
 *  - `keep_current`        : the account holding the anonymous session survives;
 *                            the other account's progress is merged into it and
 *                            the other account is marked `merged`.
 *  - `keep_existing`       : the account that already owns the identity survives;
 *                            the current (usually anonymous) account's progress
 *                            is merged into it and a NEW token is issued.
 *
 * There is deliberately no "discard" policy: progress is never destroyed.
 */
export const MergePolicyValues = ['abort', 'keep_current', 'keep_existing'] as const;
export const MergePolicySchema = z.enum(MergePolicyValues);
export type MergePolicy = z.infer<typeof MergePolicySchema>;

export const LinkIdentityRequestSchema = withIdempotency(
  z.object({
    credential: LinkCredentialSchema,
    mergePolicy: MergePolicySchema.default('abort'),
  }),
);
export type LinkIdentityRequest = z.infer<typeof LinkIdentityRequestSchema>;

export const LinkConflictKindValues = [
  /** The identity is already attached to some other account. */
  'identity_owned_by_other_account',
  /** This account already has an identity from that provider. */
  'provider_already_linked',
  /** Another account owns a verified identity with the same email address. */
  'email_in_use',
] as const;
export const LinkConflictKindSchema = z.enum(LinkConflictKindValues);
export type LinkConflictKind = z.infer<typeof LinkConflictKindSchema>;

/** Per-collection tally of what moved during a merge. Surfaced to the player. */
export const MergeReportSchema = z.object({
  survivingAccountId: IdSchema,
  mergedAccountId: IdSchema,
  moved: z.object({
    identities: NonNegativeIntSchema,
    stamps: NonNegativeIntSchema,
    photos: NonNegativeIntSchema,
    sandwiches: NonNegativeIntSchema,
    notes: NonNegativeIntSchema,
    patches: NonNegativeIntSchema,
    ticketStubs: NonNegativeIntSchema,
    discoveries: NonNegativeIntSchema,
    visitedCampsites: NonNegativeIntSchema,
    campsites: NonNegativeIntSchema,
    rewardGrants: NonNegativeIntSchema,
    orders: NonNegativeIntSchema,
    /**
     * Codes the absorbed account had scanned. They move with it: a merge is
     * never a reset, and the box was genuinely bought.
     */
    codeRedemptions: NonNegativeIntSchema.default(0),
  }),
  /** Non-mergeable singletons and how they were resolved. */
  resolutions: z.array(
    z.object({
      field: z.string(),
      kept: z.enum(['current', 'existing', 'combined']),
      note: z.string().max(200).optional(),
    }),
  ),
  mergedAt: TimestampSchema,
});
export type MergeReport = z.infer<typeof MergeReportSchema>;

/** Result of a link attempt. Every branch is explicit — no silent failures. */
export const LinkIdentityOutcomeSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('linked'),
    accountId: IdSchema,
    identity: IdentitySchema,
    auth: AuthTokenSchema,
  }),
  z.object({
    status: z.literal('already_linked'),
    accountId: IdSchema,
    identity: IdentitySchema,
  }),
  z.object({
    status: z.literal('merged'),
    accountId: IdSchema,
    identity: IdentitySchema,
    report: MergeReportSchema,
    /** Present when the surviving account differs from the caller's account. */
    auth: AuthTokenSchema,
  }),
  z.object({
    status: z.literal('conflict'),
    conflict: LinkConflictKindSchema,
    currentAccountId: IdSchema,
    existingAccountId: IdSchema,
    /** Policies the client may retry with, in preference order. */
    resolutions: z.array(MergePolicySchema),
    /** Human-facing summary of what each side would bring to a merge. */
    preview: z.object({
      current: z.object({ sandwiches: NonNegativeIntSchema, stamps: NonNegativeIntSchema, campsites: NonNegativeIntSchema }),
      existing: z.object({ sandwiches: NonNegativeIntSchema, stamps: NonNegativeIntSchema, campsites: NonNegativeIntSchema }),
    }),
  }),
]);
export type LinkIdentityOutcome = z.infer<typeof LinkIdentityOutcomeSchema>;

/* -------------------------------------------------------------------------- */
/* Email magic link                                                            */
/* -------------------------------------------------------------------------- */

export const MagicLinkRequestSchema = withIdempotency(
  z.object({
    email: z.email().max(320),
    /** Deep link the client wants the mail to bounce back into. */
    redirectPath: z.string().max(200).regex(/^\//, 'must be an app-relative path').optional(),
  }),
);
export type MagicLinkRequest = z.infer<typeof MagicLinkRequestSchema>;

export const MagicLinkIssuedSchema = z.object({
  sent: z.literal(true),
  expiresAt: TimestampSchema,
  /** Populated only by the console/dev mailer so local flows are testable. */
  devToken: z.string().optional(),
});
export type MagicLinkIssued = z.infer<typeof MagicLinkIssuedSchema>;
