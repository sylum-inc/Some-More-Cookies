/**
 * Offline audio analysis.
 *
 * Plain ESM JavaScript with no dependencies, deliberately: this module is
 * bundled into the browser page that renders the sounds (so the analysis runs
 * on the samples without shipping 100 MB of float arrays back over CDP) *and*
 * imported directly by Node for its own unit tests. One implementation, two
 * hosts, no duplication.
 *
 * Everything here operates on decoded PCM. Nothing here knows what a
 * marshmallow is.
 */

/* -------------------------------------------------------------------------- */
/* FFT                                                                        */
/* -------------------------------------------------------------------------- */

/** In-place iterative radix-2 Cooley–Tukey FFT. `re`/`im` must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  if (n <= 1) return;
  if ((n & (n - 1)) !== 0) throw new Error(`fft length must be a power of two, got ${n}`);

  // Bit-reversal permutation.
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i];
      re[i] = re[j];
      re[j] = tr;
      const ti = im[i];
      im[i] = im[j];
      im[j] = ti;
    }
  }

  for (let len = 2; len <= n; len <<= 1) {
    const angle = (-2 * Math.PI) / len;
    const wr = Math.cos(angle);
    const wi = Math.sin(angle);
    for (let i = 0; i < n; i += len) {
      let curR = 1;
      let curI = 0;
      for (let k = 0; k < len / 2; k += 1) {
        const aR = re[i + k];
        const aI = im[i + k];
        const bR = re[i + k + len / 2] * curR - im[i + k + len / 2] * curI;
        const bI = re[i + k + len / 2] * curI + im[i + k + len / 2] * curR;
        re[i + k] = aR + bR;
        im[i + k] = aI + bI;
        re[i + k + len / 2] = aR - bR;
        im[i + k + len / 2] = aI - bI;
        const nextR = curR * wr - curI * wi;
        curI = curR * wi + curI * wr;
        curR = nextR;
      }
    }
  }
}

const nextPowerOfTwo = (value) => {
  let n = 1;
  while (n < value) n <<= 1;
  return n;
};

/**
 * Energy-weighted average magnitude spectrum across overlapping Hann windows.
 *
 * Averaging frames rather than transforming the whole signal at once matters
 * for these sounds: a latch clunk is 300 ms of content inside a 1.5 s buffer,
 * and a whole-buffer FFT would dilute its spectrum with the silence after it.
 * Frames are weighted by their own energy, so silence contributes nothing.
 */
export function averageSpectrum(samples, sampleRate, frameSize = 2048, hop = 1024) {
  const size = nextPowerOfTwo(frameSize);
  const window = new Float64Array(size);
  for (let i = 0; i < size; i += 1) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1));

  const bins = size / 2;
  const accumulated = new Float64Array(bins);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let totalWeight = 0;

  for (let start = 0; start + size <= samples.length; start += hop) {
    let energy = 0;
    for (let i = 0; i < size; i += 1) {
      const value = samples[start + i] * window[i];
      re[i] = value;
      im[i] = 0;
      energy += value * value;
    }
    if (energy <= 0) continue;
    fft(re, im);
    const weight = energy;
    for (let bin = 0; bin < bins; bin += 1) {
      accumulated[bin] += weight * Math.hypot(re[bin], im[bin]);
    }
    totalWeight += weight;
  }

  if (totalWeight === 0) {
    // Shorter than one frame, or pure silence: transform what there is.
    const short = Math.min(size, nextPowerOfTwo(Math.max(2, samples.length)));
    const sre = new Float64Array(short);
    const sim = new Float64Array(short);
    for (let i = 0; i < Math.min(short, samples.length); i += 1) sre[i] = samples[i];
    fft(sre, sim);
    const out = new Float64Array(short / 2);
    for (let bin = 0; bin < out.length; bin += 1) out[bin] = Math.hypot(sre[bin], sim[bin]);
    return { magnitudes: out, binHz: sampleRate / short };
  }

  for (let bin = 0; bin < bins; bin += 1) accumulated[bin] /= totalWeight;
  return { magnitudes: accumulated, binHz: sampleRate / size };
}

/** Amplitude-weighted mean frequency — "how bright is this sound", in Hz. */
export function spectralCentroid(magnitudes, binHz) {
  let weighted = 0;
  let total = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    weighted += bin * binHz * magnitudes[bin];
    total += magnitudes[bin];
  }
  return total > 0 ? weighted / total : 0;
}

/** Frequency below which `fraction` of the spectral energy lies. */
export function spectralRolloff(magnitudes, binHz, fraction = 0.85) {
  let total = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) total += magnitudes[bin];
  if (total <= 0) return 0;
  let running = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    running += magnitudes[bin];
    if (running >= fraction * total) return bin * binHz;
  }
  return (magnitudes.length - 1) * binHz;
}

/**
 * Geometric mean over arithmetic mean of the spectrum: 0 is a pure tone, 1 is
 * white noise. This is what separates "a click" from "a beep".
 */
export function spectralFlatness(magnitudes) {
  let logSum = 0;
  let sum = 0;
  let count = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const value = magnitudes[bin] + 1e-12;
    logSum += Math.log(value);
    sum += value;
    count += 1;
  }
  if (count === 0) return 0;
  return Math.exp(logSum / count) / (sum / count);
}

/** Fraction of spectral energy in each named band. */
export const BANDS = Object.freeze({
  sub: [0, 80],
  low: [80, 300],
  lowMid: [300, 1200],
  mid: [1200, 4000],
  high: [4000, 12000],
  air: [12000, Infinity],
});

export function bandEnergy(magnitudes, binHz) {
  const totals = {};
  let overall = 0;
  for (const name of Object.keys(BANDS)) totals[name] = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const hz = bin * binHz;
    const energy = magnitudes[bin] * magnitudes[bin];
    overall += energy;
    for (const [name, [lo, hi]] of Object.entries(BANDS)) {
      if (hz >= lo && hz < hi) {
        totals[name] += energy;
        break;
      }
    }
  }
  if (overall <= 0) return totals;
  for (const name of Object.keys(totals)) totals[name] = totals[name] / overall;
  return totals;
}

/* -------------------------------------------------------------------------- */
/* Time domain                                                                 */
/* -------------------------------------------------------------------------- */

/** Short-window RMS envelope. */
export function rmsEnvelope(samples, windowSize = 128) {
  const frames = Math.max(1, Math.floor(samples.length / windowSize));
  const envelope = new Float64Array(frames);
  for (let f = 0; f < frames; f += 1) {
    let sum = 0;
    const start = f * windowSize;
    for (let i = 0; i < windowSize; i += 1) {
      const value = samples[start + i] ?? 0;
      sum += value * value;
    }
    envelope[f] = Math.sqrt(sum / windowSize);
  }
  return envelope;
}

/**
 * Attack/decay shape, measured from the RMS envelope.
 *
 * `onset` is where the sound starts (first frame above 5 % of peak), `attack`
 * is onset to peak, and `decay` is peak down to 10 % of peak (−20 dB).
 * `active` is total time above 5 % of peak, which is a fair proxy for how long
 * the sound is actually audible.
 */
export function envelopeShape(samples, sampleRate, windowSize = 128) {
  const envelope = rmsEnvelope(samples, windowSize);
  const frameSeconds = windowSize / sampleRate;
  let peak = 0;
  let peakFrame = 0;
  for (let f = 0; f < envelope.length; f += 1) {
    if (envelope[f] > peak) {
      peak = envelope[f];
      peakFrame = f;
    }
  }
  if (peak <= 0) {
    return { onsetSeconds: 0, attackSeconds: 0, peakSeconds: 0, decaySeconds: 0, activeSeconds: 0, peakRms: 0 };
  }

  const onsetThreshold = peak * 0.05;
  let onsetFrame = 0;
  for (let f = 0; f < envelope.length; f += 1) {
    if (envelope[f] >= onsetThreshold) {
      onsetFrame = f;
      break;
    }
  }

  const decayThreshold = peak * 0.1;
  let decayFrame = envelope.length - 1;
  for (let f = peakFrame; f < envelope.length; f += 1) {
    if (envelope[f] <= decayThreshold) {
      decayFrame = f;
      break;
    }
  }

  let active = 0;
  for (let f = 0; f < envelope.length; f += 1) if (envelope[f] >= onsetThreshold) active += 1;

  return {
    onsetSeconds: onsetFrame * frameSeconds,
    attackSeconds: Math.max(0, (peakFrame - onsetFrame) * frameSeconds),
    peakSeconds: peakFrame * frameSeconds,
    decaySeconds: Math.max(0, (decayFrame - peakFrame) * frameSeconds),
    activeSeconds: active * frameSeconds,
    peakRms: peak,
  };
}

export function zeroCrossingRate(samples, sampleRate) {
  let crossings = 0;
  for (let i = 1; i < samples.length; i += 1) {
    if ((samples[i - 1] < 0 && samples[i] >= 0) || (samples[i - 1] >= 0 && samples[i] < 0)) crossings += 1;
  }
  return samples.length > 1 ? (crossings * sampleRate) / samples.length : 0;
}

export function correlation(a, b) {
  const n = Math.min(a.length, b.length);
  if (n === 0) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < n; i += 1) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= n;
  meanB /= n;
  let cov = 0;
  let varA = 0;
  let varB = 0;
  for (let i = 0; i < n; i += 1) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    cov += da * db;
    varA += da * da;
    varB += db * db;
  }
  const denominator = Math.sqrt(varA * varB);
  return denominator > 0 ? cov / denominator : 0;
}

const toDb = (amplitude) => (amplitude > 0 ? 20 * Math.log10(amplitude) : -Infinity);
const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return value === Infinity ? Infinity : value === -Infinity ? -Infinity : null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/**
 * The full measurement set for one rendered sound.
 *
 * `channels` is an array of Float32Array (or plain arrays), one per channel.
 */
export function analyse(channels, sampleRate) {
  const left = channels[0];
  const frames = left.length;

  // Mono sum for spectral work; channel-wise for level and DC.
  const mono = new Float64Array(frames);
  for (const channel of channels) for (let i = 0; i < frames; i += 1) mono[i] += channel[i] / channels.length;

  let peak = 0;
  let sumSquares = 0;
  let sum = 0;
  let clipped = 0;
  for (const channel of channels) {
    for (let i = 0; i < frames; i += 1) {
      const value = channel[i];
      const magnitude = Math.abs(value);
      if (magnitude > peak) peak = magnitude;
      // Full scale, with a hair of slack for float rounding in the graph.
      if (magnitude >= 0.999) clipped += 1;
      sumSquares += value * value;
      sum += value;
    }
  }
  const total = frames * channels.length;
  const rms = Math.sqrt(sumSquares / total);
  const dcOffset = sum / total;

  const { magnitudes, binHz } = averageSpectrum(mono, sampleRate);
  const envelope = envelopeShape(mono, sampleRate);

  return {
    sampleRate,
    channels: channels.length,
    durationSeconds: round(frames / sampleRate),
    silent: peak < 1e-4,
    peak: round(peak, 6),
    peakDbfs: round(toDb(peak), 2),
    rms: round(rms, 6),
    rmsDbfs: round(toDb(rms), 2),
    crestFactor: round(rms > 0 ? peak / rms : 0, 3),
    dcOffset: round(dcOffset, 6),
    clippedSamples: clipped,
    clipFraction: round(clipped / total, 8),
    spectralCentroidHz: round(spectralCentroid(magnitudes, binHz), 1),
    spectralRolloff85Hz: round(spectralRolloff(magnitudes, binHz, 0.85), 1),
    spectralFlatness: round(spectralFlatness(magnitudes), 4),
    zeroCrossingRateHz: round(zeroCrossingRate(mono, sampleRate), 1),
    bandEnergy: Object.fromEntries(Object.entries(bandEnergy(magnitudes, binHz)).map(([k, v]) => [k, round(v, 4)])),
    envelope: {
      onsetSeconds: round(envelope.onsetSeconds, 4),
      attackSeconds: round(envelope.attackSeconds, 4),
      peakSeconds: round(envelope.peakSeconds, 4),
      decaySeconds: round(envelope.decaySeconds, 4),
      activeSeconds: round(envelope.activeSeconds, 4),
      peakRms: round(envelope.peakRms, 6),
    },
    stereoCorrelation: channels.length > 1 ? round(correlation(channels[0], channels[1]), 4) : null,
  };
}
