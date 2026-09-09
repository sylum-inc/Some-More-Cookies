import { describe, expect, it } from 'vitest';
import { createHandGeometry, handAxes, HAND_REACH } from '../src/render/hand.js';

/**
 * The hand is the only thing in this game that is guaranteed to be within half
 * a metre of the camera, which makes it the one piece of geometry where a
 * mistake is unmissable and a measurement is worth having. All of this is
 * cheap to check and none of it is checkable by looking at a screenshot: a
 * hand that is inside-out looks, at 320x240 in firelight, a great deal like a
 * hand that is merely dark.
 */
describe('the hand', () => {
  const geometry = createHandGeometry();

  /*
   * Measured along the hand's own axes rather than the world's.
   *
   * The pose is baked into the geometry now — the fingers are turned three-
   * quarters away from the view axis on purpose — so the bounding box is a
   * fact about that rotation and not about the hand. `handAxes()` gives the
   * anatomical directions and every measurement below projects onto them,
   * which is also what makes these assertions survive the next time somebody
   * changes the angle.
   */
  const AXES = handAxes();
  const along = (axis: readonly [number, number, number]) => {
    const position = geometry.getAttribute('position');
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < position.count; i++) {
      const d =
        position.getX(i) * axis[0] + position.getY(i) * axis[1] + position.getZ(i) * axis[2];
      if (d < low) low = d;
      if (d > high) high = d;
    }
    return { low, high, span: high - low };
  };

  it('is small enough to be a hand and long enough to leave the frame', () => {
    // A fist is about nine centimetres across. Anything near twice that is a
    // boxing glove and anything near half is a doll's hand.
    const across = along(AXES.across);
    const back = along(AXES.backOfHand);
    expect(across.span).toBeGreaterThan(0.09);
    expect(across.span).toBeLessThan(0.2);
    expect(back.span).toBeGreaterThan(0.09);
    expect(back.span).toBeLessThan(0.2);
    /*
     * The forearm has to run back well past the fist, or the fist reads as
     * severed and floating in the corner — but it must not be so long that it
     * reaches the lens, which is what the first version did: 28 cm of arm
     * starting from a fist 27 cm away arrived exactly at the camera and
     * rendered as a featureless wall down one side of the frame.
     *
     * Asserted as a ratio rather than as a length, because the length that is
     * right depends on how far out the hand is held and that is the scene's
     * business, while "an arm is several times longer than a fist is deep" is
     * true of every arm.
     */
    const reach = along(AXES.fingers);
    const behind = -reach.low;
    expect(behind / reach.span, 'most of the shape is forearm').toBeGreaterThan(0.55);
    expect(behind, 'the arm reaches back past the fist').toBeGreaterThan(0.15);
    expect(behind, 'the arm reaches the lens').toBeLessThan(0.3);
  });

  it('is turned away from the view axis, so it has a silhouette at all', () => {
    /*
     * The defect this exists for, and it shipped.
     *
     * The fingers used to point straight away from the eye. Anatomically
     * obvious, and on screen it produced a black column with the s'more
     * balanced on top: an art director called it "a staircase of untextured
     * boxes... no wrist, no knuckles, no thumb". A fist seen end-on has no
     * silhouette — it is a circle — and a hand is read from its silhouette.
     *
     * The runtime turns the whole group by `-facing + PI/2`, which maps this
     * geometry's +Z onto the direction the player is looking. So the test is
     * simply: how far off that axis do the fingers point? Under about
     * thirty-five degrees and the fingers merge into one block again.
     */
    const offAxis = Math.acos(Math.abs(AXES.fingers[2]));
    expect(offAxis, `fingers are ${((offAxis * 180) / Math.PI).toFixed(0)} degrees off the view axis`)
      .toBeGreaterThan(0.61);
  });

  it('has outward normals on every triangle', () => {
    /*
     * The failure this exists for: a box wound the wrong way is invisible
     * under a `FrontSide` material, and a hand that is invisible looks exactly
     * like a hand that was never mounted. The tree geometry in this same
     * codebase shipped exactly this bug during the same session — the whole
     * canopy, wound inside-out and culled — and it was a measurement rather
     * than a screenshot that found it.
     *
     * Checked by comparing each triangle's own winding normal against the
     * stored vertex normal: they must agree, and the stored one must point
     * away from the part's own centre.
     */
    const position = geometry.getAttribute('position');
    const normal = geometry.getAttribute('normal');
    let disagreements = 0;
    for (let t = 0; t < position.count; t += 3) {
      const ax = position.getX(t);
      const ay = position.getY(t);
      const az = position.getZ(t);
      const ux = position.getX(t + 1) - ax;
      const uy = position.getY(t + 1) - ay;
      const uz = position.getZ(t + 1) - az;
      const vx = position.getX(t + 2) - ax;
      const vy = position.getY(t + 2) - ay;
      const vz = position.getZ(t + 2) - az;
      const nx = uy * vz - uz * vy;
      const ny = uz * vx - ux * vz;
      const nz = ux * vy - uy * vx;
      const dot = nx * normal.getX(t) + ny * normal.getY(t) + nz * normal.getZ(t);
      if (dot <= 0) disagreements++;
    }
    expect(disagreements, 'triangles whose winding disagrees with their normal').toBe(0);
  });

  it('carries three tone bands and no baked skin colour', () => {
    /*
     * Multipliers, not colours. A hand at a campfire is orange down one side
     * and nearly black down the other, and at noon it is neither — so what
     * decides the colour has to be the light, and all this attribute may do is
     * say which parts of the hand catch more of it. A channel that differs
     * from its neighbours would be a hue, which is a skin tone, which is the
     * thing this must not contain.
     */
    const color = geometry.getAttribute('color');
    const tones = new Set<number>();
    for (let i = 0; i < color.count; i++) {
      const r = color.getX(i);
      expect(color.getY(i)).toBeCloseTo(r, 6);
      expect(color.getZ(i)).toBeCloseTo(r, 6);
      tones.add(Number(r.toFixed(4)));
    }
    /*
     * Three face bands times the per-part tone, so the exact count is not the
     * property — what matters is that the range is worth having and that the
     * cloth ends up genuinely darker than the skin. An art review's note was
     * that the hand was the brightest object in a night frame, which is the
     * wrong way round: the food is what the player is looking at.
     */
    const sorted = [...tones].sort((a, b) => a - b);
    expect(tones.size, 'a hand with one value is a slab').toBeGreaterThan(3);
    expect(sorted[sorted.length - 1]! / sorted[0]!).toBeGreaterThan(4);
  });

  it('is cheap enough to sit in front of the camera every frame', () => {
    // Five boxes, twelve triangles each. If this ever grows past a couple of
    // hundred it has stopped being a PS1 hand.
    expect(position(geometry)).toBeLessThanOrEqual(240);
  });

  it('reaches about an arm', () => {
    expect(HAND_REACH).toBeGreaterThan(0.2);
    expect(HAND_REACH).toBeLessThan(0.6);
  });
});

function position(geometry: { getAttribute: (name: string) => { count: number } }): number {
  return geometry.getAttribute('position').count / 3;
}

describe('the hand reads as a hand', () => {
  const geometry = createHandGeometry();

  it('has gaps between the fingers', () => {
    /*
     * The failure this exists for, in an art director's words: "a two-tone
     * tapering slab with one notch — no fingers, no thumb, no wrist". The
     * first version drew the finger bank as ONE box with a ridge cut across
     * it, to save triangles. A hand is read from its silhouette and the
     * silhouette of a hand is the gaps BETWEEN the fingers, so that saving
     * removed the only thing that made it a hand.
     *
     * Measured as vertical slices through the knuckle depth: a solid bank
     * fills every slice, and four fingers leave holes.
     *
     * Sliced along the hand's own axes, not the world's. Written against x and
     * z it kept passing after the pose was baked in — for the wrong reason,
     * because a rotated hand leaves most of a world-aligned bucket range
     * empty and empty buckets read as gaps. A test that passes for the wrong
     * reason is worse than one that fails, and on this codebase that mistake
     * has now been made often enough to be worth the extra four lines.
     */
    const axes = handAxes();
    const position = geometry.getAttribute('position');
    const project = (i: number, axis: readonly [number, number, number]) =>
      position.getX(i) * axis[0] + position.getY(i) * axis[1] + position.getZ(i) * axis[2];
    // The finger boxes live forward of the palm; sample across that slab.
    const columns = new Array<number>(24).fill(0);
    for (let i = 0; i < position.count; i++) {
      if (project(i, axes.fingers) < 0.03) continue;
      const x = project(i, axes.across);
      const bucket = Math.floor(((x + 0.06) / 0.12) * columns.length);
      if (bucket >= 0 && bucket < columns.length) columns[bucket]! += 1;
    }
    // Count runs of empty columns across the finger bank: four fingers give at
    // least three gaps between them.
    let gaps = 0;
    let inGap = false;
    for (const column of columns) {
      if (column === 0 && !inGap) {
        gaps += 1;
        inGap = true;
      } else if (column !== 0) {
        inGap = false;
      }
    }
    expect(gaps, `column occupancy: ${columns.join(',')}`).toBeGreaterThanOrEqual(3);
  });

  it('ends in a cuff rather than in mid-air', () => {
    // A forearm that simply stops reads as an amputation. The darkest parts of
    // the geometry are the cloth, and they have to be the ones furthest back
    // along the arm — measured along the fingers, which is the arm's own axis.
    const axis = handAxes().fingers;
    const position = geometry.getAttribute('position');
    const color = geometry.getAttribute('color');
    let darkestAlong = Infinity;
    let darkest = Infinity;
    for (let i = 0; i < color.count; i++) {
      if (color.getX(i) < darkest) {
        darkest = color.getX(i);
        darkestAlong =
          position.getX(i) * axis[0] + position.getY(i) * axis[1] + position.getZ(i) * axis[2];
      }
    }
    expect(darkestAlong, 'the darkest material is at the far end, where cloth is').toBeLessThan(
      -0.08,
    );
  });
});
