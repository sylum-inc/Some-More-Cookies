import {
  TRACE_LIFETIME_SECONDS,
  type CampsiteMemorySnapshot,
  type SyncedDiscovery,
  type SyncedTrace,
  type SyncedTraceDisposition,
} from '@somemore/protocol';

/**
 * Merging what two devices remember about one campsite.
 *
 * This is the hard part of campsite sync and it is worth being explicit about,
 * because the wrong rule is not a crash — it is a campsite that quietly claims
 * you have been there eleven times when you have been there six, which is
 * exactly the kind of dishonesty §6.3 ("returning is always warm") cannot
 * survive.
 *
 * The scenario every rule below is written against: two devices, both offline,
 * both visiting the same campsite, both then syncing.
 *
 * ── visits ────────────────────────────────────────────────────────────────
 * A **per-device grow-only counter**, summed. Each device reports only the
 * nights *it* was there; the merged total is the sum over devices, and a
 * device re-sending its own counter replaces its entry rather than adding to
 * it.
 *
 * The two obvious rules are both wrong, and each is wrong in a way a player
 * would notice:
 *   - `max` loses. Phone visits twice offline, tablet visits twice offline,
 *     the campsite has been visited twice. A night that happened is gone.
 *   - `sum of totals` double-counts, and does so *again on every re-sync*,
 *     because a device's total already includes the visits it learned from
 *     the server. Two idle syncs and the campsite thinks you live there.
 * Per-device counters are exact under both, and idempotent under re-sync,
 * which is what makes the whole thing safe to call as often as the client
 * likes. Nothing here needs a vector clock: the counters *are* the clock.
 *
 * ── an animal's `visits` ──────────────────────────────────────────────────
 * `max`, clamped to the merged visit total. A resident's `visits` is "how many
 * of your nights this fox has turned up on", and each device's number is a
 * lower bound on the truth as that device saw it. Summing would let a fox
 * appear on more nights than there have been nights, which is the one thing
 * this number can be visibly wrong about; `max` can only undercount, and an
 * undercount reads as a shy fox rather than as a bug. It is also exactly the
 * rule `Store.rememberCampsite` already applies locally — using a different
 * one here would make the same night merge differently depending on which
 * side did it.
 *
 * ── secrets ───────────────────────────────────────────────────────────────
 * Set union by `secretId`, keeping the **earliest** record. A secret is
 * noticed once; the fact worth keeping is the first time, and "first" is
 * decided by the lowest `visitIndex`, then the lowest `at`, then lexically by
 * `secretId` so the answer does not depend on arrival order.
 *
 * ── traces ────────────────────────────────────────────────────────────────
 * Union by id, and on a collision the **stronger disposition and the earlier
 * `createdAt`** win. Stronger, because a disposition only rises when the
 * player cared more, and taking the weaker would forget something they meant
 * to keep. Earlier, because a trace's age is the honest one, not the
 * flattering one.
 *
 * ── fading, and a device whose clock is wrong ─────────────────────────────
 * Traces fade on a wall clock, so a skewed clock is a real case and not a
 * hypothetical:
 *   1. `createdAt` is **clamped to the server's now**. A trace cannot have
 *      been created in the future, and a phone set a week forward would
 *      otherwise mint traces that outlive every honest one.
 *   2. Expiry is evaluated **only against the server clock**. A client is
 *      never asked when something faded.
 *   3. The response carries `observedAt`, and the client re-bases every remote
 *      trace by the difference before handing it to `tracePresence` — so two
 *      devices a day apart see the same trace at the same strength.
 * A slow clock still costs its own traces some of their life. That is
 * deliberate: correcting upward would resurrect things, and a trace that
 * fades early is a campsite forgetting gently, which is what it does anyway.
 *
 * ── sightings and constellations ──────────────────────────────────────────
 * Set union, newest-arriving first for sightings and discovery order for
 * constellations, capped where the client caps them. Both converge because the
 * server is the merge point and both devices read its answer back.
 */

/** The merged record as it is stored. Not a wire type; the state is. */
export interface StoredCampsiteMemory {
  readonly campsiteId: string;
  readonly accountId: string;
  environmentId: string;
  /** Per-device grow-only visit counters. The total is their sum. */
  deviceVisits: Record<string, number>;
  lastVisitAt: string;
  secrets: SyncedDiscovery[];
  residents: Record<string, number>;
  traces: SyncedTrace[];
  sightings: string[];
  constellations: string[];
  createdAt: string;
  updatedAt: string;
  revision: number;
}

const MAX_SIGHTINGS = 40;
const MAX_CONSTELLATIONS = 128;
const MAX_TRACES = 256;
const MAX_SECRETS = 256;

const DISPOSITION_RANK: Readonly<Record<SyncedTraceDisposition, number>> = Object.freeze({
  keep: 0,
  passport: 1,
  landmark: 2,
});

export function totalVisits(deviceVisits: Readonly<Record<string, number>>): number {
  let total = 0;
  for (const count of Object.values(deviceVisits)) total += count;
  return total;
}

/** Has this trace run out, according to the only clock that gets a vote? */
export function traceHasExpired(trace: SyncedTrace, nowMs: number): boolean {
  const lifetime = TRACE_LIFETIME_SECONDS[trace.disposition];
  if (lifetime === null) return false;
  return Date.parse(trace.createdAt) + lifetime * 1000 <= nowMs;
}

/** Which of two records of the same secret is the one that actually happened first. */
function earlier(a: SyncedDiscovery, b: SyncedDiscovery): SyncedDiscovery {
  if (a.visitIndex !== b.visitIndex) return a.visitIndex < b.visitIndex ? a : b;
  if (a.at !== b.at) return a.at < b.at ? a : b;
  return a.secretId <= b.secretId ? a : b;
}

function strongerTrace(a: SyncedTrace, b: SyncedTrace): SyncedTrace {
  const rankA = DISPOSITION_RANK[a.disposition];
  const rankB = DISPOSITION_RANK[b.disposition];
  const disposition = rankA >= rankB ? a.disposition : b.disposition;
  const createdAt = Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a.createdAt : b.createdAt;
  // `kind` is a property of the event, not of the device; a disagreement means
  // two different things reused one id, and the older one is the incumbent.
  const kind = Date.parse(a.createdAt) <= Date.parse(b.createdAt) ? a.kind : b.kind;
  return { id: a.id, kind, createdAt, disposition };
}

export interface MergeResult {
  readonly merged: StoredCampsiteMemory;
  /** Traces the merge swept because their lifetime had run out. */
  readonly expiredTraceIds: readonly string[];
}

export function emptyMemory(input: {
  campsiteId: string;
  accountId: string;
  environmentId: string;
  now: string;
}): StoredCampsiteMemory {
  return {
    campsiteId: input.campsiteId,
    accountId: input.accountId,
    environmentId: input.environmentId,
    deviceVisits: {},
    lastVisitAt: input.now,
    secrets: [],
    residents: {},
    traces: [],
    sightings: [],
    constellations: [],
    createdAt: input.now,
    updatedAt: input.now,
    revision: 0,
  };
}

/**
 * Fold one device's snapshot into the stored memory.
 *
 * Pure, deterministic and total: same inputs, same output, no clock of its own
 * and no throw. Everything about the merge that is worth arguing over is
 * therefore arguable in a unit test rather than through the HTTP layer.
 */
export function mergeCampsiteMemory(
  current: StoredCampsiteMemory,
  incoming: CampsiteMemorySnapshot,
  nowMs: number,
): MergeResult {
  const now = new Date(nowMs).toISOString();

  /*
   * Grow-only per device. `max` rather than assignment because a retried sync
   * can carry an older counter (the client persists its ledger before it knows
   * the request succeeded), and a counter must never go backwards.
   */
  const deviceVisits: Record<string, number> = { ...current.deviceVisits };
  const previousForDevice = deviceVisits[incoming.deviceId] ?? 0;
  deviceVisits[incoming.deviceId] = Math.max(previousForDevice, incoming.deviceVisits);
  const visits = totalVisits(deviceVisits);

  /*
   * Secrets: union by id, earliest record wins, sorted so two devices that
   * merge in different orders still store the same list.
   */
  const secretsById = new Map<string, SyncedDiscovery>();
  for (const record of [...current.secrets, ...incoming.secrets]) {
    const existing = secretsById.get(record.secretId);
    secretsById.set(record.secretId, existing === undefined ? record : earlier(existing, record));
  }
  const secrets = [...secretsById.values()]
    .sort((a, b) => a.visitIndex - b.visitIndex || a.at - b.at || (a.secretId < b.secretId ? -1 : 1))
    .slice(0, MAX_SECRETS);

  /*
   * Residents: max, then clamped to the visit total. A fox cannot have turned
   * up on more nights than there have been nights, and a device that synced
   * before another device's nights were counted can legitimately report a
   * number that is briefly above the total it knew about.
   */
  const residents: Record<string, number> = { ...current.residents };
  for (const [individualId, seen] of Object.entries(incoming.residents)) {
    residents[individualId] = Math.max(residents[individualId] ?? 0, seen);
  }
  for (const individualId of Object.keys(residents)) {
    residents[individualId] = Math.min(residents[individualId] ?? 0, visits);
  }

  /*
   * Traces: union by id, stronger disposition and earlier birth win, future
   * timestamps clamped to now, and anything whose lifetime has run swept.
   */
  const tracesById = new Map<string, SyncedTrace>();
  for (const trace of current.traces) tracesById.set(trace.id, trace);
  for (const raw of incoming.traces) {
    // A trace from a device whose clock runs fast would otherwise outlive
    // every honest one, so nothing is allowed to have been created later than
    // the moment the server received it.
    const createdAtMs = Math.min(Date.parse(raw.createdAt), nowMs);
    const trace: SyncedTrace = { ...raw, createdAt: new Date(createdAtMs).toISOString() };
    const existing = tracesById.get(trace.id);
    tracesById.set(trace.id, existing === undefined ? trace : strongerTrace(existing, trace));
  }

  const kept: SyncedTrace[] = [];
  const expiredTraceIds: string[] = [];
  for (const trace of tracesById.values()) {
    if (traceHasExpired(trace, nowMs)) expiredTraceIds.push(trace.id);
    else kept.push(trace);
  }
  // Landmarks first, then newest — so the cap, when it bites, drops the least
  // meaningful thing rather than whichever happened to be last in a Map.
  kept.sort(
    (a, b) =>
      DISPOSITION_RANK[b.disposition] - DISPOSITION_RANK[a.disposition] ||
      Date.parse(b.createdAt) - Date.parse(a.createdAt) ||
      (a.id < b.id ? -1 : 1),
  );
  const traces = kept.slice(0, MAX_TRACES);

  /* Sightings: new lines first, in the order they arrived, then what was here. */
  const sightings: string[] = [];
  for (const line of [...incoming.sightings, ...current.sightings]) {
    if (!sightings.includes(line)) sightings.push(line);
  }

  const constellations = [...current.constellations];
  for (const id of incoming.constellations) {
    if (!constellations.includes(id)) constellations.push(id);
  }

  const lastVisitAt = new Date(
    Math.min(nowMs, Math.max(Date.parse(current.lastVisitAt), Date.parse(incoming.lastVisitAt))),
  ).toISOString();

  return {
    merged: {
      campsiteId: current.campsiteId,
      accountId: current.accountId,
      environmentId: incoming.environmentId,
      deviceVisits,
      lastVisitAt,
      secrets,
      residents,
      traces,
      sightings: sightings.slice(0, MAX_SIGHTINGS),
      constellations: constellations.slice(0, MAX_CONSTELLATIONS),
      createdAt: current.createdAt,
      updatedAt: now,
      revision: current.revision + 1,
    },
    expiredTraceIds,
  };
}

/**
 * Sweep on read. A memory nobody has pushed to in three months should still
 * have let go of what it was supposed to let go of.
 */
export function sweepExpired(
  memory: StoredCampsiteMemory,
  nowMs: number,
): { traces: SyncedTrace[]; expiredTraceIds: string[] } {
  const traces: SyncedTrace[] = [];
  const expiredTraceIds: string[] = [];
  for (const trace of memory.traces) {
    if (traceHasExpired(trace, nowMs)) expiredTraceIds.push(trace.id);
    else traces.push(trace);
  }
  return { traces, expiredTraceIds };
}

/**
 * Fold one stored memory into another, for an account merge.
 *
 * Linking an account is a merge, never a reset (spec §6.1), and that has to
 * include the campsites. Both sides may already remember the same place from
 * different devices, so this is the same arithmetic as a device sync: per-device
 * counters unioned by max, everything else unioned, nothing summed.
 */
export function absorbCampsiteMemory(
  into: StoredCampsiteMemory,
  from: StoredCampsiteMemory,
  nowMs: number,
): StoredCampsiteMemory {
  const deviceVisits: Record<string, number> = { ...into.deviceVisits };
  for (const [deviceId, count] of Object.entries(from.deviceVisits)) {
    deviceVisits[deviceId] = Math.max(deviceVisits[deviceId] ?? 0, count);
  }
  const visits = totalVisits(deviceVisits);

  const secretsById = new Map<string, SyncedDiscovery>();
  for (const record of [...into.secrets, ...from.secrets]) {
    const existing = secretsById.get(record.secretId);
    secretsById.set(record.secretId, existing === undefined ? record : earlier(existing, record));
  }

  const residents: Record<string, number> = { ...into.residents };
  for (const [individualId, seen] of Object.entries(from.residents)) {
    residents[individualId] = Math.min(visits, Math.max(residents[individualId] ?? 0, seen));
  }
  for (const individualId of Object.keys(residents)) {
    residents[individualId] = Math.min(residents[individualId] ?? 0, visits);
  }

  const tracesById = new Map<string, SyncedTrace>();
  for (const trace of [...into.traces, ...from.traces]) {
    const existing = tracesById.get(trace.id);
    tracesById.set(trace.id, existing === undefined ? trace : strongerTrace(existing, trace));
  }
  const traces = [...tracesById.values()].filter((trace) => !traceHasExpired(trace, nowMs));

  const sightings: string[] = [];
  for (const line of [...into.sightings, ...from.sightings]) {
    if (!sightings.includes(line)) sightings.push(line);
  }
  const constellations = [...into.constellations];
  for (const id of from.constellations) if (!constellations.includes(id)) constellations.push(id);

  return {
    ...into,
    deviceVisits,
    lastVisitAt:
      Date.parse(from.lastVisitAt) > Date.parse(into.lastVisitAt) ? from.lastVisitAt : into.lastVisitAt,
    secrets: [...secretsById.values()]
      .sort((a, b) => a.visitIndex - b.visitIndex || a.at - b.at || (a.secretId < b.secretId ? -1 : 1))
      .slice(0, MAX_SECRETS),
    residents,
    traces: traces.slice(0, MAX_TRACES),
    sightings: sightings.slice(0, MAX_SIGHTINGS),
    constellations: constellations.slice(0, MAX_CONSTELLATIONS),
    createdAt: Date.parse(from.createdAt) < Date.parse(into.createdAt) ? from.createdAt : into.createdAt,
    updatedAt: new Date(nowMs).toISOString(),
    revision: into.revision + 1,
  };
}
