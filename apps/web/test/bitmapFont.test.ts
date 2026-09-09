import { describe, expect, it } from 'vitest';
import {
  BASELINE_ROW,
  CELL_HEIGHT,
  CELL_WIDTH,
  GLYPHS,
  SUPPORTED_CHARACTERS,
  X_ROW,
  blitText,
  glyphFor,
  hasGlyph,
  integerTextScale,
  measureText,
  wrapText,
  type PlotLayer,
  type TextStyle,
} from '../src/render/bitmapFont.js';

/**
 * A hand-authored font has its own characteristic bugs, and they are not the
 * bugs a renderer usually has.
 *
 * Nothing here throws at runtime. A glyph copied from the row above and left
 * unedited, a row with four columns instead of five, a letter drawn one row
 * high — every one of those produces a perfectly healthy frame with a subtly
 * wrong picture in it, and every one of them is invisible in review because
 * the reviewer is reading `'.###./#...#/...'` and seeing the letter they
 * expected. These are the checks that read the data instead.
 */

/** Every pixel a piece of text puts down, with the pass it was put down in. */
function plot(text: string, style: TextStyle = {}) {
  const marks: Array<{ x: number; y: number; layer: PlotLayer }> = [];
  const metrics = blitText((x, y, layer) => marks.push({ x, y, layer }), 0, 0, text, style);
  return { marks, metrics, ink: marks.filter((m) => m.layer === 'ink') };
}

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** The five that hang below the line, plus the punctuation that does. */
const DESCENDING = new Set(['g', 'j', 'p', 'q', 'y', ',', ';', '_']);
/** Lowercase whose ink starts at the x line — no ascender, no descender above it. */
const X_HEIGHT_ONLY = 'acemnorsuvwxz';
/** Lowercase that reaches the cap line. */
const ASCENDING = 'bdfhkl';

describe('the character set', () => {
  it('covers every printable ASCII character', () => {
    const missing: string[] = [];
    for (let code = 0x20; code <= 0x7e; code++) {
      const character = String.fromCharCode(code);
      if (!hasGlyph(character)) missing.push(`U+${code.toString(16).toUpperCase()} ${character}`);
    }
    expect(missing).toEqual([]);
  });

  it('covers the typographic marks the shipped writing actually uses', () => {
    /*
     * Counted out of `packages/content` and `apps/web/src/ui`: the em dash 325
     * times, the middle dot 19, the right single quote 22, the ellipsis 7. A
     * character with no glyph is a character that vanishes from a sentence,
     * and these are the ones the sentences have.
     */
    const used = ['—', '–', '‘', '’', '“', '”', '…', '·', '°'];
    expect(used.filter((character) => !hasGlyph(character))).toEqual([]);
  });

  it('draws something visible for a character nobody has drawn', () => {
    // Not a blank. A sentence that quietly loses a letter is reported as a
    // typo months later; a hollow box is reported as a missing glyph today.
    expect(hasGlyph('é')).toBe(false);
    expect(plot('é').ink.length).toBeGreaterThan(0);
  });
});

describe('every glyph is the same shape as every other one', () => {
  it('is exactly the declared cell, in every row of every glyph', () => {
    const ragged: string[] = [];
    for (const character of SUPPORTED_CHARACTERS) {
      const rows = glyphFor(character).rows;
      if (rows.length !== CELL_HEIGHT) ragged.push(`${character}: ${rows.length} rows`);
      rows.forEach((row, index) => {
        if (row.length !== CELL_WIDTH) ragged.push(`${character} row ${index}: ${row.length} columns`);
        if (!/^[#.]*$/.test(row)) ragged.push(`${character} row ${index}: ${row}`);
      });
    }
    // A cell one column short does not look like a broken letter. It looks
    // like every letter after it on the line has moved, which reads as the
    // whole panel shivering and gets diagnosed as a renderer bug.
    expect(ragged).toEqual([]);
  });

  it('compiles back to exactly what was authored', () => {
    for (const character of SUPPORTED_CHARACTERS) {
      expect(glyphFor(character).rows.join('/'), character).toBe(GLYPHS[character]);
    }
  });

  it('has ink in every glyph except the space', () => {
    const blank = SUPPORTED_CHARACTERS.filter((character) => glyphFor(character).inkLeft === -1);
    expect(blank).toEqual([' ']);
  });

  it('has no two characters drawn the same', () => {
    /*
     * The most valuable check in this file. Copy-and-paste is how a font of a
     * hundred glyphs gets written, and a glyph pasted and then not edited is
     * the characteristic bug: `E` and `F` differ by one row, `O` and `0` by
     * three pixels, `,` and `;` by one. None of those show up as an error and
     * all of them show up as a word that is spelled wrong on screen.
     */
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const character of SUPPORTED_CHARACTERS) {
      if (character === ' ') continue;
      const key = glyphFor(character).rows.join('/');
      const first = seen.get(key);
      if (first !== undefined) duplicates.push(`${first} and ${character} are the same drawing`);
      else seen.set(key, character);
    }
    expect(duplicates).toEqual([]);
  });
});

describe('everything sits on the same lines', () => {
  const rowsWithInk = (character: string): number[] => {
    const glyph = glyphFor(character);
    const rows: number[] = [];
    for (let y = 0; y < CELL_HEIGHT; y++) {
      for (let x = 0; x < CELL_WIDTH; x++) {
        if (glyph.bits[y * CELL_WIDTH + x] === 1) {
          rows.push(y);
          break;
        }
      }
    }
    return rows;
  };

  it('rests every letter and figure without a descender on the baseline', () => {
    // The failure this catches is one letter drawn a row high, which does not
    // read as a bad letter — it reads as text that is vibrating.
    const off: string[] = [];
    for (const character of LETTERS) {
      if (DESCENDING.has(character)) continue;
      const rows = rowsWithInk(character);
      const last = rows[rows.length - 1];
      if (last !== BASELINE_ROW) off.push(`${character} ends at row ${String(last)}`);
    }
    expect(off).toEqual([]);
  });

  it('hangs every descender below the baseline and nothing else', () => {
    const wrong: string[] = [];
    for (const character of SUPPORTED_CHARACTERS) {
      const below = rowsWithInk(character).some((row) => row > BASELINE_ROW);
      if (below !== DESCENDING.has(character)) {
        wrong.push(`${character} ${below ? 'descends and should not' : 'should descend and does not'}`);
      }
    }
    expect(wrong).toEqual([]);
  });

  it('starts lowercase at the x line and capitals at the cap line', () => {
    for (const character of X_HEIGHT_ONLY) {
      expect(rowsWithInk(character)[0], character).toBe(X_ROW);
    }
    for (const character of `${ASCENDING}ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789`) {
      expect(rowsWithInk(character)[0], character).toBe(0);
    }
    // `t` is the exception, on purpose and not by accident: it is one row
    // short of the ascenders, the way it is in every typeface, and a `t` as
    // tall as a `b` reads as a plus sign.
    expect(rowsWithInk('t')[0]).toBe(1);
  });
});

describe('measurement agrees with drawing', () => {
  it('puts every pixel inside the box it advertised', () => {
    const sample = 'Sphinx of black quartz,\njudge my vow — 47%';
    for (const style of [{}, { scale: 2 }, { tracking: 0 }, { proportional: true }, { shadow: true }]) {
      const { marks, metrics } = plot(sample, style);
      for (const mark of marks) {
        expect(mark.x, JSON.stringify(style)).toBeGreaterThanOrEqual(0);
        expect(mark.y).toBeGreaterThanOrEqual(0);
        expect(mark.x).toBeLessThan(metrics.width);
        expect(mark.y).toBeLessThan(metrics.height);
      }
    }
  });

  it('is tight against text that fills its box', () => {
    // `M` reaches both edges of the cell, `_` reaches the last row, so the
    // advertised box should be exactly the ink and not a pixel more.
    const { ink, metrics } = plot('MM_');
    expect(Math.max(...ink.map((m) => m.x)) + 1).toBe(metrics.width);
    expect(Math.max(...ink.map((m) => m.y)) + 1).toBe(metrics.height);
  });

  it('counts tracking between glyphs but never after the last one', () => {
    const one = measureText('M').width;
    const two = measureText('MM').width;
    expect(one).toBe(CELL_WIDTH);
    expect(two).toBe(CELL_WIDTH * 2 + 1);
    expect(measureText('MM', { tracking: 0 }).width).toBe(CELL_WIDTH * 2);
    expect(measureText('MM', { tracking: 3 }).width).toBe(CELL_WIDTH * 2 + 3);
  });

  it('stacks lines by cell plus leading', () => {
    expect(measureText('a').height).toBe(CELL_HEIGHT);
    expect(measureText('a\nb').height).toBe(CELL_HEIGHT * 2 + 1);
    expect(measureText('a\nb', { leading: 0 }).height).toBe(CELL_HEIGHT * 2);
    expect(measureText('a\nb').lines).toBe(2);
    expect(measureText('a\nb').lineHeight).toBe(CELL_HEIGHT + 1);
  });

  it('measures the widest line, not the last one', () => {
    expect(measureText('MMMM\nM').width).toBe(measureText('MMMM').width);
  });

  it('makes room for the drop shadow', () => {
    // A caller that lays out to the unshadowed size clips the shadow off
    // against the panel border, which reads as the text being cut.
    const plain = measureText('M');
    const shadowed = measureText('M', { shadow: true });
    expect(shadowed.width).toBe(plain.width + 1);
    expect(shadowed.height).toBe(plain.height + 1);
  });
});

describe('integer scale', () => {
  it('turns one font pixel into exactly scale-squared pixels', () => {
    const one = plot('Some more', { scale: 1 }).ink.length;
    for (const scale of [2, 3, 4]) {
      expect(plot('Some more', { scale }).ink.length, `scale ${scale}`).toBe(one * scale * scale);
    }
  });

  it('never draws a fractional pixel and never draws below 1x', () => {
    // 5-pixel-wide letters at 1.15x with smoothing are the exact mush the
    // whole art direction exists to avoid, so a fraction is rounded here
    // rather than passed on to a canvas that would interpolate it.
    expect(measureText('M', { scale: 1.4 }).scale).toBe(1);
    expect(measureText('M', { scale: 1.5 }).scale).toBe(2);
    expect(measureText('M', { scale: 0.85 }).scale).toBe(1);
    expect(measureText('M', { scale: 0 }).scale).toBe(1);
    expect(measureText('M', { scale: Number.NaN }).scale).toBe(1);
  });

  it('maps the accessibility slider onto whole font pixels with a floor of 1', () => {
    // The setting runs 0.85 to 1.8. Below 1x there is no smaller font, only a
    // smeared one, and the bottom of that slider must never make the text
    // less readable than not touching it.
    expect(integerTextScale(0.85)).toBe(1);
    expect(integerTextScale(1)).toBe(1);
    expect(integerTextScale(1.45)).toBe(1);
    expect(integerTextScale(1.5)).toBe(2);
    expect(integerTextScale(1.8)).toBe(2);
    // A larger buffer moves the whole range up without changing the slider.
    expect(integerTextScale(0.85, 2)).toBe(2);
    expect(integerTextScale(1.8, 2)).toBe(4);
  });
});

describe('the drop shadow', () => {
  it('is drawn completely before any ink', () => {
    /*
     * Not tidiness. Interleaved per glyph, the shadow of each letter lands on
     * top of the letter before it — with tracking 0, or a purely horizontal
     * offset, that eats the previous stem and the text goes gappy in a way
     * that looks like a font bug rather than a draw-order bug.
     */
    const { marks } = plot('MMM', { shadow: { x: 1, y: 0 }, tracking: 0 });
    const lastShadow = marks.map((m) => m.layer).lastIndexOf('shadow');
    const firstInk = marks.map((m) => m.layer).indexOf('ink');
    expect(firstInk).toBeGreaterThan(lastShadow);
  });

  it('offsets down and right by whole pixels, scaled with the glyph', () => {
    const { marks } = plot('M', { shadow: true, scale: 2 });
    const shadow = marks.filter((m) => m.layer === 'shadow');
    const ink = marks.filter((m) => m.layer === 'ink');
    expect(shadow.length).toBe(ink.length);
    // At 2x a one-pixel shadow is two buffer pixels, or it stops reading as
    // the same shadow when the player turns the text size up.
    expect(Math.min(...shadow.map((m) => m.x))).toBe(Math.min(...ink.map((m) => m.x)) + 2);
  });

  it('is not drawn at all when it was not asked for', () => {
    expect(plot('M').marks.every((m) => m.layer === 'ink')).toBe(true);
  });
});

describe('word wrap', () => {
  const PROSE =
    'The creek — not water exactly, more a steady sheet of white noise that you ' +
    'mistake for wind until you notice it never changes. The trees open into a bowl ' +
    'maybe fifteen metres across; the fire ring is already going low and orange, and ' +
    'the SM-01 stands at the edge of the light with its idle lamp on.';

  const widths = [40, 61, 100, 148, 200, 304];
  const styles: TextStyle[] = [{}, { proportional: true }, { scale: 2 }, { tracking: 0, shadow: true }];

  /** The narrowest box that still fits every word of the sample whole. */
  const longestWord = (style: TextStyle) =>
    Math.max(...PROSE.split(' ').map((word) => measureText(word, style).width));

  it('never returns a line wider than the box it was given', () => {
    for (const style of styles) {
      for (const width of widths) {
        for (const line of wrapText(PROSE, width, style)) {
          expect(measureText(line, style).width, `${width}px ${JSON.stringify(style)}`).toBeLessThanOrEqual(width);
        }
      }
    }
  });

  it('loses no word, gains no word and moves no space', () => {
    // The whole promise of a wrapper. Joining the lines back with one space
    // has to reproduce the paragraph exactly — not approximately, and not
    // with a doubled space where a break happened.
    for (const style of styles) {
      // Only over boxes wide enough for every word: below that the wrapper is
      // deliberately breaking words, which the next test covers instead.
      const fits = widths.filter((width) => width >= longestWord(style));
      expect(fits.length, JSON.stringify(style)).toBeGreaterThan(0);
      for (const width of fits) {
        expect(wrapText(PROSE, width, style).join(' '), `${width}px`).toBe(PROSE);
      }
    }
  });

  it('leaves no line padded with spaces at either end', () => {
    for (const line of wrapText(PROSE, 100)) {
      expect(line).toBe(line.trim());
      expect(line).not.toContain('  ');
    }
  });

  it('collapses runs of whitespace and keeps explicit line breaks', () => {
    expect(wrapText('one   two', 1000)).toEqual(['one two']);
    expect(wrapText('one\ntwo', 1000)).toEqual(['one', 'two']);
    // A blank line between paragraphs is meaning, not whitespace.
    expect(wrapText('one\n\ntwo', 1000)).toEqual(['one', '', 'two']);
  });

  it('breaks a word that cannot fit rather than letting it overhang', () => {
    // A serial number sticking through the passport's border is worse than an
    // ugly break, and it is the only outcome the caller cannot recover from.
    const long = 'SOMEMORE-01-KETTLEHOLE-1998';
    const lines = wrapText(long, 40);
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join('')).toBe(long);
    for (const line of lines) expect(measureText(line).width).toBeLessThanOrEqual(40);
  });

  it('still terminates when the box is narrower than a single letter', () => {
    const lines = wrapText('impossible', 2);
    expect(lines.join('')).toBe('impossible');
    expect(lines.length).toBe('impossible'.length);
  });

  it('packs more words per line when glyphs are packed to their ink', () => {
    const mono = wrapText(PROSE, 304, {});
    const packed = wrapText(PROSE, 304, { proportional: true });
    expect(packed.length).toBeLessThan(mono.length);
  });
});

describe('the plot contract', () => {
  it('takes a plotter that does not care about layers', () => {
    // The Node-side `Pix` adapter and half the canvas callers only ever draw
    // ink; a two-argument function has to be a legal plotter or the core is
    // not as consumer-agnostic as it claims.
    const hits: number[] = [];
    const bare = (x: number, y: number) => hits.push(x + y);
    expect(() => blitText(bare, 10, 20, 'M')).not.toThrow();
    expect(hits.length).toBeGreaterThan(0);
  });

  it('draws from the corner it was given', () => {
    const shifted = plot('M');
    const marks: Array<{ x: number; y: number }> = [];
    blitText((x, y) => marks.push({ x, y }), 17, 23, 'M');
    expect(marks[0]).toEqual({ x: 17 + (shifted.ink[0]?.x ?? 0), y: 23 + (shifted.ink[0]?.y ?? 0) });
  });

  it('draws nothing for the empty string and for a run of spaces', () => {
    expect(plot('').ink).toEqual([]);
    expect(plot('   ').ink).toEqual([]);
    expect(measureText('   ').width).toBe(CELL_WIDTH * 3 + 2);
  });
});
