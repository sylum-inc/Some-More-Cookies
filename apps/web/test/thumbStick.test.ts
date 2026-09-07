import { describe, expect, it } from 'vitest';
import { STICK_DEAD_ZONE_PX, STICK_RADIUS_PX, readStick } from '../src/interaction/thumbStick.js';

describe('the thumb pad', () => {
  it('is still when the thumb is on its centre', () => {
    expect(readStick(0, 0)).toEqual({ forward: 0, strafe: 0, knobX: 0, knobY: 0 });
  });

  it('ignores a thumb resting slightly off centre', () => {
    // A thumb on a pad is never exactly in the middle of it; without this,
    // every touch is a slow walk in whichever direction it happened to lean.
    const reading = readStick(STICK_DEAD_ZONE_PX - 1, 0);
    expect(reading.forward).toBe(0);
    expect(reading.strafe).toBe(0);
  });

  it('walks forward when the thumb goes up the screen', () => {
    /*
     * Screen y grows downward and forward is up, so this is a negation that is
     * obvious the first time somebody plays it and invisible in a diff.
     */
    const reading = readStick(0, -STICK_RADIUS_PX);
    expect(reading.forward).toBeCloseTo(1, 5);
    expect(reading.strafe).toBeCloseTo(0, 5);
  });

  it('walks back when the thumb goes down the screen', () => {
    expect(readStick(0, STICK_RADIUS_PX).forward).toBeCloseTo(-1, 5);
  });

  it('strafes right when the thumb goes right', () => {
    expect(readStick(STICK_RADIUS_PX, 0).strafe).toBeCloseTo(1, 5);
  });

  it('never asks for more than a walk, however far the thumb goes', () => {
    // A thumb dragged clean off the pad is full speed, not an ever-growing
    // number that the locomotion model would have to clamp for it.
    for (const distance of [STICK_RADIUS_PX, STICK_RADIUS_PX * 3, 4000]) {
      const reading = readStick(distance * 0.6, -distance * 0.8);
      expect(Math.hypot(reading.forward, reading.strafe)).toBeLessThanOrEqual(1.0001);
    }
    const far = readStick(0, -4000);
    expect(far.forward).toBeCloseTo(1, 5);
    // And the knob stays on the pad even when the thumb has left it.
    expect(Math.hypot(far.knobX, far.knobY)).toBeLessThanOrEqual(STICK_RADIUS_PX + 1e-6);
  });

  it('eases out of the dead zone rather than jumping', () => {
    /*
     * The first real millimetre of travel has to be the slowest walk. Without
     * re-basing past the dead zone, crossing it reads as an instant tenth of
     * full speed, which is a lurch.
     */
    const first = readStick(0, -(STICK_DEAD_ZONE_PX + 0.5));
    expect(first.forward).toBeGreaterThan(0);
    expect(first.forward).toBeLessThan(0.05);
  });

  it('keeps a diagonal a diagonal', () => {
    const reading = readStick(STICK_RADIUS_PX, -STICK_RADIUS_PX);
    expect(reading.forward).toBeCloseTo(reading.strafe, 5);
    expect(Math.hypot(reading.forward, reading.strafe)).toBeCloseTo(1, 5);
  });

  it('survives a pointer that reports nonsense', () => {
    expect(readStick(Number.NaN, 0).forward).toBe(0);
    expect(readStick(0, Number.POSITIVE_INFINITY).forward).toBe(0);
  });
});
