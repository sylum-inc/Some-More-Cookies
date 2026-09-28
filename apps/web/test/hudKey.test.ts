import { describe, expect, it } from 'vitest';
import { ACTIVITY_WINDOWS } from '@somemore/sim';

import { HUD_BRIGHTEST_INK, HUD_CEILING, hudKey, lightRegime } from '../src/ui/hudKey.js';

/** WCAG 2 relative luminance of an sRGB byte triple. */
function relativeLuminance([r, g, b]: readonly [number, number, number]): number {
  const channel = (c: number): number => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

function contrast(a: readonly [number, number, number], b: readonly [number, number, number]): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

describe('the HUD sits under the picture’s light', () => {
  it('holds its brightest ink to the ceiling for every hour', () => {
    for (const window of ACTIVITY_WINDOWS) {
      const peak = HUD_BRIGHTEST_INK * hudKey(window, false);
      expect(peak, window).toBeLessThanOrEqual(HUD_CEILING[lightRegime(window)] + 1e-9);
    }
  });

  it('is `cream4`, the top of the sprite ramp, that it is measured against', () => {
    // #fbf1d8: the value the contact sheet measured as the brightest pixel in
    // nearly every frame, 241.1. If the sprite ramp is re-authored, the
    // ceiling's argument has to be re-made, so this pins the input.
    expect(HUD_BRIGHTEST_INK).toBeCloseTo(241.1, 1);
  });

  it('goes quieter as the light goes', () => {
    expect(hudKey('deep-night', false)).toBeLessThan(hudKey('dusk', false));
    expect(hudKey('dusk', false)).toBeLessThan(hudKey('midday', false));
  });

  it('leaves the fire at least two five-bit steps clear even in the worst weather recorded', () => {
    // The dimmest fire in the contact sheet: the snow frame, 209.4. Every
    // weather frame's fire peaked between 209 and 218, and the HUD sat at
    // 241 over all of them. Sixteen is two steps of a five-bit channel, which
    // is what "a clear two steps below the fire's hottest core" means at the
    // bit depth being imitated.
    const dimmestFire = 209.4;
    for (const regime of Object.keys(HUD_CEILING) as (keyof typeof HUD_CEILING)[]) {
      expect(dimmestFire - HUD_CEILING[regime], regime).toBeGreaterThanOrEqual(16);
    }
  });

  it('is exempt in high contrast', () => {
    for (const window of ACTIVITY_WINDOWS) expect(hudKey(window, true)).toBe(1);
  });

  it('never dims a caption below WCAG AA', () => {
    /*
     * §12: subtitles are a channel a player may depend on entirely, and they
     * live inside the dimmed chrome. Ink is `SURFACE.ink`,
     * rgba(232,224,205,0.94), over the plate's darker stop, rgba(14,12,10),
     * which is the worst case. The dimming is modelled as a multiply on the
     * sRGB channels, which is the conservative reading of CSS `brightness()`:
     * if the browser applies it in linear light instead, the result is
     * brighter and the contrast higher.
     */
    const plate: [number, number, number] = [14, 12, 10];
    const ink: [number, number, number] = [
      0.94 * 232 + 0.06 * plate[0],
      0.94 * 224 + 0.06 * plate[1],
      0.94 * 205 + 0.06 * plate[2],
    ];
    for (const window of ACTIVITY_WINDOWS) {
      const k = hudKey(window, false);
      const dim = (c: [number, number, number]): [number, number, number] => [c[0] * k, c[1] * k, c[2] * k];
      expect(contrast(dim(ink), dim(plate)), window).toBeGreaterThanOrEqual(4.5);
    }
  });
});
