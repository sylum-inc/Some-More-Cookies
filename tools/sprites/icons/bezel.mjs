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
 *             pressed is the same bevel inverted and the whole plate one pixel
 *             lower, which is the entire language of a physical button.
 *   marker-*  reach and focus. The only two sprites here that use `accent`.
 *
 * THE TILING RULE, which is why the edges look the way they do. An edge tile
 * is repeated along its run, so every row of bezel-top must be identical
 * across its whole width and every column of bezel-left identical down its
 * whole height. That forbids `dither()` on the edges — a checker alternates
 * along the run and would strobe once repeated — so the brushed-metal streaks
 * here are solid one-pixel lines lying ALONG the run instead. Which is also
 * how brushed steel actually looks, so the constraint costs nothing.
 *
 * The corner tiles are generated from the same two profiles, indexed by the
 * distance to the nearest outer edge, so a corner meets its neighbouring edges
 * with the identical run of colours and the seam cannot be found.
 */

/** Frame thickness: the profiles are this long, the rest of the cell is world. */
const DEPTH = 13;

/**
 * The lit profile, outer edge first — used by the top and left runs.
 *
 * Read it as a cross-section: a dark outer rim, the chamfer that catches the
 * upper-left light, the panel face with two brushed streaks in it, then the
 * groove cut around the inside, the raised lip, and the shadow the lip throws
 * into the well.
 */
const LIT = [
  'ink', //     0  outer rim
  'steel4', //  1  outer chamfer, facing the light
  'steel3', //  2
  'steel3', //  3  panel face
  'steel2', //  4  brushed streak
  'steel3', //  5
  'steel3', //  6
  'steel2', //  7
  'steel1', //  8  brushed streak
  'steel2', //  9
  'steel1', // 10  groove
  'steel3', // 11  inner lip
  'ink2', //   12  inner shadow line
];

/**
 * The shadowed profile — the bottom and right runs, which face away from the
 * light. Same structure, same depth, but no bright chamfer on the outside: the
 * frame is one object and it is lit from one place.
 */
const DIM = [
  'ink', //     0  outer rim
  'steel2', //  1  outer chamfer, in shadow
  'steel2', //  2
  'steel2', //  3  panel face
  'steel3', //  4  brushed streak
  'steel2', //  5
  'steel2', //  6
  'steel2', //  7
  'steel1', //  8  brushed streak
  'steel2', //  9
  'steel1', // 10  groove
  'steel3', // 11  inner lip, unbroken all the way round
  'ink2', //   12  inner shadow line
];

/**
 * A rivet, on the corner plates only.
 *
 * Corners are not tiled, so they are the one place in the nine-slice that can
 * carry a detail without repeating it into wallpaper — and a frame with a
 * fastener at each corner reads as a panel bolted to a machine rather than as
 * a rectangle.
 */
function rivet(pix, cx, cy) {
  pix.disc(cx, cy, 2.2, 2.2, 'steel1');
  pix.disc(cx, cy, 1.4, 1.4, 'steel3');
  pix.set(cx + 1, cy + 1, 'steel2');
  pix.set(cx - 1, cy - 1, 'steel4');
}

/** Paints a whole cell from a profile chosen per pixel by depth and side. */
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

/** A chamfered square, drawn as an octagon so the corners are not needle sharp. */
function pad(pix, x0, y0, x1, y1, key, chamfer = 3) {
  pix.poly(
    [
      [x0 + chamfer, y0],
      [x1 - chamfer, y0],
      [x1, y0 + chamfer],
      [x1, y1 - chamfer],
      [x1 - chamfer, y1],
      [x0 + chamfer, y1],
      [x0, y1 - chamfer],
      [x0, y0 + chamfer],
    ],
    key,
  );
}

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
      rivet(pix, 5, 5);
      pix.outline();
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
      rivet(pix, 26, 5);
      pix.outline();
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
      rivet(pix, 5, 26);
      pix.outline();
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
      rivet(pix, 26, 26);
      pix.outline();
    },
  },
  {
    name: 'bezel-top',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(0, d, 32, 1, LIT[d]);
      pix.outline();
    },
  },
  {
    name: 'bezel-bottom',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(0, 31 - d, 32, 1, DIM[d]);
      pix.outline();
    },
  },
  {
    name: 'bezel-left',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(d, 0, 1, 32, LIT[d]);
      pix.outline();
    },
  },
  {
    name: 'bezel-right',
    draw(pix) {
      for (let d = 0; d < DEPTH; d++) pix.rect(31 - d, 0, 1, 32, DIM[d]);
      pix.outline();
    },
  },

  /* ---- plates ------------------------------------------------------------ */

  {
    name: 'plate-idle',
    draw(pix) {
      // Raised: a light rim left along the top-left, a dark one along the
      // bottom-right, by drawing the same shape three times, each one pixel in.
      pad(pix, 4, 4, 27, 27, 'steel4');
      pad(pix, 5, 5, 27, 27, 'steel1');
      pad(pix, 6, 6, 26, 26, 'steel2');
      // The face is not flat — a little light pooled in the upper left keeps a
      // 24-pixel plate from looking like a hole.
      pix.dither(8, 8, 12, 2, 'steel3');
      pix.dither(8, 10, 9, 2, 'steel3');
      pix.dither(8, 12, 6, 2, 'steel3');
      pix.outline();
    },
  },
  {
    name: 'plate-press',
    draw(pix) {
      // Pressed: everything one pixel lower and the bevel the other way about
      // — dark rim on the top-left now, light along the bottom-right.
      pad(pix, 4, 5, 27, 28, 'steel4');
      pad(pix, 4, 5, 26, 27, 'steel1');
      pad(pix, 5, 6, 26, 27, 'steel2');
      pix.dither(7, 9, 12, 2, 'steel1');
      pix.dither(7, 11, 9, 2, 'steel1');
      pix.dither(7, 13, 6, 2, 'steel1');
      pix.outline();
    },
  },
  {
    name: 'plate-round-idle',
    draw(pix) {
      pix.disc(16, 16, 12, 12, 'steel1');
      pix.disc(15.4, 15.4, 11.4, 11.4, 'steel4');
      pix.disc(16, 16, 10.2, 10.2, 'steel2');
      pix.dither(10, 9, 11, 2, 'steel3');
      pix.dither(10, 11, 8, 2, 'steel3');
      pix.dither(10, 13, 5, 2, 'steel3');
      pix.outline();
    },
  },
  {
    name: 'plate-round-press',
    draw(pix) {
      pix.disc(16, 17, 12, 12, 'steel4');
      pix.disc(15.4, 16.4, 11.4, 11.4, 'steel1');
      pix.disc(16, 17, 10.2, 10.2, 'steel2');
      pix.dither(10, 11, 11, 2, 'steel1');
      pix.dither(10, 13, 8, 2, 'steel1');
      pix.dither(10, 15, 5, 2, 'steel1');
      pix.outline();
    },
  },

  /* ---- markers ----------------------------------------------------------- */

  {
    name: 'marker-reach',
    draw(pix) {
      // A kite hanging over the thing you can reach: broad shoulders, long
      // point down. Down, because it hangs above what it means.
      pix.poly(
        [
          [16, 6],
          [23, 13],
          [16, 25],
          [9, 13],
        ],
        'ember2',
      );
      pix.poly(
        [
          [16, 7],
          [21, 13],
          [16, 23],
          [11, 13],
        ],
        'accent',
      );
      // The lit half is the upper left; the rest of the kite falls away.
      pix.poly(
        [
          [16, 8],
          [21, 13],
          [16, 23],
          [17, 12],
        ],
        'ember3',
      );
      pix.set(14, 11, 'cream4');
      pix.set(15, 10, 'cream4');
      pix.outline();
    },
  },
  {
    name: 'marker-focus',
    draw(pix) {
      // Two brackets facing each other round an empty middle. The gap is the
      // target: nothing is drawn there but a pip, so whatever is being framed
      // stays visible through it.
      const bracket = (x, dir) => {
        pix.rect(x, 6, 2, 20, 'accent'); // the spine
        pix.rect(x + dir * 2, 6, 4, 2, 'accent'); // upper arm
        pix.rect(x + dir * 2, 24, 4, 2, 'accent'); // lower arm
      };
      bracket(5, 1);
      bracket(25, -1);
      // A tick from each spine toward the middle. Two bare brackets are a pair
      // of punctuation marks; two brackets aiming at a pip are a reticle.
      pix.rect(7, 15, 2, 2, 'accent');
      pix.rect(23, 15, 2, 2, 'accent');
      // Shadowed faces: the inside of the left bracket and all of the right.
      pix.rect(6, 8, 1, 16, 'ember2');
      pix.rect(25, 6, 1, 20, 'ember2');
      pix.rect(5, 6, 1, 3, 'cream4');
      // The pip in the middle, so an empty bracket pair still points somewhere.
      pix.rect(15, 15, 3, 3, 'accent');
      pix.set(15, 15, 'cream4');
      pix.outline();
    },
  },
];
