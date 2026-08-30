import { z } from 'zod';
import { IdSchema, NonNegativeIntSchema, TimestampSchema, withIdempotency } from './common.js';

/**
 * Campsite memory on the wire (spec §6.3, §6.4).
 *
 * A campsite that remembers you is device-local until this contract exists:
 * lose the phone and every place that had met you has never met you. This is
 * the shape that survives that, and the shape is deliberately narrow.
 *
 * **The significance score is not here, and there is nowhere to put it.**
 * §6.4 is not a promise this file makes, it is a fact about this file:
 *
 *  - A synced trace carries `disposition` and nothing numeric but a timestamp.
 *    The lifetime is *derived* from the disposition (see
 *    `TRACE_LIFETIME_SECONDS`), so there is no float on the wire that could be
 *    a score wearing a duration's clothes.
 *  - `fade` is not a member of `SyncedTraceDispositionSchema`. A trace the
 *    model decided to let go is not expressible here, which is the same rule
 *    the client already applies locally, enforced by the schema rather than by
 *    a filter somebody could forget.
 *  - The sim's free-form `payload` does **not** cross. It is the evidence the
 *    model weighed — rarity, dwell, interaction counts — and a free-form
 *    record is precisely where a score would hide. Everything in it that
 *    matters to a returning player is already carried by `secrets` and
 *    `residents`, which are facts about the place rather than opinions about
 *    the player.
 *
 * `.strict()` on the trace object is load-bearing: an unknown key is a
 * rejected request, not a silently stripped field. A future build that tries
 * to smuggle one through gets a 422 instead of a quiet success.
 */

/* -------------------------------------------------------------------------- */
/* Traces                                                                      */
/* -------------------------------------------------------------------------- */

/** Mirrors `TraceKind` in `@somemore/sim`; a closed set, never free text. */
export const SyncedTraceKindValues = [
  'moved-object',
  'photo',
  'discovery',
  'note',
  'machine-run',
  'wildlife-encounter',
  'environmental',
  'sandwich',
  'visitor',
  'world-event',
] as const;
export const SyncedTraceKindSchema = z.enum(SyncedTraceKindValues);
export type SyncedTraceKind = z.infer<typeof SyncedTraceKindSchema>;

/**
 * The three dispositions worth carrying anywhere.
 *
 * The sim has a fourth, `fade`, and its absence here is the point: a faded
 * trace is a thing that happened tonight and is not a thing the Passport
 * carries forward.
 */
export const SyncedTraceDispositionValues = ['keep', 'passport', 'landmark'] as const;
export const SyncedTraceDispositionSchema = z.enum(SyncedTraceDispositionValues);
export type SyncedTraceDisposition = z.infer<typeof SyncedTraceDispositionSchema>;

const DAY = 86_400;

/**
 * How long each disposition lives, in seconds. `null` means "does not fade".
 *
 * This mirrors `decideTrace` in `@somemore/sim`, which is the only place the
 * decision is made. It is duplicated here rather than imported because the
 * protocol depends on nothing, and `packages/protocol/test/memory.test.ts`
 * pins it against the simulation's own output — so a drift is a red test
 * rather than a campsite that forgets three months early.
 */
export const TRACE_LIFETIME_SECONDS: Readonly<Record<SyncedTraceDisposition, number | null>> =
  Object.freeze({
    keep: 14 * DAY,
    passport: 90 * DAY,
    landmark: null,
  });

/**
 * A trace, as it crosses the wire.
 *
 * Four fields. One of them is a timestamp and the rest are identifiers and a
 * three-valued enum. Compare `DiscoveryOutcome`, which has nowhere to put a
 * reward: this has nowhere to put a score.
 */
export const SyncedTraceSchema = z
  .object({
    /**
     * The sim's own trace id, e.g. `secret:tin` or `wildlife:fox-1:4200`.
     * Stable across devices, which is what makes the merge a union by id.
     *
     * Deliberately narrower than "URL-safe": no slashes, so an id can never be
     * mistaken for a path by anything downstream that concatenates one.
     */
    id: z
      .string()
      .min(1)
      .max(128)
      .regex(/^[A-Za-z0-9_.:-]+$/, 'trace ids are opaque, and never path-shaped')
      .refine((value) => !value.includes('..'), 'trace ids may not traverse'),
    kind: SyncedTraceKindSchema,
    createdAt: TimestampSchema,
    disposition: SyncedTraceDispositionSchema,
  })
  .strict();
export type SyncedTrace = z.infer<typeof SyncedTraceSchema>;

/** When a trace has nothing left. `null` for a landmark, which never does. */
export function traceExpiresAtMs(trace: SyncedTrace): number | null {
  const lifetime = TRACE_LIFETIME_SECONDS[trace.disposition];
  if (lifetime === null) return null;
  return Date.parse(trace.createdAt) + lifetime * 1000;
}

/* -------------------------------------------------------------------------- */
/* Discoveries and residents                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A secret this player noticed here. Mirrors the sim's `DiscoveryRecord`.
 *
 * `visitIndex` is which night it happened on — an ordinal, the same kind of
 * fact the campsite page already says out loud ("the third night here").
 */
export const SyncedDiscoverySchema = z
  .object({
    secretId: z.string().min(1).max(64).regex(/^[a-z0-9_.:-]+$/),
    /** Seconds into that session it surfaced. */
    at: z.number().min(0).max(86_400),
    visitIndex: NonNegativeIntSchema.max(1_000_000),
    oneTime: z.boolean(),
    evidence: z.string().max(240).nullable(),
  })
  .strict();
export type SyncedDiscovery = z.infer<typeof SyncedDiscoverySchema>;

/**
 * How many of your nights each recognisable resident has turned up on.
 *
 * Not a collection and not a compendium (spec §7): there is no total anywhere,
 * and the only thing the number does is let the fox behave like it has met you.
 */
export const ResidentVisitsSchema = z.record(
  z.string().min(1).max(64).regex(/^[A-Za-z0-9_.:-]+$/),
  NonNegativeIntSchema.max(1_000_000),
);

/* -------------------------------------------------------------------------- */
/* The snapshot a device pushes                                                */
/* -------------------------------------------------------------------------- */

/**
 * One device's account of a campsite.
 *
 * `deviceVisits` is *this device's own* count, not the total it believes in.
 * That is what makes the merge exact rather than a guess: the server keeps one
 * counter per device and adds them up, so two phones that both went camping
 * offline come back with four nights rather than two (max) or six (sum).
 */
export const CampsiteMemorySnapshotSchema = z
  .object({
    /** Stable per-device id, the same one anonymous bootstrap uses. */
    deviceId: z.string().min(1).max(128).regex(/^[A-Za-z0-9_.:-]+$/),
    environmentId: z.string().min(1).max(64).regex(/^[a-z0-9_]+$/),
    /** Nights this device has spent here. Grow-only; never sent smaller. */
    deviceVisits: NonNegativeIntSchema.max(1_000_000),
    lastVisitAt: TimestampSchema,
    secrets: z.array(SyncedDiscoverySchema).max(256).default([]),
    residents: ResidentVisitsSchema.default({}),
    traces: z.array(SyncedTraceSchema).max(256).default([]),
    /** Lines worth reading back, newest first. Prose, never a tally. */
    sightings: z.array(z.string().min(1).max(200)).max(40).default([]),
    constellations: z.array(z.string().min(1).max(64)).max(128).default([]),
  })
  .strict();
export type CampsiteMemorySnapshot = z.infer<typeof CampsiteMemorySnapshotSchema>;

export const SyncCampsiteMemoryRequestSchema = withIdempotency(CampsiteMemorySnapshotSchema);
export type SyncCampsiteMemoryRequest = z.infer<typeof SyncCampsiteMemoryRequestSchema>;

/**
 * The merged memory, as the service holds it.
 *
 * `visits` is the sum of the per-device counters and `observedAt` is the
 * *server's* clock — the client re-bases every remote trace onto its own clock
 * using the difference, so a device whose clock is a day out still sees the
 * same traces fade at the same moment everybody else does.
 */
export const CampsiteMemoryStateSchema = z.object({
  campsiteId: IdSchema,
  accountId: IdSchema,
  environmentId: z.string().min(1).max(64),
  observedAt: TimestampSchema,
  visits: NonNegativeIntSchema,
  lastVisitAt: TimestampSchema,
  secrets: z.array(SyncedDiscoverySchema),
  residents: ResidentVisitsSchema,
  traces: z.array(SyncedTraceSchema),
  sightings: z.array(z.string()),
  constellations: z.array(z.string()),
  /** Traces the server swept because their lifetime ran out. */
  expiredTraceIds: z.array(z.string()),
  updatedAt: TimestampSchema,
  revision: NonNegativeIntSchema,
});
export type CampsiteMemoryState = z.infer<typeof CampsiteMemoryStateSchema>;
