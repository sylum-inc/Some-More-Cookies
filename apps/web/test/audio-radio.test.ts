/**
 * The radio, measured on its output rather than on its call log.
 *
 * Every assertion here is made on rendered samples. "The whistle tracks the
 * dial" is not a claim about which method was called; it is a claim about the
 * pitch of the sound coming out, and that is what is checked. See
 * `audio-offline.test.ts` for the proof that the instrument doing the measuring
 * is itself correct.
 */

import { describe, expect, it } from 'vitest';

import { NoiseBank } from '../src/audio/buffers.js';
import { MixerState } from '../src/audio/buses.js';
import type { LayerDeps } from '../src/audio/layer.js';
import {
  DEFAULT_RADIO_STATE,
  RadioKit,
  bandCharacter,
  createRadioVoiceParams,
  mapRadioState,
  type RadioAudioState,
  type RadioProgramme,
} from '../src/audio/radio.js';
import { createRng } from '../src/audio/rng.js';
import {
  bandFraction,
  dominantFrequency,
  largestDiscontinuity,
  largestEnvelopeStep,
  renderOffline,
  renderPeak,
  renderRms,
} from '../src/audio/offline.js';
import { createFakeAudioContext, type FakeAudioContext, type FakeGainNode } from '../src/audio/testing.js';

const RATE = 24000;

interface Rig {
  ctx: FakeAudioContext;
  kit: RadioKit;
  out: FakeGainNode;
  mixer: MixerState;
}

/** A radio wired to a bare gain node, so nothing else colours the measurement. */
function rig(options: { reducedIntensity?: boolean } = {}): Rig {
  const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  const mixer = new MixerState();
  if (options.reducedIntensity) mixer.setReducedAudioIntensity(true);
  const deps: LayerDeps = {
    ctx: ctx as unknown as BaseAudioContext,
    destination: out as never,
    bank: new NoiseBank(ctx as unknown as BaseAudioContext, { loopSeconds: 2, seed: 0x1234 }),
    rng: createRng(0xc0ffee),
    mixer,
  };
  return { ctx, kit: new RadioKit(deps, {}), out, mixer };
}

function reception(overrides: Partial<RadioAudioState>): Partial<RadioAudioState> {
  return { ...DEFAULT_RADIO_STATE, ...overrides };
}

const segment = (overrides: Partial<RadioProgramme> = {}): RadioProgramme => ({
  kind: 'music-bed',
  seed: 0x51a7,
  stationSeed: 0x9e1d,
  intensity: 0.5,
  durationSeconds: 180,
  ...overrides,
});

/* -------------------------------------------------------------------------- */

describe('radio — the reception mapping', () => {
  it('is a V around zero beat: the whistle falls to nothing on the station', () => {
    const params = createRadioVoiceParams();
    const at = (detune: number) => {
      mapRadioState(reception({ detune, halfWidth: 0.16, band: 'fm' }) as RadioAudioState, params);
      return { hz: params.whistleHz, gain: params.whistleGain };
    };
    expect(at(0).hz).toBe(0);
    expect(at(0).gain).toBe(0);
    // Symmetric: a beat note is |Δf| and knows nothing about which side you are on.
    expect(at(0.08).hz).toBeCloseTo(at(-0.08).hz, 9);
    // It is loudest somewhere off-station and dies again as the carrier leaves.
    expect(at(0.11).gain).toBeGreaterThan(at(0.02).gain);
    expect(at(0.11).gain).toBeGreaterThan(at(0.8).gain);
  });

  it('survives hostile input', () => {
    const params = createRadioVoiceParams();
    const state = reception({
      detune: Number.NaN,
      halfWidth: 0,
      clarity: Number.POSITIVE_INFINITY,
      hiss: -3,
      hum: Number.NaN,
    }) as RadioAudioState;
    mapRadioState(state, params);
    for (const value of Object.values(params)) expect(Number.isFinite(value)).toBe(true);
    expect(params.whistleHz).toBeGreaterThanOrEqual(0);
    expect(params.hissGain).toBeGreaterThanOrEqual(0);
  });

  it('gives each band its own noise floor and selectivity', () => {
    expect(bandCharacter('shortwave').whistleSpanHz).toBeGreaterThan(bandCharacter('fm').whistleSpanHz);
    expect(bandCharacter('am').audioCutoffHz).toBeLessThan(bandCharacter('fm').audioCutoffHz);
    expect(bandCharacter('am').humLevel).toBeGreaterThan(bandCharacter('fm').humLevel);
  });
});

describe('radio — the carrier whistle, rendered', () => {
  /** Render the whistle alone at a given mistuning and measure its pitch. */
  function whistlePitch(detune: number): number {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ detune, halfWidth: 0.16, hiss: 0, clarity: 0, hum: 0, band: 'fm' }));
    const audio = renderOffline(ctx as never, 0.85);
    return dominantFrequency(audio, 0.5, 0.85, 20, 6000);
  }

  it('rises monotonically as the dial moves away from the station, on both sides', () => {
    const offsets = [0.02, 0.05, 0.09, 0.14, 0.2, 0.28];
    const above = offsets.map((offset) => whistlePitch(offset));
    for (let i = 1; i < above.length; i += 1) {
      expect(above[i]).toBeGreaterThan((above[i - 1] as number) * 1.15);
    }
    // The far end of the sweep is a real, high whistle, not a rumble.
    expect(above[0]).toBeLessThan(200);
    expect(above[above.length - 1]).toBeGreaterThan(1200);

    // Mirrored below the station, because a beat note is an absolute difference.
    for (let i = 0; i < offsets.length; i += 1) {
      const below = whistlePitch(-(offsets[i] as number));
      expect(below).toBeCloseTo(above[i] as number, -1);
    }
  });

  it('is inaudible exactly on the station — zero beat is the "you are on it" cue', () => {
    const onStation = rig();
    onStation.kit.setPower(true);
    onStation.kit.setReception(reception({ detune: 0, halfWidth: 0.16, hiss: 0, clarity: 0, hum: 0 }));
    const silent = renderRms(renderOffline(onStation.ctx as never, 1), 0.6, 1);

    const offStation = rig();
    offStation.kit.setPower(true);
    offStation.kit.setReception(reception({ detune: 0.12, halfWidth: 0.16, hiss: 0, clarity: 0, hum: 0 }));
    const heard = renderRms(renderOffline(offStation.ctx as never, 1), 0.6, 1);

    expect(silent).toBeLessThan(heard * 0.01);
    expect(heard).toBeGreaterThan(0.01);
  });
});

describe('radio — hiss', () => {
  it('dominates between stations and recedes once a station locks', () => {
    const between = rig();
    between.kit.setPower(true);
    between.kit.setReception(reception({ hiss: 0.9, clarity: 0, detune: 0, band: 'fm' }));
    const betweenAudio = renderOffline(between.ctx as never, 1.2);
    const betweenLevel = renderRms(betweenAudio, 0.7, 1.2);

    const locked = rig();
    locked.kit.setPower(true);
    locked.kit.setReception(reception({ hiss: 0.06, clarity: 0.85, detune: 0, band: 'fm' }));
    // No programme playing: this measures the noise floor alone, both times.
    const lockedAudio = renderOffline(locked.ctx as never, 1.2);
    const lockedLevel = renderRms(lockedAudio, 0.7, 1.2);

    expect(betweenLevel).toBeGreaterThan(0.02);
    expect(lockedLevel).toBeLessThan(betweenLevel * 0.15);
  });

  it('narrows as it recedes: a station closes the static up as well as quieting it', () => {
    const measure = (hiss: number) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ hiss, clarity: 1 - hiss, band: 'fm' }));
      const audio = renderOffline(ctx as never, 1.2);
      return bandFraction(audio, 0.7, 1.2, 3000, 12000);
    };
    expect(measure(0.95)).toBeGreaterThan(measure(0.2) * 1.5);
  });

  it('is quieter and duller on AM than on FM at the same noise floor', () => {
    const measure = (band: RadioAudioState['band']) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ hiss: 0.9, clarity: 0, band }));
      const audio = renderOffline(ctx as never, 1.2);
      return {
        level: renderRms(audio, 0.7, 1.2),
        top: bandFraction(audio, 0.7, 1.2, 3000, 12000),
      };
    };
    const fm = measure('fm');
    const am = measure('am');
    expect(am.level).toBeLessThan(fm.level);
    expect(am.top).toBeLessThan(fm.top);
  });
});

describe('radio — programme material', () => {
  it('renders bit-identical samples for the same segment seed', () => {
    const render = (seed: number) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ clarity: 1, hiss: 0, hum: 0, volume: 1 }));
      kit.playSegment('primary', segment({ seed, intensity: 0.6 }));
      // Drive the look-ahead scheduler the way the engine's pump timer does.
      for (let step = 0; step < 25; step += 1) kit.pump(step * 0.1);
      return renderOffline(ctx as never, 2);
    };
    const first = render(0x51a7);
    const second = render(0x51a7);
    expect(Array.from(first.channels[0])).toEqual(Array.from(second.channels[0]));
    expect(Array.from(first.channels[1])).toEqual(Array.from(second.channels[1]));

    // ...and a different seed is a different broadcast, not the same one twice.
    const other = render(0x51a8);
    expect(Array.from(other.channels[0])).not.toEqual(Array.from(first.channels[0]));
  });

  it('gives a station the same ident every time it airs, from the station seed', () => {
    const render = (stationSeed: number, seed: number) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ clarity: 1, hiss: 0, hum: 0, volume: 1 }));
      kit.playSegment('primary', segment({ kind: 'ident', stationSeed, seed, durationSeconds: 8 }));
      return renderOffline(ctx as never, 1.6);
    };
    // Two different airings of the same station's ident: same sting.
    const first = render(0x9e1d, 111);
    const second = render(0x9e1d, 222);
    expect(Array.from(first.channels[0])).toEqual(Array.from(second.channels[0]));
    // A different station's ident is a different sting.
    const elsewhere = render(0x4411, 111);
    expect(Array.from(elsewhere.channels[0])).not.toEqual(Array.from(first.channels[0]));
  });

  it('makes speech-shaped sound: energy in the formant band, syllable-rate movement', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ clarity: 1, hiss: 0, hum: 0, volume: 1, band: 'am' }));
    kit.playSegment('primary', segment({ kind: 'spoken', durationSeconds: 40 }));
    for (let step = 0; step < 45; step += 1) kit.pump(step * 0.1);
    const audio = renderOffline(ctx as never, 4);

    // Voiced speech lives between the first formant and the top of an AM
    // channel; nothing much should be below the glottal fundamental.
    expect(bandFraction(audio, 0.5, 4, 200, 3400)).toBeGreaterThan(0.5);
    expect(renderRms(audio, 0.5, 4)).toBeGreaterThan(0.004);

    // Syllables: the envelope has to move. A steady drone would not. Measured
    // against the passage's own level, so this is a claim about *cadence* and
    // not an accidental claim about how loud the mix happens to be.
    const overall = renderRms(audio, 0.5, 4);
    let loud = 0;
    let quiet = 0;
    for (let window = 0; window < 34; window += 1) {
      const level = renderRms(audio, 0.5 + window * 0.1, 0.6 + window * 0.1);
      if (level > overall * 1.4) loud += 1;
      if (level < overall * 0.45) quiet += 1;
    }
    expect(loud).toBeGreaterThan(3);
    expect(quiet).toBeGreaterThan(2);
  });

  it('treats silence and dead air as different sounds, both quiet', () => {
    const level = (kind: RadioProgramme['kind']) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ clarity: 1, hiss: 0.03, hum: 0, volume: 1 }));
      kit.playSegment('primary', segment({ kind, durationSeconds: 20 }));
      for (let step = 0; step < 20; step += 1) kit.pump(step * 0.1);
      return renderRms(renderOffline(ctx as never, 2), 1.2, 2);
    };
    const silence = level('silence');
    const carrier = level('carrier');
    const bed = level('music-bed');
    expect(silence).toBeLessThan(bed * 0.35);
    expect(carrier).toBeLessThan(bed * 0.35);
    expect(carrier).toBeGreaterThan(silence);
  });

  it('puts a bleeding station underneath the tuned one, quieter and duller', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ clarity: 0.7, bleed: 0.5, hiss: 0.1, hum: 0, volume: 1 }));
    kit.playSegment('primary', segment({ seed: 1, intensity: 0.6 }));
    kit.playSegment('bleed', segment({ seed: 2, intensity: 0.6 }));
    for (let step = 0; step < 22; step += 1) kit.pump(step * 0.1);
    const both = renderRms(renderOffline(ctx as never, 2.2), 1.4, 2.2);

    const alone = rig();
    alone.kit.setPower(true);
    alone.kit.setReception(reception({ clarity: 0.7, bleed: 0, hiss: 0.1, hum: 0, volume: 1 }));
    alone.kit.playSegment('primary', segment({ seed: 1, intensity: 0.6 }));
    for (let step = 0; step < 22; step += 1) alone.kit.pump(step * 0.1);
    const single = renderRms(renderOffline(alone.ctx as never, 2.2), 1.4, 2.2);

    expect(both).toBeGreaterThan(single);
  });
});

describe('radio — hum', () => {
  it('sits after the volume control, as it does in a real set', () => {
    const measure = (volume: number) => {
      const { ctx, kit } = rig();
      kit.setPower(true);
      kit.setReception(reception({ hiss: 0, clarity: 0, hum: 1, volume, band: 'am' }));
      const audio = renderOffline(ctx as never, 1.2);
      return renderRms(audio, 0.8, 1.2);
    };
    // Turning the radio down does not turn the hum down: that is why hum is the
    // thing you hear at 2am with the volume at a whisper.
    expect(measure(0.05)).toBeCloseTo(measure(1), 3);
    expect(measure(1)).toBeGreaterThan(0.005);
  });

  it('hums at twice line frequency', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ hiss: 0, clarity: 0, hum: 1, volume: 1, band: 'am' }));
    const audio = renderOffline(ctx as never, 1.2);
    expect(dominantFrequency(audio, 0.6, 1.2, 30, 500)).toBeCloseTo(120, -1);
  });
});

describe('radio — nothing clicks', () => {
  /**
   * Two instruments, because a click has two shapes.
   *
   * On a tonal signal a click is a *step in the waveform*, so the bound is on
   * the largest sample-to-sample jump: a signal peaking near 0.1 that is
   * genuinely ramped cannot move further than a few thousandths between
   * adjacent samples at 24 kHz.
   *
   * On hiss it is not, and this is the trap worth naming: adjacent samples of
   * white noise legitimately differ by twice its amplitude, so cutting the
   * static dead is invisible to a sample-delta test while being obvious to a
   * listener. What is heard there is a step in the *level*, so those cases are
   * measured with `largestEnvelopeStep` instead — an instrument
   * `audio-offline.test.ts` proves can tell a cut from a fade.
   */
  const WAVEFORM_LIMIT = 0.01;
  const ENVELOPE_LIMIT = 0.45;

  it('switches on and off without a step in the waveform', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    // Tonal configuration: hum and a music bed, no hiss, so the waveform is
    // smooth and any switching artefact is unmissable.
    kit.setReception(reception({ hiss: 0, clarity: 1, hum: 0.6, volume: 1, band: 'am' }));
    kit.playSegment('primary', segment());
    for (let step = 0; step < 12; step += 1) kit.pump(step * 0.1);
    ctx.advance(1.2);
    kit.setPower(false);
    ctx.advance(0.8);
    kit.setPower(true);

    const audio = renderOffline(ctx as never, 3);
    expect(largestDiscontinuity(audio).delta).toBeLessThan(WAVEFORM_LIMIT);
    // And off is really off, and on comes back.
    expect(renderRms(audio, 1.6, 1.9)).toBeLessThan(1e-4);
    expect(renderRms(audio, 2.4, 2.9)).toBeGreaterThan(0.005);
  });

  it('fades the static rather than cutting it when the power goes off', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ hiss: 0.95, clarity: 0, hum: 0.4, volume: 1 }));
    ctx.advance(1.2);
    kit.setPower(false);

    const audio = renderOffline(ctx as never, 2.2);
    expect(largestEnvelopeStep(audio, 0.4, 2.2).ratio).toBeLessThan(ENVELOPE_LIMIT);
    // The shape of a fade: still audible a moment after the switch, gone soon after.
    const before = renderRms(audio, 1.0, 1.2);
    expect(renderRms(audio, 1.2, 1.22)).toBeGreaterThan(before * 0.3);
    expect(renderRms(audio, 1.7, 2.2)).toBeLessThan(before * 0.01);
  });

  it('changes band without a step, and mutes while the switch is in transit', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.setReception(reception({ hiss: 0.9, clarity: 0.6, hum: 0.3, volume: 1, band: 'fm' }));
    kit.playSegment('primary', segment());
    for (let step = 0; step < 12; step += 1) kit.pump(step * 0.1);
    ctx.advance(1.2);
    kit.bandChange();
    kit.setReception(reception({ hiss: 0.95, clarity: 0, hum: 0.3, volume: 1, band: 'am' }));

    const audio = renderOffline(ctx as never, 2.4);
    expect(largestEnvelopeStep(audio, 0.4, 2.4).ratio).toBeLessThan(ENVELOPE_LIMIT);
    // The dip really happens, and the far side of the switch comes back up.
    expect(renderRms(audio, 1.24, 1.3)).toBeLessThan(renderRms(audio, 0.9, 1.15) * 0.5);
    expect(renderRms(audio, 1.7, 2.3)).toBeGreaterThan(0.01);
  });

  it('sweeps across a station without a step', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    kit.playSegment('primary', segment());
    // Walk the dial through a station the way a player turning a knob would:
    // hiss giving way to programme and back, with the whistle sweeping down
    // through zero beat and up the other side.
    for (let step = 0; step <= 60; step += 1) {
      const detune = 0.34 - step * (0.68 / 60);
      const proximity = Math.exp(-((detune / 0.16) ** 2));
      kit.setReception(
        reception({
          detune,
          halfWidth: 0.16,
          clarity: proximity * 0.9,
          hiss: 0.9 * (1 - proximity * 0.9),
          hum: 0.2,
          volume: 1,
        }),
      );
      kit.pump(ctx.currentTime);
      ctx.advance(1 / 30);
    }
    const audio = renderOffline(ctx as never, 2);
    expect(largestEnvelopeStep(audio, 0.2, 2).ratio).toBeLessThan(ENVELOPE_LIMIT);
  });
});

describe('radio — accessibility and headroom', () => {
  it('never exceeds its own stated peaks', () => {
    const { ctx, kit } = rig();
    kit.setPower(true);
    // Everything at once, volume wide open: hiss, whistle, hum, two stations.
    kit.setReception(reception({ hiss: 1, clarity: 1, bleed: 1, hum: 1, detune: 0.12, halfWidth: 0.16, volume: 1 }));
    kit.playSegment('primary', segment({ intensity: 1 }));
    kit.playSegment('bleed', segment({ seed: 99, intensity: 1 }));
    for (let step = 0; step < 30; step += 1) kit.pump(step * 0.1);
    const audio = renderOffline(ctx as never, 3);
    expect(renderPeak(audio)).toBeLessThan(0.9);
    expect(renderRms(audio, 1, 3)).toBeLessThan(0.3);
  });

  it('is quieter under reduced audio intensity', () => {
    const measure = (reducedIntensity: boolean) => {
      const { ctx, kit } = rig({ reducedIntensity });
      kit.setPower(true);
      kit.setReception(reception({ hiss: 1, clarity: 1, hum: 1, volume: 1 }));
      kit.playSegment('primary', segment({ intensity: 1 }));
      for (let step = 0; step < 20; step += 1) kit.pump(step * 0.1);
      return renderRms(renderOffline(ctx as never, 2), 1, 2);
    };
    expect(measure(true)).toBeLessThan(measure(false) * 0.8);
  });

  it('is silent before the power switch is thrown', () => {
    const { ctx, kit } = rig();
    kit.setReception(reception({ hiss: 1, clarity: 1, hum: 1, volume: 1 }));
    kit.playSegment('primary', segment());
    for (let step = 0; step < 10; step += 1) kit.pump(step * 0.1);
    expect(renderPeak(renderOffline(ctx as never, 1))).toBe(0);
  });
});
