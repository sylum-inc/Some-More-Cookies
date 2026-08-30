import { Duplex } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { WsConnection } from '../src/realtime/connection.js';
import { OPCODE, encodeFrame } from '../src/realtime/frame.js';

/*
 * What an open socket costs us.
 *
 * The framing tests next door are about correctness — does the parser agree
 * with RFC 6455. These are about the other half of "a permissive WebSocket
 * parser is a security bug": what a peer that is *within* the protocol can
 * make this process spend. Both cases below are legal WebSocket traffic. Both
 * of them used to buy far more of our memory than they cost in bandwidth, and
 * neither was visible to the per-connection message limiter, which only ever
 * counts completed messages.
 */

/** A socket that accepts reads and never drains a write. */
class StalledSocket extends Duplex {
  override _read(): void {
    /* the test pushes */
  }

  override _write(_chunk: Buffer, _encoding: BufferEncoding, _done: () => void): void {
    // Deliberately never calls `done`, which is what a peer with a full
    // receive window looks like from here.
  }
}

const MASK = Buffer.from([0x0a, 0x1b, 0x2c, 0x3d]);

function connect(socket: Duplex, maxBufferedBytes = 1024): WsConnection {
  return new WsConnection(
    { socket, role: 'server', maxMessageBytes: 16 * 1024, maxFrameBytes: 64 * 1024, maxBufferedBytes },
    {},
  );
}

/** Let the stream machinery deliver everything that has been pushed. */
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

describe('resource exhaustion over a legal WebSocket', () => {
  /*
   * A zero-length continuation frame is six bytes on the wire and adds nothing
   * to a message's byte count, so `maxMessageBytes` never trips — but each one
   * put a `Buffer` in the accumulator. Measured before the fragment ceiling
   * existed: 1.2 MB of traffic held 200,001 buffers.
   */
  it('hangs up on a message fragmented into an absurd number of frames', async () => {
    const socket = new StalledSocket();
    const connection = connect(socket);

    socket.push(encodeFrame({ opcode: OPCODE.text, payload: Buffer.alloc(0), fin: false, mask: true, maskKey: MASK }));
    const empty = encodeFrame({
      opcode: OPCODE.continuation,
      payload: Buffer.alloc(0),
      fin: false,
      mask: true,
      maskKey: MASK,
    });
    expect(empty.length).toBe(6);
    for (let i = 0; i < 20_000; i += 1) socket.push(empty);
    await settle();

    expect(connection.readyState).not.toBe('open');
    // And nothing is still being held on behalf of a message that will never
    // arrive: a violation that leaves the accumulator full has not defended
    // anything.
    expect((connection as unknown as { fragments: Buffer[] | null }).fragments).toBeNull();
  });

  /*
   * The RFC requires a pong for every ping. A peer that pings hard and never
   * reads therefore makes us mirror its traffic into a socket buffer nobody is
   * emptying — 6.35 MB queued from 6.55 MB of pings, on a connection whose
   * declared ceiling was one kilobyte, because control frames skipped the
   * backpressure check.
   */
  it('hangs up on a peer that pings faster than it reads', async () => {
    const socket = new StalledSocket();
    const connection = connect(socket, 1024);

    const ping = encodeFrame({
      opcode: OPCODE.ping,
      payload: Buffer.alloc(125, 0x41),
      fin: true,
      mask: true,
      maskKey: MASK,
    });
    for (let i = 0; i < 20_000; i += 1) socket.push(ping);
    await settle();

    expect(connection.readyState).not.toBe('open');
    // A close frame is allowed out past the ceiling — refusing to write that
    // would mean refusing to hang up — so the bound is "a frame or two", not
    // zero.
    expect(socket.writableLength).toBeLessThan(8 * 1024);
  });

  it('still accepts an ordinary fragmented message', async () => {
    const received: string[] = [];
    const socket = new StalledSocket();
    const connection = new WsConnection(
      { socket, role: 'server', maxMessageBytes: 16 * 1024, maxFrameBytes: 64 * 1024, maxBufferedBytes: 1024 },
      { onMessage: (data) => received.push(String(data)) },
    );

    const parts = ['{"t":"pi', 'ng","se', 'q":1}'];
    parts.forEach((part, index) => {
      socket.push(
        encodeFrame({
          opcode: index === 0 ? OPCODE.text : OPCODE.continuation,
          payload: Buffer.from(part, 'utf8'),
          fin: index === parts.length - 1,
          mask: true,
          maskKey: MASK,
        }),
      );
    });
    await settle();

    expect(connection.readyState).toBe('open');
    expect(received).toEqual(['{"t":"ping","seq":1}']);
  });
});
