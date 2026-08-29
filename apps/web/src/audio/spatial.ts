/**
 * 3D placement.
 *
 * Everything positional funnels through `SpatialEmitter`, which owns an input
 * `GainNode` in front of a `PannerNode`. Any audio node can be plugged into
 * that input — a synthesised campfire, a machine one-shot, or later a
 * `MediaStreamAudioSourceNode` carrying another player's microphone. Multiplayer
 * voice therefore needs no new spatial code, only `attachMediaStream`.
 */

import { clamp, clamp01 } from './math.js';

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

export const DEFAULT_SPATIAL_OPTIONS: Readonly<SpatialOptions> = Object.freeze({
  panningModel: 'auto',
  distanceModel: 'inverse',
  refDistance: 1,
  maxDistance: 60,
  rolloffFactor: 1,
  coneInnerAngle: 360,
  coneOuterAngle: 360,
  coneOuterGain: 0,
});

/** HRTF costs real CPU per source; above this many concurrent emitters, drop to equal-power. */
export const HRTF_SOURCE_BUDGET = 12;

export function choosePanningModel(
  quality: SpatialQuality,
  activeSources: number,
  budget = HRTF_SOURCE_BUDGET,
): PanningModelType {
  if (quality === 'hrtf') return 'HRTF';
  if (quality === 'equalpower') return 'equalpower';
  return activeSources <= budget ? 'HRTF' : 'equalpower';
}

/**
 * The WebAudio distance-gain curves, reimplemented exactly so gameplay code can
 * predict audibility (e.g. "is the SM-01 loud enough to hear from the tent?")
 * without a live AudioContext.
 */
export function computeDistanceGain(
  distance: number,
  options: Pick<SpatialOptions, 'distanceModel' | 'refDistance' | 'maxDistance' | 'rolloffFactor'>,
): number {
  const ref = Math.max(options.refDistance, 1e-6);
  const max = Math.max(options.maxDistance, ref + 1e-6);
  const rolloff = Math.max(options.rolloffFactor, 0);
  const d = Math.max(distance, 0);

  switch (options.distanceModel) {
    case 'linear': {
      const clamped = clamp(d, ref, max);
      return clamp01(1 - (rolloff * (clamped - ref)) / (max - ref));
    }
    case 'exponential': {
      return clamp01(Math.pow(Math.max(d, ref) / ref, -rolloff));
    }
    case 'inverse':
    default: {
      return clamp01(ref / (ref + rolloff * (Math.max(d, ref) - ref)));
    }
  }
}

export function distanceBetween(a: Vec3, b: Vec3): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/** Normalise into `out` (may alias `v`). Returns `out`; a zero vector becomes (0,0,-1). */
export function normalizeVec3(v: Vec3, out: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z);
  if (len < 1e-9) {
    out.x = 0;
    out.y = 0;
    out.z = -1;
    return out;
  }
  out.x = v.x / len;
  out.y = v.y / len;
  out.z = v.z / len;
  return out;
}

export function crossVec3(a: Vec3, b: Vec3, out: Vec3): Vec3 {
  const x = a.y * b.z - a.z * b.y;
  const y = a.z * b.x - a.x * b.z;
  const z = a.x * b.y - a.y * b.x;
  out.x = x;
  out.y = y;
  out.z = z;
  return out;
}

export function dotVec3(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z;
}

/**
 * Gram-Schmidt the listener basis: WebAudio requires forward and up to be
 * orthonormal, and a camera matrix straight out of a 3D engine usually is not
 * once it has been through a lerp.
 */
export function orthonormalizeBasis(forward: Vec3, up: Vec3, outForward: Vec3, outUp: Vec3): void {
  normalizeVec3(forward, outForward);
  const dot = dotVec3(up, outForward);
  outUp.x = up.x - outForward.x * dot;
  outUp.y = up.y - outForward.y * dot;
  outUp.z = up.z - outForward.z * dot;
  if (Math.abs(outUp.x) + Math.abs(outUp.y) + Math.abs(outUp.z) < 1e-9) {
    outUp.x = 0;
    outUp.y = 1;
    outUp.z = 0;
  } else {
    normalizeVec3(outUp, outUp);
  }
}

const scratchForward: Vec3 = { x: 0, y: 0, z: -1 };
const scratchUp: Vec3 = { x: 0, y: 1, z: 0 };

/**
 * Push the listener transform onto the context. Handles both the modern
 * AudioParam listener and the deprecated `setPosition`/`setOrientation` pair
 * that Firefox and older Safari still expose.
 */
export function updateListener(
  ctx: BaseAudioContext,
  position: Vec3,
  forward: Vec3,
  up: Vec3,
  smoothingSeconds = 0.02,
): void {
  const listener = ctx.listener as AudioListener & {
    setPosition?: (x: number, y: number, z: number) => void;
    setOrientation?: (fx: number, fy: number, fz: number, ux: number, uy: number, uz: number) => void;
  };
  orthonormalizeBasis(forward, up, scratchForward, scratchUp);
  const now = ctx.currentTime;
  const tc = Math.max(smoothingSeconds, 1e-3);

  if (listener.positionX && typeof listener.positionX.setTargetAtTime === 'function') {
    listener.positionX.setTargetAtTime(position.x, now, tc);
    listener.positionY.setTargetAtTime(position.y, now, tc);
    listener.positionZ.setTargetAtTime(position.z, now, tc);
    listener.forwardX.setTargetAtTime(scratchForward.x, now, tc);
    listener.forwardY.setTargetAtTime(scratchForward.y, now, tc);
    listener.forwardZ.setTargetAtTime(scratchForward.z, now, tc);
    listener.upX.setTargetAtTime(scratchUp.x, now, tc);
    listener.upY.setTargetAtTime(scratchUp.y, now, tc);
    listener.upZ.setTargetAtTime(scratchUp.z, now, tc);
    return;
  }

  listener.setPosition?.(position.x, position.y, position.z);
  listener.setOrientation?.(
    scratchForward.x,
    scratchForward.y,
    scratchForward.z,
    scratchUp.x,
    scratchUp.y,
    scratchUp.z,
  );
}

/**
 * One positioned sound source. `input` is the node everything connects into;
 * the panner and its options live behind it.
 */
export class SpatialEmitter {
  readonly input: GainNode;
  readonly panner: PannerNode;
  private streamSource: MediaStreamAudioSourceNode | null = null;
  private disposed = false;

  constructor(
    private readonly ctx: BaseAudioContext,
    destination: AudioNode,
    options: Partial<SpatialOptions> = {},
    activeSources = 0,
  ) {
    const opts: SpatialOptions = { ...DEFAULT_SPATIAL_OPTIONS, ...options };
    this.input = ctx.createGain();
    this.panner = ctx.createPanner();
    this.panner.panningModel = choosePanningModel(opts.panningModel, activeSources);
    this.panner.distanceModel = opts.distanceModel;
    this.panner.refDistance = opts.refDistance;
    this.panner.maxDistance = opts.maxDistance;
    this.panner.rolloffFactor = opts.rolloffFactor;
    this.panner.coneInnerAngle = opts.coneInnerAngle;
    this.panner.coneOuterAngle = opts.coneOuterAngle;
    this.panner.coneOuterGain = opts.coneOuterGain;
    this.input.connect(this.panner);
    this.panner.connect(destination);
  }

  setPosition(x: number, y: number, z: number, smoothingSeconds = 0.03): void {
    const now = this.ctx.currentTime;
    const tc = Math.max(smoothingSeconds, 1e-3);
    const panner = this.panner as PannerNode & { setPosition?: (x: number, y: number, z: number) => void };
    if (panner.positionX && typeof panner.positionX.setTargetAtTime === 'function') {
      panner.positionX.setTargetAtTime(x, now, tc);
      panner.positionY.setTargetAtTime(y, now, tc);
      panner.positionZ.setTargetAtTime(z, now, tc);
    } else {
      panner.setPosition?.(x, y, z);
    }
  }

  setOrientation(x: number, y: number, z: number): void {
    const panner = this.panner as PannerNode & {
      setOrientation?: (x: number, y: number, z: number) => void;
    };
    if (panner.orientationX && typeof panner.orientationX.setValueAtTime === 'function') {
      const now = this.ctx.currentTime;
      panner.orientationX.setValueAtTime(x, now);
      panner.orientationY.setValueAtTime(y, now);
      panner.orientationZ.setValueAtTime(z, now);
    } else {
      panner.setOrientation?.(x, y, z);
    }
  }

  setGain(gain: number, smoothingSeconds = 0.02): void {
    this.input.gain.setTargetAtTime(Math.max(gain, 0), this.ctx.currentTime, Math.max(smoothingSeconds, 1e-3));
  }

  /** Feed any node through this emitter's position. */
  attach(node: AudioNode): void {
    node.connect(this.input);
  }

  /**
   * Route a remote player's microphone through this emitter. The same panner,
   * distance model and listener basis then apply to voice and to world sound,
   * which is the point of routing everything through `SpatialEmitter`.
   */
  attachMediaStream(stream: MediaStream): MediaStreamAudioSourceNode | null {
    const ctx = this.ctx as BaseAudioContext & {
      createMediaStreamSource?: (stream: MediaStream) => MediaStreamAudioSourceNode;
    };
    if (typeof ctx.createMediaStreamSource !== 'function') return null;
    this.detachMediaStream();
    const source = ctx.createMediaStreamSource(stream);
    source.connect(this.input);
    this.streamSource = source;
    return source;
  }

  detachMediaStream(): void {
    if (!this.streamSource) return;
    try {
      this.streamSource.disconnect();
    } catch {
      /* already detached */
    }
    this.streamSource = null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.detachMediaStream();
    try {
      this.input.disconnect();
      this.panner.disconnect();
    } catch {
      /* already detached */
    }
  }
}
