/**
 * The dependency bundle every synthesis layer receives from `AudioEngine`.
 *
 * Layers never create their own context, noise or RNG: they are handed one, so
 * buffers are shared, randomness is deterministic per campsite, and a layer can
 * be constructed against a stub context in tests.
 */

import type { NoiseBank } from './buffers.js';
import type { MixerState } from './buses.js';
import type { Rng } from './rng.js';

export interface LayerDeps {
  readonly ctx: BaseAudioContext;
  /** The submix bus input this layer must connect into. */
  readonly destination: AudioNode;
  readonly bank: NoiseBank;
  readonly rng: Rng;
  /** Consulted for reduced-intensity shaping on every transient. */
  readonly mixer: MixerState;
}

/** Layers that evolve on the audio clock implement this. */
export interface PumpableLayer {
  /** Schedule stochastic events into the look-ahead window. Returns events scheduled. */
  pump(now: number): number;
}
