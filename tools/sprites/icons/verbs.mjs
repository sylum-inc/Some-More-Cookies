/**
 * verbs — the twelve things a player does to the fire and to the world.
 *
 * These live on buttons, so they are read in a quarter second, side by side,
 * over and over. That makes consistency worth more here than invention: the
 * set shares one hand, one stick, one bed of coals and one kind of motion
 * mark, so a verb is understood by what CHANGES between icons rather than by
 * being studied on its own.
 *
 * The vocabulary:
 *
 *   hand    cream ramp, blue (sky) cuff, always entering from the upper right.
 *           The player's hand is a fixed thing in the frame; what it holds is
 *           what varies.
 *   stick   three pixels thick, lit along its upper-left edge. Poke, rake and
 *           bank are the same stick doing three different jobs — redrawn per
 *           icon they would read as three unrelated tools.
 *   coals   the ember bed, low in the cell, in the same place every time. The
 *           fire is the floor of this set.
 *   motion  a thin cream4 arrow: one-pixel shaft, two-pixel head, never the
 *           colour of any material. Bright, and clearly not part of an object.
 *
 * `accent` appears exactly once in the family, on the object in verb-take,
 * because that is the palette's rule: the accent is what the world wants you
 * to look at, and the thing you are about to pick up is the only such thing
 * in these twelve.
 */

/* -------------------------------------------------------------------------- */
/* Shared vocabulary                                                          */
/* -------------------------------------------------------------------------- */

/** The bed of coals: dark at the rim, hot through the middle. */
function coals(pix, cx = 16, cy = 25, rx = 9, ry = 2.6) {
  pix.disc(cx, cy, rx, ry, 'ember1');
  pix.disc(cx, cy, rx - 1.4, ry - 0.7, 'ember2');
  pix.dither(cx - rx + 2, cy - ry + 1, rx * 2 - 4, Math.max(2, Math.round(ry)), 'ember3');
  pix.disc(cx - 1, cy - 0.3, rx * 0.45, ry * 0.4, 'ember3');
  pix.set(cx - 4, cy - 1, 'ember4');
  pix.set(cx - 3, cy - 1, 'ember4');
  pix.set(cx + 2, cy, 'ember4');
  pix.set(cx + 4, cy - 1, 'ember3');
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

/** The sleeve. Drawn before the hand, so the hand sits in front of it. */
function cuff(pix, cx, cy) {
  pix.disc(cx, cy, 3.4, 3.4, 'sky1');
  pix.disc(cx - 0.3, cy - 0.3, 2.8, 2.8, 'sky3');
  pix.disc(cx - 1.2, cy - 1.2, 1.4, 1.4, 'sky4');
}

/**
 * A closed hand, gripping whatever was drawn before it.
 *
 * Blocky and grooved on purpose. Drawn as a soft cream disc it came out as a
 * blob on the end of a stick — which, in a game about a campfire, reads as a
 * marshmallow. The corners, the two ink knuckle grooves and the thumb are what
 * make it a hand instead.
 */
const FIST = [
  '..4433..',
  '.4433331',
  '44333331',
  '4433--31',
  '33333331',
  '233.--31',
  '.2222211',
  '..1111..',
];
const FIST_KEYS = { 1: 'cream1', 2: 'cream2', 3: 'cream3', 4: 'cream4', '-': 'ink' };

function fist(pix, cx, cy) {
  const x0 = Math.round(cx) - 4;
  const y0 = Math.round(cy) - 4;
  FIST.forEach((row, dy) => {
    for (let dx = 0; dx < row.length; dx++) {
      const key = FIST_KEYS[row[dx]];
      if (key) pix.set(x0 + dx, y0 + dy, key);
    }
  });
}

/**
 * An open hand, fingers up. The one-pixel gaps between fingers are left empty
 * on purpose: `outline()` fills them with ink, which is darker and cheaper
 * than drawing the separations by hand.
 */
function openHand(pix, cx, cy) {
  const left = cx - 7;
  [4, 6, 6, 4].forEach((h, i) => {
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
 * The motion mark: one-pixel shaft, solid triangular head, tip at (x,y).
 *
 * The head is filled rather than drawn as a chevron. A chevron of two diagonal
 * strokes fans out at short lengths and reads as a splash; a solid triangle
 * reads as an arrow at four pixels or forty.
 */
function arrow(pix, x, y, dx, dy, len = 6, key = 'cream4') {
  pix.line(x - dx, y - dy, x - dx * len, y - dy * len, key);
  const px = -dy;
  const py = dx;
  for (let i = 0; i <= 2; i++) {
    const bx = x - dx * i;
    const by = y - dy * i;
    pix.line(bx - px * i, by - py * i, bx + px * i, by + py * i, key);
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

/* -------------------------------------------------------------------------- */
/* The verbs                                                                  */
/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Stick driven steeply down into the coals, sparks coming back up it.
    name: 'verb-poke',
    draw(pix) {
      coals(pix, 15, 25, 8, 2.6);
      stick(pix, 26, 7, 13, 20);
      cuff(pix, 28, 5);
      fist(pix, 24, 9);
      pix.set(13, 20, 'ember4');
      pix.set(12, 20, 'ember3');
      pix.set(13, 21, 'ember4');
      spark(pix, 9, 16, 'ember4');
      spark(pix, 6, 12, 'ember3');
      spark(pix, 11, 11, 'ember4');
      pix.outline();
    },
  },

  {
    // The same stick laid flat and dragged left: a heap of coals shoved ahead
    // of the tip, and one long sweep arrow over the top.
    name: 'verb-rake',
    draw(pix) {
      coals(pix, 17, 25, 8, 2.4);
      pix.disc(9, 23.6, 4.6, 2.8, 'ember1');
      pix.disc(9, 24, 3.2, 1.8, 'ember2');
      pix.set(8, 22, 'ember3');
      pix.set(9, 22, 'ember4');
      pix.set(7, 23, 'ember3');
      stick(pix, 28, 15, 9, 21);
      cuff(pix, 28, 12);
      fist(pix, 24, 16);
      arrow(pix, 6, 11, -1, 0, 9);
      pix.outline();
    },
  },

  {
    // Ash pulled over the fire for the night: a grey mound smothering the bed,
    // embers still showing at its right foot, the stick still pushing.
    name: 'verb-bank',
    draw(pix) {
      coals(pix, 16, 25, 9, 2.4);
      pix.poly([[4, 27], [7, 21], [12, 19], [17, 21], [20, 27]], 'stone1');
      pix.poly([[6, 27], [8, 22], [12, 20], [16, 22], [18, 27]], 'stone2');
      pix.poly([[8, 24], [12, 20], [16, 23], [15, 25], [9, 25]], 'stone3');
      pix.dither(6, 21, 12, 6, 'stone3');
      pix.set(10, 20, 'stone4');
      pix.set(11, 20, 'stone4');
      pix.set(9, 21, 'stone4');
      pix.set(13, 21, 'stone4');
      pix.set(21, 25, 'ember4');
      pix.set(22, 25, 'ember4');
      pix.set(23, 24, 'ember3');
      pix.set(4, 26, 'ember3');
      pix.set(5, 26, 'ember4');
      stick(pix, 29, 12, 18, 22);
      fist(pix, 26, 13);
      arrow(pix, 7, 11, -1, 0, 8);
      pix.outline();
    },
  },

  {
    // A log lowered onto the fire: hand at the far end, sawn end to the light,
    // the drop marked in the gap above the coals.
    name: 'verb-add-log',
    draw(pix) {
      coals(pix, 15, 26, 8, 1.6);
      logBody(pix, 22, 10, 9, 12, 2.8);
      cuff(pix, 28, 5);
      fist(pix, 24, 9);
      arrow(pix, 15, 23, 0, 1, 6);
      pix.outline();
    },
  },

  {
    // A match at the instant it takes: thin shaft, fat head, sparks thrown
    // along the line of the strike.
    name: 'verb-strike',
    draw(pix) {
      cuff(pix, 27, 25);
      pix.line(22, 21, 13, 13, 'wood2');
      pix.line(21, 21, 12, 13, 'wood3');
      pix.line(21, 20, 12, 12, 'wood4');
      fist(pix, 23, 22);
      pix.disc(10, 11, 3.4, 3.4, 'ember1');
      pix.disc(10, 11, 2.6, 2.6, 'ember2');
      pix.disc(9.6, 10.6, 1.6, 1.6, 'ember3');
      pix.set(9, 10, 'ember4');
      pix.set(10, 10, 'ember4');
      pix.set(9, 9, 'ember4');
      pix.line(10, 4, 10, 6, 'cream4');
      pix.line(4, 8, 6, 6, 'cream4');
      pix.line(3, 14, 5, 14, 'cream4');
      pix.line(15, 6, 17, 4, 'cream4');
      spark(pix, 15, 15, 'ember4');
      pix.outline();
    },
  },

  {
    // Breath on embers: three hooked strokes converging from the upper left,
    // one flame answering.
    name: 'verb-blow',
    draw(pix) {
      coals(pix, 20, 25, 7, 2.6);
      pix.poly([[17, 23], [20, 14], [23, 23]], 'ember2');
      pix.poly([[18, 23], [20, 16], [22, 23]], 'ember3');
      pix.poly([[19, 22], [20, 18], [21, 22]], 'ember4');
      spark(pix, 23, 12, 'ember3');
      pix.line(8, 9, 17, 12, 'cream4');
      pix.line(9, 10, 15, 12, 'cream3');
      pix.set(7, 8, 'cream3');
      pix.set(6, 9, 'cream3');
      pix.set(6, 10, 'cream3');
      pix.line(5, 14, 14, 16, 'cream4');
      pix.line(6, 15, 12, 16, 'cream3');
      pix.set(4, 13, 'cream3');
      pix.set(3, 14, 'cream3');
      pix.set(3, 15, 'cream3');
      pix.line(7, 19, 14, 20, 'cream4');
      pix.set(6, 18, 'cream3');
      pix.set(5, 19, 'cream3');
      pix.outline();
    },
  },

  {
    // Picking something up: open palm below, the thing above it, motion coming
    // down into the hand. The one accent in the family is that thing.
    name: 'verb-take',
    draw(pix) {
      openHand(pix, 15, 20);
      cuff(pix, 25, 24);
      pix.disc(16, 9, 3.4, 3, 'ember2');
      pix.disc(16, 8.6, 2.6, 2.2, 'accent');
      pix.set(15, 7, 'cream4');
      pix.set(14, 8, 'cream4');
      arrow(pix, 7, 12, 0, 1, 6);
      arrow(pix, 24, 12, 0, 1, 6);
      pix.outline();
    },
  },

  {
    // Sitting: the same body as verb-stand, folded onto a log.
    name: 'verb-sit',
    draw(pix) {
      logBody(pix, 23, 24, 10, 24, 3);
      pix.poly([[12, 11], [18, 11], [19, 21], [12, 21]], 'sky3');
      pix.poly([[12, 11], [14, 11], [13, 21], [12, 21]], 'sky4');
      pix.rect(18, 12, 1, 9, 'sky2');
      pix.rect(6, 19, 8, 3, 'sky2');
      pix.rect(6, 19, 8, 1, 'sky3');
      pix.rect(6, 21, 3, 5, 'sky2');
      pix.rect(6, 21, 1, 5, 'sky3');
      head(pix, 14, 8);
      pix.rect(11, 14, 2, 5, 'sky4');
      pix.rect(9, 18, 2, 2, 'cream3');
      pix.outline();
    },
  },

  {
    // Standing: upright, feet on the ground, one mark rising beside the body.
    name: 'verb-stand',
    draw(pix) {
      pix.rect(5, 25, 20, 2, 'stone2');
      pix.dither(5, 25, 20, 1, 'stone3');
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
      arrow(pix, 25, 7, 0, -1, 7);
      pix.outline();
    },
  },

  {
    // Looking: one eye, wide, heavy-lidded, three lashes so the silhouette is
    // an eye and not a diamond.
    name: 'verb-look',
    draw(pix) {
      pix.line(10, 12, 8, 9, 'ink3');
      pix.line(16, 9, 16, 5, 'ink3');
      pix.line(22, 12, 24, 9, 'ink3');
      pix.poly([[5, 16], [16, 8], [27, 16], [16, 24]], 'cream2');
      pix.poly([[7, 16], [16, 10], [25, 16], [16, 22]], 'cream4');
      pix.disc(16, 16, 4.4, 4.4, 'sky2');
      pix.disc(16, 16, 3.4, 3.4, 'sky3');
      pix.disc(16, 16, 1.8, 1.8, 'ink2');
      pix.set(14, 14, 'cream4');
      pix.set(15, 14, 'cream4');
      pix.line(7, 15, 16, 9, 'ink3');
      pix.line(16, 9, 25, 15, 'ink3');
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
      pix.rect(7, 13, 3, 2, 'steel4');
      pix.line(21, 4, 21, 7, 'cream4');
      pix.line(19, 6, 23, 6, 'cream4');
      pix.outline();
    },
  },

  {
    // A s'more set down on the ground and the hand lifting off it — the
    // offering verb, so the food keeps the ground and the hand is on its way
    // out of the frame.
    name: 'verb-leave-out',
    draw(pix) {
      pix.rect(3, 25, 14, 2, 'stone2');
      pix.dither(3, 25, 14, 1, 'stone3');
      pix.rect(4, 22, 11, 3, 'cream2');
      pix.rect(4, 22, 11, 1, 'cream3');
      pix.rect(4, 20, 11, 2, 'choc2');
      pix.rect(4, 20, 11, 1, 'choc3');
      pix.rect(5, 17, 9, 3, 'cream4');
      pix.rect(5, 19, 9, 1, 'cream2');
      pix.set(4, 18, 'cream3');
      pix.set(14, 18, 'cream3');
      pix.rect(4, 14, 11, 3, 'cream2');
      pix.rect(4, 14, 11, 1, 'cream3');
      pix.set(7, 15, 'cream1');
      pix.set(10, 15, 'cream1');
      pix.set(12, 15, 'cream1');
      cuff(pix, 27, 6);
      fist(pix, 22, 10);
      arrow(pix, 24, 16, 0, -1, 4);
      pix.outline();
    },
  },
];
