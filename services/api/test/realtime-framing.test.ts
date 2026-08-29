import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REALTIME_SUBPROTOCOL, SCHEMA_VERSION } from '@somemore/protocol';
import {
  FrameReader,
  OPCODE,
  WsProtocolError,
  acceptKey,
  applyMask,
  decodeClosePayload,
  encodeClosePayload,
  encodeFrame,
  isValidClientKey,
  isValidCloseCode,
  negotiateSubprotocol,
  parseUpgradeRequest,
  extractToken,
} from '../src/realtime/index.js';
import { openWebSocket } from '../src/realtime/client.js';
import {
  expectUpgradeRejected,
  fireside,
  joinMessage,
  settle,
  startRealtimeHarness,
  until,
  type RealtimeHarness,
} from './realtime-harness.js';

/*
 * The framing tests are written against the byte vectors in RFC 6455 §1.3 and
 * §5.7 rather than against our own encoder, so a bug that made the reader and
 * the writer agree with each other but not with the RFC would still be caught.
 */

const hex = (buffer: Buffer): string => buffer.toString('hex');
const bytes = (...values: number[]): Buffer => Buffer.from(values);

describe('handshake (RFC 6455 §1.3)', () => {
  it('computes the accept key from the RFC worked example', () => {
    expect(acceptKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe('s3pPLMBiTxaQ9kYGzzhZRbK+xOo=');
  });

  it('only accepts a 16-byte base64 nonce', () => {
    expect(isValidClientKey('dGhlIHNhbXBsZSBub25jZQ==')).toBe(true);
    expect(isValidClientKey('too-short')).toBe(false);
    expect(isValidClientKey('AAAAAAAAAAAAAAAAAAAAAAAA')).toBe(false);
  });

  it('rejects an upgrade that is not actually a WebSocket upgrade', () => {
    const good = {
      method: 'GET',
      url: '/v1/realtime',
      headers: {
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-version': '13',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        host: 'localhost',
      },
    };
    expect(parseUpgradeRequest(good).ok).toBe(true);

    const cases: [Record<string, unknown>, number][] = [
      [{ method: 'POST' }, 405],
      [{ headers: { ...good.headers, upgrade: 'h2c' } }, 400],
      [{ headers: { ...good.headers, connection: 'keep-alive' } }, 400],
      [{ headers: { ...good.headers, 'sec-websocket-version': '8' } }, 426],
      [{ headers: { ...good.headers, 'sec-websocket-key': 'nope' } }, 400],
    ];
    for (const [override, status] of cases) {
      const result = parseUpgradeRequest({ ...good, ...override } as typeof good);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.rejection.status).toBe(status);
    }
  });

  it('finds a bearer token in a header, a subprotocol or the query string', () => {
    const url = new URL('http://localhost/v1/realtime?token=from-query');
    expect(extractToken({ authorization: 'Bearer from-header' }, url, [])).toBe('from-header');
    expect(extractToken({}, url, [REALTIME_SUBPROTOCOL, 'somemore.bearer.from-subprotocol'])).toBe('from-subprotocol');
    expect(extractToken({}, url, [])).toBe('from-query');
    expect(extractToken({}, new URL('http://localhost/v1/realtime'), [])).toBeNull();
  });

  it('speaks exactly one sub-protocol', () => {
    expect(negotiateSubprotocol([REALTIME_SUBPROTOCOL, 'graphql-ws'])).toBe(REALTIME_SUBPROTOCOL);
    expect(negotiateSubprotocol(['graphql-ws'])).toBeNull();
  });
});

describe('framing (RFC 6455 §5.7)', () => {
  it('writes an unmasked single-frame text message', () => {
    const frame = encodeFrame({ opcode: OPCODE.text, payload: Buffer.from('Hello') });
    expect(hex(frame)).toBe(hex(bytes(0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f)));
  });

  it('writes a masked single-frame text message with the RFC’s key', () => {
    const frame = encodeFrame({
      opcode: OPCODE.text,
      payload: Buffer.from('Hello'),
      mask: true,
      maskKey: bytes(0x37, 0xfa, 0x21, 0x3d),
    });
    expect(hex(frame)).toBe(hex(bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58)));
  });

  it('writes 16-bit and 64-bit extended lengths', () => {
    const medium = encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(256) });
    expect(hex(medium.subarray(0, 4))).toBe('827e0100');
    const large = encodeFrame({ opcode: OPCODE.binary, payload: Buffer.alloc(65_536) });
    expect(hex(large.subarray(0, 10))).toBe('827f0000000000010000');
  });

  it('writes a ping the RFC would recognise', () => {
    expect(hex(encodeFrame({ opcode: OPCODE.ping, payload: Buffer.from('Hello') }))).toBe('890548656c6c6f');
  });

  it('reads the RFC’s fragmented message back as one message', () => {
    const reader = new FrameReader({ requireMask: false, maxFrameBytes: 1024 });
    const frames = reader.receive(Buffer.concat([bytes(0x01, 0x03, 0x48, 0x65, 0x6c), bytes(0x80, 0x02, 0x6c, 0x6f)]));
    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ fin: false, opcode: OPCODE.text });
    expect(frames[1]).toMatchObject({ fin: true, opcode: OPCODE.continuation });
    expect(Buffer.concat(frames.map((f) => f.payload)).toString()).toBe('Hello');
  });

  it('reads a masked frame, whatever byte boundaries TCP chose', () => {
    const frame = bytes(0x81, 0x85, 0x37, 0xfa, 0x21, 0x3d, 0x7f, 0x9f, 0x4d, 0x51, 0x58);
    for (const split of [1, 2, 4, 6, 9]) {
      const reader = new FrameReader({ requireMask: true, maxFrameBytes: 1024 });
      expect(reader.receive(frame.subarray(0, split))).toHaveLength(0);
      const frames = reader.receive(frame.subarray(split));
      expect(frames).toHaveLength(1);
      expect((frames[0] as { payload: Buffer }).payload.toString()).toBe('Hello');
    }
  });

  it('masks symmetrically', () => {
    const key = bytes(0x11, 0x22, 0x33, 0x44);
    const payload = Buffer.from('some more, please');
    const masked = applyMask(Buffer.from(payload), key);
    expect(masked.equals(payload)).toBe(false);
    expect(applyMask(masked, key).equals(payload)).toBe(true);
  });

  it('refuses everything a well-behaved peer would never send', () => {
    const cases: [string, Buffer, number][] = [
      ['an unmasked client frame', bytes(0x81, 0x05, 0x48, 0x65, 0x6c, 0x6c, 0x6f), 1002],
      ['a reserved bit', bytes(0xc1, 0x80, 0, 0, 0, 0), 1002],
      ['a reserved opcode', bytes(0x83, 0x80, 0, 0, 0, 0), 1002],
      ['a fragmented control frame', bytes(0x09, 0x80, 0, 0, 0, 0), 1002],
      ['an oversized control frame', bytes(0x89, 0xfe, 0x01, 0x00), 1002],
    ];
    for (const [what, buffer, closeCode] of cases) {
      const reader = new FrameReader({ requireMask: true, maxFrameBytes: 1024 });
      try {
        reader.receive(buffer);
        throw new Error(`expected ${what} to be refused`);
      } catch (error) {
        expect(error).toBeInstanceOf(WsProtocolError);
        expect((error as WsProtocolError).closeCode).toBe(closeCode);
      }
    }
  });

  it('rejects an oversized frame from its header, before buffering a byte', () => {
    const reader = new FrameReader({ requireMask: true, maxFrameBytes: 64 });
    // Announces 65 536 bytes; only four bytes are actually supplied.
    expect(() => reader.receive(bytes(0x82, 0xfe, 0x01, 0x00))).toThrowError(/exceeds the 64 byte limit/);
    expect(reader.buffered).toBeLessThan(16);
  });

  it('round-trips a close payload and rejects reserved codes', () => {
    expect(decodeClosePayload(encodeClosePayload(1000, 'goodnight'))).toEqual({ code: 1000, reason: 'goodnight' });
    expect(decodeClosePayload(Buffer.alloc(0))).toEqual({ code: 1005, reason: '' });
    expect(() => decodeClosePayload(bytes(0x03))).toThrowError(WsProtocolError);
    expect(() => decodeClosePayload(encodeClosePayload(1005))).toThrowError(/reserved/);
    expect(isValidCloseCode(1000)).toBe(true);
    expect(isValidCloseCode(1004)).toBe(false);
    expect(isValidCloseCode(4000)).toBe(true);
  });
});

describe('framing against the live server', () => {
  let rig: RealtimeHarness;

  beforeEach(async () => {
    rig = await startRealtimeHarness();
  });

  afterEach(async () => {
    await rig.close();
  });

  it('completes the upgrade and echoes the sub-protocol', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    expect(client.subprotocol).toBe(REALTIME_SUBPROTOCOL);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');
  });

  it('accepts a browser-style token in the sub-protocol list', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host, { tokenIn: 'subprotocol' });
    client.send(joinMessage(session.id));
    const welcome = await client.waitFor('welcome');
    expect(welcome.accountId).toBe(host.accountId);
  });

  it('reassembles a message split across two frames', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    const text = JSON.stringify({ seq: 1, t: 'join', sessionId: session.id, schemaVersion: SCHEMA_VERSION });
    client.sendFragmented(text, 12);
    const welcome = await client.waitFor('welcome');
    expect(welcome.session.id).toBe(session.id);
  });

  it('answers a ping frame with a pong carrying the same body', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    client.ping(Buffer.from('marshmallow'));
    await until(() => client.pongs.length > 0);
    expect(client.pongs[0]?.toString()).toBe('marshmallow');
  });

  it('closes cleanly, with the code the client asked for', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    client.close(1000, 'goodnight');
    const info = await client.waitForClose();
    expect(info.clean).toBe(true);
    expect(info.code).toBe(1000);
    await settle();
    expect(rig.realtime.stats().connections).toBe(0);
  });

  it('refuses an unauthenticated upgrade with HTTP 401, not a socket', async () => {
    const failure = await expectUpgradeRejected(openWebSocket({ url: rig.wsUrl }));
    expect(failure.status).toBe(401);
    expect(failure.body).toContain('unauthorized');
  });

  it('refuses an upgrade on any other path', async () => {
    const { host } = await fireside(rig.api);
    const failure = await expectUpgradeRejected(
      openWebSocket({ url: rig.wsUrl.replace('/v1/realtime', '/v1/not-here'), token: host.token }),
    );
    expect(failure.status).toBe(404);
  });
});
