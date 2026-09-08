/**
 * What the camera does that the player did not ask for.
 *
 * The camera is the player's own eyes and has been since the composed shots
 * were removed — it does not fly anywhere, it does not lag its own head, and
 * nothing here changes that. What it did do until now is *nothing at all*: the
 * eye sat exactly on `eyePosition(player)` and pointed exactly along
 * `lookDirection(player)`, which is correct and completely inert. Standing
 * still produced a frozen frame, walking produced a dolly on rails, and
 * turning to look at something happened as though the head had no weight.
 *
 * A body has weight. This is the small amount of it a first-person camera can
 * carry without becoming a rollercoaster:
 *
 * - **Bob.** The head rises and falls twice per stride and swings side to side
 *   once, which is what walking does. Tied to distance travelled rather than
 *   to time, so it slows when you slow and stops when you stop instead of
 *   sliding on underneath a stationary body.
 * - **Roll into the turn.** Turning your head fast tips it slightly. This is
 *   the single biggest difference between a camera that feels attached to
 *   somebody and one that feels like a tripod on wheels.
 * - **Strafe lean.** Sidestepping leans the same way.
 * - **Footfalls.** A small dip at the bottom of each stride, so the walk has a
 *   beat rather than a hum.
 * - **Breath.** A very slow sway that never stops, so a still frame is still
 *   alive. Small enough to be deniable and the thing you would miss most.
 * - **Impulses.** A decaying shake something else can kick: a log dropped on
 *   the fire, thunder, the SM-01's lever going over.
 * - **Lens.** A couple of degrees of extra field of view with speed, which
 *   reads as effort.
 *
 * **All of it scales to exactly zero under reduced motion** (spec §12). That is
 * not a courtesy: head bob is the single most reliable way to make somebody
 * motion-sick, and a game that cannot be turned off is a game some people
 * cannot play. The `scale` argument is applied to every term, and the tests
 * assert that at zero this module is bit-for-bit the old inert camera.
 *
 * Pure and frameless: in go numbers, out come offsets. Nothing here touches
 * three.js, and the whole feel is therefore unit-testable without a browser.
 */

/** Millimetre-scale numbers, because that is the honest size of all of this. */
const BOB_VERTICAL = 0.021;
const BOB_LATERAL = 0.014;
/** Metres of stride. Two vertical bobs per stride, one lateral. */
const STRIDE = 1.55;
/** Radians of roll at a full-speed turn, and how fast it follows. */
const TURN_ROLL = 0.075;
const STRAFE_ROLL = 0.045;
const ROLL_FOLLOW = 5.5;
/** Breath: amplitude in metres and radians, and its period in seconds. */
const BREATH_RISE = 0.0075;
const BREATH_ROLL = 0.0045;
const BREATH_PERIOD = 5.4;
/** How fast an impulse dies. */
const IMPULSE_DECAY = 7.5;
/** Degrees of extra lens at full sprint. */
const SPEED_FOV = 2.6;

export interface CameraMotion {
  /** Distance walked, which is what the bob is a function of. */
  travelled: number;
  /** Seconds elapsed, for the breath only. */
  elapsed: number;
  /** Current roll, eased toward its target so a flick of the look does not snap. */
  roll: number;
  /** Remaining shake, 0..1, decaying. */
  impulse: number;
  /** A stable per-impulse seed so a shake is not a different shape every frame. */
  impulsePhase: number;
  /** Smoothed speed, so the lens does not twitch. */
  lensSpeed: number;
  /** Which stride the last footfall was on, so the dip fires once per step. */
  lastStep: number;
}

export function createCameraMotion(): CameraMotion {
  return {
    travelled: 0,
    elapsed: 0,
    roll: 0,
    impulse: 0,
    impulsePhase: 0,
    lensSpeed: 0,
    lastStep: 0,
  };
}

export interface MotionInput {
  /** Metres per second along the ground. */
  readonly speed: number;
  /** Radians per second the head is turning. Signed. */
  readonly turnRate: number;
  /** -1 full left to +1 full right, from the movement intent, not the velocity. */
  readonly strafe: number;
  /** True while seated or lying back: a settled body barely moves. */
  readonly settled: boolean;
  /** 0 disables every term. Reduced motion sets this to 0 (spec §12). */
  readonly scale: number;
}

export interface MotionOffset {
  /** Metres along the camera's own right vector. */
  readonly right: number;
  /** Metres along world up. */
  readonly up: number;
  /** Metres along the camera's own forward vector. */
  readonly forward: number;
  /** Radians of roll about the view axis. */
  readonly roll: number;
  /** Degrees to add to the field of view. */
  readonly fov: number;
  /** True on the frame a stride bottoms out, for the footstep sound. */
  readonly footfall: boolean;
}

const STILL: MotionOffset = { right: 0, up: 0, forward: 0, roll: 0, fov: 0, footfall: false };

/**
 * Kicks the camera. `strength` is 0..1; anything above about 0.4 is a lot.
 *
 * Deliberately additive and clamped rather than assigned, so two things
 * happening at once are felt as one bigger event and neither cancels the
 * other — but a hundred of them cannot stack into a seizure.
 */
export function shakeCamera(motion: CameraMotion, strength: number): void {
  const kick = Math.max(0, Math.min(1, strength));
  if (kick <= 0) return;
  // A fresh phase only when the shake had substantially died, so a rapid
  // sequence reads as one continuous event rather than as re-rolled noise.
  if (motion.impulse < 0.15) motion.impulsePhase = (motion.impulsePhase + 1.618) % 1000;
  motion.impulse = Math.min(1, motion.impulse + kick);
}

/**
 * Advances the motion and returns this frame's offset.
 *
 * `dt` is real seconds, not simulation steps: this is presentation, it has no
 * business being deterministic, and tying it to the fixed timestep would make
 * the bob speed up on a fast machine.
 */
export function stepCameraMotion(
  motion: CameraMotion,
  input: MotionInput,
  dt: number,
): MotionOffset {
  const scale = Math.max(0, Math.min(1, input.scale));
  const step = Math.max(0, Math.min(0.1, dt));

  const speed = Math.max(0, input.speed);
  motion.travelled += speed * step;
  motion.elapsed += step;
  motion.lensSpeed += (speed - motion.lensSpeed) * Math.min(1, step * 4);
  motion.impulse = Math.max(0, motion.impulse - motion.impulse * IMPULSE_DECAY * step);

  /*
   * Roll follows the turn rather than tracking it exactly, so whipping the
   * view round leans in and then settles, which is what a neck does. Eased
   * both ways at the same rate — a lean that snaps back is a flinch.
   */
  const settle = input.settled ? 0.25 : 1;
  const targetRoll =
    (-clamp(input.turnRate / 2.2, -1, 1) * TURN_ROLL -
      clamp(input.strafe, -1, 1) * STRAFE_ROLL) *
    settle;
  motion.roll += (targetRoll - motion.roll) * Math.min(1, step * ROLL_FOLLOW);

  if (scale === 0) {
    // Reduced motion is not "less bob", it is none. Everything above still
    // advances so that turning it back on mid-session does not jump.
    return STILL;
  }

  // --- Walking ------------------------------------------------------------
  // Phase in strides. Two vertical bobs per stride, one lateral, so the head
  // traces a flattened figure eight — which is what a head does.
  const stride = (motion.travelled / STRIDE) * Math.PI * 2;
  const moving = Math.min(1, speed / 1.4) * (input.settled ? 0 : 1);
  const bobUp = Math.sin(stride * 2) * BOB_VERTICAL * moving;
  const bobRight = Math.sin(stride) * BOB_LATERAL * moving;

  // A stride bottoms out when the vertical term passes its minimum. Reported
  // rather than acted on, so the audio layer can put a footstep exactly there.
  const strideIndex = Math.floor(motion.travelled / (STRIDE / 2));
  const footfall = moving > 0.25 && strideIndex !== motion.lastStep;
  if (footfall) motion.lastStep = strideIndex;

  // --- Breath -------------------------------------------------------------
  // Never stops, and is the only term that survives sitting down.
  const breath = (motion.elapsed / BREATH_PERIOD) * Math.PI * 2;
  const breathUp = Math.sin(breath) * BREATH_RISE * (input.settled ? 0.55 : 1);
  const breathRoll = Math.sin(breath * 0.5 + 1.1) * BREATH_ROLL;

  // --- Impulse ------------------------------------------------------------
  // Two incommensurable frequencies so a shake does not read as a wobble, and
  // squared decay so it lands hard and leaves quickly.
  const kick = motion.impulse * motion.impulse;
  const phase = motion.impulsePhase;
  const shakeRight = Math.sin(motion.elapsed * 47 + phase) * 0.05 * kick;
  const shakeUp = Math.sin(motion.elapsed * 61 + phase * 1.7) * 0.042 * kick;
  const shakeRoll = Math.sin(motion.elapsed * 39 + phase * 2.3) * 0.05 * kick;

  return {
    right: (bobRight + shakeRight) * scale,
    up: (bobUp + breathUp + shakeUp) * scale,
    // A touch of forward lean with speed. Tiny — it is the difference between
    // walking and being pushed.
    forward: Math.min(1, motion.lensSpeed / 1.6) * 0.012 * scale,
    roll: (motion.roll + breathRoll + shakeRoll) * scale,
    fov: Math.min(1, motion.lensSpeed / 1.8) * SPEED_FOV * scale,
    footfall,
  };
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}
