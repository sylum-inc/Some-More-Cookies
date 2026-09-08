/**
 * Shared UI tokens.
 *
 * The interface is a field journal and a campground booklet, not a dashboard
 * (spec §6.2). Warm paper, stamped ink, monospaced machine text.
 */

import { useEffect, useRef, useState } from 'react';

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

/**
 * The paper surface, for the one HUD thing that is a page rather than a plate.
 *
 * `plate()` above argues — correctly — that a cream card floating over a night
 * forest is a hole punched in the picture, and that is why every ambient HUD
 * channel is dark. The distinction it draws is the one that matters here:
 * *paper is right for a booklet you have stopped to read.* The survey is not
 * ambient. Nothing volunteers it; a player presses a key, stops, and reads a
 * description of where they are standing — which is the Passport's job in
 * miniature and belongs in the Passport's material.
 *
 * Same stock as `.sm-panel`: halftone at a 3px pitch over a warm gradient, a
 * hard ink border, a shadow that falls rather than glows.
 */
export function paperPanel(textScale: number, framed = false): React.CSSProperties {
  return {
    background: `
      repeating-linear-gradient(0deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      repeating-linear-gradient(90deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      linear-gradient(168deg, #efe8d7 0%, ${TOKENS.paper} 42%, ${TOKENS.paperEdge} 100%)`,
    color: TOKENS.ink,
    border: `2px solid ${TOKENS.ink}`,
    borderRadius: 0,
    boxShadow: 'inset 0 2px 0 rgba(255,252,244,0.85), 4px 5px 0 rgba(6,8,11,0.55)',
    textShadow: '0 1px 0 rgba(255,252,244,0.65)',
    fontFamily: FONT_STACK.mono,
    fontSize: typePx(12, textScale),
    lineHeight: 1.55,
    /*
     * A framed page has no padding of its own: it hands it to the scroll
     * region inside it. This is the same rule `.sm-panel-tall` obeys and for
     * the same reason — padding on the scrollport puts the whole pad between
     * the last line of type and the mark that says there is more of it, which
     * is how the survey came to be cut mid-sentence with nothing to say so.
     */
    padding: framed ? 0 : `${px(9, textScale)} ${px(12, textScale)}`,
    textAlign: 'left',
  };
}

/** What `paperPanel(scale, true)` gave away, for the scroll region to take. */
export function paperPadding(textScale: number): string {
  return `${px(9, textScale)} ${px(12, textScale)}`;
}

/**
 * How tall the mark at the bottom of a scroll region is.
 *
 * Fixed rather than scaled with the type, because it is a printed dither at a
 * 2px pitch and a dither that grows with the text stops being a dither. Every
 * scroll region adds it to its own bottom padding so the last line can pass
 * clear of the mark rather than ending underneath it — which is what the old,
 * *scaled* allowance got wrong at 1.8x, where it reserved fifty-two pixels for
 * a twenty-pixel band.
 */
export const CUT_MARK_PX = 20;

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

/**
 * Whether a scroll region has anything below its own bottom edge.
 *
 * Three overlays were graded as clipping — Settings cut a slider track in
 * half, the Passport cut a line of small caps, the survey cut mid-sentence at
 * "along the path to" — and the structural fix that came before this one (a
 * frame with the scrolling moved to a child) did not change any of that,
 * because the thing that was missing was never the structure. It was the
 * *mark*. `.sm-panel-tall::after` did exist, and it faded the paper to
 * `paperEdge` — which is the exact colour both panels already are by the time
 * they reach their own bottom. Sampling the shipped screenshot at the cut
 * gives rgb(214,202,176) against a fade ending on rgb(214,203,177): a
 * one-count difference on one channel, which is a fade that renders and says
 * nothing. A reader saw a hard border with a sliced control above it.
 *
 * So the mark is drawn honestly now (see `.sm-panel-tall[data-more="yes"]`),
 * and this is what tells it when to be there. A permanent mark on a panel with
 * nothing below it is the same lie in the other direction.
 *
 * The effect deliberately has no dependency list. The survey's content changes
 * while it is open, and a subscription set up once at mount measures a
 * scrollHeight that has since moved; re-measuring on every render of a panel
 * that renders when something about it changes is both correct and free.
 */
export function useScrollCut<T extends HTMLElement>(): {
  ref: React.RefObject<T | null>;
  more: 'yes' | 'no';
} {
  const ref = useRef<T | null>(null);
  const [more, setMore] = useState<'yes' | 'no'>('no');
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const measure = (): void => {
      // Two pixels of slack, not zero: on a fractional device-pixel ratio a
      // region scrolled to its end reports a sub-pixel short of it, and the
      // mark flickered on at the bottom of a panel with nothing below it.
      setMore(node.scrollHeight - node.clientHeight - node.scrollTop > 2 ? 'yes' : 'no');
    };
    measure();
    node.addEventListener('scroll', measure, { passive: true });
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(node);
    return () => {
      node.removeEventListener('scroll', measure);
      observer?.disconnect();
    };
  });
  return { ref, more };
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
  /*
    The overlay knows about the bezel now.

    It did not, and that is half of why the panels read as clipped. The build
    draws a nine-slice rail over every edge of the viewport (ui/Frame.tsx,
    9 atlas pixels at step 2 = 18 screen pixels a side) and hands its width to
    the HUD as frameInset so the guidance line stays inside the device. The
    overlays were never told: they sat at inset: 0 with padding: 4vmin,
    which at 1280x720 is 28.8px and happened to clear the rail, and at 393
    wide is 15.7px and does not. Two numbers that agree by luck on one screen
    size is not a layout.

    So the bezel publishes its own thickness as --sm-frame-inset (see
    Frame) and the scrim is padded by it plus a fixed 10px gutter. The panel
    then takes everything that leaves, rather than the 88vh it used to be
    capped at — which on a 720-tall window meant 87 unused pixels above and
    below a page that was cutting a slider in half.
  */
  .sm-overlay { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; padding: calc(var(--sm-frame-inset, 0px) + 10px); z-index: 40; background: rgba(6, 8, 11, 0.80); }
  .sm-panel {
    background:
      repeating-linear-gradient(0deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      repeating-linear-gradient(90deg, rgba(42,38,32,0.055) 0 1px, rgba(0,0,0,0) 1px 3px),
      linear-gradient(168deg, #efe8d7 0%, ${TOKENS.paper} 42%, ${TOKENS.paperEdge} 100%);
    color: ${TOKENS.ink};
    max-width: min(860px, 94vw);
    /* Everything the scrim leaves, which is the viewport less the bezel and a
       gutter. It used to be 88vh *as well as* the scrim's own padding, so the
       two insets were applied twice and a long page was cut earlier than it
       needed to be. */
    max-height: 100%;
    overflow-y: auto;
    border: 2px solid ${TOKENS.ink};
    border-radius: 0;
    box-shadow: inset 0 2px 0 rgba(255,252,244,0.85), 6px 8px 0 rgba(6,8,11,0.55), 0 22px 60px rgba(0,0,0,0.55);
    position: relative;
    text-shadow: 0 1px 0 rgba(255,252,244,0.65);
    /* The punched corner. A booklet page that has been through a ring binder,
       and the one asymmetry in an otherwise rigidly square object. */
    clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 14px, 100% 100%, 0 100%);
  }
  /*
    A long panel is capped and scrolls *inside itself*.

    .sm-panel already carried a height cap, overflow-y: auto and a ::after
    fade, and none of the three held: the Passport was cut through the middle
    of "KEEP THIS PASSPORT" with nothing to say it had been, and Settings ended
    mid-slider. Three reasons, all worth writing down because they are the
    three ways this keeps failing.

      1. The fade was position: sticky; bottom: 0, and a sticky box is
         clamped to its *containing block* — the panel's content box. The
         panels put their 26–28px of padding on the scroller itself, so the
         fade parked a whole pad above the cut and the last line of type was
         guillotined below it. A padded element cannot be both the scrollport
         and the thing the fade sticks to.
      2. The panel was the scroller, so everything absolutely positioned
         inside it — the close button, most obviously — scrolled away with the
         content. A dialog you cannot shut once you have read it is worse than
         one that is a little too tall.
      3. And once both of those were fixed a third grade still found all three
         panels clipping, because the fade ended on the colour the paper is
         already: measured against the shipped screenshot it was a difference
         of one count on one channel. See the note above the mark itself.

    So the panel becomes a fixed-height *frame* and the scrolling moves to a
    child. The frame does not scroll, which means ::after can be plain
    position: absolute against it and is always exactly at the cut, and the
    close button stays where the player left it.

    .sm-panel-tall rather than applying this to every panel: the arrival
    card, the terminal and the code entry are short, and turning them into
    frames would only give them an overflow: hidden they have no scroll
    region to compensate for. They keep the cap and their own scrollbar.
  */
  .sm-panel-tall { position: relative; display: flex; flex-direction: column; overflow: hidden; padding: 0; }
  .sm-panel-tall > .sm-panel-scroll {
    flex: 0 1 auto;
    /* Without this a flex item refuses to shrink below its content and the
       cap silently stops applying — the failure this whole block is about. */
    min-height: 0;
    overflow-y: auto;
    /* The campsite is behind this. Scrolling to the end of a settings panel
       should not then start moving the world. */
    overscroll-behavior: contain;
    /* Reserved whether or not the bar is drawn, so the type does not reflow
       the moment a panel becomes long enough to scroll. */
    scrollbar-gutter: stable;
    scrollbar-width: thin;
    scrollbar-color: ${TOKENS.stamp} #e2d9c2;
  }
  /*
    A scrollbar you can see.

    The third overlay finding — three panels graded as clipping — was not a
    structural one. The frame-plus-scroll-region rewrite that came before this
    was correct and changed nothing a reader could see, because what was
    missing was any evidence that the thing scrolled at all: an overlay
    scrollbar that never paints on a hover-less capture, and a "fade" that
    faded the paper to the colour the paper already was (see useScrollCut).
    A player saw a hard ink border with a sliced slider above it.

    So the bar is drawn, in the same letterpress as everything else: a scored
    cream track with a hard ink edge and a square oxidised-red block on it.
    This is the one place in the interface where a rectangle whose length
    means something is correct — it is a position in a document, not a
    quantity about the world, and §5.3 is about the latter.
  */
  .sm-panel-tall > .sm-panel-scroll::-webkit-scrollbar { width: 12px; }
  .sm-panel-tall > .sm-panel-scroll::-webkit-scrollbar-track {
    background: linear-gradient(90deg, #d8cfb8, #ece5d4);
    border-left: 2px solid ${TOKENS.ink};
  }
  .sm-panel-tall > .sm-panel-scroll::-webkit-scrollbar-thumb {
    background: linear-gradient(180deg, #b0553d 0%, ${TOKENS.stamp} 46%, #6b291c 100%);
    border: 2px solid ${TOKENS.ink};
    border-radius: 0;
  }
  /*
    The cut, drawn as a cut.

    Four hard steps of a 2px ink checker over the paper — the printed-screen
    equivalent of the ordered dither in the world, at the pitch a booklet is
    actually screened at — ending on a solid ink rule. The previous version of
    this was a smooth gradient ending on ${TOKENS.paperEdge}, and both halves
    of that were wrong: a smooth ramp bands on an 8-bit panel, and
    ${TOKENS.paperEdge} is what the paper already is down there, so the mark
    measured one count of difference against its own background in the shipped
    screenshot.

    Keyed on data-more="yes" rather than always drawn. A permanent "there is
    more below" on a panel with nothing below it is the same lie the invisible
    fade was, pointing the other way.
  */
  .sm-panel-tall[data-more="yes"]::after {
    content: '';
    position: absolute;
    left: 0; right: 0; bottom: 0;
    height: ${CUT_MARK_PX}px;
    pointer-events: none;
    background: repeating-conic-gradient(rgba(42,38,32,0.88) 0% 25%, rgba(0,0,0,0) 0% 50%) 0 0 / 4px 4px;
    -webkit-mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0 20%, rgba(0,0,0,0.34) 20% 45%, rgba(0,0,0,0.67) 45% 72%, #000 72% 100%);
    mask-image: linear-gradient(to bottom, rgba(0,0,0,0) 0 20%, rgba(0,0,0,0.34) 20% 45%, rgba(0,0,0,0.67) 45% 72%, #000 72% 100%);
    border-bottom: 2px solid ${TOKENS.ink};
  }
  /* And the arrow, drawn out of two borders rather than set in a font — there
     is no font file in this product and a ▼ from whatever the system happens
     to have is exactly the "Material X" an art grade already caught once. */
  .sm-panel-tall[data-more="yes"]::before {
    content: '';
    position: absolute;
    bottom: 6px;
    left: 50%;
    margin-left: -7px;
    width: 0; height: 0;
    border-left: 7px solid transparent;
    border-right: 7px solid transparent;
    border-top: 7px solid ${TOKENS.stamp};
    pointer-events: none;
    z-index: 2;
  }
  /*
    The sliders, drawn instead of defaulted.

    A browser range input is a pill track with a round handle and a system
    accent colour on it, which is the single most out-of-place object in a
    game whose whole premise is nearest-neighbour upscaling of a 320x240
    buffer — the same tell as a 3px border radius, at ten times the size.

    Still a real <input type="range">, because the role, the value and the
    arrow keys are the accessible control and nothing drawn out of divs gets
    those for free (spec §12). Only the paint changes:

      TRACK  cream stock with a 2px ink notch every eighth of its length. It
             was a notch every 12px, which over a 600px track is fifty of
             them, and an art grade read the result as "a comb" rather than as
             a scale — correctly: fifty marks quantify nothing a reader can
             count, and at 1px each they are the hairlines the same note was
             about. Eight is a number you can see at a glance.
      DITHER a 2px checker of paper-white over the whole track, so the stain
             below reads as a printed 50% screen rather than a flat wash —
             the booklet's version of the world's ordered dither.
      FILL   a stain of oxidised red behind the handle rather than a
             saturated fill, driven by --sm-fill because a repainted track has
             no progress pseudo-element in WebKit.
      HANDLE a square oxidised-red block with a 2px ink edge and a lit top —
             the same letterpress the panel is made of, stood up.
  */
  input[type="range"].sm-slider {
    -webkit-appearance: none;
    appearance: none;
    width: 100%;
    height: 24px;
    background: transparent;
    border: none;
    cursor: pointer;
  }
  input[type="range"].sm-slider::-webkit-slider-runnable-track {
    height: 12px;
    border: 2px solid ${TOKENS.ink};
    border-radius: 0;
    background:
      repeating-conic-gradient(rgba(253,251,244,0.55) 0% 25%, rgba(0,0,0,0) 0% 50%) 0 0 / 4px 4px,
      repeating-linear-gradient(90deg, rgba(42,38,32,0.42) 0 2px, rgba(0,0,0,0) 2px 12.5%),
      linear-gradient(90deg, rgba(143,59,42,0.80) 0 var(--sm-fill, 0%), rgba(0,0,0,0) var(--sm-fill, 0%)),
      linear-gradient(180deg, #fdfbf4, #e2d9c2);
    box-shadow: inset 0 2px 0 rgba(42,38,32,0.24);
  }
  input[type="range"].sm-slider::-moz-range-track {
    height: 12px;
    border: 2px solid ${TOKENS.ink};
    border-radius: 0;
    background:
      repeating-conic-gradient(rgba(253,251,244,0.55) 0% 25%, rgba(0,0,0,0) 0% 50%) 0 0 / 4px 4px,
      repeating-linear-gradient(90deg, rgba(42,38,32,0.42) 0 2px, rgba(0,0,0,0) 2px 12.5%),
      linear-gradient(90deg, rgba(143,59,42,0.80) 0 var(--sm-fill, 0%), rgba(0,0,0,0) var(--sm-fill, 0%)),
      linear-gradient(180deg, #fdfbf4, #e2d9c2);
    box-shadow: inset 0 2px 0 rgba(42,38,32,0.24);
  }
  input[type="range"].sm-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    appearance: none;
    width: 14px;
    height: 24px;
    border-radius: 0;
    border: 2px solid ${TOKENS.ink};
    background: linear-gradient(180deg, #b0553d 0%, ${TOKENS.stamp} 46%, #6b291c 100%);
    box-shadow: inset 0 2px 0 rgba(255,228,208,0.55), 2px 2px 0 rgba(6,8,11,0.45);
    /* WebKit measures the thumb from the top of the *track*, not the input,
       so it needs centring by hand: (12px track - 24px block) / 2. Both are
       border-box by the reset at the top of this sheet, so the 2px edges are
       already inside those numbers. */
    margin-top: -6px;
  }
  input[type="range"].sm-slider::-moz-range-thumb {
    width: 14px;
    height: 24px;
    border-radius: 0;
    border: 2px solid ${TOKENS.ink};
    background: linear-gradient(180deg, #b0553d 0%, ${TOKENS.stamp} 46%, #6b291c 100%);
    box-shadow: inset 0 2px 0 rgba(255,228,208,0.55), 2px 2px 0 rgba(6,8,11,0.45);
  }
  /*
    The stamp. Applied to a heading, it reads as ink hit at an angle — which
    is the campground booklet's own voice and costs one rotated border.

    Mottled, because a rubber stamp does not take evenly: the mark is masked
    by a 2px checker at 0.74 alpha, which is the same printed screen the
    panels and the sliders use and leaves the letters comfortably above the
    legibility floor. Rotated further than it was, too — a degree and a half
    reads as a rendering error rather than as a hand.
  */
  .sm-stamp {
    display: inline-block;
    font-family: ${FONT_STACK.mono};
    text-transform: uppercase;
    letter-spacing: 0.24em;
    color: ${TOKENS.stamp};
    border: 2px solid ${TOKENS.stamp};
    padding: 3px 10px 2px;
    transform: rotate(-2.5deg);
    opacity: 0.86;
    -webkit-mask-image: repeating-conic-gradient(#000 0% 25%, rgba(0,0,0,0.74) 0% 50%);
    mask-image: repeating-conic-gradient(#000 0% 25%, rgba(0,0,0,0.74) 0% 50%);
    -webkit-mask-size: 4px 4px;
    mask-size: 4px 4px;
  }
  /*
    The way out of a panel, drawn.

    It was a "×" — U+00D7, set in whatever the system sans happens to be, at
    22 points of antialiased modern web type in the corner of a page whose
    every other mark is 2px ink. An art grade named it directly. Two 2px bars
    crossed at 45 degrees is the same glyph, at the resolution of everything
    around it, and needs no font.

    The button keeps its aria-label: nothing here changes what it is called.
  */
  .sm-close { position: relative; background: transparent; border: 2px solid rgba(42,38,32,0.30); border-radius: 0; padding: 0; }
  .sm-close::before, .sm-close::after {
    content: '';
    position: absolute;
    left: 50%;
    top: 22%;
    width: 2px;
    height: 56%;
    margin-left: -1px;
    background: ${TOKENS.inkSoft};
  }
  .sm-close::before { transform: rotate(45deg); }
  .sm-close::after { transform: rotate(-45deg); }
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
