/**
 * The browser side of the realtime wire.
 *
 * `services/api/src/realtime/client.ts` already contains a hand-written client
 * for the same protocol, and this is deliberately *not* a second copy of it.
 * That one owns a TCP socket, masks its own frames and exists so the server's
 * tests are not marking their own homework; a browser has none of those
 * problems and none of those powers — it gets `WebSocket`, which does the
 * framing, and it cannot set an `Authorization` header. What the two share is
 * the part that matters: the schemas. Everything sent is validated with
 * `ClientMessageSchema` before it leaves and everything received with
 * `ServerMessageSchema` before it is believed, so the two clients cannot drift
 * apart in the only way that would hurt.
 *
 * The rule that shapes the rest of this file is ARCHITECTURE §1.5, *degrade,
 * never block*: a dropped connection means you are alone at your own fire, not
 * that the world stops. Nothing here throws into the render loop, nothing here
 * is awaited by gameplay, and a socket that will not open simply keeps trying
 * quietly while the campfire carries on.
 */

import {
  ClientMessageSchema,
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_SUBPROTOCOL,
  SCHEMA_VERSION,
  ServerMessageSchema,
  type ArrivalPath,
  type ClientMessageInput,
  type JoinMethod,
  type ServerMessage,
  type VoiceMode,
} from '@somemore/protocol';

/** Where the socket has got to. Presentation reads this; gameplay never waits on it. */
export type RealtimeStatus =
  | 'idle'
  /** A socket is opening, or reopening after a drop. */
  | 'connecting'
  /** Open, `join` sent, waiting to be let in. */
  | 'joining'
  /** At the fire: welcome and snapshot received. */
  | 'joined'
  /** Dropped; waiting out the backoff before trying again. */
  | 'reconnecting'
  /** Given up, or deliberately closed. You are alone at your own fire. */
  | 'alone';

/**
 * The minimum of `WebSocket` this module uses.
 *
 * Declared structurally so the unit tests can hand it a fake and so Node's own
 * global `WebSocket` (which the integration test drives) satisfies it without a
 * cast. Nothing here touches a browser-only API.
 */
export interface SocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null;
  onclose: ((event: { code?: number; reason?: string; wasClean?: boolean }) => void) | null;
  onerror: ((event: unknown) => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
}

export type SocketFactory = (url: string, protocols: string[]) => SocketLike;

export interface RealtimeTransportOptions {
  /** `ws://host:port/v1/realtime`. */
  readonly url: string;
  /** Bearer token. Presented in a subprotocol, because a browser cannot send headers. */
  readonly token: string;
  readonly sessionId: string;
  /** Membership proof, for somebody who is not yet a member of the campsite. */
  readonly join?: JoinMethod;
  /** How the player would like to walk in. The server derives one when omitted. */
  readonly approach?: ArrivalPath;
  readonly voice?: VoiceMode;
  /** Injected for tests; defaults to the platform `WebSocket`. */
  readonly socketFactory?: SocketFactory;
  readonly now?: () => number;
  /** Backoff floor and ceiling, milliseconds. */
  readonly retryBaseMs?: number;
  readonly retryCeilingMs?: number;
  /** How many consecutive failures before we stop trying and go quiet. */
  readonly maxRetries?: number;
}

export interface RealtimeHandlers {
  onMessage?(message: ServerMessage): void;
  onStatus?(status: RealtimeStatus, detail: string | null): void;
  /** A message the server sent that this build cannot parse. Never fatal. */
  onMalformed?(raw: string, reason: string): void;
}

const OPEN = 1;

/**
 * `Omit` over a union collapses it, so distribute: every member of
 * `ClientMessageInput` keeps its own shape, with `seq` supplied by the client.
 * The same trick, for the same reason, as the server's own test client.
 */
export type Unsequenced<T> = T extends unknown ? Omit<T, 'seq'> & { seq?: number } : never;

export type OutgoingMessage = Unsequenced<ClientMessageInput>;

/**
 * Backoff with full jitter.
 *
 * Deterministic given `random`, so the tests can assert the schedule instead of
 * sleeping through it. Jitter matters more than usual here: everyone at a
 * campfire loses the same server at the same moment, and an unjittered schedule
 * would have them all knock on the door in unison.
 */
export function backoffMs(attempt: number, base: number, ceiling: number, random: () => number): number {
  const window = Math.min(ceiling, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * 0.5 + random() * (window - base * 0.5));
}

export class RealtimeTransport {
  private readonly options: RealtimeTransportOptions;
  private readonly handlers: RealtimeHandlers;
  private readonly factory: SocketFactory;
  private readonly now: () => number;

  private socket: SocketLike | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private closedByUs = false;

  /**
   * Per-client monotonic counter.
   *
   * It deliberately survives a reconnect *within* this object even though the
   * server tracks `lastSeq` per connection and a new socket starts fresh — a
   * counter that only ever goes up is easier to reason about than one that
   * resets, and the server only requires strictly increasing.
   */
  private seq = 0;

  /**
   * The last tick this client applied, sent as `sinceTick` on a reconnect so
   * the server replays only what was missed rather than the whole session.
   */
  resumeFromTick: number | null = null;

  statusValue: RealtimeStatus = 'idle';
  statusDetail: string | null = null;
  /** Round-trip time in milliseconds, from the application-level ping. */
  latencyMs = 0;
  /** When the current socket was created, so an error can be dated to it. */
  private openedAtMs = 0;
  /** Errors the server sent, newest last. Bounded; kept for the settings panel. */
  readonly serverErrors: { code: string; message: string; at: number }[] = [];

  constructor(options: RealtimeTransportOptions, handlers: RealtimeHandlers = {}) {
    this.options = options;
    this.handlers = handlers;
    this.now = options.now ?? (() => Date.now());
    this.factory =
      options.socketFactory ??
      ((url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike);
  }

  get status(): RealtimeStatus {
    return this.statusValue;
  }

  get connected(): boolean {
    return this.socket !== null && this.socket.readyState === OPEN;
  }

  /** Next `seq` this client will use. */
  get nextSeq(): number {
    return this.seq + 1;
  }

  private setStatus(status: RealtimeStatus, detail: string | null = null): void {
    if (this.statusValue === status && this.statusDetail === detail) return;
    this.statusValue = status;
    this.statusDetail = detail;
    this.handlers.onStatus?.(status, detail);
  }

  /** Open the socket. Safe to call again; a live socket is left alone. */
  connect(): void {
    if (this.socket !== null) return;
    this.closedByUs = false;
    this.setStatus(this.attempt === 0 ? 'connecting' : 'reconnecting');

    const protocols = [REALTIME_SUBPROTOCOL, `${REALTIME_BEARER_SUBPROTOCOL_PREFIX}${this.options.token}`];
    let socket: SocketLike;
    try {
      socket = this.factory(this.options.url, protocols);
    } catch (error) {
      // A malformed URL or a blocked scheme. Retrying is still right: a wrong
      // URL simply exhausts the attempts and the fire carries on alone.
      this.scheduleRetry(describe(error));
      return;
    }
    this.socket = socket;
    this.openedAtMs = this.now();

    socket.onopen = () => {
      this.attempt = 0;
      this.setStatus('joining');
      this.sendJoin();
    };
    socket.onmessage = (event) => this.ingest(event.data);
    socket.onerror = () => {
      // `error` is always followed by `close`; the reason lives there.
    };
    socket.onclose = (event) => {
      this.socket = null;
      if (this.closedByUs) {
        this.setStatus('alone', 'You left the fire.');
        return;
      }
      const reason = event.reason && event.reason.length > 0 ? event.reason : `closed (${event.code ?? 0})`;
      /*
       * 1008 is the server saying "no": not a member, unsupported protocol
       * version, flooding. Reconnecting would produce the same answer at a
       * steady rate, which is a denial of service aimed at ourselves.
       *
       * One 1008 is about *when* rather than *who*. The service closes a
       * socket that has sat ten seconds without a join, and the join is sent
       * from the `open` handler, which cannot run while the main thread is
       * compiling the scene's first frame. On a slow phone, or a CI runner
       * with two browsers on it, that stall has been measured at thirteen
       * seconds. The socket was open the whole time; the page simply had not
       * been given a turn to speak. Asking again is the right answer, since
       * by the time the close is even seen the stall is over. The error the
       * service sends before closing is what tells this apart from a refusal.
       */
      if (event.code === 1008) {
        if (this.joinCameTooLate()) {
          this.scheduleRetry(reason);
          return;
        }
        this.setStatus('alone', reason);
        return;
      }
      this.scheduleRetry(reason);
    };
  }

  /**
   * Whether the socket that just closed was one the service gave up waiting
   * on, rather than one it turned away: never welcomed, and the last thing it
   * said was that no join arrived in time.
   */
  private joinCameTooLate(): boolean {
    if (this.statusValue === 'joined') return false;
    const last = this.serverErrors[this.serverErrors.length - 1];
    return last !== undefined && last.code === 'not_joined' && last.at >= this.openedAtMs;
  }

  private sendJoin(): void {
    const since = this.resumeFromTick;
    this.send({
      t: 'join',
      sessionId: this.options.sessionId,
      schemaVersion: SCHEMA_VERSION,
      voice: this.options.voice ?? 'push_to_talk',
      ...(this.options.join === undefined ? {} : { join: this.options.join }),
      ...(this.options.approach === undefined ? {} : { approach: this.options.approach }),
      ...(since === null ? {} : { sinceTick: since }),
    });
  }

  private scheduleRetry(detail: string): void {
    const max = this.options.maxRetries ?? 12;
    this.attempt += 1;
    if (this.attempt > max) {
      this.setStatus('alone', `${detail} — carrying on alone.`);
      return;
    }
    const delay = backoffMs(
      this.attempt,
      this.options.retryBaseMs ?? 700,
      this.options.retryCeilingMs ?? 20_000,
      Math.random,
    );
    this.setStatus('reconnecting', detail);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.connect();
    }, delay);
    // A pending reconnect must never hold a Node process open in the tests.
    (this.timer as { unref?: () => void }).unref?.();
  }

  private ingest(data: unknown): void {
    if (typeof data !== 'string') {
      // The protocol is JSON text. A binary frame is either a bug or somebody
      // else's protocol; either way there is nothing to do with it.
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      this.handlers.onMalformed?.(data, 'not JSON');
      return;
    }
    const result = ServerMessageSchema.safeParse(parsed);
    if (!result.success) {
      // A newer server saying something this build has never heard of. Ignore
      // it and keep playing — refusing to parse an unfamiliar message is how a
      // client breaks on the next service release.
      this.handlers.onMalformed?.(data, result.error.issues[0]?.message ?? 'schema mismatch');
      return;
    }
    const message = result.data;

    if (message.t === 'welcome') this.setStatus('joined');
    if (message.t === 'pong' && message.clientTimeMs !== null) {
      this.latencyMs = Math.max(0, this.now() - message.clientTimeMs);
    }
    if (message.t === 'error') {
      this.serverErrors.push({ code: message.code, message: message.message, at: this.now() });
      if (this.serverErrors.length > 32) this.serverErrors.shift();
    }
    this.handlers.onMessage?.(message);
  }

  /**
   * Send a message, filling in the next `seq`.
   *
   * Returns the seq used, or `null` when there was no socket to send it on —
   * which is not an error and never throws. A caller that needs to know
   * whether its input reached the fire watches for the `ack`.
   */
  send(message: OutgoingMessage): number | null {
    const socket = this.socket;
    if (socket === null || socket.readyState !== OPEN) return null;
    const seq = message.seq ?? (this.seq += 1);
    const validated = ClientMessageSchema.safeParse({ ...message, seq });
    if (!validated.success) {
      // Our own message did not match the contract. Sending it anyway would
      // earn an `invalid_message` and a strike, so it is dropped here instead.
      this.handlers.onMalformed?.(JSON.stringify(message), `outgoing: ${validated.error.issues[0]?.message ?? ''}`);
      return null;
    }
    try {
      socket.send(JSON.stringify(validated.data));
    } catch {
      return null;
    }
    return seq;
  }

  /** Application-level liveness probe. Also how `latencyMs` is measured. */
  ping(): void {
    this.send({ t: 'ping', clientTimeMs: Math.max(0, Math.round(this.now())) });
  }

  /**
   * Walk off down the trail and close.
   *
   * `walk_off` rather than `immediate` by default: leaving is walking away,
   * not vanishing (spec §9), and the people still at the fire get a path to
   * animate.
   */
  depart(manner: 'walk_off' | 'immediate' = 'walk_off'): void {
    this.closedByUs = true;
    this.send({ t: 'depart', manner });
    // Give the depart message a moment to reach the wire before hanging up.
    const socket = this.socket;
    if (socket === null) {
      this.setStatus('alone', 'You left the fire.');
      return;
    }
    setTimeout(() => socket.close(1000, 'walked off'), manner === 'walk_off' ? 40 : 0);
  }

  /** Hang up now, without a departure. Used on teardown. */
  dispose(): void {
    this.closedByUs = true;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    try {
      socket?.close(1000, 'gone');
    } catch {
      /* already gone */
    }
    this.setStatus('alone', null);
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
