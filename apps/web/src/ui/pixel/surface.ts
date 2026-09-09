/**
 * Somewhere to put a rectangle.
 *
 * The same argument `bitmapFont.ts` makes for its `Plot` type, one level up.
 * These panels have to be drawn by the browser at runtime and by Node at build
 * time — the proof sheet in `tools/pixel/proof.mjs` is the only thing that can
 * tell you a bevel mitres the wrong way — and the only thing a
 * `CanvasRenderingContext2D` and a `Pix` agree on is "put this colour in this
 * box". Everything above this line is therefore testable without a DOM, which
 * is the point: `pixelPanel.test.ts` runs the real drawing code and reads back
 * every pixel it put down.
 *
 * `fill` and not `set`, because a panel is overwhelmingly rectangles and one
 * `fillRect` per rectangle is one call where one per pixel is thousands. Text
 * goes through `blitText`, which is already batched to a font pixel.
 *
 * The parameter is a palette *key*, never a colour string. That is the whole
 * enforcement of `palette.ts`: there is no signature anywhere in this kit that
 * will accept `rgba(255,252,244,0.85)`, so the compositor never gets to invent
 * a colour and the panel cannot drift off the ramp by one accidental wash.
 */

import type { PanelInk } from './palette.js';
import { PANEL_PALETTE } from './palette.js';
import { blitText, type TextMetrics, type TextStyle } from '../../render/bitmapFont.js';

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PanelSurface {
  readonly width: number;
  readonly height: number;
  /** Whole pixels. Anything off the surface is dropped, not clamped. */
  fill(x: number, y: number, width: number, height: number, ink: PanelInk): void;
}

export function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

export function right(r: Rect): number {
  return r.x + r.width;
}

export function bottom(r: Rect): number {
  return r.y + r.height;
}

export function insetRect(r: Rect, by: number): Rect {
  return { x: r.x + by, y: r.y + by, width: Math.max(0, r.width - by * 2), height: Math.max(0, r.height - by * 2) };
}

export function intersectRect(a: Rect, b: Rect): Rect {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  return { x, y, width: Math.max(0, Math.min(right(a), right(b)) - x), height: Math.max(0, Math.min(bottom(a), bottom(b)) - y) };
}

export function containsRect(outer: Rect, inner: Rect): boolean {
  if (inner.width <= 0 || inner.height <= 0) return true;
  return (
    inner.x >= outer.x &&
    inner.y >= outer.y &&
    right(inner) <= right(outer) &&
    bottom(inner) <= bottom(outer)
  );
}

/* -------------------------------------------------------------------------- */
/* Primitives                                                                 */
/* -------------------------------------------------------------------------- */

export function pixel(surface: PanelSurface, x: number, y: number, ink: PanelInk): void {
  surface.fill(x, y, 1, 1, ink);
}

export function fillRect(surface: PanelSurface, r: Rect, ink: PanelInk): void {
  surface.fill(r.x, r.y, r.width, r.height, ink);
}

export function hLine(surface: PanelSurface, x: number, y: number, width: number, ink: PanelInk): void {
  surface.fill(x, y, width, 1, ink);
}

export function vLine(surface: PanelSurface, x: number, y: number, height: number, ink: PanelInk): void {
  surface.fill(x, y, 1, height, ink);
}

/** A one-pixel outline, drawn as four bars so it is four calls and not a loop. */
export function frameRect(surface: PanelSurface, r: Rect, ink: PanelInk): void {
  if (r.width <= 0 || r.height <= 0) return;
  hLine(surface, r.x, r.y, r.width, ink);
  hLine(surface, r.x, bottom(r) - 1, r.width, ink);
  vLine(surface, r.x, r.y, r.height, ink);
  vLine(surface, right(r) - 1, r.y, r.height, ink);
}

/* -------------------------------------------------------------------------- */
/* Clipping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * A view of a surface that cannot draw outside a rectangle.
 *
 * This is how a scroll region is done here, and it is deliberately not
 * `ctx.save()/clip()/restore()`: a canvas clip path is a floating-point region
 * the rasteriser antialiases the edge of, which on a 320x240 buffer upscaled
 * by four is a soft grey line along the exact edge the art direction is about.
 * Intersecting integer rectangles cannot do that.
 *
 * It is also what makes "the block rectangles line up with what is actually
 * drawn" checkable: give the kit a clip of one block's rectangle, draw the
 * whole panel, and anything that lands is inside that block by construction.
 */
export function clipSurface(surface: PanelSurface, clip: Rect): PanelSurface {
  return {
    width: surface.width,
    height: surface.height,
    fill(x, y, width, height, ink) {
      const box = intersectRect({ x, y, width, height }, clip);
      if (box.width <= 0 || box.height <= 0) return;
      surface.fill(box.x, box.y, box.width, box.height, ink);
    },
  };
}

/* -------------------------------------------------------------------------- */
/* An indexed buffer, for Node and for tests                                  */
/* -------------------------------------------------------------------------- */

/**
 * A fixed-size buffer of palette keys.
 *
 * The same idea as `Pix` in `tools/sprites/canvas.mjs` and deliberately not an
 * import of it: that file is a `.mjs` build tool outside every tsconfig in the
 * repo, and `apps/web` cannot take a typed dependency on it without either a
 * declaration file nobody maintains or an `any` in the middle of the one
 * module whose job is to make wrong colours impossible. The proof script
 * copies this into a real `Pix` in about eight lines, which is the cheaper
 * direction for the coupling to run.
 */
export class PanelBuffer implements PanelSurface {
  readonly width: number;
  readonly height: number;
  private readonly data: (PanelInk | null)[];

  constructor(width: number, height: number, ground: PanelInk | null = null) {
    this.width = Math.max(0, Math.floor(width));
    this.height = Math.max(0, Math.floor(height));
    this.data = new Array<PanelInk | null>(this.width * this.height).fill(ground);
  }

  fill(x: number, y: number, width: number, height: number, ink: PanelInk): void {
    const x0 = Math.max(0, Math.round(x));
    const y0 = Math.max(0, Math.round(y));
    const x1 = Math.min(this.width, Math.round(x) + Math.round(width));
    const y1 = Math.min(this.height, Math.round(y) + Math.round(height));
    for (let py = y0; py < y1; py++) {
      const row = py * this.width;
      for (let px = x0; px < x1; px++) this.data[row + px] = ink;
    }
  }

  get(x: number, y: number): PanelInk | null {
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return this.data[y * this.width + x] ?? null;
  }

  /** Every key present, for "is any of this off the palette" checks. */
  inksUsed(): Set<PanelInk> {
    const used = new Set<PanelInk>();
    for (const ink of this.data) if (ink !== null) used.add(ink);
    return used;
  }
}

/* -------------------------------------------------------------------------- */
/* The browser adapter                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The surface the game actually draws on.
 *
 * The canvas is the *internal* buffer — 320x240 at the mid quality tier — and
 * the element it belongs to is upscaled by a whole number with
 * `image-rendering: pixelated`, exactly as the world's own buffer is. Drawing
 * the panel at device resolution and letting CSS scale the type is the defect
 * being fixed, so nothing in this kit ever sees a device pixel.
 *
 * `fillStyle` is a string assignment that invalidates paint state, and a panel
 * sets the same colour hundreds of times in a row (a paper ground, then a
 * halftone, then a run of ink for a paragraph). Holding the last value turns
 * that back into one assignment per colour run.
 */
export function canvasSurface(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
): PanelSurface {
  let current: PanelInk | null = null;
  return {
    width,
    height,
    fill(x, y, w, h, ink) {
      if (w <= 0 || h <= 0) return;
      if (ink !== current) {
        ctx.fillStyle = PANEL_PALETTE[ink];
        current = ink;
      }
      ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h));
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Type                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * `blitText` onto a surface, in one palette colour.
 *
 * No drop shadow on paper, ever, and that is a decision rather than an
 * omission. A shadow costs a pixel of width and a pixel of height that the
 * metrics then have to carry, and every rectangle this kit reports would have
 * to reserve it — which is the difference between "the block rectangle is what
 * was drawn" being true and being nearly true. Reversed type on the dark plate
 * is where a shadow earns its keep; pass `shadow` there and the caller gets it.
 */
export function drawText(
  surface: PanelSurface,
  x: number,
  y: number,
  text: string,
  ink: PanelInk,
  style: TextStyle = {},
  shadowInk?: PanelInk,
): TextMetrics {
  return blitText(
    (px, py, layer) => {
      if (layer === 'shadow') {
        if (shadowInk !== undefined) pixel(surface, px, py, shadowInk);
        return;
      }
      pixel(surface, px, py, ink);
    },
    x,
    y,
    text,
    shadowInk === undefined ? { ...style, shadow: null } : style,
  );
}
