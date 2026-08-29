import { describe, expect, it } from 'vitest';

import { HEALTH, TOLERANCE, checkFrameHealth } from './rules.mjs';
import { ASSERT_AT, KNOWN_DEVIATIONS, STATIC_BUDGETS } from '../budgets.mjs';

/**
 * Tests for the checks themselves.
 *
 * A frame-health rule that cannot fail is worse than no rule: it produces a
 * green tick for a black screen. These drive the rules with the *actual*
 * defect shapes from `IMPLEMENTATION_PLAN.md`'s defect table and confirm each
 * one is caught, and drive them with a measured healthy frame and confirm it
 * is not.
 */

/** Real numbers, taken from a passing run's `artifacts/visual/frame-metrics.json`. */
const HEALTHY_ARRIVAL = {
  stage: 'arrival',
  meanLuminance: 0.016,
  luminanceStdDev: 0.033,
  blackFraction: 0.694,
  whiteFraction: 0,
  colourVariety: 0.0035,
};

const HEALTHY_REVEAL = {
  stage: 'reveal',
  meanLuminance: 0.389,
  luminanceStdDev: 0.24,
  blackFraction: 0.051,
  whiteFraction: 0.001,
  colourVariety: 0.0156,
};

describe('frame health', () => {
  it('passes the darkest and the brightest real stages', () => {
    expect(checkFrameHealth(HEALTHY_ARRIVAL)).toEqual([]);
    expect(checkFrameHealth(HEALTHY_REVEAL)).toEqual([]);
  });

  it('catches a stage that renders entirely black (defect #6)', () => {
    const problems = checkFrameHealth({
      stage: 'assembling',
      meanLuminance: 0.0005,
      luminanceStdDev: 0.0002,
      blackFraction: 1,
      whiteFraction: 0,
      colourVariety: 0.00002,
    });
    expect(problems.length).toBeGreaterThanOrEqual(3);
    expect(problems.join(' ')).toMatch(/black/i);
  });

  it('catches a whiteout (the reveal defect)', () => {
    const problems = checkFrameHealth({
      stage: 'reveal',
      meanLuminance: 0.95,
      luminanceStdDev: 0.05,
      blackFraction: 0,
      whiteFraction: 0.8,
      colourVariety: 0.0005,
    });
    expect(problems.join(' ')).toMatch(/whiteout/i);
  });

  it('catches a flat fill — the clear colour with nothing drawn on it (defect #10)', () => {
    const problems = checkFrameHealth({
      // The clear colour 0x070a0f measures 0.038, comfortably above the mean
      // luminance floor, which is exactly why the standard deviation rule has
      // to exist.
      stage: 'reveal',
      meanLuminance: 0.038,
      luminanceStdDev: 0.0001,
      blackFraction: 0,
      whiteFraction: 0,
      colourVariety: 0.00001,
    });
    expect(problems.join(' ')).toMatch(/flat fill/i);
    expect(problems.join(' ')).toMatch(/distinct colours/i);
  });

  it('catches a world that lost its textures', () => {
    const problems = checkFrameHealth({ ...HEALTHY_REVEAL, colourVariety: 0.00005 });
    expect(problems.join(' ')).toMatch(/distinct colours/i);
  });
});

describe('tolerances', () => {
  it('covers every stage the suite captures, or falls back to a default', () => {
    expect(TOLERANCE.default).toBeGreaterThan(0);
    for (const [stage, value] of Object.entries(TOLERANCE)) {
      expect(value, `${stage} tolerance`).toBeGreaterThan(0);
      // A tolerance above 25 % of the frame is not a regression test any more.
      expect(value, `${stage} tolerance`).toBeLessThanOrEqual(0.25);
    }
  });

  it('stays above the measured noise floor of 3 % everywhere', () => {
    for (const [stage, value] of Object.entries(TOLERANCE)) {
      expect(value, `${stage} would be flaky`).toBeGreaterThanOrEqual(0.03);
    }
  });

  it('keeps the pixel threshold loose enough for the dither but not for a repaint', () => {
    expect(HEALTH.pixelThreshold).toBeGreaterThan(0.1);
    expect(HEALTH.pixelThreshold).toBeLessThan(0.4);
  });
});

describe('budgets', () => {
  it('never asserts above the architecture budget', () => {
    expect(ASSERT_AT.simulationMeanMs).toBeLessThanOrEqual(1.5);
    expect(ASSERT_AT.drawCalls).toBeLessThanOrEqual(STATIC_BUDGETS.drawCalls);
    expect(ASSERT_AT.triangles).toBeLessThanOrEqual(STATIC_BUDGETS.triangles);
    expect(ASSERT_AT.textureMegabytes).toBeLessThanOrEqual(STATIC_BUDGETS.textureMegabytes);
  });

  it('records every known deviation with a budget, a ceiling and a reason', () => {
    for (const [name, deviation] of Object.entries(KNOWN_DEVIATIONS)) {
      expect(deviation.ceiling, `${name} ceiling`).toBeGreaterThan(deviation.budget);
      expect(deviation.measured, `${name} measured`).toBeLessThanOrEqual(deviation.ceiling);
      // A pinned deviation without a written reason becomes permanent.
      expect(deviation.why.length, `${name} needs an explanation`).toBeGreaterThan(80);
    }
  });
});
