/**
 * A session room: everyone at one fire, and the timeline they share.
 *
 * The room is where ADR-0006 actually happens. It holds no simulation state at
 * all — no marshmallow, no fire, no patch temperatures. What it holds is the
 * *input history*: every intent anybody expressed, stamped with the tick and a
 * session-wide monotonic sequence. Replaying that history against the campsite
 * seed reproduces the world exactly, which is how a late joiner arrives at an
 * identical marshmallow without a byte of state crossing the wire.
 *
 * It also owns the three rules that keep a shared fire pleasant:
 *
 *  - **Authority.** One holder per object, leased, with a fencing sequence.
 *    Nobody takes a live object out of somebody's hands; a hand-off keeps both
 *    players holding for a moment so the stick is passed, not teleported.
 *  - **Anti-grief.** Destructive verbs do not exist in the protocol, so the
 *    remaining risk is nuisance — and nuisance is metered.
 *  - **Blocks.** A blocked player's inputs are not relayed to the person who
 *    blocked them, in either direction.
 */

import {
  MAX_INPUT_HISTORY,
  REALTIME_CLOSE,
  SCHEMA_VERSION,
  authorizedDrivers,
  compareStampedInputs,
  defaultApproachPath,
  departurePathFrom,
  intentObjectId,
  intentRequiresAuthority,
  isAuthorityExpired,
  isInterferenceProne,
  realtimeAuthorityDenial,
  tickAt,
  type ArrivalPath,
  type AuthorityHandoffRequest,
  type AuthorityRecord,
  type ClientMessage,
  type DeparturePath,
  type InputIntent,
  type MemberRole,
  type Participant,
  type Presence,
  type RealtimeErrorCode,
  type ServerMessage,
  type Session,
  type StampedInput,
  type VoiceMode,
} from '@somemore/protocol';
import type { WsConnection } from './connection.js';
import { ConnectionMeters, type RealtimeLimitsConfig, wireLimits } from './limits.js';
import type { BlockDirectory, RealtimeCampsitePort, RealtimeSessionPort } from './types.js';
import type { VoiceRoom } from './voice.js';
import type { Clock } from '../clock.js';
import type { Logger } from '../logging.js';

export interface RoomPeer {
  readonly connectionId: string;
  readonly accountId: string;
  readonly connection: WsConnection;
  readonly meters: ConnectionMeters;
  role: MemberRole;
  joinedAtMs: number;
  joinedAtTick: number;
  arrival: ArrivalPath | null;
  presence: Presence;
  voiceMode: VoiceMode;
  joined: boolean;
  departed: boolean;
}

export interface RoomOptions {
  readonly session: Session;
  readonly seed: number;
  readonly environmentId: string;
  readonly sessions: RealtimeSessionPort;
  readonly campsites: RealtimeCampsitePort;
  readonly blocks: BlockDirectory;
  readonly voice: VoiceRoom;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly limits: RealtimeLimitsConfig;
  readonly onEmpty: (sessionId: string) => void;
}

interface MutualHold {
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly untilTick: number;
}

export class SessionRoom {
  readonly sessionId: string;
  readonly campsiteId: string;
  readonly seed: number;
  readonly environmentId: string;
  /** Epoch ms of tick 0 — the moment the session was opened. */
  readonly originMs: number;

  private readonly options: RoomOptions;
  private readonly peers = new Map<string, RoomPeer>();
  /** accountId → accounts that account has blocked. */
  private readonly blocks = new Map<string, Set<string>>();
  private readonly authorityCache = new Map<string, AuthorityRecord>();
  private readonly mutualHolds = new Map<string, MutualHold>();

  private history: StampedInput[] = [];
  private serverSeq = 0;
  private historyTruncated = false;
  private hostAccountId: string;
  private sessionState: Session['state'];
  /** Serialises every mutation so `serverSeq` and the tick stamp cannot race. */
  private tail: Promise<unknown> = Promise.resolve();

  inputsRelayed = 0;

  constructor(options: RoomOptions) {
    this.options = options;
    this.sessionId = options.session.id;
    this.campsiteId = options.session.campsiteId;
    this.seed = options.seed;
    this.environmentId = options.environmentId;
    this.hostAccountId = options.session.hostAccountId;
    this.sessionState = options.session.state;
    const parsed = Date.parse(options.session.startedAt);
    this.originMs = Number.isFinite(parsed) ? parsed : options.clock.now().getTime();
  }

  get size(): number {
    return this.peers.size;
  }

  get retainedInputs(): number {
    return this.history.length;
  }

  get truncated(): boolean {
    return this.historyTruncated;
  }

  nowMs(): number {
    return this.options.clock.now().getTime();
  }

  tick(nowMs: number = this.nowMs()): number {
    return tickAt(this.originMs, nowMs);
  }

  peerFor(connectionId: string): RoomPeer | undefined {
    return this.peers.get(connectionId);
  }

  participants(): Participant[] {
    const nowMs = this.nowMs();
    return [...this.peers.values()]
      .filter((peer) => peer.joined && !peer.departed)
      .map((peer) => this.participantFor(peer, nowMs));
  }

  private participantFor(peer: RoomPeer, nowMs: number): Participant {
    const walkMs = peer.arrival?.durationMs ?? 0;
    return {
      accountId: peer.accountId,
      role: peer.role,
      presence: peer.presence,
      joinedAtTick: peer.joinedAtTick,
      arrival: peer.arrival,
      // Settled once the walk down the trail is over; until then the client is
      // rendering a silhouette, not a player.
      settled: nowMs >= peer.joinedAtMs + walkMs,
    };
  }

  /** Every mutation of room state runs through here, one at a time. */
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.tail.then(work, work);
    this.tail = next.catch(() => undefined);
    return next;
  }

  /* ----------------------------------------------------------------------- */
  /* Sending                                                                  */
  /* ----------------------------------------------------------------------- */

  send(peer: RoomPeer, message: ServerMessage): void {
    if (peer.connection.readyState !== 'open') return;
    peer.connection.send(JSON.stringify(message));
  }

  sendError(
    peer: RoomPeer,
    code: RealtimeErrorCode,
    message: string,
    options: { seq?: number | null; retryAfterMs?: number | null } = {},
  ): void {
    this.send(peer, {
      t: 'error',
      code,
      message,
      seq: options.seq ?? null,
      retryAfterMs: options.retryAfterMs ?? null,
    });
    // Being told to slow down and carrying on regardless is itself the abuse
    // signal. Enough refusals and the socket goes.
    if (code === 'rate_limited' || code === 'interference_cooldown') {
      peer.meters.strikes += 1;
      if (peer.meters.strikes > this.options.limits.rateLimitStrikes) {
        peer.connection.close(REALTIME_CLOSE.policyViolation, 'Too many refused messages.');
      }
    }
  }

  /**
   * Relay to everyone except the origin, skipping any pair where either side
   * has blocked the other. A block is a wall, not a filter you can see past.
   */
  broadcast(message: ServerMessage, options: { fromAccountId?: string | null; exceptConnectionId?: string } = {}): void {
    const from = options.fromAccountId ?? null;
    for (const peer of this.peers.values()) {
      if (!peer.joined || peer.departed) continue;
      if (options.exceptConnectionId !== undefined && peer.connectionId === options.exceptConnectionId) continue;
      if (from !== null && peer.accountId !== from && this.isBlockedEitherWay(peer.accountId, from)) continue;
      this.send(peer, message);
    }
  }

  private isBlockedEitherWay(a: string, b: string): boolean {
    return (this.blocks.get(a)?.has(b) ?? false) || (this.blocks.get(b)?.has(a) ?? false);
  }

  async loadBlocksFor(accountId: string): Promise<void> {
    const listed = await this.options.blocks.listBlocks(accountId);
    this.blocks.set(accountId, new Set(listed.map((b) => b.blockedAccountId)));
  }

  /* ----------------------------------------------------------------------- */
  /* Joining and leaving                                                      */
  /* ----------------------------------------------------------------------- */

  /**
   * Add a peer that has already been admitted (membership proven, session
   * joined). Broadcasts the diegetic arrival, then hands the newcomer a
   * snapshot they can replay to catch up exactly.
   */
  async admit(input: {
    connectionId: string;
    accountId: string;
    connection: WsConnection;
    session: Session;
    role: MemberRole;
    approach: ArrivalPath | undefined;
    voiceMode: VoiceMode;
    sinceTick: number | undefined;
    meters: ConnectionMeters;
  }): Promise<RoomPeer> {
    return this.serialize(async () => {
      const nowMs = this.nowMs();
      const tick = this.tick(nowMs);
      this.sessionState = input.session.state;
      this.hostAccountId = input.session.hostAccountId;

      const presence =
        input.session.presence.find((p) => p.accountId === input.accountId) ??
        ({
          accountId: input.accountId,
          sessionId: this.sessionId,
          connection: 'connected',
          joinedAt: this.options.clock.isoNow(),
          lastHeartbeatAt: this.options.clock.isoNow(),
          role: input.role,
          position: null,
          facingY: 0,
          activity: 'idle',
          micMuted: true,
        } satisfies Presence);

      const peer: RoomPeer = {
        connectionId: input.connectionId,
        accountId: input.accountId,
        connection: input.connection,
        meters: input.meters,
        role: input.role,
        joinedAtMs: nowMs,
        joinedAtTick: tick,
        // Nobody pops into existence: an arrival is always a walk down a trail,
        // and if the client did not describe one we derive a stable one.
        arrival: input.approach ?? defaultApproachPath(this.seed, input.accountId),
        presence,
        voiceMode: input.voiceMode,
        joined: true,
        departed: false,
      };

      await this.loadBlocksFor(input.accountId);
      await this.refreshAuthority(input.accountId);

      // Footsteps first: everybody already at the fire hears them coming.
      const participant = this.participantFor(peer, nowMs);
      this.broadcast(
        { t: 'arrival', tick, participant, path: peer.arrival as ArrivalPath },
        { fromAccountId: input.accountId },
      );

      this.peers.set(peer.connectionId, peer);

      this.send(peer, {
        t: 'welcome',
        tick,
        serverTimeMs: nowMs,
        sessionOriginMs: this.originMs,
        accountId: input.accountId,
        connectionId: input.connectionId,
        schemaVersion: SCHEMA_VERSION,
        session: input.session,
        limits: wireLimits(this.options.limits),
      });

      this.send(peer, this.snapshotFor(peer, tick, input.sinceTick));
      return peer;
    });
  }

  /**
   * The late-joiner payload: seed, environment, and the ordered input history.
   *
   * This is the whole of ADR-0006's claim in one message. Replaying `inputs`
   * against `seed` reconstructs the marshmallow patch-for-patch; nothing about
   * the simulation's *state* is sent, and nothing needs to be.
   */
  snapshotFor(peer: RoomPeer, tick: number, sinceTick: number | undefined): ServerMessage {
    const from = sinceTick ?? 0;
    const inputs = this.history
      .filter((stamped) => stamped.tick >= from && !this.isBlockedEitherWay(peer.accountId, stamped.accountId))
      .sort(compareStampedInputs);
    return {
      t: 'snapshot',
      tick,
      sessionId: this.sessionId,
      campsiteId: this.campsiteId,
      seed: this.seed,
      environmentId: this.environmentId,
      fromTick: from,
      inputs,
      authority: [...this.authorityCache.values()],
      participants: this.participants(),
      // Reconstruction is only exact if we still hold the whole history from
      // the requested tick. Say so rather than handing over a subtly wrong world.
      truncated: this.historyTruncated && from < (this.history[0]?.tick ?? 0),
    };
  }

  /**
   * Remove a peer: release everything they were holding, tell the fire they
   * went, and — for a `walk_off` — give the client a path to animate.
   */
  async release(connectionId: string, manner: 'walk_off' | 'immediate' | 'dropped', path?: DeparturePath): Promise<void> {
    const peer = this.peers.get(connectionId);
    if (peer === undefined) return;
    await this.serialize(async () => {
      if (peer.departed) return;
      peer.departed = true;
      this.peers.delete(connectionId);

      const nowMs = this.nowMs();
      const tick = this.tick(nowMs);
      const heldBefore = [...this.authorityCache.values()]
        .filter((record) => record.holderAccountId === peer.accountId)
        .map((record) => record.objectId);

      // A dropped connection must not leave the marshmallow frozen in mid-air.
      let released: string[] = [];
      try {
        await this.options.sessions.leave(peer.accountId, this.sessionId);
        await this.refreshAuthority(peer.accountId);
        released = heldBefore.filter((objectId) => this.authorityCache.get(objectId)?.holderAccountId !== peer.accountId);
        for (const objectId of released) {
          const record = this.authorityCache.get(objectId);
          this.mutualHolds.delete(objectId);
          if (record !== undefined) {
            this.broadcast({
              t: 'authority',
              tick,
              record,
              reason: 'disconnect',
              mutualHoldUntilTick: null,
              mutualHolders: [],
            });
          }
        }
      } catch (error) {
        this.options.logger.warn('realtime.leave_failed', {
          sessionId: this.sessionId,
          accountId: peer.accountId,
          error: String(error),
        });
      }

      await this.options.voice.leave(this.sessionId, peer.accountId);

      this.broadcast({
        t: 'departure',
        tick,
        accountId: peer.accountId,
        manner,
        path: path ?? (peer.arrival === null ? null : departurePathFrom(peer.arrival)),
        releasedObjectIds: released,
      });

      if (this.peers.size === 0) this.options.onEmpty(this.sessionId);
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Authority                                                               */
  /* ----------------------------------------------------------------------- */

  private async refreshAuthority(asAccountId: string): Promise<void> {
    try {
      const records = await this.options.sessions.listAuthority(asAccountId, this.sessionId);
      this.authorityCache.clear();
      for (const record of records) this.authorityCache.set(record.objectId, record);
    } catch (error) {
      this.options.logger.debug('realtime.authority_refresh_failed', { sessionId: this.sessionId, error: String(error) });
    }
  }

  private recordFor(objectId: string, kind: AuthorityRecord['objectKind']): AuthorityRecord {
    const existing = this.authorityCache.get(objectId);
    if (existing !== undefined) return existing;
    return {
      sessionId: this.sessionId,
      objectId,
      objectKind: kind,
      holderAccountId: null,
      grantedAt: this.options.clock.isoNow(),
      expiresAt: null,
      sequence: 0,
      locked: false,
    };
  }

  /**
   * Expire a lease that has run out.
   *
   * ARCHITECTURE §6: the server grants authority if an object is "unheld or
   * expired". The domain's legality rule only knows about `holder`, so the
   * realtime layer turns an expired lease into an explicit `timeout` hand-off
   * first — performed on the *old holder's* behalf, which is exactly who the
   * rules permit to do it.
   */
  private async expireIfLapsed(record: AuthorityRecord, nowIso: string): Promise<AuthorityRecord> {
    if (record.holderAccountId === null) return record;
    if (!isAuthorityExpired(record, nowIso)) return record;
    const holder = record.holderAccountId;
    const result = await this.options.sessions.handoff(holder, this.sessionId, {
      objectId: record.objectId,
      objectKind: record.objectKind,
      toAccountId: null,
      reason: 'timeout',
      expectedSequence: record.sequence,
      leaseSeconds: 1,
    });
    if (result.status !== 'granted') return record;
    this.authorityCache.set(result.record.objectId, result.record);
    this.mutualHolds.delete(result.record.objectId);
    this.broadcast({ t: 'authority_expired', tick: this.tick(), record: result.record });
    return result.record;
  }

  async handleAuthority(peer: RoomPeer, seq: number, request: AuthorityHandoffRequest): Promise<void> {
    await this.serialize(async () => {
      const nowMs = this.nowMs();
      const nowIso = this.options.clock.isoNow();
      const tick = this.tick(nowMs);

      if (!peer.meters.authority.tryTake(nowMs)) {
        this.sendError(peer, 'rate_limited', 'Too many authority requests.', {
          seq,
          retryAfterMs: peer.meters.authority.retryAfterMs(nowMs),
        });
        return;
      }

      let record = this.recordFor(request.objectId, request.objectKind);
      const originalSequence = record.sequence;
      record = await this.expireIfLapsed(record, nowIso);

      // Expiring the lease bumped the fence. A client whose request was
      // current *before* the expiry is not stale — it just raced the timer —
      // so its expectation is carried forward. A genuinely old sequence is not.
      const expectedSequence =
        record.sequence !== originalSequence && request.expectedSequence === originalSequence
          ? record.sequence
          : request.expectedSequence;

      const denial = realtimeAuthorityDenial({
        record,
        requesterAccountId: peer.accountId,
        request: { expectedSequence, reason: request.reason, toAccountId: request.toAccountId },
        requesterIsHost: this.hostAccountId === peer.accountId,
        requesterIsMember: true,
        targetIsPresent:
          request.toAccountId === null ||
          [...this.peers.values()].some((p) => p.accountId === request.toAccountId && !p.departed),
        sessionState: this.sessionState,
        nowIso,
      });

      if (denial !== null) {
        // Trying to take something out of somebody's hands is the archetypal
        // grief move, so a refusal costs interference budget as well.
        if (denial === 'not_holder') this.chargeInterference(peer, nowMs);
        this.send(peer, { t: 'authority_denied', tick, seq, reason: denial, current: record });
        return;
      }

      const previousHolder = record.holderAccountId;
      const result = await this.options.sessions.handoff(peer.accountId, this.sessionId, {
        ...request,
        expectedSequence,
      });

      if (result.status === 'denied') {
        if (result.reason === 'not_holder') this.chargeInterference(peer, nowMs);
        this.authorityCache.set(result.current.objectId, result.current);
        this.send(peer, { t: 'authority_denied', tick, seq, reason: result.reason, current: result.current });
        return;
      }

      this.authorityCache.set(result.record.objectId, result.record);

      // A pass keeps both hands on the object for a moment. Without this the
      // stick would jump from one player's hand to the other's on whichever
      // frame the grant landed — the teleport ADR-0006 exists to prevent.
      let hold: MutualHold | null = null;
      if (
        request.reason === 'give' &&
        previousHolder !== null &&
        request.toAccountId !== null &&
        previousHolder !== request.toAccountId
      ) {
        hold = {
          fromAccountId: previousHolder,
          toAccountId: request.toAccountId,
          untilTick: tick + this.options.limits.mutualHoldTicks,
        };
        this.mutualHolds.set(result.record.objectId, hold);
      } else {
        this.mutualHolds.delete(result.record.objectId);
      }

      const message: ServerMessage = {
        t: 'authority',
        tick,
        record: result.record,
        reason: request.reason,
        mutualHoldUntilTick: hold?.untilTick ?? null,
        mutualHolders: hold === null ? [] : [hold.fromAccountId, hold.toAccountId],
      };
      this.send(peer, { t: 'ack', seq, tick, serverSeq: this.serverSeq });
      this.send(peer, message);
      this.broadcast(message, { exceptConnectionId: peer.connectionId });
    });
  }

  /** Expire lapsed leases. Called by the transport's sweeper. */
  async sweepAuthority(): Promise<void> {
    await this.serialize(async () => {
      const nowIso = this.options.clock.isoNow();
      for (const record of [...this.authorityCache.values()]) {
        if (record.holderAccountId === null) continue;
        if (!isAuthorityExpired(record, nowIso)) continue;
        await this.expireIfLapsed(record, nowIso);
      }
      for (const [objectId, hold] of [...this.mutualHolds.entries()]) {
        if (this.tick() > hold.untilTick) this.mutualHolds.delete(objectId);
      }
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Inputs                                                                   */
  /* ----------------------------------------------------------------------- */

  private chargeInterference(peer: RoomPeer, nowMs: number): boolean {
    if (!peer.meters.interference.tryTake(nowMs)) {
      peer.meters.interferenceCooldownUntilMs = nowMs + this.options.limits.interferenceCooldownMs;
      return false;
    }
    return true;
  }

  /**
   * Is anybody else mid-task in a way this intent would disturb?
   *
   * Tending the fire together is the point of the game, so it is never
   * forbidden — but doing it repeatedly *at* someone who is roasting is
   * exactly the "repeated interference" spec §9 asks us to cool down.
   */
  private disturbsSomeoneElse(peer: RoomPeer, intent: InputIntent): boolean {
    if (!isInterferenceProne(intent)) return false;
    const busyActivity = intent.kind === 'machine_control' ? 'machine' : 'roasting';
    return [...this.peers.values()].some(
      (other) => other.accountId !== peer.accountId && !other.departed && other.presence.activity === busyActivity,
    );
  }

  async handleInput(peer: RoomPeer, seq: number, intent: InputIntent): Promise<void> {
    await this.serialize(async () => {
      const nowMs = this.nowMs();
      const tick = this.tick(nowMs);

      if (!peer.meters.inputs.tryTake(nowMs)) {
        this.sendError(peer, 'rate_limited', 'Slow down — too many inputs.', {
          seq,
          retryAfterMs: peer.meters.inputs.retryAfterMs(nowMs),
        });
        return;
      }

      // Anything that manipulates an object requires the lease on that object.
      // This is the whole of the "no destructive actions on somebody else's
      // work" rule: the destructive verbs do not exist, and the constructive
      // ones only reach an object you are holding.
      const objectId = intentObjectId(intent);
      if (intentRequiresAuthority(intent) && objectId !== null) {
        const record = this.authorityCache.get(objectId);
        const drivers =
          record === undefined ? [] : authorizedDrivers(record, this.mutualHolds.get(objectId) ?? null, tick);
        if (!drivers.includes(peer.accountId)) {
          this.chargeInterference(peer, nowMs);
          this.sendError(peer, 'no_authority', `You are not holding ${objectId}.`, { seq });
          return;
        }
      }

      if (this.disturbsSomeoneElse(peer, intent)) {
        if (nowMs < peer.meters.interferenceCooldownUntilMs) {
          this.sendError(peer, 'interference_cooldown', 'Give them a moment.', {
            seq,
            retryAfterMs: peer.meters.interferenceCooldownUntilMs - nowMs,
          });
          return;
        }
        if (!this.chargeInterference(peer, nowMs)) {
          this.sendError(peer, 'interference_cooldown', 'Give them a moment.', {
            seq,
            retryAfterMs: this.options.limits.interferenceCooldownMs,
          });
          return;
        }
      }

      this.serverSeq += 1;
      const stamped: StampedInput = {
        tick,
        serverSeq: this.serverSeq,
        accountId: peer.accountId,
        clientSeq: seq,
        intent,
      };
      this.appendHistory(stamped);
      this.inputsRelayed += 1;

      // The sender gets an ack rather than an echo: it already knows the
      // intent, and the ack tells it which tick to apply it on so its local
      // prediction lands on the same tick everybody else will replay it on.
      this.send(peer, { t: 'ack', seq, tick, serverSeq: stamped.serverSeq });
      this.broadcast({ t: 'input', stamped }, { fromAccountId: peer.accountId, exceptConnectionId: peer.connectionId });
    });
  }

  private appendHistory(stamped: StampedInput): void {
    this.history.push(stamped);
    const limit = this.options.limits.maxInputHistory ?? MAX_INPUT_HISTORY;
    if (this.history.length > limit) {
      // Past the cap an exact reconstruction is no longer possible. We keep the
      // recent tail so the session keeps working and mark every future snapshot
      // truncated, rather than pretending.
      this.history = this.history.slice(this.history.length - limit);
      this.historyTruncated = true;
    }
  }

  /* ----------------------------------------------------------------------- */
  /* Presence, chat, blocks, voice                                            */
  /* ----------------------------------------------------------------------- */

  async handlePresence(peer: RoomPeer, seq: number, update: Extract<ClientMessage, { t: 'presence' }>['presence']): Promise<void> {
    await this.serialize(async () => {
      const tick = this.tick();
      try {
        const presence = await this.options.sessions.heartbeat(peer.accountId, this.sessionId, update);
        peer.presence = presence;
        this.send(peer, { t: 'ack', seq, tick, serverSeq: this.serverSeq });
        this.broadcast({ t: 'presence', tick, presence }, { fromAccountId: peer.accountId, exceptConnectionId: peer.connectionId });
      } catch (error) {
        this.sendError(peer, 'not_joined', `Presence update refused: ${describe(error)}`, { seq });
      }
    });
  }

  async handleChat(peer: RoomPeer, seq: number, text: string): Promise<void> {
    await this.serialize(async () => {
      const nowMs = this.nowMs();
      if (!peer.meters.chat.tryTake(nowMs)) {
        this.sendError(peer, 'rate_limited', 'Too much talking at once.', {
          seq,
          retryAfterMs: peer.meters.chat.retryAfterMs(nowMs),
        });
        return;
      }
      const tick = this.tick(nowMs);
      this.send(peer, { t: 'ack', seq, tick, serverSeq: this.serverSeq });
      this.broadcast({ t: 'chat', tick, fromAccountId: peer.accountId, text }, { fromAccountId: peer.accountId, exceptConnectionId: peer.connectionId });
    });
  }

  async handleBlock(peer: RoomPeer, seq: number, accountId: string, blocked: boolean): Promise<void> {
    await this.serialize(async () => {
      if (accountId === peer.accountId) {
        this.sendError(peer, 'invalid_message', 'You cannot block yourself.', { seq });
        return;
      }
      if (blocked) {
        await this.options.blocks.createBlock({
          blockerAccountId: peer.accountId,
          blockedAccountId: accountId,
          createdAt: this.options.clock.isoNow(),
        });
        await this.options.voice.setBlocked(this.sessionId, peer.accountId, accountId, true);
      } else {
        await this.options.blocks.deleteBlock(peer.accountId, accountId);
        await this.options.voice.setBlocked(this.sessionId, peer.accountId, accountId, false);
      }
      await this.loadBlocksFor(peer.accountId);
      this.send(peer, { t: 'ack', seq, tick: this.tick(), serverSeq: this.serverSeq });
    });
  }

  async handleVoice(peer: RoomPeer, seq: number, message: Extract<ClientMessage, { t: 'voice' }>): Promise<void> {
    await this.serialize(async () => {
      const tick = this.tick();
      const voice = this.options.voice;
      switch (message.op) {
        case 'set_mode':
          peer.voiceMode = message.mode ?? peer.voiceMode;
          await voice.setMuted(this.sessionId, peer.accountId, peer.voiceMode !== 'open_mic');
          break;
        case 'set_muted':
          await voice.setMuted(this.sessionId, peer.accountId, message.muted ?? true);
          break;
        case 'set_volume':
          if (message.accountId !== undefined && message.volume !== undefined) {
            await voice.setVolume(this.sessionId, peer.accountId, message.accountId, message.volume);
          }
          break;
        case 'leave':
          await voice.leave(this.sessionId, peer.accountId);
          this.send(peer, { t: 'ack', seq, tick, serverSeq: this.serverSeq });
          return;
        default:
          break;
      }

      const room = await voice.mintToken({
        sessionId: this.sessionId,
        campsiteId: this.campsiteId,
        accountId: peer.accountId,
        displayName: peer.accountId,
        mode: message.mode ?? peer.voiceMode,
      });
      this.send(peer, { t: 'ack', seq, tick, serverSeq: this.serverSeq });
      this.send(peer, { t: 'voice', tick, room });
      if (room.status !== 'ready') {
        // Degrade, never block: say why, then carry on with text and gesture.
        this.sendError(peer, 'voice_not_configured', room.reason, { seq });
      }
    });
  }

  handleDepart(peer: RoomPeer, seq: number, manner: 'walk_off' | 'immediate', path: DeparturePath | undefined): void {
    this.send(peer, { t: 'ack', seq, tick: this.tick(), serverSeq: this.serverSeq });
    void this.release(peer.connectionId, manner, path).then(() => {
      peer.connection.close(1000, manner === 'walk_off' ? 'Walked off down the trail.' : 'Left the fire.');
    });
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
