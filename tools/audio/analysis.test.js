import { describe, expect, it } from 'vitest';

import { analyse, averageSpectrum, bandEnergy, envelopeShape, fft, spectralCentroid, spectralFlatness } from './analysis.js';

/**
 * Tests for the analyser, not for the game.
 *
 * Every number in `artifacts/audio/report.json` is only as trustworthy as this
 * file. These drive the measurements with signals whose answers are known from
 * first principles — a sine of a known frequency, white noise, a decaying
 * exponential, digital silence — so a broken FFT or an off-by-one in the band
 * edges fails here rather than quietly reporting that the latch clunk is fine.
 */

const SR = 48000;

function sine(hz, seconds, amplitude = 0.5, sampleRate = SR) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  for (let i = 0; i < out.length; i += 1) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / sampleRate);
  return out;
}

function noise(seconds, amplitude = 0.5, sampleRate = SR) {
  const out = new Float32Array(Math.round(seconds * sampleRate));
  // Deterministic LCG: a flaky test about randomness is useless.
  let state = 12345;
  for (let i = 0; i < out.length; i += 1) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = amplitude * (state / 0x80000000 - 1);
  }
  return out;
}

describe('fft', () => {
  it('turns a unit impulse into a flat spectrum', () => {
    const re = new Float64Array(64);
    const im = new Float64Array(64);
    re[0] = 1;
    fft(re, im);
    for (let bin = 0; bin < 32; bin += 1) expect(Math.hypot(re[bin], im[bin])).toBeCloseTo(1, 10);
  });

  it('puts a sine on its own bin', () => {
    const size = 1024;
    const re = new Float64Array(size);
    const im = new Float64Array(size);
    // Exactly 8 cycles across the window: no leakage.
    for (let i = 0; i < size; i += 1) re[i] = Math.sin((2 * Math.PI * 8 * i) / size);
    fft(re, im);
    const magnitudes = Array.from({ length: size / 2 }, (_, bin) => Math.hypot(re[bin], im[bin]));
    const loudest = magnitudes.indexOf(Math.max(...magnitudes));
    expect(loudest).toBe(8);
  });

  it('refuses a non-power-of-two length rather than returning nonsense', () => {
    expect(() => fft(new Float64Array(60), new Float64Array(60))).toThrow(/power of two/);
  });
});

describe('spectral measures', () => {
  it('places the centroid of a 1 kHz sine at 1 kHz', () => {
    const { magnitudes, binHz } = averageSpectrum(sine(1000, 1), SR);
    expect(spectralCentroid(magnitudes, binHz)).toBeGreaterThan(950);
    expect(spectralCentroid(magnitudes, binHz)).toBeLessThan(1100);
  });

  it('places the centroid of a 4 kHz sine four times higher', () => {
    const low = averageSpectrum(sine(1000, 1), SR);
    const high = averageSpectrum(sine(4000, 1), SR);
    const ratio = spectralCentroid(high.magnitudes, high.binHz) / spectralCentroid(low.magnitudes, low.binHz);
    expect(ratio).toBeGreaterThan(3.5);
    expect(ratio).toBeLessThan(4.5);
  });

  it('separates a tone from noise by flatness', () => {
    const tone = averageSpectrum(sine(1000, 1), SR);
    const hiss = averageSpectrum(noise(1), SR);
    expect(spectralFlatness(tone.magnitudes)).toBeLessThan(0.02);
    expect(spectralFlatness(hiss.magnitudes)).toBeGreaterThan(0.3);
  });

  it('assigns a 120 Hz sine to the low band and a 6 kHz sine to the high band', () => {
    const lowTone = averageSpectrum(sine(120, 1), SR);
    const highTone = averageSpectrum(sine(6000, 1), SR);
    expect(bandEnergy(lowTone.magnitudes, lowTone.binHz).low).toBeGreaterThan(0.9);
    expect(bandEnergy(highTone.magnitudes, highTone.binHz).high).toBeGreaterThan(0.9);
  });
});

describe('envelope', () => {
  it('measures the attack of a slow fade-in', () => {
    const samples = sine(440, 1);
    for (let i = 0; i < samples.length; i += 1) samples[i] *= Math.min(1, i / (0.4 * SR));
    const shape = envelopeShape(samples, SR);
    // Peak arrives at the end of the ramp; onset is early, so attack ≈ 0.4 s.
    expect(shape.attackSeconds).toBeGreaterThan(0.25);
    expect(shape.attackSeconds).toBeLessThan(1);
  });

  it('measures the decay of an exponentially decaying tone', () => {
    const samples = sine(440, 2);
    // −20 dB (a factor of 10) after exactly 0.5 s.
    const tau = 0.5 / Math.log(10);
    for (let i = 0; i < samples.length; i += 1) samples[i] *= Math.exp(-i / SR / tau);
    const shape = envelopeShape(samples, SR);
    expect(shape.decaySeconds).toBeGreaterThan(0.4);
    expect(shape.decaySeconds).toBeLessThan(0.6);
  });

  it('reports a transient as short and a bed as long', () => {
    const transient = sine(2000, 1);
    for (let i = 0; i < transient.length; i += 1) transient[i] *= Math.exp(-i / SR / 0.01);
    const bed = noise(1);
    expect(envelopeShape(transient, SR).activeSeconds).toBeLessThan(0.15);
    expect(envelopeShape(bed, SR).activeSeconds).toBeGreaterThan(0.9);
  });
});

describe('analyse', () => {
  it('reports peak, rms and crest factor of a sine correctly', () => {
    const result = analyse([sine(1000, 1, 0.5)], SR);
    expect(result.peak).toBeCloseTo(0.5, 2);
    // RMS of a sine is amplitude / sqrt(2).
    expect(result.rms).toBeCloseTo(0.5 / Math.SQRT2, 2);
    expect(result.crestFactor).toBeCloseTo(Math.SQRT2, 1);
    expect(result.silent).toBe(false);
  });

  it('finds a DC offset and expresses it relative to the peak', () => {
    const samples = sine(1000, 1, 0.4);
    for (let i = 0; i < samples.length; i += 1) samples[i] += 0.1;
    const result = analyse([samples], SR);
    expect(result.dcOffset).toBeCloseTo(0.1, 2);
    expect(result.dcOffsetRatio).toBeCloseTo(0.1 / 0.5, 1);
  });

  it('counts clipped samples', () => {
    const clean = analyse([sine(1000, 0.5, 0.9)], SR);
    const clipped = analyse([sine(1000, 0.5, 1.4).map((v) => Math.max(-1, Math.min(1, v)))], SR);
    expect(clean.clippedSamples).toBe(0);
    expect(clipped.clippedSamples).toBeGreaterThan(1000);
  });

  it('reports digital silence as silent, at a finite dBFS', () => {
    const result = analyse([new Float32Array(SR)], SR);
    expect(result.silent).toBe(true);
    expect(result.peak).toBe(0);
    // Not -Infinity: JSON.stringify would turn that into null.
    expect(result.peakDbfs).toBe(-200);
    expect(Number.isFinite(result.peakDbfs)).toBe(true);
  });

  it('reports stereo correlation: identical channels 1, inverted channels -1', () => {
    const left = noise(0.25);
    const inverted = Float32Array.from(left, (value) => -value);
    expect(analyse([left, left], SR).stereoCorrelation).toBeCloseTo(1, 3);
    expect(analyse([left, inverted], SR).stereoCorrelation).toBeCloseTo(-1, 3);
  });

  it('ignores silence when averaging the spectrum', () => {
    // A 50 ms 3 kHz burst inside 2 s of silence must still measure as 3 kHz.
    const samples = new Float32Array(2 * SR);
    const burst = sine(3000, 0.05, 0.5);
    samples.set(burst, Math.round(0.1 * SR));
    const result = analyse([samples], SR);
    expect(result.spectralCentroidHz).toBeGreaterThan(2500);
    expect(result.spectralCentroidHz).toBeLessThan(3600);
  });
});
