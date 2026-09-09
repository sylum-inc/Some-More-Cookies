/**
 * A bitmap font, authored as data in this file, rasterised by code.
 *
 * The overlays — passport, settings, the spoken survey — were anti-aliased
 * Georgia and system sans, rendered by the browser at device resolution on top
 * of a nearest-neighbour 320x240 world. Two rendering languages in one window:
 * the world cannot draw a half-pixel and the type over it was drawing nothing
 * but half-pixels. This is the font that lets the overlays move into the pixel
 * buffer where they belong.
 *
 * There is no font file, for the same reason there is no PNG of a marshmallow
 * (ADR-0002): nothing here is loaded, there is no artist, and a `.ttf` would be
 * a binary asset nobody in this repository can open, review or correct. So the
 * glyphs are written out below the way the 88 icons in `tools/sprites/icons/`
 * are written out — as something a human reads, checks and fixes in a diff.
 * `#` is ink, `.` is paper, `/` ends a row. If a letter is wrong you can see
 * that it is wrong without running anything.
 *
 * ## The cell is 5x9, and 5x7 was tried first
 *
 * Five wide is not negotiable: at 320x240 an overlay needs 40-50 characters on
 * a line and six pixels of advance is what that costs. The height is where the
 * judgement went.
 *
 * A 5x7 cell holds the classic capital exactly and has nowhere at all to put a
 * descender, so `g j p q y` have to be squashed up onto the baseline. That is
 * the single thing that makes a hand-made small font look amateur, and this
 * game's writing is lowercase prose, not machine capitals — "judge my vow"
 * carries three of the five.
 *
 * So the capitals are the classic 5x7 and the cell is two rows taller:
 *
 *     row 0   cap line — capitals and the ascenders b d f h k l start here
 *     row 1   t starts here: a t as tall as a b reads as a plus sign
 *     row 2   x line — a c e m n o r s u v w x z start here
 *     row 6   baseline — everything without a descender ends here
 *     row 7   \ descender — g j p q y , ; _ live down here, and only these
 *     row 8   /
 *
 * Cap height 7, x-height 5, descent 2. The x-height is what carries prose, and
 * five rows is the smallest that keeps `a e s g` apart from each other: at four
 * rows an `a` is an `o` with a nick in it, which is legible in a test and not
 * legible in a sentence. Two descender rows rather than one because a one-row
 * tail is a nub — it reads as dirt on the glass, and `y` becomes `v`.
 *
 * The cost is real and worth stating: 5x9 with one row of leading is a ten-row
 * line, so a 240-row buffer holds 24 lines instead of the 30 a 5x7 would.
 *
 * ## Integer scale, always
 *
 * These are five-pixel-wide letters. At 1.15x with smoothing the stems land
 * across two device pixels and the whole thing turns to mush, which is the
 * exact failure the art direction exists to avoid. Every scale in here is a
 * whole number of font pixels and a fractional one is rounded, never honoured.
 * See `integerTextScale` for what that means for the accessibility slider.
 */

/** Columns in a glyph cell. */
export const CELL_WIDTH = 5;
/** Rows in a glyph cell, descender included. */
export const CELL_HEIGHT = 9;
/** Row index of the cap line: capitals and ascenders start here. */
export const CAP_ROW = 0;
/** Row index of the x line: lowercase without an ascender starts here. */
export const X_ROW = 2;
/** Row index of the last row *on* the baseline. Descenders use 7 and 8. */
export const BASELINE_ROW = 6;
/** Cap height, x-height and descent in rows, for anyone laying out around it. */
export const CAP_HEIGHT = BASELINE_ROW - CAP_ROW + 1;
export const X_HEIGHT = BASELINE_ROW - X_ROW + 1;
export const DESCENT = CELL_HEIGHT - 1 - BASELINE_ROW;

/**
 * Blank columns between glyphs, and blank rows between lines.
 *
 * One column is the minimum that keeps `rn` from reading as `m` — the glyphs
 * are drawn to the edge of the cell on purpose so that the tracking, not the
 * side bearing, controls the colour of a line of text.
 */
export const DEFAULT_TRACKING = 1;
export const DEFAULT_LEADING = 1;

/**
 * Width of a word space when glyphs are packed to their ink (`proportional`).
 *
 * Two font pixels plus one of tracking gives a three-pixel word gap against a
 * one-pixel letter gap. Below that, prose loses its word shapes; above it, a
 * justified-looking rag appears at 40 characters a line.
 */
const PROPORTIONAL_SPACE = 2;

/* -------------------------------------------------------------------------- */
/* The glyphs                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Every glyph, one per line, nine rows of five columns separated by `/`.
 *
 * Read them like a knitting pattern. The rows are always all nine, including
 * the empty ones, because a glyph that declares only the rows it uses is a
 * glyph whose vertical position is implicit — and a font where one letter sits
 * a row high does not look like a font with a bug in it, it looks like the
 * whole interface is vibrating.
 *
 * Keep them in this order (ASCII, then the typographic extras). It is the
 * order the proof sheet prints in, which is the order you will be reviewing.
 */
export const GLYPHS: Readonly<Record<string, string>> = {
  ' ': '...../...../...../...../...../...../...../...../.....',
  '!': '..#../..#../..#../..#../..#../...../..#../...../.....',
  '"': '.#.#./.#.#./...../...../...../...../...../...../.....',
  '#': '...../.#.#./#####/.#.#./#####/.#.#./...../...../.....',
  '$': '..#../.####/#.#../.###./..#.#/####./..#../...../.....',
  '%': '##.../##..#/...#./..#../.#.../#..##/...##/...../.....',
  '&': '.##../#..#./#..#./.##../#.#.#/#..#./.##.#/...../.....',
  "'": '..#../..#../...../...../...../...../...../...../.....',
  '(': '...#./..#../.#.../.#.../.#.../..#../...#./...../.....',
  ')': '.#.../..#../...#./...#./...#./..#../.#.../...../.....',
  '*': '...../#.#.#/.###./#.#.#/...../...../...../...../.....',
  '+': '...../...../...../..#../#####/..#../...../...../.....',
  ',': '...../...../...../...../...../...../..#../..#../.#...',
  '-': '...../...../...../...../.###./...../...../...../.....',
  '.': '...../...../...../...../...../...../..#../...../.....',
  '/': '....#/....#/...#./..#../.#.../#..../#..../...../.....',
  '0': '.###./#...#/#..##/#.#.#/##..#/#...#/.###./...../.....',
  '1': '..#../.##../..#../..#../..#../..#../.###./...../.....',
  '2': '.###./#...#/....#/...#./..#../.#.../#####/...../.....',
  '3': '#####/...#./..##./....#/....#/#...#/.###./...../.....',
  '4': '...#./..##./.#.#./#..#./#####/...#./...#./...../.....',
  '5': '#####/#..../####./....#/....#/#...#/.###./...../.....',
  '6': '..##./.#.../#..../####./#...#/#...#/.###./...../.....',
  '7': '#####/....#/...#./..#../.#.../.#.../.#.../...../.....',
  '8': '.###./#...#/#...#/.###./#...#/#...#/.###./...../.....',
  '9': '.###./#...#/#...#/.####/....#/...#./.##../...../.....',
  ':': '...../...../...../..#../...../...../..#../...../.....',
  ';': '...../...../...../..#../...../...../..#../..#../.#...',
  '<': '...../...../...#./..#../.#.../..#../...#./...../.....',
  '=': '...../...../...../#####/...../#####/...../...../.....',
  '>': '...../...../.#.../..#../...#./..#../.#.../...../.....',
  '?': '.###./#...#/....#/...#./..#../...../..#../...../.....',
  '@': '.###./#...#/#.###/#.#.#/#.###/#..../.###./...../.....',
  'A': '.###./#...#/#...#/#####/#...#/#...#/#...#/...../.....',
  'B': '####./#...#/#...#/####./#...#/#...#/####./...../.....',
  'C': '.###./#...#/#..../#..../#..../#...#/.###./...../.....',
  'D': '####./#...#/#...#/#...#/#...#/#...#/####./...../.....',
  'E': '#####/#..../#..../####./#..../#..../#####/...../.....',
  'F': '#####/#..../#..../####./#..../#..../#..../...../.....',
  'G': '.###./#...#/#..../#.###/#...#/#...#/.###./...../.....',
  'H': '#...#/#...#/#...#/#####/#...#/#...#/#...#/...../.....',
  'I': '.###./..#../..#../..#../..#../..#../.###./...../.....',
  'J': '..###/...#./...#./...#./...#./#..#./.##../...../.....',
  'K': '#...#/#..#./#.#../##.../#.#../#..#./#...#/...../.....',
  'L': '#..../#..../#..../#..../#..../#..../#####/...../.....',
  'M': '#...#/##.##/#.#.#/#.#.#/#...#/#...#/#...#/...../.....',
  'N': '#...#/##..#/#.#.#/#.#.#/#..##/#...#/#...#/...../.....',
  'O': '.###./#...#/#...#/#...#/#...#/#...#/.###./...../.....',
  'P': '####./#...#/#...#/####./#..../#..../#..../...../.....',
  'Q': '.###./#...#/#...#/#...#/#.#.#/#..#./.##.#/...../.....',
  'R': '####./#...#/#...#/####./#.#../#..#./#...#/...../.....',
  'S': '.####/#..../#..../.###./....#/....#/####./...../.....',
  'T': '#####/..#../..#../..#../..#../..#../..#../...../.....',
  'U': '#...#/#...#/#...#/#...#/#...#/#...#/.###./...../.....',
  'V': '#...#/#...#/#...#/#...#/#...#/.#.#./..#../...../.....',
  'W': '#...#/#...#/#...#/#.#.#/#.#.#/#.#.#/.#.#./...../.....',
  'X': '#...#/#...#/.#.#./..#../.#.#./#...#/#...#/...../.....',
  'Y': '#...#/#...#/.#.#./..#../..#../..#../..#../...../.....',
  'Z': '#####/....#/...#./..#../.#.../#..../#####/...../.....',
  '[': '.###./.#.../.#.../.#.../.#.../.#.../.###./...../.....',
  '\\': '#..../#..../.#.../..#../...#./....#/....#/...../.....',
  ']': '.###./...#./...#./...#./...#./...#./.###./...../.....',
  '^': '..#../.#.#./#...#/...../...../...../...../...../.....',
  '_': '...../...../...../...../...../...../...../...../#####',
  '`': '.#.../..#../...../...../...../...../...../...../.....',
  'a': '...../...../.###./....#/.####/#...#/.####/...../.....',
  'b': '#..../#..../####./#...#/#...#/#...#/####./...../.....',
  'c': '...../...../.###./#...#/#..../#...#/.###./...../.....',
  'd': '....#/....#/.####/#...#/#...#/#...#/.####/...../.....',
  'e': '...../...../.###./#...#/#####/#..../.###./...../.....',
  'f': '..##./.#.../####./.#.../.#.../.#.../.#.../...../.....',
  'g': '...../...../.####/#...#/#...#/#...#/.####/....#/.###.',
  'h': '#..../#..../####./#...#/#...#/#...#/#...#/...../.....',
  'i': '..#../...../..#../..#../..#../..#../..#../...../.....',
  'j': '...#./...../...#./...#./...#./...#./...#./#..#./.##..',
  'k': '#..../#..../#..#./#.#../##.../#.#../#..#./...../.....',
  'l': '..#../..#../..#../..#../..#../..#../..##./...../.....',
  'm': '...../...../#####/#.#.#/#.#.#/#.#.#/#.#.#/...../.....',
  'n': '...../...../####./#...#/#...#/#...#/#...#/...../.....',
  'o': '...../...../.###./#...#/#...#/#...#/.###./...../.....',
  'p': '...../...../####./#...#/#...#/#...#/####./#..../#....',
  'q': '...../...../.####/#...#/#...#/#...#/.####/....#/....#',
  'r': '...../...../#.##./##.../#..../#..../#..../...../.....',
  's': '...../...../.####/#..../.###./....#/####./...../.....',
  't': '...../.#.../####./.#.../.#.../.#.../..##./...../.....',
  'u': '...../...../#...#/#...#/#...#/#...#/.####/...../.....',
  'v': '...../...../#...#/#...#/#...#/.#.#./..#../...../.....',
  'w': '...../...../#...#/#...#/#.#.#/#.#.#/.#.#./...../.....',
  'x': '...../...../#...#/.#.#./..#../.#.#./#...#/...../.....',
  'y': '...../...../#...#/#...#/#...#/.#.#./..#../.#.../##...',
  'z': '...../...../#####/...#./..#../.#.../#####/...../.....',
  '{': '..##./.#.../.#.../#..../.#.../.#.../..##./...../.....',
  '|': '..#../..#../..#../..#../..#../..#../..#../...../.....',
  '}': '.##../...#./...#./....#/...#./...#./.##../...../.....',
  '~': '...../...../...../.##.#/#..##/...../...../...../.....',

  /*
   * The typographic extras. Every one of these is in the shipped writing, and
   * a character with no glyph is a character that silently disappears — so
   * they are drawn rather than transliterated. The em dash alone occurs 325
   * times in `packages/content`; it is this game's favourite punctuation mark
   * and it is not going to be rendered as a hyphen.
   */

  // ° degree
  '°': '.##../#..#./.##../...../...../...../...../...../.....',
  /*
   * × multiplication sign.
   *
   * Added when the overlays moved into the buffer, for one string:
   * `Settings.tsx` prints a multiplier as "×1.00" and the panel drew it as the
   * hollow missing-glyph box. That readout took three rounds of art grading to
   * arrive at — a percentage beside a handle that is not at that percentage is
   * the defect it exists to prevent — so the font grew the character rather
   * than the panel losing the mark.
   *
   * Three pixels across rather than a copy of `x`: at five pixels a lowercase
   * `x` and a multiplication sign have the same skeleton, and a font where two
   * characters are the same drawing is the exact bug `bitmapFont.test.ts`
   * spends its most valuable assertion on. It sits on rows 2 to 4 so that its
   * centre is the figures' centre — the proof sheet had it a row lower and
   * "×1.00" read as a subscript rather than as a multiplier.
   */
  '×': '...../...../.#.#./..#../.#.#./...../...../...../.....',
  // · middle dot — the separator in the stamped stickers
  '·': '...../...../...../...../..#../...../...../...../.....',
  /*
   * – en dash and — em dash.
   *
   * Three, four and five pixels for hyphen, en and em. A five-wide cell cannot
   * give the em dash the double length it has in real type, and that limit is
   * accepted rather than worked around: in this game's prose the em dash is
   * always spaced ("the creek — not water exactly") and the hyphen never is,
   * so the gap on either side does the work the extra length would have done.
   * A wide-advance glyph would have bought two pixels at the price of every
   * measurement in this file taking a special case.
   */
  '–': '...../...../...../...../####./...../...../...../.....',
  '—': '...../...../...../...../#####/...../...../...../.....',
  // ‘ ’ “ ” curly quotes. The singles differ by one pixel,
  // which is also true at 12 point; the direction of the tail is the whole
  // signal, so keep the tails pointing the way they do here.
  '‘': '.##../.#.../...../...../...../...../...../...../.....',
  '’': '.##../..#../...../...../...../...../...../...../.....',
  '“': '##.##/#..#./...../...../...../...../...../...../.....',
  '”': '##.##/.#..#/...../...../...../...../...../...../.....',
  // … ellipsis, as one glyph — three periods at this size are four
  // pixels apart and read as a dashed line.
  '…': '...../...../...../...../...../...../#.#.#/...../.....',
};

/**
 * What an unsupported character draws.
 *
 * A hollow box, deliberately ugly. The alternative — drawing nothing — is the
 * failure where a sentence quietly loses a letter and nobody notices until a
 * player reports that a word is misspelled. Missing type should look missing.
 */
const MISSING_GLYPH = '...../...../#####/#...#/#...#/#...#/#####/...../.....';

/* -------------------------------------------------------------------------- */
/* Compilation                                                                */
/* -------------------------------------------------------------------------- */

export interface Glyph {
  /** The nine authored rows, for review tooling and tests. */
  readonly rows: readonly string[];
  /** Row-major ink flags, `CELL_WIDTH * CELL_HEIGHT` of them. */
  readonly bits: Uint8Array;
  /** Leftmost and rightmost inked column, or -1/-1 when the glyph is blank. */
  readonly inkLeft: number;
  readonly inkRight: number;
}

/**
 * Turns one authored line into a glyph, refusing anything ragged.
 *
 * This throws at module load rather than returning something plausible,
 * because a cell that is four columns wide instead of five does not show up as
 * a broken letter — it shows up as every letter after it on the line sitting a
 * pixel to the left, which reads as the interface shivering and gets
 * misdiagnosed for a day.
 */
function compile(name: string, pattern: string): Glyph {
  const rows = pattern.split('/');
  if (rows.length !== CELL_HEIGHT) {
    throw new Error(`glyph ${name}: ${rows.length} rows, expected ${CELL_HEIGHT}`);
  }
  const bits = new Uint8Array(CELL_WIDTH * CELL_HEIGHT);
  let inkLeft = -1;
  let inkRight = -1;
  for (let y = 0; y < CELL_HEIGHT; y++) {
    const row = rows[y] ?? '';
    if (row.length !== CELL_WIDTH) {
      throw new Error(`glyph ${name} row ${y}: ${row.length} columns, expected ${CELL_WIDTH}`);
    }
    for (let x = 0; x < CELL_WIDTH; x++) {
      const cell = row[x];
      if (cell === '.') continue;
      if (cell !== '#') throw new Error(`glyph ${name} row ${y}: '${cell ?? ''}' is not '#' or '.'`);
      bits[y * CELL_WIDTH + x] = 1;
      if (inkLeft === -1 || x < inkLeft) inkLeft = x;
      if (x > inkRight) inkRight = x;
    }
  }
  return { rows, bits, inkLeft, inkRight };
}

const COMPILED = new Map<string, Glyph>(
  Object.entries(GLYPHS).map(([character, pattern]) => [character, compile(character, pattern)]),
);
const MISSING = compile('missing', MISSING_GLYPH);

/** Every character this font can draw, in authoring order. */
export const SUPPORTED_CHARACTERS: readonly string[] = Object.freeze(Object.keys(GLYPHS));

export function hasGlyph(character: string): boolean {
  return COMPILED.has(character);
}

/** The glyph for a character, or the hollow box for one nobody has drawn. */
export function glyphFor(character: string): Glyph {
  return COMPILED.get(character) ?? MISSING;
}

/* -------------------------------------------------------------------------- */
/* Style                                                                      */
/* -------------------------------------------------------------------------- */

export interface TextStyle {
  /**
   * Whole font pixels per glyph pixel. Rounded to an integer and floored at 1;
   * see `integerTextScale`.
   */
  scale?: number;
  /** Blank columns between glyphs. Default 1. */
  tracking?: number;
  /** Blank rows between lines. Default 1. */
  leading?: number;
  /**
   * Offset of a one-pixel drop shadow, in font pixels, or `true` for (1, 1).
   * Down and right only, because the light in this game comes from the upper
   * left and every icon in `tools/sprites/icons/` already agrees about that.
   */
  shadow?: boolean | { x: number; y: number } | null;
  /**
   * Pack each glyph to its own ink instead of the fixed cell.
   *
   * Off by default: the HUD's machine text wants a column grid, and digits
   * that change width as they count are worse than digits that are too wide.
   * On for prose, where it buys about a fifth of the line back from `i`, `l`,
   * `t` and the punctuation.
   */
  proportional?: boolean;
}

interface Resolved {
  scale: number;
  tracking: number;
  leading: number;
  shadowX: number;
  shadowY: number;
  hasShadow: boolean;
  proportional: boolean;
}

function wholePixels(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.round(value));
}

function resolve(style: TextStyle): Resolved {
  const shadow = style.shadow === true ? { x: 1, y: 1 } : style.shadow || null;
  return {
    scale: wholePixels(style.scale, 1, 1),
    tracking: wholePixels(style.tracking, DEFAULT_TRACKING, 0),
    leading: wholePixels(style.leading, DEFAULT_LEADING, 0),
    // Clamped to positive: a shadow up and left would move the ink's origin
    // away from the (x, y) the caller passed, and then every metric in here
    // would need a bearing as well as a size.
    shadowX: shadow ? wholePixels(shadow.x, 1, 0) : 0,
    shadowY: shadow ? wholePixels(shadow.y, 1, 0) : 0,
    hasShadow: shadow !== null,
    proportional: style.proportional === true,
  };
}

/** Advance of one glyph in font pixels, tracking excluded. */
function advanceOf(glyph: Glyph, style: Resolved): number {
  if (!style.proportional) return CELL_WIDTH;
  if (glyph.inkLeft === -1) return PROPORTIONAL_SPACE;
  return glyph.inkRight - glyph.inkLeft + 1;
}

/** Width of one line in font pixels, with no trailing tracking and no shadow. */
function lineInk(line: string, style: Resolved): number {
  let width = 0;
  let count = 0;
  for (const character of line) {
    width += advanceOf(glyphFor(character), style);
    count += 1;
  }
  return count === 0 ? 0 : width + (count - 1) * style.tracking;
}

/* -------------------------------------------------------------------------- */
/* Measurement                                                                */
/* -------------------------------------------------------------------------- */

export interface TextMetrics {
  /**
   * Size of the box the text occupies, in buffer pixels — font pixels times
   * the scale, with the drop shadow included, because a caller that lays out
   * to the unshadowed size clips the shadow off the right edge of the panel.
   */
  readonly width: number;
  readonly height: number;
  /** Number of lines, counting a trailing blank one. */
  readonly lines: number;
  /** Rows from the top of the box down to the first line's baseline. */
  readonly baseline: number;
  /** One line to the next, in buffer pixels. */
  readonly lineHeight: number;
  /** The integer scale actually used, after rounding. */
  readonly scale: number;
}

function metricsFor(lines: readonly string[], style: Resolved): TextMetrics {
  let widest = 0;
  for (const line of lines) widest = Math.max(widest, lineInk(line, style));
  const rows = lines.length * CELL_HEIGHT + Math.max(0, lines.length - 1) * style.leading;
  return {
    width: widest === 0 ? 0 : (widest + style.shadowX) * style.scale,
    height: (rows + style.shadowY) * style.scale,
    lines: lines.length,
    baseline: (BASELINE_ROW + 1) * style.scale,
    lineHeight: (CELL_HEIGHT + style.leading) * style.scale,
    scale: style.scale,
  };
}

/**
 * The size `blitText` would draw, without drawing it.
 *
 * Newlines are honoured; nothing is wrapped. Widths are the *advance* box, so
 * a trailing space counts — that is what a caller positioning a cursor or
 * centring a line needs, and it is what `wrapText` measures against.
 */
export function measureText(text: string, style: TextStyle = {}): TextMetrics {
  return metricsFor(text.split('\n'), resolve(style));
}

/* -------------------------------------------------------------------------- */
/* Wrapping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Breaks prose to a pixel width.
 *
 * Greedy, which is what every reader expects and what makes the result stable
 * when a panel is resized by one pixel. Runs of whitespace collapse to a
 * single space and an explicit newline is kept as a line break, so a blank
 * line between paragraphs survives.
 *
 * A word too long for the width is broken across lines rather than allowed to
 * overhang. That is the less pretty answer, but the promise this function
 * makes is that nothing it returns is wider than the box it was given, and a
 * single long word overhanging is how a panel's border ends up with a serial
 * number sticking through it.
 */
export function wrapText(text: string, maxWidth: number, style: TextStyle = {}): string[] {
  const resolved = resolve(style);
  const width = (line: string) => (lineInk(line, resolved) + resolved.shadowX) * resolved.scale;
  const out: string[] = [];

  for (const paragraph of text.split('\n')) {
    const words = paragraph.split(/[ \t]+/).filter((word) => word.length > 0);
    if (words.length === 0) {
      out.push('');
      continue;
    }
    let line = '';
    for (const word of words) {
      if (width(word) > maxWidth) {
        if (line !== '') {
          out.push(line);
          line = '';
        }
        const chunks = breakWord(word, maxWidth, width);
        for (let i = 0; i < chunks.length - 1; i++) out.push(chunks[i] ?? '');
        line = chunks[chunks.length - 1] ?? '';
        continue;
      }
      const candidate = line === '' ? word : `${line} ${word}`;
      if (line !== '' && width(candidate) > maxWidth) {
        out.push(line);
        line = word;
      } else {
        line = candidate;
      }
    }
    out.push(line);
  }
  return out;
}

/**
 * Splits one over-long word into pieces that each fit.
 *
 * At least one character per piece even when a single glyph is wider than the
 * box, because the alternative is a loop that never ends — and a panel narrow
 * enough to trigger that is a layout bug that should show as one enormous
 * letter per line, not as a hung frame.
 */
function breakWord(word: string, maxWidth: number, width: (line: string) => number): string[] {
  const chunks: string[] = [];
  let chunk = '';
  for (const character of word) {
    const candidate = chunk + character;
    if (chunk !== '' && width(candidate) > maxWidth) {
      chunks.push(chunk);
      chunk = character;
    } else {
      chunk = candidate;
    }
  }
  chunks.push(chunk);
  return chunks;
}

/* -------------------------------------------------------------------------- */
/* Drawing                                                                    */
/* -------------------------------------------------------------------------- */

export type PlotLayer = 'shadow' | 'ink';

/**
 * Somewhere to put a pixel.
 *
 * Deliberately not a canvas, not a `Pix`, not an `ImageData`. The same glyphs
 * have to be drawn by the browser at runtime and by Node at build time, and
 * the only thing those two agree on is "set this pixel". Everything above this
 * line is testable without a DOM because of it.
 *
 * A consumer that does not draw shadows can ignore the third argument
 * entirely — `(x, y) => void` is assignable to this.
 */
export type Plot = (x: number, y: number, layer: PlotLayer) => void;

/** Walks the ink of one pass in font-pixel coordinates relative to the text box. */
function eachInk(
  lines: readonly string[],
  style: Resolved,
  visit: (x: number, y: number) => void,
): void {
  let top = 0;
  for (const line of lines) {
    let left = 0;
    for (const character of line) {
      const glyph = glyphFor(character);
      const shift = style.proportional && glyph.inkLeft >= 0 ? glyph.inkLeft : 0;
      for (let y = 0; y < CELL_HEIGHT; y++) {
        for (let x = 0; x < CELL_WIDTH; x++) {
          if (glyph.bits[y * CELL_WIDTH + x] !== 1) continue;
          visit(left + x - shift, top + y);
        }
      }
      left += advanceOf(glyph, style) + style.tracking;
    }
    top += CELL_HEIGHT + style.leading;
  }
}

/**
 * Draws `text` with its top-left corner at `x, y`, one pixel at a time.
 *
 * The shadow is drawn as a complete pass before any ink, and that ordering is
 * load-bearing rather than tidy: interleaved per glyph, the shadow of every
 * letter lands on top of the letter before it, and at tracking 0 or with a
 * purely horizontal offset it eats the previous stem. Two passes costs one
 * extra walk of a string that is at most a few hundred characters.
 */
export function blitText(
  plot: Plot,
  x: number,
  y: number,
  text: string,
  style: TextStyle = {},
): TextMetrics {
  const resolved = resolve(style);
  const lines = text.split('\n');
  const block = (fx: number, fy: number, layer: PlotLayer) => {
    const left = x + fx * resolved.scale;
    const top = y + fy * resolved.scale;
    for (let dy = 0; dy < resolved.scale; dy++) {
      for (let dx = 0; dx < resolved.scale; dx++) plot(left + dx, top + dy, layer);
    }
  };
  if (resolved.hasShadow) {
    eachInk(lines, resolved, (fx, fy) => block(fx + resolved.shadowX, fy + resolved.shadowY, 'shadow'));
  }
  eachInk(lines, resolved, (fx, fy) => block(fx, fy, 'ink'));
  return metricsFor(lines, resolved);
}

export interface CanvasTextStyle extends TextStyle {
  /** Any canvas fill style; a flat palette colour, not a gradient. */
  ink: string;
  /** Omitted means no shadow is drawn even if `shadow` is set. */
  shadowColor?: string;
}

/**
 * The browser adapter.
 *
 * One `fillRect` per *font* pixel rather than per device pixel, so a 3x letter
 * is nine device pixels in one call. Every coordinate is a whole number and
 * every rectangle is axis-aligned, which is the only way a 2D context draws
 * pixel art without asking the compositor to interpolate something.
 */
export function drawText(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  text: string,
  style: CanvasTextStyle,
): TextMetrics {
  // A shadow with no colour is not a shadow, and it must not be reserved in
  // the metrics either — a caller centring on a box a pixel wider than the
  // ink it actually drew is off-centre everywhere in the panel.
  const drawsShadow = style.shadowColor !== undefined;
  const resolved = resolve(drawsShadow ? style : { ...style, shadow: null });
  const lines = text.split('\n');
  const fill = (fx: number, fy: number) =>
    ctx.fillRect(x + fx * resolved.scale, y + fy * resolved.scale, resolved.scale, resolved.scale);
  if (resolved.hasShadow && style.shadowColor !== undefined) {
    ctx.fillStyle = style.shadowColor;
    eachInk(lines, resolved, (fx, fy) => fill(fx + resolved.shadowX, fy + resolved.shadowY));
  }
  ctx.fillStyle = style.ink;
  eachInk(lines, resolved, fill);
  return metricsFor(lines, resolved);
}

/* -------------------------------------------------------------------------- */
/* The accessibility text scale                                               */
/* -------------------------------------------------------------------------- */

/**
 * The player's text-size setting, as a number of font pixels.
 *
 * The setting runs 0.85 to 1.8 in steps of 0.05 — twenty stops of a continuous
 * dial, designed for a browser that can set type at 14.375px. A bitmap font
 * has no such stops. It has 1x, 2x, 3x, and nothing at all in between, and
 * there is no honest way to give it more.
 *
 * So this rounds, and it floors at 1. Flooring matters most: 0.85 of a 5x9
 * cell is not a smaller font, it is a smeared one, and the bottom of this
 * slider must not be allowed to make the interface *less* readable for the
 * person who reached for it because they could not read something. One font
 * pixel is the floor, and it is also the point of the whole exercise — the
 * type is finally the same size as the pixels of the world behind it.
 *
 * What that leaves, at a 320x240 buffer:
 *
 *   0.85 - 1.49   1x   50 characters across a 304px measure, 24 lines. Reading size.
 *   1.50 - 1.80   2x   25 characters, 12 lines. Large print.
 *
 * Two sizes out of twenty stops. The recommendation that goes with that is
 * that the *slider* should stop lying about it: `Settings.tsx` already carries
 * a long note about a control whose label disagreed with its handle, and a
 * twenty-stop dial where eighteen stops do nothing is the same defect. For the
 * pixel overlays this wants to be two or three named steps.
 *
 * The rest of the range still has somewhere useful to go, and it is not the
 * glyph: leading, panel padding and — the one that actually helps a reader —
 * the measure. Forty-six characters a line at 1x with two rows of leading is
 * easier to read than twenty-three characters a line at 2x, and it does not
 * cost half the passport.
 *
 * `base` is for a buffer that is not 320x240. At the `high` quality tier the
 * internal height is 360, so an overlay that wants the same apparent size
 * passes base 2 and gets 2x, 3x, 4x out of the same slider.
 */
export function integerTextScale(setting: number, base = 1): number {
  if (!Number.isFinite(setting) || setting <= 0) return Math.max(1, Math.round(base));
  return Math.max(1, Math.round(base * setting));
}
