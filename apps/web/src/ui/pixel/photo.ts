/**
 * A photograph, printed.
 *
 * The Passport's photographs are the one thing on these panels that is not
 * type, not chrome and not a mark — they are bytes, made at runtime by photo
 * mode, arriving as a data URL with no palette, no size and no relationship to
 * anything else in the interface. An `<img>` over a drawn panel would have put
 * the whole defect back: a smooth, full-colour, device-resolution rectangle in
 * the middle of a page made of eleven colours and five-pixel letters.
 *
 * So a photograph is *developed* rather than displayed. It is box-filtered
 * down to a print about seventy pixels across, its luminance is mapped onto
 * the panel's own paper-to-ink ramp, and the steps between are ordered-
 * dithered with the same Bayer cell the world quantises with. What comes out
 * is a halftone print in the booklet's ink — which is what a photograph in a
 * campground scrapbook is, and it is the only version of this that can sit on
 * the same page as the type without one of the two looking wrong.
 *
 * Colour is deliberately thrown away. A six-step ramp of warm greys is a
 * duotone and reads as a print; the same six steps chosen by nearest-colour
 * across the whole palette puts `ice` and `amber` into a photograph of a fire
 * and reads as a fault. `palette.ts` already makes this argument about hue
 * against lightness for dithers — the eye averages lightness and does not
 * average hue — and a photograph is the place it bites hardest.
 */

import { bayer4x4 } from './dither.js';
import type { PanelInk } from './palette.js';
import type { PanelSurface, Rect } from './surface.js';
import { bottom, fillRect, frameRect, pixel, right } from './surface.js';

/**
 * The paper-to-ink ramp, darkest first.
 *
 * Six steps and not eleven: these are the entries that differ only in
 * lightness, so a dither between two neighbours reads as one tone. The two
 * ends are the page's own extremes, which is what keeps a print sitting *on*
 * the paper rather than floating over it.
 */
export const PRINT_RAMP: readonly PanelInk[] = Object.freeze([
  'ink',
  'inkSoft',
  'paperShade',
  'paperEdge',
  'paper',
  'paperLit',
]);

/** An `ImageData`, or anything shaped like one. RGBA, row-major. */
export interface PhotoPixels {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray | Uint8Array | readonly number[];
}

/** Rec. 709 luminance, 0..1. The channel weights every other file here uses. */
function luminance(r: number, g: number, b: number): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * The average luminance of the source block one print pixel stands for.
 *
 * A box filter rather than a nearest-neighbour sample, and the difference is
 * not subtle at this reduction: a 512-pixel-wide capture of a dithered world
 * point-sampled down to seventy pixels samples the *dither* — every fourth
 * pixel of an ordered pattern — and comes back as a moiré of the Bayer cell
 * against itself. Averaging the block throws the world's screen away and
 * leaves the tone, which is then screened again on the way onto the paper.
 */
function blockLuma(pixels: PhotoPixels, x0: number, y0: number, x1: number, y1: number): number {
  const left = Math.max(0, Math.min(pixels.width - 1, Math.floor(x0)));
  const top = Math.max(0, Math.min(pixels.height - 1, Math.floor(y0)));
  const rightEdge = Math.max(left + 1, Math.min(pixels.width, Math.ceil(x1)));
  const bottomEdge = Math.max(top + 1, Math.min(pixels.height, Math.ceil(y1)));
  let total = 0;
  let count = 0;
  for (let y = top; y < bottomEdge; y++) {
    const row = y * pixels.width * 4;
    for (let x = left; x < rightEdge; x++) {
      const at = row + x * 4;
      total += luminance(Number(pixels.data[at]), Number(pixels.data[at + 1]), Number(pixels.data[at + 2]));
      count += 1;
    }
  }
  return count === 0 ? 0.5 : total / count;
}

/**
 * The picture itself, into a rectangle of the buffer.
 *
 * Exported on its own so a caller with somewhere else to put a print — the
 * photo-mode viewfinder, one day — gets the same development process rather
 * than a second one that looks similar.
 */
export function developPhoto(surface: PanelSurface, area: Rect, pixels: PhotoPixels): void {
  if (area.width <= 0 || area.height <= 0) return;
  if (pixels.width <= 0 || pixels.height <= 0) return;
  const steps = PRINT_RAMP.length - 1;
  /*
   * Cropped to the print rather than squashed into it.
   *
   * Photo mode captures the render canvas, so a photograph's shape is the
   * shape of the window it was taken in — which on a phone held upright is
   * nothing like the print's. Stretching it is the one thing a photograph must
   * never do to a face or a horizon, so the middle of the frame is taken at
   * the print's own proportions, the way a machine printing a 6x4 off a 3:2
   * negative does.
   */
  const scale = Math.max(area.width / pixels.width, area.height / pixels.height);
  const cropWidth = area.width / scale;
  const cropHeight = area.height / scale;
  const cropX = (pixels.width - cropWidth) / 2;
  const cropY = (pixels.height - cropHeight) / 2;
  const sx = cropWidth / area.width;
  const sy = cropHeight / area.height;
  for (let y = 0; y < area.height; y++) {
    for (let x = 0; x < area.width; x++) {
      const luma = blockLuma(
        pixels,
        cropX + x * sx,
        cropY + y * sy,
        cropX + (x + 1) * sx,
        cropY + (y + 1) * sy,
      );
      const t = Math.min(steps, Math.max(0, luma * steps));
      const low = Math.min(steps - 1, Math.floor(t));
      // The threshold is read at the *buffer's* coordinates, not the print's,
      // so a photograph, the paper's halftone and the scrim behind the whole
      // overlay are all on one grid. Two dither grids half a cell out of step
      // is the seam `dither.ts` exists to prevent.
      const px = area.x + x;
      const py = area.y + y;
      const ink = t - low > bayer4x4(px, py) ? PRINT_RAMP[low + 1] : PRINT_RAMP[low];
      pixel(surface, px, py, ink ?? 'paper');
    }
  }
}

/**
 * A print nobody has the bytes for yet.
 *
 * Not blank, and not an error either: a photograph whose data URL has been
 * dropped because the bytes reached object storage is still a photograph in
 * the booklet, and one still decoding is a photograph that is about to be. A
 * flat grey rectangle reads as a bug; a screened one reads as an undeveloped
 * frame, which is what it is.
 */
export function drawUndeveloped(surface: PanelSurface, area: Rect): void {
  for (let y = area.y; y < bottom(area); y++) {
    for (let x = right(area) - 1; x >= area.x; x--) {
      // A diagonal screen rather than the orthogonal one the paper uses, so
      // an empty frame cannot be mistaken for a patch of the page.
      pixel(surface, x, y, (x + y) % 4 === 0 ? 'paperShade' : 'paperEdge');
    }
  }
}

/**
 * The card the print is mounted on.
 *
 * `paperLit` rather than white, because there is no white on this palette and
 * inventing one for a photo border is exactly the drift `palette.ts` exists to
 * prevent. The card is outlined in `paperShade` so it reads as an object lying
 * on the page rather than as a hole cut in it — the old CSS did that with a
 * drop shadow, which is a thing this palette cannot spell.
 */
export function drawPrintCard(surface: PanelSurface, area: Rect): void {
  fillRect(surface, area, 'paperLit');
  frameRect(surface, area, 'paperShade');
}
