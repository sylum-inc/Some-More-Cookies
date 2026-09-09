/**
 * Prints the font and looks at it.
 *
 * A font you have not looked at is a font that does not work. Every other
 * property of `apps/web/src/render/bitmapFont.ts` — cell size, coverage,
 * distinctness, wrapping — is checked by `apps/web/test/bitmapFont.test.ts`,
 * and none of those checks can tell you that the lowercase `e` has filled in
 * or that `rn` reads as `m`. Only a specimen sheet can, and only if somebody
 * opens it.
 *
 * The sheet is 320 pixels wide on purpose. That is the width of the buffer the
 * overlays are moving into, so a line that runs off the right-hand edge here
 * runs off the passport too, and the character counts printed on it are the
 * real ones rather than an estimate.
 *
 *   node tools/font/proof.mjs            # sheet + terminal chart
 *   node tools/font/proof.mjs --chart    # terminal chart only, for iterating
 *
 * Node reads the TypeScript module directly (type stripping, Node >= 22.18),
 * so there is no build step between editing a glyph and seeing it. The glyph
 * table is the source of truth for both the game and this sheet; a proof that
 * rasterises a copy of the data proves nothing.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pix, encodePng } from '../sprites/canvas.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');

const font = await import(join(ROOT, 'apps/web/src/render/bitmapFont.ts'));
const {
  GLYPHS,
  CELL_WIDTH,
  CELL_HEIGHT,
  SUPPORTED_CHARACTERS,
  blitText,
  measureText,
  wrapText,
  glyphFor,
} = font;

/** The buffer the overlays are moving into (ADR-0003, `QUALITY.mid`). */
const SHEET_WIDTH = 320;

/**
 * The game's own prose, copied out of the shipped manifests.
 *
 * Not lorem ipsum and not a font-vendor paragraph: this is what the passport
 * will actually be full of, em dashes and all, and it is the only sample that
 * can tell you whether the font can carry this writing.
 */
const PANGRAM = 'Sphinx of black quartz, judge my vow.';
/* Short enough to fit the 320px sheet at 3x, so nothing runs off the edge. */
const SHORT = ['Sphinx of black quartz,', 'judge my vow', 'hamburgefonstiv'];
const PROSE =
  'The creek — not water exactly, more a steady sheet of white noise that you ' +
  'mistake for wind until you notice it never changes. The trees open into a bowl ' +
  'maybe fifteen metres across; the fire ring is already going low and orange, and ' +
  'the SM-01 stands at the edge of the light with its idle lamp on.';
const FIGURES = 'Site 14 · 0123456789 · (47/113) · 90% & #4';

/* -------------------------------------------------------------------------- */

/** Ink on paper, or paper on ink, as one pair of palette keys. */
const PAPER = { ground: 'cream4', ink: 'ink', shadow: 'cream2' };
const PLATE = { ground: 'ink2', ink: 'cream4', shadow: 'ink' };

function say(pix, x, y, text, style, skin = PAPER) {
  return blitText(
    (px, py, layer) => pix.set(px, py, layer === 'shadow' ? skin.shadow : skin.ink),
    x,
    y,
    text,
    style,
  );
}

/** A caption in the sheet's own voice, so each block says what it is proving. */
function caption(pix, x, y, text) {
  say(pix, x, y, text, { scale: 1, proportional: true }, PAPER);
  return y + CELL_HEIGHT + 3;
}

function rule(pix, y) {
  pix.dither(8, y, SHEET_WIDTH - 16, 1, 'cream1');
  return y + 4;
}

/**
 * Draws the whole sheet and returns the height it used.
 *
 * Run once against a one-row buffer to find the height (`Pix.set` ignores
 * anything out of bounds), then again against a buffer of exactly that size.
 * Cheaper than keeping a layout constant in agreement with the layout.
 */
function drawSheet(pix) {
  const margin = 8;
  let y = 6;

  say(pix, margin, y, 'SOME MORE — 5x9 BITMAP FONT', { scale: 1 });
  y += CELL_HEIGHT + 2;
  y = caption(pix, margin, y, `${SUPPORTED_CHARACTERS.length} glyphs · cap 7 · x-height 5 · descent 2`);
  y = rule(pix, y);

  // The whole character set, in authoring order, at reading size. Anything
  // that is not a letter here is a glyph that needs redrawing.
  const all = SUPPORTED_CHARACTERS.join('');
  for (const line of chunk(all, 46)) {
    say(pix, margin, y, line, { scale: 1 });
    y += CELL_HEIGHT + 1;
  }
  y += 3;
  y = rule(pix, y);

  y = caption(pix, margin, y, 'THE SAME WORDS AT 1x, 2x AND 3x');
  say(pix, margin, y, PANGRAM, { scale: 1 });
  y += CELL_HEIGHT + 2;
  for (const scale of [2, 3]) {
    const metrics = say(pix, margin, y, SHORT[scale - 2], { scale });
    y += metrics.height + 2;
  }
  y = rule(pix, y);

  y = caption(pix, margin, y, 'FIGURES AND PUNCTUATION');
  y += say(pix, margin, y, FIGURES, { scale: 1 }).height + 2;
  y += say(pix, margin, y, 'Time 9:38; 3 of 47.', { scale: 2 }).height + 2;
  y = rule(pix, y);

  // Prose, wrapped to the panel width the passport will really have: the
  // sheet less its margins, which is where the line breaks will really fall.
  const measure = SHEET_WIDTH - margin * 2;
  y = caption(pix, margin, y, `PROSE, MONOSPACED, WRAPPED TO ${measure}px`);
  for (const line of wrapText(PROSE, measure, { scale: 1 })) {
    say(pix, margin, y, line, { scale: 1 });
    y += CELL_HEIGHT + 1;
  }
  y += 3;

  y = caption(pix, margin, y, 'THE SAME, PACKED TO ITS INK');
  for (const line of wrapText(PROSE, measure, { scale: 1, proportional: true })) {
    say(pix, margin, y, line, { scale: 1, proportional: true });
    y += CELL_HEIGHT + 1;
  }
  y += 3;
  y = rule(pix, y);

  // Reversed out on a dark plate, which is where a drop shadow earns its keep
  // and where cream-on-ink either separates or does not.
  y = caption(pix, margin, y, 'REVERSED, WITH A ONE-PIXEL SHADOW');
  const plateLines = wrapText(PROSE, measure - 12, { scale: 1, proportional: true });
  const plateHeight = plateLines.length * (CELL_HEIGHT + 1) + 11;
  pix.rect(margin - 2, y - 2, SHEET_WIDTH - (margin - 2) * 2, plateHeight, PLATE.ground);
  let py = y + 4;
  for (const line of plateLines) {
    say(pix, margin + 4, py, line, { scale: 1, proportional: true, shadow: true }, PLATE);
    py += CELL_HEIGHT + 1;
  }
  y += plateHeight + 4;

  return y;
}

function chunk(text, size) {
  const out = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

/** Nearest-neighbour, because looking at a font through a smoothed zoom is looking at a lie. */
function magnify(pix, factor) {
  const big = new Pix(pix.width * factor, pix.height * factor);
  for (let y = 0; y < pix.height; y++) {
    for (let x = 0; x < pix.width; x++) {
      const key = pix.get(x, y);
      if (key !== 'none') big.rect(x * factor, y * factor, factor, factor, key);
    }
  }
  return big;
}

/* -------------------------------------------------------------------------- */

/** Every glyph as text, next to its character, for reading in a terminal. */
function terminalChart() {
  const out = [];
  const columns = 8;
  const names = SUPPORTED_CHARACTERS;
  for (let i = 0; i < names.length; i += columns) {
    const group = names.slice(i, i + columns);
    out.push(group.map((c) => ` ${c}   `.padEnd(CELL_WIDTH + 3)).join(''));
    for (let row = 0; row < CELL_HEIGHT; row++) {
      out.push(
        group
          .map((c) => {
            const line = glyphFor(c).rows[row].replace(/#/g, '█').replace(/\./g, '·');
            return `${line}   `;
          })
          .join(''),
      );
    }
    out.push('');
  }
  return out.join('\n');
}

const chartOnly = process.argv.includes('--chart');
// eslint-disable-next-line no-console
console.log(terminalChart());
// eslint-disable-next-line no-console
console.log(
  [
    `glyphs        ${SUPPORTED_CHARACTERS.length}`,
    `cell          ${CELL_WIDTH}x${CELL_HEIGHT}`,
    `1x line       ${measureText('x', { scale: 1 }).lineHeight}px, ` +
      `${Math.floor((SHEET_WIDTH - 16) / (CELL_WIDTH + 1))} characters across 304px`,
    `2x line       ${measureText('x', { scale: 2 }).lineHeight}px, ` +
      `${Math.floor((SHEET_WIDTH - 16) / ((CELL_WIDTH + 1) * 2))} characters across 304px`,
    `prose 1x      ${wrapText(PROSE, 304, { scale: 1 }).length} lines monospaced, ` +
      `${wrapText(PROSE, 304, { scale: 1, proportional: true }).length} lines packed`,
  ].join('\n'),
);

if (!chartOnly) {
  const probe = new Pix(SHEET_WIDTH, 1);
  const height = drawSheet(probe);
  const sheet = new Pix(SHEET_WIDTH, height);
  sheet.rect(0, 0, sheet.width, sheet.height, PAPER.ground);
  drawSheet(sheet);

  const out = join(ROOT, 'artifacts', 'font');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'specimen.png'), encodePng(sheet));
  writeFileSync(join(out, 'specimen-4x.png'), encodePng(magnify(sheet, 4)));
  // eslint-disable-next-line no-console
  console.log(`\nwrote artifacts/font/specimen.png (${sheet.width}x${sheet.height}) and specimen-4x.png`);
}
