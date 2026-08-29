/**
 * The bridge, and the whole mix at once.
 *
 * Two things are checked here that neither kit can check alone: that the
 * simulation's *rolling event logs* are read as logs and not replayed sixty
 * times a second, and that with every layer running together the engine still
 * has headroom.
 */

import { describe, expect, it } from 'vitest';

import {
  SIM_DT,
  createRitual,
  setRadioBand,
  setRadioVolume,
  stepRitual,
  toggleRadio,
  tuneToStation,
  type RadioProfileSpec,
  type RitualState,
  type WildlifeSpecies,
} from '@somemore/sim';

import { AudioBridge } from '../src/audio/bridge.js';
import { AudioEngine } from '../src/audio/engine.js';
import { renderOffline, renderPeak, renderRms } from '../src/audio/offline.js';
import { createFakeAudioContext, type FakeAudioContext } from '../src/audio/testing.js';

const RATE = 24000;

const DIAL: RadioProfileSpec = {
  stations: [
    { id: 'kdel', dial: 91.3, band: 'fm', name: 'KDEL', character: 'lofi', reception: 0.85, note: 'a long record' },
    { id: 'wnum', dial: 92.1, band: 'fm', name: 'WNUM', character: 'strange', reception: 0.5, note: 'a carrier' },
    { id: 'wxam', dial: 1080, band: 'am', name: 'WX', character: 'weather-service', reception: 0.6, note: 'a forecast' },
  ],
  baseReception: 0.8,
  receptionNote: 'the ridge helps',
  betweenStations: 'static, and a long way off, a carrier',
};

const ROSTER: readonly WildlifeSpecies[] = [
  {
    id: 'red-fox',
    label: 'a fox',
    shyness: 0.45,
    curiosity: 0.8,
    window: ['dusk', 'early-night', 'deep-night', 'pre-dawn', 'dawn'],
    attractedBy: ['stillness', 'food-smell', 'crumbs'],
    repelledBy: ['sudden-movement'],
    canPersist: true,
    investigatesObjects: true,
    traces: ['prints in the ash'],
    note: 'comes back',
  },
  {
    id: 'flying-squirrel',
    label: 'a flying squirrel',
    shyness: 0.92,
    curiosity: 0.5,
    window: ['deep-night'],
    attractedBy: ['stillness', 'quiet'],
    repelledBy: ['footsteps', 'flashlight'],
    canPersist: false,
    investigatesObjects: false,
    traces: ['claw marks'],
    note: 'only for a still player',
  },
];

function world(): RitualState {
  return createRitual({
    campsiteSeed: 'pine-hollow/test',
    environmentId: 'pine-hollow',
    now: 1_700_000_000_000,
    world: { radio: DIAL, wildlife: ROSTER },
  });
}

async function rig(): Promise<{ ctx: FakeAudioContext; bridge: AudioBridge; engine: AudioEngine }> {
  const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
  const bridge = new AudioBridge({
    contextFactory: () => ctx as unknown as AudioContext,
    pumpIntervalMs: 0,
    spatialQuality: 'equalpower',
    // The offline renderer does not model convolution, so the reverb return is
    // switched off and every level below is honestly the dry mix.
    reverb: { wet: 0 },
  });
  const ok = await bridge.unlock();
  expect(ok).toBe(true);
  const engine = bridge.engine;
  if (!engine) throw new Error('engine did not start');
  return { ctx, bridge, engine };
}

/** Advance the simulation and the audio clock together, as the app does. */
function run(ctx: FakeAudioContext, bridge: AudioBridge, ritual: RitualState, steps: number): string[] {
  const cues: string[] = [];
  for (let i = 0; i < steps; i += 1) {
    stepRitual(ritual, SIM_DT);
    const cue = bridge.update(ritual);
    if (cue) cues.push(cue.text);
    bridge.engine?.pump(ctx.currentTime);
    ctx.advance(SIM_DT);
  }
  return cues;
}

/* -------------------------------------------------------------------------- */

describe('bridge — the radio', () => {
  it('follows power, band and the tuned station', async () => {
    const { ctx, bridge, engine } = await rig();
    const ritual = world();
    const radio = engine.radio;
    if (!radio) throw new Error('no radio kit');

    run(ctx, bridge, ritual, 30);
    expect(radio.powered).toBe(false);
    expect(radio.segmentOf('primary')).toBeNull();

    toggleRadio(ritual, true);
    tuneToStation(ritual.radio, 'kdel');
    setRadioVolume(ritual, 0.8);
    run(ctx, bridge, ritual, 30);

    expect(radio.powered).toBe(true);
    expect(radio.state.band).toBe('fm');
    expect(radio.state.volume).toBeCloseTo(0.8, 5);
    // Locked on: the receiver is being handed real programme material.
    expect(radio.segmentOf('primary')).not.toBeNull();
    expect(radio.state.clarity).toBeGreaterThan(0.3);
    expect(radio.state.hiss).toBeLessThan(0.5);

    // Off the station: hiss takes over and the programme is dropped.
    ritual.radio.dial = 91.85;
    run(ctx, bridge, ritual, 30);
    expect(radio.state.hiss).toBeGreaterThan(radio.state.clarity);
    expect(Math.abs(radio.state.detune)).toBeGreaterThan(0);

    setRadioBand(ritual, 'am');
    run(ctx, bridge, ritual, 30);
    expect(radio.state.band).toBe('am');

    toggleRadio(ritual, false);
    run(ctx, bridge, ritual, 10);
    expect(radio.powered).toBe(false);
    expect(radio.segmentOf('primary')).toBeNull();
    await engine.close();
  });

  it('reads the rolling event log once, not once per frame', async () => {
    const { ctx, bridge, engine } = await rig();
    const ritual = world();
    toggleRadio(ritual, true);
    tuneToStation(ritual.radio, 'kdel');

    // Ten seconds of a locked station. `ritual.radioEvents` is a bounded log
    // that nothing drains, so a naive reader would re-announce every entry on
    // every one of these 600 frames.
    const cues = run(ctx, bridge, ritual, 600);
    expect(ritual.radioEvents.length).toBeGreaterThan(0);
    // One line per event that actually happened, not one per frame.
    expect(cues.length).toBeLessThanOrEqual(ritual.radioEvents.length);
    expect(cues.length).toBeLessThan(10);
    // And the copy is the simulation's, not a parallel vocabulary.
    for (const line of cues) expect(line.length).toBeGreaterThan(0);
    await engine.close();
  });
});

describe('bridge — wildlife', () => {
  it('tracks the animals that are present and says what appeared', { timeout: 30_000 }, async () => {
    const { ctx, bridge, engine } = await rig();
    const ritual = world();
    const kit = engine.wildlife;
    if (!kit) throw new Error('no wildlife kit');

    // Sit still: stillness is what brings anything out at all (spec §7).
    ritual.presence.speed = 0;
    ritual.presence.seated = true;
    const cues: string[] = [];
    let sawAnimals = false;
    for (let i = 0; i < 60 * 660; i += 1) {
      stepRitual(ritual, SIM_DT);
      const cue = bridge.update(ritual);
      if (cue?.kind === 'wildlife') cues.push(cue.text);
      if (ritual.wildlife.animals.length > 0) sawAnimals = true;
      bridge.engine?.pump(ctx.currentTime);
      ctx.advance(SIM_DT);
    }

    // Eleven simulated minutes of sitting still at a campsite with a roster.
    // Appearance is rare by design — stillness is the mechanic — so the window
    // is generous; if nothing ever turns up over that, the wiring is what is
    // wrong, not the luck.
    expect(sawAnimals).toBe(true);
    expect(kit.tracked).toBe(ritual.wildlife.animals.length);
    const appearances = ritual.wildlifeEvents.filter((event) => event.kind === 'appeared');
    if (appearances.length > 0) {
      expect(cues.length).toBeGreaterThan(0);
      // Again: one line per sighting, never one per frame.
      expect(cues.length).toBeLessThanOrEqual(appearances.length + 1);
    }
    await engine.close();
  });
});

describe('the whole mix', () => {
  it('keeps every layer inside the engine headroom at once', { timeout: 30_000 }, async () => {
    const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
    const engine = new AudioEngine({
      contextFactory: () => ctx as unknown as AudioContext,
      pumpIntervalMs: 0,
      spatialQuality: 'equalpower',
      reverb: { wet: 0 },
    });
    expect(await engine.resume()).toBe(true);
    engine.startBeds();

    // Everything, at once, at its worst: a roaring fire in a gale, the SM-01
    // compressor and fan at full tilt with frost forming, the radio wide open
    // between two stations, and a campsite full of animals.
    engine.setFireState({ intensity: 1, emberHeat: 1, fuelLoad: 1, windSpeed: 1, crackleRate: 1 });
    engine.setAmbienceConditions({ windSpeed: 1, temperatureC: 22, timeOfDay: 0, wetness: 0 });
    engine.setSizzleState({ heat: 1, moisture: 1, browning: 1, scorch: 1 });
    engine.machine?.compressorStart();
    engine.machine?.fanRamp(1, 0.2);
    engine.machine?.crtWhine(true);
    engine.machine?.frostCrackle(1);
    engine.radio?.setPower(true);
    engine.radio?.setReception({
      clarity: 1,
      hiss: 1,
      bleed: 1,
      hum: 1,
      detune: 0.12,
      halfWidth: 0.16,
      volume: 1,
      band: 'fm',
    });
    engine.radio?.playSegment('primary', {
      kind: 'music-bed',
      seed: 4242,
      stationSeed: 99,
      intensity: 1,
      durationSeconds: 200,
    });
    engine.radio?.playSegment('bleed', {
      kind: 'spoken',
      seed: 8484,
      stationSeed: 77,
      intensity: 1,
      durationSeconds: 200,
    });
    engine.wildlife?.setAnimals([
      {
        id: 'a',
        speciesId: 'raccoon',
        shyness: 0.1,
        curiosity: 0.9,
        x: 2,
        y: 0,
        z: -1,
        distanceM: 2.2,
        phase: 'fleeing',
        alarm: 1,
        interest: 1,
      },
      {
        id: 'b',
        speciesId: 'red-fox',
        shyness: 0.4,
        curiosity: 0.9,
        x: -3,
        y: 0,
        z: 2,
        distanceM: 3.6,
        phase: 'investigating',
        alarm: 0.4,
        interest: 1,
      },
    ]);
    engine.wildlife?.setWatched(true, 0, 0, -6);

    for (let step = 0; step < 60 * 4; step += 1) {
      engine.pump(ctx.currentTime);
      ctx.advance(SIM_DT);
    }

    const audio = renderOffline(ctx as never, 4);
    const peak = renderPeak(audio);
    const rms = renderRms(audio, 1, 4);

    // Everything is running: this must not be silence.
    expect(rms).toBeGreaterThan(0.01);
    // The limiter is a safety net and it is doing its job: nothing reaches full
    // scale, so nothing clips at the device.
    expect(peak).toBeLessThan(1);
    // And there is real headroom left, not a hair of it.
    expect(peak).toBeLessThan(0.85);
    // A sane long-term level, well under the limiter's threshold.
    expect(rms).toBeLessThan(0.35);
    await engine.close();
  });

  it('is silent when muted, with everything still running', async () => {
    const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
    const engine = new AudioEngine({
      contextFactory: () => ctx as unknown as AudioContext,
      pumpIntervalMs: 0,
      reverb: { wet: 0 },
    });
    await engine.resume();
    engine.startBeds();
    engine.setFireState({ intensity: 1, emberHeat: 1, fuelLoad: 1 });
    engine.radio?.setPower(true);
    engine.radio?.setReception({ hiss: 1, clarity: 1, hum: 1, volume: 1 });
    engine.wildlife?.setWatched(true);
    engine.setMuted(true);
    for (let step = 0; step < 120; step += 1) {
      engine.pump(ctx.currentTime);
      ctx.advance(SIM_DT);
    }
    // Muting is a master-gain move, so it takes a moment to settle; measure
    // after it has.
    expect(renderRms(renderOffline(ctx as never, 2), 1, 2)).toBeLessThan(1e-4);
    await engine.close();
  });
});
