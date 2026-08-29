/**
 * Submix bus definitions and the pure mixer state machine.
 *
 * The state machine deliberately knows nothing about WebAudio: it holds
 * volumes, mute and the reduced-intensity flag, and notifies listeners. The
 * engine subscribes and pushes the resulting gains onto real `GainNode`s. That
 * split means bus/mute/accessibility behaviour is fully testable headlessly,
 * and it means volumes set before the context exists are not lost.
 */

import { clamp01 } from './math.js';
import type { IntensityShaping } from './envelopes.js';
import { shapingFor } from './envelopes.js';

export const BUS_NAMES = ['ambience', 'fire', 'machine', 'foley', 'ui', 'voice'] as const;

export type BusName = (typeof BUS_NAMES)[number];

/** What each bus is for, surfaced in the accessibility settings UI. */
export const BUS_DESCRIPTIONS: Readonly<Record<BusName, string>> = Object.freeze({
  ambience: 'Wind, water, insects, animals, the radio and room tone',
  fire: 'The campfire bed, crackles and rumble',
  machine: 'The SM-01 and other machinery',
  foley: 'Cooking, handling and footsteps',
  ui: 'Interface beeps and confirmations',
  voice: 'Other players and spoken lines',
});

export const DEFAULT_BUS_VOLUMES: Readonly<Record<BusName, number>> = Object.freeze({
  ambience: 0.7,
  fire: 0.85,
  machine: 0.8,
  foley: 0.75,
  ui: 0.6,
  voice: 1,
});

export function isBusName(value: string): value is BusName {
  return (BUS_NAMES as readonly string[]).includes(value);
}

/**
 * Slider position (0..1) to linear gain. A squared curve tracks perceived
 * loudness far better than a linear fader: 0.5 lands near -12 dB.
 */
export function volumeToGain(volume: number): number {
  const v = clamp01(volume);
  return v * v;
}

/** Inverse of `volumeToGain`, for restoring a slider from a stored gain. */
export function gainToVolume(gain: number): number {
  return Math.sqrt(clamp01(gain));
}

export interface MixerSnapshot {
  master: number;
  muted: boolean;
  reducedIntensity: boolean;
  buses: Record<BusName, number>;
}

export type MixerChange = BusName | 'master' | 'mute' | 'reducedIntensity';

export type MixerListener = (change: MixerChange, state: MixerState) => void;

export class MixerState {
  private readonly volumes: Record<BusName, number>;
  private master = 0.8;
  private mutedFlag = false;
  private reducedFlag = false;
  private readonly listeners = new Set<MixerListener>();

  constructor(initial?: Partial<MixerSnapshot>) {
    this.volumes = { ...DEFAULT_BUS_VOLUMES };
    if (initial) this.restore(initial);
  }

  subscribe(listener: MixerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(change: MixerChange): void {
    for (const listener of this.listeners) listener(change, this);
  }

  /** Returns true when the value actually changed (so callers can skip work). */
  setBusVolume(bus: BusName, volume: number): boolean {
    const next = clamp01(volume);
    if (this.volumes[bus] === next) return false;
    this.volumes[bus] = next;
    this.emit(bus);
    return true;
  }

  getBusVolume(bus: BusName): number {
    return this.volumes[bus];
  }

  /** Linear gain for the bus's own `GainNode`. */
  busGain(bus: BusName): number {
    return volumeToGain(this.volumes[bus]);
  }

  setMasterVolume(volume: number): boolean {
    const next = clamp01(volume);
    if (this.master === next) return false;
    this.master = next;
    this.emit('master');
    return true;
  }

  getMasterVolume(): number {
    return this.master;
  }

  /** Linear gain for the master `GainNode`, mute folded in. */
  masterGain(): number {
    return this.mutedFlag ? 0 : volumeToGain(this.master);
  }

  setMuted(muted: boolean): boolean {
    if (this.mutedFlag === muted) return false;
    this.mutedFlag = muted;
    this.emit('mute');
    return true;
  }

  toggleMute(): boolean {
    this.setMuted(!this.mutedFlag);
    return this.mutedFlag;
  }

  get muted(): boolean {
    return this.mutedFlag;
  }

  setReducedAudioIntensity(reduced: boolean): boolean {
    if (this.reducedFlag === reduced) return false;
    this.reducedFlag = reduced;
    this.emit('reducedIntensity');
    return true;
  }

  get reducedAudioIntensity(): boolean {
    return this.reducedFlag;
  }

  /** Peak/attack shaping every one-shot must run its envelope through. */
  get shaping(): IntensityShaping {
    return shapingFor(this.reducedFlag);
  }

  /** Total linear gain a sound on `bus` ends up with. */
  effectiveGain(bus: BusName): number {
    return this.masterGain() * this.busGain(bus);
  }

  /** True when nothing on this bus can be heard — lets callers skip synthesis entirely. */
  isSilent(bus: BusName): boolean {
    return this.effectiveGain(bus) <= 0;
  }

  snapshot(): MixerSnapshot {
    return {
      master: this.master,
      muted: this.mutedFlag,
      reducedIntensity: this.reducedFlag,
      buses: { ...this.volumes },
    };
  }

  /** Apply a stored snapshot (e.g. from localStorage). Unknown buses are ignored. */
  restore(snapshot: Partial<MixerSnapshot>): void {
    if (typeof snapshot.master === 'number') this.master = clamp01(snapshot.master);
    if (typeof snapshot.muted === 'boolean') this.mutedFlag = snapshot.muted;
    if (typeof snapshot.reducedIntensity === 'boolean') this.reducedFlag = snapshot.reducedIntensity;
    const buses = snapshot.buses;
    if (buses) {
      for (const bus of BUS_NAMES) {
        const value = buses[bus];
        if (typeof value === 'number') this.volumes[bus] = clamp01(value);
      }
    }
    this.emit('master');
  }

  reset(): void {
    for (const bus of BUS_NAMES) this.volumes[bus] = DEFAULT_BUS_VOLUMES[bus];
    this.master = 0.8;
    this.mutedFlag = false;
    this.reducedFlag = false;
    this.emit('master');
  }
}
