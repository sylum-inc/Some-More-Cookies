import { describe, expect, it } from 'vitest';

import {
  analyse,
  averageSpectrum,
  bandEnergy,
  envelopeShape,
  fft,
  bufferLoopEstimate,
  loopEstimate,
  spectralCentroid,
  spectralFlatness,
  spectrogram,
  transients,
} from './analysis.js';

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

/* -------------------------------------------------------------------------- */

/** Noise whose *envelope* repeats every `periodSeconds`, but whose samples never do. */
function loopingEnvelopeNoise(seconds, periodSeconds, sampleRate = SR) {
  const out = noise(seconds, 1, sampleRate);
  for (let i = 0; i < out.length; i += 1) {
    const phase = ((i / sampleRate) % periodSeconds) / periodSeconds;
    out[i] *= 0.05 + 0.95 * (phase < 0.25 ? 1 : 0.05);
  }
  return out;
}

describe('loopEstimate', () => {
  it('finds the period of material whose envelope repeats', () => {
    const result = loopEstimate(loopingEnvelopeNoise(12, 1.5), SR, 0.25, 6);
    expect(result.conclusive).toBe(true);
    expect(result.lagSeconds).toBeCloseTo(1.5, 1);
    expect(result.correlation).toBeGreaterThan(0.8);
  });

  it('scores prominence high for a real loop and near zero for stationary noise', () => {
    /*
     * The regression this metric exists for.
     *
     * Raw correlation alone called a single non-looping noise buffer a loop at
     * 0.95, because a slowly-varying envelope correlates with itself at every
     * lag. Prominence — the best lag's height over the median across lags —
     * is what actually separates the two, so both halves are asserted here.
     */
    const looped = loopEstimate(loopingEnvelopeNoise(12, 1.5), SR, 0.25, 6);
    const stationary = loopEstimate(noise(12), SR, 0.25, 6);
    expect(looped.prominence).toBeGreaterThan(0.5);
    expect(stationary.prominence).toBeLessThan(0.2);
    expect(looped.prominence).toBeGreaterThan(stationary.prominence * 4);
  });

  it('reports the shortest period, not one of its multiples', () => {
    // A 1.5 s loop correlates just as well at 3 s and 4.5 s. The shortest is
    // the one a listener hears, so it is the one that must come back.
    const result = loopEstimate(loopingEnvelopeNoise(20, 1.5), SR, 0.25, 8);
    expect(result.lagSeconds).toBeGreaterThan(1.4);
    expect(result.lagSeconds).toBeLessThan(1.6);
  });

  it('sees a literal buffer repeat, at the period or a multiple of it', () => {
    /*
     * The regression that the `control-pink-noise` scene exposed.
     *
     * A 3.75 s buffer looped for 30 s was reported as a 15 s loop, because the
     * old search shrank its overlap as the lag grew and a quarter-length
     * window at 15 s beat a full-length one at 3.75 s on variance alone.
     *
     * The lag is asserted as a multiple rather than the period itself because
     * an envelope correlation genuinely cannot resolve better than that here:
     * 3.75 s is 351.6 frames of a 512-sample envelope, and a lag quantised
     * half a frame off decorrelates noise completely, so the two-period lag
     * (which happens to land closer to a frame boundary) scores higher.
     * `bufferLoopEstimate` is the instrument for the exact period.
     */
    const period = 3.75;
    const cell = noise(period, 0.5);
    const out = new Float32Array(Math.round(30 * SR));
    for (let i = 0; i < out.length; i += 1) out[i] = cell[i % cell.length];
    const result = loopEstimate(out, SR, 0.25, 15);
    expect(result.correlation).toBeGreaterThan(0.8);
    expect(result.prominence).toBeGreaterThan(0.7);
    const multiple = result.lagSeconds / period;
    expect(Math.abs(multiple - Math.round(multiple))).toBeLessThan(0.05);
  });

  it('says so rather than guessing when the render is too short to search', () => {
    const result = loopEstimate(noise(0.2), SR, 0.25, 6);
    expect(result.conclusive).toBe(false);
    expect(result.correlation).toBe(0);
  });
});

describe('bufferLoopEstimate', () => {
  it('finds the exact period of a looped buffer, where the envelope cannot', () => {
    const period = 3.75;
    const cell = noise(period, 0.5);
    const out = new Float32Array(Math.round(30 * SR));
    for (let i = 0; i < out.length; i += 1) out[i] = cell[i % cell.length];
    const result = bufferLoopEstimate(out, SR, 0.5, 15);
    expect(result.conclusive).toBe(true);
    expect(result.lagSeconds).toBeCloseTo(period, 2);
    expect(result.correlation).toBeGreaterThan(0.9);
  });

  it('finds nothing in noise that never repeats', () => {
    // The same length and colour, generated once rather than looped. Anything
    // much above zero here would make every loop finding worthless.
    const result = bufferLoopEstimate(noise(30, 0.5), SR, 0.5, 15);
    expect(result.correlation).toBeLessThan(0.2);
  });

  it('is not fooled by a repeating envelope over fresh samples', () => {
    // A pattern repeat is not a buffer repeat: the events recur, the PCM does
    // not. `loopEstimate` is the instrument that should see this one.
    const result = bufferLoopEstimate(loopingEnvelopeNoise(20, 1.5), SR, 0.5, 8);
    expect(result.correlation).toBeLessThan(0.4);
    expect(loopEstimate(loopingEnvelopeNoise(20, 1.5), SR, 0.25, 8).correlation).toBeGreaterThan(0.8);
  });
});

describe('transients', () => {
  it('counts discrete impulses and misses none of them', () => {
    const samples = new Float32Array(4 * SR);
    // Ten clicks a second, evenly spaced, on a quiet noise bed.
    const bed = noise(4, 0.01);
    samples.set(bed);
    for (let n = 0; n < 40; n += 1) {
      const at = Math.round((n / 10) * SR);
      for (let i = 0; i < 120; i += 1) samples[at + i] += 0.6 * Math.exp(-i / 30) * (i % 2 ? 1 : -1);
    }
    const result = transients(samples, SR);
    expect(result.count).toBeGreaterThanOrEqual(38);
    expect(result.perSecond).toBeGreaterThan(9);
    expect(result.perSecond).toBeLessThan(11);
    // Every gap is 100 ms, so every measured interval must be too.
    for (const interval of result.intervals) expect(interval).toBeCloseTo(0.1, 2);
  });

  it('finds almost nothing in flat noise, which is the whole point', () => {
    // The control the fire bed is compared against: no events at all, so the
    // onset count has to stay low or every finding built on it is worthless.
    expect(transients(noise(4, 0.3), SR, 0.003, 3).perSecond).toBeLessThan(2);
  });

  it('returns zero for digital silence rather than dividing by it', () => {
    const result = transients(new Float32Array(SR), SR);
    expect(result.count).toBe(0);
    expect(result.perSecond).toBe(0);
    expect(result.medianFloor).toBe(0);
  });
});

describe('spectrogram', () => {
  it('puts a sine in the right bin, in every column', () => {
    const spec = spectrogram(sine(1000, 1), SR, 1024, 512);
    expect(spec.columns.length).toBeGreaterThan(30);
    const expected = Math.round(1000 / spec.binHz);
    for (const column of spec.columns) {
      let loudest = 0;
      let at = 0;
      for (let bin = 1; bin < column.length; bin += 1) {
        if (column[bin] > column[at] || at === 0) {
          if (column[bin] > loudest || at === 0) {
            loudest = column[bin];
            at = bin;
          }
        }
      }
      expect(Math.abs(at - expected)).toBeLessThanOrEqual(2);
    }
  });

  it('tracks a sound that changes over time, which a whole-file FFT cannot', () => {
    // Silence, then a tone: the first columns must be far quieter than the last.
    const samples = new Float32Array(2 * SR);
    samples.set(sine(2000, 1), SR);
    const spec = spectrogram(samples, SR, 1024, 512);
    const loudestOf = (column) => Math.max(...column);
    expect(loudestOf(spec.columns[5])).toBeLessThan(-60);
    expect(loudestOf(spec.columns[spec.columns.length - 5])).toBeGreaterThan(-10);
  });

  it('reports dB relative to its own loudest bin, so the ceiling is 0', () => {
    const spec = spectrogram(sine(1000, 1), SR, 1024, 512);
    let loudest = -Infinity;
    for (const column of spec.columns) for (const value of column) if (value > loudest) loudest = value;
    expect(loudest).toBeCloseTo(0, 6);
  });
});
