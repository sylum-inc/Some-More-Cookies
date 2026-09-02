/**
 * Campsite memory, between this device and the service.
 *
 * `CampsiteMemory` in the store is what a campsite remembers about a player,
 * and until this file existed it lived in `localStorage` and nowhere else: a
 * lost phone was every place that had met you, forgetting you. This is the
 * bridge, and it obeys the same rule everything in `net/` obeys — **the ritual
 * never waits on the network.** A failed sync leaves the local memory
 * byte-identical and the player never learns anything happened.
 *
 * Two things here are worth reading slowly.
 *
 * ## The device ledger
 *
 * The server counts visits with one grow-only counter per device and sums
 * them, because that is the only rule that is exact when two devices camp
 * offline (see `services/api/src/domain/memoryMerge.ts` for why `max` and
 * `sum-of-totals` are both wrong). That means this device has to know how many
 * nights are *its own*, which the store's single `visits` number cannot say
 * once it has absorbed somebody else's.
 *
 * So a tiny ledger sits beside it: for each campsite, how many nights this
 * device has contributed, and what total it last accepted from the server. New
 * local nights are `visits - lastKnownTotal`, added to our own counter. That is
 * idempotent — syncing twice with nothing in between adds nothing — which is
 * what makes it safe to call on a timer and again on `pagehide`.
 *
 * ## Clock skew
 *
 * Traces fade on a wall clock and a phone's clock is not the server's. The
 * server clamps a future `createdAt` and evaluates every expiry against its own
 * clock; this end does the other half, re-basing each remote trace's age onto
 * *this* device's clock using the `observedAt` the response carries. A device
 * a day out therefore sees the same trace at the same strength as everybody
 * else, rather than one that faded early or one that will not go away.
 *
 * ## What does not cross
 *
 * The significance score, and the evidence it is computed from. A synced trace
 * is an id, a kind, a birth time and a disposition (§6.4); the sim's free-form
 * payload stays on the device that made it. A trace that arrives from the
 * service therefore has an empty payload, which nothing reads — everything a
 * returning player actually notices is carried by `secrets` and `residents`.
 */

import type { Trace, TraceDisposition, TraceKind } from '@somemore/sim';
import {
  CampsiteMemorySnapshotSchema,
  TRACE_LIFETIME_SECONDS,
  type CampsiteMemorySnapshot,
  type CampsiteMemoryState,
  type SyncedTrace,
} from '@somemore/protocol';
import type { CampsiteMemory } from '../state/store.js';

const LEDGER_KEY = 'some-more/memory-ledger/v1';

/** What this device has contributed, and what it last heard back. */
export interface DeviceLedgerEntry {
  /** Nights this device has spent here. Grow-only, never sent smaller. */
  own: number;
  /** The merged total this device last accepted, so new nights are a delta. */
  lastKnownTotal: number;
}

export type DeviceLedger = Record<string, DeviceLedgerEntry>;

export function loadLedger(): DeviceLedger {
  try {
    const raw = localStorage.getItem(LEDGER_KEY);
    if (!raw) return {};
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return {};
    return parsed as DeviceLedger;
  } catch {
    // A corrupt ledger costs at worst a recount, never a night of play.
    return {};
  }
}

export function saveLedger(ledger: DeviceLedger): void {
  try {
    localStorage.setItem(LEDGER_KEY, JSON.stringify(ledger));
  } catch {
    /* A device that will not persist the ledger simply recounts. */
  }
}

/** Only the three dispositions the wire has a member for. */
function isSyncable(disposition: TraceDisposition): disposition is 'keep' | 'passport' | 'landmark' {
  return disposition === 'keep' || disposition === 'passport' || disposition === 'landmark';
}

/** A trace id the protocol will accept. Anything odd is simply not sent. */
function isSendableTraceId(id: string): boolean {
  return id.length > 0 && id.length <= 128 && /^[A-Za-z0-9_.:-]+$/.test(id) && !id.includes('..');
}

/**
 * Build the snapshot this device would push.
 *
 * Pure: it takes the ledger entry rather than reading storage, so the
 * arithmetic that decides how many nights we claim is testable without a
 * browser.
 */
export function buildSnapshot(input: {
  memory: CampsiteMemory;
  deviceId: string;
  entry: DeviceLedgerEntry;
}): { snapshot: CampsiteMemorySnapshot; entry: DeviceLedgerEntry } {
  const newLocalVisits = Math.max(0, input.memory.visits - input.entry.lastKnownTotal);
  const own = Math.max(input.entry.own, input.entry.own + newLocalVisits);

  const traces: SyncedTrace[] = [];
  for (const trace of input.memory.traces) {
    if (!isSyncable(trace.disposition)) continue;
    if (!isSendableTraceId(trace.id)) continue;
    traces.push({
      id: trace.id,
      kind: trace.kind,
      createdAt: new Date(trace.createdAt).toISOString(),
      disposition: trace.disposition,
    });
  }

  const snapshot = CampsiteMemorySnapshotSchema.parse({
    deviceId: input.deviceId,
    environmentId: input.memory.environmentId,
    deviceVisits: own,
    lastVisitAt: new Date(input.memory.lastVisitAt || Date.now()).toISOString(),
    secrets: input.memory.secrets.slice(0, 256).map((record) => ({
      secretId: record.secretId,
      at: Math.max(0, Math.min(86_400, record.at)),
      visitIndex: Math.max(0, Math.round(record.visitIndex)),
      oneTime: record.oneTime,
      evidence: record.evidence,
    })),
    residents: input.memory.residents,
    traces: traces.slice(0, 256),
    sightings: input.memory.sightings.slice(0, 40),
    constellations: input.memory.constellations.slice(0, 128),
  });

  return { snapshot, entry: { own, lastKnownTotal: input.entry.lastKnownTotal } };
}

/**
 * Turn the merged state back into a local `CampsiteMemory`.
 *
 * The merge already happened on the server, so this is a translation and not a
 * second merge — a second one with different rules is how two devices end up
 * disagreeing about a place they both went to.
 *
 * `localNowMs` is this device's clock and `observedAt` is the server's; every
 * trace age is expressed as "how long ago the server thought this happened",
 * then re-based here. That is the whole of the skew handling on this side.
 */
export function applyRemoteMemory(input: {
  local: CampsiteMemory;
  remote: CampsiteMemoryState;
  localNowMs: number;
}): CampsiteMemory {
  const observedAtMs = Date.parse(input.remote.observedAt);
  const skewMs = Number.isFinite(observedAtMs) ? input.localNowMs - observedAtMs : 0;

  const traces: Trace[] = input.remote.traces.map((trace) => {
    const lifetime = TRACE_LIFETIME_SECONDS[trace.disposition];
    return {
      id: trace.id,
      kind: trace.kind as TraceKind,
      // Re-based, so `tracePresence` — which reads this device's clock —
      // agrees with what the server would have said.
      createdAt: Date.parse(trace.createdAt) + skewMs,
      lifetimeSeconds: lifetime === null ? Infinity : lifetime,
      disposition: trace.disposition,
      // Empty on purpose: the evidence never left the device that made it.
      payload: {},
    };
  });

  // Anything the service swept is gone here too, and anything this device
  // still has that the service did not return is kept — the service is the
  // merge point, not an authority that can delete a night nobody uploaded yet.
  const swept = new Set(input.remote.expiredTraceIds);
  const byId = new Map<string, Trace>();
  for (const trace of input.local.traces) {
    if (swept.has(trace.id)) continue;
    byId.set(trace.id, trace);
  }
  for (const trace of traces) byId.set(trace.id, trace);

  const secretIds = new Set(input.remote.secrets.map((s) => s.secretId));
  const secrets = [
    ...input.remote.secrets.map((record) => ({ ...record })),
    ...input.local.secrets.filter((record) => !secretIds.has(record.secretId)),
  ];

  const residents = { ...input.local.residents };
  for (const [individualId, seen] of Object.entries(input.remote.residents)) {
    residents[individualId] = Math.max(residents[individualId] ?? 0, seen);
  }

  const sightings: string[] = [];
  for (const line of [...input.remote.sightings, ...input.local.sightings]) {
    if (!sightings.includes(line)) sightings.push(line);
  }
  const constellations = [...input.remote.constellations];
  for (const id of input.local.constellations) {
    if (!constellations.includes(id)) constellations.push(id);
  }

  return {
    campsiteSeed: input.local.campsiteSeed,
    environmentId: input.local.environmentId,
    // Never downward: the total the service knows may lag a night this device
    // has had and not yet pushed.
    visits: Math.max(input.local.visits, input.remote.visits),
    lastVisitAt: Math.max(input.local.lastVisitAt, Date.parse(input.remote.lastVisitAt) || 0),
    secrets,
    residents,
    traces: [...byId.values()],
    sightings: sightings.slice(0, 40),
    constellations: constellations.slice(0, 128),
  };
}
