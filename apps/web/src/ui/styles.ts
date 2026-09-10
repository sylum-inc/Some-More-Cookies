/**
 * Shared UI tokens.
 *
 * The interface is a field journal and a campground booklet, not a dashboard
 * (spec §6.2). Warm paper, stamped ink, monospaced machine text.
 *
 * ## What is left in here, and what is not
 *
 * The overlays are not. All five are drawn into the pixel buffer now, in the
 * eleven colours of `ui/pixel/palette.ts` and the 5x9 face of
 * `render/bitmapFont.ts`, and the four hundred lines of panel material that
 * used to live at the bottom of `GLOBAL_CSS` went with the last of them. The
 * note where they used to be says where each rule ended up.
 *
 * What remains is what is genuinely still CSS: the tokens themselves (which
 * `pixel/palette.ts` copies, exactly, and a test holds it to), the HUD's dark
 * plates, its grid of named areas, the focus outline and the reduced-motion
 * rule. `TOKENS` is the one thing in this file both worlds share, and that is
 * the point of it.
 */

// No React hook lives here any more — `useScrollCut` was the last one and the
// layout answers its question by construction. The import stays for the
// `React.CSSProperties` the style helpers below are typed as.
import type React from 'react';

export const TOKENS = {
  paper: '#e8e0cd',
  paperEdge: '#d6cbb1',
  ink: '#2a2620',
  inkSoft: '#5c554a',
  stamp: '#8f3b2a',
  night: '#0a0d12',
  amber: '#ffa42c',
  ice: '#8fd4ff',
  ember: '#ff6a1f',
} as const;

export const FONT_STACK = {
  hand: '"Bradley Hand", "Segoe Print", "Comic Sans MS", cursive',
  serif: 'Georgia, "Times New Roman", serif',
  mono: '"Courier New", ui-monospace, monospace',
  sans: '"Helvetica Neue", Arial, sans-serif',
} as const;

/**
 * Whole pixels, everywhere, always.
 *
 * Every size in this interface is a base number times the player's text scale,
 * and text scale runs 0.85 to 1.8 in steps of 0.05 — so almost every one of
 * them was landing on a fraction. `12.5 * 1.15` is 14.375px, which the browser
 * renders by antialiasing the stems of the type across two device pixels, and
 * an art grade of the build called the result "fully antialiased modern web
 * typography" sitting next to a nearest-neighbour 320x240 world. It was right:
 * the world cannot draw a half-pixel and neither should the panels over it.
 *
 * Rounding at the point of use rather than trusting authors to pick sizes that
 * happen to divide, because the multiplier is the player's and there is no set
 * of base numbers that stays whole across all twenty of its stops.
 */
export function px(n: number, scale = 1): string {
  return `${Math.round(n * scale)}px`;
}

/**
 * The same, for type, with a floor.
 *
 * Eight pixels is where a monospaced capital stops being a letter and becomes
 * a smudge; the smallest thing on these panels is a 10px label, so at the
 * bottom of the text-scale range (0.85) it lands on 9 and the floor never
 * fires. It is here so that a future 7px caption cannot quietly ship.
 */
export function typePx(n: number, scale = 1): string {
  return `${Math.max(8, Math.round(n * scale))}px`;
}

/**
 * What the heads-up display is made of.
 *
 * §6.2 has always said field journal and campground booklet — warm paper,
 * stamped ink, monospaced machine text — and the HUD had been ignoring it: 11
 * to 13 pixels of system sans in slate-grey rounded rectangles, which is what
 * a browser looks like and not what this looks like. Every channel drew its
 * own box, so the boxes also disagreed with each other about width, colour and
 * corner radius, and two of them stacked at different offsets.
 *
 * One plate, therefore, and everything sits on it. Three surfaces:
 *
 *   PLATE   what the world says. A dark, warm, deeply recessed card with a
 *           stamped amber rule down its leading edge — the rule is the whole
 *           identity, and it is the one place the HUD is allowed a saturated
 *           colour.
 *   PANEL   what your thumb can do. The same card, bevelled *out* instead of
 *           in, because a thing you press must look like it stands up.
 *   MACHINE small monospaced capitals for anything the SM-01 or the sky is
 *           reporting, which is the "machine text" half of §6.2.
 *
 * Dark rather than the cream paper the overlays use, deliberately. Paper is
 * right for a booklet you have stopped to read; a cream card floating over a
 * night forest is a hole punched in the picture, and the D7 legibility floor
 * cuts both ways — a HUD that outshines the fire is as wrong as one that
 * disappears into it.
 */
export const SURFACE = {
  /** The card itself: warm-black, not the blue-grey it used to be. */
  plate: 'linear-gradient(180deg, rgba(26,22,18,0.90), rgba(14,12,10,0.94))',
  plateHigh: 'rgba(6,5,4,0.96)',
  /**
   * The lit edge along the top, and the shadow the card sits in.
   *
   * Two pixels, not one. A 1px inset highlight over a 320x240 world upscaled
   * by four is a quarter of a world pixel: at every scale factor the browser
   * resolves it by fading it, so the bevel that was supposed to say "this
   * stands up" arrived as a grey blur along one edge. Two pixels survives the
   * rounding and reads as the moulded plastic it is imitating.
   */
  bevelOut:
    'inset 2px 2px 0 rgba(214,203,177,0.22), inset -2px -2px 0 rgba(0,0,0,0.62), 0 2px 5px rgba(0,0,0,0.55)',
  bevelIn:
    'inset 2px 2px 0 rgba(0,0,0,0.62), inset -2px -2px 0 rgba(214,203,177,0.14), 0 2px 4px rgba(0,0,0,0.5)',
  /** The stamped rule. Three pixels, on the leading edge, always. */
  rule: `3px solid ${TOKENS.amber}`,
  ruleQuiet: `3px solid ${TOKENS.stamp}`,
  /** Ink on this surface, as paper would be under a lamp. */
  ink: 'rgba(232,224,205,0.94)',
  inkSoft: 'rgba(232,224,205,0.66)',
} as const;

/**
 * The prose plate: the one thing on screen that should look like a book.
 *
 * Square corners on purpose. A rounded rectangle is the single most reliable
 * tell that something was styled by a web framework rather than drawn, and
 * this game is imitating hardware that could not draw one.
 */
export function plate(textScale: number, high = false): React.CSSProperties {
  return {
    background: high ? SURFACE.plateHigh : SURFACE.plate,
    color: SURFACE.ink,
    borderLeft: high ? SURFACE.rule : SURFACE.ruleQuiet,
    borderRadius: 0,
    boxShadow: SURFACE.bevelIn,
    padding: `${px(7, textScale)} ${px(12, textScale)}`,
    fontFamily: FONT_STACK.mono,
    // 12, not 12.5: see `px` above. Half a pixel of body type is the single
    // largest source of antialiasing in the whole interface.
    fontSize: typePx(12, textScale),
    lineHeight: 1.42,
    textAlign: 'left',
  };
}

/*
 * `paperPanel`, `paperPadding` and `CUT_MARK_PX` were here.
 *
 * They were the CSS panel's stock — a halftone over a warm gradient, a hard
 * ink border, and a fixed allowance at the bottom of a scroll region for the
 * mark that says a page continues. Every one of them is now drawn:
 * `ui/pixel/chrome.ts` mitres the border and `drawPaperPanel` screens the
 * paper, `ui/pixel/dither.ts` puts the halftone on it, and the allowance is
 * `PanelMetrics.cutMark`, which is reserved by `layoutPanel` rather than
 * remembered by each caller. The arguments they carried went with them into
 * those files; nothing was thrown away except the declarations.
 */

/**
 * Off screen, but read aloud.
 *
 * The `clip`/`clip-path` pair rather than `display: none` or `visibility:
 * hidden`, either of which takes the element out of the accessibility tree as
 * well as out of the picture, which is the opposite of what this is for.
 */
export const SR_ONLY: React.CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

/** Small monospaced capitals, for what a machine or the sky is reporting. */
export function machineText(textScale: number): React.CSSProperties {
  return {
    fontFamily: FONT_STACK.mono,
    fontSize: typePx(10, textScale),
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: SURFACE.inkSoft,
  };
}

/*
 * `useScrollCut` was here.
 *
 * It measured a DOM scroller and told `.sm-panel-tall` whether to draw its
 * mark. `layoutPanel` answers the same question by construction now — it knows
 * where the flow ends and where the viewport does, so `PanelLayout.cut` is
 * null when there is nothing below and a rectangle when there is, and there is
 * no scrollHeight to measure or ResizeObserver to keep alive. The lesson it
 * was written for survives in `pixel/panel.ts`: a mark on a page with nothing
 * below it is the same lie as no mark on a page that has more.
 */

/** Injects the global stylesheet. */
export const GLOBAL_CSS = `
  * { box-sizing: border-box; }
  html, body, #root { height: 100%; margin: 0; padding: 0; background: ${TOKENS.night}; overflow: hidden; }
  body { font-family: ${FONT_STACK.sans}; color: ${TOKENS.paper}; -webkit-font-smoothing: antialiased; overscroll-behavior: none; }
  /* The low internal resolution is upscaled with nearest, which is the whole
     point of ADR-0003 — never let the browser smooth it. */
  canvas { image-rendering: pixelated; image-rendering: crisp-edges; touch-action: none; display: block; }
  button { font: inherit; color: inherit; cursor: pointer; }
  /*
    The overlays used to be here, and they are drawn now.

    .sm-overlay, .sm-panel, .sm-panel-tall, .sm-panel-scroll and its scrollbar,
    the cut mark keyed on data-more, the repainted input[type="range"]
    .sm-slider, .sm-stamp and .sm-close were about four hundred lines of this
    sheet, and the last of the five panels that used them moved into the pixel
    buffer with this change (spec section 6.2). Every one of them exists, in
    the game's own eleven colours and its own font, in ui/pixel/ — the halftone
    in dither.ts, the mitred bevel and the stamp and the slider in chrome.ts,
    the cut in panel.ts, the scrim over the world in dither.ts — and the
    reasoning each rule carried moved with it rather than being deleted. Read
    those files: none of this is lost, and none of it is CSS any more.

    (No backticks in this comment, and that is not fussiness. This whole string
    is a template literal, so one backtick in a note about a selector ends the
    stylesheet in the middle of a sentence and the rest of the file becomes
    something the parser has to guess at.)

    Two things about them were structural rather than decorative and are worth
    saying once more here, because they are the reasons the panels kept
    failing:

      1. NOTHING SHIPPED IS A FADE THAT MATCHES ITS OWN BACKGROUND. The mark at
         a cut is a *dither*, which is legible at any two colours because a
         reader sees the pattern rather than the value. A gradient ending on
         the colour the paper already was shipped three times and could not be
         seen in any of them.
      2. THE BEZEL IS PUBLISHED, NOT GUESSED. --sm-frame-inset is still written
         on the root element by ui/Frame.tsx and is still what an overlay
         insets itself by: PixelPanel takes it as a prop and falls back to
         reading that property. Two numbers that agree by luck at one window
         size is not a layout.
  */
  /*
    The bottom of the frame, in the two shapes a screen comes in.

    Hud.tsx's doctrine is one column down the left for what the world says and
    one up the right for what your thumb can do, and on a phone the markup was
    not honouring it: the left column and the right column were *stacked*, so
    the bottom of the screen was as tall as the sum of the two. In landscape
    on a 393-line viewport that sum is taller than the viewport, and the words
    rode up over the status chips in the top-left corner — visible in
    artifacts/gallery/phone-landscape.png, and not caught by the mobile suite
    because it only checks channel collisions in portrait. In portrait the
    same stack parked two plates of prose directly over the fire, which is the
    subject of the game.

    So this is a grid with named areas and one query, rather than a stack with
    exceptions in it. The query is on the aspect of the window, not on a device
    width, because the thing that decides which arrangement works is whether
    there is more room across or down:

      TALL   the words dock to the bottom edge, in one full-width band, and
             everything you can press stacks above them. This is the shape a
             dialogue box has had since 1989 and it is the shape that leaves
             the middle of the picture alone.
      WIDE   the words and the acts share one row, so the bottom of the screen
             is as tall as the taller of them rather than as tall as both, and
             the pad sits under the words on the left where a thumb is.

    The whole grid is then capped short of the top so the corner the status
    chips live in is reserved rather than merely usually free.
  */
  .sm-hud-bottom {
    display: grid;
    align-content: end;
    grid-template-columns: 1fr;
    grid-template-areas: "acts" "stick" "bite" "words";
    /* 64px: the chips are a 12px pad and a row of 16px sprites, and the art
       direction asks for the top-left 150x50 to be theirs. Overflow is hidden
       rather than allowed to ride up, so in the pathological case — every
       channel talking at once at 1.8x text — the oldest line goes off the top
       instead of landing on the corner. Every one of those channels is a live
       region as well, so nothing said is lost, only unshown. */
    max-height: calc(100% - 64px);
    overflow: hidden;
  }
  .sm-hud-words { grid-area: words; }
  .sm-hud-stick { grid-area: stick; }
  .sm-hud-bite { grid-area: bite; }
  .sm-hud-acts { grid-area: acts; }
  @media (min-aspect-ratio: 1/1) {
    .sm-hud-bottom {
      grid-template-columns: minmax(0, 1fr) auto;
      grid-template-areas: "bite bite" "words acts" "stick acts";
    }
  }
  .sm-focus:focus-visible { outline: 3px solid ${TOKENS.amber}; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
