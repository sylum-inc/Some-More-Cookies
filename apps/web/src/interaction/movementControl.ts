/**
 * Movement input mapping (spec §Technical Direction).
 *
 * "Default mobile exploration can use tap-to-move + drag-to-look with
 * contextual direct manipulation, with optional virtual joystick +
 * swipe-to-look."
 *
 * The hard part is that one finger has to serve both: a tap means "walk
 * there", a drag means "look around", and the difference is only knowable
 * after the fact. This resolves it the way good touch interfaces do — by
 * distance and time, committing to look as soon as the finger travels far
 * enough, and to a tap only if the finger lifts before that.
 *
 * Pure and DOM-free so it can be unit tested headlessly.
 */

export interface MovementControlConfig {
  /** Pixels of travel before a press becomes a look-drag rather than a tap. */
  dragThreshold: number;
  /** Milliseconds after which a stationary press is a hold, not a tap. */
  tapMaxDuration: number;
  /** Radians of yaw per pixel dragged. */
  lookSensitivityX: number;
  /** Radians of pitch per pixel dragged. */
  lookSensitivityY: number;
  /** Invert vertical look. */
  invertY: boolean;
  /** Dead zone of the virtual joystick, in pixels. */
  joystickDeadZone: number;
  /** Radius at which the joystick reads full deflection. */
  joystickRadius: number;
}

export const DEFAULT_MOVEMENT_CONTROL: MovementControlConfig = {
  dragThreshold: 11,
  tapMaxDuration: 420,
  lookSensitivityX: 0.0042,
  lookSensitivityY: 0.0034,
  invertY: false,
  joystickDeadZone: 8,
  joystickRadius: 62,
};

export type GestureKind = 'none' | 'undecided' | 'look' | 'joystick';

export interface LookDelta {
  yaw: number;
  pitch: number;
}

/** Emitted when a press resolves to a tap rather than a drag. */
export interface TapResult {
  x: number;
  y: number;
}

export class MovementController {
  private readonly config: MovementControlConfig;
  private kind: GestureKind = 'none';
  private startX = 0;
  private startY = 0;
  private startTime = 0;
  private lastX = 0;
  private lastY = 0;
  private travelled = 0;
  /** Joystick origin, set on press when joystick mode is active. */
  private joystickOriginX = 0;
  private joystickOriginY = 0;
  private joystickX = 0;
  private joystickY = 0;

  /** When true, a press starts a virtual joystick instead of a look-drag. */
  useJoystick = false;

  constructor(config: Partial<MovementControlConfig> = {}) {
    this.config = { ...DEFAULT_MOVEMENT_CONTROL, ...config };
  }

  get gesture(): GestureKind {
    return this.kind;
  }

  begin(x: number, y: number, timeMs: number): void {
    this.startX = x;
    this.startY = y;
    this.lastX = x;
    this.lastY = y;
    this.startTime = timeMs;
    this.travelled = 0;
    if (this.useJoystick) {
      this.kind = 'joystick';
      this.joystickOriginX = x;
      this.joystickOriginY = y;
      this.joystickX = 0;
      this.joystickY = 0;
    } else {
      // Undecided until the finger either travels or lifts.
      this.kind = 'undecided';
    }
  }

  /** Returns a look delta when the gesture is (or becomes) a look-drag. */
  move(x: number, y: number): LookDelta | null {
    if (this.kind === 'none') return null;

    if (this.kind === 'joystick') {
      this.joystickX = x - this.joystickOriginX;
      this.joystickY = y - this.joystickOriginY;
      return null;
    }

    const dx = x - this.lastX;
    const dy = y - this.lastY;
    this.travelled += Math.hypot(dx, dy);
    this.lastX = x;
    this.lastY = y;

    if (this.kind === 'undecided') {
      if (Math.hypot(x - this.startX, y - this.startY) < this.config.dragThreshold) return null;
      this.kind = 'look';
      // Fall through: the frame that crosses the threshold should still turn,
      // otherwise the view snags at the start of every drag.
    }

    return {
      yaw: dx * this.config.lookSensitivityX,
      pitch: (this.config.invertY ? dy : -dy) * this.config.lookSensitivityY,
    };
  }

  /**
   * Ends the gesture. Returns a tap when the press was short and stationary,
   * otherwise null.
   */
  end(timeMs: number): TapResult | null {
    const kind = this.kind;
    this.kind = 'none';
    this.joystickX = 0;
    this.joystickY = 0;
    if (kind !== 'undecided') return null;
    if (timeMs - this.startTime > this.config.tapMaxDuration) return null;
    if (this.travelled >= this.config.dragThreshold) return null;
    return { x: this.startX, y: this.startY };
  }

  cancel(): void {
    this.kind = 'none';
    this.joystickX = 0;
    this.joystickY = 0;
  }

  /**
   * Current joystick deflection as forward/strafe in -1..1, ready to hand to
   * the simulation's `MoveIntent`.
   */
  joystick(): { forward: number; strafe: number } {
    if (this.kind !== 'joystick') return { forward: 0, strafe: 0 };
    const distance = Math.hypot(this.joystickX, this.joystickY);
    if (distance <= this.config.joystickDeadZone) return { forward: 0, strafe: 0 };
    const usable = Math.min(1, (distance - this.config.joystickDeadZone) / (this.config.joystickRadius - this.config.joystickDeadZone));
    const scale = usable / distance;
    return {
      // Screen up is forward; screen right is strafe right.
      forward: -this.joystickY * scale,
      strafe: this.joystickX * scale,
    };
  }

  /** Where to draw the joystick, or null when it is not active. */
  joystickVisual(): { originX: number; originY: number; knobX: number; knobY: number } | null {
    if (this.kind !== 'joystick') return null;
    const distance = Math.hypot(this.joystickX, this.joystickY);
    const clamped = distance > this.config.joystickRadius ? this.config.joystickRadius / distance : 1;
    return {
      originX: this.joystickOriginX,
      originY: this.joystickOriginY,
      knobX: this.joystickOriginX + this.joystickX * clamped,
      knobY: this.joystickOriginY + this.joystickY * clamped,
    };
  }
}

/**
 * Keyboard movement as an alternate control scheme (spec §12).
 *
 * Tracked as a set of held keys so diagonal movement works and so releasing
 * one key of two does not stop the player dead.
 */
export class KeyboardMovement {
  private readonly held = new Set<string>();

  down(key: string): void {
    this.held.add(normaliseKey(key));
  }

  up(key: string): void {
    this.held.delete(normaliseKey(key));
  }

  clear(): void {
    this.held.clear();
  }

  get active(): boolean {
    return this.held.size > 0;
  }

  /** Forward/strafe in -1..1, normalised so diagonals are not faster. */
  intent(): { forward: number; strafe: number } {
    let forward = 0;
    let strafe = 0;
    if (this.held.has('w')) forward += 1;
    if (this.held.has('s')) forward -= 1;
    if (this.held.has('d')) strafe += 1;
    if (this.held.has('a')) strafe -= 1;
    const magnitude = Math.hypot(forward, strafe);
    if (magnitude > 1) {
      forward /= magnitude;
      strafe /= magnitude;
    }
    return { forward, strafe };
  }

  /**
   * Yaw and pitch *rate* from the arrow keys, radians per second.
   *
   * The arrows used to duplicate WASD, which meant a keyboard player could
   * translate around the campsite and never change which way they were facing:
   * `player.facing` only ever moves from a pointer look delta or from walking
   * toward a tapped point, so on the keyboard alone you could not look at the
   * sky, aim the torch, face the water to fish, or look at an animal. Every
   * one of §5.2's activities was behind a pointer.
   *
   * So the arrows look. This removes a duplication rather than adding a
   * binding, and it is the conventional split. Every other arrow-key meaning
   * in the product — the roasting nudge, the assembly nudge, the stone's
   * wind-up — belongs to an anchored stage, where walking and looking are both
   * already off.
   *
   * Yaw is faster than pitch because there is a great deal more world sideways
   * than there is up, and pitch is clamped by the simulation anyway.
   */
  look(): { yaw: number; pitch: number } {
    let yaw = 0;
    let pitch = 0;
    if (this.held.has('arrowright')) yaw -= LOOK_KEY_YAW_RATE;
    if (this.held.has('arrowleft')) yaw += LOOK_KEY_YAW_RATE;
    if (this.held.has('arrowup')) pitch += LOOK_KEY_PITCH_RATE;
    if (this.held.has('arrowdown')) pitch -= LOOK_KEY_PITCH_RATE;
    return { yaw, pitch };
  }
}

/**
 * A full turn in about three and a half seconds held, which is brisk enough to
 * follow a fox and slow enough to aim a torch.
 */
export const LOOK_KEY_YAW_RATE = 1.8;
/** The pitch range is only 1.4 rad end to end, so this crosses it in a second. */
export const LOOK_KEY_PITCH_RATE = 1.4;

function normaliseKey(key: string): string {
  return key.length === 1 ? key.toLowerCase() : key.toLowerCase();
}

/**
 * Finds where a screen ray meets the ground.
 *
 * Marched against the terrain *height function* rather than raycast against
 * the terrain mesh, so the point you tap and the point the simulation walks
 * to are computed the same way and cannot drift apart. Coarse march to find
 * the crossing, then a short bisection to land on it.
 */
export function marchToGround(
  originX: number,
  originY: number,
  originZ: number,
  dirX: number,
  dirY: number,
  dirZ: number,
  heightAt: (x: number, z: number) => number,
  maxDistance = 60,
): { x: number; y: number; z: number } | null {
  // Looking up at the sky never hits the ground.
  if (dirY >= -0.001) return null;

  const step = 0.35;
  let previous = 0;
  let previousGap = originY - heightAt(originX, originZ);
  for (let travelled = step; travelled <= maxDistance; travelled += step) {
    const x = originX + dirX * travelled;
    const y = originY + dirY * travelled;
    const z = originZ + dirZ * travelled;
    const gap = y - heightAt(x, z);
    if (gap <= 0) {
      // Bisect between the last point above ground and this one below it.
      let low = previous;
      let high = travelled;
      for (let i = 0; i < 24; i++) {
        const mid = (low + high) / 2;
        const mx = originX + dirX * mid;
        const my = originY + dirY * mid;
        const mz = originZ + dirZ * mid;
        if (my - heightAt(mx, mz) > 0) low = mid;
        else high = mid;
      }
      const hit = (low + high) / 2;
      return {
        x: originX + dirX * hit,
        y: originY + dirY * hit,
        z: originZ + dirZ * hit,
      };
    }
    previous = travelled;
    previousGap = gap;
  }
  void previousGap;
  return null;
}
