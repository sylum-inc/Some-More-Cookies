/**
 * Overlays that live in the pixel buffer, and the DOM that gives them meaning.
 *
 * This is the wiring `ui/pixel/panel.ts` describes in its header, written once
 * so that all five overlays — the Passport, Settings, the code reader, the
 * order terminal and the spoken survey — are one object rather than five that
 * drift. Read that header first; this file is its implementation and does not
 * repeat its arguments.
 *
 * Three things here exist only because the last three panels needed them, and
 * each is a seam rather than a special case:
 *
 *   A FIELD      `TextControl` and `onText`. A drawn well with a real
 *                `<input>` or `<textarea>` over it, and a block caret the
 *                canvas draws because the browser's own is inside an element
 *                at zero opacity and never reaches the screen.
 *   A WINDOW     `ApertureBlock` and `slot`. One rectangle on one panel that
 *                the game does not draw into, because what goes in it is a
 *                live camera and a lens is not printed matter. See `Scan.tsx`.
 *   A PLATE      `surface="plate"`. The terminal is a device readout rather
 *                than a page, which `pixel/panel.ts` anticipated with
 *                `drawPlate` before there was anything to draw on it.
 *
 * ## Why the overlays moved into the buffer at all
 *
 * The world is a 426x240 internal buffer upscaled by a whole number with
 * `image-rendering: pixelated`, quantised against a 4x4 Bayer matrix. The
 * overlays were browser-rendered DOM at device resolution: anti-aliased
 * Georgia and system sans, `rgba()` washes the compositor invents colours for,
 * `border-radius`, `linear-gradient`, `box-shadow`. Two rendering languages in
 * one window, and the shipped captures read as exactly what they were — a
 * browser dialog dropped on top of a game. Spec §6.2 is amended to record that
 * the field-journal *material* survives and the *medium* does not.
 *
 * ## The division, in one sentence each
 *
 *   THE CANVAS DRAWS   `drawPanel` into a buffer sized from the viewport and
 *                      the bezel, upscaled by a whole number.
 *   THE DOM MEANS      every heading, paragraph, stamp, print and control is a
 *                      real element, positioned exactly over the pixels that
 *                      stand for it, at `opacity: 0`.
 *   FOCUS IS MIRRORED  the DOM owns focus; `focusedId` tells the canvas where
 *                      to draw the ring.
 *
 * Everything mirrored is `opacity: 0` and nothing is `display: none`,
 * `visibility: hidden`, `aria-hidden` or clipped to a pixel. One rule, for two
 * audiences: a screen reader reads an element with a real box, and so does a
 * hit test. `SR_ONLY` from `styles.ts` is deliberately not used here — it is
 * for text nobody can point at, and every word on these panels is drawn
 * somewhere a player can point at it.
 *
 * ## The bezel
 *
 * `ui/Frame.tsx` draws a nine-slice rail over the edge of the viewport and
 * publishes its thickness as `--sm-frame-inset`. A panel that does not know
 * about it is a panel drawn partly under the rail — which is how the guidance
 * line lost its first character once already. The inset arrives as a prop from
 * `App` (which computes it for the HUD anyway) and falls back to reading that
 * custom property, and it is applied *in buffer pixels* before the panel
 * rectangle is chosen, so it reaches `toScreen` by construction rather than by
 * being remembered. It is also where the scrim stops: the rail stays lit, so
 * the thing you are still holding is still there while you read.
 *
 * ## Motion
 *
 * There is none, and that is the still path (§12). Nothing on a drawn panel
 * animates: the mottle, the scrim, the stamps and the cut mark are all
 * functions of position, never of time — there is no `requestAnimationFrame`
 * in this file and no clock reaches the drawing. The one thing that moves is
 * the page under a scroll, and that is a jump to a whole line rather than an
 * animation: `scroll-behavior` is never set to `smooth` here at any setting,
 * so there is nothing for reduced motion to turn off.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  canvasSurface,
  drawBevelBox,
  drawFocusRing,
  drawPanel,
  focusTargets,
  intrinsicHeight,
  layoutPanel,
  panelTextMetrics,
  scrim,
  toScreen,
  PLATE_SURFACE,
  type LaidOutBlock,
  type PanelBlock,
  type PanelLayout,
  type PanelMetrics,
  type PanelSpec,
  type PanelSurface,
  type PhotoPixels,
  type Rect,
  type ScreenBox,
} from './pixel/index.js';
import { useViewportSize } from '../pwa/viewport.js';
import { useDialog } from './useDialog.js';

/* -------------------------------------------------------------------------- */
/* Sizing the buffer                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The mid tier's internal height, which is the unit this game is drawn in. An
 * overlay pixel wants to be the same size as a world pixel.
 */
const WORLD_ROWS = 240;
/**
 * The narrowest buffer worth setting a page in, in buffer pixels.
 *
 * Thirty characters at 1x. Below that a wrapped paragraph is a column of
 * broken words. A portrait phone's *world* buffer is about 111 pixels across —
 * the aspect ratio times 240 — so on a phone the overlay deliberately takes a
 * smaller upscale than the world does rather than shipping an 18-character
 * measure. That is the one place the two buffers are allowed to disagree, and
 * it disagrees in the direction of being readable.
 */
const MIN_COLUMNS = 180;
const MIN_ROWS = 180;
/** Buffer pixels between the bezel and the page. */
const GUTTER = 3;
/** Characters of measure a page is allowed, at any type size. */
const MEASURE_CHARACTERS = 48;

export interface OverlayView {
  /** Whole screen pixels per buffer pixel. */
  readonly scale: number;
  /** The buffer. It covers the whole viewport, so nothing has to be moved. */
  readonly width: number;
  readonly height: number;
  /** Inside the bezel: where the scrim goes, and nothing outside it. */
  readonly frame: Rect;
  /** Inside the gutter: where a page may sit. */
  readonly area: Rect;
}

/**
 * How big the overlay buffer is for a viewport, and where a page may sit.
 *
 * Pure, exported and unit-tested: this is the arithmetic that decides whether
 * anybody can read the panel, and it is the arithmetic the bezel has to reach.
 */
export function overlayView(width: number, height: number, frameInset: number): OverlayView {
  const inset = Math.max(0, Math.round(frameInset));
  const availableWidth = Math.max(1, width - inset * 2);
  const availableHeight = Math.max(1, height - inset * 2);
  // What the world would use, so the page's pixels are the world's pixels...
  const worldScale = Math.max(1, Math.round(availableHeight / WORLD_ROWS));
  // ...unless that leaves too few columns to set a line of type in.
  const fitScale = Math.max(
    1,
    Math.min(Math.floor(availableWidth / MIN_COLUMNS), Math.floor(availableHeight / MIN_ROWS)),
  );
  const scale = Math.max(1, Math.min(worldScale, fitScale));
  const bufferWidth = Math.ceil(width / scale);
  const bufferHeight = Math.ceil(height / scale);
  const rail = Math.ceil(inset / scale);
  const frame: Rect = {
    x: rail,
    y: rail,
    width: Math.max(1, bufferWidth - rail * 2),
    height: Math.max(1, bufferHeight - rail * 2),
  };
  return {
    scale,
    width: bufferWidth,
    height: bufferHeight,
    frame,
    area: {
      x: frame.x + GUTTER,
      y: frame.y + GUTTER,
      width: Math.max(1, frame.width - GUTTER * 2),
      height: Math.max(1, frame.height - GUTTER * 2),
    },
  };
}

/**
 * The bezel's thickness, when nobody passed it in.
 *
 * `App` passes the number it already computes for the HUD, which is the
 * reliable route. This is the fallback for a panel mounted somewhere else, and
 * it reads the same custom property `.sm-overlay` does, so the two cannot
 * disagree about where the rail is.
 */
export function readFrameInset(): number {
  if (typeof window === 'undefined' || typeof document === 'undefined') return 0;
  const raw = getComputedStyle(document.documentElement).getPropertyValue('--sm-frame-inset');
  const value = Number.parseFloat(raw);
  return Number.isFinite(value) ? value : 0;
}

/**
 * A page rectangle: as wide as the measure allows, as tall as it needs.
 *
 * A 471-pixel buffer would set a 78-character line, which is a wall rather
 * than a column. The cap scales with the type, so large print gets a
 * proportionally wider page instead of the same page with half the words on it.
 */
export function pageRect(
  area: Rect,
  blocks: readonly PanelBlock[],
  scale: number,
  metrics: Partial<PanelMetrics>,
  maxFraction = 1,
): Rect {
  const inset = 1 + 2 + (metrics.padding ?? 4 * scale);
  const width = Math.min(area.width, MEASURE_CHARACTERS * 6 * scale + inset * 2);
  const wanted = intrinsicHeight({ rect: { ...area, width }, blocks, scale, metrics });
  const height = Math.min(Math.round(area.height * maxFraction), wanted);
  return {
    x: area.x + Math.floor((area.width - width) / 2),
    y: area.y + Math.floor((area.height - height) / 2),
    width,
    height: Math.max(1, height),
  };
}

/**
 * Everything about where a page goes, in one place.
 *
 * Exported because it is the *only* place: `tools/pixel/proof.mjs` and the
 * offline sheets rasterise these panels outside a browser, and a proof that
 * computes its own geometry is a proof of something nobody ships. The
 * component below calls this and so does the sheet, so a page that reads badly
 * on the sheet reads badly on the screen for the same reason.
 */
export function overlayPage(
  viewportWidth: number,
  viewportHeight: number,
  frameInset: number,
  blocks: readonly PanelBlock[],
  textScale: number,
  options: { readonly anchor?: 'centre' | 'corner'; readonly maxFraction?: number } = {},
): { view: OverlayView; spec: PanelSpec } {
  const view = overlayView(viewportWidth, viewportHeight, frameInset);
  // `base` rises when a buffer pixel is only one screen pixel across, which
  // happens in a small window: at 1x a five-pixel letter is five screen pixels,
  // and that is not type, it is a texture.
  const type = panelTextMetrics(textScale, view.scale <= 1 ? 2 : 1);
  /*
   * Room for the close mark, reserved in the flow rather than hoped for.
   *
   * The mark sits three pixels inside the page's top-right corner, which is
   * three glyph-scales *below* where the content starts — so the first line of
   * every dialog runs under it, and on a narrow page the first line is the one
   * that wraps to the full measure. Nothing about the drawing would have said
   * so: the type is drawn, then the mark on top of it, and the result is a
   * kicker with a box through the end of it.
   *
   * A spacer rather than a shorter first line, because the layout's promise is
   * that a block's rectangle is what was drawn in it, and a measure that
   * changes for one line would be a second measure nothing else knows about.
   * The cost is three pixels of paper at the top, which a booklet has anyway.
   */
  // The mark's bottom edge, less where the content already starts. Written as
  // the arithmetic rather than as a constant, so moving the mark cannot leave
  // a stale number behind.
  const gap = 2 + 6 * type.scale - (1 + 2 + (type.metrics.padding ?? 4 * type.scale));
  const clearance: PanelBlock[] =
    options.anchor === 'corner' || gap <= 0
      ? []
      : [{ kind: 'spacer', id: 'close-clearance', height: gap }];
  const page = [...clearance, ...blocks];
  const area =
    options.anchor === 'corner'
      ? (() => {
          // Under the corner affordances, which are 52 screen pixels tall.
          const top = view.area.y + Math.ceil(52 / view.scale);
          return {
            x: view.area.x,
            y: top,
            width: view.area.width,
            height: Math.max(1, view.area.y + view.area.height - top),
          };
        })()
      : view.area;
  const sized = pageRect(area, page, type.scale, type.metrics, options.maxFraction ?? 1);
  return {
    view,
    spec: {
      // A note sits in the corner of the frame; a dialog is a place you have
      // been taken to and sits in the middle of it.
      rect: options.anchor === 'corner' ? { ...sized, x: area.x, y: area.y } : sized,
      blocks: page,
      scale: type.scale,
      metrics: type.metrics,
    },
  };
}

/* -------------------------------------------------------------------------- */
/* The close mark                                                             */
/* -------------------------------------------------------------------------- */

/**
 * The canvas, resized and cleared, as a `PanelSurface`.
 *
 * Setting `width` clears a canvas, so it is only assigned when it has actually
 * changed — otherwise every redraw would be a reallocation, which on a phone
 * turning in somebody's hand is a reallocation a frame.
 */
function paint(canvas: HTMLCanvasElement | null, view: OverlayView): PanelSurface | null {
  if (canvas === null) return null;
  if (canvas.width !== view.width) canvas.width = view.width;
  if (canvas.height !== view.height) canvas.height = view.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return null;
  ctx.clearRect(0, 0, view.width, view.height);
  return canvasSurface(ctx, view.width, view.height);
}

/**
 * Where the way out sits: the page's top-right corner, tight against the bevel.
 *
 * Six pixels and two from the edge rather than seven and three, and the two
 * pixels are load-bearing. The mark hangs below the top of the content area,
 * so the flow has to be pushed down to clear it (`overlayPage`) — and at large
 * print that push is a whole *atom*: a slider row at 2x is a third of the
 * viewport, so three pixels of clearance can be the difference between a
 * control being on the first screen and being below the cut. Every pixel taken
 * off this mark is a pixel the page does not have to spend.
 */
export function closeRect(panel: Rect, scale: number): Rect {
  const size = 6 * scale;
  return { x: panel.x + panel.width - size - 2, y: panel.y + 2, width: size, height: size };
}

/** How far the flow has to start below the page's top to clear the mark. */
export function closeClearance(panel: Rect, contentTop: number, scale: number): number {
  return Math.max(0, closeRect(panel, scale).y + closeRect(panel, scale).height - contentTop);
}

/**
 * The X, drawn rather than set.
 *
 * `overlay-panels.test.ts` has insisted since this panel was CSS that the mark
 * is not a glyph, and it was right for a reason that survives the move: U+00D7
 * in the system sans at 22 points was the most obviously webby thing on the
 * page. It is two diagonals on a bevelled cap now, which is what the button on
 * a handheld's menu looked like — and the font has no multiplication sign to
 * set it in anyway.
 */
export function drawCloseMark(surface: PanelSurface, area: Rect): void {
  drawBevelBox(surface, area, 'paper', 'out', 'ink');
  const inset = 2;
  const span = area.width - inset * 2;
  for (let i = 0; i < span; i++) {
    surface.fill(area.x + inset + i, area.y + inset + i, 1, 1, 'ink');
    surface.fill(area.x + inset + i, area.y + area.height - 1 - inset - i, 1, 1, 'ink');
  }
}

/* -------------------------------------------------------------------------- */
/* The mirrored DOM                                                           */
/* -------------------------------------------------------------------------- */

/** What a real `<input type="range">` needs that the drawing does not. */
export interface SliderMirror {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly value: number;
  /**
   * What a screen reader should say, when that differs from what the page
   * prints. `Settings.tsx` argues this at length: "×1.00" is the right mark on
   * paper and the wrong sentence in an ear.
   */
  readonly spoken?: string;
}

/** Invisible, present, and pointed at. Never `display: none`. */
const MIRROR: React.CSSProperties = {
  position: 'absolute',
  margin: 0,
  padding: 0,
  border: 0,
  background: 'transparent',
  color: 'transparent',
  opacity: 0,
  font: 'inherit',
  appearance: 'none',
  WebkitAppearance: 'none',
};

const PROSE: React.CSSProperties = {
  ...MIRROR,
  pointerEvents: 'none',
  userSelect: 'none',
  overflow: 'hidden',
  whiteSpace: 'pre-wrap',
  lineHeight: 1,
  fontSize: 8,
};

function boxStyle(rect: Rect, scale: number, base: React.CSSProperties): React.CSSProperties {
  const box = toScreen(rect, { scale });
  return {
    ...base,
    left: box.left,
    top: box.top,
    width: Math.max(1, box.width),
    height: Math.max(1, box.height),
  };
}

/**
 * One block's semantics, as the element a reader would have expected.
 *
 * The canvas has one node in the accessibility tree and it is the canvas, so
 * this is the entire Passport as far as a screen reader is concerned. It is
 * not a summary of the page — it is the page, in document order, with the
 * headings that let somebody skim it and nothing that is only decoration.
 */
function semanticsFor(
  block: LaidOutBlock,
  rect: Rect,
  scale: number,
  testId: string | undefined,
): React.ReactNode {
  const source = block.block;
  const attrs = {
    style: boxStyle(rect, scale, PROSE),
    ...(testId === undefined ? {} : { 'data-testid': testId }),
  };
  switch (source.kind) {
    case 'heading':
      return (source.level ?? 2) === 1 ? (
        <h1 {...attrs}>{source.text}</h1>
      ) : (
        <h2 {...attrs}>{source.text}</h2>
      );
    case 'body': {
      /*
       * A paragraph unless it is a channel.
       *
       * The fire's log and the code reader's verdict both change while nobody
       * is looking at them and nobody's focus has moved, and §12's rule is
       * that nothing is delivered through one channel only. A live region is
       * the DOM's whole answer to that, and it has to be a real one — the
       * drawn page is the other channel, not a substitute for this one.
       */
      const extra = {
        ...(source.live === undefined ? {} : { 'aria-live': source.live, 'aria-atomic': 'false' as const }),
        ...(source.role === undefined ? {} : { role: source.role }),
        ...(source.label === undefined ? {} : { 'aria-label': source.label }),
        ...Object.fromEntries(
          Object.entries(source.data ?? {}).map(([key, value]) => [`data-${key}`, value]),
        ),
      };
      // A `<div>` when it carries a role of its own; `role="log"` on a
      // paragraph is a paragraph pretending, and the role wins over the tag.
      return source.role === undefined ? (
        <p {...attrs} {...extra}>
          {source.text}
        </p>
      ) : (
        <div {...attrs} {...extra}>
          {source.text}
        </div>
      );
    }
    case 'machine':
      return <p {...attrs}>{source.text}</p>;
    case 'stamps':
      return (
        <ul {...attrs}>
          {source.marks.map((mark) => (
            <li key={mark.id}>{mark.label}</li>
          ))}
        </ul>
      );
    case 'photos':
      return (
        <ul {...attrs}>
          {source.photos.map((photo) => (
            <li key={photo.id}>{photo.caption}</li>
          ))}
        </ul>
      );
    default:
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Scrolling                                                                  */
/* -------------------------------------------------------------------------- */

interface SnapScroll {
  readonly scrollTop: number;
  readonly ref: React.RefObject<HTMLDivElement | null>;
  readonly onScroll: () => void;
  /** Jump to an offset the caller has already worked out, and stay there. */
  readonly jumpTo: (offset: number) => void;
}

/**
 * A DOM scroller that comes to rest on a line boundary.
 *
 * The DOM scroller is the authority — it has to be, because that is what a
 * trackpad, a screen reader's own scrolling and `scrollIntoViewIfNeeded` all
 * drive — and the drawing snaps to an atom's top edge, so between the two
 * there is up to one line of disagreement while a scroll is in flight. That is
 * invisible in motion and intolerable at rest: a checkbox whose hit target is
 * a line above its own picture is worse than no picture at all.
 *
 * So the snap is applied when the scroll *settles* rather than on every event.
 * Snapping every event would also kill momentum scrolling on a phone, which is
 * the other reason this is a timer and not a handler.
 */
function useSnapScroll(spec: PanelSpec, scale: number): SnapScroll {
  const ref = useRef<HTMLDivElement | null>(null);
  const settleRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [scrollTop, setScrollTop] = useState(0);

  const settle = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    const snapped = layoutPanel({ ...spec, scrollTop: node.scrollTop / scale }).scroll.top;
    const target = snapped * scale;
    if (Math.abs(node.scrollTop - target) > 0.5) node.scrollTop = target;
    setScrollTop(snapped);
  }, [spec, scale]);

  const onScroll = useCallback(() => {
    const node = ref.current;
    if (node === null) return;
    setScrollTop(node.scrollTop / scale);
    if (settleRef.current !== null) clearTimeout(settleRef.current);
    settleRef.current = setTimeout(settle, 90);
  }, [settle, scale]);

  const jumpTo = useCallback(
    (offset: number) => {
      const node = ref.current;
      if (node !== null) node.scrollTop = offset * scale;
      setScrollTop(offset);
    },
    [scale],
  );

  useEffect(
    () => () => {
      if (settleRef.current !== null) clearTimeout(settleRef.current);
    },
    [],
  );

  return { scrollTop, ref, onScroll, jumpTo };
}

/** The scroll viewport: the content box, less the band the cut mark reserves. */
function scrollport(layout: PanelLayout): Rect {
  return {
    x: layout.content.x,
    y: layout.content.y,
    width: layout.content.width,
    height: layout.overflow
      ? Math.max(1, layout.content.height - layout.metrics.cutMark)
      : layout.content.height,
  };
}

/** A drawn rectangle back in the page's own coordinates, where the DOM lives. */
function pageCoords(layout: PanelLayout, rect: Rect): Rect {
  return {
    x: rect.x - layout.content.x,
    y: rect.y - layout.content.y + layout.scroll.top,
    width: rect.width,
    height: rect.height,
  };
}

/* -------------------------------------------------------------------------- */
/* The modal panel                                                            */
/* -------------------------------------------------------------------------- */

export interface PixelPanelProps {
  /** The dialog's accessible name. */
  readonly label: string;
  /** The close button's accessible name: "Close settings". */
  readonly closeLabel: string;
  readonly blocks: readonly PanelBlock[];
  readonly textScale: number;
  /** Drops the paper's printed screen, which is the first thing to go when
      the contrast budget is being spent on the type. */
  readonly highContrast?: boolean;
  /** The bezel, from `bezelInset`. Falls back to `--sm-frame-inset`. */
  readonly frameInset?: number;
  readonly onClose: () => void;
  readonly onButton?: (id: string) => void;
  readonly onCheckbox?: (id: string, checked: boolean) => void;
  readonly onSlider?: (id: string, value: number) => void;
  /** A `text` control changed. The caller owns the value; this is a report. */
  readonly onText?: (id: string, value: string) => void;
  /**
   * Enter was pressed in a single-line field.
   *
   * The code reader and the fire were both `<form onSubmit>` before this, and
   * pressing Enter in the field is how anybody actually sends either one. A
   * drawn panel has no form to submit, so the key is carried explicitly rather
   * than lost — which is §12's keyboard path for the two verbs on this panel
   * that a player uses most.
   */
  readonly onSubmit?: (id: string) => void;
  readonly sliders?: Readonly<Record<string, SliderMirror>>;
  /** `data-testid` for a block or a control, by id. */
  readonly testIds?: Readonly<Record<string, string>>;
  /** The bytes of one photograph. See `DrawPanelOptions.photo`. */
  readonly photo?: (id: string) => PhotoPixels | undefined;
  /**
   * The one thing on a drawn panel the game did not draw.
   *
   * Called for each `aperture` block with the screen rectangle the layout gave
   * it, so the caller can put a real element inside the drawn window — the
   * code reader's `<video>`, and nothing else so far. The kit owns the
   * geometry, which is what stops the instrument and the lens drifting apart.
   */
  readonly slot?: (id: string, box: ScreenBox) => React.ReactNode;
  /**
   * A device readout rather than a page.
   *
   * The terminal is the only one. `panel.ts` has carried `drawPlate` for it
   * since the kit was written, and `styles.ts` drew the same line for the HUD:
   * paper is for a booklet you have stopped to read, and a cream card is the
   * wrong object for an appliance printing an order at you.
   */
  readonly surface?: 'paper' | 'plate';
}

export function PixelPanel(props: PixelPanelProps): React.ReactElement {
  const dialog = useDialog();
  const viewport = useViewportSize();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const inset = props.frameInset ?? readFrameInset();
  const { view, spec } = useMemo(
    () => overlayPage(viewport.width, viewport.height, inset, props.blocks, props.textScale),
    [viewport.width, viewport.height, inset, props.blocks, props.textScale],
  );

  const scroll = useSnapScroll(spec, view.scale);
  const layout: PanelLayout = useMemo(
    () => layoutPanel({ ...spec, scrollTop: scroll.scrollTop }),
    [spec, scroll.scrollTop],
  );
  const close = useMemo(() => closeRect(layout.panel, layout.metrics.scale), [layout]);
  const targets = useMemo(() => focusTargets(layout), [layout]);

  /* ---------------------------------------------------------------------- */
  /* Drawing                                                                */
  /* ---------------------------------------------------------------------- */

  useEffect(() => {
    const surface = paint(canvasRef.current, view);
    if (surface === null) return;
    // The scrim stops at the rail rather than covering it. The bezel is
    // furniture, not world, and an overlay that dims the object you are
    // holding is a browser dialog by another name.
    scrim(surface, view.frame);
    drawPanel(surface, layout, {
      focusedId,
      ...(props.surface === 'plate' ? PLATE_SURFACE : {}),
      // High contrast still wins over the surface: it drops the printed screen
      // (a plate has none anyway) and pulls the soft voice up to the body one.
      ...(props.highContrast === true ? { screen: null, highContrast: true } : {}),
      ...(props.photo === undefined ? {} : { photo: props.photo }),
    });
    drawCloseMark(surface, close);
    if (focusedId === 'close') drawFocusRing(surface, close);
    /*
     * Redrawn when something it draws has changed, and not otherwise.
     *
     * The world is still running behind the scrim, so `App` re-renders while
     * this panel is open — several times a second, more when the fire is
     * lively. An effect with no dependency list would repaint a few hundred
     * thousand pixels every one of those renders to produce an identical
     * picture. `layout` is memoised on the spec and the scroll offset, so this
     * fires on a scroll, a resize, a setting, a focus move, and nothing else.
     */
  }, [view, layout, close, focusedId, props.highContrast, props.photo, props.surface]);

  /**
   * Bring a control onto the page when it takes focus.
   *
   * A control below the cut is drawn nowhere, so a focus ring around it would
   * be a ring around nothing and a keyboard player would be operating a
   * setting they cannot see. `layoutPanel` is pure, so the check is to lay the
   * page out again at a candidate offset and ask whether the control came out
   * visible — no measuring, no guessing at line heights, no second copy of the
   * flow rules anywhere.
   */
  const reveal = useCallback(
    (id: string) => {
      const target = targets.find((entry) => entry.id === id);
      if (target === undefined || target.visible) return;
      const flowTop = target.rect.y - layout.content.y + layout.scroll.top;
      for (const candidate of [Math.max(0, flowTop - layout.metrics.lineHeight * 2), flowTop]) {
        const probe = layoutPanel({ ...spec, scrollTop: candidate });
        const found = probe.blocks.flatMap((block) => block.controls).find((entry) => entry.id === id);
        if (found?.visible !== true) continue;
        scroll.jumpTo(probe.scroll.top);
        return;
      }
    },
    [targets, layout, spec, scroll],
  );

  /* ---------------------------------------------------------------------- */
  /* The document                                                           */
  /* ---------------------------------------------------------------------- */

  /*
   * Whether a pointer is currently pressed on this panel.
   *
   * `reveal` runs on focus, and a click focuses before it completes. So a
   * control sitting partly below the cut was scrolled out from under the
   * finger that was pressing it, between `pointerdown` and `pointerup` — the
   * browser then had no single element under both, dispatched no `click`, and
   * the control did not change. `access.spec.ts` caught it as "clicking the
   * checkbox did not change its state", and it is a real defect and not a test
   * artefact: on a phone the setting you tap slides away and nothing happens.
   *
   * A control that was clicked was, by definition, visible enough to click.
   * So the reveal is for keyboard focus, which is the case it was written for
   * — a control below the cut is drawn nowhere, and a focus ring around
   * nothing is no use to somebody moving through the page by tab.
   */
  const pointerHeld = useRef(false);
  const holdPointer = (): void => {
    pointerHeld.current = true;
  };
  const releasePointer = (): void => {
    pointerHeld.current = false;
  };
  /*
   * Released on the window, not on the panel.
   *
   * A press that starts on a control and ends outside it — a drag off a
   * checkbox, a scroll flick that leaves the dialog — never delivers its
   * `pointerup` to this subtree, and the flag would stay set. That would
   * silently disable the keyboard reveal until the next press, which is the
   * kind of latch that is invisible until somebody is tabbing through a
   * settings page and cannot see where they are.
   */
  useEffect(() => {
    window.addEventListener('pointerup', releasePointer);
    window.addEventListener('pointercancel', releasePointer);
    return () => {
      window.removeEventListener('pointerup', releasePointer);
      window.removeEventListener('pointercancel', releasePointer);
    };
  }, []);

  const focus = (id: string) => () => {
    setFocusedId(id);
    if (!pointerHeld.current) reveal(id);
  };
  const blur = (): void => setFocusedId(null);
  const stop = (event: React.MouseEvent): void => event.stopPropagation();

  return (
    <div
      role="dialog"
      aria-label={props.label}
      // Clicking the scrim is clicking away from the page, which is what the
      // CSS overlay did and what a player who opened this by accident expects.
      onClick={props.onClose}
      onPointerDownCapture={holdPointer}
      onPointerUpCapture={releasePointer}
      onPointerCancelCapture={releasePointer}
      style={{ position: 'fixed', inset: 0, zIndex: 40, overflow: 'hidden' }}
      {...dialog.props}
    >
      <PanelCanvas ref={canvasRef} view={view} />

      {/*
        The way out, first in the document.

        Before the scroll region and outside it, which `useDialog` relies on to
        land focus somewhere sensible and `overlay-panels.test.ts` has asserted
        since this panel was CSS: a booklet this long is read to the end, and
        the way to shut it used to scroll off the top with the cover.
      */}
      <button
        type="button"
        aria-label={props.closeLabel}
        onClick={(event) => {
          event.stopPropagation();
          props.onClose();
        }}
        onFocus={focus('close')}
        onBlur={blur}
        style={{
          ...boxStyle(close, view.scale, MIRROR),
          /*
           * Grown to a thumb, concentrically.
           *
           * The drawn mark is six buffer pixels, which at a 2x upscale is
           * twelve screen pixels and not something anybody hits on a phone.
           * `panel.ts` forbids mirroring a control *somewhere else* — a target
           * that disagrees with the picture — and this does not: the picture
           * stays inside the target and centred in it, which is what every
           * platform's minimum tap size means in the first place.
           */
          minWidth: 24,
          minHeight: 24,
          transform: 'translate(-50%, -50%)',
          marginLeft: (close.width * view.scale) / 2,
          marginTop: (close.height * view.scale) / 2,
          cursor: 'pointer',
          pointerEvents: 'auto',
          zIndex: 2,
        }}
      />

      {/*
        The page's own box.

        It takes the pointer, so a click on the page is not a click on the
        scrim behind it — and it is the element that stands for "the panel" to
        anything measuring where the panel is. `mobile.spec.ts` reads its
        rectangle to prove a settings sheet fits on an iPhone SE; there is no
        `.sm-panel` to measure any more, and a canvas that covers the whole
        viewport would answer that question with the viewport.
      */}
      <div
        data-testid="pixel-panel"
        onClick={stop}
        style={{ ...boxStyle(layout.panel, view.scale, { position: 'absolute' }), pointerEvents: 'auto' }}
      />

      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        onClick={stop}
        role="group"
        aria-label={`${props.label}, page`}
        // Focusable because it scrolls. A region a mouse can scroll and a
        // keyboard cannot is a region with content nobody can reach (§12), and
        // the browser gives arrow keys and Page Down to a focusable scroller
        // for free.
        tabIndex={0}
        style={{
          ...boxStyle(scrollport(layout), view.scale, { position: 'absolute' }),
          overflowY: 'auto',
          overflowX: 'hidden',
          // The campsite is behind this. Reaching the end of a page should not
          // then start moving the world.
          overscrollBehavior: 'contain',
          // No scrollbar: the dithered cut mark is the drawn evidence that the
          // page goes on, and a browser scrollbar over a pixel panel is the one
          // piece of chrome that cannot be drawn in this language.
          scrollbarWidth: 'none',
          pointerEvents: 'auto',
          outline: 'none',
        }}
      >
        <div style={{ position: 'relative', height: Math.max(1, layout.contentHeight * view.scale) }}>
          {layout.blocks.map((block) => (
            <div key={block.id}>
              {block.controls.length === 0
                ? semanticsFor(block, pageCoords(layout, block.rect), view.scale, props.testIds?.[block.id])
                : block.controls.map((control) => {
                    const row = toScreen(pageCoords(layout, control.rect), { scale: view.scale });
                    const chrome = toScreen(pageCoords(layout, control.control), { scale: view.scale });
                    const testId = props.testIds?.[control.id];
                    const inner: React.CSSProperties = {
                      ...MIRROR,
                      left: chrome.left - row.left,
                      top: chrome.top - row.top,
                      width: Math.max(1, chrome.width),
                      height: Math.max(1, chrome.height),
                      cursor: 'pointer',
                      pointerEvents: 'auto',
                    };
                    if (control.kind === 'button') {
                      return (
                        <button
                          key={control.id}
                          type="button"
                          {...(testId === undefined ? {} : { 'data-testid': testId })}
                          {...(control.pressed === undefined ? {} : { 'aria-pressed': control.pressed })}
                          disabled={control.disabled === true}
                          onClick={() => props.onButton?.(control.id)}
                          onFocus={focus(control.id)}
                          onBlur={blur}
                          style={{
                            ...inner,
                            left: row.left,
                            top: row.top,
                            width: Math.max(1, row.width),
                            height: Math.max(1, row.height),
                            cursor: control.disabled === true ? 'default' : 'pointer',
                          }}
                        >
                          {control.label}
                        </button>
                      );
                    }
                    if (control.kind === 'text') {
                      /*
                       * A real field, over the drawn well.
                       *
                       * `<textarea>` when the well is more than one line deep
                       * and `<input>` when it is one, because that is the
                       * difference a player can feel: Enter sends a line at the
                       * fire and adds one to a pasted code. Both are inside a
                       * `<label>` for the same reason every other control here
                       * is — `access.spec.ts` reads the label's own text, and
                       * `redeem.spec.ts` fills this by test id.
                       */
                      const field: React.CSSProperties = {
                        ...inner,
                        // A caret the browser draws at device resolution would
                        // be the one anti-aliased thing on the panel, and it
                        // sits *inside* an element at zero opacity anyway. The
                        // drawn block caret is the one a player sees.
                        caretColor: 'transparent',
                        resize: 'none',
                        overflow: 'hidden',
                        lineHeight: 1,
                        fontSize: 8,
                      };
                      const shared = {
                        ...(testId === undefined ? {} : { 'data-testid': testId }),
                        ...(control.maxLength === undefined ? {} : { maxLength: control.maxLength }),
                        ...(control.inputMode === undefined ? {} : { inputMode: control.inputMode }),
                        ...(control.placeholder === undefined ? {} : { placeholder: control.placeholder }),
                        value: control.value ?? '',
                        disabled: control.disabled === true,
                        spellCheck: false,
                        autoCapitalize: 'off',
                        autoCorrect: 'off',
                        onFocus: focus(control.id),
                        onBlur: blur,
                        style: field,
                      } as const;
                      return (
                        <label
                          key={control.id}
                          style={{
                            ...PROSE,
                            left: row.left,
                            top: row.top,
                            width: Math.max(1, row.width),
                            height: Math.max(1, row.height),
                            pointerEvents: 'auto',
                            cursor: 'text',
                          }}
                        >
                          {(control.rows ?? 1) > 1 ? (
                            <textarea
                              {...shared}
                              rows={control.rows ?? 1}
                              onChange={(event) => props.onText?.(control.id, event.target.value)}
                            />
                          ) : (
                            <input
                              {...shared}
                              type="text"
                              onChange={(event) => props.onText?.(control.id, event.target.value)}
                              onKeyDown={(event) => {
                                if (event.key !== 'Enter') return;
                                event.preventDefault();
                                props.onSubmit?.(control.id);
                              }}
                            />
                          )}
                          <span>{control.label}</span>
                          {control.hint !== undefined && <small>{control.hint}</small>}
                        </label>
                      );
                    }
                    const slider = props.sliders?.[control.id];
                    return (
                      <label
                        key={control.id}
                        style={{
                          ...PROSE,
                          left: row.left,
                          top: row.top,
                          width: Math.max(1, row.width),
                          height: Math.max(1, row.height),
                          pointerEvents: 'auto',
                          cursor: 'pointer',
                        }}
                      >
                        {control.kind === 'checkbox' ? (
                          <input
                            type="checkbox"
                            {...(testId === undefined ? {} : { 'data-testid': testId })}
                            checked={control.checked === true}
                            disabled={control.disabled === true}
                            onChange={(event) => props.onCheckbox?.(control.id, event.target.checked)}
                            onFocus={focus(control.id)}
                            onBlur={blur}
                            style={inner}
                          />
                        ) : (
                          <input
                            type="range"
                            {...(testId === undefined ? {} : { 'data-testid': testId })}
                            min={slider?.min ?? 0}
                            max={slider?.max ?? 1}
                            step={slider?.step ?? 0.05}
                            value={slider?.value ?? 0}
                            disabled={control.disabled === true}
                            onChange={(event) => props.onSlider?.(control.id, Number(event.target.value))}
                            onFocus={focus(control.id)}
                            onBlur={blur}
                            /*
                              The handle's drawn position, published on the
                              element the browser positions from.

                              It painted the WebKit track once; the canvas
                              paints the handle now. It is still here because
                              it is the seam `settings-sliders.test.ts`
                              measures — the number printed on the page against
                              the number the handle sits at — and that seam is
                              exactly as worth checking when the handle is
                              drawn as when it was a pseudo-element.
                            */
                            style={{ ...inner, '--sm-fill': `${(control.fraction ?? 0) * 100}%` } as React.CSSProperties}
                          />
                        )}
                        <span>{control.label}</span>
                        {/* `<small>` rather than a span: a hint is fine print,
                            which is what the element means, and it keeps the
                            row's spans to the three `settings-sliders.test.ts`
                            reads — label, mark, sentence. */}
                        {control.hint !== undefined && <small>{control.hint}</small>}
                        {/*
                          Two channels for one number, exactly as the CSS panel
                          carried them: the mark the page prints and the
                          sentence an ear needs. The drawn readout is the
                          spoken form here — see `Settings.tsx` for why "×1.00"
                          could not survive the move — and this span is what
                          `access.spec.ts` reads "100%" out of.
                        */}
                        {control.kind === 'slider' &&
                          (slider?.spoken === undefined || slider.spoken === control.readout ? (
                            <span>{control.readout ?? ''}</span>
                          ) : (
                            <>
                              {/* The mark the page prints, and then the
                                  sentence an ear needs. `Settings.tsx` argues
                                  this at length: "×1.00" read aloud is "times
                                  one point zero zero", which is not how
                                  anybody describes how large their type is. */}
                              <span aria-hidden="true">{control.readout ?? ''}</span>
                              <span>{slider.spoken}</span>
                            </>
                          ))}
                      </label>
                    );
                  })}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* The note                                                                   */
/* -------------------------------------------------------------------------- */

export interface PixelNoteProps {
  /** The live region's accessible name, and the scroller's. */
  readonly label: string;
  readonly blocks: readonly PanelBlock[];
  readonly textScale: number;
  readonly highContrast?: boolean;
  readonly frameInset?: number;
  readonly testId?: string;
  /** How much of the frame's height the note may take. */
  readonly maxFraction?: number;
}

/**
 * A page the world hands you, with no scrim and no focus trap.
 *
 * The spoken survey is not a dialog: it is not modal, it does not take focus,
 * and it goes away with the same key that opened it. What it shares with the
 * four dialogs is everything else — the same paper, the same font, the same
 * buffer, the same cut mark — which is the whole point of there being one kit.
 *
 * It stays a live region. §12's rule is that nothing may be delivered through
 * one channel, and this is the one line in the product the player explicitly
 * asked for, so it is announced as well as drawn — `assertive`, because
 * interrupting whatever else was being read is correct for something somebody
 * just asked for.
 */
export function PixelNote(props: PixelNoteProps): React.ReactElement {
  const viewport = useViewportSize();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const inset = props.frameInset ?? readFrameInset();
  /*
   * Under the corner affordances, up against the left rail.
   *
   * The same placement the CSS survey had and for the same reason: at the
   * largest text scale on the narrowest phone, a panel wide enough to be worth
   * reading and a pair of buttons wide enough to be worth pressing do not both
   * fit across one row.
   */
  const { view, spec } = useMemo(
    () =>
      overlayPage(viewport.width, viewport.height, inset, props.blocks, props.textScale, {
        anchor: 'corner',
        maxFraction: props.maxFraction ?? 0.62,
      }),
    [viewport.width, viewport.height, inset, props.blocks, props.textScale, props.maxFraction],
  );

  const scroll = useSnapScroll(spec, view.scale);
  const layout = useMemo(
    () => layoutPanel({ ...spec, scrollTop: scroll.scrollTop }),
    [spec, scroll.scrollTop],
  );

  useEffect(() => {
    const surface = paint(canvasRef.current, view);
    if (surface === null) return;
    drawPanel(surface, layout, {
      ...(props.highContrast === true ? { screen: null, highContrast: true } : {}),
    });
    // Same argument as the dialog's: this one sits over live gameplay, where
    // the HUD renders on every tick of the ritual.
  }, [view, layout, props.highContrast]);

  /*
   * The whole answer, in one live region, in reading order.
   *
   * Not one element per drawn line: the survey is prose that happens to have
   * been wrapped, and a screen reader reading a wrapped page line by line
   * reads it as a list. The block texts are what the world actually said.
   */
  const spoken = props.blocks
    .map((block) => ('text' in block ? block.text : ''))
    .filter((line) => line !== '')
    .join('\n');

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 21, pointerEvents: 'none' }}>
      <PanelCanvas ref={canvasRef} view={view} />
      <div
        ref={scroll.ref}
        onScroll={scroll.onScroll}
        role="status"
        aria-live="assertive"
        aria-atomic="true"
        aria-label={props.label}
        {...(props.testId === undefined ? {} : { 'data-testid': props.testId })}
        // Focusable because it scrolls, for the same reason the dialog's page
        // is: a talkative campsite has more to say than fits, and a region a
        // mouse can scroll and a keyboard cannot is content nobody can reach.
        tabIndex={0}
        style={{
          ...boxStyle(scrollport(layout), view.scale, PROSE),
          overflowY: 'auto',
          overflowX: 'hidden',
          overscrollBehavior: 'contain',
          scrollbarWidth: 'none',
          pointerEvents: 'auto',
          outline: 'none',
        }}
      >
        <div style={{ height: Math.max(1, layout.contentHeight * view.scale) }}>{spoken}</div>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/** The one `<canvas>` both panels draw into, sized in whole buffer pixels. */
const PanelCanvas = ({
  ref,
  view,
}: {
  ref: React.RefObject<HTMLCanvasElement | null>;
  view: OverlayView;
}): React.ReactElement => (
  <canvas
    ref={ref}
    aria-hidden
    width={view.width}
    height={view.height}
    style={{
      position: 'absolute',
      left: 0,
      top: 0,
      width: view.width * view.scale,
      height: view.height * view.scale,
      pointerEvents: 'none',
    }}
  />
);
