/**
 * Shared synthesis primitives.
 *
 * Three building blocks cover almost every one-shot in the game:
 *
 *  - `noiseBurst`  — band-passed noise with a percussive envelope and an
 *                    optional filter sweep. Air, scrape, hiss, fizz, crunch.
 *  - `modalRing`   — a noise grain fed through parallel high-Q band-passes.
 *                    Struck solids: steel panels, plastic bodies, wood, ice.
 *  - `thump`       — a pitched oscillator with a downward glide. Mass, impact,
 *                    pressure, the low half of anything heavy.
 *
 * Every one applies the mixer's reduced-intensity shaping, so accessibility is
 * enforced at the primitive rather than at each call site.
 */

import type { PercussiveEnvelope } from './envelopes.js';
import { applyPercussive, safeFrequency, shapePercussive } from './envelopes.js';
import type { LayerDeps } from './layer.js';
import type { NoiseKind } from './noise.js';
import type { Rng } from './rng.js';
import type { NoiseBank } from './buffers.js';

export class Synth {
  /** Reused envelope object — the one-shot path allocates no envelopes. */
  private readonly env: PercussiveEnvelope = { attack: 0.001, decay: 0.02, peak: 0.3 };

  constructor(
    private readonly deps: LayerDeps,
    readonly output: AudioNode,
  ) {}

  get ctx(): BaseAudioContext {
    return this.deps.ctx;
  }

  get rng(): Rng {
    return this.deps.rng;
  }

  get bank(): NoiseBank {
    return this.deps.bank;
  }

  /** Never schedule in the past; a few ms of slack avoids glitching. */
  at(when?: number): number {
    return Math.max(when ?? 0, this.deps.ctx.currentTime + 0.004);
  }

  /** Build a percussive envelope with reduced-intensity shaping applied. */
  shaped(attack: number, decay: number, peak: number): PercussiveEnvelope {
    this.env.attack = attack;
    this.env.decay = decay;
    this.env.peak = peak;
    return shapePercussive(this.env, this.deps.mixer.shaping);
  }

  /** Peak scaling only, for envelopes written by hand. */
  get shaping() {
    return this.deps.mixer.shaping;
  }

  /**
   * A filtered slice of the shared noise loop with a percussive envelope.
   * `sweepTo` glides the filter across the envelope, which is what turns a
   * static hiss into something escaping, tearing or moving.
   */
  noiseBurst(
    time: number,
    centerHz: number,
    q: number,
    attack: number,
    decay: number,
    peak: number,
    type: BiquadFilterType = 'bandpass',
    sweepTo?: number,
    destination: AudioNode = this.output,
    noiseKind: NoiseKind = 'white',
  ): number {
    const ctx = this.deps.ctx;
    const bank = this.deps.bank;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = safeFrequency(centerHz, ctx.sampleRate);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(destination);

    const end = applyPercussive(gain.gain, time, this.shaped(attack, decay, peak));
    if (sweepTo !== undefined) {
      filter.frequency.setValueAtTime(safeFrequency(centerHz, ctx.sampleRate), time);
      filter.frequency.exponentialRampToValueAtTime(safeFrequency(sweepTo, ctx.sampleRate), end);
    }

    const source = ctx.createBufferSource();
    source.buffer = bank.loop(noiseKind);
    const loopEnd = bank.loopEnd(noiseKind);
    const duration = Math.min(end - time + 0.02, Math.max(loopEnd - 0.05, 0.05));
    source.connect(filter);
    source.start(time, this.deps.rng.range(0, Math.max(loopEnd - duration - 0.01, 0.01)), duration);
    return end;
  }

  /**
   * Modal synthesis: excite parallel high-Q band-passes with a noise grain.
   * Pass *inharmonic* partial ratios for metal, glass and ice; near-harmonic
   * ratios read as pitched and wooden.
   */
  modalRing(
    time: number,
    partials: readonly number[],
    q: number,
    decay: number,
    peak: number,
    destination: AudioNode = this.output,
    brightness = 0.6,
  ): number {
    const ctx = this.deps.ctx;
    const bus = ctx.createGain();
    bus.gain.value = 0;
    bus.connect(destination);

    const end = applyPercussive(bus.gain, time, this.shaped(0.0008, decay, peak));

    const source = ctx.createBufferSource();
    source.buffer = this.deps.bank.grainForBrightness(brightness);
    const excitation = ctx.createGain();
    excitation.gain.value = 1;
    source.connect(excitation);

    for (let i = 0; i < partials.length; i += 1) {
      const hz = partials[i];
      if (hz === undefined) continue;
      const filter = ctx.createBiquadFilter();
      filter.type = 'bandpass';
      filter.frequency.value = safeFrequency(hz, ctx.sampleRate);
      // Higher partials of a struck body die first.
      filter.Q.value = q / (1 + i * 0.25);
      const partialGain = ctx.createGain();
      partialGain.gain.value = 1 / (1 + i * 0.9);
      excitation.connect(filter);
      filter.connect(partialGain);
      partialGain.connect(bus);
    }

    source.start(time);
    source.stop(end + 0.02);
    return end;
  }

  /** A pitched body/impact: an oscillator with a downward glide and a fast tail. */
  thump(
    time: number,
    fromHz: number,
    toHz: number,
    glide: number,
    decay: number,
    peak: number,
    wave: OscillatorType = 'sine',
    destination: AudioNode = this.output,
  ): number {
    const ctx = this.deps.ctx;
    const osc = ctx.createOscillator();
    osc.type = wave;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(destination);

    osc.frequency.setValueAtTime(safeFrequency(fromHz, ctx.sampleRate), time);
    osc.frequency.exponentialRampToValueAtTime(safeFrequency(toHz, ctx.sampleRate), time + Math.max(glide, 0.005));

    const end = applyPercussive(gain.gain, time, this.shaped(0.0015, decay, peak));
    osc.start(time);
    osc.stop(end + 0.02);
    return end;
  }

  /**
   * A single pre-rendered grain from the bank, band-passed and panned. Cheaper
   * than `noiseBurst` (no loop offset maths) and the right tool for crunch,
   * crumble and tick clusters.
   */
  grain(
    time: number,
    brightness: number,
    centerHz: number,
    q: number,
    attack: number,
    decay: number,
    peak: number,
    playbackRate = 1,
    pan = 0,
    destination: AudioNode = this.output,
  ): number {
    const ctx = this.deps.ctx;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = safeFrequency(centerHz, ctx.sampleRate);
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);

    const factory = ctx as BaseAudioContext & { createStereoPanner?: () => StereoPannerNode };
    if (pan !== 0 && typeof factory.createStereoPanner === 'function') {
      const panner = factory.createStereoPanner();
      panner.pan.value = pan < -1 ? -1 : pan > 1 ? 1 : pan;
      gain.connect(panner);
      panner.connect(destination);
    } else {
      gain.connect(destination);
    }

    const end = applyPercussive(gain.gain, time, this.shaped(attack, decay, peak));
    const source = ctx.createBufferSource();
    source.buffer = this.deps.bank.grainForBrightness(brightness);
    source.playbackRate.value = playbackRate;
    source.connect(filter);
    source.start(time);
    source.stop(end + 0.02);
    return end;
  }

  /**
   * Disconnect nodes once their sources have finished. Uses the host timer when
   * there is one; headlessly the nodes are left attached to a silent chain,
   * which is harmless.
   */
  cleanupLater(nodes: readonly (AudioNode | null | undefined)[], delaySeconds: number): void {
    const timer = (globalThis as { setTimeout?: (fn: () => void, ms: number) => unknown }).setTimeout;
    if (typeof timer !== 'function') return;
    timer(() => {
      for (let i = 0; i < nodes.length; i += 1) {
        const node = nodes[i];
        if (!node) continue;
        try {
          node.disconnect();
        } catch {
          /* already detached */
        }
      }
    }, Math.max(delaySeconds, 0) * 1000 + 50);
  }
}
