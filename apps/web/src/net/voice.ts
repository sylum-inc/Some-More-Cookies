/**
 * Spatial voice, and the thing that has to be just as good when there is none.
 *
 * The service already mints tokens behind a LiveKit-shaped abstraction and,
 * with no `LIVEKIT_*` credentials, answers `{ status: 'not_configured',
 * fallback: 'text_and_gesture' }`. Two consequences shape this file:
 *
 *  1. **The fallback is the common case**, so it is built first and built
 *     properly. Text and gesture are not a consolation prize for a campsite
 *     with no SFU; they are the accessible path that has to exist anyway
 *     (spec §12), and anybody may use them at any time whether voice is up or
 *     not. `status === 'text_and_gesture'` is a working campfire, not a
 *     degraded one.
 *
 *  2. **The spatial path is real but unattached.** There is no WebRTC SDK in
 *     this build and adding one would be a runtime dependency, so what exists
 *     here is the seam: hand `attach(accountId, stream)` a `MediaStream` from
 *     whatever transport eventually arrives and the voice is placed in the
 *     world, attenuated by distance, on the audio engine's own `voice` bus and
 *     its own panner. `apps/web/test/voice.test.ts` drives that path with a
 *     synthetic stream through an offline context.
 *
 * ## Where `proximityGain` is applied, and why here
 *
 * `proximityGain` is defined and tested in the protocol and applied by nothing.
 * This client applies it, per track, per frame, and turns the panner's own
 * distance model *off* (`rolloffFactor: 0`) while doing it.
 *
 * That is deliberate. The protocol's comment says the client and any SFU-side
 * mixer "must agree exactly", and they cannot agree if one of them is a
 * `PannerNode`'s inverse curve with a `refDistance` and the other is
 * `proximityGain`'s curve with a `fullVolumeRadiusM` and a `cutoffRadiusM`.
 * Two distance models multiplied together is also just wrong: a voice at the
 * treeline would be attenuated twice. So the panner keeps the job only it can
 * do — direction, HRTF, the listener basis shared with the fire and the
 * wildlife — and the single authority on *how loud* is the shared pure
 * function. It is also the one that a server-side mixer can evaluate without a
 * browser.
 *
 * ## Privacy
 *
 * Voice is never recorded. `VoiceRoomInfo` types `recording` as the literal
 * `false`, so there is no state in which this client could believe otherwise,
 * and the panel says so out loud rather than offering it as a setting.
 */

import {
  DEFAULT_VOICE_PROXIMITY,
  proximityGain,
  type VoiceMode,
  type VoiceProximity,
  type VoiceRoomInfo,
} from '@somemore/protocol';
import type { SpatialEmitter } from '../audio/spatial.js';

export type VoiceStatus =
  /** Voice is up and a token is in hand. */
  | 'ready'
  /** No provider configured, or it is down. Text and gesture carry the fire. */
  | 'text_and_gesture'
  /** Nobody has asked for voice yet. */
  | 'idle';

/** What the audio engine has to provide for voice to be placed in the world. */
export interface VoiceAudioHost {
  createEmitter(): SpatialEmitter | null;
  releaseEmitter(emitter: SpatialEmitter): void;
}

interface Track {
  readonly accountId: string;
  readonly emitter: SpatialEmitter;
  stream: MediaStream | null;
  /** Last gain written, so the panel can show who is audible from where. */
  gain: number;
}

export class VoiceChannel {
  private room: VoiceRoomInfo | null = null;
  private host: VoiceAudioHost | null = null;
  private readonly tracks = new Map<string, Track>();
  private readonly volumes = new Map<string, number>();
  private readonly blocked = new Set<string>();

  /** Open mic, push to talk, or off. Push to talk is the default the server sends. */
  mode: VoiceMode = 'push_to_talk';
  /** Whether the local microphone is muted. Muted until somebody says otherwise. */
  muted = true;
  /** Held while the push-to-talk key is down. */
  transmitting = false;
  /** Why voice is unavailable, in the service's own words. Never invented here. */
  reason: string | null = null;

  get status(): VoiceStatus {
    if (this.room === null) return 'idle';
    return this.room.status === 'ready' ? 'ready' : 'text_and_gesture';
  }

  get provider(): string | null {
    return this.room?.provider ?? null;
  }

  /** Always false. Present so the interface can show the guarantee. */
  get recording(): false {
    return false;
  }

  get proximity(): VoiceProximity {
    return this.room !== null && this.room.status === 'ready' ? this.room.proximity : DEFAULT_VOICE_PROXIMITY;
  }

  /** The audio graph to place voices in. Available only after audio is unlocked. */
  useAudio(host: VoiceAudioHost | null): void {
    this.host = host;
  }

  /** What the server said about the room. */
  applyRoom(room: VoiceRoomInfo): void {
    this.room = room;
    if (room.status === 'ready') {
      this.reason = null;
      this.mode = room.mode;
      for (const participant of room.participants) {
        this.volumes.set(participant.accountId, participant.volume);
        if (participant.blocked) this.blocked.add(participant.accountId);
      }
    } else {
      this.reason = room.reason;
      this.detachAll();
    }
  }

  volumeFor(accountId: string): number {
    return this.volumes.get(accountId) ?? 1;
  }

  setVolume(accountId: string, volume: number): void {
    this.volumes.set(accountId, Math.max(0, Math.min(1, volume)));
  }

  setBlocked(accountId: string, blocked: boolean): void {
    if (blocked) {
      this.blocked.add(accountId);
      this.detach(accountId);
    } else {
      this.blocked.delete(accountId);
    }
  }

  /**
   * Place a remote player's microphone in the world.
   *
   * The emitter is the same `SpatialEmitter` the fire and the wildlife use, on
   * the `voice` bus, so per-bus accessibility volume and the listener basis
   * apply to voice for free.
   */
  attach(accountId: string, stream: MediaStream): boolean {
    if (this.blocked.has(accountId)) return false;
    const host = this.host;
    if (host === null) return false;
    this.detach(accountId);
    const emitter = host.createEmitter();
    if (emitter === null) return false;
    const source = emitter.attachMediaStream(stream);
    if (source === null) {
      host.releaseEmitter(emitter);
      return false;
    }
    this.tracks.set(accountId, { accountId, emitter, stream, gain: 0 });
    return true;
  }

  detach(accountId: string): void {
    const track = this.tracks.get(accountId);
    if (track === undefined) return;
    this.tracks.delete(accountId);
    track.emitter.detachMediaStream();
    this.host?.releaseEmitter(track.emitter);
  }

  detachAll(): void {
    for (const accountId of [...this.tracks.keys()]) this.detach(accountId);
  }

  get attachedCount(): number {
    return this.tracks.size;
  }

  /** The gain last written for a speaker; 0 when they are out of earshot. */
  gainFor(accountId: string): number {
    return this.tracks.get(accountId)?.gain ?? 0;
  }

  /**
   * Place and attenuate every attached voice. Called once a frame.
   *
   * `speakers` is whatever the roster knows; anyone with no track is skipped,
   * so this is a handful of arithmetic even at a busy fire.
   */
  update(
    listener: { x: number; y: number; z: number },
    speakers: readonly { accountId: string; position: { x: number; y: number; z: number } }[],
  ): void {
    const proximity = this.proximity;
    for (const speaker of speakers) {
      const track = this.tracks.get(speaker.accountId);
      if (track === undefined) continue;
      const dx = speaker.position.x - listener.x;
      const dy = speaker.position.y - listener.y;
      const dz = speaker.position.z - listener.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const gain = proximityGain(distance, proximity) * this.volumeFor(speaker.accountId);
      track.gain = this.blocked.has(speaker.accountId) ? 0 : gain;
      track.emitter.setGain(track.gain);
      track.emitter.setPosition(speaker.position.x, speaker.position.y + 1.5, speaker.position.z);
    }
  }

  /** Whether the local microphone should currently be sending. */
  get open(): boolean {
    if (this.mode === 'off' || this.muted) return false;
    return this.mode === 'open_mic' || this.transmitting;
  }

  dispose(): void {
    this.detachAll();
    this.host = null;
  }
}

/**
 * Panner settings for a voice.
 *
 * `rolloffFactor: 0` is the important one: distance attenuation is
 * `proximityGain`'s job (see the note at the top of this file), and the panner
 * is here for direction only.
 */
export const VOICE_SPATIAL_OPTIONS = Object.freeze({
  distanceModel: 'linear' as DistanceModelType,
  refDistance: 1,
  maxDistance: 10_000,
  rolloffFactor: 0,
  coneInnerAngle: 360,
  coneOuterAngle: 360,
  coneOuterGain: 0,
});
