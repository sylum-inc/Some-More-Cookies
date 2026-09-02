/**
 * SM-01 machine kit — late-1990s industrial refrigeration.
 *
 * The design brief for this kit: nothing here should sound like a game. Real
 * appliances of that era are built from a small number of physical events —
 * a solenoid throwing, a contactor closing, an induction motor pulling in, air
 * moving through a squirrel-cage fan, refrigerant finding its way through a
 * capillary — and each of those has a recognisable acoustic signature.
 *
 * Techniques used here:
 *
 *  - **Modal synthesis** for metal. A noise excitation is fed through parallel
 *    high-Q band-passes tuned to *inharmonic* partials. Harmonic partials sound
 *    like a bell or a note; inharmonic ones sound like a struck steel panel.
 *  - **Two-stage transients.** Heavy mechanisms travel before they arrive. The
 *    latch is a bright travel/scrape transient, a gap, then the thunk. That gap
 *    is most of what makes it read as heavy.
 *  - **Contact bounce.** Relay contacts chatter for a millisecond or two. Three
 *    decaying micro-ticks is the difference between "relay" and "click".
 *  - **Slip and drift.** An induction motor never sits exactly on its nominal
 *    frequency and never holds it exactly. The hum glides in during start-up
 *    and then drifts by a fraction of a percent forever.
 *  - **Electrical vs mechanical.** The hum has both a mechanical fundamental
 *    and a mains-ripple component at twice line frequency; keeping them
 *    separate (and slightly out of tune with each other) is what stops it
 *    sounding like a synthesiser pad.
 */

import { clamp, clamp01, mapExp } from './math.js';
import { safeFrequency } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import { Synth } from './synth.js';
import { LookaheadWindow, PoissonScheduler } from './voices.js';

/* -------------------------------------------------------------------------- */
/* Pure specification data                                                     */
/* -------------------------------------------------------------------------- */

export interface RelayCharacter {
  id: string;
  /** Low thump of the coil pulling the armature in. */
  coilHz: number;
  coilPeak: number;
  /** Bright band where the contacts actually snap. */
  contactHz: number;
  contactQ: number;
  contactPeak: number;
  /** Exponential decay time-constant of the contact tick. */
  decay: number;
  /** Number of bounce ticks after the first contact. */
  bounces: number;
  /** Spacing between bounces, in seconds. */
  bounceSpacing: number;
}

/**
 * Five physically distinguishable relays. The player is expected to learn these
 * by ear (which one just fired tells you what the machine is doing), so they
 * differ in register, brightness, bounce count and decay — not just in pitch.
 */
export const RELAY_CHARACTERS: readonly RelayCharacter[] = Object.freeze([
  // Big contactor: heavy coil thump, few bounces, long-ish ring.
  { id: 'contactor', coilHz: 78, coilPeak: 0.34, contactHz: 1750, contactQ: 3.2, contactPeak: 0.4, decay: 0.028, bounces: 1, bounceSpacing: 0.0042 },
  // Control relay: mid, chattery, three bounces.
  { id: 'control', coilHz: 132, coilPeak: 0.2, contactHz: 3100, contactQ: 4.5, contactPeak: 0.46, decay: 0.013, bounces: 3, bounceSpacing: 0.0021 },
  // Defrost timer relay: dull, slow, almost no bounce.
  { id: 'defrost', coilHz: 96, coilPeak: 0.27, contactHz: 1180, contactQ: 2.4, contactPeak: 0.3, decay: 0.034, bounces: 0, bounceSpacing: 0.003 },
  // Small reed-ish relay: quiet, very bright, very fast.
  { id: 'reed', coilHz: 210, coilPeak: 0.1, contactHz: 5200, contactQ: 6, contactPeak: 0.33, decay: 0.006, bounces: 2, bounceSpacing: 0.0013 },
  // Solid mechanical interlock: low and abrupt with a single hard bounce.
  { id: 'interlock', coilHz: 62, coilPeak: 0.4, contactHz: 900, contactQ: 2, contactPeak: 0.38, decay: 0.045, bounces: 1, bounceSpacing: 0.0065 },
]);

export function relayCharacter(index: number): RelayCharacter {
  const list = RELAY_CHARACTERS;
  const first = list[0];
  if (!first) throw new Error('RELAY_CHARACTERS is empty');
  if (list.length === 0) return first;
  const i = ((Math.trunc(index) % list.length) + list.length) % list.length;
  return list[i] ?? first;
}

export const RELAY_COUNT = RELAY_CHARACTERS.length;

export type BeepKind = 'confirm' | 'deny' | 'nudge' | 'tick';

export const BEEP_KINDS: readonly BeepKind[] = ['confirm', 'deny', 'nudge', 'tick'];

export interface BeepSpec {
  /** Frequencies of each repeat, in order. */
  steps: readonly number[];
  /** Length of one beep. */
  durationSeconds: number;
  /** Silence between beeps. */
  gapSeconds: number;
  peak: number;
  /** Low-pass placed after the oscillator; keeps a square from being shrill. */
  filterHz: number;
  wave: OscillatorType;
}

/**
 * A deliberately small, restrained utility set. All of these are low-mid, short
 * and quiet: a panel beeper from 1997, not a notification sound.
 */
export const BEEP_SPECS: Readonly<Record<BeepKind, BeepSpec>> = Object.freeze({
  // Flat, matter-of-fact acknowledgement.
  confirm: { steps: [880], durationSeconds: 0.075, gapSeconds: 0, peak: 0.26, filterHz: 2600, wave: 'square' },
  // Two low beeps, falling. Reads as "no" without being punitive.
  deny: { steps: [392, 330], durationSeconds: 0.09, gapSeconds: 0.055, peak: 0.24, filterHz: 1800, wave: 'square' },
  // A single soft prompt, higher and quieter.
  nudge: { steps: [1175], durationSeconds: 0.05, gapSeconds: 0, peak: 0.16, filterHz: 3200, wave: 'triangle' },
  // Sub-audible-length blip for counters and increments.
  tick: { steps: [1568], durationSeconds: 0.018, gapSeconds: 0, peak: 0.12, filterHz: 4200, wave: 'square' },
});

export interface FanCurve {
  cutoffHz: number;
  level: number;
  bladeHz: number;
  bladeLevel: number;
}

export function createFanCurve(): FanCurve {
  return { cutoffHz: 300, level: 0, bladeHz: 0, bladeLevel: 0 };
}

/** Nominal fan speed at full tilt, in RPM, and the blade count of an SM-01 impeller. */
export const FAN_MAX_RPM = 1450;
export const FAN_BLADES = 7;

/**
 * Fan speed (0..1) to synthesis parameters. Air noise rises faster than the
 * blade tone at the bottom of the range and the blade tone dominates at the top,
 * which is how a squirrel-cage blower actually behaves.
 */
export function fanCurve(targetSpeed: number, out: FanCurve = createFanCurve()): FanCurve {
  const s = clamp01(targetSpeed);
  out.level = 0.34 * Math.pow(s, 1.15);
  out.cutoffHz = safeFrequency(mapExp(s, 260, 5200));
  // A stopped impeller has no blade-pass tone at all.
  out.bladeHz = s <= 0 ? 0 : safeFrequency(((s * FAN_MAX_RPM) / 60) * FAN_BLADES, 48000);
  out.bladeLevel = 0.055 * s * s;
  return out;
}

/** Frost tick rate (events/second) from frost coverage. Superlinear: frost accelerates. */
export function frostTickRate(intensity: number): number {
  const i = clamp01(intensity);
  if (i <= 0) return 0;
  return clamp(0.35 + 13 * Math.pow(i, 1.6), 0, 18);
}

/** Relative amplitudes of the compressor's mechanical partials. */
export const COMPRESSOR_HARMONICS: readonly { ratio: number; gain: number }[] = Object.freeze([
  { ratio: 1, gain: 1 },
  { ratio: 2, gain: 0.42 },
  { ratio: 3, gain: 0.2 },
  { ratio: 4, gain: 0.11 },
  { ratio: 6, gain: 0.05 },
]);

/**
 * A 4-pole induction motor on a 60 Hz supply runs a little under 30 rev/s under
 * load; mains ripple sits at twice line frequency. Returns both, in Hz.
 */
export function compressorFrequencies(mainsHz = 60, slip = 0.035): { mechanicalHz: number; rippleHz: number } {
  const synchronous = mainsHz / 2; // 4-pole
  return { mechanicalHz: synchronous * (1 - clamp01(slip)), rippleHz: mainsHz * 2 };
}

/* -------------------------------------------------------------------------- */
/* Kit                                                                         */
/* -------------------------------------------------------------------------- */

export interface MachineKitOptions {
  mainsHz: number;
  /** Seconds a fan ramp takes to reach its target. */
  fanRampSeconds: number;
  /** Frequency of the CRT whine. Real flyback is 15.7 kHz; that is painful and
   *  inaudible to many adults, so we voice it an octave down where it still
   *  reads as "a monitor is on in here". */
  crtWhineHz: number;
  crtWhineGain: number;
  lookaheadSeconds: number;
}

export const DEFAULT_MACHINE_OPTIONS: Readonly<MachineKitOptions> = Object.freeze({
  mainsHz: 60,
  fanRampSeconds: 1.4,
  crtWhineHz: 8400,
  crtWhineGain: 0.012,
  lookaheadSeconds: 0.3,
});

interface ContinuousChain {
  gain: GainNode;
  nodes: AudioNode[];
  sources: AudioScheduledSourceNode[];
}

export class MachineKit implements PumpableLayer {
  private readonly options: MachineKitOptions;
  private readonly output: GainNode;
  private readonly synth: Synth;
  private readonly fanState: FanCurve = createFanCurve();

  private compressor: ContinuousChain | null = null;
  private compressorPitch: AudioParam[] = [];
  private fan: ContinuousChain | null = null;
  private fanFilter: BiquadFilterNode | null = null;
  private fanBlade: OscillatorNode | null = null;
  private fanBladeGain: GainNode | null = null;
  private crt: ContinuousChain | null = null;

  private readonly frostScheduler: PoissonScheduler;
  private readonly frostWindow: LookaheadWindow;
  private readonly frostTimes = new Float64Array(24);
  private frostIntensityValue = 0;
  private compressorRunningValue = false;
  private fanSpeedValue = 0;
  private crtOnValue = false;
  private disposed = false;

  constructor(
    private readonly deps: LayerDeps,
    options: Partial<MachineKitOptions> = {},
  ) {
    this.options = { ...DEFAULT_MACHINE_OPTIONS, ...options };
    this.output = deps.ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);
    this.synth = new Synth(deps, this.output);
    this.frostScheduler = new PoissonScheduler(deps.rng);
    this.frostWindow = new LookaheadWindow(this.options.lookaheadSeconds);
    this.frostWindow.reset(deps.ctx.currentTime);
  }

  /* ---------------------------------------------------------------- utils */

  /** Never schedule in the past; a few ms of slack avoids glitching. */
  private at(when?: number): number {
    return this.synth.at(when);
  }

  /* -------------------------------------------------------------- one-shots */

  /**
   * Heavy two-stage latch.
   *
   * Stage 1 (t+0): the handle travels — a short bright scrape, band-passed
   * around 2.6 kHz and swept downward as the mechanism moves.
   * Stage 2 (t+70 ms): arrival — a 90→52 Hz thunk, a broadband impact and a
   * long inharmonic steel-panel ring. The 70 ms gap is what sells the mass.
   */
  latchClunk(when?: number): number {
    const t = this.at(when);
    const rng = this.deps.rng;

    // Stage 1: mechanical travel.
    this.synth.noiseBurst(t, 2600, 1.6, 0.004, 0.02, 0.2, 'bandpass', 1300);
    this.synth.noiseBurst(t + 0.012, 4200, 3, 0.001, 0.008, 0.1);

    // Stage 2: arrival.
    const impact = t + 0.07 + rng.range(-0.006, 0.006);
    this.synth.thump(impact, 92, 52, 0.045, 0.09, 0.5);
    this.synth.noiseBurst(impact, 320, 0.9, 0.001, 0.03, 0.34, 'lowpass');
    const end = this.synth.modalRing(impact + 0.002, [148, 331, 517, 883, 1291], 26, 0.28, 0.3);
    return end;
  }

  /** Small crisp panel switch: one sharp tick with a short plastic-body ping. */
  switchDetent(when?: number): number {
    const t = this.at(when);
    this.synth.noiseBurst(t, 3400, 2.4, 0.0006, 0.004, 0.28);
    const end = this.synth.modalRing(t + 0.0008, [1820, 2960], 14, 0.016, 0.18);
    // The return spring, a hair later and much quieter.
    this.synth.noiseBurst(t + 0.021, 2800, 3, 0.0005, 0.0025, 0.07);
    return end;
  }

  /** One of `RELAY_COUNT` distinguishable relays: coil thump, contact snap, bounce. */
  relayClick(index = 0, when?: number): number {
    const t = this.at(when);
    const relay = relayCharacter(index);
    const rng = this.deps.rng;

    // Coil pulling in — a soft low thud just before contact.
    this.synth.thump(t, relay.coilHz * 1.35, relay.coilHz, 0.012, 0.022, relay.coilPeak);

    // Contact snap plus bounce chatter, each bounce quieter and faster.
    let end = t;
    const contactTime = t + 0.006;
    for (let b = 0; b <= relay.bounces; b += 1) {
      const bounceTime = contactTime + b * relay.bounceSpacing * rng.range(0.8, 1.25);
      const peak = relay.contactPeak * Math.pow(0.45, b);
      end = Math.max(
        end,
        this.synth.noiseBurst(
          bounceTime,
          relay.contactHz * rng.range(0.95, 1.06),
          relay.contactQ,
          0.0004,
          relay.decay * Math.pow(0.7, b),
          peak,
        ),
      );
    }
    return end;
  }

  /* ------------------------------------------------------------ compressor */

  get compressorRunning(): boolean {
    return this.compressorRunningValue;
  }

  /**
   * Start-up: contactor clunk, then the motor pulls in — the mechanical
   * fundamental glides up from roughly half speed to running speed over ~1.1 s
   * while a broadband surge fades away, leaving a settled hum with harmonics,
   * mains ripple and a permanent slow pitch drift.
   */
  compressorStart(when?: number): void {
    if (this.disposed || this.compressorRunningValue) return;
    const t = this.at(when);
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const { mechanicalHz, rippleHz } = compressorFrequencies(this.options.mainsHz);

    // The contactor closing is a real, separate, audible event.
    this.relayClick(0, t);

    const bus = ctx.createGain();
    bus.gain.value = 0.0001;
    bus.connect(this.output);
    const nodes: AudioNode[] = [bus];
    const sources: AudioScheduledSourceNode[] = [];
    this.compressorPitch = [];

    // Body resonance of the compressor can: everything goes through it.
    const body = ctx.createBiquadFilter();
    body.type = 'lowpass';
    body.frequency.value = 900;
    body.Q.value = 1.1;
    body.connect(bus);
    nodes.push(body);

    const peaking = ctx.createBiquadFilter();
    peaking.type = 'peaking';
    peaking.frequency.value = 212; // the can's own resonance
    peaking.Q.value = 4;
    peaking.gain.value = 7;
    peaking.connect(body);
    nodes.push(peaking);

    const spinUp = 1.1;
    for (let i = 0; i < COMPRESSOR_HARMONICS.length; i += 1) {
      const partial = COMPRESSOR_HARMONICS[i];
      if (!partial) continue;
      const osc = ctx.createOscillator();
      osc.type = i === 0 ? 'sawtooth' : 'sine';
      const target = mechanicalHz * partial.ratio;
      osc.frequency.setValueAtTime(safeFrequency(target * 0.42, ctx.sampleRate), t);
      osc.frequency.exponentialRampToValueAtTime(safeFrequency(target, ctx.sampleRate), t + spinUp);
      osc.detune.value = rng.range(-8, 8);
      const g = ctx.createGain();
      g.gain.value = partial.gain * 0.14;
      osc.connect(g);
      g.connect(peaking);
      osc.start(t);
      sources.push(osc);
      nodes.push(g);
      this.compressorPitch.push(osc.frequency);
    }

    // Mains ripple: electrical, not mechanical, so it does not glide.
    const ripple = ctx.createOscillator();
    ripple.type = 'sine';
    ripple.frequency.value = rippleHz;
    const rippleGain = ctx.createGain();
    rippleGain.gain.value = 0.045;
    ripple.connect(rippleGain);
    rippleGain.connect(body);
    ripple.start(t);
    sources.push(ripple);
    nodes.push(rippleGain);

    // Mechanical noise floor: valve chatter and casing rattle.
    const rattleFilter = ctx.createBiquadFilter();
    rattleFilter.type = 'bandpass';
    rattleFilter.frequency.value = 420;
    rattleFilter.Q.value = 0.8;
    const rattleGain = ctx.createGain();
    rattleGain.gain.value = 0.05;
    rattleFilter.connect(rattleGain);
    rattleGain.connect(bus);
    const rattle = ctx.createBufferSource();
    rattle.buffer = this.deps.bank.loop('brown');
    rattle.loop = true;
    rattle.loopEnd = this.deps.bank.loopEnd('brown');
    rattle.connect(rattleFilter);
    rattle.start(t);
    sources.push(rattle);
    nodes.push(rattleFilter, rattleGain);

    // Permanent slow drift: a real motor never holds an exact speed.
    const drift = ctx.createOscillator();
    drift.type = 'sine';
    drift.frequency.value = 0.063;
    const driftDepth = ctx.createGain();
    driftDepth.gain.value = mechanicalHz * 0.004;
    drift.connect(driftDepth);
    for (let i = 0; i < this.compressorPitch.length; i += 1) {
      const param = this.compressorPitch[i];
      if (param) driftDepth.connect(param);
    }
    drift.start(t);
    sources.push(drift);
    nodes.push(driftDepth);

    // Start-up surge, then settle.
    const shaping = this.deps.mixer.shaping;
    const settled = Math.min(0.7 * shaping.peakScale, shaping.ceiling);
    bus.gain.setValueAtTime(0.0001, t);
    bus.gain.exponentialRampToValueAtTime(Math.min(1, settled * 1.6), t + 0.16 * shaping.attackScale);
    bus.gain.exponentialRampToValueAtTime(settled, t + spinUp + 0.5);

    this.synth.noiseBurst(t + 0.01, 180, 0.7, 0.02, 0.35, 0.22 * shaping.peakScale, 'lowpass', 90);

    this.compressor = { gain: bus, nodes, sources };
    this.compressorRunningValue = true;
  }

  /** Shut-down: contactor drops out, the hum droops and dies, refrigerant equalises. */
  compressorStop(when?: number): void {
    const chain = this.compressor;
    if (!chain || this.disposed) return;
    const t = this.at(when);
    const ctx = this.deps.ctx;

    this.relayClick(0, t);

    const coast = 0.75;
    for (let i = 0; i < this.compressorPitch.length; i += 1) {
      const param = this.compressorPitch[i];
      if (!param) continue;
      param.cancelScheduledValues(t);
      param.setValueAtTime(Math.max(param.value, 1), t);
      param.exponentialRampToValueAtTime(Math.max(param.value * 0.35, 1), t + coast);
    }

    chain.gain.gain.cancelScheduledValues(t);
    chain.gain.gain.setValueAtTime(Math.max(chain.gain.gain.value, 0.0001), t);
    chain.gain.gain.exponentialRampToValueAtTime(0.0001, t + coast);
    chain.gain.gain.setValueAtTime(0, t + coast + 0.01);

    for (let i = 0; i < chain.sources.length; i += 1) safeStop(chain.sources[i], t + coast + 0.05);
    const nodes = chain.nodes;
    // Pressure equalising through the capillary once the motor stops.
    this.refrigerantFlow(t + coast * 0.6, 0.55);

    this.compressor = null;
    this.compressorPitch = [];
    this.compressorRunningValue = false;
    // Detach once the sources have actually stopped, so the graph can collect them.
    this.synth.cleanupLater([...nodes, chain.gain], coast + 0.3);
  }

  /* ------------------------------------------------------------------- fan */

  get fanSpeed(): number {
    return this.fanSpeedValue;
  }

  get fanParams(): Readonly<FanCurve> {
    return this.fanState;
  }

  /**
   * Broadband air noise whose cutoff and level ramp to `targetSpeed`, plus a
   * faint blade-passing tone at `blades * rpm / 60`.
   */
  fanRamp(targetSpeed: number, rampSeconds = this.options.fanRampSeconds): void {
    if (this.disposed) return;
    const speed = clamp01(targetSpeed);
    this.fanSpeedValue = speed;
    const ctx = this.deps.ctx;
    const t = this.at();
    const ramp = Math.max(rampSeconds, 0.05);
    fanCurve(speed, this.fanState);

    if (!this.fan) {
      if (speed <= 0) return;
      const bus = ctx.createGain();
      bus.gain.value = 0.0001;
      bus.connect(this.output);

      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 260;
      filter.Q.value = 0.6;
      filter.connect(bus);

      const air = ctx.createBufferSource();
      air.buffer = this.deps.bank.loop('pink');
      air.loop = true;
      air.loopEnd = this.deps.bank.loopEnd('pink');
      air.connect(filter);
      air.start(t);

      const blade = ctx.createOscillator();
      blade.type = 'triangle';
      blade.frequency.value = safeFrequency(Math.max(this.fanState.bladeHz, 20), ctx.sampleRate);
      const bladeGain = ctx.createGain();
      bladeGain.gain.value = 0.0001;
      blade.connect(bladeGain);
      bladeGain.connect(bus);
      blade.start(t);

      this.fan = { gain: bus, nodes: [filter, bladeGain], sources: [air, blade] };
      this.fanFilter = filter;
      this.fanBlade = blade;
      this.fanBladeGain = bladeGain;
    }

    const fan = this.fan;
    if (!fan) return;
    const shaping = this.deps.mixer.shaping;
    const level = Math.max(this.fanState.level * shaping.peakScale, 0.0001);
    fan.gain.gain.cancelScheduledValues(t);
    fan.gain.gain.setValueAtTime(Math.max(fan.gain.gain.value, 0.0001), t);
    fan.gain.gain.exponentialRampToValueAtTime(level, t + ramp);
    this.fanFilter?.frequency.setTargetAtTime(this.fanState.cutoffHz, t, ramp / 3);
    this.fanBlade?.frequency.setTargetAtTime(Math.max(this.fanState.bladeHz, 20), t, ramp / 3);
    this.fanBladeGain?.gain.setTargetAtTime(Math.max(this.fanState.bladeLevel, 0.00001), t, ramp / 3);

    if (speed <= 0) {
      // Spin down and free the nodes once the impeller has actually stopped.
      const stopAt = t + ramp + 0.15;
      for (let i = 0; i < fan.sources.length; i += 1) safeStop(fan.sources[i], stopAt);
      this.synth.cleanupLater([...fan.nodes, fan.gain], ramp + 0.3);
      this.fan = null;
      this.fanFilter = null;
      this.fanBlade = null;
      this.fanBladeGain = null;
    }
  }

  /* -------------------------------------------------------- refrigerant/ice */

  /**
   * Refrigerant moving through the capillary: a band-passed velvet-noise hiss
   * with a wandering centre, plus a handful of descending resonant "bloops"
   * where liquid slugs pass a bend.
   */
  refrigerantFlow(when?: number, durationSeconds = 2.2): number {
    if (this.disposed) return 0;
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const t = this.at(when);
    const dur = clamp(durationSeconds, 0.2, 8);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 1400;
    filter.Q.value = 2.6;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    filter.connect(gain);
    gain.connect(this.output);

    const shaping = this.deps.mixer.shaping;
    const peak = Math.min(0.17 * shaping.peakScale, shaping.ceiling);
    gain.gain.setValueAtTime(0, t);
    gain.gain.linearRampToValueAtTime(peak, t + 0.12 * shaping.attackScale);
    gain.gain.setTargetAtTime(0, t + dur * 0.55, dur * 0.22);
    gain.gain.setValueAtTime(0, t + dur + 0.3);

    // Wandering centre frequency: this is the "movement inside pipes".
    const wobble = ctx.createOscillator();
    wobble.type = 'sine';
    wobble.frequency.value = rng.range(0.6, 1.8);
    const wobbleDepth = ctx.createGain();
    wobbleDepth.gain.value = 700;
    wobble.connect(wobbleDepth);
    wobbleDepth.connect(filter.frequency);
    wobble.start(t);
    wobble.stop(t + dur + 0.35);

    const source = ctx.createBufferSource();
    source.buffer = this.deps.bank.velvet(2400);
    source.loop = true;
    source.loopEnd = this.deps.bank.loopEnd('white');
    source.connect(filter);
    source.start(t);
    source.stop(t + dur + 0.35);

    // Gurgles: short descending resonances.
    const gurgles = rng.int(3, 6);
    for (let i = 0; i < gurgles; i += 1) {
      const at = t + rng.range(0.05, dur * 0.85);
      const from = rng.range(520, 1100);
      this.synth.thump(at, from, from * rng.range(0.4, 0.65), 0.09, 0.055, 0.09 * shaping.peakScale, 'sine');
    }
    return t + dur + 0.35;
  }

  get frostIntensity(): number {
    return this.frostIntensityValue;
  }

  /**
   * Frost growth. Sets a Poisson rate for tiny high-frequency ticks; the ticks
   * themselves are scheduled by `pump`. 0 stops it entirely.
   */
  frostCrackle(intensity: number): void {
    this.frostIntensityValue = clamp01(intensity);
    this.frostScheduler.setRate(frostTickRate(this.frostIntensityValue), this.deps.ctx.currentTime);
  }

  pump(now: number): number {
    if (this.disposed) return 0;
    const horizon = this.frostWindow.advance(now);
    if (horizon === null) return 0;
    const count = this.frostScheduler.collect(horizon, this.frostTimes);
    const rng = this.deps.rng;
    for (let i = 0; i < count; i += 1) {
      const t = this.frostTimes[i] ?? now;
      // Very short, very high, very quiet — ice is a tiny sound.
      this.synth.noiseBurst(
        t,
        rng.range(5200, 11000),
        rng.range(6, 14),
        0.0003,
        rng.range(0.0025, 0.009),
        rng.range(0.05, 0.14) * (0.4 + 0.6 * this.frostIntensityValue),
      );
    }
    return count;
  }

  /* ----------------------------------------------------------- door / vapor */

  /**
   * A heavy insulated door: the magnetic gasket peeling off the frame (a low
   * swept squelch), the latch releasing, then air rushing in to fill the void.
   */
  doorOpen(when?: number): number {
    const t = this.at(when);
    const shaping = this.deps.mixer.shaping;

    // Gasket peel: band-passed noise swept downward, slow attack.
    this.synth.noiseBurst(t, 900, 1.2, 0.03 * shaping.attackScale, 0.14, 0.2, 'bandpass', 260);
    // Seal release thump.
    this.synth.thump(t + 0.09, 120, 46, 0.06, 0.12, 0.42);
    // Latch mechanism.
    this.synth.noiseBurst(t + 0.1, 2100, 2.2, 0.001, 0.02, 0.24);
    const ring = this.synth.modalRing(t + 0.1, [96, 214, 389, 702], 18, 0.4, 0.22);
    // Air inrush behind it.
    this.synth.noiseBurst(t + 0.14, 620, 0.7, 0.09 * shaping.attackScale, 0.3, 0.16, 'lowpass', 300);
    return Math.max(ring, t + 0.9);
  }

  /** A soft pressurised exhale: fast attack, long fall, filter sweeping down. */
  vaporRelease(when?: number, strength = 1): number {
    const t = this.at(when);
    const s = clamp01(strength);
    const shaping = this.deps.mixer.shaping;
    // The initial crack of the valve.
    this.synth.noiseBurst(t, 4200, 1.4, 0.004 * shaping.attackScale, 0.05, 0.18 * s);
    // The body of the exhale, sweeping down as pressure drops.
    const end = this.synth.noiseBurst(t + 0.01, 3000, 0.9, 0.03 * shaping.attackScale, 0.42, 0.26 * s, 'bandpass', 700);
    // Low pressure component you feel more than hear.
    this.synth.thump(t, 88, 40, 0.12, 0.18, 0.16 * s);
    return end;
  }

  /* ------------------------------------------------------------ tones/beeps */

  /**
   * Completion. Deliberately not a jingle: two warm low partials, the second a
   * perfect fourth below the first, with a soft attack, a long decay and a
   * quiet relay click underneath — the sound of a machine finishing a cycle and
   * dropping its contactor, not a reward.
   */
  completionTone(when?: number): number {
    const t = this.at(when);
    const ctx = this.deps.ctx;
    const shaping = this.deps.mixer.shaping;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 2000;
    filter.Q.value = 0.7;
    const out = ctx.createGain();
    out.gain.value = 1;
    filter.connect(out);
    out.connect(this.output);

    // 523.25 Hz then 392.00 Hz — C5 down to G4.
    const steps: readonly [number, number][] = [
      [523.25, 0],
      [392.0, 0.26],
    ];
    let end = t;
    for (let i = 0; i < steps.length; i += 1) {
      const step = steps[i];
      if (!step) continue;
      const [hz, offset] = step;
      const start = t + offset;
      const dur = i === 0 ? 0.5 : 1.1;
      for (let h = 0; h < 2; h += 1) {
        const osc = ctx.createOscillator();
        osc.type = h === 0 ? 'sine' : 'triangle';
        osc.frequency.value = hz * (h + 1);
        osc.detune.value = h === 0 ? 0 : 4;
        const g = ctx.createGain();
        g.gain.value = 0;
        osc.connect(g);
        g.connect(filter);
        const peak = Math.min((h === 0 ? 0.2 : 0.05) * shaping.peakScale, shaping.ceiling);
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(peak, start + 0.03 * shaping.attackScale);
        g.gain.setTargetAtTime(0, start + 0.06, dur * 0.3);
        g.gain.setValueAtTime(0, start + dur);
        osc.start(start);
        osc.stop(start + dur + 0.05);
        end = Math.max(end, start + dur);
      }
    }
    // The cycle actually ending.
    this.relayClick(2, t + 0.02);
    return end;
  }

  /** A restrained utility beep. */
  beep(kind: BeepKind = 'confirm', when?: number): number {
    const t = this.at(when);
    const ctx = this.deps.ctx;
    const spec = BEEP_SPECS[kind];
    const shaping = this.deps.mixer.shaping;

    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = spec.filterHz;
    filter.Q.value = 0.7;
    const out = ctx.createGain();
    out.gain.value = 1;
    filter.connect(out);
    out.connect(this.output);

    let end = t;
    for (let i = 0; i < spec.steps.length; i += 1) {
      const hz = spec.steps[i];
      if (hz === undefined) continue;
      const start = t + i * (spec.durationSeconds + spec.gapSeconds);
      const osc = ctx.createOscillator();
      osc.type = spec.wave;
      osc.frequency.value = safeFrequency(hz, ctx.sampleRate);
      const g = ctx.createGain();
      g.gain.value = 0;
      osc.connect(g);
      g.connect(filter);
      const peak = Math.min(spec.peak * shaping.peakScale, shaping.ceiling);
      // 2 ms edges: enough to kill the click, short enough to stay crisp.
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(peak, start + 0.002 * shaping.attackScale);
      g.gain.setValueAtTime(peak, start + spec.durationSeconds - 0.003);
      g.gain.linearRampToValueAtTime(0, start + spec.durationSeconds);
      osc.start(start);
      osc.stop(start + spec.durationSeconds + 0.01);
      end = start + spec.durationSeconds;
    }
    return end;
  }

  get crtOn(): boolean {
    return this.crtOnValue;
  }

  /**
   * The panel CRT. Voiced at ~8.4 kHz rather than a true 15.7 kHz flyback:
   * the real frequency is inaudible to many adults and painful to the rest,
   * and this reads as the same thing at a tenth of the annoyance. Kept very
   * quiet, with a slow amplitude wobble so it never sits perfectly still.
   */
  crtWhine(on: boolean): void {
    if (this.disposed) return;
    const ctx = this.deps.ctx;
    const t = this.at();
    this.crtOnValue = on;

    if (on) {
      if (!this.crt) {
        const bus = ctx.createGain();
        bus.gain.value = 0.00001;
        bus.connect(this.output);

        const osc = ctx.createOscillator();
        osc.type = 'sine';
        osc.frequency.value = safeFrequency(this.options.crtWhineHz, ctx.sampleRate);
        osc.connect(bus);
        osc.start(t);

        // A touch of the 2nd harmonic makes it read as a flyback rather than a test tone.
        const harmonic = ctx.createOscillator();
        harmonic.type = 'sine';
        harmonic.frequency.value = safeFrequency(this.options.crtWhineHz * 2, ctx.sampleRate);
        const harmonicGain = ctx.createGain();
        harmonicGain.gain.value = 0.25;
        harmonic.connect(harmonicGain);
        harmonicGain.connect(bus);
        harmonic.start(t);

        const wobble = ctx.createOscillator();
        wobble.type = 'sine';
        wobble.frequency.value = 0.13;
        const wobbleDepth = ctx.createGain();
        wobbleDepth.gain.value = this.options.crtWhineGain * 0.25;
        wobble.connect(wobbleDepth);
        wobbleDepth.connect(bus.gain);
        wobble.start(t);

        this.crt = { gain: bus, nodes: [harmonicGain, wobbleDepth], sources: [osc, harmonic, wobble] };
      }
      const gain = Math.max(this.options.crtWhineGain * this.deps.mixer.shaping.peakScale, 0.00001);
      this.crt.gain.gain.cancelScheduledValues(t);
      this.crt.gain.gain.setValueAtTime(Math.max(this.crt.gain.gain.value, 0.00001), t);
      this.crt.gain.gain.exponentialRampToValueAtTime(gain, t + 0.25);
      return;
    }

    const crt = this.crt;
    if (!crt) return;
    crt.gain.gain.cancelScheduledValues(t);
    crt.gain.gain.setValueAtTime(Math.max(crt.gain.gain.value, 0.00001), t);
    crt.gain.gain.exponentialRampToValueAtTime(0.00001, t + 0.2);
    for (let i = 0; i < crt.sources.length; i += 1) safeStop(crt.sources[i], t + 0.3);
    this.crt = null;
  }

  dispose(): void {
    if (this.disposed) return;
    const now = this.deps.ctx.currentTime;
    this.crtWhine(false);
    this.fanRamp(0, 0.05);
    const chain = this.compressor;
    if (chain) {
      chain.gain.gain.cancelScheduledValues(now);
      chain.gain.gain.setValueAtTime(0, now);
      for (let i = 0; i < chain.sources.length; i += 1) safeStop(chain.sources[i], now + 0.05);
      this.synth.cleanupLater([...chain.nodes, chain.gain], 0.2);
      this.compressor = null;
      this.compressorPitch = [];
      this.compressorRunningValue = false;
    }
    this.frostScheduler.setRate(0, now);
    this.disposed = true;
    safeDisconnect(this.output);
  }
}
