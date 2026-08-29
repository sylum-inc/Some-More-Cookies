import { z } from 'zod';
import {
  IdSchema,
  JsonValueSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  SemVerSchema,
  TimestampSchema,
  withIdempotency,
} from './common.js';

/**
 * `@somemore/protocol/liveops` — content that changes after ship.
 *
 * The base catalogue is compiled into the client (`@somemore/content`) and that
 * is correct: the campfire must start with no network, and twelve authored
 * environments are not a thing to download. What is *not* correct is compiling
 * a meteor-shower weekend, a limited flavour, or a reward that turns on in
 * March — those are operations, not builds (spec §14).
 *
 * So this contract describes an **overlay**, never a replacement:
 *
 *  - the client boots from its compiled catalogue, always, immediately;
 *  - it fetches a manifest in the background, with cache validators, and
 *    applies whatever it got on top;
 *  - if the fetch fails, is slow, or returns something it cannot understand,
 *    the campsite is already running and nothing waits.
 *
 * A document goes `draft → staged → published → retired`, and every publish or
 * retirement mints a new immutable **release**: a numbered snapshot of exactly
 * which document versions were live. Rolling back is publishing an earlier
 * release's contents as a *new* release — forward-only, for the same reason the
 * migration runner is forward-only. The path that runs in production is a path
 * that was tested, and the audit trail never loses a step.
 */

/* -------------------------------------------------------------------------- */
/* Documents                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * What a document holds. Each kind has a validator that runs **at publish
 * time**, on our machine, so a malformed environment is an operator's 422 and
 * never a player's broken campsite.
 */
export const ContentKindValues = [
  'environment',
  'seasonal_event',
  'station_programming',
  'reward_definition',
] as const;
export const ContentKindSchema = z.enum(ContentKindValues);
export type ContentKind = z.infer<typeof ContentKindSchema>;

export const ContentStatusValues = ['draft', 'staged', 'published', 'retired'] as const;
export const ContentStatusSchema = z.enum(ContentStatusValues);
export type ContentStatus = z.infer<typeof ContentStatusSchema>;

/**
 * Legal lifecycle moves.
 *
 * `published → staged` is deliberately absent: un-publishing by moving a
 * document backwards would leave the manifest describing a state no release
 * ever recorded. Taking something down is `retired`, which is a release of its
 * own; putting it back is a rollback, which is also a release.
 */
export const CONTENT_TRANSITIONS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = Object.freeze({
  draft: ['staged', 'retired'],
  staged: ['published', 'draft', 'retired'],
  published: ['retired'],
  retired: [],
});

export function canTransitionContent(from: ContentStatus, to: ContentStatus): boolean {
  return CONTENT_TRANSITIONS[from].includes(to);
}

/**
 * When a document is live.
 *
 * Evaluated **server-side against the service clock**, never against the
 * device's. A phone with its clock set forward is the oldest trick there is,
 * and a seasonal event is exactly the sort of thing someone would try it on.
 */
export const ActivationWindowSchema = z
  .object({
    startsAt: TimestampSchema.nullable().default(null),
    endsAt: TimestampSchema.nullable().default(null),
  })
  .refine(
    (w) => w.startsAt === null || w.endsAt === null || w.startsAt < w.endsAt,
    { message: 'startsAt must be before endsAt' },
  );
export type ActivationWindow = z.infer<typeof ActivationWindowSchema>;

/** Is `window` open at `nowIso`? Pure, so client previews agree with the server. */
export function isWindowOpen(window: ActivationWindow | null, nowIso: string): boolean {
  if (window === null) return true;
  if (window.startsAt !== null && nowIso < window.startsAt) return false;
  if (window.endsAt !== null && nowIso >= window.endsAt) return false;
  return true;
}

export const ContentSlugSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9_]+$/, 'slugs are lowercase, digits and underscores');

export const ContentDocumentSchema = z.object({
  id: IdSchema,
  kind: ContentKindSchema,
  /** Stable key across versions. `(kind, slug)` is the thing being versioned. */
  slug: ContentSlugSchema,
  version: PositiveIntSchema,
  status: ContentStatusSchema.default('draft'),
  title: z.string().min(1).max(120),
  /** The payload. Its shape is the kind's business, checked before publish. */
  body: JsonValueSchema,
  /** sha256 of the canonical body. Server-minted; the ETag is derived from it. */
  checksum: z.string().length(64),
  /** Null means "live whenever published" — most content, including all base data. */
  activation: ActivationWindowSchema.nullable().default(null),
  /** Contract version this document was authored against. */
  schemaVersion: SemVerSchema,
  createdAt: TimestampSchema,
  createdBy: z.string().max(64),
  updatedAt: TimestampSchema,
  publishedAt: TimestampSchema.nullable().default(null),
  retiredAt: TimestampSchema.nullable().default(null),
  notes: z.string().max(500).default(''),
});
export type ContentDocument = z.infer<typeof ContentDocumentSchema>;

export const CreateContentDocumentRequestSchema = withIdempotency(
  z.object({
    kind: ContentKindSchema,
    slug: ContentSlugSchema,
    title: z.string().min(1).max(120),
    body: JsonValueSchema,
    activation: ActivationWindowSchema.nullable().default(null),
    notes: z.string().max(500).default(''),
  }),
);
export type CreateContentDocumentRequest = z.infer<typeof CreateContentDocumentRequestSchema>;

export const TransitionContentDocumentRequestSchema = withIdempotency(
  z.object({
    to: ContentStatusSchema,
    notes: z.string().max(500).default(''),
  }),
);
export type TransitionContentDocumentRequest = z.infer<typeof TransitionContentDocumentRequestSchema>;

/**
 * A rejection, in the shape `packages/content/src/validate.ts` already reports:
 * a dotted path and a sentence. Operators get every problem at once, not the
 * first one — the point of a CMS is that a person can fix the document.
 */
export const ContentIssueSchema = z.object({
  path: z.string().max(240),
  message: z.string().max(400),
});
export type ContentIssue = z.infer<typeof ContentIssueSchema>;

export const ContentValidationResultSchema = z.object({
  valid: z.boolean(),
  issues: z.array(ContentIssueSchema).max(500),
});
export type ContentValidationResult = z.infer<typeof ContentValidationResultSchema>;

/* -------------------------------------------------------------------------- */
/* Releases                                                                    */
/* -------------------------------------------------------------------------- */

export const ContentReleaseReasonValues = ['publish', 'retire', 'rollback'] as const;
export const ContentReleaseReasonSchema = z.enum(ContentReleaseReasonValues);
export type ContentReleaseReason = z.infer<typeof ContentReleaseReasonSchema>;

export const ReleaseEntrySchema = z.object({
  documentId: IdSchema,
  kind: ContentKindSchema,
  slug: ContentSlugSchema,
  version: PositiveIntSchema,
  checksum: z.string().length(64),
});
export type ReleaseEntry = z.infer<typeof ReleaseEntrySchema>;

/**
 * An immutable numbered snapshot of what was live. Releases are append-only:
 * a rollback to release 7 creates release 12 whose entries equal release 7's,
 * so "what was live at 03:14" is always answerable.
 */
export const ContentReleaseSchema = z.object({
  id: IdSchema,
  version: PositiveIntSchema,
  reason: ContentReleaseReasonSchema,
  entries: z.array(ReleaseEntrySchema).max(2000),
  /** Set when `reason` is `rollback`: which release this reproduces. */
  rolledBackFromVersion: PositiveIntSchema.nullable().default(null),
  createdAt: TimestampSchema,
  createdBy: z.string().max(64),
  note: z.string().max(400).default(''),
});
export type ContentRelease = z.infer<typeof ContentReleaseSchema>;

export const RollbackReleaseRequestSchema = withIdempotency(
  z.object({
    toVersion: PositiveIntSchema,
    note: z.string().max(400).default(''),
  }),
);
export type RollbackReleaseRequest = z.infer<typeof RollbackReleaseRequestSchema>;

/* -------------------------------------------------------------------------- */
/* The manifest the client fetches                                             */
/* -------------------------------------------------------------------------- */

export const ManifestDocumentSchema = z.object({
  kind: ContentKindSchema,
  slug: ContentSlugSchema,
  version: PositiveIntSchema,
  checksum: z.string().length(64),
  title: z.string().max(120),
  body: JsonValueSchema,
  activation: ActivationWindowSchema.nullable(),
  /**
   * Whether the window is open **right now, by the server's clock**. The client
   * renders this and does not recompute it; that is the whole point.
   */
  active: z.boolean(),
});
export type ManifestDocument = z.infer<typeof ManifestDocumentSchema>;

export const ContentManifestSchema = z.object({
  /** The release this manifest renders. Monotonic; rollbacks move it forward. */
  releaseVersion: NonNegativeIntSchema,
  /** Server time the activation windows were evaluated at. */
  evaluatedAt: TimestampSchema,
  schemaVersion: SemVerSchema,
  /**
   * Strong validator over release version *and* current activation state, so a
   * seasonal event opening flips the ETag without anybody publishing anything.
   */
  etag: z.string().min(3).max(80),
  documents: z.array(ManifestDocumentSchema).max(2000),
  /** Convenience: the slugs whose windows are open now. */
  activeEventSlugs: z.array(ContentSlugSchema).max(200),
  /**
   * A promise to the client, in the payload, because it is the rule that
   * matters most: this is an overlay on the compiled catalogue, and a client
   * that never reaches this endpoint is a fully working client.
   */
  overlay: z.literal(true),
});
export type ContentManifest = z.infer<typeof ContentManifestSchema>;

/**
 * Live-ops availability, reported like every other credential-gated subsystem:
 * a structured status, never a throw, never a silent no-op.
 */
export const LiveOpsStatusSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ready'), releaseVersion: NonNegativeIntSchema }),
  z.object({
    status: z.literal('not_configured'),
    reason: z.string().max(240),
    /** Reads keep working; only authoring is unavailable. */
    fallback: z.literal('read_only'),
  }),
]);
export type LiveOpsStatus = z.infer<typeof LiveOpsStatusSchema>;
