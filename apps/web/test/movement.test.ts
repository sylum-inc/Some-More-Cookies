import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MOVEMENT_CONTROL,
  KeyboardMovement,
  MovementController,
} from '../src/interaction/movementControl.js';

describe('tap versus drag', () => {
  it('a short stationary press is a tap', () => {
    const control = new MovementController();
    control.begin(300, 400, 0);
    expect(control.end(120)).toEqual({ x: 300, y: 400 });
  });

  it('a press that travels becomes a look-drag, not a tap', () => {
    const control = new MovementController();
    control.begin(300, 400, 0);
    control.move(340, 400);
    expect(control.gesture).toBe('look');
    expect(control.end(200)).toBeNull();
  });

  it('a long press is not a tap, even if stationary', () => {
    // Otherwise resting a thumb on the screen teleports you across the camp.
    const control = new MovementController();
    control.begin(300, 400, 0);
    expect(control.end(DEFAULT_MOVEMENT_CONTROL.tapMaxDuration + 50)).toBeNull();
  });

  it('small jitter within the threshold is still a tap', () => {
    const control = new MovementController();
    control.begin(300, 400, 0);
    control.move(303, 402);
    control.move(300, 400);
    expect(control.end(150)).toEqual({ x: 300, y: 400 });
  });

  it('does not look until the finger has committed to a drag', () => {
    const control = new MovementController();
    control.begin(300, 400, 0);
    expect(control.move(304, 400)).toBeNull();
    expect(control.gesture).toBe('undecided');
  });

  it('turns on the very frame the drag is recognised', () => {
    // Waiting a frame makes every drag snag at the start.
    const control = new MovementController();
    control.begin(300, 400, 0);
    const delta = control.move(300 + DEFAULT_MOVEMENT_CONTROL.dragThreshold + 1, 400);
    expect(delta).not.toBeNull();
    expect(delta!.yaw).toBeGreaterThan(0);
  });

  it('ignores movement when no press is active', () => {
    expect(new MovementController().move(10, 10)).toBeNull();
  });
});

describe('looking', () => {
  it('drags right to turn right and up to look up', () => {
    const control = new MovementController();
    control.begin(300, 400, 0);
    control.move(340, 400);
    const horizontal = control.move(380, 400)!;
    expect(horizontal.yaw).toBeGreaterThan(0);

    control.begin(300, 400, 0);
    control.move(300, 360);
    const vertical = control.move(300, 340)!;
    expect(vertical.pitch).toBeGreaterThan(0);
  });

  it('honours inverted vertical look', () => {
    const control = new MovementController({ invertY: true });
    control.begin(300, 400, 0);
    control.move(300, 360);
    expect(control.move(300, 340)!.pitch).toBeLessThan(0);
  });

  it('scales with sensitivity', () => {
    const slow = new MovementController({ lookSensitivityX: 0.001 });
    const fast = new MovementController({ lookSensitivityX: 0.01 });
    for (const control of [slow, fast]) {
      control.begin(300, 400, 0);
      control.move(340, 400);
    }
    expect(fast.move(380, 400)!.yaw).toBeGreaterThan(slow.move(380, 400)!.yaw);
  });
});

describe('virtual joystick', () => {
  it('is off by default', () => {
    const control = new MovementController();
    control.begin(100, 600, 0);
    expect(control.gesture).toBe('undecided');
    expect(control.joystickVisual()).toBeNull();
  });

  it('reads deflection as forward and strafe', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    control.move(100, 540);
    const forward = control.joystick();
    expect(forward.forward).toBeGreaterThan(0.5);
    expect(Math.abs(forward.strafe)).toBeLessThan(0.1);

    control.move(160, 600);
    const strafe = control.joystick();
    expect(strafe.strafe).toBeGreaterThan(0.5);
  });

  it('has a dead zone so a resting thumb does not creep', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    control.move(103, 602);
    expect(control.joystick()).toEqual({ forward: 0, strafe: 0 });
  });

  it('clamps to full deflection rather than exceeding it', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    control.move(100, 100);
    const intent = control.joystick();
    expect(Math.hypot(intent.forward, intent.strafe)).toBeLessThanOrEqual(1.001);
  });

  it('reports where to draw itself, knob clamped inside the ring', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    control.move(100, 200);
    const visual = control.joystickVisual()!;
    expect(visual.originX).toBe(100);
    expect(Math.hypot(visual.knobX - 100, visual.knobY - 600)).toBeLessThanOrEqual(
      DEFAULT_MOVEMENT_CONTROL.joystickRadius + 0.001,
    );
  });

  it('never produces a tap', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    expect(control.end(50)).toBeNull();
  });

  it('stops when released', () => {
    const control = new MovementController();
    control.useJoystick = true;
    control.begin(100, 600, 0);
    control.move(100, 540);
    control.end(200);
    expect(control.joystick()).toEqual({ forward: 0, strafe: 0 });
  });

  it('cancel clears any gesture', () => {
    const control = new MovementController();
    control.begin(10, 10, 0);
    control.cancel();
    expect(control.gesture).toBe('none');
    expect(control.end(20)).toBeNull();
  });
});

describe('keyboard', () => {
  it('walks on WASD', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    expect(keys.intent().forward).toBe(1);
    keys.up('w');
    keys.down('s');
    expect(keys.intent().forward).toBe(-1);
  });

  /*
   * The arrows used to be a second set of walk keys, which left `player.facing`
   * unreachable from the keyboard entirely: it only ever moves from a pointer
   * look delta or from walking toward a tapped point. So a keyboard player
   * could cross the campsite and never turn — no sky, no aiming a torch, no
   * facing the water. The arrows look now; the duplication is what paid for it.
   */
  it('looks on the arrows, and does not walk on them', () => {
    const keys = new KeyboardMovement();
    keys.down('ArrowLeft');
    expect(keys.intent()).toEqual({ forward: 0, strafe: 0 });
    expect(keys.look().yaw).toBeGreaterThan(0);
    keys.up('ArrowLeft');
    keys.down('ArrowRight');
    expect(keys.look().yaw).toBeLessThan(0);
    keys.up('ArrowRight');
    keys.down('ArrowUp');
    expect(keys.look().pitch).toBeGreaterThan(0);
  });

  it('walks and looks at the same time', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    keys.down('ArrowRight');
    expect(keys.intent().forward).toBe(1);
    expect(keys.look().yaw).toBeLessThan(0);
  });

  it('stops turning when the key comes up', () => {
    const keys = new KeyboardMovement();
    keys.down('ArrowRight');
    keys.up('ArrowRight');
    expect(keys.look()).toEqual({ yaw: 0, pitch: 0 });
  });

  it('is case insensitive', () => {
    const keys = new KeyboardMovement();
    keys.down('W');
    expect(keys.intent().forward).toBe(1);
  });

  it('does not make diagonals faster', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    keys.down('d');
    const intent = keys.intent();
    expect(Math.hypot(intent.forward, intent.strafe)).toBeCloseTo(1, 6);
  });

  it('releasing one of two keys keeps you moving', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    keys.down('d');
    keys.up('d');
    expect(keys.intent()).toEqual({ forward: 1, strafe: 0 });
    expect(keys.active).toBe(true);
  });

  it('opposing keys cancel', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    keys.down('s');
    expect(keys.intent()).toEqual({ forward: 0, strafe: 0 });
  });

  it('clears on focus loss', () => {
    const keys = new KeyboardMovement();
    keys.down('w');
    keys.clear();
    expect(keys.active).toBe(false);
    expect(keys.intent().forward).toBe(0);
  });
});
