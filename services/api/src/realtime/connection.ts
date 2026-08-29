/**
 * One WebSocket connection.
 *
 * Sits directly on the `net.Socket` that `node:http` hands us from the
 * `upgrade` event and turns the byte stream into messages: fragment
 * reassembly, control-frame handling, the closing handshake, keepalive, and
 * backpressure. Above this line nothing knows about frames; below it nothing
 * knows about campfires.
 */

import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  FrameReader,
  OPCODE,
  WsProtocolError,
  decodeClosePayload,
  decodeUtf8,
  encodeClosePayload,
  encodeFrame,
  isControlOpcode,
} from './frame.js';

export type ReadyState = 'open' | 'closing' | 'closed';

export interface ConnectionClose {
  readonly code: number;
  readonly reason: string;
  /** True when both sides exchanged close frames rather than the socket dying. */
  readonly clean: boolean;
}

export interface WsConnectionOptions {
  readonly socket: Duplex;
  /** Servers require masked input and send unmasked; clients do the reverse. */
  readonly role: 'server' | 'client';
  readonly maxMessageBytes: number;
  readonly maxFrameBytes: number;
  /**
   * How much unflushed data we tolerate before deciding the peer cannot keep
   * up. A slow client must not be allowed to grow the server's heap.
   */
  readonly maxBufferedBytes: number;
  /** Milliseconds to wait for the peer's close frame before dropping the TCP. */
  readonly closeTimeoutMs?: number;
  readonly id?: string;
  /**
   * Bytes already read off the socket before this object existed — the tail of
   * the handshake response. Fed through the reader as soon as handlers are in
   * place, so nothing is lost between `upgrade` and the first `data` event.
   */
  readonly initialChunk?: Buffer;
}

export interface WsConnectionHandlers {
  onMessage?(data: string | Buffer, isBinary: boolean): void;
  onPing?(payload: Buffer): void;
  onPong?(payload: Buffer): void;
  onClose?(info: ConnectionClose): void;
  onError?(error: Error): void;
}

export class WsConnection {
  readonly id: string;
  private readonly socket: Duplex;
  private readonly options: WsConnectionOptions;
  private readonly reader: FrameReader;
  private readonly handlers: WsConnectionHandlers = {};

  private state: ReadyState = 'open';
  private closeSent = false;
  private closeInfo: ConnectionClose | null = null;
  private closeTimer: NodeJS.Timeout | null = null;

  /** Fragment accumulator. `null` when no message is in flight. */
  private fragments: Buffer[] | null = null;
  private fragmentOpcode = 0;
  private fragmentBytes = 0;

  /** Keepalive bookkeeping, driven by the hub's sweeper rather than a timer. */
  private lastInboundMs: number;
  private lastPingMs = 0;
  private awaitingPong = false;

  constructor(options: WsConnectionOptions, handlers: WsConnectionHandlers = {}, nowMs: number = Date.now()) {
    this.id = options.id ?? `wsc_${randomUUID().replace(/-/g, '')}`;
    this.socket = options.socket;
    this.options = options;
    this.handlers = handlers;
    this.lastInboundMs = nowMs;
    this.reader = new FrameReader({
      requireMask: options.role === 'server',
      maxFrameBytes: options.maxFrameBytes,
    });

    const withNoDelay = this.socket as Duplex & { setNoDelay?: (enable: boolean) => void };
    withNoDelay.setNoDelay?.(true);
    this.socket.on('data', (chunk: Buffer) => this.onData(chunk, Date.now()));
    this.socket.on('error', (error: Error) => {
      this.handlers.onError?.(error);
      this.finish({ code: 1006, reason: error.message, clean: false });
    });
    this.socket.on('close', () => this.finish({ code: 1006, reason: 'Socket closed.', clean: false }));
    this.socket.on('end', () => this.finish(this.closeInfo ?? { code: 1006, reason: 'Socket ended.', clean: false }));

    if (options.initialChunk !== undefined && options.initialChunk.length > 0) {
      this.onData(options.initialChunk, nowMs);
    }
  }

  get readyState(): ReadyState {
    return this.state;
  }

  /** Unflushed bytes sitting in the kernel/stream buffer. */
  get bufferedBytes(): number {
    return this.socket.writableLength ?? 0;
  }

  get lastInboundAtMs(): number {
    return this.lastInboundMs;
  }

  /* ----------------------------------------------------------------------- */
  /* Sending                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * Send a text message. Returns false when the message was dropped because
   * the peer is too far behind — in which case the connection is also closing,
   * so callers never need to retry.
   */
  send(text: string): boolean {
    return this.write(OPCODE.text, Buffer.from(text, 'utf8'));
  }

  sendBinary(payload: Buffer): boolean {
    return this.write(OPCODE.binary, payload);
  }

  ping(payload: Buffer = Buffer.alloc(0), nowMs: number = Date.now()): void {
    this.lastPingMs = nowMs;
    this.awaitingPong = true;
    this.write(OPCODE.ping, payload, true);
  }

  pong(payload: Buffer = Buffer.alloc(0)): void {
    this.write(OPCODE.pong, payload, true);
  }

  private write(opcode: number, payload: Buffer, control = false): boolean {
    if (this.state !== 'open') return false;

    // Backpressure: a peer that cannot drain gets hung up on rather than being
    // allowed to queue unbounded state in our process.
    if (!control && this.bufferedBytes > this.options.maxBufferedBytes) {
      this.close(1013, 'Falling behind; try again later.');
      return false;
    }

    try {
      this.socket.write(encodeFrame({ opcode, payload, mask: this.options.role === 'client' }));
      return true;
    } catch (error) {
      this.handlers.onError?.(error as Error);
      this.finish({ code: 1006, reason: 'Write failed.', clean: false });
      return false;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Closing                                                                  */
  /* ----------------------------------------------------------------------- */

  /** Begin the closing handshake (§7.1.2): send close, await the echo. */
  close(code = 1000, reason = ''): void {
    if (this.state === 'closed') return;
    if (!this.closeSent) {
      this.closeSent = true;
      this.state = 'closing';
      try {
        this.socket.write(
          encodeFrame({
            opcode: OPCODE.close,
            payload: encodeClosePayload(code, reason),
            mask: this.options.role === 'client',
          }),
        );
      } catch {
        /* the socket is already gone; fall through to the timer */
      }
      this.closeInfo ??= { code, reason, clean: false };
      const timeout = this.options.closeTimeoutMs ?? 5_000;
      this.closeTimer = setTimeout(() => this.terminate(), timeout);
      this.closeTimer.unref?.();
    }
  }

  /** Drop the TCP connection immediately. Used for timeouts and hard limits. */
  terminate(): void {
    if (this.state === 'closed') {
      this.socket.destroy();
      return;
    }
    this.socket.destroy();
    this.finish(this.closeInfo ?? { code: 1006, reason: 'Terminated.', clean: false });
  }

  private finish(info: ConnectionClose): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    if (this.closeTimer !== null) {
      clearTimeout(this.closeTimer);
      this.closeTimer = null;
    }
    this.closeInfo = info;
    // An upgraded socket is half-open by default: the peer's FIN gives us
    // `end`, never `close`, and node keeps counting it as a live connection
    // until we tear our side down too. `destroySoon` flushes whatever is still
    // queued — a close frame, usually — and then lets go.
    const closable = this.socket as Duplex & { destroySoon?: () => void };
    if (closable.destroySoon !== undefined) closable.destroySoon();
    else this.socket.destroy();
    this.handlers.onClose?.(info);
  }

  /* ----------------------------------------------------------------------- */
  /* Keepalive                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Heartbeat step. Called by the hub's sweeper with an injected clock, so
   * dead-connection reaping is deterministic in tests instead of a race.
   *
   * Returns `'reaped'` when the peer failed to answer and the connection was
   * dropped.
   */
  heartbeat(nowMs: number, pingIntervalMs: number, pongTimeoutMs: number): 'idle' | 'pinged' | 'reaped' {
    if (this.state === 'closed') return 'idle';
    if (this.awaitingPong && nowMs - this.lastPingMs >= pongTimeoutMs) {
      this.terminate();
      return 'reaped';
    }
    // Any inbound traffic counts as liveness; a chatty client is never pinged.
    if (!this.awaitingPong && nowMs - this.lastInboundMs >= pingIntervalMs) {
      this.ping(Buffer.alloc(0), nowMs);
      return 'pinged';
    }
    return 'idle';
  }

  /* ----------------------------------------------------------------------- */
  /* Receiving                                                                */
  /* ----------------------------------------------------------------------- */

  private onData(chunk: Buffer, nowMs: number): void {
    if (this.state === 'closed') return;
    this.lastInboundMs = nowMs;
    let frames;
    try {
      frames = this.reader.receive(chunk);
    } catch (error) {
      this.fail(error);
      return;
    }
    for (const frame of frames) {
      try {
        this.handleFrame(frame.fin, frame.opcode, frame.payload);
      } catch (error) {
        this.fail(error);
        return;
      }
      if ((this.state as ReadyState) === 'closed') return;
    }
  }

  private fail(error: unknown): void {
    if (error instanceof WsProtocolError) {
      this.handlers.onError?.(error);
      this.close(error.closeCode, error.message);
      // A framing violation means the stream is no longer trustworthy: say so
      // and stop reading rather than trying to resynchronise.
      this.socket.end();
      return;
    }
    this.handlers.onError?.(error as Error);
    this.terminate();
  }

  private handleFrame(fin: boolean, opcode: number, payload: Buffer): void {
    if (isControlOpcode(opcode)) {
      this.handleControlFrame(opcode, payload);
      return;
    }

    if (opcode === OPCODE.continuation) {
      if (this.fragments === null) throw new WsProtocolError(1002, 'Continuation frame with nothing to continue.');
      this.fragmentBytes += payload.length;
      this.enforceMessageSize();
      this.fragments.push(payload);
      if (!fin) return;
      const complete = Buffer.concat(this.fragments);
      const startOpcode = this.fragmentOpcode;
      this.fragments = null;
      this.fragmentBytes = 0;
      this.fragmentOpcode = 0;
      this.deliver(startOpcode, complete);
      return;
    }

    // A fresh data frame while a fragmented message is open is a violation.
    if (this.fragments !== null) throw new WsProtocolError(1002, 'A new data frame interrupted a fragmented message.');

    if (payload.length > this.options.maxMessageBytes) {
      throw new WsProtocolError(1009, `Message exceeds the ${this.options.maxMessageBytes} byte limit.`);
    }

    if (fin) {
      this.deliver(opcode, payload);
      return;
    }
    this.fragments = [payload];
    this.fragmentOpcode = opcode;
    this.fragmentBytes = payload.length;
  }

  private enforceMessageSize(): void {
    if (this.fragmentBytes > this.options.maxMessageBytes) {
      throw new WsProtocolError(1009, `Message exceeds the ${this.options.maxMessageBytes} byte limit.`);
    }
  }

  private deliver(opcode: number, payload: Buffer): void {
    if (opcode === OPCODE.text) {
      this.handlers.onMessage?.(decodeUtf8(payload), false);
      return;
    }
    this.handlers.onMessage?.(payload, true);
  }

  private handleControlFrame(opcode: number, payload: Buffer): void {
    switch (opcode) {
      case OPCODE.ping:
        this.handlers.onPing?.(payload);
        // The RFC requires an automatic pong carrying the same body.
        this.pong(payload);
        return;
      case OPCODE.pong:
        this.awaitingPong = false;
        this.handlers.onPong?.(payload);
        return;
      case OPCODE.close: {
        const info = decodeClosePayload(payload);
        const code = info.code === 1005 ? 1000 : info.code;
        if (!this.closeSent) {
          // Peer initiated: echo their code straight back, then end.
          this.closeSent = true;
          this.state = 'closing';
          try {
            this.socket.write(
              encodeFrame({
                opcode: OPCODE.close,
                payload: encodeClosePayload(code, ''),
                mask: this.options.role === 'client',
              }),
            );
          } catch {
            /* already gone */
          }
        }
        this.closeInfo = { code: info.code, reason: info.reason, clean: true };
        this.socket.end();
        this.finish(this.closeInfo);
        return;
      }
      default:
        throw new WsProtocolError(1002, `Unhandled control opcode 0x${opcode.toString(16)}.`);
    }
  }
}
