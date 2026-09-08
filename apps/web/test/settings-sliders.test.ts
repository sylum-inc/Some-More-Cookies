/**
 * What the settings panel says it is set to.
 *
 * This defect has now shipped twice, in opposite directions, and both times it
 * was found by a person opening a screenshot rather than by anything in here —
 * which is the only reason this file exists. The panel is a grid of numbers
 * next to handles, and a number next to a handle is checkable.
 *
 * The invariant is small and it is the whole of it: **a bare percentage on
 * this panel is the handle's position on its track.** Every slider that runs
 * 0..max satisfies that trivially. The ones that do not — text size, fire
 * brightness, resolution, all multipliers around a reference of 1 — must say
 * so rather than borrowing the notation and meaning something else by it.
 *
 * Driven through the real component rather than against `sliderReadout` alone,
 * so a slider added tomorrow with a range nobody thought about is covered the
 * moment it is added. Rendered with `renderToStaticMarkup` because the assert
 * is about markup: what the label says, and where the input's value sits
 * between its own min and max.
 */

import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { Settings, sliderPosition, sliderReadout } from '../src/ui/Settings.js';
import { DEFAULT_ACCESSIBILITY, DEFAULT_AUDIO } from '../src/state/store.js';
import { DEFAULT_RENDER_SETTINGS } from '../src/render/ps1.js';

interface PanelSlider {
  /** The label to the left of the readout, e.g. "Fire brightness". */
  label: string;
  /** The readout to the right of it, e.g. "100% of normal". */
  readout: string;
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
    sliders.push({
      label: spans[0] ?? '',
      readout: spans[1] ?? '',
      min: attr('min'),
      max: attr('max'),
      value: attr('value'),
      fill: fill ? Number(fill[1]) / 100 : null,
    });
  }
  return sliders;
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
   * At their defaults fire brightness sat at 57% of its track and text size at
   * 16% of its, directly under Flicker hard against its right-hand stop, and
   * all three labels read "100%". Every one of those three numbers was
   * defensible on its own and the column of them told the reader nothing.
   */
  it('never prints a bare percentage that is not where the handle is', () => {
    const wrong = panelSliders()
      .filter((s) => /^\d+%$/.test(s.readout))
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

  it('says what it is a percentage of when the track is not 0..max', () => {
    const byLabel = new Map(panelSliders().map((s) => [s.label, s]));
    // The three multiplier scales. None of them can reach zero and all of them
    // go past 1, so "100%" alone would be the ambiguity this file is about.
    for (const label of ['Fire brightness', 'Text size', 'Resolution']) {
      expect(byLabel.get(label)?.readout, label).toBe('100% of normal');
    }
    // And a dial that really does run from off to everything is untouched.
    expect(byLabel.get('Flicker')?.readout).toBe('100%');
    expect(byLabel.get('Dithering')?.readout).toBe('100%');
  });

  it('moves its readout when the value moves', () => {
    const brighter = panelSliders(DEFAULT_ACCESSIBILITY, {
      ...DEFAULT_RENDER_SETTINGS,
      fireBrightness: 1.5,
      flicker: 0.4,
    });
    const byLabel = new Map(brighter.map((s) => [s.label, s]));
    expect(byLabel.get('Fire brightness')?.readout).toBe('150% of normal');
    expect(byLabel.get('Flicker')?.readout).toBe('40%');
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

describe('sliderReadout', () => {
  it('reads a 0..max dial as its position, which is also its value', () => {
    expect(sliderReadout(0, 0, 1)).toBe('0%');
    expect(sliderReadout(0.5, 0, 1)).toBe('50%');
    expect(sliderReadout(1, 0, 1)).toBe('100%');
  });

  it('does not read a multiplier as if it were a dial', () => {
    // The regression itself: text size at its default and flicker at full are
    // not the same state and must not read as the same string.
    expect(sliderReadout(1, 0.85, 1.8)).not.toBe(sliderReadout(1, 0, 1));
    // Still a percentage, because that is how people talk about text size —
    // and the access suite reads it back off the panel.
    expect(sliderReadout(1, 0.85, 1.8)).toContain('100%');
    expect(sliderReadout(1.8, 0.85, 1.8)).toBe('180% of normal');
    expect(sliderReadout(0.35, 0.35, 1.5)).toBe('35% of normal');
  });

  it('hands over to a formatter that knows the unit', () => {
    expect(sliderReadout(5, 3, 8, (v) => `${v}-bit`)).toBe('5-bit');
    expect(sliderReadout(0, 0, 2, (v) => (v === 0 ? 'off' : `${v} rad/s`))).toBe('off');
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
});
