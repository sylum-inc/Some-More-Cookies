/**
 * Objects — the things you carry, and the things you walk up to.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`. The short version of what this file agrees to:
 * a 24x24 box centred in a 32x32 cell, light from the upper left, one ramp per
 * material, `outline()` last, and never a letter or a digit anywhere.
 *
 * Materials are load-bearing here, but they are not allowed to do the whole
 * job. An earlier pass of this family had four consecutive icons — sandwich,
 * graham, chocolate, log — that were the same rounded rectangle in silhouette,
 * with only interior value telling them apart, which is rule 3 broken four
 * times in a row. So each of those now breaks its own contour: the ice cream
 * bulges past the crackers, the bar has a corner snapped off, the log is
 * end-on. Exactly one of them is still a clean slab, and that one is the
 * cracker, which really is a clean slab.
 *
 *   wood   logs, sticks, graham crackers, the roasting rod's handle
 *   steel  the SM-01, the radio, the camera, the torch, the binoculars
 *   cream  marshmallow, ice cream, the plate
 *   choc   exactly one thing
 *   stone  exactly one thing
 *   ember  the torch beam and what is alight behind the machine's door
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

/**
 * A lit block.
 *
 * `lit` says which edges of this block are actually facing the light: 't' for
 * the top, 'l' for the left. An edge that is *not* lit is drawn dark, because
 * an unlit edge is unlit for a reason — something is standing in front of it.
 * A machine drawn out of five blocks that each get a highlight on their own
 * top and left is a machine lit by five different suns, which is what the
 * binoculars, the camera and the SM-01 used to look like.
 */
function block(pix, x, y, w, h, dark, body, light, lit = 'tl') {
  pix.rect(x, y, w, h, body);
  if (lit.includes('t')) pix.line(x, y, x + w - 1, y, light);
  if (lit.includes('l')) pix.line(x, y, x, y + h - 1, light);
  pix.line(x, y + h - 1, x + w - 1, y + h - 1, dark);
  pix.line(x + w - 1, y, x + w - 1, y + h - 1, dark);
  if (!lit.includes('l')) pix.line(x, y, x, y + h - 1, dark);
  if (!lit.includes('t')) pix.line(x, y, x + w - 1, y, dark);
}

/**
 * A run of an ellipse's edge, by angle.
 *
 * `ring()` lights a whole ellipse evenly, which is exactly wrong for a rim:
 * a rim is the one place on a round object where the light direction is
 * legible, so it needs a bright arc on the upper left and a dark one on the
 * lower right. Angles are screen angles — 0 is right, and y grows downward,
 * so PI..1.5PI is the upper-left quarter.
 */
function arc(pix, cx, cy, rx, ry, from, to, key, thickness = 1) {
  const step = 0.5 / Math.max(rx, ry, 1);
  for (let t = from; t <= to; t += step) {
    for (let k = 0; k < thickness; k++) {
      pix.set(cx + Math.cos(t) * (rx - k), cy + Math.sin(t) * (ry - k), key);
    }
  }
}

/** A stick with body, a lit upper-left side and a shaded lower-right side. */
function stick(pix, x0, y0, x1, y1, lit, body, shade) {
  pix.line(x0, y0 + 1, x1, y1 + 1, shade);
  pix.line(x0, y0, x1, y1, body);
  pix.line(x0, y0 - 1, x1, y1 - 1, lit);
}

/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // A fat pillow on a skewer. The toast is a wood dither over the cream —
    // a fifth cream would have been the easy way and the wrong one — and it
    // climbs the right-hand side rather than sitting in a band on the bottom,
    // because a marshmallow turns in the fire and browns where it faced it.
    name: 'obj-marshmallow',
    draw(pix) {
      // Skewer, three runs wide so `outline()` leaves something behind. Two
      // one-pixel lines came back from the outline pass as a single black
      // thread, and the stick is the clearest cue the icon has.
      pix.line(4, 26, 17, 13, 'wood3');
      pix.line(5, 27, 18, 14, 'wood2');
      pix.line(6, 27, 19, 14, 'wood1');

      // Capsule: a barrel with a rounded cap top and bottom.
      pix.rect(11, 12, 12, 8, 'cream3');
      pix.disc(16.5, 12, 6, 3.2, 'cream3');
      pix.disc(16.5, 19, 6, 3.2, 'cream3');

      // Light from the upper left.
      pix.disc(14, 12, 3.4, 2.4, 'cream4');
      pix.set(13, 11, 'cream4');
      ditherIn(pix, 17, 14, 7, 9, 'cream2', 0, ['cream3']);
      pix.line(22, 13, 22, 19, 'cream2');

      // Toast: a wood dither climbing the right flank and pooling underneath.
      const cream = ['cream4', 'cream3', 'cream2'];
      ditherIn(pix, 18, 12, 6, 6, 'cream2', 1, ['cream3']);
      ditherIn(pix, 19, 13, 5, 6, 'wood3', 0, cream);
      ditherIn(pix, 11, 17, 13, 3, 'wood3', 1, cream);
      ditherIn(pix, 11, 19, 13, 2, 'wood3', 0, cream);
      for (let y = 21; y <= 23; y++) {
        for (let x = 11; x <= 23; x++) if (cream.includes(pix.get(x, y))) pix.set(x, y, 'wood3');
      }
      ditherIn(pix, 11, 20, 13, 4, 'wood2', 0, ['wood3']);
      ditherIn(pix, 18, 15, 6, 8, 'wood2', 1, ['wood3']);
      ditherIn(pix, 12, 22, 11, 2, 'wood1', 1, ['wood2', 'wood3']);

      pix.outline();
    },
  },

  {
    // Ice cream between two grahams, and the ice cream is squeezing out past
    // them on both sides. That bulge is deliberate: it is the only thing that
    // stops this from being the same rectangle as the cracker and the bar.
    name: 'obj-sandwich',
    draw(pix) {
      // Right side face, in shadow, then the front, then the lit top.
      pix.poly([[22, 12], [25, 9], [25, 21], [22, 24]], 'wood1');

      // Crackers, front on.
      pix.rect(7, 12, 16, 4, 'wood3');
      pix.rect(7, 21, 16, 4, 'wood3');
      pix.line(7, 12, 22, 12, 'wood4');
      pix.line(7, 15, 22, 15, 'wood2');
      pix.line(7, 21, 22, 21, 'wood4');
      pix.line(7, 24, 22, 24, 'wood2');
      ditherIn(pix, 17, 13, 6, 12, 'wood2', 1, ['wood3']);

      // Ice cream, wider than the biscuits and lumpy at both ends.
      pix.rect(5, 16, 20, 5, 'cream3');
      pix.disc(6, 18, 2.2, 2.6, 'cream3');
      pix.disc(24, 19, 2.2, 2.4, 'cream3');
      pix.disc(13, 20, 4, 2.4, 'cream3');
      // One drip escaping down the left, past the lower cracker's edge.
      pix.rect(5, 21, 3, 3, 'cream3');
      pix.set(5, 24, 'cream2');
      pix.set(6, 24, 'cream2');

      // Bright along the top of the cream, soft underneath.
      pix.line(6, 16, 23, 16, 'cream4');
      pix.set(5, 17, 'cream4');
      ditherIn(pix, 16, 18, 10, 6, 'cream2', 0, ['cream3']);
      ditherIn(pix, 5, 21, 6, 4, 'cream2', 1, ['cream3']);
      pix.line(8, 20, 20, 20, 'cream2');

      // Lit top face of the upper cracker, with its perforations.
      pix.poly([[7, 12], [10, 9], [25, 9], [22, 12]], 'wood4');
      for (const x of [12, 16, 20]) pix.set(x, 10, 'wood2');
      for (const x of [10, 14, 18]) pix.set(x, 11, 'wood2');
      pix.poly([[22, 16], [25, 13], [25, 17], [22, 20]], 'cream1');

      pix.outline();
    },
  },

  {
    // One cracker, whole. The clean slab of the family — the other three that
    // used to share this rectangle have all broken their contour, so this one
    // is allowed to keep it. What separates it from a plank is a chipped,
    // bevelled edge and the docking holes, not value alone.
    name: 'obj-graham',
    draw(pix) {
      pix.rect(7, 9, 18, 15, 'wood4');

      // Bevel: the biscuit is thicker than a card and the edge says so.
      pix.line(7, 9, 24, 9, 'cream3');
      pix.line(7, 9, 7, 23, 'cream3');
      pix.line(7, 22, 24, 22, 'wood3');
      pix.line(7, 23, 24, 23, 'wood2');
      pix.line(23, 10, 23, 23, 'wood3');
      pix.line(24, 10, 24, 23, 'wood2');

      // Baked unevenly: darker toward the lower right.
      ditherIn(pix, 14, 14, 11, 9, 'wood3', 0, ['wood4']);
      ditherIn(pix, 18, 17, 7, 6, 'wood2', 1, ['wood3']);
      ditherIn(pix, 8, 10, 8, 6, 'cream3', 1, ['wood4']);

      // The score, stopping well short of both edges so the slab still reads
      // as one biscuit rather than as two panels of a folded card. Perforated
      // rather than solid, which is both what a cracker actually has and the
      // safe side of rule 6 — a solid bar down the middle of a rectangle is
      // one squint away from being a digit.
      for (const y of [13, 14, 16, 17, 19]) {
        pix.set(15, y, 'wood3');
        pix.set(16, y, 'wood2');
      }

      // Docking holes.
      for (const y of [12, 17]) {
        for (const x of [10, 12, 19, 21]) pix.set(x, y, 'wood2');
      }
      for (const y of [14, 19]) {
        for (const x of [11, 13, 20, 22]) pix.set(x, y, 'wood2');
      }

      // Chipped: corners knocked off and three crumbs missing from the edges.
      for (const [x, y] of [[7, 9], [24, 9], [7, 23], [24, 23], [8, 9], [7, 10]]) {
        pix.set(x, y, 'none');
      }
      for (const [x, y] of [[24, 14], [24, 15], [16, 23], [17, 23]]) {
        pix.set(x, y, 'none');
      }
      pix.set(23, 14, 'wood2');

      pix.outline();
    },
  },

  {
    // Segmented bar with a corner snapped clean off. Nine cells, one of them
    // gone — the notch is what keeps this out of the rectangle pile, and a
    // broken chocolate bar is more appetising than an unbroken one anyway.
    name: 'obj-chocolate',
    draw(pix) {
      // Squared, not rounded: this is the one hard-cornered object here.
      pix.rect(6, 10, 20, 15, 'choc2');

      for (const cy of [10, 15, 20]) {
        for (const cx of [6, 13, 20]) {
          pix.rect(cx, cy, 6, 4, 'choc2');
          pix.line(cx, cy, cx + 5, cy, 'choc3');
          pix.line(cx, cy, cx, cy + 3, 'choc3');
          pix.line(cx + 5, cy, cx + 5, cy + 4, 'choc1');
          pix.line(cx, cy + 4, cx + 5, cy + 4, 'choc1');
        }
      }
      ditherIn(pix, 6, 10, 21, 6, 'choc3', 1, ['choc2']);
      ditherIn(pix, 16, 17, 10, 8, 'choc1', 0, ['choc2']);

      // The bar's own outer edge is not a groove.
      pix.line(6, 10, 25, 10, 'choc3');
      pix.line(6, 10, 6, 24, 'choc3');
      pix.line(6, 24, 25, 24, 'choc1');
      pix.line(25, 10, 25, 24, 'choc1');

      // Snap off the top-right cell, along a ragged break.
      for (const [x, y] of [
        [26, 9], [20, 10], [21, 10], [22, 10], [23, 10], [24, 10], [25, 10],
        [21, 11], [22, 11], [23, 11], [24, 11], [25, 11],
        [22, 12], [23, 12], [24, 12], [25, 12],
        [24, 13], [25, 13], [25, 14],
      ]) {
        pix.set(x, y, 'none');
      }
      // The broken face is paler than the moulded top: fresh chocolate.
      for (const [x, y] of [[20, 11], [21, 12], [22, 13], [23, 13], [23, 14], [24, 14], [24, 15]]) {
        pix.set(x, y, 'choc3');
      }

      pix.outline();
    },
  },

  {
    // A split round turned three-quarter on, cut face toward you. The circle
    // of the end is what breaks the rectangle — a log drawn side-on is just
    // another slab, and this family had four of those.
    name: 'obj-log',
    draw(pix) {
      // Barrel running away to the upper right.
      pix.poly([[10, 12], [21, 9], [25, 17], [16, 24]], 'wood2');
      pix.disc(23, 13, 3.5, 4.2, 'wood2');

      // Bark: lit along the top of the barrel, dark along the belly.
      pix.poly([[10, 12], [21, 9], [23, 13], [12, 16]], 'wood3');
      ditherIn(pix, 12, 13, 14, 5, 'wood2', 0, ['wood3']);
      ditherIn(pix, 14, 18, 12, 7, 'wood1', 1, ['wood2']);
      pix.line(16, 24, 25, 17, 'wood1');
      pix.line(15, 23, 24, 16, 'wood1');
      // Two ridges running the length, so the barrel is bark and not a bag.
      pix.line(14, 13, 22, 11, 'wood1');
      pix.line(15, 19, 24, 15, 'wood1');

      // Cut end, nearer the middle than the margin so the detail anchors the
      // icon instead of fighting the outline. Heartwood is warm, not pale.
      pix.disc(13, 18, 6.5, 7, 'wood3');
      ditherIn(pix, 8, 18, 12, 8, 'wood2', 0, ['wood3']);
      pix.disc(11.5, 16, 3.6, 3.6, 'wood4');
      ditherIn(pix, 11, 16, 6, 6, 'wood3', 1, ['wood4']);
      // Two rings. Three was a bullseye, and a bullseye is a target.
      pix.ring(13, 18, 4.6, 5, 'wood2');
      pix.ring(13, 18, 2.2, 2.4, 'wood2');
      pix.set(13, 18, 'wood2');
      // Bark rim around the cut face, bright where it faces the light.
      pix.ring(13, 18, 6.5, 7, 'wood2');
      arc(pix, 13, 18, 6.5, 7, Math.PI * 0.95, Math.PI * 1.8, 'wood3');
      arc(pix, 13, 18, 6.5, 7, Math.PI * 0.05, Math.PI * 0.8, 'wood1');

      pix.outline();
    },
  },

  {
    // Split sticks, bundled. Five one-pixel sticks crossing at the centre came
    // back from `outline()` as a black asterisk — half the icon was ink. These
    // are three fat ones stacked, with a single one laid across them, so there
    // is mass for the outline to sit around instead of eat.
    name: 'obj-kindling',
    draw(pix) {
      stick(pix, 5, 21, 26, 18, 'wood3', 'wood2', 'wood1');
      stick(pix, 5, 22, 26, 19, 'wood3', 'wood2', 'wood1');
      stick(pix, 6, 16, 26, 12, 'wood4', 'wood3', 'wood2');
      stick(pix, 6, 17, 26, 13, 'wood4', 'wood3', 'wood2');
      stick(pix, 5, 11, 25, 8, 'wood3', 'wood2', 'wood1');
      stick(pix, 5, 12, 25, 9, 'wood3', 'wood2', 'wood1');

      // One laid across the bundle, so it is a pile and not a fence.
      stick(pix, 9, 25, 22, 6, 'wood4', 'wood3', 'wood2');
      stick(pix, 10, 25, 23, 6, 'wood4', 'wood3', 'wood2');

      // Grain along the fat sticks, which is the cheapest way to say wood.
      ditherIn(pix, 12, 19, 10, 3, 'wood1', 0, ['wood2']);
      ditherIn(pix, 12, 13, 10, 3, 'wood2', 1, ['wood3']);

      // Pale ends, because split wood is bright where it broke.
      for (const [x, y] of [[5, 21], [5, 11], [9, 25], [26, 18], [26, 12], [22, 6]]) {
        for (const [dx, dy] of [[0, 0], [1, 0], [0, 1], [1, 1]]) pix.set(x + dx, y + dy, 'wood4');
      }
      pix.set(6, 22, 'cream3');
      pix.set(6, 12, 'cream3');
      pix.set(10, 25, 'cream3');

      pix.outline();
    },
  },

  {
    // A nest of dry stuff: a dark hollow up in the top left and a thick rim
    // rolling round the bottom right.
    //
    // The strands are laid *tangent* to the mass, not radiating out of it.
    // Fourteen one-pixel spokes around an oval is a spider, which is what the
    // last pass of this drew, and shortening the spokes only made a smaller
    // spider — a nest is wound, so the strokes have to follow the winding.
    // What is left of the fringe is a one-and-two-pixel raggedness on the rim,
    // which reads as fibre; anything longer goes straight back to being a leg.
    name: 'obj-tinder',
    draw(pix) {
      // The mass: pale and dry, not the dark brown of the kindling.
      pix.disc(16, 18, 9, 6, 'wood3');
      ditherIn(pix, 7, 12, 19, 8, 'wood4', 0, ['wood3']);
      ditherIn(pix, 14, 18, 13, 7, 'wood2', 1, ['wood3', 'wood4']);

      // Wound: each stroke sits across the mass rather than pointing out of it.
      for (let i = 0; i < 15; i++) {
        const a = i * 0.897 + 0.4;
        const r = 0.5 + ((i * 7) % 5) * 0.12;
        const cx = 16 + Math.cos(a) * 9 * r;
        const cy = 18 + Math.sin(a) * 6 * r;
        const tx = -Math.sin(a) * 3.2;
        const ty = Math.cos(a) * 2.2;
        const key = i % 3 === 0 ? 'cream2' : i % 3 === 1 ? 'wood4' : 'wood2';
        pix.line(cx - tx, cy - ty, cx + tx, cy + ty, key);
      }

      // Thick rim along the bottom right, which is where a nest has its bulk.
      arc(pix, 16, 18, 9, 6, Math.PI * 0.02, Math.PI * 0.88, 'wood2', 3);
      arc(pix, 16, 18, 9, 6, Math.PI * 0.98, Math.PI * 1.88, 'cream2', 2);

      // The hollow, up and to the left, dark enough to read as a hole.
      pix.disc(14, 16, 5, 3, 'wood1');
      pix.disc(14, 16.4, 4, 2.2, 'wood2');
      ditherIn(pix, 10, 14, 9, 4, 'wood1', 0, ['wood2']);
      arc(pix, 14, 16, 5, 3, Math.PI * 0.9, Math.PI * 1.9, 'wood1', 1);
      arc(pix, 14, 16, 4.4, 2.6, Math.PI * 0.05, Math.PI * 0.8, 'wood3', 1);

      // Ragged edge: single fibres poking a pixel or two past the rim, so the
      // silhouette is fuzzy rather than the clean oval the stone already owns.
      for (let i = 0; i < 11; i++) {
        const a = i * 0.571 + 0.15;
        const out = 1 + (i % 3);
        pix.line(
          16 + Math.cos(a) * 8.4,
          18 + Math.sin(a) * 5.4,
          16 + Math.cos(a) * (9 + out),
          18 + Math.sin(a) * (6 + out * 0.7),
          i % 2 === 0 ? 'cream2' : 'wood3',
        );
      }

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
      ditherIn(pix, 15, 17, 11, 8, 'stone1', 0, ['stone2']);
      ditherIn(pix, 8, 16, 8, 6, 'stone3', 1, ['stone2']);
      ditherIn(pix, 10, 10, 9, 5, 'stone4', 1, ['stone3']);

      // One crack, so the facets read as stone rather than as folded paper.
      pix.line(15, 16, 17, 21, 'stone1');
      pix.line(17, 21, 16, 24, 'stone1');

      pix.outline();
    },
  },

  {
    // Hand torch, stood up on its end with the head high and to the left.
    //
    // Lying on its side it was a grey box with three white hairs coming out of
    // it, and the hairs did not survive `outline()` — a one-pixel ray comes
    // back wrapped in ink, which is a scratch, not light. So: a tapered stick
    // for a silhouette, and the beam is a solid wedge in the ember ramp, well
    // away from the cream the food is drawn in.
    name: 'obj-torch',
    draw(pix) {
      // The beam, first, so the bezel overlaps its root.
      pix.poly([[7, 11], [15, 7], [13, 4], [4, 8]], 'ember3');
      pix.poly([[8, 10], [14, 7], [13, 5], [7, 8]], 'ember4');
      ditherIn(pix, 4, 4, 12, 6, 'ember4', 0, ['ember3']);
      ditherIn(pix, 4, 6, 6, 5, 'ember2', 1, ['ember3']);

      // Head: a cone opening up and to the left.
      pix.poly([[7, 11], [15, 7], [17, 14], [11, 16]], 'steel2');
      pix.poly([[7, 11], [15, 7], [16, 11], [9, 14]], 'steel3');
      pix.line(7, 11, 15, 7, 'steel4');
      ditherIn(pix, 11, 11, 7, 6, 'steel1', 0, ['steel2']);

      // Lens, hot: the one warm thing on a steel object.
      pix.line(8, 11, 15, 8, 'ember4');
      pix.line(8, 12, 15, 9, 'ember3');
      pix.set(9, 11, 'accent');
      pix.set(10, 11, 'accent');

      // Barrel, tapering to the tail.
      pix.poly([[11, 16], [17, 14], [20, 23], [16, 25]], 'steel2');
      pix.poly([[11, 16], [16, 14], [18, 22], [14, 24]], 'steel3');
      pix.line(11, 16, 17, 14, 'steel4');
      ditherIn(pix, 15, 16, 6, 9, 'steel1', 0, ['steel2', 'steel3']);
      // Knurling: three bands across the barrel, not along it.
      for (const [x0, y0, x1, y1] of [[12, 18, 18, 16], [13, 20, 19, 19], [14, 22, 19, 21]]) {
        pix.line(x0, y0, x1, y1, 'steel1');
      }
      // Tail cap, and a switch on the lit side.
      pix.poly([[15, 24], [19, 22], [20, 25], [16, 26]], 'steel2');
      pix.line(15, 24, 19, 22, 'steel3');
      pix.rect(11, 17, 2, 3, 'steel4');
      pix.set(12, 19, 'steel1');

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

      // Shaft: thin and bright against the handle, but two runs wide so the
      // outline has something to wrap rather than something to swallow.
      pix.line(12, 17, 20, 9, 'steel4');
      pix.line(13, 17, 21, 9, 'steel3');
      pix.line(14, 18, 22, 10, 'steel2');

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
    // Portable radio: speaker, dial, two knobs, whip aerial off the top right.
    // The aerial is this object's whole silhouette claim, which is why the
    // machine next door had to stop growing one.
    name: 'obj-radio',
    draw(pix) {
      // Aerial first, so the case covers its root.
      pix.line(22, 14, 26, 6, 'steel3');
      pix.line(22, 15, 26, 7, 'steel2');
      pix.disc(26, 5, 1.4, 1.4, 'steel4');

      block(pix, 6, 12, 20, 13, 'steel1', 'steel2', 'steel3');
      pix.line(6, 12, 25, 12, 'steel4');
      ditherIn(pix, 17, 20, 9, 5, 'steel1', 0, ['steel2']);

      // Speaker grille.
      pix.disc(13, 18, 5.4, 5.4, 'steel1');
      pix.disc(13, 18, 4.4, 4.4, 'steel3');
      for (let y = 13; y <= 23; y += 2) {
        for (let x = 7; x <= 19; x++) if (pix.get(x, y) === 'steel3') pix.set(x, y, 'steel1');
      }
      pix.ring(13, 18, 5.4, 5.4, 'steel4');
      arc(pix, 13, 18, 5.4, 5.4, Math.PI * 0.05, Math.PI * 0.85, 'steel1');
      ditherIn(pix, 8, 19, 11, 6, 'steel1', 1, ['steel4']);

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
    //
    // Lit as one object: the left eyecup is the upper-left-most surface, so it
    // is the only part that gets the steel4 highlight, and every part standing
    // to the right of another part has its left edge in shadow.
    name: 'obj-binoculars',
    draw(pix) {
      // Eyecups. The right one is behind the bridge's shoulder, hence unlit.
      block(pix, 8, 8, 5, 4, 'steel1', 'steel2', 'steel4', 'tl');
      block(pix, 19, 8, 5, 4, 'steel1', 'steel2', 'steel3', 't');

      // Bridge, behind the barrels and to the right of the left one.
      block(pix, 12, 13, 8, 6, 'steel1', 'steel2', 'steel3', 't');
      pix.rect(14, 11, 4, 5, 'steel3');
      for (const y of [12, 14]) pix.line(14, y, 17, y, 'steel1');
      pix.line(14, 11, 14, 15, 'steel2');

      // Barrels.
      block(pix, 6, 11, 8, 12, 'steel1', 'steel2', 'steel3', 'tl');
      block(pix, 18, 11, 8, 12, 'steel1', 'steel2', 'steel3', 't');
      ditherIn(pix, 10, 15, 4, 8, 'steel1', 0, ['steel2']);
      ditherIn(pix, 20, 12, 6, 11, 'steel1', 0, ['steel2']);
      pix.line(6, 11, 13, 11, 'steel4');

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
    // The flash is the upper-left-most block and gets the only steel4 edge;
    // the prism and the winder stand to its right and are shaded accordingly.
    name: 'obj-camera',
    draw(pix) {
      block(pix, 12, 7, 8, 5, 'steel1', 'steel2', 'steel3', 't');
      block(pix, 6, 8, 4, 4, 'steel1', 'steel2', 'steel4', 'tl');
      pix.rect(7, 9, 2, 2, 'cream4');
      block(pix, 22, 9, 3, 3, 'steel1', 'steel3', 'steel3', 't');

      // Body.
      block(pix, 5, 11, 22, 14, 'steel1', 'steel2', 'steel3', 'tl');
      // Its top edge is only lit where nothing is standing on it.
      pix.line(5, 11, 11, 11, 'steel4');
      pix.line(12, 11, 19, 11, 'steel1');
      pix.line(20, 11, 26, 11, 'steel3');
      ditherIn(pix, 20, 14, 7, 11, 'steel1', 0, ['steel2']);
      ditherIn(pix, 6, 20, 5, 5, 'steel1', 1, ['steel2']);
      ditherIn(pix, 6, 12, 6, 5, 'steel3', 0, ['steel2']);

      // Lens.
      pix.disc(16, 18, 5.6, 5.6, 'steel1');
      pix.ring(16, 18, 5.6, 5.6, 'steel3');
      arc(pix, 16, 18, 5.6, 5.6, Math.PI * 0.05, Math.PI * 0.85, 'steel1');
      pix.disc(16, 18, 4.4, 4.4, 'steel3');
      ditherIn(pix, 12, 14, 5, 5, 'steel4', 0, ['steel3']);
      ditherIn(pix, 16, 19, 6, 5, 'steel2', 1, ['steel3']);
      pix.disc(16, 18, 3.4, 3.4, 'ink2');
      pix.disc(16, 18, 2.4, 2.4, 'sky2');
      pix.set(15, 16, 'sky4');
      pix.set(14, 17, 'sky3');

      pix.outline();
    },
  },

  {
    // SM-01. The hero object, so it gets the shape nothing else here has.
    //
    // Drawn as a box with a lever it was, in flat black, the same cut-out as
    // the radio: wide case, thin stalk off the upper right, one big circle on
    // the body. So the box is gone. A pot belly, a hopper breaking the top
    // edge on the *left* — the radio's aerial leaves on the right — and legs
    // that taper to two feet. The door is the only warm thing in the icon and
    // it is what your eye lands on.
    name: 'obj-machine',
    draw(pix) {
      // Legs, under everything, splaying out as they go down.
      pix.poly([[8, 21], [12, 21], [10, 27], [7, 27]], 'steel1');
      pix.poly([[20, 21], [24, 21], [25, 27], [22, 27]], 'steel1');
      pix.line(8, 21, 7, 27, 'steel2');
      pix.line(20, 21, 22, 27, 'steel2');

      // Hopper, off the top left, wider at its mouth.
      pix.poly([[4, 4], [13, 4], [11, 11], [7, 11]], 'steel2');
      pix.poly([[4, 4], [13, 4], [12, 6], [5, 6]], 'steel3');
      pix.line(4, 4, 13, 4, 'steel4');
      pix.line(4, 4, 7, 11, 'steel3');
      ditherIn(pix, 8, 6, 6, 6, 'steel1', 0, ['steel2']);
      pix.line(13, 5, 11, 11, 'steel1');

      // The belly. Widest across the middle, which is the whole silhouette.
      pix.poly([[9, 10], [22, 10], [26, 17], [23, 24], [9, 24], [5, 17]], 'steel2');
      pix.poly([[9, 10], [22, 10], [24, 13], [8, 13]], 'steel3');
      pix.line(9, 10, 22, 10, 'steel4');
      pix.line(9, 10, 5, 17, 'steel3');
      ditherIn(pix, 16, 14, 11, 11, 'steel1', 0, ['steel2']);
      ditherIn(pix, 5, 15, 8, 10, 'steel1', 1, ['steel2']);
      ditherIn(pix, 6, 11, 10, 6, 'steel3', 1, ['steel2']);
      pix.line(9, 24, 23, 24, 'steel1');
      arc(pix, 16, 17, 11, 7, Math.PI * 0.1, Math.PI * 0.8, 'steel1');

      // A collar where the hopper meets the belly, so it is joinery and not
      // a stalk stuck on.
      pix.rect(6, 10, 8, 2, 'steel3');
      pix.line(6, 10, 13, 10, 'steel4');
      pix.line(6, 11, 13, 11, 'steel1');

      // The door. A ring only reads at this size if the band is as wide as the
      // hole, so: a fat bright bezel, four bolts, dark glass, and a fire.
      pix.disc(17, 17, 5.6, 5.6, 'steel3');
      arc(pix, 17, 17, 5.6, 5.6, Math.PI * 0.95, Math.PI * 1.85, 'steel4', 2);
      arc(pix, 17, 17, 5.6, 5.6, Math.PI * 0.05, Math.PI * 0.85, 'steel1', 2);
      ditherIn(pix, 14, 18, 8, 6, 'steel2', 0, ['steel3']);
      for (const [x, y] of [[14, 14], [20, 14], [14, 20], [20, 20]]) pix.set(x, y, 'steel1');
      pix.disc(17, 17, 3.4, 3.4, 'ink2');

      // Something is going on in there. Dark glass above it, so the door
      // reads as a window with a fire behind it and not as an orange tile.
      pix.disc(17, 18.4, 2.4, 1.8, 'ember1');
      pix.disc(17, 18.8, 1.6, 1.2, 'ember2');
      pix.set(16, 18, 'ember3');
      pix.set(17, 19, 'ember3');
      pix.set(16, 16, 'steel4');

      // A tap on the lower right, because something has to come out of it.
      pix.rect(24, 19, 3, 2, 'steel3');
      pix.line(24, 19, 26, 19, 'steel4');
      pix.rect(26, 20, 2, 3, 'steel2');
      pix.set(26, 23, 'steel1');

      pix.outline();
    },
  },

  {
    // A plate on a foot, three-quarter on. Flat, it was an oval — the same
    // cut-out as the stone and the tinder, and it read as an egg. So the rim
    // is raised, the well is sunk dark enough to be a hole, and the pedestal
    // breaks the bottom of the oval so the silhouette is not a closed curve.
    name: 'obj-plate',
    draw(pix) {
      // Foot, drawn first and left standing proud below the bowl.
      pix.disc(16, 26, 5.4, 1.8, 'cream1');
      pix.disc(16, 25, 5.4, 1.8, 'cream2');
      pix.poly([[13, 21], [19, 21], [20, 26], [12, 26]], 'cream2');
      pix.line(13, 21, 12, 26, 'cream3');
      pix.line(19, 21, 20, 26, 'cream1');
      ditherIn(pix, 16, 22, 6, 5, 'cream1', 0, ['cream2']);

      // The rim: an ellipse with its underside showing, so it has thickness.
      pix.disc(16, 19, 11, 5, 'cream1');
      pix.disc(16, 17, 11, 5, 'cream3');
      ditherIn(pix, 16, 17, 12, 8, 'cream2', 0, ['cream3']);
      ditherIn(pix, 20, 19, 8, 6, 'cream1', 1, ['cream2']);
      arc(pix, 16, 17, 11, 5, Math.PI * 0.95, Math.PI * 1.85, 'cream4', 2);
      arc(pix, 16, 19, 11, 5, Math.PI * 0.05, Math.PI * 0.85, 'cream1', 2);

      // The well, sunk. Dark at its far edge, which is what makes it a hole
      // rather than a disc painted on a plate.
      pix.disc(16, 17.4, 6.6, 2.6, 'cream1');
      pix.disc(16, 18, 6, 2.2, 'cream2');
      ditherIn(pix, 11, 17, 11, 4, 'cream3', 1, ['cream2']);
      arc(pix, 16, 17.4, 6.6, 2.6, Math.PI * 0.95, Math.PI * 1.9, 'cream1', 1);
      arc(pix, 16, 18, 6, 2.2, Math.PI * 0.1, Math.PI * 0.8, 'cream3', 1);

      pix.outline();
    },
  },

  {
    name: 'obj-seat',
    draw(pix) {
      /*
       * A felled log with a flat split face, which is what you sit on here.
       *
       * The first version of this was a chair — steel legs, a green cushion
       * and a leaning back rest — which is a perfectly good drawing of an
       * office chair and has no business in a pine hollow. The campsite's
       * seat has always been a log: the reach id is `log-seat`, the geometry
       * in the scene is `LAYOUT.logSeat`, a cylinder lying on its side, and a
       * player who walks up to it and is shown a swivel chair has been lied
       * to about what is in front of them.
       *
       * Drawn along its length, end-on to nothing, which is also what keeps it
       * apart from `obj-log` now that the log has turned its cut face to the
       * viewer: one of them is a circle, this one is a bench.
       */

      // The bark barrel, seen slightly from above so the split face shows.
      pix.rect(4, 14, 24, 8, 'wood2');
      pix.line(4, 21, 27, 21, 'wood1');
      pix.line(4, 22, 27, 22, 'wood1');

      // The split: a pale sawn face along the top, in three-quarter view, so
      // it reads as a surface you could put yourself on rather than a stripe.
      pix.poly([[4, 13], [8, 10], [28, 10], [27, 13]], 'cream2');
      pix.rect(5, 13, 22, 2, 'cream2');
      pix.line(8, 10, 27, 10, 'cream3');
      pix.line(5, 14, 26, 14, 'cream1');
      ditherIn(pix, 14, 11, 14, 4, 'cream1', 1, ['cream2']);
      // Grain, running the length. Two lines, not a texture — at this size a
      // third one turns the seat into a griddle.
      pix.line(9, 12, 16, 12, 'cream1');
      pix.line(20, 12, 25, 12, 'cream1');

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
      ditherIn(pix, 7, 17, 18, 2, 'wood1', 0, ['wood2']);
      // And knock the corners off, so the ends are round rather than square.
      for (const [x, y] of [[4, 13], [27, 13], [4, 21], [27, 21], [4, 14], [27, 22]]) {
        pix.set(x, y, 'none');
      }
      pix.set(27, 14, 'wood2');

      // The cut end, catching the light on the left.
      pix.poly([[4, 12], [8, 11], [7, 21], [4, 21]], 'wood3');
      pix.line(4, 13, 4, 20, 'wood2');
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
