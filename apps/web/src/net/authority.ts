/**
 * Who is holding what, and how a thing gets passed from one hand to another.
 *
 * The server owns this — leases, a fencing sequence, an anti-snatch rule — and
 * the client's job is threefold:
 *
 *  1. **Predict.** `realtimeAuthorityDenial` is a pure function shared by both
 *     sides, so the interface can grey out "take the stick" instead of
 *     offering it and being refused. The protocol went to the trouble of
 *     making the rule shareable; not using it would be the client's fault.
 *  2. **Carry the pass.** A hand-off is granted with a `mutualHoldUntilTick`
 *     during which *both* players may drive the object. That window is why a
 *     roasting stick can change hands without teleporting, and rendering it is
 *     this file's real reason to exist: `handoffProgress` is the 0..1 the
 *     scene interpolates the stick along, from one person's hand to the
 *     other's.
 *  3. **Say no in words.** A denial is a sentence about the fire ("it is in
 *     their hands"), never an error code, and never a modal.
 */

import {
  DEFAULT_MUTUAL_HOLD_TICKS,
  authorizedDrivers,
  isAuthorityExpired,
  realtimeAuthorityDenial,
  type AuthorityDenialReason,
  type AuthorityHandoffReason,
  type AuthorityObjectKind,
  type AuthorityRecord,
  type SessionState,
} from '@somemore/protocol';

/** The marshmallow every campsite starts with. Shared with the server's tests. */
export const MARSHMALLOW_OBJECT_ID = 'obj_marshmallow_1';
export const SM01_OBJECT_ID = 'obj_sm01_1';

export interface MutualHold {
  readonly objectId: string;
  readonly fromAccountId: string;
  readonly toAccountId: string;
  readonly untilTick: number;
  readonly startedTick: number;
}

/** Something a person is offering to somebody else, awaiting an answer. */
export interface PendingOffer {
  readonly objectId: string;
  readonly objectKind: AuthorityObjectKind;
  readonly toAccountId: string;
  readonly seq: number;
  readonly at: number;
}

export class AuthorityTable {
  private readonly records = new Map<string, AuthorityRecord>();
  private readonly holds = new Map<string, MutualHold>();
  private readonly offers = new Map<number, PendingOffer>();

  /** The most recent refusal, in words, for the interface to show quietly. */
  lastDenial: { objectId: string; reason: AuthorityDenialReason; line: string } | null = null;

  /**
   * The last hand-off seen, kept after its window closes.
   *
   * `holds` is swept the moment the mutual hold expires, which is right — it
   * is what `drivers` reads. But a pass is a *quarter of a second*, and both
   * the interface ("it was passed to you") and anything inspecting the fire
   * afterwards need to know it happened without having been watching at that
   * exact instant.
   */
  lastHold: MutualHold | null = null;

  constructor(
    private readonly self: () => string,
    private readonly sessionState: () => SessionState,
    private readonly isHost: () => boolean,
    private readonly present: () => readonly string[],
    private readonly nowIso: () => string,
  ) {}

  get all(): readonly AuthorityRecord[] {
    return [...this.records.values()];
  }

  record(objectId: string): AuthorityRecord | null {
    return this.records.get(objectId) ?? null;
  }

  holderOf(objectId: string): string | null {
    const record = this.records.get(objectId);
    if (record === undefined) return null;
    return isAuthorityExpired(record, this.nowIso()) ? null : record.holderAccountId;
  }

  /** The fencing sequence to present with the next request for this object. */
  sequenceFor(objectId: string): number {
    return this.records.get(objectId)?.sequence ?? 0;
  }

  hold(objectId: string): MutualHold | null {
    return this.holds.get(objectId) ?? null;
  }

  /**
   * Who may drive this object on this tick — the holder, plus both parties to
   * a hand-off while the mutual-hold window is open.
   */
  drivers(objectId: string, tick: number): readonly string[] {
    const record = this.records.get(objectId);
    if (record === undefined) return [];
    const held = this.holds.get(objectId);
    return authorizedDrivers(
      record,
      held === undefined ? null : { fromAccountId: held.fromAccountId, toAccountId: held.toAccountId, untilTick: held.untilTick },
      tick,
    );
  }

  canDrive(objectId: string, tick: number): boolean {
    return this.drivers(objectId, tick).includes(this.self());
  }

  /**
   * How far through the pass this object is, 0..1, or `null` when it is not
   * being passed. The scene interpolates the object along this rather than
   * snapping it to the new holder's hand.
   */
  handoffProgress(objectId: string, tick: number): number | null {
    const held = this.holds.get(objectId);
    if (held === undefined) return null;
    const span = held.untilTick - held.startedTick;
    if (span <= 0) return tick >= held.untilTick ? null : 0;
    const t = (tick - held.startedTick) / span;
    if (t >= 1) return null;
    return t < 0 ? 0 : t;
  }

  /**
   * Would the server refuse this, if we asked right now?
   *
   * The same function the server enforces with. `null` means it would be
   * granted, so the control can be offered.
   */
  wouldDeny(input: {
    objectId: string;
    objectKind: AuthorityObjectKind;
    reason: AuthorityHandoffReason;
    toAccountId: string | null;
  }): AuthorityDenialReason | null {
    const nowIso = this.nowIso();
    const stored = this.records.get(input.objectId) ?? this.blank(input.objectId, input.objectKind);
    /*
     * A lapsed lease is as good as unheld (ARCHITECTURE §6), and the server
     * makes that literally true before it decides: `SessionRoom` performs an
     * explicit `timeout` hand-off on the old holder's behalf and *then*
     * evaluates. Predicting against the stored record instead would grey out a
     * control that the server would in fact grant — the client would be
     * refusing on the server's behalf, which is exactly the mistake sharing the
     * rule was supposed to prevent. The sequence is carried forward because
     * the server carries it forward too.
     */
    const record =
      stored.holderAccountId !== null && isAuthorityExpired(stored, nowIso)
        ? { ...stored, holderAccountId: null, expiresAt: null }
        : stored;
    return realtimeAuthorityDenial({
      record,
      requesterAccountId: this.self(),
      request: { expectedSequence: record.sequence, reason: input.reason, toAccountId: input.toAccountId },
      requesterIsHost: this.isHost(),
      requesterIsMember: true,
      targetIsPresent: input.toAccountId === null || this.present().includes(input.toAccountId),
      sessionState: this.sessionState(),
      nowIso,
    });
  }

  private blank(objectId: string, objectKind: AuthorityObjectKind): AuthorityRecord {
    return {
      sessionId: '',
      objectId,
      objectKind,
      holderAccountId: null,
      grantedAt: this.nowIso(),
      expiresAt: null,
      sequence: 0,
      locked: false,
    };
  }

  /** A grant, however it came about. */
  applyGrant(
    tick: number,
    record: AuthorityRecord,
    mutualHoldUntilTick: number | null,
    mutualHolders: readonly string[],
  ): void {
    this.records.set(record.objectId, record);
    const [from, to] = mutualHolders;
    if (mutualHoldUntilTick !== null && from !== undefined && to !== undefined) {
      const hold: MutualHold = {
        objectId: record.objectId,
        fromAccountId: from,
        toAccountId: to,
        untilTick: mutualHoldUntilTick,
        startedTick: Math.max(0, mutualHoldUntilTick - DEFAULT_MUTUAL_HOLD_TICKS),
      };
      this.holds.set(record.objectId, hold);
      this.lastHold = hold;
    } else {
      this.holds.delete(record.objectId);
    }
    for (const [seq, offer] of [...this.offers]) {
      if (offer.objectId === record.objectId) this.offers.delete(seq);
    }
  }

  applyExpiry(record: AuthorityRecord): void {
    this.records.set(record.objectId, record);
    this.holds.delete(record.objectId);
  }

  /** Somebody left; everything they held is back in the world. */
  releaseAllHeldBy(accountId: string, objectIds: readonly string[]): void {
    for (const objectId of objectIds) {
      const record = this.records.get(objectId);
      if (record === undefined || record.holderAccountId !== accountId) continue;
      this.records.set(objectId, { ...record, holderAccountId: null, expiresAt: null });
      this.holds.delete(objectId);
    }
  }

  noteOffer(offer: PendingOffer): void {
    this.offers.set(offer.seq, offer);
  }

  offerFor(seq: number): PendingOffer | null {
    return this.offers.get(seq) ?? null;
  }

  applyDenial(seq: number, reason: AuthorityDenialReason, current: AuthorityRecord, nameOf: (id: string) => string): void {
    this.records.set(current.objectId, current);
    this.offers.delete(seq);
    this.lastDenial = { objectId: current.objectId, reason, line: denialLine(reason, current, nameOf) };
  }

  /** Drop expired mutual holds. Cheap; called once a frame. */
  sweep(tick: number): void {
    for (const [objectId, held] of [...this.holds]) {
      if (tick > held.untilTick) this.holds.delete(objectId);
    }
  }
}

/**
 * A refusal, said the way a person at a campfire would say it.
 *
 * Spec §12: nothing arrives through one channel only, so these lines are what
 * the subtitle layer reads as well as what the panel prints.
 */
export function denialLine(
  reason: AuthorityDenialReason,
  record: AuthorityRecord,
  nameOf: (accountId: string) => string,
): string {
  const holder = record.holderAccountId === null ? 'someone' : nameOf(record.holderAccountId);
  switch (reason) {
    case 'not_holder':
      return `[it is in ${holder}'s hands]`;
    case 'sequence_stale':
      return '[somebody got there first]';
    case 'object_locked':
      return '[the machine is mid-run — leave it be]';
    case 'target_not_present':
      return '[they are not at the fire any more]';
    case 'session_not_active':
      return '[this fire has been banked]';
    case 'not_a_member':
      return '[this is not your campsite]';
    default:
      return '[not just now]';
  }
}
