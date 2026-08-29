/**
 * Tests for the offline renderer itself.
 *
 * `tools/audio/analysis.test.js` exists for exactly this reason: a report full
 * of confident numbers from a broken instrument is worse than no report. The
 * same applies here — every claim the radio and wildlife suites make about
 * rendered audio rests on this file being right, so it is driven with signals
 * whose answers are known in closed form.
 */

import { describe, expect, it } from 'vitest';

import {
  bandFraction,
  dominantFrequency,
  largestDiscontinuity,
  largestEnvelopeStep,
  pannerGains,
  renderChannelRms,
  renderOffline,
  renderPeak,
  renderRms,
} from '../src/audio/offline.js';
import { createFakeAudioContext, type FakeAudioContext } from '../src/audio/testing.js';

function context(sampleRate = 24000): FakeAudioContext {
  return createFakeAudioContext({ sampleRate, state: 'running' });
}

describe('offline renderer — sources', () => {
  it('renders a sine at the requested frequency and unit amplitude', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 440;
    osc.connect(ctx.destination as never);
    osc.start(0);

    const audio = renderOffline(ctx as never, 0.5);
    expect(renderPeak(audio)).toBeCloseTo(1, 2);
    // A unit sine has an RMS of 1/sqrt(2).
    expect(renderRms(audio, 0.1, 0.4)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(dominantFrequency(audio, 0.1, 0.4)).toBeCloseTo(440, 0);
  });

  it('honours start and stop times', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 300;
    osc.connect(ctx.destination as never);
    osc.start(0.2);
    osc.stop(0.4);

    const audio = renderOffline(ctx as never, 0.6);
    expect(renderRms(audio, 0, 0.19)).toBe(0);
    expect(renderRms(audio, 0.25, 0.35)).toBeGreaterThan(0.5);
    expect(renderRms(audio, 0.45, 0.6)).toBe(0);
  });

  it('plays a buffer back at the requested rate and loops it', () => {
    const ctx = context();
    const buffer = ctx.createBuffer(1, 240, 24000);
    const data = buffer.getChannelData(0);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.sin((2 * Math.PI * 100 * i) / 24000);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.loop = true;
    source.loopEnd = 240 / 24000;
    source.connect(ctx.destination as never);
    source.start(0);

    const audio = renderOffline(ctx as never, 0.3);
    // The loop is exactly one cycle of a 100 Hz sine, so looping it forever is
    // still a 100 Hz sine.
    expect(dominantFrequency(audio, 0.05, 0.25)).toBeCloseTo(100, 0);
  });
});

describe('offline renderer — parameter automation', () => {
  it('follows a linear ramp exactly', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(0, 0);
    gain.gain.linearRampToValueAtTime(1, 1);
    osc.connect(gain as never);
    gain.connect(ctx.destination as never);
    osc.start(0);

    const audio = renderOffline(ctx as never, 1);
    // RMS across a window centred at t should be t/sqrt(2).
    expect(renderRms(audio, 0.24, 0.26)).toBeCloseTo(0.25 * Math.SQRT1_2, 2);
    expect(renderRms(audio, 0.74, 0.76)).toBeCloseTo(0.75 * Math.SQRT1_2, 2);
  });

  it('starts a setTarget from wherever the parameter actually was', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const gain = ctx.createGain();
    gain.gain.value = 1;
    // No setValueAtTime first: setTargetAtTime must pick up the standing value.
    gain.gain.setTargetAtTime(0, 0.2, 0.05);
    osc.connect(gain as never);
    gain.connect(ctx.destination as never);
    osc.start(0);

    const audio = renderOffline(ctx as never, 0.6);
    expect(renderRms(audio, 0.05, 0.15)).toBeCloseTo(Math.SQRT1_2, 2);
    // One time constant later the envelope is at 1/e.
    expect(renderRms(audio, 0.245, 0.255)).toBeCloseTo(Math.SQRT1_2 * Math.exp(-1), 1);
    expect(renderRms(audio, 0.5, 0.6)).toBeLessThan(0.01);
  });

  it('drops events that cancelScheduledValues removed', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 1000;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.gain.setValueAtTime(1, 0);
    gain.gain.setValueAtTime(0, 0.3);
    gain.gain.cancelScheduledValues(0.2);
    osc.connect(gain as never);
    gain.connect(ctx.destination as never);
    osc.start(0);

    const audio = renderOffline(ctx as never, 0.5);
    expect(renderRms(audio, 0.35, 0.45)).toBeCloseTo(Math.SQRT1_2, 2);
  });

  it('sums a signal connected into a parameter, as WebAudio does', () => {
    const ctx = context();
    const carrier = ctx.createOscillator();
    carrier.frequency.value = 400;
    const depth = ctx.createGain();
    depth.gain.value = 100;
    const lfo = ctx.createOscillator();
    lfo.frequency.value = 3;
    lfo.connect(depth as never);
    depth.connect(carrier.frequency as never);
    carrier.connect(ctx.destination as never);
    carrier.start(0);
    lfo.start(0);

    const audio = renderOffline(ctx as never, 1);
    // A quarter of the way through the LFO cycle the carrier sits at its peak
    // deviation: 400 + 100 Hz.
    const atPeak = dominantFrequency(audio, 1 / 12 - 0.01, 1 / 12 + 0.01, 200, 900);
    expect(atPeak).toBeGreaterThan(470);
    expect(atPeak).toBeLessThan(530);
  });
});

describe('offline renderer — filters and panning', () => {
  it('attenuates above a low-pass cutoff and passes below it', () => {
    const measure = (toneHz: number): number => {
      const ctx = context(48000);
      const osc = ctx.createOscillator();
      osc.frequency.value = toneHz;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 500;
      filter.Q.value = Math.SQRT1_2;
      osc.connect(filter as never);
      filter.connect(ctx.destination as never);
      osc.start(0);
      return renderRms(renderOffline(ctx as never, 0.4), 0.2, 0.4);
    };
    // A Butterworth low-pass is -3 dB at its cutoff and -12 dB/octave above.
    expect(measure(100)).toBeCloseTo(Math.SQRT1_2, 2);
    expect(measure(500)).toBeCloseTo(Math.SQRT1_2 * Math.SQRT1_2, 1);
    expect(measure(4000)).toBeLessThan(measure(500) * 0.05);
  });

  it('reports where a signal energy sits', () => {
    const ctx = context(48000);
    const osc = ctx.createOscillator();
    osc.frequency.value = 300;
    osc.connect(ctx.destination as never);
    osc.start(0);
    const audio = renderOffline(ctx as never, 0.5);
    expect(bandFraction(audio, 0.1, 0.4, 200, 400)).toBeGreaterThan(0.95);
    expect(bandFraction(audio, 0.1, 0.4, 2000, 20000)).toBeLessThan(0.01);
  });

  it('pans a stereo panner with constant power', () => {
    const render = (pan: number) => {
      const ctx = context();
      const osc = ctx.createOscillator();
      osc.frequency.value = 500;
      const panner = ctx.createStereoPanner();
      panner.pan.value = pan;
      osc.connect(panner as never);
      panner.connect(ctx.destination as never);
      osc.start(0);
      return renderOffline(ctx as never, 0.3);
    };
    const left = render(-1);
    expect(renderChannelRms(left, 0, 0.1, 0.3)).toBeGreaterThan(0.6);
    expect(renderChannelRms(left, 1, 0.1, 0.3)).toBeLessThan(1e-6);

    const centre = render(0);
    expect(renderChannelRms(centre, 0, 0.1, 0.3)).toBeCloseTo(renderChannelRms(centre, 1, 0.1, 0.3), 5);
  });

  it('places a panner node by the WebAudio azimuth rule', () => {
    const listener = { x: 0, y: 0, z: 0 };
    const forward = { x: 0, y: 0, z: -1 };
    const up = { x: 0, y: 1, z: 0 };
    const options = {
      distanceModel: 'inverse' as DistanceModelType,
      refDistance: 1,
      maxDistance: 100,
      rolloffFactor: 1,
    };
    const right = pannerGains({ x: 1, y: 0, z: 0 }, listener, forward, up, options);
    expect(right.gainR).toBeGreaterThan(0.99);
    expect(right.gainL).toBeLessThan(0.01);

    const left = pannerGains({ x: -1, y: 0, z: 0 }, listener, forward, up, options);
    expect(left.gainL).toBeGreaterThan(0.99);
    expect(left.gainR).toBeLessThan(0.01);

    const ahead = pannerGains({ x: 0, y: 0, z: -1 }, listener, forward, up, options);
    expect(ahead.gainL).toBeCloseTo(ahead.gainR, 6);

    // Distance attenuates on the inverse curve: 1 / (1 + (d - ref)).
    const far = pannerGains({ x: 0, y: 0, z: -11 }, listener, forward, up, options);
    expect(far.gainL / ahead.gainL).toBeCloseTo(1 / 11, 3);
  });
});

describe('offline renderer — measurement helpers', () => {
  it('finds a deliberate discontinuity and ignores a smooth signal', () => {
    const ctx = context();
    const osc = ctx.createOscillator();
    osc.frequency.value = 50;
    const gain = ctx.createGain();
    gain.gain.value = 0.5;
    osc.connect(gain as never);
    gain.connect(ctx.destination as never);
    osc.start(0);
    const smooth = renderOffline(ctx as never, 0.4);
    // A 50 Hz sine at 24 kHz moves at most 2*pi*50/24000 ≈ 0.013 per sample.
    expect(largestDiscontinuity(smooth).delta).toBeLessThan(0.02);

    const clicky = context();
    const osc2 = clicky.createOscillator();
    osc2.frequency.value = 50;
    const gain2 = clicky.createGain();
    gain2.gain.value = 0;
    gain2.gain.setValueAtTime(0.5, 0.107);
    gain2.gain.setValueAtTime(0, 0.213);
    osc2.connect(gain2 as never);
    gain2.connect(clicky.destination as never);
    osc2.start(0);
    const stepped = renderOffline(clicky as never, 0.4);
    expect(largestDiscontinuity(stepped).delta).toBeGreaterThan(0.1);
  });

  it('tells a cut from a fade on a noise signal, where a sample-delta cannot', () => {
    const build = (cut: boolean) => {
      const ctx = context();
      const buffer = ctx.createBuffer(1, 24000, 24000);
      const data = buffer.getChannelData(0);
      let seed = 1;
      for (let i = 0; i < data.length; i += 1) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        data[i] = (seed / 0x3fffffff - 1) * 0.5;
      }
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.loopEnd = 1;
      const gain = ctx.createGain();
      gain.gain.value = 1;
      if (cut) gain.gain.setValueAtTime(0, 0.5);
      else gain.gain.setTargetAtTime(0, 0.5, 0.06);
      source.connect(gain as never);
      gain.connect(ctx.destination as never);
      source.start(0);
      return renderOffline(ctx as never, 1);
    };

    const cut = build(true);
    const fade = build(false);
    // A sample-delta test cannot separate them: white noise steps that far on
    // its own, every few milliseconds.
    expect(largestDiscontinuity(cut).delta).toBeCloseTo(largestDiscontinuity(fade).delta, 1);
    // The envelope can.
    expect(largestEnvelopeStep(cut).ratio).toBeGreaterThan(0.8);
    expect(largestEnvelopeStep(fade).ratio).toBeLessThan(0.45);
  });

  it('renders the same graph identically twice', () => {
    const build = () => {
      const ctx = context();
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = 220;
      const filter = ctx.createBiquadFilter();
      filter.type = 'lowpass';
      filter.frequency.value = 900;
      osc.connect(filter as never);
      filter.connect(ctx.destination as never);
      osc.start(0);
      return renderOffline(ctx as never, 0.2);
    };
    const a = build();
    const b = build();
    expect(Array.from(a.channels[0])).toEqual(Array.from(b.channels[0]));
  });
});
