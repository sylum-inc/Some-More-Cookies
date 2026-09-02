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

import { vec3, type RitualState, type Vec3 } from '@somemore/sim';

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
  /**
   * How far past the end of the band you must keep pulling to take the
   * marshmallow off the fire, in band units.
   *
   * Taking it to the plate used to be a button in the corner of the screen,
   * which is the same species of thing as the "Roast" button the product
   * exists to not have (spec §1.3). It is a pull: the stick comes back out of
   * the heat and away, which is what a hand does. The band's outer end is the
   * edge of the fire, so anything beyond it is already off the fire.
   *
   * 0.35 of the band is about a hundred pixels of drag past the end — far
   * enough that cooling a marshmallow by drawing it back cannot finish the
   * roast by accident, short enough that it never feels like a fight.
   */
  withdrawToPlate: number;
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
  withdrawToPlate: 0.35,
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
  /** How far past the end of the band the stick has been pulled, band units. */
  private overshoot = 0;
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
    const raw = this.startPositionAtDrag + (dy * this.config.radiusPerPixel) / radiusRange;
    this.position = clamp01(raw);
    // Kept rather than discarded by the clamp: past the end of the band the
    // stick is off the fire and on its way to the plate.
    this.overshoot = Math.max(0, raw - 1);
    this.rotation = this.startRotationAtDrag + dx * this.config.rotationPerPixel;
  }

  end(): void {
    this.dragging = false;
    // A pull that stopped short springs back. Only a pull carried all the way
    // through takes the marshmallow off the fire, and `withdrawProgress` is
    // read while the hand is still moving.
    this.overshoot = 0;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  /** Rotates without moving — used by the automatic-rotation assist. */
  addRotation(delta: number): void {
    this.rotation += delta;
    this.startRotationAtDrag += delta;
  }

  /**
   * Moves along the band directly — used by keyboard and gamepad input.
   *
   * Past the end of the band the surplus accumulates as overshoot, so holding
   * the "further away" key keeps pulling the stick back exactly as a drag
   * does, and reaches the plate the same way. No extra key, and no second
   * mechanism to keep in step with the first.
   */
  nudge(positionDelta: number, rotationDelta: number): void {
    const raw = this.position + this.overshoot + positionDelta;
    this.position = clamp01(raw);
    this.overshoot = Math.max(0, raw - 1);
    this.rotation += rotationDelta;
    this.startPositionAtDrag = this.position;
    this.startRotationAtDrag = this.rotation;
  }

  /**
   * 0 while the marshmallow is over the fire, 1 when it has been pulled far
   * enough back to be on its way to the plate.
   *
   * Reported rather than acted on, so the interface can say what is happening
   * while it happens — a pull that silently completes is indistinguishable
   * from a slip.
   */
  get withdrawProgress(): number {
    return clamp01(this.overshoot / this.config.withdrawToPlate);
  }

  /** Puts the stick back over the fire, after a withdraw was acted on. */
  resetWithdraw(): void {
    this.overshoot = 0;
  }

  setBearing(bearing: number): void {
    this.bearing = bearing;
  }

  /** Current world pose of the marshmallow, with the fire pit at the origin. */
  pose(out: RoastPose = { position: vec3(), rotation: 0, proximity: 0 }): RoastPose {
    const c = this.config;
    const range = c.maxRadius - c.minRadius;
    // The overshoot moves the marshmallow too, or a pull toward the plate is a
    // number changing with nothing happening on screen.
    const extended = this.position + this.overshoot;
    const radius = c.minRadius + range * extended;
    // Held higher when further out — the natural arc of an arm.
    const height = c.minHeight + (c.maxHeight - c.minHeight) * extended;
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

/** Scratch pose, so sampling the controller allocates nothing per frame. */
const SAMPLE: RoastPose = { position: vec3(), rotation: 0, proximity: 0 };

/**
 * Writes the controller's current pose into the ritual's roast input.
 *
 * Called from the frame loop, because the bearing changes as the player walks
 * round the fire — and called *again* the instant a key is pressed, which is
 * the part that matters. A drag is continuous, so sampling it a frame late
 * costs nothing; a key press is a discrete act, and on a device rendering
 * slowly the presses between two frames collapse into one. That is not a
 * hypothetical: under software rendering the roasting close-up runs at about
 * 1.5 frames a second, and twenty-four presses of the turn key browned the
 * marshmallow on one face, because the simulation stepped sixty times a second
 * against an input sampled once. The keyboard path is the accessibility
 * alternative to the drag (spec §12), so the players it is for are exactly the
 * ones most likely to be on the slow device.
 */
export function applyRoastPose(
  control: RoastController,
  ritual: RitualState,
  bearing: number,
  applyRotation: boolean,
): void {
  control.setBearing(bearing);
  const pose = control.pose(SAMPLE);
  ritual.roastInput.position.x = pose.position.x;
  ritual.roastInput.position.y = pose.position.y;
  ritual.roastInput.position.z = pose.position.z;
  // The automatic-rotation assist owns the rotation when it is switched on;
  // overwriting it here would fight the assist every frame.
  if (applyRotation) ritual.roastInput.rotation = pose.rotation;
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
