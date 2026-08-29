import { describe, expect, it } from 'vitest';
import {
  BlowGestureDetector,
  DEFAULT_ROAST_CONTROL,
  RoastController,
  screenToTableOffset,
} from '../src/interaction/roastControl.js';
import { formatDateStamp } from '../src/interaction/photo.js';

describe('roast control', () => {
  it('starts within the reachable band', () => {
    const pose = new RoastController().pose();
    const radius = Math.hypot(pose.position.x, pose.position.z);
    expect(radius).toBeGreaterThanOrEqual(DEFAULT_ROAST_CONTROL.minRadius);
    expect(radius).toBeLessThanOrEqual(DEFAULT_ROAST_CONTROL.maxRadius);
  });

  it('covers the browning band the heat model actually produces', () => {
    // The reachable range must bracket where roasting happens, or the control
    // is unusable no matter how good the simulation is (risk R7).
    const control = new RoastController();
    control.nudge(-1, 0);
    const closest = Math.hypot(control.pose().position.x, control.pose().position.z);
    control.nudge(1, 0);
    const furthest = Math.hypot(control.pose().position.x, control.pose().position.z);
    expect(closest).toBeLessThan(0.12);
    expect(furthest).toBeGreaterThan(0.45);
  });

  it('does not move until a drag begins', () => {
    const control = new RoastController();
    const before = control.bandPosition;
    control.move(500, 500);
    expect(control.bandPosition).toBe(before);
  });

  it('never jumps when a finger lands', () => {
    // Dragging is relative to where it started, so touching the screen far
    // from the marshmallow must not teleport it.
    const control = new RoastController();
    const before = control.bandPosition;
    control.begin(900, 30);
    expect(control.bandPosition).toBe(before);
  });

  it('dragging up moves it toward the heat', () => {
    const control = new RoastController();
    control.begin(500, 500);
    control.move(500, 400);
    expect(control.bandPosition).toBeLessThan(DEFAULT_ROAST_CONTROL.startPosition);
  });

  it('dragging down pulls it back out', () => {
    const control = new RoastController();
    control.begin(500, 400);
    control.move(500, 500);
    expect(control.bandPosition).toBeGreaterThan(DEFAULT_ROAST_CONTROL.startPosition);
  });

  it('dragging sideways rotates it', () => {
    const control = new RoastController();
    control.begin(500, 500);
    control.move(700, 500);
    expect(control.totalRotation).toBeGreaterThan(0);
    control.move(300, 500);
    expect(control.totalRotation).toBeLessThan(0);
  });

  it('controls both axes in one continuous drag', () => {
    // The core mobile requirement (spec §4.2).
    const control = new RoastController();
    control.begin(500, 500);
    control.move(640, 420);
    expect(control.totalRotation).not.toBe(0);
    expect(control.bandPosition).not.toBe(DEFAULT_ROAST_CONTROL.startPosition);
  });

  it('clamps at both ends of the band', () => {
    const control = new RoastController();
    control.begin(500, 500);
    control.move(500, -100000);
    expect(control.bandPosition).toBe(0);
    control.move(500, 100000);
    expect(control.bandPosition).toBe(1);
  });

  it('holds position across successive drags', () => {
    const control = new RoastController();
    control.begin(500, 500);
    control.move(500, 400);
    const after = control.bandPosition;
    control.end();
    control.begin(200, 200);
    expect(control.bandPosition).toBe(after);
  });

  it('is held higher when further out — the arc of an arm', () => {
    const control = new RoastController();
    control.nudge(-1, 0);
    const near = control.pose().position.y;
    control.nudge(2, 0);
    const far = control.pose().position.y;
    expect(far).toBeGreaterThan(near);
  });

  it('reports proximity for the non-numeric heat readout', () => {
    const control = new RoastController();
    control.nudge(-1, 0);
    expect(control.pose().proximity).toBeCloseTo(1, 5);
    control.nudge(2, 0);
    expect(control.pose().proximity).toBeCloseTo(0, 5);
  });

  it('places the marshmallow on the player’s side of the fire', () => {
    const control = new RoastController({}, Math.PI / 2);
    const pose = control.pose();
    expect(pose.position.x).toBeCloseTo(0, 5);
    expect(pose.position.z).toBeGreaterThan(0);
  });

  it('supports keyboard nudging as an alternate control scheme', () => {
    const control = new RoastController();
    const before = control.bandPosition;
    control.nudge(-0.04, 0.22);
    expect(control.bandPosition).toBeLessThan(before);
    expect(control.totalRotation).toBeCloseTo(0.22, 6);
  });

  it('automatic rotation does not disturb the player’s distance', () => {
    const control = new RoastController();
    const before = control.bandPosition;
    control.addRotation(1.4);
    expect(control.bandPosition).toBe(before);
    expect(control.totalRotation).toBeCloseTo(1.4, 6);
  });

  it('rotation applied by an assist survives the next drag', () => {
    const control = new RoastController();
    control.begin(500, 500);
    control.addRotation(1);
    control.move(500, 500);
    expect(control.totalRotation).toBeCloseTo(1, 6);
  });
});

describe('blow-out gesture', () => {
  it('recognises a shake', () => {
    const detector = new BlowGestureDetector();
    let fired = false;
    let t = 0;
    for (let i = 0; i < 8; i++) {
      t += 40;
      fired = detector.sample(i % 2 === 0 ? 100 : 260, t) || fired;
    }
    expect(fired).toBe(true);
  });

  it('ignores a plain swipe', () => {
    // A straight drag is how the player *roasts*; it must never blow the
    // marshmallow out by accident.
    const detector = new BlowGestureDetector();
    let fired = false;
    for (let i = 0; i < 12; i++) fired = detector.sample(100 + i * 30, i * 30) || fired;
    expect(fired).toBe(false);
  });

  it('ignores a small jitter', () => {
    const detector = new BlowGestureDetector();
    let fired = false;
    for (let i = 0; i < 12; i++) fired = detector.sample(i % 2 === 0 ? 100 : 103, i * 30) || fired;
    expect(fired).toBe(false);
  });

  it('does not fire twice in quick succession', () => {
    const detector = new BlowGestureDetector();
    let count = 0;
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 40;
      if (detector.sample(i % 2 === 0 ? 100 : 300, t)) count++;
    }
    expect(count).toBeLessThanOrEqual(2);
  });

  it('needs enough samples to decide', () => {
    const detector = new BlowGestureDetector();
    expect(detector.sample(100, 0)).toBe(false);
    expect(detector.sample(300, 30)).toBe(false);
  });

  it('resets cleanly', () => {
    const detector = new BlowGestureDetector();
    for (let i = 0; i < 6; i++) detector.sample(i % 2 === 0 ? 100 : 300, i * 40);
    detector.reset();
    expect(detector.sample(100, 1000)).toBe(false);
  });

  it('works immediately, not only after the first second', () => {
    // Regression: a zero-initialised cooldown made this inert at t < 900ms.
    const detector = new BlowGestureDetector();
    let fired = false;
    for (let i = 0; i < 8; i++) fired = detector.sample(i % 2 === 0 ? 100 : 260, i * 40) || fired;
    expect(fired).toBe(true);
  });
});

describe('table offset mapping', () => {
  it('is relative to the anchor', () => {
    const offset = screenToTableOffset(500, 500, 500, 500);
    expect(offset.x).toBe(0);
    expect(offset.z).toBe(0);
  });

  it('maps pixels to a plausible physical scale', () => {
    // 200 px of drag should move a component centimetres, not metres.
    const offset = screenToTableOffset(700, 500, 500, 500);
    expect(offset.x).toBeGreaterThan(0.02);
    expect(offset.x).toBeLessThan(0.2);
  });

  it('keeps the component above the plate', () => {
    expect(screenToTableOffset(0, 0, 500, 500).y).toBeGreaterThan(0);
  });
});

describe('photo date stamp', () => {
  it('uses the format those cameras printed', () => {
    expect(formatDateStamp(new Date(2024, 7, 12))).toBe("'24 08 12");
  });

  it('pads single digits', () => {
    expect(formatDateStamp(new Date(2003, 0, 5))).toBe("'03 01 05");
  });
});
