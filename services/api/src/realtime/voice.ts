/**
 * Spatial voice, behind an abstraction.
 *
 * Voice is the one part of multiplayer we will not build ourselves: echo
 * cancellation, jitter buffers, TURN relays and mobile codec negotiation are a
 * product in their own right. Spec §9.1 calls for "a managed WebRTC solution
 * behind a LiveKit-style abstraction", so this module defines the seam.
 *
 * What lives here:
 *  - `VoiceRoom`, the port: token minting, participants, mute, block,
 *    per-player volume, proximity attenuation.
 *  - A LiveKit-shaped adapter that mints real LiveKit access tokens (they are
 *    plain HS256 JWTs, so `node:crypto` is enough) and that reports
 *    `not_configured` — never throws, never blocks the fire — without
 *    credentials.
 *  - An in-memory fake for tests.
 *
 * What does not live here: signalling, SDP, ICE, or any audio. The adapter
 * hands the client a token and a URL and the provider's SDK does the rest.
 *
 * **Voice is never recorded.** There is no recording flag to turn on: the
 * token we mint carries `roomRecord: false` and the room info reports
 * `recording: false` as a literal type, so "record the campfire" is not a
 * state this code can reach.
 */

import { createHmac, randomUUID } from 'node:crypto';
import {
  DEFAULT_VOICE_PROXIMITY,
  proximityGain,
  type VoiceMode,
  type VoiceParticipant,
  type VoiceProximity,
  type VoiceRoomInfo,
} from '@somemore/protocol';
import type { Clock } from '../clock.js';

export interface VoiceTokenRequest {
  readonly sessionId: string;
  readonly campsiteId: string;
  readonly accountId: string;
  /** Display name shown on the mic indicator. */
  readonly displayName: string;
  readonly mode: VoiceMode;
  readonly ttlSeconds?: number;
  readonly canPublish?: boolean;
}

/**
 * The seam every voice provider sits behind.
 *
 * Deliberately not "a LiveKit client": mute, block and per-player volume are
 * product rules that must hold whatever the transport is, so they are part of
 * the port rather than something we hope the SDK exposes.
 */
export interface VoiceRoom {
  readonly provider: string;
  /** Always `false`. Present so the guarantee is in the type system. */
  readonly recording: false;
  isConfigured(): boolean;
  /** Why voice is unavailable, or `null` when it is fine. */
  unavailableReason(): string | null;
  /** A join token for one player, or a `not_configured` report. */
  mintToken(request: VoiceTokenRequest): Promise<VoiceRoomInfo>;
  participants(sessionId: string): Promise<VoiceParticipant[]>;
  setMuted(sessionId: string, accountId: string, muted: boolean): Promise<void>;
  /** Blocking is symmetric-by-listener: the blocker stops hearing the blocked. */
  setBlocked(sessionId: string, listenerAccountId: string, speakerAccountId: string, blocked: boolean): Promise<void>;
  setVolume(sessionId: string, listenerAccountId: string, speakerAccountId: string, volume: number): Promise<void>;
  /** Effective gain: per-player volume × proximity, zero if muted or blocked. */
  gainFor(input: {
    sessionId: string;
    listenerAccountId: string;
    speakerAccountId: string;
    distanceM: number;
  }): Promise<number>;
  leave(sessionId: string, accountId: string): Promise<void>;
  closeRoom(sessionId: string): Promise<void>;
  readonly proximity: VoiceProximity;
}

interface RoomMember {
  accountId: string;
  identity: string;
  muted: boolean;
  speaking: boolean;
}

/**
 * Membership, mute state, blocks and per-listener volumes.
 *
 * Shared by both adapters because these are our rules, not the provider's —
 * swapping LiveKit for something else must not change who can hear whom.
 */
class VoiceRegistry {
  private readonly rooms = new Map<string, Map<string, RoomMember>>();
  /** `sessionId` → listener → speaker → volume. */
  private readonly volumes = new Map<string, Map<string, Map<string, number>>>();
  /** `sessionId` → listener → set of blocked speakers. */
  private readonly blocks = new Map<string, Map<string, Set<string>>>();

  join(sessionId: string, member: RoomMember): void {
    const room = this.rooms.get(sessionId) ?? new Map<string, RoomMember>();
    room.set(member.accountId, member);
    this.rooms.set(sessionId, room);
  }

  leave(sessionId: string, accountId: string): void {
    this.rooms.get(sessionId)?.delete(accountId);
    this.volumes.get(sessionId)?.delete(accountId);
    this.blocks.get(sessionId)?.delete(accountId);
  }

  closeRoom(sessionId: string): void {
    this.rooms.delete(sessionId);
    this.volumes.delete(sessionId);
    this.blocks.delete(sessionId);
  }

  setMuted(sessionId: string, accountId: string, muted: boolean): void {
    const member = this.rooms.get(sessionId)?.get(accountId);
    if (member !== undefined) member.muted = muted;
  }

  setVolume(sessionId: string, listener: string, speaker: string, volume: number): void {
    const perSession = this.volumes.get(sessionId) ?? new Map<string, Map<string, number>>();
    const perListener = perSession.get(listener) ?? new Map<string, number>();
    perListener.set(speaker, Math.max(0, Math.min(1, volume)));
    perSession.set(listener, perListener);
    this.volumes.set(sessionId, perSession);
  }

  volume(sessionId: string, listener: string, speaker: string): number {
    return this.volumes.get(sessionId)?.get(listener)?.get(speaker) ?? 1;
  }

  setBlocked(sessionId: string, listener: string, speaker: string, blocked: boolean): void {
    const perSession = this.blocks.get(sessionId) ?? new Map<string, Set<string>>();
    const set = perSession.get(listener) ?? new Set<string>();
    if (blocked) set.add(speaker);
    else set.delete(speaker);
    perSession.set(listener, set);
    this.blocks.set(sessionId, perSession);
  }

  isBlocked(sessionId: string, listener: string, speaker: string): boolean {
    return this.blocks.get(sessionId)?.get(listener)?.has(speaker) ?? false;
  }

  participants(sessionId: string, listener: string | null): VoiceParticipant[] {
    const room = this.rooms.get(sessionId);
    if (room === undefined) return [];
    return [...room.values()].map((member) => ({
      accountId: member.accountId,
      identity: member.identity,
      muted: member.muted,
      speaking: member.speaking,
      volume: listener === null ? 1 : this.volume(sessionId, listener, member.accountId),
      blocked: listener === null ? false : this.isBlocked(sessionId, listener, member.accountId),
    }));
  }

  muted(sessionId: string, accountId: string): boolean {
    return this.rooms.get(sessionId)?.get(accountId)?.muted ?? true;
  }
}

function roomNameFor(sessionId: string): string {
  return `somemore-${sessionId}`;
}

/* -------------------------------------------------------------------------- */
/* LiveKit-shaped adapter                                                      */
/* -------------------------------------------------------------------------- */

export interface LiveKitConfig {
  /** `wss://…` — the LiveKit SFU the client connects to. */
  readonly url: string | null;
  readonly apiKey: string | null;
  readonly apiSecret: string | null;
  readonly defaultTtlSeconds?: number;
  readonly proximity?: VoiceProximity;
}

/** Read the LiveKit configuration off the environment. All three or nothing. */
export function liveKitConfigFromEnv(env: NodeJS.ProcessEnv = process.env): LiveKitConfig {
  const value = (key: string): string | null => {
    const raw = env[key];
    if (raw === undefined) return null;
    const trimmed = raw.trim();
    return trimmed.length === 0 ? null : trimmed;
  };
  return {
    url: value('LIVEKIT_URL'),
    apiKey: value('LIVEKIT_API_KEY'),
    apiSecret: value('LIVEKIT_API_SECRET'),
  };
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/**
 * A LiveKit access token. These are ordinary HS256 JWTs with a `video` grant,
 * so no SDK is needed to mint one — which is exactly why the abstraction can
 * be honest about being wired up before a provider account exists.
 */
export function mintLiveKitToken(input: {
  apiKey: string;
  apiSecret: string;
  identity: string;
  displayName: string;
  roomName: string;
  issuedAt: Date;
  ttlSeconds: number;
  canPublish: boolean;
}): { token: string; expiresAt: Date } {
  const issuedAtSeconds = Math.floor(input.issuedAt.getTime() / 1000);
  const expiresAtSeconds = issuedAtSeconds + input.ttlSeconds;
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    iss: input.apiKey,
    sub: input.identity,
    name: input.displayName,
    nbf: issuedAtSeconds,
    iat: issuedAtSeconds,
    exp: expiresAtSeconds,
    jti: randomUUID(),
    video: {
      room: input.roomName,
      roomJoin: true,
      canPublish: input.canPublish,
      canSubscribe: true,
      canPublishData: true,
      // Not a setting. Private voice is never recorded (spec §9.1).
      roomRecord: false,
      recorder: false,
    },
  };
  const signingInput = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
  const signature = createHmac('sha256', input.apiSecret).update(signingInput).digest('base64url');
  return { token: `${signingInput}.${signature}`, expiresAt: new Date(expiresAtSeconds * 1000) };
}

export function createLiveKitVoiceRoom(config: LiveKitConfig, clock: Clock): VoiceRoom {
  const registry = new VoiceRegistry();
  const proximity = config.proximity ?? DEFAULT_VOICE_PROXIMITY;
  const ttl = config.defaultTtlSeconds ?? 60 * 60;

  function missing(): string[] {
    const gaps: string[] = [];
    if (config.url === null) gaps.push('LIVEKIT_URL');
    if (config.apiKey === null) gaps.push('LIVEKIT_API_KEY');
    if (config.apiSecret === null) gaps.push('LIVEKIT_API_SECRET');
    return gaps;
  }

  return {
    provider: 'livekit',
    recording: false,
    proximity,

    isConfigured() {
      return missing().length === 0;
    },

    unavailableReason() {
      const gaps = missing();
      return gaps.length === 0 ? null : `LiveKit is not configured: ${gaps.join(', ')} not set.`;
    },

    async mintToken(request) {
      const gaps = missing();
      if (gaps.length > 0 || config.apiKey === null || config.apiSecret === null || config.url === null) {
        // Degrade, never block (ARCHITECTURE §1.5). The fire carries on with
        // text and gesture; the client shows "voice unavailable", not an error.
        return {
          status: 'not_configured',
          provider: 'livekit',
          reason: `LiveKit is not configured: ${gaps.join(', ')} not set. See README "Blockers".`,
          fallback: 'text_and_gesture',
        };
      }
      const roomName = roomNameFor(request.sessionId);
      const identity = `${request.accountId}`;
      const { token, expiresAt } = mintLiveKitToken({
        apiKey: config.apiKey,
        apiSecret: config.apiSecret,
        identity,
        displayName: request.displayName,
        roomName,
        issuedAt: clock.now(),
        ttlSeconds: request.ttlSeconds ?? ttl,
        canPublish: request.canPublish ?? true,
      });
      registry.join(request.sessionId, {
        accountId: request.accountId,
        identity,
        muted: request.mode !== 'open_mic',
        speaking: false,
      });
      return {
        status: 'ready',
        provider: 'livekit',
        roomName,
        url: config.url,
        token,
        expiresAt: expiresAt.toISOString(),
        mode: request.mode,
        proximity,
        recording: false,
        participants: registry.participants(request.sessionId, request.accountId),
      };
    },

    async participants(sessionId) {
      return registry.participants(sessionId, null);
    },

    async setMuted(sessionId, accountId, muted) {
      registry.setMuted(sessionId, accountId, muted);
    },

    async setBlocked(sessionId, listener, speaker, blocked) {
      registry.setBlocked(sessionId, listener, speaker, blocked);
    },

    async setVolume(sessionId, listener, speaker, volume) {
      registry.setVolume(sessionId, listener, speaker, volume);
    },

    async gainFor({ sessionId, listenerAccountId, speakerAccountId, distanceM }) {
      if (registry.isBlocked(sessionId, listenerAccountId, speakerAccountId)) return 0;
      if (registry.muted(sessionId, speakerAccountId)) return 0;
      return registry.volume(sessionId, listenerAccountId, speakerAccountId) * proximityGain(distanceM, proximity);
    },

    async leave(sessionId, accountId) {
      registry.leave(sessionId, accountId);
    },

    async closeRoom(sessionId) {
      registry.closeRoom(sessionId);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Fake                                                                        */
/* -------------------------------------------------------------------------- */

export interface FakeVoiceRoom extends VoiceRoom {
  /** Every token minted, so tests can assert on what was handed out. */
  readonly minted: VoiceTokenRequest[];
}

/**
 * In-memory voice room. Mints an obviously-fake token so nothing can mistake a
 * test run for a real SFU, but implements every product rule for real.
 */
export function createFakeVoiceRoom(clock: Clock, options: { proximity?: VoiceProximity } = {}): FakeVoiceRoom {
  const registry = new VoiceRegistry();
  const proximity = options.proximity ?? DEFAULT_VOICE_PROXIMITY;
  const minted: VoiceTokenRequest[] = [];

  return {
    provider: 'fake',
    recording: false,
    proximity,
    minted,

    isConfigured() {
      return true;
    },

    unavailableReason() {
      return null;
    },

    async mintToken(request) {
      minted.push(request);
      const identity = request.accountId;
      registry.join(request.sessionId, {
        accountId: request.accountId,
        identity,
        muted: request.mode !== 'open_mic',
        speaking: false,
      });
      const expiresAt = new Date(clock.now().getTime() + (request.ttlSeconds ?? 3600) * 1000);
      return {
        status: 'ready',
        provider: 'fake',
        roomName: roomNameFor(request.sessionId),
        url: 'wss://voice.invalid/fake',
        token: `fake-voice-token.${request.sessionId}.${request.accountId}`,
        expiresAt: expiresAt.toISOString(),
        mode: request.mode,
        proximity,
        recording: false,
        participants: registry.participants(request.sessionId, request.accountId),
      };
    },

    async participants(sessionId) {
      return registry.participants(sessionId, null);
    },

    async setMuted(sessionId, accountId, muted) {
      registry.setMuted(sessionId, accountId, muted);
    },

    async setBlocked(sessionId, listener, speaker, blocked) {
      registry.setBlocked(sessionId, listener, speaker, blocked);
    },

    async setVolume(sessionId, listener, speaker, volume) {
      registry.setVolume(sessionId, listener, speaker, volume);
    },

    async gainFor({ sessionId, listenerAccountId, speakerAccountId, distanceM }) {
      if (registry.isBlocked(sessionId, listenerAccountId, speakerAccountId)) return 0;
      if (registry.muted(sessionId, speakerAccountId)) return 0;
      return registry.volume(sessionId, listenerAccountId, speakerAccountId) * proximityGain(distanceM, proximity);
    },

    async leave(sessionId, accountId) {
      registry.leave(sessionId, accountId);
    },

    async closeRoom(sessionId) {
      registry.closeRoom(sessionId);
    },
  };
}
