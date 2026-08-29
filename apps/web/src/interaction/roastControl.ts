/**
 * Roasting input mapping (spec §4.2).
 *
 * "The player moves the marshmallow closer/farther from the fire and rotates
 * it manually." On touch this must be *one continuous drag* controlling both
 * axes, because asking a thumb to operate two separate controls over a fire is
 * exactly the fiddliness the spec warns about (risk R7).
 *
 * Mapping: vertical drag = distance from the heat, horizontal drag = rotation
 * about the stick. Both are relative to where the drag started, so the
 * marshmallow never jumps when a finger lands.
 *
 * Pure and DOM-free so it can be unit tested headlessly.
 */

import { vec3, type Vec3 } from '@somemore/sim';

export interface RoastControlConfig {
  /** Closest the marshmallow can get to the fire centre, metres. */
  minRadius: number;
  /** Furthest, metres. */
  maxRadius: number;
  /** Height above the ground at the closest radius. */
  minHeight: number;
  /** Height at the furthest radius. */
  maxHeight: number;
  /** Metres of radius change per pixel of vertical drag. */
  radiusPerPixel: number;
  /** Radians of rotation per pixel of horizontal drag. */
  rotationPerPixel: number;
  /** Where the marshmallow starts, as a 0..1 position along the radius band. */
  startPosition: number;
}

export const DEFAULT_ROAST_CONTROL: RoastControlConfig = {
  // Tuned against the measured heat field: the browning band sits around
  // 0.12-0.25 m, so the reachable range brackets it with room either side.
  minRadius: 0.07,
  maxRadius: 0.55,
  minHeight: 0.06,
  maxHeight: 0.3,
  radiusPerPixel: 0.0016,
  rotationPerPixel: 0.011,
  startPosition: 0.55,
};

export interface RoastPose {
  position: Vec3;
  rotation: number;
  /** 0..1 along the radius band — used for the non-numeric heat indicator. */
  proximity: number;
}

export class RoastController {
  private readonly config: RoastControlConfig;
  /** 0..1 along the band; 0 = closest to the fire. */
  private position: number;
  private rotation = 0;
  private dragging = false;
  private startX = 0;
  private startY = 0;
  private startPositionAtDrag = 0;
  private startRotationAtDrag = 0;
  /** Angle around the fire the player stands at. */
  private bearing: number;

  constructor(config: Partial<RoastControlConfig> = {}, bearing = 0) {
    this.config = { ...DEFAULT_ROAST_CONTROL, ...config };
    this.position = clamp01(this.config.startPosition);
    this.bearing = bearing;
  }

  begin(x: number, y: number): void {
    this.dragging = true;
    this.startX = x;
    this.startY = y;
    this.startPositionAtDrag = this.position;
    this.startRotationAtDrag = this.rotation;
  }

  move(x: number, y: number): void {
    if (!this.dragging) return;
    const dx = x - this.startX;
    const dy = y - this.startY;
    // Dragging *down* pulls the marshmallow back out of the fire, which is the
    // direction a real arm moves.
    const radiusRange = this.config.maxRadius - this.config.minRadius;
    this.position = clamp01(
      this.startPositionAtDrag + (dy * this.config.radiusPerPixel) / radiusRange,
    );
    this.rotation = this.startRotationAtDrag + dx * this.config.rotationPerPixel;
  }

  end(): void {
    this.dragging = false;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** Rotates without moving — used by the automatic-rotation assist. */
  addRotation(delta: number): void {
    this.rotation += delta;
    this.startRotationAtDrag += delta;
  }

  /** Moves along the band directly — used by keyboard and gamepad input. */
  nudge(positionDelta: number, rotationDelta: number): void {
    this.position = clamp01(this.position + positionDelta);
    this.rotation += rotationDelta;
    this.startPositionAtDrag = this.position;
    this.startRotationAtDrag = this.rotation;
  }

  setBearing(bearing: number): void {
    this.bearing = bearing;
  }

  /** Current world pose of the marshmallow, with the fire pit at the origin. */
  pose(out: RoastPose = { position: vec3(), rotation: 0, proximity: 0 }): RoastPose {
    const c = this.config;
    const radius = c.minRadius + (c.maxRadius - c.minRadius) * this.position;
    // Held higher when further out — the natural arc of an arm.
    const height = c.minHeight + (c.maxHeight - c.minHeight) * this.position;
    out.position.x = Math.cos(this.bearing) * radius;
    out.position.y = height;
    out.position.z = Math.sin(this.bearing) * radius;
    out.rotation = this.rotation;
    out.proximity = 1 - this.position;
    return out;
  }

  /** Total rotation applied so far, radians. */
  get totalRotation(): number {
    return this.rotation;
  }

  /** How far along the band, 0 = in the coals, 1 = well back. */
  get bandPosition(): number {
    return this.position;
  }
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/**
 * Maps a pointer position on screen to an assembly offset on the table plane.
 *
 * Kept separate from the 3D raycast so the mapping itself is testable and so
 * a keyboard or gamepad can drive the same path.
 */
export function screenToTableOffset(
  pointerX: number,
  pointerY: number,
  anchorX: number,
  anchorY: number,
  metresPerPixel = 0.00035,
): Vec3 {
  return vec3((pointerX - anchorX) * metresPerPixel, 0.01, (pointerY - anchorY) * metresPerPixel);
}

/**
 * Detects a blow-out gesture: a fast shake or a quick upward flick.
 *
 * Real blowing needs microphone permission, which must never be required
 * (spec §5.5 on permissions), so the gesture is the primary path and the mic
 * an optional enhancement.
 */
export class BlowGestureDetector {
  private samples: { x: number; t: number }[] = [];
  /**
   * -Infinity, not 0: a zero start makes the detector inert for the first
   * 900 ms of whatever timebase is passed in, which silently breaks blow-out
   * for anyone who shakes early.
   */
  private lastTriggered = -Infinity;

  /** Feeds a pointer sample. Returns true when a blow-out is recognised. */
  sample(x: number, timeMs: number): boolean {
    this.samples.push({ x, t: timeMs });
    // Keep a 400 ms window.
    while (this.samples.length > 0 && timeMs - (this.samples[0] as { t: number }).t > 400) {
      this.samples.shift();
    }
    if (this.samples.length < 4) return false;
    if (timeMs - this.lastTriggered < 900) return false;

    // Count direction reversals — a shake, not a swipe.
    let reversals = 0;
    let travel = 0;
    for (let i = 2; i < this.samples.length; i++) {
      const a = this.samples[i - 2] as { x: number };
      const b = this.samples[i - 1] as { x: number };
      const c = this.samples[i] as { x: number };
      const d1 = b.x - a.x;
      const d2 = c.x - b.x;
      travel += Math.abs(d2);
      if (d1 * d2 < 0 && Math.abs(d1) > 6 && Math.abs(d2) > 6) reversals++;
    }
    if (reversals >= 2 && travel > 90) {
      this.lastTriggered = timeMs;
      this.samples.length = 0;
      return true;
    }
    return false;
  }

  reset(): void {
    this.samples.length = 0;
    this.lastTriggered = -Infinity;
  }
}
