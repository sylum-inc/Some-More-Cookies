/**
 * The shape of a long overlay.
 *
 * Both tall panels were being cut off at the bottom of the frame — the
 * Passport straight through "KEEP THIS PASSPORT", Settings mid-slider — and
 * the cap and the fade that were supposed to prevent it were both already in
 * the stylesheet. They did not hold for one structural reason: the panel was
 * the scroller *and* carried its own padding, which clamps a `position:
 * sticky` fade a whole pad above the cut and drags every absolutely positioned
 * child, the close button included, off the top with the content.
 *
 * That is a fact about markup and a line of CSS, so it is checkable here
 * rather than only in a screenshot. None of this is about how the panel looks;
 * it is about the two things that made the cap useless.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings } from '../src/ui/Settings.js';
import { Passport } from '../src/ui/Passport.js';
import { GLOBAL_CSS } from '../src/ui/styles.js';
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

function settingsMarkup(): string {
  return renderToStaticMarkup(
    createElement(Settings, {
      render: DEFAULT_RENDER_SETTINGS,
      accessibility: DEFAULT_ACCESSIBILITY,
      audio: DEFAULT_AUDIO,
      onRender: () => {},
      onAccessibility: () => {},
      onAudio: () => {},
      onClose: () => {},
    }),
  );
}

function passportMarkup(): string {
  return renderToStaticMarkup(
    createElement(Passport, {
      passport: PASSPORT,
      onClose: () => {},
      onLink: () => {},
      textScale: 1,
    }),
  );
}

const PANELS: readonly (readonly [string, () => string, string])[] = [
  ['Settings', settingsMarkup, 'Close settings'],
  ['Passport', passportMarkup, 'Close passport'],
];

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
    });
  }
});

describe('the stylesheet the cap depends on', () => {
  it('caps the panel and hands the scrolling to the child', () => {
    expect(GLOBAL_CSS).toMatch(/max-height:\s*88vh/);
    const region = /\.sm-panel-tall\s*>\s*\.sm-panel-scroll\s*\{([^}]*)\}/.exec(GLOBAL_CSS);
    expect(region, 'the scroll region has no rule').not.toBeNull();
    expect(region![1]).toMatch(/overflow-y:\s*auto/);
    // Without this a flex item refuses to shrink below its content and the
    // 88vh cap silently stops applying — which is how this failed before.
    expect(region![1]).toMatch(/min-height:\s*0/);
  });

  it('pins the fade to the cut rather than to the content', () => {
    const fade = /\.sm-panel-tall::after\s*\{([^}]*)\}/.exec(GLOBAL_CSS);
    expect(fade, 'there is no fade at the cut').not.toBeNull();
    expect(fade![1]).toMatch(/position:\s*absolute/);
    expect(fade![1]).not.toMatch(/position:\s*sticky/);
    expect(fade![1]).toMatch(/bottom:\s*0/);
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
});
