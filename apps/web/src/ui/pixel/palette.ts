/**
 * The palette the overlays are allowed to be made of.
 *
 * The art grade's charge against the panels was not only that the type was
 * anti-aliased. It was that they had "no palette relationship" with the world:
 * a browser rendering `rgba(255,252,244,0.85)` over `#e8e0cd` over a halftone
 * gradient produces a few hundred distinct colours on a page whose neighbour
 * on screen is a nearest-neighbour buffer quantised to a handful. Alpha is
 * where they came from — every one of those `rgba()` washes is a colour
 * nobody chose, invented by the compositor at paint time.
 *
 * So this module is the whole answer to "what colour is that": eleven entries,
 * no alpha anywhere in the kit, and a surface that will not accept anything
 * else (see `surface.ts` — `fill` takes a key, never a string). A panel that
 * is nearly-but-not-quite the world's paper is the same defect as a panel in
 * Georgia, and the way to make it impossible is to make the wrong colour
 * unrepresentable rather than to remember not to type it.
 *
 * ## Where the eleven come from
 *
 * Seven are `TOKENS` from `ui/styles.ts`, unchanged and exact. Those are the
 * game's own colours and rounding them to something near would be the defect
 * this file exists to prevent, so they are copied digit for digit and
 * `pixelPanel.test.ts` asserts they still match. (They are copied rather than
 * imported because `styles.ts` imports React, and this module is rasterised by
 * `tools/pixel/proof.mjs` in bare Node where dragging React in buys nothing.)
 *
 * Four are derived, and derived rather than picked because the interface
 * already had them — as alpha. CSS asks for a lit inner edge at
 * `rgba(255,252,244,0.85)` and a bevel shadow at `rgba(0,0,0,0.55)`; those are
 * real colours once you resolve them against the paper they sit on, and
 * resolving them here is the entire move. Each one is written out with the mix
 * that produced it so the next person can check the arithmetic:
 *
 *   paperLit    paper 45% + #fffcf4 55%   the lit top-left bevel
 *   paperShade  paper 72% + ink 28%       the shaded bottom-right bevel
 *   paperEdge   TOKENS.paperEdge          halftone dot, and the dither partner
 *                                         paper fades toward at a scroll cut
 *   inkSoft     TOKENS.inkSoft            secondary type and hairline rules
 *
 * ## What it is not
 *
 * It is not `tools/sprites/canvas.mjs`'s `PALETTE`. That is the world's ramp —
 * cream, ember, wood, stone — and the two are cousins rather than the same
 * family: `paper` is 27 units of RGB from `cream4`, `stamp` 36 from `ember2`,
 * `amber` 43 from `ember4`. Close enough that the page sits in the same world,
 * far enough that snapping the overlays onto the sprite ramp would repaint the
 * interface. `tools/pixel/proof.mjs` prints those distances every run so the
 * claim stays measured rather than remembered.
 */

export const PANEL_PALETTE = {
  /** The scrim behind an overlay, dithered rather than washed. TOKENS.night. */
  night: '#0a0d12',
  /** Borders and body type. TOKENS.ink. */
  ink: '#2a2620',
  /** Secondary type, hints, hairline rules. TOKENS.inkSoft. */
  inkSoft: '#5c554a',
  /** Stamped marks, slider fill, the leading rule. TOKENS.stamp. */
  stamp: '#8f3b2a',
  /** TOKENS.ember. Heat, and nothing else. */
  ember: '#ff6a1f',
  /** The one accent. TOKENS.amber. */
  amber: '#ffa42c',
  /** Cold. TOKENS.ice. */
  ice: '#8fd4ff',
  /** paper 72% + ink 28%. The shaded half of every bevel. */
  paperShade: '#b3ac9d',
  /** TOKENS.paperEdge. The halftone dot and the far end of the cut fade. */
  paperEdge: '#d6cbb1',
  /** The page. TOKENS.paper. */
  paper: '#e8e0cd',
  /** paper 45% + #fffcf4 55%. The lit half of every bevel. */
  paperLit: '#f5efe2',
} as const;

export type PanelInk = keyof typeof PANEL_PALETTE;

/** Every key, in the order above, for tests and for the proof sheet. */
export const PANEL_INKS: readonly PanelInk[] = Object.freeze(
  Object.keys(PANEL_PALETTE) as PanelInk[],
);

export function panelHex(ink: PanelInk): string {
  return PANEL_PALETTE[ink];
}

export function isPanelInk(value: string): value is PanelInk {
  return Object.prototype.hasOwnProperty.call(PANEL_PALETTE, value);
}

/** `#rrggbb` to three channels. Throws rather than guessing at a bad string. */
export function parseHex(hex: string): [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!match?.[1]) throw new Error(`not a #rrggbb colour: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return [(value >> 16) & 0xff, (value >> 8) & 0xff, value & 0xff];
}

/**
 * Distance between two colours, by the "redmean" approximation.
 *
 * Plain RGB distance is wrong in the one place this function is used: it puts
 * `paperEdge` and `paperShade` further apart than `paper` and `paperLit`, when
 * to a reader the second pair is the one that is nearly identical. Redmean is
 * three lines and gets the warm end of a paper ramp in the right order, which
 * is the whole ramp this kit spends its time in. A full CIELAB conversion
 * would be more correct and would need a colour library, and ADR-0002's point
 * about not adding a dependency to draw a 24-pixel icon applies here too.
 */
export function colourDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const mean = (a[0] + b[0]) / 2;
  const dr = a[0] - b[0];
  const dg = a[1] - b[1];
  const db = a[2] - b[2];
  return Math.sqrt(((512 + mean) * dr * dr) / 256 + 4 * dg * dg + ((767 - mean) * db * db) / 256);
}

/**
 * The nearest palette entry to an arbitrary colour.
 *
 * For the caller holding a colour from somewhere else — a token that has not
 * moved into this table, a tint carried on a piece of content. It is a ramp to
 * come back onto, not a licence: anything a *panel* draws should be naming a
 * key directly, and if the nearest entry is far away the answer is a design
 * decision rather than a rounding.
 */
export function quantise(hex: string): PanelInk {
  const target = parseHex(hex);
  let best: PanelInk = 'paper';
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const ink of PANEL_INKS) {
    const distance = colourDistance(target, parseHex(PANEL_PALETTE[ink]));
    if (distance < bestDistance) {
      bestDistance = distance;
      best = ink;
    }
  }
  return best;
}

/**
 * How differently two colours are *tinted*, ignoring how light they are.
 *
 * This is the measurement that decides whether a dither of two entries reads
 * as one colour, and it took two goes to get right. Charging for plain
 * distance ruled out `inkSoft` over `paperShade` — a dark warm grey against a
 * light warm grey, which is the single most useful screen in the whole palette
 * and the oldest trick in the era's book. What actually fails is a difference
 * of *hue*: a checker of amber and pale blue is never grey at any viewing
 * distance, it is amber and pale blue. Lightness the eye averages; hue it does
 * not.
 *
 * `r - g` and `g - b` are a crude opponent pair and crude is enough here: they
 * barely move along a ramp of one material and move hugely between two.
 */
function chromaDistance(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const ar = a[0] - a[1];
  const ab = a[1] - a[2];
  const br = b[0] - b[1];
  const bb = b[1] - b[2];
  return Math.hypot(ar - br, ab - bb);
}

export interface DitherPair {
  /** The colour that shows where the ordered threshold is not crossed. */
  readonly from: PanelInk;
  /** The colour that shows where it is. */
  readonly to: PanelInk;
  /** How much of `to`, 0..1, quantised to the sixteen steps a 4x4 Bayer cell has. */
  readonly amount: number;
  /** Redmean distance from the requested colour to the blend. */
  readonly distance: number;
  /** How far apart in hue the two entries are; see `chromaDistance`. */
  readonly separation: number;
}

/**
 * The best two-entry ordered dither for a colour this palette does not have.
 *
 * This is the second half of quantisation and the more useful half. An eleven
 * entry palette has no mid-tone between `paperEdge` and `inkSoft`, but a 4x4
 * Bayer cell of the two at nine sixteenths *is* that mid-tone at any distance
 * a player reads a panel from — which is the trick the whole era ran on, and
 * the reason `Pix.dither` exists in `tools/sprites/canvas.mjs` and every ramp
 * in the world is made of it.
 *
 * Sixteen steps, not a continuum, because a 4x4 cell has exactly sixteen
 * thresholds and a seventeenth level is a lie that rounds back to one of them.
 */
export function quantisePair(hex: string): DitherPair {
  const target = parseHex(hex);
  let best: DitherPair = {
    from: 'paper',
    to: 'paper',
    amount: 0,
    distance: Number.POSITIVE_INFINITY,
    separation: 0,
  };
  let bestScore = Number.POSITIVE_INFINITY;
  for (const from of PANEL_INKS) {
    const a = parseHex(PANEL_PALETTE[from]);
    for (const to of PANEL_INKS) {
      const b = parseHex(PANEL_PALETTE[to]);
      /*
       * The two have to agree about hue, and this is the whole reason there is
       * a score here as well as a distance.
       *
       * Judged on the blend alone, the closest answer to a warm grey was
       * "amber and ice, half each" — arithmetically true and visually
       * nonsense: a 50/50 dither of orange and pale blue is not grey, it is
       * orange and pale blue, sixteen pixels of each.
       */
      const separation = chromaDistance(a, b);
      for (let step = 0; step <= 16; step++) {
        const amount = step / 16;
        const blend: [number, number, number] = [
          a[0] + (b[0] - a[0]) * amount,
          a[1] + (b[1] - a[1]) * amount,
          a[2] + (b[2] - a[2]) * amount,
        ];
        const distance = colourDistance(target, blend);
        // A pair that is one entry used twice has no separation and so pays
        // nothing: a flat fill is always allowed to win when it deserves to.
        const score = distance + separation * 0.6;
        if (score < bestScore) {
          bestScore = score;
          best = { from, to, amount, distance, separation };
        }
      }
    }
  }
  return best;
}
