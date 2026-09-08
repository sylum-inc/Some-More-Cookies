/**
 * life — the animals you glimpse, and the marks they leave behind.
 *
 * Contract and rules live in `_example.mjs`; the drawing API and the palette
 * live in `../canvas.mjs`. A 24x24 box centred in a 32x32 cell, light from the
 * upper left, four values per material, `outline()` last, and never a letter or
 * a digit.
 *
 * The family is in two halves and they are drawn by opposite rules on purpose.
 *
 *   sightings   An animal at the edge of the firelight is a shape and two
 *               points of light, so that is exactly what these are: a flat
 *               cut-out in the ink ramp, seen side-on, with a rim of ink3 where
 *               the fire catches the top-left edge and ink under the belly. If
 *               a fox is not a fox as a black shape it is not fixable by
 *               shading it, so every one of these is built silhouette-first and
 *               the interior does almost nothing.
 *
 *   traces      A trace is not an animal, it is a dent or a leftover, so these
 *               are lit and material: duff, bark, ash, cream, chocolate. They
 *               carry the colour the sightings deliberately refuse.
 *
 * `accent` appears in this file in one place only — the eyeshine, two pixels,
 * on each of the eight animals. Nothing else in the family may use it, because
 * the whole point of the sighting cue is that your eye goes to the eyes.
 *
 * One hard-won rule about the silhouettes: negative space has to be at least
 * three pixels wide. `outline()` floods every transparent pixel within one of
 * the art, so a two-pixel gap between two legs is not a gap, it is a slab —
 * which is why these animals have two clear legs rather than four smeared ones,
 * and why every tail stands well clear of the back it curls over.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `dither()` that respects a silhouette — only recolours pixels already drawn,
 * so ground texture never leaks past the edge of a patch.
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

/** One pixel, but only where the material underneath is one we meant to paint. */
function over(pix, x, y, key, allowed) {
  if (allowed.includes(pix.get(x, y))) pix.set(x, y, key);
}

/**
 * Turns a flat mass into a lit cut-out.
 *
 * Every drawn pixel with nothing above or to its left takes the rim value;
 * every pixel with nothing below or to its right takes the dark value. One
 * pass over the whole canvas, so an animal can be built out of overlapping
 * discs and polys without any of the seams showing. The ramp stays inside
 * ink/ink2/ink3, so the result is still a black shape — the rim is a fire
 * catching an edge, not a light source of its own.
 */
function cutout(pix, rim = 'ink3', dark = 'ink') {
  const copy = pix.data.slice();
  const at = (x, y) => (pix.inside(x, y) ? copy[y * pix.width + x] : 'none');
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      if (at(x, y) === 'none') continue;
      if (at(x, y - 1) === 'none' || at(x - 1, y) === 'none') pix.set(x, y, rim);
      else if (at(x, y + 1) === 'none' || at(x + 1, y) === 'none') pix.set(x, y, dark);
    }
  }
}

/** The one accent in this family: two pixels of firelight in an eye. */
function eyeshine(pix, x, y, horizontal = true) {
  pix.set(x, y, 'accent');
  if (horizontal) pix.set(x + 1, y, 'accent');
  else pix.set(x, y + 1, 'accent');
}

/**
 * Lights the far wall of a depression.
 *
 * A hole in the ground is only a hole if the side away from the light is
 * bright, so ground touching the print on its lower-right is lifted a ramp
 * step. Without this a paw print is a black sticker.
 */
function litRim(pix, holeKeys, groundKeys, lit, dirs = [[0, 1], [1, 1]]) {
  const copy = pix.data.slice();
  const at = (x, y) => (pix.inside(x, y) ? copy[y * pix.width + x] : 'none');
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      if (!holeKeys.includes(at(x, y))) continue;
      for (const [dx, dy] of dirs) {
        if (groundKeys.includes(at(x + dx, y + dy))) pix.set(x + dx, y + dy, lit);
      }
    }
  }
}

/** A patch of forest floor: duff, its texture, and a couple of fallen needles. */
function duff(pix, cx, cy, rx, ry) {
  pix.disc(cx, cy, rx, ry, 'wood2');
  pix.disc(cx - rx * 0.4, cy - ry * 0.5, rx * 0.7, ry * 0.6, 'wood3');
  pix.disc(cx + rx * 0.5, cy + ry * 0.4, rx * 0.5, ry * 0.5, 'wood2');
  ditherIn(pix, cx - rx, cy - ry, rx * 2 + 2, ry * 2 + 2, 'wood1', 1, ['wood2']);
  ditherIn(pix, cx - rx, cy - ry, rx * 2 + 2, ry * 2 + 2, 'wood2', 0, ['wood3']);
  pix.line(cx - rx + 2, cy + ry - 3, cx - rx + 6, cy + ry - 5, 'green2');
  pix.line(cx + 1, cy - ry + 1, cx + 5, cy - ry + 2, 'green3');
}

/** One paw print: a heel pad and four toes, pressed pointing up. */
function pawprint(pix, cx, cy, s, key) {
  pix.disc(cx, cy + 3.4 * s, 3.4 * s, 2.6 * s, key);
  pix.disc(cx - 3.6 * s, cy - 1.4 * s, 1.5 * s, 1.7 * s, key);
  pix.disc(cx - 1.2 * s, cy - 3.4 * s, 1.5 * s, 1.7 * s, key);
  pix.disc(cx + 1.4 * s, cy - 3.4 * s, 1.5 * s, 1.7 * s, key);
  pix.disc(cx + 3.6 * s, cy - 1.4 * s, 1.5 * s, 1.7 * s, key);
}

/* -------------------------------------------------------------------------- */
/* Sightings — flat cut-outs, side-on, two pixels of eyeshine                  */
/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Fox. Read in order: the brush, which is a third of the animal and is held
    // out low behind with the tip flicked up, then the two straight ears, then
    // the long wedge of muzzle. The body is deliberately shallow — a fox that
    // stands as tall as it is long is a dog.
    name: 'life-fox',
    draw(pix) {
      // Brush. Drawn first so the haunch overlaps its root. It leaves the rump
      // level and only lifts at the tip — a tail held straight up is a cat.
      pix.disc(21.5, 19, 3.2, 3.2, 'ink2');
      pix.disc(24, 16.5, 3, 3, 'ink2');
      pix.disc(25, 13, 2.4, 2.6, 'ink2');
      pix.disc(24, 10, 2, 2.2, 'ink2');

      // Two legs, well apart. Four would be one black slab at this size.
      pix.rect(12, 20, 3, 6, 'ink2');
      pix.rect(18, 20, 3, 6, 'ink2');
      pix.rect(11, 25, 4, 1, 'ink2');
      pix.rect(17, 25, 4, 1, 'ink2');

      // Body: level back, deep chest, heavy haunch.
      pix.poly([[11, 15], [21, 14], [22, 20], [12, 21]], 'ink2');
      pix.disc(20, 18, 3.6, 3.6, 'ink2');
      pix.disc(13, 17, 3, 3.2, 'ink2');

      // Head and muzzle, carried low.
      pix.disc(12, 13, 3.6, 3.2, 'ink2');
      pix.poly([[4, 16], [11, 11], [12, 18]], 'ink2');
      pix.rect(4, 15, 3, 2, 'ink2');

      // Ears: tall, straight-sided, a clear notch between them.
      pix.poly([[8, 12], [8, 4], [12, 12]], 'ink2');
      pix.poly([[13, 12], [17, 5], [17, 13]], 'ink2');

      cutout(pix);
      eyeshine(pix, 9, 12);
      pix.outline();
    },
  },

  {
    // Owl. The only animal here seen head-on, because an owl is a face: two ear
    // tufts, a barrel with no neck, and both eyes at once.
    name: 'life-owl',
    draw(pix) {
      // Branch stub under the feet.
      pix.rect(8, 25, 16, 2, 'ink2');

      // Body: a bell, wide at the shoulders, tail below the perch line.
      pix.poly([[10, 12], [22, 12], [23, 24], [9, 24]], 'ink2');
      pix.disc(16, 18, 7, 7, 'ink2');
      pix.poly([[13, 22], [19, 22], [18, 26], [14, 26]], 'ink2');

      // Head, merged straight into the shoulders — an owl has no neck.
      pix.disc(16, 11, 6.5, 5.5, 'ink2');

      // Ear tufts, asymmetric so it does not read as a cat.
      pix.poly([[10, 8], [9, 4], [14, 8]], 'ink2');
      pix.poly([[18, 8], [23, 4], [22, 9]], 'ink2');

      // Wing edges, folded down the sides.
      pix.poly([[10, 14], [12, 14], [13, 23], [10, 22]], 'ink2');
      pix.poly([[20, 14], [22, 14], [22, 22], [19, 23]], 'ink2');

      // Toes gripping the branch.
      pix.rect(12, 24, 1, 3, 'ink2');
      pix.rect(14, 24, 1, 3, 'ink2');
      pix.rect(18, 24, 1, 3, 'ink2');
      pix.rect(20, 24, 1, 3, 'ink2');

      cutout(pix);

      // A shallow notch of rim between the eyes reads as the beak.
      pix.set(16, 12, 'ink3');
      pix.set(16, 13, 'ink3');

      eyeshine(pix, 12, 11, false);
      eyeshine(pix, 19, 11, false);
      pix.outline();
    },
  },

  {
    // Deer. Antlers and leg length carry this one, so the body is small and
    // high off the ground and everything else gets out of their way.
    name: 'life-deer',
    draw(pix) {
      // Legs: a foreleg and a hind leg, the hind one broken at the hock, which
      // is the joint that says deer and not dog.
      pix.rect(11, 17, 2, 9, 'ink2');
      pix.line(21, 17, 20, 21, 'ink2');
      pix.line(22, 17, 21, 21, 'ink2');
      pix.rect(20, 21, 2, 5, 'ink2');
      pix.rect(10, 25, 3, 1, 'ink2');
      pix.rect(19, 25, 3, 1, 'ink2');

      // Barrel body, short and set high.
      pix.poly([[10, 13], [22, 13], [23, 18], [11, 19]], 'ink2');
      pix.disc(21, 16, 3.4, 3.2, 'ink2');

      // Tail, cocked up.
      pix.poly([[23, 13], [25, 11], [25, 14]], 'ink2');

      // Neck, rising steeply forward.
      pix.poly([[9, 8], [13, 9], [13, 16], [10, 16]], 'ink2');

      // Head: a small wedge with an ear cupped behind it.
      pix.poly([[4, 10], [11, 7], [11, 11], [5, 12]], 'ink2');
      pix.poly([[10, 8], [14, 6], [13, 10]], 'ink2');

      // Antlers: two beams off the brow, each with two tines, the far one
      // shorter so the pair does not read as one flat comb.
      pix.line(9, 7, 8, 3, 'ink2');
      pix.line(8, 3, 5, 2, 'ink2');
      pix.line(8, 5, 5, 5, 'ink2');
      pix.set(9, 6, 'ink2');
      pix.line(11, 6, 13, 3, 'ink2');
      pix.line(13, 3, 16, 3, 'ink2');
      pix.line(13, 5, 15, 6, 'ink2');

      cutout(pix);
      eyeshine(pix, 8, 9);
      pix.outline();
    },
  },

  {
    // Mouse. One ear the size of the skull, a snout that comes to a point, and
    // a bare tail longer than the body, held clear of the back so it reads.
    name: 'life-mouse',
    draw(pix) {
      // Tail, whipping up and back.
      pix.line(21, 20, 25, 18, 'ink2');
      pix.line(25, 18, 26, 14, 'ink2');
      pix.line(26, 14, 24, 11, 'ink2');
      pix.set(25, 17, 'ink2');
      pix.set(26, 15, 'ink2');

      // Body, low and rounded.
      pix.disc(16, 19, 6, 4.6, 'ink2');
      pix.poly([[10, 17], [21, 15], [22, 21], [10, 22]], 'ink2');

      // Head running straight into a pointed snout.
      pix.disc(10, 18, 3.6, 3.4, 'ink2');
      pix.poly([[4, 21], [10, 15], [11, 22]], 'ink2');

      // The ear. Oversized on purpose — it is the whole read.
      pix.disc(12, 11, 4, 4, 'ink2');
      pix.rect(11, 13, 3, 3, 'ink2');

      // Feet.
      pix.rect(11, 22, 3, 2, 'ink2');
      pix.rect(18, 22, 3, 2, 'ink2');

      cutout(pix);
      eyeshine(pix, 8, 17);
      pix.outline();
    },
  },

  {
    // Squirrel. Sitting up with the tail plumed over the back in a question
    // mark. The tail is a chain of discs so it keeps an even, fat width, and it
    // is held four pixels clear of the spine so the two masses stay separate.
    name: 'life-squirrel',
    draw(pix) {
      for (const [x, y, r] of [
        [18, 25, 3],
        [21.5, 24, 3],
        [23.5, 21, 3],
        [24, 17, 3],
        [23, 13, 3],
        [21, 10, 2.8],
      ]) {
        pix.disc(x, y, r, r, 'ink2');
      }

      // Haunch and back, sitting upright, kept narrow and well to the left so
      // the plume never closes on it — a tail that touches the spine turns the
      // whole animal into one doughnut.
      pix.disc(12, 21, 4, 4.4, 'ink2');
      pix.poly([[8, 14], [14, 13], [16, 22], [8, 23]], 'ink2');

      // Chest and the forepaws held together in front of it.
      pix.poly([[7, 15], [11, 14], [11, 21], [7, 20]], 'ink2');
      pix.rect(6, 16, 3, 3, 'ink2');

      // Head, blunt nose, and a tufted ear.
      pix.disc(10, 11, 3.4, 3.2, 'ink2');
      pix.poly([[5, 13], [10, 9], [10, 14]], 'ink2');
      pix.poly([[10, 9], [12, 5], [13, 10]], 'ink2');

      // Feet.
      pix.rect(9, 24, 6, 2, 'ink2');

      cutout(pix);
      eyeshine(pix, 7, 11);
      pix.outline();
    },
  },

  {
    // Bird. A perched songbird: round front, a beak, and a long tail cocked
    // down and back, clear of the twig — that overhang is the difference
    // between a bird and a lump.
    name: 'life-bird',
    draw(pix) {
      // Twig.
      pix.line(6, 25, 24, 24, 'ink2');
      pix.line(6, 26, 24, 25, 'ink2');
      pix.line(19, 25, 22, 27, 'ink2');

      // Tail, angled down and away.
      pix.poly([[17, 14], [26, 17], [26, 21], [17, 19]], 'ink2');

      // Body: deep chest forward, back sloping to the tail.
      pix.disc(13, 16, 5.4, 5, 'ink2');
      pix.poly([[9, 13], [18, 15], [19, 20], [10, 21]], 'ink2');

      // Wing, folded.
      pix.poly([[11, 14], [18, 16], [16, 20], [11, 19]], 'ink2');

      // Head and beak.
      pix.disc(9, 11, 3.6, 3.4, 'ink2');
      pix.poly([[3, 12], [7, 10], [7, 13]], 'ink2');

      // Legs down to the twig.
      pix.rect(11, 20, 1, 5, 'ink2');
      pix.rect(14, 20, 1, 5, 'ink2');

      cutout(pix);
      eyeshine(pix, 9, 10);
      pix.outline();
    },
  },

  {
    // Moth. Head-on, because a moth at the lantern is a shape pressed flat.
    // Drawn as a left half and mirrored — the only symmetric animal here. The
    // straight swept leading edge and the fat abdomen below the hindwings are
    // what keep it from being a butterfly.
    name: 'life-moth',
    draw(pix) {
      // Forewing: one long straight leading edge, swept back.
      pix.poly([[15, 10], [4, 6], [4, 13], [15, 17]], 'ink2');
      // Hindwing: smaller, rounder, tucked under.
      pix.poly([[15, 16], [7, 19], [10, 24], [15, 22]], 'ink2');

      // Furry thorax over a tapering abdomen that clears the wings.
      pix.poly([[13, 9], [16, 9], [16, 26], [14, 26]], 'ink2');
      pix.disc(15, 10, 2.6, 2.4, 'ink2');

      // Feathered antenna: one hair with three barbs, thin enough that it
      // cannot be mistaken for an ear.
      pix.line(14, 8, 7, 4, 'ink2');
      pix.set(12, 5, 'ink2');
      pix.set(9, 3, 'ink2');
      pix.set(6, 3, 'ink2');

      pix.mirrorX();

      cutout(pix);
      // Two wing bars, in the rim value, inboard of every edge.
      pix.line(12, 12, 7, 10, 'ink3');
      pix.line(19, 12, 24, 10, 'ink3');
      pix.line(13, 19, 10, 20, 'ink3');
      pix.line(18, 19, 21, 20, 'ink3');

      eyeshine(pix, 13, 10, false);
      eyeshine(pix, 18, 10, false);
      pix.outline();
    },
  },

  {
    // Fish. A deep body, a tail with a real fork bitten out of it, and one fin
    // above and one below so it can never be read upside down.
    name: 'life-fish',
    draw(pix) {
      // Tail, then the notch that makes it a fork.
      pix.poly([[20, 17], [27, 10], [27, 24]], 'ink2');
      pix.poly([[28, 14], [22, 17], [28, 20]], 'none');

      // Body.
      pix.disc(15, 17, 7.4, 5.4, 'ink2');
      pix.poly([[6, 17], [13, 12], [13, 22]], 'ink2');

      // Dorsal fin up, anal fin down, pectoral tucked behind the gill.
      pix.poly([[12, 12], [16, 6], [20, 13]], 'ink2');
      pix.poly([[13, 21], [16, 25], [19, 22]], 'ink2');
      pix.poly([[11, 18], [15, 22], [10, 22]], 'ink2');

      // Mouth: a slit bitten out of the snout.
      pix.set(6, 17, 'none');
      pix.set(7, 17, 'none');

      cutout(pix);
      // Gill plate.
      pix.line(11, 14, 10, 20, 'ink3');

      eyeshine(pix, 9, 15);
      pix.outline();
    },
  },

  /* ------------------------------------------------------------------------ */
  /* Traces — dents and leftovers, lit and material                            */
  /* ------------------------------------------------------------------------ */

  {
    // Prints in duff. One paw large and one behind it, offset the way a walking
    // animal lands. The ink is the hole, the strip of duff left between the
    // toes and the heel pad is what makes it a paw rather than a crater, and
    // the wood4 crescent below each is the far wall catching the fire.
    name: 'trace-prints',
    draw(pix) {
      duff(pix, 16, 16, 11, 10);
      pawprint(pix, 12, 12, 1, 'ink');
      pawprint(pix, 20, 20, 0.8, 'ink');
      litRim(pix, ['ink'], ['wood1', 'wood2', 'wood3'], 'wood4');
      pix.outline();
    },
  },

  {
    // A dropped feather, stood almost upright. Built rib by rib out from the
    // shaft, with the barbs parted in three places on each side — that split
    // vane is the whole difference between a feather and a leaf.
    name: 'trace-feather',
    draw(pix) {
      const shaftAt = (y) => 15 + Math.round((y - 6) * 0.22);
      // Half-width of the vane at each row: nothing at the tip, full through
      // the middle, closing again above the bare quill.
      const halfAt = (y) => {
        if (y < 6) return -1;
        if (y < 12) return Math.round((y - 5) * 0.9);
        if (y <= 19) return 6;
        if (y <= 23) return 6 - (y - 19) * 1.5;
        return -1;
      };
      const splitLeft = [10, 15, 20];
      const splitRight = [12, 17, 21];

      for (let y = 6; y <= 23; y++) {
        const cx = shaftAt(y);
        const half = Math.round(halfAt(y));
        for (let j = -half; j <= half; j++) {
          // A barb parting: the outer two-thirds of that rib is missing.
          if (j < 0 && splitLeft.includes(y) && j < -half + 4) continue;
          if (j > 0 && splitRight.includes(y) && j > half - 4) continue;
          pix.set(cx + j, y, j < 0 ? 'cream3' : 'cream2');
        }
        if (half >= 2) {
          pix.set(cx - half, y, 'cream4');
          pix.set(cx + half, y, 'cream1');
        }
        // The rachis.
        pix.set(cx, y, y < 9 ? 'cream3' : 'cream1');
      }

      // Bare quill below the vane, and a little down clinging to it.
      pix.line(20, 24, 21, 27, 'cream2');
      pix.set(20, 24, 'cream3');
      pix.set(21, 27, 'cream1');
      pix.set(18, 23, 'cream3');
      pix.set(22, 23, 'cream2');

      pix.outline();
    },
  },

  {
    // Scat. Three tapered pellets, dropped on moss rather than on duff — the
    // chocolate ramp and the wood ramp sit at almost the same value, so brown
    // on brown was one mound, and the green is what makes them three objects.
    name: 'trace-scat',
    draw(pix) {
      // Moss cushion.
      pix.disc(16, 19, 11, 8, 'green2');
      pix.disc(12, 16, 6, 4, 'green3');
      pix.disc(21, 21, 5, 3.5, 'green2');
      ditherIn(pix, 5, 11, 23, 17, 'green3', 0, ['green2']);
      ditherIn(pix, 5, 19, 23, 9, 'green1', 1, ['green2']);
      ditherIn(pix, 6, 12, 12, 8, 'green4', 0, ['green3']);
      pix.line(7, 22, 10, 20, 'green1');
      pix.line(23, 15, 25, 17, 'green1');

      /**
       * One pellet: a lozenge with a point at each end. The taper is the whole
       * job — an oval this size is a berry and a circle is a stone.
       */
      const pellet = (cx, cy, tilt) => {
        const pts = [
          [cx - 5, cy - tilt],
          [cx - 2, cy - 2],
          [cx + 2, cy - 2 + tilt],
          [cx + 5, cy + tilt],
          [cx + 2, cy + 2 + tilt],
          [cx - 2, cy + 2],
        ];
        // Bedded in: a hard shadow directly under it and nowhere else, so the
        // pellets stay three objects instead of one mound.
        pix.poly(pts.map(([x, y]) => [x, y + 2]), 'ink');
        pix.poly(pts, 'choc2');
        pix.line(cx - 2, cy - 2, cx + 1, cy - 2, 'choc3');
        pix.set(cx - 3, cy - 1, 'choc3');
        pix.line(cx - 1, cy + 2, cx + 2, cy + 2, 'choc1');
        pix.set(cx + 4, cy + tilt, 'choc1');
      };

      pellet(10, 21, 0);
      pellet(21, 22, 0);
      pellet(16, 15, 1);

      pix.outline();
    },
  },

  {
    // A cone a squirrel has been at. Cone first: a teardrop, heavy at the base
    // and pointed at the top, in courses of overlapping scales. Then the story:
    // one flank gnawed back to the bare core, a short stripped tip, and the
    // cuttings dropped in a ring where it sat.
    name: 'trace-cone',
    draw(pix) {
      // Teardrop body.
      pix.disc(16, 20, 5.6, 6.4, 'wood2');
      pix.poly([[16, 8], [21, 21], [11, 21]], 'wood2');

      // Courses of scales: a dark seam, a lit lip below it, and vertical splits
      // offset row to row so they overlap like real scales.
      const scaled = ['wood2', 'wood3'];
      for (const [ry, phase] of [
        [11, 0],
        [14, 1],
        [17, 0],
        [20, 1],
        [23, 0],
      ]) {
        for (let x = 9; x <= 23; x++) {
          over(pix, x, ry, 'wood1', scaled);
          over(pix, x, ry + 1, 'wood3', ['wood2']);
        }
        for (let x = 10 + phase * 2; x <= 23; x += 4) {
          for (let d = 1; d <= 2; d++) over(pix, x, ry + d, 'wood1', scaled);
        }
      }
      ditherIn(pix, 17, 20, 6, 7, 'wood1', 1, ['wood2', 'wood3']);

      // Stripped tip: the bare core, three pixels wide, with the stubble of cut
      // scales still on it.
      pix.rect(15, 5, 3, 6, 'wood2');
      pix.line(15, 5, 15, 10, 'wood3');
      pix.line(17, 6, 17, 10, 'wood1');
      pix.set(14, 7, 'wood1');
      pix.set(18, 8, 'wood1');
      pix.set(14, 9, 'wood1');

      // Gnawed flank: scales taken off the lower left, down to smooth core.
      pix.poly([[11, 19], [15, 21], [14, 26], [11, 25]], 'wood2');
      pix.line(11, 19, 14, 21, 'wood1');
      pix.line(11, 20, 11, 25, 'wood3');
      ditherIn(pix, 12, 22, 4, 4, 'wood1', 0, ['wood2']);

      // Cuttings, dropped where it sat.
      pix.rect(5, 24, 3, 2, 'wood3');
      pix.set(5, 24, 'wood4');
      pix.rect(24, 23, 3, 2, 'wood3');
      pix.set(24, 23, 'wood4');
      pix.rect(7, 21, 2, 2, 'wood3');
      pix.rect(22, 26, 2, 2, 'wood3');

      pix.outline();
    },
  },

  {
    // Claw scratches on bark. Four gouges, fanned the way a paw fans, cutting
    // through the grain to the pale wood underneath. The bark is kept dark and
    // low-contrast on purpose: it is a backdrop, and the four bright cuts are
    // the only thing here that is supposed to be seen.
    name: 'trace-scratch',
    draw(pix) {
      // Slab of bark with a broken edge top and bottom.
      pix.rect(7, 5, 17, 22, 'wood1');
      pix.disc(15, 5, 8.5, 2, 'wood1');
      pix.disc(15, 26, 8.5, 2, 'wood1');
      pix.set(7, 5, 'none');
      pix.set(23, 5, 'none');
      pix.set(7, 26, 'none');
      pix.set(23, 26, 'none');

      // Grain: raised ridges, lit on their left, and a little dither between.
      for (let x = 8; x <= 22; x += 4) {
        for (let y = 3; y <= 28; y++) {
          over(pix, x, y, 'wood2', ['wood1']);
          over(pix, x + 1, y, 'wood2', ['wood1']);
        }
      }
      ditherIn(pix, 6, 3, 20, 26, 'wood1', 1, ['wood2']);

      // The gouges. Dark lip on the upper-left, open wood below it.
      const claws = [
        [8, 9, 14, 22],
        [11, 7, 18, 21],
        [15, 6, 21, 19],
        [19, 7, 24, 17],
      ];
      for (const [x0, y0, x1, y1] of claws) {
        pix.line(x0 - 1, y0, x1 - 1, y1, 'ink2');
        pix.line(x0, y0, x1, y1, 'cream3');
        pix.line(x0 + 1, y0, x1 + 1, y1, 'wood4');
      }
      // Splintered ends where the claw left the bark.
      for (const [, , x1, y1] of claws) {
        over(pix, x1 + 2, y1 + 1, 'wood3', ['wood1', 'wood2']);
      }

      pix.outline();
    },
  },

  {
    // A hand pressed into cold ash. The ash is the pale field and the hand is
    // the absence of it, which is why this one is inverted from every other
    // trace and is the only trace built out of ink.
    name: 'trace-ash',
    draw(pix) {
      // Drift of ash, lobed rather than round so it reads as a spill.
      pix.disc(16, 17, 11, 10, 'stone3');
      pix.disc(11, 12, 6, 5, 'stone3');
      pix.disc(22, 22, 5, 4, 'stone3');
      ditherIn(pix, 4, 4, 24, 24, 'stone4', 0, ['stone3']);
      ditherIn(pix, 4, 17, 24, 11, 'stone2', 1, ['stone3']);
      ditherIn(pix, 5, 5, 10, 10, 'stone4', 1, ['stone4', 'stone3']);

      // Palm.
      pix.disc(16, 20, 4.6, 4, 'ink2');
      pix.rect(12, 17, 9, 5, 'ink2');

      // Four fingers, splayed, and a thumb swung out to the left.
      pix.rect(12, 12, 2, 6, 'ink2');
      pix.rect(15, 10, 2, 8, 'ink2');
      pix.rect(18, 11, 2, 7, 'ink2');
      pix.rect(21, 14, 2, 5, 'ink2');
      pix.poly([[12, 18], [9, 14], [7, 16], [11, 21]], 'ink2');
      // Round the fingertips off.
      pix.set(12, 12, 'ink3');
      pix.set(15, 10, 'ink3');
      pix.set(18, 11, 'ink3');
      pix.set(21, 14, 'ink3');
      pix.set(7, 15, 'none');

      // Ash pushed up on the far side of the print.
      litRim(pix, ['ink2', 'ink3'], ['stone2', 'stone3'], 'stone4');
      pix.outline();
    },
  },
];
