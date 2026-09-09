/**
 * Ordered dithering, on paper.
 *
 * There are no smooth ramps in this game. The world's fragment shader ends by
 * quantising every channel against a 4x4 Bayer threshold (`render/ps1.ts`),
 * the sprites fade with `Pix.dither`, and the reason the overlays read as a
 * different product is partly that they were the one surface with real
 * gradients on it — three `radial-gradient`s and two `repeating-linear-
 * gradient`s on the Passport alone, every one of them a continuous ramp the
 * compositor evaluates in floating point.
 *
 * So every gradient the kit can draw is made here, out of two palette entries
 * and a threshold, and it is deliberately the *same* matrix as the shader
 * rather than a second one that looks similar. `pixelPanel.test.ts` asserts
 * the two agree cell for cell: two dither patterns in one window is the same
 * category of mistake as two type systems in one window, and it is much harder
 * to see, because a 4x4 matrix in a different rotation still looks like a
 * dither — it just beats against the world's at the panel's edge.
 */

import type { PanelInk } from './palette.js';
import type { PanelSurface, Rect } from './surface.js';
import { bottom, pixel, right } from './surface.js';

/**
 * The threshold matrix, from `render/ps1.ts`.
 *
 * Restated rather than imported: `ps1.ts` imports three.js at module scope, so
 * importing `bayer4x4` from it would put a WebGL library inside a module the
 * proof script rasterises in bare Node, and inside every unit test that draws
 * a panel. The test locks the two copies together instead, which costs one
 * assertion and catches the only thing that can go wrong here.
 */
export const BAYER_4X4: readonly (readonly number[])[] = Object.freeze([
  Object.freeze([0, 8, 2, 10]),
  Object.freeze([12, 4, 14, 6]),
  Object.freeze([3, 11, 1, 9]),
  Object.freeze([15, 7, 13, 5]),
]);

/** Threshold for a pixel, 0..15/16. Mirrors `ps1.bayer4x4` exactly. */
export function bayer4x4(x: number, y: number): number {
  const row = BAYER_4X4[((y % 4) + 4) % 4];
  return (row?.[((x % 4) + 4) % 4] ?? 0) / 16;
}

/**
 * A flat two-colour dither across a rectangle.
 *
 * `amount` is how much of `to` shows: 0 is all `from`, 1 is all `to`, and the
 * fourteen useful values in between are the sixteen thresholds of the cell.
 *
 * The phase is in *surface* coordinates, not rectangle coordinates. That is
 * load-bearing and was got wrong once already in this repo's CSS: a dither
 * whose origin moves with the box it is filling makes a visible seam wherever
 * two dithered boxes meet, because the two checkerboards are half a cell out
 * of step. Anchoring every dither in this kit to the buffer means the panel,
 * its scroll fade and the scrim behind it are all on one grid — the same grid
 * the world behind them is on.
 */
export function ditherFill(
  surface: PanelSurface,
  area: Rect,
  from: PanelInk | null,
  to: PanelInk,
  amount: number,
): void {
  const clamped = Math.min(1, Math.max(0, amount));
  for (let y = area.y; y < bottom(area); y++) {
    for (let x = area.x; x < right(area); x++) {
      const ink = clamped > bayer4x4(x, y) ? to : from;
      if (ink !== null) pixel(surface, x, y, ink);
    }
  }
}

export type DitherAxis = 'down' | 'up' | 'right' | 'left';

export interface DitherGradient {
  /** Where the ramp starts, 0..1 of `to`. Default 0. */
  readonly start?: number;
  /** Where it ends. Default 1. */
  readonly end?: number;
  /** Which way it runs. Default 'down'. */
  readonly axis?: DitherAxis;
}

/**
 * A ramp between two palette entries, one Bayer cell at a time.
 *
 * This is the fade at a scroll cut, and it is the one piece of the kit that
 * exists because of a specific shipped bug. `styles.ts` records it: the fade
 * that was supposed to mark the cut ran from `paper` to `paperEdge`, which is
 * the colour the panel already is by the time it reaches its own bottom —
 * rgb(214,202,176) against rgb(214,203,177), "a fade that renders and says
 * nothing". A dither cannot fail that way. At nine sixteenths of `inkSoft`
 * over paper there is visibly a screen over the type whatever the two end
 * colours happen to be, because the mark is a *pattern* and not a value.
 */
export function ditherGradient(
  surface: PanelSurface,
  area: Rect,
  from: PanelInk | null,
  to: PanelInk,
  options: DitherGradient = {},
): void {
  const start = options.start ?? 0;
  const end = options.end ?? 1;
  const axis = options.axis ?? 'down';
  const span = axis === 'down' || axis === 'up' ? area.height : area.width;
  if (span <= 0) return;
  for (let y = area.y; y < bottom(area); y++) {
    for (let x = area.x; x < right(area); x++) {
      const along =
        axis === 'down'
          ? (y - area.y) / span
          : axis === 'up'
            ? (bottom(area) - 1 - y) / span
            : axis === 'right'
              ? (x - area.x) / span
              : (right(area) - 1 - x) / span;
      const amount = start + (end - start) * along;
      const ink = Math.min(1, Math.max(0, amount)) > bayer4x4(x, y) ? to : from;
      if (ink !== null) pixel(surface, x, y, ink);
    }
  }
}

/**
 * The printed dot screen the paper is stocked with.
 *
 * `.sm-panel` gets this from two crossed `repeating-linear-gradient`s at a 3px
 * pitch, which is a grid of *lines* at 5.5% alpha — about half the panel,
 * barely tinted. Half the panel barely tinted is not available here: the
 * nearest tint the palette has is a whole step to `paperEdge`, and half a
 * panel of it is a grey page. One dot in nine at that step is the same
 * apparent weight, and it is what a booklet screened at this size would
 * actually be. The pitch is 3 rather than 2 because a 2px screen at the same
 * frequency as the bevel makes the two beat against each other.
 */
export function halftone(surface: PanelSurface, area: Rect, dot: PanelInk, pitch = 3): void {
  for (let y = area.y; y < bottom(area); y++) {
    if (((y % pitch) + pitch) % pitch !== 0) continue;
    for (let x = area.x; x < right(area); x++) {
      if (((x % pitch) + pitch) % pitch === 0) pixel(surface, x, y, dot);
    }
  }
}

/**
 * The wash behind an overlay.
 *
 * `.sm-overlay` is `rgba(6,8,11,0.80)` over the world, which the compositor
 * resolves per pixel into eighty per cent of a colour it invents. A handheld
 * of this era had no such move and did the thing this does instead: it drew
 * the pause colour through an ordered screen, so the world stayed visible in
 * the holes. Thirteen sixteenths is the closest cell to that eighty per cent,
 * and it is deliberately not sixteen — an opaque scrim is a cut to another
 * screen, and the whole grammar of this interface is that you are still at the
 * fire while you read.
 */
export function scrim(surface: PanelSurface, area: Rect, ink: PanelInk = 'night', amount = 13 / 16): void {
  ditherFill(surface, area, null, ink, amount);
}
