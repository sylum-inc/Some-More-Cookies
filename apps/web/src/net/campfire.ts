/**
 * A shared campfire.
 *
 * One object owns everything about being at a fire with other people: the
 * socket, the ordered timeline, who is here, who is holding what, voice, and
 * the text-and-gesture channel that carries the fire when there is no voice.
 * The rest of the client talks to this and never to the wire.
 *
 * The shape is chosen so that **there is only ever one code path**. A player
 * alone at their own campsite has a `Campfire` too — one with no transport,
 * which applies every intent locally and immediately. Joining a fire does not
 * switch the client into a different mode; it gives the same object a socket.
 * That is what makes ARCHITECTURE §1.5 true rather than aspirational: losing
 * the connection drops the session back to exactly the object that was already
 * working, mid-roast, without a reload.
 *
 * ## What goes on the wire, and what does not
 *
 * Intents (ADR-0006), authority, presence, chat, voice control. Not: the
 * simulation, the camera, the walk, the wildlife, the sky, or anything a
 * player's own client observed about their own night. See
 * `SharedTimeline.divergenceNotes()`.
 */

import {
  arrive as simArrive,
  beginRoasting as simBeginRoasting,
  blowOutMarshmallow as simBlowOut,
  finishRoasting as simFinishRoasting,
  holdComponent as simHoldComponent,
  moveComponent as simMoveComponent,
  moveMarshmallow as simMoveMarshmallow,
  operateMachine as simOperateMachine,
  placeComponent as simPlaceComponent,
  stepRitual as simStepRitual,
  takeSandwich as simTakeSandwich,
  tendFire as simTendFire,
  SIM_DT,
  type ComponentKind,
  type MachineAction,
  type RitualState,
  type SandwichRecord,
  type Vec3,
} from '@somemore/sim';
import {
  type AuthorityObjectKind,
  type Gesture,
  type InputIntent,
  type MachineControl,
  type MachineDialProgram,
  type Presence,
  type ServerMessage,
  type SessionState,
  type TendFireAction,
} from '@somemore/protocol';
import { RealtimeTransport, type RealtimeStatus, type RealtimeTransportOptions } from './realtime.js';
import { SharedTimeline, type TimelineOptions } from './timeline.js';
import { Roster } from './roster.js';
import { AuthorityTable, MARSHMALLOW_OBJECT_ID } from './authority.js';
import { VoiceChannel } from './voice.js';

export const TORCH_OBJECT_ID = 'obj_torch_1';
export const SM01_OBJECT_ID = 'obj_sm01_1';

/**
 * `tendFire`'s action, which the simulation takes inline and never names.
 * Written down here so the wire mapping has something to be a function of.
 */
export type FireAction =
  | { type: 'add-log'; woodId: string; placement?: number }
  | { type: 'rake' }
  | { type: 'fan'; strength?: number };

/**
 * How often the holder's hand is sent.
 *
 * The server allows seventy inputs a second. Twenty is what a hand actually
 * contains: the marshmallow is moved by a person, not by a mouse driver, and
 * three simulation steps between samples is below the threshold at which a
 * rotation reads as stepped. It leaves the rest of the budget for everything
 * else somebody might do while roasting.
 */
export const HAND_SEND_HZ = 20;
/** Presence is cheaper still: it moves a silhouette, not a thermal model. */
export const PRESENCE_SEND_HZ = 10;

/**
 * Shared ticks caught up per call into `step`.
 *
 * `advance` in `time.ts` calls its step callback up to sixteen times in one
 * frame, so this is `CATCH_UP_STEPS_PER_FRAME / 8` — a frame that is already
 * recovering from a stall spends at most a couple of milliseconds catching the
 * shared world up as well, and still recovers a minute of backlog in about a
 * third of a second.
 */
const STEPS_PER_STEP_CALL = 12;

/**
 * How long a lost socket is treated as a hiccup rather than a departure.
 *
 * Under this the world holds its breath, which nobody notices and which keeps
 * the resume path — the server replaying only the missed ticks — available.
 * Over it, the fire carries on without the session (see `SharedTimeline.stepAlone`).
 */
const RECONNECT_GRACE_MS = 900;

export interface ChatLine {
  readonly from: string;
  readonly name: string;
  readonly text: string;
  readonly at: number;
  readonly mine: boolean;
}

export interface GestureEvent {
  readonly from: string;
  readonly name: string;
  readonly gesture: Gesture;
  readonly target: string | null;
  readonly at: number;
}

export interface CampfireOptions {
  /** Absent for a campsite of one. */
  readonly transport?: Omit<RealtimeTransportOptions, 'url' | 'token' | 'sessionId'> & {
    url: string;
    token: string;
    sessionId: string;
  };
  /**
   * Simulation options for the rebuilt shared world.
   *
   * Everything here must be derived from the session or the environment, never
   * from local settings — see `TimelineOptions`.
   */
  readonly ritualOptionsFor?: (environmentId: string, sessionOriginMs: number) => TimelineOptions['ritualOptions'];
  /** Called when the shared world replaces the local one. */
  readonly onAdopt?: (ritual: RitualState, seed: number, environmentId: string) => void;
  /** A line for the subtitle layer. Everything audible has one (spec §12). */
  readonly onSubtitle?: (line: string) => void;
  /** Presentation-relevant change; the interface should re-render. */
  readonly onChange?: () => void;
  /** The local player's accessibility assists, read when an intent is built. */
  readonly assists?: () => { autoRotate: number; assemblyAssist: number };
  readonly now?: () => number;
}

export class Campfire {
  readonly roster: Roster;
  readonly authority: AuthorityTable;
  readonly voice = new VoiceChannel();
  readonly chat: ChatLine[] = [];
  readonly gestures: GestureEvent[] = [];

  transport: RealtimeTransport | null = null;
  timeline: SharedTimeline | null = null;

  accountId: string | null = null;
  sessionId: string | null = null;
  hostAccountId: string | null = null;
  sessionState: SessionState = 'active';
  campsiteId: string | null = null;
  /** Epoch milliseconds of tick 0, from `welcome`. Identical on every client. */
  sessionOriginMs = 0;
  /**
   * The server's clock minus this device's, in milliseconds.
   *
   * Authority leases are timestamps the *server* issued, and whether one has
   * lapsed is a question about the server's clock rather than about this
   * laptop's. Reading `Date.now()` instead meant a device a few minutes fast
   * believed every lease it was granted had already expired, and would offer
   * to take a marshmallow out of somebody's hand that it was itself holding.
   * Set from `welcome` and refined by every `pong`.
   */
  serverClockSkewMs = 0;
  /**
   * How long a lease we ask for when picking something up.
   *
   * Long, deliberately: a lease that lapses while somebody is thinking is a
   * marshmallow taken out of their hand by a timer, and the server releases
   * everything they hold the moment they disconnect anyway.
   */
  leaseSeconds = 300;

  private readonly options: CampfireOptions;
  private readonly now: () => number;
  private lastHandSendMs = 0;
  private lastComponentSendMs = 0;
  private lastPresenceSendMs = 0;
  private predictedComponent: { offset: Vec3; rotation: number } | null = null;
  private autoRotateAccum = 0;
  /** When the socket went, in local milliseconds. Zero while connected. */
  private strandedSinceMs = 0;
  /**
   * Who last did the thing the ritual is currently doing.
   *
   * The ritual's stage is shared — it has to be, it is part of the world — but
   * the *camera* is not. Without this, one person starting a roast pulled every
   * other client into an arm's-length close-up of somebody else's marshmallow,
   * which is the opposite of being at a campfire together: you could no longer
   * see the fire, the machine, or the person doing it.
   */
  private lastActorAccountId: string | null = null;
  /** Set while this client's own `take_sandwich` is still in flight. */
  private pendingTake = false;
  /**
   * Intents this client has sent and not yet seen placed in the timeline.
   *
   * The server acks the sender rather than echoing to it — it already knows
   * what it sent, and a round trip of its own intent back at it would double
   * the traffic of a roast. So the `ack` is where a local input enters the
   * *shared* timeline: it carries the tick and the server sequence, and the
   * intent is looked up here by the client sequence it was sent under. Without
   * this a player's own actions reach every fire but their own.
   */
  private readonly awaitingAck = new Map<number, InputIntent>();
  private lastMarshmallowSent: { position: Vec3; rotation: number } | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CampfireOptions = {}) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.roster = new Roster(() => this.accountId ?? '');
    this.authority = new AuthorityTable(
      () => this.accountId ?? '',
      () => this.sessionState,
      () => this.accountId !== null && this.accountId === this.hostAccountId,
      // You are at your own fire: without yourself in this list, reaching for
      // anything is refused as `target_not_present`, because a `grab` names
      // *you* as the person it is going to.
      () => [this.accountId ?? '', ...this.roster.presentAccountIds],
      () => this.serverNowIso(),
    );
  }

  /** A campsite of one. Every intent applies locally and immediately. */
  static solo(options: CampfireOptions = {}): Campfire {
    return new Campfire(options);
  }

  get joined(): boolean {
    return this.timeline !== null && this.transport?.status === 'joined';
  }

  /** Whether the shared timeline, rather than the local frame, owns the step. */
  get drivesSimulation(): boolean {
    return this.timeline !== null;
  }

  get status(): RealtimeStatus {
    return this.transport?.status ?? 'idle';
  }

  get statusDetail(): string | null {
    return this.transport?.statusDetail ?? null;
  }

  get latencyMs(): number {
    return this.transport?.latencyMs ?? 0;
  }

  get tick(): number {
    return this.timeline?.appliedTick ?? 0;
  }

  get catchingUp(): boolean {
    return this.timeline?.catchingUp ?? false;
  }

  get notes(): string[] {
    return this.timeline?.divergenceNotes() ?? [];
  }

  /**
   * Somebody else is doing the thing the ritual is in the middle of.
   *
   * The composed close-ups (roasting, assembly, the SM-01) are framings of
   * *your* hands. When they are not your hands you stay on your own feet, free
   * to walk round the fire and watch — which is what being at somebody else's
   * roast is.
   */
  get spectating(): boolean {
    if (!this.joined || this.timeline === null || this.accountId === null) return false;
    /*
     * Whose hands, asked of the authority model rather than of who started it.
     * A stick that has been handed over is in the other person's hands even
     * though this player began the roast, and the camera has to follow the
     * hands — that is what the close-up is a shot of.
     */
    const stage = this.timeline.ritual.stage;
    if (stage === 'roasting') {
      const holder = this.authority.holderOf(MARSHMALLOW_OBJECT_ID);
      return holder !== null && holder !== this.accountId;
    }
    if (stage === 'machine' || stage === 'reveal') {
      const holder = this.authority.holderOf(SM01_OBJECT_ID);
      return holder !== null && holder !== this.accountId;
    }
    // Assembly and eating name no object on this wire, so the best available
    // answer is who last moved the ritual on.
    return this.lastActorAccountId !== null && this.lastActorAccountId !== this.accountId;
  }

  /** Now, on the server's clock. Everything about leases is asked of this. */
  serverNowIso(): string {
    return new Date(this.now() + this.serverClockSkewMs).toISOString();
  }

  /** Open the socket, if this campfire has one to open. */
  connect(): void {
    const config = this.options.transport;
    if (config === undefined || this.transport !== null) return;
    this.sessionId = config.sessionId;
    this.transport = new RealtimeTransport(config, {
      onMessage: (message) => this.receive(message),
      onStatus: (status, detail) => {
        if (status === 'reconnecting' || status === 'alone') {
          // Losing the connection is not losing the campsite. Say what
          // happened, once, and carry on with the fire that is already lit.
          this.options.onSubtitle?.(
            status === 'alone' ? '[you are alone at the fire]' : '[the others have gone quiet for a moment]',
          );
        }
        this.options.onChange?.();
      },
      onMalformed: () => this.options.onChange?.(),
    });
    this.transport.connect();
    this.pingTimer = setInterval(() => this.transport?.ping(), 10_000);
    (this.pingTimer as { unref?: () => void }).unref?.();
  }

  /* ----------------------------------------------------------------------- */
  /* Receiving                                                                */
  /* ----------------------------------------------------------------------- */

  private receive(message: ServerMessage): void {
    /*
     * The safe tick is raised only by messages the room emits from its
     * serialised queue. `pong` and transport-level `error` are answered
     * outside it and may overtake a relay stamped earlier, so trusting their
     * tick would let the simulation step past an input still in flight. See
     * the note at the top of `timeline.ts`.
     */
    switch (message.t) {
      case 'welcome': {
        this.accountId = message.accountId;
        this.hostAccountId = message.session.hostAccountId;
        this.sessionState = message.session.state;
        this.campsiteId = message.session.campsiteId;
        this.sessionOriginMs = message.sessionOriginMs;
        this.serverClockSkewMs = message.serverTimeMs - this.now();
        this.timeline?.observe(message.tick);
        this.options.onChange?.();
        return;
      }
      case 'snapshot': {
        if (this.timeline === null) {
          this.timeline = new SharedTimeline({
            seed: message.seed,
            environmentId: message.environmentId,
            ...(this.options.ritualOptionsFor
              ? { ritualOptions: this.options.ritualOptionsFor(message.environmentId, this.sessionOriginMs) }
              : {}),
          });
        }
        this.timeline.reset(message);
        for (const record of message.authority) this.authority.applyGrant(message.tick, record, null, []);
        this.roster.seed(message.participants, message.tick);
        // Everything the world needs before anybody can act: catch the whole
        // history up in one go, which is cheap (see `BULK_CATCH_UP_TICKS`) and
        // happens while the local player is still walking in.
        this.timeline.pump();
        this.options.onAdopt?.(this.timeline.ritual, message.seed, message.environmentId);
        this.announce();
        this.options.onChange?.();
        return;
      }
      case 'input': {
        this.timeline?.enqueue(message.stamped);
        if (changesStage(message.stamped.intent)) this.lastActorAccountId = message.stamped.accountId;
        if (message.stamped.intent.kind === 'gesture') {
          this.gestures.push({
            from: message.stamped.accountId,
            name: this.roster.nameOf(message.stamped.accountId),
            gesture: message.stamped.intent.gesture,
            target: message.stamped.intent.targetAccountId,
            at: this.now(),
          });
          if (this.gestures.length > 16) this.gestures.shift();
          this.options.onSubtitle?.(
            `[${this.roster.nameOf(message.stamped.accountId)} ${describeGesture(message.stamped.intent.gesture)}]`,
          );
        }
        if (message.stamped.intent.kind === 'move_prop') {
          this.roster.propMoved(message.stamped.accountId, message.stamped.intent.objectId, message.stamped.intent.position);
        }
        return;
      }
      case 'ack': {
        const intent = this.awaitingAck.get(message.seq);
        if (intent !== undefined) {
          this.awaitingAck.delete(message.seq);
          if (changesStage(intent)) this.lastActorAccountId = this.accountId;
          this.timeline?.enqueue({
            tick: message.tick,
            serverSeq: message.serverSeq,
            accountId: this.accountId ?? '',
            clientSeq: message.seq,
            intent,
          });
        }
        this.timeline?.observe(message.tick);
        return;
      }
      case 'authority': {
        this.timeline?.observe(message.tick);
        this.authority.applyGrant(message.tick, message.record, message.mutualHoldUntilTick, message.mutualHolders);
        if (message.reason === 'give' && message.record.holderAccountId !== null) {
          const to = this.roster.nameOf(message.record.holderAccountId);
          this.options.onSubtitle?.(
            message.record.holderAccountId === this.accountId ? '[it is passed to you]' : `[passed to ${to}]`,
          );
        }
        this.options.onChange?.();
        return;
      }
      case 'authority_denied': {
        this.timeline?.observe(message.tick);
        this.authority.applyDenial(message.seq, message.reason, message.current, (id) => this.roster.nameOf(id));
        const line = this.authority.lastDenial?.line;
        if (line !== undefined) this.options.onSubtitle?.(line);
        this.options.onChange?.();
        return;
      }
      case 'authority_expired': {
        this.timeline?.observe(message.tick);
        this.authority.applyExpiry(message.record);
        this.options.onChange?.();
        return;
      }
      case 'presence': {
        this.timeline?.observe(message.tick);
        this.roster.presence(message.presence);
        return;
      }
      case 'arrival': {
        this.timeline?.observe(message.tick);
        this.roster.arrive(message.participant, message.path, message.tick);
        this.announce();
        this.options.onChange?.();
        return;
      }
      case 'departure': {
        this.timeline?.observe(message.tick);
        this.authority.releaseAllHeldBy(message.accountId, message.releasedObjectIds);
        this.roster.depart(message.accountId, message.manner, message.path, message.tick);
        this.announce();
        this.options.onChange?.();
        return;
      }
      case 'chat': {
        this.timeline?.observe(message.tick);
        this.pushChat({
          from: message.fromAccountId,
          name: this.roster.nameOf(message.fromAccountId),
          text: message.text,
          at: this.now(),
          mine: false,
        });
        return;
      }
      case 'voice': {
        this.timeline?.observe(message.tick);
        this.voice.applyRoom(message.room);
        if (message.room.status !== 'ready') {
          this.options.onSubtitle?.('[no voice here tonight — type or gesture]');
        }
        this.options.onChange?.();
        return;
      }
      case 'pong': {
        // Half the round trip out, half back: the best estimate of the
        // server's clock this transport can make without a time protocol.
        const half = (this.transport?.latencyMs ?? 0) / 2;
        this.serverClockSkewMs = message.serverTimeMs + half - this.now();
        return;
      }
      case 'error': {
        // Never fatal, and never a modal. `history_truncated` is the one worth
        // saying out loud, because it is a claim about accuracy.
        if (message.code === 'history_truncated' && this.timeline !== null) this.timeline.truncated = true;
        this.options.onChange?.();
        return;
      }
      default:
        return;
    }
  }

  private announce(): void {
    for (const line of this.roster.drainAnnouncements()) this.options.onSubtitle?.(line);
  }

  private pushChat(line: ChatLine): void {
    this.chat.push(line);
    if (this.chat.length > 80) this.chat.shift();
    // Chat is a *sound* at a campfire as much as a text box, so it goes to the
    // subtitle layer too rather than only into a panel nobody has open.
    this.options.onSubtitle?.(`${line.name}: ${line.text}`);
    this.options.onChange?.();
  }

  /* ----------------------------------------------------------------------- */
  /* The step                                                                 */
  /* ----------------------------------------------------------------------- */

  /**
   * One fixed step, in place of `stepRitual`.
   *
   * Alone, this *is* `stepRitual`. At a shared fire the timeline owns the step:
   * it applies each replicated intent on the tick the server stamped it with,
   * advances the world by however many ticks are now proven complete, and then
   * puts the local player's own hands back where their pointer is, which is
   * cosmetic and lasts exactly one frame. See `timeline.ts` for why that is
   * the whole of the reconciliation and why there is no rollback.
   */
  step(ritual: RitualState, dt: number = SIM_DT): void {
    const timeline = this.timeline;
    if (timeline === null) {
      simStepRitual(ritual, dt);
      return;
    }

    // The local frame has just written this player's hand into `roastInput`.
    // Keep it as the prediction; the replicated value is what is simulated.
    const shared = timeline.ritual;
    const predictedHand =
      ritual === shared && shared.stage === 'roasting'
        ? {
            position: { x: ritual.roastInput.position.x, y: ritual.roastInput.position.y, z: ritual.roastInput.position.z },
            rotation: ritual.roastInput.rotation,
          }
        : null;

    if (predictedHand !== null) this.sendHand(predictedHand, dt);

    if (this.joined) {
      // A slice, not a drain: `advance` may call this sixteen times in one
      // frame after a stall, so the per-call budget is the frame budget divided
      // by that ceiling, and the bulk path is refused. See `SharedTimeline.pump`.
      timeline.pump(STEPS_PER_STEP_CALL, false);
    } else {
      /*
       * The socket has gone. The fire has not.
       *
       * ARCHITECTURE §1.5: a dropped connection means you are alone at your own
       * fire, not that the world stops — so the simulation carries on
       * unordered, every intent applies locally again, and the timeline records
       * that it has strayed. When the socket comes back it asks for the whole
       * snapshot rather than resuming, because the ticks invented here are this
       * client's and must not be spliced into everybody else's.
       *
       * There is a moment's grace first. A hiccup of a few hundred milliseconds
       * is a reconnect, not a departure, and pausing imperceptibly through it
       * keeps the cheap resume path — where the server replays only the gap —
       * available. Past the grace it is a real drop and the fire wins.
       */
      const now = this.now();
      if (this.strandedSinceMs === 0) this.strandedSinceMs = now;
      if (now - this.strandedSinceMs > RECONNECT_GRACE_MS) timeline.stepAlone(dt);
    }
    if (this.joined) this.strandedSinceMs = 0;
    this.authority.sweep(timeline.appliedTick);
    /*
     * Where to pick the story up if the socket drops.
     *
     * Inputs at `appliedTick` have not been applied yet — they go in before the
     * step that leaves it — so this is exactly the first tick we still need,
     * and asking for it means a reconnect replays the gap rather than the
     * session. The server answers with `fromTick` and the timeline resumes
     * instead of rebuilding.
     */
    if (this.transport !== null) {
      this.transport.resumeFromTick = timeline.strayed ? null : timeline.appliedTick;
    }

    /*
     * Taking the sandwich off the tray is two things: a machine control, which
     * is replicated, and a move to eating, which is not — there is no `bite`
     * intent on this wire, so the sandwich belongs to whoever picked it up.
     * The local half waits for the replicated half to land, so the machine
     * still agrees on every client. `takeSandwich` re-runs the control, which
     * the machine now refuses, and performs the local transition only.
     */
    if (this.pendingTake && shared.sandwich !== null && !shared.machine.hasSandwich) {
      this.pendingTake = false;
      simTakeSandwich(shared);
    }

    const driving = this.authority.canDrive(MARSHMALLOW_OBJECT_ID, timeline.appliedTick);
    timeline.predict({
      marshmallow: predictedHand !== null && driving ? predictedHand : null,
      component: this.predictedComponent,
    });
  }

  /**
   * Send the hand, at a human rate.
   *
   * Auto-rotation (spec §12) is folded in here rather than left to
   * `stepRitual`: the shared world runs with `autoRotate` pinned to zero,
   * because an assist that ran on every client would make the marshmallow spin
   * at the sum of everybody's accessibility settings. Adding it to the
   * rotation the holder *sends* keeps the assist exactly what §12 says it is —
   * a change to the dexterity this player needs, and to nothing else.
   */
  private sendHand(hand: { position: Vec3; rotation: number }, dt: number): void {
    const timeline = this.timeline;
    if (timeline === null || !this.joined) return;
    if (!this.authority.canDrive(MARSHMALLOW_OBJECT_ID, timeline.appliedTick)) return;

    const autoRotate = this.options.assists?.().autoRotate ?? 0;
    if (autoRotate > 0) this.autoRotateAccum += autoRotate * dt;

    const now = this.now();
    if (now - this.lastHandSendMs < 1000 / HAND_SEND_HZ) return;
    const rotation = hand.rotation + this.autoRotateAccum;
    const last = this.lastMarshmallowSent;
    // A hand that has not moved is not news. This is most of the traffic saved.
    if (
      last !== null &&
      Math.abs(last.rotation - rotation) < 1e-4 &&
      Math.abs(last.position.x - hand.position.x) < 1e-4 &&
      Math.abs(last.position.y - hand.position.y) < 1e-4 &&
      Math.abs(last.position.z - hand.position.z) < 1e-4
    ) {
      return;
    }
    this.lastHandSendMs = now;
    this.lastMarshmallowSent = { position: { ...hand.position }, rotation };
    this.emit({
      kind: 'move_marshmallow',
      objectId: MARSHMALLOW_OBJECT_ID,
      position: hand.position,
      rotation,
      blow: 0,
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Intents                                                                  */
  /* ----------------------------------------------------------------------- */

  /**
   * Send an intent, or apply it locally when there is nobody to send it to.
   *
   * The local application is not a fallback bolted on: it is the same call the
   * single-player build has always made, and it is why a dropped connection
   * costs company rather than the ritual.
   */
  private emit(intent: InputIntent): void {
    if (!this.joined || this.transport === null) return;
    const seq = this.transport.send({ t: 'input', intent });
    // Held until the ack says which tick it landed on. See `awaitingAck`.
    if (seq !== null) this.awaitingAck.set(seq, intent);
    // A refused input never gets an ack, so the map is bounded rather than
    // trusted: anything older than a generous round trip is simply forgotten.
    if (this.awaitingAck.size > 256) {
      const oldest = this.awaitingAck.keys().next();
      if (!oldest.done) this.awaitingAck.delete(oldest.value);
    }
  }

  /**
   * Bind a ritual for the solo path.
   *
   * A campfire with no socket still has to apply intents to *something*, and
   * that something is whatever the store is holding. Set once at boot.
   */
  bind(ritual: RitualState): void {
    if (this.timeline !== null) return;
    this.soloRitual = ritual;
  }

  private soloRitual: RitualState | null = null;

  private get target(): RitualState | null {
    return this.timeline?.ritual ?? this.soloRitual;
  }

  private localOnly(apply: (ritual: RitualState) => void): boolean {
    if (this.joined) return false;
    const ritual = this.target;
    if (ritual !== null) apply(ritual);
    return true;
  }

  arrive(): void {
    // Purely local: 'arriving' → 'at-fire' is where the camera is, not what the
    // simulation is doing, and `stepRitual` branches on neither.
    const ritual = this.target;
    if (ritual !== null) simArrive(ritual);
  }

  tendFire(action: FireAction): void {
    const wire = toTendFireAction(action);
    if (wire === null || this.localOnly((r) => simTendFire(r, action))) return;
    this.emit({ kind: 'tend_fire', action: wire });
  }

  beginRoast(): void {
    if (this.localOnly((r) => simBeginRoasting(r))) return;
    this.autoRotateAccum = 0;
    this.lastMarshmallowSent = null;
    /*
     * Reach for it first. Every intent that names an object requires the lease
     * on that object — that is the whole of the anti-grief rule — so an intent
     * sent ahead of the grab is refused rather than queued. The server
     * serialises the room's work in the order it arrives, so a grab sent on
     * this socket immediately before the intent is guaranteed to be decided
     * first; there is nothing to wait for.
     */
    this.grab(MARSHMALLOW_OBJECT_ID, 'marshmallow');
    this.emit({ kind: 'begin_roast', objectId: MARSHMALLOW_OBJECT_ID });
  }

  moveMarshmallow(position: Vec3, rotation: number, blow = 0): void {
    if (this.localOnly((r) => simMoveMarshmallow(r, position, rotation, blow))) return;
    this.emit({ kind: 'move_marshmallow', objectId: MARSHMALLOW_OBJECT_ID, position, rotation, blow });
  }

  blowOut(): boolean {
    const ritual = this.target;
    const wouldWork = ritual !== null && ritual.marshmallow.burning;
    if (this.localOnly((r) => void simBlowOut(r))) return wouldWork;
    this.emit({ kind: 'blow_out', objectId: MARSHMALLOW_OBJECT_ID });
    return wouldWork;
  }

  finishRoast(): boolean {
    const ritual = this.target;
    const fallen = ritual?.marshmallow.fallen ?? false;
    if (this.localOnly((r) => void simFinishRoasting(r))) return !fallen;
    this.emit({ kind: 'finish_roast', objectId: MARSHMALLOW_OBJECT_ID });
    return !fallen;
  }

  holdComponent(kind?: ComponentKind): void {
    if (this.localOnly((r) => void simHoldComponent(r, kind))) return;
    const assist = this.options.assists?.().assemblyAssist;
    this.emit({
      kind: 'hold_component',
      component: kind ?? null,
      ...(assist === undefined ? {} : { assist }),
    });
  }

  moveComponent(offset: Vec3, rotation: number): void {
    if (this.localOnly((r) => simMoveComponent(r, offset, rotation))) return;
    // Predicted so the piece follows the finger, corrected by the next step.
    this.predictedComponent = { offset: { ...offset }, rotation };
    const now = this.now();
    if (now - this.lastComponentSendMs < 1000 / HAND_SEND_HZ) return;
    this.lastComponentSendMs = now;
    this.emit({ kind: 'move_component', offset, rotation });
  }

  placeComponent(): void {
    this.predictedComponent = null;
    if (this.localOnly((r) => void simPlaceComponent(r))) return;
    this.emit({ kind: 'place_component' });
  }

  machine(action: MachineAction): void {
    const control = toMachineControl(action);
    if (control === null || this.localOnly((r) => void simOperateMachine(r, action))) return;
    // The SM-01 is an object like any other: operating it means having your
    // hands on it, and the protocol will not accept a control from anybody who
    // has not reached for it.
    if (this.authority.holderOf(SM01_OBJECT_ID) !== this.accountId) this.grab(SM01_OBJECT_ID, 'sm01');
    this.emit({
      kind: 'machine_control',
      objectId: SM01_OBJECT_ID,
      control: control.control,
      ...(control.program === undefined ? {} : { program: control.program }),
    });
  }

  /**
   * Take the sandwich off the tray.
   *
   * Returns the record for the Passport, which is this player's own copy of an
   * object every client derived identically from the same roast — the whole
   * point of a deterministic core (ADR-0006).
   */
  takeSandwich(): SandwichRecord | null {
    const ritual = this.target;
    if (ritual === null) return null;
    if (this.localOnly((r) => void simTakeSandwich(r))) return ritual.sandwich;
    if (this.authority.holderOf(SM01_OBJECT_ID) !== this.accountId) this.grab(SM01_OBJECT_ID, 'sm01');
    this.pendingTake = true;
    this.emit({ kind: 'machine_control', objectId: SM01_OBJECT_ID, control: 'take_sandwich' });
    return ritual.sandwich;
  }

  /** A wave, a high five, a stick tossed across the fire. Changes no world state. */
  gesture(gesture: Gesture, targetAccountId: string | null = null): void {
    if (!this.joined) return;
    this.emit({ kind: 'gesture', gesture, targetAccountId });
    this.gestures.push({
      from: this.accountId ?? '',
      name: 'you',
      gesture,
      target: targetAccountId,
      at: this.now(),
    });
    if (this.gestures.length > 16) this.gestures.shift();
    this.options.onChange?.();
  }

  /** Where the torch is, so everyone can see who is carrying it. */
  moveTorch(position: Vec3, rotationY: number): void {
    if (!this.joined) return;
    if (!this.authority.canDrive(TORCH_OBJECT_ID, this.tick)) return;
    const now = this.now();
    if (now - this.lastPropSendMs < 1000 / PRESENCE_SEND_HZ) return;
    this.lastPropSendMs = now;
    this.emit({ kind: 'move_prop', objectId: TORCH_OBJECT_ID, position, rotationY });
  }

  private lastPropSendMs = 0;

  /* ----------------------------------------------------------------------- */
  /* Authority                                                                */
  /* ----------------------------------------------------------------------- */

  /** Reach for something. Refused, in words, if it is in somebody's hands. */
  grab(objectId: string, objectKind: AuthorityObjectKind): boolean {
    if (!this.joined || this.transport === null) return true;
    const denial = this.authority.wouldDeny({ objectId, objectKind, reason: 'grab', toAccountId: this.accountId });
    if (denial !== null) {
      const record = this.authority.record(objectId);
      if (record !== null) {
        this.authority.applyDenial(-1, denial, record, (id) => this.roster.nameOf(id));
        this.options.onSubtitle?.(this.authority.lastDenial?.line ?? '[not just now]');
      }
      return false;
    }
    this.transport.send({
      t: 'authority',
      request: {
        objectId,
        objectKind,
        toAccountId: this.accountId,
        reason: 'grab',
        expectedSequence: this.authority.sequenceFor(objectId),
        leaseSeconds: this.leaseSeconds,
      },
    });
    return true;
  }

  /**
   * Hold it out to somebody.
   *
   * This is the spec's test case, and the reason `mutualHoldUntilTick` exists:
   * for the length of that window both hands are on the stick and both may
   * drive it, so the scene interpolates it across rather than snapping it into
   * the other person's fist. Nothing is taken from anybody — a `give` is
   * offered by the holder, which is the only direction the protocol allows.
   */
  offer(objectId: string, objectKind: AuthorityObjectKind, toAccountId: string): boolean {
    if (!this.joined || this.transport === null) return false;
    const denial = this.authority.wouldDeny({ objectId, objectKind, reason: 'give', toAccountId });
    if (denial !== null) {
      const record = this.authority.record(objectId);
      if (record !== null) {
        this.authority.applyDenial(-1, denial, record, (id) => this.roster.nameOf(id));
        this.options.onSubtitle?.(this.authority.lastDenial?.line ?? '[not just now]');
      }
      return false;
    }
    const seq = this.transport.send({
      t: 'authority',
      request: {
        objectId,
        objectKind,
        toAccountId,
        reason: 'give',
        expectedSequence: this.authority.sequenceFor(objectId),
        leaseSeconds: this.leaseSeconds,
      },
    });
    if (seq !== null) {
      this.authority.noteOffer({ objectId, objectKind, toAccountId, seq, at: this.now() });
      this.options.onSubtitle?.(`[you hold it out to ${this.roster.nameOf(toAccountId)}]`);
    }
    return seq !== null;
  }

  /** Put it down. */
  release(objectId: string, objectKind: AuthorityObjectKind): void {
    if (!this.joined || this.transport === null) return;
    this.transport.send({
      t: 'authority',
      request: {
        objectId,
        objectKind,
        toAccountId: null,
        reason: 'release',
        expectedSequence: this.authority.sequenceFor(objectId),
        leaseSeconds: 1,
      },
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Presence, chat, moderation, voice                                        */
  /* ----------------------------------------------------------------------- */

  /**
   * Tell the fire where you are.
   *
   * Presence is lossy on purpose: it moves a silhouette and feeds the audio
   * panner, and nothing about it is replayed. It is not on the input timeline
   * and never will be — a 60 Hz position stream per player is precisely the
   * bandwidth ADR-0006 exists to avoid.
   */
  reportPresence(update: {
    position: Vec3;
    facingY: number;
    activity: Presence['activity'];
    micMuted: boolean;
  }): void {
    if (!this.joined || this.transport === null) return;
    const now = this.now();
    if (now - this.lastPresenceSendMs < 1000 / PRESENCE_SEND_HZ) return;
    this.lastPresenceSendMs = now;
    this.transport.send({
      t: 'presence',
      presence: {
        connection: 'connected',
        position: { x: update.position.x, y: update.position.y, z: update.position.z },
        facingY: clampAngle(update.facingY),
        activity: update.activity,
        micMuted: update.micMuted,
      },
    });
  }

  say(text: string): boolean {
    const trimmed = text.trim().slice(0, 280);
    if (trimmed.length === 0) return false;
    if (!this.joined || this.transport === null) return false;
    const seq = this.transport.send({ t: 'chat', text: trimmed });
    if (seq === null) return false;
    this.chat.push({ from: this.accountId ?? '', name: 'you', text: trimmed, at: this.now(), mine: true });
    if (this.chat.length > 80) this.chat.shift();
    this.options.onChange?.();
    return true;
  }

  /**
   * Block somebody.
   *
   * The server stops relaying their inputs in either direction, which is a
   * wall rather than a filter — and which means the two of you are no longer
   * watching the same fire. That is the honest cost of the anti-grief rule and
   * the interface says so rather than pretending otherwise; see
   * `SharedTimeline.divergenceNotes`.
   */
  block(accountId: string, blocked = true): void {
    if (!this.joined || this.transport === null) return;
    this.transport.send(blocked ? { t: 'block', accountId } : { t: 'unblock', accountId });
    this.roster.setBlocked(accountId, blocked);
    this.voice.setBlocked(accountId, blocked);
    if (blocked) this.timeline?.mutedByBlock.add(accountId);
    else this.timeline?.mutedByBlock.delete(accountId);
    this.options.onChange?.();
  }

  requestVoice(op: 'join' | 'refresh' | 'set_mode' | 'set_muted' | 'set_volume' | 'leave', extra: {
    mode?: 'open_mic' | 'push_to_talk' | 'off';
    muted?: boolean;
    accountId?: string;
    volume?: number;
  } = {}): void {
    if (!this.joined || this.transport === null) return;
    this.transport.send({ t: 'voice', op, ...extra });
    if (extra.mode !== undefined) this.voice.mode = extra.mode;
    if (extra.muted !== undefined) this.voice.muted = extra.muted;
    if (extra.accountId !== undefined && extra.volume !== undefined) {
      this.voice.setVolume(extra.accountId, extra.volume);
      this.roster.setVolume(extra.accountId, extra.volume);
    }
    this.options.onChange?.();
  }

  /** Walk off down the trail. */
  depart(manner: 'walk_off' | 'immediate' = 'walk_off'): void {
    this.transport?.depart(manner);
  }

  dispose(): void {
    if (this.pingTimer !== null) clearInterval(this.pingTimer);
    this.pingTimer = null;
    this.voice.dispose();
    this.transport?.dispose();
    this.transport = null;
  }
}

/* -------------------------------------------------------------------------- */
/* Simulation vocabulary → wire vocabulary                                     */
/* -------------------------------------------------------------------------- */

function toTendFireAction(action: FireAction): TendFireAction | null {
  switch (action.type) {
    case 'add-log':
      return { action: 'add_log', woodId: action.woodId, placement: action.placement ?? 0.6 };
    case 'rake':
      return { action: 'rake' };
    case 'fan':
      return { action: 'fan', strength: action.strength ?? 1 };
    default:
      return null;
  }
}

function toMachineControl(action: MachineAction): { control: MachineControl; program?: MachineDialProgram } | null {
  switch (action.type) {
    case 'load':
      return { control: 'load' };
    case 'close-door':
      return { control: 'close_door' };
    case 'engage-latch':
      return { control: 'engage_latch' };
    case 'set-program':
      return { control: 'set_program', program: action.program };
    case 'confirm':
      return { control: 'confirm' };
    case 'pull-lever':
      return { control: 'pull_lever' };
    case 'release-latch':
      return { control: 'release_latch' };
    case 'open-door':
      return { control: 'open_door' };
    case 'take-sandwich':
      return { control: 'take_sandwich' };
    case 'reset':
      return { control: 'reset' };
    default:
      return null;
  }
}

/** Intents that move the ritual from one stage to another. */
function changesStage(intent: InputIntent): boolean {
  switch (intent.kind) {
    case 'begin_roast':
    case 'finish_roast':
    case 'hold_component':
    case 'place_component':
    case 'machine_control':
    case 'tend_fire':
      return true;
    default:
      return false;
  }
}

function describeGesture(gesture: Gesture): string {
  switch (gesture) {
    case 'wave':
      return 'waves';
    case 'high_five':
      return 'holds a hand up';
    case 'fist_bump':
      return 'offers a fist';
    case 'sit':
      return 'sits down';
    case 'stand':
      return 'stands up';
    case 'point':
      return 'points';
    case 'applaud':
      return 'claps';
    case 'toss_stick':
      return 'tosses a stick on the fire';
    case 'offer_food':
      return 'offers you something';
    case 'photograph':
      return 'takes a photograph';
    default:
      return 'gestures';
  }
}

function clampAngle(radians: number): number {
  const limit = Math.PI * 2;
  if (!Number.isFinite(radians)) return 0;
  return Math.max(-limit, Math.min(limit, radians));
}
