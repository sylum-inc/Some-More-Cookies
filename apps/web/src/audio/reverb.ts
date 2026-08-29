/**
 * Convolution reverb send, fed by procedurally generated impulse responses.
 *
 * One shared reverb bus; every submix sends into it at a fixed ratio. That is
 * a lot cheaper than per-layer convolvers and it is also more convincing —
 * the fire and the machine sharing one space is what makes them feel co-located.
 */

import { clamp01 } from './math.js';
import { safeDisconnect, toAudioBuffer } from './context.js';
import type { GeneratedImpulse, ImpulseSpec, SpaceType } from './impulse.js';
import { ImpulseCache } from './impulse.js';
import type { BusName } from './buses.js';

/** How much of each submix is sent into the shared reverb. */
export const DEFAULT_REVERB_SENDS: Readonly<Record<BusName, number>> = Object.freeze({
  ambience: 0.12, // already spacious; too much send turns it to mush
  fire: 0.28,
  machine: 0.35, // machinery in a shed lives or dies on its room
  foley: 0.22,
  ui: 0, // interface sound is non-diegetic and stays dry
  voice: 0.18,
});

export interface ReverbOptions {
  space: SpaceType;
  /** Overall reverb return level, 0..1. */
  wet: number;
  /** Rolls off the top of the return so tails sit behind the dry signal. */
  dampingHz: number;
}

export const DEFAULT_REVERB_OPTIONS: Readonly<ReverbOptions> = Object.freeze({
  space: 'openForest',
  wet: 0.35,
  dampingHz: 7000,
});

export class ReverbBus {
  /** Connect submix sends here. */
  readonly input: GainNode;
  private readonly convolver: ConvolverNode;
  private readonly tone: BiquadFilterNode;
  private readonly output: GainNode;
  private readonly cache: ImpulseCache;
  private currentSpace: SpaceType;
  private wetLevel: number;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    options: Partial<ReverbOptions> = {},
    cache: ImpulseCache = new ImpulseCache(),
  ) {
    const opts: ReverbOptions = { ...DEFAULT_REVERB_OPTIONS, ...options };
    this.cache = cache;
    this.currentSpace = opts.space;
    this.wetLevel = clamp01(opts.wet);

    this.input = ctx.createGain();
    this.input.gain.value = 1;
    this.convolver = ctx.createConvolver();
    this.convolver.normalize = false; // our IRs are already peak-normalised
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = opts.dampingHz;
    this.output = ctx.createGain();
    this.output.gain.value = this.wetLevel;

    this.input.connect(this.convolver);
    this.convolver.connect(this.tone);
    this.tone.connect(this.output);
    this.output.connect(destination);

    this.applyImpulse(this.cache.get(this.currentSpace, ctx.sampleRate));
  }

  private applyImpulse(impulse: GeneratedImpulse): void {
    this.convolver.buffer = toAudioBuffer(this.ctx, impulse.channels, impulse.sampleRate);
  }

  get space(): SpaceType {
    return this.currentSpace;
  }

  get wet(): number {
    return this.wetLevel;
  }

  specFor(space: SpaceType): ImpulseSpec {
    return this.cache.specFor(space);
  }

  /** Swap spaces. Cross-fades the return so a campsite change does not click. */
  setSpace(space: SpaceType, crossfadeSeconds = 0.35): void {
    if (space === this.currentSpace) return;
    this.currentSpace = space;
    const now = this.ctx.currentTime;
    const half = Math.max(crossfadeSeconds, 0.01) / 2;
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(0, now + half);
    this.applyImpulse(this.cache.get(space, this.ctx.sampleRate));
    this.output.gain.linearRampToValueAtTime(this.wetLevel, now + half * 2);
  }

  setWet(wet: number, smoothingSeconds = 0.1): void {
    this.wetLevel = clamp01(wet);
    this.output.gain.setTargetAtTime(this.wetLevel, this.ctx.currentTime, Math.max(smoothingSeconds, 1e-3));
  }

  setDamping(hz: number): void {
    this.tone.frequency.setTargetAtTime(Math.max(hz, 200), this.ctx.currentTime, 0.05);
  }

  /** Build the per-bus send node for `bus`. Returns null when the bus is dry by design. */
  createSend(bus: BusName, source: AudioNode, amount = DEFAULT_REVERB_SENDS[bus]): GainNode | null {
    if (amount <= 0) return null;
    const send = this.ctx.createGain();
    send.gain.value = amount;
    source.connect(send);
    send.connect(this.input);
    return send;
  }

  dispose(): void {
    safeDisconnect(this.input);
    safeDisconnect(this.convolver);
    safeDisconnect(this.tone);
    safeDisconnect(this.output);
  }
}
