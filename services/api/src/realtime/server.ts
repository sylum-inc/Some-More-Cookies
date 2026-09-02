/**
 * `attachRealtime` — the WebSocket edge.
 *
 * Mirrors `http/server.ts`: request ids, auth, limits, one error shape, and no
 * business logic. It listens for the `upgrade` event on the existing HTTP
 * server, so the realtime transport shares a port, a TLS terminator and an
 * auth model with the REST API rather than being a second deployment.
 *
 * Wiring is a one-liner in `main.ts`; everything this needs arrives as a
 * parameter, so nothing in `app.ts`, `domain/` or `repos/` knows this file
 * exists.
 */

import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  ClientMessageSchema,
  REALTIME_CLOSE,
  REALTIME_PATH,
  checkSchemaCompatibility,
  type ClientMessage,
  type MemberRole,
  type RealtimeErrorCode,
} from '@somemore/protocol';
import { ApiError } from '../errors.js';
import { WsConnection, type ConnectionClose } from './connection.js';
import {
  buildAcceptResponse,
  buildRejectionResponse,
  negotiateSubprotocol,
  parseUpgradeRequest,
  type HandshakeRejection,
} from './handshake.js';
import { ConnectionMeters, DEFAULT_REALTIME_LIMITS, type RealtimeLimitsConfig } from './limits.js';
import { SessionRoom, type RoomPeer } from './room.js';
import { createLiveKitVoiceRoom, liveKitConfigFromEnv, type VoiceRoom } from './voice.js';
import type { RealtimeDeps, RealtimeHandle, RealtimeStats } from './types.js';

interface ConnectionState {
  readonly id: string;
  readonly accountId: string;
  readonly connection: WsConnection;
  readonly meters: ConnectionMeters;
  readonly openedAtMs: number;
  /** Highest client `seq` accepted. Replays and reorderings are dropped. */
  lastSeq: number;
  room: SessionRoom | null;
  peer: RoomPeer | null;
  closed: boolean;
}

export function attachRealtime(server: Server, deps: RealtimeDeps): RealtimeHandle {
  const limits: RealtimeLimitsConfig = { ...DEFAULT_REALTIME_LIMITS, ...(deps.limits ?? {}) };
  const path = deps.path ?? REALTIME_PATH;
  const voice: VoiceRoom = deps.voice ?? createLiveKitVoiceRoom(liveKitConfigFromEnv(), deps.clock);
  const logger = deps.logger.child({ component: 'realtime' });
  const newId = deps.newConnectionId ?? (() => `wsc_${randomUUID().replace(/-/g, '')}`);

  const connections = new Map<string, ConnectionState>();
  const byAccount = new Map<string, Set<string>>();
  const rooms = new Map<string, SessionRoom>();

  let closing = false;

  /* ----------------------------------------------------------------------- */
  /* Upgrade                                                                  */
  /* ----------------------------------------------------------------------- */

  function reject(socket: Duplex, rejection: HandshakeRejection, requestId: string): void {
    try {
      socket.write(buildRejectionResponse(rejection, requestId));
    } catch {
      /* the peer already went away */
    }
    socket.destroy();
  }

  async function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    const requestId = `req_${randomUUID().replace(/-/g, '')}`;
    if (closing) {
      reject(socket, { status: 503, code: 'internal_error', message: 'The service is shutting down.' }, requestId);
      return;
    }

    const parsed = parseUpgradeRequest({ method: req.method, url: req.url, headers: req.headers });
    if (!parsed.ok) {
      reject(socket, parsed.rejection, requestId);
      return;
    }
    if (parsed.request.url.pathname !== path) {
      reject(socket, { status: 404, code: 'not_found', message: `No realtime endpoint at ${parsed.request.url.pathname}.` }, requestId);
      return;
    }
    if (parsed.request.token === null) {
      reject(socket, { status: 401, code: 'unauthorized', message: 'A bearer token is required.' }, requestId);
      return;
    }

    let accountId: string;
    try {
      const auth = await deps.authenticate(parsed.request.token, deps.clock.now());
      accountId = auth.accountId;
    } catch (error) {
      const message = error instanceof ApiError ? error.message : 'That token is not valid.';
      reject(socket, { status: 401, code: 'unauthorized', message }, requestId);
      return;
    }

    // One player, a handful of devices. Anything more is a runaway client.
    const existing = byAccount.get(accountId) ?? new Set<string>();
    if (existing.size >= limits.connectionsPerAccount) {
      reject(
        socket,
        { status: 429, code: 'rate_limited', message: `At most ${limits.connectionsPerAccount} concurrent connections per account.` },
        requestId,
      );
      return;
    }

    const subprotocol = negotiateSubprotocol(parsed.request.subprotocols);
    socket.write(buildAcceptResponse(parsed.request.key, { subprotocol }));

    const id = newId();
    const nowMs = deps.clock.now().getTime();
    const connection = new WsConnection(
      {
        socket,
        role: 'server',
        maxMessageBytes: limits.maxMessageBytes,
        maxFrameBytes: limits.maxFrameBytes,
        maxBufferedBytes: limits.maxBufferedBytes,
        closeTimeoutMs: limits.closeTimeoutMs,
        id,
        // Bytes the HTTP parser had already read past the header boundary.
        initialChunk: head.length > 0 ? head : undefined,
      },
      {
        onMessage: (data, isBinary) => void handleMessage(id, data, isBinary),
        onClose: (info) => void handleClose(id, info),
        onError: (error) => logger.debug('realtime.socket_error', { connectionId: id, error: error.message }),
      },
      nowMs,
    );

    const state: ConnectionState = {
      id,
      accountId,
      connection,
      meters: new ConnectionMeters(limits, nowMs),
      openedAtMs: nowMs,
      lastSeq: 0,
      room: null,
      peer: null,
      closed: false,
    };
    connections.set(id, state);
    existing.add(id);
    byAccount.set(accountId, existing);
    logger.info('realtime.connected', { connectionId: id, accountId, requestId });
  }

  const upgradeListener = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    void onUpgrade(req, socket, head).catch((error: unknown) => {
      logger.error('realtime.upgrade_failed', { error: String(error) });
      socket.destroy();
    });
  };
  server.on('upgrade', upgradeListener);

  /* ----------------------------------------------------------------------- */
  /* Errors                                                                   */
  /* ----------------------------------------------------------------------- */

  function sendError(
    state: ConnectionState,
    code: RealtimeErrorCode,
    message: string,
    options: { seq?: number | null; retryAfterMs?: number | null } = {},
  ): void {
    state.connection.send(
      JSON.stringify({
        t: 'error',
        code,
        message,
        seq: options.seq ?? null,
        retryAfterMs: options.retryAfterMs ?? null,
      }),
    );
  }

  /** Map the HTTP domain's error vocabulary onto the realtime one. */
  function realtimeCodeFor(error: unknown): { code: RealtimeErrorCode; message: string } {
    if (error instanceof ApiError) {
      switch (error.code) {
        case 'unauthorized':
          return { code: 'unauthorized', message: error.message };
        case 'forbidden':
        case 'anti_abuse_rejected':
          return { code: 'forbidden', message: error.message };
        case 'not_found':
          return { code: 'not_found', message: error.message };
        case 'conflict':
        case 'illegal_state_transition':
          return { code: 'session_not_active', message: error.message };
        case 'rate_limited':
          return { code: 'rate_limited', message: error.message };
        default:
          return { code: 'invalid_message', message: error.message };
      }
    }
    return { code: 'internal_error', message: 'Something went wrong at the fire.' };
  }

  /* ----------------------------------------------------------------------- */
  /* Messages                                                                 */
  /* ----------------------------------------------------------------------- */

  async function handleMessage(connectionId: string, data: string | Buffer, isBinary: boolean): Promise<void> {
    const state = connections.get(connectionId);
    if (state === undefined || state.closed) return;
    // Once we have decided to hang up, a flood costs us nothing more: no
    // parsing, no metering, no handlers.
    if (state.connection.readyState !== 'open') return;

    if (isBinary) {
      sendError(state, 'invalid_message', 'This protocol is JSON text; binary frames are not accepted.');
      state.connection.close(REALTIME_CLOSE.unsupportedData, 'Binary frames are not accepted.');
      return;
    }

    const nowMs = deps.clock.now().getTime();
    if (!state.meters.messages.tryTake(nowMs)) {
      state.meters.strikes += 1;
      sendError(state, 'rate_limited', 'Too many messages.', {
        retryAfterMs: state.meters.messages.retryAfterMs(nowMs),
      });
      if (state.meters.strikes > limits.rateLimitStrikes) {
        state.connection.close(REALTIME_CLOSE.policyViolation, 'Flooding.');
      }
      return;
    }

    let json: unknown;
    try {
      json = JSON.parse(data as string);
    } catch {
      sendError(state, 'invalid_message', 'That was not JSON.');
      return;
    }

    const parsed = ClientMessageSchema.safeParse(json);
    if (!parsed.success) {
      sendError(state, 'invalid_message', `Message rejected: ${parsed.error.issues[0]?.message ?? 'schema mismatch'}.`);
      return;
    }
    const message = parsed.data;

    // Per-client monotonicity: a retry or a reordered delivery is dropped
    // rather than replayed, which is what makes the input stream idempotent.
    if (message.seq <= state.lastSeq) {
      sendError(state, 'sequence_stale', `Sequence ${message.seq} is not ahead of ${state.lastSeq}.`, { seq: message.seq });
      return;
    }
    state.lastSeq = message.seq;

    try {
      await dispatch(state, message);
    } catch (error) {
      const mapped = realtimeCodeFor(error);
      logger.warn('realtime.handler_failed', { connectionId, code: mapped.code, error: String(error) });
      sendError(state, mapped.code, mapped.message, { seq: message.seq });
    }
  }

  async function dispatch(state: ConnectionState, message: ClientMessage): Promise<void> {
    if (message.t === 'join') {
      await handleJoin(state, message);
      return;
    }

    if (message.t === 'ping') {
      state.connection.send(
        JSON.stringify({
          t: 'pong',
          tick: state.room?.tick() ?? 0,
          serverTimeMs: deps.clock.now().getTime(),
          clientTimeMs: message.clientTimeMs ?? null,
        }),
      );
      return;
    }

    const room = state.room;
    const peer = state.peer;
    if (room === null || peer === null) {
      sendError(state, 'not_joined', 'Send a join message first.', { seq: message.seq });
      return;
    }

    switch (message.t) {
      case 'input':
        await room.handleInput(peer, message.seq, message.intent);
        return;
      case 'authority':
        await room.handleAuthority(peer, message.seq, message.request);
        return;
      case 'presence':
        await room.handlePresence(peer, message.seq, message.presence);
        return;
      case 'chat':
        await room.handleChat(peer, message.seq, message.text);
        return;
      case 'block':
        await room.handleBlock(peer, message.seq, message.accountId, true);
        return;
      case 'unblock':
        await room.handleBlock(peer, message.seq, message.accountId, false);
        return;
      case 'voice':
        await room.handleVoice(peer, message.seq, message);
        return;
      case 'depart':
        room.handleDepart(peer, message.seq, message.manner, message.path);
        return;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Join — privacy lives here                                                */
  /* ----------------------------------------------------------------------- */

  async function handleJoin(state: ConnectionState, message: Extract<ClientMessage, { t: 'join' }>): Promise<void> {
    if (state.room !== null) {
      sendError(state, 'already_joined', 'This connection is already at a fire.', { seq: message.seq });
      return;
    }

    const compatibility = checkSchemaCompatibility(message.schemaVersion);
    if (!compatibility.compatible) {
      sendError(state, 'unsupported_version', `Client protocol ${message.schemaVersion} is ${compatibility.reason}.`, {
        seq: message.seq,
      });
      state.connection.close(REALTIME_CLOSE.policyViolation, 'Unsupported protocol version.');
      return;
    }

    /*
     * Sessions are private by default (spec §9). Three things can get you in:
     * you are already a member of the campsite, or you present an invite link,
     * a camp code or a QR payload that resolves to one. Nothing else does —
     * and a stranger gets the same `not_found` the HTTP API gives, so session
     * ids stay unenumerable.
     */
    try {
      await deps.sessions.get(state.accountId, message.sessionId);
    } catch (error) {
      if (message.join === undefined) {
        const mapped = realtimeCodeFor(error);
        sendError(state, mapped.code, mapped.message, { seq: message.seq });
        state.connection.close(REALTIME_CLOSE.policyViolation, 'Not a member of that campsite.');
        return;
      }
      // Redeem the invite, then try again as a member.
      await deps.campsites.join(state.accountId, {
        join: message.join,
        idempotencyKey: `rt-join-${state.id}`,
      });
      await deps.sessions.get(state.accountId, message.sessionId);
    }

    const joined = await deps.sessions.join(state.accountId, message.sessionId);
    const campsite = await deps.campsites.get(state.accountId, joined.campsiteId);
    const role: MemberRole = campsite.members.find((m) => m.accountId === state.accountId)?.role ?? 'viewer';

    let room = rooms.get(joined.id);
    if (room === undefined) {
      room = new SessionRoom({
        session: joined,
        seed: campsite.seed,
        environmentId: campsite.environmentId,
        sessions: deps.sessions,
        blocks: deps.blocks,
        voice,
        clock: deps.clock,
        logger,
        limits,
        onEmpty: (sessionId) => rooms.delete(sessionId),
      });
      rooms.set(joined.id, room);
    }

    const peer = await room.admit({
      connectionId: state.id,
      accountId: state.accountId,
      connection: state.connection,
      session: joined,
      role,
      approach: message.approach,
      voiceMode: message.voice,
      sinceTick: message.sinceTick,
      meters: state.meters,
    });

    state.room = room;
    state.peer = peer;
    logger.info('realtime.joined', { connectionId: state.id, accountId: state.accountId, sessionId: joined.id });
  }

  /* ----------------------------------------------------------------------- */
  /* Closing                                                                  */
  /* ----------------------------------------------------------------------- */

  async function handleClose(connectionId: string, info: ConnectionClose): Promise<void> {
    const state = connections.get(connectionId);
    if (state === undefined || state.closed) return;
    state.closed = true;
    connections.delete(connectionId);
    const forAccount = byAccount.get(state.accountId);
    forAccount?.delete(connectionId);
    if (forAccount !== undefined && forAccount.size === 0) byAccount.delete(state.accountId);

    if (state.room !== null && state.peer !== null) {
      // A dropped connection is still a departure: the silhouette walks away
      // rather than blinking out, and everything they held is released.
      await state.room.release(connectionId, info.clean ? 'walk_off' : 'dropped');
    }
    logger.info('realtime.disconnected', { connectionId, accountId: state.accountId, code: info.code });
  }

  /* ----------------------------------------------------------------------- */
  /* Sweeping                                                                 */
  /* ----------------------------------------------------------------------- */

  async function sweep(nowMs: number = deps.clock.now().getTime()): Promise<void> {
    for (const state of [...connections.values()]) {
      if (state.closed) continue;
      // A socket that connects and never joins is a scanner, not a player.
      if (state.room === null && nowMs - state.openedAtMs > limits.joinTimeoutMs) {
        sendError(state, 'not_joined', 'No join message arrived in time.');
        state.connection.close(REALTIME_CLOSE.policyViolation, 'Join timed out.');
        continue;
      }
      state.connection.heartbeat(nowMs, limits.pingIntervalMs, limits.pongTimeoutMs);
    }
    for (const room of [...rooms.values()]) await room.sweepAuthority();
  }

  const sweepIntervalMs = deps.sweepIntervalMs === undefined ? 5_000 : deps.sweepIntervalMs;
  let sweepTimer: NodeJS.Timeout | null = null;
  if (sweepIntervalMs !== null) {
    sweepTimer = setInterval(() => {
      void sweep().catch((error: unknown) => logger.warn('realtime.sweep_failed', { error: String(error) }));
    }, sweepIntervalMs);
    sweepTimer.unref?.();
  }

  return {
    path,
    voice,
    limits,
    sweep,

    stats(): RealtimeStats {
      let participants = 0;
      let inputsRelayed = 0;
      let inputsRetained = 0;
      for (const room of rooms.values()) {
        participants += room.size;
        inputsRelayed += room.inputsRelayed;
        inputsRetained += room.retainedInputs;
      }
      return { connections: connections.size, rooms: rooms.size, participants, inputsRelayed, inputsRetained };
    },

    async close(code = REALTIME_CLOSE.goingAway, reason = 'The fire is being banked.') {
      closing = true;
      server.off('upgrade', upgradeListener);
      if (sweepTimer !== null) clearInterval(sweepTimer);
      for (const state of [...connections.values()]) state.connection.close(code, reason);
      // Give the closing handshakes a moment, then make sure nothing lingers.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 50);
        timer.unref?.();
      });
      for (const state of [...connections.values()]) state.connection.terminate();
      connections.clear();
      byAccount.clear();
      rooms.clear();
    },
  };
}
