/**
 * 3D placement.
 *
 * Everything positional funnels through `SpatialEmitter`, which owns an input
 * `GainNode` in front of a `PannerNode`. Any audio node can be plugged into
 * that input — a synthesised campfire, a machine one-shot, or later a
 * `MediaStreamAudioSourceNode` carrying another player's microphone. Multiplayer
 * voice therefore needs no new spatial code, only `attachMediaStream`.
 */
export interface Vec3 {
    x: number;
    y: number;
    z: number;
}
export type SpatialQuality = 'hrtf' | 'equalpower' | 'auto';
export interface SpatialOptions {
    panningModel: SpatialQuality;
    distanceModel: DistanceModelType;
    refDistance: number;
    maxDistance: number;
    rolloffFactor: number;
    /** Inner/outer cone in degrees; 360 inner means omnidirectional. */
    coneInnerAngle: number;
    coneOuterAngle: number;
    coneOuterGain: number;
}
export declare const DEFAULT_SPATIAL_OPTIONS: Readonly<SpatialOptions>;
/** HRTF costs real CPU per source; above this many concurrent emitters, drop to equal-power. */
export declare const HRTF_SOURCE_BUDGET = 12;
export declare function choosePanningModel(quality: SpatialQuality, activeSources: number, budget?: number): PanningModelType;
/**
 * The WebAudio distance-gain curves, reimplemented exactly so gameplay code can
 * predict audibility (e.g. "is the SM-01 loud enough to hear from the tent?")
 * without a live AudioContext.
 */
export declare function computeDistanceGain(distance: number, options: Pick<SpatialOptions, 'distanceModel' | 'refDistance' | 'maxDistance' | 'rolloffFactor'>): number;
export declare function distanceBetween(a: Vec3, b: Vec3): number;
/** Normalise into `out` (may alias `v`). Returns `out`; a zero vector becomes (0,0,-1). */
export declare function normalizeVec3(v: Vec3, out: Vec3): Vec3;
export declare function crossVec3(a: Vec3, b: Vec3, out: Vec3): Vec3;
export declare function dotVec3(a: Vec3, b: Vec3): number;
/**
 * Gram-Schmidt the listener basis: WebAudio requires forward and up to be
 * orthonormal, and a camera matrix straight out of a 3D engine usually is not
 * once it has been through a lerp.
 */
export declare function orthonormalizeBasis(forward: Vec3, up: Vec3, outForward: Vec3, outUp: Vec3): void;
/**
 * Push the listener transform onto the context. Handles both the modern
 * AudioParam listener and the deprecated `setPosition`/`setOrientation` pair
 * that Firefox and older Safari still expose.
 */
export declare function updateListener(ctx: BaseAudioContext, position: Vec3, forward: Vec3, up: Vec3, smoothingSeconds?: number): void;
/**
 * One positioned sound source. `input` is the node everything connects into;
 * the panner and its options live behind it.
 */
export declare class SpatialEmitter {
    private readonly ctx;
    readonly input: GainNode;
    readonly panner: PannerNode;
    private streamSource;
    private disposed;
    constructor(ctx: BaseAudioContext, destination: AudioNode, options?: Partial<SpatialOptions>, activeSources?: number);
    setPosition(x: number, y: number, z: number, smoothingSeconds?: number): void;
    setOrientation(x: number, y: number, z: number): void;
    setGain(gain: number, smoothingSeconds?: number): void;
    /** Feed any node through this emitter's position. */
    attach(node: AudioNode): void;
    /**
     * Route a remote player's microphone through this emitter. The same panner,
     * distance model and listener basis then apply to voice and to world sound,
     * which is the point of routing everything through `SpatialEmitter`.
     */
    attachMediaStream(stream: MediaStream): MediaStreamAudioSourceNode | null;
    detachMediaStream(): void;
    dispose(): void;
}
//# sourceMappingURL=spatial.d.ts.map