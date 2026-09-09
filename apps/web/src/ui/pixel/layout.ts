/**
 * Where everything goes, worked out without a canvas.
 *
 * This is the half of the kit that can be checked. A drawing function is only
 * ever as trustworthy as somebody looking at its output, and the three things
 * that have actually gone wrong on these panels — a slider sliced in half at
 * the bottom of a scroll region, a line of small caps cut through the middle,
 * a sentence that stopped at "along the path to" — are all *positions*. So
 * positions are computed here, returned as data, and asserted on in
 * `apps/web/test/pixelPanel.test.ts`; `panel.ts` does nothing but paint what
 * this returns.
 *
 * It is also what makes the swap-over safe. Somebody converting `Passport.tsx`
 * can call `layoutPanel` with the blocks they are about to draw and read back
 * the rectangle of every heading, paragraph and control before a single pixel
 * is committed — including which of them fall below the cut.
 *
 * ## Atoms, and why the cut cannot land mid-line
 *
 * The flow is a stack of *atoms*: horizontal bands that must not be sliced. A
 * line of type is one, a row of buttons is one, a slider's whole row is one, a
 * rule is one. They are contiguous, they are in order and none of them
 * overlaps another vertically — which is the property that makes the cut safe
 * rather than nearly safe. The cut is placed at the bottom edge of the last
 * atom that fits, so there is no y it could take that passes through anything,
 * and a scroll offset snaps to an atom's top edge for the same reason at the
 * other end.
 *
 * The cost is a few unused pixels at the bottom of a scrolled panel. That is
 * the correct trade: a reader can see that a page continues, and cannot
 * un-see a letter cut in half.
 */

import {
  CELL_HEIGHT,
  integerTextScale,
  measureText,
  wrapText,
  type TextStyle,
} from '../../render/bitmapFont.js';
import type { Rect } from './surface.js';
import { bottom } from './surface.js';

/* -------------------------------------------------------------------------- */
/* Metrics                                                                    */
/* -------------------------------------------------------------------------- */

export interface PanelMetrics {
  /** Whole font pixels per glyph pixel for body type. See `integerTextScale`. */
  readonly scale: number;
  /** The page's hard border. One pixel, always. */
  readonly border: number;
  /** The mitred bevel inside it. Two pixels, always. */
  readonly bevel: number;
  /** Paper between the bevel and the first word. */
  readonly padding: number;
  /** One line of body type to the next. */
  readonly lineHeight: number;
  /** Height of one line's ink. */
  readonly lineInk: number;
  readonly paragraphGap: number;
  readonly headingGapAbove: number;
  readonly headingGapBelow: number;
  readonly ruleGap: number;
  readonly controlGap: number;
  readonly buttonPadX: number;
  readonly buttonHeight: number;
  readonly checkboxSize: number;
  readonly checkboxGap: number;
  readonly sliderHeight: number;
  readonly stampSize: number;
  readonly stampGap: number;
  /** How deep the dithered fade at a scroll cut is. */
  readonly cutMark: number;
}

/**
 * Metrics for a text scale.
 *
 * Everything is a whole number of buffer pixels at every scale, which is only
 * possible because the scale itself is a whole number — `integerTextScale`
 * exists so that the accessibility slider cannot ask for 1.15 here. The gaps
 * are multiples of the scale rather than fixed, so large print gets a
 * proportionally airier page instead of the same page with bigger type jammed
 * into it.
 *
 * The exception is `cutMark`, which is fixed. `styles.ts` gives the reason and
 * it survives the move into the buffer unchanged: the mark is a printed
 * dither, and a dither that grows with the type stops being a dither.
 */
export function panelMetrics(scale = 1): PanelMetrics {
  // `integerTextScale` rather than a rounding of our own. It is the font's
  // rule about what the accessibility slider is allowed to mean, it has the
  // argument for the floor written next to it, and a panel that rounded the
  // same setting differently from the type inside it would be a panel whose
  // padding and whose words disagreed about how large the page is.
  const s = integerTextScale(scale);
  return {
    scale: s,
    border: 1,
    bevel: 2,
    padding: 4 * s,
    lineHeight: (CELL_HEIGHT + 1) * s,
    lineInk: CELL_HEIGHT * s,
    paragraphGap: 4 * s,
    headingGapAbove: 6 * s,
    headingGapBelow: 3 * s,
    ruleGap: 4 * s,
    controlGap: 4 * s,
    buttonPadX: 4 * s,
    buttonHeight: CELL_HEIGHT * s + 6,
    checkboxSize: CELL_HEIGHT * s,
    checkboxGap: 4 * s,
    sliderHeight: CELL_HEIGHT * s,
    stampSize: 48 * s,
    stampGap: 6 * s,
    cutMark: 8,
  };
}

/** Border + bevel + padding: how far the first word is from the panel's edge. */
export function contentInset(metrics: PanelMetrics): number {
  return metrics.border + metrics.bevel + metrics.padding;
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

export type PanelTone = 'ink' | 'soft';

export interface HeadingBlock {
  readonly kind: 'heading';
  readonly id: string;
  readonly text: string;
  /** 1 is the page's title, drawn a scale larger. 2 is a section label. */
  readonly level?: 1 | 2;
}

export interface BodyBlock {
  readonly kind: 'body';
  readonly id: string;
  readonly text: string;
  readonly tone?: PanelTone;
}

/** Small monospaced capitals: what the SM-01 or the sky is reporting. */
export interface MachineBlock {
  readonly kind: 'machine';
  readonly id: string;
  readonly text: string;
}

export interface RuleBlock {
  readonly kind: 'rule';
  readonly id: string;
  readonly style?: 'solid' | 'hair' | 'dashed';
}

export interface SpacerBlock {
  readonly kind: 'spacer';
  readonly id: string;
  readonly height: number;
}

export interface StampMark {
  readonly id: string;
  readonly label: string;
}

export interface StampsBlock {
  readonly kind: 'stamps';
  readonly id: string;
  readonly marks: readonly StampMark[];
}

export interface ButtonControl {
  readonly kind: 'button';
  readonly id: string;
  readonly label: string;
}

export interface CheckboxControl {
  readonly kind: 'checkbox';
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
}

export interface SliderControl {
  readonly kind: 'slider';
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  /** Already formatted by the caller: "×1.00", "100%", "Off". */
  readonly readout: string;
  /** The handle's position on its track, 0..1 — not the value. */
  readonly fraction: number;
}

export type PanelControl = ButtonControl | CheckboxControl | SliderControl;

export interface ControlsBlock {
  readonly kind: 'controls';
  readonly id: string;
  readonly controls: readonly PanelControl[];
}

export type PanelBlock =
  | HeadingBlock
  | BodyBlock
  | MachineBlock
  | RuleBlock
  | SpacerBlock
  | StampsBlock
  | ControlsBlock;

/* -------------------------------------------------------------------------- */
/* Results                                                                    */
/* -------------------------------------------------------------------------- */

export interface LaidOutLine {
  readonly text: string;
  readonly rect: Rect;
  readonly tone: PanelTone;
  readonly style: TextStyle;
}

export interface LaidOutControl {
  readonly id: string;
  readonly kind: PanelControl['kind'];
  readonly role: 'button' | 'checkbox' | 'slider';
  readonly label: string;
  readonly hint?: string;
  /**
   * The whole labelled row. This is what a `<label>` covers in the mirrored
   * DOM, and what a pointer should hit.
   */
  readonly rect: Rect;
  /**
   * The chrome itself — the button box, the checkbox well, the slider track.
   * This is what the focus ring goes around and where the real `<input>` sits.
   */
  readonly control: Rect;
  readonly checked?: boolean;
  readonly readout?: string;
  readonly fraction?: number;
  /**
   * The control's own type — its label, its hint, its readout — already
   * wrapped and placed.
   *
   * Here rather than re-wrapped by the painter, because a label measured twice
   * is a label that can be measured differently twice: the row would be sized
   * from one wrap and drawn from another, and the overflow the tests check for
   * would be exactly the thing they could no longer see.
   */
  readonly lines: readonly LaidOutLine[];
  readonly visible: boolean;
}

export interface LaidOutMark {
  readonly id: string;
  readonly label: string;
  readonly rect: Rect;
}

export interface LaidOutBlock {
  readonly id: string;
  readonly kind: PanelBlock['kind'];
  readonly block: PanelBlock;
  /** Surface coordinates, already offset by the scroll. */
  readonly rect: Rect;
  readonly lines: readonly LaidOutLine[];
  readonly controls: readonly LaidOutControl[];
  readonly marks: readonly LaidOutMark[];
  /** Wholly above the cut and below the top of the viewport. */
  readonly visible: boolean;
}

export interface PanelCut {
  /** Surface row where drawing stops. Always an atom's bottom edge. */
  readonly y: number;
  /** The dithered band, in reserved paper below `y`, flush with the page's bottom. */
  readonly mark: Rect;
  /** Ids of blocks with anything at or below the cut. */
  readonly below: readonly string[];
}

export interface PanelLayout {
  readonly panel: Rect;
  /** The scroll viewport: inside the border, the bevel and the padding. */
  readonly content: Rect;
  readonly blocks: readonly LaidOutBlock[];
  /** Height the flow wants, whether or not it got it. */
  readonly contentHeight: number;
  readonly overflow: boolean;
  readonly scroll: {
    /** The offset actually used, snapped to an atom's top edge. */
    readonly top: number;
    readonly max: number;
    readonly requested: number;
  };
  readonly cut: PanelCut | null;
  readonly metrics: PanelMetrics;
}

export interface PanelSpec {
  readonly rect: Rect;
  readonly blocks: readonly PanelBlock[];
  readonly scale?: number;
  readonly scrollTop?: number;
  /** Override any metric; mostly for tests and for the proof sheet. */
  readonly metrics?: Partial<PanelMetrics>;
}

/* -------------------------------------------------------------------------- */
/* Type styles                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Prose is packed to its ink; machine text is not.
 *
 * Straight out of `bitmapFont.ts`: the HUD's machine text wants a column grid
 * because digits that change width as they count are worse than digits that
 * are too wide, and prose wants the fifth of the line back that `i l t` and
 * the punctuation are wasting. A passport is both — a page of writing with a
 * provenance receipt on it — so both are here rather than one compromise.
 */
export function bodyStyle(metrics: PanelMetrics): TextStyle {
  return { scale: metrics.scale, proportional: true };
}

export function machineStyle(metrics: PanelMetrics): TextStyle {
  return { scale: metrics.scale, tracking: 2 * metrics.scale };
}

export function headingStyle(metrics: PanelMetrics, level: 1 | 2): TextStyle {
  if (level === 1) return { scale: metrics.scale + 1, proportional: true };
  return { scale: metrics.scale, tracking: 2 * metrics.scale };
}

function lineHeightFor(style: TextStyle, metrics: PanelMetrics): number {
  return (CELL_HEIGHT + 1) * (style.scale ?? metrics.scale);
}

function inkHeightFor(style: TextStyle, metrics: PanelMetrics): number {
  return CELL_HEIGHT * (style.scale ?? metrics.scale);
}

/* -------------------------------------------------------------------------- */
/* The flow                                                                   */
/* -------------------------------------------------------------------------- */

interface Atom {
  readonly top: number;
  readonly bottom: number;
}

interface FlowBlock {
  readonly id: string;
  readonly kind: PanelBlock['kind'];
  readonly block: PanelBlock;
  readonly rect: Rect;
  readonly lines: LaidOutLine[];
  readonly controls: Omit<LaidOutControl, 'visible'>[];
  readonly marks: LaidOutMark[];
}

/** Text laid out in content-relative coordinates, one atom per line. */
function flowText(
  text: string,
  width: number,
  style: TextStyle,
  metrics: PanelMetrics,
  tone: PanelTone,
  top: number,
  atoms: Atom[],
): { lines: LaidOutLine[]; height: number } {
  const wrapped = wrapText(text, width, style);
  const lineHeight = lineHeightFor(style, metrics);
  const ink = inkHeightFor(style, metrics);
  const lines: LaidOutLine[] = [];
  let y = top;
  for (const line of wrapped) {
    const size = measureText(line, style);
    lines.push({ text: line, rect: { x: 0, y, width: size.width, height: ink }, tone, style });
    atoms.push({ top: y, bottom: y + ink });
    y += lineHeight;
  }
  // The trailing leading of the last line is not part of the block: a block
  // that carries it double-counts every gap between blocks, and a page of
  // fourteen paragraphs ends up an inch shorter than the numbers say.
  const height = wrapped.length === 0 ? 0 : y - top - (lineHeight - ink);
  return { lines, height };
}

function flowControls(
  block: ControlsBlock,
  width: number,
  metrics: PanelMetrics,
  top: number,
  atoms: Atom[],
): { controls: Omit<LaidOutControl, 'visible'>[]; height: number } {
  const controls: Omit<LaidOutControl, 'visible'>[] = [];
  const style = bodyStyle(metrics);
  const lineHeightBase = lineHeightFor(style, metrics);
  const inkHeight = inkHeightFor(style, metrics);
  let y = top;
  let rowX = 0;
  let rowTop = y;
  let rowHeight = metrics.buttonHeight;
  let rowStart = 0;
  let rowOpen = false;

  /*
   * Buttons in a row are all as tall as the tallest, which is why the row is
   * closed rather than simply advanced past.
   *
   * A row of buttons where one has wrapped to two lines and the others have
   * not is a row of buttons at three different heights, and that reads as a
   * layout accident rather than as a set of choices.
   */
  const closeRow = (): void => {
    if (!rowOpen) return;
    for (let index = rowStart; index < controls.length; index++) {
      const entry = controls[index];
      if (entry === undefined) continue;
      const box: Rect = { ...entry.control, height: rowHeight };
      const inkBlock = entry.lines.length * lineHeightBase - (lineHeightBase - inkHeight);
      const shift = Math.floor((rowHeight - inkBlock) / 2) - (entry.lines[0]?.rect.y ?? 0) + box.y;
      controls[index] = {
        ...entry,
        rect: box,
        control: box,
        lines: entry.lines.map((line) => ({ ...line, rect: { ...line.rect, y: line.rect.y + shift } })),
      };
    }
    atoms.push({ top: rowTop, bottom: rowTop + rowHeight });
    y = rowTop + rowHeight + metrics.controlGap;
    rowX = 0;
    rowHeight = metrics.buttonHeight;
    rowOpen = false;
  };

  for (const control of block.controls) {
    if (control.kind === 'button') {
      /*
       * The label is wrapped to the box, not merely measured against it.
       *
       * Centring an unwrapped label inside a box too small for it puts the
       * text at a negative offset: on a narrow panel the first proof of this
       * reported a line starting three pixels to the *left* of the page, which
       * is both outside the panel and — worse — reported by the layout as
       * being inside it, so a mirrored `<button>` would have been placed there
       * too.
       */
      const room = Math.max(1, width - metrics.buttonPadX * 2 - 2);
      const wrapped = wrapText(control.label, room, style);
      let labelWidth = 0;
      for (const line of wrapped) labelWidth = Math.max(labelWidth, measureText(line, style).width);
      const boxWidth = Math.min(width, labelWidth + metrics.buttonPadX * 2 + 2);
      const boxHeight = Math.max(
        metrics.buttonHeight,
        wrapped.length * lineHeightBase - (lineHeightBase - inkHeight) + 6,
      );
      if (rowOpen && rowX + boxWidth > width) closeRow();
      if (!rowOpen) {
        rowTop = y;
        rowStart = controls.length;
        rowHeight = metrics.buttonHeight;
        rowOpen = true;
      }
      rowHeight = Math.max(rowHeight, boxHeight);
      const box: Rect = { x: rowX, y: rowTop, width: boxWidth, height: boxHeight };
      let lineY = box.y + 3;
      controls.push({
        id: control.id,
        kind: 'button',
        role: 'button',
        label: control.label,
        rect: box,
        control: box,
        lines: wrapped.map((text) => {
          const measured = measureText(text, style).width;
          const line: LaidOutLine = {
            text,
            rect: {
              x: box.x + Math.max(0, Math.floor((box.width - measured) / 2)),
              y: lineY,
              width: measured,
              height: inkHeight,
            },
            tone: 'ink',
            style,
          };
          lineY += lineHeightBase;
          return line;
        }),
      });
      rowX += boxWidth + metrics.controlGap;
      continue;
    }

    closeRow();

    if (control.kind === 'checkbox') {
      const labelLeft = metrics.checkboxSize + metrics.checkboxGap;
      const labelWidth = width - labelLeft;
      const label = wrapText(control.label, Math.max(1, labelWidth), style);
      const hint = control.hint === undefined ? [] : wrapText(control.hint, Math.max(1, labelWidth), style);
      const lineHeight = lineHeightFor(style, metrics);
      const ink = inkHeightFor(style, metrics);
      const textHeight =
        label.length * lineHeight + hint.length * lineHeight -
        (label.length + hint.length > 0 ? lineHeight - ink : 0);
      const height = Math.max(metrics.checkboxSize, textHeight);
      const row: Rect = { x: 0, y, width, height };
      const lines: LaidOutLine[] = [];
      let textY = y;
      for (const text of label) {
        lines.push({ text, rect: { x: labelLeft, y: textY, width: measureText(text, style).width, height: ink }, tone: 'ink', style });
        textY += lineHeight;
      }
      for (const text of hint) {
        lines.push({ text, rect: { x: labelLeft, y: textY, width: measureText(text, style).width, height: ink }, tone: 'soft', style });
        textY += lineHeight;
      }
      controls.push({
        id: control.id,
        kind: 'checkbox',
        role: 'checkbox',
        label: control.label,
        ...(control.hint === undefined ? {} : { hint: control.hint }),
        rect: row,
        control: { x: 0, y, width: metrics.checkboxSize, height: metrics.checkboxSize },
        checked: control.checked,
        lines,
      });
      atoms.push({ top: y, bottom: y + height });
      y += height + metrics.controlGap;
      continue;
    }

    // A slider row: the label and its readout on one line, an optional hint
    // under it, then the track. The readout is right-aligned on the label's
    // line because that is where `Settings.tsx` puts it and because a number
    // under its own label reads as a second setting.
    const lineHeight = lineHeightFor(style, metrics);
    const ink = inkHeightFor(style, metrics);
    const readoutWidth = measureText(control.readout, style).width;
    /*
     * The readout sits beside the label until it cannot.
     *
     * On a panel narrow enough that "100% of normal" is wider than the whole
     * measure, right-aligning it put a 77-pixel line at x=0 of a 26-pixel
     * column — outside the panel, through the border, and reported by the
     * layout as if it were inside. It drops to its own line instead, still
     * right-aligned, which is what a printed spec sheet does with a value too
     * long for its column.
     */
    const beside = readoutWidth + metrics.controlGap <= width;
    const labelWidth = beside ? width - readoutWidth - metrics.controlGap : width;
    const label = wrapText(control.label, Math.max(1, labelWidth), style);
    const readout = beside ? [control.readout] : wrapText(control.readout, Math.max(1, width), style);
    const hint = control.hint === undefined ? [] : wrapText(control.hint, Math.max(1, width), style);
    const headLines = label.length + (beside ? 0 : readout.length);
    const headHeight = headLines * lineHeight - (lineHeight - ink);
    const hintHeight = hint.length === 0 ? 0 : hint.length * lineHeight - (lineHeight - ink);
    const trackTop = y + headHeight + (hint.length === 0 ? 0 : Math.round(metrics.controlGap / 2) + hintHeight) + 3;
    const height = trackTop + metrics.sliderHeight - y;
    const row: Rect = { x: 0, y, width, height };
    const lines: LaidOutLine[] = [];
    let textY = y;
    for (const text of label) {
      lines.push({ text, rect: { x: 0, y: textY, width: measureText(text, style).width, height: ink }, tone: 'ink', style });
      textY += lineHeight;
    }
    let readoutY = beside ? y : y + label.length * lineHeight;
    for (const text of readout) {
      const measured = measureText(text, style).width;
      lines.push({
        text,
        rect: { x: Math.max(0, width - measured), y: readoutY, width: measured, height: ink },
        tone: 'soft',
        style,
      });
      readoutY += lineHeight;
    }
    textY = y + headHeight + (hint.length === 0 ? 0 : Math.round(metrics.controlGap / 2));
    for (const text of hint) {
      lines.push({ text, rect: { x: 0, y: textY, width: measureText(text, style).width, height: ink }, tone: 'soft', style });
      textY += lineHeight;
    }
    controls.push({
      id: control.id,
      kind: 'slider',
      role: 'slider',
      label: control.label,
      ...(control.hint === undefined ? {} : { hint: control.hint }),
      rect: row,
      control: { x: 0, y: trackTop, width, height: metrics.sliderHeight },
      readout: control.readout,
      fraction: control.fraction,
      lines,
    });
    atoms.push({ top: y, bottom: y + height });
    y += height + metrics.controlGap;
  }

  closeRow();
  const height = Math.max(0, y - top - metrics.controlGap);
  return { controls, height };
}

function flowStamps(
  block: StampsBlock,
  width: number,
  metrics: PanelMetrics,
  top: number,
  atoms: Atom[],
): { marks: LaidOutMark[]; height: number } {
  const marks: LaidOutMark[] = [];
  // A die never wider than the measure. On a narrow panel a fixed 48 would
  // hang a stamp through the border, which is the one thing every rectangle
  // out of this module promises not to do.
  const size = Math.max(1, Math.min(metrics.stampSize, width));
  const step = size + metrics.stampGap;
  const perRow = Math.max(1, Math.floor((width + metrics.stampGap) / step));
  let y = top;
  for (let index = 0; index < block.marks.length; index++) {
    const mark = block.marks[index];
    if (mark === undefined) continue;
    const column = index % perRow;
    if (column === 0 && index > 0) y += step;
    marks.push({
      id: mark.id,
      label: mark.label,
      rect: { x: column * step, y, width: size, height: size },
    });
    if (column === 0) atoms.push({ top: y, bottom: y + size });
  }
  const height = block.marks.length === 0 ? 0 : y + size - top;
  return { marks, height };
}

/**
 * Lays a panel out.
 *
 * Pure, and pure on purpose: nothing here touches a canvas, a DOM node or a
 * clock, so the whole of it runs under vitest and the proof script gets the
 * same numbers the browser will.
 */
export function layoutPanel(spec: PanelSpec): PanelLayout {
  const metrics = { ...panelMetrics(spec.scale ?? 1), ...spec.metrics };
  const inset = contentInset(metrics);
  const content: Rect = {
    x: spec.rect.x + inset,
    y: spec.rect.y + inset,
    width: Math.max(0, spec.rect.width - inset * 2),
    height: Math.max(0, spec.rect.height - inset * 2),
  };

  const atoms: Atom[] = [];
  const flow: FlowBlock[] = [];
  let y = 0;
  let previous: PanelBlock['kind'] | null = null;

  for (const block of spec.blocks) {
    // The gap above a block depends on what it follows, which is why it is
    // decided here and not baked into each block's height. A heading straight
    // after a rule wants the rule's gap, not both.
    if (previous !== null) {
      if (block.kind === 'heading') y += metrics.headingGapAbove;
      else if (block.kind === 'rule') y += metrics.ruleGap;
      else if (previous === 'heading') y += metrics.headingGapBelow;
      else if (previous === 'rule') y += metrics.ruleGap;
      else if (block.kind !== 'spacer' && previous !== 'spacer') y += metrics.paragraphGap;
    }

    const top = y;
    let lines: LaidOutLine[] = [];
    let controls: Omit<LaidOutControl, 'visible'>[] = [];
    let marks: LaidOutMark[] = [];
    let height = 0;

    switch (block.kind) {
      case 'heading': {
        const level = block.level ?? 2;
        const style = headingStyle(metrics, level);
        const text = level === 2 ? block.text.toUpperCase() : block.text;
        const laid = flowText(text, content.width, style, metrics, 'ink', top, atoms);
        lines = laid.lines;
        height = laid.height;
        break;
      }
      case 'body': {
        const laid = flowText(
          block.text,
          content.width,
          bodyStyle(metrics),
          metrics,
          block.tone ?? 'ink',
          top,
          atoms,
        );
        lines = laid.lines;
        height = laid.height;
        break;
      }
      case 'machine': {
        const laid = flowText(
          block.text.toUpperCase(),
          content.width,
          machineStyle(metrics),
          metrics,
          'soft',
          top,
          atoms,
        );
        lines = laid.lines;
        height = laid.height;
        break;
      }
      case 'rule': {
        height = 1;
        atoms.push({ top, bottom: top + 1 });
        break;
      }
      case 'spacer': {
        height = Math.max(0, Math.round(block.height));
        atoms.push({ top, bottom: top + height });
        break;
      }
      case 'stamps': {
        const laid = flowStamps(block, content.width, metrics, top, atoms);
        marks = laid.marks;
        height = laid.height;
        break;
      }
      case 'controls': {
        const laid = flowControls(block, content.width, metrics, top, atoms);
        controls = laid.controls;
        height = laid.height;
        break;
      }
    }

    flow.push({
      id: block.id,
      kind: block.kind,
      block,
      rect: { x: 0, y: top, width: content.width, height },
      lines,
      controls,
      marks,
    });
    y = top + height;
    previous = block.kind;
  }

  const contentHeight = y;
  const overflow = contentHeight > content.height;

  /*
   * The mark is *reserved*, not painted over the type.
   *
   * The first proof sheet had the fade sitting on the last line of every
   * scrolled panel — eight rows of dither over a nine-row line — and it did
   * not read as a page continuing, it read as a rendering fault. `styles.ts`
   * had already written down the rule and this got it backwards: "every scroll
   * region adds it to its own bottom padding so the last line can pass clear
   * of the mark rather than ending underneath it". So the viewport the content
   * is allowed to fill is short by the mark's depth, and the mark is a band of
   * clean dithered paper below everything.
   */
  // Reserved whether or not the mark is being drawn right now. A viewport that
  // grew by eight pixels the moment you reached the bottom would reflow the
  // page under the reader's eye at the exact moment they were finishing it.
  const viewportHeight = overflow ? Math.max(0, content.height - metrics.cutMark) : content.height;

  /*
   * The furthest the page can be scrolled is a *snapped* offset, and working
   * that out first is what makes the end of a page reachable.
   *
   * It was `contentHeight - viewportHeight`, an offset that is almost never an
   * atom's top edge — so the snap below took it back down to the last one that
   * was, the viewport stopped short of the end, and the last block of every
   * long panel could not be reached at all. The link buttons at the foot of
   * the Passport are exactly that block. So the ceiling is the first atom top
   * from which everything left fits, and scrolling to it shows the end.
   */
  const tops = [0, ...atoms.map((atom) => atom.top)].sort((a, b) => a - b);
  let max = tops[tops.length - 1] ?? 0;
  for (const candidate of tops) {
    if (candidate + viewportHeight >= contentHeight) {
      max = candidate;
      break;
    }
  }
  const requested = Math.min(Math.max(0, Math.round(spec.scrollTop ?? 0)), max);

  // Snap the offset up to an atom's top edge, so the first visible line starts
  // flush instead of arriving with its ascenders already gone. Down rather
  // than to the nearest, always: a reader who has scrolled keeps the line they
  // were on rather than having it taken off the top.
  let top = 0;
  for (const atom of atoms) if (atom.top <= requested && atom.top > top) top = atom.top;

  // And the bottom to an atom's bottom edge, so nothing is sliced.
  const limit = top + viewportHeight;
  let cutBottom = top;
  for (const atom of atoms) if (atom.bottom <= limit && atom.bottom > cutBottom) cutBottom = atom.bottom;
  // A mark on a page with nothing below it is the same lie as no mark on a
  // page that has more; `styles.ts` says so in as many words.
  const more = cutBottom < contentHeight;

  const shift = content.y - top;
  const offset = (r: Rect, dx: number): Rect => ({ x: r.x + dx, y: r.y + shift, width: r.width, height: r.height });

  const cutY = more ? content.y + (cutBottom - top) : bottom(content);
  const below: string[] = [];
  const blocks: LaidOutBlock[] = flow.map((item) => {
    const rect = offset(item.rect, content.x);
    const visible = bottom(rect) > content.y && rect.y < cutY;
    if (bottom(rect) > cutY) below.push(item.id);
    return {
      id: item.id,
      kind: item.kind,
      block: item.block,
      rect,
      lines: item.lines.map((line) => ({ ...line, rect: offset(line.rect, content.x) })),
      controls: item.controls.map((control) => {
        const controlRect = offset(control.rect, content.x);
        return {
          ...control,
          rect: controlRect,
          control: offset(control.control, content.x),
          lines: control.lines.map((line) => ({ ...line, rect: offset(line.rect, content.x) })),
          visible: bottom(controlRect) > content.y && bottom(controlRect) <= cutY,
        };
      }),
      marks: item.marks.map((mark) => ({ ...mark, rect: offset(mark.rect, content.x) })),
      visible,
    };
  });

  // Flush with the bottom of the page, not with the cut. A mark that moves up
  // and down by a line depending on where the text happened to break is a mark
  // a reader has to find; one that is always in the same place is one they
  // learn in a single panel.
  const markHeight = Math.min(metrics.cutMark, Math.max(0, bottom(content) - cutY));
  const cut: PanelCut | null = more
    ? {
        y: cutY,
        mark: {
          x: content.x,
          y: bottom(content) - markHeight,
          width: content.width,
          height: markHeight,
        },
        below,
      }
    : null;

  return {
    panel: spec.rect,
    content,
    blocks,
    contentHeight,
    overflow,
    scroll: { top, max, requested },
    cut,
    metrics,
  };
}

/**
 * The height this panel wants, so a caller can size one to its content.
 *
 * Cheaper than it looks and cheaper than keeping a constant in agreement with
 * a layout — the same trick `tools/font/proof.mjs` uses to size its sheet.
 */
export function intrinsicHeight(spec: PanelSpec): number {
  const probe = layoutPanel({ ...spec, rect: { ...spec.rect, height: 1_000_000 }, scrollTop: 0 });
  return probe.contentHeight + contentInset(probe.metrics) * 2;
}

/* -------------------------------------------------------------------------- */
/* The accessibility seam                                                     */
/* -------------------------------------------------------------------------- */

export interface FocusTarget {
  readonly id: string;
  readonly role: 'button' | 'checkbox' | 'slider';
  readonly label: string;
  readonly hint?: string;
  /** The labelled row, in buffer pixels. What a `<label>` should cover. */
  readonly rect: Rect;
  /** The chrome, in buffer pixels. What the `<input>` or `<button>` covers. */
  readonly control: Rect;
  readonly checked?: boolean;
  readonly readout?: string;
  readonly fraction?: number;
  /** False when the cut or the scroll offset has taken it off the page. */
  readonly visible: boolean;
}

/**
 * Everything the DOM has to carry, and where it has to sit.
 *
 * A canvas has one accessible node and it is the canvas. Nothing drawn on it
 * has a role, a name, a value or a tab stop, and `e2e/access.spec.ts` asserts
 * all four on these panels — `getByRole('checkbox', { name: /Simplified
 * gestures/ })`, a slider that reads out "100%", Tab that goes round the
 * dialog forty times without escaping. None of that can be faked by drawing.
 *
 * So the division is: the canvas draws, the DOM means. This function is the
 * seam. Every control the layout placed comes back with an id, a role, a name
 * and two rectangles, and the caller's job is to put a real element over each
 * one. See the note at the top of `panel.ts` for the exact wiring.
 */
export function focusTargets(layout: PanelLayout): FocusTarget[] {
  const targets: FocusTarget[] = [];
  for (const block of layout.blocks) {
    for (const control of block.controls) {
      targets.push({
        id: control.id,
        role: control.role,
        label: control.label,
        ...(control.hint === undefined ? {} : { hint: control.hint }),
        rect: control.rect,
        control: control.control,
        ...(control.checked === undefined ? {} : { checked: control.checked }),
        ...(control.readout === undefined ? {} : { readout: control.readout }),
        ...(control.fraction === undefined ? {} : { fraction: control.fraction }),
        visible: control.visible,
      });
    }
  }
  return targets;
}

/** Find a control by id, for a caller mapping a DOM event back to the drawing. */
export function controlById(layout: PanelLayout, id: string): LaidOutControl | undefined {
  for (const block of layout.blocks) {
    for (const control of block.controls) if (control.id === id) return control;
  }
  return undefined;
}

export interface ScreenMapping {
  /** The whole-number upscale the buffer is presented at. */
  readonly scale: number;
  /** Where the buffer's origin sits in CSS pixels, if it is letterboxed. */
  readonly offsetX?: number;
  readonly offsetY?: number;
}

export interface ScreenBox {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

/**
 * A buffer rectangle in CSS pixels, for positioning the mirrored element.
 *
 * The upscale is a whole number and so is every rectangle this kit produces,
 * so the result is exact — no element ever lands half a pixel off the thing it
 * is standing in for, which is the failure that makes a hit target disagree
 * with the drawing that invites it.
 */
export function toScreen(r: Rect, mapping: ScreenMapping): ScreenBox {
  const scale = Math.max(1, Math.round(mapping.scale));
  return {
    left: (mapping.offsetX ?? 0) + r.x * scale,
    top: (mapping.offsetY ?? 0) + r.y * scale,
    width: r.width * scale,
    height: r.height * scale,
  };
}
