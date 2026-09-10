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
 *
 * ## What changed when the panels moved into the buffer
 *
 * All five overlays are drawn now (`ui/PixelPanel.tsx`), so half of what this
 * file used to measure is measured somewhere better: the cut, the measure, the
 * rectangles and the palette are all asserted against the real drawing in
 * `pixelPanel.test.ts`, and there is a proof sheet a human looks at. What is
 * left here is the half that only exists once a panel is mounted in a document
 * — the *seam*: that the way out is still first, that every drawn control
 * still has a real element over it with a role and a name, and that the
 * element is over the pixels it stands for rather than near them.
 *
 * The stylesheet block that used to sit at the bottom of this file is gone
 * with the rules it checked. `.sm-panel`, `.sm-overlay`, `.sm-panel-tall`,
 * `.sm-panel-scroll`, the cut mark keyed on `data-more` and the repainted
 * range input were the last three panels' material — the code entry, the
 * terminal and the fireside panel — and those three moved into the buffer with
 * this change. Nothing in `apps/web/src` referenced any of them afterwards
 * (checked, not assumed), so the declarations went and these assertions went
 * with them: a test that a stylesheet contains a rule nobody applies is a test
 * that keeps dead code alive.
 *
 * What the deleted rules were *about* is not gone. The mark at a cut has to
 * contrast with the paper it cuts — `pixelPanel.test.ts` asserts the drawn
 * dither, which is legible at any two colours because it is a pattern; the
 * sliders have to stay real `<input type="range">` elements — asserted below,
 * against the mirrored DOM rather than against a pseudo-element.
 *
 * ## All five panels, on the same table
 *
 * `PANELS` is every drawn overlay in the product, and every generic assertion
 * in this file runs against all of them. That is the point of there being one
 * kit: the code entry and the terminal get the close button in the right
 * place, the single scroll region, the painted-out mirror and the bezel inset
 * for free, and if any of them stops getting one of those, this notices.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings, settingsPage } from '../src/ui/Settings.js';
import { Passport, passportPage } from '../src/ui/Passport.js';
import { Scan, scanPage } from '../src/ui/Scan.js';
import { Terminal, terminalPage } from '../src/ui/Terminal.js';
import { CampfirePanel, campfirePage } from '../src/ui/Campfire.js';
import { overlayPage, overlayView } from '../src/ui/PixelPanel.js';
import { GLOBAL_CSS, TOKENS } from '../src/ui/styles.js';
import { hasGlyph } from '../src/render/bitmapFont.js';
import { deriveMachineIdentity, deriveSandwich, PROGRAMS, type SandwichRecord } from '@somemore/sim';
import type { Campfire } from '../src/net/campfire.js';
import type { ScanFlow, ScanState } from '../src/net/codes.js';
import {
  PanelBuffer,
  drawStamp,
  focusTargets,
  layoutPanel,
  panelTextMetrics,
  stampSeed,
  toScreen,
  type PanelBlock,
} from '../src/ui/pixel/index.js';
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

/* -------------------------------------------------------------------------- */
/* The three that arrived last                                                */
/* -------------------------------------------------------------------------- */

/**
 * A sandwich the simulation would actually produce.
 *
 * The terminal prints its provenance, and provenance built out of placeholder
 * numbers would not tell us whether a real serial fits the measure — which is
 * exactly the kind of thing the drawn panel can get wrong and the CSS one
 * could not.
 */
function makeSandwich(): SandwichRecord {
  return deriveSandwich({
    roast: {
      brown: 0.6, char: 0.05, blister: 0.2, evenness: 0.8, sidedness: 0.1,
      peakTempC: 194, melt: 0.3, fallen: false, ignitionCount: 0, flameSeconds: 0,
      seconds: 74.2, rotationTravel: 40, descriptors: ['evenly-golden'], label: 'Evenly golden',
    },
    assembly: {
      misalignment: 0.004, maxMisalignment: 0.006, lean: 0.02, squish: 0.4,
      crumbs: 0.3, smear: 0.2, seconds: 20, tidiness: 0.8, label: 'Neatly stacked',
    },
    machine: {
      serial: deriveMachineIdentity('camp-overlay', 'pine_hollow').serial,
      program: 'standard', durationSeconds: 50, peakFrost: 0.7,
      minChamberTempC: -28, quirkIds: [], firmness: PROGRAMS.standard.firmness,
    },
    environmentId: 'pine_hollow',
    campsiteSeed: 'camp-overlay',
    createdAt: Date.UTC(2026, 0, 1),
    index: 1,
  });
}

const SANDWICH = makeSandwich();

const SCAN_STATE: ScanState = {
  stage: 'idle',
  message: null,
  awarded: null,
  result: null,
  inviteToken: null,
  decidedOffline: false,
  failure: null,
};

/** Enough of a `ScanFlow` to render one: the panel reads its state and nothing else. */
const SCAN_FLOW = {
  state: SCAN_STATE,
  subscribe: () => () => {},
  submit: async () => {},
  reset: () => {},
} as unknown as ScanFlow;

/**
 * A fire with two people at it.
 *
 * A stand-in rather than a real `Campfire`, which needs a transport and a
 * session: what is being checked here is the *panel*, and the panel's whole
 * input is this shape. Two people rather than none, because a roster with
 * somebody in it is the case with the controls in it.
 */
const FIRE = {
  accountId: 'me',
  joined: true,
  status: 'joined',
  statusDetail: null,
  latencyMs: 42,
  catchingUp: false,
  notes: [],
  chat: [{ at: 1, from: 'acct-0', name: 'Wren Alvarez', text: 'pull up a log' }],
  roster: {
    everyone: [
      { accountId: 'acct-0', name: 'Wren Alvarez', phase: 'here', activity: 'roasting', micMuted: false, blocked: false, volume: 0.8 },
      { accountId: 'acct-1', name: 'Tomas Bell', phase: 'here', activity: 'assembling', micMuted: true, blocked: false, volume: 1 },
    ],
  },
  authority: { holderOf: () => 'me' },
  voice: { status: 'text_and_gesture', mode: 'off', muted: false, provider: null, reason: 'nothing is configured' },
  requestVoice: () => {},
  offer: () => {},
  block: () => {},
  say: () => true,
  gesture: () => {},
  depart: () => {},
} as unknown as Campfire;

function scanMarkup(scale = 1): string {
  return renderToStaticMarkup(
    createElement(Scan, { flow: SCAN_FLOW, textScale: scale, onClose: () => {} }),
  );
}

function terminalMarkup(scale = 1): string {
  return renderToStaticMarkup(
    createElement(Terminal, { sandwich: SANDWICH, textScale: scale, onClose: () => {} }),
  );
}

function campfireMarkup(scale = 1): string {
  return renderToStaticMarkup(
    createElement(CampfirePanel, {
      fire: FIRE,
      textScale: scale,
      highContrast: false,
      onClose: () => {},
    }),
  );
}

/**
 * Every drawn overlay in the product.
 *
 * All five, on one table, because there is one kit: a panel that stops getting
 * the close button in the right place, or the single scroll region, or the
 * painted-out mirror, has stopped being made of the same thing as the others
 * and this is where that shows.
 */
const PANELS: readonly (readonly [string, (scale?: number) => string, string])[] = [
  ['Settings', settingsMarkup, 'Close settings'],
  ['Passport', passportMarkup, 'Close passport'],
  ['Scan', scanMarkup, 'Close'],
  ['Terminal', terminalMarkup, 'Close terminal'],
  ['Campfire', campfireMarkup, 'Close'],
];

/** Every text scale the settings panel can actually be set to (0.85..1.8). */
const TEXT_SCALES = Array.from({ length: 20 }, (_, i) => Number((0.85 + i * 0.05).toFixed(2)));

/** The viewport `useViewportSize` reports with no window, which is what SSR gets. */
const SSR_VIEWPORT = { width: 1024, height: 768, inset: 0 } as const;

function blocksFor(panel: string): PanelBlock[] {
  switch (panel) {
    case 'Settings':
      return settingsPage(DEFAULT_RENDER_SETTINGS, DEFAULT_ACCESSIBILITY, DEFAULT_AUDIO, {
        onRender: () => {},
        onAccessibility: () => {},
        onAudio: () => {},
      }).blocks;
    case 'Scan':
      return scanPage(SCAN_STATE, '', { cameraAvailable: false, cameraOpen: false, cameraNote: null }).blocks;
    case 'Terminal':
      return terminalPage(SANDWICH, 'terminal', null, EMPTY_ADDRESS, '', false).blocks;
    case 'Campfire':
      return campfirePage(FIRE, '').blocks;
    default:
      return passportPage(PASSPORT, undefined, true).blocks;
  }
}

const EMPTY_ADDRESS = {
  name: '', line1: '', line2: null, city: '', region: '',
  postalCode: '', country: 'US', phone: null,
} as const;

/** One element's inline `left/top/width/height`, in CSS pixels. */
function boxOf(tag: string): { left: number; top: number; width: number; height: number } | null {
  const style = /style="([^"]*)"/.exec(tag)?.[1];
  if (style === undefined) return null;
  const number = (name: string): number => {
    // `px` is optional because React writes a zero-length offset as `left:0`.
    const found = new RegExp(`(?:^|;)\\s*${name}:\\s*(-?[\\d.]+)(?:px)?(?:;|$)`).exec(style);
    return found === null ? Number.NaN : Number(found[1]);
  };
  const box = { left: number('left'), top: number('top'), width: number('width'), height: number('height') };
  return Number.isNaN(box.left) ? null : box;
}

describe('a panel drawn into the buffer', () => {
  for (const [name, markup, closeLabel] of PANELS) {
    describe(name, () => {
      it('is a canvas with exactly one scroll region over it', () => {
        const html = markup();
        expect([...html.matchAll(/<canvas/g)]).toHaveLength(1);
        // The scroll region is the only thing in the panel that scrolls, and
        // it is a real one: the canvas is a projection of where it has got to,
        // not a second idea of it.
        expect([...html.matchAll(/overflow-y:\s*auto/g)]).toHaveLength(1);
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
        expect(close).toBeLessThan(html.indexOf('overflow-y:auto'));
        const firstFocusable = /<(?:button|input|a|select|textarea)\b[^>]*>/.exec(html);
        expect(firstFocusable?.[0]).toContain(closeLabel);
      });

      /* The X in the corner was U+00D7 in the system sans at 22 points: the
         one glyph on these panels that an art grade named outright. It is two
         drawn diagonals on a bevelled cap now, and the button over it is
         empty — the mark is pixels, not type. */
      it('draws its own close mark rather than setting one in a font', () => {
        const close = new RegExp(`<button[^>]*aria-label="${closeLabel}"[^>]*>([^<]*)</button>`).exec(markup());
        expect(close, 'the close button was not found').not.toBeNull();
        expect(close![1], 'the close button still has a glyph in it').toBe('');
      });

      /*
       * Nothing the browser draws draws anything.
       *
       * The whole conversion rests on one rule: the DOM means, the canvas
       * draws. A mirrored element that paints so much as a border is a second
       * renderer in the window, which is the defect being fixed. Every one of
       * them is `opacity: 0`, and none of them is `display: none`,
       * `visibility: hidden` or clipped to a pixel — that is the other half of
       * the same rule, and it is the half a screen reader cares about.
       */
      it('paints nothing itself, and hides nothing from anybody', () => {
        const html = markup();
        const painted = [...html.matchAll(/style="([^"]*)"/g)]
          .map((match) => match[1] ?? '')
          .filter((style) => /(?:^|;)(?:background|border|box-shadow|text-shadow):(?!\s*(?:transparent|0|none))/.test(style));
        expect(painted).toEqual([]);
        expect(html).not.toMatch(/visibility:\s*hidden/);
        expect(html).not.toMatch(/display:\s*none/);
        expect(html).not.toMatch(/clip(?:-path)?:/);
        // The canvas is the picture of all of it, so it is the one node that
        // should be hidden from the accessibility tree.
        expect(html).toMatch(/<canvas[^>]*aria-hidden/);
      });

      /*
       * Whole pixels, at every scale the player can choose.
       *
       * The old panel could ask a browser for 14.375px and get smeared stems.
       * A five-pixel bitmap face cannot be asked for that at all, so what this
       * checks now is the thing that replaced it: that the dial still moves
       * something at every one of its twenty stops, and that everything it
       * moves is a whole number of buffer pixels.
       */
      it('lands every one of the twenty text scales on whole pixels', () => {
        const seen = new Set<string>();
        for (const scale of TEXT_SCALES) {
          const type = panelTextMetrics(scale);
          expect(Number.isInteger(type.scale)).toBe(true);
          for (const [key, value] of Object.entries(type.metrics)) {
            expect(Number.isInteger(value), `${key} is ${String(value)} at ${scale}x`).toBe(true);
          }
          seen.add(`${type.scale}/${String(type.metrics.leading)}/${String(type.metrics.padding)}`);
        }
        // Two glyph sizes is all a bitmap face has. If the dial only ever
        // produced two states it would be a control that does nothing at
        // eighteen of its stops, which is the defect `sliderReadout` has a
        // page of notes about — so the rest of it has to buy something.
        expect(seen.size).toBeGreaterThan(2);
      });

      /*
       * The bezel, reaching the arithmetic rather than being remembered.
       *
       * `Frame` draws a nine-slice rail over every edge of the viewport, and
       * the overlays had never heard of it: they padded themselves by `4vmin`,
       * which clears 18 pixels at 1280 wide and does not at 393. The panel
       * rectangle is chosen *after* the inset is converted into buffer pixels
       * now, so a page under the rail is not a thing that can be forgotten.
       */
      it('never lets a page overhang the bezel the build draws over the viewport', () => {
        for (const inset of [0, 9, 18, 40]) {
          const { view, spec } = overlayPage(1280, 720, inset, blocksFor(name), 1);
          expect(spec.rect.x * view.scale).toBeGreaterThanOrEqual(inset);
          expect(spec.rect.y * view.scale).toBeGreaterThanOrEqual(inset);
          expect((spec.rect.x + spec.rect.width) * view.scale).toBeLessThanOrEqual(1280 - inset);
          expect((spec.rect.y + spec.rect.height) * view.scale).toBeLessThanOrEqual(720 - inset);
        }
      });
    });
  }
});

/*
 * The seam, measured.
 *
 * `ui/pixel/panel.ts` says the canvas draws and the DOM means, and the one way
 * that arrangement fails silently is a control mirrored *near* the pixels it
 * stands for rather than *on* them: the picture invites a click somewhere the
 * hit target is not. Nothing about that shows up in a screenshot, in a type
 * check or in an accessibility audit — every element is present, named and
 * operable, and the panel is simply lying about where its buttons are.
 */
describe('what the DOM puts over what the canvas drew', () => {
  const settingsBlocks = (): PanelBlock[] =>
    settingsPage(DEFAULT_RENDER_SETTINGS, DEFAULT_ACCESSIBILITY, DEFAULT_AUDIO, {
      onRender: () => {},
      onAccessibility: () => {},
      onAudio: () => {},
    }).blocks;

  it('gives every drawn control a real element with a role and a name', () => {
    const html = settingsMarkup();
    const { spec } = overlayPage(
      SSR_VIEWPORT.width,
      SSR_VIEWPORT.height,
      SSR_VIEWPORT.inset,
      settingsBlocks(),
      DEFAULT_ACCESSIBILITY.textScale,
    );
    const targets = focusTargets(layoutPanel(spec));
    expect(targets.length).toBeGreaterThan(15);
    const inputs = [...html.matchAll(/<input[^>]*>/g)].map((match) => match[0]);
    const checkboxes = inputs.filter((tag) => tag.includes('type="checkbox"')).length;
    const ranges = inputs.filter((tag) => tag.includes('type="range"')).length;
    expect(checkboxes).toBe(targets.filter((target) => target.role === 'checkbox').length);
    expect(ranges).toBe(targets.filter((target) => target.role === 'slider').length);
    // And the name comes from a real label, which is what
    // `getByRole('checkbox', { name: /Simplified gestures/ })` resolves.
    for (const target of targets) expect(html).toContain(`<span>${target.label}</span>`);
  });

  it('puts each of them exactly over the pixels it stands for', () => {
    const html = settingsMarkup();
    const { view, spec } = overlayPage(
      SSR_VIEWPORT.width,
      SSR_VIEWPORT.height,
      SSR_VIEWPORT.inset,
      settingsBlocks(),
      DEFAULT_ACCESSIBILITY.textScale,
    );
    const layout = layoutPanel(spec);
    const rows = [...html.matchAll(/<label[^>]*>/g)].map((match) => boxOf(match[0]));
    const drawn = layout.blocks
      .flatMap((block) => block.controls)
      .filter((control) => control.kind !== 'button');
    expect(rows.length).toBe(drawn.length);
    drawn.forEach((control, index) => {
      // The page's own coordinates: the scroller carries the offset, so at the
      // top of an unscrolled page these are the drawn ones less the content
      // origin. If the two ever disagree the picture and the hit target do.
      const expected = toScreen(
        {
          x: control.rect.x - layout.content.x,
          y: control.rect.y - layout.content.y + layout.scroll.top,
          width: control.rect.width,
          height: control.rect.height,
        },
        { scale: view.scale },
      );
      expect(rows[index], `control ${index} has no box`).not.toBeNull();
      expect(rows[index]!.left, `control ${index} left`).toBe(expected.left);
      expect(rows[index]!.top, `control ${index} top`).toBe(expected.top);
      expect(rows[index]!.width, `control ${index} width`).toBe(expected.width);
    });
  });
});

/*
 * The booklet's copy, which is the half of the Passport a drawing cannot check.
 */
describe('what the Passport prints', () => {
  const stamped: PassportState = {
    ...PASSPORT,
    stamps: ['stamp-golden', 'stamp-first-light'],
    sandwichCount: 47,
    redeemedCodes: [{ id: 'r1', awarded: 'free_kit added to your Passport.', batchId: 'b', redeemedAt: 0 }],
  };

  it('sets every character in a glyph the font actually has', () => {
    /*
     * A character with no glyph draws as a hollow box — correct behaviour for
     * a missing glyph, and a word with a box in it on the page. The booklet is
     * the panel with the most shipped copy on it, so it is the one that finds
     * these.
     */
    const { blocks } = passportPage(stamped, undefined, true);
    const undrawable = new Set<string>();
    for (const block of blocks) {
      const texts: string[] = [];
      if ('text' in block) texts.push(block.text);
      if (block.kind === 'stamps') for (const mark of block.marks) texts.push(mark.label);
      if (block.kind === 'controls') for (const control of block.controls) texts.push(control.label);
      for (const text of texts) {
        for (const character of text) {
          if (character !== '\n' && !hasGlyph(character)) undrawable.add(character);
        }
      }
    }
    expect([...undrawable]).toEqual([]);
  });

  /*
   * Spec §5.3. The Passport is a record of sandwiches, not a stat screen, and
   * the easiest way to turn it into one is to print a number that is already
   * in the state — `sandwichCount` is right there and has never been shown.
   */
  it('is a record rather than a total', () => {
    const { blocks } = passportPage(stamped, undefined, true);
    const printed = blocks.map((block) => ('text' in block ? block.text : '')).join('\n');
    expect(printed).not.toContain('47');
    expect(printed).not.toMatch(/\b\d+\s*\/\s*\d+\b/);
    expect(printed.toLowerCase()).not.toMatch(/score|streak|total|complete/);
  });

  it('keeps the stub a reader can find', () => {
    const { testIds } = passportPage(stamped, undefined, true);
    expect(Object.values(testIds)).toContain('passport-stub');
    expect(Object.values(testIds)).toContain('passport-add-code');
    expect(passportMarkup(1, stamped)).toContain('data-testid="passport-stub"');
  });
});

/*
 * The stamp, now that it is pressed rather than declared.
 *
 * "As drawn it is a border-radius" — and it was: a 76px div with a 50% radius
 * on it. The three properties the old SVG version was checked for are the same
 * three, read off the pixels instead of off the markup.
 */
describe('the passport stamp', () => {
  const mark = (id: string): PanelBuffer => {
    const buffer = new PanelBuffer(48, 48, 'paper');
    drawStamp(buffer, { x: 0, y: 0, width: 48, height: 48 }, { label: 'pine hollow', seed: stampSeed(id) });
    return buffer;
  };

  const ringRow = (buffer: PanelBuffer, y: number): string => {
    let row = '';
    for (let x = 0; x < buffer.width; x++) row += buffer.get(x, y) === 'stamp' ? '#' : '.';
    return row;
  };

  it('is inked rather than outlined', () => {
    const buffer = mark('stamp-golden');
    let inked = 0;
    for (let y = 0; y < 48; y++) for (let x = 0; x < 48; x++) if (buffer.get(x, y) === 'stamp') inked += 1;
    expect(inked).toBeGreaterThan(60);
  });

  it('is broken along its ring rather than closed', () => {
    /*
     * A closed ring is a border however it is drawn. Read across the die's own
     * centre line: a ring with four gaps in it cannot put ink at both ends of
     * every row it crosses, and a mottled one cannot be solid anywhere.
     */
    const buffer = mark('stamp-first-light');
    const rows = [12, 24, 36].map((y) => ringRow(buffer, y));
    expect(rows.some((row) => !row.includes('#'))).toBe(false);
    expect(rows.every((row) => /#{6,}/.test(row))).toBe(false);
  });

  /* The same booklet, opened twice, is the same booklet. Everything variable
     about a stamp is a hash of its own id. */
  it('draws the same mark every time it is opened', () => {
    const once = mark('stamp-golden');
    const twice = mark('stamp-golden');
    for (let y = 0; y < 48; y++) expect(ringRow(twice, y)).toBe(ringRow(once, y));
    // And a different stamp is a different mark.
    expect(ringRow(mark('stamp-first-light'), 24)).not.toBe(ringRow(once, 24));
  });
});

/*
 * What is left of the stylesheet, now that no panel is made of it.
 *
 * This block used to check nine rules — the panel, the scrim, the frame and
 * its scroll region, the scrollbar, the mark at the cut, and the repainted
 * range input — and every one of them was checked *because it was shipped*,
 * not because anything used it. The last three panels that did moved into the
 * pixel buffer, nothing in `apps/web/src` referenced any of those selectors
 * afterwards, and the declarations went. Keeping the assertions would have
 * kept four hundred lines of dead CSS alive by making its removal a test
 * failure.
 *
 * Every claim they carried still has somewhere to live, and it is a better
 * place in each case:
 *
 *   THE CUT       `pixelPanel.test.ts` asserts the drawn dither's rectangle
 *                 and that it is reserved below the last line rather than
 *                 screened over it. A dither is legible at any two colours,
 *                 which is the whole reason it replaced a gradient that had
 *                 shipped three times ending on the colour the paper already
 *                 was.
 *   THE SLIDERS   still real `<input type="range">` elements, asserted above
 *                 against the mirrored DOM — which is the thing
 *                 `access.spec.ts` drives — rather than against a `::-webkit`
 *                 pseudo-element that only existed to repaint them.
 *   THE BEZEL     `never lets a page overhang the bezel` above, run against
 *                 all five panels at four insets, instead of a regex looking
 *                 for `calc(var(--sm-frame-inset))` in a padding shorthand.
 *
 * What remains here is the HUD's own layout, which is still CSS and still the
 * one place in this interface where a `grid-template-areas` is the right
 * answer.
 */
/*
 * Every word these five panels can print, checked against the font.
 *
 * `pixelPanel.test.ts` makes this argument once with a handful of literals and
 * calls it a guard rather than a feature; this is the guard pointed at the
 * copy that actually ships. It is not hypothetical — the multiplier readout
 * "×1.00" drew as a hollow missing-glyph box until the font grew U+00D7, and
 * it was found by somebody opening a picture. A converted panel arrives with a
 * few hundred new characters of prose in it (a terminal's small caps, a
 * fireside roster, a code reader's refusals), and one non-breaking space or
 * one accented letter anywhere in that is a box in the middle of a sentence
 * that nothing else in the suite would notice.
 */
describe('the copy all five panels ship', () => {
  const textOf = (block: PanelBlock): string[] => {
    switch (block.kind) {
      case 'heading':
      case 'body':
      case 'machine':
        return [block.text];
      case 'stamps':
        return block.marks.map((mark) => mark.label);
      case 'photos':
        return block.photos.map((photo) => photo.caption);
      case 'aperture':
        return [block.label];
      case 'controls':
        return block.controls.flatMap((control) => [
          control.label,
          ...(control.kind === 'slider' ? [control.readout] : []),
          ...(control.kind === 'text' ? [control.value, control.placeholder ?? ''] : []),
          ...('hint' in control && control.hint !== undefined ? [control.hint] : []),
        ]);
      default:
        return [];
    }
  };

  for (const [name] of PANELS) {
    it(`${name} has nothing in it the font cannot draw`, () => {
      const undrawable = new Set<string>();
      for (const block of blocksFor(name)) {
        for (const text of textOf(block)) {
          for (const character of text) {
            if (character !== '\n' && !hasGlyph(character)) undrawable.add(character);
          }
        }
      }
      expect([...undrawable], `${name} prints characters with no glyph`).toEqual([]);
    });
  }
});

describe('the stylesheet the HUD still depends on', () => {
  const rule = (selector: string): string => {
    const found = new RegExp(`${selector.replace(/[.[\]*>"=-]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(GLOBAL_CSS);
    expect(found, `no rule for ${selector}`).not.toBeNull();
    return found![1] as string;
  };

  /*
   * The overlays are gone from this sheet, and that is checked rather than
   * assumed: a rule left behind here is a rule somebody re-applies in six
   * months to a panel that is drawn now, and gets two rendering languages in
   * one window all over again.
   *
   * Comments are stripped first, and that is not a convenience — the sheet
   * still *names* every one of these, in the note that says where each of them
   * went. A check that could not tell a declaration from a sentence about a
   * declaration would force the removal to be silent, which is the opposite of
   * what four hundred deleted lines deserve.
   */
  it('has no panel material left in it at all', () => {
    const declarations = GLOBAL_CSS.replace(/\/\*[\s\S]*?\*\//g, '');
    for (const selector of [
      '.sm-overlay',
      '.sm-panel',
      '.sm-panel-tall',
      '.sm-panel-scroll',
      '.sm-slider',
      '.sm-stamp',
      '.sm-close',
    ]) {
      expect(declarations, `${selector} is still shipped and nothing uses it`).not.toContain(selector);
    }
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
