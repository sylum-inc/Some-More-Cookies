import { describe, expect, it } from 'vitest';
import { printedStations } from '../src/ui/RadioDial.js';
import {
  AdaptiveQuality,
  bayer4x4,
  DEFAULT_RENDER_SETTINGS,
  internalRenderSize,
  probeQualityTier,
  QUALITY,
  quantiseChannel,
  snapNdc,
  TIER_PARAMS,
} from '../src/render/ps1.js';

describe('PS1 material tiers', () => {
  it('gives the world full jitter and affine swim', () => {
    expect(TIER_PARAMS.ps1.jitterAmount).toBe(1);
    expect(TIER_PARAMS.ps1.affineness).toBe(1);
  });

  it('gives the SM-01 a half step of polish', () => {
    // The machine is Some More technology: crisper, but still of this world.
    expect(TIER_PARAMS.ps1Plus.jitterAmount).toBeLessThan(TIER_PARAMS.ps1.jitterAmount);
    expect(TIER_PARAMS.ps1Plus.jitterAmount).toBeGreaterThan(TIER_PARAMS.hero.jitterAmount);
  });

  it('gives only the sandwich the full fidelity bump', () => {
    // Spec §2.1: the finished sandwich is the one object permitted this.
    expect(TIER_PARAMS.hero.jitterAmount).toBe(0);
    expect(TIER_PARAMS.hero.affineness).toBe(0);
    expect(TIER_PARAMS.hero.fogFar).toBeGreaterThan(TIER_PARAMS.ps1.fogFar);
  });
});

describe('vertex snapping', () => {
  it('snaps to the virtual raster', () => {
    const [x] = snapNdc(0.12345, 0, 160, 1);
    expect(x * 160).toBeCloseTo(Math.round(0.12345 * 160), 6);
  });

  it('is a no-op when disabled', () => {
    expect(snapNdc(0.12345, -0.98765, 160, 0)).toEqual([0.12345, -0.98765]);
  });

  it('blends partially', () => {
    const full = snapNdc(0.1234, 0, 160, 1)[0];
    const half = snapNdc(0.1234, 0, 160, 0.5)[0];
    expect(half).toBeGreaterThan(Math.min(0.1234, full) - 1e-9);
    expect(half).toBeLessThan(Math.max(0.1234, full) + 1e-9);
  });

  it('wobbles more at a coarser raster', () => {
    const coarse = Math.abs(snapNdc(0.1234, 0, 80, 1)[0] - 0.1234);
    const fine = Math.abs(snapNdc(0.1234, 0, 640, 1)[0] - 0.1234);
    expect(coarse).toBeGreaterThan(fine);
  });
});

describe('dithering', () => {
  it('produces every threshold in a 4x4 tile exactly once', () => {
    const values = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) values.add(bayer4x4(x, y));
    expect(values.size).toBe(16);
  });

  it('tiles and handles negative coordinates', () => {
    expect(bayer4x4(5, 6)).toBe(bayer4x4(1, 2));
    expect(bayer4x4(-3, -2)).toBe(bayer4x4(1, 2));
  });

  it('stays in [0,1)', () => {
    for (let y = 0; y < 4; y++) {
      for (let x = 0; x < 4; x++) {
        expect(bayer4x4(x, y)).toBeGreaterThanOrEqual(0);
        expect(bayer4x4(x, y)).toBeLessThan(1);
      }
    }
  });
});

describe('colour quantisation', () => {
  it('is a no-op at full depth', () => {
    expect(quantiseChannel(0.4321, 8, 0.5)).toBe(0.4321);
  });

  it('snaps to the available levels', () => {
    const levels = 2 ** 5 - 1;
    const out = quantiseChannel(0.5, 5, 0.5, 0);
    expect(Math.round(out * levels)).toBeCloseTo(out * levels, 6);
  });

  it('never leaves [0,1]', () => {
    for (const v of [0, 0.001, 0.5, 0.999, 1]) {
      for (const t of [0, 0.5, 1]) {
        const out = quantiseChannel(v, 3, t);
        expect(out).toBeGreaterThanOrEqual(0);
        expect(out).toBeLessThanOrEqual(1);
      }
    }
  });

  it('dithering breaks up a flat band', () => {
    // The point of ordered dithering: neighbouring pixels of the same input
    // land on different levels, so a gradient does not band.
    const value = 0.517;
    const outputs = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) outputs.add(quantiseChannel(value, 4, bayer4x4(x, y)));
    expect(outputs.size).toBeGreaterThan(1);
  });

  it('with dithering off, one input gives one output', () => {
    const outputs = new Set<number>();
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) outputs.add(quantiseChannel(0.517, 4, bayer4x4(x, y), 0));
    expect(outputs.size).toBe(1);
  });
});

describe('internal resolution', () => {
  it('renders far below the viewport', () => {
    // This is the single largest performance lever in the build (ADR-0003).
    const { width, height } = internalRenderSize(1920, 1080, QUALITY.mid);
    expect(height).toBe(240);
    expect(width).toBeLessThan(500);
  });

  it('preserves the aspect ratio', () => {
    const { width, height } = internalRenderSize(1600, 900, QUALITY.mid);
    expect(width / height).toBeCloseTo(1600 / 900, 1);
  });

  it('scales with the resolution setting', () => {
    const low = internalRenderSize(1024, 768, QUALITY.mid, { ...DEFAULT_RENDER_SETTINGS, resolutionScale: 0.5 });
    const high = internalRenderSize(1024, 768, QUALITY.mid, { ...DEFAULT_RENDER_SETTINGS, resolutionScale: 2 });
    expect(high.height).toBeGreaterThan(low.height);
  });

  it('never collapses to nothing', () => {
    const tiny = internalRenderSize(0, 0, QUALITY.low, { ...DEFAULT_RENDER_SETTINGS, resolutionScale: 0.01 });
    expect(tiny.width).toBeGreaterThanOrEqual(160);
    expect(tiny.height).toBeGreaterThanOrEqual(120);
  });

  it('the tiers are ordered', () => {
    expect(QUALITY.low.internalHeight).toBeLessThan(QUALITY.mid.internalHeight);
    expect(QUALITY.mid.internalHeight).toBeLessThan(QUALITY.high.internalHeight);
    expect(QUALITY.low.maxParticles).toBeLessThan(QUALITY.high.maxParticles);
    expect(QUALITY.low.drawDistance).toBeLessThan(QUALITY.high.drawDistance);
  });

  it('drops the marshmallow patch grid on weak devices', () => {
    expect(QUALITY.low.patchLongitude * QUALITY.low.patchLatitude).toBeLessThan(
      QUALITY.mid.patchLongitude * QUALITY.mid.patchLatitude,
    );
  });
});

describe('quality probe', () => {
  it('picks low for a weak device', () => {
    expect(probeQualityTier({ deviceMemoryGb: 2, hardwareConcurrency: 2 })).toBe('low');
    expect(probeQualityTier({ maxTextureSize: 2048 })).toBe('low');
  });

  it('picks high for a strong device', () => {
    expect(probeQualityTier({ deviceMemoryGb: 8, hardwareConcurrency: 8 })).toBe('high');
  });

  it('defaults to mid when nothing is known', () => {
    // Never sniff device strings; assume the middle and let measurement decide.
    expect(probeQualityTier({})).toBe('mid');
  });
});

describe('adaptive quality', () => {
  const fill = (adaptive: AdaptiveQuality, ms: number, count = 90) => {
    let tier = adaptive.tier;
    for (let i = 0; i < count; i++) tier = adaptive.sample(ms);
    return tier;
  };

  it('holds steady at the target frame time', () => {
    const adaptive = new AdaptiveQuality('mid');
    expect(fill(adaptive, 16)).toBe('mid');
  });

  it('drops a tier when frames are slow', () => {
    const adaptive = new AdaptiveQuality('high');
    expect(fill(adaptive, 40)).toBe('mid');
  });

  it('raises a tier when there is headroom', () => {
    const adaptive = new AdaptiveQuality('low');
    expect(fill(adaptive, 6)).toBe('mid');
  });

  it('never drops below low or rises above high', () => {
    const low = new AdaptiveQuality('low');
    for (let i = 0; i < 400; i++) low.sample(80);
    expect(low.tier).toBe('low');
    const high = new AdaptiveQuality('high');
    for (let i = 0; i < 400; i++) high.sample(3);
    expect(high.tier).toBe('high');
  });

  it('does not oscillate — a change costs a visible resolution pop', () => {
    const adaptive = new AdaptiveQuality('high');
    let changes = 0;
    let previous = adaptive.tier;
    // Frame times right on the boundary.
    for (let i = 0; i < 900; i++) {
      const tier = adaptive.sample(i % 2 === 0 ? 8 : 30);
      if (tier !== previous) changes++;
      previous = tier;
    }
    expect(changes).toBeLessThanOrEqual(2);
  });

  it('ignores rubbish samples', () => {
    const adaptive = new AdaptiveQuality('mid');
    for (let i = 0; i < 50; i++) adaptive.sample(Number.NaN);
    for (let i = 0; i < 50; i++) adaptive.sample(-1);
    expect(adaptive.sampleCount).toBe(0);
    expect(adaptive.tier).toBe('mid');
  });

  it('waits for a full window before deciding', () => {
    const adaptive = new AdaptiveQuality('high');
    for (let i = 0; i < 40; i++) adaptive.sample(60);
    expect(adaptive.tier).toBe('high');
  });

  it('reacts to the 90th percentile, not the mean', () => {
    // A smooth average hides the stutters players actually feel.
    const adaptive = new AdaptiveQuality('high');
    for (let i = 0; i < 90; i++) adaptive.sample(i < 80 ? 8 : 90);
    expect(adaptive.tier).toBe('mid');
  });
});

/* -------------------------------------------------------------------------- */
/* The radio's dial face                                                       */
/* -------------------------------------------------------------------------- */

describe('what a dial face has printed on it', () => {
  const station = (id: string, name: string, dial: number, reception = 0.8) => ({
    id,
    name,
    dial,
    band: 'fm' as const,
    character: 'lofi' as const,
    reception,
    note: '',
  });

  const radio = (stations: ReturnType<typeof station>[]) =>
    ({
      band: 'fm' as const,
      profile: { stations, baseReception: 0.6, receptionNote: '', betweenStations: '' },
    }) as unknown as Parameters<typeof printedStations>[0];

  it('prints the leading token, not the whole station name', () => {
    // Regression: Pine Hollow's three FM stations printed their full names
    // centred on the same few millimetres of glass and came out as
    // `NIGHDKEERVIDEF REPEATER`.
    const printed = printedStations(radio([station('a', 'Forest Service Repeater', 91.3)]), 88, 20);
    expect(printed[0]?.label).toBe('FOREST');
  });

  it('staggers two nearby stations onto separate rows', () => {
    const printed = printedStations(
      radio([station('a', 'KHOL', 88.7), station('b', 'WNGT', 89.4)]),
      88,
      20,
    );
    expect(printed).toHaveLength(2);
    expect(printed[0]?.row).toBe(0);
    expect(printed[1]?.row).toBe(1);
  });

  it('leaves a third crowded station off the glass entirely', () => {
    const printed = printedStations(
      radio([station('a', 'KHOL', 88.7), station('b', 'WNGT', 89.0), station('c', 'KRVR', 89.2)]),
      88,
      20,
    );
    expect(printed.map((p) => p.id)).toEqual(['a', 'b']);
  });

  it('does not print a station too faint to have been marked', () => {
    const printed = printedStations(radio([station('a', 'GHOST', 96.1, 0.2)]), 88, 20);
    expect(printed).toHaveLength(0);
  });

  it('prints a well-separated dial in full', () => {
    const printed = printedStations(
      radio([station('a', 'KHOL', 88.7), station('b', 'WNGT', 96.0), station('c', 'KRVR', 104.1)]),
      88,
      20,
    );
    expect(printed).toHaveLength(3);
    expect(printed.every((p) => p.row === 0)).toBe(true);
  });
});
