/**
 * bite — the s'more being eaten, and the eight places you can eat it from.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`. A 24x24 box centred in a 32x32 cell, light from the
 * upper left, four values per material, `outline()` last, and never a letter
 * or a digit.
 *
 * This family exists to kill a row of numbered circles. The HUD used to draw
 * the eight bite directions as eight discs with the numerals one to eight in
 * them, which is a progress counter in a costume and looks like a debug
 * control. So there is no count anywhere in this file and no bar anywhere in
 * this file. There is a sandwich, and how much of it is left, and where the
 * teeth go.
 *
 * Two vocabularies:
 *
 *   state-bite-*  the sandwich in three-quarter view, 24x24, at four stages of
 *                 being eaten. The read is the SILHOUETTE and nothing else:
 *                 a whole slab, a slab with a corner nicked out, a ragged half,
 *                 a scatter with one corner surviving. Squinted at in a row it
 *                 should look like somebody eating.
 *   bite-*        the same sandwich from directly above, 16x16 rather than
 *                 24x24 because eight of them sit in a thumb-wide row on a
 *                 phone. They are deliberately flat and low-contrast so that
 *                 the one loud thing in each is the notch, and the notch is in
 *                 the compass direction the name gives. A corner bite loses a
 *                 corner of the square; an edge bite keeps both corners. That
 *                 difference is what separates `bite-ne` from `bite-n` at a
 *                 glance, which is why the cracker is a square and not a disc.
 *
 * Every bite in the file — big or small — is cut by `biteFrom`: three round
 * lobes side by side, the middle one deepest, leaving cusps between them. That
 * is the whole trick for tooth curvature. A straight cut reads as a slice, and
 * a slice is somebody else's food.
 */

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `dither()` that respects a silhouette — it only recolours pixels that are
 * already drawn, so texture never leaks past an edge where `outline()` cannot
 * rescue it.
 */
function ditherIn(pix, x, y, w, h, key, phase = 0, over = null) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if ((x + dx + y + dy + phase) % 2 !== 0) continue;
      const current = pix.get(x + dx, y + dy);
      if (current === 'none') continue;
      if (over && !over.includes(current)) continue;
      pix.set(x + dx, y + dy, key);
    }
  }
}

/** Every pixel inside an ellipse, on the same test the canvas `disc` uses. */
function eachEllipse(cx, cy, rx, ry, fn) {
  for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
    for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
      const nx = (x - cx) / Math.max(0.0001, rx);
      const ny = (y - cy) / Math.max(0.0001, ry);
      if (nx * nx + ny * ny <= 1.02) fn(x, y);
    }
  }
}

/** A disc that only recolours pixels already drawn. */
function discOver(pix, cx, cy, r, key, over = null) {
  eachEllipse(cx, cy, r, r, (x, y) => {
    const current = pix.get(x, y);
    if (current === 'none') return;
    if (over && !over.includes(current)) return;
    pix.set(x, y, key);
  });
}

/** A disc that removes what is under it. */
function discCut(pix, cx, cy, r) {
  eachEllipse(cx, cy, r, r, (x, y) => pix.set(x, y, 'none'));
}

/**
 * Rounded rectangle by inclusive corners, filled without erasing anything.
 *
 * `pix.rect` plus a corner clip would punch holes through whatever is
 * underneath, which matters here because the top cracker sits on the
 * marshmallow and the marshmallow has to keep showing round it.
 */
function slab(pix, x0, y0, x1, y1, key, r = 2) {
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = Math.min(x - x0, x1 - x);
      const dy = Math.min(y - y0, y1 - y);
      if (dx + dy < r) continue;
      pix.set(x, y, key);
    }
  }
}

/**
 * Takes lobes out of whatever is drawn and leaves a crumb rim behind.
 *
 * Every rim is painted before any lobe is cut, so the dark edge ends up one
 * pixel thick along the outside of the union and nowhere inside it.
 */
function chew(pix, lobes, rim = 'wood1') {
  for (const [cx, cy, r] of lobes) discOver(pix, cx, cy, r + 1, rim);
  for (const [cx, cy, r] of lobes) discCut(pix, cx, cy, r);
}

/**
 * A bite aimed inward from a direction.
 *
 * `dist` is how far the mouth closed on the thing — measured from its centre,
 * so smaller is deeper. The two outer lobes sit shallower than the middle one,
 * which is what leaves cusps rather than one smooth scoop.
 */
function biteFrom(pix, cx, cy, ux, uy, dist, r, rim = 'wood1') {
  const px = -uy;
  const py = ux;
  const back = dist + r * 0.55;
  const spread = r * 0.85;
  const side = r * 0.62;
  chew(
    pix,
    [
      [cx + ux * back + px * spread, cy + uy * back + py * spread, side],
      [cx + ux * dist, cy + uy * dist, r],
      [cx + ux * back - px * spread, cy + uy * back - py * spread, side],
    ],
    rim,
  );
}

/* -------------------------------------------------------------------------- */
/* The sandwich, three-quarter on                                             */
/* -------------------------------------------------------------------------- */

/**
 * A whole s'more: two grahams, chocolate, and marshmallow squeezing out.
 *
 * Seen from slightly above, so there is a lit top face and a side face in
 * shadow, the same three-quarter box the rest of the icons use. The four
 * `state-bite-*` all start from this and then get eaten, which is what keeps
 * the layers lining up across the four — the chocolate is at the same height
 * in the crumbs as it is in the whole one.
 */
function sandwich(pix) {
  // Side face, in shadow, with the filling banded across it.
  pix.poly([[22, 12], [26, 8], [26, 21], [22, 25]], 'wood1');
  pix.poly([[22, 16], [26, 12], [26, 15], [22, 19]], 'choc1');
  pix.poly([[22, 18], [26, 14], [26, 17], [22, 21]], 'cream1');
  pix.line(22, 25, 26, 21, 'wood1');

  // Marshmallow squeezing out either side, under the crackers.
  pix.disc(6.5, 19.5, 2.2, 2.6, 'cream3');
  pix.disc(23, 19.5, 2, 2.4, 'cream3');

  // Front: cracker, chocolate, marshmallow, cracker.
  pix.rect(6, 12, 17, 4, 'wood3');
  pix.rect(6, 16, 17, 2, 'choc2');
  pix.rect(6, 18, 17, 4, 'cream3');
  pix.rect(6, 22, 17, 4, 'wood3');

  // Cracker shading: lit along each top edge, dark along each bottom edge.
  pix.line(6, 15, 22, 15, 'wood2');
  pix.line(6, 22, 22, 22, 'wood4');
  pix.line(6, 25, 22, 25, 'wood2');
  ditherIn(pix, 16, 13, 7, 13, 'wood2', 1, ['wood3']);

  // Chocolate. The darkest band in the icon on purpose: it is the one stripe
  // that separates a s'more from two crackers and a pillow at this size.
  pix.line(6, 17, 22, 17, 'choc1');
  pix.line(6, 16, 9, 16, 'choc3');
  ditherIn(pix, 15, 16, 8, 1, 'choc1', 0, ['choc2']);

  // Marshmallow: bright on top, soft underneath, one bead of it running out.
  pix.line(6, 18, 22, 18, 'cream4');
  pix.line(6, 21, 22, 21, 'cream2');
  ditherIn(pix, 15, 19, 9, 3, 'cream2', 0, ['cream3']);
  pix.rect(10, 21, 2, 2, 'cream3');
  pix.set(11, 22, 'cream2');
  pix.set(8, 18, 'cream4');

  // Lit top face, with the docking holes.
  pix.poly([[6, 12], [10, 8], [26, 8], [22, 12]], 'wood4');
  pix.line(6, 12, 22, 12, 'wood4');
  ditherIn(pix, 17, 8, 10, 5, 'wood3', 0, ['wood4']);
  for (const x of [12, 16, 20, 24]) pix.set(x, 9, 'wood2');
  for (const x of [10, 14, 18, 22]) pix.set(x, 11, 'wood2');
}

/** A loose fragment: one to three pixels, with its own dark underside. */
function crumb(pix, x, y, w, key, dark) {
  pix.rect(x, y, w, 1, key);
  pix.set(x + w - 1, y + 1, dark);
}

/* -------------------------------------------------------------------------- */
/* The eight targets, from directly above                                     */
/* -------------------------------------------------------------------------- */

/**
 * The same sandwich from above: a square cracker on a marshmallow squeeze,
 * 16x16 of art, with one bite out of `ux, uy`.
 *
 * Flat on purpose. Eight of these sit in a row under a thumb, and the only
 * thing that has to survive being that small is where the notch is — so the
 * cracker gets one soft dither and nothing else competes.
 */
function target(pix, ux, uy) {
  // Marshmallow and the lower cracker, showing all round the top one.
  slab(pix, 8, 8, 23, 23, 'cream2', 2);
  pix.line(10, 8, 21, 8, 'cream3');
  pix.line(8, 10, 8, 21, 'cream3');
  pix.set(9, 9, 'cream3');
  pix.line(10, 23, 21, 23, 'cream1');
  pix.line(23, 10, 23, 21, 'cream1');
  pix.set(22, 22, 'cream1');

  // Top cracker.
  slab(pix, 9, 9, 21, 21, 'wood3', 2);
  pix.line(11, 9, 19, 9, 'wood4');
  pix.line(9, 11, 9, 19, 'wood4');
  pix.set(10, 10, 'wood4');
  pix.line(11, 21, 19, 21, 'wood2');
  pix.line(21, 11, 21, 19, 'wood2');
  pix.set(20, 20, 'wood2');
  ditherIn(pix, 14, 14, 8, 8, 'wood2', 1, ['wood3']);

  // The bite. Corners sit further from the middle than edges do, so a diagonal
  // has to close further to take the same depth out.
  const diagonal = Math.abs(ux) > 0.2 && Math.abs(uy) > 0.2;
  const dist = diagonal ? 8.8 : 7.2;
  biteFrom(pix, 15.5, 15.5, ux, uy, dist, 3.2);

  // A smear of chocolate on the deepest part of the crumb rim, so the hole
  // reads as a bite through a sandwich rather than a chip off a tile.
  const reach = dist - 3.9;
  discOver(pix, 15.5 + ux * reach, 15.5 + uy * reach, 1.4, 'choc2', ['wood1']);
}

const COMPASS = [
  ['bite-n', 0, -1],
  ['bite-ne', 1, -1],
  ['bite-e', 1, 0],
  ['bite-se', 1, 1],
  ['bite-s', 0, 1],
  ['bite-sw', -1, 1],
  ['bite-w', -1, 0],
  ['bite-nw', -1, -1],
];

const targets = COMPASS.map(([name, dx, dy]) => {
  const length = Math.hypot(dx, dy);
  const ux = dx / length;
  const uy = dy / length;
  return {
    name,
    draw(pix) {
      target(pix, ux, uy);
      pix.outline();
    },
  };
});

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Nobody has touched it. Four clean corners, four straight layers.
    name: 'state-bite-whole',
    draw(pix) {
      sandwich(pix);
      pix.outline();
    },
  },

  {
    // One corner gone. The silhouette is still the whole slab apart from a
    // scallop out of the top right, which is the point — this has to read as
    // "barely started" next to the half.
    name: 'state-bite-nibbled',
    draw(pix) {
      sandwich(pix);
      biteFrom(pix, 15, 17, 0.79, -0.61, 10.6, 3.6);
      crumb(pix, 25, 16, 2, 'wood3', 'wood2');
      pix.set(21, 6, 'wood3');
      pix.outline();
    },
  },

  {
    // Most of one side gone. Three big lobes scoop the right away, and two
    // small ones notch the edge they leave, so the tear is uneven — a smooth
    // curve here would read as a smaller whole sandwich rather than half a one.
    name: 'state-bite-half',
    draw(pix) {
      sandwich(pix);
      chew(pix, [
        [24, 4, 7],
        [22, 16, 8],
        [24, 28, 7],
        [17, 10, 3],
        [18, 22, 3],
      ]);

      // Crumbs off the torn edge, and the marshmallow pulling into a string.
      pix.set(15, 19, 'cream4');
      pix.set(16, 20, 'cream3');
      pix.set(18, 20, 'cream2');
      crumb(pix, 19, 13, 2, 'wood3', 'wood2');
      crumb(pix, 22, 22, 2, 'wood2', 'wood1');
      pix.set(24, 15, 'wood3');
      pix.set(17, 26, 'choc2');
      pix.outline();
    },
  },

  {
    // One corner survived. Everything else is on the ground.
    //
    // The survivor is still a stack — cracker, chocolate, marshmallow, cracker,
    // at the same heights as in the whole one — because a shapeless lump plus
    // dots would read as spilled gravel rather than as the end of a s'more.
    name: 'state-bite-crumbs',
    draw(pix) {
      sandwich(pix);
      chew(pix, [
        [3, 8.5, 7],
        [10, 8.5, 7],
        [17, 8.5, 7],
        [24, 8.5, 7],
        [20, 15, 7],
        [21, 23, 7],
        [19, 29, 7],
      ]);

      // The scatter. Uneven sizes and no two spaced alike, so it stays a mess
      // and never lines up into something that could be counted.
      crumb(pix, 17, 9, 2, 'wood3', 'wood2');
      crumb(pix, 22, 12, 3, 'wood4', 'wood2');
      crumb(pix, 26, 17, 1, 'wood3', 'wood2');
      crumb(pix, 19, 16, 1, 'choc2', 'choc1');
      crumb(pix, 24, 22, 2, 'wood2', 'wood1');
      crumb(pix, 16, 23, 1, 'cream3', 'cream1');
      crumb(pix, 20, 25, 2, 'wood3', 'wood2');
      crumb(pix, 13, 7, 1, 'wood3', 'wood2');
      pix.set(26, 13, 'wood2');
      pix.set(14, 26, 'choc2');
      pix.outline();
    },
  },

  ...targets,
];
