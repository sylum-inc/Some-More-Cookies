/**
 * The client half of a shared campfire, without a server.
 *
 * `test/integration/campfire-convergence.test.ts` drives the real service and
 * asserts the thing that actually matters — that two clients agree. What that
 * test cannot easily reach is the behaviour around the edges: a socket that
 * refuses to open, a server saying something this build has never heard of, a
 * person walking down a trail, a voice at the treeline. Those are here, driven
 * through a fake socket and a fake audio graph.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_SUBPROTOCOL,
  SCHEMA_VERSION,
  DEFAULT_VOICE_PROXIMITY,
  proximityGain,
  type Participant,
  type Presence,
  type ServerMessage,
} from '@somemore/protocol';
import { RealtimeTransport, backoffMs, type RealtimeTransportOptions, type SocketLike } from '../src/net/realtime.js';
import { Roster, campName, walkAlong } from '../src/net/roster.js';
import { AuthorityTable, denialLine } from '../src/net/authority.js';
import { VoiceChannel } from '../src/net/voice.js';
import { parseJoin, realtimeUrl } from '../src/net/join.js';

/* -------------------------------------------------------------------------- */
/* A socket that does what it is told                                          */
/* -------------------------------------------------------------------------- */

class FakeSocket implements SocketLike {
  readyState = 0;
  readonly sent: string[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  closedWith: { code?: number; reason?: string } | null = null;

  constructor(
    readonly url: string,
    readonly protocols: string[],
  ) {}

  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code: code ?? 1000, reason: reason ?? '' };
    this.readyState = 3;
  }

  /** The server hangs up. */
  drop(code = 1006, reason = 'gone'): void {
    this.readyState = 3;
    this.onclose?.({ code, reason, wasClean: false });
  }

  deliver(message: ServerMessage | string): void {
    this.onmessage?.({ data: typeof message === 'string' ? message : JSON.stringify(message) });
  }

  parsed(index: number): Record<string, unknown> {
    return JSON.parse(this.sent[index] as string) as Record<string, unknown>;
  }
}

function makeTransport(overrides: Partial<RealtimeTransportOptions> = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: string[] = [];
  const messages: ServerMessage[] = [];
  const malformed: string[] = [];
  const transport = new RealtimeTransport(
    {
      url: 'ws://camp.test/v1/realtime',
      token: 'tok_abc123',
      sessionId: 'ses_1',
      retryBaseMs: 10,
      retryCeilingMs: 40,
      maxRetries: 2,
      socketFactory: (url, protocols) => {
        const socket = new FakeSocket(url, protocols);
        sockets.push(socket);
        return socket;
      },
      ...overrides,
    },
    {
      onStatus: (status) => statuses.push(status),
      onMessage: (message) => messages.push(message),
      onMalformed: (_raw, reason) => malformed.push(reason),
    },
  );
  return { transport, sockets, statuses, messages, malformed };
}

const WELCOME: ServerMessage = {
  t: 'welcome',
  tick: 12,
  serverTimeMs: 1_700_000_000_000,
  sessionOriginMs: 1_699_999_999_800,
  accountId: 'acct_me',
  connectionId: 'wsc_1',
  schemaVersion: SCHEMA_VERSION,
  session: {
    id: 'ses_1',
    campsiteId: 'cmp_1',
    hostAccountId: 'acct_me',
    state: 'active',
    startedAt: '2026-08-29T12:00:00.000Z',
    endedAt: null,
    maxMembers: 8,
    presence: [],
    authorityEpoch: 0,
  },
  limits: {
    maxMessageBytes: 16384,
    messagesPerSecond: 90,
    messageBurst: 120,
    inputsPerSecond: 70,
    chatPerMinute: 20,
    authorityRequestsPerMinute: 60,
    interferencePerMinute: 12,
    interferenceCooldownMs: 8000,
    connectionsPerAccount: 3,
    maxInputHistory: 60000,
    mutualHoldTicks: 15,
  },
};

describe('the transport', () => {
  it('presents the token in a subprotocol, because a browser cannot send a header', () => {
    const { transport, sockets } = makeTransport();
    transport.connect();
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket');
    expect(socket.protocols).toEqual([REALTIME_SUBPROTOCOL, `${REALTIME_BEARER_SUBPROTOCOL_PREFIX}tok_abc123`]);
  });

  it('joins as its first message and numbers everything after it', () => {
    const { transport, sockets } = makeTransport();
    transport.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();

    expect(socket.parsed(0)).toMatchObject({ t: 'join', sessionId: 'ses_1', seq: 1 });
    transport.send({ t: 'chat', text: 'hello' });
    transport.send({ t: 'chat', text: 'again' });
    expect(socket.parsed(1)['seq']).toBe(2);
    expect(socket.parsed(2)['seq']).toBe(3);
  });

  it('asks only for what it missed when it comes back', () => {
    const { transport, sockets } = makeTransport();
    transport.resumeFromTick = 4_200;
    transport.connect();
    (sockets[0] as FakeSocket).open();
    expect(sockets[0]?.parsed(0)).toMatchObject({ sinceTick: 4_200 });
  });

  it('ignores a message this build has never heard of instead of breaking', () => {
    const { transport, sockets, malformed, messages } = makeTransport();
    transport.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    socket.deliver('{"t":"a_message_from_the_future","weather":"snow"}');
    socket.deliver('not json at all');
    socket.deliver(WELCOME);
    expect(malformed).toHaveLength(2);
    expect(messages.map((m) => m.t)).toEqual(['welcome']);
    expect(transport.status).toBe('joined');
  });

  it('refuses to send a message that would not survive the contract', () => {
    const { transport, sockets, malformed } = makeTransport();
    transport.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    const before = socket.sent.length;
    // 280 characters is the limit; this is not a message, it is a novel.
    expect(transport.send({ t: 'chat', text: 'x'.repeat(400) })).toBeNull();
    expect(socket.sent.length).toBe(before);
    expect(malformed.some((reason) => reason.startsWith('outgoing:'))).toBe(true);
  });

  it('drops back to your own fire rather than throwing when there is no socket', () => {
    const { transport } = makeTransport();
    // Never connected: sending is a no-op, not an exception. Play never waits.
    expect(transport.send({ t: 'chat', text: 'anyone there?' })).toBeNull();
    expect(transport.status).toBe('idle');
  });

  it('retries a dropped connection, with a ceiling, then goes quiet', async () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets, statuses } = makeTransport();
      transport.connect();
      (sockets[0] as FakeSocket).open();
      (sockets[0] as FakeSocket).drop();
      expect(transport.status).toBe('reconnecting');

      await vi.advanceTimersByTimeAsync(100);
      expect(sockets).toHaveLength(2);
      (sockets[1] as FakeSocket).drop();
      await vi.advanceTimersByTimeAsync(100);
      expect(sockets).toHaveLength(3);
      (sockets[2] as FakeSocket).drop();
      await vi.advanceTimersByTimeAsync(200);
      // `maxRetries: 2`, so the third failure is where it stops trying.
      expect(sockets).toHaveLength(3);
      expect(transport.status).toBe('alone');
      expect(statuses).toContain('alone');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not keep knocking when the answer was "no"', async () => {
    vi.useFakeTimers();
    try {
      const { transport, sockets } = makeTransport();
      transport.connect();
      (sockets[0] as FakeSocket).open();
      // 1008: not a member, wrong protocol version, flooding. Retrying would
      // produce the same refusal at a steady rate.
      (sockets[0] as FakeSocket).drop(1008, 'Not a member of that campsite.');
      await vi.advanceTimersByTimeAsync(500);
      expect(sockets).toHaveLength(1);
      expect(transport.status).toBe('alone');
      expect(transport.statusDetail).toContain('Not a member');
    } finally {
      vi.useRealTimers();
    }
  });

  it('measures the round trip from its own ping', () => {
    let now = 1_000;
    const { transport, sockets } = makeTransport({ now: () => now });
    transport.connect();
    const socket = sockets[0] as FakeSocket;
    socket.open();
    transport.ping();
    now = 1_048;
    socket.deliver({ t: 'pong', tick: 30, serverTimeMs: 5, clientTimeMs: 1_000 });
    expect(transport.latencyMs).toBe(48);
  });
});

describe('backoff', () => {
  it('grows, jitters, and never exceeds the ceiling', () => {
    const half = () => 0.5;
    const zero = () => 0;
    const one = () => 1;
    expect(backoffMs(1, 700, 20_000, zero)).toBe(350);
    expect(backoffMs(1, 700, 20_000, one)).toBe(700);
    expect(backoffMs(6, 700, 20_000, one)).toBe(20_000);
    // Monotonic in the attempt, for a fixed random draw.
    const schedule = [1, 2, 3, 4, 5, 6, 7].map((attempt) => backoffMs(attempt, 700, 20_000, half));
    expect(schedule).toEqual([...schedule].sort((a, b) => a - b));
    expect(Math.max(...schedule)).toBeLessThanOrEqual(20_000);
  });
});

/* -------------------------------------------------------------------------- */
/* Arrival, departure, presence                                                */
/* -------------------------------------------------------------------------- */

const PATH = {
  waypoints: [
    { x: 20, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 2, y: 0, z: 0 },
  ],
  durationMs: 6_000,
  style: 'trail' as const,
  sound: 'footsteps' as const,
  flashlight: true,
  silhouetteAtMs: 3_000,
};

function participant(accountId: string): Participant {
  return {
    accountId,
    role: 'guest',
    presence: {
      accountId,
      sessionId: 'ses_1',
      connection: 'connected',
      joinedAt: '2026-08-29T12:00:00.000Z',
      lastHeartbeatAt: '2026-08-29T12:00:00.000Z',
      role: 'guest',
      position: null,
      facingY: 0,
      activity: 'idle',
      micMuted: true,
    } satisfies Presence,
    joinedAtTick: 0,
    arrival: PATH,
    settled: false,
  };
}

describe('the walk in and the walk out', () => {
  it('places somebody along their own trail, not at the fire', () => {
    const roster = new Roster(() => 'acct_me');
    roster.arrive(participant('acct_them'), PATH, 0);
    const person = roster.get('acct_them');
    if (person === null) throw new Error('nobody arrived');
    expect(person.phase).toBe('approaching');
    expect(person.position.x).toBeCloseTo(20, 5);

    // Two thirds down: still moving, and only just becoming a shape. The
    // silhouette resolves at half way, which is what `silhouetteAtMs` says.
    roster.step(240, 1 / 60, () => 0);
    expect(person.walkProgress).toBeCloseTo(0.667, 2);
    expect(person.position.x).toBeLessThan(12);
    expect(person.legibility).toBeGreaterThan(0);
    expect(person.legibility).toBeLessThan(1);
    expect(person.flashlight).toBe(true);
  });

  it('is a light in the trees before it is a person', () => {
    const roster = new Roster(() => 'acct_me');
    roster.arrive(participant('acct_them'), PATH, 0);
    const person = roster.get('acct_them');
    if (person === null) throw new Error('nobody arrived');
    // A quarter of the way in is before `silhouetteAtMs`: nothing legible yet.
    roster.step(90, 1 / 60, () => 0);
    expect(person.legibility).toBe(0);
    expect(person.flashlight).toBe(true);
  });

  it('says out loud that somebody is coming, because a sound alone is not enough', () => {
    const roster = new Roster(() => 'acct_me');
    roster.arrive(participant('acct_them'), PATH, 0);
    const lines = roster.drainAnnouncements();
    expect(lines.join(' ')).toContain('coming down the trail');
    expect(lines.join(' ')).toContain(campName('acct_them'));
  });

  it('settles them at the fire when the walk is over', () => {
    const roster = new Roster(() => 'acct_me');
    roster.arrive(participant('acct_them'), PATH, 0);
    roster.step(600, 1 / 60, () => 0);
    const person = roster.get('acct_them');
    expect(person?.phase).toBe('here');
    expect(person?.legibility).toBe(1);
    expect(person?.flashlight).toBe(false);
    expect(roster.drainAnnouncements().join(' ')).toContain('sits down by the fire');
  });

  it('walks a departure back up the trail, with a glance back', () => {
    const roster = new Roster(() => 'acct_me');
    roster.arrive(participant('acct_them'), PATH, 0);
    roster.step(600, 1 / 60, () => 0);
    roster.depart(
      'acct_them',
      'walk_off',
      { waypoints: [...PATH.waypoints].reverse(), durationMs: 4_800, style: 'trail', sound: 'footsteps', glanceBack: true },
      600,
    );
    const person = roster.get('acct_them');
    if (person === null) throw new Error('nobody there');
    expect(person.phase).toBe('leaving');

    // Two thirds out is the glance: they are facing the fire, not the trees.
    roster.step(600 + Math.round(4.8 * 60 * 0.66), 1 / 60, () => 0);
    const toFire = Math.atan2(-person.position.z, -person.position.x);
    expect(Math.abs(person.targetFacingY - toFire)).toBeLessThan(0.01);
    expect(person.position.x).toBeGreaterThan(2);

    // And gone at the end, rather than vanishing at the start.
    roster.step(600 + 5 * 60, 1 / 60, () => 0);
    expect(roster.get('acct_them')).toBeNull();
  });

  it('gives everybody a stable, quiet name without a byte of extra protocol', () => {
    expect(campName('acct_one')).toBe(campName('acct_one'));
    expect(campName('acct_one')).not.toBe(campName('acct_two'));
    expect(campName('acct_one').split(' ')).toHaveLength(2);
  });

  it('interpolates along a polyline the way a person walks it', () => {
    const out = { x: 0, y: 0, z: 0 };
    expect(walkAlong(PATH.waypoints, 0, out)).toMatchObject({ x: 20 });
    expect(walkAlong(PATH.waypoints, 1, out)).toMatchObject({ x: 2 });
    expect(walkAlong(PATH.waypoints, 0.5, out).x).toBeCloseTo(10, 5);
    // Out of range is clamped, never extrapolated off the end of the trail.
    expect(walkAlong(PATH.waypoints, 4, out)).toMatchObject({ x: 2 });
  });

  it('eases toward a reported position instead of overshooting it', () => {
    const roster = new Roster(() => 'acct_me');
    roster.seed([{ ...participant('acct_them'), settled: true, arrival: null }], 0);
    const person = roster.get('acct_them');
    if (person === null) throw new Error('nobody there');
    roster.presence({ ...participant('acct_them').presence, position: { x: 4, y: 0, z: 0 } });
    roster.step(10, 1 / 60, () => 0);
    // Part of the way, in the right direction, and never past the target.
    expect(person.position.x).toBeGreaterThan(0);
    expect(person.position.x).toBeLessThanOrEqual(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Authority                                                                   */
/* -------------------------------------------------------------------------- */

function table(self = 'acct_me', present: string[] = ['acct_me', 'acct_them']): AuthorityTable {
  return new AuthorityTable(
    () => self,
    () => 'active',
    () => false,
    () => present,
    () => '2026-08-29T12:00:00.000Z',
  );
}

const RECORD = {
  sessionId: 'ses_1',
  objectId: 'obj_marshmallow_1',
  objectKind: 'marshmallow' as const,
  holderAccountId: null as string | null,
  grantedAt: '2026-08-29T11:59:00.000Z',
  expiresAt: null as string | null,
  sequence: 0,
  locked: false,
};

describe('holding things', () => {
  it('predicts the refusal the server would give, so the control is never offered', () => {
    const authority = table();
    authority.applyGrant(10, { ...RECORD, holderAccountId: 'acct_them', sequence: 1, expiresAt: '2026-08-29T12:05:00.000Z' }, null, []);
    expect(
      authority.wouldDeny({ objectId: RECORD.objectId, objectKind: 'marshmallow', reason: 'grab', toAccountId: 'acct_me' }),
    ).toBe('not_holder');
    // An expired lease is as good as unheld (ARCHITECTURE §6), and the server
    // clears it before deciding — so the client must not refuse on its behalf.
    authority.applyGrant(10, { ...RECORD, holderAccountId: 'acct_them', sequence: 2, expiresAt: '2026-08-29T11:00:00.000Z' }, null, []);
    expect(authority.holderOf(RECORD.objectId)).toBeNull();
    expect(
      authority.wouldDeny({ objectId: RECORD.objectId, objectKind: 'marshmallow', reason: 'grab', toAccountId: 'acct_me' }),
    ).toBeNull();
  });

  it('lets both hands hold it while it is being passed', () => {
    const authority = table();
    authority.applyGrant(100, { ...RECORD, holderAccountId: 'acct_them', sequence: 3 }, 115, ['acct_me', 'acct_them']);
    expect(new Set(authority.drivers(RECORD.objectId, 100))).toEqual(new Set(['acct_me', 'acct_them']));
    // Progress across the window is what the scene interpolates along, so the
    // stick is carried rather than teleported.
    expect(authority.handoffProgress(RECORD.objectId, 100)).toBe(0);
    expect(authority.handoffProgress(RECORD.objectId, 107)).toBeCloseTo(0.466, 2);
    expect(authority.handoffProgress(RECORD.objectId, 115)).toBeNull();
    // Afterwards, one pair of hands.
    expect(authority.drivers(RECORD.objectId, 116)).toEqual(['acct_them']);
  });

  it('lets go of everything somebody was holding when they leave', () => {
    const authority = table();
    authority.applyGrant(1, { ...RECORD, holderAccountId: 'acct_them', sequence: 1 }, null, []);
    authority.releaseAllHeldBy('acct_them', [RECORD.objectId]);
    expect(authority.holderOf(RECORD.objectId)).toBeNull();
  });

  it('refuses in words rather than in codes', () => {
    expect(denialLine('not_holder', { ...RECORD, holderAccountId: 'acct_them' }, () => 'Pine Hollow')).toBe(
      "[it is in Pine Hollow's hands]",
    );
    expect(denialLine('object_locked', RECORD, () => 'x')).toContain('mid-run');
    expect(denialLine('target_not_present', RECORD, () => 'x')).toContain('not at the fire');
  });
});

/* -------------------------------------------------------------------------- */
/* Voice                                                                       */
/* -------------------------------------------------------------------------- */

class FakeEmitter {
  gain = -1;
  position: [number, number, number] = [0, 0, 0];
  stream: MediaStream | null = null;
  detached = false;
  setGain(value: number): void {
    this.gain = value;
  }
  setPosition(x: number, y: number, z: number): void {
    this.position = [x, y, z];
  }
  attachMediaStream(stream: MediaStream): unknown {
    this.stream = stream;
    return {};
  }
  detachMediaStream(): void {
    this.detached = true;
    this.stream = null;
  }
}

function voiceWithAudio(): { voice: VoiceChannel; emitters: FakeEmitter[] } {
  const voice = new VoiceChannel();
  const emitters: FakeEmitter[] = [];
  voice.useAudio({
    createEmitter: () => {
      const emitter = new FakeEmitter();
      emitters.push(emitter);
      return emitter as never;
    },
    releaseEmitter: () => undefined,
  });
  return { voice, emitters };
}

describe('voice', () => {
  it('carries the fire with text and gesture when there is no provider', () => {
    const voice = new VoiceChannel();
    voice.applyRoom({
      status: 'not_configured',
      provider: 'livekit',
      reason: 'LIVEKIT_URL, LIVEKIT_API_KEY and LIVEKIT_API_SECRET are not set.',
      fallback: 'text_and_gesture',
    });
    expect(voice.status).toBe('text_and_gesture');
    expect(voice.reason).toContain('LIVEKIT_URL');
    // The guarantee is a type, not a setting.
    expect(voice.recording).toBe(false);
  });

  it('attenuates a voice by the shared curve, not by the panner', () => {
    const { voice, emitters } = voiceWithAudio();
    voice.attach('acct_them', {} as MediaStream);
    const emitter = emitters[0];
    if (emitter === undefined) throw new Error('no emitter');

    // Inside the ring of light: no attenuation at all.
    voice.update({ x: 0, y: 0, z: 0 }, [{ accountId: 'acct_them', position: { x: 1, y: 0, z: 0 } }]);
    expect(emitter.gain).toBe(1);

    // Across the clearing: exactly `proximityGain`, which is what a
    // server-side mixer would compute for the same pair.
    voice.update({ x: 0, y: 0, z: 0 }, [{ accountId: 'acct_them', position: { x: 9, y: 0, z: 0 } }]);
    expect(emitter.gain).toBeCloseTo(proximityGain(9, DEFAULT_VOICE_PROXIMITY), 10);

    // Past the treeline: gone.
    voice.update({ x: 0, y: 0, z: 0 }, [{ accountId: 'acct_them', position: { x: 40, y: 0, z: 0 } }]);
    expect(emitter.gain).toBe(0);
  });

  it('multiplies the listener own volume into the same gain', () => {
    const { voice, emitters } = voiceWithAudio();
    voice.attach('acct_them', {} as MediaStream);
    voice.setVolume('acct_them', 0.25);
    voice.update({ x: 0, y: 0, z: 0 }, [{ accountId: 'acct_them', position: { x: 0, y: 0, z: 0 } }]);
    expect(emitters[0]?.gain).toBeCloseTo(0.25, 10);
  });

  it('is a wall rather than a filter when somebody is blocked', () => {
    const { voice, emitters } = voiceWithAudio();
    voice.attach('acct_them', {} as MediaStream);
    voice.setBlocked('acct_them', true);
    expect(emitters[0]?.detached).toBe(true);
    expect(voice.attachedCount).toBe(0);
    // And they cannot be attached again while blocked.
    expect(voice.attach('acct_them', {} as MediaStream)).toBe(false);
  });

  it('only opens the microphone when the mode and the mute say so', () => {
    const voice = new VoiceChannel();
    voice.mode = 'push_to_talk';
    voice.muted = false;
    expect(voice.open).toBe(false);
    voice.transmitting = true;
    expect(voice.open).toBe(true);
    voice.muted = true;
    expect(voice.open).toBe(false);
    voice.muted = false;
    voice.mode = 'open_mic';
    expect(voice.open).toBe(true);
    voice.mode = 'off';
    expect(voice.open).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Walking down a link                                                         */
/* -------------------------------------------------------------------------- */

describe('arriving from a link', () => {
  it('reads a session and a way in out of a query string', () => {
    expect(parseJoin('?fire=ses_1&invite=abcdefghijklmnopqrst')).toEqual({
      sessionId: 'ses_1',
      join: { method: 'invite_link', token: 'abcdefghijklmnopqrst' },
    });
    expect(parseJoin('?fire=ses_1&code=pine-hollow-42')?.join).toEqual({
      method: 'camp_code',
      code: 'PINE-HOLLOW-42',
    });
    expect(parseJoin('?fire=ses_1')?.join).toBeUndefined();
  });

  it('is nothing at all without a fire to walk to', () => {
    expect(parseJoin('')).toBeNull();
    expect(parseJoin('?camp=pine-hollow')).toBeNull();
  });

  it('shares an origin with the API, upgrading the scheme', () => {
    expect(realtimeUrl('https://api.somemore.test')).toBe('wss://api.somemore.test/v1/realtime');
    expect(realtimeUrl('http://127.0.0.1:8787')).toBe('ws://127.0.0.1:8787/v1/realtime');
    expect(realtimeUrl('', '/v1/realtime', 'https://play.somemore.test')).toBe('wss://play.somemore.test/v1/realtime');
  });
});
