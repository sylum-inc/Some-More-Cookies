/**
 * The soundscape, as a set of named scenes.
 *
 * Every scene here drives the *shipping* path: a real `AudioBridge` over a real
 * `AudioEngine`, fed a real `RitualState` that a real `stepRitual` advanced,
 * with `bridge.update` doing the simulation-to-audio mapping exactly as
 * `App.tsx` does it. Nothing calls a synthesis method directly unless the note
 * on the scene says so and says why.
 *
 * That distinction is the whole point of the exercise. A test that calls
 * `kit.latchClunk()` proves the latch clunk exists; it does not prove anything
 * about whether the game ever plays it. Rendering the bridge's own output
 * proves what a player would actually hear — and it is how `footsteps-walking`
 * below came to be a scene that renders silence.
 *
 * The renderer is `apps/web/src/audio/offline.ts`, in Node, with no browser.
 * Its two documented gaps matter to every number downstream and are repeated
 * on every artefact: `ConvolverNode` renders silence, so the reverb return is
 * switched off and these are honestly the *dry* mix; and HRTF is rendered as
 * equal-power panning, so direction survives and a real HRTF's spectral
 * colouring does not.
 */

import {
  SIM_DT,
  createEstablishedFire,
  createFire,
  createRitual,
  operateMachine,
  setRadioVolume,
  stepRitual,
  tendFire,
  toggleRadio,
  tuneToStation,
  type RadioProfileSpec,
  type RitualState,
  type WeatherKind,
  type WildlifeSpecies,
} from '@somemore/sim';

import { AMBIENCE_PRESETS } from '../../apps/web/src/audio/ambience.js';
import { AudioBridge } from '../../apps/web/src/audio/bridge.js';
import { NoiseBank } from '../../apps/web/src/audio/buffers.js';
import { BUS_NAMES, type BusName } from '../../apps/web/src/audio/buses.js';
import type { AudioEngine } from '../../apps/web/src/audio/engine.js';
import { renderOffline, renderRms, type RenderedAudio } from '../../apps/web/src/audio/offline.js';
import { createFakeAudioContext, type FakeAudioContext } from '../../apps/web/src/audio/testing.js';
import {
  createCameraMotion,
  stepCameraMotion,
  type CameraMotion,
} from '../../apps/web/src/scene/cameraMotion.js';

/**
 * 24 kHz, not 48.
 *
 * The offline renderer is a per-sample simulator in JavaScript, and thirty
 * seconds of a full graph at 48 kHz takes minutes. Halving the rate halves the
 * work and costs only the octave above 12 kHz, which carries none of the
 * questions being asked — every claim here is about 20 Hz to 8 kHz. Scenes that
 * genuinely need the top octave say so.
 */
const RATE = 24000;

export interface Scene {
  readonly id: string;
  readonly label: string;
  /** What this scene is supposed to answer. Carried through to the report. */
  readonly question: string;
  readonly seconds: number;
  /** Simulated seconds to run before the render starts, so beds have settled. */
  readonly warmupSeconds: number;
  readonly build: (rig: Rig) => void;
  /** Called every simulation frame during the render, after `stepRitual`. */
  readonly drive?: (rig: Rig, elapsed: number) => void;
}

export interface Rig {
  readonly ctx: FakeAudioContext;
  readonly bridge: AudioBridge;
  readonly engine: AudioEngine;
  ritual: RitualState;
}

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
    id: 'barred-owl',
    label: 'an owl',
    shyness: 0.6,
    curiosity: 0.4,
    window: ['early-night', 'deep-night', 'pre-dawn'],
    attractedBy: ['stillness', 'quiet'],
    repelledBy: ['footsteps'],
    canPersist: true,
    investigatesObjects: false,
    traces: ['a pellet under the pine'],
    note: 'the one you hear before you see',
  },
];

function world(seed = 'pine-hollow/soundscape'): RitualState {
  return createRitual({
    campsiteSeed: seed,
    environmentId: 'pine-hollow',
    now: 1_700_000_000_000,
    world: { radio: DIAL, wildlife: ROSTER },
  });
}

/**
 * Force the weather to a named kind and hold it there.
 *
 * `stepWeather` evolves the state on its own clock and would drift off a
 * chosen kind mid-render, so each scene re-asserts its weather every frame.
 * The fields written are exactly the ones `bridge.update` reads, so this is
 * indistinguishable from the simulation having produced that weather itself.
 */
export interface WeatherHold {
  kind: WeatherKind;
  precipitation: number;
  windSpeed: number;
  temperatureC: number;
  humidity: number;
  fog: number;
}

export function holdWeather(ritual: RitualState, hold: WeatherHold): void {
  const weather = ritual.weather;
  weather.kind = hold.kind;
  weather.nextKind = hold.kind;
  weather.transition = 0;
  weather.precipitation = hold.precipitation;
  weather.windSpeed = hold.windSpeed;
  weather.temperatureC = hold.temperatureC;
  weather.humidity = hold.humidity;
  weather.fog = hold.fog;
}

/**
 * The nine-plus weather kinds, at the intensity each one means.
 *
 * Taken from what `stepWeather` actually produces for each kind rather than
 * invented here, so "a storm" is the storm the simulation makes.
 */
export const WEATHER_HOLDS: Readonly<Record<string, WeatherHold>> = Object.freeze({
  clear: { kind: 'clear', precipitation: 0, windSpeed: 0.8, temperatureC: 11, humidity: 0.45, fog: 0 },
  'high-cloud': { kind: 'high-cloud', precipitation: 0, windSpeed: 1.4, temperatureC: 12, humidity: 0.55, fog: 0 },
  overcast: { kind: 'overcast', precipitation: 0, windSpeed: 1.8, temperatureC: 12, humidity: 0.7, fog: 0.05 },
  'light-rain': { kind: 'light-rain', precipitation: 0.3, windSpeed: 2.2, temperatureC: 10, humidity: 0.9, fog: 0.1 },
  rain: { kind: 'rain', precipitation: 0.7, windSpeed: 3.2, temperatureC: 9, humidity: 0.97, fog: 0.15 },
  storm: { kind: 'storm', precipitation: 1, windSpeed: 5.8, temperatureC: 8, humidity: 1, fog: 0.2 },
  fog: { kind: 'fog', precipitation: 0.02, windSpeed: 0.4, temperatureC: 7, humidity: 0.99, fog: 0.9 },
  snow: { kind: 'snow', precipitation: 0.5, windSpeed: 1.2, temperatureC: -3, humidity: 0.85, fog: 0.35 },
  'snow-squall': { kind: 'snow-squall', precipitation: 0.85, windSpeed: 4.6, temperatureC: -5, humidity: 0.9, fog: 0.6 },
  wind: { kind: 'wind', precipitation: 0, windSpeed: 5.2, temperatureC: 10, humidity: 0.5, fog: 0 },
});

/**
 * The three fire states, reached the way the game reaches them.
 *
 * An earlier draft of this file pinned `fire.flame` and `fire.combustion` every
 * frame to hold a state, and that quietly broke the most important measurement
 * in the report: a fire held at full combustion emits a crackle from the
 * thermal model on almost every step, `bridge.update` maps
 * `cracklesThisStep * 0.5` into the snap parameter, and the Poisson rate
 * saturated at ~37 events a second — five times what the same fire produces
 * when it is left alone. Every crackle overlapped the next and the transient
 * structure measured as zero. That was the rig's fault, not the engine's.
 *
 * So nothing is pinned. `catching` strikes a spark on fresh tinder,
 * `burning` uses the model's own `createEstablishedFire` and feeds it, and
 * `emberBed` burns one down and waits for `isEmberBed` to agree. Fuel is added
 * through `tendFire`, the same entry point the player's hands use.
 */
type FireStage = 'catching' | 'burning' | 'emberBed';

/**
 * Put the pit into the starting condition for a stage, then let the model run.
 *
 * Only `ritual.fire` is replaced, and only with a state one of the simulation's
 * own constructors produced. Nothing reaches into the thermal variables.
 */
function prepareFire(rig: Rig, stage: FireStage): void {
  const ritual = rig.ritual;
  if (stage === 'catching') {
    // A cold pit with fine dry fuel in it, and a light held to it. This is the
    // sequence the game requires: find dry fuel, lay it, strike.
    ritual.fire = createFire();
    tendFire(ritual, { type: 'add-log', woodId: 'pine', grade: 'tinder', moisture: 0.02 });
    tendFire(ritual, { type: 'add-log', woodId: 'pine', grade: 'kindling', moisture: 0.03 });
    tendFire(ritual, { type: 'add-log', woodId: 'pine', grade: 'kindling', moisture: 0.04 });
    /*
     * Strike until it takes, stepping the simulation between attempts.
     *
     * `strikeSpark` is a coin weighted by how dry the tinder is, and on this
     * seed the first one missed — which produced a "fire: catching" render of
     * a pit that never lit, and very nearly a report claiming that a catching
     * fire makes no sound.
     *
     * The step between attempts is load-bearing, not politeness. `ritual`'s
     * RNG streams are re-seeded per tick from `(seed, name, tick)`, so every
     * strike inside one tick draws the *same* number: forty strikes on one
     * frame fail forty times, identically. Across ticks the seed moves and the
     * coin is a coin again — which is also what a person does, since striking
     * again takes a moment.
     */
    for (let attempt = 0; attempt < 60 && ritual.fire.emberMass <= 0; attempt += 1) {
      tendFire(ritual, { type: 'strike' });
      stepRitual(ritual, SIM_DT);
    }
    if (ritual.fire.emberMass <= 0) throw new Error('the fire never caught; this scene would measure nothing');
    return;
  }
  ritual.fire = createEstablishedFire();
}

/**
 * Feed a burning fire so it stays burning for the length of the render.
 *
 * `createEstablishedFire` is deliberately sized to fall to coals in two or
 * three minutes, which is shorter than a warm-up plus a thirty-second render.
 * A log every twelve seconds is what a person tending a fire actually does and
 * it keeps the state under measurement the state named on the tin.
 */
function feed(rig: Rig, elapsed: number): void {
  if (elapsed < 0 || Math.floor(elapsed / 12) === Math.floor((elapsed - SIM_DT) / 12)) return;
  tendFire(rig.ritual, { type: 'add-log', woodId: 'oak', moisture: 0.05 });
}

async function makeRig(options: { profile?: keyof typeof AMBIENCE_PRESETS } = {}): Promise<Rig> {
  const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
  const bridge = new AudioBridge({
    contextFactory: () => ctx as unknown as AudioContext,
    pumpIntervalMs: 0,
    // The offline renderer models HRTF as equal-power panning; asking for it
    // explicitly makes that a stated choice rather than a silent fallback.
    spatialQuality: 'equalpower',
    // `ConvolverNode` renders silence offline, so the wet return would only
    // remove level without adding a tail. Every measurement is the dry mix.
    reverb: { wet: 0 },
    ...(options.profile ? { ambienceProfile: AMBIENCE_PRESETS[options.profile] } : {}),
  });
  const ok = await bridge.unlock();
  if (!ok) throw new Error('the engine did not start');
  const engine = bridge.engine;
  if (!engine) throw new Error('the engine did not build a graph');
  return { ctx, bridge, engine, ritual: world() };
}

export interface RenderedScene {
  readonly scene: Scene;
  readonly audio: RenderedAudio;
  /** Simulation frames run during the render, for the scheduling budget. */
  readonly frames: number;
  /** Wall-clock milliseconds spent inside `bridge.update` + `engine.pump`. */
  readonly schedulingMs: number;
  /** Total crackle/chirp/call events the layers scheduled during the render. */
  readonly eventsScheduled: number;
  /** RMS on each submix bus, rendered separately. See `busBreakdown`. */
  readonly buses: Readonly<Record<BusName, number>> | null;
}

/**
 * How loud each bus actually is, rendered one at a time.
 *
 * The sharpest instrument in this file for the question the brief cares most
 * about: a sound that is synthesised and never reaches the output bus looks
 * exactly like one nobody wrote, and rendering a bus in isolation is how you
 * tell the difference. A bus at exact digital silence during gameplay that is
 * supposed to be carrying something is a wiring gap, full stop.
 *
 * Rendered over `BUS_SECONDS` rather than the scene's full length: silence is
 * silence at any duration and the continuous levels have settled long before
 * this window opens, so the extra six renders cost a fraction of the scene
 * instead of multiplying it by seven.
 */
const BUS_SECONDS = 8;

function busBreakdown(rig: Rig, startTime: number, seconds: number): Record<BusName, number> {
  const out = {} as Record<BusName, number>;
  const window = Math.min(seconds, BUS_SECONDS);
  for (const bus of BUS_NAMES) {
    const node = rig.engine.busInput(bus);
    out[bus] = node ? renderRms(renderOffline(rig.ctx as never, window, { startTime, target: node as never })) : 0;
  }
  return out;
}

/**
 * Run one scene and render it.
 *
 * The simulation and the audio clock advance together at `SIM_DT`, which is
 * what `App.tsx` does; the render then reads the graph the run built. Time
 * spent in `bridge.update` and `engine.pump` is measured here because
 * ARCHITECTURE §10 gives audio scheduling 0.5 ms of main thread per frame and
 * nothing had ever checked it.
 */
export async function renderScene(scene: Scene): Promise<RenderedScene> {
  const rig = await makeRig();
  scene.build(rig);

  const warmupFrames = Math.round(scene.warmupSeconds / SIM_DT);
  for (let i = 0; i < warmupFrames; i += 1) {
    stepRitual(rig.ritual, SIM_DT);
    scene.drive?.(rig, -scene.warmupSeconds + i * SIM_DT);
    rig.bridge.update(rig.ritual);
    rig.engine.pump(rig.ctx.currentTime);
    rig.ctx.advance(SIM_DT);
  }

  // The render starts from the clock the warm-up left behind, so the beds are
  // already at their steady state rather than fading up inside the picture.
  const startTime = rig.ctx.currentTime;
  const frames = Math.round(scene.seconds / SIM_DT);
  let schedulingMs = 0;
  let eventsScheduled = 0;
  for (let i = 0; i < frames; i += 1) {
    stepRitual(rig.ritual, SIM_DT);
    scene.drive?.(rig, i * SIM_DT);
    const before = performance.now();
    rig.bridge.update(rig.ritual);
    eventsScheduled += rig.engine.pump(rig.ctx.currentTime);
    schedulingMs += performance.now() - before;
    rig.ctx.advance(SIM_DT);
  }

  const audio = renderOffline(rig.ctx as never, scene.seconds, { startTime });
  const buses = busBreakdown(rig, startTime, scene.seconds);
  await rig.engine.close();
  return { scene, audio, frames, schedulingMs, eventsScheduled, buses };
}

/* -------------------------------------------------------------------------- */
/* The scenes                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Warm-ups are per stage, not per scene, because the model decides how long
 * each state takes to arrive at. `catching` is measured while it is still
 * catching, which is a matter of seconds; an ember bed takes minutes.
 */
const FIRE_WARMUP: Readonly<Record<FireStage, number>> = Object.freeze({
  catching: 2,
  burning: 8,
  emberBed: 220,
});

/**
 * `catching` is shorter because the state is shorter.
 *
 * Struck tinder and kindling reaches full flame about five seconds in and has
 * burned itself out by twenty-five, with nothing put on it. Rendering thirty
 * seconds of that would spend the last third measuring a fire that has gone
 * out and call the average "catching".
 */
const FIRE_SECONDS: Readonly<Record<FireStage, number>> = Object.freeze({
  catching: 18,
  burning: 30,
  emberBed: 30,
});

function fireScene(id: string, label: string, question: string, stage: FireStage): Scene {
  return {
    id,
    label,
    question,
    seconds: FIRE_SECONDS[stage],
    warmupSeconds: FIRE_WARMUP[stage],
    build: (rig) => {
      prepareFire(rig, stage);
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      // An ember bed is only an ember bed if nothing is put on it; the other
      // two states need fuel or they become one.
      if (stage !== 'emberBed') feed(rig, elapsed);
    },
  };
}

function weatherScene(kind: keyof typeof WEATHER_HOLDS): Scene {
  const hold = WEATHER_HOLDS[kind]!;
  return {
    id: `weather-${kind}`,
    label: `Weather: ${kind}`,
    question: 'Is this weather kind a distinct sound, or the same bed at a different wind value?',
    seconds: 20,
    warmupSeconds: 8,
    build: (rig) => {
      // A burning fire under every weather scene, because that is the only way
      // a player ever hears the weather: there is always a fire. Identical in
      // every one of them, so any difference between two of these renders is
      // the weather and nothing else.
      prepareFire(rig, 'burning');
      holdWeather(rig.ritual, hold);
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, hold);
      feed(rig, elapsed);
    },
  };
}

export const SCENES: readonly Scene[] = [
  fireScene(
    'fire-catching',
    'Fire: catching',
    'Does a fire that has just taken have its own sound, or is it a quiet version of a burning one?',
    'catching',
  ),
  fireScene(
    'fire-burning',
    'Fire: burning',
    'The single most important sound in the game. Does the crackle have discrete transient structure, and is there anything below 120 Hz?',
    'burning',
  ),
  fireScene(
    'fire-ember-bed',
    'Fire: ember bed',
    'Do embers read as their own material — sparser, brighter, quieter — or as the same bed turned down?',
    'emberBed',
  ),

  ...(['clear', 'high-cloud', 'overcast', 'light-rain', 'rain', 'storm', 'fog', 'snow', 'snow-squall', 'wind'] as const).map(
    weatherScene,
  ),

  {
    id: 'clear-night-wildlife',
    label: 'Clear night with wildlife',
    question: 'On a still, clear night with animals present, is there anything to hear beyond the fire?',
    seconds: 30,
    // Long, because stillness is the mechanic: nothing comes out for a player
    // who has just arrived, and eleven simulated minutes of sitting is what
    // the world suite needs before anything reliably turns up.
    warmupSeconds: 600,
    build: (rig) => {
      prepareFire(rig, 'emberBed');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      rig.ritual.presence.speed = 0;
      rig.ritual.presence.seated = true;
    },
    drive: (rig) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      rig.ritual.presence.speed = 0;
      rig.ritual.presence.seated = true;
    },
  },

  {
    id: 'sm01-cycle',
    label: 'SM-01: a full cycle',
    question: 'Does the machine read as a sequence of distinct mechanical events, or as one continuous drone?',
    seconds: 45,
    warmupSeconds: 220,
    build: (rig) => {
      prepareFire(rig, 'emberBed');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
    },
    // The cycle is driven through `operateMachine`, the same entry point the
    // UI uses, so every event is one the simulation genuinely emitted.
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      const at = (t: number): boolean => elapsed >= t && elapsed < t + SIM_DT;
      if (at(0.5)) operateMachine(rig.ritual, { type: 'load' });
      if (at(1.5)) operateMachine(rig.ritual, { type: 'close-door' });
      if (at(6)) operateMachine(rig.ritual, { type: 'engage-latch' });
      if (at(7)) operateMachine(rig.ritual, { type: 'set-program', program: 'soft-set' });
      if (at(8)) operateMachine(rig.ritual, { type: 'confirm' });
      if (at(9)) operateMachine(rig.ritual, { type: 'pull-lever' });
      if (at(40)) operateMachine(rig.ritual, { type: 'release-latch' });
      if (at(42)) operateMachine(rig.ritual, { type: 'open-door' });
    },
  },

  {
    id: 'radio-tuned',
    label: 'Radio: tuned to a station',
    question: 'Locked onto a station: is there programme material, and does the receiver sit under the fire or over it?',
    seconds: 30,
    warmupSeconds: 8,
    build: (rig) => {
      prepareFire(rig, 'burning');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      toggleRadio(rig.ritual, true);
      tuneToStation(rig.ritual.radio, 'kdel');
      setRadioVolume(rig.ritual, 0.8);
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      feed(rig, elapsed);
    },
  },

  {
    id: 'radio-tuning',
    label: 'Radio: tuning across the band',
    question: 'Sweeping the dial: does the heterodyne whistle actually fall to zero beat, and does hiss trade against programme?',
    seconds: 30,
    warmupSeconds: 220,
    build: (rig) => {
      // An ember bed under this one, not a burning fire: the question is about
      // the receiver, and a roaring fire would sit on top of the whistle.
      prepareFire(rig, 'emberBed');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      toggleRadio(rig.ritual, true);
      setRadioVolume(rig.ritual, 0.85);
      rig.ritual.radio.dial = 90.6;
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      // A slow sweep from below KDEL up past WNUM, so both stations and the
      // gap between them are inside one render.
      rig.ritual.radio.dial = 90.6 + Math.max(0, elapsed) * 0.06;
    },
  },

  {
    id: 'footsteps-walking',
    label: 'Footsteps on the walk',
    question:
      'The player walks. `FoleyKit.footstep` exists and `cameraMotion` reports a footfall flag "so the audio layer can put a footstep exactly there". Does anything?',
    seconds: 15,
    warmupSeconds: 220,
    build: (rig) => {
      // Deliberately an ember bed and a clear, still night: if there is a
      // footstep in the output it has nothing to hide behind.
      prepareFire(rig, 'emberBed');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
    },
    /*
     * Walking, hard, for the whole render — and stepping the camera, because
     * the camera is what decides when a foot lands.
     *
     * `cameraMotion` reports a footfall on the frame a stride bottoms out, and
     * the whole point of putting the sound there is that the thud and the
     * head's dip are the same event. So the scene runs the same spring the
     * game runs and plays through the same bridge method `App.tsx` calls.
     *
     * Stated plainly because it matters: this **mirrors** the app's wiring, it
     * does not share it. If somebody removes `onFootfall` from `World.tsx`
     * this render will still contain footsteps and will still be wrong. What
     * it proves is that the sound exists, is audible over the bed, and lands
     * on the stride — not that the game is calling it.
     */
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      rig.ritual.presence.seated = false;
      rig.ritual.presence.speed = 1.4;
      const motion = (rig as unknown as { footMotion?: CameraMotion }).footMotion ??
        ((rig as unknown as { footMotion?: CameraMotion }).footMotion = createCameraMotion());
      const sway = stepCameraMotion(
        motion,
        { speed: 1.4, turnRate: 0, strafe: 0, settled: false, scale: 1 },
        SIM_DT,
      );
      if (sway.footfall) rig.bridge.playFootstep('pineNeedles', 1);
      void elapsed;
    },
  },

  {
    id: 'reduced-intensity',
    label: 'Accessibility: reduced audio intensity',
    question: 'Does the reduced-intensity flag measurably tame transients, or is it a boolean nobody reads?',
    seconds: 20,
    // Identical to `weather-clear` in every respect but the flag, so the two
    // renders differ by exactly the thing under test.
    warmupSeconds: 8,
    build: (rig) => {
      prepareFire(rig, 'burning');
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      rig.engine.setReducedAudioIntensity(true);
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['clear']!);
      feed(rig, elapsed);
    },
  },

  {
    id: 'everything-at-once',
    label: 'The whole mix',
    question: 'Storm, fire, radio and machine together: does the limiter hold, and does anything fight for the same octave?',
    seconds: 30,
    warmupSeconds: 8,
    build: (rig) => {
      prepareFire(rig, 'burning');
      holdWeather(rig.ritual, WEATHER_HOLDS['storm']!);
      toggleRadio(rig.ritual, true);
      tuneToStation(rig.ritual.radio, 'kdel');
      setRadioVolume(rig.ritual, 0.9);
    },
    drive: (rig, elapsed) => {
      holdWeather(rig.ritual, WEATHER_HOLDS['storm']!);
      feed(rig, elapsed);
      const at = (t: number): boolean => elapsed >= t && elapsed < t + SIM_DT;
      if (at(0.5)) operateMachine(rig.ritual, { type: 'load' });
      if (at(1.5)) operateMachine(rig.ritual, { type: 'close-door' });
      if (at(3)) operateMachine(rig.ritual, { type: 'engage-latch' });
      if (at(4)) operateMachine(rig.ritual, { type: 'set-program', program: 'soft-set' });
      if (at(5)) operateMachine(rig.ritual, { type: 'confirm' });
      if (at(6)) operateMachine(rig.ritual, { type: 'pull-lever' });
    },
  },
];

/**
 * The control.
 *
 * "Does the crackle have structure, or is it a noise band with an envelope on
 * it?" is only answerable against a reference, because every envelope
 * statistic that sounds damning — a peak four times the median, a handful of
 * onsets a second — is also what plain filtered noise produces. So this scene
 * builds exactly the noise band the fire's roar layer is: the engine's own
 * `NoiseBank` pink loop through a low-pass at the cutoff and Q that
 * `mapFireState` produces for a burning fire, at a gain that lands it near the
 * same RMS as `fire-burning`. No crackles, no other layers.
 *
 * Whatever `fire-burning` measures *above* this row is what the crackle stream
 * is actually contributing. If the two rows match, the crackle is decoration
 * that does not survive the mix.
 */
export async function renderNoiseControl(seconds = 30): Promise<RenderedScene> {
  const ctx = createFakeAudioContext({ sampleRate: RATE, state: 'running' });
  const bank = new NoiseBank(ctx as unknown as BaseAudioContext);

  const filter = ctx.createBiquadFilter();
  filter.type = 'lowpass';
  // The values `mapFireState` produces at intensity 0.86, measured, not guessed.
  filter.frequency.value = 932;
  filter.Q.value = 1.37;
  const gain = ctx.createGain();
  gain.gain.value = 0.54;
  filter.connect(gain as never);
  gain.connect(ctx.destination as never);

  const source = ctx.createBufferSource();
  // `NoiseBank` is typed against the DOM's `BaseAudioContext`, so it hands back
  // a DOM `AudioBuffer`; the fake graph wants its own. The object is the same
  // one either way — the bank builds it through `ctx.createBuffer`.
  source.buffer = bank.loop('pink') as never;
  source.loop = true;
  source.loopStart = 0;
  source.loopEnd = bank.loopEnd('pink');
  source.connect(filter as never);
  source.start(0);

  const audio = renderOffline(ctx as never, seconds, { startTime: 2 });
  return {
    scene: {
      id: 'control-pink-noise',
      label: 'Control: the roar layer alone',
      question:
        'The reference row. This is the fire bed with every crackle removed — whatever fire-burning measures above this is what the crackle stream contributes.',
      seconds,
      warmupSeconds: 0,
      build: () => {},
    },
    audio,
    frames: 0,
    schedulingMs: 0,
    eventsScheduled: 0,
    // No engine, so no buses: this graph is four nodes long by design.
    buses: null,
  };
}

/**
 * Determinism: the same seed must give the same samples.
 *
 * ADR-0001 forbids `Math.random` and wall-clock reads in `packages/sim`, and
 * the audio engine seeds its own RNG from the campsite so a place sounds the
 * same everywhere. Neither claim had ever been checked against the samples.
 */
export async function renderTwice(scene: Scene): Promise<[RenderedAudio, RenderedAudio]> {
  const first = await renderScene(scene);
  const second = await renderScene(scene);
  return [first.audio, second.audio];
}
