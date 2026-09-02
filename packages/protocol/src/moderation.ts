import { z } from 'zod';
import { IdSchema, TimestampSchema, withIdempotency } from './common.js';

/** Minimal, honest moderation surface: report a thing, block a person. */
export const ReportTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('account'), accountId: IdSchema }),
  z.object({ kind: z.literal('campsite'), campsiteId: IdSchema }),
  z.object({ kind: z.literal('photo'), photoId: IdSchema }),
  z.object({ kind: z.literal('sandwich'), sandwichId: IdSchema }),
  z.object({ kind: z.literal('note'), noteId: IdSchema }),
  z.object({ kind: z.literal('landmark'), landmarkId: IdSchema }),
]);
export type ReportTarget = z.infer<typeof ReportTargetSchema>;

export const ReportReasonValues = [
  'harassment',
  'hate_speech',
  'sexual_content',
  'violence',
  'self_harm',
  'spam',
  'impersonation',
  'child_safety',
  'other',
] as const;
export const ReportReasonSchema = z.enum(ReportReasonValues);
export type ReportReason = z.infer<typeof ReportReasonSchema>;

export const ReportStateValues = ['open', 'reviewing', 'actioned', 'dismissed'] as const;
export const ReportStateSchema = z.enum(ReportStateValues);
export type ReportState = z.infer<typeof ReportStateSchema>;

export const REPORT_TRANSITIONS: Readonly<Record<ReportState, readonly ReportState[]>> = Object.freeze({
  open: ['reviewing', 'dismissed', 'actioned'],
  reviewing: ['actioned', 'dismissed'],
  actioned: [],
  dismissed: ['reviewing'],
});

export function canTransitionReport(from: ReportState, to: ReportState): boolean {
  return REPORT_TRANSITIONS[from].includes(to);
}

export const ModerationReportSchema = z.object({
  id: IdSchema,
  reporterAccountId: IdSchema,
  target: ReportTargetSchema,
  reason: ReportReasonSchema,
  details: z.string().max(1000).default(''),
  state: ReportStateSchema.default('open'),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  /** Child-safety reports jump the queue and are never auto-dismissed. */
  priority: z.enum(['standard', 'urgent']).default('standard'),
});
export type ModerationReport = z.infer<typeof ModerationReportSchema>;

export const CreateReportRequestSchema = withIdempotency(
  z.object({
    target: ReportTargetSchema,
    reason: ReportReasonSchema,
    details: z.string().max(1000).default(''),
  }),
);
export type CreateReportRequest = z.infer<typeof CreateReportRequestSchema>;

export const BlockSchema = z.object({
  blockerAccountId: IdSchema,
  blockedAccountId: IdSchema,
  createdAt: TimestampSchema,
});
export type Block = z.infer<typeof BlockSchema>;

export const CreateBlockRequestSchema = withIdempotency(
  z.object({ blockedAccountId: IdSchema }),
);
export type CreateBlockRequest = z.infer<typeof CreateBlockRequestSchema>;
