/**
 * Objects — the things you carry, and the things you walk up to.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`. The short version of what this file agrees to:
 * a 24x24 box centred in a 32x32 cell, light from the upper left, one ramp per
 * material, `outline()` last, and never a letter or a digit anywhere.
 *
 * Materials are load-bearing here, because half of these icons are the same
 * chunky slab in silhouette and the ramp is what tells them apart:
 *
 *   wood   logs, sticks, graham crackers, the roasting rod's handle
 *   steel  the SM-01, the radio, the camera, the torch, the binoculars
 *   cream  marshmallow, ice cream, the plate
 *   choc   exactly one thing
 *   stone  exactly one thing
 *   green  the seat's canvas, the only soft thing in the family
 */

/* -------------------------------------------------------------------------- */
/* Small shared helpers                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `dither()` that respects a silhouette.
 *
 * The canvas dither paints a rectangle whether or not anything is under it,
 * which is right for a background and wrong for shading a shape — texture that
 * leaks past an edge is the one thing `outline()` cannot rescue. This only
 * touches pixels that are already drawn, optionally only certain keys.
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

/** A lit block: body, highlight on the top and left, shadow on the bottom and right. */
function block(pix, x, y, w, h, dark, body, light) {
  pix.rect(x, y, w, h, body);
  pix.line(x, y, x + w - 1, y, light);
  pix.line(x, y, x, y + h - 1, light);
  pix.line(x, y + h - 1, x + w - 1, y + h - 1, dark);
  pix.line(x + w - 1, y, x + w - 1, y + h - 1, dark);
}

/** Two parallel diagonal runs, i.e. a stick with a lit side and a shaded side. */
function stick(pix, x0, y0, x1, y1, lit, shade) {
  pix.line(x0, y0, x1, y1, shade);
  pix.line(x0 - 1, y0, x1 - 1, y1, lit);
}

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // A fat pillow on a skewer. The toast is a wood dither on the underside —
    // a fifth cream would have been the easy way and the wrong one.
    name: 'obj-marshmallow',
    draw(pix) {
      // Skewer, running out to the lower left, drawn first so the sweet covers it.
      pix.line(5, 27, 18, 14, 'wood2');
      pix.line(5, 26, 18, 13, 'wood3');

      // Capsule: a barrel with a rounded cap top and bottom.
      pix.rect(11, 12, 12, 8, 'cream3');
      pix.disc(16.5, 12, 6, 3.2, 'cream3');
      pix.disc(16.5, 19, 6, 3.2, 'cream3');

      // Light from the upper left.
      pix.disc(14, 12, 3.4, 2.4, 'cream4');
      pix.set(13, 11, 'cream4');
      ditherIn(17, 14, 7, 9, 'cream2', 0, ['cream3']);
      pix.line(22, 13, 22, 19, 'cream2');

      // Toasted underside — a wood dither over the cream, never a fifth cream.
      const cream = ['cream4', 'cream3', 'cream2'];
      ditherIn(11, 16, 13, 3, 'cream2', 1, ['cream3']);
      ditherIn(11, 17, 13, 3, 'wood3', 1, cream);
      ditherIn(11, 19, 13, 2, 'wood3', 0, cream);
      for (let y = 21; y <= 23; y++) {
        for (let x = 11; x <= 23; x++) if (cream.includes(pix.get(x, y))) pix.set(x, y, 'wood3');
      }
      ditherIn(11, 20, 13, 4, 'wood2', 0, ['wood3']);
      ditherIn(12, 22, 11, 2, 'wood1', 1, ['wood2', 'wood3']);

      pix.outline();
    },
  },

  {
    // Ice cream between two grahams. The bright band in the middle is the
    // whole read — crackers alone would just be a slab.
    name: 'obj-sandwich',
    draw(pix) {
      // Right side face, in shadow, then the front, then the lit top.
      pix.poly([[22, 12], [25, 9], [25, 21], [22, 24]], 'wood1');
      pix.poly([[22, 16], [25, 13], [25, 17], [22, 20]], 'cream1');

      // Front: cracker, ice cream, cracker.
      pix.rect(6, 12, 17, 4, 'wood3');
      pix.rect(6, 16, 17, 5, 'cream3');
      pix.rect(6, 21, 17, 4, 'wood3');

      // Cracker shading.
      pix.line(6, 12, 22, 12, 'wood4');
      pix.line(6, 15, 22, 15, 'wood2');
      pix.line(6, 21, 22, 21, 'wood4');
      pix.line(6, 24, 22, 24, 'wood2');
      ditherIn(17, 13, 6, 12, 'wood2', 1, ['wood3']);

      // Ice cream: bright at the top, a soft edge at the bottom, one drip.
      pix.line(6, 16, 22, 16, 'cream4');
      pix.line(6, 20, 22, 20, 'cream2');
      ditherIn(16, 17, 7, 4, 'cream2', 0, ['cream3']);
      pix.rect(11, 20, 2, 2, 'cream3');
      pix.set(11, 21, 'cream2');

      // Lit top face of the upper cracker, with its perforations.
      pix.poly([[6, 12], [9, 9], [25, 9], [22, 12]], 'wood4');
      for (const x of [11, 15, 19, 23]) pix.set(x, 10, 'wood2');
      for (const x of [9, 13, 17, 21]) pix.set(x, 11, 'wood2');

      pix.outline();
    },
  },

  {
    // One cracker. Lighter than every other wood in the family, because the
    // only thing separating a biscuit from a plank here is value and holes.
    name: 'obj-graham',
    draw(pix) {
      pix.rect(7, 10, 18, 12, 'wood4');
      pix.rect(7, 22, 18, 2, 'wood3');

      // Baked unevenly: darker toward the lower right.
      ditherIn(15, 15, 10, 7, 'wood3', 0, ['wood4']);
      ditherIn(19, 18, 6, 4, 'wood2', 1, ['wood3']);
      pix.line(7, 21, 24, 21, 'wood3');
      pix.line(24, 11, 24, 21, 'wood3');
      pix.line(7, 24, 24, 24, 'wood2');

      // The score line down the middle, and the docking holes.
      pix.line(15, 11, 15, 20, 'wood3');
      pix.line(16, 11, 16, 20, 'wood2');
      for (const y of [13, 18]) {
        for (const x of [9, 11, 13, 18, 20, 22]) pix.set(x, y, 'wood2');
      }

      // Rounded corners, and a bite out of the right edge.
      for (const [x, y] of [[7, 10], [24, 10], [7, 23], [24, 23]]) pix.set(x, y, 'none');
      pix.disc(26, 15, 4.4, 4.4, 'none');
      pix.disc(23, 10, 2.2, 2.2, 'none');
      for (const [x, y] of [[22, 11], [21, 13], [21, 17], [22, 19]]) pix.set(x, y, 'wood3');

      pix.outline();
    },
  },

  {
    // Segmented bar. Nine cells, grooves in ink, one bevel each.
    name: 'obj-chocolate',
    draw(pix) {
      pix.poly([[23, 12], [26, 9], [26, 20], [23, 23]], 'choc1');
      pix.poly([[6, 12], [9, 9], [26, 9], [23, 12]], 'choc3');
      ditherIn(6, 9, 21, 3, 'choc2', 1, ['choc3']);

      for (const cy of [12, 16, 20]) {
        for (const cx of [6, 12, 18]) {
          pix.rect(cx, cy, 6, 4, 'choc2');
          pix.line(cx, cy, cx + 4, cy, 'choc3');
          pix.line(cx, cy, cx, cy + 2, 'choc3');
          pix.line(cx + 5, cy, cx + 5, cy + 3, 'ink2');
          pix.line(cx, cy + 3, cx + 5, cy + 3, 'ink2');
        }
      }

      // The bar's own outer edge is not a groove.
      pix.line(6, 23, 22, 23, 'choc1');
      pix.line(23, 12, 23, 23, 'choc1');

      pix.outline();
    },
  },

  {
    // A split round, cut face toward the light.
    name: 'obj-log',
    draw(pix) {
      pix.rect(9, 11, 15, 12, 'wood2');
      pix.disc(23, 17, 3.2, 6, 'wood2');

      // Bark: lit along the top, dark along the belly, ridged in between.
      pix.rect(9, 11, 15, 2, 'wood3');
      ditherIn(9, 13, 16, 2, 'wood3', 0, ['wood2']);
      pix.rect(9, 21, 16, 2, 'wood1');
      ditherIn(9, 19, 17, 2, 'wood1', 1, ['wood2']);
      for (const x of [15, 20]) pix.line(x, 13, x, 20, 'wood1');
      pix.line(22, 14, 22, 19, 'wood3');

      // Cut end: pale heartwood, dark rings, dark rim of bark around it.
      pix.disc(9, 17, 4.2, 6.4, 'cream2');
      pix.ring(9, 17, 4.2, 6.4, 'wood1');
      pix.ring(9, 17, 3, 4.6, 'wood1');
      pix.ring(9, 17, 1.6, 2.6, 'wood1');
      pix.set(9, 17, 'wood1');
      ditherIn(8, 18, 6, 6, 'wood3', 1, ['cream2']);
      pix.set(7, 13, 'cream3');
      pix.set(8, 13, 'cream3');

      pix.outline();
    },
  },

  {
    // A crossed pile of split sticks. Thinner than the log, and lying every
    // which way — a tidy upright bundle reads as a fence at this size.
    name: 'obj-kindling',
    draw(pix) {
      stick(pix, 6, 22, 26, 17, 'wood3', 'wood2');
      stick(pix, 6, 12, 25, 21, 'wood2', 'wood1');
      stick(pix, 8, 25, 23, 8, 'wood3', 'wood2');
      stick(pix, 8, 9, 22, 24, 'wood4', 'wood2');
      stick(pix, 5, 17, 24, 14, 'wood3', 'wood1');

      // Pale ends, because split wood is bright where it broke.
      for (const [x, y] of [[6, 22], [25, 21], [8, 25], [22, 24], [5, 17]]) {
        pix.set(x, y, 'wood4');
        pix.set(x - 1, y, 'wood3');
      }

      pix.outline();
    },
  },

  {
    // A wad of fine dry stuff. The ragged edge is the whole point: it is what
    // separates this from the stone, which is the same oval in silhouette.
    name: 'obj-tinder',
    draw(pix) {
      pix.disc(16, 18, 8, 5, 'wood2');
      // Uneven strand lengths: an even fringe reads as a sea urchin.
      const reach = [1, 0.62, 0.85, 0.55, 1, 0.7, 0.9, 0.6, 0.95, 0.65, 1, 0.58, 0.88, 0.72];
      for (let i = 0; i < reach.length; i++) {
        const a = (i / reach.length) * Math.PI * 2 + 0.35;
        const key = i % 3 === 0 ? 'cream2' : i % 3 === 1 ? 'wood3' : 'wood2';
        pix.line(
          16 + Math.cos(a) * 3.2,
          18 + Math.sin(a) * 2,
          16 + Math.cos(a) * (5.5 + 4.5 * reach[i]),
          18 + Math.sin(a) * (3.4 + 3 * reach[i]),
          key,
        );
      }
      // Hollow in the middle, lit from the upper left.
      pix.disc(16, 17.5, 3.6, 2.2, 'wood1');
      pix.disc(15, 17, 2.4, 1.2, 'wood2');
      ditherIn(9, 19, 15, 5, 'wood1', 0, ['wood2', 'wood3']);
      ditherIn(9, 13, 10, 4, 'cream2', 1, ['wood3']);

      pix.outline();
    },
  },

  {
    // A rock: flat facets, no curves. Curves would read as a potato.
    name: 'obj-stone',
    draw(pix) {
      const shape = [[7, 20], [9, 13], [14, 9], [21, 11], [25, 18], [22, 24], [12, 24]];
      pix.poly(shape, 'stone2');

      // Top-left facet catches the light; the underside does not.
      pix.poly([[9, 13], [14, 9], [21, 11], [18, 16], [11, 17]], 'stone3');
      pix.poly([[10, 13], [14, 10], [18, 11], [14, 15]], 'stone4');
      pix.poly([[12, 24], [22, 24], [25, 18], [19, 21]], 'stone1');
      ditherIn(15, 17, 11, 8, 'stone1', 0, ['stone2']);
      ditherIn(8, 16, 8, 6, 'stone3', 1, ['stone2']);

      // One crack, so the facets read as stone rather than as folded paper.
      pix.line(15, 16, 17, 21, 'stone1');
      pix.line(17, 21, 16, 24, 'stone1');

      pix.outline();
    },
  },

  {
    // Hand torch: cone, barrel, and light coming out of the front.
    name: 'obj-torch',
    draw(pix) {
      // Barrel and tail cap.
      block(pix, 14, 12, 12, 10, 'steel1', 'steel2', 'steel3');
      pix.line(14, 12, 25, 12, 'steel4');
      block(pix, 24, 11, 3, 12, 'steel1', 'steel2', 'steel3');
      for (const x of [17, 19, 21]) pix.line(x, 13, x, 20, 'steel1');
      pix.rect(19, 10, 3, 2, 'steel3');
      pix.set(19, 10, 'steel4');
      pix.set(20, 10, 'steel4');

      // Head: a cone opening to the left.
      pix.poly([[14, 11], [14, 22], [8, 24], [8, 9]], 'steel2');
      pix.poly([[14, 11], [14, 15], [8, 15], [8, 9]], 'steel3');
      pix.line(8, 9, 14, 11, 'steel4');
      ditherIn(9, 18, 6, 7, 'steel1', 0, ['steel2']);

      // Lens and the light off it.
      pix.rect(8, 11, 2, 11, 'cream3');
      pix.rect(8, 11, 2, 4, 'cream4');
      pix.set(9, 21, 'cream2');
      pix.line(7, 12, 4, 9, 'cream4');
      pix.line(7, 16, 4, 16, 'cream4');
      pix.line(7, 20, 4, 23, 'cream4');

      pix.outline();
    },
  },

  {
    // The roasting rod: wooden handle, steel shaft, two prongs.
    name: 'obj-rod',
    draw(pix) {
      // Handle: fat, and clearly wood.
      pix.line(4, 24, 11, 17, 'wood4');
      pix.line(4, 25, 11, 18, 'wood3');
      pix.line(5, 27, 12, 20, 'wood2');
      pix.line(5, 26, 12, 19, 'wood2');
      pix.line(6, 27, 12, 21, 'wood1');
      pix.set(4, 23, 'wood3');
      pix.set(5, 23, 'wood3');

      // Ferrule.
      pix.line(11, 17, 14, 20, 'steel4');
      pix.line(12, 17, 14, 19, 'steel3');
      pix.line(13, 17, 14, 18, 'steel2');

      // Shaft: thin and bright against the handle.
      pix.line(13, 17, 21, 9, 'steel4');
      pix.line(14, 18, 22, 10, 'steel3');

      // Two prongs off the tip.
      pix.line(20, 10, 27, 8, 'steel3');
      pix.line(20, 10, 27, 7, 'steel4');
      pix.line(20, 10, 22, 4, 'steel4');
      pix.line(21, 10, 23, 5, 'steel3');
      pix.set(20, 10, 'steel4');

      pix.outline();
    },
  },

  {
    // Portable radio: speaker, dial, two knobs, whip aerial.
    name: 'obj-radio',
    draw(pix) {
      // Aerial first, so the case covers its root.
      pix.line(22, 14, 26, 6, 'steel3');
      pix.line(22, 15, 26, 7, 'steel2');
      pix.disc(26, 5, 1.4, 1.4, 'steel4');

      block(pix, 6, 12, 20, 13, 'steel1', 'steel2', 'steel3');
      pix.line(6, 12, 25, 12, 'steel4');
      ditherIn(17, 20, 9, 5, 'steel1', 0, ['steel2']);

      // Speaker grille.
      pix.disc(13, 18, 5.4, 5.4, 'steel1');
      pix.disc(13, 18, 4.4, 4.4, 'steel3');
      for (let y = 13; y <= 23; y += 2) {
        for (let x = 7; x <= 19; x++) if (pix.get(x, y) === 'steel3') pix.set(x, y, 'steel1');
      }
      pix.ring(13, 18, 5.4, 5.4, 'steel4');
      ditherIn(8, 19, 11, 6, 'steel1', 1, ['steel4']);

      // Dial window with a needle, and two knobs.
      pix.rect(19, 14, 6, 3, 'ink2');
      pix.rect(19, 14, 6, 1, 'steel4');
      pix.line(22, 15, 22, 16, 'ember3');
      pix.disc(20, 21, 1.8, 1.8, 'steel3');
      pix.set(19, 20, 'steel4');
      pix.disc(24, 21, 1.8, 1.8, 'steel3');
      pix.set(23, 20, 'steel4');

      pix.outline();
    },
  },

  {
    // Two barrels and a bridge. Nothing else in the family has a hole in it.
    name: 'obj-binoculars',
    draw(pix) {
      // Eyecups.
      block(pix, 8, 8, 5, 4, 'steel1', 'steel2', 'steel3');
      block(pix, 19, 8, 5, 4, 'steel1', 'steel2', 'steel3');

      // Bridge, behind the barrels.
      block(pix, 12, 13, 8, 6, 'steel1', 'steel2', 'steel3');
      pix.rect(14, 11, 4, 5, 'steel3');
      for (const y of [12, 14]) pix.line(14, y, 17, y, 'steel1');

      // Barrels.
      block(pix, 6, 11, 8, 12, 'steel1', 'steel2', 'steel3');
      block(pix, 18, 11, 8, 12, 'steel1', 'steel2', 'steel3');
      ditherIn(10, 15, 4, 8, 'steel1', 0, ['steel2']);
      ditherIn(22, 15, 4, 8, 'steel1', 0, ['steel2']);

      // Objective glass.
      for (const cx of [9.5, 21.5]) {
        pix.disc(cx, 23, 3.8, 2.2, 'steel1');
        pix.disc(cx, 23, 2.8, 1.4, 'sky2');
        pix.set(cx - 1.5, 22, 'sky4');
        pix.set(cx - 0.5, 22, 'sky3');
      }

      pix.outline();
    },
  },

  {
    // Camera: body, prism hump, flash, and a lens big enough to be the icon.
    name: 'obj-camera',
    draw(pix) {
      // Prism and flash sit on top of the body.
      block(pix, 12, 7, 8, 5, 'steel1', 'steel2', 'steel3');
      block(pix, 6, 8, 4, 4, 'steel1', 'steel2', 'steel4');
      pix.rect(7, 9, 2, 2, 'cream4');
      block(pix, 22, 9, 3, 3, 'steel2', 'steel3', 'steel4');

      // Body.
      block(pix, 5, 11, 22, 14, 'steel1', 'steel2', 'steel3');
      pix.line(5, 11, 26, 11, 'steel4');
      ditherIn(20, 14, 7, 11, 'steel1', 0, ['steel2']);
      ditherIn(6, 20, 5, 5, 'steel1', 1, ['steel2']);

      // Lens.
      pix.disc(16, 18, 5.6, 5.6, 'steel1');
      pix.ring(16, 18, 5.6, 5.6, 'steel3');
      pix.disc(16, 18, 4.4, 4.4, 'steel3');
      pix.disc(16, 18, 3.4, 3.4, 'ink2');
      pix.disc(16, 18, 2.4, 2.4, 'sky2');
      ditherIn(12, 14, 5, 5, 'steel4', 0, ['steel3']);
      pix.set(15, 16, 'sky4');
      pix.set(14, 17, 'sky3');

      pix.outline();
    },
  },

  {
    // SM-01. Heavy as a chest freezer, round door, latch, lever.
    //
    // The hero object, so it gets the full three-quarter box: a lit top face, a
    // body face, and a side face in shadow, all sharing one steel ramp. The
    // door is the only warm thing in the icon and it is what your eye lands on.
    name: 'obj-machine',
    draw(pix) {
      // Lever, first: a pump arm off the back right corner with a ball knob.
      // It rises clear of the box, which is what keeps the silhouette from
      // being a plain rectangle.
      pix.line(20, 13, 25, 8, 'steel2');
      pix.line(20, 12, 25, 7, 'steel3');
      pix.line(20, 11, 24, 7, 'steel4');
      pix.disc(25, 6, 2.2, 2.2, 'steel3');
      pix.disc(24.6, 5.6, 1.1, 1.1, 'steel4');
      pix.set(26, 7, 'steel1');

      // Feet, under everything.
      pix.rect(5, 25, 4, 2, 'steel1');
      pix.rect(18, 25, 4, 2, 'steel1');

      // Side face, in shadow.
      pix.poly([[22, 13], [25, 10], [25, 22], [22, 25]], 'steel1');
      ditherIn(22, 10, 4, 13, 'steel2', 1, ['steel1']);

      // Lit top face, with cooling slots.
      pix.poly([[4, 13], [7, 10], [25, 10], [22, 13]], 'steel3');
      ditherIn(4, 10, 22, 4, 'steel4', 0, ['steel3']);
      for (const x of [9, 12, 15]) pix.line(x, 12, x + 2, 10, 'steel1');
      // Pivot boss the lever turns in.
      pix.rect(20, 11, 3, 2, 'steel2');
      pix.line(20, 11, 22, 11, 'steel4');

      // Body face.
      pix.rect(4, 13, 19, 13, 'steel2');
      pix.line(4, 13, 22, 13, 'steel4');
      pix.line(4, 13, 4, 25, 'steel3');
      pix.line(4, 25, 22, 25, 'steel1');
      pix.line(22, 14, 22, 25, 'steel1');
      ditherIn(15, 24, 8, 2, 'steel1', 0, ['steel2']);

      // The door. A ring only reads at this size if the band is as wide as the
      // hole, so: hard ink edge, a fat bright bezel, four bolts, dark glass.
      pix.disc(11, 19, 5.4, 5.4, 'steel4');
      ditherIn(11, 19, 7, 7, 'steel3', 1, ['steel4']);
      ditherIn(12, 21, 6, 5, 'steel2', 0, ['steel3', 'steel4']);
      for (const [x, y] of [[8, 16], [14, 16], [8, 22], [14, 22]]) pix.set(x, y, 'steel1');
      pix.disc(11, 19, 3.4, 3.4, 'ink2');

      // Something is going on in there. Dark glass above it, so the door
      // reads as a window with a fire behind it and not as an orange tile.
      pix.disc(11, 20.4, 2.2, 1.7, 'ember1');
      pix.disc(11, 20.8, 1.5, 1.2, 'ember2');
      pix.set(10, 20, 'ember3');
      pix.set(11, 21, 'ember3');
      pix.set(10, 18, 'cream3');

      // Latch: a handle bar on two brackets, right of the door.
      pix.rect(17, 14, 5, 11, 'steel1');
      pix.rect(18, 15, 3, 2, 'steel2');
      pix.rect(18, 22, 3, 2, 'steel2');
      pix.rect(18, 15, 2, 9, 'steel3');
      pix.line(18, 15, 18, 23, 'steel4');
      pix.line(21, 15, 21, 23, 'steel1');

      pix.outline();
    },
  },

  {
    // A plate, three-quarter on, with a rim and a foot so it is not a stone.
    name: 'obj-plate',
    draw(pix) {
      pix.disc(16, 20, 10, 5.2, 'cream1');
      pix.disc(16, 18, 10, 5.2, 'cream3');
      pix.ring(16, 18, 10, 5.2, 'cream2');
      pix.ring(16, 18, 6.8, 3.2, 'cream1');
      pix.disc(16, 18, 6.2, 2.8, 'cream4');

      // Light upper left, shadow lower right, on both rim and well.
      ditherIn(16, 19, 11, 7, 'cream2', 0, ['cream3', 'cream4']);
      ditherIn(18, 21, 9, 5, 'cream1', 1, ['cream2', 'cream3']);
      pix.line(9, 15, 13, 14, 'cream4');
      pix.line(21, 22, 24, 20, 'cream1');

      pix.outline();
    },
  },

  {
    // Folding camp chair: canvas seat and back, crossed steel legs.
    name: 'obj-seat',
    draw(pix) {
      /*
       * A felled log with a flat split face, which is what you sit on here.
       *
       * The first version of this was a chair — steel legs, a green cushion
       * and a leaning back rest — which is a perfectly good drawing of an
       * office chair and has no business in a pine hollow. The campsite's
       * seat has always been a log: the reach id is `log-seat`, the geometry
       * in the scene is a cylinder lying on its side, and a player who walks
       * up to it and is shown a swivel chair has been lied to about what is
       * in front of them.
       *
       * Drawn along its length rather than end-on, because the end-on view of
       * a log is a circle and a circle at 24 pixels is a stone.
       */

      // The bark barrel, seen slightly from above so the split face shows.
      pix.rect(4, 14, 24, 8, 'wood2');
      pix.rect(4, 13, 24, 2, 'wood3');
      pix.line(4, 21, 27, 21, 'wood1');
      pix.line(4, 22, 27, 22, 'wood1');

      // The split: a pale sawn face along the top, which is the seat itself
      // and the one thing that says "sit here" rather than "firewood".
      pix.rect(5, 11, 22, 3, 'cream2');
      pix.line(5, 11, 26, 11, 'cream3');
      pix.line(5, 13, 26, 13, 'cream1');
      // Grain, running the length. Two lines, not a texture — at this size a
      // third one turns the seat into a griddle.
      pix.line(8, 12, 15, 12, 'cream1');
      pix.line(19, 12, 24, 12, 'cream1');

      /*
       * Round the barrel. Four bands rather than a dither: at eight pixels of
       * height a checker reads as noise, and what this shape needs is not
       * texture but curvature — without a value falling off toward the bottom
       * the log is a crate, which is exactly what the first pass looked like.
       */
      pix.line(5, 15, 26, 15, 'wood3');
      pix.line(5, 16, 26, 16, 'wood2');
      pix.line(5, 19, 26, 19, 'wood1');
      pix.line(5, 20, 26, 20, 'wood1');
      // Bark, only in the lit band, where a texture can be seen at all.
      ditherIn(7, 17, 18, 2, 'wood1', 0, ['wood2']);
      // And knock the corners off, so the ends are round rather than square.
      pix.set(4, 13, 'none');
      pix.set(27, 13, 'none');
      pix.set(4, 21, 'none');
      pix.set(27, 21, 'none');
      pix.set(27, 14, 'wood2');

      // The cut end, catching the light on the left.
      pix.poly([[4, 12], [7, 11], [7, 21], [4, 22]], 'wood3');
      pix.line(4, 12, 4, 22, 'wood2');
      // Rings on it, because that is the whole charm of a cut log.
      pix.line(5, 15, 6, 15, 'cream1');
      pix.line(5, 18, 6, 18, 'wood1');

      // Two chocks so it does not read as floating, and a contact shadow.
      pix.rect(9, 22, 3, 3, 'wood1');
      pix.rect(19, 22, 3, 3, 'wood1');
      // A contact shadow down-right, so the log sits on ground rather than in air.
      pix.shadow(1, 1, 'ink2');

      pix.outline();
    },
  },
];
