/**
 * The shared timeline: ordering, reconciliation, and the honest limits of both.
 *
 * This is the piece ADR-0006 actually rests on. The server stamps every
 * accepted intent with `(tick, serverSeq)` and relays it; every client replays
 * that stream against the campsite seed and arrives at the same world. What
 * follows is the reasoning that makes that true here rather than merely
 * plausible.
 *
 * ## Why no interpolation buffer, and why no rollback
 *
 * The obvious design is a jitter buffer: run the simulation N ticks behind the
 * server and hope every input arrives before its tick comes round, then roll
 * back and re-simulate the ones that do not. That needs a snapshot of the
 * world per tick, which for a 32-patch marshmallow plus a fire plus a weather
 * model is real allocation in the hot path (ARCHITECTURE §10 forbids it), and
 * it needs a guess at N.
 *
 * None of that is necessary, because the server hands us an exact safety rule
 * for free:
 *
 *  - Every message the room emits — `input`, `ack`, `authority`, `presence`,
 *    `arrival`, `departure`, `chat`, `snapshot` — is produced inside the
 *    room's serialised queue, so they leave the server in the same total order
 *    the inputs were stamped in, on one socket, over TCP.
 *  - Therefore **receiving any room message carrying tick T proves that every
 *    input with a tick below T has already been sent to us.**
 *
 * So the simulation advances to `safeTick` and no further, and an input can
 * never arrive for a tick that has already been stepped. No buffer to tune, no
 * rollback to pay for, and the ordering is the server's rather than a guess.
 * `lateInputs` counts violations of that rule; it should be, and in the tests
 * is, exactly zero. If it is ever not zero we say so rather than quietly
 * diverging.
 *
 * `pong` and transport-level `error` are deliberately *not* trusted for the
 * safe tick: they are answered outside the room's queue and can overtake a
 * pending relay.
 *
 * ## Local prediction
 *
 * Your own input is applied on the tick the server *acked*, exactly like
 * everybody else's — the simulation never runs ahead of the timeline, so it
 * cannot be wrong about it. What is predicted is the *picture*: after the step,
 * the marshmallow you are holding is drawn where your hand is rather than where
 * the last acknowledged intent put it (see `predict`). That write is cosmetic
 * — `stepRoast` overwrites the position from `roastInput` at the top of every
 * step — so the heat model is untouched and the response is immediate.
 *
 * The trade is real and worth stating: the thermal consequence of a movement
 * lands one round trip after the movement is seen. Browning is a 45-second
 * variable, so 60 ms of lag in the heat integral is invisible; 60 ms of lag in
 * the visible position of your own hand is not.
 *
 * ## What is not convergeable
 *
 * See `divergenceNotes()`. In short: the ritual core (fire, marshmallow,
 * assembly, machine) converges exactly. The world systems — wildlife, secrets,
 * radio reception, the sky — are driven by `PresenceInput`, which is each
 * client's own observation of its own player and is deliberately not on the
 * input wire. Those are yours, not the campsite's.
 */

import {
  SIM_DT,
  createRitual,
  stepRitual,
  type RitualOptions,
  type RitualState,
} from '@somemore/sim';
import { compareStampedInputs, type StampedInput } from '@somemore/protocol';
import { applyIntent } from './replication.js';

/**
 * How many simulation steps one frame may spend catching up.
 *
 * `stepRitual` measures at 0.01–0.02 ms per step (`artifacts/perf/sim-bench`),
 * and ARCHITECTURE §10 gives simulation 1.5 ms of a frame, so ninety steps is
 * the whole budget and no more. It is the multiplayer analogue of `time.ts`'s
 * `MAX_CATCH_UP_SECONDS`: the same spiral-of-death guard, expressed in ticks
 * we owe the server rather than in seconds of wall clock we missed.
 */
export const CATCH_UP_STEPS_PER_FRAME = 90;

/**
 * Past this backlog we stop trickling and catch up in one go.
 *
 * A tab restored after a minute in the background owes 3,600 ticks. Trickling
 * ninety a frame would take forty frames of watching a fire that is visibly in
 * the past; draining it in one call costs about 60 ms and puts you back at the
 * real fire immediately. `catchingUp` is exposed so the interface can say what
 * is happening rather than appear to hang.
 */
export const BULK_CATCH_UP_TICKS = 600;

/** Ceiling on a single bulk drain, so a pathological backlog cannot lock the tab. */
export const MAX_BULK_STEPS = 120_000;

/** A prediction of where the local player's own hands are, this frame. */
export interface HandPrediction {
  /** The marshmallow, when the local player is driving it. */
  marshmallow?: { position: { x: number; y: number; z: number }; rotation: number } | null;
  /** The held assembly component's offset, when the local player is placing it. */
  component?: { offset: { x: number; y: number; z: number }; rotation: number } | null;
}

export interface TimelineOptions {
  /** The campsite seed from the snapshot. Numeric, exactly as the server sent it. */
  readonly seed: number;
  readonly environmentId: string;
  /**
   * Extra simulation options.
   *
   * Every value here must be identical on every client or the world is not
   * reconstructable, so callers pass things derived from the session (the
   * origin timestamp) or from the environment id, never from local settings.
   * Accessibility assists are the interesting exclusion: `autoRotate` is
   * folded into the outgoing rotation by whoever is holding the stick, and
   * `assemblyAssist` travels on the wire with `hold_component`.
   */
  readonly ritualOptions?: Omit<RitualOptions, 'campsiteSeed' | 'environmentId' | 'assemblyAssist' | 'autoRotate'>;
}

export class SharedTimeline {
  private options: TimelineOptions;
  private queue: StampedInput[] = [];

  /** The world every client agrees on. Driven only by the replicated stream. */
  ritual: RitualState;

  /** Steps taken. Equal to the session tick this world has been advanced to. */
  appliedTick = 0;

  /**
   * The highest tick proved to be fully delivered. See the note at the top:
   * only room-ordered messages may raise this.
   */
  safeTick = 0;

  /** True while a bulk drain is outstanding. */
  catchingUp = false;

  /** History was trimmed server-side; reconstruction is no longer exact. */
  truncated = false;

  /**
   * Inputs that arrived for a tick already stepped.
   *
   * Should always be zero. A non-zero value means the ordering guarantee this
   * class is built on has been violated, and the world has silently diverged —
   * so it is counted and surfaced rather than swallowed.
   */
  lateInputs = 0;

  /** Accounts whose inputs the server is not relaying to us, because of a block. */
  readonly mutedByBlock = new Set<string>();

  constructor(options: TimelineOptions) {
    this.options = options;
    this.ritual = this.build();
  }

  private build(): RitualState {
    return createRitual({
      ...this.options.ritualOptions,
      campsiteSeed: this.options.seed,
      environmentId: this.options.environmentId,
      // Pinned, not taken from settings: both are per-player accessibility
      // dials and both change what the simulation does, so a shared world has
      // to get them from the wire instead. See `replication.ts`.
      assemblyAssist: 0.5,
      autoRotate: 0,
    });
  }

  get backlog(): number {
    return Math.max(0, this.safeTick - this.appliedTick);
  }

  /** Inputs known but not yet due. */
  get pending(): number {
    return this.queue.length;
  }

  /**
   * Note the tick carried by a room-ordered server message.
   *
   * Never call this with a `pong` or a transport `error`: those are answered
   * outside the room's serialised queue and can overtake a relay that was
   * stamped earlier, which would let the simulation step past an input that is
   * still in flight.
   */
  observe(tick: number): void {
    if (Number.isFinite(tick) && tick > this.safeTick) this.safeTick = tick;
  }

  /** Queue replicated inputs. Ordering is by `(tick, serverSeq)`, always. */
  enqueue(...inputs: readonly StampedInput[]): void {
    if (inputs.length === 0) return;
    for (const input of inputs) {
      if (input.tick < this.appliedTick) this.lateInputs += 1;
      this.queue.push(input);
    }
    this.queue.sort(compareStampedInputs);
    const last = this.queue[this.queue.length - 1];
    if (last !== undefined) this.observe(last.tick);
  }

  /**
   * Start again from a snapshot: seed, environment, and the ordered history.
   *
   * This is the late-joiner path and the reconnect path, and it is the whole of
   * ADR-0006's claim in one method — a world rebuilt from a number and a list
   * of intents, with not one patch temperature having crossed the wire.
   *
   * `fromTick > 0` means the server was asked to resume rather than replay, so
   * the world we already have is kept and only the gap is filled.
   */
  reset(snapshot: {
    seed: number;
    environmentId: string;
    fromTick: number;
    inputs: readonly StampedInput[];
    tick: number;
    truncated: boolean;
  }): void {
    this.truncated = this.truncated || snapshot.truncated;
    const resuming = snapshot.fromTick > 0 && snapshot.seed === this.options.seed && this.appliedTick > 0;
    if (!resuming) {
      this.options = { ...this.options, seed: snapshot.seed, environmentId: snapshot.environmentId };
      this.ritual = this.build();
      this.appliedTick = 0;
      this.queue = [];
      this.lateInputs = 0;
    } else {
      // Anything at or past the resume point is about to be re-delivered.
      this.queue = this.queue.filter((input) => input.tick < snapshot.fromTick);
    }
    this.enqueue(...snapshot.inputs);
    this.observe(snapshot.tick);
  }

  /**
   * Advance toward `safeTick`, applying each input on the tick it belongs to.
   *
   * Returns the number of steps taken. The loop is the same one the server's
   * replay harness runs, deliberately: inputs for tick T are applied *before*
   * the T-th step, so "the tick an intent landed on" means the same thing on
   * both sides of the wire.
   *
   * `allowBulk` is off when this is called from inside the render loop's own
   * fixed-step callback, which can run up to sixteen times in one frame after
   * a stall — sixteen bulk drains in a single frame would be the spiral of
   * death `time.ts` exists to prevent, wearing a different hat. The one caller
   * that does want a bulk drain is the snapshot, which happens off-frame while
   * the player is still walking in.
   */
  pump(maxSteps = CATCH_UP_STEPS_PER_FRAME, allowBulk = true): number {
    const backlog = this.backlog;
    if (backlog <= 0) {
      this.catchingUp = false;
      return 0;
    }
    const bulk = allowBulk && backlog > BULK_CATCH_UP_TICKS;
    const budget = bulk ? Math.min(backlog, MAX_BULK_STEPS) : Math.min(backlog, maxSteps);
    this.catchingUp = backlog > BULK_CATCH_UP_TICKS;

    let steps = 0;
    while (steps < budget && this.appliedTick < this.safeTick) {
      while (this.queue.length > 0 && (this.queue[0] as StampedInput).tick <= this.appliedTick) {
        applyIntent(this.ritual, (this.queue.shift() as StampedInput).intent);
      }
      stepRitual(this.ritual, SIM_DT);
      this.appliedTick += 1;
      steps += 1;
    }
    if (this.backlog <= BULK_CATCH_UP_TICKS) this.catchingUp = false;
    return steps;
  }

  /**
   * Draw the local player's own hands where they actually are.
   *
   * Purely cosmetic, and only ever called after `pump`: `stepRoast` and
   * `stepAssembly` re-read their inputs at the top of the next step, so
   * nothing written here reaches the thermal model or the assembly record. It
   * exists so that moving your own marshmallow is visible in the same frame
   * you moved it, which ARCHITECTURE §10 requires and a round trip cannot
   * deliver.
   */
  predict(hands: HandPrediction): void {
    const marshmallow = hands.marshmallow;
    if (marshmallow) {
      this.ritual.marshmallow.position.x = marshmallow.position.x;
      this.ritual.marshmallow.position.y = marshmallow.position.y;
      this.ritual.marshmallow.position.z = marshmallow.position.z;
      this.ritual.marshmallow.rotation = marshmallow.rotation;
    }
    const component = hands.component;
    if (component && this.ritual.assembly.heldKind !== null) {
      this.ritual.assembly.heldOffset.x = component.offset.x;
      this.ritual.assembly.heldOffset.y = component.offset.y;
      this.ritual.assembly.heldOffset.z = component.offset.z;
      this.ritual.assembly.heldRotation = component.rotation;
    }
  }

  /**
   * What this session cannot promise, in the words the interface should use.
   *
   * Kept here rather than in the UI because these are properties of the
   * replication model, and a client that quietly diverged while claiming to be
   * in sync would be the worst possible outcome of ADR-0006.
   */
  divergenceNotes(): string[] {
    const notes: string[] = [];
    if (this.truncated) {
      notes.push(
        'This fire has been burning longer than the campsite remembers, so what you are looking at is close but not exact.',
      );
    }
    if (this.mutedByBlock.size > 0) {
      notes.push(
        'Somebody here is blocked, so nothing they do reaches this fire. You are no longer watching quite the same fire they are.',
      );
    }
    if (this.lateInputs > 0) {
      notes.push(`${this.lateInputs} thing(s) arrived after their moment had passed, and were not applied.`);
    }
    return notes;
  }
}
