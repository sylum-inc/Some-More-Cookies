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
  /**
   * Blank rows between one line's ink and the next.
   *
   * Here rather than baked into `lineHeight` because it is the one metric the
   * accessibility text slider can move without changing the size of a glyph.
   * See `panelTextMetrics`: below the point where the type doubles, the dial
   * spends itself on this and on `padding`, which is what the font's own note
   * about `integerTextScale` recommends and is the half of "larger text" a
   * bitmap face can actually deliver.
   */
  readonly leading: number;
  /** One line of body type to the next: `lineInk + leading`. */
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
  /**
   * How wide the picture inside a print is.
   *
   * Eighty buffer pixels, sixteen to nine — the shape of the world buffer the
   * photograph was taken out of, so a print is a crop of what was on screen
   * rather than a squashed copy of it. It is not arbitrary at either end: a
   * print reduced much past this stops being a picture of somewhere and
   * becomes a grey square, and much wider than this only two fit across a
   * 288-pixel measure, which reads as two large pictures rather than as a
   * page of an album.
   */
  readonly photoWidth: number;
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
export function panelMetrics(scale = 1, extraLeading = 1): PanelMetrics {
  // `integerTextScale` rather than a rounding of our own. It is the font's
  // rule about what the accessibility slider is allowed to mean, it has the
  // argument for the floor written next to it, and a panel that rounded the
  // same setting differently from the type inside it would be a panel whose
  // padding and whose words disagreed about how large the page is.
  const s = integerTextScale(scale);
  const leading = Math.max(1, Math.round(extraLeading)) * s;
  return {
    scale: s,
    border: 1,
    bevel: 2,
    padding: 4 * s,
    leading,
    lineHeight: CELL_HEIGHT * s + leading,
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
    photoWidth: 80 * s,
    cutMark: 8,
  };
}

/** Border + bevel + padding: how far the first word is from the panel's edge. */
export function contentInset(metrics: PanelMetrics): number {
  return metrics.border + metrics.bevel + metrics.padding;
}

/**
 * The accessibility text slider, landed on a bitmap face.
 *
 * The slider runs 0.85 to 1.8 in steps of 0.05 — twenty stops, designed for a
 * browser that can set type at 14.375px. `integerTextScale` says what a 5x9
 * cell can do with that and it is blunt: 1x, 2x, and nothing in between, so
 * eighteen of the twenty stops would move nothing. A dial where eighteen stops
 * do nothing is the same defect `Settings.tsx` already has a long note about,
 * and the answer is not to throw the other eighteen away.
 *
 * So the dial is read twice, and this is the whole mapping:
 *
 *   GLYPH     `integerTextScale(setting, base)`. Two sizes at a 240-row
 *             buffer, three at 360. Nothing else is honest.
 *   LEADING   the fractional remainder, as whole rows between the lines.
 *             0.85–1.15 is one row, 1.15–1.45 two, and so on up to the point
 *             the glyph doubles and the remainder resets.
 *   MEASURE   the same remainder, as page padding — which narrows the column.
 *
 * That is `integerTextScale`'s own recommendation taken literally: "leading,
 * panel padding and — the one that actually helps a reader — the measure".
 * Forty-six characters a line with two rows of leading is easier to read than
 * twenty-three characters at 2x, and it does not cost half the passport.
 *
 * The dial is not quantised anywhere else. `textScale` still scales the HUD,
 * the arrival card and every remaining CSS surface continuously, so nothing
 * about the setting is lost — it is only *inside a drawn panel* that it lands
 * on whole pixels, because inside a drawn panel there is nothing else to land
 * on.
 */
export function panelTextMetrics(
  setting: number,
  base = 1,
): { readonly scale: number; readonly metrics: Partial<PanelMetrics> } {
  const scale = integerTextScale(setting, base);
  // How far into the current glyph size the dial has climbed, 0..1. Below the
  // floor (the slider starts at 0.85, under 1) this is 0: the bottom of this
  // slider must never make the page *less* readable than its default.
  const wanted = Number.isFinite(setting) && setting > 0 ? base * setting : base;
  const remainder = Math.min(1, Math.max(0, wanted - scale + 0.5));
  const rows = 1 + Math.round(remainder * 2);
  return {
    scale,
    metrics: {
      leading: rows * scale,
      lineHeight: CELL_HEIGHT * scale + rows * scale,
      padding: (4 + Math.round(remainder * 4)) * scale,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Blocks                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What a run of type is *for*, rather than what colour it is.
 *
 * The first two are the page's own voice and move with the surface: on paper
 * they are ink and soft ink, on the terminal's dark plate they are reversed
 * out of it (`DrawPanelOptions.tones`). The second two never move, because
 * they are not on the page — they are on a control's own face, and a button
 * cap is cream stock whatever it has been screwed to. Without the split, a
 * dark-plate panel drew its button labels in the plate's own light ink on a
 * light button and the labels vanished; with it, the surface can be inverted
 * without a single control having to know.
 */
export type PanelTone = 'ink' | 'soft' | 'chrome' | 'chromeSoft';

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
  /**
   * Announce this block when it changes, as well as drawing it.
   *
   * The fire's log and the code reader's verdict both arrive without anybody
   * having moved focus, and §12's rule is that nothing may be delivered
   * through one channel. `polite` for a conversation, `assertive` for an
   * answer somebody just asked for.
   */
  readonly live?: 'polite' | 'assertive';
  /** The mirrored element's role, when a paragraph is not what it is. */
  readonly role?: 'log' | 'status' | 'alert';
  /** Its accessible name, when the role wants one. */
  readonly label?: string;
  /** `data-*` the specs read off the mirrored element. */
  readonly data?: Readonly<Record<string, string>>;
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

/**
 * One photograph in the album.
 *
 * No pixels here, and that is the point: the layout knows how big a print is
 * and where it goes, and nothing about what is on it. The bytes arrive at
 * paint time through `DrawPanelOptions.photo`, because they are a runtime data
 * URL from photo mode and a pure layout function may not go and decode one.
 */
export interface PhotoMark {
  readonly id: string;
  readonly caption: string;
}

export interface PhotosBlock {
  readonly kind: 'photos';
  readonly id: string;
  readonly photos: readonly PhotoMark[];
}

/**
 * A window in the page, for something the game did not draw.
 *
 * There is exactly one of these and it is the code reader's camera. Everything
 * else on a drawn panel is drawn; a live camera preview is not, and pretending
 * otherwise would be the one dishonest pixel in the kit. `developPhoto` is for
 * a *print* — a capture that has stopped moving, box-filtered onto the paper
 * ramp — and running it thirty times a second would be an animation on a panel
 * whose whole rule is that nothing animates (§12), on a picture whose whole
 * job is to be a lens rather than a page.
 *
 * So the kit draws the instrument and the lens shows what the lens sees: a
 * sunken aperture with reticle corners, and the caller's own element sitting
 * inside it through `PixelPanelProps.slot`. The layout owns the rectangle,
 * which is what keeps the two lined up.
 */
export interface ApertureBlock {
  readonly kind: 'aperture';
  readonly id: string;
  /** The accessible name of whatever the caller puts in it. */
  readonly label: string;
  /** Width over height. 4:3 is a camera; 16:9 is this game's own frame. */
  readonly aspect?: number;
}

export interface ButtonControl {
  readonly kind: 'button';
  readonly id: string;
  readonly label: string;
  /**
   * A button that is also a state: the voice modes at the fire are three of
   * these and exactly one is on. Mirrored as `aria-pressed`, drawn as a cap
   * that has been pushed in, and deliberately not a checkbox — "open mic" is
   * one of three choices, not a thing that is on or off by itself.
   */
  readonly pressed?: boolean;
  /**
   * Present, named, drawn, and not operable yet.
   *
   * `disabled` rather than absent because half the controls at the fire are
   * unavailable until somebody else arrives, and a panel whose buttons appear
   * and disappear as people walk up is a panel that moves under the reader.
   * The drawing says so — a soft label on a flat cap — and so does the DOM.
   */
  readonly disabled?: boolean;
}

export interface CheckboxControl {
  readonly kind: 'checkbox';
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly checked: boolean;
  readonly disabled?: boolean;
}

/**
 * Somewhere to type.
 *
 * The three panels this kit was written for had no field between them; the
 * three it was written *toward* are a code reader, a checkout and a place to
 * say something, and all three are mostly field. So a well: a sunken slip of
 * cream stock with what has been typed drawn in it, a real `<input>` or
 * `<textarea>` over the top of it, and a block caret at the end when the DOM
 * says it has focus.
 *
 * The value is drawn from its *end*, not its beginning. A wrapped 86-character
 * signature in a three-line well shows the first three lines if you take them
 * in order, which is the one part of it a typist is not looking at — the same
 * reason a real text field scrolls to the caret.
 */
export interface TextControl {
  readonly kind: 'text';
  readonly id: string;
  readonly label: string;
  readonly hint?: string;
  readonly value: string;
  /** Drawn in soft ink when there is nothing typed. */
  readonly placeholder?: string;
  /** Lines of type the well is tall. One unless it is a paragraph. */
  readonly rows?: number;
  readonly disabled?: boolean;
  /** For the mirrored input, which is where an inputmode belongs. */
  readonly inputMode?: 'text' | 'email' | 'tel' | 'numeric';
  readonly maxLength?: number;
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
  readonly disabled?: boolean;
}

export type PanelControl = ButtonControl | CheckboxControl | SliderControl | TextControl;

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
  | PhotosBlock
  | ApertureBlock
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
  readonly role: 'button' | 'checkbox' | 'slider' | 'textbox';
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
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  /** What is typed, for a `text` control. The mirrored input's value. */
  readonly value?: string;
  readonly placeholder?: string;
  readonly inputMode?: TextControl['inputMode'];
  readonly maxLength?: number;
  /** Lines of type the well holds, so the mirror knows input from textarea. */
  readonly rows?: number;
  /**
   * Where the block caret goes when this control has focus: the end of what
   * has been typed. Absent on everything that is not a well.
   */
  readonly caret?: Rect;
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

export interface LaidOutPhoto {
  readonly id: string;
  readonly caption: string;
  /** The whole print: white border, picture, caption strip. */
  readonly rect: Rect;
  /** Just the picture, which is what the image is quantised into. */
  readonly image: Rect;
  /** The caption, already wrapped to the print and placed. */
  readonly lines: readonly LaidOutLine[];
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
  readonly photos: readonly LaidOutPhoto[];
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

/**
 * One line to the next, for a style that may not be body size.
 *
 * The ink is the style's own — a level-1 heading is a scale larger — and the
 * gap under it is the panel's, so raising the leading airs out a page without
 * the headings drifting away from the paragraphs they belong to.
 */
function lineHeightFor(style: TextStyle, metrics: PanelMetrics): number {
  return CELL_HEIGHT * (style.scale ?? metrics.scale) + metrics.leading;
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
  readonly photos: LaidOutPhoto[];
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
        ...(control.pressed === undefined ? {} : { pressed: control.pressed }),
        ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
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
            // `chrome`, not `ink`: this line is on the cap, not on the page,
            // and the cap is cream stock on the dark plate too.
            tone: control.disabled === true ? 'chromeSoft' : 'chrome',
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
        ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
        lines,
      });
      atoms.push({ top: y, bottom: y + height });
      y += height + metrics.controlGap;
      continue;
    }

    if (control.kind === 'text') {
      /*
       * A label, an optional hint, and a well under them.
       *
       * The label is above rather than beside, which is not the shape the CSS
       * checkout had — it put an 88px caption in a flex row beside the field.
       * At this measure that leaves about twelve characters of field on a
       * phone, and a field you cannot see what you typed in is the one thing a
       * postcode entry must not be. Above costs a line and buys the measure.
       */
      const lineHeight = lineHeightFor(style, metrics);
      const ink = inkHeightFor(style, metrics);
      const label = wrapText(control.label, Math.max(1, width), style);
      const hint = control.hint === undefined ? [] : wrapText(control.hint, Math.max(1, width), style);
      const lines: LaidOutLine[] = [];
      let textY = y;
      for (const text of label) {
        lines.push({ text, rect: { x: 0, y: textY, width: measureText(text, style).width, height: ink }, tone: 'ink', style });
        textY += lineHeight;
      }
      for (const text of hint) {
        lines.push({ text, rect: { x: 0, y: textY, width: measureText(text, style).width, height: ink }, tone: 'soft', style });
        textY += lineHeight;
      }

      // Border, bevel and a pixel of air. The same three the page itself has,
      // one weight down, because a well is a page pressed into a page.
      const pad = 1 + metrics.scale;
      const rows = Math.max(1, Math.round(control.rows ?? 1));
      const inner = Math.max(1, width - pad * 2);
      const wellTop = textY + (label.length + hint.length === 0 ? 0 : Math.round(metrics.controlGap / 2));
      const wellHeight = rows * lineHeight - (lineHeight - ink) + pad * 2;
      const well: Rect = { x: 0, y: wellTop, width, height: wellHeight };

      /*
       * What is in the well, wrapped and then read from the end.
       *
       * `slice(-rows)` rather than `slice(0, rows)`: a redemption code is 86
       * characters of base64 and a three-line well shows three of its six
       * lines, and the three worth showing are the ones under the caret. This
       * is what every real text field does and it is invisible until the day
       * somebody pastes something long and cannot see what they pasted.
       */
      const typed = control.value !== '' ;
      const source = typed ? control.value : (control.placeholder ?? '');
      const wrappedValue = source === '' ? [] : wrapText(source, inner, style);
      const shown = wrappedValue.slice(-rows);
      let valueY = well.y + pad;
      let caret: Rect = { x: well.x + pad, y: valueY, width: metrics.scale, height: ink };
      for (const text of shown) {
        const measured = measureText(text, style).width;
        lines.push({
          text,
          rect: { x: well.x + pad, y: valueY, width: measured, height: ink },
          // Always dark on cream: a well is a slip of stock, on the dark
          // plate as much as on the page.
          tone: typed ? 'chrome' : 'chromeSoft',
          style,
        });
        if (typed) caret = { x: Math.min(well.x + well.width - pad - metrics.scale, well.x + pad + measured + 1), y: valueY, width: metrics.scale, height: ink };
        valueY += lineHeight;
      }

      const height = wellTop + wellHeight - y;
      controls.push({
        id: control.id,
        kind: 'text',
        role: 'textbox',
        label: control.label,
        ...(control.hint === undefined ? {} : { hint: control.hint }),
        rect: { x: 0, y, width, height },
        control: well,
        value: control.value,
        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
        ...(control.inputMode === undefined ? {} : { inputMode: control.inputMode }),
        ...(control.maxLength === undefined ? {} : { maxLength: control.maxLength }),
        ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
        rows,
        caret,
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
      ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
      lines,
    });
    atoms.push({ top: y, bottom: y + height });
    y += height + metrics.controlGap;
  }

  closeRow();
  const height = Math.max(0, y - top - metrics.controlGap);
  return { controls, height };
}

/**
 * A shelf of prints.
 *
 * Laid out like the stamps and for the same reason — a row at a time, the row
 * is the atom — but a print is not a die: it has a caption under it, and the
 * caption is content rather than texture. So the whole print including its
 * caption is one atom, and a row of prints is as tall as the wordiest caption
 * in it. A photograph sliced in half by a scroll cut would be worse than a
 * line of type sliced in half, because a reader cannot tell a cropped print
 * from a badly taken one.
 */
function flowPhotos(
  block: PhotosBlock,
  width: number,
  metrics: PanelMetrics,
  top: number,
  atoms: Atom[],
): { photos: LaidOutPhoto[]; height: number } {
  const photos: LaidOutPhoto[] = [];
  if (block.photos.length === 0) return { photos, height: 0 };

  const style = bodyStyle(metrics);
  const lineHeight = lineHeightFor(style, metrics);
  const ink = inkHeightFor(style, metrics);
  const border = 2 * metrics.scale;
  // Never wider than the measure: a print that hangs through the border is the
  // one thing every rectangle out of this module promises not to do.
  const nominal = Math.max(1, Math.min(metrics.photoWidth, width - border * 2));
  const perRow = Math.max(1, Math.floor((width + metrics.stampGap) / (nominal + border * 2 + metrics.stampGap)));
  /*
   * One print to a row takes the whole measure.
   *
   * A narrow column — a phone held upright — fits one print beside nothing,
   * and an eighty-pixel print half way across a hundred and sixty pixel page
   * reads as a layout that ran out of room rather than as an album. When
   * there is only one, it is the page's width, which is what a photograph in a
   * pocket album is.
   */
  const pictureWidth = perRow === 1 ? Math.max(1, width - border * 2) : nominal;
  const pictureHeight = Math.round((pictureWidth * 9) / 16);
  const printWidth = pictureWidth + border * 2;
  const step = printWidth + metrics.stampGap;

  /*
   * Every card in the block is the same height, and it is decided before any
   * of them is placed.
   *
   * A shelf of prints where one card is a line taller than the one beside it
   * reads as a layout accident rather than as a page of an album — the same
   * argument `flowControls` makes about a row of buttons. So the captions are
   * wrapped first and the tallest one sets the card.
   */
  const captions = block.photos.map((photo) => captionFor(photo.caption, pictureWidth, style));
  const captionLines = Math.max(0, ...captions.map((lines) => lines.length));
  const captionHeight = captionLines === 0 ? 0 : captionLines * lineHeight - (lineHeight - ink);
  const cardHeight = border * 2 + pictureHeight + (captionLines === 0 ? 0 : border + captionHeight) + border;

  let y = top;
  let rowHeight = 0;
  for (let index = 0; index < block.photos.length; index++) {
    const photo = block.photos[index];
    if (photo === undefined) continue;
    const column = index % perRow;
    if (column === 0 && index > 0) {
      atoms.push({ top: y, bottom: y + rowHeight });
      y += rowHeight + metrics.stampGap;
      rowHeight = 0;
    }
    const x = column * step;
    const image: Rect = { x: x + border, y: y + border, width: pictureWidth, height: pictureHeight };
    const lines: LaidOutLine[] = [];
    let textY = bottom(image) + border;
    for (const text of captions[index] ?? []) {
      lines.push({
        text,
        rect: { x: image.x, y: textY, width: measureText(text, style).width, height: ink },
        tone: 'ink',
        style,
      });
      textY += lineHeight;
    }
    photos.push({
      id: photo.id,
      caption: photo.caption,
      rect: { x, y, width: printWidth, height: cardHeight },
      image,
      lines,
    });
    rowHeight = Math.max(rowHeight, cardHeight);
  }
  atoms.push({ top: y, bottom: y + rowHeight });
  return { photos, height: y + rowHeight - top };
}

/**
 * A caption, wrapped to the print and told when it has been cut short.
 *
 * Two lines at most: a caption is a note in a margin, not a paragraph, and a
 * third line turns a shelf of prints into a wall of type. The ellipsis is not
 * decoration — the first proof sheet printed "Something moved by the" and
 * stopped, which is not a shortened caption, it is a caption with a rendering
 * fault in it. The font draws `…` as one glyph for exactly this reason.
 */
function captionFor(caption: string, width: number, style: TextStyle): string[] {
  const wrapped = wrapText(caption, width, style);
  if (wrapped.length <= 2) return wrapped;
  const kept = wrapped.slice(0, 2);
  let last = `${kept[1] ?? ''}…`;
  while (last.length > 1 && measureText(last, style).width > width) {
    last = `${last.slice(0, -2)}…`;
  }
  kept[1] = last;
  return kept;
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
    let photos: LaidOutPhoto[] = [];
    let height = 0;
    // An aperture is narrower than the measure and centred in it; everything
    // else takes the whole column.
    let apertureWidth: number | null = null;

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
      case 'photos': {
        const laid = flowPhotos(block, content.width, metrics, top, atoms);
        photos = laid.photos;
        height = laid.height;
        break;
      }
      case 'aperture': {
        /*
         * As wide as the measure allows and no taller than a third of a
         * 240-row buffer.
         *
         * Capped on the *height* rather than the width, because a 4:3 window
         * across a 288-pixel measure is 216 pixels deep — taller than the page
         * it is on — and the failure mode is a panel that is nothing but
         * viewfinder with the field it exists to fill pushed off the bottom.
         * The window is a viewfinder, not the picture.
         */
        const aspect = block.aspect === undefined || block.aspect <= 0 ? 4 / 3 : block.aspect;
        // Fifty-six rows, which on a 240-row buffer leaves the field the panel
        // exists for above the cut instead of below it. Eighty was the first
        // number and the sheet showed what it cost: the code entry and the
        // button that submits it both fell off the bottom the moment somebody
        // opened the camera, on the panel where typing is the primary path.
        const cap = 56 * metrics.scale;
        const wide = Math.max(1, Math.min(content.width, Math.round(cap * aspect)));
        height = Math.max(1, Math.round(wide / aspect));
        apertureWidth = wide;
        atoms.push({ top, bottom: top + height });
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
      rect:
        apertureWidth === null
          ? { x: 0, y: top, width: content.width, height }
          : { x: Math.floor((content.width - apertureWidth) / 2), y: top, width: apertureWidth, height },
      lines,
      controls,
      marks,
      photos,
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
          // The caret is a rectangle like every other one here and has to be
          // moved with them. It was not, and the first proof sheet drew a
          // block caret floating on the paper twelve pixels above the well it
          // belonged in — which is exactly the class of defect this whole
          // module exists to make visible, caught by looking at a picture.
          ...(control.caret === undefined ? {} : { caret: offset(control.caret, content.x) }),
          lines: control.lines.map((line) => ({ ...line, rect: offset(line.rect, content.x) })),
          visible: bottom(controlRect) > content.y && bottom(controlRect) <= cutY,
        };
      }),
      marks: item.marks.map((mark) => ({ ...mark, rect: offset(mark.rect, content.x) })),
      photos: item.photos.map((photo) => ({
        ...photo,
        rect: offset(photo.rect, content.x),
        image: offset(photo.image, content.x),
        lines: photo.lines.map((line) => ({ ...line, rect: offset(line.rect, content.x) })),
      })),
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
  readonly role: 'button' | 'checkbox' | 'slider' | 'textbox';
  readonly label: string;
  readonly hint?: string;
  /** The labelled row, in buffer pixels. What a `<label>` should cover. */
  readonly rect: Rect;
  /** The chrome, in buffer pixels. What the `<input>` or `<button>` covers. */
  readonly control: Rect;
  readonly checked?: boolean;
  readonly readout?: string;
  readonly fraction?: number;
  readonly pressed?: boolean;
  readonly disabled?: boolean;
  readonly value?: string;
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
        ...(control.pressed === undefined ? {} : { pressed: control.pressed }),
        ...(control.disabled === undefined ? {} : { disabled: control.disabled }),
        ...(control.value === undefined ? {} : { value: control.value }),
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
