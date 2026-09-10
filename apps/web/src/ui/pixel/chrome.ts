/**
 * The printed vocabulary: what a page in this game is made of.
 *
 * Every shape here has a CSS ancestor in `ui/styles.ts` and is drawn instead
 * of declared. That is not a translation exercise — three of them cannot be
 * declared at all at this resolution, and those three are the ones the art
 * grade actually named:
 *
 *   THE BEVEL     `inset 2px 2px 0 rgba(...)` is four rectangles and has no
 *                 mitre. A real moulded edge turns the corner on a diagonal,
 *                 and at a 2px bevel on a 320-wide buffer that diagonal is
 *                 three pixels a person can count. It is authored below as
 *                 nine tiles for exactly that reason.
 *   THE STAMP     `border-radius: 50%` with a dash array. An art grade wrote
 *                 "as drawn it is a border-radius" and was right. What makes a
 *                 die-struck mark is that the ink did not all take, which is a
 *                 per-pixel fact and not a property of a box.
 *   THE CUT       a `linear-gradient` fade, which shipped three times as a
 *                 fade nobody could see. Here it is a dither, and a dither is
 *                 legible at any two colours because it is a pattern.
 *
 * Everything is authored as a whole number of buffer pixels. There is no
 * radius, no alpha and no fractional coordinate anywhere in this file.
 */

import type { PanelInk } from './palette.js';
import { bayer4x4, halftone } from './dither.js';
import type { PanelSurface, Rect } from './surface.js';
import { bottom, drawText, fillRect, frameRect, hLine, insetRect, pixel, right, vLine } from './surface.js';
import { CELL_HEIGHT, measureText, wrapText } from '../../render/bitmapFont.js';

/* -------------------------------------------------------------------------- */
/* The nine-slice                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The panel's edge, authored the way the glyphs in `bitmapFont.ts` are.
 *
 * `K` ink, `L` the lit bevel, `S` the shaded bevel, `P` paper. Read the
 * corners like a knitting pattern: the top-left is a hard border, two rows of
 * light along the top and two columns of light down the left, and the two
 * bands simply overlap. The interesting ones are the other three, where a lit
 * band meets a shaded band and has to hand over — the diagonal in `topRight`
 * and `bottomLeft` is the mitre, and it is the single detail that separates a
 * drawn bevel from four CSS insets.
 *
 * Light comes from the upper left. Every icon in `tools/sprites/icons/`
 * already agrees about that and so does the drop shadow in `bitmapFont.ts`; a
 * panel lit from anywhere else would be the only object in the game that is.
 *
 * Five pixels a side, so the smallest panel this can frame is 10x10.
 */
const SLICE = 5;

const TILE_TOP_LEFT = ['KKKKK', 'KLLLL', 'KLLLL', 'KLLPP', 'KLLPP'] as const;
const TILE_TOP_RIGHT = ['KKKKK', 'LLLLK', 'LLLSK', 'PPSSK', 'PPSSK'] as const;
const TILE_BOTTOM_LEFT = ['KLLPP', 'KLLPP', 'KLSSS', 'KSSSS', 'KKKKK'] as const;
const TILE_BOTTOM_RIGHT = ['PPSSK', 'PPSSK', 'SSSSK', 'SSSSK', 'KKKKK'] as const;
/** One column of the top edge, top to bottom; the bottom edge inverted. */
const EDGE_TOP = ['K', 'L', 'L', 'P', 'P'] as const;
const EDGE_BOTTOM = ['P', 'P', 'S', 'S', 'K'] as const;
/** One row of the left edge, left to right; the right edge inverted. */
const EDGE_LEFT = ['K', 'L', 'L', 'P', 'P'] as const;
const EDGE_RIGHT = ['P', 'P', 'S', 'S', 'K'] as const;

export type PanelLegend = Readonly<Record<string, PanelInk>>;

/** Paper: a hard ink border, a lit top-left, a shaded bottom-right. */
export const PAPER_LEGEND: PanelLegend = {
  K: 'ink',
  L: 'paperLit',
  S: 'paperShade',
  P: 'paper',
};

/**
 * The same moulding, in a dark case.
 *
 * `panel.ts` has always had `drawPlate` — "a dark plate, for the one panel
 * that is a device readout and not a page" — and the terminal is that panel.
 * A plate is not a page with the colours swapped: the *border* has to be
 * darker than the face rather than lighter, so `night` takes the border and
 * the shade and `inkSoft` takes the lit edge, which is the same light from the
 * same upper left falling on a different material.
 *
 * Nothing about the tiles changes. A mitre is a mitre.
 */
export const PLATE_LEGEND: PanelLegend = {
  K: 'night',
  L: 'inkSoft',
  S: 'night',
  P: 'ink',
};

function inkFor(code: string | undefined, legend: PanelLegend = PAPER_LEGEND): PanelInk {
  const ink = code === undefined ? undefined : legend[code];
  // A typo in a tile above would otherwise be a silently wrong pixel on one
  // corner of every panel in the game, which is precisely the class of defect
  // `compile()` in bitmapFont.ts throws about. Same answer here.
  if (ink === undefined) throw new Error(`nine-slice legend has no '${code ?? ''}'`);
  return ink;
}

function paintTile(
  surface: PanelSurface,
  x: number,
  y: number,
  tile: readonly string[],
  legend: PanelLegend = PAPER_LEGEND,
): void {
  for (let row = 0; row < tile.length; row++) {
    const line = tile[row] ?? '';
    for (let column = 0; column < line.length; column++) {
      pixel(surface, x + column, y + row, inkFor(line[column], legend));
    }
  }
}

export interface PaperPanelOptions {
  /** The page colour. Default `paper`. */
  readonly face?: PanelInk;
  /** The printed screen over it, or null for a flat page. Default `paperEdge`. */
  readonly screen?: PanelInk | null;
  /**
   * A stamped rule down the leading edge, the way every HUD plate has one.
   * Three pixels wide because `SURFACE.rule` is three pixels wide.
   */
  readonly leadingRule?: PanelInk | null;
  /**
   * Which moulding this is: `PAPER_LEGEND` (the default) or `PLATE_LEGEND`.
   *
   * A legend rather than four colour props, because the nine tiles are
   * authored once and a panel that could re-letter them individually is a
   * panel where somebody eventually gets a mitre wrong on one corner.
   */
  readonly legend?: PanelLegend;
}

/**
 * A page: hard ink border, two-pixel mitred bevel, screened paper inside.
 *
 * Square corners, and the reason is written down in `styles.ts`: "a rounded
 * rectangle is the single most reliable tell that something was styled by a
 * web framework rather than drawn, and this game is imitating hardware that
 * could not draw one". A nine-slice with a chamfer would be a radius wearing a
 * different hat.
 */
export function drawPaperPanel(surface: PanelSurface, area: Rect, options: PaperPanelOptions = {}): void {
  const legend = options.legend ?? PAPER_LEGEND;
  const face = options.face ?? inkFor('P', legend);
  const border = inkFor('K', legend);
  const screen = options.screen === undefined ? 'paperEdge' : options.screen;
  if (area.width < SLICE * 2 || area.height < SLICE * 2) {
    // Too small to frame. Draw the ground and a border so the caller sees a
    // box rather than nothing, because nothing is the failure that gets
    // misread as "the panel did not render".
    fillRect(surface, area, face);
    frameRect(surface, area, border);
    return;
  }

  fillRect(surface, area, face);

  const innerWidth = area.width - SLICE * 2;
  const innerHeight = area.height - SLICE * 2;

  for (let row = 0; row < SLICE; row++) {
    const top = inkFor(EDGE_TOP[row], legend);
    const low = inkFor(EDGE_BOTTOM[row], legend);
    surface.fill(area.x + SLICE, area.y + row, innerWidth, 1, top);
    surface.fill(area.x + SLICE, bottom(area) - SLICE + row, innerWidth, 1, low);
  }
  for (let column = 0; column < SLICE; column++) {
    const left = inkFor(EDGE_LEFT[column], legend);
    const rightInk = inkFor(EDGE_RIGHT[column], legend);
    surface.fill(area.x + column, area.y + SLICE, 1, innerHeight, left);
    surface.fill(right(area) - SLICE + column, area.y + SLICE, 1, innerHeight, rightInk);
  }

  paintTile(surface, area.x, area.y, TILE_TOP_LEFT, legend);
  paintTile(surface, right(area) - SLICE, area.y, TILE_TOP_RIGHT, legend);
  paintTile(surface, area.x, bottom(area) - SLICE, TILE_BOTTOM_LEFT, legend);
  paintTile(surface, right(area) - SLICE, bottom(area) - SLICE, TILE_BOTTOM_RIGHT, legend);

  // The screen goes on *after* the frame, not before it.
  //
  // Before it, the frame's own edge tiles paint over the outermost two rows of
  // dots — the tiles are five pixels deep and their last two rows are plain
  // paper — and every panel came out with a clean five-pixel margin inside its
  // bevel that nobody had asked for. It looks like a mount, which is a
  // different object from a page, and it was an accident of draw order rather
  // than a decision. Inset by border + bevel so the dots start where the paper
  // starts.
  // Inset by border + bevel, so the dots start where the paper starts.
  if (screen !== null) halftone(surface, insetRect(area, 3), screen);

  if (options.leadingRule) {
    surface.fill(area.x + 1, area.y + 1, 3, area.height - 2, options.leadingRule);
  }
}

/* -------------------------------------------------------------------------- */
/* Bevelled boxes, for things a thumb can do                                  */
/* -------------------------------------------------------------------------- */

export type BevelDirection = 'out' | 'in';

/**
 * The control-sized bevel: one pixel, not two.
 *
 * `SURFACE.bevelOut` is two pixels and says why — a 1px inset highlight on a
 * CSS box is a fraction of a world pixel and the browser fades it. That
 * argument dissolves here, because a pixel in this kit *is* a world pixel and
 * cannot be faded. What is left is the honest one: a 17-pixel-tall button with
 * a 2px bevel is a button that is nearly a quarter chrome, and the label stops
 * fitting. One pixel, and it survives the upscale because there is no
 * resampling left to survive.
 */
export function drawBevelBox(
  surface: PanelSurface,
  area: Rect,
  face: PanelInk,
  direction: BevelDirection = 'out',
  border: PanelInk | null = 'ink',
): void {
  if (area.width <= 0 || area.height <= 0) return;
  fillRect(surface, area, face);
  const lit = direction === 'out' ? 'paperLit' : 'paperShade';
  const shade = direction === 'out' ? 'paperShade' : 'paperLit';
  const inset = border === null ? 0 : 1;
  const x = area.x + inset;
  const y = area.y + inset;
  const w = area.width - inset * 2;
  const h = area.height - inset * 2;
  if (w > 0 && h > 0) {
    hLine(surface, x, y, w, lit);
    vLine(surface, x, y, h, lit);
    hLine(surface, x, y + h - 1, w, shade);
    vLine(surface, x + w - 1, y, h, shade);
  }
  if (border !== null) frameRect(surface, area, border);
}

/* -------------------------------------------------------------------------- */
/* Rules                                                                      */
/* -------------------------------------------------------------------------- */

export type RuleStyle = 'solid' | 'hair' | 'dashed';

/**
 * A rule across the measure.
 *
 * Three weights, because the Passport already uses three: a 2px solid ink line
 * under the cover block, a 2px dashed `inkSoft` line above "Keep this
 * passport", and nothing at all between sections. `hair` is the dithered one —
 * a 50% checker of `inkSoft`, which is the printed equivalent of a hairline
 * and the only way to get a half-weight line out of a palette with no
 * half-weights in it.
 */
export function drawRule(
  surface: PanelSurface,
  x: number,
  y: number,
  width: number,
  style: RuleStyle = 'solid',
  ink: PanelInk = 'ink',
): void {
  if (width <= 0) return;
  if (style === 'solid') {
    hLine(surface, x, y, width, ink);
    return;
  }
  if (style === 'hair') {
    for (let px = x; px < x + width; px++) {
      if (bayer4x4(px, y) < 0.5) pixel(surface, px, y, ink);
    }
    return;
  }
  // Dashed: four on, three off. Anchored to the surface rather than to `x`, so
  // two rules on one page line up their dashes instead of beating.
  for (let px = x; px < x + width; px++) {
    if (((px % 7) + 7) % 7 < 4) pixel(surface, px, y, ink);
  }
}

/* -------------------------------------------------------------------------- */
/* The stamped mark                                                           */
/* -------------------------------------------------------------------------- */

/**
 * Deterministic noise for one pixel of one mark.
 *
 * `Math.random` is available to presentation under ADR-0001, and it is the
 * wrong tool here for the reason the CSS version already gives: "a mark that
 * moved every render would be a page that will not sit still". Same stamp,
 * same booklet, same mark, every time it is opened — and the same mark in the
 * proof sheet as on the screen, which is what makes the proof worth looking at.
 */
function noise(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2246822519) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

export interface StampOptions {
  /** Short, uppercased on the way in. Two or three words at most. */
  readonly label: string;
  /** Hash of the stamp's id: everything variable about the mark comes from it. */
  readonly seed: number;
  readonly ink?: PanelInk;
}

/**
 * One inked mark, pressed by hand.
 *
 * The three properties are the ones `Passport.tsx` already argues for, drawn
 * rather than declared:
 *
 *   ROTATED   four to seven degrees, never less, sign from the hash. The ring
 *             is a circle so the tilt only moves where it breaks — but the
 *             *label* has to lean, and a bitmap label cannot be rotated. It is
 *             stepped instead: the baseline drops a whole pixel every few
 *             characters, which is how a pixel artist has always faked a small
 *             angle and is the only version of this that does not resample
 *             five-pixel-wide letters through a rotation matrix.
 *   BROKEN    four gaps, placed by the hash. A closed ring is a border however
 *             it is drawn.
 *   MOTTLED   ink that did not take: a 2px checker drops about a sixth of the
 *             mark, and one hashed patch drops most of itself. Without the
 *             patch the loss is uniform, and uniform loss reads as a texture
 *             rather than as a bad impression.
 *
 * Two rings, an outer and an inner, because a die has two edges and a single
 * stroke reads as a hoop.
 */
export function drawStamp(surface: PanelSurface, area: Rect, options: StampOptions): void {
  const ink = options.ink ?? 'stamp';
  const seed = options.seed >>> 0;
  const size = Math.min(area.width, area.height);
  if (size < 12) return;
  const cx = area.x + area.width / 2 - 0.5;
  const cy = area.y + area.height / 2 - 0.5;
  const outer = size / 2 - 2;
  const inner = outer - 3;

  // Four to seven degrees, either way — `% 4` gives 0..3, so `+ 4` gives 4..7.
  const degrees = (((seed >>> 3) % 4) + 4) * (seed % 2 === 0 ? 1 : -1);
  const tilt = (degrees * Math.PI) / 180;
  // Four gaps a twenty-sixth of the ring wide, rotated with the die.
  const gapHalf = Math.PI / 26;
  const gapAt = [0, 1, 2, 3].map((i) => tilt + (i * Math.PI) / 2 + ((seed >>> (i * 4)) % 32) / 96);
  // One patch where the ink did not take, placed inside the die by the hash.
  const patchAngle = ((seed >>> 11) % 360) * (Math.PI / 180);
  const patchRadius = outer * (0.3 + ((seed >>> 17) % 40) / 100);
  const patchX = cx + Math.cos(patchAngle) * patchRadius;
  const patchY = cy + Math.sin(patchAngle) * patchRadius;
  const patchSize = Math.max(3, outer * 0.42);

  /*
   * `strength` is 1 for the ring and lighter for the label, and that is a
   * legibility decision rather than a physical one.
   *
   * At full strength the patch took whole letters out — the proof sheet had a
   * stamp reading "NIGH" and another reading "CLCAR" — and these labels are
   * content, not texture: a player is meant to be able to tell which stamp
   * they earned. The ring carries the damage instead, which is where a reader
   * reads "hand-stamped" from anyway.
   */
  const took = (x: number, y: number, strength = 1): boolean => {
    // The printed screen first: alternate cells lose a third of their ink.
    if ((x + y) % 2 === 0 && noise(x, y, seed) < 0.34 * strength) return false;
    const patch = Math.hypot(x - patchX, y - patchY) / patchSize;
    if (patch < 1 && noise(x, y, seed ^ 0x5bf03635) < 0.75 * strength * (1 - patch)) return false;
    return true;
  };

  for (let y = area.y; y < bottom(area); y++) {
    for (let x = area.x; x < right(area); x++) {
      const dx = x - cx;
      const dy = y - cy;
      const radius = Math.hypot(dx, dy);
      const onOuter = Math.abs(radius - outer) < 0.9;
      const onInner = inner > 3 && Math.abs(radius - inner) < 0.9;
      if (!onOuter && !onInner) continue;
      const angle = Math.atan2(dy, dx);
      const broken = gapAt.some((at) => {
        let delta = angle - at;
        while (delta > Math.PI) delta -= Math.PI * 2;
        while (delta < -Math.PI) delta += Math.PI * 2;
        return Math.abs(delta) < gapHalf;
      });
      if (broken) continue;
      if (!took(x, y)) continue;
      pixel(surface, x, y, ink);
    }
  }

  /*
   * The label, wrapped to the die and stepped along the tilt.
   *
   * Wrapped, because the first proof sheet had four stamps in a row whose
   * labels ran clean through each other: `drawStamp` was handed "pine hollow"
   * and set it on one line sixty-six pixels wide inside a thirty-eight pixel
   * mark. A die is round and the words go inside it, which means the measure
   * is the *inner ring's* diameter and never the caller's string.
   *
   * Stepped, because a bitmap label cannot be rotated. `Math.tan` of seven
   * degrees over a six-pixel advance is 0.74 of a pixel, so the baseline drops
   * a whole pixel roughly every other character — the oldest trick in pixel
   * art for a small angle, and the only one that does not put five-pixel-wide
   * letters through a resampling matrix.
   *
   * Clipped, because the mottle and the ring are bounded by `area` but the
   * label was not, so an overlong word did not merely look wrong: it drew on
   * the next stamp.
   */
  const clip: PanelSurface = {
    width: surface.width,
    height: surface.height,
    fill: (fx, fy, fw, fh, key) => {
      for (let y = fy; y < fy + fh; y++) {
        for (let x = fx; x < fx + fw; x++) {
          if (x < area.x || y < area.y || x >= right(area) || y >= bottom(area)) continue;
          /*
           * The label is part of the same impression, so it loses the same ink
           * — but far less of it than the ring does.
           *
           * At the ring's own strength the patch was taking whole letters out:
           * a proof sheet came back reading "PINE HOLL.a" and "NIGH", which is
           * not a stamp that has run dry, it is a rendering fault. The
           * difference is real and not a fudge: a rubber stamp loses ink at
           * its edges and on its thinnest strokes, and a five-pixel letter has
           * no thin strokes to lose — every pixel of it is the stroke. So the
           * ring wears and the name stays readable, which is also the only
           * behaviour worth having, since the name is the thing the stamp is
           * for.
           */
          if (took(x, y, 0.08)) surface.fill(x, y, 1, 1, key);
        }
      }
    },
  };

  const style = { scale: 1, proportional: false } as const;
  const advance = measureText('M', style).width + 1;
  const rise = Math.tan(tilt) * advance;
  const measure = Math.max(advance, inner * 2 - 2);
  const rows = wrapText(options.label.toUpperCase(), measure, style).slice(0, 3);
  const lineHeight = CELL_HEIGHT + 1;
  let top = Math.round(cy - (rows.length * lineHeight - 1) / 2 + 0.5);
  for (const row of rows) {
    const width = measureText(row, style).width;
    const startX = Math.round(cx - width / 2 + 0.5);
    const startY = top + Math.round((rise * (row.length - 1)) / 2);
    for (let i = 0; i < row.length; i++) {
      const character = row[i];
      if (character === undefined) continue;
      drawText(clip, startX + i * advance, startY - Math.round(rise * i), character, ink, style);
    }
    top += lineHeight;
  }
}

/* -------------------------------------------------------------------------- */
/* Focus                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The ring the canvas draws around whatever the DOM says is focused.
 *
 * Two concentric one-pixel frames, ink outside and paper-light inside, with a
 * two-pixel gap from the control. Two tones rather than one because this ring
 * has to be visible on paper, on a stamped mark and on the dark plate, and any
 * single colour disappears on one of the three. `:focus-visible` on a canvas
 * would draw nothing at all — there is no element to draw it on — which is why
 * this exists and why the caller has to tell the kit what is focused.
 */
export function drawFocusRing(surface: PanelSurface, area: Rect): void {
  const outer: Rect = { x: area.x - 3, y: area.y - 3, width: area.width + 6, height: area.height + 6 };
  const middle: Rect = { x: area.x - 2, y: area.y - 2, width: area.width + 4, height: area.height + 4 };
  frameRect(surface, outer, 'ink');
  frameRect(surface, middle, 'paperLit');
}

/* -------------------------------------------------------------------------- */
/* Controls                                                                   */
/* -------------------------------------------------------------------------- */

export function drawButtonChrome(
  surface: PanelSurface,
  area: Rect,
  pressed = false,
  disabled = false,
): void {
  /*
   * Three states and three materials, not one material at three opacities.
   *
   * The CSS version faded a disabled button to `opacity: 0.4`, which on paper
   * over a dithered forest is a button somebody can still read as available.
   * A cap that is *flat* — no bevel, no light on it — is not a thing a thumb
   * reads as pressable, at any contrast, and it keeps the label above the
   * legibility floor instead of taking it below (D7).
   */
  if (disabled) {
    fillRect(surface, area, 'paperEdge');
    frameRect(surface, area, 'inkSoft');
    return;
  }
  drawBevelBox(surface, area, pressed ? 'paperEdge' : 'paper', pressed ? 'in' : 'out', 'ink');
}

/**
 * A well: a slip of cream stock pressed into whatever it is on.
 *
 * Cream on the dark plate as much as on the page, and that is the decision
 * rather than an oversight. A dark field on a dark plate is a hole, its type
 * is reversed twice over, and the one thing a postcode or an 86-character
 * signature has to be is *legible while it is being typed* (D7). A recessed
 * light slip in a dark case is also exactly what the era's appliances did with
 * the one part of a console you had to read.
 */
export function drawTextWell(surface: PanelSurface, area: Rect, disabled = false): void {
  drawBevelBox(surface, area, disabled ? 'paperShade' : 'paperEdge', 'in', disabled ? 'inkSoft' : 'ink');
}

/**
 * The block caret, where the next character will land.
 *
 * Solid and still. A blinking caret is an animation, and §12's still path is
 * the only path on these panels — the browser's own caret is inside a control
 * at `opacity: 0` and never reaches the screen, so if this did not exist a
 * player typing into a drawn field would have nothing at all telling them
 * where they were.
 */
export function drawCaret(surface: PanelSurface, area: Rect): void {
  fillRect(surface, area, 'stamp');
}

/**
 * A window onto something the game did not draw.
 *
 * Four reticle corners and a sunken ink edge over `night`: the instrument, not
 * the picture. What sits inside it is the caller's own element (see
 * `ApertureBlock`), so the ground here is what shows while a camera is still
 * waking up — which is a dark aperture rather than a hole in the panel.
 */
export function drawAperture(surface: PanelSurface, area: Rect): void {
  if (area.width <= 0 || area.height <= 0) return;
  fillRect(surface, area, 'night');
  frameRect(surface, area, 'ink');
  // A quarter of the shorter side, so the corners read as a frame rather than
  // as four dashes at any size the measure gives us.
  const arm = Math.max(2, Math.floor(Math.min(area.width, area.height) / 5));
  const inset = 2;
  const corners = [
    [area.x + inset, area.y + inset, 1, 1],
    [right(area) - inset - 1, area.y + inset, -1, 1],
    [area.x + inset, bottom(area) - inset - 1, 1, -1],
    [right(area) - inset - 1, bottom(area) - inset - 1, -1, -1],
  ] as const;
  for (const [cx, cy, dx, dy] of corners) {
    for (let i = 0; i < arm; i++) {
      pixel(surface, cx + dx * i, cy, 'amber');
      pixel(surface, cx, cy + dy * i, 'amber');
    }
  }
}

/**
 * A checkbox: a pressed-in well with a struck tick.
 *
 * The tick is `stamp` rather than `ink` and drawn as two strokes of different
 * lengths, because a symmetric tick in the border colour reads as part of the
 * box. `accentColor: TOKENS.stamp` on the CSS input was already making this
 * choice; this is the same choice with the browser's checkbox art removed.
 */
export function drawCheckbox(surface: PanelSurface, area: Rect, checked: boolean, disabled = false): void {
  drawBevelBox(surface, area, checked ? 'paper' : 'paperEdge', 'in', disabled ? 'inkSoft' : 'ink');
  if (!checked) return;
  // Inside the border only, not inside the bevel. A 9x9 well leaves 7x7 of
  // face, and the tick is drawn to exactly that: measuring against the bevel
  // too left five pixels for a seven-pixel mark, and the first settings sheet
  // came out with every box empty and no error anywhere to say why.
  const w = area.width - 2;
  const h = area.height - 2;
  if (w < TICK[0].length || h < TICK.length) return;
  // Authored, not computed. Two Bresenham strokes at this size produce a
  // one-pixel diagonal that reads as a slash — the proof sheet showed a row of
  // checkboxes that all looked struck through rather than ticked. A tick is a
  // *shape* at seven pixels across, and the only way to be sure of a shape
  // that small is to draw it and look at it.
  const scale = Math.max(1, Math.floor(Math.min(w / TICK[0].length, h / TICK.length)));
  const width = TICK[0].length * scale;
  const height = TICK.length * scale;
  const x = area.x + Math.floor((area.width - width) / 2);
  const y = area.y + Math.floor((area.height - height) / 2);
  for (let row = 0; row < TICK.length; row++) {
    const line = TICK[row] ?? '';
    for (let column = 0; column < line.length; column++) {
      if (line[column] !== '#') continue;
      surface.fill(x + column * scale, y + row * scale, scale, scale, 'stamp');
    }
  }
}

/** `#` is ink, `.` is the well. Read it the way the glyphs in `bitmapFont.ts` read. */
const TICK = ['......#', '.....##', '#...##.', '##.##..', '.####..', '..##...'] as const;

/**
 * A slider: a sunk track, a stamped fill, a raised handle.
 *
 * `fraction` is the handle's position on its track, 0 at the left end and 1 at
 * the right — the same number `sliderPosition()` computes in `Settings.tsx`,
 * and deliberately not the value. Three rounds of art grading found a panel
 * whose printed number disagreed with its handle; the way that stays fixed is
 * that the thing that draws the handle is given the handle's position and
 * nothing else, and the readout is a string the caller has already formatted.
 */
/** Returns the handle's rectangle, for a caller that wants to point at it. */
export function drawSlider(surface: PanelSurface, track: Rect, fraction: number, disabled = false): Rect {
  const t = Math.min(1, Math.max(0, fraction));
  const handleWidth = 5;
  const trackY = track.y + Math.floor((track.height - 5) / 2);
  const trackRect: Rect = { x: track.x, y: trackY, width: track.width, height: 5 };
  const edge: PanelInk = disabled ? 'inkSoft' : 'ink';
  drawBevelBox(surface, trackRect, 'paperEdge', 'in', edge);
  const travel = Math.max(0, track.width - handleWidth);
  const filled = Math.round(travel * t);
  if (filled > 0 && !disabled) {
    fillRect(surface, { x: trackRect.x + 2, y: trackY + 2, width: filled, height: 1 }, 'stamp');
  }
  const handle: Rect = {
    x: track.x + filled,
    y: track.y,
    width: handleWidth,
    height: track.height,
  };
  if (disabled) {
    fillRect(surface, handle, 'paperShade');
    frameRect(surface, handle, 'inkSoft');
  } else {
    drawBevelBox(surface, handle, 'paper', 'out', 'ink');
  }
  return handle;
}
