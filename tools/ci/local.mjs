/**
 * The local equivalent of `.github/workflows/ci.yml`.
 *
 * GitHub Actions cannot run in this environment, so the workflow has to be
 * correct by construction — and the only honest way to make that claim is for
 * the same steps to be runnable locally, in the same order, from one list that
 * both this script and the workflow are written from.
 *
 * The `STEPS` table below *is* that list. Every job in `ci.yml` names the step
 * id it corresponds to, so a step added here without being added there is
 * visible in review.
 *
 *   npm run ci:local                       everything, in CI order
 *   npm run ci:local -- --only typecheck,unit
 *   npm run ci:local -- --skip acceptance
 *   npm run ci:local -- --list
 */

import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

import { REPO_ROOT, artifactPath, relative, table, verdict, writeJson } from '../lib/io.mjs';

/**
 * @typedef {{ id: string, job: string, title: string, command: string, args: string[],
 *             proves: string, optional?: boolean }} Step
 */

/** @type {Step[]} */
const STEPS = [
  {
    id: 'typecheck',
    job: 'verify',
    title: 'Project-wide TypeScript',
    command: 'npx',
    args: ['tsc', '-b', '--pretty', 'false'],
    proves: 'Every package compiles under strict TypeScript. Also emits packages/sim/dist, which the simulation benchmark runs against.',
  },
  {
    id: 'unit',
    job: 'verify',
    title: 'Unit and integration tests',
    command: 'npx',
    args: ['vitest', 'run'],
    proves: 'The product suite: simulation, content, protocol, backend, client helpers, audio maths.',
  },
  {
    id: 'tools',
    job: 'verify',
    title: 'Tests for the measuring instruments',
    command: 'npx',
    args: ['vitest', 'run', '--config', 'tools/vitest.config.mjs'],
    proves: 'That the audio analyser and the frame-health rules actually measure what they claim, against signals with known answers.',
  },
  {
    id: 'build',
    job: 'verify',
    title: 'Production build',
    command: 'npm',
    args: ['run', 'build'],
    proves: 'Every workspace builds. The web build is what the E2E suites are served from.',
  },
  {
    id: 'acceptance',
    job: 'acceptance',
    title: 'Playwright acceptance suite',
    command: 'npx',
    args: ['playwright', 'test', '--project=acceptance'],
    proves: 'The whole ritual runs end to end in Chromium through real input, and captures a screenshot at every stage.',
  },
  {
    id: 'perf-sim',
    job: 'performance',
    title: 'Simulation benchmark',
    command: 'node',
    args: ['--expose-gc', 'tools/perf/sim-bench.mjs'],
    proves: 'stepRitual stays inside the 1.5 ms budget, and a long session neither leaks nor allocates unboundedly.',
  },
  {
    id: 'perf-render',
    job: 'performance',
    title: 'Renderer budget instrumentation',
    command: 'npx',
    args: ['playwright', 'test', '--project=perf'],
    proves: 'Draw calls, triangles, texture memory and light counts stay inside ARCHITECTURE §10 at every ritual stage.',
  },
  {
    id: 'perf-report',
    job: 'performance',
    title: 'Merged performance report',
    command: 'node',
    args: ['tools/perf/report.mjs'],
    proves: 'One report combining both halves, and a plain statement of what a GPU-less runner cannot measure.',
  },
  {
    id: 'visual',
    job: 'visual',
    title: 'Visual regression',
    command: 'npx',
    args: ['playwright', 'test', '--project=visual'],
    proves: 'Every ritual stage matches its committed baseline within measured tolerance, and is a lit, structured, coloured frame.',
  },
  {
    id: 'audio',
    job: 'audio',
    title: 'Offline audio analysis',
    command: 'node',
    args: ['tools/audio/analyse.mjs'],
    proves: 'Every signature sound renders to real PCM with the spectral and envelope character its design claims.',
  },
];

const argv = process.argv.slice(2);
const flag = (name) => {
  const index = argv.indexOf(name);
  return index >= 0 ? (argv[index + 1] ?? '') : null;
};

if (argv.includes('--list')) {
  process.stdout.write(
    `${table(
      ['id', 'ci job', 'what it proves'],
      STEPS.map((step) => [step.id, step.job, step.proves]),
    )}\n`,
  );
  process.exit(0);
}

const only = flag('--only');
const skip = flag('--skip');
const selected = STEPS.filter((step) => {
  if (only) return only.split(',').includes(step.id);
  if (skip) return !skip.split(',').includes(step.id);
  return true;
});

if (selected.length === 0) {
  process.stderr.write(`No steps selected. Known ids: ${STEPS.map((s) => s.id).join(', ')}\n`);
  process.exit(2);
}

process.stdout.write(`\nLocal CI — ${selected.length} step${selected.length === 1 ? '' : 's'}, in workflow order.\n`);

const results = [];
let failed = false;

for (const step of selected) {
  const header = `── ${step.id}  ·  ${step.title}`;
  process.stdout.write(`\n${header}\n${'─'.repeat(Math.min(78, header.length))}\n`);

  // Once a step has failed, the rest still run: a build that is broken in
  // three places should report three, not one at a time across three pushes.
  const started = performance.now();
  const result = spawnSync(step.command, step.args, { cwd: REPO_ROOT, stdio: 'inherit', env: process.env });
  const seconds = (performance.now() - started) / 1000;
  const ok = result.status === 0;
  if (!ok) failed = true;
  results.push({ id: step.id, job: step.job, title: step.title, ok, exitCode: result.status, seconds: Math.round(seconds * 10) / 10 });
}

const summaryPath = writeJson(artifactPath('ci', 'local-run.json'), {
  tool: 'tools/ci/local.mjs',
  ranAt: new Date().toISOString(),
  passed: !failed,
  steps: results,
});

process.stdout.write(
  [
    '',
    '',
    'Local CI summary',
    '',
    table(
      ['step', 'ci job', 'seconds', ''],
      results.map((result) => [result.id, result.job, result.seconds.toFixed(1), verdict(result.ok)]),
    ),
    '',
    `Reports: artifacts/perf/, artifacts/audio/, artifacts/visual/, artifacts/screenshots/`,
    `Summary: ${relative(summaryPath)}`,
    failed ? 'RESULT: FAIL' : 'RESULT: PASS',
    '',
  ].join('\n'),
);

process.exit(failed ? 1 : 0);
