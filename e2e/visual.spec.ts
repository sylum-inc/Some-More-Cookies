import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import { sampleFrame, type FrameMetrics } from './instrument.js';
import { driveRitual, openWorld, type RoastOutcome, type StageId } from './stages.js';
import { HEALTH, TOLERANCE, checkFrameHealth } from '../tools/visual/rules.mjs';

/**
 * Visual regression for the ritual.
 *
 * Two independent checks run at every stage, because they fail on different
 * things:
 *
 *  1. **Pixel comparison against a committed baseline.** Catches "the picture
 *     changed" — geometry moved, a material stopped drawing, the framing
 *     shifted. Tolerances are wide enough for the ordered dither, the vertex
 *     jitter and the fire's per-frame flicker, and are set from measured
 *     run-to-run noise rather than guessed. See `tools/visual/rules.mjs`.
 *
 *  2. **Frame health, from the luminance distribution.** Catches "the picture
 *     is broken" without needing any baseline at all: an all-black stage, a
 *     whiteout, a flat frame, a stage that lost its colour. Three of the ten
 *     defects the previous session found by looking at the running product
 *     were exactly this shape, and all three were invisible to a green suite.
 *     This check would have caught all three.
 *
 * Baselines live in `e2e/__screenshots__/` and are updated deliberately with
 * `npm run visual:update`. Never update them to make a red build green without
 * looking at the diff — that is the one way this suite becomes worthless.
 */

const REPORT = resolve(process.cwd(), 'artifacts/visual/frame-metrics.json');

/**
 * `VISUAL_MEASURE=1` turns the suite into a tolerance-calibration run.
 *
 * Every stage is compared against its baseline with *zero* tolerance and the
 * resulting difference ratio is recorded instead of failing the run. That is
 * the run-to-run noise floor — the number the tolerances in
 * `tools/visual/rules.mjs` have to sit above. Without it, "how tolerant should
 * this be" is a guess, and a guessed tolerance is either flaky or blind.
 *
 * `npm run visual:measure` runs it.
 */
const MEASURING = process.env['VISUAL_MEASURE'] === '1';

/** Parses "123 pixels (ratio 0.05 of all image pixels) are different." */
function diffRatioFrom(message: string): number | null {
  const ratio = /ratio ([0-9.]+) of all image pixels/.exec(message);
  if (ratio) return Number(ratio[1]);
  return /Screenshot comparison failed/.test(message) ? Number.NaN : null;
}

test.describe('visual regression', () => {
  test('every ritual stage matches its baseline and is a well-formed picture', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const metrics: FrameMetrics[] = [];
    const failures: string[] = [];
    const noise: { stage: string; ratio: number }[] = [];
    let roast: RoastOutcome | null = null;
    const warnings: string[] = [];

    await openWorld(page, 'camp-visual');

    await driveRitual(
      page,
      async (stage: StageId) => {
        const frame = await sampleFrame(page, stage);
        metrics.push(frame);

        // --- (2) frame health, first: it explains a pixel diff -------------
        for (const problem of checkFrameHealth(frame)) failures.push(problem);

        // --- (1) pixel comparison against the committed baseline -----------
        const options = {
          maxDiffPixelRatio: MEASURING ? 0 : (TOLERANCE[stage] ?? TOLERANCE.default),
          // Per-pixel colour distance below which two pixels count as equal.
          // The ordered 4×4 Bayer dither means neighbouring frames legitimately
          // differ by one quantisation step over large areas of flat colour.
          threshold: HEALTH.pixelThreshold,
          animations: 'disabled' as const,
          caret: 'hide' as const,
          ...(MEASURING ? { timeout: 5_000 } : {}),
        };
        if (MEASURING) {
          try {
            await expect(page).toHaveScreenshot(`${stage}.png`, options);
            noise.push({ stage, ratio: 0 });
          } catch (error) {
            const ratio = diffRatioFrom(String((error as Error).message));
            noise.push({ stage, ratio: ratio ?? Number.NaN });
          }
        } else {
          await expect(page).toHaveScreenshot(`${stage}.png`, options);
        }
      },
      // Longer settle than the perf suite: a screenshot of a half-composed
      // frame is a false positive nobody can debug.
      1400,
      (outcome) => {
        roast = outcome;
      },
    );

    /*
     * Did the roasting stages actually roast?
     *
     * This is not a pixel question and it is not a performance question, but it
     * decides whether the `roasting`, `roasted` and every downstream baseline is
     * a picture of the thing it is named after — the finished sandwich's
     * appearance is derived from this roast. A driver whose input silently stops
     * reaching the simulation still produces sixteen plausible screenshots.
     *
     * Reported rather than failed, because the roasting *interaction* is the
     * acceptance suite's job (`ritual.spec.ts` asserts it directly and is the
     * right place for it to go red). What would be wrong is for this suite to
     * keep quietly blessing baselines of an unroasted marshmallow.
     */
    if (roast) {
      const r = roast as RoastOutcome;
      // Twenty-four presses of a quarter-radian each. Anything much short of
      // that means presses are being dropped somewhere between the key and the
      // simulation — which is what defect #25 was, and which produced sixteen
      // entirely plausible screenshots of a marshmallow browned on one face.
      if (r.rotation < 24 * 0.22 * 0.9) {
        warnings.push(
          `The marshmallow barely turned: roastInput.rotation is ${r.rotation} after 24 ArrowRight ` +
            `presses, which should give ${(24 * 0.22).toFixed(2)}. Presses are being dropped between the ` +
            'key and the simulation, so these roast stages are one-sided and every baseline downstream of ' +
            'them shows a marshmallow browned on one face only. The keyboard-only roasting path is the ' +
            'accessibility alternative to the drag (spec §12); ritual.spec.ts asserts it directly and is ' +
            'the test that should be red for it.',
        );
      }
      if (r.brown < 0.02) {
        warnings.push(
          `The marshmallow barely browned (mean ${r.brown}). These baselines are of a raw marshmallow, ` +
            'which makes the roasting, assembly and reveal stages far weaker evidence than they look.',
        );
      }
    }

    if (MEASURING) {
      const tolerance = (stage: string) =>
        (TOLERANCE as Record<string, number>)[stage] ?? TOLERANCE.default;
      console.log(
        [
          '',
          'Run-to-run pixel noise against the committed baselines (zero tolerance):',
          ...noise.map(
            (entry) =>
              `  ${entry.stage.padEnd(14)} differing pixels ${(entry.ratio * 100).toFixed(2)}%` +
              `   configured tolerance ${(tolerance(entry.stage) * 100).toFixed(0)}%` +
              `   headroom x${(tolerance(entry.stage) / Math.max(entry.ratio, 1e-6)).toFixed(1)}`,
          ),
          '',
          '  A tolerance below the measured noise is flaky; far above it is blind.',
          '',
        ].join('\n'),
      );
      mkdirSync(dirname(REPORT), { recursive: true });
      writeFileSync(
        resolve(dirname(REPORT), 'pixel-noise.json'),
        `${JSON.stringify({ measuredAt: new Date().toISOString(), tolerances: TOLERANCE, noise }, null, 2)}\n`,
        'utf8',
      );
    }

    // --- amber gives way to blue ------------------------------------------
    // Not a pixel comparison: a colour-temperature relationship between two
    // stages, which survives any amount of dither noise and is the single most
    // load-bearing visual claim in the product (spec §5, PRODUCT_SPEC).
    const at = (stage: StageId) => metrics.find((m) => m.stage === stage)!;
    const processing = at('processing');
    const freezing = at('freezing');
    expect(
      processing.warmth,
      `the processing stage should read amber (warmth ${processing.warmth}, freezing ${freezing.warmth})`,
    ).toBeGreaterThan(freezing.warmth);

    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(
      REPORT,
      `${JSON.stringify(
        {
          tool: 'e2e/visual.spec.ts',
          what: 'Per-stage frame health measured from the actual pixels of the WebGL canvas.',
          capturedAt: new Date().toISOString(),
          thresholds: HEALTH,
          pixelTolerances: TOLERANCE,
          amberToBlue: { processingWarmth: processing.warmth, freezingWarmth: freezing.warmth },
          roast,
          warnings,
          stages: metrics,
          proves:
            'That every ritual stage renders a lit, non-uniform, coloured picture that matches a reviewed ' +
            'baseline. It does not prove the picture is good-looking, appetising, or correctly framed — those ' +
            'are human judgements, and the baseline is only ever as good as the person who approved it.',
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    console.log(
      [
        '',
        'Frame health by stage (luminance 0..1):',
        ...metrics.map(
          (m) =>
            `  ${m.stage.padEnd(14)} mean ${m.meanLuminance.toFixed(3)}  sd ${m.luminanceStdDev.toFixed(3)}  ` +
            `black ${(m.blackFraction * 100).toFixed(1)}%  white ${(m.whiteFraction * 100).toFixed(1)}%  ` +
            `warmth ${m.warmth >= 0 ? '+' : ''}${m.warmth.toFixed(3)}  colours ${(m.colourVariety * 100).toFixed(2)}%`,
        ),
        '',
        `  amber→blue: processing warmth ${processing.warmth.toFixed(3)} > freezing warmth ${freezing.warmth.toFixed(3)}`,
        roast
          ? `  roast reached: brown ${(roast as RoastOutcome).brown}, char ${(roast as RoastOutcome).char}, ` +
            `rotation ${(roast as RoastOutcome).rotation}, one-sidedness ${(roast as RoastOutcome).spread}`
          : '  roast: not measured',
        '',
        ...warnings.flatMap((warning) => ['  WARNING: ' + warning, '']),
      ].join('\n'),
    );

    expect(failures, `frame health problems:\n${failures.join('\n')}`).toEqual([]);
    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});
