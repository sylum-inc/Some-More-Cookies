/**
 * Foley: cooking, handling and movement.
 *
 * The marshmallow sizzle is the only continuous layer here — it tracks the
 * surface state of the thing on the stick and has to respond smoothly, because
 * it is the player's main non-visual feedback on how close they are to a
 * perfect toast. Everything else is a one-shot built from the shared
 * `Synth` primitives.
 */

import { clamp, clamp01, lerp, mapExp, mapRange } from './math.js';
import { safeFrequency } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import { Synth } from './synth.js';
import { LookaheadWindow, PoissonScheduler } from './voices.js';

/* -------------------------------------------------------------------------- */
/* Sizzle                                                                      */
/* -------------------------------------------------------------------------- */

/** Surface state of whatever is being cooked. All 0..1. */
export interface SizzleState {
  /** How hot the surface currently is. */
  heat: number;
  /** How much water is left in the surface. Dries out as it cooks. */
  moisture: number;
  /** How far the sugar has caramelised. Adds dry, brittle micro-crackle. */
  browning: number;
  /** How close the surface is to igniting. Adds a low roar underneath. */
  scorch: number;
}

export const DEFAULT_SIZZLE_STATE: Readonly<SizzleState> = Object.freeze({
  heat: 0,
  moisture: 1,
  browning: 0,
  scorch: 0,
});

export interface SizzleParams {
  /** Broadband steam hiss level. */
  hissGain: number;
  hissCenterHz: number;
  hissQ: number;
  /** Rate of tiny bursting-bubble pops, events/second. */
  popRatePerSecond: number;
  popPeakGain: number;
  popCenterHz: number;
  /** Low roar that appears once the surface is close to catching. */
  scorchGain: number;
}

export function createSizzleParams(): SizzleParams {
  return {
    hissGain: 0,
    hissCenterHz: 3000,
    hissQ: 0.8,
    popRatePerSecond: 0,
    popPeakGain: 0,
    popCenterHz: 2600,
    scorchGain: 0,
  };
}

/**
 * Pure mapping from surface state to sizzle synthesis parameters.
 *
 * The physics being modelled: sizzle is water boiling out of the surface, so it
 * needs *both* heat and moisture and it dies as the surface dries. A dry,
 * browning surface is quieter but much brighter and drier — the hiss narrows
 * and moves up, and the pops get sparser and sharper. Right at the edge of
 * ignition a low roar joins underneath.
 */
export function sizzleParams(state: SizzleState, out: SizzleParams): SizzleParams {
  const heat = clamp01(state.heat);
  const moisture = clamp01(state.moisture);
  const browning = clamp01(state.browning);
  const scorch = clamp01(state.scorch);

  const boiling = heat * moisture;
  out.hissGain = clamp(0.3 * boiling + 0.05 * heat * browning, 0, 0.36);
  // Wet is broad and low; dry is narrow and high.
  out.hissCenterHz = safeFrequency(mapExp(1 - moisture * 0.8, 2200, 6200));
  out.hissQ = lerp(0.6, 2.6, 1 - moisture);

  // Bubbles need water. Caramel crackle needs the opposite.
  const bubbles = mapRange(boiling, 0, 1, 0, 16);
  const caramel = mapRange(browning * heat * (1 - moisture), 0, 1, 0, 7);
  out.popRatePerSecond = clamp(bubbles + caramel, 0, 24);
  out.popPeakGain = clamp(0.1 + 0.28 * heat, 0, 0.45);
  out.popCenterHz = safeFrequency(mapExp(browning * 0.6 + (1 - moisture) * 0.4, 1600, 5200));

  out.scorchGain = clamp(0.22 * Math.pow(scorch, 1.5), 0, 0.24);
  return out;
}

/* -------------------------------------------------------------------------- */
/* Footsteps                                                                   */
/* -------------------------------------------------------------------------- */

export type FootstepMaterial = 'pineNeedles' | 'gravel' | 'wetGrass' | 'snow' | 'woodDeck';

export const FOOTSTEP_MATERIALS: readonly FootstepMaterial[] = [
  'pineNeedles',
  'gravel',
  'wetGrass',
  'snow',
  'woodDeck',
];

export interface FootstepSpec {
  /** Low body of the step. */
  bodyHz: number;
  bodyPeak: number;
  bodyDecay: number;
  /** The granular layer: how many micro-grains, spread over how long. */
  grains: number;
  spreadSeconds: number;
  grainCenterHz: number;
  grainQ: number;
  grainDecay: number;
  grainPeak: number;
  /** 0 = dull/damp, 1 = bright/dry. Picks the grain from the bank. */
  brightness: number;
  /** Resonant partials of the surface itself; empty for soft ground. */
  partials: readonly number[];
}

export const FOOTSTEP_SPECS: Readonly<Record<FootstepMaterial, FootstepSpec>> = Object.freeze({
  // Dry duff: soft body, lots of fine high rustle.
  pineNeedles: {
    bodyHz: 78, bodyPeak: 0.16, bodyDecay: 0.045,
    grains: 14, spreadSeconds: 0.085, grainCenterHz: 4200, grainQ: 1.6, grainDecay: 0.012,
    grainPeak: 0.09, brightness: 0.75, partials: [],
  },
  // Hard, loud, wide-band: individual stones you can almost count.
  gravel: {
    bodyHz: 62, bodyPeak: 0.26, bodyDecay: 0.05,
    grains: 11, spreadSeconds: 0.075, grainCenterHz: 2600, grainQ: 1.1, grainDecay: 0.02,
    grainPeak: 0.2, brightness: 0.55, partials: [],
  },
  // Damp and muted, with a hint of squelch in the body.
  wetGrass: {
    bodyHz: 88, bodyPeak: 0.2, bodyDecay: 0.07,
    grains: 8, spreadSeconds: 0.1, grainCenterHz: 1500, grainQ: 0.9, grainDecay: 0.03,
    grainPeak: 0.08, brightness: 0.3, partials: [],
  },
  // The famous squeak: a narrow, high, compressed crunch with almost no tail.
  snow: {
    bodyHz: 70, bodyPeak: 0.18, bodyDecay: 0.035,
    grains: 18, spreadSeconds: 0.06, grainCenterHz: 5600, grainQ: 5, grainDecay: 0.006,
    grainPeak: 0.11, brightness: 0.9, partials: [],
  },
  // A hollow plank rings: near-harmonic partials and a long-ish body.
  woodDeck: {
    bodyHz: 96, bodyPeak: 0.3, bodyDecay: 0.09,
    grains: 4, spreadSeconds: 0.03, grainCenterHz: 1900, grainQ: 2, grainDecay: 0.015,
    grainPeak: 0.09, brightness: 0.5, partials: [186, 402, 741],
  },
});

export function footstepSpec(material: FootstepMaterial): FootstepSpec {
  return FOOTSTEP_SPECS[material] ?? FOOTSTEP_SPECS.pineNeedles;
}

export function isFootstepMaterial(value: string): value is FootstepMaterial {
  return (FOOTSTEP_MATERIALS as readonly string[]).includes(value);
}

export type StickAction = 'pickUp' | 'putDown' | 'rotate' | 'tap';

export const STICK_ACTIONS: readonly StickAction[] = ['pickUp', 'putDown', 'rotate', 'tap'];

/* -------------------------------------------------------------------------- */
/* Kit                                                                         */
/* -------------------------------------------------------------------------- */

export interface FoleyOptions {
  lookaheadSeconds: number;
  smoothingSeconds: number;
}

export const DEFAULT_FOLEY_OPTIONS: Readonly<FoleyOptions> = Object.freeze({
  lookaheadSeconds: 0.3,
  smoothingSeconds: 0.09,
});

export class FoleyKit implements PumpableLayer {
  private readonly options: FoleyOptions;
  private readonly output: GainNode;
  private readonly synth: Synth;

  private readonly sizzleStateValue: SizzleState = { ...DEFAULT_SIZZLE_STATE };
  private readonly sizzleParamsValue = createSizzleParams();
  private readonly sizzleGain: GainNode;
  private readonly sizzleFilter: BiquadFilterNode;
  private readonly scorchGain: GainNode;
  private readonly scorchFilter: BiquadFilterNode;
  private sizzleSources: AudioBufferSourceNode[] = [];
  private readonly popScheduler: PoissonScheduler;
  private readonly window: LookaheadWindow;
  private readonly eventTimes = new Float64Array(16);

  private sizzling = false;
  private disposed = false;

  constructor(
    private readonly deps: LayerDeps,
    options: Partial<FoleyOptions> = {},
  ) {
    this.options = { ...DEFAULT_FOLEY_OPTIONS, ...options };
    const ctx = deps.ctx;
    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);
    this.synth = new Synth(deps, this.output);

    this.sizzleFilter = ctx.createBiquadFilter();
    this.sizzleFilter.type = 'bandpass';
    this.sizzleFilter.frequency.value = 3000;
    this.sizzleFilter.Q.value = 0.8;
    this.sizzleGain = ctx.createGain();
    this.sizzleGain.gain.value = 0;
    this.sizzleFilter.connect(this.sizzleGain);
    this.sizzleGain.connect(this.output);

    this.scorchFilter = ctx.createBiquadFilter();
    this.scorchFilter.type = 'lowpass';
    this.scorchFilter.frequency.value = 420;
    this.scorchFilter.Q.value = 1;
    this.scorchGain = ctx.createGain();
    this.scorchGain.gain.value = 0;
    this.scorchFilter.connect(this.scorchGain);
    this.scorchGain.connect(this.output);

    this.popScheduler = new PoissonScheduler(deps.rng);
    this.window = new LookaheadWindow(this.options.lookaheadSeconds);
    this.window.reset(ctx.currentTime);
  }

  get sizzleState(): Readonly<SizzleState> {
    return this.sizzleStateValue;
  }

  get sizzleParameters(): Readonly<SizzleParams> {
    return this.sizzleParamsValue;
  }

  get sizzleRunning(): boolean {
    return this.sizzling;
  }

  /** Begin the continuous sizzle bed. Idempotent. */
  startSizzle(): void {
    if (this.sizzling || this.disposed) return;
    this.sizzling = true;
    const ctx = this.deps.ctx;
    const bank = this.deps.bank;
    const now = ctx.currentTime;

    const hiss = ctx.createBufferSource();
    hiss.buffer = bank.velvet(3600);
    hiss.loop = true;
    hiss.loopEnd = bank.loopEnd('white');
    hiss.connect(this.sizzleFilter);
    hiss.start(now, this.deps.rng.range(0, 1));

    const scorch = ctx.createBufferSource();
    scorch.buffer = bank.loop('brown');
    scorch.loop = true;
    scorch.loopEnd = bank.loopEnd('brown');
    scorch.connect(this.scorchFilter);
    scorch.start(now, this.deps.rng.range(0, 1));

    this.sizzleSources = [hiss, scorch];
    this.applySizzle();
  }

  stopSizzle(fadeSeconds = 0.25): void {
    if (!this.sizzling) return;
    this.sizzling = false;
    const now = this.deps.ctx.currentTime;
    const end = now + Math.max(fadeSeconds, 0.01);
    for (const param of [this.sizzleGain.gain, this.scorchGain.gain]) {
      param.cancelScheduledValues(now);
      param.setValueAtTime(param.value, now);
      param.linearRampToValueAtTime(0, end);
    }
    for (let i = 0; i < this.sizzleSources.length; i += 1) safeStop(this.sizzleSources[i], end);
    this.sizzleSources = [];
    this.popScheduler.setRate(0, now);
  }

  /** Hot path. Partial update, allocation-free. */
  setSizzleState(next: Partial<SizzleState>): void {
    if (next.heat !== undefined) this.sizzleStateValue.heat = clamp01(next.heat);
    if (next.moisture !== undefined) this.sizzleStateValue.moisture = clamp01(next.moisture);
    if (next.browning !== undefined) this.sizzleStateValue.browning = clamp01(next.browning);
    if (next.scorch !== undefined) this.sizzleStateValue.scorch = clamp01(next.scorch);
    this.applySizzle();
  }

  private applySizzle(): void {
    const p = sizzleParams(this.sizzleStateValue, this.sizzleParamsValue);
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const tc = this.options.smoothingSeconds;
    const audible = this.sizzling ? 1 : 0;

    this.sizzleGain.gain.setTargetAtTime(p.hissGain * audible, now, tc);
    this.sizzleFilter.frequency.setTargetAtTime(p.hissCenterHz, now, tc);
    this.sizzleFilter.Q.setTargetAtTime(p.hissQ, now, tc);
    this.scorchGain.gain.setTargetAtTime(p.scorchGain * audible, now, tc);
    this.popScheduler.setRate(p.popRatePerSecond * audible, now);
  }

  pump(now: number): number {
    if (this.disposed) return 0;
    const horizon = this.window.advance(now);
    if (horizon === null) return 0;
    const count = this.popScheduler.collect(horizon, this.eventTimes);
    const rng = this.deps.rng;
    const p = this.sizzleParamsValue;
    for (let i = 0; i < count; i += 1) {
      const t = this.eventTimes[i] ?? now;
      // A bursting bubble: a single tiny grain, randomly placed and pitched.
      this.synth.grain(
        t,
        clamp01(0.5 + this.sizzleStateValue.browning * 0.4),
        p.popCenterHz * rng.range(0.7, 1.5),
        rng.range(2, 6),
        0.0004,
        rng.range(0.004, 0.016),
        p.popPeakGain * rng.range(0.3, 1),
        rng.range(0.9, 1.8),
        rng.range(-0.35, 0.35),
      );
    }
    return count;
  }

  /* --------------------------------------------------------------- one-shots */

  /**
   * Ignition. A fast broadband swell that opens upward as the flame front
   * expands, plus a low pressure pulse. Not an explosion — this is a
   * marshmallow catching, or kindling taking.
   */
  ignitionWhoosh(scale = 1, when?: number): number {
    const t = this.synth.at(when);
    const s = clamp01(scale);
    const shaping = this.synth.shaping;
    // The catch itself.
    this.synth.noiseBurst(t, 900, 0.8, 0.012 * shaping.attackScale, 0.06, 0.22 * s, 'bandpass', 2600);
    // The swell of the flame front opening up.
    const end = this.synth.noiseBurst(
      t + 0.01, 500, 0.5, 0.07 * shaping.attackScale, 0.34, 0.3 * s, 'lowpass', 2200,
    );
    // Pressure underneath.
    this.synth.thump(t + 0.005, 130, 58, 0.09, 0.14, 0.18 * s);
    return end;
  }

  /** Blowing a flame out: a breathy puff, then the flame dying. */
  blowOut(strength = 1, when?: number): number {
    const t = this.synth.at(when);
    const s = clamp01(strength);
    const shaping = this.synth.shaping;
    // The breath. Slow attack, band sweeping down as the lips close.
    const end = this.synth.noiseBurst(
      t, 1500, 0.7, 0.05 * shaping.attackScale, 0.16, 0.24 * s, 'bandpass', 420,
    );
    // The flame guttering out just after.
    this.synth.noiseBurst(t + 0.09, 700, 1.4, 0.006, 0.05, 0.12 * s, 'bandpass', 260);
    return end;
  }

  /**
   * Graham cracker. Brittle laminated biscuit: one decisive snap along the
   * score line, then crumbs. The snap is a hard modal tick; the crumble is a
   * scatter of small grains over the next ~180 ms.
   */
  grahamSnap(when?: number): number {
    const t = this.synth.at(when);
    const rng = this.deps.rng;
    this.synth.noiseBurst(t, 2400, 1.3, 0.0006, 0.012, 0.34, 'bandpass', 1400);
    let end = this.synth.modalRing(t, [780, 1640, 2510], 9, 0.03, 0.24, this.output, 0.5);
    const crumbs = rng.int(5, 9);
    for (let i = 0; i < crumbs; i += 1) {
      const at = t + 0.02 + rng.range(0, 0.17);
      end = Math.max(
        end,
        this.synth.grain(
          at, 0.6, rng.range(1800, 4600), rng.range(1.5, 4), 0.0004,
          rng.range(0.005, 0.02), rng.range(0.03, 0.11), rng.range(0.8, 1.6), rng.range(-0.4, 0.4),
        ),
      );
    }
    return end;
  }

  /**
   * Chocolate. Denser and more homogeneous than biscuit: a single clean, high,
   * short fracture with a brief glassy ring and almost no crumble.
   */
  chocolateFracture(when?: number): number {
    const t = this.synth.at(when);
    const rng = this.deps.rng;
    this.synth.noiseBurst(t, 4800, 2.6, 0.0004, 0.006, 0.3);
    const end = this.synth.modalRing(t, [2870, 4310, 6220], 20, 0.022, 0.26, this.output, 0.85);
    // One or two tiny shards.
    for (let i = 0; i < rng.int(1, 2); i += 1) {
      this.synth.grain(
        t + rng.range(0.015, 0.06), 0.9, rng.range(3800, 7200), 4, 0.0003, 0.005,
        rng.range(0.03, 0.07), 1.2, rng.range(-0.3, 0.3),
      );
    }
    return end;
  }

  /** A soft wet squish — low, dull, slow-ish, with a couple of wet ticks. */
  squish(strength = 1, when?: number): number {
    const t = this.synth.at(when);
    const s = clamp01(strength);
    const rng = this.deps.rng;
    const shaping = this.synth.shaping;
    // The compression itself: a low band sliding downward.
    const end = this.synth.noiseBurst(
      t, 620, 1.8, 0.02 * shaping.attackScale, 0.09, 0.2 * s, 'bandpass', 220,
    );
    this.synth.thump(t, 165, 92, 0.07, 0.07, 0.12 * s);
    for (let i = 0; i < rng.int(1, 3); i += 1) {
      this.synth.grain(
        t + rng.range(0.01, 0.09), 0.25, rng.range(700, 1600), 3, 0.001,
        rng.range(0.008, 0.02), 0.05 * s, rng.range(0.7, 1.2), rng.range(-0.25, 0.25),
      );
    }
    return end;
  }

  /** Handling the roasting stick: wood on wood, wood on hand, wood on ground. */
  stickHandling(action: StickAction = 'rotate', when?: number): number {
    const t = this.synth.at(when);
    const rng = this.deps.rng;
    // Near-harmonic partials: this is wood, not metal.
    const woodPartials = [420, 786, 1232];

    switch (action) {
      case 'pickUp':
        // A short scrape as it leaves the ground, then a light knock.
        this.synth.noiseBurst(t, 1800, 1.1, 0.02, 0.07, 0.1, 'bandpass', 900);
        return this.synth.modalRing(t + 0.06, woodPartials, 11, 0.05, 0.14, this.output, 0.45);
      case 'putDown':
        this.synth.thump(t, 140, 74, 0.03, 0.05, 0.16);
        return this.synth.modalRing(t, woodPartials, 9, 0.07, 0.18, this.output, 0.4);
      case 'tap':
        return this.synth.modalRing(t, woodPartials, 14, 0.04, 0.2, this.output, 0.55);
      case 'rotate':
      default: {
        // A slow dry creak: several tiny grains along a slipping contact.
        let end = t;
        const ticks = rng.int(3, 6);
        for (let i = 0; i < ticks; i += 1) {
          end = Math.max(
            end,
            this.synth.grain(
              t + (i / ticks) * 0.14 + rng.range(0, 0.02), 0.4,
              rng.range(900, 2400), rng.range(4, 9), 0.001,
              rng.range(0.006, 0.018), rng.range(0.02, 0.06), rng.range(0.8, 1.3),
              rng.range(-0.2, 0.2),
            ),
          );
        }
        return end;
      }
    }
  }

  /**
   * One footstep. `intensity` scales weight (a walk vs a stomp) and the grain
   * layer is scattered stochastically so no two steps are identical.
   */
  footstep(material: FootstepMaterial = 'pineNeedles', intensity = 1, when?: number): number {
    const t = this.synth.at(when);
    const spec = footstepSpec(material);
    const weight = clamp(intensity, 0.15, 1.5);
    const rng = this.deps.rng;

    let end = this.synth.thump(
      t, spec.bodyHz * rng.range(0.92, 1.1), spec.bodyHz * 0.62,
      spec.bodyDecay * 0.6, spec.bodyDecay, spec.bodyPeak * weight,
    );

    if (spec.partials.length > 0) {
      end = Math.max(end, this.synth.modalRing(t, spec.partials, 12, 0.06, 0.12 * weight, this.output, 0.45));
    }

    const grains = Math.max(1, Math.round(spec.grains * clamp(weight, 0.4, 1.4)));
    for (let i = 0; i < grains; i += 1) {
      // Grains cluster toward the start of the step and thin out after.
      const u = rng.next();
      const at = t + u * u * spec.spreadSeconds;
      end = Math.max(
        end,
        this.synth.grain(
          at,
          spec.brightness,
          spec.grainCenterHz * rng.range(0.7, 1.45),
          spec.grainQ * rng.range(0.8, 1.3),
          0.0004,
          spec.grainDecay * rng.range(0.7, 1.4),
          spec.grainPeak * weight * rng.range(0.35, 1),
          rng.range(0.85, 1.5),
          rng.range(-0.3, 0.3),
        ),
      );
    }
    return end;
  }

  dispose(): void {
    if (this.disposed) return;
    this.stopSizzle(0.05);
    this.disposed = true;
    safeDisconnect(this.sizzleFilter);
    safeDisconnect(this.sizzleGain);
    safeDisconnect(this.scorchFilter);
    safeDisconnect(this.scorchGain);
    safeDisconnect(this.output);
  }
}
