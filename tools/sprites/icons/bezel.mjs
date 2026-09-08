/**
 * bezel — the HUD's own furniture: the frame, not the icons.
 *
 * Everything else in this folder is a thing the player looks AT. This family
 * is what those things sit in, so its whole job is to be structural and then
 * shut up: one material (steel), one light, no accent anywhere except on the
 * two markers, which are attention itself and nothing else.
 *
 * Three groups:
 *
 *   bezel-*   a nine-slice panel. Four corners and four edges of brushed steel
 *             with a bevelled inner lip. The frame's thickness is thirteen
 *             pixels of the cell, measured from the OUTER edge inward, and the
 *             rest of each cell is transparent because that is where the world
 *             shows through.
 *   plate-*   the pad an icon sits on. Square and round, idle and pressed;
 *             pressed is the same bevel inverted AND the face a step darker,
 *             because a rim swap alone is invisible at 1x.
 *   marker-*  reach and focus. The only two sprites here that use `accent`,
 *             and they share one body value and one shadow value so they read
 *             as a pair the way the eight bezel tiles read as one panel.
 *
 * THE TILING RULE, which is why the edges look the way they do. An edge tile
 * is repeated along its run, so every row of bezel-top must be identical
 * across its whole width and every column of bezel-left identical down its
 * whole height. That forbids `dither()` on the edges — a checker alternates
 * along the run and would strobe once repeated — so the brushed-metal streak
 * here is a solid one-pixel line lying ALONG the run instead. Which is also
 * how brushed steel actually looks, so the constraint costs nothing.
 *
 * The corner tiles are generated from the same two profiles, indexed by the
 * distance to the nearest outer edge, so a corner meets its neighbouring edges
 * with the identical run of colours and the seam cannot be found.
 */

/**
 * Frame thickness: the profiles are this long, the rest of the cell is world.
 * It must equal `FRAME_SLICE` in `../build.mjs` exactly — a frame whose
 * artwork is deeper than its slice ships a row the border-image never draws.
 */
const DEPTH = 9;

/**
 * The lit profile, outer edge first — used by the top and left runs.
 *
 * Read it as a cross-section: a hard outer rim, the two-pixel chamfer that
 * catches the upper-left light, the panel face with a single brushed streak in
 * it, then the groove cut around the inside, the raised lip, and the hard edge
 * where the frame stops and the world starts.
 *
 * A monotone falloff with ONE interruption. Four values and no more, because
 * nine pixels of depth read as banding rather than as bevel the moment they
 * carry five value reversals.
 *
 * **Cream plastic, not brushed steel, and thinner than it was.** The first
 * version of this was a cold #6a7787 chrome picture-frame thirteen pixels
 * deep, and an art director's verdict on it was blunt and correct: at that
 * chroma and that width it was the coldest, most saturated element on the
 * screen, competing with the campfire it was supposed to be framing, and it
 * belonged to no product. What this is imitating is a handheld from about
 * 1998, and those were warm off-white ABS that had gone slightly yellow, with
 * a dark olive lip around the screen. Warm plastic sits *behind* the fire in
 * the colour hierarchy instead of in front of it, which is the whole job of a
 * bezel. Nine pixels because twenty-six a side out of a phone's 393 was a
 * quarter of the picture.
 */
const LIT = [
  'ink2', //   0  outer rim, warm-black rather than a hard line
  'cream4', // 1  chamfer, facing the light
  'cream3', // 2  panel face
  'cream3', // 3
  'cream4', // 4  moulding seam — the one interruption
  'cream3', // 5
  'cream2', // 6  the face falling away toward the well
  'green1', // 7  olive lip around the screen
  'ink2', //   8  inner edge, hard against the world
];

/**
 * The shadowed profile — the bottom and right runs, which face away from the
 * light. The SAME cross-section one ramp step down, never a flatter one: a
 * shadowed chamfer is still a chamfer, and deleting it leaves the bottom of
 * the frame reading as an unbevelled plank beside a modelled top.
 *
 * Every value here is drawn from the same four as LIT, so a miter corner that
 * carries both profiles still holds four values total.
 */
const DIM = [
  'ink2', //   0  outer rim
  'ink2', //   1  chamfer, turned away — the rim thickens into shadow
  'cream2', // 2  panel face
  'cream2', // 3
  'cream3', // 4  moulding seam, same place, dimmer
  'cream2', // 5
  'cream1', // 6  falling away
  'green1', // 7  olive lip, unchanged: a lip in shadow is still the lip
  'ink2', //   8  inner edge
];

/**
 * A rivet, on the corner plates only.
 *
 * Corners are not tiled, so they are the one place in the nine-slice that can
 * carry a detail without repeating it into wallpaper — and a frame with a
 * fastener at each corner reads as a panel bolted to a machine rather than as
 * a rectangle.
 *
 * The ring is ink, not steel1, so the same stud reads with the same contrast
 * on the lit panel face and on the shadowed one. Four rivets that look like
 * four different objects are worse than no rivets.
 */
function rivet(pix, cx, cy) {
  pix.disc(cx, cy, 2.4, 2.4, 'ink2'); // ring, dark against either face
  pix.disc(cx, cy, 1.4, 1.4, 'steel3'); // cap
  pix.set(cx - 1, cy - 1, 'steel4'); // catch-light, upper left
  pix.set(cx + 1, cy + 1, 'steel2'); // the drop it throws, lower right
}

/**
 * Paints a whole cell from a profile chosen per pixel by depth and side.
 *
 * These tiles deliberately do NOT call `outline()`. Three of every tile's four
 * sides bleed to the cell edge, where an outline has nothing to sit on, and on
 * the fourth it would add a fourteenth row to artwork the build slices at
 * thirteen. Index 0 of both profiles is ink: the hard outer edge is drawn, not
 * derived.
 */
function nineSlice(pix, depthOf, profileOf) {
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      const d = depthOf(x, y);
      if (d < DEPTH) pix.set(x, y, profileOf(x, y)[d]);
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Plates                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * A chamfered square as a membership test: an octagon, so the corners are not
 * needle sharp. Predicates rather than polygons because the bevel below needs
 * to ask "is this pixel two in from the edge", which a fill cannot answer.
 */
function octagon(x0, y0, x1, y1, chamfer) {
  return (x, y) =>
    x >= x0 &&
    x <= x1 &&
    y >= y0 &&
    y <= y1 &&
    x - x0 + (y - y0) >= chamfer &&
    x1 - x + (y - y0) >= chamfer &&
    x - x0 + (y1 - y) >= chamfer &&
    x1 - x + (y1 - y) >= chamfer;
}

/**
 * The round plate, as an explicit half-width per row.
 *
 * Not `disc()`. A rasteriser with a tolerance produces a circle whose edge
 * jitters by a pixel per row, and a bevel built from two discs a fraction of a
 * pixel apart produces a ring that closes all the way round instead of a
 * crescent — a wobbly coin, not a lit button. A table steps cleanly and is
 * exactly twenty-four across, which is what the square plate beside it is.
 */
const ROUND_HALF = [
  5, 7, 9, 10, 11, 11, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 12, 11, 11, 10, 9, 7, 5,
];
const round = (x, y) => {
  const half = ROUND_HALF[y - 4];
  return half !== undefined && x >= 16 - half && x <= 15 + half;
};

/** Everything at least two pixels in from the shape's edge — i.e. not the rim. */
const INSET = [
  [0, 0],
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
  [2, 0],
  [-2, 0],
  [0, 2],
  [0, -2],
];
const core = (inside) => (x, y) => INSET.every(([dx, dy]) => inside(x + dx, y + dy));

/**
 * A plate with a two-pixel bevel and a face.
 *
 * Two pixels, not one: the whole difference between idle and pressed is which
 * side of the rim is bright, and one pixel of that at 24px is a difference a
 * player cannot see. The pressed face also drops a whole ramp step — dithered
 * steel1 through the steel2 — so the two states differ in overall value and
 * not only in where their highlight sits.
 */
function plate(pix, inside, pressed) {
  const face = core(inside);
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (!inside(x, y)) continue;
      if (!face(x, y)) {
        // Light from the upper left: the anti-diagonal through the centre
        // splits the rim into the half that faces it and the half that does not.
        const lit = x + y < 31;
        pix.set(x, y, lit !== pressed ? 'steel4' : 'steel1');
      } else if (pressed) {
        pix.set(x, y, (x + y) % 2 === 0 ? 'steel1' : 'steel2');
      } else {
        pix.set(x, y, 'steel2');
      }
    }
  }
  // Idle only: a sheen dithered into the face just inside the lit rim, and
  // nowhere else. A raised face with nothing on it reads as a hole no matter
  // how bright its edge is — but the light on a domed button pools against the
  // bevel it came over, so this is a crescent hugging the rim rather than a
  // patch parked in the corner.
  if (!pressed) {
    const deep = core(core(face));
    for (let y = 0; y < 32; y++) {
      for (let x = 0; x < 32; x++) {
        if (face(x, y) && !deep(x, y) && x + y < 31 && (x + y) % 2 === 0) {
          pix.set(x, y, 'steel4');
        }
      }
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Markers                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Repaints every `body` pixel whose neighbour in direction (dx, dy) is empty.
 *
 * The markers are flat cut-outs, so their only modelling is the rim, and the
 * rim has to be lit from one place: this is called with (1, 0) and (0, 1) for
 * the faces that turn away from the light and never for the other two, which
 * is what keeps `accent` running all the way to the outline on the upper left.
 */
function rimFacing(pix, body, key, dx, dy) {
  const hits = [];
  for (let y = 0; y < 32; y++) {
    for (let x = 0; x < 32; x++) {
      if (pix.get(x, y) === body && pix.get(x + dx, y + dy) === 'none') hits.push([x, y]);
    }
  }
  for (const [x, y] of hits) pix.set(x, y, key);
}

/** One corner elbow of the reticle: two arms, seven long and three thick. */
function elbow(pix, x, y, sx, sy) {
  const ax = sx > 0 ? x : x - 6;
  const ay = sy > 0 ? y : y - 6;
  pix.rect(ax, sy > 0 ? y : y - 2, 7, 3, 'accent'); // arm along the run
  pix.rect(sx > 0 ? x : x - 2, ay, 3, 7, 'accent'); // arm down the side
}

/**
 * The pin's silhouette: the width of each row, top row first.
 *
 * A round head in the first nine rows and then a stem that steps in hard and
 * runs twelve more to a single-pixel point. Both halves matter. The widest row
 * has to sit near the top, because a shape that reaches its widest halfway
 * down is a faceted gem, and on a screen full of ember icons a gem reads as
 * loot rather than as attention. And the step from head to stem has to be
 * abrupt — taper the head smoothly into the point and the two become one cone,
 * which is a funnel.
 */
const PIN = [9, 13, 15, 17, 17, 17, 15, 13, 13, 5, 5, 5, 5, 5, 5, 3, 3, 3, 3, 1, 1];

export const SPRITES = [
  /* ---- the nine-slice ---------------------------------------------------- */

  {
    name: 'bezel-tl',
    draw(pix) {
      nineSlice(
        pix,
        (x, y) => Math.min(x, y),
        () => LIT,
      );
      rivet(pix, 7, 7);
    },
  },
  {
    name: 'bezel-tr',
    draw(pix) {
      // The miter runs corner to corner: above it the top run's light profile,
      // below it the right run's dark one, so both neighbours match exactly.
      nineSlice(
        pix,
        (x, y) => Math.min(y, 31 - x),
        (x, y) => (y <= 31 - x ? LIT : DIM),
      );
      rivet(pix, 24, 7);
    },
  },
  {
    name: 'bezel-bl',
    draw(pix) {
      nineSlice(
        pix,
        (x, y) => Math.min(x, 31 - y),
        (x, y) => (x <= 31 - y ? LIT : DIM),
      );
      rivet(pix, 7, 24);
    },
  },
  {
    name: 'bezel-br',
    draw(pix) {
      nineSlice(
        pix,
        (x, y) => Math.min(31 - x, 31 - y),
        () => DIM,
      );
      rivet(pix, 24, 24);
    },
  },
  {
    name: 'bezel-top',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(0, d, 32, 1, LIT[d]);
    },
  },
  {
    name: 'bezel-bottom',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(0, 31 - d, 32, 1, DIM[d]);
    },
  },
  {
    name: 'bezel-left',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(d, 0, 1, 32, LIT[d]);
    },
  },
  {
    name: 'bezel-right',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(31 - d, 0, 1, 32, DIM[d]);
    },
  },

  /* ---- plates ------------------------------------------------------------ */

  {
    name: 'plate-idle',
    draw(pix) {
      plate(pix, octagon(4, 4, 27, 27, 4), false);
      pix.outline();
    },
  },
  {
    name: 'plate-press',
    draw(pix) {
      // Same footprint, same twenty-four pixels. A button that grows when you
      // press it is not a button; the bevel flips and the face sinks instead.
      plate(pix, octagon(4, 4, 27, 27, 4), true);
      pix.outline();
    },
  },
  {
    name: 'plate-round-idle',
    draw(pix) {
      plate(pix, round, false);
      pix.outline();
    },
  },
  {
    name: 'plate-round-press',
    draw(pix) {
      plate(pix, round, true);
      pix.outline();
    },
  },

  /* ---- markers ----------------------------------------------------------- */

  {
    name: 'marker-reach',
    draw(pix) {
      // A pin hanging over the thing you can reach: a heavy head in the top
      // third, then a stem down to a point. Down, because it hangs above what
      // it means, and the head is what makes that direction legible.
      PIN.forEach((w, i) => pix.rect(16 - (w - 1) / 2, 6 + i, w, 1, 'accent'));

      // Light from the upper left, so only the right and lower faces darken.
      // The upper-left edge runs accent straight into the outline, which is
      // where a highlight can then actually sit.
      rimFacing(pix, 'accent', 'ember2', 1, 0);
      rimFacing(pix, 'accent', 'ember2', 0, 1);
      // A second pixel of shade round the underside of the head and down the
      // tail, so the lower half has form rather than a hairline.
      for (let i = 3; i < PIN.length; i++) {
        const w = PIN[i];
        if (w >= 5) pix.set(16 + (w - 1) / 2 - 1, 6 + i, 'ember2');
      }

      // The specular, running along the upper-left rim of the head. It sits ON
      // the edge, which is the only place a highlight belongs; floating in the
      // middle of the body it reads as dirt.
      for (const [x, y] of [
        [12, 6],
        [13, 6],
        [14, 6],
        [10, 7],
        [11, 7],
        [9, 8],
        [8, 9],
        [8, 10],
      ]) {
        pix.set(x, y, 'cream4');
      }

      pix.outline();
    },
  },
  {
    name: 'marker-focus',
    draw(pix) {
      // Four corner elbows aiming inward. NOT two full-height brackets: a pair
      // of tall brackets round a middle dot is punctuation, and punctuation is
      // letterforms. Corners cannot be read as glyphs, the middle of every side
      // is empty, and there is nothing in the centre — whatever is being framed
      // shows through, which is the entire point of a reticle.
      elbow(pix, 6, 6, 1, 1);
      elbow(pix, 25, 6, -1, 1);
      elbow(pix, 6, 25, 1, -1);
      elbow(pix, 25, 25, -1, -1);

      // One light, four elbows: right and lower faces shade, upper-left corners
      // catch. Both markers share `accent` as the body and `ember2` as the
      // shadow, so the pair are the same material.
      rimFacing(pix, 'accent', 'ember2', 1, 0);
      rimFacing(pix, 'accent', 'ember2', 0, 1);
      for (const [cx, cy] of [
        [6, 6],
        [19, 6],
        [6, 19],
        [23, 19],
      ]) {
        pix.set(cx, cy, 'cream4');
        pix.set(cx + 1, cy, 'cream4');
        pix.set(cx, cy + 1, 'cream4');
      }

      pix.outline();
    },
  },
];
