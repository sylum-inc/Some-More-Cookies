/**
 * Thresholds for the visual-regression suite, and the baseline-free frame
 * health rules.
 *
 * Kept out of the spec so they can be reviewed as policy — "how different is
 * too different" is a judgement call, and it should be written down somewhere a
 * reviewer will actually look, with the reasoning attached.
 */

export const HEALTH = Object.freeze({
  /**
   * Per-pixel colour distance below which Playwright counts two pixels as
   * equal (its `threshold`, a 0..1 YIQ distance).
   *
   * The PS1 pipeline quantises colour to 5:5:5 and applies an ordered 4×4
   * Bayer dither in screen space (ADR-0003), so two frames of an identical
   * scene legitimately differ by one quantisation step across large flat
   * areas. 0.25 absorbs a step or two of that without absorbing a real change
   * of material or lighting.
   */
  pixelThreshold: 0.25,

  /**
   * A floor, not the main black-frame detector.
   *
   * Measured: the darkest real stage is the arrival at 0.016 and the brightest
   * the reveal at 0.391. Note that the clear colour alone (0x070a0f) measures
   * 0.038, *above* several legitimate night stages — which is precisely why
   * mean luminance cannot be the black-frame test here. `minLuminanceStdDev`
   * and `minColourVariety` are; this is only a floor against a frame that is
   * darker than anything the world contains.
   */
  minMeanLuminance: 0.006,

  /** Almost every pixel at the floor means nothing is lit. */
  maxBlackFraction: 0.97,

  /**
   * A blown-out frame. The reveal whiteout (fixed in commit "Fix the reveal
   * whiteout") is the case this exists for.
   */
  maxWhiteFraction: 0.25,

  /**
   * Structure — the real black-frame and whiteout detector.
   *
   * A frame consisting of nothing but the clear colour has a standard
   * deviation of essentially zero, whatever its brightness. That is what the
   * "entire assembly stage rendered black" defect (IMPLEMENTATION_PLAN #6) and
   * the sealed-in-geometry reveal (#10) both looked like. Measured across the
   * sixteen stages: 0.033 (arrival, the flattest) to 0.305 (freezing).
   */
  minLuminanceStdDev: 0.015,

  /**
   * Distinct quantised colours as a fraction of sampled pixels. A single
   * untextured material covering the frame collapses this. Measured range:
   * 0.0015 (machine-armed) to 0.0155 (assembling).
   */
  minColourVariety: 0.0006,
});

/**
 * Per-stage maximum fraction of pixels allowed to differ from the baseline.
 *
 * **Measured, not guessed.** `npm run visual:measure` re-runs the whole suite
 * against the committed baselines with zero tolerance and prints the resulting
 * difference ratio per stage — that is the run-to-run noise floor. On this
 * runner it came out at 0–3 % of pixels, worst at `eating` (3 %), `roasting`,
 * `assembling` and `bitten` (2 %), everything else at or below 1 %, and
 * `machine-armed` at exactly zero.
 *
 * Where that noise comes from is worth knowing, because it bounds how tight
 * these can ever be: the ordered 4×4 Bayer dither and the 5:5:5 quantisation
 * make flat areas differ by a quantisation step; the vertex jitter snaps
 * positions to a virtual raster; and — the big one — the render loop advances
 * the simulation by *wall-clock* delta, so the flame's flicker phase at the
 * instant of a screenshot is not reproducible between runs.
 *
 * The values below sit roughly 4–12× above the measured noise, which absorbs a
 * slower CI runner (more real time elapsing between stages means the fire burns
 * further down) without absorbing a real change. Raising one of these numbers is
 * a decision, not a fix: every point of tolerance is a regression this suite
 * will now sleep through.
 */
export const TOLERANCE = Object.freeze({
  default: 0.08,

  // Fire-lit stages. The flame is a particle system whose population and
  // brightness change every frame and whose phase is not reproducible, so a
  // large, bright, constantly-moving fraction of these frames legitimately
  // differs between runs. Measured noise: 1 %.
  arrival: 0.12,
  'at-fire': 0.12,
  'fire-tended': 0.12,

  // Coals rather than flames: dimmer and steadier. Measured noise: 1–2 %.
  'ember-bed': 0.1,
  roasting: 0.1,
  roasted: 0.1,

  // Away from the fire and lit by a lantern. Measured noise: 1–2 %.
  assembling: 0.08,
  assembled: 0.08,

  // The SM-01 at rest is the steadiest picture in the product — the only
  // stage that matched its baseline pixel-for-pixel. Measured noise: 0–1 %.
  'machine-idle': 0.06,
  'machine-armed': 0.06,

  // Running: amber/blue light sequence, growing frost, vapour. Measured: 1 %.
  processing: 0.08,
  freezing: 0.08,
  complete: 0.08,

  // The reveal has falling vapour over it; eating has crumbs and fracture.
  // Measured noise: 1 % (reveal), 3 % (eating), 2 % (bitten).
  reveal: 0.1,
  eating: 0.1,
  bitten: 0.1,
});

/**
 * Baseline-free checks on one frame's measurements.
 *
 * Returns a list of human-readable problems; an empty list is a healthy frame.
 * Deliberately separate from the pixel comparison: this half keeps working
 * when the baselines are stale, which is exactly when a reviewer is most
 * likely to wave a diff through.
 */
export function checkFrameHealth(frame) {
  const problems = [];
  const at = `"${frame.stage}"`;

  if (frame.meanLuminance < HEALTH.minMeanLuminance) {
    problems.push(
      `${at} is effectively black: mean luminance ${frame.meanLuminance} < ${HEALTH.minMeanLuminance}. ` +
        'A ritual stage that renders no light is the defect this check exists for.',
    );
  }
  if (frame.blackFraction > HEALTH.maxBlackFraction) {
    problems.push(`${at} is ${(frame.blackFraction * 100).toFixed(1)}% pure black (limit ${HEALTH.maxBlackFraction * 100}%).`);
  }
  if (frame.whiteFraction > HEALTH.maxWhiteFraction) {
    problems.push(
      `${at} is ${(frame.whiteFraction * 100).toFixed(1)}% blown to white (limit ${HEALTH.maxWhiteFraction * 100}%) — a whiteout.`,
    );
  }
  if (frame.luminanceStdDev < HEALTH.minLuminanceStdDev) {
    problems.push(
      `${at} is a flat fill: luminance standard deviation ${frame.luminanceStdDev} < ${HEALTH.minLuminanceStdDev}. ` +
        'Nothing appears to be drawn over the clear colour.',
    );
  }
  if (frame.colourVariety < HEALTH.minColourVariety) {
    problems.push(
      `${at} has almost no distinct colours (${frame.colourVariety} of sampled pixels). ` +
        'Textures or materials are probably missing.',
    );
  }
  return problems;
}
