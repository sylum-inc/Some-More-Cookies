/**
 * Painting a laid-out panel, and the one thing the caller still has to do.
 *
 * ## THE DOM IS NOT OPTIONAL
 *
 * A canvas has one node in the accessibility tree and it is the canvas. Draw a
 * checkbox on it and you have drawn a picture of a checkbox: no role, no
 * name, no checked state, no tab stop, no way to operate it without a pointer.
 * `e2e/access.spec.ts` asserts every one of those on these panels — it finds
 * controls by `getByRole('checkbox', { name: /Simplified gestures/ })`, reads
 * "100%" off a slider's own label, presses Tab forty times to prove focus
 * cannot leave the dialog, and presses Escape to prove it comes back. Spec §12
 * says every verb has a keyboard path. None of that survives being drawn.
 *
 * So the end state is three things, and this kit is one of them:
 *
 *   THE CANVAS DRAWS      `drawPanel` here, at the internal resolution,
 *                         upscaled by a whole number with `image-rendering:
 *                         pixelated`.
 *   THE DOM MEANS         a real `<div role="dialog" aria-modal="true">` with
 *                         a real `<button>`, `<input type="checkbox">` and
 *                         `<input type="range">` inside it, one per
 *                         `focusTarget`, positioned over the pixels they stand
 *                         for and painted out.
 *   FOCUS IS MIRRORED     the DOM owns focus; the canvas draws a ring around
 *                         whatever the DOM says has it.
 *
 * ### How to wire it (this is the whole recipe)
 *
 *   1. `const layout = layoutPanel({ rect, blocks, scale, scrollTop })`.
 *   2. `drawPanel(canvasSurface(ctx, w, h), layout, { focusedId })`.
 *   3. For each `focusTargets(layout)` entry, render one real element inside
 *      the dialog, absolutely positioned at `toScreen(target.control, { scale
 *      })` — `<button>` for `role: 'button'`, `<input type="checkbox">` for
 *      `'checkbox'`, `<input type="range">` for `'slider'`. Give it the label
 *      as its accessible name (`aria-label`, or a real `<label>` wrapping it
 *      when the panel's tests read the label's text, as the settings suite
 *      does). Set `checked` / `value` from the same numbers the layout drew.
 *   4. Make those elements invisible without making them absent:
 *      `opacity: 0` and `color: transparent`, **never** `visibility: hidden`,
 *      `display: none`, `aria-hidden`, or a 1x1 clip. Playwright's
 *      `toBeVisible()` and every screen reader agree with each other here — an
 *      element with a real box and zero opacity is present, focusable and
 *      hit-testable; one that is clipped to a pixel is a control nobody can
 *      point at. `SR_ONLY` in `styles.ts` is for text, not for controls.
 *   5. Redraw on `focus`, `blur`, `input` and `change`. The canvas is a
 *      projection of DOM state; if it is not redrawn when that state changes
 *      it is a screenshot of it.
 *   6. Keep the dialog wrapper and `useDialog()` exactly as they are. The
 *      focus trap, the Escape handler and the return of focus to the opener
 *      are DOM behaviour and none of them moves into the buffer.
 *
 * Ordering matters for one thing: the elements must be in reading order in the
 * document, because that is what Tab follows. `focusTargets` returns them in
 * flow order for exactly that reason — render the array as it comes and the
 * tab order is the page's order for free.
 *
 * ### What the caller must not do
 *
 * Do not put the real controls anywhere but on top of what was drawn. A
 * control mirrored somewhere else is a hit target that disagrees with the
 * picture, which is worse than no picture — and `toScreen` exists so that
 * lining them up is arithmetic rather than a guess.
 */

import { drawText, type PanelSurface, type Rect } from './surface.js';
import { clipSurface, fillRect } from './surface.js';
import { ditherGradient, scrim } from './dither.js';
import {
  drawButtonChrome,
  drawCheckbox,
  drawFocusRing,
  drawPaperPanel,
  drawRule,
  drawSlider,
  drawStamp,
  type PaperPanelOptions,
} from './chrome.js';
import { controlById, type LaidOutBlock, type LaidOutLine, type PanelLayout } from './layout.js';
import type { PanelInk } from './palette.js';

export interface DrawPanelOptions extends PaperPanelOptions {
  /**
   * The id of the control the DOM says is focused, from `focusTargets`.
   *
   * Deliberately an input rather than something this module tracks. Focus
   * belongs to the browser; a kit that kept its own idea of it would be a
   * second source of truth, and the first time the two disagreed the ring
   * would be around the wrong control with nothing to say so.
   */
  readonly focusedId?: string | null;
  /** Hash a stamp's id to a seed. Defaults to a small FNV-style hash. */
  readonly stampSeed?: (id: string) => number;
}

/** The same shape of hash `Passport.tsx` uses, so a stamp keeps its identity. */
export function stampSeed(id: string): number {
  let hash = 2166136261;
  for (let index = 0; index < id.length; index++) {
    hash ^= id.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function inkFor(tone: LaidOutLine['tone']): PanelInk {
  return tone === 'soft' ? 'inkSoft' : 'ink';
}

function paintLines(surface: PanelSurface, lines: readonly LaidOutLine[]): void {
  for (const line of lines) {
    if (line.text === '') continue;
    drawText(surface, line.rect.x, line.rect.y, line.text, inkFor(line.tone), line.style);
  }
}

function paintBlock(surface: PanelSurface, block: LaidOutBlock, options: DrawPanelOptions): void {
  paintLines(surface, block.lines);

  if (block.kind === 'rule') {
    const style = block.block.kind === 'rule' ? (block.block.style ?? 'solid') : 'solid';
    drawRule(
      surface,
      block.rect.x,
      block.rect.y,
      block.rect.width,
      style,
      style === 'solid' ? 'ink' : 'inkSoft',
    );
  }

  const seedOf = options.stampSeed ?? stampSeed;
  for (const mark of block.marks) {
    drawStamp(surface, mark.rect, { label: mark.label, seed: seedOf(mark.id) });
  }

  for (const control of block.controls) {
    if (control.kind === 'button') drawButtonChrome(surface, control.control);
    else if (control.kind === 'checkbox') drawCheckbox(surface, control.control, control.checked === true);
    else drawSlider(surface, control.control, control.fraction ?? 0);
    paintLines(surface, control.lines);
  }
}

/**
 * Draws a panel: the page, its contents, the mark at the cut, the focus ring.
 *
 * The content is drawn through a clipped surface rather than a canvas clip
 * path, and only down to the cut — so the two things that could put ink where
 * the layout did not say it would go are both structurally impossible rather
 * than carefully avoided. That is what lets `pixelPanel.test.ts` assert that
 * every pixel of a block lands inside the rectangle the layout reported for it.
 */
export function drawPanel(
  surface: PanelSurface,
  layout: PanelLayout,
  options: DrawPanelOptions = {},
): void {
  drawPaperPanel(surface, layout.panel, options);

  const cutY = layout.cut?.y ?? layout.content.y + layout.content.height;
  const viewport: Rect = {
    x: layout.content.x,
    y: layout.content.y,
    width: layout.content.width,
    height: Math.max(0, cutY - layout.content.y),
  };
  const page = clipSurface(surface, viewport);
  for (const block of layout.blocks) {
    if (!block.visible) continue;
    paintBlock(page, block, options);
  }

  if (layout.cut !== null && layout.cut.mark.height > 0) {
    // A dither, which is the whole point: `styles.ts` records a
    // `linear-gradient` mark that shipped three times and ended one count away
    // from the colour the panel already was. A screen is visible whatever its
    // two colours are, because a reader sees the pattern and not the value.
    //
    // It runs light at the top and heavy at the page's edge, on the reserved
    // paper below the last line rather than across it, so the page reads as
    // going under the edge instead of as type that has been damaged.
    ditherGradient(surface, layout.cut.mark, null, 'paperShade', { start: 2 / 16, end: 15 / 16, axis: 'down' });
  }

  if (options.focusedId != null) {
    const focused = controlById(layout, options.focusedId);
    // Clipped to the page rather than to the scroll viewport: the ring sits
    // three pixels outside its control and would lose a side against the
    // content edge, and a focus ring with a side missing reads as a border.
    if (focused !== undefined && focused.visible) {
      drawFocusRing(clipSurface(surface, layout.panel), focused.control);
    }
  }
}

/**
 * The scrim and the panel, in one call.
 *
 * `viewport` is the whole internal buffer. Nothing is cleared first — the
 * world is behind this and stays behind it, showing through three of every
 * sixteen pixels, which is what `rgba(6,8,11,0.80)` was trying to say.
 */
export function drawOverlay(
  surface: PanelSurface,
  viewport: Rect,
  layout: PanelLayout,
  options: DrawPanelOptions = {},
): void {
  scrim(surface, viewport);
  drawPanel(surface, layout, options);
}

/** A dark plate, for the one panel that is a device readout and not a page. */
export function drawPlate(surface: PanelSurface, area: Rect, rule: PanelInk = 'amber'): void {
  fillRect(surface, area, 'ink');
  fillRect(surface, { x: area.x, y: area.y, width: 3, height: area.height }, rule);
}
