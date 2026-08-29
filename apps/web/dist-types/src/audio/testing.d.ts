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
export declare class FakeAudioParam {
    value: number;
    readonly name: string;
    readonly events: ParamEvent[];
    constructor(value?: number, name?: string);
    setValueAtTime(value: number, time: number): this;
    linearRampToValueAtTime(value: number, time: number): this;
    exponentialRampToValueAtTime(value: number, time: number): this;
    setTargetAtTime(value: number, time: number, timeConstant: number): this;
    cancelScheduledValues(time: number): this;
    cancelAndHoldAtTime(time: number): this;
    /** Events of one type, in schedule order. */
    eventsOfType(type: ParamEventType): ParamEvent[];
    get lastEvent(): ParamEvent | undefined;
}
export declare class FakeAudioBuffer {
    readonly numberOfChannels: number;
    readonly length: number;
    readonly sampleRate: number;
    private readonly channels;
    constructor(numberOfChannels: number, length: number, sampleRate: number);
    get duration(): number;
    getChannelData(channel: number): Float32Array;
    copyToChannel(source: Float32Array, channel: number, offset?: number): void;
    copyFromChannel(destination: Float32Array, channel: number, offset?: number): void;
}
export declare class FakeAudioNode {
    readonly context: FakeAudioContext;
    readonly kind: string;
    readonly outputs: FakeAudioNode[];
    readonly paramOutputs: FakeAudioParam[];
    disconnected: boolean;
    constructor(context: FakeAudioContext, kind: string);
    connect<T>(target: T): T;
    disconnect(): void;
    /** Depth-first search for a downstream node of `kind`. */
    reaches(kind: string, seen?: Set<FakeAudioNode>): boolean;
}
export declare class FakeScheduledSource extends FakeAudioNode {
    startedAt: number | null;
    stoppedAt: number | null;
    startOffset: number;
    startDuration: number | null;
    start(when?: number, offset?: number, duration?: number): void;
    stop(when?: number): void;
}
export declare class FakeGainNode extends FakeAudioNode {
    readonly gain: FakeAudioParam;
}
export declare class FakeBiquadFilterNode extends FakeAudioNode {
    type: BiquadFilterType;
    readonly frequency: FakeAudioParam;
    readonly Q: FakeAudioParam;
    readonly gain: FakeAudioParam;
    readonly detune: FakeAudioParam;
}
export declare class FakeOscillatorNode extends FakeScheduledSource {
    type: OscillatorType;
    readonly frequency: FakeAudioParam;
    readonly detune: FakeAudioParam;
}
export declare class FakeBufferSourceNode extends FakeScheduledSource {
    buffer: FakeAudioBuffer | null;
    loop: boolean;
    loopStart: number;
    loopEnd: number;
    readonly playbackRate: FakeAudioParam;
    readonly detune: FakeAudioParam;
}
export declare class FakeConvolverNode extends FakeAudioNode {
    buffer: FakeAudioBuffer | null;
    normalize: boolean;
}
export declare class FakeStereoPannerNode extends FakeAudioNode {
    readonly pan: FakeAudioParam;
}
export declare class FakePannerNode extends FakeAudioNode {
    panningModel: PanningModelType;
    distanceModel: DistanceModelType;
    refDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    coneInnerAngle: number;
    coneOuterAngle: number;
    coneOuterGain: number;
    readonly positionX: FakeAudioParam;
    readonly positionY: FakeAudioParam;
    readonly positionZ: FakeAudioParam;
    readonly orientationX: FakeAudioParam;
    readonly orientationY: FakeAudioParam;
    readonly orientationZ: FakeAudioParam;
}
export declare class FakeDynamicsCompressorNode extends FakeAudioNode {
    readonly threshold: FakeAudioParam;
    readonly knee: FakeAudioParam;
    readonly ratio: FakeAudioParam;
    readonly attack: FakeAudioParam;
    readonly release: FakeAudioParam;
    readonly reduction = 0;
}
export declare class FakeDelayNode extends FakeAudioNode {
    readonly delayTime: FakeAudioParam;
}
export declare class FakeAudioListener {
    readonly positionX: FakeAudioParam;
    readonly positionY: FakeAudioParam;
    readonly positionZ: FakeAudioParam;
    readonly forwardX: FakeAudioParam;
    readonly forwardY: FakeAudioParam;
    readonly forwardZ: FakeAudioParam;
    readonly upX: FakeAudioParam;
    readonly upY: FakeAudioParam;
    readonly upZ: FakeAudioParam;
}
export interface FakeAudioContextOptions {
    sampleRate?: number;
    /** Start in 'suspended' to model a browser that has not seen a gesture yet. */
    state?: AudioContextState;
}
export declare class FakeAudioContext {
    readonly sampleRate: number;
    readonly destination: FakeAudioNode;
    readonly listener: FakeAudioListener;
    readonly nodes: FakeAudioNode[];
    readonly startedSources: FakeScheduledSource[];
    readonly created: Record<string, number>;
    state: AudioContextState;
    currentTime: number;
    closed: boolean;
    constructor(options?: FakeAudioContextOptions);
    /** Move the audio clock forward, as the browser would. */
    advance(seconds: number): number;
    private track;
    /** How many nodes of a kind have been created. */
    countOf(kind: string): number;
    /** All created nodes of a kind, in creation order. */
    nodesOf(kind: string): FakeAudioNode[];
    createGain(): FakeGainNode;
    createBiquadFilter(): FakeBiquadFilterNode;
    createOscillator(): FakeOscillatorNode;
    createBufferSource(): FakeBufferSourceNode;
    createConvolver(): FakeConvolverNode;
    createStereoPanner(): FakeStereoPannerNode;
    createPanner(): FakePannerNode;
    createDynamicsCompressor(): FakeDynamicsCompressorNode;
    createDelay(): FakeDelayNode;
    createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer;
    resume(): Promise<void>;
    suspend(): Promise<void>;
    close(): Promise<void>;
}
/**
 * Build a fake context and the factory the engine expects.
 *
 * ```ts
 * const ctx = createFakeAudioContext();
 * const engine = new AudioEngine({ contextFactory: () => ctx as unknown as AudioContext, pumpIntervalMs: 0 });
 * ```
 */
export declare function createFakeAudioContext(options?: FakeAudioContextOptions): FakeAudioContext;
//# sourceMappingURL=testing.d.ts.map