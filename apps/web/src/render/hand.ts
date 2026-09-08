/**
 * A hand, because the camera belonged to nobody.
 *
 * Two art reviews of this build named the same absence twice each. First: the
 * s'more — the object the entire ritual exists to produce — hangs at eye level
 * in the payoff shot with nothing holding it, no contact shadow and no body,
 * which reads as a physics bug rather than as eating. Second: no frame in the
 * game has anything in its near plane, so every shot is midground plus
 * background with no depth cue, no scale reference and no parallax.
 *
 * One piece of geometry answers both. A first-person hand is the cheapest
 * foreground in the business: it is dark, it is close, it moves with the head,
 * and it tells you whose eyes these are.
 *
 * **Blocky on purpose.** The reference is a console generation whose hands were
 * six boxes and a thumb, and at 320x240 that is not a limitation — a smooth,
 * anatomically hopeful hand at this resolution reads as a mitten. Hard edges
 * survive the downsample; curves do not.
 *
 * Vertex colours rather than a texture, and stored as **multipliers** rather
 * than as skin tones. What decides the actual colour is the light the hand is
 * standing in: at a fire it should be orange down one side and nearly black
 * down the other, and at noon it should be neither. Baking a skin tone in
 * would fight every hour of the day this build just spent a session earning.
 */

import * as THREE from 'three';

/** How far the wrist sits from the camera, in metres. Roughly an arm. */
export const HAND_REACH = 0.34;

/**
 * The bands, as multipliers on whatever colour the material carries.
 *
 * A hand is not flat: the back of it catches the sky, the knuckles catch
 * whatever is in front, and the underside catches almost nothing. Three values
 * is what the hardware being imitated would have had and it is enough — the
 * fourth is the outline the low resolution draws for free.
 */
const LIT = 1.18;
const MID = 0.82;
const SHADE = 0.46;

interface Box {
  /** Centre, in the hand's own frame: +X right, +Y up, +Z away from the eye. */
  readonly at: [number, number, number];
  readonly size: [number, number, number];
  /** Rotation about X then Y, in radians. Fingers are not axis-aligned. */
  readonly tilt?: [number, number];
  /**
   * A multiplier on this part's tone bands, for the parts that are not skin.
   *
   * The cuff and sleeve are cloth and want to be much darker than a hand: an
   * art review's note was that the hand is "the brightest object in a night
   * frame", which is the wrong way round — the food is what the player is
   * looking at and it has to win. Dark cloth also does the other half of the
   * foreground's job, which is to be a dark shape at the edge that the eye
   * travels past.
   */
  readonly tone?: number;
}

/**
 * The parts. A fist is a palm block, a bank of fingers, a thumb across the
 * front, and a forearm running back out of frame.
 *
 * The forearm matters more than it looks: without it the fist is a severed
 * hand floating in the corner, and with it the eye reads an arm continuing
 * past the edge of the screen and stops asking.
 */
const PARTS: readonly Box[] = [
  // Palm.
  { at: [0, 0, 0], size: [0.086, 0.09, 0.05] },
  /*
   * Four fingers, curled over whatever is being held — as four separate boxes,
   * which is the whole point.
   *
   * The first version drew the bank of fingers as ONE box with a ridge cut
   * across it, on the reasoning that four boxes at this size are four pixels
   * and a lot of triangles. That reasoning was wrong and an art director put it
   * plainly: "a two-tone tapering slab with one notch — no fingers, no thumb,
   * no wrist". A hand is read from its silhouette, and the silhouette of a hand
   * is *the gaps between the fingers*. Four boxes with a pixel of air between
   * them is the cheapest hand there is, and it is what the hardware being
   * imitated actually shipped.
   *
   * Each is a little shorter and lower than the one inboard of it, because
   * fingers are, and because a bank of four identical ones is the slab again.
   */
  { at: [-0.03, 0.014, 0.046], size: [0.017, 0.062, 0.05], tilt: [0.4, 0] },
  { at: [-0.009, 0.02, 0.05], size: [0.017, 0.066, 0.054], tilt: [0.36, 0] },
  { at: [0.012, 0.016, 0.048], size: [0.017, 0.062, 0.052], tilt: [0.38, 0] },
  { at: [0.032, 0.008, 0.042], size: [0.016, 0.054, 0.046], tilt: [0.44, 0] },
  // The knuckle line, which is what says the fingers are curled rather than
  // splayed.
  { at: [0, 0.046, 0.026], size: [0.086, 0.016, 0.038] },
  // Thumb, lying across the front, which is how a hand holds something light.
  { at: [-0.048, -0.014, 0.028], size: [0.028, 0.028, 0.058], tilt: [0.22, 0.4] },
  // Wrist: narrower than both the fist and the sleeve, so there is a join.
  { at: [0.008, -0.03, -0.052], size: [0.058, 0.06, 0.06], tilt: [0.14, 0] },
  /*
   * A cuff, and then the sleeve.
   *
   * The cuff is the trick: it hides where the arm stops being modelled. Without
   * it the forearm has to terminate somewhere, and wherever that is reads as an
   * amputation — with it, the arm goes into a sleeve and the sleeve goes out of
   * frame, which is a thing eyes accept without asking.
   */
  { at: [0.012, -0.04, -0.1], size: [0.078, 0.08, 0.036], tilt: [0.16, 0], tone: 0.42 },
  { at: [0.014, -0.046, -0.16], size: [0.07, 0.072, 0.14], tilt: [0.16, 0], tone: 0.34 },
];

/**
 * The hand, as one merged buffer geometry.
 *
 * Built by hand rather than with `BoxGeometry` + a merge helper, because every
 * box needs its own per-face vertex colours and the merge helpers in this
 * repository are for parts that share a material's colour.
 */
export function createHandGeometry(): THREE.BufferGeometry {
  const positions: number[] = [];
  const normals: number[] = [];
  const colors: number[] = [];

  for (const part of PARTS) {
    appendBox(part, positions, normals, colors);
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('normal', new THREE.Float32BufferAttribute(normals, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeBoundingSphere();
  return geometry;
}

/** The six faces of one box, each with its own flat normal and tone. */
function appendBox(
  box: Box,
  positions: number[],
  normals: number[],
  colors: number[],
): void {
  const [hx, hy, hz] = [box.size[0] / 2, box.size[1] / 2, box.size[2] / 2];
  const [tiltX, tiltY] = box.tilt ?? [0, 0];
  const cx = Math.cos(tiltX);
  const sx = Math.sin(tiltX);
  const cy = Math.cos(tiltY);
  const sy = Math.sin(tiltY);

  const place = (x: number, y: number, z: number): [number, number, number] => {
    // X then Y, matching the order the tilt is documented in.
    const y1 = y * cx - z * sx;
    const z1 = y * sx + z * cx;
    const x2 = x * cy + z1 * sy;
    const z2 = -x * sy + z1 * cy;
    return [x2 + box.at[0], y1 + box.at[1], z2 + box.at[2]];
  };

  // Corner index bits: 1 = +x, 2 = +y, 4 = +z.
  const corner = (i: number): [number, number, number] =>
    place(i & 1 ? hx : -hx, i & 2 ? hy : -hy, i & 4 ? hz : -hz);

  /*
   * Which faces are lit.
   *
   * Light in this game comes from a fire that is in front of and below the
   * player, or from a sky that is above. So the top takes the sky band, the
   * face pointing away from the eye takes the fire band, and the underside and
   * the inboard side take the shade. Fixed rather than computed from the
   * scene, because this is albedo variation and not lighting — the actual
   * light is done by the actual lights.
   */
  const faces: { readonly quad: [number, number, number, number]; readonly tone: number }[] = [
    { quad: [4, 5, 7, 6], tone: MID }, // +z, toward what you are looking at
    { quad: [1, 0, 2, 3], tone: SHADE }, // -z, toward the eye
    { quad: [2, 6, 7, 3], tone: LIT }, // +y, the back of the hand
    { quad: [1, 5, 4, 0], tone: SHADE }, // -y, the palm side
    { quad: [5, 1, 3, 7], tone: MID }, // +x
    { quad: [0, 4, 6, 2], tone: SHADE }, // -x, inboard and always in shadow
  ];

  for (const face of faces) {
    const [a, b, c, d] = face.quad;
    const pa = corner(a);
    const pb = corner(b);
    const pc = corner(c);
    const pd = corner(d);
    const normal = faceNormal(pa, pb, pc);
    for (const tri of [
      [pa, pb, pc],
      [pa, pc, pd],
    ]) {
      const tone = face.tone * (box.tone ?? 1);
      for (const point of tri) {
        positions.push(point[0], point[1], point[2]);
        normals.push(normal[0], normal[1], normal[2]);
        colors.push(tone, tone, tone);
      }
    }
  }
}

function faceNormal(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
  c: readonly [number, number, number],
): [number, number, number] {
  const ux = b[0] - a[0];
  const uy = b[1] - a[1];
  const uz = b[2] - a[2];
  const vx = c[0] - a[0];
  const vy = c[1] - a[1];
  const vz = c[2] - a[2];
  const nx = uy * vz - uz * vy;
  const ny = uz * vx - ux * vz;
  const nz = ux * vy - uy * vx;
  const length = Math.hypot(nx, ny, nz) || 1;
  return [nx / length, ny / length, nz / length];
}
