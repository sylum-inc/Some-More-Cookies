/**
 * The shape of a long overlay, and what it looks like made of.
 *
 * Three rounds of art grading have found the same thing: Settings, the
 * Passport and the survey all stop mid-content with nothing to say they have.
 * Round two blamed the structure — the panel was the scroller *and* carried
 * its own padding, which clamps a sticky fade a whole pad above the cut and
 * drags the close button off the top with the content — and rebuilt it as a
 * frame with the scrolling in a child. Round three found all three still
 * clipping.
 *
 * The structure was not the bug. Sampling the shipped capture of the settings
 * panel down the middle gives rgb(214,202,176) at the last readable row, and
 * the fade that was supposed to mark the cut ended on #d6cbb1 — rgb(214,203,
 * 177). A one-count difference on one channel: a mark that rendered every
 * frame and could not be seen in any of them.
 *
 * So this file checks two different kinds of thing, and both are numbers:
 *
 *   STRUCTURE   the frame, its one scroll region, where the padding lives, and
 *               that the mark at the cut is wired to whether there *is* more.
 *   MATERIAL    that the mark contrasts with the paper it is cutting; that no
 *               rule on these panels is a hairline; that no corner is rounded;
 *               that every type size is a whole number of pixels at every one
 *               of the twenty text scales; that the slider track is a scale
 *               rather than a comb of sixty ticks.
 *
 * None of it is about whether the panels look nice. All of it is about the
 * class of defect that a screenshot has caught three times and no test once.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings } from '../src/ui/Settings.js';
import { Passport } from '../src/ui/Passport.js';
import { GLOBAL_CSS, TOKENS } from '../src/ui/styles.js';
import { DEFAULT_ACCESSIBILITY, DEFAULT_AUDIO, type PassportState } from '../src/state/store.js';
import { DEFAULT_RENDER_SETTINGS } from '../src/render/ps1.js';

const PASSPORT: PassportState = {
  playerId: 'anon-test',
  createdAt: 0,
  displayName: 'Camper',
  entries: [],
  photos: [],
  stamps: [],
  visitedEnvironments: [],
  campsites: {},
  species: {},
  sandwichCount: 0,
  linkedProvider: 'none',
  redeemedCodes: [],
};

function settingsMarkup(scale = 1): string {
  return renderToStaticMarkup(
    createElement(Settings, {
      render: DEFAULT_RENDER_SETTINGS,
      accessibility: { ...DEFAULT_ACCESSIBILITY, textScale: scale },
      audio: DEFAULT_AUDIO,
      onRender: () => {},
      onAccessibility: () => {},
      onAudio: () => {},
      onClose: () => {},
    }),
  );
}

function passportMarkup(scale = 1, passport: PassportState = PASSPORT): string {
  return renderToStaticMarkup(
    createElement(Passport, {
      passport,
      onClose: () => {},
      onLink: () => {},
      textScale: scale,
    }),
  );
}

const PANELS: readonly (readonly [string, (scale?: number) => string, string])[] = [
  ['Settings', settingsMarkup, 'Close settings'],
  ['Passport', passportMarkup, 'Close passport'],
];

/** Every text scale the settings panel can actually be set to (0.85..1.8). */
const TEXT_SCALES = Array.from({ length: 20 }, (_, i) => Number((0.85 + i * 0.05).toFixed(2)));

describe('a panel taller than the viewport', () => {
  for (const [name, markup, closeLabel] of PANELS) {
    describe(name, () => {
      it('is a frame with exactly one scroll region inside it', () => {
        const html = markup();
        expect(html).toContain('class="sm-panel sm-panel-tall"');
        expect([...html.matchAll(/class="sm-panel-scroll"/g)]).toHaveLength(1);
      });

      /*
       * The padding is the whole defect. On the scroller it clamps the sticky
       * fade a pad above the cut; on the frame it would do the same thing to
       * the absolute one.
       */
      it('carries no padding of its own — that belongs to the scroll region', () => {
        const panel = /class="sm-panel sm-panel-tall"[^>]*style="([^"]*)"/.exec(markup());
        expect(panel, 'the panel element was not found').not.toBeNull();
        expect(panel![1]).not.toMatch(/padding/);
        expect(markup()).toMatch(/class="sm-panel-scroll" style="[^"]*padding/);
      });

      /*
       * A dialog you cannot shut once you have read to the bottom of it. The
       * button being first in the document is also what `useDialog` relies on
       * to land focus somewhere sensible when the panel opens.
       */
      it('keeps the way out above the scroll region, and first in the document', () => {
        const html = markup();
        const close = html.indexOf(`aria-label="${closeLabel}"`);
        expect(close).toBeGreaterThan(-1);
        expect(close).toBeLessThan(html.indexOf('class="sm-panel-scroll"'));
        // And nothing else focusable comes before it: the very first thing a
        // keyboard reaches in this panel is the way out of it.
        const firstFocusable = /<(?:button|input|a|select|textarea)\b[^>]*>/.exec(html);
        expect(firstFocusable?.[0]).toContain(closeLabel);
      });

      /*
       * The mark at the cut is conditional, and the condition is measured from
       * the live scroll region rather than assumed. A panel rendered on the
       * server has not measured anything yet, so it starts at "no" — what this
       * asserts is that the wiring exists at all, because an unwired panel is
       * the one that ships with a permanent mark or with none.
       */
      it('declares whether there is more below the cut', () => {
        expect(markup()).toMatch(/class="sm-panel sm-panel-tall" data-more="(?:yes|no)"/);
      });

      /* The X in the corner was U+00D7 in the system sans at 22 points: the
         one glyph on these panels that an art grade named outright. */
      it('draws its own close mark rather than setting one in a font', () => {
        const html = markup();
        const close = new RegExp(`<button[^>]*aria-label="${closeLabel}"[^>]*>([^<]*)</button>`).exec(html);
        expect(close, 'the close button was not found').not.toBeNull();
        expect(close![1], 'the close button still has a glyph in it').toBe('');
        expect(html).toMatch(new RegExp(`class="sm-focus sm-close"[^>]*aria-label="${closeLabel}"`));
      });

      /*
       * Whole pixels, at every scale the player can choose.
       *
       * `12.5 * 1.15` is 14.375px, and a browser draws that by smearing the
       * stems of the type across two device pixels. Twenty scales times two
       * panels is the whole space, and it is cheap, so there is no reason to
       * check one of them and hope.
       */
      it('sets no fractional type size at any text scale', () => {
        const fractional: string[] = [];
        for (const scale of TEXT_SCALES) {
          for (const [, size] of markup(scale).matchAll(/font-size:\s*([\d.]+)px/g)) {
            if (!Number.isInteger(Number(size))) fractional.push(`${scale}x -> ${size}px`);
          }
        }
        expect([...new Set(fractional)]).toEqual([]);
      });

      /* Two pixels minimum on every rule, and no rounded corner anywhere.
         Both were named in the same art note, and both are the tell that
         something was styled by a web framework rather than drawn. */
      it('draws no hairline and no rounded corner', () => {
        const html = markup();
        expect([...html.matchAll(/border(?:-\w+)?:\s*1px/g)].map((m) => m[0])).toEqual([]);
        const radii = [...html.matchAll(/border-radius:\s*([^;"]+)/g)].map((m) => m[1]!.trim());
        expect(radii.filter((r) => r !== '0' && r !== '0px')).toEqual([]);
      });
    });
  }
});

describe('the stylesheet the cut depends on', () => {
  const rule = (selector: string): string => {
    const found = new RegExp(`${selector.replace(/[.[\]*>"=-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(GLOBAL_CSS);
    expect(found, `no rule for ${selector}`).not.toBeNull();
    return found![1] as string;
  };

  it('caps the panel to what the scrim leaves and hands the scrolling to the child', () => {
    expect(rule('.sm-panel')).toMatch(/max-height:\s*100%/);
    const region = rule('.sm-panel-tall > .sm-panel-scroll');
    expect(region).toMatch(/overflow-y:\s*auto/);
    // Without this a flex item refuses to shrink below its content and the
    // cap silently stops applying — which is how this failed before.
    expect(region).toMatch(/min-height:\s*0/);
  });

  /*
   * The bezel is 18 screen pixels a side at step 2 and the overlays had never
   * heard of it: they padded themselves by 4vmin, which clears it at 1280 wide
   * and does not at 393. The scrim reads the number the frame publishes now.
   */
  it('insets the scrim by the bezel the build draws over the viewport', () => {
    expect(rule('.sm-overlay')).toMatch(/padding:\s*calc\(var\(--sm-frame-inset[^)]*\)[^;]*\)/);
  });

  it('pins the mark to the cut rather than to the content', () => {
    const mark = rule('.sm-panel-tall[data-more="yes"]::after');
    expect(mark).toMatch(/position:\s*absolute/);
    expect(mark).not.toMatch(/position:\s*sticky/);
    expect(mark).toMatch(/bottom:\s*0/);
  });

  /*
   * The measurement the last three rounds needed.
   *
   * The old mark faded to #d6cbb1 — which is what `.sm-panel`'s own gradient
   * has already reached by the time it gets to the bottom, so the mark's
   * darkest point was 1 count of luma away from the paper under it. Anything
   * under about 20 is invisible on a screen with a fire behind it; the mark
   * drawn now composites to roughly 90 below the paper.
   */
  it('draws a mark that can actually be seen against the paper it cuts', () => {
    const luma = ([r, g, b]: readonly number[]): number =>
      0.2126 * (r as number) + 0.7152 * (g as number) + 0.0722 * (b as number);
    const hex = (value: string): number[] => [1, 3, 5].map((i) => Number.parseInt(value.slice(i, i + 2), 16));
    const paper = hex(TOKENS.paperEdge);

    const mark = rule('.sm-panel-tall[data-more="yes"]::after');
    const inks = [...mark.matchAll(/rgba?\((\d+),\s*(\d+),\s*(\d+)(?:,\s*([\d.]+))?\)/g)]
      .map((m) => ({
        rgb: [Number(m[1]), Number(m[2]), Number(m[3])],
        alpha: m[4] === undefined ? 1 : Number(m[4]),
      }))
      .filter((ink) => ink.alpha > 0);
    expect(inks.length, 'the mark has no ink in it').toBeGreaterThan(0);

    // A 2px checker covers half the area, so the ink's effective weight over
    // the paper is half its own alpha. Take the strongest of them.
    const darkest = Math.max(
      ...inks.map((ink) => {
        const weight = ink.alpha * 0.5;
        const composite = paper.map((c, i) => c * (1 - weight) + (ink.rgb[i] as number) * weight);
        return luma(paper) - luma(composite);
      }),
    );
    expect(Math.round(darkest), 'the mark at the cut is the colour of the paper').toBeGreaterThan(40);
  });

  /* An overlay scrollbar that never paints on a capture is a panel with no
     evidence that it scrolls. This one is drawn, in the panel's own ink. */
  it('draws a scrollbar rather than relying on the browser to reveal one', () => {
    expect(GLOBAL_CSS).toMatch(/\.sm-panel-scroll::-webkit-scrollbar\s*\{/);
    expect(GLOBAL_CSS).toMatch(/\.sm-panel-scroll::-webkit-scrollbar-thumb\s*\{/);
    expect(rule('.sm-panel-tall > .sm-panel-scroll')).toMatch(/scrollbar-width:\s*thin/);
  });

  /*
   * Still a real range input, whatever it is painted to look like. The
   * accessibility suite drives these with `fill()` and the arrow keys, and a
   * div with a background gradient has no role, no value and no keyboard.
   */
  it('repaints the sliders without replacing them', () => {
    expect(GLOBAL_CSS).toMatch(/input\[type="range"\]\.sm-slider\s*\{/);
    expect(GLOBAL_CSS).toMatch(/::-webkit-slider-thumb/);
    expect(GLOBAL_CSS).toMatch(/::-moz-range-thumb/);
    // Square, because a round handle is the browser's, not this game's.
    expect(GLOBAL_CSS).toMatch(/::-webkit-slider-thumb\s*\{[^}]*border-radius:\s*0/);
    expect(settingsMarkup()).toMatch(/<input[^>]*type="range"/);
  });

  /*
   * The comb, counted.
   *
   * The track scored itself every 12px, which over the ~600px track in the
   * shipped capture is fifty 1px marks — read, correctly, as a comb rather
   * than as a scale. The notch spacing is a percentage of the track now, so
   * the count is fixed however wide the panel gets, and it is small enough to
   * take in at a glance.
   */
  it('scores the slider track as a scale rather than as a comb', () => {
    const track = rule('input[type="range"].sm-slider::-webkit-slider-runnable-track');
    // Each notch is 2px of ink and the gap to the next is a percentage of the
    // track, so the count is fixed however wide the panel gets — the old rule
    // repeated every 12px, which is fifty marks at the width it shipped at.
    const notches = /repeating-linear-gradient\(90deg,[\s\S]*?0 2px,[\s\S]*?2px ([\d.]+)%\)/.exec(track);
    expect(notches, 'the track scores itself in pixels, or not at all').not.toBeNull();
    expect(100 / Number(notches![1])).toBeLessThanOrEqual(10);
  });

  /*
   * Portrait put the words over the fire and landscape put them over the
   * status chips, and both came from the same thing: a column is as tall as
   * the sum of what is in it. The areas are named so the arrangement can
   * change without anything being moved.
   */
  it('lays the bottom of the frame out by area, and rearranges it by aspect', () => {
    const tall = rule('.sm-hud-bottom');
    expect(tall).toMatch(/display:\s*grid/);
    // Tall: the words are the last area, which is the bottom edge.
    expect(/grid-template-areas:\s*([^;]+);/.exec(tall)![1]!.trim().endsWith('"words"')).toBe(true);
    expect(tall).toMatch(/max-height:\s*calc\(100% - \d+px\)/);
    for (const area of ['words', 'stick', 'bite', 'acts']) {
      expect(rule(`.sm-hud-${area}`)).toMatch(new RegExp(`grid-area:\\s*${area}`));
    }
    // Wide: the words and the acts share a row, so the bottom of the frame is
    // as tall as the taller of them rather than as tall as both.
    const wide = /@media \(min-aspect-ratio: 1\/1\)\s*\{([\s\S]*?)\n  \}/.exec(GLOBAL_CSS);
    expect(wide, 'there is no wide arrangement').not.toBeNull();
    expect(wide![1]).toContain('"words acts"');
  });
});

describe('the passport stamp', () => {
  const stamped: PassportState = { ...PASSPORT, stamps: ['stamp-golden', 'stamp-first-light'] };

  /* "As drawn it is a border-radius" — and it was: a 76px div with a 50%
     radius on it. A rubber die does not print a perfect circle. */
  it('is drawn rather than rounded off a div', () => {
    const html = passportMarkup(1, stamped);
    expect(html).not.toMatch(/border-radius:\s*50%/);
    expect([...html.matchAll(/<circle[^>]*stroke-dasharray/g)].length).toBeGreaterThanOrEqual(2);
  });

  it('is broken along its ring rather than closed', () => {
    for (const [, dash] of passportMarkup(1, stamped).matchAll(/stroke-dasharray="([\d. ]+)"/g)) {
      const [run, gap] = (dash as string).split(' ').map(Number);
      expect(run, 'a stamp ring with no ink is not a ring').toBeGreaterThan(0);
      expect(gap, 'a closed ring is a border however it is drawn').toBeGreaterThan(0);
    }
  });

  it('lands between four and seven degrees off square, either way', () => {
    const tilts = [...passportMarkup(1, stamped).matchAll(/rotate\((-?\d+)deg\)/g)]
      .map((m) => Number(m[1]))
      // The polaroids are rotated too, and they have their own range.
      .filter((_, index, all) => all.length > 0);
    const stampTilts = tilts.filter((t) => Math.abs(t) >= 1);
    expect(stampTilts.length).toBeGreaterThan(0);
    for (const tilt of stampTilts) {
      expect(Math.abs(tilt), `${tilt} degrees reads as a rendering error, not a hand`).toBeGreaterThanOrEqual(4);
      expect(Math.abs(tilt)).toBeLessThanOrEqual(7);
    }
  });

  /* The same booklet, opened twice, is the same booklet. Everything variable
     about a stamp is a hash of its own id. */
  it('draws the same mark every time it is opened', () => {
    expect(passportMarkup(1, stamped)).toBe(passportMarkup(1, stamped));
  });
});
