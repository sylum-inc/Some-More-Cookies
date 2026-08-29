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
} from './common.js';
import {
  AuthorityHandoffRequestSchema,
  ConnectionStateSchema,
  AuthorityRecordSchema,
  AuthorityDenialReasonSchema,
  JoinMethodSchema,
  PresenceSchema,
  SessionSchema,
  authorityHandoffDenial,
  type AuthorityDenialReason,
  type AuthorityHandoffRequest,
  type AuthorityRecord,
  type SessionState,
} from './session.js';
import { MemberRoleSchema } from './campsite.js';

/**
 * `@somemore/protocol/realtime` — the WebSocket contract.
 *
 * Per ADR-0006 this wire carries **inputs and authority, never simulation
 * state**. A marshmallow is 32 patches × 6 floats; a `move_marshmallow` intent
 * is three floats and a rotation. Every client runs the same deterministic
 * `@somemore/sim` over the same seed and the same, totally-ordered input
 * stream, so they all arrive at byte-identical marshmallows for free.
 *
 * Three properties make that work:
 *
 *  1. **Total order.** The server stamps every accepted intent with a
 *     `(tick, serverSeq)` pair. `serverSeq` is monotonic per session, so two
 *     intents landing on the same tick still have one agreed order.
 *  2. **Replayability.** The session snapshot is `seed + environmentId +
 *     the entire stamped input history`. Replaying it reconstructs the world
 *     exactly — that is the late-joiner path and, not coincidentally, the
 *     server-side sandwich verification path.
 *  3. **Per-client monotonicity.** Each client numbers its own messages with
 *     `seq`; the server drops anything that does not advance, which makes
 *     retries idempotent and out-of-order delivery harmless.
 *
 * Nothing here imports node built-ins or `@somemore/sim`; the mapping from
 * `InputIntent` to a simulation call lives in the client and in the replay
 * harness, never in the contract.
 */

/* -------------------------------------------------------------------------- */
/* Ticks                                                                       */
/* -------------------------------------------------------------------------- */

/** The wire ticks at the simulation's fixed timestep. Same number as `SIM_DT`. */
export const REALTIME_TICK_HZ = 60;
export const REALTIME_TICK_MS = 1000 / REALTIME_TICK_HZ;

/** Sub-protocol offered in the `Sec-WebSocket-Protocol` header. */
export const REALTIME_SUBPROTOCOL = 'somemore.v1';

/** Default path the transport attaches to. */
export const REALTIME_PATH = '/v1/realtime';

/** How the client may present its bearer token when a header is impossible. */
export const REALTIME_BEARER_SUBPROTOCOL_PREFIX = 'somemore.bearer.';

export const TickSchema = NonNegativeIntSchema;

/** Wall-clock milliseconds → session tick. Ticks never run backwards. */
export function tickAt(sessionOriginMs: number, nowMs: number): number {
  if (!Number.isFinite(sessionOriginMs) || !Number.isFinite(nowMs)) return 0;
  // Multiply rather than divide by the period: `1000 / 60` is not exact in
  // binary, and one tick of drift per second would desynchronise replays.
  const tick = Math.floor(((nowMs - sessionOriginMs) * REALTIME_TICK_HZ) / 1000);
  return tick < 0 ? 0 : tick;
}

/** Session tick → wall-clock milliseconds. */
export function tickToMs(sessionOriginMs: number, tick: number): number {
  return sessionOriginMs + tick * REALTIME_TICK_MS;
}

/* -------------------------------------------------------------------------- */
/* Diegetic arrival and departure                                              */
/* -------------------------------------------------------------------------- */

/**
 * Joining is lobby-less and diegetic (spec §9): nobody pops into existence at
 * the fire. An arrival is a path down the trail with a sound and a silhouette,
 * and the client is given enough to render all of it before the player is
 * anywhere near the ring of light.
 */
export const ApproachStyleValues = ['trail', 'ridge', 'water', 'road', 'treeline'] as const;
export const ApproachStyleSchema = z.enum(ApproachStyleValues);
export type ApproachStyle = z.infer<typeof ApproachStyleSchema>;

export const ApproachSoundValues = ['footsteps', 'twigs', 'gravel', 'paddle', 'bicycle'] as const;
export const ApproachSoundSchema = z.enum(ApproachSoundValues);
export type ApproachSound = z.infer<typeof ApproachSoundSchema>;

export const ArrivalPathSchema = z.object({
  /** World-space waypoints, far → near. The last one is the arrival seat. */
  waypoints: z.array(Vec3Schema).min(2).max(16),
  /** How long the walk takes. Long enough to be noticed, short enough to be polite. */
  durationMs: z.number().int().min(1_000).max(60_000).default(9_000),
  style: ApproachStyleSchema.default('trail'),
  sound: ApproachSoundSchema.default('footsteps'),
  /** A moving flashlight through the trees, before the silhouette resolves. */
  flashlight: z.boolean().default(true),
  /** Milliseconds into the walk at which the silhouette becomes legible. */
  silhouetteAtMs: NonNegativeIntSchema.default(4_000),
});
export type ArrivalPath = z.infer<typeof ArrivalPathSchema>;

export const DepartureMannerValues = ['walk_off', 'immediate', 'dropped'] as const;
export const DepartureMannerSchema = z.enum(DepartureMannerValues);
export type DepartureManner = z.infer<typeof DepartureMannerSchema>;

export const DeparturePathSchema = z.object({
  waypoints: z.array(Vec3Schema).min(2).max(16),
  durationMs: z.number().int().min(500).max(60_000).default(7_000),
  style: ApproachStyleSchema.default('trail'),
  sound: ApproachSoundSchema.default('footsteps'),
  /** A last look back at the fire before the trees take them. */
  glanceBack: z.boolean().default(true),
});
export type DeparturePath = z.infer<typeof DeparturePathSchema>;

/** FNV-1a. Local copy so the contract package keeps depending on nothing. */
function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

const APPROACH_STYLES: readonly ApproachStyle[] = ApproachStyleValues;
const APPROACH_SOUNDS: readonly ApproachSound[] = ApproachSoundValues;

/**
 * A deterministic approach for a player who did not send one.
 *
 * Derived from the campsite seed and the account id, so the same friend always
 * comes down the same trail — arrivals become recognisable, which is the whole
 * point of not using a lobby.
 */
export function defaultApproachPath(seed: number, accountId: string): ArrivalPath {
  const h = hash32(`${seed >>> 0}:${accountId}`);
  const angle = ((h % 3600) / 3600) * Math.PI * 2;
  const far = 26 + ((h >>> 12) % 9);
  const style = APPROACH_STYLES[h % APPROACH_STYLES.length] ?? 'trail';
  const sound = APPROACH_SOUNDS[(h >>> 5) % APPROACH_SOUNDS.length] ?? 'footsteps';
  const waypoints = [1, 0.62, 0.34, 0.12].map((t, index) => {
    // A slight sway so the walk reads as a person, not a dolly track.
    const sway = Math.sin(angle * 3 + index) * 1.4 * t;
    return {
      x: Math.cos(angle) * far * t + sway,
      y: 0,
      z: Math.sin(angle) * far * t - sway,
    };
  });
  return {
    waypoints,
    durationMs: 7_000 + ((h >>> 3) % 4_000),
    style,
    sound,
    flashlight: (h & 1) === 1,
    silhouetteAtMs: 3_500 + ((h >>> 7) % 2_000),
  };
}

/** The mirror image: a departure that walks back up the same trail. */
export function departurePathFrom(arrival: ArrivalPath): DeparturePath {
  return {
    waypoints: [...arrival.waypoints].reverse(),
    durationMs: Math.max(500, Math.round(arrival.durationMs * 0.8)),
    style: arrival.style,
    sound: arrival.sound,
    glanceBack: true,
  };
}

/* -------------------------------------------------------------------------- */
/* Input intents — the small stream                                            */
/* -------------------------------------------------------------------------- */

export const GestureValues = [
  'wave',
  'high_five',
  'fist_bump',
  'sit',
  'stand',
  'point',
  'applaud',
  'toss_stick',
  'offer_food',
  'photograph',
] as const;
export const GestureSchema = z.enum(GestureValues);
export type Gesture = z.infer<typeof GestureSchema>;

/** Fire tending. Note what is *absent*: there is no way to put a fire out. */
export const TendFireActionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('add_log'),
    woodId: z.string().min(1).max(32).regex(/^[a-z0-9_]+$/),
    placement: UnitIntervalSchema.default(0.6),
  }),
  z.object({ action: z.literal('rake') }),
  z.object({ action: z.literal('fan'), strength: UnitIntervalSchema.default(1) }),
]);
export type TendFireAction = z.infer<typeof TendFireActionSchema>;

/** SM-01 panel controls. One control per intent — the machine is operated, not commanded. */
export const MachineControlValues = [
  'load',
  'close_door',
  'engage_latch',
  'set_program',
  'confirm',
  'pull_lever',
  'release_latch',
  'open_door',
  'take_sandwich',
  'reset',
] as const;
export const MachineControlSchema = z.enum(MachineControlValues);
export type MachineControl = z.infer<typeof MachineControlSchema>;

/**
 * The SM-01's front dial, as the *machine* names its settings. Distinct from
 * `MachineProgram` in the sandwich record, which is the catalogue name the
 * finished run is filed under.
 */
export const MachineDialProgramValues = ['standard', 'soft-set', 'deep-freeze'] as const;
export const MachineDialProgramSchema = z.enum(MachineDialProgramValues);
export type MachineDialProgram = z.infer<typeof MachineDialProgramSchema>;

export const ComponentKindSchema = z.enum(['graham-bottom', 'chocolate', 'marshmallow', 'graham-top']);

export const InputIntentKindValues = [
  'move_marshmallow',
  'blow_out',
  'begin_roast',
  'finish_roast',
  'tend_fire',
  'hold_component',
  'move_component',
  'place_component',
  'machine_control',
  'move_prop',
  'gesture',
] as const;
export const InputIntentKindSchema = z.enum(InputIntentKindValues);
export type InputIntentKind = z.infer<typeof InputIntentKindSchema>;

/**
 * Every intent a player can express.
 *
 * The anti-grief guarantee (spec §9) is structural rather than policed: an
 * intent either names an `objectId` — in which case the sender must hold
 * authority over it — or it names nothing at all. No intent takes another
 * player's object, resets another player's run, or destroys work in progress,
 * because no such message exists to send. `targetAccountId` appears on exactly
 * one intent kind, `gesture`, and a gesture cannot change the world.
 */
export const InputIntentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('move_marshmallow'),
    objectId: IdSchema,
    position: Vec3Schema,
    rotation: z.number().finite(),
    blow: UnitIntervalSchema.default(0),
  }),
  z.object({ kind: z.literal('blow_out'), objectId: IdSchema }),
  z.object({ kind: z.literal('begin_roast'), objectId: IdSchema }),
  z.object({ kind: z.literal('finish_roast'), objectId: IdSchema }),
  z.object({ kind: z.literal('tend_fire'), action: TendFireActionSchema }),
  z.object({ kind: z.literal('hold_component'), component: ComponentKindSchema.nullable().default(null) }),
  z.object({ kind: z.literal('move_component'), offset: Vec3Schema, rotation: z.number().finite() }),
  z.object({ kind: z.literal('place_component') }),
  z.object({
    kind: z.literal('machine_control'),
    objectId: IdSchema,
    control: MachineControlSchema,
    program: MachineDialProgramSchema.optional(),
  }),
  z.object({
    kind: z.literal('move_prop'),
    objectId: IdSchema,
    position: Vec3Schema,
    rotationY: z.number().finite(),
  }),
  z.object({
    kind: z.literal('gesture'),
    gesture: GestureSchema,
    targetAccountId: IdSchema.nullable().default(null),
  }),
]);
export type InputIntent = z.infer<typeof InputIntentSchema>;

/**
 * Verbs that deliberately do not exist on this wire. Kept as data so the
 * guarantee is testable rather than a comment somebody deletes later.
 */
export const NON_EXPRESSIBLE_INTENTS: readonly string[] = Object.freeze([
  'take_from_player',
  'steal_object',
  'knock_over',
  'shove_player',
  'push_player',
  'destroy_object',
  'discard_other',
  'douse_fire',
  'scatter_embers',
  'abort_other_run',
  'reset_other_machine',
  'remove_component',
  'drop_other_object',
  'eat_other_sandwich',
]);

export function isExpressibleIntentKind(kind: string): kind is InputIntentKind {
  return (InputIntentKindValues as readonly string[]).includes(kind);
}

/** The object an intent manipulates, or `null` if it touches no owned object. */
export function intentObjectId(intent: InputIntent): string | null {
  return 'objectId' in intent ? intent.objectId : null;
}

/** The player an intent is aimed at. Only ever set for gestures. */
export function intentTargetAccountId(intent: InputIntent): string | null {
  return intent.kind === 'gesture' ? intent.targetAccountId : null;
}

/**
 * Whether the sender must hold authority over `intentObjectId` for this intent
 * to be accepted. Shared, so the client can grey out the control instead of
 * letting the player try and be refused.
 */
export function intentRequiresAuthority(intent: InputIntent): boolean {
  return intentObjectId(intent) !== null;
}

/**
 * Whether an intent touches shared state that somebody else may be mid-way
 * through. These are legal — tending the fire together is the point — but they
 * are the actions worth rate-limiting when they are repeated at somebody
 * (spec §9: "a short cooldown on repeated interference").
 */
export function isInterferenceProne(intent: InputIntent): boolean {
  return intent.kind === 'tend_fire' || intent.kind === 'move_prop' || intent.kind === 'machine_control';
}

/* -------------------------------------------------------------------------- */
/* Stamped inputs and history                                                  */
/* -------------------------------------------------------------------------- */

/**
 * An intent after the server has placed it in the session's timeline.
 *
 * `(tick, serverSeq)` is a total order: replaying the history sorted by that
 * pair reproduces the session exactly, on any client, on any device.
 */
export const StampedInputSchema = z.object({
  /** Session tick the intent applies on. */
  tick: TickSchema,
  /** Monotonic across the whole session; the tie-break within a tick. */
  serverSeq: NonNegativeIntSchema,
  accountId: IdSchema,
  /** The sender's own monotonic counter, echoed for client-side reconciliation. */
  clientSeq: NonNegativeIntSchema,
  intent: InputIntentSchema,
});
export type StampedInput = z.infer<typeof StampedInputSchema>;

/** Ordering used by both the server's history and every client's replay. */
export function compareStampedInputs(a: StampedInput, b: StampedInput): number {
  return a.tick === b.tick ? a.serverSeq - b.serverSeq : a.tick - b.tick;
}

/**
 * Hard ceiling on retained history. Past this the session can no longer offer
 * an exact reconstruction and says so (`truncated`) rather than handing a late
 * joiner a subtly wrong world.
 */
export const MAX_INPUT_HISTORY = 60_000;

/* -------------------------------------------------------------------------- */
/* Participants                                                                */
/* -------------------------------------------------------------------------- */

export const ParticipantSchema = z.object({
  accountId: IdSchema,
  role: MemberRoleSchema,
  presence: PresenceSchema,
  joinedAtTick: TickSchema,
  /** How they walked in, so a mid-session observer can still render the trail. */
  arrival: ArrivalPathSchema.nullable().default(null),
  /** Set once the player is inside the ring of light and interactive. */
  settled: z.boolean().default(false),
});
export type Participant = z.infer<typeof ParticipantSchema>;

/* -------------------------------------------------------------------------- */
/* Voice                                                                       */
/* -------------------------------------------------------------------------- */

export const VoiceModeValues = ['open_mic', 'push_to_talk', 'off'] as const;
export const VoiceModeSchema = z.enum(VoiceModeValues);
export type VoiceMode = z.infer<typeof VoiceModeSchema>;

export const VoiceParticipantSchema = z.object({
  accountId: IdSchema,
  identity: z.string().min(1).max(128),
  muted: z.boolean().default(true),
  speaking: z.boolean().default(false),
  /** Listener-side gain, 0..1, set per player by whoever is listening. */
  volume: UnitIntervalSchema.default(1),
  blocked: z.boolean().default(false),
});
export type VoiceParticipant = z.infer<typeof VoiceParticipantSchema>;

/**
 * Proximity attenuation. Voice is spatial: full volume inside the ring of
 * light, rolling off to nothing past the treeline.
 */
export const VoiceProximitySchema = z.object({
  /** Metres within which there is no attenuation at all. */
  fullVolumeRadiusM: z.number().min(0).max(50).default(2.5),
  /** Metres past which a speaker is inaudible. */
  cutoffRadiusM: z.number().min(0.5).max(200).default(18),
  rolloff: z.enum(['linear', 'inverse', 'exponential']).default('inverse'),
});
export type VoiceProximity = z.infer<typeof VoiceProximitySchema>;

export const DEFAULT_VOICE_PROXIMITY: VoiceProximity = Object.freeze({
  fullVolumeRadiusM: 2.5,
  cutoffRadiusM: 18,
  rolloff: 'inverse',
});

/** Pure gain curve — the client and the SFU-side mixer must agree exactly. */
export function proximityGain(distanceM: number, proximity: VoiceProximity = DEFAULT_VOICE_PROXIMITY): number {
  if (!Number.isFinite(distanceM) || distanceM <= proximity.fullVolumeRadiusM) return 1;
  if (distanceM >= proximity.cutoffRadiusM) return 0;
  const span = proximity.cutoffRadiusM - proximity.fullVolumeRadiusM;
  const t = (distanceM - proximity.fullVolumeRadiusM) / (span <= 0 ? 1 : span);
  switch (proximity.rolloff) {
    case 'linear':
      return 1 - t;
    case 'exponential':
      return (1 - t) ** 2.2;
    default:
      return (1 - t) / (1 + 3 * t);
  }
}

export const VoiceRoomStatusValues = ['ready', 'not_configured', 'unavailable'] as const;
export const VoiceRoomStatusSchema = z.enum(VoiceRoomStatusValues);
export type VoiceRoomStatus = z.infer<typeof VoiceRoomStatusSchema>;

export const VoiceRoomInfoSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    provider: z.string().min(1).max(40),
    roomName: z.string().min(1).max(128),
    url: z.string().min(1).max(512),
    token: z.string().min(1).max(4096),
    expiresAt: TimestampSchema,
    mode: VoiceModeSchema.default('push_to_talk'),
    proximity: VoiceProximitySchema,
    /** Never `true`. Present so clients can display the guarantee, not a setting. */
    recording: z.literal(false),
    participants: z.array(VoiceParticipantSchema).max(32).default([]),
  }),
  z.object({
    status: z.literal('not_configured'),
    provider: z.string().min(1).max(40),
    /** Human-readable "what is missing", surfaced in the settings panel. */
    reason: z.string().max(240),
    /** Fireside carries on without voice; nothing hard-fails (ARCHITECTURE §1.5). */
    fallback: z.literal('text_and_gesture'),
  }),
  z.object({
    status: z.literal('unavailable'),
    provider: z.string().min(1).max(40),
    reason: z.string().max(240),
    fallback: z.literal('text_and_gesture'),
  }),
]);
export type VoiceRoomInfo = z.infer<typeof VoiceRoomInfoSchema>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const RealtimeErrorCodeValues = [
  'unauthorized',
  'forbidden',
  'not_found',
  'invalid_message',
  'unsupported_version',
  'sequence_stale',
  'no_authority',
  'authority_denied',
  'rate_limited',
  'interference_cooldown',
  'payload_too_large',
  'session_not_active',
  'not_joined',
  'already_joined',
  'blocked',
  'voice_not_configured',
  'history_truncated',
  'internal_error',
] as const;
export const RealtimeErrorCodeSchema = z.enum(RealtimeErrorCodeValues);
export type RealtimeErrorCode = z.infer<typeof RealtimeErrorCodeSchema>;

/** WebSocket close codes this transport uses, beyond the RFC 6455 basics. */
export const REALTIME_CLOSE = Object.freeze({
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupportedData: 1003,
  invalidPayload: 1007,
  policyViolation: 1008,
  messageTooBig: 1009,
  internalError: 1011,
  tryAgainLater: 1013,
});

/* -------------------------------------------------------------------------- */
/* Client → server                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Presence update. Identical in shape to the HTTP heartbeat so the two paths
 * cannot drift; over the socket it is sent continuously rather than polled.
 */
export const RealtimePresenceSchema = z.object({
  connection: ConnectionStateSchema.default('connected'),
  position: Vec3Schema.optional(),
  facingY: z.number().min(-Math.PI * 2).max(Math.PI * 2).optional(),
  activity: PresenceSchema.shape.activity.optional(),
  micMuted: z.boolean().optional(),
});
export type RealtimePresenceUpdate = z.infer<typeof RealtimePresenceSchema>;

const ClientBase = { seq: NonNegativeIntSchema };

export const ClientMessageSchema = z.discriminatedUnion('t', [
  /** Always the first message. Carries the privacy proof for a non-member. */
  z.object({
    ...ClientBase,
    t: z.literal('join'),
    sessionId: IdSchema,
    schemaVersion: SemVerSchema,
    /** Membership proof for someone who is not yet a member of the campsite. */
    join: JoinMethodSchema.optional(),
    /** How the player would like to walk in. Server-generated when omitted. */
    approach: ArrivalPathSchema.optional(),
    /** Reconnecting: only send history from this tick on. */
    sinceTick: TickSchema.optional(),
    voice: VoiceModeSchema.default('push_to_talk'),
  }),
  z.object({ ...ClientBase, t: z.literal('input'), intent: InputIntentSchema }),
  z.object({ ...ClientBase, t: z.literal('authority'), request: AuthorityHandoffRequestSchema }),
  z.object({ ...ClientBase, t: z.literal('presence'), presence: RealtimePresenceSchema }),
  z.object({ ...ClientBase, t: z.literal('chat'), text: z.string().min(1).max(280) }),
  z.object({ ...ClientBase, t: z.literal('block'), accountId: IdSchema }),
  z.object({ ...ClientBase, t: z.literal('unblock'), accountId: IdSchema }),
  z.object({
    ...ClientBase,
    t: z.literal('voice'),
    op: z.enum(['join', 'refresh', 'set_mode', 'set_muted', 'set_volume', 'leave']),
    mode: VoiceModeSchema.optional(),
    muted: z.boolean().optional(),
    /** Per-player listener volume; `accountId` is whose voice is being adjusted. */
    accountId: IdSchema.optional(),
    volume: UnitIntervalSchema.optional(),
  }),
  /** Leave. `walk_off` keeps the silhouette on the trail for a few seconds. */
  z.object({
    ...ClientBase,
    t: z.literal('depart'),
    manner: z.enum(['walk_off', 'immediate']).default('walk_off'),
    path: DeparturePathSchema.optional(),
  }),
  /** Application-level liveness probe, distinct from the RFC 6455 ping frame. */
  z.object({ ...ClientBase, t: z.literal('ping'), clientTimeMs: NonNegativeIntSchema.optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type ClientMessageType = ClientMessage['t'];

/* -------------------------------------------------------------------------- */
/* Server → client                                                             */
/* -------------------------------------------------------------------------- */

export const RealtimeLimitsSchema = z.object({
  maxMessageBytes: PositiveIntSchema,
  messagesPerSecond: PositiveIntSchema,
  messageBurst: PositiveIntSchema,
  inputsPerSecond: PositiveIntSchema,
  chatPerMinute: PositiveIntSchema,
  authorityRequestsPerMinute: PositiveIntSchema,
  interferencePerMinute: PositiveIntSchema,
  interferenceCooldownMs: PositiveIntSchema,
  connectionsPerAccount: PositiveIntSchema,
  maxInputHistory: PositiveIntSchema,
  /** Mutual-hold window on a hand-off, in ticks. */
  mutualHoldTicks: PositiveIntSchema,
});
export type RealtimeLimits = z.infer<typeof RealtimeLimitsSchema>;

export const ServerMessageSchema = z.discriminatedUnion('t', [
  z.object({
    t: z.literal('welcome'),
    tick: TickSchema,
    serverTimeMs: z.number().int(),
    /** Epoch ms of tick 0. Everything on this wire is relative to it. */
    sessionOriginMs: z.number().int(),
    accountId: IdSchema,
    connectionId: IdSchema,
    schemaVersion: SemVerSchema,
    session: SessionSchema,
    limits: RealtimeLimitsSchema,
  }),
  /**
   * Everything a late joiner needs to reconstruct the world exactly: the seed,
   * the environment, and the ordered input history (ADR-0006). No simulation
   * state crosses this wire — not one patch temperature.
   */
  z.object({
    t: z.literal('snapshot'),
    tick: TickSchema,
    sessionId: IdSchema,
    campsiteId: IdSchema,
    seed: SeedSchema,
    environmentId: z.string().min(1).max(64),
    /** First tick covered by `inputs`. 0 unless the history was trimmed. */
    fromTick: TickSchema,
    inputs: z.array(StampedInputSchema),
    authority: z.array(AuthorityRecordSchema),
    participants: z.array(ParticipantSchema),
    /** True when history was trimmed and reconstruction is no longer exact. */
    truncated: z.boolean().default(false),
  }),
  /** Somebody's intent, already stamped into the timeline. */
  z.object({ t: z.literal('input'), stamped: StampedInputSchema }),
  /** Your own message was accepted; `tick` is where it landed. */
  z.object({ t: z.literal('ack'), seq: NonNegativeIntSchema, tick: TickSchema, serverSeq: NonNegativeIntSchema }),
  z.object({
    t: z.literal('authority'),
    tick: TickSchema,
    record: AuthorityRecordSchema,
    reason: z.enum(['grab', 'release', 'give', 'timeout', 'disconnect', 'host_override']),
    /**
     * During a hand-off both players hold the object briefly so it is carried
     * across rather than teleported. Inputs from either are relayed until this
     * tick passes.
     */
    mutualHoldUntilTick: TickSchema.nullable().default(null),
    mutualHolders: z.array(IdSchema).max(2).default([]),
  }),
  z.object({
    t: z.literal('authority_denied'),
    tick: TickSchema,
    seq: NonNegativeIntSchema,
    reason: AuthorityDenialReasonSchema,
    current: AuthorityRecordSchema,
  }),
  z.object({ t: z.literal('authority_expired'), tick: TickSchema, record: AuthorityRecordSchema }),
  z.object({ t: z.literal('presence'), tick: TickSchema, presence: PresenceSchema }),
  /** Footsteps on the trail. Sent to everyone already at the fire. */
  z.object({ t: z.literal('arrival'), tick: TickSchema, participant: ParticipantSchema, path: ArrivalPathSchema }),
  /** They walked off down the trail, or the network took them. */
  z.object({
    t: z.literal('departure'),
    tick: TickSchema,
    accountId: IdSchema,
    manner: DepartureMannerSchema,
    path: DeparturePathSchema.nullable().default(null),
    releasedObjectIds: z.array(IdSchema).default([]),
  }),
  z.object({ t: z.literal('chat'), tick: TickSchema, fromAccountId: IdSchema, text: z.string().max(280) }),
  z.object({ t: z.literal('voice'), tick: TickSchema, room: VoiceRoomInfoSchema }),
  z.object({ t: z.literal('pong'), tick: TickSchema, serverTimeMs: z.number().int(), clientTimeMs: NonNegativeIntSchema.nullable().default(null) }),
  z.object({
    t: z.literal('error'),
    code: RealtimeErrorCodeSchema,
    message: z.string().max(400),
    /** The client `seq` that caused it, when there was one. */
    seq: NonNegativeIntSchema.nullable().default(null),
    /** Milliseconds until the client may retry, for the rate-limit codes. */
    retryAfterMs: NonNegativeIntSchema.nullable().default(null),
  }),
]);
export type ServerMessage = z.infer<typeof ServerMessageSchema>;
export type ServerMessageType = ServerMessage['t'];

/* -------------------------------------------------------------------------- */
/* Authority over the wire                                                     */
/* -------------------------------------------------------------------------- */

/** A lease that has run out is as good as unheld (ARCHITECTURE §6). */
export function isAuthorityExpired(record: AuthorityRecord, nowIso: string): boolean {
  if (record.holderAccountId === null) return true;
  return record.expiresAt !== null && record.expiresAt <= nowIso;
}

/**
 * The realtime addition to {@link authorityHandoffDenial}: you cannot take a
 * live object out of somebody's hands, and neither can the host by accident.
 *
 * The HTTP domain rule lets a host move anything, which is right for
 * moderation; over the realtime wire that has to be *deliberate*, so a plain
 * `grab` aimed at an unexpired holder is refused for everyone and the host must
 * say `host_override`. Spec §9: "authority cannot be stolen from an active
 * holder".
 */
export function snatchDenial(input: {
  record: AuthorityRecord;
  requesterAccountId: string;
  reason: AuthorityHandoffRequest['reason'];
  nowIso: string;
}): AuthorityDenialReason | null {
  const { record, requesterAccountId, reason, nowIso } = input;
  if (reason === 'host_override' || reason === 'timeout' || reason === 'disconnect') return null;
  if (record.holderAccountId === null) return null;
  if (record.holderAccountId === requesterAccountId) return null;
  return isAuthorityExpired(record, nowIso) ? null : 'not_holder';
}

/**
 * The single decision function for a realtime hand-off: the shared protocol
 * rule plus the anti-snatch guard. The client predicts with this; the server
 * enforces with this. Neither re-implements the other.
 */
export function realtimeAuthorityDenial(input: {
  record: AuthorityRecord;
  requesterAccountId: string;
  request: Pick<AuthorityHandoffRequest, 'expectedSequence' | 'reason' | 'toAccountId'>;
  requesterIsHost: boolean;
  requesterIsMember: boolean;
  targetIsPresent: boolean;
  sessionState: SessionState;
  nowIso: string;
}): AuthorityDenialReason | null {
  const snatch = snatchDenial({
    record: input.record,
    requesterAccountId: input.requesterAccountId,
    reason: input.request.reason,
    nowIso: input.nowIso,
  });
  if (snatch !== null) return snatch;
  return authorityHandoffDenial(input);
}

/**
 * Who may drive an object right now. Normally exactly the holder; during a
 * hand-off's mutual-hold window, both the giver and the receiver, so the
 * roasting stick is carried across rather than snapping to the new hand.
 */
export function authorizedDrivers(
  record: AuthorityRecord,
  mutualHold: { fromAccountId: string; toAccountId: string; untilTick: number } | null,
  tick: number,
): readonly string[] {
  const drivers: string[] = [];
  if (record.holderAccountId !== null) drivers.push(record.holderAccountId);
  if (mutualHold !== null && tick <= mutualHold.untilTick) {
    for (const id of [mutualHold.fromAccountId, mutualHold.toAccountId]) {
      if (!drivers.includes(id)) drivers.push(id);
    }
  }
  return drivers;
}

/** Default mutual-hold window: ~250 ms, long enough to see the pass. */
export const DEFAULT_MUTUAL_HOLD_TICKS = 15;
