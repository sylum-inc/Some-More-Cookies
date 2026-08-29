/**
 * Voice pooling and stochastic scheduling.
 *
 * WebAudio forces one allocation per one-shot: `AudioBufferSourceNode` and
 * `OscillatorNode` are single-use by spec. Everything *else* — the gain,
 * filter and panner each shot runs through — is pooled here and reused, and the
 * per-frame update path (`FireBed.update`, `NightAmbience.update`) allocates
 * nothing at all: it writes into pre-built parameter objects and calls
 * `setTargetAtTime`.
 */

import type { Rng } from './rng.js';
import { poissonInterval } from './rng.js';

export interface PoolStats {
  created: number;
  inUse: number;
  free: number;
  highWater: number;
}

/** A minimal free-list pool. No allocation on acquire once warm. */
export class ObjectPool<T> {
  private readonly free: T[] = [];
  private createdCount = 0;
  private inUseCount = 0;
  private highWaterMark = 0;

  constructor(
    private readonly factory: () => T,
    private readonly onRelease: ((item: T) => void) | null = null,
    warmCount = 0,
    private readonly maxSize = 256,
  ) {
    for (let i = 0; i < warmCount; i += 1) {
      this.free.push(this.factory());
      this.createdCount += 1;
    }
  }

  acquire(): T {
    const pooled = this.free.pop();
    const item = pooled ?? this.factory();
    if (pooled === undefined) this.createdCount += 1;
    this.inUseCount += 1;
    if (this.inUseCount > this.highWaterMark) this.highWaterMark = this.inUseCount;
    return item;
  }

  release(item: T): void {
    if (this.inUseCount > 0) this.inUseCount -= 1;
    this.onRelease?.(item);
    if (this.free.length < this.maxSize) this.free.push(item);
  }

  get stats(): PoolStats {
    return {
      created: this.createdCount,
      inUse: this.inUseCount,
      free: this.free.length,
      highWater: this.highWaterMark,
    };
  }

  /** Drop cached items (e.g. when the AudioContext is closed). */
  clear(): void {
    this.free.length = 0;
    this.inUseCount = 0;
  }
}

/**
 * Homogeneous Poisson process over the audio clock.
 *
 * `collect` writes the absolute times of every event up to `horizon` into a
 * caller-owned `Float64Array`, so the scheduling loop is allocation-free. If
 * more events fall inside the horizon than the array can hold, the surplus is
 * dropped and counted in `dropped` — that is the voice budget doing its job
 * when the fire is roaring.
 */
export class PoissonScheduler {
  private nextTime = Number.POSITIVE_INFINITY;
  private ratePerSecond = 0;
  private droppedCount = 0;

  constructor(private readonly rng: Rng) {}

  /** Arm the process at `now`; the first event lands one interval later. */
  reset(now: number): void {
    this.nextTime =
      this.ratePerSecond > 0 ? now + poissonInterval(this.ratePerSecond, this.rng) : Number.POSITIVE_INFINITY;
  }

  /**
   * Change the rate. A process that was stopped is re-armed from `now`; a
   * running process keeps its pending event unless it now sits implausibly far
   * in the future for the new rate (which would make a sudden flare-up feel
   * laggy), in which case it is resampled.
   */
  setRate(ratePerSecond: number, now: number): void {
    const rate = Number.isFinite(ratePerSecond) && ratePerSecond > 0 ? ratePerSecond : 0;
    const wasStopped = this.ratePerSecond <= 0;
    this.ratePerSecond = rate;
    if (rate <= 0) {
      this.nextTime = Number.POSITIVE_INFINITY;
      return;
    }
    if (wasStopped || !Number.isFinite(this.nextTime)) {
      this.reset(now);
      return;
    }
    const meanInterval = 1 / rate;
    if (this.nextTime - now > meanInterval * 6) {
      this.nextTime = now + poissonInterval(rate, this.rng);
    }
  }

  get rate(): number {
    return this.ratePerSecond;
  }

  get dropped(): number {
    return this.droppedCount;
  }

  /** Absolute time of the next pending event (`Infinity` when stopped). */
  peek(): number {
    return this.nextTime;
  }

  collect(horizon: number, out: Float64Array): number {
    if (this.ratePerSecond <= 0) return 0;
    let count = 0;
    while (this.nextTime <= horizon) {
      if (count >= out.length) {
        // Budget exhausted: skip forward rather than accumulating a backlog.
        this.droppedCount += 1;
        this.nextTime += poissonInterval(this.ratePerSecond, this.rng);
        if (this.nextTime > horizon) break;
        continue;
      }
      out[count] = this.nextTime;
      count += 1;
      this.nextTime += poissonInterval(this.ratePerSecond, this.rng);
    }
    return count;
  }
}

/**
 * Look-ahead window driver. The audio clock runs ahead of the game loop, so all
 * stochastic events are scheduled into `[now, now + lookahead]` and the pump
 * only needs to run every `intervalSeconds`.
 */
export class LookaheadWindow {
  private horizon = 0;

  constructor(
    public lookaheadSeconds = 0.25,
    public readonly maxCatchUpSeconds = 1,
  ) {}

  reset(now: number): void {
    this.horizon = now;
  }

  /**
   * Advance the window to `now`. Returns the new horizon, or `null` when there
   * is nothing to do yet. Large gaps (tab was backgrounded) are truncated to
   * `maxCatchUpSeconds` so we never dump a thousand queued crackles at once.
   */
  advance(now: number): number | null {
    if (this.horizon === 0) this.horizon = now;
    if (now - this.horizon > this.maxCatchUpSeconds) this.horizon = now;
    const target = now + this.lookaheadSeconds;
    if (target <= this.horizon) return null;
    this.horizon = target;
    return target;
  }

  get currentHorizon(): number {
    return this.horizon;
  }
}

/**
 * A reusable gain+filter chain for one-shot grains. The source node is created
 * per shot (WebAudio requires it) but is thrown away immediately; the chain
 * behind it survives for the life of the engine.
 */
export interface GrainVoice {
  readonly gain: GainNode;
  readonly filter: BiquadFilterNode;
  /** Null when the platform lacks `StereoPannerNode` (older Safari). */
  readonly pan: StereoPannerNode | null;
  /** Audio-clock time at which this voice becomes reusable. */
  busyUntil: number;
}

export class GrainVoicePool {
  private readonly voices: GrainVoice[] = [];

  constructor(
    private readonly ctx: BaseAudioContext,
    private readonly destination: AudioNode,
    private readonly size: number,
  ) {
    for (let i = 0; i < size; i += 1) {
      this.voices.push(this.build());
    }
  }

  private build(): GrainVoice {
    const gain = this.ctx.createGain();
    const filter = this.ctx.createBiquadFilter();
    gain.gain.value = 0;
    filter.type = 'bandpass';
    filter.connect(gain);

    const factory = this.ctx as BaseAudioContext & {
      createStereoPanner?: () => StereoPannerNode;
    };
    let pan: StereoPannerNode | null = null;
    if (typeof factory.createStereoPanner === 'function') {
      pan = factory.createStereoPanner();
      gain.connect(pan);
      pan.connect(this.destination);
    } else {
      gain.connect(this.destination);
    }
    return { gain, filter, pan, busyUntil: 0 };
  }

  /**
   * Pick a voice that is free at `time`, otherwise steal the one that frees up
   * soonest. Stealing is audible only under extreme density, where a dropped
   * tail is far less noticeable than a missing crackle.
   */
  acquire(time: number): GrainVoice {
    let oldest: GrainVoice | null = null;
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      if (!voice) continue;
      if (voice.busyUntil <= time) return voice;
      if (!oldest || voice.busyUntil < oldest.busyUntil) oldest = voice;
    }
    return oldest ?? this.build();
  }

  get activeCount(): number {
    const now = this.ctx.currentTime;
    let active = 0;
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      if (voice && voice.busyUntil > now) active += 1;
    }
    return active;
  }

  get capacity(): number {
    return this.voices.length;
  }

  dispose(): void {
    for (let i = 0; i < this.voices.length; i += 1) {
      const voice = this.voices[i];
      if (!voice) continue;
      try {
        voice.filter.disconnect();
        voice.gain.disconnect();
        voice.pan?.disconnect();
      } catch {
        /* already detached */
      }
    }
    this.voices.length = 0;
  }
}
