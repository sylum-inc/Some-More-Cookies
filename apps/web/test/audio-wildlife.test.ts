/**
 * Wildlife audio, measured on its output.
 *
 * The claims worth checking here are the ones the spec makes: an animal is
 * where it is in the stereo field, a species sounds like itself everywhere, a
 * resident is recognisably that resident, shyness and curiosity really are what
 * shape a voice, and being watched is quiet enough to miss and never a scare.
 */

import { describe, expect, it } from 'vitest';

import { NoiseBank } from '../src/audio/buffers.js';
import { MixerState } from '../src/audio/buses.js';
import type { LayerDeps } from '../src/audio/layer.js';
import { createRng } from '../src/audio/rng.js';
import {
  MAX_CALL_SECONDS,
  PHASE_MOVEMENT_RATE,
  WILDLIFE_AUDIBLE_METRES,
  WildlifeKit,
  distanceCutoffHz,
  individualVoice,
  movementRate,
  speciesVoice,
  type WildlifeAnimalAudio,
} from '../src/audio/wildlife.js';
import {
  bandFraction,
  largestDiscontinuity,
  renderChannelRms,
  renderOffline,
  renderPeak,
  renderRms,
} from '../src/audio/offline.js';
import { createFakeAudioContext, type FakeAudioContext } from '../src/audio/testing.js';

const RATE = 24000;

function rig(options: { reducedIntensity?: boolean } = {}): { ctx: FakeAudioContext; kit: WildlifeKit } {
  const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);
  const mixer = new MixerState();
  if (options.reducedIntensity) mixer.setReducedAudioIntensity(true);
  const deps: LayerDeps = {
    ctx: ctx as unknown as BaseAudioContext,
    destination: out as never,
    bank: new NoiseBank(ctx as unknown as BaseAudioContext, { loopSeconds: 2, seed: 0x77 }),
    rng: createRng(0xbeef),
    mixer,
  };
  const kit = new WildlifeKit(deps, { panningModel: 'equalpower' });
  kit.start();
  return { ctx, kit };
}

function animal(overrides: Partial<WildlifeAnimalAudio> = {}): WildlifeAnimalAudio {
  return {
    id: 'fox:abc',
    speciesId: 'red-fox',
    shyness: 0.55,
    curiosity: 0.6,
    x: 0,
    y: 0,
    z: -5,
    distanceM: 5,
    phase: 'watching',
    alarm: 0,
    interest: 0.5,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */

describe('wildlife — voices from shyness and curiosity alone', () => {
  it('gives a species the same voice everywhere, from its id', () => {
    const a = speciesVoice('pine-marten', 0.7, 0.4);
    const b = speciesVoice('pine-marten', 0.7, 0.4);
    expect(a).toEqual(b);
    expect(speciesVoice('raccoon', 0.7, 0.4)).not.toEqual(a);
  });

  it('puts shy animals higher and quieter than bold ones', () => {
    // Averaged across ids, because the archetype is a per-species choice and one
    // pair of species proves nothing.
    let shyHz = 0;
    let boldHz = 0;
    let shyPeak = 0;
    let boldPeak = 0;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    for (const id of ids) {
      const shy = speciesVoice(id, 0.95, 0.5);
      const bold = speciesVoice(id, 0.05, 0.5);
      shyHz += shy.startHz;
      boldHz += bold.startHz;
      shyPeak += shy.peak;
      boldPeak += bold.peak;
    }
    expect(shyHz / ids.length).toBeGreaterThan((boldHz / ids.length) * 2);
    expect(shyPeak / ids.length).toBeLessThan(boldPeak / ids.length);
    // And a shy voice is a thin one: less breath behind it.
    expect(speciesVoice('a', 0.95, 0.5).breath).toBeLessThan(speciesVoice('a', 0.05, 0.5).breath);
  });

  it('makes curious animals more expressive, not just louder', () => {
    const dull = speciesVoice('vole', 0.5, 0.02);
    const keen = speciesVoice('vole', 0.5, 0.98);
    expect(keen.modIndex).toBeGreaterThan(dull.modIndex);
    expect(keen.repeats).toBeGreaterThanOrEqual(dull.repeats);
    // Same species, same archetype: curiosity shapes it, it does not replace it.
    expect(keen.archetype).toBe(dull.archetype);
  });

  it('shifts an individual off the species baseline, subtly', () => {
    const base = speciesVoice('red-fox', 0.55, 0.6);
    const one = individualVoice(base, 'red-fox:1a2b');
    const two = individualVoice(base, 'red-fox:9z8y');
    expect(one).not.toEqual(two);
    expect(individualVoice(base, 'red-fox:1a2b')).toEqual(one);
    // Never far enough to read as a different animal: inside a semitone.
    for (const voice of [one, two]) {
      expect(voice.startHz / base.startHz).toBeGreaterThan(0.94);
      expect(voice.startHz / base.startHz).toBeLessThan(1.06);
    }
  });

  it('bounds every call so nothing can hold a note', () => {
    for (let i = 0; i < 200; i += 1) {
      const voice = speciesVoice(`species-${i}`, (i % 11) / 10, (i % 7) / 6);
      expect(voice.durationSeconds).toBeLessThanOrEqual(MAX_CALL_SECONDS);
      expect(voice.repeats).toBeLessThanOrEqual(6);
      expect(voice.peak).toBeLessThan(0.5);
      expect(Number.isFinite(voice.startHz)).toBe(true);
    }
  });
});

describe('wildlife — movement', () => {
  it('rates movement by phase, quieting for shy animals and silent when absent', () => {
    expect(PHASE_MOVEMENT_RATE.fleeing).toBeGreaterThan(PHASE_MOVEMENT_RATE.investigating);
    expect(PHASE_MOVEMENT_RATE.investigating).toBeGreaterThan(PHASE_MOVEMENT_RATE.watching);
    expect(movementRate('absent', 0, 3)).toBe(0);
    expect(movementRate('gone', 0, 3)).toBe(0);
    // A watching animal is nearly silent: stillness is the mechanic (spec §7).
    expect(movementRate('watching', 0.5, 4)).toBeLessThan(movementRate('approaching', 0.5, 4) * 0.2);
    expect(movementRate('approaching', 0.9, 4)).toBeLessThan(movementRate('approaching', 0.1, 4));
    // Nothing to hear from the far side of the campsite.
    expect(movementRate('fleeing', 0.2, WILDLIFE_AUDIBLE_METRES + 1)).toBe(0);
  });

  it('takes the top off a sound with distance', () => {
    expect(distanceCutoffHz(1, 5000)).toBeGreaterThan(distanceCutoffHz(20, 5000));
    expect(distanceCutoffHz(0, 5000)).toBeCloseTo(5000, -1);
  });

  it('renders duller rustles from further away', () => {
    const brightness = (distanceM: number) => {
      const { ctx, kit } = rig();
      kit.rustle(0, 0, -distanceM, distanceM, 0.6, 0.05);
      const audio = renderOffline(ctx as never, 0.6);
      return bandFraction(audio, 0, 0.6, 2000, 12000);
    };
    expect(brightness(2)).toBeGreaterThan(brightness(20) * 1.4);
  });
});

describe('wildlife — placement in the stereo field', () => {
  /**
   * The listener sits at the origin facing -Z with +Y up, which is the WebAudio
   * default and the basis `updateListener` maintains. +X is therefore the
   * player's right.
   */
  function sides(x: number, z: number): { left: number; right: number } {
    const { ctx, kit } = rig();
    kit.call(animal({ x, y: 0, z, distanceM: Math.hypot(x, z), alarm: 0 }), 0.05);
    const audio = renderOffline(ctx as never, 2.5);
    return { left: renderChannelRms(audio, 0, 0, 2.5), right: renderChannelRms(audio, 1, 0, 2.5) };
  }

  it('puts a call on the correct side for its bearing', () => {
    const right = sides(6, 0);
    expect(right.right).toBeGreaterThan(right.left * 4);
    expect(right.right).toBeGreaterThan(0);

    const left = sides(-6, 0);
    expect(left.left).toBeGreaterThan(left.right * 4);

    // Directly behind: centred, and audible — which is the entire point of the
    // wildlife system.
    const behind = sides(0, 6);
    expect(behind.left).toBeCloseTo(behind.right, 4);
    expect(behind.left).toBeGreaterThan(0);
  });

  it('places movement foley too, not just calls', () => {
    const { ctx, kit } = rig();
    kit.rustle(-7, 0, 0, 7, 0.7, 0.05);
    const audio = renderOffline(ctx as never, 0.8);
    expect(renderChannelRms(audio, 0, 0, 0.8)).toBeGreaterThan(renderChannelRms(audio, 1, 0, 0.8) * 4);
  });

  it('gets quieter with distance', () => {
    const level = (distanceM: number) => {
      const { ctx, kit } = rig();
      kit.call(animal({ x: 0, y: 0, z: -distanceM, distanceM }), 0.05);
      return renderRms(renderOffline(ctx as never, 2.5), 0, 2.5);
    };
    expect(level(20)).toBeLessThan(level(3) * 0.5);
    expect(level(20)).toBeGreaterThan(0);
  });
});

describe('wildlife — one-shots', () => {
  it('makes a startle that is louder than a call, brief, and over', () => {
    const bolt = rig();
    bolt.kit.startle({ speciesId: 'red-fox', shyness: 0.4, curiosity: 0.6, x: 2, y: 0, z: -3, distanceM: 3.6 }, 0.05);
    const audio = renderOffline(bolt.ctx as never, 2);

    const voice = rig();
    voice.kit.call(animal({ x: 2, y: 0, z: -3, distanceM: 3.6 }), 0.05);
    const called = renderOffline(voice.ctx as never, 2);

    // A bolt is the most arresting thing this layer makes: peakier than a call,
    // and concentrated into a third of a second rather than spread over a phrase.
    expect(renderPeak(audio)).toBeGreaterThan(renderPeak(called));
    // Brief: nothing left a second later. A bolt, not a set piece.
    expect(renderRms(audio, 1.2, 2)).toBeLessThan(renderRms(audio, 0.05, 0.5) * 0.05);
  });

  it('makes taking an object a small knock and a drag, not a bang', () => {
    const { ctx, kit } = rig();
    kit.tookObject(1, 0, -2, 2.2, 0.05);
    const audio = renderOffline(ctx as never, 1.5);
    expect(renderPeak(audio)).toBeGreaterThan(0.005);
    expect(renderPeak(audio)).toBeLessThan(0.35);
  });

  it('schedules movement from the tracked animals and stops when they leave', () => {
    const { ctx, kit } = rig();
    kit.setAnimals([animal({ phase: 'approaching', distanceM: 6, x: 3, z: -4 })]);
    let scheduled = 0;
    for (let step = 0; step < 200; step += 1) {
      scheduled += kit.pump(step * 0.1);
      ctx.advance(0.1);
    }
    // An approaching animal disturbs the undergrowth about once a second, so
    // twenty seconds of it is a stream of events, not a handful.
    expect(scheduled).toBeGreaterThan(8);
    const audio = renderOffline(ctx as never, 20);
    expect(renderRms(audio, 0, 20)).toBeGreaterThan(0.0005);

    const quiet = rig();
    quiet.kit.setAnimals([]);
    let none = 0;
    for (let step = 0; step < 200; step += 1) {
      none += quiet.kit.pump(step * 0.1);
      quiet.ctx.advance(0.1);
    }
    expect(none).toBe(0);
    expect(renderPeak(renderOffline(quiet.ctx as never, 20))).toBe(0);
  });
});

describe('wildlife — being watched', () => {
  /**
   * Spec §2.1 forbids generic horror and §2.2 forbids anything threatening, so
   * these are the assertions that keep the cue honest: it is quiet, it arrives
   * slowly, it has no transient, and it is placed rather than pressed into the
   * middle of the player's head.
   */
  it('is audible, very quiet, and free of any transient', () => {
    const { ctx, kit } = rig();
    kit.setWatched(true, -4, 0, -2);
    const audio = renderOffline(ctx as never, 10);

    const level = renderRms(audio, 7, 10);
    expect(level).toBeGreaterThan(0);
    // A hundredth of full scale is the ceiling. This has to be missable.
    expect(renderPeak(audio)).toBeLessThan(0.02);
    // No stinger: no step anywhere in it.
    expect(largestDiscontinuity(audio).delta).toBeLessThan(0.002);
    // It arrives over seconds, not instantly.
    expect(renderRms(audio, 0, 0.5)).toBeLessThan(level * 0.25);
    // And it is placed: something is behind and to the left, not inside the head.
    expect(renderChannelRms(audio, 0, 7, 10)).toBeGreaterThan(renderChannelRms(audio, 1, 7, 10) * 1.5);
  });

  it('is low: nothing in it is bright enough to be a scare', () => {
    const { ctx, kit } = rig();
    kit.setWatched(true, 0, 0, -3);
    const audio = renderOffline(ctx as never, 10);
    expect(bandFraction(audio, 6, 10, 0, 400)).toBeGreaterThan(0.9);
  });

  it('fades away again when nothing is watching', () => {
    const { ctx, kit } = rig();
    kit.setWatched(true, 0, 0, -3);
    ctx.advance(8);
    kit.setWatched(false);
    const audio = renderOffline(ctx as never, 16);
    const present = renderRms(audio, 6, 8);
    expect(present).toBeGreaterThan(0);
    expect(renderRms(audio, 14, 16)).toBeLessThan(present * 0.05);
    expect(largestDiscontinuity(audio).delta).toBeLessThan(0.002);
  });

  it('is far quieter than an ordinary call', () => {
    const watchedRig = rig();
    watchedRig.kit.setWatched(true, 0, 0, -4);
    const watched = renderPeak(renderOffline(watchedRig.ctx as never, 10));

    const callRig = rig();
    callRig.kit.call(animal({ distanceM: 4, z: -4 }), 0.05);
    const call = renderPeak(renderOffline(callRig.ctx as never, 2.5));

    expect(watched).toBeLessThan(call * 0.25);
  });
});

describe('wildlife — accessibility and headroom', () => {
  it('stays well inside the headroom with a busy campsite', () => {
    const { ctx, kit } = rig();
    const crowd: WildlifeAnimalAudio[] = [
      animal({ id: 'a', speciesId: 'raccoon', shyness: 0.1, phase: 'fleeing', distanceM: 2, x: 2, z: -1 }),
      animal({ id: 'b', speciesId: 'red-fox', shyness: 0.4, phase: 'investigating', distanceM: 3, x: -2, z: -2 }),
      animal({ id: 'c', speciesId: 'flying-squirrel', shyness: 0.9, phase: 'approaching', distanceM: 4, x: 0, z: 3 }),
    ];
    kit.setAnimals(crowd);
    kit.setWatched(true, 0, 0, -5);
    for (const each of crowd) kit.call(each, 0.1);
    kit.startle(crowd[0] as WildlifeAnimalAudio, 0.2);
    kit.tookObject(1, 0, -1, 1.4, 0.3);
    for (let step = 0; step < 40; step += 1) {
      kit.pump(step * 0.1);
      ctx.advance(0.1);
    }
    const audio = renderOffline(ctx as never, 4);
    expect(renderPeak(audio)).toBeLessThan(0.8);
  });

  it('is quieter under reduced audio intensity', () => {
    const measure = (reducedIntensity: boolean) => {
      const { ctx, kit } = rig({ reducedIntensity });
      kit.call(animal({ distanceM: 3, z: -3, alarm: 0.8 }), 0.05);
      kit.startle({ speciesId: 'red-fox', shyness: 0.4, curiosity: 0.6, x: 0, y: 0, z: -3, distanceM: 3 }, 0.6);
      return renderPeak(renderOffline(ctx as never, 3));
    };
    expect(measure(true)).toBeLessThan(measure(false) * 0.8);
  });
});
