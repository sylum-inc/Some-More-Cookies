/**
 * A WebSocket client, also written by hand.
 *
 * It exists for two reasons: the tests need something to drive the server with
 * that is not the server's own convenience wrapper, and a headless client is
 * how the replay guarantee in ADR-0006 gets exercised without a browser. It
 * speaks the same framing module as the server but the opposite way round —
 * this side masks, the server side does not — so a bug that made both agree
 * would still be caught by the byte-level handshake and framing tests.
 */

import { connect as netConnect, type Socket } from 'node:net';
import {
  ClientMessageSchema,
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_SUBPROTOCOL,
  ServerMessageSchema,
  type ClientMessage,
  type ServerMessage,
  type ServerMessageType,
} from '@somemore/protocol';
import { WsConnection, type ConnectionClose } from './connection.js';
import { generateClientKey, verifyAcceptResponse } from './handshake.js';
import { OPCODE, encodeFrame } from './frame.js';

export interface RawClientOptions {
  readonly url: string;
  readonly token?: string | null;
  /** Where to put the token. Browsers can only do `subprotocol` or `query`. */
  readonly tokenIn?: 'header' | 'subprotocol' | 'query';
  readonly headers?: Readonly<Record<string, string>>;
  readonly subprotocols?: readonly string[];
  readonly maxMessageBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxBufferedBytes?: number;
  readonly handshakeTimeoutMs?: number;
}

export class HandshakeFailure extends Error {
  readonly status: number;
  readonly body: string;

  constructor(status: number, body: string, message: string) {
    super(message);
    this.name = 'HandshakeFailure';
    this.status = status;
    this.body = body;
  }
}

export interface RawClient {
  readonly connection: WsConnection;
  readonly subprotocol: string | null;
  readonly socket: Socket;
}

const MAX_HANDSHAKE_HEAD_BYTES = 16 * 1024;

/** Open a raw WebSocket connection: TCP, handshake, verification. */
export async function openWebSocket(
  options: RawClientOptions,
  handlers: {
    onMessage?(data: string | Buffer, isBinary: boolean): void;
    onClose?(info: ConnectionClose): void;
    onPong?(payload: Buffer): void;
    onError?(error: Error): void;
  } = {},
): Promise<RawClient> {
  const url = new URL(options.url);
  const tokenIn = options.tokenIn ?? 'header';
  const subprotocols = [...(options.subprotocols ?? [REALTIME_SUBPROTOCOL])];
  if (options.token != null && tokenIn === 'subprotocol') {
    subprotocols.push(`${REALTIME_BEARER_SUBPROTOCOL_PREFIX}${options.token}`);
  }
  if (options.token != null && tokenIn === 'query') {
    url.searchParams.set('token', options.token);
  }

  const key = generateClientKey();
  const port = url.port === '' ? 80 : Number(url.port);
  const socket = netConnect({ host: url.hostname, port });
  socket.setNoDelay(true);

  const requestLines = [
    `GET ${url.pathname}${url.search} HTTP/1.1`,
    `Host: ${url.hostname}:${port}`,
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Key: ${key}`,
    'Sec-WebSocket-Version: 13',
  ];
  if (subprotocols.length > 0) requestLines.push(`Sec-WebSocket-Protocol: ${subprotocols.join(', ')}`);
  if (options.token != null && tokenIn === 'header') requestLines.push(`Authorization: Bearer ${options.token}`);
  for (const [name, value] of Object.entries(options.headers ?? {})) requestLines.push(`${name}: ${value}`);

  const { head, rest } = await new Promise<{ head: string; rest: Buffer }>((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error('WebSocket handshake timed out.'));
    }, options.handshakeTimeoutMs ?? 10_000);
    timer.unref?.();

    function cleanup(): void {
      clearTimeout(timer);
      socket.off('data', onData);
      socket.off('error', onError);
    }
    function onError(error: Error): void {
      cleanup();
      reject(error);
    }
    function onData(chunk: Buffer): void {
      buffer = Buffer.concat([buffer, chunk]);
      const boundary = buffer.indexOf('\r\n\r\n');
      if (boundary < 0) {
        if (buffer.length > MAX_HANDSHAKE_HEAD_BYTES) {
          cleanup();
          socket.destroy();
          reject(new Error('Handshake response headers are implausibly large.'));
        }
        return;
      }
      cleanup();
      socket.pause();
      resolve({ head: buffer.subarray(0, boundary).toString('latin1'), rest: buffer.subarray(boundary + 4) });
    }

    socket.on('error', onError);
    socket.on('data', onData);
    socket.on('connect', () => socket.write(`${requestLines.join('\r\n')}\r\n\r\n`));
  });

  const verified = verifyAcceptResponse(head, key);
  if (!verified.ok) {
    const status = Number(/^HTTP\/1\.1 (\d{3})/.exec(head)?.[1] ?? 0);
    socket.destroy();
    throw new HandshakeFailure(status, rest.toString('utf8'), verified.reason);
  }

  const connection = new WsConnection(
    {
      socket,
      role: 'client',
      maxMessageBytes: options.maxMessageBytes ?? 1024 * 1024,
      maxFrameBytes: options.maxFrameBytes ?? 1024 * 1024,
      maxBufferedBytes: options.maxBufferedBytes ?? 4 * 1024 * 1024,
      initialChunk: rest,
    },
    handlers,
  );
  socket.resume();

  return { connection, subprotocol: verified.subprotocol, socket };
}

/* -------------------------------------------------------------------------- */
/* The Some More client                                                        */
/* -------------------------------------------------------------------------- */

export interface RealtimeClientOptions extends RawClientOptions {
  /** Fail loudly on a malformed server message instead of dropping it. */
  readonly strict?: boolean;
}

type Waiter = { match(message: ServerMessage): boolean; resolve(message: ServerMessage): void; reject(error: Error): void; timer: NodeJS.Timeout };

/**
 * A typed client for the realtime contract: keeps the per-client `seq`
 * monotonic, validates everything the server sends, and lets a test wait for a
 * specific message instead of sleeping and hoping.
 */
export class RealtimeClient {
  private readonly raw: RawClient;
  private readonly waiters: Waiter[] = [];
  private readonly options: RealtimeClientOptions;
  private seqCounter = 0;

  readonly received: ServerMessage[] = [];
  readonly errors: Error[] = [];
  /** Pong payloads the server sent back, for keepalive assertions. */
  readonly pongs: Buffer[] = [];
  closed: ConnectionClose | null = null;

  private constructor(raw: RawClient, options: RealtimeClientOptions) {
    this.raw = raw;
    this.options = options;
  }

  static async connect(options: RealtimeClientOptions): Promise<RealtimeClient> {
    let client: RealtimeClient | null = null;
    const raw = await openWebSocket(options, {
      onMessage: (data, isBinary) => {
        if (isBinary || client === null) return;
        client.ingest(data as string);
      },
      onClose: (info) => {
        if (client === null) return;
        client.closed = info;
        client.failWaiters(new Error(`Connection closed: ${info.code} ${info.reason}`));
      },
      onPong: (payload) => client?.pongs.push(payload),
      onError: (error) => client?.errors.push(error),
    });
    client = new RealtimeClient(raw, options);
    return client;
  }

  get connection(): WsConnection {
    return this.raw.connection;
  }

  get subprotocol(): string | null {
    return this.raw.subprotocol;
  }

  /** Next `seq` this client will use. Monotonic for the life of the socket. */
  get nextSeq(): number {
    return this.seqCounter;
  }

  private ingest(text: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      this.errors.push(error as Error);
      return;
    }
    const result = ServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      const error = new Error(`Server sent a message this client cannot parse: ${result.error.message}`);
      this.errors.push(error);
      if (this.options.strict === true) throw error;
      return;
    }
    this.received.push(result.data);
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const waiter = this.waiters[i] as Waiter;
      if (waiter.match(result.data)) {
        this.waiters.splice(i, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(result.data);
      }
    }
  }

  private failWaiters(error: Error): void {
    while (this.waiters.length > 0) {
      const waiter = this.waiters.pop() as Waiter;
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  /** Send an already-numbered message verbatim. Used to test bad input. */
  sendRaw(message: unknown): void {
    this.raw.connection.send(JSON.stringify(message));
  }

  /** Send a message, filling in the next `seq`. Returns the seq used. */
  send(message: Omit<ClientMessage, 'seq'> & { seq?: number }): number {
    const seq = message.seq ?? (this.seqCounter += 1);
    const full = { ...message, seq } as ClientMessage;
    const validated = ClientMessageSchema.parse(full);
    this.raw.connection.send(JSON.stringify(validated));
    return seq;
  }

  /** Send an oversized or malformed payload deliberately. */
  sendText(text: string): void {
    this.raw.connection.send(text);
  }

  /** Send one message in two fragments, to exercise the reassembler. */
  sendFragmented(text: string, splitAt: number): void {
    const payload = Buffer.from(text, 'utf8');
    const head = payload.subarray(0, splitAt);
    const tail = payload.subarray(splitAt);
    this.raw.socket.write(encodeFrame({ opcode: OPCODE.text, payload: head, fin: false, mask: true }));
    this.raw.socket.write(encodeFrame({ opcode: OPCODE.continuation, payload: tail, fin: true, mask: true }));
  }

  ping(payload: Buffer = Buffer.alloc(0)): void {
    this.raw.connection.ping(payload);
  }

  /** Resolve with the first message of `type` that satisfies `predicate`. */
  waitFor<T extends ServerMessageType>(
    type: T,
    predicate: (message: Extract<ServerMessage, { t: T }>) => boolean = () => true,
    timeoutMs = 5_000,
  ): Promise<Extract<ServerMessage, { t: T }>> {
    const match = (message: ServerMessage): boolean =>
      message.t === type && predicate(message as Extract<ServerMessage, { t: T }>);

    // Messages that arrived before the wait was set up still count.
    const already = this.received.find(match);
    if (already !== undefined) return Promise.resolve(already as Extract<ServerMessage, { t: T }>);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const index = this.waiters.findIndex((w) => w.timer === timer);
        if (index >= 0) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for a "${type}" message. Saw: ${this.received.map((m) => m.t).join(', ')}`));
      }, timeoutMs);
      timer.unref?.();
      this.waiters.push({
        match,
        resolve: (m) => resolve(m as Extract<ServerMessage, { t: T }>),
        reject,
        timer,
      });
    });
  }

  /** Every message of a type received so far. */
  all<T extends ServerMessageType>(type: T): Extract<ServerMessage, { t: T }>[] {
    return this.received.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === type);
  }

  waitForClose(timeoutMs = 5_000): Promise<ConnectionClose> {
    if (this.closed !== null) return Promise.resolve(this.closed);
    return new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = setInterval(() => {
        if (this.closed !== null) {
          clearInterval(poll);
          resolve(this.closed);
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(poll);
          reject(new Error('Timed out waiting for the connection to close.'));
        }
      }, 5);
      poll.unref?.();
    });
  }

  close(code = 1000, reason = ''): void {
    this.raw.connection.close(code, reason);
  }

  terminate(): void {
    this.raw.connection.terminate();
  }
}
