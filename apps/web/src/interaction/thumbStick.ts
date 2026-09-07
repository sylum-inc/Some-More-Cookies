/**
 * The thumb pad, as arithmetic.
 *
 * `movementControl.ts` already carries a virtual joystick, and it is invisible
 * and floating: it starts wherever the finger happens to land on the canvas,
 * behind an accessibility toggle nobody turns on. That is a defensible design
 * and it is not the one this product is being asked for. A drawn pad in the
 * bottom-left corner is the single most recognisable thing about a phone game
 * of this shape — you can see the control before you touch it, and it is in the
 * same place every time.
 *
 * The vector lives here rather than in the component so that the parts worth
 * getting wrong — the dead zone, the clamp, which way is forward — can be
 * tested without a browser.
 */

/** How far the knob travels from the centre before the reading saturates. */
export const STICK_RADIUS_PX = 52;

/**
 * Slack at the centre.
 *
 * A thumb resting on a pad is never exactly at its middle, and without this
 * every touch would be a slow walk in whatever direction the thumb happened to
 * be leaning. Small, because a large dead zone on a small pad costs most of
 * the pad.
 */
export const STICK_DEAD_ZONE_PX = 5;

export interface StickReading {
  /** Forward/back in -1..1. Positive is away from the player. */
  readonly forward: number;
  /** Strafe in -1..1. Positive is to the player's right. */
  readonly strafe: number;
  /** Where to draw the knob, in pixels from the pad's centre. */
  readonly knobX: number;
  readonly knobY: number;
}

const STILL: StickReading = { forward: 0, strafe: 0, knobX: 0, knobY: 0 };

/**
 * Reads the pad from the thumb's offset from its centre, in CSS pixels.
 *
 * `dy` is screen-space, so it grows downward; forward is up the screen, which
 * is why it is negated. Getting that backwards is the kind of thing that is
 * obvious the first time you play it and invisible in a diff, so it has a test.
 */
export function readStick(
  dx: number,
  dy: number,
  radius: number = STICK_RADIUS_PX,
  deadZone: number = STICK_DEAD_ZONE_PX,
): StickReading {
  const distance = Math.hypot(dx, dy);
  if (!Number.isFinite(distance) || distance <= deadZone) return STILL;

  const unitX = dx / distance;
  const unitY = dy / distance;
  // Clamped so that dragging a thumb clean off the pad is full speed rather
  // than an ever-increasing number, and re-based past the dead zone so the
  // first millimetre of real travel is the slowest walk rather than a jump.
  const reach = Math.min(distance, radius);
  const travel = Math.min(1, (reach - deadZone) / Math.max(1e-6, radius - deadZone));

  return {
    forward: -unitY * travel,
    strafe: unitX * travel,
    knobX: unitX * reach,
    knobY: unitY * reach,
  };
}
