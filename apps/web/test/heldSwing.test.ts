import { describe, expect, it } from 'vitest';

import { holdPointFor } from '../src/scene/World.js';
import { createPlayer, vec3 } from '@somemore/sim';

/**
 * That the arm's lag actually reaches the hold point.
 *
 * `cameraMotion` produces the swing and its own tests prove the spring is a
 * spring. This is the other half, and on this codebase it is the half that has
 * failed five separate times: a render term that is computed correctly and
 * then never applied looks exactly like one that was never written. So this
 * asks the only question that matters — with a swing on, is the thing in the
 * player's hands in a different place than without one?
 */

function player(facing: number) {
  return createPlayer(vec3(0, 0, 0), facing);
}

describe('the hold point under a swing', () => {
  it('is exactly the rigid point when nothing is swinging', () => {
    // The default has to be inert, because the anchored close-ups and every
    // caller that does not know about arms go through it.
    const rigid = holdPointFor(player(0.4));
    const explicit = holdPointFor(player(0.4), { yaw: 0, pitch: 0, right: 0, up: 0 });
    expect(explicit).toEqual(rigid);
  });

  it('orbits the eye rather than sliding toward it', () => {
    /*
     * The distinction the swing is modelled on. A hand on the end of a forearm
     * keeps its distance from the face and swings round; a hand that changed
     * its distance would read as a lens fault rather than as a body. So the
     * bearing moves and the radius does not.
     */
    const eyeHeight = holdPointFor(player(0))[1];
    const rigid = holdPointFor(player(0));
    const swung = holdPointFor(player(0), { yaw: 0.3, pitch: 0, right: 0, up: 0 });
    const reach = (p: readonly [number, number, number]) =>
      Math.hypot(p[0], p[2]);
    // It moved, and it moved by a visible amount rather than a rounding error.
    expect(Math.hypot(swung[0] - rigid[0], swung[2] - rigid[2])).toBeGreaterThan(0.05);
    // Same height, because yaw is a bearing and not a lift.
    expect(swung[1]).toBeCloseTo(eyeHeight, 6);
    // And the same distance out from the body's axis, to within a millimetre.
    expect(reach(swung)).toBeCloseTo(reach(rigid), 3);
  });

  it('lifts with the stride and is thrown sideways by the turn', () => {
    const rigid = holdPointFor(player(0));
    const lifted = holdPointFor(player(0), { yaw: 0, pitch: 0, right: 0, up: 0.04 });
    expect(lifted[1] - rigid[1]).toBeCloseTo(0.04, 6);

    const thrown = holdPointFor(player(0), { yaw: 0, pitch: 0, right: 0.05, up: 0 });
    // Facing +x, so the camera's right is -z: the throw has to land there and
    // not in the direction the player is looking.
    expect(thrown[0]).toBeCloseTo(rigid[0], 6);
    expect(Math.abs(thrown[2] - rigid[2])).toBeCloseTo(0.05, 6);
  });

  it('swings the same way whichever way the body is pointing', () => {
    // The swing is in the body's own frame, so walking north and walking east
    // have to feel identical. This is the same rule the bob is held to.
    const offsetFor = (facing: number) => {
      const rigid = holdPointFor(player(facing));
      const swung = holdPointFor(player(facing), { yaw: 0.25, pitch: 0, right: 0, up: 0 });
      const cos = Math.cos(-facing);
      const sin = Math.sin(-facing);
      const dx = swung[0] - rigid[0];
      const dz = swung[2] - rigid[2];
      return [dx * cos - dz * sin, dx * sin + dz * cos];
    };
    const north = offsetFor(0);
    const east = offsetFor(Math.PI / 2);
    expect(east[0]!).toBeCloseTo(north[0]!, 6);
    expect(east[1]!).toBeCloseTo(north[1]!, 6);
  });
});
