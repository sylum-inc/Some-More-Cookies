import { describe, expect, it } from 'vitest';
import { createEvidence, createTrace, decideTrace } from '@somemore/sim';
import {
  CampsiteMemorySnapshotSchema,
  CampsiteMemoryStateSchema,
  SyncedTraceSchema,
  TRACE_LIFETIME_SECONDS,
  traceExpiresAtMs,
} from '../src/index.js';

const NOW = '2026-08-30T12:00:00.000Z';

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    deviceId: 'device-1',
    environmentId: 'pine_hollow',
    deviceVisits: 3,
    lastVisitAt: NOW,
    ...overrides,
  };
}

describe('campsite memory on the wire', () => {
  it('fills in the empty collections so a first sync is a small body', () => {
    const parsed = CampsiteMemorySnapshotSchema.parse(snapshot());
    expect(parsed.secrets).toEqual([]);
    expect(parsed.residents).toEqual({});
    expect(parsed.traces).toEqual([]);
    expect(parsed.constellations).toEqual([]);
  });

  it('refuses an unknown key on a trace rather than stripping it', () => {
    // The whole point of `.strict()`: a stripped field is a field somebody
    // will assume arrived. A refused one is a bug found at the edge.
    const smuggled = SyncedTraceSchema.safeParse({
      id: 'secret:tin',
      kind: 'discovery',
      createdAt: NOW,
      disposition: 'keep',
      score: 0.91,
    });
    expect(smuggled.success).toBe(false);
  });

  it('has no member for a faded trace', () => {
    expect(
      SyncedTraceSchema.safeParse({ id: 'x', kind: 'photo', createdAt: NOW, disposition: 'fade' }).success,
    ).toBe(false);
  });

  it('carries exactly four fields, none of which is a value', () => {
    const trace = SyncedTraceSchema.parse({
      id: 'secret:tin',
      kind: 'discovery',
      createdAt: NOW,
      disposition: 'landmark',
    });
    expect(Object.keys(trace).sort()).toEqual(['createdAt', 'disposition', 'id', 'kind']);
  });

  it('refuses a trace id that could be a path or a script', () => {
    for (const id of ['../etc/passwd', 'a/b', '<script>', 'a b', '', 'a..b']) {
      expect(
        SyncedTraceSchema.safeParse({ id, kind: 'photo', createdAt: NOW, disposition: 'keep' }).success,
      ).toBe(false);
    }
  });

  it('says when a trace runs out, and that a landmark never does', () => {
    const keep = SyncedTraceSchema.parse({ id: 'a', kind: 'photo', createdAt: NOW, disposition: 'keep' });
    expect(traceExpiresAtMs(keep)).toBe(Date.parse(NOW) + 14 * 86_400_000);
    const landmark = SyncedTraceSchema.parse({
      id: 'b',
      kind: 'photo',
      createdAt: NOW,
      disposition: 'landmark',
    });
    expect(traceExpiresAtMs(landmark)).toBeNull();
  });

  it('accepts the state the service returns', () => {
    const parsed = CampsiteMemoryStateSchema.parse({
      campsiteId: 'cmp_1',
      accountId: 'acct_1',
      environmentId: 'pine_hollow',
      observedAt: NOW,
      visits: 4,
      lastVisitAt: NOW,
      secrets: [],
      residents: { 'fox-1': 2 },
      traces: [],
      sightings: [],
      constellations: [],
      expiredTraceIds: [],
      updatedAt: NOW,
      revision: 2,
    });
    expect(parsed.visits).toBe(4);
  });
});

describe('the lifetime table matches the simulation that decides it', () => {
  /*
   * `TRACE_LIFETIME_SECONDS` duplicates a constant that lives in
   * `packages/sim/src/significance.ts`, because the protocol depends on
   * nothing. A duplicated constant is a drift risk unless something fails when
   * it drifts — so this drives the real `decideTrace` into each disposition and
   * holds the answer against the table. If somebody retunes the model, this
   * goes red instead of a campsite forgetting three months early.
   */
  function evidenceFor(disposition: string) {
    switch (disposition) {
      case 'landmark':
        return createEvidence('sandwich', { explicitlyPreserved: true });
      case 'passport':
        return createEvidence('sandwich', { rarity: 0.5, isFirst: true, photographed: true });
      case 'keep':
        return createEvidence('discovery', { rarity: 0.5, isFirst: true });
      default:
        return createEvidence('environmental');
    }
  }

  it('agrees with decideTrace on every disposition the wire can carry', () => {
    for (const disposition of ['keep', 'passport', 'landmark'] as const) {
      const decision = decideTrace(evidenceFor(disposition));
      expect(decision.disposition).toBe(disposition);
      const expected = TRACE_LIFETIME_SECONDS[disposition];
      if (expected === null) expect(decision.lifetimeSeconds).toBe(Infinity);
      else expect(decision.lifetimeSeconds).toBe(expected);
    }
  });

  it('agrees for a trace the simulation actually built', () => {
    const trace = createTrace('secret:tin', evidenceFor('keep'), Date.parse(NOW), { rarity: 0.5 });
    expect(TRACE_LIFETIME_SECONDS[trace.disposition as 'keep']).toBe(trace.lifetimeSeconds);
    // And the sim's own trace carries a payload the wire schema has no room
    // for, which is the point: the evidence stays on the device.
    expect(trace.payload).toEqual({ rarity: 0.5 });
    expect(
      SyncedTraceSchema.safeParse({ ...trace, lifetimeSeconds: undefined, payload: undefined }).success,
    ).toBe(false);
  });
});
