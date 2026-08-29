/**
 * Shared, lazily-built `AudioBuffer` bank.
 *
 * Every layer needs noise, and generating a 4-second pink-noise loop costs a
 * couple of hundred thousand operations. The bank builds each buffer once, on
 * first use, and hands the same object to fire, ambience, machine and foley.
 */

import type { NoiseKind } from './noise.js';
import {
  crossfadeLoopInPlace,
  fillBlueNoise,
  fillBrownNoise,
  fillGrain,
  fillPinkNoise,
  fillVelvetNoise,
  fillWhiteNoise,
  loopEndFor,
} from './noise.js';
import { toAudioBuffer } from './context.js';
import type { Rng } from './rng.js';
import { createRng } from './rng.js';
import { cyclicAt } from './math.js';

export interface NoiseBankOptions {
  /** Length of each looping texture. Long enough that the loop is not audible. */
  loopSeconds: number;
  /** Crossfade applied across the loop seam, in seconds. */
  loopFadeSeconds: number;
  /** Number of distinct one-shot grains, spread from dull to bright. */
  grainCount: number;
  grainSeconds: number;
  seed: number;
}

export const DEFAULT_NOISE_BANK_OPTIONS: Readonly<NoiseBankOptions> = Object.freeze({
  loopSeconds: 4,
  loopFadeSeconds: 0.25,
  grainCount: 12,
  grainSeconds: 0.28,
  seed: 0x50d1e,
});

export class NoiseBank {
  private readonly options: NoiseBankOptions;
  private readonly rng: Rng;
  private readonly loops = new Map<NoiseKind, AudioBuffer>();
  private readonly loopEnds = new Map<NoiseKind, number>();
  private readonly velvets = new Map<number, AudioBuffer>();
  private grains: AudioBuffer[] | null = null;

  constructor(
    private readonly ctx: BaseAudioContext,
    options: Partial<NoiseBankOptions> = {},
  ) {
    this.options = { ...DEFAULT_NOISE_BANK_OPTIONS, ...options };
    this.rng = createRng(this.options.seed);
  }

  private fill(kind: NoiseKind, data: Float32Array): void {
    switch (kind) {
      case 'pink':
        fillPinkNoise(data, this.rng);
        break;
      case 'brown':
        fillBrownNoise(data, this.rng);
        break;
      case 'blue':
        fillBlueNoise(data, this.rng);
        break;
      case 'velvet':
        fillVelvetNoise(data, this.rng, 1200, this.ctx.sampleRate);
        break;
      case 'white':
      default:
        fillWhiteNoise(data, this.rng);
        break;
    }
  }

  /** A seamless looping mono texture of the given colour. */
  loop(kind: NoiseKind): AudioBuffer {
    const existing = this.loops.get(kind);
    if (existing) return existing;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.round(this.options.loopSeconds * sampleRate));
    const fade = Math.round(this.options.loopFadeSeconds * sampleRate);
    const data = new Float32Array(length);
    this.fill(kind, data);
    crossfadeLoopInPlace(data, fade);
    const buffer = toAudioBuffer(this.ctx, [data], sampleRate);
    this.loops.set(kind, buffer);
    this.loopEnds.set(kind, loopEndFor(length, fade, sampleRate));
    return buffer;
  }

  /** The `loopEnd` seconds to pair with `loop(kind)` so the seam stays inaudible. */
  loopEnd(kind: NoiseKind): number {
    if (!this.loopEnds.has(kind)) this.loop(kind);
    return this.loopEnds.get(kind) ?? this.options.loopSeconds;
  }

  private buildGrains(): AudioBuffer[] {
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(8, Math.round(this.options.grainSeconds * sampleRate));
    const count = Math.max(1, this.options.grainCount);
    const grains: AudioBuffer[] = [];
    const data = new Float32Array(length);
    for (let i = 0; i < count; i += 1) {
      const brightness = count === 1 ? 0.5 : i / (count - 1);
      // Brighter grains are also shorter: a resin snap is faster than a thud.
      const decay = 0.09 - 0.07 * brightness;
      fillGrain(data, this.rng, sampleRate, 0.0008 + 0.0025 * (1 - brightness), decay, brightness);
      grains.push(toAudioBuffer(this.ctx, [data], sampleRate));
    }
    return grains;
  }

  /** One of `grainCount` percussive noise grains, ordered dull -> bright. */
  grain(index: number): AudioBuffer {
    if (!this.grains) this.grains = this.buildGrains();
    const first = this.grains[0];
    if (!first) throw new Error('NoiseBank: grain bank is empty');
    return cyclicAt(this.grains, index, first);
  }

  /** Pick the grain closest to a 0..1 brightness. */
  grainForBrightness(brightness: number): AudioBuffer {
    if (!this.grains) this.grains = this.buildGrains();
    const count = this.grains.length;
    const index = Math.round((brightness < 0 ? 0 : brightness > 1 ? 1 : brightness) * (count - 1));
    return this.grain(index);
  }

  get grainCount(): number {
    if (!this.grains) this.grains = this.buildGrains();
    return this.grains.length;
  }

  /** A looping velvet-noise buffer at a given impulse density. */
  velvet(densityHz: number): AudioBuffer {
    const key = Math.round(densityHz);
    const existing = this.velvets.get(key);
    if (existing) return existing;
    const sampleRate = this.ctx.sampleRate;
    const length = Math.max(1, Math.round(this.options.loopSeconds * sampleRate));
    const data = new Float32Array(length);
    fillVelvetNoise(data, this.rng, key, sampleRate);
    const buffer = toAudioBuffer(this.ctx, [data], sampleRate);
    this.velvets.set(key, buffer);
    return buffer;
  }

  dispose(): void {
    this.loops.clear();
    this.loopEnds.clear();
    this.velvets.clear();
    this.grains = null;
  }
}
