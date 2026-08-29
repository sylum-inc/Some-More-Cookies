import { describe, expect, it } from 'vitest';
import {
  ClientMessageSchema,
  DEFAULT_MUTUAL_HOLD_TICKS,
  DEFAULT_VOICE_PROXIMITY,
  InputIntentKindValues,
  InputIntentSchema,
  MAX_INPUT_HISTORY,
  NON_EXPRESSIBLE_INTENTS,
  REALTIME_TICK_HZ,
  SCHEMA_VERSION,
  ServerMessageSchema,
  StampedInputSchema,
  VoiceRoomInfoSchema,
  authorizedDrivers,
  compareStampedInputs,
  defaultApproachPath,
  departurePathFrom,
  intentObjectId,
  intentRequiresAuthority,
  intentTargetAccountId,
  isAuthorityExpired,
  isExpressibleIntentKind,
  isInterferenceProne,
  proximityGain,
  realtimeAuthorityDenial,
  snatchDenial,
  tickAt,
  tickToMs,
  type AuthorityRecord,
  type InputIntent,
  type StampedInput,
} from '../src/index.js';

const NOW = '2026-08-29T12:00:00.000Z';
const LATER = '2026-08-29T12:05:00.000Z';

function record(overrides: Partial<AuthorityRecord> = {}): AuthorityRecord {
  return {
    sessionId: 'ses_1',
    objectId: 'obj_skewer',
    objectKind: 'skewer',
    holderAccountId: null,
    grantedAt: NOW,
    expiresAt: null,
    sequence: 0,
    locked: false,
    ...overrides,
  };
}

describe('ticks', () => {
  it('runs at the simulation timestep and never goes backwards', () => {
    expect(REALTIME_TICK_HZ).toBe(60);
    const origin = Date.parse(NOW);
    expect(tickAt(origin, origin)).toBe(0);
    expect(tickAt(origin, origin - 5_000)).toBe(0);
    expect(tickAt(origin, origin + 1_000)).toBe(60);
    expect(tickAt(origin, origin + 16)).toBe(0);
    expect(tickAt(origin, origin + 17)).toBe(1);
  });

  it('round-trips a tick back to wall-clock time', () => {
    const origin = Date.parse(NOW);
    expect(tickAt(origin, tickToMs(origin, 600))).toBe(600);
  });
});

describe('input intents', () => {
  it('accepts every intent a player can express and applies its defaults', () => {
    const move = InputIntentSchema.parse({
      kind: 'move_marshmallow',
      objectId: 'obj_m1',
      position: { x: 0, y: 0.4, z: 0.6 },
      rotation: 1.5,
    });
    expect(move).toMatchObject({ blow: 0 });

    expect(InputIntentSchema.parse({ kind: 'tend_fire', action: { action: 'add_log', woodId: 'oak' } })).toMatchObject({
      action: { placement: 0.6 },
    });
    expect(InputIntentSchema.parse({ kind: 'hold_component' })).toMatchObject({ component: null });
    expect(InputIntentSchema.parse({ kind: 'gesture', gesture: 'high_five' })).toMatchObject({
      targetAccountId: null,
    });
  });

  it('rejects intents that are not in the vocabulary', () => {
    expect(InputIntentSchema.safeParse({ kind: 'set_marshmallow_temperature', patches: [] }).success).toBe(false);
    expect(InputIntentSchema.safeParse({ kind: 'gesture', gesture: 'headbutt' }).success).toBe(false);
  });

  /**
   * The anti-grief guarantee is that these verbs do not exist, so this is the
   * test that stops one being added by accident later.
   */
  it('cannot express a destructive action on another player', () => {
    for (const forbidden of NON_EXPRESSIBLE_INTENTS) {
      expect(isExpressibleIntentKind(forbidden)).toBe(false);
      expect(InputIntentSchema.safeParse({ kind: forbidden, objectId: 'obj_1' }).success).toBe(false);
    }
  });

  it('only lets a gesture name another player', () => {
    const intents: InputIntent[] = [
      InputIntentSchema.parse({ kind: 'move_marshmallow', objectId: 'o', position: { x: 0, y: 0, z: 0 }, rotation: 0 }),
      InputIntentSchema.parse({ kind: 'machine_control', objectId: 'o', control: 'pull_lever' }),
      InputIntentSchema.parse({ kind: 'move_prop', objectId: 'o', position: { x: 0, y: 0, z: 0 }, rotationY: 0 }),
      InputIntentSchema.parse({ kind: 'tend_fire', action: { action: 'rake' } }),
      InputIntentSchema.parse({ kind: 'place_component' }),
    ];
    for (const intent of intents) expect(intentTargetAccountId(intent)).toBeNull();

    const gesture = InputIntentSchema.parse({ kind: 'gesture', gesture: 'wave', targetAccountId: 'acct_2' });
    expect(intentTargetAccountId(gesture)).toBe('acct_2');
    // ...and a gesture cannot touch an object, so it cannot break anything.
    expect(intentObjectId(gesture)).toBeNull();
    expect(intentRequiresAuthority(gesture)).toBe(false);
  });

  it('requires authority for exactly the object-bearing intents', () => {
    for (const kind of InputIntentKindValues) {
      const sample = sampleIntent(kind);
      expect(intentRequiresAuthority(sample)).toBe(intentObjectId(sample) !== null);
    }
  });

  it('marks the shared-space intents as interference-prone', () => {
    expect(isInterferenceProne(InputIntentSchema.parse({ kind: 'tend_fire', action: { action: 'fan' } }))).toBe(true);
    expect(isInterferenceProne(InputIntentSchema.parse({ kind: 'machine_control', objectId: 'o', control: 'reset' }))).toBe(true);
    expect(isInterferenceProne(InputIntentSchema.parse({ kind: 'place_component' }))).toBe(false);
  });
});

function sampleIntent(kind: (typeof InputIntentKindValues)[number]): InputIntent {
  switch (kind) {
    case 'move_marshmallow':
      return InputIntentSchema.parse({ kind, objectId: 'o', position: { x: 0, y: 0, z: 0 }, rotation: 0 });
    case 'blow_out':
    case 'begin_roast':
    case 'finish_roast':
      return InputIntentSchema.parse({ kind, objectId: 'o' });
    case 'tend_fire':
      return InputIntentSchema.parse({ kind, action: { action: 'rake' } });
    case 'hold_component':
      return InputIntentSchema.parse({ kind });
    case 'move_component':
      return InputIntentSchema.parse({ kind, offset: { x: 0, y: 0, z: 0 }, rotation: 0 });
    case 'place_component':
      return InputIntentSchema.parse({ kind });
    case 'machine_control':
      return InputIntentSchema.parse({ kind, objectId: 'o', control: 'confirm' });
    case 'move_prop':
      return InputIntentSchema.parse({ kind, objectId: 'o', position: { x: 0, y: 0, z: 0 }, rotationY: 0 });
    case 'gesture':
      return InputIntentSchema.parse({ kind, gesture: 'wave' });
  }
}

describe('stamped input history', () => {
  const stamped = (tick: number, serverSeq: number): StampedInput =>
    StampedInputSchema.parse({
      tick,
      serverSeq,
      accountId: 'acct_1',
      clientSeq: serverSeq,
      intent: { kind: 'place_component' },
    });

  it('orders by tick, then by the server sequence within a tick', () => {
    const shuffled = [stamped(4, 9), stamped(2, 3), stamped(4, 7), stamped(1, 12)];
    const ordered = [...shuffled].sort(compareStampedInputs).map((s) => [s.tick, s.serverSeq]);
    expect(ordered).toEqual([
      [1, 12],
      [2, 3],
      [4, 7],
      [4, 9],
    ]);
  });

  it('is a total order — no two entries ever compare equal', () => {
    const entries = [stamped(1, 1), stamped(1, 2), stamped(2, 1)];
    for (const a of entries) {
      for (const b of entries) {
        if (a === b) continue;
        expect(compareStampedInputs(a, b)).not.toBe(0);
      }
    }
  });

  it('caps retained history so a snapshot is never quietly wrong', () => {
    expect(MAX_INPUT_HISTORY).toBeGreaterThan(1_000);
  });
});

describe('authority over the wire', () => {
  it('treats an unheld or lapsed lease as available', () => {
    expect(isAuthorityExpired(record(), NOW)).toBe(true);
    expect(isAuthorityExpired(record({ holderAccountId: 'acct_1', expiresAt: null }), NOW)).toBe(false);
    expect(isAuthorityExpired(record({ holderAccountId: 'acct_1', expiresAt: LATER }), NOW)).toBe(false);
    expect(isAuthorityExpired(record({ holderAccountId: 'acct_1', expiresAt: NOW }), LATER)).toBe(true);
  });

  it('refuses to take a live object out of somebody else’s hands', () => {
    const held = record({ holderAccountId: 'acct_1', expiresAt: LATER });
    expect(snatchDenial({ record: held, requesterAccountId: 'acct_2', reason: 'grab', nowIso: NOW })).toBe('not_holder');
    // The holder themselves, an expired lease, and an explicit override are fine.
    expect(snatchDenial({ record: held, requesterAccountId: 'acct_1', reason: 'grab', nowIso: NOW })).toBeNull();
    expect(snatchDenial({ record: held, requesterAccountId: 'acct_2', reason: 'grab', nowIso: LATER })).toBeNull();
    expect(snatchDenial({ record: held, requesterAccountId: 'acct_2', reason: 'host_override', nowIso: NOW })).toBeNull();
    expect(snatchDenial({ record: held, requesterAccountId: 'acct_2', reason: 'disconnect', nowIso: NOW })).toBeNull();
  });

  it('closes the host loophole the HTTP rule leaves open', () => {
    const held = record({ holderAccountId: 'acct_1', expiresAt: LATER });
    const asHost = {
      record: held,
      requesterAccountId: 'acct_host',
      requesterIsHost: true,
      requesterIsMember: true,
      targetIsPresent: true,
      sessionState: 'active' as const,
      nowIso: NOW,
    };
    // A plain grab is refused even for the host...
    expect(
      realtimeAuthorityDenial({ ...asHost, request: { expectedSequence: 0, reason: 'grab', toAccountId: 'acct_host' } }),
    ).toBe('not_holder');
    // ...but a deliberate override is not.
    expect(
      realtimeAuthorityDenial({
        ...asHost,
        request: { expectedSequence: 0, reason: 'host_override', toAccountId: 'acct_host' },
      }),
    ).toBeNull();
  });

  it('still applies every shared rule: fencing, membership, session state', () => {
    const base = {
      record: record({ sequence: 4 }),
      requesterAccountId: 'acct_1',
      requesterIsHost: false,
      requesterIsMember: true,
      targetIsPresent: true,
      sessionState: 'active' as const,
      nowIso: NOW,
    };
    expect(realtimeAuthorityDenial({ ...base, request: { expectedSequence: 3, reason: 'grab', toAccountId: 'acct_1' } })).toBe(
      'sequence_stale',
    );
    expect(
      realtimeAuthorityDenial({ ...base, requesterIsMember: false, request: { expectedSequence: 4, reason: 'grab', toAccountId: 'acct_1' } }),
    ).toBe('not_a_member');
    expect(
      realtimeAuthorityDenial({ ...base, sessionState: 'ended', request: { expectedSequence: 4, reason: 'grab', toAccountId: 'acct_1' } }),
    ).toBe('session_not_active');
    expect(
      realtimeAuthorityDenial({ ...base, targetIsPresent: false, request: { expectedSequence: 4, reason: 'give', toAccountId: 'acct_2' } }),
    ).toBe('target_not_present');
    expect(realtimeAuthorityDenial({ ...base, request: { expectedSequence: 4, reason: 'grab', toAccountId: 'acct_1' } })).toBeNull();
  });

  it('lets both hands hold an object during a pass, and only during it', () => {
    const held = record({ holderAccountId: 'acct_2', sequence: 1 });
    const hold = { fromAccountId: 'acct_1', toAccountId: 'acct_2', untilTick: 100 };
    expect(authorizedDrivers(held, hold, 95)).toEqual(['acct_2', 'acct_1']);
    expect(authorizedDrivers(held, hold, 100)).toEqual(['acct_2', 'acct_1']);
    expect(authorizedDrivers(held, hold, 101)).toEqual(['acct_2']);
    expect(authorizedDrivers(held, null, 95)).toEqual(['acct_2']);
    expect(authorizedDrivers(record(), null, 0)).toEqual([]);
    expect(DEFAULT_MUTUAL_HOLD_TICKS).toBeGreaterThan(0);
  });
});

describe('diegetic arrival', () => {
  it('gives the same friend the same trail every time', () => {
    const a = defaultApproachPath(1234, 'acct_rowan');
    const b = defaultApproachPath(1234, 'acct_rowan');
    expect(a).toEqual(b);
    expect(defaultApproachPath(1234, 'acct_ash')).not.toEqual(a);
    expect(defaultApproachPath(9999, 'acct_rowan')).not.toEqual(a);
  });

  it('walks in from a distance and ends at the fire', () => {
    const path = defaultApproachPath(77, 'acct_rowan');
    const first = path.waypoints[0];
    const last = path.waypoints[path.waypoints.length - 1];
    if (first === undefined || last === undefined) throw new Error('a path needs waypoints');
    const distance = (p: { x: number; z: number }) => Math.hypot(p.x, p.z);
    expect(distance(first)).toBeGreaterThan(20);
    expect(distance(last)).toBeLessThan(distance(first));
    // Long enough to be noticed as an arrival rather than a pop-in.
    expect(path.durationMs).toBeGreaterThanOrEqual(5_000);
    expect(path.silhouetteAtMs).toBeLessThan(path.durationMs);
  });

  it('leaves back up the trail it arrived on', () => {
    const arrival = defaultApproachPath(5, 'acct_rowan');
    const departure = departurePathFrom(arrival);
    expect(departure.waypoints[0]).toEqual(arrival.waypoints[arrival.waypoints.length - 1]);
    expect(departure.waypoints[departure.waypoints.length - 1]).toEqual(arrival.waypoints[0]);
    expect(departure.glanceBack).toBe(true);
  });
});

describe('spatial voice', () => {
  it('is full volume at the fire and silent past the treeline', () => {
    expect(proximityGain(0)).toBe(1);
    expect(proximityGain(DEFAULT_VOICE_PROXIMITY.fullVolumeRadiusM)).toBe(1);
    expect(proximityGain(DEFAULT_VOICE_PROXIMITY.cutoffRadiusM)).toBe(0);
    expect(proximityGain(1_000)).toBe(0);
  });

  it('falls off monotonically', () => {
    let previous = 1;
    for (let d = 0; d <= 20; d += 0.5) {
      const gain = proximityGain(d);
      expect(gain).toBeLessThanOrEqual(previous + 1e-9);
      previous = gain;
    }
  });

  it('reports "not configured" as a first-class state, never an error', () => {
    const parsed = VoiceRoomInfoSchema.parse({
      status: 'not_configured',
      provider: 'livekit',
      reason: 'LIVEKIT_URL not set.',
      fallback: 'text_and_gesture',
    });
    expect(parsed.status).toBe('not_configured');
  });

  it('cannot describe a recorded room', () => {
    const ready = {
      status: 'ready',
      provider: 'livekit',
      roomName: 'somemore-ses_1',
      url: 'wss://voice.example',
      token: 'tok',
      expiresAt: LATER,
      proximity: DEFAULT_VOICE_PROXIMITY,
      recording: false,
    };
    expect(VoiceRoomInfoSchema.safeParse(ready).success).toBe(true);
    expect(VoiceRoomInfoSchema.safeParse({ ...ready, recording: true }).success).toBe(false);
  });
});

describe('message envelopes', () => {
  it('accepts a well-formed join and rejects a version-less one', () => {
    const join = ClientMessageSchema.parse({
      seq: 1,
      t: 'join',
      sessionId: 'ses_1',
      schemaVersion: SCHEMA_VERSION,
    });
    expect(join).toMatchObject({ voice: 'push_to_talk' });
    expect(ClientMessageSchema.safeParse({ seq: 1, t: 'join', sessionId: 'ses_1' }).success).toBe(false);
  });

  it('carries the privacy proof on the join message', () => {
    expect(
      ClientMessageSchema.safeParse({
        seq: 1,
        t: 'join',
        sessionId: 'ses_1',
        schemaVersion: SCHEMA_VERSION,
        join: { method: 'camp_code', code: 'K7QMR3' },
      }).success,
    ).toBe(true);
    expect(
      ClientMessageSchema.safeParse({
        seq: 1,
        t: 'join',
        sessionId: 'ses_1',
        schemaVersion: SCHEMA_VERSION,
        join: { method: 'camp_code', code: 'nope' },
      }).success,
    ).toBe(false);
  });

  it('bounds chat and requires a sequence on every client message', () => {
    expect(ClientMessageSchema.safeParse({ seq: 1, t: 'chat', text: 'x'.repeat(281) }).success).toBe(false);
    expect(ClientMessageSchema.safeParse({ t: 'chat', text: 'hello' }).success).toBe(false);
  });

  it('describes a snapshot as seed plus history, with no simulation state', () => {
    const snapshot = ServerMessageSchema.parse({
      t: 'snapshot',
      tick: 120,
      sessionId: 'ses_1',
      campsiteId: 'cmp_1',
      seed: 4242,
      environmentId: 'pine_hollow',
      fromTick: 0,
      inputs: [],
      authority: [],
      participants: [],
    });
    expect(snapshot).toMatchObject({ truncated: false });
    expect(Object.keys(snapshot)).not.toContain('marshmallow');
    expect(Object.keys(snapshot)).not.toContain('patches');
  });
});
