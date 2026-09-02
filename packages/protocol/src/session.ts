import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  TimestampSchema,
  Vec3Schema,
  withIdempotency,
} from './common.js';
import { CampCodeSchema, MemberRoleSchema } from './campsite.js';

/* -------------------------------------------------------------------------- */
/* Joining                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Three ways to arrive at somebody's fire. All three resolve to the same
 * invite record server-side; the QR payload is just a wrapped link token.
 */
export const JoinMethodSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('invite_link'), token: z.string().min(16).max(128) }),
  z.object({ method: z.literal('camp_code'), code: CampCodeSchema }),
  z.object({ method: z.literal('qr'), payload: z.string().min(16).max(512) }),
]);
export type JoinMethod = z.infer<typeof JoinMethodSchema>;

export const JoinCampsiteRequestSchema = withIdempotency(
  z.object({
    join: JoinMethodSchema,
    device: z.object({ deviceId: z.string().min(8).max(128) }).optional(),
  }),
);
export type JoinCampsiteRequest = z.infer<typeof JoinCampsiteRequestSchema>;

/** QR payloads are `somemore://join?t=<token>`; parsed on the server. */
export const QR_JOIN_PREFIX = 'somemore://join?t=';

export function parseQrJoinPayload(payload: string): string | null {
  if (!payload.startsWith(QR_JOIN_PREFIX)) return null;
  const token = payload.slice(QR_JOIN_PREFIX.length);
  return token.length >= 16 ? token : null;
}

/* -------------------------------------------------------------------------- */
/* Sessions & presence                                                         */
/* -------------------------------------------------------------------------- */

export const SessionStateValues = ['lobby', 'active', 'ending', 'ended'] as const;
export const SessionStateSchema = z.enum(SessionStateValues);
export type SessionState = z.infer<typeof SessionStateSchema>;

export const SESSION_TRANSITIONS: Readonly<Record<SessionState, readonly SessionState[]>> = Object.freeze({
  lobby: ['active', 'ended'],
  active: ['ending', 'ended'],
  ending: ['ended'],
  ended: [],
});

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from].includes(to);
}

export const ConnectionStateValues = ['connecting', 'connected', 'idle', 'disconnected'] as const;
export const ConnectionStateSchema = z.enum(ConnectionStateValues);
export type ConnectionState = z.infer<typeof ConnectionStateSchema>;

export const PresenceSchema = z.object({
  accountId: IdSchema,
  sessionId: IdSchema,
  connection: ConnectionStateSchema,
  joinedAt: TimestampSchema,
  lastHeartbeatAt: TimestampSchema,
  role: MemberRoleSchema,
  position: Vec3Schema.nullable().default(null),
  facingY: z.number().min(-Math.PI * 2).max(Math.PI * 2).default(0),
  /** What the player is doing right now — drives nameplates and audio ducking. */
  activity: z
    .enum(['idle', 'roasting', 'assembling', 'machine', 'photographing', 'eating', 'browsing_shop'])
    .default('idle'),
  micMuted: z.boolean().default(true),
});
export type Presence = z.infer<typeof PresenceSchema>;

export const SessionSchema = z.object({
  id: IdSchema,
  campsiteId: IdSchema,
  hostAccountId: IdSchema,
  state: SessionStateSchema,
  startedAt: TimestampSchema,
  endedAt: TimestampSchema.nullable().default(null),
  maxMembers: PositiveIntSchema.max(16).default(8),
  presence: z.array(PresenceSchema).default([]),
  /** Monotonic counter; every authority change bumps it. */
  authorityEpoch: NonNegativeIntSchema.default(0),
});
export type Session = z.infer<typeof SessionSchema>;

export const CreateSessionRequestSchema = withIdempotency(
  z.object({
    maxMembers: PositiveIntSchema.max(16).default(8),
  }),
);
export type CreateSessionRequest = z.infer<typeof CreateSessionRequestSchema>;

export const HeartbeatRequestSchema = z.object({
  connection: ConnectionStateSchema.default('connected'),
  position: Vec3Schema.optional(),
  facingY: z.number().min(-Math.PI * 2).max(Math.PI * 2).optional(),
  activity: PresenceSchema.shape.activity.optional(),
  micMuted: z.boolean().optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Shared-object authority                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Exactly one participant simulates each shared object at a time. Authority is
 * a server-arbitrated lease: the holder owns the object's physics until they
 * release it, hand it off, time out, or drop their connection.
 */
export const AuthorityObjectKindValues = [
  'marshmallow',
  'skewer',
  'sm01',
  'sandwich',
  'camera',
  'firewood',
  'prop',
] as const;
export const AuthorityObjectKindSchema = z.enum(AuthorityObjectKindValues);
export type AuthorityObjectKind = z.infer<typeof AuthorityObjectKindSchema>;

export const AuthorityRecordSchema = z.object({
  sessionId: IdSchema,
  objectId: IdSchema,
  objectKind: AuthorityObjectKindSchema,
  holderAccountId: IdSchema.nullable(),
  grantedAt: TimestampSchema,
  expiresAt: TimestampSchema.nullable().default(null),
  /** Fencing token. A hand-off must present the sequence it believes is current. */
  sequence: NonNegativeIntSchema,
  /** Locked objects only move on host override (e.g. the SM-01 mid-run). */
  locked: z.boolean().default(false),
});
export type AuthorityRecord = z.infer<typeof AuthorityRecordSchema>;

export const AuthorityHandoffReasonValues = [
  'grab',
  'release',
  'give',
  'timeout',
  'disconnect',
  'host_override',
] as const;
export const AuthorityHandoffReasonSchema = z.enum(AuthorityHandoffReasonValues);
export type AuthorityHandoffReason = z.infer<typeof AuthorityHandoffReasonSchema>;

export const AuthorityHandoffRequestSchema = z.object({
  objectId: IdSchema,
  objectKind: AuthorityObjectKindSchema,
  /** `null` releases the object back to the world. */
  toAccountId: IdSchema.nullable(),
  reason: AuthorityHandoffReasonSchema,
  /** Fencing: must equal the server's current sequence or the call is stale. */
  expectedSequence: NonNegativeIntSchema,
  leaseSeconds: PositiveIntSchema.max(600).default(60),
});
export type AuthorityHandoffRequest = z.infer<typeof AuthorityHandoffRequestSchema>;

export const AuthorityDenialReasonValues = [
  'not_holder',
  'sequence_stale',
  'not_a_member',
  'object_locked',
  'target_not_present',
  'session_not_active',
] as const;
export const AuthorityDenialReasonSchema = z.enum(AuthorityDenialReasonValues);
export type AuthorityDenialReason = z.infer<typeof AuthorityDenialReasonSchema>;

export const AuthorityHandoffResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('granted'), record: AuthorityRecordSchema }),
  z.object({
    status: z.literal('denied'),
    reason: AuthorityDenialReasonSchema,
    current: AuthorityRecordSchema,
  }),
]);
export type AuthorityHandoffResult = z.infer<typeof AuthorityHandoffResultSchema>;

/**
 * Legality of a hand-off, expressed as a pure function so the client can
 * predict the answer and the server can enforce it with the same rules.
 */
export function authorityHandoffDenial(input: {
  record: AuthorityRecord;
  requesterAccountId: string;
  request: Pick<AuthorityHandoffRequest, 'expectedSequence' | 'reason' | 'toAccountId'>;
  requesterIsHost: boolean;
  requesterIsMember: boolean;
  targetIsPresent: boolean;
  sessionState: SessionState;
}): AuthorityDenialReason | null {
  const { record, requesterAccountId, request } = input;
  if (!input.requesterIsMember) return 'not_a_member';
  if (input.sessionState !== 'active' && input.sessionState !== 'lobby') return 'session_not_active';
  if (request.expectedSequence !== record.sequence) return 'sequence_stale';
  if (record.locked && !input.requesterIsHost && request.reason !== 'host_override') return 'object_locked';
  if (request.reason === 'host_override' && !input.requesterIsHost) return 'not_holder';
  const unheld = record.holderAccountId === null;
  const isHolder = record.holderAccountId === requesterAccountId;
  if (!unheld && !isHolder && !input.requesterIsHost && request.reason !== 'timeout' && request.reason !== 'disconnect') {
    return 'not_holder';
  }
  if (request.toAccountId !== null && !input.targetIsPresent) return 'target_not_present';
  return null;
}
