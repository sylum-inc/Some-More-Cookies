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

/**
 * dBFS, floored at −200 rather than −Infinity.
 *
 * `JSON.stringify` turns Infinity into `null`, which would silently poison
 * every consumer of the report; a true digital silence reads as −200 dBFS,
 * which is unambiguous and stays a number.
 */
const toDb = (amplitude) => (amplitude > 0 ? Math.max(-200, 20 * Math.log10(amplitude)) : -200);
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
    /**
     * DC as a fraction of the peak. This, not the absolute figure, is the
     * meaningful measure: 5 mV of offset on a signal that peaks at full scale
     * is nothing, and the same offset on a whisper is a fault.
     */
    dcOffsetRatio: round(peak > 0 ? Math.abs(dcOffset) / peak : 0, 6),
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

/* -------------------------------------------------------------------------- */
/* Repetition, transients and spectrograms                                     */
/* -------------------------------------------------------------------------- */

/**
 * Does this material repeat inside the render?
 *
 * Autocorrelation of the *RMS envelope*, not of the samples. Correlating raw
 * samples finds pitch, which for a fire bed is meaningless; correlating the
 * envelope finds the thing a listener actually notices, which is the same
 * pattern of events arriving again. A one-second loop of noise has an envelope
 * that repeats exactly every second even though no two samples match.
 *
 * `minLagSeconds` skips the trivial peak at lag 0 and the short lags that any
 * smooth envelope correlates with. Correlation is never evaluated on less than
 * half the render: a 90 % overlap of two frames is a coin flip dressed as a
 * measurement.
 *
 * **Raw correlation on its own is not evidence of a loop, and reading it as
 * though it were is a trap this function fell into.** A stationary bed of
 * filtered noise has a slowly-varying envelope that correlates with itself at
 * *every* lag, so it scores 0.95 while repeating nothing — measured, on the
 * `control-pink-noise` scene, which is a single non-looping noise buffer.
 *
 * What separates a loop from a smooth envelope is that a loop puts a *local
 * peak* at one lag. So `prominence` is the number to read: how far the best
 * lag stands above the median correlation across all lags searched. A genuine
 * repeat is a spike above a low floor and scores high; a stationary bed has no
 * peak to speak of and scores near zero however high its raw correlation runs.
 */
export function loopEstimate(samples, sampleRate, minLagSeconds = 0.25, maxLagSeconds = Infinity, windowSize = 512) {
  const envelope = rmsEnvelope(samples, windowSize);
  const frameRate = sampleRate / windowSize;
  const frames = envelope.length;
  const minLag = Math.max(1, Math.round(minLagSeconds * frameRate));
  const maxLag = Math.min(Math.floor(frames / 2), Math.round(Math.min(maxLagSeconds, frames / frameRate) * frameRate));
  if (maxLag <= minLag) {
    return {
      lagSeconds: 0,
      correlation: 0,
      prominence: 0,
      medianCorrelation: 0,
      searchedFromSeconds: minLagSeconds,
      searchedToSeconds: 0,
      conclusive: false,
    };
  }

  /*
   * Every lag is correlated over the *same* number of frames.
   *
   * The obvious loop — correlate `[0, n-lag)` against `[lag, n)` — shrinks the
   * overlap as the lag grows, so a long lag is estimated from less data, has
   * higher variance, and wins the argmax on noise alone. Measured: on a render
   * containing a real 3.75 s loop, that version reported 15 s, because at 15 s
   * only half the render was left and the estimate was inflated. Holding the
   * window fixed at `frames - maxLag` makes the whole curve comparable.
   */
  const window = frames - maxLag;
  if (window < 8) {
    return {
      lagSeconds: 0,
      correlation: 0,
      prominence: 0,
      medianCorrelation: 0,
      searchedFromSeconds: minLag / frameRate,
      searchedToSeconds: maxLag / frameRate,
      conclusive: false,
    };
  }

  const head = envelope.subarray(0, window);
  const curve = new Float64Array(maxLag - minLag + 1);
  let bestLag = minLag;
  let best = -1;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = correlation(head, envelope.subarray(lag, lag + window));
    curve[lag - minLag] = value;
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }

  /*
   * Report the *shortest* lag that is essentially as good as the best.
   *
   * Every integer multiple of a true period correlates as well as the period
   * itself, so a plain argmax on a 1.5 s loop happily returns 4.5 s. What a
   * listener hears is the shortest repeat, so that is what is reported: the
   * first lag within 5 % of the maximum. The tolerance is loose because the
   * later multiples of a period are not merely as good as the first, they are
   * often a shade better — the envelope has had longer to settle.
   */
  let reportedLag = bestLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (curve[lag - minLag] >= best * 0.95) {
      reportedLag = lag;
      break;
    }
  }

  const sorted = Float64Array.from(curve).sort();
  const middle = sorted[Math.floor(sorted.length / 2)] ?? 0;
  return {
    lagSeconds: reportedLag / frameRate,
    correlation: best,
    /** Best correlation minus the median across lags. Near 0 means no loop. */
    prominence: best - middle,
    medianCorrelation: middle,
    searchedFromSeconds: minLag / frameRate,
    searchedToSeconds: maxLag / frameRate,
    conclusive: true,
  };
}

/**
 * Sample-exact autocorrelation, for finding a *literal* repeat.
 *
 * `loopEstimate` correlates the envelope, which finds a repeating *pattern* —
 * the same events arriving again, played by different samples. This finds the
 * other kind: the same PCM, again. That is what a looping `AudioBuffer` is, and
 * it is what every continuous bed in this engine is built from, so it is the
 * measurement that answers "does the noise bed loop".
 *
 * Sample resolution matters here and the envelope cannot supply it: a 3.75 s
 * period is 175.78 frames of a 512-sample envelope, and a lag quantised half a
 * frame away from the truth destroys the correlation of a noise signal
 * completely. Computed by Wiener–Khinchin — FFT, power spectrum, inverse — so
 * the whole curve costs two transforms rather than a million dot products.
 *
 * Returns the strongest repeat at or above `minLagSeconds`, as a correlation in
 * 0..1. Above ~0.5 the same audio is genuinely recurring.
 */
export function bufferLoopEstimate(samples, sampleRate, minLagSeconds = 0.5, maxLagSeconds = Infinity) {
  const length = samples.length;
  const minLag = Math.max(1, Math.round(minLagSeconds * sampleRate));
  const maxLag = Math.min(Math.floor(length / 2), Math.round(Math.min(maxLagSeconds, length / sampleRate) * sampleRate));
  if (maxLag <= minLag) {
    return { lagSeconds: 0, correlation: 0, conclusive: false };
  }

  let size = 1;
  while (size < length * 2) size <<= 1;
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let mean = 0;
  for (let i = 0; i < length; i += 1) mean += samples[i];
  mean /= length;
  for (let i = 0; i < length; i += 1) re[i] = samples[i] - mean;

  fft(re, im);
  for (let i = 0; i < size; i += 1) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  // The power spectrum is real and even, so its forward transform is the
  // autocorrelation up to a factor of `size` — which cancels in the ratio.
  fft(re, im);

  const zero = re[0];
  if (!(zero > 0)) return { lagSeconds: 0, correlation: 0, conclusive: false };

  /*
   * Normalised by the overlap, not by the whole render.
   *
   * This is a *linear* autocorrelation: at lag L only `length - L` samples
   * overlap, so a perfect repeat scores `(length - L) / length` rather than 1 —
   * a flawless 3.75 s loop inside a 30 s render reads 0.875, which looks like
   * a hedge and is really a bookkeeping artefact. Dividing by the overlap makes
   * 1.0 mean "identical" at every lag, which is the only reading that lets two
   * scenes be compared. `maxLag` is half the render, so this never scales by
   * more than two.
   */
  const at = (lag) => re[lag] / (zero * ((length - lag) / length));

  let best = -1;
  let bestLag = minLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    const value = at(lag);
    if (value > best) {
      best = value;
      bestLag = lag;
    }
  }
  // The shortest lag that is essentially as strong, for the same reason
  // `loopEstimate` does it: multiples of a period correlate as well as it does.
  let reportedLag = bestLag;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    if (at(lag) >= best * 0.95) {
      reportedLag = lag;
      break;
    }
  }
  return { lagSeconds: reportedLag / sampleRate, correlation: best, conclusive: true };
}

/**
 * Discrete transients in the RMS envelope — the measurable form of "is there
 * structure in this, or is it a noise band with a fade on it?".
 *
 * An onset is a frame that rises past `riseFactor` times the envelope's own
 * median and is still rising, with a short hold afterwards so one crackle is
 * counted once rather than once per sample of its attack. A crackle stream
 * produces many per second across a wide spread of inter-onset intervals; a
 * filtered noise loop produces almost none, because its envelope never rises
 * sharply above its own median.
 */
export function transients(samples, sampleRate, windowSeconds = 0.003, riseFactor = 3, holdSeconds = 0.012) {
  const windowSize = Math.max(4, Math.round(windowSeconds * sampleRate));
  const envelope = rmsEnvelope(samples, windowSize);
  const frameSeconds = windowSize / sampleRate;
  const holdFrames = Math.max(1, Math.round(holdSeconds / frameSeconds));

  // The median of the envelope is a fair stand-in for "the bed"; an onset is
  // what pokes above it. A mean would be dragged up by the transients
  // themselves, which is the thing being measured.
  const sorted = Float64Array.from(envelope).sort();
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  if (median <= 0) return { count: 0, perSecond: 0, times: [], intervals: [], medianFloor: 0 };

  const threshold = median * riseFactor;
  const times = [];
  let cooldown = 0;
  for (let f = 1; f < envelope.length; f += 1) {
    if (cooldown > 0) {
      cooldown -= 1;
      continue;
    }
    if (envelope[f] >= threshold && envelope[f] > envelope[f - 1]) {
      times.push(f * frameSeconds);
      cooldown = holdFrames;
    }
  }

  const intervals = [];
  for (let i = 1; i < times.length; i += 1) intervals.push(times[i] - times[i - 1]);
  const seconds = (envelope.length * windowSize) / sampleRate;
  return {
    count: times.length,
    perSecond: seconds > 0 ? times.length / seconds : 0,
    times,
    intervals,
    medianFloor: median,
  };
}

/**
 * Short-time magnitude spectrum over the whole render: one column per hop,
 * `fftSize / 2` bins each, in dB relative to the loudest bin in the render.
 *
 * Deliberately separate from `averageSpectrum`, which collapses time away —
 * and time is exactly where a repeating column pattern, a layer that switches
 * on, or a click at a buffer boundary shows itself.
 */
export function spectrogram(samples, sampleRate, fftSize = 1024, hop = 512) {
  const window = new Float64Array(fftSize);
  for (let i = 0; i < fftSize; i += 1) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (fftSize - 1));
  }
  const bins = fftSize / 2;
  const columns = [];
  const re = new Float64Array(fftSize);
  const im = new Float64Array(fftSize);
  let loudest = 0;

  for (let start = 0; start + fftSize <= samples.length; start += hop) {
    for (let i = 0; i < fftSize; i += 1) {
      re[i] = (samples[start + i] ?? 0) * window[i];
      im[i] = 0;
    }
    fft(re, im);
    const column = new Float32Array(bins);
    for (let bin = 0; bin < bins; bin += 1) {
      const magnitude = Math.hypot(re[bin], im[bin]) / (fftSize / 4);
      column[bin] = magnitude;
      if (magnitude > loudest) loudest = magnitude;
    }
    columns.push(column);
  }

  // dB relative to the render's own loudest bin, so a quiet scene is still
  // readable rather than a black rectangle. The absolute reference is returned
  // alongside so two scenes can still be compared on level.
  const reference = loudest > 0 ? loudest : 1;
  for (const column of columns) {
    for (let bin = 0; bin < column.length; bin += 1) {
      column[bin] = Math.max(-100, 20 * Math.log10((column[bin] + 1e-12) / reference));
    }
  }
  return { columns, bins, binHz: sampleRate / fftSize, hopSeconds: hop / sampleRate, referenceMagnitude: loudest };
}
