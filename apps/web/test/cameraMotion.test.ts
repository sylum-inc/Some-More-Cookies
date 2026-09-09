import { describe, expect, it } from 'vitest';
import {
  createCameraMotion,
  shakeCamera,
  stepCameraMotion,
  type MotionInput,
} from '../src/scene/cameraMotion.js';

/**
 * The weight of a head.
 *
 * The camera has been the player's own eyes since the composed shots were
 * removed, and it was completely inert: standing still produced a frozen
 * frame, walking produced a dolly on rails, and turning happened as though the
 * head had no mass. These are about the small amount of body a first-person
 * camera can carry — and, more importantly, about the ceiling on it, because
 * head bob is the most reliable way there is to make somebody motion-sick.
 */

const WALK: MotionInput = { speed: 1.4, turnRate: 0, strafe: 0, settled: false, scale: 1 };
const STILL: MotionInput = { speed: 0, turnRate: 0, strafe: 0, settled: false, scale: 1 };

/** Runs a stretch of real time at sixty frames a second. */
function run(
  motion: ReturnType<typeof createCameraMotion>,
  input: MotionInput,
  seconds: number,
): ReturnType<typeof stepCameraMotion>[] {
  const frames = [];
  for (let i = 0; i < Math.round(seconds * 60); i++) {
    frames.push(stepCameraMotion(motion, input, 1 / 60));
  }
  return frames;
}

describe('reduced motion', () => {
  it('is none of it, not less of it', () => {
    /*
     * §12, and the reason this module is a separate pure file at all. A player
     * who has asked for reduced motion gets exactly the camera that existed
     * before any of this: the eye on `eyePosition`, pointing along
     * `lookDirection`, and nothing added.
     */
    const motion = createCameraMotion();
    shakeCamera(motion, 1);
    const frames = run(motion, { ...WALK, scale: 0, turnRate: 1.5, strafe: 1 }, 3);
    for (const frame of frames) {
      expect(frame.right).toBe(0);
      expect(frame.up).toBe(0);
      expect(frame.forward).toBe(0);
      expect(frame.roll).toBe(0);
      expect(frame.fov).toBe(0);
    }
  });

  it('does not jump when it is switched back on', () => {
    // The state keeps advancing while the offsets are suppressed, so a player
    // toggling the setting mid-session does not get a lurch.
    const off = createCameraMotion();
    run(off, { ...WALK, scale: 0 }, 2);
    const resumed = stepCameraMotion(off, WALK, 1 / 60);
    expect(Math.abs(resumed.up)).toBeLessThan(0.05);
    expect(Math.abs(resumed.roll)).toBeLessThan(0.05);
  });
});

describe('walking', () => {
  it('bobs, and stops bobbing when you stop', () => {
    const motion = createCameraMotion();
    const walking = run(motion, WALK, 3);
    const spread = (frames: { up: number }[]) =>
      Math.max(...frames.map((f) => f.up)) - Math.min(...frames.map((f) => f.up));
    expect(spread(walking), 'walking did not move the head at all').toBeGreaterThan(0.02);

    const standing = run(motion, STILL, 3);
    // Breath survives standing still; the stride does not.
    expect(spread(standing)).toBeLessThan(spread(walking) * 0.6);
  });

  it('is a function of distance walked, not of time', () => {
    /*
     * The bug this prevents: a bob on a timer keeps swinging under a body that
     * has stopped, and runs at the same rate whether you are strolling or
     * running. Half the speed, half the phase, in the same wall-clock second.
     */
    const fast = createCameraMotion();
    const slow = createCameraMotion();
    run(fast, { ...WALK, speed: 1.4 }, 1);
    run(slow, { ...WALK, speed: 0.7 }, 1);
    expect(slow.travelled).toBeCloseTo(fast.travelled / 2, 2);
  });

  it('reports a footfall once per half stride, and never while standing', () => {
    const motion = createCameraMotion();
    const walked = run(motion, WALK, 6).filter((f) => f.footfall).length;
    // Six seconds at 1.4 m/s is 8.4 m, which is about eleven half-strides.
    expect(walked).toBeGreaterThan(6);
    expect(walked).toBeLessThan(16);
    expect(run(motion, STILL, 6).filter((f) => f.footfall).length).toBe(0);
  });

  it('stays small enough to look through', () => {
    // The ceiling. Everything on at once — walking, turning hard, sidestepping,
    // freshly kicked — must still be a head and not a rollercoaster.
    const motion = createCameraMotion();
    shakeCamera(motion, 1);
    const frames = run(motion, { speed: 2.2, turnRate: 3, strafe: 1, settled: false, scale: 1 }, 4);
    for (const frame of frames) {
      expect(Math.abs(frame.up), 'the head left the neck').toBeLessThan(0.12);
      expect(Math.abs(frame.right)).toBeLessThan(0.12);
      expect(Math.abs(frame.roll), 'the horizon rolled past ten degrees').toBeLessThan(0.18);
      expect(frame.fov).toBeLessThan(4);
    }
  });
});

describe('the head has weight', () => {
  it('rolls into a turn and settles back level', () => {
    // The single biggest difference between a camera attached to somebody and
    // a tripod on wheels.
    const motion = createCameraMotion();
    const turning = run(motion, { ...WALK, turnRate: 2.2 }, 1);
    const rolled = turning[turning.length - 1]!.roll;
    expect(Math.abs(rolled), 'turning hard did not lean the head').toBeGreaterThan(0.02);

    const straight = run(motion, WALK, 3);
    expect(Math.abs(straight[straight.length - 1]!.roll)).toBeLessThan(Math.abs(rolled) * 0.6);
  });

  it('leans the opposite way for the opposite turn', () => {
    const left = createCameraMotion();
    const right = createCameraMotion();
    const a = run(left, { ...WALK, turnRate: 2.2 }, 1).pop()!.roll;
    const b = run(right, { ...WALK, turnRate: -2.2 }, 1).pop()!.roll;
    expect(Math.sign(a)).toBe(-Math.sign(b));
  });

  it('follows the turn rather than tracking it, so a flick does not snap', () => {
    // One frame of a hard turn must not produce the full lean; it has to be
    // eased, or every twitch of a pointer becomes a jolt.
    const motion = createCameraMotion();
    const first = stepCameraMotion(motion, { ...WALK, turnRate: 3 }, 1 / 60);
    const settled = run(motion, { ...WALK, turnRate: 3 }, 2).pop()!;
    expect(Math.abs(first.roll)).toBeLessThan(Math.abs(settled.roll) * 0.5);
  });

  it('never quite goes still, even sitting down', () => {
    /*
     * A dead frame reads as a paused game. Breath is the only term that
     * survives sitting, and it is deliberately small enough to be deniable —
     * the thing you would not notice until it was gone.
     */
    const motion = createCameraMotion();
    const seated = run(motion, { ...STILL, settled: true }, 8);
    const spread = Math.max(...seated.map((f) => f.up)) - Math.min(...seated.map((f) => f.up));
    expect(spread, 'the frame was completely dead').toBeGreaterThan(0.001);
    expect(spread, 'sitting still was seasick').toBeLessThan(0.02);
  });
});

describe('impulses', () => {
  it('kicks and decays away', () => {
    const motion = createCameraMotion();
    shakeCamera(motion, 1);
    const size = (frames: { right: number }[]) => Math.max(...frames.map((f) => Math.abs(f.right)));

    const early = size(run(motion, STILL, 0.25));
    // Then let it die before measuring again. The first version compared the
    // first tenth of a second against the next two seconds *starting from
    // there* — which still contained the loudest part of the decay, so the
    // "late" window was legitimately bigger and the test failed on a shake
    // that was working perfectly.
    run(motion, STILL, 2.5);
    const late = size(run(motion, STILL, 0.5));

    expect(early, 'a full kick did nothing').toBeGreaterThan(0.005);
    expect(late, 'the shake never stopped').toBeLessThan(early * 0.05);
  });

  it('cannot be stacked into a seizure', () => {
    // A hundred events in one frame is one event, harder.
    const motion = createCameraMotion();
    for (let i = 0; i < 100; i++) shakeCamera(motion, 1);
    expect(motion.impulse).toBeLessThanOrEqual(1);
    const frames = run(motion, STILL, 0.2);
    for (const frame of frames) expect(Math.abs(frame.right)).toBeLessThan(0.08);
  });

  it('ignores a kick of nothing', () => {
    const motion = createCameraMotion();
    shakeCamera(motion, 0);
    shakeCamera(motion, -3);
    expect(motion.impulse).toBe(0);
  });
});

describe('the lens', () => {
  it('widens with speed and comes back', () => {
    const motion = createCameraMotion();
    const moving = run(motion, { ...WALK, speed: 2.2 }, 2).pop()!;
    expect(moving.fov).toBeGreaterThan(1);
    const stopped = run(motion, STILL, 3).pop()!;
    expect(stopped.fov).toBeLessThan(0.3);
  });

  it('does not twitch when the speed does', () => {
    // Smoothed, because raw speed from a pointer-driven walk is noisy and a
    // field of view that flickers is worse than one that does not move.
    const motion = createCameraMotion();
    run(motion, WALK, 1);
    const before = stepCameraMotion(motion, WALK, 1 / 60).fov;
    const after = stepCameraMotion(motion, STILL, 1 / 60).fov;
    expect(Math.abs(after - before)).toBeLessThan(0.35);
  });
});

describe('a frame that arrives late', () => {
  it('does not launch the camera', () => {
    // A tab that was backgrounded delivers one enormous dt. Clamped, or the
    // travelled distance jumps a hundred strides and the bob teleports.
    const motion = createCameraMotion();
    const frame = stepCameraMotion(motion, WALK, 45);
    expect(Number.isFinite(frame.up)).toBe(true);
    expect(Math.abs(frame.up)).toBeLessThan(0.12);
    expect(motion.travelled).toBeLessThan(1);
  });
});

describe('the thing in your hands', () => {
  /*
   * The arm, which is the only motion term with a large amplitude.
   *
   * Everything else in this module is measured in millimetres and single
   * degrees, because a camera that moves more than that is a camera that makes
   * people ill. The held object is the exception and has to be: it is seen
   * *against* the frame rather than through it, so an effect small enough to be
   * safe on the camera is invisible on the hand. Seventeen degrees of lag on a
   * marshmallow is a wrist doing what a wrist does; seventeen degrees on the
   * view would be unplayable.
   */
  it('trails a turn by far more than the eyes do', () => {
    const motion = createCameraMotion();
    const frames = run(motion, { ...STILL, turnRate: 3 }, 0.5);
    const last = frames[frames.length - 1]!;
    // Both lag the same way — the sign is what makes it read as "left behind"
    // rather than as "thrown ahead".
    expect(Math.sign(last.swingYaw)).toBe(Math.sign(last.yaw));
    // And the arm lags several times harder than the neck. The exact ratio is
    // not the contract; the order of magnitude is.
    expect(Math.abs(last.swingYaw)).toBeGreaterThan(Math.abs(last.yaw) * 2);
  });

  it('overshoots when the turn stops and comes back', () => {
    /*
     * The whole reason this is a spring and not an ease. An ease can only
     * arrive; an arm arrives, carries on a little, and returns. If this test
     * fails because the swing never crosses zero, the damping has been raised
     * past critical and the effect has quietly become an ease.
     */
    const motion = createCameraMotion();
    const turned = run(motion, { ...STILL, turnRate: 3 }, 0.5);
    const swung = turned[turned.length - 1]!.swingYaw;
    const after = run(motion, STILL, 1.5).map((frame) => frame.swingYaw);
    // It crosses the far side of zero from where it was held.
    const overshot = after.some((value) => Math.sign(value) === -Math.sign(swung));
    expect(overshot).toBe(true);
    // And then settles. Not to exactly zero — it is still ringing — but to
    // something far smaller than it was held at.
    expect(Math.abs(after[after.length - 1]!)).toBeLessThan(Math.abs(swung) * 0.2);
  });

  it('takes much longer to settle than the eyes do', () => {
    // The detuning is the point: the view is done in a tenth of a second and
    // the hand is still moving. If these two settle together, the swing has
    // been retuned to the look lag and stopped being a separate body part.
    const motion = createCameraMotion();
    run(motion, { ...STILL, turnRate: 3 }, 0.5);
    const after = run(motion, STILL, 0.25);
    const held = after[0]!;
    const later = after[after.length - 1]!;
    expect(Math.abs(later.yaw)).toBeLessThan(Math.abs(held.yaw) * 0.5);
    expect(Math.abs(later.swingYaw)).toBeGreaterThan(Math.abs(held.swingYaw) * 0.5);
  });

  it('bobs harder than the head when walking', () => {
    // An arm is a lever on the end of a torso, so the hand travels further
    // through a stride than the eyes do. Reported as the *extra* travel, so
    // whatever holds it can add the two without double-counting the head's.
    const motion = createCameraMotion();
    const frames = run(motion, WALK, 3);
    const peakHead = Math.max(...frames.map((frame) => Math.abs(frame.up)));
    const peakHand = Math.max(...frames.map((frame) => Math.abs(frame.swingUp)));
    expect(peakHand).toBeGreaterThan(0);
    expect(peakHand).toBeGreaterThan(peakHead * 0.5);
    // But still centimetres, not a flail.
    expect(peakHand).toBeLessThan(0.09);
  });

  it('is thrown sideways by the turn, and not by standing still', () => {
    const motion = createCameraMotion();
    const still = run(motion, STILL, 1);
    expect(still[still.length - 1]!.swingRight).toBeCloseTo(0, 3);
    const turned = run(motion, { ...STILL, turnRate: 3 }, 0.5);
    expect(Math.abs(turned[turned.length - 1]!.swingRight)).toBeGreaterThan(0.005);
  });

  it('is none of it under reduced motion', () => {
    // §12 again. The hand is the largest term here, so it is also the one that
    // would be worst to leave switched on by accident.
    const motion = createCameraMotion();
    const frames = run(motion, { ...WALK, scale: 0, turnRate: 3, pitchRate: 2 }, 2);
    for (const frame of frames) {
      expect(frame.swingYaw).toBe(0);
      expect(frame.swingPitch).toBe(0);
      expect(frame.swingRight).toBe(0);
      expect(frame.swingUp).toBe(0);
    }
  });
});
