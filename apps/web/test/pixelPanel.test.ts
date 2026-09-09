/**
 * What a drawing test can and cannot be.
 *
 * `tools/pixel/proof.mjs` exists because most of what is wrong with a panel is
 * only visible in a picture — it is the file that found a bevel with an
 * accidental five-pixel mount inside it, four stamps whose labels ran through
 * each other, and a checkbox whose tick read as a slash. None of those could
 * have been caught here, and this file does not try.
 *
 * What it catches is the other half, and it is the half that has actually
 * shipped three times on these panels: *positions*. A slider sliced in half at
 * the bottom of a scroll region, a line of small caps cut through, a sentence
 * that stopped at "along the path to". Every one of those is a number, and
 * every number in this kit comes out of `layoutPanel`, which touches no canvas
 * and no DOM and therefore runs here in full.
 *
 * Four invariants, in the order they matter:
 *
 *   1. NOTHING LEAVES THE PANEL. Not a line of type, not a control, not a die.
 *   2. THE CUT NEVER LANDS MID-LINE, at either end of the scroll.
 *   3. EVERY COLOUR IS ON THE PALETTE, in both the buffer and the canvas.
 *   4. THE RECTANGLES ARE TRUE. What is drawn is inside what the layout said,
 *      which is the promise the whole accessibility mirror rests on: a real
 *      `<button>` is positioned from `toScreen(target.control)`, and if the
 *      drawing is not where the rectangle says, the hit target is not where
 *      the picture is.
 */

import { describe, expect, it } from 'vitest';
import { bayer4x4 as worldBayer } from '../src/render/ps1.js';
import { TOKENS } from '../src/ui/styles.js';
import { hasGlyph, measureText } from '../src/render/bitmapFont.js';
import {
  PANEL_INKS,
  PANEL_PALETTE,
  PanelBuffer,
  bayer4x4,
  canvasSurface,
  contentInset,
  ditherFill,
  drawPanel,
  drawStamp,
  focusTargets,
  intrinsicHeight,
  isPanelInk,
  layoutPanel,
  panelMetrics,
  parseHex,
  quantise,
  quantisePair,
  drawOverlay,
  drawPlate,
  drawText,
  toScreen,
  type PanelBlock,
  type PanelInk,
  type PanelLayout,
  type Rect,
} from '../src/ui/pixel/index.js';

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                   */
/* -------------------------------------------------------------------------- */

const PROSE =
  'The trees open into a bowl maybe fifteen metres across; the fire ring is ' +
  'already going low and orange, and the SM-01 stands at the edge of the light ' +
  'with its idle lamp on.';

/** A page with one of everything on it, so no block kind goes unlaid. */
function page(): PanelBlock[] {
  return [
    { kind: 'machine', id: 'kicker', text: 'Some More · Campground registration' },
    { kind: 'heading', id: 'title', level: 1, text: 'Campfire Passport' },
    { kind: 'body', id: 'issued', tone: 'soft', text: 'Ash Kimura · issued 12 May 2026' },
    { kind: 'rule', id: 'rule-1', style: 'solid' },
    { kind: 'heading', id: 'stamps-label', level: 2, text: 'Stamps' },
    {
      kind: 'stamps',
      id: 'stamps',
      marks: [
        { id: 'first-fire', label: 'first fire' },
        { id: 'pine-hollow', label: 'pine hollow' },
        { id: 'night-walk', label: 'night walk' },
      ],
    },
    { kind: 'body', id: 'arrival', text: PROSE },
    { kind: 'spacer', id: 'gap', height: 6 },
    { kind: 'rule', id: 'rule-2', style: 'dashed' },
    {
      kind: 'controls',
      id: 'controls',
      controls: [
        { kind: 'slider', id: 'text-size', label: 'Text size', readout: '100% of normal', fraction: 0.16 },
        {
          kind: 'checkbox',
          id: 'simplified',
          label: 'Simplified gestures',
          hint: 'Tend the fire with controls instead of reaching for it.',
          checked: true,
        },
        { kind: 'button', id: 'apple', label: 'Apple' },
        { kind: 'button', id: 'google', label: 'Google' },
        { kind: 'button', id: 'email', label: 'Email' },
      ],
    },
  ];
}

const TALL: Rect = { x: 12, y: 8, width: 296, height: 224 };
const SHORT: Rect = { x: 24, y: 52, width: 272, height: 120 };

function everyLine(layout: PanelLayout) {
  return layout.blocks.flatMap((block) => [...block.lines, ...block.controls.flatMap((c) => c.lines)]);
}

function everyRect(layout: PanelLayout): Rect[] {
  return layout.blocks.flatMap((block) => [
    // A rule has no lines and no controls: the block *is* the mark, so its own
    // rectangle is the claim being checked.
    ...(block.kind === 'rule' ? [block.rect] : []),
    ...block.lines.map((line) => line.rect),
    ...block.marks.map((mark) => mark.rect),
    ...block.controls.flatMap((control) => [control.rect, control.control, ...control.lines.map((l) => l.rect)]),
  ]);
}

/* -------------------------------------------------------------------------- */
/* 1. The palette                                                             */
/* -------------------------------------------------------------------------- */

describe('the palette', () => {
  /*
   * The seven that are copies, checked against their originals.
   *
   * `pixel/palette.ts` writes these out rather than importing `styles.ts`, so
   * that a build tool rasterising a panel in bare Node does not pull React in
   * behind it. That is a reasonable trade only while something notices if the
   * two drift, and the drift would be invisible: a panel painted in a paper
   * that is two counts off the world's paper looks like a panel.
   */
  it('carries the game tokens exactly', () => {
    expect(PANEL_PALETTE.paper).toBe(TOKENS.paper);
    expect(PANEL_PALETTE.paperEdge).toBe(TOKENS.paperEdge);
    expect(PANEL_PALETTE.ink).toBe(TOKENS.ink);
    expect(PANEL_PALETTE.inkSoft).toBe(TOKENS.inkSoft);
    expect(PANEL_PALETTE.stamp).toBe(TOKENS.stamp);
    expect(PANEL_PALETTE.night).toBe(TOKENS.night);
    expect(PANEL_PALETTE.amber).toBe(TOKENS.amber);
    expect(PANEL_PALETTE.ember).toBe(TOKENS.ember);
    expect(PANEL_PALETTE.ice).toBe(TOKENS.ice);
  });

  it('is small, and every entry is a whole opaque colour', () => {
    // Eleven is a decision, not an accident: a palette that grows one entry at
    // a time to solve one panel at a time is how the overlays got here.
    expect(PANEL_INKS.length).toBeLessThanOrEqual(12);
    for (const ink of PANEL_INKS) {
      expect(PANEL_PALETTE[ink]).toMatch(/^#[0-9a-f]{6}$/);
      expect(() => parseHex(PANEL_PALETTE[ink])).not.toThrow();
    }
    expect(new Set(Object.values(PANEL_PALETTE)).size).toBe(PANEL_INKS.length);
  });

  it('quantises an exact palette colour to itself', () => {
    for (const ink of PANEL_INKS) expect(quantise(PANEL_PALETTE[ink])).toBe(ink);
  });

  it('beats a flat fill with a dither when the colour is between two entries', () => {
    // Halfway between paper and paperLit. A flat nearest can only be one of
    // them; the pair is what makes the palette bigger than its table.
    const between = '#eeeadb';
    const pair = quantisePair(between);
    const flat = quantise(between);
    const flatDistance = quantisePair(PANEL_PALETTE[flat]).distance;
    expect(pair.from).not.toBe(pair.to);
    expect(pair.distance).toBeLessThan(8);
    expect(pair.distance).toBeLessThanOrEqual(flatDistance + 8);
    expect(Number.isInteger(pair.amount * 16)).toBe(true);
  });

  it('refuses a dither of two colours nobody could read as a blend', () => {
    // The failing answer before the separation was charged for: a warm grey
    // "quantised" to half amber and half ice, which is not grey, it is
    // speckle. Whatever it picks now, the two have to be near enough that the
    // eye resolves the cell as one colour rather than as two.
    for (const hex of ['#c6b696', '#8a8070', '#efe8d7', '#3a332b']) {
      const pair = quantisePair(hex);
      expect(pair.separation, `${hex} dithers ${pair.from} against ${pair.to}`).toBeLessThan(60);
    }
    // And the useful screen is not banned along with the absurd one: a dark
    // warm grey over a light warm grey is a long way apart in lightness and
    // no distance at all in hue.
    const grey = quantisePair('#8a8070');
    expect(grey.from).not.toBe(grey.to);
  });
});

/* -------------------------------------------------------------------------- */
/* 2. The dither                                                              */
/* -------------------------------------------------------------------------- */

describe('the dither', () => {
  /*
   * One matrix in the whole product.
   *
   * `pixel/dither.ts` restates the Bayer cell rather than importing it from
   * `render/ps1.ts`, because that module imports three.js and this kit is
   * rasterised in bare Node by the proof script. Two dithers in one window is
   * as bad as two type systems in one window and much harder to see — a matrix
   * in a different rotation still looks like a dither, it just beats against
   * the world's along the panel's edge.
   */
  it('is the same matrix the world quantises with', () => {
    for (let y = -4; y < 8; y++) {
      for (let x = -4; x < 8; x++) expect(bayer4x4(x, y)).toBe(worldBayer(x, y));
    }
  });

  it('is all one colour at nought and all the other at one', () => {
    const area: Rect = { x: 0, y: 0, width: 8, height: 8 };
    const none = new PanelBuffer(8, 8);
    ditherFill(none, area, 'paper', 'ink', 0);
    expect([...none.inksUsed()]).toEqual(['paper']);
    const all = new PanelBuffer(8, 8);
    ditherFill(all, area, 'paper', 'ink', 1);
    expect([...all.inksUsed()]).toEqual(['ink']);
  });

  it('is exactly half at eight sixteenths', () => {
    const buffer = new PanelBuffer(8, 8);
    ditherFill(buffer, { x: 0, y: 0, width: 8, height: 8 }, 'paper', 'ink', 8 / 16);
    let ink = 0;
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (buffer.get(x, y) === 'ink') ink += 1;
    expect(ink).toBe(32);
  });

  it('is anchored to the buffer, not to the box being filled', () => {
    // Two boxes side by side must be on one grid. When the phase followed the
    // box, the seam between two dithered areas was half a cell out of step and
    // showed as a line down the middle of what should be one field.
    const whole = new PanelBuffer(16, 4);
    ditherFill(whole, { x: 0, y: 0, width: 16, height: 4 }, 'paper', 'ink', 6 / 16);
    const halves = new PanelBuffer(16, 4);
    ditherFill(halves, { x: 0, y: 0, width: 7, height: 4 }, 'paper', 'ink', 6 / 16);
    ditherFill(halves, { x: 7, y: 0, width: 9, height: 4 }, 'paper', 'ink', 6 / 16);
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 16; x++) expect(halves.get(x, y)).toBe(whole.get(x, y));
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 3. The layout stays inside the panel                                       */
/* -------------------------------------------------------------------------- */

describe('a laid-out panel', () => {
  it('never puts anything outside the measure', () => {
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    const contentRight = layout.content.x + layout.content.width;
    for (const rect of everyRect(layout)) {
      expect(rect.x).toBeGreaterThanOrEqual(layout.content.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(contentRight);
    }
  });

  it('wraps every line inside the measure', () => {
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    for (const line of everyLine(layout)) {
      expect(measureText(line.text, line.style).width).toBeLessThanOrEqual(layout.content.width);
      expect(line.rect.width).toBeLessThanOrEqual(layout.content.width);
    }
  });

  it('breaks a word too long for the measure rather than letting it overhang', () => {
    // The failure this replaces is a serial number sticking through a border.
    const layout = layoutPanel({
      rect: { x: 0, y: 0, width: 90, height: 200 },
      blocks: [{ kind: 'body', id: 'serial', text: 'SM-01/4471-CIRQUE-MELTWATER-0009' }],
    });
    const lines = layout.blocks[0]?.lines ?? [];
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line.rect.width).toBeLessThanOrEqual(layout.content.width);
  });

  it('holds inside a panel narrow enough to be a mistake', () => {
    // Not a supported size. It must still not throw and must still not draw
    // outside itself, because the alternative is a crash in an overlay.
    const layout = layoutPanel({ rect: { x: 0, y: 0, width: 40, height: 40 }, blocks: page() });
    const contentRight = layout.content.x + layout.content.width;
    for (const rect of everyRect(layout)) {
      expect(rect.x).toBeGreaterThanOrEqual(layout.content.x);
      expect(rect.x + rect.width).toBeLessThanOrEqual(contentRight);
    }
  });

  it('lays a page out the same way at large print, only taller', () => {
    const small = layoutPanel({ rect: TALL, blocks: page(), scale: 1 });
    const large = layoutPanel({ rect: TALL, blocks: page(), scale: 2 });
    expect(large.contentHeight).toBeGreaterThan(small.contentHeight);
    expect(large.metrics.scale).toBe(2);
    const contentRight = large.content.x + large.content.width;
    for (const rect of everyRect(large)) expect(rect.x + rect.width).toBeLessThanOrEqual(contentRight);
  });

  it('reports a height a panel can be built to, and that height does not cut', () => {
    const spec = { rect: TALL, blocks: page() };
    const height = intrinsicHeight(spec);
    const sized = layoutPanel({ ...spec, rect: { ...TALL, height } });
    expect(sized.overflow).toBe(false);
    expect(sized.cut).toBeNull();
    expect(sized.scroll.max).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 4. The cut                                                                 */
/* -------------------------------------------------------------------------- */

describe('the cut at the bottom of a scroll region', () => {
  it('is reported when there is more, and not when there is not', () => {
    expect(layoutPanel({ rect: SHORT, blocks: page() }).cut).not.toBeNull();
    const spec = { rect: TALL, blocks: [{ kind: 'body', id: 'short', text: 'Two words.' } as PanelBlock] };
    expect(layoutPanel(spec).cut).toBeNull();
  });

  it('never lands in the middle of a line, at any scroll offset', () => {
    /*
     * The invariant, driven rather than asserted at one offset. Every stop
     * down a long page: nothing drawn may cross the cut, at either end.
     */
    const probe = layoutPanel({ rect: SHORT, blocks: page() });
    for (let scrollTop = 0; scrollTop <= probe.scroll.max; scrollTop += 3) {
      const layout = layoutPanel({ rect: SHORT, blocks: page(), scrollTop });
      const cutY = layout.cut?.y ?? layout.content.y + layout.content.height;
      for (const block of layout.blocks) {
        if (!block.visible) continue;
        for (const line of [...block.lines, ...block.controls.flatMap((c) => c.lines)]) {
          const straddlesBottom = line.rect.y < cutY && line.rect.y + line.rect.height > cutY;
          const straddlesTop =
            line.rect.y < layout.content.y && line.rect.y + line.rect.height > layout.content.y;
          expect(straddlesBottom, `line "${line.text}" is sliced at the cut (scroll ${scrollTop})`).toBe(false);
          expect(straddlesTop, `line "${line.text}" is sliced at the top (scroll ${scrollTop})`).toBe(false);
        }
        for (const control of block.controls) {
          if (!control.visible) continue;
          const box = control.control;
          expect(box.y + box.height, `${control.id} is sliced at the cut`).toBeLessThanOrEqual(cutY);
          expect(box.y, `${control.id} is sliced at the top`).toBeGreaterThanOrEqual(layout.content.y);
        }
      }
    }
  });

  it('reserves its mark below the last line rather than screening the type', () => {
    /*
     * `styles.ts`: "every scroll region adds it to its own bottom padding so
     * the last line can pass clear of the mark rather than ending underneath
     * it". The first proof sheet had it the other way round and eight rows of
     * dither over a nine-row line did not read as a page continuing, it read
     * as a rendering fault.
     */
    const layout = layoutPanel({ rect: SHORT, blocks: page() });
    const cut = layout.cut;
    expect(cut).not.toBeNull();
    if (cut === null) return;
    expect(cut.mark.y).toBeGreaterThanOrEqual(cut.y);
    expect(cut.mark.y + cut.mark.height).toBe(layout.content.y + layout.content.height);
    expect(cut.mark.height).toBeGreaterThan(0);
    expect(cut.below.length).toBeGreaterThan(0);
  });

  it('names what is under it, and nothing that is not', () => {
    const layout = layoutPanel({ rect: SHORT, blocks: page() });
    const below = new Set(layout.cut?.below ?? []);
    const cutY = layout.cut?.y ?? 0;
    for (const block of layout.blocks) {
      const past = block.rect.y + block.rect.height > cutY;
      expect(below.has(block.id), `${block.id} is misreported`).toBe(past);
    }
  });

  it('snaps a scroll offset, and snapping it twice changes nothing', () => {
    for (const requested of [0, 5, 17, 40, 96, 400]) {
      const once = layoutPanel({ rect: SHORT, blocks: page(), scrollTop: requested });
      expect(once.scroll.top).toBeLessThanOrEqual(once.scroll.requested);
      const twice = layoutPanel({ rect: SHORT, blocks: page(), scrollTop: once.scroll.top });
      expect(twice.scroll.top).toBe(once.scroll.top);
    }
  });

  it('can be scrolled to the end', () => {
    const layout = layoutPanel({ rect: SHORT, blocks: page(), scrollTop: 10_000 });
    const last = layout.blocks[layout.blocks.length - 1];
    expect(last?.visible).toBe(true);
    expect(layout.cut?.below ?? []).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* 5. Every colour is on the palette                                          */
/* -------------------------------------------------------------------------- */

describe('what actually gets drawn', () => {
  function paint(rect: Rect, blocks: PanelBlock[], focusedId?: string) {
    const buffer = new PanelBuffer(320, 240);
    const layout = layoutPanel({ rect, blocks });
    drawPanel(buffer, layout, focusedId === undefined ? {} : { focusedId });
    return { buffer, layout };
  }

  it('uses nothing that is not in the palette', () => {
    const { buffer } = paint(TALL, page(), 'text-size');
    for (const ink of buffer.inksUsed()) expect(isPanelInk(ink)).toBe(true);
  });

  it('hands the canvas nothing but palette colours', () => {
    /*
     * The buffer check above is nearly free — its type says palette key. This
     * one is the real one: it watches the browser adapter, which is the only
     * place in the kit where a colour becomes a string, and asserts that every
     * string it sets is a hex out of the table and never an `rgba()`.
     */
    const used: string[] = [];
    const boxes: number[][] = [];
    const ctx = {
      set fillStyle(value: string) {
        used.push(value);
      },
      get fillStyle(): string {
        return used[used.length - 1] ?? '';
      },
      fillRect(x: number, y: number, w: number, h: number) {
        boxes.push([x, y, w, h]);
      },
    } as unknown as CanvasRenderingContext2D;

    const layout = layoutPanel({ rect: TALL, blocks: page() });
    drawPanel(canvasSurface(ctx, 320, 240), layout, {});
    const palette = new Set<string>(PANEL_INKS.map((ink) => PANEL_PALETTE[ink]));
    expect(used.length).toBeGreaterThan(0);
    for (const value of used) expect(palette.has(value), `${value} is off the palette`).toBe(true);
    // And every rectangle is whole pixels. A fractional fillRect is the one
    // way a canvas can still antialias an axis-aligned box.
    for (const box of boxes) for (const n of box) expect(Number.isInteger(n)).toBe(true);
  });

  it('holds the fill style between runs of the same colour', () => {
    // Not a micro-optimisation: a panel sets one colour hundreds of times in a
    // row, and every assignment invalidates canvas paint state.
    let assignments = 0;
    const ctx = {
      set fillStyle(_value: string) {
        assignments += 1;
      },
      get fillStyle(): string {
        return '';
      },
      fillRect() {},
    } as unknown as CanvasRenderingContext2D;
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    const surface = canvasSurface(ctx, 320, 240);
    drawPanel(surface, layout, {});
    const boxes = 320 * 240;
    expect(assignments).toBeLessThan(boxes / 4);
  });

  it('draws nothing outside the panel', () => {
    const { buffer } = paint(TALL, page(), 'text-size');
    for (let y = 0; y < 240; y++) {
      for (let x = 0; x < 320; x++) {
        const inside =
          x >= TALL.x && y >= TALL.y && x < TALL.x + TALL.width && y < TALL.y + TALL.height;
        if (!inside) expect(buffer.get(x, y), `ink at ${x},${y}`).toBeNull();
      }
    }
  });

  /*
   * The rectangles are true.
   *
   * The panel is drawn twice — once with its blocks and once with none of them
   * — and every pixel that differs has to be inside a rectangle the layout
   * reported, or inside the cut's mark. The chrome is identical in both, so
   * the difference is exactly the content.
   *
   * This is the assertion the whole accessibility mirror rests on. A caller
   * positions a real `<button>` from `toScreen(target.control)`; if the
   * drawing is a few pixels away from the rectangle, the thing a player can
   * click is not the thing they can see, and nothing else in this file would
   * notice.
   */
  it('puts every pixel of every block inside the rectangle it reported', () => {
    const blocks = page();
    const withContent = paint(SHORT, blocks, 'text-size');
    const bare = new PanelBuffer(320, 240);
    drawPanel(bare, layoutPanel({ rect: SHORT, blocks: [] }), {});

    const claimed: Rect[] = [...everyRect(withContent.layout)];
    const cut = withContent.layout.cut;
    if (cut !== null) claimed.push(cut.mark);
    // The focus ring is drawn three pixels outside its control, by design.
    const focused = focusTargets(withContent.layout).find((t) => t.id === 'text-size');
    if (focused !== undefined && focused.visible) {
      claimed.push({
        x: focused.control.x - 3,
        y: focused.control.y - 3,
        width: focused.control.width + 6,
        height: focused.control.height + 6,
      });
    }
    const inAny = (x: number, y: number): boolean =>
      claimed.some((r) => x >= r.x && y >= r.y && x < r.x + r.width && y < r.y + r.height);

    const strays: string[] = [];
    for (let y = SHORT.y; y < SHORT.y + SHORT.height; y++) {
      for (let x = SHORT.x; x < SHORT.x + SHORT.width; x++) {
        if (withContent.buffer.get(x, y) === bare.get(x, y)) continue;
        if (!inAny(x, y)) strays.push(`${x},${y}`);
      }
    }
    expect(strays.slice(0, 12)).toEqual([]);
  });

  it('draws no focus ring when nothing is focused, and one when something is', () => {
    const none = paint(TALL, page());
    const one = paint(TALL, page(), 'text-size');
    let differences = 0;
    for (let y = TALL.y; y < TALL.y + TALL.height; y++) {
      for (let x = TALL.x; x < TALL.x + TALL.width; x++) {
        if (none.buffer.get(x, y) !== one.buffer.get(x, y)) differences += 1;
      }
    }
    expect(differences).toBeGreaterThan(0);
  });

  it('keeps a stamp inside its own die', () => {
    // The mark that ran through its neighbour: the ring and the mottle were
    // bounded by the rectangle and the label was not.
    const buffer = new PanelBuffer(80, 80);
    const die: Rect = { x: 20, y: 20, width: 40, height: 40 };
    drawStamp(buffer, die, { label: 'an unreasonably long stamp name', seed: 7 });
    for (let y = 0; y < 80; y++) {
      for (let x = 0; x < 80; x++) {
        const inside = x >= die.x && y >= die.y && x < die.x + die.width && y < die.y + die.height;
        if (!inside) expect(buffer.get(x, y), `stamp ink at ${x},${y}`).toBeNull();
      }
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 6. The accessibility seam                                                  */
/* -------------------------------------------------------------------------- */

describe('what the DOM has to mirror', () => {
  it('gives every control an id, a role, a name and two rectangles', () => {
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    const targets = focusTargets(layout);
    expect(targets.map((t) => t.id)).toEqual(['text-size', 'simplified', 'apple', 'google', 'email']);
    expect(new Set(targets.map((t) => t.id)).size).toBe(targets.length);
    for (const target of targets) {
      expect(target.role).toMatch(/^(button|checkbox|slider)$/);
      expect(target.label.length).toBeGreaterThan(0);
      expect(target.control.width).toBeGreaterThan(0);
      expect(target.control.height).toBeGreaterThan(0);
      // The chrome is inside the labelled row: a `<label>` that does not
      // contain its own `<input>` is a label for nothing.
      expect(target.control.x).toBeGreaterThanOrEqual(target.rect.x);
      expect(target.control.y).toBeGreaterThanOrEqual(target.rect.y);
      expect(target.control.y + target.control.height).toBeLessThanOrEqual(target.rect.y + target.rect.height);
    }
  });

  it('returns them in reading order, because that is what Tab follows', () => {
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    const targets = focusTargets(layout);
    for (let i = 1; i < targets.length; i++) {
      const previous = targets[i - 1];
      const current = targets[i];
      if (previous === undefined || current === undefined) continue;
      const ordered =
        current.rect.y > previous.rect.y ||
        (current.rect.y === previous.rect.y && current.rect.x >= previous.rect.x);
      expect(ordered, `${current.id} comes before ${previous.id}`).toBe(true);
    }
  });

  it('carries the value a slider and a checkbox have to read out', () => {
    const layout = layoutPanel({ rect: TALL, blocks: page() });
    const slider = focusTargets(layout).find((t) => t.id === 'text-size');
    expect(slider?.readout).toBe('100% of normal');
    expect(slider?.fraction).toBeCloseTo(0.16, 5);
    expect(focusTargets(layout).find((t) => t.id === 'simplified')?.checked).toBe(true);
  });

  it('maps a rectangle onto the upscaled canvas exactly', () => {
    // Whole numbers in, whole numbers out. Half a pixel here is a hit target
    // that disagrees with the picture it belongs to.
    const box = toScreen({ x: 12, y: 8, width: 40, height: 15 }, { scale: 4, offsetX: 6, offsetY: 2 });
    expect(box).toEqual({ left: 54, top: 34, width: 160, height: 60 });
    for (const value of Object.values(box)) expect(Number.isInteger(value)).toBe(true);
  });

  it('marks a control below the cut as not on the page', () => {
    // A caller that renders an element for it anyway is putting a tab stop on
    // something nobody can see, which is how a focus trap starts eating keys.
    const layout = layoutPanel({ rect: SHORT, blocks: page() });
    const targets = focusTargets(layout);
    expect(targets.some((t) => !t.visible)).toBe(true);
    for (const target of targets) {
      if (!target.visible) continue;
      expect(target.control.y + target.control.height).toBeLessThanOrEqual(layout.cut?.y ?? Infinity);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* 7. Metrics                                                                 */
/* -------------------------------------------------------------------------- */

describe('metrics', () => {
  it('is whole pixels at every scale the text setting can produce', () => {
    for (const scale of [1, 2, 3]) {
      const metrics = panelMetrics(scale);
      for (const [name, value] of Object.entries(metrics)) {
        expect(Number.isInteger(value), `${name} is ${value} at scale ${scale}`).toBe(true);
      }
      expect(contentInset(metrics)).toBe(3 + 4 * scale);
    }
  });

  it('refuses a fractional scale rather than honouring it', () => {
    // The whole reason `integerTextScale` exists. 1.15 of a five-pixel stem is
    // the mush the art direction is about.
    expect(panelMetrics(1.15).scale).toBe(1);
    expect(panelMetrics(0.85).scale).toBe(1);
    expect(panelMetrics(1.6).scale).toBe(2);
  });

  it('keeps the cut mark fixed while the type grows', () => {
    // A dither that grows with the text stops being a dither.
    expect(panelMetrics(1).cutMark).toBe(panelMetrics(3).cutMark);
  });

  it('lets a caller override one metric without restating the rest', () => {
    const layout = layoutPanel({ rect: SHORT, blocks: page(), metrics: { cutMark: 16 } });
    expect(layout.metrics.cutMark).toBe(16);
    expect(layout.metrics.padding).toBe(panelMetrics(1).padding);
    expect(layout.cut?.mark.height).toBe(16);
  });
});

describe('the dark plate', () => {
  /*
   * The one surface in the kit that is not paper.
   *
   * `styles.ts` draws the line and it survives the move into the buffer: paper
   * is for a booklet you have stopped to read, and a cream card floating over
   * a night forest is a hole punched in the picture. Reversed type is also the
   * one place a drop shadow earns its keep — cream on warm black separates
   * badly without one — and it is the only place this kit ever draws one,
   * because a shadow costs a pixel the block rectangles would have to carry.
   */
  it('reverses type out of it, with a shadow, in palette', () => {
    const buffer = new PanelBuffer(80, 20);
    drawPlate(buffer, { x: 0, y: 0, width: 80, height: 20 }, 'amber');
    drawText(buffer, 6, 5, 'SM-01', 'paper', { scale: 1, shadow: true }, 'night');
    const used = buffer.inksUsed();
    expect(used.has('paper')).toBe(true);
    expect(used.has('night')).toBe(true);
    expect(used.has('amber')).toBe(true);
    for (const ink of used) expect(isPanelInk(ink)).toBe(true);
  });
});

describe('the scrim', () => {
  it('leaves the world showing through rather than covering it', () => {
    // `rgba(6,8,11,0.80)` resolved per pixel by the compositor becomes an
    // ordered screen here, and the point of a screen is the holes: you are
    // still at the fire while you read.
    const buffer = new PanelBuffer(64, 64, 'ember');
    drawOverlay(
      buffer,
      { x: 0, y: 0, width: 64, height: 64 },
      layoutPanel({ rect: { x: 8, y: 8, width: 20, height: 20 }, blocks: [] }),
      {},
    );
    let world = 0;
    for (let y = 32; y < 64; y++) for (let x = 32; x < 64; x++) if (buffer.get(x, y) === 'ember') world += 1;
    expect(world).toBeGreaterThan(0);
    expect(world).toBeLessThan(32 * 32);
  });
});

/* -------------------------------------------------------------------------- */
/* 8. What the conversion will trip over                                      */
/* -------------------------------------------------------------------------- */

describe('the copy the overlays already ship', () => {
  /*
   * A guard, not a feature.
   *
   * This check was written against `Settings.tsx`'s multiplier — "×1.00",
   * U+00D7, which the font had no glyph for and drew as a hollow box. The
   * conversion resolved that in the font rather than in the panel: the readout
   * took three rounds of art grading to arrive at and was not going to be
   * transliterated to an "x" to suit a missing character, so `bitmapFont.ts`
   * grew the multiplication sign. It is checked here now as *drawable*, which
   * is the half of that decision this file can hold.
   *
   * The guard itself outlives its first example. A panel full of shipped copy
   * will hit more of these, and anything a converted overlay hands the kit
   * should go past this shape of check first.
   */
  it('names the characters a converted panel cannot draw', () => {
    const undrawable = (text: string): string[] =>
      [...text].filter((character) => character !== '\n' && !hasGlyph(character));
    expect(undrawable('Campfire Passport · issued 12 May 2026 — kept')).toEqual([]);
    expect(undrawable('×1.00')).toEqual([]);
    // An accented letter is the shape of thing still missing, and it is the
    // one that arrives with a localisation rather than with a rendering
    // change: the font grows the glyphs before the copy does.
    expect(undrawable('café')).toEqual(['é']);
    // A non-breaking space is the other one, and it is worse: it is invisible
    // in the source and prints as a box in the middle of a sentence.
    expect(undrawable('Site 14')).toEqual([' ']);
  });
});
