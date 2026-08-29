import { connect as netConnect } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { REALTIME_PATH } from '@somemore/protocol';
import { openWebSocket } from '../src/realtime/client.js';
import { TokenBucket, acceptKey, generateClientKey } from '../src/realtime/index.js';
import {
  expectUpgradeRejected,
  fireside,
  joinMessage,
  settle,
  startRealtimeHarness,
  until,
  type RealtimeHarness,
} from './realtime-harness.js';

let rig: RealtimeHarness;

afterEach(async () => {
  await rig.close();
});

describe('token bucket', () => {
  beforeEach(async () => {
    rig = await startRealtimeHarness();
  });

  it('spends a burst, then refills at the configured rate', () => {
    const bucket = new TokenBucket(10, 5, 0);
    for (let i = 0; i < 10; i += 1) expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.retryAfterMs(0)).toBe(200);

    expect(bucket.tryTake(200)).toBe(true);
    expect(bucket.tryTake(200)).toBe(false);
    // Never more than the burst, however long it has been idle.
    expect(bucket.tryTake(1_000_000)).toBe(true);
    expect(bucket.available).toBeLessThanOrEqual(10);
  });
});

describe('hard limits', () => {
  beforeEach(async () => {
    rig = await startRealtimeHarness();
  });

  it('hangs up on an oversized message rather than buffering it', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    const oversized = JSON.stringify({ seq: 2, t: 'chat', text: 'x'.repeat(rig.realtime.limits.maxMessageBytes) });
    expect(oversized.length).toBeGreaterThan(rig.realtime.limits.maxMessageBytes);
    client.sendText(oversized);

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1009);
    expect(closed.reason).toContain('byte limit');
  });

  it('refuses an oversized frame announced in the header alone', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    // A masked text frame claiming 2 GiB, with none of it supplied.
    const header = Buffer.alloc(14);
    header[0] = 0x81;
    header[1] = 0xff;
    header.writeBigUInt64BE(BigInt(2 ** 31), 2);
    Buffer.from([1, 2, 3, 4]).copy(header, 10);
    (client as unknown as { raw: { socket: NodeJS.WritableStream } }).raw.socket.write(header);

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1009);
  });

  it('disconnects a flooding client after a run of refusals', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    // The manual clock does not advance, so nothing refills: this is a client
    // that has been told to slow down and has not.
    for (let i = 0; i < 400; i += 1) {
      client.sendRaw({ seq: i + 100, t: 'chat', text: 'more' });
    }

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);

    // It was told to slow down a bounded number of times and then hung up on:
    // the server does not keep answering a client it has already given up on.
    const limited = client.all('error').filter((m) => m.code === 'rate_limited');
    expect(limited.length).toBeGreaterThan(0);
    expect(limited.length).toBeLessThanOrEqual(rig.realtime.limits.rateLimitStrikes + 1);
    // ...and it was served normally first, rather than punished from the off.
    expect(client.all('ack').length).toBeGreaterThan(5);
    expect(client.all('ack').length + limited.length).toBeLessThan(400);
  });

  it('caps concurrent connections per account', async () => {
    const { host, session } = await fireside(rig.api);
    const allowed = rig.realtime.limits.connectionsPerAccount;
    for (let i = 0; i < allowed; i += 1) {
      const client = await rig.connect(host);
      client.send(joinMessage(session.id));
      await client.waitFor('welcome');
    }
    const failure = await expectUpgradeRejected(openWebSocket({ url: rig.wsUrl, token: host.token }));
    expect(failure.status).toBe(429);
    expect(failure.body).toContain('rate_limited');
  });

  it('closes a socket that connects and never joins', async () => {
    const { host } = await fireside(rig.api);
    const client = await rig.connect(host);
    rig.api.clock.advance(rig.realtime.limits.joinTimeoutMs + 1_000);
    await rig.realtime.sweep();

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);
    expect(client.all('error').some((m) => m.code === 'not_joined')).toBe(true);
  });

  it('refuses binary frames', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    client.connection.sendBinary(Buffer.from([1, 2, 3]));
    const closed = await client.waitForClose();
    expect(closed.code).toBe(1003);
  });
});

describe('keepalive and reaping', () => {
  beforeEach(async () => {
    // The join deadline is shorter than the ping interval by default, which is
    // right in production and unhelpful here: this test is about the *idle*
    // path, so give the socket all the time in the world to join.
    rig = await startRealtimeHarness({ limits: { joinTimeoutMs: 10 * 60_000 } });
  });

  /**
   * A client that stops answering has to be noticed, or the fire fills up with
   * ghosts holding marshmallows. The reaper is driven by the injected clock, so
   * this is exact rather than a sleep.
   */
  it('pings an idle socket and reaps one that never answers', async () => {
    const { host, session } = await fireside(rig.api);
    const port = (rig.api.app.server.address() as { port: number }).port;

    // A hand-rolled socket that completes the handshake and then plays dead:
    // it never sends a pong, because it never sends anything.
    const socket = netConnect({ host: '127.0.0.1', port });
    await new Promise((resolve) => socket.once('connect', resolve));
    const clientKey = generateClientKey();
    socket.write(
      [
        `GET ${REALTIME_PATH} HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${clientKey}`,
        'Sec-WebSocket-Version: 13',
        `Authorization: Bearer ${host.token}`,
        '',
        '',
      ].join('\r\n'),
    );
    const head = await new Promise<Buffer>((resolve) => socket.once('data', (chunk: Buffer) => resolve(chunk)));
    expect(head.toString('latin1')).toContain('101 Switching Protocols');
    expect(head.toString('latin1')).toContain(acceptKey(clientKey));

    const frames: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => frames.push(chunk));
    let destroyed = false;
    socket.on('close', () => {
      destroyed = true;
    });

    // It has not joined yet, so first make it look like a real participant.
    void session;

    // Idle past the ping interval: the server probes it.
    rig.api.clock.advance(rig.realtime.limits.pingIntervalMs + 100);
    await rig.realtime.sweep();
    await until(() => frames.some((f) => (f[0] as number) === 0x89));

    // Still silent past the pong deadline: reaped.
    rig.api.clock.advance(rig.realtime.limits.pongTimeoutMs + 100);
    await rig.realtime.sweep();
    await until(() => destroyed);
    await settle();
    expect(rig.realtime.stats().connections).toBe(0);
  });

  it('treats any inbound traffic as liveness', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    for (let i = 0; i < 3; i += 1) {
      rig.api.clock.advance(rig.realtime.limits.pingIntervalMs - 1_000);
      const seq = client.send({ t: 'ping', clientTimeMs: 0 });
      await client.waitFor('pong');
      void seq;
      await rig.realtime.sweep();
    }
    expect(client.closed).toBeNull();
    expect(rig.realtime.stats().connections).toBe(1);
  });
});

describe('a smaller budget', () => {
  beforeEach(async () => {
    rig = await startRealtimeHarness({ limits: { maxMessageBytes: 512, messageBurst: 4, rateLimitStrikes: 2 } });
  });

  it('applies the configured limits, and tells the client what they are', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    const welcome = await client.waitFor('welcome');
    expect(welcome.limits.maxMessageBytes).toBe(512);
    expect(welcome.limits.messageBurst).toBe(4);

    for (let i = 0; i < 20; i += 1) client.sendRaw({ seq: i + 50, t: 'chat', text: 'hi' });
    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);
  });
});
