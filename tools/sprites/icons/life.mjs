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
 * `accent` appears in this file in one place only — the eyeshine, on each of
 * the eight animals. Nothing else in the family may use it, because the whole
 * point of the sighting cue is that your eye goes to the eyes.
 *
 * Two hard-won rules about the silhouettes.
 *
 * First, negative space has to be at least three pixels wide. `outline()`
 * floods every transparent pixel within one of the art, so a two-pixel gap
 * between two legs is not a gap, it is a slab — which is why these animals
 * have two clear legs rather than four smeared ones.
 *
 * Second, and it is the opposite mistake: two masses that belong to one animal
 * must actually overlap. A tail held clear of the back at every point is not a
 * tail, it is a second object standing next to the first one, and the flat
 * silhouette has no way to say which. So a squirrel's plume bites into its
 * haunch and parts from the head exactly once, high up, where a single notch
 * can be read. One notch in the right place beats an outline of daylight.
 *
 * The same rule, inverted, is why `outline()` is not enough on its own: a
 * feature drawn *inside* a mass — a folded wing, a gnawed flank — produces no
 * silhouette at all. If it matters, it has to be bitten out of the edge.
 */

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `dither()` that respects a silhouette — only recolours pixels already drawn,
 * so ground texture never leaks past the edge of a patch.
 */
function ditherIn(pix, x, y, w, h, key, phase = 0, onlyOver = null) {
  for (let dy = 0; dy < h; dy++) {
    for (let dx = 0; dx < w; dx++) {
      if ((x + dx + y + dy + phase) % 2 !== 0) continue;
      const current = pix.get(x + dx, y + dy);
      if (current === 'none') continue;
      if (onlyOver && !onlyOver.includes(current)) continue;
      pix.set(x + dx, y + dy, key);
    }
  }
}

/** One pixel, but only where the material underneath is one we meant to paint. */
function over(pix, x, y, key, allowed) {
  if (allowed.includes(pix.get(x, y))) pix.set(x, y, key);
}

/** A line, but only where the material underneath is one we meant to paint. */
function lineOver(pix, x0, y0, x1, y1, key, allowed) {
  const steps = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    over(pix, Math.round(x0 + (x1 - x0) * t), Math.round(y0 + (y1 - y0) * t), key, allowed);
  }
}

/**
 * A two-pixel-thick polyline.
 *
 * A one-pixel curve is not a tail or a claw at this size, it is a hair, and
 * `outline()` doubles it into a smear anyway. Two pixels of body with the ink
 * around it is the thinnest thing in this file that still reads as a thing.
 */
function stroke2(pix, points, key) {
  for (let i = 0; i + 1 < points.length; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const steps = Math.max(Math.abs(bx - ax), Math.abs(by - ay)) * 2 + 1;
    for (let s = 0; s <= steps; s++) {
      const x = Math.round(ax + ((bx - ax) * s) / steps);
      const y = Math.round(ay + ((by - ay) * s) / steps);
      pix.rect(x, y, 2, 2, key);
    }
  }
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
 *
 * Note what this cannot do: it only sees edges. Anything drawn in the middle
 * of the mass is invisible, so wings and flanks are cut out of the outline
 * rather than drawn on top of it.
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

/** The one accent in this family: firelight in an eye. */
function eyeshine(pix, x, y, horizontal = true) {
  pix.set(x, y, 'accent');
  if (horizontal === null) return;
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

/**
 * Chews the edge of a patch.
 *
 * A ground patch drawn out of discs is a disc, and a brown disc with dark
 * marks in it is a biscuit. Removing the first drawn pixel on selected rows
 * and columns turns the rim into something ragged that nothing in a kitchen
 * has.
 */
function ragged(pix, x0, y0, x1, y1, step, phase = 0) {
  for (let y = y0; y <= y1; y++) {
    if ((y + phase) % step !== 0) continue;
    for (let x = x0; x <= x1; x++) {
      if (pix.get(x, y) === 'none') continue;
      pix.set(x, y, 'none');
      if (pix.get(x + 1, y) !== 'none' && (y + phase) % (step * 2) === 0) pix.set(x + 1, y, 'none');
      break;
    }
    for (let x = x1; x >= x0; x--) {
      if (pix.get(x, y) === 'none') continue;
      pix.set(x, y, 'none');
      if (pix.get(x - 1, y) !== 'none' && (y + phase) % (step * 2) === 1) pix.set(x - 1, y, 'none');
      break;
    }
  }
}

/** A patch of forest floor: duff, its texture, and a couple of fallen needles. */
function duff(pix) {
  // Lobed and lopsided, never round. A brown disc with dark marks in it is a
  // biscuit, and this family cannot afford that joke by accident.
  pix.disc(13, 13, 9.4, 8, 'wood2');
  pix.disc(20, 21, 7.5, 6, 'wood2');
  pix.disc(9, 21, 5.4, 5, 'wood2');
  pix.disc(20, 12, 6, 5, 'wood2');
  pix.disc(11, 10, 6, 4.5, 'wood3');
  pix.disc(21, 19, 4, 3, 'wood3');
  ditherIn(pix, 3, 4, 26, 24, 'wood1', 1, ['wood2']);
  ditherIn(pix, 3, 4, 26, 24, 'wood2', 0, ['wood3']);
  ragged(pix, 3, 4, 28, 27, 4, 0);
  ragged(pix, 3, 4, 28, 27, 6, 3);
  pix.line(5, 24, 9, 22, 'green2');
  pix.line(20, 6, 24, 8, 'green3');
  pix.set(26, 17, 'green2');
}

/**
 * One paw print: a heel pad and four toes, pressed pointing up.
 *
 * The toes are an arc rather than a row and the pad hangs four clear pixels
 * below them. That gap is the paw — close it and the print is a crater — and
 * needing it at this size is the reason there is one big print here rather
 * than the two small ones that used to merge into a pair of blobs.
 */
function pawprint(pix, cx, cy, s, key) {
  pix.disc(cx, cy + 8 * s, 4.2 * s, 2.8 * s, key);
  pix.disc(cx - 6.6 * s, cy - 1.4 * s, 2.0 * s, 2.3 * s, key);
  pix.disc(cx - 2.3 * s, cy - 4.2 * s, 2.0 * s, 2.3 * s, key);
  pix.disc(cx + 2.3 * s, cy - 4.2 * s, 2.0 * s, 2.3 * s, key);
  pix.disc(cx + 6.6 * s, cy - 1.4 * s, 2.0 * s, 2.3 * s, key);
}

/* -------------------------------------------------------------------------- */
/* Sightings — flat cut-outs, seen side-on, lit only in the eye                */
/* -------------------------------------------------------------------------- */

export const SPRITES = [
  {
    // Fox. Read in order: the brush, which is a third of the animal, then the
    // long wedge of muzzle leaving the skull at eye level, then the wide-based
    // triangular ears. Ears half the height of the skull and a snout on the
    // same line as the eye — tall ears over a small round head is a cat, and
    // that is the misread this drawing exists to avoid.
    name: 'life-fox',
    draw(pix) {
      // Brush. Drawn first so the haunch overlaps its root: the tail has to be
      // part of the same mass as the animal or it is a separate object.
      pix.disc(21, 21.5, 3.4, 3.4, 'ink2');
      pix.disc(24.5, 21, 3.2, 3.2, 'ink2');
      pix.disc(25.5, 17.5, 2.4, 2.4, 'ink2');

      // Two legs, four pixels apart, and short: a fox stands low and long, and
      // long legs under a deep chest is a dog.
      pix.rect(11, 21, 3, 5, 'ink2');
      pix.rect(17, 21, 3, 5, 'ink2');
      pix.rect(10, 25, 4, 1, 'ink2');
      pix.rect(17, 25, 4, 1, 'ink2');

      // Body: level back, deep chest, heavy haunch, shallow overall.
      pix.poly([[10, 16], [19, 15], [20, 21], [11, 22]], 'ink2');
      pix.disc(18, 19, 3.4, 3.4, 'ink2');
      pix.disc(12, 19, 3.2, 3.2, 'ink2');

      // Head, and the muzzle leaving it along the eye line — long, thin and
      // level, which is the line a dog does not have.
      pix.disc(10, 13, 3.4, 3.2, 'ink2');
      pix.poly([[4, 15], [10, 11], [11, 16]], 'ink2');
      pix.set(5, 14, 'ink2');

      // Ears: wide at the base, short, with a V of daylight between them.
      pix.poly([[6, 13], [8, 6], [10, 13]], 'ink2');
      pix.poly([[11, 13], [13, 6], [15, 13]], 'ink2');

      cutout(pix);
      eyeshine(pix, 9, 12);
      pix.outline();
    },
  },

  {
    name: 'life-owl',
    draw(pix) {
      // Tail, hanging below the branch line so the bottom of the bird is not
      // just where the rectangle stopped.
      pix.poly([[14, 24], [19, 24], [18, 28], [15, 28]], 'ink2');

      // Barrel: wide at the shoulders, tapering to the vent.
      pix.disc(16, 14, 6.6, 5.2, 'ink2');
      pix.poly([[10, 11], [22, 11], [21, 19], [11, 19]], 'ink2');

      // Skull, clearly narrower than the chest — the step at the shoulder is
      // most of what says owl rather than cabinet.
      pix.disc(16, 9, 4.6, 4.4, 'ink2');

      // Ear tufts, asymmetric so it does not read as a cat.
      pix.poly([[11, 7], [10, 4], [15, 8]], 'ink2');
      pix.poly([[17, 8], [22, 4], [21, 8]], 'ink2');

      // Folded wing tips, bitten out of each flank. A wing painted on top of
      // the body is invisible in a cut-out: cutout() only rims what has night
      // next to it, so the wing has to be an edge or it is nothing.
      pix.poly([[6, 13], [12, 17], [6, 21]], 'none');
      pix.poly([[26, 13], [20, 17], [26, 21]], 'none');

      // Feet, five pixels apart, so a real window of night survives between
      // them and the bird is standing on something.
      pix.rect(11, 18, 3, 7, 'ink2');
      pix.rect(19, 18, 3, 7, 'ink2');
      // The branch, over the root of the tail.
      pix.rect(6, 25, 20, 2, 'ink2');

      cutout(pix);

      // A shallow notch of rim between the eyes reads as the beak.
      pix.set(16, 11, 'ink3');
      pix.set(16, 12, 'ink3');

      eyeshine(pix, 12, 9, false);
      eyeshine(pix, 19, 9, false);
      pix.outline();
    },
  },

  {
    name: 'life-deer',
    draw(pix) {
      // Legs: a foreleg and a hind leg, the hind one broken at the hock, which
      // is the joint that says deer and not dog.
      pix.rect(12, 19, 2, 8, 'ink2');
      pix.line(21, 19, 20, 22, 'ink2');
      pix.line(22, 19, 21, 22, 'ink2');
      pix.rect(20, 22, 2, 5, 'ink2');
      pix.rect(11, 26, 3, 1, 'ink2');
      pix.rect(19, 26, 3, 1, 'ink2');

      // Barrel body, short and set high on the legs.
      pix.poly([[11, 15], [22, 14], [23, 20], [12, 21]], 'ink2');
      pix.disc(21, 17, 3.4, 3.2, 'ink2');

      // Tail: a stub that actually leaves the rump, or it is invisible ink.
      pix.poly([[22, 15], [26, 13], [25, 17]], 'ink2');

      // Neck, rising steeply forward out of the shoulder.
      pix.poly([[9, 10], [13, 11], [14, 17], [10, 16]], 'ink2');

      // Head: a small wedge, muzzle low and forward, ear cupped behind.
      pix.poly([[4, 14], [10, 9], [12, 14], [6, 15]], 'ink2');
      pix.poly([[11, 11], [15, 10], [12, 15]], 'ink2');

      // Antler: root on the brow, fork at (13,8), one arm forward and up and
      // one sweeping back over the shoulder. The hole between the arms is the
      // whole point — a solid Y is a horn.
      pix.line(11, 11, 13, 8, 'ink2');
      pix.line(12, 11, 13, 8, 'ink2');
      pix.line(13, 8, 11, 4, 'ink2');
      pix.line(13, 8, 18, 5, 'ink2');
      pix.set(19, 4, 'ink2');
      pix.set(11, 5, 'ink2');

      cutout(pix);
      eyeshine(pix, 7, 12);
      pix.outline();
    },
  },

  {
    // Mouse. The ear is the entire read, so it is a disc the size of the skull
    // sitting on a one-pixel neck with daylight all around it. Bridge that gap
    // and the ear becomes a bump, the bump becomes the head, and the snout
    // becomes a beak: the animal turns into a duck.
    name: 'life-mouse',
    draw(pix) {
      // Tail: one continuous two-pixel curve, leaving the rump from inside the
      // silhouette and clearing the back by three.
      stroke2(pix, [[20, 21], [23, 22], [25, 20], [26, 17], [25, 14]], 'ink2');

      // Body, low and rounded, back humped over the hips.
      pix.disc(15, 19, 6, 4.4, 'ink2');
      pix.poly([[10, 17], [21, 16], [22, 22], [10, 22]], 'ink2');

      // Head running into a short blunt snout — long and thin would be a bill.
      pix.disc(10, 18, 3.6, 3.4, 'ink2');
      pix.poly([[4, 20], [10, 16], [11, 21]], 'ink2');

      // The ear. Oversized on purpose, and standing clear.
      pix.disc(12, 11, 3.2, 3.2, 'ink2');

      // Feet.
      pix.rect(11, 22, 3, 2, 'ink2');
      pix.rect(18, 22, 3, 2, 'ink2');

      cutout(pix);
      eyeshine(pix, 8, 17);
      pix.outline();
    },
  },

  {
    // Squirrel. Sitting up, which is a comma: narrow head and chest opening
    // into a heavy haunch. The plume overlaps the back rather than standing
    // beside it — the lower discs bite into the haunch so animal and tail are
    // one mass — and parts from the head exactly once, at the top, where three
    // pixels of night are enough to say tail.
    name: 'life-squirrel',
    draw(pix) {
      // The plume: it leaves the rump low, climbs the whole right side and
      // hooks forward at the top. If the tail is not the biggest thing in the
      // cell it is not a squirrel. The lowest disc bites deep into the haunch
      // on purpose — tail and animal are one mass, joined at the hip and
      // parted exactly once, up where a notch has room to be seen.
      for (const [x, y, r] of [
        [16, 24, 3.6],
        [20, 20, 4.0],
        [22, 15, 4.0],
        [21, 10, 3.6],
        [18, 7, 3.0],
      ]) {
        pix.disc(x, y, r, r, 'ink2');
      }

      // Haunch and chest: a comma. Narrow at the shoulder, heavy at the hip,
      // sitting back on its heels.
      pix.disc(12, 21, 4.4, 4.4, 'ink2');
      pix.poly([[8, 15], [13, 14], [15, 21], [9, 22]], 'ink2');

      // Forepaws held together against the chest.
      pix.poly([[5, 16], [8, 15], [9, 19], [5, 19]], 'ink2');

      // Head, carried well forward of the plume, with a small tufted ear.
      pix.disc(8, 13, 3.2, 3, 'ink2');
      pix.poly([[4, 15], [8, 11], [9, 16]], 'ink2');
      pix.poly([[8, 11], [9, 8], [11, 12]], 'ink2');

      // Feet.
      pix.rect(8, 25, 7, 2, 'ink2');

      cutout(pix);
      eyeshine(pix, 7, 12);
      pix.outline();
    },
  },

  {
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
      pix.poly([[4, 12], [7, 10], [7, 13]], 'ink2');

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
    // Drawn as a left half and mirrored — the only symmetric animal here.
    //
    // Everything here is aimed at one misread. Two glowing eyes over a wide
    // flat wing bar, with a pair of curled antennae above them, is a bat. So
    // the wings are one swept triangle wider than it is tall with a real point
    // at the leading tip, the abdomen runs out below the trailing edge where a
    // bat has nothing at all, and the eyeshine is a single pixel a side.
    name: 'life-moth',
    draw(pix) {
      // One wing pair, drawn as a left half and mirrored. The forewing has a
      // straight leading edge out to a real point; the hindwing hangs below
      // and behind it, and the step between the two is bitten into the
      // trailing edge rather than drawn inside the mass.
      pix.poly([[15, 9], [4, 13], [10, 18], [15, 15]], 'ink2');
      pix.poly([[14, 14], [8, 18], [12, 22], [15, 20]], 'ink2');
      pix.poly([[4, 16], [10, 18], [5, 20]], 'none');

      // Furry thorax, small head, and an abdomen that runs out well below the
      // wings — a bat has nothing at all down there, and that is the whole
      // argument this sprite is making.
      pix.poly([[14, 10], [17, 10], [16, 26], [15, 26]], 'ink2');
      pix.disc(15, 11, 2.4, 2.4, 'ink2');
      pix.disc(15, 8, 1.6, 1.4, 'ink2');

      // Antennae: long, thin, swept out and forward almost to the wing tips.
      // Two short stubs above the head are ears, and ears over a wingspan is
      // the bat this drawing keeps being mistaken for.
      pix.line(14, 7, 10, 5, 'ink2');
      pix.line(10, 5, 7, 6, 'ink2');

      pix.mirrorX();

      cutout(pix);
      // Wing bars, in the rim value, following the sweep of the leading edge.
      pix.line(12, 14, 7, 14, 'ink3');
      pix.line(19, 14, 24, 14, 'ink3');
      pix.line(12, 19, 10, 20, 'ink3');
      pix.line(19, 19, 21, 20, 'ink3');

      // One pixel of eyeshine a side. Four is a face, and a face here is a bat.
      eyeshine(pix, 14, 8, null);
      eyeshine(pix, 17, 8, null);
      pix.outline();
    },
  },

  {
    name: 'life-fish',
    draw(pix) {
      // Tail, then the notch that makes it a fork rather than two quills. The
      // bite stops short of the peduncle, so rows 16-18 stay joined.
      pix.poly([[20, 17], [27, 11], [27, 23]], 'ink2');
      pix.poly([[28, 15], [24, 17], [28, 19]], 'none');

      // Body.
      pix.disc(15, 17, 7, 5, 'ink2');
      pix.poly([[7, 16], [8, 20], [14, 22], [14, 12]], 'ink2');

      // Dorsal fin up, anal fin down, pectoral tucked behind the gill.
      pix.poly([[12, 13], [15, 9], [19, 13]], 'ink2');
      pix.poly([[14, 21], [16, 24], [18, 21]], 'ink2');
      pix.poly([[11, 19], [15, 22], [11, 22]], 'ink2');

      // Mouth: bitten out of the snout from the outside, so it opens to the
      // night and outline() draws a lip instead of filling it in.
      pix.poly([[5, 18], [10, 19], [5, 21]], 'none');

      cutout(pix);
      // Gill plate and the line of the jaw.
      pix.line(12, 14, 11, 20, 'ink3');
      pix.set(8, 17, 'ink3');
      pix.set(9, 17, 'ink3');

      eyeshine(pix, 9, 15);
      pix.outline();
    },
  },

  /* ------------------------------------------------------------------------ */
  /* Traces — dents and leftovers, lit and material                            */
  /* ------------------------------------------------------------------------ */

  {
    // Prints in duff. The ground is a lobed, chewed patch rather than a disc,
    // because a round brown thing with dark spots in it is a cookie and this
    // game is not going to make that joke by accident. One deep print and one
    // smaller one behind it, the way a walking animal lands, with three clear
    // pixels of duff between the toes and the heel pad and the wood4 crescent
    // below each print doing the work of a far wall catching the fire.
    // A print in duff. The ground is a lobed, chewed patch rather than a
    // disc, because a round brown thing with dark spots in it is a cookie and
    // this game is not going to make that joke by accident. One print, big
    // enough that the strip of duff between the toes and the heel pad is
    // three pixels wide and the paw reads as a paw — two smaller prints put
    // that gap at one pixel and both of them came out as blobs. The wood4
    // crescent below is the far wall of the dent catching the fire.
    name: 'trace-prints',
    draw(pix) {
      duff(pix);
      pawprint(pix, 15, 14, 0.9, 'ink');
      litRim(pix, ['ink'], ['wood1', 'wood2', 'wood3'], 'wood4');
      pix.outline();
    },
  },

  {
    name: 'trace-feather',
    draw(pix) {
      // A dropped feather, leaning hard. Built rib by rib out from the shaft,
      // with the barbs parted five times — and a parting has to break the
      // outline, not sit inside it. A split that closes again before it
      // reaches the edge is a hole punched in a leaf, which is exactly the
      // thing this drawing must not be.
      const shaftAt = (y) => 9 + (y - 4) * 0.55;
      // Half-width of the vane at each row: a point at the tip, full through
      // the middle, closing again above the bare quill. The trailing vane is
      // the wider one — a feather is not symmetric about its shaft.
      const halfAt = (y) => {
        if (y <= 9) return (y - 3) * 0.75;
        if (y <= 18) return 4.5;
        return 4.5 - (y - 18) * 1.1;
      };
      // Where the vane is parted, and how deep each parting cuts.
      const splitLeft = { 8: 3, 9: 4, 14: 4, 15: 5, 20: 3 };
      const splitRight = { 11: 4, 12: 5, 17: 4, 18: 3, 22: 2 };

      for (let y = 4; y <= 23; y++) {
        const cx = Math.round(shaftAt(y));
        const half = Math.max(0, Math.round(halfAt(y)));
        const left = half - (splitLeft[y] || 0);
        const right = Math.round(half * 1.25) - (splitRight[y] || 0);
        for (let j = -left; j <= right; j++) {
          pix.set(cx + j, y, j < 0 ? 'cream3' : 'cream2');
        }
        // Edge shading, but only on a row that still reaches its own edge —
        // written unconditionally it paints every parting shut again.
        if (left >= 2 && !splitLeft[y]) pix.set(cx - left, y, 'cream4');
        if (right >= 2 && !splitRight[y]) pix.set(cx + right, y, 'cream1');
        // The rachis, dark the whole way down so the vane reads as two vanes.
        pix.set(cx, y, y < 7 ? 'cream3' : 'cream1');
      }

      // Bare quill below the vane, and a little down clinging to it.
      pix.line(20, 24, 22, 27, 'cream2');
      pix.set(20, 24, 'cream3');
      pix.set(22, 27, 'cream1');
      pix.set(17, 23, 'cream3');
      pix.set(23, 22, 'cream2');

      pix.outline();
    },
  },

  {
    name: 'trace-scat',
    draw(pix) {
      // Moss cushion.
      pix.disc(16, 18, 11, 8.5, 'green2');
      pix.disc(12, 15, 6, 4, 'green3');
      pix.disc(21, 20, 5, 3.5, 'green2');
      ditherIn(pix, 5, 9, 23, 18, 'green3', 0, ['green2']);
      ditherIn(pix, 5, 18, 23, 10, 'green1', 1, ['green2']);
      ditherIn(pix, 6, 11, 12, 8, 'green4', 0, ['green3']);
      pix.line(6, 23, 9, 21, 'green1');
      pix.line(24, 13, 26, 15, 'green1');

      /**
       * One pellet: a short lozenge with a point at each end. The taper is the
       * whole job — an oval this size is a berry and a circle is a stone — and
       * the pellets are kept short so three of them fit with three pixels of
       * moss at every closest approach. Two that touch are one brown lump, and
       * one brown lump in a game called Some More Cookies is a biscuit.
       */
      const pellet = (cx, cy, tilt) => {
        const pts = [
          [cx - 4.5, cy - tilt],
          [cx - 1.5, cy - 1.7],
          [cx + 1.5, cy - 1.7 + tilt],
          [cx + 4.5, cy + tilt],
          [cx + 1.5, cy + 1.7 + tilt],
          [cx - 1.5, cy + 1.7],
        ];
        // Bedded in: a hard shadow down and to the right, agreeing with every
        // other shadow in the set, and nowhere else.
        pix.poly(pts.map(([x, y]) => [x + 1, y + 2]), 'ink');
        pix.poly(pts, 'choc2');
        pix.set(cx - 2, cy - 1, 'choc3');
        pix.set(cx - 1, cy - 1, 'choc3');
        pix.line(cx - 1, cy + 1, cx + 2, cy + 1 + tilt, 'choc1');
        pix.set(cx + 3, cy + tilt, 'choc1');
        // A fibre or a needle end poking out of the taper. Nothing edible has
        // this, and it is the cheapest way to say what this is.
        pix.set(cx - 5, cy - tilt, 'wood3');
        pix.set(cx + 5, cy + tilt, 'wood3');
      };

      pellet(9, 19, 0);
      pellet(21, 20, 0);
      pellet(16, 11, 1);

      pix.outline();
    },
  },

  {
    name: 'trace-cone',
    draw(pix) {
      // A fat teardrop: a rounded body with a real point on top and a short
      // stem at the BOTTOM, which is the one detail that stops a cone reading
      // as a bottle. An unpointed ellipse is an egg, and an egg with bands
      // around it is a beehive.
      pix.disc(16, 19, 6.8, 6, 'wood2');
      pix.disc(16, 13, 5, 4.6, 'wood2');
      pix.poly([[16, 6], [19, 13], [13, 13]], 'wood2');

      // Courses of scales, three rows each: a lit lip along the top of every
      // scale, the body of it, and the recess in shadow directly beneath the
      // overhang. That is what an overlapping scale does under a light from
      // the upper left — the old drawing had the pair the other way up and lit
      // the whole cone from below.
      const scaled = ['wood2', 'wood3', 'wood4'];
      for (let y = 8; y <= 26; y++) {
        const band = (y - 8) % 3;
        for (let x = 8; x <= 24; x++) {
          if (band === 0) over(pix, x, y, 'wood3', scaled);
          else if (band === 2) over(pix, x, y, 'wood1', scaled);
        }
      }
      // The splits between scales in a course, staggered course to course so
      // the scales overlap the way they do on the real thing.
      for (let y = 8; y <= 26; y += 3) {
        const phase = ((y - 8) / 3) % 2 ? 2 : 0;
        for (let x = 10 + phase; x <= 24; x += 4) {
          over(pix, x, y, 'wood1', scaled);
          over(pix, x, y + 1, 'wood1', scaled);
        }
      }
      ditherIn(pix, 11, 9, 6, 8, 'wood4', 0, ['wood3']);
      ditherIn(pix, 18, 18, 5, 8, 'wood1', 1, ['wood2']);

      // Scallop the profile a pixel at every lip row, so the edge is a stack
      // of scale tips rather than a smooth wobble — one pixel a course, since
      // chewing every row on both sides whittles the cone down to a spike.
      for (let y = 10; y <= 25; y += 3) {
        for (let x = 8; x <= 24; x++) {
          if (pix.get(x, y) === 'none') continue;
          pix.set(x, y, 'none');
          break;
        }
        for (let x = 24; x >= 8; x--) {
          if (pix.get(x, y) === 'none') continue;
          pix.set(x, y, 'none');
          break;
        }
      }
      pix.rect(15, 25, 2, 3, 'wood1');

      // The gnawed flank, taken out of the profile itself: the scales are gone
      // from the lower left and what is left is the bare core, narrower than
      // the cone and lit down its one exposed edge. Drawn inside the shape it
      // would be a smudge; bitten out of the edge it is a chewed cone.
      pix.poly([[8, 18], [13, 20], [12, 27], [8, 26]], 'none');
      pix.poly([[12, 19], [15, 21], [14, 26], [12, 25]], 'wood2');
      pix.line(12, 19, 12, 25, 'wood3');
      ditherIn(pix, 13, 21, 3, 5, 'wood1', 0, ['wood2']);

      // Cuttings, dropped where it sat.
      pix.rect(4, 21, 3, 2, 'wood3');
      pix.set(4, 21, 'wood4');
      pix.rect(25, 19, 3, 2, 'wood3');
      pix.set(25, 19, 'wood4');
      pix.rect(5, 17, 2, 2, 'wood3');
      pix.rect(23, 24, 2, 2, 'wood3');
      pix.rect(7, 26, 2, 2, 'wood3');

      pix.outline();
    },
  },

  {
    name: 'trace-scratch',
    draw(pix) {
      // A shard of bark off a trunk: torn at the top and bottom, no two edges
      // parallel, and nothing like the four clean corners that made this a
      // biscuit with grill marks.
      pix.poly([[9, 5], [19, 6], [23, 13], [22, 24], [13, 27], [7, 17]], 'wood1');
      for (const [x, y] of [[9, 5], [18, 6], [23, 13], [22, 24], [13, 27], [7, 17], [12, 5], [21, 25]]) {
        pix.set(x, y, 'none');
      }
      pix.set(15, 4, 'wood1');
      pix.set(8, 20, 'wood1');
      pix.set(23, 18, 'wood1');

      // Grain: ridges lit down their left edge, the grooves between them left
      // dark. Kept low-contrast on purpose — the bark is a backdrop and the
      // four cuts are the only thing here meant to be seen.
      for (let x = 8; x <= 22; x += 5) {
        for (let y = 3; y <= 28; y++) {
          over(pix, x, y, 'wood2', ['wood1']);
          over(pix, x + 1, y, 'wood2', ['wood1']);
          over(pix, x + 2, y, 'wood2', ['wood1']);
        }
      }
      for (const [x, y] of [[10, 12], [15, 20], [20, 10], [10, 22]]) {
        over(pix, x, y, 'wood1', ['wood2']);
        over(pix, x, y + 1, 'wood1', ['wood2']);
      }

      // The gouges: one swipe, four claws, raked up and across the vertical
      // grain. Cuts running the same way as the grain compete with it; cuts
      // that cross it are the only thing you see.
      const claws = [
        [7, 14, 20, 6],
        [7, 19, 22, 10],
        [8, 24, 22, 15],
        [12, 27, 22, 21],
      ];
      const bark = ['wood1', 'wood2', 'wood3'];
      for (const [x0, y0, x1, y1] of claws) {
        // A dark trough one pixel wide, clipped to the bark — a cut that runs
        // off the shard is not a cut, it is a speck floating in the night...
        lineOver(pix, x0, y0, x1, y1, 'ink2', bark);
        // ...with only its far wall lifted into the light. The floor stays
        // dark: a bright floor is a raised stripe, not a cut.
        lineOver(pix, x0, y0 + 1, x1, y1 + 1, 'wood4', bark);
      }
      // Three splinters where the claws left the bark, and nowhere else —
      // cream is the brightest value in this icon and it is not a floor.
      over(pix, 20, 6, 'cream3', bark);
      over(pix, 21, 10, 'cream3', bark);
      over(pix, 21, 15, 'cream3', bark);

      pix.outline();
    },
  },

  {
    name: 'trace-ash',
    draw(pix) {
      // Drift of ash, lobed rather than round so it reads as a spill.
      pix.disc(16, 17, 10.5, 9.5, 'stone3');
      pix.disc(10, 12, 6, 5, 'stone3');
      pix.disc(22, 22, 4.6, 4, 'stone3');
      ragged(pix, 4, 4, 28, 28, 4, 1);
      // Light from the upper left across the drift: stone4 only in the top
      // corner, stone2 through the lower right, stone3 doing the body of the
      // work. Dither everything and the field is static.
      ditherIn(pix, 4, 4, 14, 13, 'stone4', 0, ['stone3']);
      ditherIn(pix, 4, 18, 24, 11, 'stone2', 1, ['stone3']);
      ditherIn(pix, 17, 12, 12, 10, 'stone2', 0, ['stone3']);

      // Three toes splayed off one hub, and the hallux behind. Two pixels
      // thick on four-pixel centres at the hub, opening to six at the tips.
      stroke2(pix, [[15, 17], [8, 10]], 'ink2');
      stroke2(pix, [[15, 17], [15, 7]], 'ink2');
      stroke2(pix, [[15, 17], [23, 11]], 'ink2');
      stroke2(pix, [[15, 18], [17, 24]], 'ink2');
      pix.disc(15.5, 17.5, 2, 2, 'ink2');
      // Claw tips, one pixel past the end of each toe.
      pix.set(7, 9, 'ink3');
      pix.set(15, 6, 'ink3');
      pix.set(24, 10, 'ink3');
      pix.set(18, 25, 'ink3');

      // Ash pushed up on the far side of the print — the brightest thing in
      // the icon, and the only place stone4 appears outside the top corner.
      litRim(pix, ['ink2', 'ink3'], ['stone2', 'stone3'], 'stone4');
      pix.outline();
    },
  },
];
