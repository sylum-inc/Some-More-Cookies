/**
 * What the settings panel says it is set to.
 *
 * This defect has now shipped three times, and every time it was found by a
 * person opening a screenshot rather than by anything in here — which is the
 * only reason this file exists. The panel is a column of numbers next to a
 * column of handles, and a number next to a handle is checkable.
 *
 * The third round is worth stating precisely, because the reviewer was half
 * wrong and the half they were right about is the half that matters. They read
 * "Fire brightness — 100% of normal" with its handle 56% of the way along its
 * track and called it a surviving bug. It was not: fire brightness runs 0.35
 * to 1.5, its default is 1.0, and 1.0 *is* a hundred per cent of normal. But a
 * reader cannot know that from the panel, and a setting that has to be worked
 * out is broken however true its arithmetic is.
 *
 * So the invariant here got wider rather than being patched. It used to be
 * "a bare percentage is the handle's position". It is now three things:
 *
 *   1. A percentage on this panel is the handle's position on its track.
 *   2. Anything that is not the handle's position is not written as a
 *      percentage at all — a multiplier reads "×1.00", which cannot be
 *      mistaken for a position because it does not look like one.
 *   3. No two rows may print the same mark with their handles in different
 *      places. That is the reviewer's complaint restated as something a test
 *      can measure, and it is the one that would have caught all three rounds.
 *
 * The spoken form is checked too. "×1.00" is a good mark and a bad sentence,
 * so the row also carries "100% of normal" for anybody listening rather than
 * looking, and the accessibility suite reads exactly that back off the panel.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings, sliderPosition, sliderReadout, sliderSpoken } from '../src/ui/Settings.js';
import { DEFAULT_ACCESSIBILITY, DEFAULT_AUDIO } from '../src/state/store.js';
import { DEFAULT_RENDER_SETTINGS } from '../src/render/ps1.js';

interface PanelSlider {
  /** The label to the left of the readout, e.g. "Fire brightness". */
  label: string;
  /** What a reader sees to the right of it, e.g. "×1.00". */
  readout: string;
  /** What a screen reader is given instead, when the two differ. */
  spoken: string;
  min: number;
  max: number;
  value: number;
  /** The `--sm-fill` the track is painted with, 0..1, or null if unset. */
  fill: number | null;
}

/**
 * Every slider on the settings panel, as a reader of the panel sees it.
 *
 * Deliberately reads the rendered markup rather than a table of props: the two
 * numbers that must agree are the one printed on the page and the one the
 * browser positions the handle from, and only the markup has both.
 */
function panelSliders(
  accessibility = DEFAULT_ACCESSIBILITY,
  render = DEFAULT_RENDER_SETTINGS,
): PanelSlider[] {
  const markup = renderToStaticMarkup(
    createElement(Settings, {
      render,
      accessibility,
      audio: DEFAULT_AUDIO,
      onRender: () => {},
      onAccessibility: () => {},
      onAudio: () => {},
      onClose: () => {},
    }),
  );

  const sliders: PanelSlider[] = [];
  for (const chunk of markup.split('<label')) {
    const input = /<input[^>]*type="range"[^>]*>/.exec(chunk);
    if (!input) continue;
    const attr = (name: string): number => {
      const found = new RegExp(`${name}="([^"]*)"`).exec(input[0]);
      return found ? Number(found[1]) : Number.NaN;
    };
    const spans = [...chunk.matchAll(/<span[^>]*>([^<]*)<\/span>/g)].map((m) => m[1] ?? '');
    const fill = /--sm-fill:\s*([\d.]+)%/.exec(input[0]);
    // The readout is one span when the mark and the sentence agree, and two —
    // an aria-hidden glyph then a visually hidden sentence — when they do not.
    const [label = '', first = '', second] = spans;
    sliders.push({
      label,
      readout: first,
      spoken: second ?? first,
      min: attr('min'),
      max: attr('max'),
      value: attr('value'),
      fill: fill ? Number(fill[1]) / 100 : null,
    });
  }
  return sliders;
}

/** Every value a slider can actually be set to, ends included. */
function stops(min: number, max: number, step: number): number[] {
  const out: number[] = [];
  for (let v = min; v <= max + 1e-9; v += step) out.push(Number(v.toFixed(4)));
  return out;
}

describe('what a settings slider says it is set to', () => {
  it('renders every slider it was given', () => {
    const sliders = panelSliders();
    // If the extraction above ever silently stops matching, every assertion
    // below passes over an empty list and this file becomes decoration.
    expect(sliders.length).toBeGreaterThan(10);
    expect(sliders.map((s) => s.label)).toEqual(
      expect.arrayContaining(['Fire brightness', 'Text size', 'Flicker', 'Dithering', 'Resolution']),
    );
  });

  /*
   * The defect, in one assertion.
   *
   * At their defaults fire brightness sat at 56% of its track and text size at
   * 16% of its, and both printed a percentage. Whatever that percentage was of,
   * it was not where the handle was.
   */
  it('never prints a percentage that is not where the handle is', () => {
    const wrong = panelSliders()
      .filter((s) => /\d+\s*%/.test(s.readout))
      .filter(
        (s) => Math.round(sliderPosition(s.value, s.min, s.max) * 100) !== Number.parseInt(s.readout, 10),
      )
      .map(
        (s) =>
          `${s.label} reads ${s.readout} with its handle at ` +
          `${Math.round(sliderPosition(s.value, s.min, s.max) * 100)}% of ${s.min}..${s.max}`,
      );
    expect(wrong).toEqual([]);
  });

  /*
   * And the same defect from the other side.
   *
   * The reviewer's actual objection was not that any one number was false, it
   * was that the column of them was unreadable: three rows saying "100%" with
   * their handles at 16%, 56% and 100% of their tracks. Restricted to
   * percentages on purpose — three rows all reading "×1.00" is not that bug,
   * because a multiplier is a value and three settings sitting at their own
   * defaults legitimately share one. Only a mark shaped like a fraction of a
   * track can be mistaken for one.
   */
  it('never prints the same percentage for two handles in different places', () => {
    const seen = new Map<string, PanelSlider>();
    const clashes: string[] = [];
    for (const slider of panelSliders().filter((s) => /\d+\s*%/.test(s.readout))) {
      const previous = seen.get(slider.readout);
      const here = sliderPosition(slider.value, slider.min, slider.max);
      if (previous) {
        const there = sliderPosition(previous.value, previous.min, previous.max);
        if (Math.abs(here - there) > 0.02) {
          clashes.push(
            `${previous.label} and ${slider.label} both read ${slider.readout}, ` +
              `at ${Math.round(there * 100)}% and ${Math.round(here * 100)}% of their tracks`,
          );
        }
      } else {
        seen.set(slider.readout, slider);
      }
    }
    expect(clashes).toEqual([]);
  });

  it('writes a multiplier as a multiplier', () => {
    const byLabel = new Map(panelSliders().map((s) => [s.label, s]));
    // The three scales that run around a reference of 1. None of them can
    // reach zero and all of them go past it, so a percentage would be the
    // ambiguity this whole file is about.
    for (const label of ['Fire brightness', 'Text size', 'Resolution']) {
      expect(byLabel.get(label)?.readout, label).toBe('×1.00');
    }
    // And a dial that really does run from off to everything is untouched.
    expect(byLabel.get('Flicker')?.readout).toBe('100%');
    expect(byLabel.get('Dithering')?.readout).toBe('100%');
  });

  /*
   * "×1.00" read aloud is "times one point zero zero", which is not how
   * anybody describes how large their type is — and the accessibility suite
   * reads "100%" back off these two rows. Both are the same fact.
   */
  it('says it in words for anybody listening rather than looking', () => {
    const byLabel = new Map(panelSliders().map((s) => [s.label, s]));
    for (const label of ['Fire brightness', 'Text size', 'Resolution']) {
      expect(byLabel.get(label)?.spoken, label).toBe('100% of normal');
    }
    // A dial needs no second channel: the mark is already a sentence.
    expect(byLabel.get('Flicker')?.spoken).toBe('100%');
  });

  it('moves its readout when the value moves', () => {
    const brighter = panelSliders(DEFAULT_ACCESSIBILITY, {
      ...DEFAULT_RENDER_SETTINGS,
      fireBrightness: 1.5,
      flicker: 0.4,
    });
    const byLabel = new Map(brighter.map((s) => [s.label, s]));
    expect(byLabel.get('Fire brightness')?.readout).toBe('×1.50');
    expect(byLabel.get('Fire brightness')?.spoken).toBe('150% of normal');
    expect(byLabel.get('Flicker')?.readout).toBe('40%');
  });

  /*
   * Every stop of every slider, swept.
   *
   * A readout that stops moving while the handle keeps moving is the same
   * defect as one that moves when the handle does not — "×1.1" for both 1.10
   * and 1.15 would be a control with two positions and one label. Cheap to
   * check across the whole range, and the only way to know that a rounding
   * choice made for the default holds at the ends.
   */
  it('gives every reachable value its own mark', () => {
    const ranges: readonly (readonly [string, number, number, number])[] = [
      ['fire brightness', 0.35, 1.5, 0.05],
      ['text size', 0.85, 1.8, 0.05],
      ['resolution', 0.5, 2, 0.1],
      ['a 0..1 dial', 0, 1, 0.05],
      ['automatic turning', 0, 2, 0.1],
    ];
    for (const [name, min, max, step] of ranges) {
      const marks = stops(min, max, step).map((v) => sliderReadout(v, min, max));
      expect(new Set(marks).size, `${name} repeats a mark across its range`).toBe(marks.length);
    }
  });
});

describe('sliderReadout', () => {
  it('reads a 0..max dial as its position, which is also its value', () => {
    expect(sliderReadout(0, 0, 1)).toBe('0%');
    expect(sliderReadout(0.5, 0, 1)).toBe('50%');
    expect(sliderReadout(1, 0, 1)).toBe('100%');
  });

  it('does not read a multiplier as if it were a dial', () => {
    // The regression itself: text size at its default and flicker at full are
    // not the same state and must not read as the same string — and now they
    // cannot even be the same *kind* of string.
    expect(sliderReadout(1, 0.85, 1.8)).not.toBe(sliderReadout(1, 0, 1));
    expect(sliderReadout(1, 0.85, 1.8)).toBe('×1.00');
    expect(sliderReadout(1.8, 0.85, 1.8)).toBe('×1.80');
    expect(sliderReadout(0.35, 0.35, 1.5)).toBe('×0.35');
    // Two decimals, because the step on both multiplier sliders is 0.05.
    expect(sliderReadout(1.15, 0.85, 1.8)).toBe('×1.15');
  });

  it('hands over to a formatter that knows the unit', () => {
    expect(sliderReadout(5, 3, 8, (v) => `${v}-bit`)).toBe('5-bit');
    expect(sliderReadout(0, 0, 2, (v) => (v === 0 ? 'off' : `${v} rad/s`))).toBe('off');
  });
});

describe('sliderSpoken', () => {
  it('keeps the sentence the mark cannot say', () => {
    expect(sliderSpoken(1, 0.85, 1.8)).toBe('100% of normal');
    expect(sliderSpoken(0.35, 0.35, 1.5)).toBe('35% of normal');
  });

  it('is the mark itself wherever the mark already reads as words', () => {
    expect(sliderSpoken(0.5, 0, 1)).toBe(sliderReadout(0.5, 0, 1));
    expect(sliderSpoken(5, 3, 8, (v) => `${v}-bit`)).toBe('5-bit');
  });
});

describe('sliderPosition', () => {
  it('is where the handle sits, clamped to the track', () => {
    expect(sliderPosition(0.35, 0.35, 1.5)).toBe(0);
    expect(sliderPosition(1.5, 0.35, 1.5)).toBe(1);
    expect(sliderPosition(1, 0.35, 1.5)).toBeCloseTo(0.5652, 4);
    // A stored value from an older build with a wider range must not paint a
    // fill off the end of its own track.
    expect(sliderPosition(9, 0.35, 1.5)).toBe(1);
    expect(sliderPosition(1, 1, 1)).toBe(0);
  });

  /*
   * The stain behind the handle is painted from `--sm-fill` rather than by the
   * browser, because a repainted track has no progress pseudo-element in
   * WebKit. Two ways of saying the same thing is two things that can disagree.
   */
  it('paints the track fill exactly where the handle is', () => {
    for (const slider of panelSliders()) {
      expect(slider.fill, `${slider.label} has no track fill`).not.toBeNull();
      expect(slider.fill, slider.label).toBeCloseTo(sliderPosition(slider.value, slider.min, slider.max), 5);
    }
  });
});
