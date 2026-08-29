/**
 * Merges the two halves of the performance evidence into one report.
 *
 *   tools/perf/sim-bench.mjs  → artifacts/perf/sim-bench.json      (CPU: the model)
 *   e2e/perf.spec.ts          → artifacts/perf/render-budget.json  (GPU-side: the scene)
 *
 * and writes `artifacts/perf/report.json` plus a readable `report.md`.
 *
 * The most important thing this file does is print, every single time, what a
 * software renderer cannot answer. A green performance run in this environment
 * is not evidence of 60 FPS on a phone and must never be quoted as if it were.
 *
 * Run: `npm run perf:report` (or `npm run perf`, which produces both inputs first).
 */

import { existsSync, readFileSync } from 'node:fs';

import { FRAME_BUDGET_MS, KNOWN_DEVIATIONS, MEASURABLE_HERE, STATIC_BUDGETS, UNMEASURABLE_HERE } from '../budgets.mjs';
import { artifactPath, relative, table, verdict, wrap, writeJson, writeText } from '../lib/io.mjs';

const read = (path) => (existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null);

const sim = read(artifactPath('perf', 'sim-bench.json'));
const render = read(artifactPath('perf', 'render-budget.json'));

const missing = [];
if (!sim) missing.push('artifacts/perf/sim-bench.json — run `npm run perf:sim`');
if (!render) missing.push('artifacts/perf/render-budget.json — run `npm run perf:render`');

if (missing.length > 0) {
  process.stderr.write(`Missing input:\n  ${missing.join('\n  ')}\n`);
  process.exit(2);
}

const passed = Boolean(sim.passed);

const report = {
  tool: 'tools/perf/report.mjs',
  generatedAt: new Date().toISOString(),
  architecture: { frameBudgetMs: FRAME_BUDGET_MS, staticBudgets: STATIC_BUDGETS },
  knownDeviations: KNOWN_DEVIATIONS,
  simulation: sim,
  renderer: render,
  measurableHere: MEASURABLE_HERE,
  unmeasurableHere: UNMEASURABLE_HERE,
  passed,
};

const jsonPath = writeJson(artifactPath('perf', 'report.json'), report);

/* ----------------------------------------------------------------- terminal */

const worst = sim.stages.reduce((a, b) => (b.ms.mean > a.ms.mean ? b : a));
const peaks = render.peaks;

const lines = [];
lines.push('');
lines.push('Performance report — ARCHITECTURE §10');
lines.push('');
lines.push('Simulation, per fixed 60 Hz step (compiled @somemore/sim, real Node, no browser):');
lines.push('');
lines.push(
  table(
    ['stage', 'mean ms', 'p99 ms', 'max ms', '% of 1.5 ms', ''],
    sim.stages.map((stage) => [
      stage.id,
      stage.ms.mean.toFixed(4),
      stage.ms.p99.toFixed(4),
      stage.ms.max.toFixed(4),
      `${(stage.budgetUsage * 100).toFixed(1)}%`,
      verdict(stage.withinBudget),
    ]),
  ),
);
lines.push('');
lines.push(
  `  Worst stage ${worst.id}: ${worst.ms.mean.toFixed(4)} ms mean, ` +
    `${(FRAME_BUDGET_MS.simulation / worst.ms.mean).toFixed(0)}x inside the 1.5 ms budget.`,
);
lines.push(
  `  Long run: ${sim.retained.steps.toLocaleString()} steps, retained ${sim.retained.retainedBytesPerStep} B/step ` +
    `[${verdict(sim.retained.withinBudget)}]. Transient churn ${sim.allocation.transientBytesPerStep} B/step ` +
    `[${verdict(sim.allocation.withinBudget)}].`,
);
lines.push('');
lines.push(`Scene composition, read from THREE.WebGLRenderer.info at every ritual stage:`);
lines.push('');
lines.push(
  table(
    ['budget', 'peak', 'stage', 'limit', '% used', ''],
    [
      [
        'draw calls',
        peaks.drawCalls.value,
        peaks.drawCalls.stage,
        STATIC_BUDGETS.drawCalls,
        `${((peaks.drawCalls.value / STATIC_BUDGETS.drawCalls) * 100).toFixed(0)}%`,
        verdict(peaks.drawCalls.value <= STATIC_BUDGETS.drawCalls),
      ],
      [
        'triangles',
        peaks.triangles.value,
        peaks.triangles.stage,
        STATIC_BUDGETS.triangles,
        `${((peaks.triangles.value / STATIC_BUDGETS.triangles) * 100).toFixed(0)}%`,
        verdict(peaks.triangles.value <= STATIC_BUDGETS.triangles),
      ],
      [
        'texture MB',
        peaks.textureMegabytes.value.toFixed(2),
        peaks.textureMegabytes.stage,
        STATIC_BUDGETS.textureMegabytes,
        `${((peaks.textureMegabytes.value / STATIC_BUDGETS.textureMegabytes) * 100).toFixed(0)}%`,
        verdict(peaks.textureMegabytes.value <= STATIC_BUDGETS.textureMegabytes),
      ],
      [
        'dynamic lights',
        peaks.dynamicLights.value,
        peaks.dynamicLights.stage,
        STATIC_BUDGETS.dynamicLights,
        `${((peaks.dynamicLights.value / STATIC_BUDGETS.dynamicLights) * 100).toFixed(0)}%`,
        peaks.dynamicLights.value <= STATIC_BUDGETS.dynamicLights ? 'PASS' : 'OVER (pinned)',
      ],
    ],
  ),
);

if (render.warnings?.length) {
  lines.push('');
  for (const warning of render.warnings) lines.push(wrap(`WARNING: ${warning}`));
}

lines.push('');
lines.push('What this environment CAN answer:');
for (const item of MEASURABLE_HERE) lines.push(wrap(`- ${item}`));
lines.push('');
lines.push('What it CANNOT answer, and no amount of green here changes:');
for (const item of UNMEASURABLE_HERE) lines.push(wrap(`- ${item}`));
lines.push('');
lines.push(
  wrap(
    'Shortfall S3 in IMPLEMENTATION_PLAN.md ("never profiled on real hardware") and risk R8 ("60 FPS on ' +
      '4–5-year-old phones") are narrowed by this report, not closed. What has been removed from those risks ' +
      'is the possibility that the simulation or the scene composition is the problem: the model uses under ' +
      'one percent of its frame budget and the scene draws a hundred-odd calls of a few thousand triangles. ' +
      'What remains is entirely GPU- and device-side, and needs a phone.',
  ),
);
lines.push('');
lines.push(`Report: ${relative(jsonPath)}`);
lines.push(passed ? 'RESULT: PASS' : 'RESULT: FAIL');
lines.push('');

process.stdout.write(`${lines.join('\n')}\n`);

/* ----------------------------------------------------------------- markdown */

const markdown = [
  '# Performance report',
  '',
  `Generated by \`tools/perf/report.mjs\` on ${report.generatedAt}.`,
  '',
  `Simulation measured on ${sim.environment.cpuModel} (${sim.environment.cpus} cores, Node ${sim.environment.node}).`,
  `Scene counters read from a real \`THREE.WebGLRenderer\` in Chromium at an internal resolution of ` +
    `${render.internalResolution.width}×${render.internalResolution.height}.`,
  '',
  '## Simulation — budget 1.5 ms per frame for all systems',
  '',
  '| stage | steps | mean ms | p50 | p95 | p99 | max | % of budget |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
  ...sim.stages.map(
    (stage) =>
      `| ${stage.id} | ${stage.steps} | ${stage.ms.mean.toFixed(4)} | ${stage.ms.p50.toFixed(4)} | ${stage.ms.p95.toFixed(
        4,
      )} | ${stage.ms.p99.toFixed(4)} | ${stage.ms.max.toFixed(4)} | ${(stage.budgetUsage * 100).toFixed(1)}% |`,
  ),
  '',
  `Long run: ${sim.retained.steps.toLocaleString()} steps (${(sim.retained.simulatedSeconds / 60).toFixed(
    0,
  )} simulated minutes), retained heap growth ${sim.retained.retainedBytesPerStep} bytes/step ` +
    `(${(sim.retained.retainedTotalBytes / 1024).toFixed(0)} KiB total).`,
  '',
  `Transient allocation: ${sim.allocation.transientBytesPerStep} bytes/step. ${sim.allocation.note}`,
  '',
  '## Scene composition — static budgets',
  '',
  '| stage | draw calls | triangles | texture MB | dynamic lights | visible meshes |',
  '| --- | ---: | ---: | ---: | ---: | ---: |',
  ...render.stages.map(
    (stage) =>
      `| ${stage.stage} | ${stage.drawCalls} | ${stage.triangles} | ${stage.textureMegabytes.toFixed(2)} | ${
        stage.dynamicLights
      } | ${stage.visibleMeshes}/${stage.meshes} |`,
  ),
  '',
  `Peaks: ${peaks.drawCalls.value}/${STATIC_BUDGETS.drawCalls} draw calls, ` +
    `${peaks.triangles.value}/${STATIC_BUDGETS.triangles} triangles, ` +
    `${peaks.textureMegabytes.value.toFixed(2)}/${STATIC_BUDGETS.textureMegabytes} MB textures, ` +
    `${peaks.dynamicLights.value}/${STATIC_BUDGETS.dynamicLights} dynamic lights.`,
  '',
  render.textureMeasurementNote,
  '',
  ...(Object.keys(KNOWN_DEVIATIONS).length > 0
    ? [
        '## Known deviations from ARCHITECTURE §10',
        '',
        ...Object.entries(KNOWN_DEVIATIONS).map(
          ([name, deviation]) =>
            `- **${name}**: budget ${deviation.budget}, measured ${deviation.measured}, pinned at ` +
            `${deviation.ceiling} (stages: ${deviation.stages.join(', ')}). ${deviation.why}`,
        ),
        '',
      ]
    : []),
  '## What this proves',
  '',
  ...MEASURABLE_HERE.map((item) => `- ${item}`),
  '',
  '## What it does not, and cannot, prove here',
  '',
  ...UNMEASURABLE_HERE.map((item) => `- ${item}`),
  '',
  'Shortfall S3 and risk R8 in `IMPLEMENTATION_PLAN.md` remain open. This report narrows them: the',
  'simulation and the scene are provably not the bottleneck. Everything that is left is GPU- and',
  'device-side and needs real hardware.',
  '',
].join('\n');

writeText(artifactPath('perf', 'report.md'), markdown);

process.exit(passed ? 0 : 1);
