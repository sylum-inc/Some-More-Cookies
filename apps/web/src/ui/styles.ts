/**
 * Shared UI tokens.
 *
 * The interface is a field journal and a campground booklet, not a dashboard
 * (spec §6.2). Warm paper, stamped ink, monospaced machine text.
 */

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
  /** A hairline of lit edge along the top, and the shadow the card sits in. */
  bevelOut:
    'inset 1px 1px 0 rgba(214,203,177,0.22), inset -1px -1px 0 rgba(0,0,0,0.62), 0 2px 5px rgba(0,0,0,0.55)',
  bevelIn:
    'inset 1px 1px 0 rgba(0,0,0,0.62), inset -1px -1px 0 rgba(214,203,177,0.14), 0 1px 3px rgba(0,0,0,0.5)',
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
    padding: `${7 * textScale}px ${12 * textScale}px`,
    fontFamily: FONT_STACK.mono,
    fontSize: `${12.5 * textScale}px`,
    lineHeight: 1.42,
    textAlign: 'left',
  };
}

/** Small monospaced capitals, for what a machine or the sky is reporting. */
export function machineText(textScale: number): React.CSSProperties {
  return {
    fontFamily: FONT_STACK.mono,
    fontSize: `${10.5 * textScale}px`,
    letterSpacing: '0.18em',
    textTransform: 'uppercase',
    color: SURFACE.inkSoft,
  };
}

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
    The overlays are printed matter, not web panels.

    They were cream paper with Georgia on it behind a Gaussian blur, which is a
    handsome document and the wrong object: an art review called it "two
    products in one window", and it is right — you cut from a dithered forest
    to something that could be an article on any website. Three things fix it,
    and none of them is a picture:

      1. NO BLUR AND NO ROUNDED CORNERS. A backdrop blur filter is a
         post-2015 effect on top of a render pipeline whose entire premise is
         nearest-neighbour upscaling of a 320x240 buffer, and a 3px radius is
         the single clearest tell that something was styled rather than drawn.
         The scrim is a flat wash instead, and every corner is square.
      2. A HALFTONE. Two crossed repeating gradients at a 3px pitch, which is a
         printed dot screen — the same idea as the ordered dither in the world,
         at the size a booklet would actually be screened at. It sits over the
         paper at low alpha, so the paper stops being a flat #e8e0cd field and
         starts being stock.
      3. LETTERPRESS. A hard ink border, a hairline of light along the top
         inner edge, and a shadow that falls rather than glows. Type on this
         gets a 1px light shadow below it, which is what ink pressed into paper
         does to the fibre beside it.
  */
  .sm-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: 4vmin; z-index: 40; background: rgba(6, 8, 11, 0.80); }
  .sm-panel {
    background:
      repeating-linear-gradient(0deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      repeating-linear-gradient(90deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      linear-gradient(168deg, #efe8d7 0%, ${TOKENS.paper} 42%, ${TOKENS.paperEdge} 100%);
    color: ${TOKENS.ink};
    max-width: min(860px, 94vw);
    max-height: 88vh;
    overflow-y: auto;
    border: 2px solid ${TOKENS.ink};
    border-radius: 0;
    box-shadow: inset 0 1px 0 rgba(255,252,244,0.85), 6px 8px 0 rgba(6,8,11,0.55), 0 22px 60px rgba(0,0,0,0.55);
    position: relative;
    text-shadow: 0 1px 0 rgba(255,252,244,0.65);
    /* The punched corner. A booklet page that has been through a ring binder,
       and the one asymmetry in an otherwise rigidly square object. */
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%);
  }
  .sm-panel::after { content: ''; display: block; position: sticky; bottom: 0; height: 28px; margin-top: -28px; background: linear-gradient(to bottom, rgba(0,0,0,0), ${TOKENS.paperEdge}); pointer-events: none; }
  /* The stamp. Applied to a heading, it reads as ink hit at an angle — which
     is the campground booklet's own voice and costs one rotated border. */
  .sm-stamp {
    display: inline-block;
    font-family: ${FONT_STACK.mono};
    text-transform: uppercase;
    letter-spacing: 0.24em;
    color: ${TOKENS.stamp};
    border: 2px solid ${TOKENS.stamp};
    padding: 3px 10px 2px;
    transform: rotate(-1.5deg);
    opacity: 0.82;
  }
  .sm-focus:focus-visible { outline: 3px solid ${TOKENS.amber}; outline-offset: 2px; }
  @media (prefers-reduced-motion: reduce) { * { animation-duration: 0.01ms !important; transition-duration: 0.01ms !important; } }
`;
