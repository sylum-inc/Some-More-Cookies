/**
 * The audio lab — renders the game's synthesised sounds offline, in a browser,
 * and measures them.
 *
 * Nobody has heard this audio engine (IMPLEMENTATION_PLAN, shortfall S7). This
 * is the next best thing: a real `OfflineAudioContext` renders the *real*
 * synthesis graph — the same `MachineKit`, `FireBed` and `FoleyKit` the game
 * constructs, imported unmodified from `apps/web/src/audio` — to actual PCM,
 * and `analysis.js` measures what came out.
 *
 * Why offline rendering and not the `FakeAudioContext` in `audio/testing.ts`:
 * the fake records automation events, which proves the *scheduling* is right.
 * It cannot prove the result is audible, that the filters resonate where they
 * are meant to, that nothing clips, or that the latch is low-frequency
 * dominant. Only samples can. The unit suite already covers the scheduling;
 * this covers the sound.
 *
 * This file is bundled by `tools/audio/analyse.mjs` (Vite, IIFE) and injected
 * into a blank page. It writes one global, `window.__audioLab`.
 */

import {
  FireBed,
  FoleyKit,
  MachineKit,
  MixerState,
  NoiseBank,
  createRng,
  generateImpulseResponse,
  SPACE_PRESETS,
} from '../../apps/web/src/audio/index.js';

import { analyse } from './analysis.js';

/** Everything a layer needs, built against an offline context. */
function makeDeps(ctx: BaseAudioContext, destination: AudioNode, seed: number) {
  return {
    ctx,
    destination,
    bank: new NoiseBank(ctx, { seed }),
    rng: createRng(seed),
    mixer: new MixerState(),
  };
}

export interface RenderRequest {
  id: string;
  seconds: number;
  sampleRate?: number;
  seed?: number;
  /** Which layer to build and what to do with it. */
  script: string;
  /** Extra argument for scripts that take one (relay index, fan speed, ...). */
  arg?: number | string;
}

/**
 * The scripts.
 *
 * Each one builds the layer the game builds, triggers the sound the way the
 * game triggers it, and returns. Scheduling starts at 0.05 s so the analyser
 * can see the silence before the onset (and so `Synth.at`'s 4 ms floor is
 * never the thing that decides the timing).
 */
const SCRIPTS: Record<string, (ctx: BaseAudioContext, out: AudioNode, seed: number, arg: number | string | undefined, seconds: number) => void> = {
  /* ---------------------------------------------------------- SM-01 kit */
  'latch-clunk': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).latchClunk(0.05),

  'switch-detent': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).switchDetent(0.05),

  'relay-click': (ctx, out, seed, arg) =>
    new MachineKit(makeDeps(ctx, out, seed)).relayClick(Number(arg ?? 0), 0.05),

  'compressor-start': (ctx, out, seed) => {
    const kit = new MachineKit(makeDeps(ctx, out, seed));
    kit.compressorStart(0.05);
  },

  'compressor-stop': (ctx, out, seed) => {
    const kit = new MachineKit(makeDeps(ctx, out, seed));
    kit.compressorStart(0.0);
    kit.compressorStop(1.2);
  },

  'fan-ramp': (ctx, out, seed, arg) => {
    const kit = new MachineKit(makeDeps(ctx, out, seed));
    kit.fanRamp(Number(arg ?? 1), 1.5);
  },

  'refrigerant-flow': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).refrigerantFlow(0.05, 2.2),

  'frost-crackle': (ctx, out, seed, arg, seconds) => {
    const kit = new MachineKit(makeDeps(ctx, out, seed));
    kit.frostCrackle(Number(arg ?? 0.85));
    // `frostCrackle` only sets a Poisson rate; `pump` is what schedules the
    // ticks into the look-ahead window, exactly as the game's timer does.
    for (let t = 0; t < seconds; t += 0.1) kit.pump(t);
  },

  'completion-tone': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).completionTone(0.05),

  'beep-confirm': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).beep('confirm', 0.05),
  'beep-deny': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).beep('deny', 0.05),

  'door-open': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).doorOpen(0.05),

  'vapor-release': (ctx, out, seed) => new MachineKit(makeDeps(ctx, out, seed)).vaporRelease(0.05, 1),

  'crt-whine': (ctx, out, seed) => {
    const kit = new MachineKit(makeDeps(ctx, out, seed));
    kit.crtWhine(true);
  },

  /* -------------------------------------------------------------- fire */
  'fire-bed': (ctx, out, seed, arg, seconds) => {
    const bed = new FireBed(makeDeps(ctx, out, seed));
    bed.start();
    bed.setState({ intensity: 0.75, emberHeat: 0.5, fuelLoad: 0.7, windSpeed: 0.25, crackleRate: 0.6 });
    for (let t = 0; t < seconds; t += 0.1) bed.pump(t);
  },

  'fire-embers': (ctx, out, seed, arg, seconds) => {
    const bed = new FireBed(makeDeps(ctx, out, seed));
    bed.start();
    // The bed a marshmallow is actually roasted over: flames down, coals hot.
    bed.setState({ intensity: 0.08, emberHeat: 0.9, fuelLoad: 0.35, windSpeed: 0.2, crackleRate: 0.25 });
    for (let t = 0; t < seconds; t += 0.1) bed.pump(t);
  },

  'fire-dead': (ctx, out, seed, arg, seconds) => {
    const bed = new FireBed(makeDeps(ctx, out, seed));
    bed.start();
    // A dead fire must produce exactly nothing — silence is information too.
    bed.setState({ intensity: 0, emberHeat: 0, fuelLoad: 0, windSpeed: 0, crackleRate: 0 });
    for (let t = 0; t < seconds; t += 0.1) bed.pump(t);
  },

  /* ------------------------------------------------------------- foley */
  sizzle: (ctx, out, seed, arg, seconds) => {
    const kit = new FoleyKit(makeDeps(ctx, out, seed));
    kit.startSizzle();
    kit.setSizzleState({ heat: 0.8, moisture: 0.7, browning: 0.4, scorch: 0.1 });
    for (let t = 0; t < seconds; t += 0.1) kit.pump(t);
  },

  'graham-snap': (ctx, out, seed) => new FoleyKit(makeDeps(ctx, out, seed)).grahamSnap(0.05),

  'chocolate-fracture': (ctx, out, seed) => new FoleyKit(makeDeps(ctx, out, seed)).chocolateFracture(0.05),

  'ignition-whoosh': (ctx, out, seed) => new FoleyKit(makeDeps(ctx, out, seed)).ignitionWhoosh(1, 0.05),

  /* ----------------------------------------------------------- reverb */
  'impulse-clearing': (ctx, out, seed) => {
    // Not a game sound: the impulse response the clearing's reverb convolves
    // with. Rendered by playing it through the graph so it is measured the
    // same way as everything else.
    const generated = generateImpulseResponse(SPACE_PRESETS.clearing, ctx.sampleRate, seed);
    const buffer = ctx.createBuffer(generated.channels.length, generated.channels[0]!.length, ctx.sampleRate);
    for (let c = 0; c < generated.channels.length; c += 1) buffer.getChannelData(c).set(generated.channels[c]!);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(out);
    source.start(0.05);
  },
};

export async function render(request: RenderRequest) {
  const sampleRate = request.sampleRate ?? 48000;
  const seed = request.seed ?? 0x50f7;
  const frames = Math.max(128, Math.round(request.seconds * sampleRate));
  const ctx = new OfflineAudioContext(2, frames, sampleRate);

  // A pass-through gain in place of the engine's bus, so what is measured is
  // the layer's own output with no master gain, limiter or reverb send in the
  // way. Those are the engine's business and have their own tests.
  const out = ctx.createGain();
  out.gain.value = 1;
  out.connect(ctx.destination);

  const script = SCRIPTS[request.script];
  if (!script) throw new Error(`unknown audio script: ${request.script}`);
  script(ctx, out, seed, request.arg, request.seconds);

  const buffer = await ctx.startRendering();
  const channels: Float32Array[] = [];
  for (let c = 0; c < buffer.numberOfChannels; c += 1) channels.push(buffer.getChannelData(c));
  return { id: request.id, metrics: analyse(channels, sampleRate) };
}

declare global {
  interface Window {
    __audioLab?: {
      render: typeof render;
      scripts: string[];
    };
  }
}

window.__audioLab = { render, scripts: Object.keys(SCRIPTS) };
