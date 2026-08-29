/**
 * The rendering half of the headless harness.
 *
 * `testing.ts` records *what was scheduled*. That proves the timing of a latch
 * clunk and it proves a bus is wired to the master, but it cannot answer any of
 * the questions this engine actually has to get right: is the hiss louder than
 * the station, does the whistle really fall to zero beat as you tune in, does
 * anything click when the radio is switched off, is a call on the correct side
 * of the head, does the whole mix stay inside the limiter's headroom. Only
 * samples answer those, so this module renders the recorded graph to PCM.
 *
 * It is a WebAudio *simulator*, not a re-implementation: it reads the same
 * `FakeAudioContext` the engine was built against and evaluates it offline. It
 * is deliberately not exported from `index.ts` — nothing here ships.
 *
 * ```ts
 * const ctx = createFakeAudioContext({ sampleRate: 24000 });
 * const kit = new RadioKit(depsFrom(ctx), {});
 * kit.setPower(true);
 * const audio = renderOffline(ctx, 2);   // 2 seconds of stereo Float32
 * ```
 *
 * What it models faithfully
 *   - `AudioParam` automation: `setValueAtTime`, linear and exponential ramps,
 *     `setTargetAtTime` (evaluated continuously from wherever the param
 *     actually was, which is the whole reason the engine prefers it) and
 *     `cancelScheduledValues`. Gain and oscillator frequency are evaluated per
 *     sample, so a ramp is a real ramp and a click is a real click.
 *   - Signal-rate modulation of params: an LFO connected to a `gain` param, or
 *     an FM operator connected to a `frequency` param, is summed in exactly as
 *     WebAudio sums it.
 *   - `BiquadFilterNode` as the RBJ cookbook filters WebAudio specifies,
 *     `GainNode`, `OscillatorNode`, `AudioBufferSourceNode` (offset, duration,
 *     looping, playback rate), `StereoPannerNode`, `DelayNode`, and
 *     `PannerNode` azimuth + distance gain following the spec's algorithm.
 *
 * What it approximates, and why that is stated rather than hidden
 *   - **Oscillators are naive**, not band-limited: a square or sawtooth aliases
 *     here where a browser's would not. Every level, envelope and panning
 *     measurement is unaffected; a spectral assertion above the fundamental of
 *     a non-sine oscillator would not be trustworthy.
 *   - **`ConvolverNode` renders silence.** A real IR convolution is far too
 *     expensive for a unit test. Anything measured through this renderer is
 *     therefore the *dry* mix; tests that care about total level either build
 *     the engine with `reverb: { wet: 0 }` or say plainly that they measure the
 *     dry path.
 *   - **HRTF is rendered as equal-power panning.** Direction is preserved, the
 *     spectral colouring of a real HRTF is not.
 *   - **Filter coefficients are recomputed per block**, not per sample, so a
 *     very fast filter sweep is quantised to the block grid (2.7 ms at 48 kHz).
 *   - `DynamicsCompressorNode` is a plain feed-forward compressor with a soft
 *     knee and no look-ahead delay.
 */

import { clamp } from './math.js';
import {
  FakeAudioContext,
  FakeAudioNode,
  FakeAudioParam,
  FakeBiquadFilterNode,
  FakeBufferSourceNode,
  FakeDelayNode,
  FakeDynamicsCompressorNode,
  FakeGainNode,
  FakeOscillatorNode,
  FakePannerNode,
  FakeStereoPannerNode,
  type ParamEvent,
} from './testing.js';

/* -------------------------------------------------------------------------- */
/* Parameter automation                                                        */
/* -------------------------------------------------------------------------- */

type CurveKind = 'const' | 'target';

interface ParamCursor {
  /** Index of the next unfolded event. */
  index: number;
  kind: CurveKind;
  /** Time the current segment began. */
  t0: number;
  /** Value at `t0`. */
  v0: number;
  target: number;
  timeConstant: number;
  timeline: readonly ParamEvent[];
}

/**
 * Flatten a param's recorded events into the timeline WebAudio would actually
 * play back.
 *
 * `cancelScheduledValues(t)` drops every event at or after `t` that had already
 * been scheduled when it was called — which is exactly what replaying the
 * recording in insertion order and splicing on each cancel produces.
 */
function buildTimeline(events: readonly ParamEvent[]): ParamEvent[] {
  const timeline: ParamEvent[] = [];
  for (const event of events) {
    if (event.type === 'cancel') {
      for (let i = timeline.length - 1; i >= 0; i -= 1) {
        const candidate = timeline[i];
        if (candidate && candidate.time >= event.time) timeline.splice(i, 1);
      }
      continue;
    }
    timeline.push(event);
  }
  // Stable sort: two events at the same instant keep their scheduling order.
  return timeline
    .map((event, order) => ({ event, order }))
    .sort((a, b) => a.event.time - b.event.time || a.order - b.order)
    .map((entry) => entry.event);
}

function curveValue(cursor: ParamCursor, time: number): number {
  if (cursor.kind === 'target') {
    const tc = Math.max(cursor.timeConstant, 1e-9);
    return cursor.target + (cursor.v0 - cursor.target) * Math.exp(-(time - cursor.t0) / tc);
  }
  return cursor.v0;
}

/**
 * Value of a param at `time`.
 *
 * The cursor only ever moves forward, so a whole render costs one pass over the
 * event list per param rather than one pass per sample.
 */
function paramValueAt(cursor: ParamCursor, time: number): number {
  const timeline = cursor.timeline;
  for (;;) {
    const next = timeline[cursor.index];
    if (!next) return curveValue(cursor, time);

    if (time < next.time) {
      // Between segments. A pending ramp is interpolated toward its endpoint;
      // anything else holds (or keeps decaying toward a setTarget's target).
      if (next.type === 'linearRamp' || next.type === 'exponentialRamp') {
        if (!Number.isFinite(cursor.t0) || next.time <= cursor.t0) return next.value;
        const progress = (time - cursor.t0) / (next.time - cursor.t0);
        if (next.type === 'linearRamp') return cursor.v0 + (next.value - cursor.v0) * progress;
        // An exponential ramp through or from zero is illegal in WebAudio; the
        // engine never schedules one, and a guard beats a NaN in a buffer.
        if (cursor.v0 <= 0 || next.value <= 0) return next.value;
        return cursor.v0 * Math.pow(next.value / cursor.v0, progress);
      }
      return curveValue(cursor, time);
    }

    // Fold the event in: `next` has now started.
    const edge = curveValue(cursor, next.time);
    cursor.index += 1;
    if (next.type === 'setTarget') {
      cursor.kind = 'target';
      cursor.t0 = next.time;
      cursor.v0 = edge;
      cursor.target = next.value;
      cursor.timeConstant = next.timeConstant ?? 1e-3;
    } else {
      cursor.kind = 'const';
      cursor.t0 = next.time;
      cursor.v0 = next.value;
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Biquad                                                                      */
/* -------------------------------------------------------------------------- */

interface BiquadState {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
  x1: [number, number];
  x2: [number, number];
  y1: [number, number];
  y2: [number, number];
}

function createBiquadState(): BiquadState {
  return { b0: 1, b1: 0, b2: 0, a1: 0, a2: 0, x1: [0, 0], x2: [0, 0], y1: [0, 0], y2: [0, 0] };
}

/** RBJ cookbook coefficients, normalised by a0, matching the WebAudio spec. */
function updateBiquad(
  state: BiquadState,
  type: BiquadFilterType,
  frequencyHz: number,
  q: number,
  dbGain: number,
  sampleRate: number,
): void {
  const nyquist = sampleRate * 0.5;
  const f = clamp(frequencyHz, 1e-4, nyquist * 0.999);
  const w0 = (2 * Math.PI * f) / sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const qq = Math.max(q, 1e-4);
  const alpha = sin / (2 * qq);
  const a = Math.pow(10, dbGain / 40);

  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;

  switch (type) {
    case 'highpass':
      b0 = (1 + cos) / 2;
      b1 = -(1 + cos);
      b2 = (1 + cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'bandpass':
      // Constant 0 dB peak gain, which is the variant WebAudio uses.
      b0 = alpha;
      b1 = 0;
      b2 = -alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'notch':
      b0 = 1;
      b1 = -2 * cos;
      b2 = 1;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'allpass':
      b0 = 1 - alpha;
      b1 = -2 * cos;
      b2 = 1 + alpha;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
    case 'peaking':
      b0 = 1 + alpha * a;
      b1 = -2 * cos;
      b2 = 1 - alpha * a;
      a0 = 1 + alpha / a;
      a1 = -2 * cos;
      a2 = 1 - alpha / a;
      break;
    case 'lowshelf': {
      const sqrtA = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 - (a - 1) * cos + sqrtA);
      b1 = 2 * a * (a - 1 - (a + 1) * cos);
      b2 = a * (a + 1 - (a - 1) * cos - sqrtA);
      a0 = a + 1 + (a - 1) * cos + sqrtA;
      a1 = -2 * (a - 1 + (a + 1) * cos);
      a2 = a + 1 + (a - 1) * cos - sqrtA;
      break;
    }
    case 'highshelf': {
      const sqrtA = 2 * Math.sqrt(a) * alpha;
      b0 = a * (a + 1 + (a - 1) * cos + sqrtA);
      b1 = -2 * a * (a - 1 + (a + 1) * cos);
      b2 = a * (a + 1 + (a - 1) * cos - sqrtA);
      a0 = a + 1 - (a - 1) * cos + sqrtA;
      a1 = 2 * (a - 1 - (a + 1) * cos);
      a2 = a + 1 - (a - 1) * cos - sqrtA;
      break;
    }
    case 'lowpass':
    default:
      b0 = (1 - cos) / 2;
      b1 = 1 - cos;
      b2 = (1 - cos) / 2;
      a0 = 1 + alpha;
      a1 = -2 * cos;
      a2 = 1 - alpha;
      break;
  }

  state.b0 = b0 / a0;
  state.b1 = b1 / a0;
  state.b2 = b2 / a0;
  state.a1 = a1 / a0;
  state.a2 = a2 / a0;
}

/* -------------------------------------------------------------------------- */
/* Node state                                                                  */
/* -------------------------------------------------------------------------- */

interface NodeState {
  /** Oscillator phase in cycles, 0..1. */
  phase: number;
  /** Buffer-source read head, in source frames. */
  position: number;
  biquad: BiquadState | null;
  /** Delay line, one per channel. */
  delay: Float32Array[] | null;
  delayWrite: number;
  /** Compressor gain reduction in dB, smoothed. */
  reductionDb: number;
}

function createNodeState(): NodeState {
  return { phase: 0, position: 0, biquad: null, delay: null, delayWrite: 0, reductionDb: 0 };
}

function waveform(type: OscillatorType, phase: number): number {
  const p = phase - Math.floor(phase);
  switch (type) {
    case 'square':
      return p < 0.5 ? 1 : -1;
    case 'sawtooth':
      return 2 * p - 1;
    case 'triangle':
      // Starts at 0 and rises, as WebAudio's does.
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 'sine':
    default:
      return Math.sin(2 * Math.PI * p);
  }
}

/* -------------------------------------------------------------------------- */
/* Renderer                                                                    */
/* -------------------------------------------------------------------------- */

export interface OfflineRenderOptions {
  /** Audio-clock time to start from. Defaults to 0 — the clock the graph was built on. */
  startTime?: number;
  /** Render this node's output instead of the context destination. */
  target?: FakeAudioNode;
  /** Samples per processing block. Filter coefficients update at this rate. */
  blockSize?: number;
}

export interface RenderedAudio {
  readonly sampleRate: number;
  /** Left and right, always two channels. */
  readonly channels: readonly [Float32Array, Float32Array];
  readonly durationSeconds: number;
}

/**
 * Render `seconds` of the graph hanging off `ctx.destination` (or off
 * `options.target`) to stereo PCM.
 *
 * The graph is read, never modified: a context can be rendered more than once
 * and gives the same samples, which is what makes the determinism tests
 * meaningful.
 */
export function renderOffline(
  ctx: FakeAudioContext,
  seconds: number,
  options: OfflineRenderOptions = {},
): RenderedAudio {
  const sampleRate = ctx.sampleRate;
  const blockSize = Math.max(8, Math.round(options.blockSize ?? 128));
  const startTime = options.startTime ?? 0;
  const frames = Math.max(0, Math.round(Math.max(seconds, 0) * sampleRate));
  const target = options.target ?? ctx.destination;

  const left = new Float32Array(frames);
  const right = new Float32Array(frames);

  // --- graph topology ------------------------------------------------------
  const inputs = new Map<FakeAudioNode, FakeAudioNode[]>();
  const paramInputs = new Map<FakeAudioParam, FakeAudioNode[]>();
  const reachable: FakeAudioNode[] = [ctx.destination, ...ctx.nodes];
  for (const node of reachable) {
    for (const output of node.outputs) {
      const list = inputs.get(output);
      if (list) list.push(node);
      else inputs.set(output, [node]);
    }
    for (const param of node.paramOutputs) {
      const list = paramInputs.get(param);
      if (list) list.push(node);
      else paramInputs.set(param, [node]);
    }
  }

  const states = new Map<FakeAudioNode, NodeState>();
  const cursors = new Map<FakeAudioParam, ParamCursor>();
  const buffers = new Map<FakeAudioNode, [Float32Array, Float32Array]>();
  const computed = new Set<FakeAudioNode>();
  const visiting = new Set<FakeAudioNode>();
  // Modulation can nest (an LFO into a gain whose source is itself modulated),
  // so scratch buffers come off a depth-indexed stack rather than one shared
  // array that a nested call would overwrite under the caller.
  const scratchStack: Float32Array[] = [];
  let scratchDepth = 0;
  const takeScratch = (): Float32Array => {
    let buffer = scratchStack[scratchDepth];
    if (!buffer) {
      buffer = new Float32Array(blockSize);
      scratchStack[scratchDepth] = buffer;
    }
    scratchDepth += 1;
    return buffer;
  };
  const releaseScratch = (): void => {
    scratchDepth = Math.max(0, scratchDepth - 1);
  };

  const stateOf = (node: FakeAudioNode): NodeState => {
    let state = states.get(node);
    if (!state) {
      state = createNodeState();
      states.set(node, state);
    }
    return state;
  };

  const cursorOf = (param: FakeAudioParam): ParamCursor => {
    let cursor = cursors.get(param);
    if (!cursor) {
      cursor = {
        index: 0,
        kind: 'const',
        t0: Number.NEGATIVE_INFINITY,
        v0: param.assignedValue,
        target: 0,
        timeConstant: 1e-3,
        timeline: buildTimeline(param.events),
      };
      cursors.set(param, cursor);
    }
    return cursor;
  };

  const bufferOf = (node: FakeAudioNode): [Float32Array, Float32Array] => {
    let pair = buffers.get(node);
    if (!pair) {
      pair = [new Float32Array(blockSize), new Float32Array(blockSize)];
      buffers.set(node, pair);
    }
    return pair;
  };

  /** Automation value of a param, ignoring any connected modulation. */
  const automation = (param: FakeAudioParam, time: number): number => paramValueAt(cursorOf(param), time);

  /**
   * Signal connected *into* a param, summed into `out`. WebAudio adds connected
   * signals to the automation value, which is how the fire's wind LFO and the
   * bird calls' FM operator both work.
   */
  const modulation = (param: FakeAudioParam, blockStart: number, count: number): Float32Array | null => {
    const sources = paramInputs.get(param);
    if (!sources || sources.length === 0) return null;
    const out = takeScratch();
    out.fill(0, 0, count);
    for (const source of sources) {
      const [sl, sr] = pull(source, blockStart, count);
      for (let i = 0; i < count; i += 1) {
        out[i] = (out[i] ?? 0) + ((sl[i] ?? 0) + (sr[i] ?? 0)) * 0.5;
      }
    }
    releaseScratch();
    return out;
  };

  function pull(node: FakeAudioNode, blockStart: number, count: number): [Float32Array, Float32Array] {
    const out = bufferOf(node);
    if (computed.has(node)) return out;
    if (visiting.has(node)) {
      // A feedback loop. Nothing in this engine builds one; returning the
      // previous block rather than recursing forever keeps a bug visible
      // instead of hanging the test run.
      return out;
    }
    visiting.add(node);
    computed.add(node);

    const [outL, outR] = out;
    outL.fill(0, 0, count);
    outR.fill(0, 0, count);

    // Sum every upstream node first.
    const sources = inputs.get(node);
    if (sources) {
      for (const source of sources) {
        const [sl, sr] = pull(source, blockStart, count);
        for (let i = 0; i < count; i += 1) {
          outL[i] = (outL[i] ?? 0) + (sl[i] ?? 0);
          outR[i] = (outR[i] ?? 0) + (sr[i] ?? 0);
        }
      }
    }

    process(node, outL, outR, blockStart, count);
    visiting.delete(node);
    return out;
  }

  function process(
    node: FakeAudioNode,
    outL: Float32Array,
    outR: Float32Array,
    blockStart: number,
    count: number,
  ): void {
    const dt = 1 / sampleRate;

    if (node instanceof FakeGainNode) {
      const modulated = modulation(node.gain, blockStart, count);
      for (let i = 0; i < count; i += 1) {
        const t = blockStart + i * dt;
        const g = automation(node.gain, t) + (modulated ? (modulated[i] ?? 0) : 0);
        outL[i] = (outL[i] ?? 0) * g;
        outR[i] = (outR[i] ?? 0) * g;
      }
      return;
    }

    if (node instanceof FakeBiquadFilterNode) {
      const state = stateOf(node);
      if (!state.biquad) state.biquad = createBiquadState();
      const modulated = modulation(node.frequency, blockStart, count);
      const detune = automation(node.detune, blockStart);
      const frequency =
        (automation(node.frequency, blockStart) + (modulated ? (modulated[0] ?? 0) : 0)) *
        Math.pow(2, detune / 1200);
      updateBiquad(
        state.biquad,
        node.type,
        frequency,
        automation(node.Q, blockStart),
        automation(node.gain, blockStart),
        sampleRate,
      );
      const b = state.biquad;
      for (let c = 0; c < 2; c += 1) {
        const data = c === 0 ? outL : outR;
        let x1 = b.x1[c] ?? 0;
        let x2 = b.x2[c] ?? 0;
        let y1 = b.y1[c] ?? 0;
        let y2 = b.y2[c] ?? 0;
        for (let i = 0; i < count; i += 1) {
          const x0 = data[i] ?? 0;
          const y0 = b.b0 * x0 + b.b1 * x1 + b.b2 * x2 - b.a1 * y1 - b.a2 * y2;
          x2 = x1;
          x1 = x0;
          y2 = y1;
          y1 = y0;
          data[i] = y0;
        }
        b.x1[c] = x1;
        b.x2[c] = x2;
        b.y1[c] = y1;
        b.y2[c] = y2;
      }
      return;
    }

    if (node instanceof FakeOscillatorNode) {
      const state = stateOf(node);
      const started = node.startedAt;
      const stopped = node.stoppedAt;
      const modulated = modulation(node.frequency, blockStart, count);
      for (let i = 0; i < count; i += 1) {
        const t = blockStart + i * dt;
        if (started === null || t < started || (stopped !== null && t >= stopped)) {
          outL[i] = 0;
          outR[i] = 0;
          continue;
        }
        const base = automation(node.frequency, t) + (modulated ? (modulated[i] ?? 0) : 0);
        const hz = base * Math.pow(2, automation(node.detune, t) / 1200);
        state.phase += hz * dt;
        if (state.phase > 1e6 || state.phase < -1e6) state.phase = state.phase % 1;
        const value = waveform(node.type, state.phase);
        outL[i] = value;
        outR[i] = value;
      }
      return;
    }

    if (node instanceof FakeBufferSourceNode) {
      const state = stateOf(node);
      const buffer = node.buffer;
      const started = node.startedAt;
      if (!buffer || started === null) {
        outL.fill(0, 0, count);
        outR.fill(0, 0, count);
        return;
      }
      const sourceRate = buffer.sampleRate / sampleRate;
      const data = buffer.getChannelData(0);
      const dataR = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : data;
      const loopEnd = node.loopEnd > 0 ? node.loopEnd : buffer.duration;
      const loopStart = Math.max(0, node.loopStart);
      const stopAt = node.stoppedAt;
      const durationEnd = node.startDuration === null ? Infinity : started + node.startDuration;
      for (let i = 0; i < count; i += 1) {
        const t = blockStart + i * dt;
        if (t < started || t >= durationEnd || (stopAt !== null && t >= stopAt)) {
          outL[i] = 0;
          outR[i] = 0;
          continue;
        }
        if (state.position === 0) state.position = node.startOffset * buffer.sampleRate;
        let frame = state.position;
        if (node.loop) {
          const loopStartFrame = loopStart * buffer.sampleRate;
          const loopEndFrame = Math.min(loopEnd * buffer.sampleRate, buffer.length);
          const span = Math.max(loopEndFrame - loopStartFrame, 1);
          if (frame >= loopEndFrame) {
            frame = loopStartFrame + ((frame - loopStartFrame) % span);
            state.position = frame;
          }
        } else if (frame >= buffer.length - 1) {
          outL[i] = 0;
          outR[i] = 0;
          continue;
        }
        const index = Math.floor(frame);
        const frac = frame - index;
        const next = index + 1 < buffer.length ? index + 1 : index;
        outL[i] = (data[index] ?? 0) * (1 - frac) + (data[next] ?? 0) * frac;
        outR[i] = (dataR[index] ?? 0) * (1 - frac) + (dataR[next] ?? 0) * frac;
        state.position += automation(node.playbackRate, t) * sourceRate;
      }
      return;
    }

    if (node instanceof FakeStereoPannerNode) {
      for (let i = 0; i < count; i += 1) {
        const t = blockStart + i * dt;
        const pan = clamp(automation(node.pan, t), -1, 1);
        // WebAudio's stereo panner sums the two input channels for |pan|>0.
        const x = (pan + 1) * 0.25 * Math.PI;
        const gainL = Math.cos(x);
        const gainR = Math.sin(x);
        const mono = ((outL[i] ?? 0) + (outR[i] ?? 0)) * 0.5;
        outL[i] = mono * gainL;
        outR[i] = mono * gainR;
      }
      return;
    }

    if (node instanceof FakePannerNode) {
      const listener = ctx.listener;
      const px = automation(node.positionX, blockStart);
      const py = automation(node.positionY, blockStart);
      const pz = automation(node.positionZ, blockStart);
      const lx = automation(listener.positionX, blockStart);
      const ly = automation(listener.positionY, blockStart);
      const lz = automation(listener.positionZ, blockStart);
      const fx = automation(listener.forwardX, blockStart);
      const fy = automation(listener.forwardY, blockStart);
      const fz = automation(listener.forwardZ, blockStart);
      const ux = automation(listener.upX, blockStart);
      const uy = automation(listener.upY, blockStart);
      const uz = automation(listener.upZ, blockStart);
      const { gainL, gainR } = pannerGains(
        { x: px, y: py, z: pz },
        { x: lx, y: ly, z: lz },
        { x: fx, y: fy, z: fz },
        { x: ux, y: uy, z: uz },
        node,
      );
      for (let i = 0; i < count; i += 1) {
        const mono = ((outL[i] ?? 0) + (outR[i] ?? 0)) * 0.5;
        outL[i] = mono * gainL;
        outR[i] = mono * gainR;
      }
      return;
    }

    if (node instanceof FakeDelayNode) {
      const state = stateOf(node);
      const maxFrames = Math.max(2, Math.round(sampleRate * 2));
      if (!state.delay) state.delay = [new Float32Array(maxFrames), new Float32Array(maxFrames)];
      const lines = state.delay;
      for (let i = 0; i < count; i += 1) {
        const t = blockStart + i * dt;
        const delayFrames = clamp(automation(node.delayTime, t) * sampleRate, 0, maxFrames - 1);
        const readPos = state.delayWrite - delayFrames;
        const wrapped = ((readPos % maxFrames) + maxFrames) % maxFrames;
        const index = Math.floor(wrapped);
        const frac = wrapped - index;
        const next = (index + 1) % maxFrames;
        for (let c = 0; c < 2; c += 1) {
          const line = lines[c];
          const data = c === 0 ? outL : outR;
          if (!line) continue;
          const value = (line[index] ?? 0) * (1 - frac) + (line[next] ?? 0) * frac;
          line[state.delayWrite] = data[i] ?? 0;
          data[i] = value;
        }
        state.delayWrite = (state.delayWrite + 1) % maxFrames;
      }
      return;
    }

    if (node instanceof FakeDynamicsCompressorNode) {
      const state = stateOf(node);
      const threshold = automation(node.threshold, blockStart);
      const knee = Math.max(automation(node.knee, blockStart), 0);
      const ratio = Math.max(automation(node.ratio, blockStart), 1);
      const attack = Math.max(automation(node.attack, blockStart), 1e-4);
      const release = Math.max(automation(node.release, blockStart), 1e-3);
      const attackCoef = Math.exp(-dt / attack);
      const releaseCoef = Math.exp(-dt / release);
      for (let i = 0; i < count; i += 1) {
        const level = Math.max(Math.abs(outL[i] ?? 0), Math.abs(outR[i] ?? 0));
        const db = level > 1e-9 ? 20 * Math.log10(level) : -200;
        const over = db - threshold;
        let wanted = 0;
        if (knee > 0 && over > -knee / 2 && over < knee / 2) {
          const x = over + knee / 2;
          wanted = ((1 / ratio - 1) * x * x) / (2 * knee);
        } else if (over >= knee / 2) {
          wanted = over * (1 / ratio - 1);
        }
        const coef = wanted < state.reductionDb ? attackCoef : releaseCoef;
        state.reductionDb = wanted + (state.reductionDb - wanted) * coef;
        const gain = Math.pow(10, state.reductionDb / 20);
        outL[i] = (outL[i] ?? 0) * gain;
        outR[i] = (outR[i] ?? 0) * gain;
      }
      return;
    }

    if (node.kind === 'convolver') {
      // Documented at the top of this file: the reverb return is not modelled.
      outL.fill(0, 0, count);
      outR.fill(0, 0, count);
      return;
    }

    // 'destination' and anything unrecognised pass their summed input through.
  }

  const blocks = Math.ceil(frames / blockSize);
  for (let block = 0; block < blocks; block += 1) {
    const offset = block * blockSize;
    const count = Math.min(blockSize, frames - offset);
    const blockStart = startTime + offset / sampleRate;
    computed.clear();
    const [bl, br] = pull(target, blockStart, count);
    for (let i = 0; i < count; i += 1) {
      left[offset + i] = bl[i] ?? 0;
      right[offset + i] = br[i] ?? 0;
    }
  }

  return { sampleRate, channels: [left, right], durationSeconds: frames / sampleRate };
}

interface Vector {
  x: number;
  y: number;
  z: number;
}

function normalise(v: Vector): Vector {
  const length = Math.hypot(v.x, v.y, v.z);
  if (length < 1e-9) return { x: 0, y: 0, z: -1 };
  return { x: v.x / length, y: v.y / length, z: v.z / length };
}

function cross(a: Vector, b: Vector): Vector {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}

function dot(a: Vector, b: Vector): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Equal-power panner gains and distance attenuation, following the azimuth
 * algorithm in the WebAudio specification. HRTF is rendered the same way (see
 * the caveats at the top of this file): direction survives, colouring does not.
 */
export function pannerGains(
  source: Vector,
  listenerPosition: Vector,
  listenerForward: Vector,
  listenerUp: Vector,
  node: Pick<FakePannerNode, 'distanceModel' | 'refDistance' | 'maxDistance' | 'rolloffFactor'>,
): { gainL: number; gainR: number; azimuth: number; distance: number } {
  const rel = {
    x: source.x - listenerPosition.x,
    y: source.y - listenerPosition.y,
    z: source.z - listenerPosition.z,
  };
  const distance = Math.hypot(rel.x, rel.y, rel.z);
  const forward = normalise(listenerForward);
  const up = normalise(listenerUp);
  const right = normalise(cross(forward, up));
  const trueUp = normalise(cross(right, forward));

  let azimuth = 0;
  if (distance > 1e-9) {
    const dir = normalise(rel);
    const upProjection = dot(dir, trueUp);
    const projected = normalise({
      x: dir.x - trueUp.x * upProjection,
      y: dir.y - trueUp.y * upProjection,
      z: dir.z - trueUp.z * upProjection,
    });
    azimuth = (180 / Math.PI) * Math.acos(clamp(dot(projected, right), -1, 1));
    if (dot(projected, forward) < 0) azimuth = 360 - azimuth;
    azimuth = azimuth >= 0 && azimuth <= 270 ? 90 - azimuth : 450 - azimuth;
  }

  let folded = azimuth;
  if (folded < -90) folded = -180 - folded;
  if (folded > 90) folded = 180 - folded;
  const x = (folded + 90) / 180;
  const gain = distanceGain(distance, node);
  return {
    gainL: Math.cos((x * Math.PI) / 2) * gain,
    gainR: Math.sin((x * Math.PI) / 2) * gain,
    azimuth,
    distance,
  };
}

function distanceGain(
  distance: number,
  node: Pick<FakePannerNode, 'distanceModel' | 'refDistance' | 'maxDistance' | 'rolloffFactor'>,
): number {
  const ref = Math.max(node.refDistance, 1e-6);
  const max = Math.max(node.maxDistance, ref + 1e-6);
  const rolloff = Math.max(node.rolloffFactor, 0);
  const d = Math.max(distance, 0);
  switch (node.distanceModel) {
    case 'linear': {
      const clamped = clamp(d, ref, max);
      return clamp(1 - (rolloff * (clamped - ref)) / (max - ref), 0, 1);
    }
    case 'exponential':
      return clamp(Math.pow(Math.max(d, ref) / ref, -rolloff), 0, 1);
    case 'inverse':
    default:
      return clamp(ref / (ref + rolloff * (Math.max(d, ref) - ref)), 0, 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Measurement helpers                                                         */
/* -------------------------------------------------------------------------- */

/** Peak absolute sample across every channel. */
export function renderPeak(audio: RenderedAudio): number {
  let peak = 0;
  for (const channel of audio.channels) {
    for (let i = 0; i < channel.length; i += 1) {
      const magnitude = Math.abs(channel[i] ?? 0);
      if (magnitude > peak) peak = magnitude;
    }
  }
  return peak;
}

/** RMS over a time window, mono-summed. Both bounds are in seconds. */
export function renderRms(audio: RenderedAudio, fromSeconds = 0, toSeconds = Infinity): number {
  const [left, right] = audio.channels;
  const start = Math.max(0, Math.round(fromSeconds * audio.sampleRate));
  const end = Math.min(left.length, Math.round(Math.min(toSeconds, audio.durationSeconds) * audio.sampleRate));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const mono = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
    sum += mono * mono;
  }
  return Math.sqrt(sum / (end - start));
}

/** RMS of one channel over a window. `channel` is 0 for left, 1 for right. */
export function renderChannelRms(
  audio: RenderedAudio,
  channel: 0 | 1,
  fromSeconds = 0,
  toSeconds = Infinity,
): number {
  const data = audio.channels[channel];
  const start = Math.max(0, Math.round(fromSeconds * audio.sampleRate));
  const end = Math.min(data.length, Math.round(Math.min(toSeconds, audio.durationSeconds) * audio.sampleRate));
  if (end <= start) return 0;
  let sum = 0;
  for (let i = start; i < end; i += 1) {
    const value = data[i] ?? 0;
    sum += value * value;
  }
  return Math.sqrt(sum / (end - start));
}

export interface Discontinuity {
  /** Largest sample-to-sample step found, in linear amplitude. */
  delta: number;
  /** Where it happened, in seconds. */
  atSeconds: number;
}

/**
 * The largest single-sample jump in the render — the measurable definition of
 * "it clicked".
 *
 * A click is a step; a fade is a slope. At 48 kHz a signal peaking at 0.3 that
 * moves smoothly cannot step by more than a few thousandths between adjacent
 * samples unless something was switched rather than ramped.
 */
export function largestDiscontinuity(
  audio: RenderedAudio,
  fromSeconds = 0,
  toSeconds = Infinity,
): Discontinuity {
  const [left, right] = audio.channels;
  const start = Math.max(1, Math.round(fromSeconds * audio.sampleRate));
  const end = Math.min(left.length, Math.round(Math.min(toSeconds, audio.durationSeconds) * audio.sampleRate));
  let delta = 0;
  let at = 0;
  for (let i = start; i < end; i += 1) {
    const dl = Math.abs((left[i] ?? 0) - (left[i - 1] ?? 0));
    const dr = Math.abs((right[i] ?? 0) - (right[i - 1] ?? 0));
    const step = Math.max(dl, dr);
    if (step > delta) {
      delta = step;
      at = i / audio.sampleRate;
    }
  }
  return { delta, atSeconds: at };
}

export interface EnvelopeStep {
  /** Largest jump in short-window RMS, in linear amplitude. */
  step: number;
  /** Loudest window in the range, for scale. */
  reference: number;
  /** `step / reference`. A hard cut approaches 1; a ramp stays well below it. */
  ratio: number;
  atSeconds: number;
}

/**
 * The largest jump in the signal's *envelope*.
 *
 * `largestDiscontinuity` is the right instrument for a tone and the wrong one
 * for noise: adjacent samples of white noise legitimately differ by twice its
 * amplitude, so muting noise instantly is invisible to a sample-delta test even
 * though it is plainly audible. What a listener hears in that case is a step in
 * the *level*, so that is what this measures. A cut takes the envelope to zero
 * in one window (ratio near 1); a ramp with a time constant longer than the
 * window cannot (ratio near `1 - exp(-window/tau)`).
 */
export function largestEnvelopeStep(
  audio: RenderedAudio,
  fromSeconds = 0,
  toSeconds = Infinity,
  windowSeconds = 0.02,
): EnvelopeStep {
  const [left, right] = audio.channels;
  const rate = audio.sampleRate;
  const size = Math.max(8, Math.round(windowSeconds * rate));
  const start = Math.max(0, Math.round(fromSeconds * rate));
  const end = Math.min(left.length, Math.round(Math.min(toSeconds, audio.durationSeconds) * rate));

  let previous = -1;
  let step = 0;
  let reference = 0;
  let at = 0;
  for (let offset = start; offset + size <= end; offset += size) {
    let sum = 0;
    for (let i = offset; i < offset + size; i += 1) {
      const mono = ((left[i] ?? 0) + (right[i] ?? 0)) * 0.5;
      sum += mono * mono;
    }
    const rms = Math.sqrt(sum / size);
    if (rms > reference) reference = rms;
    if (previous >= 0) {
      const delta = Math.abs(rms - previous);
      if (delta > step) {
        step = delta;
        at = offset / rate;
      }
    }
    previous = rms;
  }
  return { step, reference, ratio: reference > 0 ? step / reference : 0, atSeconds: at };
}

/** In-place iterative radix-2 FFT. `re`/`im` must have a power-of-two length. */
function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i += 1) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] ?? 0;
      re[i] = re[j] ?? 0;
      re[j] = tr;
      const ti = im[i] ?? 0;
      im[i] = im[j] ?? 0;
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
        const aR = re[i + k] ?? 0;
        const aI = im[i + k] ?? 0;
        const br = re[i + k + len / 2] ?? 0;
        const bi = im[i + k + len / 2] ?? 0;
        const bR = br * curR - bi * curI;
        const bI = br * curI + bi * curR;
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

/** Hann-windowed magnitude spectrum of a mono-summed window of the render. */
export function spectrumOf(
  audio: RenderedAudio,
  fromSeconds: number,
  toSeconds: number,
): { magnitudes: Float64Array; binHz: number } {
  const [left, right] = audio.channels;
  const rate = audio.sampleRate;
  const start = Math.max(0, Math.round(fromSeconds * rate));
  const end = Math.min(left.length, Math.round(toSeconds * rate));
  const length = Math.max(0, end - start);
  let size = 1;
  while (size < length) size <<= 1;
  size = Math.max(size, 64);

  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < length; i += 1) {
    const window = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / Math.max(length - 1, 1));
    re[i] = (((left[start + i] ?? 0) + (right[start + i] ?? 0)) * 0.5) * window;
  }
  fft(re, im);
  const magnitudes = new Float64Array(size / 2);
  for (let bin = 0; bin < magnitudes.length; bin += 1) {
    magnitudes[bin] = Math.hypot(re[bin] ?? 0, im[bin] ?? 0);
  }
  return { magnitudes, binHz: rate / size };
}

/**
 * Loudest frequency in a window, from the spectral peak with parabolic
 * interpolation between bins.
 *
 * This is how the carrier whistle is measured. An FFT peak rather than
 * autocorrelation because the whistle is heard *through* hiss and programme
 * material, and a correlation peak-picker locks onto the wrong multiple of the
 * period as soon as the signal is not a bare sine.
 */
export function dominantFrequency(
  audio: RenderedAudio,
  fromSeconds: number,
  toSeconds: number,
  minHz = 40,
  maxHz = 8000,
): number {
  const { magnitudes, binHz } = spectrumOf(audio, fromSeconds, toSeconds);
  const first = Math.max(1, Math.ceil(minHz / binHz));
  const last = Math.min(magnitudes.length - 2, Math.floor(maxHz / binHz));
  let peakBin = -1;
  let peak = 0;
  for (let bin = first; bin <= last; bin += 1) {
    const value = magnitudes[bin] ?? 0;
    if (value > peak) {
      peak = value;
      peakBin = bin;
    }
  }
  if (peakBin < 0 || peak <= 0) return 0;
  const previous = magnitudes[peakBin - 1] ?? 0;
  const next = magnitudes[peakBin + 1] ?? 0;
  const denominator = previous - 2 * peak + next;
  const shift = denominator !== 0 ? (0.5 * (previous - next)) / denominator : 0;
  return (peakBin + clamp(shift, -1, 1)) * binHz;
}

/** Fraction of spectral energy in `[lowHz, highHz)` across a window. */
export function bandFraction(
  audio: RenderedAudio,
  fromSeconds: number,
  toSeconds: number,
  lowHz: number,
  highHz: number,
): number {
  const { magnitudes, binHz } = spectrumOf(audio, fromSeconds, toSeconds);
  let total = 0;
  let inBand = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const energy = (magnitudes[bin] ?? 0) ** 2;
    total += energy;
    const hz = bin * binHz;
    if (hz >= lowHz && hz < highHz) inBand += energy;
  }
  return total > 0 ? inBand / total : 0;
}
