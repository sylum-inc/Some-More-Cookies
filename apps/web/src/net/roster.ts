/**
 * The other people at the fire.
 *
 * Joining is lobby-less and diegetic (spec §9), and the protocol already went
 * to the trouble of modelling that properly: an `arrival` carries a path down
 * the trail with waypoints, a duration, a sound, a style, and the moment the
 * silhouette becomes legible; a `departure` carries the reverse and a glance
 * back. Nothing here invents any of that — it turns those numbers into a
 * position, a phase and a line of text, once per frame, allocating nothing.
 *
 * Two decisions worth writing down:
 *
 *  - **Names are derived, not sent.** There is no display name anywhere on
 *    this wire — `Participant` carries an account id and a role and that is
 *    all. Rather than print an opaque id over somebody's head, each account is
 *    given a stable camp name derived from its id, so every client calls the
 *    same person the same thing without a byte of extra protocol. It is also
 *    the right register: this is a campsite, not a lobby.
 *
 *  - **Positions are smoothed, never extrapolated.** Presence arrives at a
 *    handful of hertz. Extrapolating a walking figure means overshooting and
 *    snapping back every time somebody stops, which reads as teleporting. An
 *    exponential approach toward the last reported position is a person who is
 *    slightly behind rather than a person who is wrong.
 */

import { REALTIME_TICK_MS, type ArrivalPath, type DeparturePath, type Participant, type Presence } from '@somemore/protocol';

export type RemotePhase = 'approaching' | 'here' | 'leaving' | 'gone';

export interface RemotePlayer {
  readonly accountId: string;
  /** A stable camp name derived from the account id. */
  readonly name: string;
  phase: RemotePhase;
  role: Participant['role'];
  activity: Presence['activity'];
  micMuted: boolean;
  speaking: boolean;
  /** Where they are, smoothed. */
  readonly position: { x: number; y: number; z: number };
  /** Where the network last said they were. */
  readonly target: { x: number; y: number; z: number };
  facingY: number;
  targetFacingY: number;
  /** Metres per second, derived from how far the smoothed position moved. */
  speed: number;
  /** The walk in, while it is happening. */
  arrival: ArrivalPath | null;
  arrivalTick: number;
  /** The walk out. */
  departure: DeparturePath | null;
  departureTick: number;
  /** 0..1 through whichever walk is playing, or 1 when settled. */
  walkProgress: number;
  /** 0..1 how legible the silhouette is. Below 1 they are a shape in the trees. */
  legibility: number;
  /** Whether they are showing a light on the trail. */
  flashlight: boolean;
  /** They are carrying the campsite's torch. Driven by `move_prop`. */
  carryingTorch: boolean;
  /** Blocked by us: present in the roster, absent from the world. */
  blocked: boolean;
  /** Per-listener voice volume, 0..1. */
  volume: number;
}

const CAMP_FIRST = [
  'Quiet',
  'Long',
  'Pine',
  'Ash',
  'Birch',
  'Cedar',
  'Fern',
  'Moss',
  'Slate',
  'Hollow',
  'Amber',
  'Still',
  'Low',
  'North',
  'Cinder',
  'Willow',
] as const;

const CAMP_SECOND = [
  'Creek',
  'Hollow',
  'Ridge',
  'Ember',
  'Lantern',
  'Kettle',
  'Marten',
  'Thistle',
  'Barrow',
  'Beck',
  'Cairn',
  'Larch',
  'Heron',
  'Wren',
  'Pike',
  'Otter',
] as const;

function hash32(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * A stable, quiet name for an account id.
 *
 * Deterministic, so everyone at the fire — including the person themself —
 * sees the same two words. Two campers can collide; that is a real thing that
 * happens at a campground and costs nothing here.
 */
export function campName(accountId: string): string {
  const h = hash32(accountId);
  const first = CAMP_FIRST[h % CAMP_FIRST.length] ?? 'Quiet';
  const second = CAMP_SECOND[(h >>> 8) % CAMP_SECOND.length] ?? 'Creek';
  return `${first} ${second}`;
}

/** Position along a polyline of waypoints, 0..1. Allocation-free. */
export function walkAlong(
  waypoints: readonly { x: number; y: number; z: number }[],
  t: number,
  out: { x: number; y: number; z: number },
): { x: number; y: number; z: number } {
  const count = waypoints.length;
  if (count === 0) return out;
  const first = waypoints[0] as { x: number; y: number; z: number };
  if (count === 1 || t <= 0) {
    out.x = first.x;
    out.y = first.y;
    out.z = first.z;
    return out;
  }
  const last = waypoints[count - 1] as { x: number; y: number; z: number };
  if (t >= 1) {
    out.x = last.x;
    out.y = last.y;
    out.z = last.z;
    return out;
  }
  const scaled = t * (count - 1);
  const index = Math.min(count - 2, Math.floor(scaled));
  const local = scaled - index;
  const a = waypoints[index] as { x: number; y: number; z: number };
  const b = waypoints[index + 1] as { x: number; y: number; z: number };
  out.x = a.x + (b.x - a.x) * local;
  out.y = a.y + (b.y - a.y) * local;
  out.z = a.z + (b.z - a.z) * local;
  return out;
}

function createPlayer(accountId: string, role: Participant['role']): RemotePlayer {
  return {
    accountId,
    name: campName(accountId),
    phase: 'approaching',
    role,
    activity: 'idle',
    micMuted: true,
    speaking: false,
    position: { x: 0, y: 0, z: 0 },
    target: { x: 0, y: 0, z: 0 },
    facingY: 0,
    targetFacingY: 0,
    speed: 0,
    arrival: null,
    arrivalTick: 0,
    departure: null,
    departureTick: 0,
    walkProgress: 1,
    legibility: 1,
    flashlight: false,
    carryingTorch: false,
    blocked: false,
    volume: 1,
  };
}

/**
 * Everybody who is here, coming, or going.
 *
 * The roster is presentation state, not simulation state: nothing in it is
 * replayed, nothing in it affects the ritual, and losing it costs a picture
 * rather than a world. That separation is what lets presence be lossy.
 */
export class Roster {
  private readonly players = new Map<string, RemotePlayer>();
  private readonly scratch = { x: 0, y: 0, z: 0 };

  /** Lines the subtitle layer should say. Drained by the caller. */
  readonly announcements: string[] = [];

  constructor(private readonly selfAccountId: () => string) {}

  get everyone(): readonly RemotePlayer[] {
    return [...this.players.values()];
  }

  /** Everyone visible in the world right now, blocked people excluded. */
  get visible(): readonly RemotePlayer[] {
    const out: RemotePlayer[] = [];
    for (const player of this.players.values()) {
      if (player.phase !== 'gone' && !player.blocked) out.push(player);
    }
    return out;
  }

  get presentAccountIds(): readonly string[] {
    const out: string[] = [];
    for (const player of this.players.values()) if (player.phase !== 'gone') out.push(player.accountId);
    return out;
  }

  get(accountId: string): RemotePlayer | null {
    return this.players.get(accountId) ?? null;
  }

  nameOf(accountId: string): string {
    return this.players.get(accountId)?.name ?? campName(accountId);
  }

  clear(): void {
    this.players.clear();
  }

  /** From a snapshot: everybody already here, mid-walk or settled. */
  seed(participants: readonly Participant[], tick: number): void {
    const self = this.selfAccountId();
    for (const participant of participants) {
      if (participant.accountId === self) continue;
      const player = this.ensure(participant.accountId, participant.role);
      player.role = participant.role;
      player.activity = participant.presence.activity;
      player.micMuted = participant.presence.micMuted;
      player.arrival = participant.arrival;
      player.arrivalTick = participant.joinedAtTick;
      player.phase = participant.settled || participant.arrival === null ? 'here' : 'approaching';
      const position = participant.presence.position;
      if (position !== null) {
        player.target.x = position.x;
        player.target.y = position.y;
        player.target.z = position.z;
        player.position.x = position.x;
        player.position.y = position.y;
        player.position.z = position.z;
      } else if (participant.arrival !== null) {
        walkAlong(participant.arrival.waypoints, this.arrivalProgress(participant.arrival, participant.joinedAtTick, tick), player.position);
        player.target.x = player.position.x;
        player.target.y = player.position.y;
        player.target.z = player.position.z;
      }
      player.targetFacingY = participant.presence.facingY;
      player.facingY = participant.presence.facingY;
    }
  }

  private ensure(accountId: string, role: Participant['role']): RemotePlayer {
    const existing = this.players.get(accountId);
    if (existing !== undefined) return existing;
    const created = createPlayer(accountId, role);
    this.players.set(accountId, created);
    return created;
  }

  private arrivalProgress(path: ArrivalPath, fromTick: number, tick: number): number {
    const ticks = Math.max(1, path.durationMs / REALTIME_TICK_MS);
    return Math.max(0, Math.min(1, (tick - fromTick) / ticks));
  }

  /** Footsteps on the trail. */
  arrive(participant: Participant, path: ArrivalPath, tick: number): void {
    if (participant.accountId === this.selfAccountId()) return;
    const player = this.ensure(participant.accountId, participant.role);
    player.role = participant.role;
    player.phase = 'approaching';
    player.arrival = path;
    player.arrivalTick = tick;
    player.departure = null;
    player.walkProgress = 0;
    player.legibility = 0;
    player.flashlight = path.flashlight;
    walkAlong(path.waypoints, 0, player.position);
    player.target.x = player.position.x;
    player.target.y = player.position.y;
    player.target.z = player.position.z;
    // §12: an approach that is only a sound is inaccessible, and one that is
    // only a shape in the dark is easy to miss. It gets both.
    this.announcements.push(`[${player.name} is coming down the trail]`);
  }

  depart(accountId: string, manner: 'walk_off' | 'immediate' | 'dropped', path: DeparturePath | null, tick: number): void {
    const player = this.players.get(accountId);
    if (player === undefined) return;
    if (manner === 'walk_off' && path !== null) {
      player.phase = 'leaving';
      player.departure = path;
      player.departureTick = tick;
      player.walkProgress = 0;
      this.announcements.push(`[${player.name} heads off up the trail]`);
    } else {
      player.phase = 'gone';
      this.announcements.push(
        manner === 'dropped' ? `[${player.name} dropped out]` : `[${player.name} has gone]`,
      );
    }
  }

  presence(presence: Presence): void {
    if (presence.accountId === this.selfAccountId()) return;
    const player = this.ensure(presence.accountId, presence.role);
    player.role = presence.role;
    player.activity = presence.activity;
    player.micMuted = presence.micMuted;
    if (presence.position !== null) {
      player.target.x = presence.position.x;
      player.target.y = presence.position.y;
      player.target.z = presence.position.z;
      // The first position we ever hear is where they are, not somewhere to
      // walk from: without this they slide in from the origin, through the fire.
      if (player.phase === 'here' && player.walkProgress >= 1 && player.speed === 0 && isOrigin(player.position)) {
        player.position.x = presence.position.x;
        player.position.y = presence.position.y;
        player.position.z = presence.position.z;
      }
    }
    player.targetFacingY = presence.facingY;
    if (presence.connection === 'disconnected') player.phase = 'gone';
  }

  /** Somebody is moving the campsite's torch about, so they are holding it. */
  propMoved(accountId: string, objectId: string, position: { x: number; y: number; z: number }): void {
    const player = this.players.get(accountId);
    if (player === undefined) return;
    if (objectId.includes('torch')) {
      player.carryingTorch = true;
      // The torch is at their hand, so it is also a good position fix for them.
      player.target.x = position.x;
      player.target.z = position.z;
    }
  }

  setBlocked(accountId: string, blocked: boolean): void {
    const player = this.players.get(accountId);
    if (player !== undefined) player.blocked = blocked;
  }

  setVolume(accountId: string, volume: number): void {
    const player = this.players.get(accountId);
    if (player !== undefined) player.volume = Math.max(0, Math.min(1, volume));
  }

  setSpeaking(accountId: string, speaking: boolean): void {
    const player = this.players.get(accountId);
    if (player !== undefined) player.speaking = speaking;
  }

  /**
   * Advance every figure by one rendered frame.
   *
   * `tick` is the shared session tick, so the walks are driven by the same
   * clock the arrival was stamped with rather than by local wall time.
   */
  step(tick: number, dt: number, groundAt: (x: number, z: number) => number): void {
    for (const player of this.players.values()) {
      const before = { x: player.position.x, z: player.position.z };

      if (player.phase === 'approaching' && player.arrival !== null) {
        const path = player.arrival;
        const t = this.arrivalProgress(path, player.arrivalTick, tick);
        player.walkProgress = t;
        walkAlong(path.waypoints, t, this.scratch);
        player.position.x = this.scratch.x;
        player.position.z = this.scratch.z;
        player.target.x = this.scratch.x;
        player.target.z = this.scratch.z;
        const silhouetteT = Math.max(0, Math.min(1, path.silhouetteAtMs / Math.max(1, path.durationMs)));
        // A shape resolving out of the dark, not a fade-in: nothing at all
        // until the trees thin, then legible over the rest of the walk.
        player.legibility = t <= silhouetteT ? 0 : Math.min(1, (t - silhouetteT) / Math.max(0.05, 1 - silhouetteT));
        player.flashlight = path.flashlight && t < 0.92;
        if (t >= 1) {
          player.phase = 'here';
          player.legibility = 1;
          player.flashlight = false;
          this.announcements.push(`[${player.name} sits down by the fire]`);
        }
      } else if (player.phase === 'leaving' && player.departure !== null) {
        const path = player.departure;
        const ticks = Math.max(1, path.durationMs / REALTIME_TICK_MS);
        const t = Math.max(0, Math.min(1, (tick - player.departureTick) / ticks));
        player.walkProgress = t;
        walkAlong(path.waypoints, t, this.scratch);
        player.position.x = this.scratch.x;
        player.position.z = this.scratch.z;
        // The glance back: they turn to the fire around two thirds of the way.
        player.targetFacingY =
          path.glanceBack && t > 0.6 && t < 0.75
            ? Math.atan2(-player.position.z, -player.position.x)
            : Math.atan2(player.position.z - before.z, player.position.x - before.x);
        player.legibility = 1 - Math.max(0, (t - 0.55) / 0.45);
        if (t >= 1) {
          player.phase = 'gone';
          player.legibility = 0;
        }
      } else if (player.phase === 'here') {
        // Smoothed, never extrapolated. See the note at the top of the file.
        const k = 1 - Math.exp(-9 * dt);
        player.position.x += (player.target.x - player.position.x) * k;
        player.position.z += (player.target.z - player.position.z) * k;
        player.legibility = 1;
      }

      player.position.y = groundAt(player.position.x, player.position.z);

      const moved = Math.hypot(player.position.x - before.x, player.position.z - before.z);
      player.speed = dt > 0 ? moved / dt : 0;
      // Walking figures face the way they are going; standing ones face where
      // presence says. Facing the direction of travel is what stops a settled
      // player pivoting on the spot every time a packet lands.
      const wanted =
        player.speed > 0.25 ? Math.atan2(player.position.z - before.z, player.position.x - before.x) : player.targetFacingY;
      let delta = wanted - player.facingY;
      while (delta > Math.PI) delta -= Math.PI * 2;
      while (delta < -Math.PI) delta += Math.PI * 2;
      player.facingY += delta * (1 - Math.exp(-10 * dt));
    }

    // Nobody lingers in the roster once they are gone and their walk is over.
    for (const [accountId, player] of [...this.players]) {
      if (player.phase === 'gone' && player.legibility <= 0) this.players.delete(accountId);
    }
  }

  /** How loud the fire is with other people at it, for the wildlife model. */
  voicesLevel(): number {
    let level = 0;
    for (const player of this.players.values()) {
      if (player.phase !== 'here' || player.blocked) continue;
      level += player.speaking ? 0.5 : 0.12;
    }
    return Math.min(1, level);
  }

  drainAnnouncements(): string[] {
    if (this.announcements.length === 0) return [];
    return this.announcements.splice(0, this.announcements.length);
  }
}

function isOrigin(p: { x: number; z: number }): boolean {
  return Math.abs(p.x) < 1e-6 && Math.abs(p.z) < 1e-6;
}
