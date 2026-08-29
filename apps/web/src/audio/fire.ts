/**
 * The fire bed.
 *
 * Four continuous layers plus a stochastic crackle stream:
 *
 *  - roar   : looping pink noise through a resonant low-pass. Cutoff and gain
 *             track `intensity`; this is the body of the flame.
 *  - hiss    : looping white noise through a high-pass. Steam and wood gas
 *             escaping — loudest on a well-fuelled, moderately hot fire.
 *  - rumble : looping brown noise through a low-pass around 60-140 Hz. Only a
 *             well-fed fire has it, and it is what makes a fire feel *big*.
 *  - embers : sparse velvet noise, band-passed high. Audible when flames drop
 *             and the coal bed is doing the work.
 *  - crackle: Poisson-scheduled noise grains, band-passed, with a fast attack
 *             and an exponential tail. Rate, brightness and level all move.
 *
 * Wind is a modulator rather than a layer: an LFO at `windFlutterHz` with depth
 * `windFlutterDepth` is summed into the roar gain and the roar cutoff, which is
 * what a gust actually does to a flame.
 */

import { clamp, clamp01, lerp, mapExp, mapRange, smoothstep } from './math.js';
import type { PercussiveEnvelope } from './envelopes.js';
import { applyPercussive, safeFrequency, shapePercussive } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import { GrainVoicePool, LookaheadWindow, PoissonScheduler } from './voices.js';

/**
 * Normalised simulation state. Everything is 0..1 and is clamped on entry, so
 * the simulation is free to overshoot without producing a hostile noise.
 */
export interface FireAudioState {
  /** Flame size / combustion vigour. */
  intensity: number;
  /** How hot the coal bed is. Drives crackle brightness and the ember fizz. */
  emberHeat: number;
  /** How much unburnt fuel is stacked on. Drives rumble and hiss. */
  fuelLoad: number;
  /** Local wind. Modulates everything and raises the crackle rate. */
  windSpeed: number;
  /** Fuel dryness / resin content, i.e. how *snappy* this wood is. */
  crackleRate: number;
}

export const DEFAULT_FIRE_STATE: Readonly<FireAudioState> = Object.freeze({
  intensity: 0,
  emberHeat: 0,
  fuelLoad: 0,
  windSpeed: 0,
  crackleRate: 0.35,
});

/** The audio-side parameters `mapFireState` produces. Mutated in place; never re-allocated. */
export interface FireVoiceParams {
  roarGain: number;
  roarCutoffHz: number;
  roarQ: number;
  hissGain: number;
  hissCutoffHz: number;
  rumbleGain: number;
  rumbleCutoffHz: number;
  emberGain: number;
  emberCenterHz: number;
  crackleRatePerSecond: number;
  cracklePeakGain: number;
  crackleCenterHz: number;
  crackleBrightness: number;
  windFlutterDepth: number;
  windFlutterHz: number;
}

export function createFireVoiceParams(): FireVoiceParams {
  return {
    roarGain: 0,
    roarCutoffHz: 180,
    roarQ: 0.7,
    hissGain: 0,
    hissCutoffHz: 1800,
    rumbleGain: 0,
    rumbleCutoffHz: 60,
    emberGain: 0,
    emberCenterHz: 2400,
    crackleRatePerSecond: 0,
    cracklePeakGain: 0,
    crackleCenterHz: 1200,
    crackleBrightness: 0.5,
    windFlutterDepth: 0,
    windFlutterHz: 0.3,
  };
}

/** Upper bound on the Poisson rate, so a runaway sim value cannot melt the CPU. */
export const MAX_CRACKLE_RATE = 40;

/**
 * Pure mapping from simulation state to synthesis parameters.
 *
 * Deliberately allocation-free: the caller owns `out`, which lets the engine
 * call this every frame from the render loop without producing garbage.
 */
export function mapFireState(state: FireAudioState, out: FireVoiceParams): FireVoiceParams {
  const intensity = clamp01(state.intensity);
  const ember = clamp01(state.emberHeat);
  const fuel = clamp01(state.fuelLoad);
  const wind = clamp01(state.windSpeed);
  const snap = clamp01(state.crackleRate);

  // A gust fans the flame: slightly louder, noticeably brighter.
  const windBoost = 1 + 0.25 * wind;

  // Roar. Smoothstep at the bottom so an almost-dead fire is genuinely quiet
  // rather than a constant low hum.
  out.roarGain = clamp(0.52 * smoothstep(0.02, 0.65, intensity) * windBoost, 0, 0.75);
  out.roarCutoffHz = safeFrequency(mapExp(intensity * 0.85 + wind * 0.15, 150, 1700));
  out.roarQ = lerp(0.6, 1.5, intensity);

  // Hiss: steam and volatiles. Needs both heat and unburnt fuel, so it peaks
  // mid-burn and fades once the wood is charred.
  const volatiles = intensity * (0.35 + 0.65 * fuel);
  out.hissGain = clamp(0.2 * volatiles * windBoost, 0, 0.3);
  out.hissCutoffHz = safeFrequency(mapExp(intensity, 1600, 5200));

  // Rumble: only a properly fed, properly hot fire.
  out.rumbleGain = clamp(0.34 * fuel * smoothstep(0.25, 0.8, intensity), 0, 0.4);
  out.rumbleCutoffHz = safeFrequency(mapRange(fuel, 0, 1, 55, 145));

  // Embers take over as flames drop.
  out.emberGain = clamp(0.14 * ember * (1 - 0.55 * intensity), 0, 0.16);
  out.emberCenterHz = safeFrequency(mapExp(ember, 1800, 3600));

  // Crackle rate: a Poisson λ in events per second. Gated at the bottom so a
  // genuinely dead fire produces exactly zero events rather than one tick a
  // minute — silence is information too.
  const alive = smoothstep(0, 0.08, Math.max(intensity, ember * 0.6));
  out.crackleRatePerSecond = clamp(
    mapRange(snap, 0, 1, 0.4, 24) * alive * (0.25 + 0.75 * intensity) * (1 + 0.45 * wind),
    0,
    MAX_CRACKLE_RATE,
  );
  out.cracklePeakGain = clamp(0.22 + 0.45 * intensity * (0.5 + 0.5 * fuel), 0, 0.85);
  out.crackleCenterHz = safeFrequency(mapExp(ember * 0.7 + snap * 0.3, 850, 3200));
  out.crackleBrightness = clamp01(0.2 + 0.55 * ember + 0.25 * snap);

  // Wind modulation. Depth is how far the flame is pushed, rate is gust speed.
  out.windFlutterDepth = clamp01(wind) * 0.55 * out.roarGain;
  out.windFlutterHz = lerp(0.22, 2.8, wind);

  return out;
}

export interface FireBedOptions {
  /** Concurrent crackle voices. Beyond this, the newest crackle steals the oldest. */
  crackleVoices: number;
  /** How far ahead of the audio clock crackles are scheduled. */
  lookaheadSeconds: number;
  /** Smoothing constant for continuous parameter moves. */
  smoothingSeconds: number;
}

export const DEFAULT_FIRE_BED_OPTIONS: Readonly<FireBedOptions> = Object.freeze({
  crackleVoices: 14,
  lookaheadSeconds: 0.3,
  smoothingSeconds: 0.12,
});

export class FireBed implements PumpableLayer {
  private readonly options: FireBedOptions;
  private readonly stateValue: FireAudioState = { ...DEFAULT_FIRE_STATE };
  private readonly paramsValue = createFireVoiceParams();

  private readonly output: GainNode;
  private readonly roarGain: GainNode;
  private readonly roarFilter: BiquadFilterNode;
  private readonly hissGain: GainNode;
  private readonly hissFilter: BiquadFilterNode;
  private readonly rumbleGain: GainNode;
  private readonly rumbleFilter: BiquadFilterNode;
  private readonly emberGain: GainNode;
  private readonly emberFilter: BiquadFilterNode;
  private readonly windLfo: OscillatorNode;
  private readonly windGainDepth: GainNode;
  private readonly windCutoffDepth: GainNode;
  private readonly sources: AudioBufferSourceNode[] = [];
  private readonly crackleVoices: GrainVoicePool;
  private readonly scheduler: PoissonScheduler;
  private readonly window: LookaheadWindow;
  /** Pre-allocated: `collect` writes event times here, never into a fresh array. */
  private readonly eventTimes: Float64Array;
  private readonly crackleEnv: PercussiveEnvelope = { attack: 0.0012, decay: 0.045, peak: 0.4 };

  private started = false;
  private disposed = false;
  private crackleCount = 0;

  constructor(
    private readonly deps: LayerDeps,
    options: Partial<FireBedOptions> = {},
  ) {
    this.options = { ...DEFAULT_FIRE_BED_OPTIONS, ...options };
    const ctx = deps.ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);

    // --- roar -------------------------------------------------------------
    this.roarFilter = ctx.createBiquadFilter();
    this.roarFilter.type = 'lowpass';
    this.roarFilter.frequency.value = this.paramsValue.roarCutoffHz;
    this.roarFilter.Q.value = this.paramsValue.roarQ;
    this.roarGain = ctx.createGain();
    this.roarGain.gain.value = 0;
    this.roarFilter.connect(this.roarGain);
    this.roarGain.connect(this.output);

    // --- hiss -------------------------------------------------------------
    this.hissFilter = ctx.createBiquadFilter();
    this.hissFilter.type = 'highpass';
    this.hissFilter.frequency.value = this.paramsValue.hissCutoffHz;
    this.hissFilter.Q.value = 0.5;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0;
    this.hissFilter.connect(this.hissGain);
    this.hissGain.connect(this.output);

    // --- rumble -----------------------------------------------------------
    this.rumbleFilter = ctx.createBiquadFilter();
    this.rumbleFilter.type = 'lowpass';
    this.rumbleFilter.frequency.value = this.paramsValue.rumbleCutoffHz;
    this.rumbleFilter.Q.value = 0.9;
    this.rumbleGain = ctx.createGain();
    this.rumbleGain.gain.value = 0;
    this.rumbleFilter.connect(this.rumbleGain);
    this.rumbleGain.connect(this.output);

    // --- embers -----------------------------------------------------------
    this.emberFilter = ctx.createBiquadFilter();
    this.emberFilter.type = 'bandpass';
    this.emberFilter.frequency.value = this.paramsValue.emberCenterHz;
    this.emberFilter.Q.value = 1.4;
    this.emberGain = ctx.createGain();
    this.emberGain.gain.value = 0;
    this.emberFilter.connect(this.emberGain);
    this.emberGain.connect(this.output);

    // --- wind modulation --------------------------------------------------
    // Summed into the roar's gain and cutoff params. WebAudio adds connected
    // signals to a param's automation value, so this coexists with the
    // setTargetAtTime moves that `setState` makes.
    this.windLfo = ctx.createOscillator();
    this.windLfo.type = 'sine';
    this.windLfo.frequency.value = this.paramsValue.windFlutterHz;
    this.windGainDepth = ctx.createGain();
    this.windGainDepth.gain.value = 0;
    this.windCutoffDepth = ctx.createGain();
    this.windCutoffDepth.gain.value = 0;
    this.windLfo.connect(this.windGainDepth);
    this.windLfo.connect(this.windCutoffDepth);
    this.windGainDepth.connect(this.roarGain.gain);
    this.windCutoffDepth.connect(this.roarFilter.frequency);

    this.crackleVoices = new GrainVoicePool(ctx, this.output, this.options.crackleVoices);
    this.scheduler = new PoissonScheduler(deps.rng);
    this.window = new LookaheadWindow(this.options.lookaheadSeconds);
    this.eventTimes = new Float64Array(Math.max(8, this.options.crackleVoices * 2));
  }

  get state(): Readonly<FireAudioState> {
    return this.stateValue;
  }

  get params(): Readonly<FireVoiceParams> {
    return this.paramsValue;
  }

  get running(): boolean {
    return this.started;
  }

  /** Total crackles scheduled since construction — a cheap diagnostic. */
  get cracklesScheduled(): number {
    return this.crackleCount;
  }

  private startLoop(
    buffer: AudioBuffer,
    target: AudioNode,
    loopEnd: number,
    detune: number,
    when: number,
  ): void {
    const source = this.deps.ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopStart = 0;
    source.loopEnd = loopEnd;
    source.playbackRate.value = detune;
    source.connect(target);
    // Random start offset so the three loops never phase-lock into a pattern.
    source.start(when, this.deps.rng.range(0, Math.max(loopEnd - 0.01, 0.01)));
    this.sources.push(source);
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const ctx = this.deps.ctx;
    const bank = this.deps.bank;
    const now = ctx.currentTime;

    this.startLoop(bank.loop('pink'), this.roarFilter, bank.loopEnd('pink'), 1, now);
    this.startLoop(bank.loop('white'), this.hissFilter, bank.loopEnd('white'), 1, now);
    this.startLoop(bank.loop('brown'), this.rumbleFilter, bank.loopEnd('brown'), 0.85, now);
    this.startLoop(bank.velvet(700), this.emberFilter, bank.loopEnd('white'), 1, now);
    this.windLfo.start(now);

    this.window.reset(now);
    this.scheduler.setRate(this.paramsValue.crackleRatePerSecond, now);
  }

  stop(fadeSeconds = 0.4): void {
    if (!this.started) return;
    this.started = false;
    const now = this.deps.ctx.currentTime;
    const end = now + Math.max(fadeSeconds, 0.01);
    this.output.gain.cancelScheduledValues(now);
    this.output.gain.setValueAtTime(this.output.gain.value, now);
    this.output.gain.linearRampToValueAtTime(0, end);
    for (let i = 0; i < this.sources.length; i += 1) safeStop(this.sources[i], end);
    this.sources.length = 0;
    safeStop(this.windLfo, end);
    this.scheduler.setRate(0, now);
  }

  /**
   * Hot path. Called every simulation frame; allocates nothing. Partial state
   * is merged so callers can push only what changed.
   */
  setState(next: Partial<FireAudioState>): void {
    if (this.disposed) return;
    if (next.intensity !== undefined) this.stateValue.intensity = clamp01(next.intensity);
    if (next.emberHeat !== undefined) this.stateValue.emberHeat = clamp01(next.emberHeat);
    if (next.fuelLoad !== undefined) this.stateValue.fuelLoad = clamp01(next.fuelLoad);
    if (next.windSpeed !== undefined) this.stateValue.windSpeed = clamp01(next.windSpeed);
    if (next.crackleRate !== undefined) this.stateValue.crackleRate = clamp01(next.crackleRate);

    const p = mapFireState(this.stateValue, this.paramsValue);
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const tc = this.options.smoothingSeconds;

    this.roarGain.gain.setTargetAtTime(p.roarGain, now, tc);
    this.roarFilter.frequency.setTargetAtTime(p.roarCutoffHz, now, tc);
    this.roarFilter.Q.setTargetAtTime(p.roarQ, now, tc);
    this.hissGain.gain.setTargetAtTime(p.hissGain, now, tc);
    this.hissFilter.frequency.setTargetAtTime(p.hissCutoffHz, now, tc);
    this.rumbleGain.gain.setTargetAtTime(p.rumbleGain, now, tc);
    this.rumbleFilter.frequency.setTargetAtTime(p.rumbleCutoffHz, now, tc);
    this.emberGain.gain.setTargetAtTime(p.emberGain, now, tc);
    this.emberFilter.frequency.setTargetAtTime(p.emberCenterHz, now, tc);

    this.windLfo.frequency.setTargetAtTime(p.windFlutterHz, now, 0.5);
    this.windGainDepth.gain.setTargetAtTime(p.windFlutterDepth, now, tc);
    this.windCutoffDepth.gain.setTargetAtTime(p.roarCutoffHz * 0.45 * clamp01(this.stateValue.windSpeed), now, tc);

    this.scheduler.setRate(p.crackleRatePerSecond, now);
  }

  /**
   * Schedule crackles into the look-ahead window. Safe to call at any rate;
   * `LookaheadWindow` collapses long gaps so a backgrounded tab does not
   * produce a burst on return.
   */
  pump(now: number): number {
    if (!this.started || this.disposed) return 0;
    const horizon = this.window.advance(now);
    if (horizon === null) return 0;
    const count = this.scheduler.collect(horizon, this.eventTimes);
    for (let i = 0; i < count; i += 1) {
      this.spawnCrackle(this.eventTimes[i] ?? now);
    }
    this.crackleCount += count;
    return count;
  }

  /** Fire a single crackle immediately — used by gameplay pokes (a log settling). */
  crackleNow(scale = 1): void {
    if (this.disposed) return;
    this.spawnCrackle(this.deps.ctx.currentTime + 0.005, scale);
  }

  private spawnCrackle(time: number, scale = 1): void {
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const p = this.paramsValue;
    const voice = this.crackleVoices.acquire(time);

    // ~9% of events are a bigger, duller "pop" — a pocket of sap letting go.
    const isPop = rng.next() < 0.09;
    const brightness = clamp01(
      (isPop ? p.crackleBrightness * 0.35 : p.crackleBrightness) + rng.gaussian() * 0.12,
    );

    const source = ctx.createBufferSource();
    source.buffer = this.deps.bank.grainForBrightness(brightness);
    source.playbackRate.value = isPop ? rng.range(0.45, 0.75) : rng.range(0.8, 1.7);

    voice.filter.type = 'bandpass';
    voice.filter.frequency.value = safeFrequency(
      p.crackleCenterHz * (isPop ? rng.range(0.3, 0.55) : rng.range(0.7, 1.5)),
      ctx.sampleRate,
    );
    voice.filter.Q.value = isPop ? rng.range(0.5, 1.1) : rng.range(0.8, 2.6);
    voice.pan?.pan.setValueAtTime(rng.range(-0.7, 0.7), time);

    this.crackleEnv.attack = isPop ? 0.004 : 0.0012;
    this.crackleEnv.decay = isPop ? rng.range(0.09, 0.18) : rng.range(0.015, 0.06);
    this.crackleEnv.peak = clamp(
      p.cracklePeakGain * scale * (isPop ? rng.range(0.8, 1.4) : rng.range(0.25, 1)),
      0,
      1,
    );
    const shaped = shapePercussive(this.crackleEnv, this.deps.mixer.shaping);
    const end = applyPercussive(voice.gain.gain, time, shaped);

    source.connect(voice.filter);
    source.start(time);
    source.stop(end + 0.02);
    voice.busyUntil = end;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stop(0.05);
    this.disposed = true;
    this.crackleVoices.dispose();
    safeDisconnect(this.roarFilter);
    safeDisconnect(this.roarGain);
    safeDisconnect(this.hissFilter);
    safeDisconnect(this.hissGain);
    safeDisconnect(this.rumbleFilter);
    safeDisconnect(this.rumbleGain);
    safeDisconnect(this.emberFilter);
    safeDisconnect(this.emberGain);
    safeDisconnect(this.windLfo);
    safeDisconnect(this.windGainDepth);
    safeDisconnect(this.windCutoffDepth);
    safeDisconnect(this.output);
  }
}
