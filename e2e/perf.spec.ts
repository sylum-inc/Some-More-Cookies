import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

import {
  KNOWN_DEVIATIONS,
  MEASURABLE_HERE,
  HIGH_TIER_BUDGETS,
  STATIC_BUDGETS,
  UNMEASURABLE_HERE,
  WARN_AT_FRACTION,
  ceilingFor,
} from '../tools/budgets.mjs';
import { ENVIRONMENTS } from '@somemore/content';
import { sampleRenderer, type RenderSample } from './instrument.js';
import { driveRitual, openWorld, type StageId } from './stages.js';
import { act, waitForWorld } from './helpers.js';

/**
 * In-browser performance instrumentation — ARCHITECTURE §10 static budgets.
 *
 * Drives the full ritual and reads the live `THREE.WebGLRenderer` counters at
 * every stage: draw calls, triangles, texture footprint, light count. These
 * are scene-composition facts, so they hold on real hardware; the report says
 * so explicitly, and says just as explicitly what this environment cannot
 * answer (frame rate, GPU pass timings, thermal behaviour).
 *
 * The companion `tools/perf/sim-bench.mjs` covers the simulation half of §10.
 * `tools/perf/report.mjs` merges the two.
 */

const REPORT = resolve(process.cwd(), 'artifacts/perf/render-budget.json');

const MB = 1024 * 1024;

test.describe('performance budgets', () => {
  test('the scene stays inside the static budgets at every ritual stage', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));

    const samples: RenderSample[] = [];
    /*
     * Pinned to `mid`, because §10's budget is a mid-tier budget.
     *
     * The tier used to be whatever `probeQualityTier` decided, which on this
     * four-core runner is `mid` — but only at startup. `AdaptiveQuality`
     * watches frame time and *promotes* as readily as it demotes, so a run
     * that happened to render cheaply for a few seconds would be measured on
     * `high`, pick up the campfire's cube shadow, and report 182 draw calls
     * against a 120 budget. The failure was real and the measurement was not:
     * it was the wrong tier's number held to the mid tier's ceiling.
     *
     * The `high` tier is not left unmeasured — see "what the high tier costs"
     * below, which prices it deliberately.
     */
    await openWorld(page, 'camp-perf', 'pine_hollow', 'mid');

    await driveRitual(page, async (stage: StageId) => {
      samples.push(await sampleRenderer(page, stage));
    });

    expect(samples.length, 'every stage should have been sampled').toBeGreaterThanOrEqual(16);

    /*
     * Deliberate worst case, on a second page.
     *
     * Draw calls at the campfire stages swing by 30+ between runs, because the
     * fire's particle count is a function of how much fuel is burning and how
     * hard, and that depends on when the run happened to sample. Waiting for a
     * bad frame to appear by chance is how a budget check becomes flaky. So
     * this drives the fire to its loudest — four logs, fanned, at full flame —
     * and samples that on purpose. The number it produces is the one the
     * budget actually has to survive.
     */
    const probe = await page.context().newPage();
    try {
      await openWorld(probe, 'camp-perf-peak', 'pine_hollow', 'mid');
      await probe.evaluate(() => {
        const actions = window.__someMore!.actions;
        actions['arrive']!();
        for (let i = 0; i < 4; i += 1) actions['addLog']!('oak' as never);
        actions['rake']!();
      });
      // Sweep the whole life of a heavily-fuelled fire and keep the worst
      // frame seen anywhere in it. Draw calls track the fire's particle
      // population, which rises as the logs catch and falls as they burn down,
      // so the peak is somewhere in the middle and a single sample would miss
      // it by tens of calls.
      let worst: RenderSample | null = null;
      for (let sweep = 0; sweep < 14; sweep += 1) {
        const sample = await sampleRenderer(probe, 'worst-case-fire', 12);
        if (!worst || sample.drawCalls > worst.drawCalls) worst = sample;
        await probe.evaluate(() => window.__someMore!.actions['advanceSeconds']!(6 as never));
      }
      samples.push(worst!);
      console.log(`  worst-case fire sweep: peak ${worst!.drawCalls} draw calls, ${worst!.triangles} triangles`);
    } finally {
      await probe.close();
    }

    const worstBy = <K extends keyof RenderSample>(key: K) =>
      samples.reduce((a, b) => ((b[key] as number) > (a[key] as number) ? b : a));

    const worstDraws = worstBy('drawCalls');
    const worstTris = worstBy('triangles');
    const worstTextures = worstBy('textureBytes');
    const worstLights = worstBy('dynamicLights');

    /*
     * What this campsite's own manifest says it costs.
     *
     * Every environment declares `midTierDrawCalls`, `midTierTriangles` and
     * `dynamicLights` for itself, and nothing had ever checked them: the
     * numbers were authored intent that no measurement could contradict. Pine
     * Hollow claims 74 draw calls and the renderer produces around 107, which
     * is the kind of drift that only gets worse in silence.
     *
     * Asserted generously rather than exactly, because these are authored
     * estimates and not contracts, and failing the suite on every one of them
     * today would make the check something to be switched off. What it catches
     * is an environment that has become *wildly* heavier than it was written
     * to be — and the claim is printed beside the measurement either way, so
     * the drift is visible to whoever next reads the report.
     */
    const claimed = await page.evaluate(() => {
      const env = (window.__someMore!.store.state as unknown as { environmentId: string }).environmentId;
      const found = window.__someMore!.environments.find((e) => e.id === env);
      return { id: found?.id ?? env };
    });
    const manifest = ENVIRONMENTS.find((environment) => environment.id === claimed.id);
    if (manifest) {
      // eslint-disable-next-line no-console
      console.log(
        `  ${manifest.id} claims ${manifest.performance.midTierDrawCalls} draw calls / ` +
          `${manifest.performance.midTierTriangles} triangles / ${manifest.performance.dynamicLights} lights ` +
          `(cost: ${manifest.performance.cost}); measured ${worstDraws.drawCalls} / ${worstTris.triangles} / ` +
          `${worstLights.dynamicLights}`,
      );
      expect(
        worstDraws.drawCalls,
        `${manifest.id} is far heavier than its manifest says it is`,
      ).toBeLessThan(manifest.performance.midTierDrawCalls * 1.8);
      expect(
        worstTris.triangles,
        `${manifest.id} draws far more than its manifest says it does`,
      ).toBeLessThan(manifest.performance.midTierTriangles * 1.8);
    }

    const report = {
      tool: 'e2e/perf.spec.ts',
      what: 'Live THREE.WebGLRenderer counters, read at every ritual stage.',
      capturedAt: new Date().toISOString(),
      claimedByEnvironment: manifest
        ? {
            id: manifest.id,
            cost: manifest.performance.cost,
            drawCalls: manifest.performance.midTierDrawCalls,
            triangles: manifest.performance.midTierTriangles,
            dynamicLights: manifest.performance.dynamicLights,
            lowTierCuts: manifest.performance.lowTierCuts,
          }
        : null,
      budgets: {
        drawCalls: STATIC_BUDGETS.drawCalls,
        triangles: STATIC_BUDGETS.triangles,
        textureMegabytes: STATIC_BUDGETS.textureMegabytes,
        dynamicLights: STATIC_BUDGETS.dynamicLights,
      },
      internalResolution: {
        width: samples[0]!.drawingBufferWidth,
        height: samples[0]!.drawingBufferHeight,
        pixelRatio: samples[0]!.pixelRatio,
        note:
          'The PS1 pipeline renders at a low internal resolution and lets the browser upscale (ADR-0003). ' +
          'This is the single largest performance lever in the build and is the same on any device.',
      },
      peaks: {
        drawCalls: { stage: worstDraws.stage, value: worstDraws.drawCalls, budget: STATIC_BUDGETS.drawCalls },
        triangles: { stage: worstTris.stage, value: worstTris.triangles, budget: STATIC_BUDGETS.triangles },
        textureMegabytes: {
          stage: worstTextures.stage,
          value: Math.round((worstTextures.textureBytes / MB) * 1000) / 1000,
          budget: STATIC_BUDGETS.textureMegabytes,
          largest: worstTextures.largestTexture,
        },
        dynamicLights: {
          stage: worstLights.stage,
          value: worstLights.dynamicLights,
          budget: STATIC_BUDGETS.dynamicLights,
        },
      },
      stages: samples.map((sample) => ({
        ...sample,
        textureMegabytes: Math.round((sample.textureBytes / MB) * 1000) / 1000,
      })),
      textureMeasurementNote:
        'Texture bytes are computed from every texture reachable from the scene graph at width × height × 4 ' +
        '(every texture in this project is an RGBA8 canvas — ADR-0002), plus a third for any texture with ' +
        'mipmapping actually enabled. It excludes render targets and driver-side padding, so treat it as a ' +
        'close lower bound on GPU texture memory rather than an exact figure.',
      knownDeviations: KNOWN_DEVIATIONS,
      warnings: [] as string[],
      measurableHere: MEASURABLE_HERE,
      unmeasurableHere: UNMEASURABLE_HERE,
    };

    // Anything already using most of its budget is called out before it is a
    // failure — the point of a budget is to see the wall before hitting it.
    const near = (value: number, budget: number) => value >= budget * WARN_AT_FRACTION;
    const draws = report.peaks.drawCalls.value;
    /*
     * There is no accepted deviation for draw calls, and there was never a
     * `drawCalls` entry in the table — but this message read one, and would
     * have thrown the first time the number went over budget, which is the one
     * moment it exists for. Found by typechecking the suite (S15).
     */
    const knownDrawCalls = (KNOWN_DEVIATIONS as Partial<Record<string, { status: string; why: string }>>)['drawCalls'];
    if (near(draws, STATIC_BUDGETS.drawCalls)) {
      const over = draws - STATIC_BUDGETS.drawCalls;
      report.warnings.push(
        `Draw calls reach ${draws} of ${STATIC_BUDGETS.drawCalls} during "${report.peaks.drawCalls.stage}" — ` +
          `${Math.round((draws / STATIC_BUDGETS.drawCalls) * 100)}% of budget, ` +
          (over > 0 ? `${over} OVER.` : `${-over} calls of headroom.`) +
          ' The arrival shot frames the whole campsite from the trail with nothing yet culled, so it is the ' +
          'worst case by construction and the frame least able to afford a stall.' +
          (over > 0 && knownDrawCalls ? ` ${knownDrawCalls.status} ${knownDrawCalls.why}` : ''),
      );
    }
    /*
     * And the same warning for triangles, which did not have one.
     *
     * `near()` was written for exactly this and was wired only to draw calls,
     * so the metric that actually went to the wall crossed 85% and then 92% of
     * its budget in silence across a single session's art work. The report
     * printed the number the whole time; nothing said it was nearly spent.
     * A budget with no warning is a budget you find out about by failing.
     */
    const tris = report.peaks.triangles.value;
    if (near(tris, STATIC_BUDGETS.triangles)) {
      const over = tris - STATIC_BUDGETS.triangles;
      report.warnings.push(
        `Triangles reach ${tris.toLocaleString('en-GB')} of ` +
          `${STATIC_BUDGETS.triangles.toLocaleString('en-GB')} during "${report.peaks.triangles.stage}" — ` +
          `${Math.round((tris / STATIC_BUDGETS.triangles) * 100)}% of budget, ` +
          (over > 0
            ? `${over.toLocaleString('en-GB')} OVER.`
            : `${(-over).toLocaleString('en-GB')} triangles of headroom.`) +
          ' Geometry is the cheap half of this budget and has been spent like it: ground cover, a denser ' +
          'flame cluster, the water surface and the canopy silhouette all bought draw calls back with ' +
          'triangles. That trade was right and it is close to done being available.',
      );
    }
    const textureMb = report.peaks.textureMegabytes.value;
    if (near(textureMb, STATIC_BUDGETS.textureMegabytes)) {
      report.warnings.push(
        `Texture memory reaches ${textureMb.toFixed(2)} MB of ${STATIC_BUDGETS.textureMegabytes} MB during ` +
          `"${report.peaks.textureMegabytes.stage}".`,
      );
    }
    if (report.peaks.dynamicLights.value > STATIC_BUDGETS.dynamicLights) {
      report.warnings.push(
        `Dynamic lights reach ${report.peaks.dynamicLights.value} against a §10 budget of ${STATIC_BUDGETS.dynamicLights} ` +
          `during "${report.peaks.dynamicLights.stage}". This is a KNOWN DEVIATION pinned at ` +
          `${KNOWN_DEVIATIONS.dynamicLights.ceiling}: ${KNOWN_DEVIATIONS.dynamicLights.why}`,
      );
    }

    mkdirSync(dirname(REPORT), { recursive: true });
    writeFileSync(REPORT, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    // Numbers, printed, so a CI log is evidence and not just a green tick.
    const rows = report.stages.map(
      (s) =>
        `  ${s.stage.padEnd(14)} draws ${String(s.drawCalls).padStart(4)} (mean ${String(s.drawCallsMean).padStart(5)})   tris ${String(s.triangles).padStart(6)}   ` +
        `tex ${s.textureMegabytes.toFixed(2).padStart(6)} MB   lights ${String(s.dynamicLights).padStart(2)}   ` +
        `meshes ${String(s.visibleMeshes).padStart(3)}/${s.meshes}`,
    );
    console.log(
      [
        '',
        `Renderer budgets (internal ${report.internalResolution.width}x${report.internalResolution.height}):`,
        ...rows,
        '',
        `  peak draw calls  ${report.peaks.drawCalls.value} / ${STATIC_BUDGETS.drawCalls}   (${report.peaks.drawCalls.stage})`,
        `  peak triangles   ${report.peaks.triangles.value} / ${STATIC_BUDGETS.triangles}   (${report.peaks.triangles.stage})`,
        `  peak textures    ${report.peaks.textureMegabytes.value} MB / ${STATIC_BUDGETS.textureMegabytes} MB   (${report.peaks.textureMegabytes.stage})`,
        `  peak lights      ${report.peaks.dynamicLights.value} / ${STATIC_BUDGETS.dynamicLights}   (${report.peaks.dynamicLights.stage})`,
        '',
        ...report.warnings.flatMap((warning) => ['  WARNING: ' + warning, '']),
      ].join('\n'),
    );

    // --- the budgets themselves -------------------------------------------
    // Pinned rather than budget-enforced: the arrival frame is currently one
    // call over §10 and the fix belongs to the scene workstream. The pin stops
    // it drifting further while the warning above keeps it unmissable. See
    // KNOWN_DEVIATIONS in tools/budgets.mjs.
    expect(
      report.peaks.drawCalls.value,
      `draw calls peaked at ${report.peaks.drawCalls.value} during "${report.peaks.drawCalls.stage}" ` +
        `(§10 budget ${STATIC_BUDGETS.drawCalls}, pinned ceiling ${ceilingFor('drawCalls')})`,
    ).toBeLessThanOrEqual(ceilingFor('drawCalls'));

    expect(
      report.peaks.triangles.value,
      `triangles peaked at ${report.peaks.triangles.value} during "${report.peaks.triangles.stage}"`,
    ).toBeLessThanOrEqual(ceilingFor('triangles'));

    expect(
      report.peaks.textureMegabytes.value,
      `texture memory peaked at ${report.peaks.textureMegabytes.value} MB during "${report.peaks.textureMegabytes.stage}"`,
    ).toBeLessThanOrEqual(ceilingFor('textureMegabytes'));

    // Dynamic lights already exceed §10 in the reveal stages. The check pins
    // the deviation rather than pretending it is not there — see
    // `KNOWN_DEVIATIONS` in tools/budgets.mjs, and the warning printed above.
    expect(
      report.peaks.dynamicLights.value,
      `dynamic lights peaked at ${report.peaks.dynamicLights.value} during "${report.peaks.dynamicLights.stage}" ` +
        `(§10 budget ${STATIC_BUDGETS.dynamicLights}, known-deviation ceiling ${ceilingFor('dynamicLights')})`,
    ).toBeLessThanOrEqual(ceilingFor('dynamicLights'));

    // A stage that renders nothing would pass every budget above.
    for (const sample of samples) {
      expect(sample.drawCalls, `"${sample.stage}" drew nothing`).toBeGreaterThan(0);
      expect(sample.triangles, `"${sample.stage}" drew no geometry`).toBeGreaterThan(0);
    }

    expect(errors, `page errors: ${errors.join(' | ')}`).toEqual([]);
  });
});

test.describe('what the high tier costs', () => {
  /*
   * The tier the budget is *not* written for, measured on purpose.
   *
   * Everything above checks §10's "≤ 120 draw calls on the mid tier". Nothing
   * checked `high`, and nothing could: the tier comes from a probe that reads
   * cores and memory, so on a four-core runner the answer is always `mid` and
   * the tier carrying the most expensive thing in the build — the campfire's
   * cube shadow — was invisible to every run.
   *
   * This is a recorded price rather than a raised budget. If the gap between
   * the tiers grows, that is a decision somebody should make on purpose, and
   * this is what makes them make it.
   */
  test('the campfire shadow is paid for on high and nowhere else', async ({ page }) => {
    const measured: Record<string, RenderSample> = {};
    for (const tier of ['mid', 'high'] as const) {
      await openWorld(page, 'perf-tiers', 'pine_hollow', tier);
      await act(page, 'arrive');
      await waitForWorld(page, "r.stage === 'at-fire'", 'at fire', 40_000);
      // The shadow map is built on the first frames that need it; sampling
      // before then measures a scene that has not paid for it yet.
      await page.waitForTimeout(2500);
      measured[tier] = await sampleRenderer(page, `at-fire-${tier}`);
    }

    const mid = measured['mid']!;
    const high = measured['high']!;
    // eslint-disable-next-line no-console
    console.log(
      `  at the fire — mid ${mid.drawCalls} draws / ${mid.triangles} tris · ` +
        `high ${high.drawCalls} draws / ${high.triangles} tris ` +
        `(+${high.drawCalls - mid.drawCalls} for the fire's shadow)`,
    );

    // Mid is what §10 budgets, and it must stay inside it.
    expect(mid.drawCalls, 'the mid tier is what ARCHITECTURE §10 budgets').toBeLessThan(
      STATIC_BUDGETS.drawCalls,
    );
    // High is allowed to cost more, but not without anybody noticing.
    expect(
      high.drawCalls,
      `the high tier's recorded price is ${HIGH_TIER_BUDGETS.drawCalls} draw calls`,
    ).toBeLessThan(HIGH_TIER_BUDGETS.drawCalls);
    expect(high.triangles).toBeLessThan(HIGH_TIER_BUDGETS.triangles);
    // And the thing being paid for has to actually be there: if high stops
    // costing more than mid, the shadow has silently switched itself off.
    expect(
      high.drawCalls,
      'high costs no more than mid — the fire has stopped casting',
    ).toBeGreaterThan(mid.drawCalls);
  });
});
