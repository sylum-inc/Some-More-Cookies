/**
 * Tests for the procedural audio engine.
 *
 * Everything pure (noise generation, impulse responses, envelope maths, the
 * Poisson scheduler, every simulation-state mapping, the mixer state machine)
 * is asserted directly. The stateful half is driven through the headless
 * `FakeAudioContext` from `src/audio/testing.ts`, which records every parameter
 * automation event so scheduling can be checked precisely.
 */

import { describe, expect, it } from 'vitest';

import {
  AMBIENCE_PRESETS,
  BEEP_KINDS,
  BEEP_SPECS,
  BUS_NAMES,
  COMPRESSOR_HARMONICS,
  DEFAULT_AMBIENCE_CONDITIONS,
  DEFAULT_AMBIENCE_PROFILE,
  DEFAULT_BUS_VOLUMES,
  DEFAULT_FIRE_STATE,
  FAN_BLADES,
  FAN_MAX_RPM,
  FOOTSTEP_MATERIALS,
  FOOTSTEP_SPECS,
  ImpulseCache,
  LookaheadWindow,
  MAX_CRACKLE_RATE,
  MixerState,
  ObjectPool,
  PoissonScheduler,
  RELAY_CHARACTERS,
  REDUCED_INTENSITY,
  SPACE_PRESETS,
  SPACE_TYPES,
  adsrValueAt,
  applyPercussive,
  birdCallRate,
  choosePanningModel,
  compressorFrequencies,
  computeDistanceGain,
  correlation,
  createFanCurve,
  createFireVoiceParams,
  createRng,
  createSizzleParams,
  crossfadeLoopInPlace,
  fanCurve,
  fillGrain,
  fillPinkNoise,
  fillVelvetNoise,
  fillWhiteNoise,
  footstepSpec,
  frostTickRate,
  generateImpulseResponse,
  generateNoise,
  hashSeed,
  impulseSampleCount,
  insectActivity,
  mixingTimeSeconds,
  insectVoiceCount,
  isBusName,
  loopEndFor,
  mapFireState,
  nightFactor,
  normalizeVec3,
  orthonormalizeBasis,
  peakOf,
  percussiveDuration,
  percussiveValueAt,
  poissonInterval,
  relayCharacter,
  resolveAmbienceProfile,
  rmsOf,
  shapePercussive,
  sizzleParams,
  tailSeconds,
  timeConstantForDecay,
  volumeToGain,
  windCutoff,
  windLevel,
  windowedRms,
  zeroCrossingRate,
  audioMath,
} from '../src/audio/index.js';

import { AudioEngine } from '../src/audio/engine.js';
import {
  FakeAudioParam,
  FakeBiquadFilterNode,
  FakeBufferSourceNode,
  FakeGainNode,
  FakeOscillatorNode,
  createFakeAudioContext,
  type FakeAudioContext,
} from '../src/audio/testing.js';

const { clamp, clamp01, mapExp, mapRange, equalPowerGains, cyclicAt, dbToGain, gainToDb, smoothstep } = audioMath;

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

function makeEngine(options: Record<string, unknown> = {}): { engine: AudioEngine; ctx: FakeAudioContext } {
  const ctx = createFakeAudioContext({ sampleRate: 48000 });
  const engine = new AudioEngine({
    contextFactory: () => ctx as unknown as AudioContext,
    pumpIntervalMs: 0,
    seed: 'test-campsite',
    // Small banks keep the suite fast without changing any of the logic.
    noiseBank: { loopSeconds: 0.5, loopFadeSeconds: 0.05, grainCount: 6, grainSeconds: 0.08 },
    ...options,
  });
  return { engine, ctx };
}

function oscillatorsStartedAfter(ctx: FakeAudioContext, index: number): FakeOscillatorNode[] {
  return ctx.nodes.slice(index).filter((node): node is FakeOscillatorNode => node instanceof FakeOscillatorNode);
}

function gainsAfter(ctx: FakeAudioContext, index: number): FakeGainNode[] {
  return ctx.nodes.slice(index).filter((node): node is FakeGainNode => node instanceof FakeGainNode);
}

function filtersAfter(ctx: FakeAudioContext, index: number): FakeBiquadFilterNode[] {
  return ctx.nodes.slice(index).filter((node): node is FakeBiquadFilterNode => node instanceof FakeBiquadFilterNode);
}

/** The largest value any of these gain params was ever ramped to. */
function peakScheduled(gains: FakeGainNode[]): number {
  let peak = 0;
  for (const gain of gains) {
    for (const event of gain.gain.events) {
      if (event.value > peak) peak = event.value;
    }
  }
  return peak;
}

/* -------------------------------------------------------------------------- */
/* math                                                                        */
/* -------------------------------------------------------------------------- */

describe('math helpers', () => {
  it('clamps, and collapses non-finite input to the minimum', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-5, 0, 1)).toBe(0);
    expect(clamp(Number.NaN, 0.2, 1)).toBe(0.2);
    expect(clamp(Number.POSITIVE_INFINITY, 0.2, 1)).toBe(0.2);
    expect(clamp01(0.4)).toBe(0.4);
  });

  it('maps ranges with clamping, and exponentially for frequencies', () => {
    expect(mapRange(0.5, 0, 1, 100, 200)).toBeCloseTo(150);
    expect(mapRange(2, 0, 1, 100, 200)).toBe(200);
    expect(mapRange(-2, 0, 1, 100, 200)).toBe(100);
    // The exponential midpoint is the geometric mean, not the arithmetic one.
    expect(mapExp(0.5, 100, 10000)).toBeCloseTo(1000, 6);
    expect(mapExp(0, 100, 10000)).toBeCloseTo(100);
    expect(mapExp(1, 100, 10000)).toBeCloseTo(10000);
  });

  it('round-trips decibels and produces constant-power pan gains', () => {
    expect(dbToGain(0)).toBeCloseTo(1);
    expect(dbToGain(-6)).toBeCloseTo(0.5012, 3);
    expect(gainToDb(dbToGain(-13.5))).toBeCloseTo(-13.5, 6);

    const out = [0, 0];
    equalPowerGains(0, out);
    expect((out[0] ?? 0) ** 2 + (out[1] ?? 0) ** 2).toBeCloseTo(1, 6);
    equalPowerGains(-1, out);
    expect(out[0]).toBeCloseTo(1);
    expect(out[1]).toBeCloseTo(0);
    equalPowerGains(1, out);
    expect(out[1]).toBeCloseTo(1);
    // Out-of-range pans are clamped rather than wrapping the image.
    equalPowerGains(9, out);
    expect(out[1]).toBeCloseTo(1);
  });

  it('smoothsteps between edges and wraps cyclic indices', () => {
    expect(smoothstep(0, 1, -1)).toBe(0);
    expect(smoothstep(0, 1, 2)).toBe(1);
    expect(smoothstep(0, 1, 0.5)).toBeCloseTo(0.5);
    expect(cyclicAt([10, 20, 30], -1, 0)).toBe(30);
    expect(cyclicAt([10, 20, 30], 4, 0)).toBe(20);
    expect(cyclicAt([], 0, -1)).toBe(-1);
  });
});

/* -------------------------------------------------------------------------- */
/* rng and Poisson maths                                                       */
/* -------------------------------------------------------------------------- */

describe('seeded randomness', () => {
  it('is deterministic for a seed and different across seeds', () => {
    const a = createRng(1234);
    const b = createRng(1234);
    const c = createRng(1235);
    const seqA = Array.from({ length: 16 }, () => a.next());
    const seqB = Array.from({ length: 16 }, () => b.next());
    const seqC = Array.from({ length: 16 }, () => c.next());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    expect(seqA.every((v) => v >= 0 && v < 1)).toBe(true);
  });

  it('respects range and int bounds and reseeds', () => {
    const rng = createRng(7);
    for (let i = 0; i < 500; i += 1) {
      const r = rng.range(-3, 5);
      expect(r).toBeGreaterThanOrEqual(-3);
      expect(r).toBeLessThan(5);
      const n = rng.int(2, 4);
      expect([2, 3, 4]).toContain(n);
    }
    const before = rng.next();
    rng.reseed(7);
    const seq = Array.from({ length: 3 }, () => rng.next());
    expect(seq[0]).not.toBe(before);
    rng.reseed(7);
    expect(rng.next()).toBe(seq[0]);
  });

  it('hashes strings to stable, distinct seeds', () => {
    expect(hashSeed('lakeside')).toBe(hashSeed('lakeside'));
    expect(hashSeed('lakeside')).not.toBe(hashSeed('pineRidge'));
    expect(hashSeed('')).toBeGreaterThanOrEqual(0);
  });

  it('samples Poisson intervals with the right mean', () => {
    const rng = createRng(99);
    const rate = 5;
    const n = 20000;
    let total = 0;
    for (let i = 0; i < n; i += 1) total += poissonInterval(rate, rng);
    // E[interval] = 1/lambda = 0.2 s
    expect(total / n).toBeCloseTo(0.2, 2);
    expect(poissonInterval(0, rng)).toBe(Number.POSITIVE_INFINITY);
    expect(poissonInterval(-3, rng)).toBe(Number.POSITIVE_INFINITY);
  });
});

/* -------------------------------------------------------------------------- */
/* envelopes                                                                   */
/* -------------------------------------------------------------------------- */

describe('envelope maths', () => {
  it('converts between decay times and time constants', () => {
    const tau = timeConstantForDecay(0.5);
    expect(tailSeconds(tau)).toBeCloseTo(0.5, 9);
    // 60 dB down is a factor of 1000.
    expect(Math.exp(-0.5 / tau)).toBeCloseTo(0.001, 6);
  });

  it('shapes percussive hits: linear attack then exponential tail', () => {
    const env = { attack: 0.01, decay: 0.05, peak: 0.8 };
    expect(percussiveValueAt(env, -1)).toBe(0);
    expect(percussiveValueAt(env, 0)).toBe(0);
    expect(percussiveValueAt(env, 0.005)).toBeCloseTo(0.4, 6);
    expect(percussiveValueAt(env, 0.01)).toBeCloseTo(0.8, 6);
    expect(percussiveValueAt(env, 0.06)).toBeCloseTo(0.8 * Math.exp(-1), 6);
    // Monotone decreasing after the peak.
    let prev = Number.POSITIVE_INFINITY;
    for (let t = 0.01; t < 0.4; t += 0.01) {
      const v = percussiveValueAt(env, t);
      expect(v).toBeLessThanOrEqual(prev + 1e-12);
      prev = v;
    }
    expect(percussiveDuration(env)).toBeCloseTo(0.01 + tailSeconds(0.05), 9);
  });

  it('evaluates ADSR across all four phases', () => {
    const env = { attack: 0.1, decay: 0.2, sustain: 0.4, release: 0.3 };
    expect(adsrValueAt(env, 0)).toBe(0);
    expect(adsrValueAt(env, 0.05)).toBeCloseTo(0.5);
    expect(adsrValueAt(env, 0.1)).toBeCloseTo(1);
    expect(adsrValueAt(env, 0.2)).toBeCloseTo(0.7); // halfway through decay
    expect(adsrValueAt(env, 0.3)).toBeCloseTo(0.4);
    expect(adsrValueAt(env, 5)).toBeCloseTo(0.4); // sustains indefinitely
    // Released at 1 s from the sustain level.
    expect(adsrValueAt(env, 1, 1)).toBeCloseTo(0.4);
    expect(adsrValueAt(env, 1.15, 1)).toBeCloseTo(0.2);
    expect(adsrValueAt(env, 1.3, 1)).toBeCloseTo(0);
    expect(adsrValueAt(env, 2, 1)).toBe(0);
  });

  it('reduced intensity lowers peaks, stretches attacks and enforces a ceiling', () => {
    const loud = { attack: 0.001, decay: 0.05, peak: 0.9 };
    const shaped = shapePercussive(loud, REDUCED_INTENSITY);
    expect(shaped.peak).toBeLessThan(loud.peak);
    expect(shaped.peak).toBeLessThanOrEqual(REDUCED_INTENSITY.ceiling);
    expect(shaped.attack).toBeCloseTo(loud.attack * REDUCED_INTENSITY.attackScale);
    // The decay is untouched: we tame the startle, not the character.
    expect(shaped.decay).toBe(loud.decay);
    // The ceiling binds even for an already-quiet-ish sound above it.
    expect(shapePercussive({ attack: 0.001, decay: 0.01, peak: 1 }, REDUCED_INTENSITY).peak).toBe(
      REDUCED_INTENSITY.ceiling,
    );
  });

  it('writes a safe automation sequence onto a param', () => {
    const param = new FakeAudioParam(0);
    const env = { attack: 0.002, decay: 0.03, peak: 0.5 };
    const end = applyPercussive(param, 10, env);
    const types = param.events.map((e) => e.type);
    expect(types).toEqual(['cancel', 'setValue', 'linearRamp', 'setTarget', 'setValue']);
    // Never an exponential ramp toward zero, which WebAudio forbids.
    expect(types).not.toContain('exponentialRamp');
    expect(param.events[1]?.value).toBe(0);
    expect(param.events[2]?.value).toBeCloseTo(0.5);
    expect(param.events[2]?.time).toBeCloseTo(10.002);
    expect(param.lastEvent?.value).toBe(0);
    expect(param.lastEvent?.time).toBeCloseTo(end);
    expect(end).toBeCloseTo(10 + percussiveDuration(env), 6);
  });
});

/* -------------------------------------------------------------------------- */
/* noise                                                                       */
/* -------------------------------------------------------------------------- */

describe('noise generation', () => {
  it('produces bounded, roughly zero-mean white noise', () => {
    const rng = createRng(3);
    const data = new Float32Array(8192);
    fillWhiteNoise(data, rng);
    expect(peakOf(data)).toBeLessThanOrEqual(1);
    let sum = 0;
    for (const v of data) sum += v;
    expect(Math.abs(sum / data.length)).toBeLessThan(0.05);
    expect(rmsOf(data)).toBeGreaterThan(0.5);
  });

  it('orders noise colours by brightness (zero-crossing rate)', () => {
    const white = generateNoise('white', 32768, { rng: createRng(11) });
    const pink = generateNoise('pink', 32768, { rng: createRng(11) });
    const brown = generateNoise('brown', 32768, { rng: createRng(11) });
    const blue = generateNoise('blue', 32768, { rng: createRng(11) });

    const zWhite = zeroCrossingRate(white);
    const zPink = zeroCrossingRate(pink);
    const zBrown = zeroCrossingRate(brown);
    const zBlue = zeroCrossingRate(blue);

    expect(zBrown).toBeLessThan(zPink);
    expect(zPink).toBeLessThan(zWhite);
    expect(zBlue).toBeGreaterThan(zWhite);
    // Coloured noise is peak-normalised so no layer can clip a bus on its own.
    expect(peakOf(pink)).toBeCloseTo(0.95, 2);
    expect(peakOf(brown)).toBeCloseTo(0.95, 2);
  });

  it('places exactly one velvet impulse per grid slot', () => {
    const rng = createRng(5);
    const sampleRate = 48000;
    const density = 1000; // one impulse per 48 samples
    const data = new Float32Array(sampleRate);
    fillVelvetNoise(data, rng, density, sampleRate);

    let impulses = 0;
    for (const v of data) {
      if (v !== 0) {
        expect(Math.abs(v)).toBe(1);
        impulses += 1;
      }
    }
    expect(impulses).toBe(sampleRate / 48);
    // Both polarities occur, otherwise it would have a DC component.
    let positive = 0;
    for (const v of data) if (v > 0) positive += 1;
    expect(positive).toBeGreaterThan(impulses * 0.3);
    expect(positive).toBeLessThan(impulses * 0.7);
  });

  it('builds normalised, decaying grains whose brightness is controllable', () => {
    const dull = new Float32Array(4096);
    const bright = new Float32Array(4096);
    fillGrain(dull, createRng(21), 48000, 0.001, 0.02, 0);
    fillGrain(bright, createRng(21), 48000, 0.001, 0.02, 1);

    expect(peakOf(dull)).toBeCloseTo(1, 5);
    expect(peakOf(bright)).toBeCloseTo(1, 5);
    expect(zeroCrossingRate(bright)).toBeGreaterThan(zeroCrossingRate(dull));

    const windows = windowedRms(dull, 8);
    expect(windows[0] ?? 0).toBeGreaterThan((windows[7] ?? 1) * 20);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i] ?? 0).toBeLessThanOrEqual((windows[i - 1] ?? 0) + 1e-6);
    }
  });

  it('crossfades only the loop seam and reports the matching loopEnd', () => {
    const rng = createRng(31);
    const data = new Float32Array(1000);
    fillWhiteNoise(data, rng);
    const original = Float32Array.from(data);
    crossfadeLoopInPlace(data, 100);

    for (let i = 100; i < data.length; i += 1) {
      expect(data[i]).toBe(original[i]);
    }
    let changed = 0;
    for (let i = 0; i < 100; i += 1) if (data[i] !== original[i]) changed += 1;
    expect(changed).toBeGreaterThan(90);

    expect(loopEndFor(1000, 100, 1000)).toBeCloseTo(0.9);
    // A fade longer than half the buffer is clamped rather than corrupting it.
    expect(loopEndFor(1000, 900, 1000)).toBeCloseTo(0.5);
  });
});

/* -------------------------------------------------------------------------- */
/* impulse responses                                                           */
/* -------------------------------------------------------------------------- */

describe('procedural impulse responses', () => {
  const sampleRate = 24000; // half rate keeps the suite quick; the maths is identical

  it('has the right length, pre-delay silence and stereo pair', () => {
    const spec = SPACE_PRESETS.canyon;
    const ir = generateImpulseResponse(spec, sampleRate, 1);
    expect(ir.length).toBe(impulseSampleCount(spec, sampleRate));
    expect(ir.length).toBe(Math.round(spec.durationSeconds * sampleRate));
    expect(ir.channels).toHaveLength(2);
    expect(ir.channels[0].length).toBe(ir.length);

    const preDelaySamples = Math.round(spec.preDelaySeconds * sampleRate);
    // Nothing before the pre-delay: that gap is what reads as room size.
    for (let i = 0; i < preDelaySamples - 1; i += 1) {
      expect(ir.channels[0][i]).toBe(0);
    }
  });

  it('decays monotonically toward silence', () => {
    const ir = generateImpulseResponse(SPACE_PRESETS.openForest, sampleRate, 2);
    const windows = windowedRms(ir.channels[0], 10);
    const first = windows[0] ?? 0;
    const last = windows[9] ?? 1;
    expect(first).toBeGreaterThan(0);
    expect(last).toBeLessThan(first * 0.05);
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i] ?? 0).toBeLessThan(windows[i - 1] ?? 0);
    }
  });

  it('stamps discrete early reflections above the diffuse tail', () => {
    const spec = SPACE_PRESETS.canyon;
    const ir = generateImpulseResponse(spec, sampleRate, 3);
    const left = ir.channels[0];
    const reflection = spec.earlyReflections[0];
    expect(reflection).toBeDefined();
    if (!reflection) return;

    const index = Math.round((spec.preDelaySeconds + reflection.timeSeconds) * sampleRate);
    let localPeak = 0;
    for (let i = index - 40; i <= index + 40; i += 1) {
      localPeak = Math.max(localPeak, Math.abs(left[i] ?? 0));
    }
    // The diffuse tail between reflections, for comparison.
    const background = rmsOf(left, index + 400, 300);
    expect(background).toBeGreaterThan(0);
    expect(localPeak).toBeGreaterThan(background * 4);
  });

  it('builds the diffuse tail up over the mixing time', () => {
    const spec = SPACE_PRESETS.canyon;
    expect(mixingTimeSeconds(spec)).toBeGreaterThan(0.4);
    const ir = generateImpulseResponse(spec, sampleRate, 7);
    const left = ir.channels[0];
    const preDelay = Math.round(spec.preDelaySeconds * sampleRate);
    // Right after the pre-delay the field is still sparse; by the mixing time
    // it is dense. Windows avoid the discrete reflections themselves.
    const earliest = rmsOf(left, preDelay + 20, 200);
    const mixed = rmsOf(left, preDelay + Math.round(mixingTimeSeconds(spec) * sampleRate), 200);
    expect(mixed).toBeGreaterThan(earliest * 2);
  });

  it('decorrelates the channels according to stereoWidth', () => {
    const wide = generateImpulseResponse(SPACE_PRESETS.clearing, sampleRate, 4);
    expect(Math.abs(correlation(wide.channels[0], wide.channels[1]))).toBeLessThan(0.5);

    const mono = generateImpulseResponse(
      { ...SPACE_PRESETS.clearing, stereoWidth: 0 },
      sampleRate,
      4,
    );
    expect(correlation(mono.channels[0], mono.channels[1])).toBeCloseTo(1, 6);
  });

  it('damps high frequencies more in absorbent spaces', () => {
    const snow = generateImpulseResponse(SPACE_PRESETS.snowfield, sampleRate, 5);
    const canyon = generateImpulseResponse(SPACE_PRESETS.canyon, sampleRate, 5);
    // Compare the tails, not the transient onset.
    const snowTail = snow.channels[0].subarray(Math.floor(snow.length * 0.5));
    const canyonTail = canyon.channels[0].subarray(Math.floor(canyon.length * 0.5));
    expect(zeroCrossingRate(snowTail)).toBeLessThan(zeroCrossingRate(canyonTail));
    expect(SPACE_PRESETS.snowfield.damping).toBeGreaterThan(SPACE_PRESETS.canyon.damping);
  });

  it('normalises to the preset gain and stays inside it', () => {
    for (const space of SPACE_TYPES) {
      const spec = SPACE_PRESETS[space];
      const ir = generateImpulseResponse(spec, sampleRate, 6);
      const peak = Math.max(peakOf(ir.channels[0]), peakOf(ir.channels[1]));
      expect(peak).toBeLessThanOrEqual(spec.gain + 1e-6);
      expect(peak).toBeGreaterThan(0);
    }
  });

  it('caches by space, sample rate and seed', () => {
    const cache = new ImpulseCache();
    expect(cache.size).toBe(0);
    expect(cache.has('clearing', sampleRate)).toBe(false);
    const first = cache.get('clearing', sampleRate);
    const second = cache.get('clearing', sampleRate);
    expect(second).toBe(first); // identity, not just equality
    expect(cache.size).toBe(1);
    cache.get('clearing', sampleRate * 2);
    cache.get('canyon', sampleRate);
    expect(cache.size).toBe(3);
    cache.clear();
    expect(cache.size).toBe(0);
  });

  it('honours per-space overrides', () => {
    const cache = new ImpulseCache({ clearing: { ...SPACE_PRESETS.clearing, durationSeconds: 0.2 } });
    expect(cache.specFor('clearing').durationSeconds).toBe(0.2);
    expect(cache.specFor('canyon')).toBe(SPACE_PRESETS.canyon);
    expect(cache.get('clearing', sampleRate).length).toBe(Math.round(0.2 * sampleRate));
  });
});

/* -------------------------------------------------------------------------- */
/* mixer state machine                                                         */
/* -------------------------------------------------------------------------- */

describe('mixer state machine', () => {
  it('exposes every bus with a default volume and a description', () => {
    expect(BUS_NAMES).toEqual(['ambience', 'fire', 'machine', 'foley', 'ui', 'voice']);
    for (const bus of BUS_NAMES) {
      expect(DEFAULT_BUS_VOLUMES[bus]).toBeGreaterThan(0);
      expect(DEFAULT_BUS_VOLUMES[bus]).toBeLessThanOrEqual(1);
      expect(isBusName(bus)).toBe(true);
    }
    expect(isBusName('sfx')).toBe(false);
  });

  it('uses a squared fader curve', () => {
    expect(volumeToGain(0)).toBe(0);
    expect(volumeToGain(1)).toBe(1);
    expect(volumeToGain(0.5)).toBeCloseTo(0.25);
    expect(gainToDb(volumeToGain(0.5))).toBeCloseTo(-12.04, 1);
  });

  it('clamps volumes and reports whether anything changed', () => {
    const mixer = new MixerState();
    expect(mixer.setBusVolume('fire', 0.5)).toBe(true);
    expect(mixer.setBusVolume('fire', 0.5)).toBe(false);
    mixer.setBusVolume('fire', 4);
    expect(mixer.getBusVolume('fire')).toBe(1);
    mixer.setBusVolume('fire', -4);
    expect(mixer.getBusVolume('fire')).toBe(0);
    expect(mixer.isSilent('fire')).toBe(true);
  });

  it('mutes without destroying the stored volumes', () => {
    const mixer = new MixerState();
    mixer.setMasterVolume(0.7);
    mixer.setBusVolume('machine', 0.6);
    const gainBefore = mixer.effectiveGain('machine');
    expect(gainBefore).toBeCloseTo(volumeToGain(0.7) * volumeToGain(0.6));

    expect(mixer.toggleMute()).toBe(true);
    expect(mixer.masterGain()).toBe(0);
    expect(mixer.effectiveGain('machine')).toBe(0);
    expect(mixer.getBusVolume('machine')).toBe(0.6);
    expect(mixer.getMasterVolume()).toBe(0.7);

    expect(mixer.toggleMute()).toBe(false);
    expect(mixer.effectiveGain('machine')).toBeCloseTo(gainBefore);
  });

  it('notifies listeners with the specific thing that changed', () => {
    const mixer = new MixerState();
    const changes: string[] = [];
    const unsubscribe = mixer.subscribe((change) => changes.push(change));
    mixer.setBusVolume('ui', 0.1);
    mixer.setMasterVolume(0.3);
    mixer.setMuted(true);
    mixer.setReducedAudioIntensity(true);
    mixer.setBusVolume('ui', 0.1); // no change, no event
    expect(changes).toEqual(['ui', 'master', 'mute', 'reducedIntensity']);
    unsubscribe();
    mixer.setBusVolume('ui', 0.9);
    expect(changes).toHaveLength(4);
  });

  it('switches shaping when reduced intensity is on', () => {
    const mixer = new MixerState();
    expect(mixer.shaping.peakScale).toBe(1);
    mixer.setReducedAudioIntensity(true);
    expect(mixer.reducedAudioIntensity).toBe(true);
    expect(mixer.shaping.peakScale).toBeLessThan(1);
    expect(mixer.shaping.attackScale).toBeGreaterThan(1);
  });

  it('round-trips a snapshot and resets to defaults', () => {
    const mixer = new MixerState();
    mixer.setMasterVolume(0.44);
    mixer.setBusVolume('voice', 0.11);
    mixer.setMuted(true);
    mixer.setReducedAudioIntensity(true);
    const snapshot = mixer.snapshot();

    const restored = new MixerState();
    restored.restore(snapshot);
    expect(restored.snapshot()).toEqual(snapshot);

    // Junk in a stored snapshot is ignored or clamped, never trusted.
    restored.restore({ master: 99, buses: { fire: -1 } as never });
    expect(restored.getMasterVolume()).toBe(1);
    expect(restored.getBusVolume('fire')).toBe(0);

    restored.reset();
    expect(restored.getBusVolume('fire')).toBe(DEFAULT_BUS_VOLUMES.fire);
    expect(restored.muted).toBe(false);
    expect(restored.reducedAudioIntensity).toBe(false);
  });

  it('accepts initial state through the constructor', () => {
    const mixer = new MixerState({ master: 0.25, muted: true, buses: { ui: 0.05 } as never });
    expect(mixer.getMasterVolume()).toBe(0.25);
    expect(mixer.muted).toBe(true);
    expect(mixer.getBusVolume('ui')).toBe(0.05);
    expect(mixer.getBusVolume('fire')).toBe(DEFAULT_BUS_VOLUMES.fire);
  });
});

/* -------------------------------------------------------------------------- */
/* pooling and scheduling                                                      */
/* -------------------------------------------------------------------------- */

describe('pooling and scheduling', () => {
  it('reuses pooled objects instead of allocating', () => {
    let built = 0;
    let reset = 0;
    const pool = new ObjectPool(
      () => ({ id: (built += 1) }),
      () => {
        reset += 1;
      },
      2,
    );
    expect(pool.stats.created).toBe(2);
    expect(pool.stats.free).toBe(2);

    const a = pool.acquire();
    const b = pool.acquire();
    expect(pool.stats.created).toBe(2); // warm items, no new allocation
    expect(pool.stats.inUse).toBe(2);

    const c = pool.acquire();
    expect(pool.stats.created).toBe(3);
    expect(pool.stats.highWater).toBe(3);

    pool.release(a);
    expect(reset).toBe(1);
    expect(pool.acquire()).toBe(a); // the same object comes back
    pool.release(b);
    pool.release(c);
  });

  it('never exceeds a Poisson scheduler budget, and counts what it drops', () => {
    const scheduler = new PoissonScheduler(createRng(2));
    const out = new Float64Array(4);
    expect(scheduler.peek()).toBe(Number.POSITIVE_INFINITY);
    expect(scheduler.collect(100, out)).toBe(0);

    scheduler.setRate(200, 0);
    const count = scheduler.collect(1, out);
    expect(count).toBe(4);
    expect(scheduler.dropped).toBeGreaterThan(0);
    // Times are in order and inside the horizon.
    for (let i = 1; i < count; i += 1) {
      expect(out[i] ?? 0).toBeGreaterThan(out[i - 1] ?? 0);
      expect(out[i] ?? 0).toBeLessThanOrEqual(1);
    }
  });

  it('produces about lambda*T events over a long horizon', () => {
    const scheduler = new PoissonScheduler(createRng(17));
    const out = new Float64Array(64);
    scheduler.setRate(8, 0);
    let total = 0;
    let now = 0;
    for (let step = 0; step < 400; step += 1) {
      now += 0.25;
      total += scheduler.collect(now, out);
    }
    expect(scheduler.dropped).toBe(0);
    // 8/s over 100 s; allow generous slack for a stochastic process.
    expect(total).toBeGreaterThan(700);
    expect(total).toBeLessThan(900);
  });

  it('stops dead at rate zero and re-arms from the current time', () => {
    const scheduler = new PoissonScheduler(createRng(4));
    scheduler.setRate(10, 0);
    expect(scheduler.peek()).toBeGreaterThan(0);
    scheduler.setRate(0, 1);
    expect(scheduler.peek()).toBe(Number.POSITIVE_INFINITY);
    expect(scheduler.collect(1000, new Float64Array(8))).toBe(0);

    scheduler.setRate(10, 500);
    expect(scheduler.peek()).toBeGreaterThan(500);
    expect(scheduler.peek()).toBeLessThan(505);
  });

  it('advances the look-ahead window and collapses long gaps', () => {
    const window = new LookaheadWindow(0.25, 1);
    window.reset(10);
    expect(window.advance(10)).toBeCloseTo(10.25);
    // Each call extends the horizon by however much the clock moved.
    expect(window.advance(10.05)).toBeCloseTo(10.3);
    expect(window.advance(10.2)).toBeCloseTo(10.45);
    // No clock movement means nothing new to schedule.
    expect(window.advance(10.2)).toBeNull();
    // A backgrounded tab must not dump a backlog on return.
    const horizon = window.advance(60) ?? 0;
    expect(horizon).toBeCloseTo(60.25);
  });
});

/* -------------------------------------------------------------------------- */
/* spatial                                                                     */
/* -------------------------------------------------------------------------- */

describe('spatialisation maths', () => {
  const base = { refDistance: 1, maxDistance: 100, rolloffFactor: 1 };

  it('matches the WebAudio distance model formulas', () => {
    const inverse = { ...base, distanceModel: 'inverse' as DistanceModelType };
    expect(computeDistanceGain(1, inverse)).toBeCloseTo(1);
    expect(computeDistanceGain(2, inverse)).toBeCloseTo(0.5);
    expect(computeDistanceGain(9, inverse)).toBeCloseTo(1 / 9, 6);
    // Closer than the reference distance does not get louder than 1.
    expect(computeDistanceGain(0.01, inverse)).toBeCloseTo(1);

    const exponential = { ...base, distanceModel: 'exponential' as DistanceModelType };
    expect(computeDistanceGain(4, exponential)).toBeCloseTo(0.25);

    const linear = { ...base, distanceModel: 'linear' as DistanceModelType };
    expect(computeDistanceGain(1, linear)).toBeCloseTo(1);
    expect(computeDistanceGain(50.5, linear)).toBeCloseTo(0.5, 2);
    expect(computeDistanceGain(1000, linear)).toBeCloseTo(0);
  });

  it('is monotonically quieter with distance in every model', () => {
    for (const model of ['inverse', 'linear', 'exponential'] as DistanceModelType[]) {
      let prev = Number.POSITIVE_INFINITY;
      for (let d = 1; d < 120; d += 3) {
        const gain = computeDistanceGain(d, { ...base, distanceModel: model });
        expect(gain).toBeLessThanOrEqual(prev + 1e-9);
        expect(gain).toBeGreaterThanOrEqual(0);
        expect(gain).toBeLessThanOrEqual(1);
        prev = gain;
      }
    }
  });

  it('drops HRTF once the source budget is exceeded', () => {
    expect(choosePanningModel('hrtf', 500)).toBe('HRTF');
    expect(choosePanningModel('equalpower', 0)).toBe('equalpower');
    expect(choosePanningModel('auto', 4)).toBe('HRTF');
    expect(choosePanningModel('auto', 400)).toBe('equalpower');
    expect(choosePanningModel('auto', 3, 2)).toBe('equalpower');
  });

  it('orthonormalises a sloppy listener basis', () => {
    const forward = { x: 0, y: 0, z: 0 };
    const up = { x: 0, y: 0, z: 0 };
    orthonormalizeBasis({ x: 0, y: 0.4, z: -1 }, { x: 0, y: 1, z: 0 }, forward, up);

    const lenF = Math.hypot(forward.x, forward.y, forward.z);
    const lenU = Math.hypot(up.x, up.y, up.z);
    expect(lenF).toBeCloseTo(1, 9);
    expect(lenU).toBeCloseTo(1, 9);
    expect(forward.x * up.x + forward.y * up.y + forward.z * up.z).toBeCloseTo(0, 9);
  });

  it('falls back to a sane forward vector for a degenerate input', () => {
    const out = { x: 9, y: 9, z: 9 };
    normalizeVec3({ x: 0, y: 0, z: 0 }, out);
    expect(out).toEqual({ x: 0, y: 0, z: -1 });
  });
});

/* -------------------------------------------------------------------------- */
/* fire mapping                                                                */
/* -------------------------------------------------------------------------- */

describe('fire state mapping', () => {
  const map = (state: Partial<Record<string, number>>) =>
    mapFireState({ ...DEFAULT_FIRE_STATE, ...state } as never, createFireVoiceParams());

  it('is silent for a dead fire', () => {
    const p = map({});
    expect(p.roarGain).toBe(0);
    expect(p.rumbleGain).toBe(0);
    expect(p.hissGain).toBe(0);
    expect(p.emberGain).toBe(0);
    // A dead fire crackles exactly zero times, not once a minute.
    expect(p.crackleRatePerSecond).toBe(0);
  });

  it('opens the roar filter and raises its level with intensity', () => {
    let prevGain = -1;
    let prevCutoff = -1;
    for (let i = 0; i <= 1.0001; i += 0.1) {
      const p = map({ intensity: i });
      expect(p.roarGain).toBeGreaterThanOrEqual(prevGain);
      expect(p.roarCutoffHz).toBeGreaterThan(prevCutoff);
      prevGain = p.roarGain;
      prevCutoff = p.roarCutoffHz;
    }
    expect(map({ intensity: 1 }).roarGain).toBeGreaterThan(0.4);
    expect(map({ intensity: 1 }).roarCutoffHz).toBeGreaterThan(800);
  });

  it('needs both fuel and heat for rumble, and both heat and fuel for hiss', () => {
    expect(map({ intensity: 1, fuelLoad: 0 }).rumbleGain).toBe(0);
    expect(map({ intensity: 0.1, fuelLoad: 1 }).rumbleGain).toBe(0);
    expect(map({ intensity: 1, fuelLoad: 1 }).rumbleGain).toBeGreaterThan(0.3);
    // More fuel means a deeper rumble.
    expect(map({ intensity: 1, fuelLoad: 1 }).rumbleCutoffHz).toBeGreaterThan(
      map({ intensity: 1, fuelLoad: 0.2 }).rumbleCutoffHz,
    );
    expect(map({ intensity: 0 }).hissGain).toBe(0);
    expect(map({ intensity: 0.7, fuelLoad: 1 }).hissGain).toBeGreaterThan(
      map({ intensity: 0.7, fuelLoad: 0 }).hissGain,
    );
  });

  it('lets embers speak when the flames drop', () => {
    const lowFlame = map({ emberHeat: 1, intensity: 0.05 });
    const highFlame = map({ emberHeat: 1, intensity: 1 });
    expect(lowFlame.emberGain).toBeGreaterThan(highFlame.emberGain);
    expect(map({ emberHeat: 0 }).emberGain).toBe(0);
    // Hotter coals snap brighter.
    expect(map({ emberHeat: 1, intensity: 0.5 }).crackleCenterHz).toBeGreaterThan(
      map({ emberHeat: 0.1, intensity: 0.5 }).crackleCenterHz,
    );
  });

  it('drives crackle rate from dryness, intensity and wind, and caps it', () => {
    const calm = map({ intensity: 1, crackleRate: 1, windSpeed: 0 });
    const windy = map({ intensity: 1, crackleRate: 1, windSpeed: 1 });
    expect(windy.crackleRatePerSecond).toBeGreaterThan(calm.crackleRatePerSecond);
    expect(map({ intensity: 1, crackleRate: 1 }).crackleRatePerSecond).toBeGreaterThan(
      map({ intensity: 1, crackleRate: 0.2 }).crackleRatePerSecond,
    );
    // Nothing the simulation can say produces an unplayable rate.
    const insane = map({ intensity: 99, crackleRate: 99, windSpeed: 99, fuelLoad: 99, emberHeat: 99 });
    expect(insane.crackleRatePerSecond).toBeLessThanOrEqual(MAX_CRACKLE_RATE);
    expect(insane.roarGain).toBeLessThanOrEqual(0.75);
    expect(insane.cracklePeakGain).toBeLessThanOrEqual(0.85);
  });

  it('turns wind into flutter modulation', () => {
    const still = map({ intensity: 1, windSpeed: 0 });
    const gale = map({ intensity: 1, windSpeed: 1 });
    expect(still.windFlutterDepth).toBe(0);
    expect(gale.windFlutterDepth).toBeGreaterThan(0);
    expect(gale.windFlutterHz).toBeGreaterThan(still.windFlutterHz);
    // Flutter is proportional to the roar, so it cannot exceed it.
    expect(gale.windFlutterDepth).toBeLessThan(gale.roarGain);
  });

  it('sanitises hostile input rather than trusting it', () => {
    const p = mapFireState(
      { intensity: Number.NaN, emberHeat: -5, fuelLoad: Number.POSITIVE_INFINITY, windSpeed: -1, crackleRate: Number.NaN },
      createFireVoiceParams(),
    );
    for (const value of Object.values(p)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });

  it('writes into the caller-owned object without allocating', () => {
    const out = createFireVoiceParams();
    const result = mapFireState({ ...DEFAULT_FIRE_STATE, intensity: 0.5 }, out);
    expect(result).toBe(out);
  });
});

/* -------------------------------------------------------------------------- */
/* ambience profile and activity curves                                        */
/* -------------------------------------------------------------------------- */

describe('ambience profiles', () => {
  it('merges manifest fragments over the defaults', () => {
    const profile = resolveAmbienceProfile({ id: 'test', wind: { level: 0.9 } });
    expect(profile.id).toBe('test');
    expect(profile.wind.level).toBe(0.9);
    // Untouched fields keep the default character.
    expect(profile.wind.gustRateHz).toBe(DEFAULT_AMBIENCE_PROFILE.wind.gustRateHz);
    expect(profile.insects.baseHz).toBe(DEFAULT_AMBIENCE_PROFILE.insects.baseHz);
    expect(profile.reverb.space).toBe(DEFAULT_AMBIENCE_PROFILE.reverb.space);
  });

  it('clamps hostile manifest values into a safe mix', () => {
    const profile = resolveAmbienceProfile({
      wind: { level: 40, gustRateHz: 900, cutoffHz: 900000 },
      insects: { density: -3, pulsesPerChirp: 99.7, chirpsPerMinute: -10 },
      roomTone: { level: 7, cutoffHz: 0 },
      birds: { callsPerMinute: 9999, kinds: [] },
    });
    expect(profile.wind.level).toBe(1);
    expect(profile.wind.gustRateHz).toBeLessThanOrEqual(2);
    expect(profile.wind.cutoffHz).toBeLessThan(24000);
    expect(profile.insects.density).toBe(0);
    expect(profile.insects.pulsesPerChirp).toBe(16);
    expect(profile.insects.chirpsPerMinute).toBe(0);
    expect(profile.roomTone.level).toBe(1);
    expect(profile.roomTone.cutoffHz).toBeGreaterThanOrEqual(10);
    expect(profile.birds.callsPerMinute).toBeLessThanOrEqual(60);
    // An empty kind list would make bird scheduling meaningless.
    expect(profile.birds.kinds.length).toBeGreaterThan(0);
  });

  it('layers presets on top of the defaults', () => {
    const lakeside = AMBIENCE_PRESETS.lakeside;
    expect(lakeside).toBeDefined();
    if (!lakeside) return;
    expect(lakeside.water.enabled).toBe(true);
    expect(lakeside.reverb.space).toBe('clearing');
    expect(AMBIENCE_PRESETS.winterHollow?.reverb.space).toBe('snowfield');
    expect(AMBIENCE_PRESETS.canyonMouth?.reverb.space).toBe('canyon');
    // Every preset is a fully resolved, in-range profile.
    for (const preset of Object.values(AMBIENCE_PRESETS)) {
      expect(preset.wind.level).toBeLessThanOrEqual(1);
      expect(preset.insects.density).toBeLessThanOrEqual(1);
      expect(preset.birds.kinds.length).toBeGreaterThan(0);
    }
  });

  it('models night as a smooth 24-hour curve', () => {
    expect(nightFactor(0)).toBeCloseTo(1);
    expect(nightFactor(0.5)).toBeCloseTo(0); // midday
    expect(nightFactor(0.95)).toBeCloseTo(1);
    expect(nightFactor(0.28)).toBeGreaterThan(0);
    expect(nightFactor(0.28)).toBeLessThan(1);
    // Wraps across days.
    expect(nightFactor(2.5)).toBeCloseTo(nightFactor(0.5));
  });

  it('silences the insects when it is cold, loud, wet or windy', () => {
    const profile = resolveAmbienceProfile({ insects: { density: 1, minTemperatureC: 10 } });
    const warm = { ...DEFAULT_AMBIENCE_CONDITIONS, temperatureC: 22, windSpeed: 0, timeOfDay: 0 };

    const base = insectActivity(profile, warm);
    expect(base).toBeGreaterThan(0.5);

    // Below the threshold they stop completely, not just quieten.
    expect(insectActivity(profile, { ...warm, temperatureC: 9 })).toBe(0);
    expect(insectActivity(profile, { ...warm, temperatureC: 4 })).toBe(0);

    expect(insectActivity(profile, { ...warm, playerLoudness: 1 })).toBe(0);
    expect(insectActivity(profile, { ...warm, playerLoudness: 0.5 })).toBeLessThan(base);
    expect(insectActivity(profile, { ...warm, windSpeed: 1 })).toBeLessThan(base * 0.4);
    expect(insectActivity(profile, { ...warm, wetness: 1 })).toBeLessThan(base * 0.5);
    expect(insectActivity(profile, { ...warm, timeOfDay: 0.5 })).toBeLessThan(base);

    // Density scales the whole chorus, and zero density means no layer at all.
    const sparse = resolveAmbienceProfile({ insects: { density: 0.25, minTemperatureC: 10 } });
    expect(insectActivity(sparse, warm)).toBeCloseTo(base * 0.25, 6);
    expect(insectActivity(resolveAmbienceProfile({ insects: { density: 0 } }), warm)).toBe(0);
  });

  it('never runs an insect voice at zero activity', () => {
    expect(insectVoiceCount(0, 5)).toBe(0);
    expect(insectVoiceCount(0.01, 5)).toBe(1);
    expect(insectVoiceCount(1, 5)).toBe(5);
    expect(insectVoiceCount(2, 5)).toBe(5);
  });

  it('schedules bird calls only when they make sense', () => {
    const profile = resolveAmbienceProfile({ birds: { enabled: true, callsPerMinute: 6 } });
    const night = { ...DEFAULT_AMBIENCE_CONDITIONS, timeOfDay: 0, windSpeed: 0, playerLoudness: 0 };
    expect(birdCallRate(profile, night)).toBeCloseTo(0.1, 6);
    expect(birdCallRate(profile, { ...night, timeOfDay: 0.5 })).toBeLessThan(0.1);
    expect(birdCallRate(profile, { ...night, windSpeed: 1 })).toBeLessThan(0.1);
    expect(birdCallRate(profile, { ...night, playerLoudness: 1 })).toBe(0);
    expect(birdCallRate(resolveAmbienceProfile({ birds: { enabled: false } }), night)).toBe(0);
  });

  it('scales the wind bed with the weather', () => {
    const profile = resolveAmbienceProfile({ wind: { level: 0.5, cutoffHz: 500 } });
    const calm = { ...DEFAULT_AMBIENCE_CONDITIONS, windSpeed: 0 };
    const gale = { ...DEFAULT_AMBIENCE_CONDITIONS, windSpeed: 1 };
    expect(windLevel(profile, gale)).toBeGreaterThan(windLevel(profile, calm));
    expect(windLevel(profile, gale)).toBeLessThanOrEqual(1);
    // A stronger wind whistles higher.
    expect(windCutoff(profile, gale)).toBeGreaterThan(windCutoff(profile, calm));
  });
});

/* -------------------------------------------------------------------------- */
/* machine specs                                                               */
/* -------------------------------------------------------------------------- */

describe('SM-01 specifications', () => {
  it('gives every relay a distinguishable character', () => {
    expect(RELAY_CHARACTERS.length).toBeGreaterThanOrEqual(4);
    const contactFrequencies = new Set(RELAY_CHARACTERS.map((r) => r.contactHz));
    const coilFrequencies = new Set(RELAY_CHARACTERS.map((r) => r.coilHz));
    expect(contactFrequencies.size).toBe(RELAY_CHARACTERS.length);
    expect(coilFrequencies.size).toBe(RELAY_CHARACTERS.length);
    // They differ in more than pitch: bounce count and decay vary too.
    expect(new Set(RELAY_CHARACTERS.map((r) => r.bounces)).size).toBeGreaterThan(1);
    expect(new Set(RELAY_CHARACTERS.map((r) => r.decay)).size).toBe(RELAY_CHARACTERS.length);
  });

  it('wraps relay indices in both directions', () => {
    expect(relayCharacter(0)).toBe(RELAY_CHARACTERS[0]);
    expect(relayCharacter(RELAY_CHARACTERS.length)).toBe(RELAY_CHARACTERS[0]);
    expect(relayCharacter(-1)).toBe(RELAY_CHARACTERS[RELAY_CHARACTERS.length - 1]);
    expect(relayCharacter(7.9)).toBe(relayCharacter(7));
  });

  it('derives the fan curve from real blade-pass geometry', () => {
    const stopped = fanCurve(0, createFanCurve());
    expect(stopped.level).toBe(0);
    expect(stopped.bladeHz).toBe(0);
    expect(stopped.bladeLevel).toBe(0);

    const full = fanCurve(1, createFanCurve());
    expect(full.bladeHz).toBeCloseTo((FAN_MAX_RPM / 60) * FAN_BLADES, 4);
    expect(full.level).toBeGreaterThan(0.3);

    let prev = -1;
    for (let s = 0; s <= 1.0001; s += 0.1) {
      const curve = fanCurve(s, createFanCurve());
      expect(curve.level).toBeGreaterThanOrEqual(prev);
      expect(curve.cutoffHz).toBeGreaterThanOrEqual(260);
      prev = curve.level;
    }
    // Out-of-range speeds are clamped, not extrapolated.
    expect(fanCurve(4, createFanCurve()).level).toBeCloseTo(full.level);
  });

  it('accelerates frost ticks superlinearly and caps them', () => {
    expect(frostTickRate(0)).toBe(0);
    expect(frostTickRate(-1)).toBe(0);
    const quarter = frostTickRate(0.25);
    const half = frostTickRate(0.5);
    const full = frostTickRate(1);
    expect(quarter).toBeGreaterThan(0);
    expect(half - quarter).toBeLessThan(full - half); // superlinear
    expect(full).toBeLessThanOrEqual(18);
    expect(frostTickRate(99)).toBeLessThanOrEqual(18);
  });

  it('places the compressor hum on real motor and mains frequencies', () => {
    const { mechanicalHz, rippleHz } = compressorFrequencies(60, 0.035);
    expect(rippleHz).toBe(120);
    expect(mechanicalHz).toBeCloseTo(28.95, 2); // 4-pole, 3.5% slip
    expect(compressorFrequencies(50).rippleHz).toBe(100);
    // Slip always makes the motor run below synchronous speed.
    expect(compressorFrequencies(60, 0).mechanicalHz).toBe(30);
    expect(compressorFrequencies(60, 0.1).mechanicalHz).toBeLessThan(30);
  });

  it('keeps the utility beeps small and restrained', () => {
    for (const kind of BEEP_KINDS) {
      const spec = BEEP_SPECS[kind];
      expect(spec.steps.length).toBeGreaterThan(0);
      expect(spec.peak).toBeLessThanOrEqual(0.3);
      expect(spec.durationSeconds).toBeLessThanOrEqual(0.1);
      for (const hz of spec.steps) {
        expect(hz).toBeGreaterThan(200);
        expect(hz).toBeLessThan(4000);
      }
    }
    // "Deny" falls rather than rises — the only one with two steps.
    const deny = BEEP_SPECS.deny;
    expect(deny.steps.length).toBe(2);
    expect(deny.steps[1] ?? 0).toBeLessThan(deny.steps[0] ?? 0);
  });
});

/* -------------------------------------------------------------------------- */
/* foley specs                                                                 */
/* -------------------------------------------------------------------------- */

describe('foley mapping', () => {
  const map = (state: Partial<Record<string, number>>) =>
    sizzleParams({ heat: 0, moisture: 1, browning: 0, scorch: 0, ...state } as never, createSizzleParams());

  it('needs both heat and moisture to sizzle', () => {
    expect(map({ heat: 0, moisture: 1 }).hissGain).toBe(0);
    expect(map({ heat: 1, moisture: 0 }).hissGain).toBe(0);
    expect(map({ heat: 1, moisture: 1 }).hissGain).toBeGreaterThan(0.25);
    expect(map({ heat: 1, moisture: 1 }).popRatePerSecond).toBeGreaterThan(10);
    expect(map({ heat: 0, moisture: 1 }).popRatePerSecond).toBe(0);
  });

  it('gets drier and brighter as the surface dries out', () => {
    const wet = map({ heat: 1, moisture: 1 });
    const dry = map({ heat: 1, moisture: 0.1 });
    expect(dry.hissCenterHz).toBeGreaterThan(wet.hissCenterHz);
    expect(dry.hissQ).toBeGreaterThan(wet.hissQ);
    expect(dry.hissGain).toBeLessThan(wet.hissGain);
  });

  it('adds caramel crackle only on a dry, browning, hot surface', () => {
    const raw = map({ heat: 1, moisture: 0.2, browning: 0 });
    const caramelised = map({ heat: 1, moisture: 0.2, browning: 1 });
    expect(caramelised.popRatePerSecond).toBeGreaterThan(raw.popRatePerSecond);
    expect(caramelised.popCenterHz).toBeGreaterThan(raw.popCenterHz);
    expect(map({ heat: 0, browning: 1, moisture: 0 }).popRatePerSecond).toBe(0);
  });

  it('brings in the scorch roar only near ignition, superlinearly', () => {
    expect(map({ scorch: 0 }).scorchGain).toBe(0);
    const low = map({ scorch: 0.3 }).scorchGain;
    const mid = map({ scorch: 0.6 }).scorchGain;
    const high = map({ scorch: 1 }).scorchGain;
    expect(low).toBeGreaterThan(0);
    expect(mid - low).toBeLessThan(high - mid);
    expect(high).toBeLessThanOrEqual(0.24);
  });

  it('clamps everything, including nonsense input', () => {
    const p = sizzleParams({ heat: 99, moisture: -5, browning: Number.NaN, scorch: 99 } as never, createSizzleParams());
    for (const value of Object.values(p)) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
    expect(p.popRatePerSecond).toBeLessThanOrEqual(24);
  });

  it('defines a distinct spec for every ground material', () => {
    for (const material of FOOTSTEP_MATERIALS) {
      const spec = footstepSpec(material);
      expect(spec).toBe(FOOTSTEP_SPECS[material]);
      expect(spec.grains).toBeGreaterThan(0);
      expect(spec.bodyPeak).toBeGreaterThan(0);
    }
    // Snow is the tightest, brightest crunch; wood is the only one that rings.
    expect(FOOTSTEP_SPECS.snow.grainQ).toBeGreaterThan(FOOTSTEP_SPECS.gravel.grainQ);
    expect(FOOTSTEP_SPECS.snow.brightness).toBeGreaterThan(FOOTSTEP_SPECS.wetGrass.brightness);
    expect(FOOTSTEP_SPECS.woodDeck.partials.length).toBeGreaterThan(0);
    expect(FOOTSTEP_SPECS.gravel.partials.length).toBe(0);
    // An unknown material must not throw at runtime.
    expect(footstepSpec('quicksand' as never)).toBe(FOOTSTEP_SPECS.pineNeedles);
  });
});

/* -------------------------------------------------------------------------- */
/* engine, driven headlessly                                                   */
/* -------------------------------------------------------------------------- */

describe('AudioEngine (headless)', () => {
  it('constructs without an AudioContext and reports it', () => {
    const engine = new AudioEngine();
    expect(engine.status).toBe('idle');
    expect(engine.context).toBeNull();
    expect(engine.initialized).toBe(false);
    expect(engine.fire).toBeNull();
    expect(engine.machine).toBeNull();
    // No WebAudio in Node, so this must fail softly rather than throw.
    expect(AudioEngine.supported).toBe(false);
  });

  it('accepts mixer changes before the context exists and applies them on resume', async () => {
    const { engine, ctx } = makeEngine();
    engine.setBusVolume('fire', 0.5);
    engine.setMasterVolume(0.6);
    expect(engine.getBusVolume('fire')).toBe(0.5);
    expect(ctx.nodes).toHaveLength(0);

    expect(await engine.resume()).toBe(true);
    expect(engine.status).toBe('running');
    expect(ctx.state).toBe('running');

    const master = ctx.nodes.find((n): n is FakeGainNode => n instanceof FakeGainNode);
    expect(master?.gain.value).toBeCloseTo(volumeToGain(0.6));
    await engine.close();
  });

  it('builds the full bus graph exactly once', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    await engine.resume(); // idempotent

    expect(ctx.countOf('compressor')).toBe(1); // the safety limiter
    expect(ctx.countOf('convolver')).toBe(1); // one shared reverb
    expect(engine.busInput('fire')).not.toBeNull();
    expect(engine.busInput('voice')).not.toBeNull();
    // Every bus reaches the destination.
    for (const bus of BUS_NAMES) {
      const node = engine.busInput(bus) as unknown as FakeGainNode;
      expect(node.reaches('destination')).toBe(true);
    }
    expect(engine.reverb?.space).toBe(DEFAULT_AMBIENCE_PROFILE.reverb.space);
    await engine.close();
  });

  it('renders an impulse response into the convolver', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    const convolver = ctx.nodes.find((n) => n.kind === 'convolver') as unknown as {
      buffer: { numberOfChannels: number; length: number } | null;
      normalize: boolean;
    };
    expect(convolver.buffer).not.toBeNull();
    expect(convolver.buffer?.numberOfChannels).toBe(2);
    expect(convolver.buffer?.length).toBeGreaterThan(1000);
    // Our IRs are pre-normalised, so the convolver must not renormalise them.
    expect(convolver.normalize).toBe(false);
    await engine.close();
  });

  it('routes bus volume changes to the right gain node', async () => {
    const { engine } = makeEngine();
    await engine.resume();
    const fireBus = engine.busInput('fire') as unknown as FakeGainNode;
    const uiBus = engine.busInput('ui') as unknown as FakeGainNode;
    const fireEventsBefore = fireBus.gain.events.length;
    const uiEventsBefore = uiBus.gain.events.length;

    engine.setBusVolume('fire', 0.25);
    expect(fireBus.gain.events.length).toBe(fireEventsBefore + 1);
    expect(uiBus.gain.events.length).toBe(uiEventsBefore);
    expect(fireBus.gain.lastEvent?.type).toBe('setTarget');
    expect(fireBus.gain.lastEvent?.value).toBeCloseTo(volumeToGain(0.25));
    await engine.close();
  });

  it('mutes at the master and restores the previous balance', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    const master = ctx.nodes.find((n): n is FakeGainNode => n instanceof FakeGainNode);
    expect(master).toBeDefined();
    if (!master) return;

    engine.setMasterVolume(0.8);
    const before = master.gain.value;
    engine.setMuted(true);
    expect(master.gain.lastEvent?.value).toBe(0);
    engine.setMuted(false);
    expect(master.gain.lastEvent?.value).toBeCloseTo(before);
    expect(engine.getMasterVolume()).toBe(0.8);
    await engine.close();
  });

  it('tightens the limiter when reduced audio intensity is enabled', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    const limiter = ctx.nodes.find((n) => n.kind === 'compressor') as unknown as {
      threshold: FakeAudioParam;
      ratio: FakeAudioParam;
    };
    const normalThreshold = limiter.threshold.value;
    engine.setReducedAudioIntensity(true);
    expect(engine.reducedAudioIntensity).toBe(true);
    expect(limiter.threshold.value).toBeLessThan(normalThreshold);
    expect(limiter.ratio.value).toBeGreaterThan(0);
    engine.setReducedAudioIntensity(false);
    expect(limiter.threshold.value).toBe(normalThreshold);
    await engine.close();
  });

  it('starts the continuous beds as looping sources', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();

    const looping = ctx.startedSources.filter(
      (s): s is FakeBufferSourceNode => s instanceof FakeBufferSourceNode && s.loop,
    );
    // Fire: roar, hiss, rumble, embers. Ambience: wind, leaves, water x2, room tone.
    expect(looping.length).toBeGreaterThanOrEqual(9);
    for (const source of looping) {
      expect(source.buffer).not.toBeNull();
      expect(source.loopEnd).toBeGreaterThan(0);
      // Every loop starts at a random offset so they cannot phase-lock.
      expect(source.startOffset).toBeGreaterThanOrEqual(0);
    }
    expect(engine.fire?.running).toBe(true);
    expect(engine.ambience?.running).toBe(true);
    await engine.close();
  });

  it('schedules crackles at a rate driven by the fire state', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();
    engine.setFireState({ intensity: 1, emberHeat: 0.8, fuelLoad: 0.8, crackleRate: 1, windSpeed: 0 });

    const rate = engine.fire?.params.crackleRatePerSecond ?? 0;
    expect(rate).toBeGreaterThan(5);

    // Run ten seconds of audio clock through the look-ahead pump.
    let scheduled = 0;
    for (let i = 0; i < 100; i += 1) {
      ctx.advance(0.1);
      scheduled += engine.fire?.pump(ctx.currentTime) ?? 0;
    }
    expect(scheduled).toBeGreaterThan(rate * 10 * 0.5);
    expect(scheduled).toBeLessThan(rate * 10 * 1.5);
    expect(engine.fire?.cracklesScheduled).toBe(scheduled);
    await engine.close();
  });

  it('stops crackling entirely when the fire dies', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();
    engine.setFireState({ intensity: 0, emberHeat: 0, fuelLoad: 0, crackleRate: 1 });
    let scheduled = 0;
    for (let i = 0; i < 50; i += 1) {
      ctx.advance(0.2);
      scheduled += engine.fire?.pump(ctx.currentTime) ?? 0;
    }
    expect(scheduled).toBe(0);
    await engine.close();
  });

  it('pushes fire state onto real params without re-creating nodes', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();
    const nodesAfterStart = ctx.nodes.length;

    for (let i = 0; i < 200; i += 1) {
      engine.setFireState({ intensity: i / 200 });
    }
    // The per-frame update path creates nothing.
    expect(ctx.nodes.length).toBe(nodesAfterStart);
    await engine.close();
  });

  it('separates the latch into two stages about 70 ms apart', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);
    const mark = ctx.nodes.length;
    engine.machine?.latchClunk();

    const gains = gainsAfter(ctx, mark);
    const starts = gains
      .map((gain) => gain.gain.events.find((e) => e.type === 'linearRamp')?.time ?? 0)
      .filter((t) => t > 0)
      .sort((a, b) => a - b);
    expect(starts.length).toBeGreaterThanOrEqual(4);
    const first = starts[0] ?? 0;
    const last = starts[starts.length - 1] ?? 0;
    // Travel transient, then the arrival — the gap is what sells the mass.
    expect(last - first).toBeGreaterThan(0.05);
    expect(last - first).toBeLessThan(0.12);
    // A low pitched body is part of the arrival.
    const oscillators = oscillatorsStartedAfter(ctx, mark);
    expect(oscillators.some((o) => o.frequency.events.some((e) => e.value < 100))).toBe(true);
    await engine.close();
  });

  it('gives each relay index its own contact band', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);

    const contactBandFor = (index: number): number => {
      const mark = ctx.nodes.length;
      engine.machine?.relayClick(index);
      const frequencies = filtersAfter(ctx, mark)
        .filter((f) => f.type === 'bandpass')
        .map((f) => f.frequency.value);
      return Math.max(...frequencies);
    };

    const reed = contactBandFor(3); // small bright reed relay
    const interlock = contactBandFor(4); // heavy low interlock
    expect(reed).toBeGreaterThan(interlock * 2);
    await engine.close();
  });

  it('runs the compressor as a harmonic stack that glides up and settles', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);
    const mark = ctx.nodes.length;

    expect(engine.machine?.compressorRunning).toBe(false);
    engine.machine?.compressorStart();
    expect(engine.machine?.compressorRunning).toBe(true);

    const oscillators = oscillatorsStartedAfter(ctx, mark);
    // Harmonic stack + mains ripple + drift LFO + the contactor's coil thump.
    expect(oscillators.length).toBeGreaterThanOrEqual(7);
    // The whole harmonic stack glides upward as the motor pulls in.
    const glidingUp = oscillators.filter((o) => {
      const setValue = o.frequency.eventsOfType('setValue')[0];
      const ramp = o.frequency.eventsOfType('exponentialRamp')[0];
      return setValue !== undefined && ramp !== undefined && ramp.value > setValue.value;
    });
    expect(glidingUp.length).toBe(COMPRESSOR_HARMONICS.length);
    for (const osc of glidingUp) {
      const setValue = osc.frequency.eventsOfType('setValue')[0];
      const ramp = osc.frequency.eventsOfType('exponentialRamp')[0];
      // Spin-up starts well below running speed.
      expect((setValue?.value ?? 0) / (ramp?.value ?? 1)).toBeLessThan(0.6);
    }
    // Mains ripple sits at twice line frequency and does not glide.
    expect(oscillators.some((o) => Math.abs(o.frequency.value - 120) < 0.001)).toBe(true);

    engine.machine?.compressorStop();
    expect(engine.machine?.compressorRunning).toBe(false);
    for (const osc of oscillators) {
      if (osc.startedAt !== null) expect(osc.stoppedAt).not.toBeNull();
    }
    await engine.close();
  });

  it('ramps the fan and voices the blade tone at the geometric frequency', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);
    const mark = ctx.nodes.length;

    engine.machine?.fanRamp(0.5);
    expect(engine.machine?.fanSpeed).toBe(0.5);
    const params = engine.machine?.fanParams;
    expect(params?.bladeHz).toBeCloseTo((0.5 * FAN_MAX_RPM / 60) * FAN_BLADES, 3);

    const oscillators = oscillatorsStartedAfter(ctx, mark);
    const blade = oscillators.find((o) => o.type === 'triangle');
    expect(blade).toBeDefined();

    // Ramping up must open the low-pass further.
    const filters = filtersAfter(ctx, mark).filter((f) => f.type === 'lowpass');
    const lowCutoff = filters[0]?.frequency.lastEvent?.value ?? 0;
    engine.machine?.fanRamp(1);
    const highCutoff = filters[0]?.frequency.lastEvent?.value ?? 0;
    expect(highCutoff).toBeGreaterThan(lowCutoff);

    engine.machine?.fanRamp(0);
    expect(engine.machine?.fanSpeed).toBe(0);
    expect(blade?.stoppedAt).not.toBeNull();
    await engine.close();
  });

  it('scales frost ticks with frost coverage', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();

    const ticksOver = (intensity: number, seconds: number): number => {
      engine.machine?.frostCrackle(intensity);
      let total = 0;
      for (let i = 0; i < seconds * 10; i += 1) {
        ctx.advance(0.1);
        total += engine.machine?.pump(ctx.currentTime) ?? 0;
      }
      return total;
    };

    expect(ticksOver(0, 5)).toBe(0);
    const light = ticksOver(0.2, 20);
    const heavy = ticksOver(1, 20);
    expect(light).toBeGreaterThan(0);
    expect(heavy).toBeGreaterThan(light * 3);
    expect(engine.machine?.frostIntensity).toBe(1);
    await engine.close();
  });

  it('plays a restrained completion tone rather than a jingle', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);
    const mark = ctx.nodes.length;
    engine.machine?.completionTone();

    const oscillators = oscillatorsStartedAfter(ctx, mark);
    const pitches = oscillators.map((o) => o.frequency.value).filter((hz) => hz > 200);
    expect(pitches).toContain(523.25);
    // The second note is lower than the first: it falls, it does not celebrate.
    expect(Math.min(...pitches)).toBeLessThan(523.25);
    // And it is quiet.
    expect(peakScheduled(gainsAfter(ctx, mark))).toBeLessThanOrEqual(0.4);
    await engine.close();
  });

  it('keeps the CRT whine quiet, toggleable and below the painful band', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);
    const mark = ctx.nodes.length;

    engine.machine?.crtWhine(true);
    expect(engine.machine?.crtOn).toBe(true);
    const oscillators = oscillatorsStartedAfter(ctx, mark);
    const fundamental = oscillators.find((o) => o.frequency.value > 5000 && o.frequency.value < 12000);
    expect(fundamental).toBeDefined();
    expect(fundamental?.frequency.value).toBeLessThan(15700); // deliberately not a real flyback
    expect(peakScheduled(gainsAfter(ctx, mark))).toBeLessThan(0.05);

    engine.machine?.crtWhine(false);
    expect(engine.machine?.crtOn).toBe(false);
    expect(fundamental?.stoppedAt).not.toBeNull();
    await engine.close();
  });

  it('emits one oscillator per beep step', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);

    const mark = ctx.nodes.length;
    engine.machine?.beep('deny');
    const denyOscillators = oscillatorsStartedAfter(ctx, mark);
    expect(denyOscillators).toHaveLength(BEEP_SPECS.deny.steps.length);
    expect(denyOscillators[0]?.startedAt ?? 0).toBeLessThan(denyOscillators[1]?.startedAt ?? 0);

    const mark2 = ctx.nodes.length;
    engine.machine?.beep('tick');
    expect(oscillatorsStartedAfter(ctx, mark2)).toHaveLength(1);
    await engine.close();
  });

  it('reduced intensity lowers the peak of every transient', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);

    const markLoud = ctx.nodes.length;
    engine.machine?.latchClunk();
    const loudPeak = peakScheduled(gainsAfter(ctx, markLoud));

    engine.setReducedAudioIntensity(true);
    ctx.advance(1);
    const markSoft = ctx.nodes.length;
    engine.machine?.latchClunk();
    const softPeak = peakScheduled(gainsAfter(ctx, markSoft));

    expect(softPeak).toBeLessThan(loudPeak);
    expect(softPeak).toBeLessThanOrEqual(REDUCED_INTENSITY.ceiling);
    await engine.close();
  });

  it('tracks the marshmallow surface with a continuous sizzle bed', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.foley?.startSizzle();
    expect(engine.foley?.sizzleRunning).toBe(true);

    engine.setSizzleState({ heat: 1, moisture: 1 });
    const wet = engine.foley?.sizzleParameters.hissGain ?? 0;
    engine.setSizzleState({ moisture: 0.05 });
    const dry = engine.foley?.sizzleParameters.hissGain ?? 0;
    expect(dry).toBeLessThan(wet);

    // Bubbles keep popping while there is water left.
    engine.setSizzleState({ heat: 1, moisture: 1 });
    let pops = 0;
    for (let i = 0; i < 60; i += 1) {
      ctx.advance(0.1);
      pops += engine.foley?.pump(ctx.currentTime) ?? 0;
    }
    expect(pops).toBeGreaterThan(20);

    engine.foley?.stopSizzle();
    expect(engine.foley?.sizzleRunning).toBe(false);
    await engine.close();
  });

  it('makes a footstep out of a body plus scattered grains', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    ctx.advance(1);

    const mark = ctx.nodes.length;
    engine.foley?.footstep('gravel', 1);
    const grainSources = ctx.nodes
      .slice(mark)
      .filter((n): n is FakeBufferSourceNode => n instanceof FakeBufferSourceNode);
    expect(grainSources.length).toBeGreaterThanOrEqual(FOOTSTEP_SPECS.gravel.grains - 3);
    // The grains are spread through time, not stacked on one instant.
    const times = grainSources.map((s) => s.startedAt ?? 0);
    expect(Math.max(...times) - Math.min(...times)).toBeGreaterThan(0.005);

    // A lighter step uses fewer grains and less level.
    const mark2 = ctx.nodes.length;
    engine.foley?.footstep('gravel', 0.3);
    const lightSources = ctx.nodes
      .slice(mark2)
      .filter((n) => n instanceof FakeBufferSourceNode);
    expect(lightSources.length).toBeLessThan(grainSources.length);
    await engine.close();
  });

  it('places the fire and the machine in 3D and exposes emitters for voice', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    expect(engine.fireEmitter).not.toBeNull();
    expect(engine.machineEmitter).not.toBeNull();
    expect(ctx.countOf('panner')).toBeGreaterThanOrEqual(2);

    engine.setMachinePosition(3, 0, -4);
    const panner = ctx.nodesOf('panner')[1] as unknown as { positionX: FakeAudioParam };
    expect(panner.positionX.lastEvent?.value).toBe(3);

    // A voice emitter is just another emitter on the voice bus.
    const emitter = engine.createEmitter('voice', { refDistance: 1.2 });
    expect(emitter).not.toBeNull();
    expect(engine.emitterCount).toBe(3);
    if (emitter) {
      expect(emitter.panner.refDistance).toBe(1.2);
      // No MediaStream support in the fake context: must return null, not throw.
      expect(emitter.attachMediaStream({} as MediaStream)).toBeNull();
      engine.releaseEmitter(emitter);
    }
    expect(engine.emitterCount).toBe(2);
    await engine.close();
  });

  it('moves the listener with an orthonormalised basis', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.listenerUpdate({ x: 1, y: 2, z: 3 }, { x: 0, y: 0.5, z: -1 }, { x: 0, y: 1, z: 0 });

    expect(ctx.listener.positionX.lastEvent?.value).toBe(1);
    expect(ctx.listener.positionZ.lastEvent?.value).toBe(3);
    const fx = ctx.listener.forwardX.value;
    const fy = ctx.listener.forwardY.value;
    const fz = ctx.listener.forwardZ.value;
    expect(Math.hypot(fx, fy, fz)).toBeCloseTo(1, 6);
    const ux = ctx.listener.upX.value;
    const uy = ctx.listener.upY.value;
    const uz = ctx.listener.upZ.value;
    expect(fx * ux + fy * uy + fz * uz).toBeCloseTo(0, 6);
    await engine.close();
  });

  it('swaps campsite profile and reverb space together', async () => {
    const { engine } = makeEngine();
    await engine.resume();
    const winter = AMBIENCE_PRESETS.winterHollow;
    expect(winter).toBeDefined();
    if (!winter) return;

    engine.setAmbienceProfile(winter);
    expect(engine.ambienceProfile.id).toBe('winterHollow');
    expect(engine.reverb?.space).toBe('snowfield');
    expect(engine.ambience?.profile.reverb.space).toBe('snowfield');

    // Cold enough that nothing chirps.
    engine.setAmbienceConditions({ temperatureC: -4, timeOfDay: 0 });
    expect(engine.ambience?.insectActivityLevel).toBe(0);
    expect(engine.ambience?.insectVoicesActive).toBe(0);

    engine.setAmbienceConditions({ temperatureC: 24 });
    expect(engine.ambience?.insectActivityLevel).toBeGreaterThan(0);
    expect(engine.ambience?.insectVoicesActive).toBeGreaterThan(0);
    await engine.close();
  });

  it('schedules insect chirps and bird calls only while running', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();
    engine.setAmbienceConditions({ temperatureC: 25, timeOfDay: 0, windSpeed: 0, playerLoudness: 0, wetness: 0 });

    let events = 0;
    for (let i = 0; i < 200; i += 1) {
      ctx.advance(0.25);
      events += engine.ambience?.pump(ctx.currentTime) ?? 0;
    }
    expect(events).toBeGreaterThan(20);
    expect(engine.ambience?.birdCallsScheduled ?? 0).toBeGreaterThan(0);

    // A loud player hushes the chorus.
    engine.setAmbienceConditions({ playerLoudness: 1 });
    expect(engine.ambience?.insectActivityLevel).toBe(0);
    await engine.close();
  });

  it('is deterministic for a given seed', async () => {
    const run = async (): Promise<number[]> => {
      const ctx = createFakeAudioContext({ sampleRate: 48000 });
      const engine = new AudioEngine({
        contextFactory: () => ctx as unknown as AudioContext,
        pumpIntervalMs: 0,
        seed: 'lakeside-01',
        noiseBank: { loopSeconds: 0.5, loopFadeSeconds: 0.05, grainCount: 4, grainSeconds: 0.08 },
      });
      await engine.resume();
      engine.startBeds();
      engine.setFireState({ intensity: 0.8, emberHeat: 0.5, fuelLoad: 0.5, crackleRate: 0.7 });
      const counts: number[] = [];
      for (let i = 0; i < 40; i += 1) {
        ctx.advance(0.1);
        counts.push(engine.fire?.pump(ctx.currentTime) ?? 0);
      }
      await engine.close();
      return counts;
    };
    const a = await run();
    const b = await run();
    expect(a).toEqual(b);
    expect(a.reduce((s, n) => s + n, 0)).toBeGreaterThan(0);
  });

  it('suspends, resumes and closes cleanly', async () => {
    const { engine, ctx } = makeEngine();
    await engine.resume();
    engine.startBeds();

    await engine.suspend();
    expect(engine.status).toBe('suspended');
    expect(ctx.state).toBe('suspended');

    await engine.resume();
    expect(engine.status).toBe('running');

    await engine.close();
    expect(engine.status).toBe('closed');
    expect(engine.context).toBeNull();
    expect(engine.fire).toBeNull();
    expect(ctx.closed).toBe(true);
    // Post-close calls are no-ops, not crashes.
    expect(() => engine.setFireState({ intensity: 1 })).not.toThrow();
    expect(engine.pump()).toBe(0);
  });

  it('degrades silently when no AudioContext can be created', async () => {
    const engine = new AudioEngine({ contextFactory: () => null as unknown as AudioContext });
    expect(await engine.resume()).toBe(false);
    expect(engine.status).toBe('unsupported');
    // Everything the game might call must still be safe.
    expect(() => {
      engine.setBusVolume('fire', 0.5);
      engine.setFireState({ intensity: 1 });
      engine.setAmbienceConditions({ temperatureC: 10 });
      engine.setSizzleState({ heat: 1 });
      engine.startBeds();
      engine.listenerUpdate({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -1 }, { x: 0, y: 1, z: 0 });
    }).not.toThrow();
    expect(engine.createEmitter('voice')).toBeNull();
    expect(engine.pump()).toBe(0);
  });
});
