/**
 * roast — six portraits of one marshmallow, from cold sugar to open flame.
 *
 * These exist to replace the doneness bar in the HUD. A bar that fills is a
 * score however it is drawn, and the spec (§5.3) says a player is shown no
 * score, meter or number — so doneness is read here the way it is read at a
 * real fire: by looking at the sweet on the end of the stick. Nothing in this
 * file is a ring, a segment, a pip, or a fraction of anything.
 *
 * What makes the six read as one sequence is not a quantity, it is three
 * things happening at once to one object:
 *
 *   silhouette  a square-shouldered block softens, rounds, swells, sags and
 *               finally hangs off the stick. Squint at the row and the shape
 *               alone says roughly how far gone it is.
 *   value       the sugar darkens and never lightens: cream4..cream1, handing
 *               over to choc3..choc1, handing over to ink3/ink2. Any two
 *               neighbours differ by a whole step, which is what lets them be
 *               told apart at thirty-two pixels with no caption.
 *   event       each portrait owns one thing the others do not — the first
 *               gold underneath, the one shiny highlight, the split skin, the
 *               flame. That is the label, and it is a picture rather than a
 *               word.
 *
 * The stick is the constant: same wood, same angle, same corner of the cell in
 * all six, so the eye compares sugar and nothing else. Except in the last one,
 * where the body has come away from it — which is the whole point of the last
 * one, and is why the stick is drawn long enough there to be seen bare.
 *
 * Ember is spent in exactly one place, the flame and its seam in
 * `state-roast-burning`. It is the only saturated colour in the family, so it
 * can only mean "this is alight now", and it is kept small so it reads as a
 * flame on a marshmallow rather than as a campfire.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`.
 */

import { Pix } from '../canvas.mjs';

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/** The window the sugar can occupy, for the helpers that walk columns. */
const BODY_BOX = [8, 5, 20, 22];

/**
 * `dither()` that respects a silhouette.
 *
 * The canvas dither paints a rectangle whether or not anything is under it,
 * which is right for a background and wrong for shading a shape — texture that
 * leaks past an edge is the one thing `outline()` cannot rescue.
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

/**
 * Draws freehand and keeps only what landed on the sugar.
 *
 * A crack, a specular, an ember seam: all of them are drawn as a line or a
 * disc that would otherwise spill past the body's edge. Rendering to a scratch
 * buffer and compositing only over the listed keys means the marks can be
 * aimed roughly and still never break the silhouette.
 */
function clipped(pix, over, draw) {
  const scratch = new Pix(pix.width, pix.height);
  draw(scratch);
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      const key = scratch.get(x, y);
      if (key === 'none') continue;
      if (!over.includes(pix.get(x, y))) continue;
      pix.set(x, y, key);
    }
  }
}

/**
 * Lights the top edge of a mass and shades its bottom edge, column by column.
 * A blob of one colour is a hole; the same blob with a lit crown and a dark
 * belly is a solid thing lit from above.
 */
function rimLight(pix, box, bodyKeys, lightKey, darkKey) {
  const [x0, y0, w, h] = box;
  for (let x = x0; x < x0 + w; x++) {
    let first = -1;
    let last = -1;
    for (let y = y0; y < y0 + h; y++) {
      if (!bodyKeys.includes(pix.get(x, y))) continue;
      if (first < 0) first = y;
      last = y;
    }
    if (first < 0) continue;
    if (lightKey) pix.set(x, first, lightKey);
    if (darkKey && last > first) pix.set(x, last, darkKey);
  }
}

/**
 * Colour that creeps up from the underside, following the curve of the belly.
 *
 * This is how a marshmallow actually cooks — the face toward the coals goes
 * first — and it is deliberately not a horizontal band: it hugs the bottom of
 * whatever shape it is given and its upper edge is feathered by a dither, so
 * it can never be mistaken for a level in a container.
 */
function underside(pix, box, bodyKeys, key, depth, feather = 0) {
  const [x0, y0, w, h] = box;
  for (let x = x0; x < x0 + w; x++) {
    let last = -1;
    for (let y = y0; y < y0 + h; y++) if (bodyKeys.includes(pix.get(x, y))) last = y;
    if (last < 0) continue;
    for (let d = 0; d < depth + feather; d++) {
      const y = last - d;
      if (!bodyKeys.includes(pix.get(x, y))) continue;
      if (d >= depth && (x + y) % 2 !== 0) continue;
      pix.set(x, y, key);
    }
  }
}

/**
 * The body of the sweet: a superellipse with a heavy bottom.
 *
 * One shape function for all six, because they are six pictures of the same
 * object and a different construction each time would show. `square` is the
 * corner: high is a block with the corners just nicked off, low is an egg.
 * `bulge` fattens the lower half, `lean` slides the mass down and across, and
 * between them they carry the entire slump from cold to drooping.
 */
function lump(pix, key, { cx, cy, rx, ry, square = 4, lean = 0, bulge = 0 }) {
  const span = ry + 0.5;
  for (let y = Math.round(cy - ry); y <= Math.round(cy + ry); y++) {
    const t = Math.max(-1, Math.min(1, (y - cy) / span));
    let w = rx * Math.pow(Math.max(0, 1 - Math.pow(Math.abs(t), square)), 1 / square);
    if (t > 0) w *= 1 + bulge * t;
    if (w < 0.4) continue;
    const x = cx + lean * t;
    pix.line(Math.round(x - w), y, Math.round(x + w), y, key);
  }
}

/**
 * The stick, entering from the lower left. Three parallel runs offset
 * vertically — lit along the top, dark along the underside.
 */
function skewer(pix, tipX = 19, tipY = 12) {
  pix.line(5, 27, tipX, tipY + 1, 'wood1');
  pix.line(5, 26, tipX, tipY, 'wood2');
  pix.line(5, 25, tipX, tipY - 1, 'wood3');
  // Split, pale end where it was broken off the branch.
  pix.set(5, 25, 'wood4');
  pix.set(6, 26, 'wood4');
}

/**
 * A tongue of flame: a point at the tip, widest around halfway down, drawing
 * back in at the base, leaning as it climbs. The waist is the trick — a shape
 * that only widens downward is a cone, and a cone reads as a hat.
 */
function flame(pix, cx, topY, baseY, maxW, lean, key) {
  const height = Math.max(1, baseY - topY);
  for (let y = topY; y <= baseY; y++) {
    const t = (y - topY) / height;
    const halfWidth = maxW * Math.sin(Math.PI * 0.8 * Math.pow(t, 0.62));
    const x = cx + lean * (1 - t) * (1 - t);
    pix.line(Math.round(x - halfWidth), y, Math.round(x + halfWidth), y, key);
  }
}

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Cold. A block of raw sugar: corners barely knocked off, light sitting on
    // it as a broad matte field rather than a shine, because there is no skin
    // on it yet for anything to shine off.
    name: 'state-roast-cold',
    draw(pix) {
      skewer(pix);
      lump(pix, 'cream3', { cx: 18, cy: 12.8, rx: 6.4, ry: 5.4, square: 12 });

      clipped(pix, ['cream3'], (s) => s.disc(15, 11, 3.6, 2.6, 'cream4'));
      ditherIn(pix, 12, 12, 9, 3, 'cream3', 1, ['cream4']);
      ditherIn(pix, 21, 13, 5, 6, 'cream2', 0, ['cream3']);

      underside(pix, BODY_BOX, ['cream3', 'cream2'], 'cream2', 2, 2);
      rimLight(pix, BODY_BOX, ['cream4', 'cream3', 'cream2'], null, 'cream1');

      pix.outline();
    },
  },

  {
    // Warm. Not one grain of it has coloured — the only news is in the shape:
    // the corners have gone, the base has spread, the whole thing has settled
    // a pixel down the stick, and a first lip of it has crept onto the wood.
    name: 'state-roast-warm',
    draw(pix) {
      skewer(pix);
      lump(pix, 'cream3', { cx: 18, cy: 14, rx: 6.5, ry: 4.9, square: 2.6, bulge: 0.34, lean: 0.3 });

      clipped(pix, ['cream3'], (s) => s.disc(15, 12, 3.4, 2.4, 'cream4'));
      ditherIn(pix, 12, 13, 9, 3, 'cream3', 1, ['cream4']);
      ditherIn(pix, 21, 14, 5, 6, 'cream2', 0, ['cream3']);

      underside(pix, BODY_BOX, ['cream3', 'cream2'], 'cream2', 3, 2);
      rimLight(pix, BODY_BOX, ['cream4', 'cream3', 'cream2'], null, 'cream1');

      // Slumping: a lip of sugar starting down the stick, under the belly.
      pix.set(13, 20, 'cream2');
      pix.set(14, 20, 'cream3');
      pix.set(14, 21, 'cream2');

      pix.outline();
    },
  },

  {
    // Toasting. The first gold, and it is only underneath — the face that has
    // been looking at the coals. The crown is still raw cream, which is what
    // makes this one obviously earlier than the next.
    name: 'state-roast-toasting',
    draw(pix) {
      skewer(pix);
      lump(pix, 'cream3', { cx: 17.8, cy: 14.2, rx: 6.6, ry: 5.3, square: 2.7, bulge: 0.34, lean: 0.4 });

      clipped(pix, ['cream3'], (s) => s.disc(15, 12, 3.2, 2.2, 'cream4'));
      ditherIn(pix, 12, 13, 9, 3, 'cream3', 1, ['cream4']);

      underside(pix, BODY_BOX, ['cream3'], 'cream2', 4, 3);
      underside(pix, BODY_BOX, ['cream2'], 'choc3', 2, 2);
      rimLight(pix, [9, 5, 12, 22], ['cream4', 'cream3', 'cream2', 'choc3'], 'cream4', null);

      // Sagging further onto the stick.
      pix.set(13, 21, 'cream2');
      pix.set(14, 20, 'cream2');
      pix.set(14, 21, 'cream1');

      pix.outline();
    },
  },

  {
    // Browning. An even caramel skin all the way round — lighter at the top
    // because the light is up there, not because it is less cooked — visibly
    // swollen, and now glossy enough to hold one specular. That highlight is
    // the only cream4 on a brown body in the family.
    name: 'state-roast-browning',
    draw(pix) {
      skewer(pix);
      lump(pix, 'choc3', { cx: 17.6, cy: 14.6, rx: 7.1, ry: 5.8, square: 2.4, bulge: 0.24, lean: 0.5 });

      ditherIn(pix, 11, 9, 10, 7, 'cream2', 0, ['choc3']);
      rimLight(pix, [9, 5, 13, 22], ['choc3', 'cream2'], 'cream2', null);
      underside(pix, BODY_BOX, ['choc3', 'cream2'], 'choc2', 3, 3);
      ditherIn(pix, 19, 15, 8, 6, 'choc2', 0, ['choc3']);

      clipped(pix, ['choc3', 'cream2'], (s) => {
        s.set(14, 11, 'cream4');
        s.set(15, 11, 'cream4');
        s.set(14, 12, 'cream4');
      });

      pix.outline();
    },
  },

  {
    // Scorching. Dark brown going to black along the bottom, the skin split
    // wide enough to show the molten inside, and the whole mass hanging with a
    // bead pulling off the belly. The split is the event: nothing else in the
    // six is broken open.
    name: 'state-roast-scorching',
    draw(pix) {
      skewer(pix);
      lump(pix, 'choc2', { cx: 17.4, cy: 15.2, rx: 7, ry: 6.1, square: 2.2, bulge: 0.5, lean: 0.8 });

      ditherIn(pix, 11, 9, 10, 7, 'choc3', 0, ['choc2']);
      rimLight(pix, [9, 5, 13, 22], ['choc2', 'choc3'], 'choc3', null);
      underside(pix, BODY_BOX, ['choc2', 'choc3'], 'choc1', 4, 3);
      underside(pix, BODY_BOX, ['choc1'], 'ink2', 2, 2);

      // The split, with a dark lip under it so it reads as a hole in a crust
      // and not as a scratch on the surface.
      clipped(pix, ['choc1', 'choc2', 'choc3', 'ink2'], (s) => {
        s.line(14, 12, 15, 15, 'choc1');
        s.line(16, 16, 20, 18, 'choc1');
        s.line(15, 11, 16, 15, 'cream2');
        s.line(16, 15, 20, 17, 'cream2');
        s.set(15, 12, 'cream3');
        s.set(16, 15, 'cream3');
      });

      // A bead of it sagging off the underside.
      pix.set(18, 22, 'choc1');
      pix.set(19, 22, 'choc1');
      pix.set(18, 23, 'ink2');
      pix.set(18, 24, 'ink2');

      pix.outline();
    },
  },

  {
    // Burning. Alight: a small flame, a crust gone black, one ember seam where
    // the crust has cracked, and the body slumped clear off the end of the
    // stick, so that a length of bare wood shows above it that shows in none
    // of the other five.
    name: 'state-roast-burning',
    draw(pix) {
      skewer(pix, 22, 9);
      // Charred tip, where the sugar has gone and the fire has stayed.
      for (let i = 0; i < 2; i++) {
        pix.set(22 - i, 8 + i, 'ink3');
        pix.set(22 - i, 9 + i, 'ink3');
        pix.set(22 - i, 10 + i, 'ink2');
      }

      lump(pix, 'ink3', { cx: 15.5, cy: 17.6, rx: 6.6, ry: 5.6, square: 2.1, bulge: 0.55, lean: 1 });

      // Crust: warm char on the side the flame is on, cold char underneath.
      ditherIn(pix, 9, 12, 10, 7, 'choc1', 0, ['ink3']);
      rimLight(pix, [8, 8, 14, 20], ['ink3', 'choc1'], 'choc1', null);
      ditherIn(pix, 10, 13, 6, 4, 'choc2', 1, ['choc1']);
      underside(pix, BODY_BOX, ['ink3', 'choc1'], 'ink2', 3, 3);

      // The one ember seam, with a dark red lip below it.
      clipped(pix, ['ink2', 'ink3', 'choc1', 'choc2'], (s) => {
        s.line(11, 19, 14, 21, 'ember1');
        s.line(14, 21, 17, 23, 'ember1');
        s.line(10, 18, 13, 20, 'ember3');
        s.line(13, 20, 16, 22, 'ember3');
        s.set(11, 19, 'ember4');
        s.set(14, 21, 'ember4');
      });

      // A bead of burnt sugar hanging off it.
      pix.set(17, 24, 'ink2');
      pix.set(18, 24, 'ink2');
      pix.set(17, 25, 'ink2');

      // The flame. Small on purpose: this is a sweet on fire, not a campfire.
      flame(pix, 13, 5, 13, 2.4, 1.6, 'ember2');
      flame(pix, 13, 7, 12, 1.5, 1.1, 'ember3');
      flame(pix, 12.8, 9, 11.5, 0.7, 0.5, 'ember4');

      pix.outline();
    },
  },
];
