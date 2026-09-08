/**
 * verbs — the twelve things a player does to the fire and to the world.
 *
 * These live on buttons, so they are read in a quarter second, side by side,
 * over and over. That makes consistency worth more here than invention: the
 * set shares one bed of coals, one stick, one kind of hand and one kind of
 * motion mark, so a verb is understood by what CHANGES between icons rather
 * than by being studied on its own.
 *
 * The vocabulary:
 *
 *   coals   the ember bed. It takes no arguments on purpose — five buttons in
 *           a row must share one floor, and a floor that drifts three pixels
 *           per icon makes the whole bar jitter as the eye moves along it.
 *   stick   three pixels thick, lit along its upper-left edge. On the tool
 *           verbs there is no hand at all: the shaft simply runs to the edge
 *           of the art box, and a tool leaving the cell reads as held. A fist
 *           drawn around it only ever read as a mitten.
 *   hand    cream, entering from the upper right, with a blue (sky) cuff
 *           behind it. It is cut on the OUTER contour — finger gaps that
 *           `outline()` fills with ink — so it is a hand in flat black and not
 *           only in colour. Where the hand appears next to food it drops a
 *           value, so it is never the same mass as the marshmallow.
 *   motion  a `steel4` arrow: two-pixel shaft, three-deep solid head, never
 *           shorter than eight pixels. Steel is the one ramp no verb uses as
 *           a material, which is the point — motion must not be the same
 *           value as matter, or the mark reads as a thing rather than a move.
 *
 * `accent` appears exactly once in the family, on the bundle in verb-take,
 * because that is the palette's rule: the accent is what the world wants you
 * to look at, and the thing you are about to pick up is the only such thing
 * in these twelve.
 *
 * Every sprite keeps its ink inside x,y 4..27 so `outline()` and `shadow()`
 * have margin to live in and nothing bleeds into the atlas neighbour.
 */

/** Motion is steel. No verb draws a steel object, so nothing else is this colour. */
const MOTION = 'steel4';

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The bed of coals: dark at the rim, hot through the middle.
 *
 * No parameters. The fire is the floor of this set and a floor is only a floor
 * if it is in the same place on every button.
 */
function coals(pix) {
  pix.disc(16, 25, 9, 2.6, 'ember1');
  pix.disc(16, 25, 7.6, 1.9, 'ember2');
  pix.dither(9, 23, 14, 3, 'ember3');
  pix.disc(15, 24.7, 4, 1, 'ember3');
  pix.set(12, 24, 'ember4');
  pix.set(13, 24, 'ember4');
  pix.set(18, 25, 'ember4');
  pix.set(20, 24, 'ember3');
}

/**
 * The stick: three pixels thick, dark on the trailing side, lit on the side
 * facing the upper-left light. Steep sticks thicken sideways and shallow ones
 * thicken vertically, which keeps the width even at any angle.
 */
function stick(pix, x0, y0, x1, y1) {
  const steep = Math.abs(y1 - y0) >= Math.abs(x1 - x0);
  const ox = steep ? 1 : 0;
  const oy = steep ? 0 : 1;
  pix.line(x0 + ox, y0 + oy, x1 + ox, y1 + oy, 'wood2');
  pix.line(x0, y0, x1, y1, 'wood3');
  pix.line(x0 - ox, y0 - oy, x1 - ox, y1 - oy, 'wood4');
}

/** A cut log: a capsule of discs, with a pale sawn end at (x1,y1). */
function logBody(pix, x0, y0, x1, y1, r) {
  const along = (t) => [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
  const steps = 28;
  for (let i = 0; i <= steps; i++) {
    const [x, y] = along(i / steps);
    pix.disc(x, y, r, r, 'wood1');
  }
  for (let i = 0; i <= steps; i++) {
    const [x, y] = along(i / steps);
    pix.disc(x - 0.3, y - 0.6, r - 0.6, r - 0.6, 'wood2');
  }
  for (let i = 0; i <= steps; i += 2) {
    const [x, y] = along(i / steps);
    pix.disc(x - 0.6, y - 1.2, r - 1.7, r - 1.7, 'wood3');
  }
  pix.disc(x1, y1, r - 0.4, r - 0.4, 'wood2');
  pix.disc(x1 - 0.3, y1 - 0.3, r - 1.4, r - 1.4, 'wood4');
}

/**
 * Bites a notch out of the top contour of whatever is already drawn in a
 * column. Bark on a log has to be cut out of the SILHOUETTE — painted on the
 * inside it vanishes the moment the icon is small, which is always.
 */
function notchTop(pix, x, depth = 1) {
  for (let y = 0; y < pix.height; y++) {
    if (pix.get(x, y) === 'none') continue;
    for (let d = 0; d < depth; d++) pix.set(x, y + d, 'none');
    return;
  }
}

/** The sleeve. Drawn before the hand, so the hand sits in front of it. */
function cuff(pix, cx, cy) {
  pix.disc(cx, cy, 3, 3, 'sky1');
  pix.disc(cx - 0.3, cy - 0.3, 2.4, 2.4, 'sky3');
  pix.set(cx - 2, cy - 2, 'sky4');
  pix.set(cx - 1, cy - 2, 'sky4');
}

/**
 * A hand from the back, fingers hanging down, reaching for what is below it.
 *
 * The fingers are separate two-pixel columns with one-pixel gaps, which
 * `outline()` fills with ink: the separations are cuts in the outer contour
 * rather than lines painted inside a blob, so this is still a hand when the
 * whole icon is a flat black cut-out. It is drawn cream1..cream3 — a value
 * below the marshmallow, so a hand over food is never mistaken for more food.
 */
function handDown(pix, cx, cy) {
  const left = cx - 4;
  // The back of the hand slopes up toward the wrist, and the fingers step
  // shorter across it. A flat block with even stubs is just one more layer on
  // a stack of layers; a wedge with a raked edge is a hand.
  pix.poly(
    [[left + 3, cy - 5], [left + 9, cy - 5], [left + 9, cy], [left, cy], [left, cy - 2]],
    'cream2',
  );
  pix.line(left + 3, cy - 5, left + 9, cy - 5, 'cream3');
  pix.line(left, cy - 2, left + 3, cy - 5, 'cream3');
  [5, 4, 3].forEach((h, i) => {
    const x = left + i * 3;
    pix.rect(x, cy, 2, h, 'cream2');
    pix.set(x, cy, 'cream3');
    pix.rect(x, cy + h - 1, 2, 1, 'cream1');
  });
  // Thumb, tucked under on the near side.
  pix.rect(left - 2, cy - 3, 2, 4, 'cream2');
  pix.set(left - 2, cy - 3, 'cream3');
  pix.set(left - 2, cy, 'cream1');
}

/**
 * An open palm, fingers up. The one-pixel gaps between fingers are left empty
 * on purpose: `outline()` fills them with ink, which is darker and cheaper
 * than drawing the separations by hand.
 */
function openHand(pix, cx, cy) {
  const left = cx - 7;
  [3, 5, 5, 3].forEach((h, i) => {
    const x = left + i * 3;
    pix.rect(x, cy - h, 2, h + 2, 'cream3');
    pix.set(x, cy - h, 'cream4');
  });
  pix.rect(left, cy, 11, 4, 'cream3');
  pix.rect(left, cy + 3, 11, 1, 'cream1');
  pix.rect(left, cy, 4, 1, 'cream4');
  // Thumb, out to the right.
  pix.rect(left + 11, cy - 1, 3, 3, 'cream3');
  pix.set(left + 11, cy - 1, 'cream4');
  pix.set(left + 13, cy + 1, 'cream1');
}

/**
 * The motion mark: two-pixel shaft, solid three-deep head, tip at (x,y).
 *
 * Eight pixels is the floor. Below that the head outweighs the stem and the
 * whole mark collapses into a four-point sparkle, which is a glint, which is
 * a thing, which is the opposite of what an arrow is for.
 */
function arrow(pix, x, y, dx, dy, len = 8, key = MOTION) {
  const n = Math.max(8, len);
  const px = -dy;
  const py = dx;
  for (let i = 0; i <= 2; i++) {
    const bx = x - dx * i;
    const by = y - dy * i;
    pix.line(bx - px * i, by - py * i, bx + px * i, by + py * i, key);
  }
  for (let i = 3; i <= n; i++) {
    pix.set(x - dx * i, y - dy * i, key);
    pix.set(x - dx * i + px, y - dy * i + py, key);
  }
}

/** A spark: two by two, so `outline()` leaves a lit core rather than a dot. */
function spark(pix, x, y, key = 'ember4') {
  pix.rect(x, y, 2, 2, key);
}

/** A head, same cream as the hands. Used by the two body verbs. */
function head(pix, cx, cy) {
  pix.disc(cx, cy, 3.2, 3.2, 'cream1');
  pix.disc(cx - 0.4, cy - 0.4, 2.6, 2.6, 'cream3');
  pix.set(cx - 2, cy - 2, 'cream4');
  pix.set(cx - 1, cy - 2, 'cream4');
}

/** The floor the two body verbs stand on. Both of them, at the same height. */
function ground(pix, x, w) {
  pix.rect(x, 25, w, 2, 'stone2');
  pix.dither(x, 25, w, 1, 'stone3');
}

/* -------------------------------------------------------------------------- */
/* The verbs                                                                  */
/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // A near-vertical shaft driven straight down, its tip swallowed by the bed
    // and the coals parted around it. Upright bar, split floor — nothing else
    // in the set has that silhouette.
    name: 'verb-poke',
    draw(pix) {
      coals(pix);
      stick(pix, 19, 5, 15, 22);

      // The tip goes IN: embers painted back over the last two rows of shaft.
      pix.set(14, 22, 'ember2');
      pix.set(15, 22, 'ember3');
      pix.set(16, 22, 'ember4');

      // The bed parts around it — a dark slot with a hot lip either side.
      pix.set(15, 23, 'ember1');
      pix.set(16, 23, 'ink2');
      pix.set(15, 24, 'ink2');
      pix.set(16, 24, 'ember1');
      pix.set(12, 23, 'ember4');
      pix.set(13, 23, 'ember3');
      pix.set(19, 23, 'ember3');
      pix.set(20, 23, 'ember4');

      spark(pix, 10, 17, 'ember4');
      spark(pix, 7, 12, 'ember3');
      spark(pix, 11, 11, 'ember4');
      pix.outline();
    },
  },

  {
    // The same shaft laid almost flat and dragged left, with a spill of embers
    // hauled out of the bed behind the tip. The trail is part of the shape:
    // the fire itself is smeared sideways, which no other verb does.
    name: 'verb-rake',
    draw(pix) {
      coals(pix);

      // Heaped ahead of the tip and spilled behind it. The heap rises well
      // clear of the bed line, so the drag is in the silhouette and not only
      // in the colour.
      pix.poly([[4, 27], [6, 22], [9, 19], [12, 23], [11, 27]], 'ember1');
      pix.poly([[5, 27], [7, 23], [9, 20], [11, 23], [10, 27]], 'ember2');
      pix.poly([[6, 26], [8, 22], [10, 22], [10, 25], [8, 26]], 'ember3');
      pix.set(8, 20, 'ember4');
      pix.set(9, 21, 'ember4');
      pix.set(6, 24, 'ember3');

      stick(pix, 27, 14, 13, 22);
      arrow(pix, 5, 10, -1, 0, 9);
      pix.outline();
    },
  },

  {
    // Ash pulled over the fire for the night. No stick at all: the mound IS
    // the verb, and a mound is unlike anything else on the bar. Embers still
    // glow out from under both feet of it.
    name: 'verb-bank',
    draw(pix) {
      coals(pix);
      pix.poly([[7, 27], [9, 22], [13, 19], [18, 19], [23, 21], [25, 25], [26, 27]], 'stone1');
      pix.poly([[9, 27], [11, 23], [14, 20], [18, 20], [22, 22], [23, 26], [24, 27]], 'stone2');
      pix.poly([[10, 26], [13, 21], [18, 21], [21, 23], [19, 25], [12, 26]], 'stone3');
      pix.dither(11, 21, 10, 4, 'stone4');
      pix.set(14, 20, 'stone4');
      pix.set(15, 20, 'stone4');
      pix.set(16, 20, 'stone4');
      // Crumbly at the crown — ash heaped by hand, not a boulder.
      notchTop(pix, 12, 1);
      notchTop(pix, 17, 1);
      notchTop(pix, 21, 1);

      // Still alight: through the ash, and out from under both feet.
      pix.set(15, 23, 'ember3');
      pix.set(19, 24, 'ember3');
      pix.set(7, 25, 'ember3');
      pix.set(7, 26, 'ember4');
      pix.set(24, 27, 'ember4');
      pix.set(25, 27, 'ember3');

      arrow(pix, 20, 13, 0, 1, 8);
      pix.outline();
    },
  },

  {
    // A log lowered onto the fire. No hand: a round leaving the frame reads as
    // carried, and a fist drawn round it only ever fused with it into one
    // horizontal sausage. Tilted well off the rake's shallow shaft, twice its
    // thickness, ringed at the sawn face and notched along the bark, held
    // clear above the bed with the drop marked in the gap.
    name: 'verb-add-log',
    draw(pix) {
      coals(pix);
      logBody(pix, 25, 8, 15, 16, 2.8);
      // Growth rings on the sawn face — the one detail that names a cut log.
      pix.ring(15, 16, 1.6, 1.6, 'wood2');
      pix.set(15, 16, 'wood4');
      // Bark bitten out of the top edge.
      notchTop(pix, 18, 1);
      notchTop(pix, 21, 1);
      notchTop(pix, 24, 1);

      arrow(pix, 6, 21, 0, 1, 8);
      pix.outline();
    },
  },

  {
    // A match at the instant it takes. One long diagonal, corner to corner:
    // family-standard shaft lit up its upper-left edge, a teardrop head fatter
    // at the tip than the wood, and sparks thrown off the head itself.
    name: 'verb-strike',
    draw(pix) {
      stick(pix, 26, 25, 13, 13);

      // Head: three discs down to nothing, so it tapers into the shaft.
      pix.disc(9.5, 9.5, 3, 3, 'ember1');
      pix.disc(11.5, 11.5, 2.2, 2.2, 'ember1');
      pix.disc(13, 13, 1.6, 1.6, 'ember1');
      pix.disc(9.2, 9.2, 2.2, 2.2, 'ember2');
      pix.disc(11.2, 11.2, 1.5, 1.5, 'ember2');
      pix.disc(9, 9, 1.4, 1.4, 'ember3');
      pix.set(8, 8, 'ember4');
      pix.set(9, 8, 'ember4');
      pix.set(8, 9, 'ember4');

      // Sparks, touching the head rather than floating near it.
      spark(pix, 5, 7, 'ember4');
      spark(pix, 9, 5, 'ember3');
      spark(pix, 5, 11, 'ember3');
      pix.outline();
    },
  },

  {
    // Breath on embers. Two tapering bands enter from the left edge and run
    // all the way into the bed — one continuous gesture, in sky blue so it is
    // plainly air and not another cream object — and the flame leans away.
    name: 'verb-blow',
    draw(pix) {
      coals(pix);

      // The flame leans right, off the wind. A symmetric spike reads as a leaf.
      pix.poly([[13, 23], [15, 18], [17, 13], [20, 17], [19, 23]], 'ember2');
      pix.poly([[15, 22], [16, 18], [17, 15], [19, 18], [18, 22]], 'ember3');
      pix.poly([[16, 21], [17, 17], [18, 20], [17, 21]], 'ember4');
      spark(pix, 20, 10, 'ember3');

      // Breath: fat where it enters, thin where it lands, touching the coals.
      const band = (pts) => {
        for (let i = 0; i + 1 < pts.length; i++) {
          pix.line(pts[i][0], pts[i][1], pts[i + 1][0], pts[i + 1][1], 'sky4');
        }
        pix.line(pts[0][0], pts[0][1] + 1, pts[1][0], pts[1][1] + 1, 'sky3');
        pix.set(pts[0][0], pts[0][1] + 2, 'sky3');
      };
      band([[4, 10], [8, 13], [11, 17], [13, 23]]);
      band([[4, 17], [8, 20], [11, 23]]);
      pix.outline();
    },
  },

  {
    // Picking something up: open palm below with the sleeve straight beneath
    // the wrist, the bundle held clear above it, motion falling either side.
    // The one accent in the family is that bundle.
    name: 'verb-take',
    draw(pix) {
      cuff(pix, 13, 24);
      openHand(pix, 15, 20);

      // A tied bundle. Two ears and a neck, so the silhouette names an object
      // to be picked up rather than reading as a coin or a yolk.
      pix.line(13, 4, 15, 7, 'wood2');
      pix.line(19, 4, 17, 7, 'wood2');
      pix.disc(16, 9, 3.2, 2.6, 'wood2');
      pix.disc(16, 8.7, 2.4, 1.9, 'accent');
      pix.rect(15, 6, 3, 1, 'wood1');
      pix.set(14, 8, 'cream4');
      pix.set(15, 8, 'cream4');
      pix.set(18, 10, 'wood1');

      arrow(pix, 6, 13, 0, 1, 8);
      arrow(pix, 25, 13, 0, 1, 8);
      pix.outline();
    },
  },

  {
    // Sitting: the same body as verb-stand, folded onto a log — and standing
    // on the same floor, so the figure does not hop between the two buttons.
    name: 'verb-sit',
    draw(pix) {
      ground(pix, 5, 20);
      logBody(pix, 24, 22, 14, 22, 2.4);

      pix.poly([[13, 12], [18, 12], [19, 20], [13, 20]], 'sky3');
      pix.rect(13, 12, 2, 8, 'sky4');
      pix.rect(18, 13, 1, 7, 'sky2');
      // Thigh forward, shin down to the floor.
      pix.rect(8, 18, 6, 3, 'sky2');
      pix.rect(8, 18, 6, 1, 'sky3');
      pix.rect(8, 21, 3, 4, 'sky2');
      pix.rect(8, 21, 1, 4, 'sky3');
      head(pix, 15, 9);
      pix.rect(12, 14, 2, 5, 'sky4');
      pix.rect(10, 18, 2, 2, 'cream3');
      pix.outline();
    },
  },

  {
    // Standing: upright, feet on the same floor as verb-sit, one mark rising
    // clear of the body.
    name: 'verb-stand',
    draw(pix) {
      ground(pix, 5, 20);
      pix.poly([[12, 11], [18, 11], [18, 19], [12, 19]], 'sky3');
      pix.rect(12, 11, 2, 8, 'sky4');
      pix.rect(17, 11, 1, 8, 'sky2');
      pix.rect(10, 12, 2, 6, 'sky3');
      pix.rect(18, 12, 2, 6, 'sky2');
      pix.rect(10, 18, 2, 2, 'cream3');
      pix.rect(18, 18, 2, 2, 'cream2');
      pix.rect(12, 19, 2, 6, 'sky2');
      pix.rect(16, 19, 2, 6, 'sky2');
      pix.rect(12, 19, 1, 6, 'sky3');
      head(pix, 15, 8);
      arrow(pix, 25, 6, 0, -1, 8);
      pix.outline();
    },
  },

  {
    // Looking: one eye, wide, lit from the upper left like everything else —
    // cream4 in the top-left quarter down to cream1 in the bottom-right, with
    // a lid shadow under the upper lid. Three pale lashes so the silhouette is
    // an eye and not a diamond.
    name: 'verb-look',
    draw(pix) {
      pix.line(10, 12, 7, 8, 'cream2');
      pix.line(16, 9, 16, 4, 'cream2');
      pix.line(22, 12, 25, 8, 'cream2');

      pix.poly([[5, 16], [16, 8], [27, 16], [16, 24]], 'cream2');
      pix.poly([[5, 16], [16, 8], [16, 16]], 'cream4');
      pix.poly([[16, 8], [27, 16], [16, 16]], 'cream3');
      pix.poly([[16, 16], [27, 16], [16, 24]], 'cream1');
      // The upper lid casts down onto the white.
      pix.line(7, 16, 16, 10, 'cream1');
      pix.line(16, 10, 25, 16, 'cream1');

      pix.disc(16, 16, 4.4, 4.4, 'sky2');
      pix.disc(15.6, 15.6, 3.4, 3.4, 'sky3');
      pix.disc(16, 16, 1.8, 1.8, 'ink2');
      pix.set(14, 14, 'cream4');
      pix.set(15, 14, 'cream4');
      pix.outline();
    },
  },

  {
    // The camera: steel body, one big lens, a sparkle where the flash sits.
    name: 'verb-photo',
    draw(pix) {
      pix.rect(9, 8, 6, 3, 'steel3');
      pix.rect(5, 11, 22, 13, 'steel2');
      pix.rect(5, 11, 22, 1, 'steel3');
      pix.rect(5, 23, 22, 1, 'steel1');
      pix.rect(26, 11, 1, 13, 'steel1');
      pix.disc(17, 17, 6, 6, 'steel1');
      pix.disc(17, 17, 5, 5, 'steel3');
      pix.disc(17, 17, 3.6, 3.6, 'steel1');
      pix.disc(17, 17, 2.6, 2.6, 'sky2');
      pix.disc(16.4, 16.4, 1.4, 1.4, 'sky3');
      pix.set(15, 15, 'cream4');
      pix.rect(7, 13, 3, 2, 'steel3');
      pix.set(7, 13, 'cream4');
      pix.line(21, 4, 21, 7, 'cream4');
      pix.line(19, 6, 23, 6, 'cream4');
      pix.outline();
    },
  },

  {
    // A s'more set down and the hand lifting off it. The fingers come all the
    // way to the top graham so hand and food are one action, the stack is bit
    // and offset so it is a s'more and not a layer cake, and the hand sits a
    // value below the marshmallow so it is never read as another layer.
    name: 'verb-leave-out',
    draw(pix) {
      ground(pix, 9, 16);

      pix.rect(11, 22, 12, 3, 'cream2');
      pix.rect(11, 22, 12, 1, 'cream3');
      pix.rect(11, 20, 12, 2, 'choc2');
      pix.rect(11, 20, 12, 1, 'choc3');
      // Marshmallow, squeezed out past the biscuit on both sides.
      pix.rect(12, 17, 10, 3, 'cream4');
      pix.rect(12, 19, 10, 1, 'cream2');
      pix.set(11, 18, 'cream3');
      pix.set(22, 18, 'cream3');
      // Top graham, offset a pixel and bitten at the far corner.
      pix.rect(12, 14, 12, 3, 'cream2');
      pix.rect(12, 14, 12, 1, 'cream3');
      pix.set(15, 15, 'cream1');
      pix.set(18, 15, 'cream1');
      pix.set(20, 16, 'cream1');
      for (const [x, y] of [[21, 14], [22, 14], [23, 14], [22, 15], [23, 15], [23, 16]]) {
        pix.set(x, y, 'none');
      }

      cuff(pix, 24, 7);
      handDown(pix, 18, 9);
      arrow(pix, 6, 8, 0, -1, 8);
      pix.outline();
    },
  },
];
