/**
 * A headless stand-in for WebAudio.
 *
 * This is test/dev support, deliberately kept out of `index.ts` so it never
 * ends up in the shipped bundle. It implements enough of the API for the whole
 * engine to be constructed and driven in Node, and it records every parameter
 * automation event so scheduling logic can be asserted precisely.
 */

export type ParamEventType = 'setValue' | 'linearRamp' | 'exponentialRamp' | 'setTarget' | 'cancel';

export interface ParamEvent {
  type: ParamEventType;
  value: number;
  time: number;
  timeConstant?: number;
}

export class FakeAudioParam {
  readonly events: ParamEvent[] = [];
  /**
   * The last value written by a plain `param.value = x` assignment.
   *
   * Automation events do not touch it, so the offline renderer can recover the
   * baseline a graph was built with even after the param has been automated.
   * (`value` itself keeps reporting the most recently scheduled value, which is
   * what the scheduling tests assert on.)
   */
  assignedValue: number;
  private current: number;

  constructor(value: number = 0, readonly name = 'param') {
    this.current = value;
    this.assignedValue = value;
  }

  get value(): number {
    return this.current;
  }

  set value(next: number) {
    this.current = next;
    this.assignedValue = next;
  }

  setValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'setValue', value, time });
    this.current = value;
    return this;
  }

  linearRampToValueAtTime(value: number, time: number): this {
    this.events.push({ type: 'linearRamp', value, time });
    this.current = value;
    return this;
  }

  exponentialRampToValueAtTime(value: number, time: number): this {
    if (value === 0) throw new RangeError('exponentialRampToValueAtTime: value must be non-zero');
    this.events.push({ type: 'exponentialRamp', value, time });
    this.current = value;
    return this;
  }

  setTargetAtTime(value: number, time: number, timeConstant: number): this {
    this.events.push({ type: 'setTarget', value, time, timeConstant });
    this.current = value;
    return this;
  }

  cancelScheduledValues(time: number): this {
    this.events.push({ type: 'cancel', value: this.current, time });
    return this;
  }

  cancelAndHoldAtTime(time: number): this {
    return this.cancelScheduledValues(time);
  }

  /** Events of one type, in schedule order. */
  eventsOfType(type: ParamEventType): ParamEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  get lastEvent(): ParamEvent | undefined {
    return this.events[this.events.length - 1];
  }
}

export class FakeAudioBuffer {
  private readonly channels: Float32Array[] = [];

  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    for (let i = 0; i < numberOfChannels; i += 1) this.channels.push(new Float32Array(length));
  }

  get duration(): number {
    return this.length / this.sampleRate;
  }

  getChannelData(channel: number): Float32Array {
    const data = this.channels[channel];
    if (!data) throw new RangeError(`no channel ${channel}`);
    return data;
  }

  copyToChannel(source: Float32Array, channel: number, offset = 0): void {
    this.getChannelData(channel).set(source.subarray(0, this.length - offset), offset);
  }

  copyFromChannel(destination: Float32Array, channel: number, offset = 0): void {
    destination.set(this.getChannelData(channel).subarray(offset, offset + destination.length));
  }
}

export class FakeAudioNode {
  readonly outputs: FakeAudioNode[] = [];
  readonly paramOutputs: FakeAudioParam[] = [];
  disconnected = false;

  constructor(
    readonly context: FakeAudioContext,
    readonly kind: string,
  ) {}

  connect<T>(target: T): T {
    if (target instanceof FakeAudioParam) {
      this.paramOutputs.push(target);
    } else if (target instanceof FakeAudioNode) {
      this.outputs.push(target);
    }
    return target;
  }

  disconnect(): void {
    this.outputs.length = 0;
    this.paramOutputs.length = 0;
    this.disconnected = true;
  }

  /** Depth-first search for a downstream node of `kind`. */
  reaches(kind: string, seen = new Set<FakeAudioNode>()): boolean {
    if (seen.has(this)) return false;
    seen.add(this);
    for (const output of this.outputs) {
      if (output.kind === kind || output.reaches(kind, seen)) return true;
    }
    return false;
  }
}

export class FakeScheduledSource extends FakeAudioNode {
  startedAt: number | null = null;
  stoppedAt: number | null = null;
  startOffset = 0;
  startDuration: number | null = null;

  start(when = 0, offset = 0, duration?: number): void {
    if (this.startedAt !== null) throw new Error('source already started');
    this.startedAt = when;
    this.startOffset = offset;
    this.startDuration = duration ?? null;
    this.context.startedSources.push(this);
  }

  stop(when = 0): void {
    if (this.startedAt === null) throw new Error('cannot stop before start');
    this.stoppedAt = when;
  }
}

export class FakeGainNode extends FakeAudioNode {
  readonly gain = new FakeAudioParam(1, 'gain');
}

export class FakeBiquadFilterNode extends FakeAudioNode {
  type: BiquadFilterType = 'lowpass';
  readonly frequency = new FakeAudioParam(350, 'frequency');
  readonly Q = new FakeAudioParam(1, 'Q');
  readonly gain = new FakeAudioParam(0, 'gain');
  readonly detune = new FakeAudioParam(0, 'detune');
}

export class FakeOscillatorNode extends FakeScheduledSource {
  type: OscillatorType = 'sine';
  readonly frequency = new FakeAudioParam(440, 'frequency');
  readonly detune = new FakeAudioParam(0, 'detune');
}

export class FakeBufferSourceNode extends FakeScheduledSource {
  buffer: FakeAudioBuffer | null = null;
  loop = false;
  loopStart = 0;
  loopEnd = 0;
  readonly playbackRate = new FakeAudioParam(1, 'playbackRate');
  readonly detune = new FakeAudioParam(0, 'detune');
}

export class FakeConvolverNode extends FakeAudioNode {
  buffer: FakeAudioBuffer | null = null;
  normalize = true;
}

export class FakeStereoPannerNode extends FakeAudioNode {
  readonly pan = new FakeAudioParam(0, 'pan');
}

export class FakePannerNode extends FakeAudioNode {
  panningModel: PanningModelType = 'equalpower';
  distanceModel: DistanceModelType = 'inverse';
  refDistance = 1;
  maxDistance = 10000;
  rolloffFactor = 1;
  coneInnerAngle = 360;
  coneOuterAngle = 360;
  coneOuterGain = 0;
  readonly positionX = new FakeAudioParam(0, 'positionX');
  readonly positionY = new FakeAudioParam(0, 'positionY');
  readonly positionZ = new FakeAudioParam(0, 'positionZ');
  readonly orientationX = new FakeAudioParam(1, 'orientationX');
  readonly orientationY = new FakeAudioParam(0, 'orientationY');
  readonly orientationZ = new FakeAudioParam(0, 'orientationZ');
}

export class FakeDynamicsCompressorNode extends FakeAudioNode {
  readonly threshold = new FakeAudioParam(-24, 'threshold');
  readonly knee = new FakeAudioParam(30, 'knee');
  readonly ratio = new FakeAudioParam(12, 'ratio');
  readonly attack = new FakeAudioParam(0.003, 'attack');
  readonly release = new FakeAudioParam(0.25, 'release');
  readonly reduction = 0;
}

export class FakeDelayNode extends FakeAudioNode {
  readonly delayTime = new FakeAudioParam(0, 'delayTime');
}

export class FakeAudioListener {
  readonly positionX = new FakeAudioParam(0, 'positionX');
  readonly positionY = new FakeAudioParam(0, 'positionY');
  readonly positionZ = new FakeAudioParam(0, 'positionZ');
  readonly forwardX = new FakeAudioParam(0, 'forwardX');
  readonly forwardY = new FakeAudioParam(0, 'forwardY');
  readonly forwardZ = new FakeAudioParam(-1, 'forwardZ');
  readonly upX = new FakeAudioParam(0, 'upX');
  readonly upY = new FakeAudioParam(1, 'upY');
  readonly upZ = new FakeAudioParam(0, 'upZ');
}

export interface FakeAudioContextOptions {
  sampleRate?: number;
  /** Start in 'suspended' to model a browser that has not seen a gesture yet. */
  state?: AudioContextState;
}

export class FakeAudioContext {
  readonly sampleRate: number;
  readonly destination: FakeAudioNode;
  readonly listener = new FakeAudioListener();
  readonly nodes: FakeAudioNode[] = [];
  readonly startedSources: FakeScheduledSource[] = [];
  readonly created: Record<string, number> = {};
  state: AudioContextState;
  currentTime = 0;
  closed = false;

  constructor(options: FakeAudioContextOptions = {}) {
    this.sampleRate = options.sampleRate ?? 48000;
    this.state = options.state ?? 'suspended';
    this.destination = new FakeAudioNode(this, 'destination');
  }

  /** Move the audio clock forward, as the browser would. */
  advance(seconds: number): number {
    this.currentTime += Math.max(seconds, 0);
    return this.currentTime;
  }

  private track<T extends FakeAudioNode>(node: T): T {
    this.nodes.push(node);
    this.created[node.kind] = (this.created[node.kind] ?? 0) + 1;
    return node;
  }

  /** How many nodes of a kind have been created. */
  countOf(kind: string): number {
    return this.created[kind] ?? 0;
  }

  /** All created nodes of a kind, in creation order. */
  nodesOf(kind: string): FakeAudioNode[] {
    return this.nodes.filter((node) => node.kind === kind);
  }

  createGain(): FakeGainNode {
    return this.track(new FakeGainNode(this, 'gain'));
  }

  createBiquadFilter(): FakeBiquadFilterNode {
    return this.track(new FakeBiquadFilterNode(this, 'biquad'));
  }

  createOscillator(): FakeOscillatorNode {
    return this.track(new FakeOscillatorNode(this, 'oscillator'));
  }

  createBufferSource(): FakeBufferSourceNode {
    return this.track(new FakeBufferSourceNode(this, 'bufferSource'));
  }

  createConvolver(): FakeConvolverNode {
    return this.track(new FakeConvolverNode(this, 'convolver'));
  }

  createStereoPanner(): FakeStereoPannerNode {
    return this.track(new FakeStereoPannerNode(this, 'stereoPanner'));
  }

  createPanner(): FakePannerNode {
    return this.track(new FakePannerNode(this, 'panner'));
  }

  createDynamicsCompressor(): FakeDynamicsCompressorNode {
    return this.track(new FakeDynamicsCompressorNode(this, 'compressor'));
  }

  createDelay(): FakeDelayNode {
    return this.track(new FakeDelayNode(this, 'delay'));
  }

  createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer {
    this.created.buffer = (this.created.buffer ?? 0) + 1;
    return new FakeAudioBuffer(channels, length, sampleRate);
  }

  async resume(): Promise<void> {
    this.state = 'running';
  }

  async suspend(): Promise<void> {
    this.state = 'suspended';
  }

  async close(): Promise<void> {
    this.state = 'closed';
    this.closed = true;
  }
}

/**
 * Build a fake context and the factory the engine expects.
 *
 * ```ts
 * const ctx = createFakeAudioContext();
 * const engine = new AudioEngine({ contextFactory: () => ctx as unknown as AudioContext, pumpIntervalMs: 0 });
 * ```
 */
export function createFakeAudioContext(options: FakeAudioContextOptions = {}): FakeAudioContext {
  return new FakeAudioContext(options);
}
