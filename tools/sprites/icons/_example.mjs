/**
 * The reference sprite. Not packed — every other file in this folder should
 * look like this one.
 *
 * Read `../canvas.mjs` for the full drawing API. The short version:
 *
 *   pix.set(x, y, key)                 one pixel
 *   pix.rect(x, y, w, h, key)          filled rectangle
 *   pix.frame(x, y, w, h, key)         one-pixel outline rectangle
 *   pix.line(x0, y0, x1, y1, key)      Bresenham line
 *   pix.disc(cx, cy, rx, ry, key)      filled ellipse
 *   pix.ring(cx, cy, rx, ry, key)      ellipse outline
 *   pix.poly([[x,y], ...], key)        filled convex polygon
 *   pix.dither(x, y, w, h, key, phase) 50% checker, for in-palette gradients
 *   pix.outline(key = 'ink')           one-pixel outline around everything drawn
 *   pix.shadow(dx, dy, key)            offset copy underneath
 *   pix.mirrorX()                      mirror the left half onto the right
 *   pix.stamp(otherPix, x, y)          composite another buffer
 *
 * `key` is a palette name from `PALETTE` in `../canvas.mjs`. There are no other
 * colours: an unknown key throws. The ramps are ink/ember/wood/stone/steel/
 * cream/green/sky/choc, four steps each, darkest first, plus one `accent`.
 *
 * The rules, which are not style preferences:
 *
 * 1. The cell is 32x32 and the art lives inside a 24x24 box centred in it —
 *    so roughly x,y from 4 to 27. The margin is where `outline()` and
 *    `shadow()` go, and an icon drawn to the edge loses both.
 * 2. Call `pix.outline()` last, or near it. An icon without a hard outline
 *    disappears against a dithered forest floor. This is the single most
 *    important call in the file.
 * 3. Silhouette first. If the shape is not recognisable as a flat black
 *    cut-out, no amount of interior shading will save it. Test: squint.
 * 4. Four values maximum per material — outline, shadow, body, highlight —
 *    and use `dither()` rather than reaching for a fifth colour.
 * 5. Light comes from the upper left. Highlights top-left, shadow bottom-right.
 *    Every icon agreeing about this is most of what makes a set read as a set.
 * 6. No text, no letters, no numbers, ever. This game shows no numbers to a
 *    player and an icon with a "3" on it would be the whole rule broken.
 */

export const SPRITES = [
  {
    name: 'example-ember',
    draw(pix) {
      // Bed of coals: a squashed disc, darker at the edge, hot in the middle.
      pix.disc(16, 20, 9, 5, 'ember1');
      pix.disc(16, 20, 7, 4, 'ember2');
      pix.dither(9, 17, 14, 6, 'ember3');
      pix.disc(15, 19, 3, 2, 'ember3');
      pix.set(14, 18, 'ember4');
      pix.set(15, 18, 'ember4');

      // Two flames, asymmetric — a symmetric flame reads as a leaf.
      pix.poly([[14, 17], [16, 9], [18, 17]], 'ember3');
      pix.poly([[15, 16], [16, 12], [17, 16]], 'ember4');
      pix.poly([[19, 18], [21, 13], [22, 18]], 'ember2');

      pix.outline();
    },
  },
];
