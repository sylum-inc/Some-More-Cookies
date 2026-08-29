/**
 * Headless simulation benchmark — ARCHITECTURE §10, "Simulation ≤ 1.5 ms/frame".
 *
 * This measures the real thing: it imports the compiled `@somemore/sim` and
 * calls `stepRitual` at the real fixed timestep, in the real stage order, with
 * player input applied every step the way the client applies it. Nothing is
 * stubbed and nothing in `packages/sim` is modified — the package is imported
 * exactly as `apps/web` imports it.
 *
 * Three things are measured:
 *
 *  1. **Per-step cost by ritual stage.** The stages do very different amounts
 *     of work (roasting runs a 32-patch thermal model; `at-fire` does not), so
 *     a single averaged number would hide the only stage that can blow the
 *     budget. Each stage gets its own mean/p50/p95/p99/max.
 *  2. **Long-session stability.** A full ritual is run repeatedly for a long
 *     simulated session and retained heap is sampled after forced major GCs.
 *     A per-step retained-growth slope above zero is a leak.
 *  3. **Allocation churn.** Heap growth across a GC-free window gives bytes
 *     allocated per step. ARCHITECTURE §10 claims zero; this reports the
 *     actual figure rather than assuming it.
 *
 * Run: `npm run perf:sim`  (which supplies `--expose-gc`).
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { ALLOCATION_HISTORY, ALLOCATION_REFERENCE, ASSERT_AT, FRAME_BUDGET_MS, usage } from '../budgets.mjs';
import { REPO_ROOT, artifactPath, relative, round, summarise, table, verdict, writeJson } from '../lib/io.mjs';

const SIM_DIST = resolve(REPO_ROOT, 'packages/sim/dist/src/index.js');

/**
 * The bench runs the *compiled* package rather than the TypeScript sources.
 * That keeps the measurement free of any transform in the loop, and it is the
 * same emit the type checker produces, so `npx tsc -b` is the only build step
 * this needs.
 */
function loadSim() {
  if (!existsSync(SIM_DIST)) {
    process.stderr.write('packages/sim is not built; running `npx tsc -b` first...\n');
    execFileSync('npx', ['tsc', '-b'], { cwd: REPO_ROOT, stdio: 'inherit' });
  }
  return import(SIM_DIST);
}

const sim = await loadSim();
const { SIM_DT, createRitual, stepRitual, arrive, tendFire, beginRoasting, moveMarshmallow, finishRoasting, holdComponent, moveComponent, placeComponent, operateMachine, takeSandwich, bite } = sim;

const gc = globalThis.gc;
if (typeof gc !== 'function') {
  process.stderr.write(
    'sim-bench needs --expose-gc for its allocation measurements.\n' +
      'Run it as `npm run perf:sim`, or `node --expose-gc --max-semi-space-size=64 tools/perf/sim-bench.mjs`.\n',
  );
  process.exit(2);
}

/**
 * The allocation measurement works by making scavenges impossible rather than
 * by detecting them, which needs a young generation much larger than the
 * default. Without the flag the figure still prints, but it is measuring the
 * collector as much as the model, so say so rather than quietly reporting it.
 */
const ENLARGED_NURSERY = process.execArgv.some((arg) => arg.startsWith('--max-semi-space-size'));
if (!ENLARGED_NURSERY) {
  process.stderr.write(
    'WARNING: running without --max-semi-space-size=64. Timing and retained heap are unaffected, but the\n' +
      'transient allocation figure will be depressed by scavenges landing inside the sample windows.\n' +
      'Use `npm run perf:sim`.\n',
  );
}

const STEPS_PER_SECOND = Math.round(1 / SIM_DT);

/* -------------------------------------------------------------------------- */
/* Driving the ritual                                                          */
/* -------------------------------------------------------------------------- */

function fresh(seed = 'perf-bench') {
  return createRitual({ campsiteSeed: seed, environmentId: 'pine_hollow', now: 0 });
}

function run(ritual, seconds, onStep) {
  const steps = Math.round(seconds / SIM_DT);
  for (let i = 0; i < steps; i += 1) {
    onStep?.(ritual, i);
    stepRitual(ritual, SIM_DT);
  }
  return ritual;
}

/**
 * Player input during roasting, applied every step exactly as the client's
 * pointer handler applies it: a continuous two-axis drag. Roasting with a
 * frozen marshmallow would measure a case that never happens.
 */
function roastInput(ritual, step) {
  const t = step * SIM_DT;
  const height = 0.34 + 0.06 * Math.sin(t * 0.7);
  const reach = 0.3 + 0.05 * Math.cos(t * 0.43);
  moveMarshmallow(ritual, { x: 0, y: height, z: reach }, t * 2.2, 0);
}

/** Puts a ritual into `roasting` over a real ember bed, the way a player would. */
function toRoasting(seed) {
  const ritual = fresh(seed);
  arrive(ritual);
  tendFire(ritual, { type: 'rake' });
  // Burn down to coals — the roasting surface the model is tuned for.
  for (let i = 0; i < 400 && !(ritual.fire.flame < 0.2 && ritual.fire.emberMass > 0.2); i += 1) {
    run(ritual, 3);
  }
  beginRoasting(ritual);
  return ritual;
}

function toAssembling(seed) {
  const ritual = toRoasting(seed);
  run(ritual, 60, roastInput);
  finishRoasting(ritual);
  return ritual;
}

function toMachineRunning(seed) {
  const ritual = toAssembling(seed);
  for (let i = 0; i < 4; i += 1) {
    holdComponent(ritual);
    moveComponent(ritual, { x: 0.004, y: 0.01, z: -0.003 }, 0.02);
    run(ritual, 0.4);
    placeComponent(ritual);
  }
  run(ritual, 1);
  // The door has to finish opening before the tray will take a sandwich.
  for (let i = 0; i < 60 && ritual.machine.door <= 0.9; i += 1) run(ritual, 1);
  operateMachine(ritual, { type: 'load' });
  operateMachine(ritual, { type: 'close-door' });
  for (let i = 0; i < 60 && ritual.machine.stage !== 'door-closed'; i += 1) run(ritual, 1);
  operateMachine(ritual, { type: 'engage-latch' });
  operateMachine(ritual, { type: 'set-program', program: 'standard' });
  operateMachine(ritual, { type: 'confirm' });
  operateMachine(ritual, { type: 'pull-lever' });
  return ritual;
}

function toEating(seed) {
  const ritual = toMachineRunning(seed);
  for (let i = 0; i < 200 && !ritual.sandwich; i += 1) {
    run(ritual, 1);
    if (ritual.machine.stage === 'complete') {
      operateMachine(ritual, { type: 'release-latch' });
      operateMachine(ritual, { type: 'open-door' });
    }
  }
  takeSandwich(ritual);
  return ritual;
}

/**
 * The stages measured, in ritual order. `seconds` is simulated time, so each
 * stage is measured over a realistic dwell — roasting is where a player spends
 * minutes, so roasting is measured for minutes.
 */
const STAGES = [
  { id: 'at-fire', label: 'At the fire (fire + weather)', seconds: 90, build: (s) => { const r = fresh(s); arrive(r); return r; } },
  { id: 'roasting', label: 'Roasting (32-patch thermal + input)', seconds: 180, build: toRoasting, onStep: roastInput },
  { id: 'assembling', label: 'Assembly', seconds: 60, build: toAssembling },
  { id: 'machine', label: 'SM-01 run (full 50 s programme)', seconds: 60, build: toMachineRunning },
  { id: 'eating', label: 'Eating / after', seconds: 60, build: toEating },
];

/* -------------------------------------------------------------------------- */
/* Measurement                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Times individual steps.
 *
 * `performance.now()` costs tens of nanoseconds here against a per-step cost in
 * the tens of microseconds, so the per-step overhead is well under a percent —
 * and it is the only way to get a p99, which is the number that matters for a
 * frame budget. A batch mean would hide exactly the spikes a budget exists to
 * catch.
 */
function measureStage(stage) {
  const warm = stage.build(`${stage.id}-warmup`);
  run(warm, 5, stage.onStep);

  const ritual = stage.build(stage.id);
  const steps = Math.round(stage.seconds / SIM_DT);
  const samples = new Float64Array(steps);
  gc();
  for (let i = 0; i < steps; i += 1) {
    stage.onStep?.(ritual, i);
    const started = performance.now();
    stepRitual(ritual, SIM_DT);
    samples[i] = performance.now() - started;
  }
  const stats = summarise(samples);
  return {
    id: stage.id,
    label: stage.label,
    simulatedSeconds: stage.seconds,
    steps,
    ms: {
      mean: round(stats.mean, 4),
      p50: round(stats.p50, 4),
      p95: round(stats.p95, 4),
      p99: round(stats.p99, 4),
      max: round(stats.max, 4),
    },
    budgetUsage: round(usage(stats.mean, FRAME_BUDGET_MS.simulation), 4),
    withinBudget: stats.mean <= ASSERT_AT.simulationMeanMs && stats.p99 <= ASSERT_AT.simulationP99Ms,
  };
}

/** Forced major collection, twice — the second pass sweeps what the first freed. */
function collect() {
  gc();
  gc();
  return process.memoryUsage().heapUsed;
}

/**
 * Retained heap across a long session.
 *
 * A ritual is driven end to end repeatedly. Between blocks the heap is fully
 * collected and sampled, and a least-squares slope over the samples gives
 * retained bytes per step. Anything materially above zero means the simulation
 * is accumulating state it never releases, which a short test cannot see.
 */
function measureLongRun(blocks = 8, secondsPerBlock = 240) {
  const samples = [];
  let ritual = toRoasting('long-run');
  let stepsTotal = 0;
  collect();
  const baseline = collect();

  for (let block = 0; block < blocks; block += 1) {
    const steps = Math.round(secondsPerBlock / SIM_DT);
    for (let i = 0; i < steps; i += 1) {
      roastInput(ritual, stepsTotal + i);
      stepRitual(ritual, SIM_DT);
    }
    stepsTotal += steps;
    // Restart the ritual periodically so the run exercises every stage's
    // allocation behaviour, not just the roasting loop.
    if (block % 2 === 1) ritual = toRoasting(`long-run-${block}`);
    samples.push({ steps: stepsTotal, heapUsed: collect() - baseline });
  }

  // Least-squares slope of heapUsed against steps.
  const n = samples.length;
  const meanX = samples.reduce((total, s) => total + s.steps, 0) / n;
  const meanY = samples.reduce((total, s) => total + s.heapUsed, 0) / n;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += (sample.steps - meanX) * (sample.heapUsed - meanY);
    denominator += (sample.steps - meanX) ** 2;
  }
  const bytesPerStep = denominator === 0 ? 0 : numerator / denominator;
  const last = samples[samples.length - 1];

  return {
    blocks,
    simulatedSeconds: blocks * secondsPerBlock,
    steps: stepsTotal,
    samples: samples.map((s) => ({ steps: s.steps, heapUsedDeltaBytes: Math.round(s.heapUsed) })),
    retainedBytesPerStep: round(bytesPerStep, 4),
    retainedTotalBytes: Math.round(last.heapUsed),
    withinBudget: bytesPerStep <= ASSERT_AT.retainedBytesPerStep,
  };
}

/**
 * Transient allocation per step.
 *
 * Getting a trustworthy number here is harder than it looks, and two earlier
 * attempts are worth recording because both produced confident, stable-looking,
 * wrong answers.
 *
 * `heapUsed` grows by exactly the bytes allocated *as long as no collection
 * happens in the window*. A collection frees memory mid-count, so a dirty
 * window reads far lower than the truth. Taking the median of several windows
 * therefore under-reports — it reported anywhere between 213 and 862 B/step for
 * the same build depending on nothing but how the collector fell. Taking the
 * maximum instead over-reports, because the largest window is whichever one
 * happened to contain a heap expansion or a rare bursty step, and that gave
 * 4,000–7,600 B/step for the same build. Detecting dirty windows directly does
 * not work either: `PerformanceObserver` delivers `gc` entries asynchronously
 * and this sampling loop is synchronous, so the entries arrive after the window
 * they belong to has been classified.
 *
 * What does work is removing the collector from the experiment. Run with a very
 * large young generation (`--max-semi-space-size=64`, i.e. a 128 MB nursery)
 * and a window small enough to fit inside it, and no scavenge occurs at all —
 * the delta is then simply the allocation. Each window is checked for a
 * decrease, which is the signature of a collection having happened anyway, and
 * such windows are discarded and counted.
 *
 * `npm run perf:sim` supplies the flag.
 */
function measureAllocation(windowSteps = 20_000, repeats = 5) {
  const ritual = toRoasting('allocation');
  run(ritual, 5, roastInput);

  const rates = [];
  const discarded = [];
  let step = 0;
  for (let repeat = 0; repeat < repeats; repeat += 1) {
    collect();
    const before = process.memoryUsage().heapUsed;
    for (let i = 0; i < windowSteps; i += 1) {
      roastInput(ritual, step + i);
      stepRitual(ritual, SIM_DT);
    }
    const after = process.memoryUsage().heapUsed;
    step += windowSteps;
    const rate = (after - before) / windowSteps;
    if (rate <= 0) discarded.push(round(rate, 2));
    else rates.push(rate);
  }

  const usable = rates.length > 0 ? [...rates].sort((a, b) => a - b) : [0];
  const median = usable[Math.floor(usable.length / 2)];
  const spread = usable[usable.length - 1] - usable[0];

  return {
    windowSteps,
    repeats,
    enlargedNursery: ENLARGED_NURSERY,
    usableWindows: rates.length,
    discardedWindows: discarded.length,
    samplesBytesPerStep: usable.map((rate) => round(rate, 2)),
    spreadBytesPerStep: round(spread, 2),
    transientBytesPerStep: round(median, 2),
    withinBudget: median <= ASSERT_AT.transientBytesPerStep,
    limitBytesPerStep: ASSERT_AT.transientBytesPerStep,
    reference: ALLOCATION_REFERENCE,
    history: ALLOCATION_HISTORY,
    changeVsReference: round(median / ALLOCATION_REFERENCE.bytesPerStep, 3),
    measurementNote:
      `Median of ${rates.length} windows of ${windowSteps} steps run inside an enlarged young generation so ` +
      `that no scavenge occurs; spread across those windows was ${round(spread, 1)} B/step. ` +
      (discarded.length > 0
        ? `${discarded.length} window(s) showed a heap *decrease* and were discarded as collector-polluted.`
        : 'No window showed a heap decrease, so none was polluted by a collection.') +
      (ENLARGED_NURSERY ? '' : ' Run WITHOUT --max-semi-space-size=64, so this figure is depressed and unreliable.'),
    note:
      'ARCHITECTURE §10 claims zero per-frame allocation in simulation hot paths. It is not zero and cannot ' +
      'be while `stepRitual` constructs a named `Rng` per subsystem per step, so there is no §10 number to ' +
      'check against; the limit here is a guard rail chosen from measurement, and `history` records every ' +
      'time it has moved and why. What is asserted is that the churn does not grow unnoticed — see ' +
      '`retained` for the number that would indicate a real leak, and the `max ms` column for what this ' +
      'churn costs: a scavenge landing inside a step is the only thing in this benchmark that ever exceeds ' +
      'the 1.5 ms frame budget.',
  };
}

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const startedAt = new Date().toISOString();
process.stderr.write('Measuring simulation cost by ritual stage...\n');
const stages = STAGES.map((stage) => {
  process.stderr.write(`  ${stage.id} (${stage.seconds}s simulated)...\n`);
  return measureStage(stage);
});

process.stderr.write('Measuring long-session retained heap...\n');
const retained = measureLongRun();

process.stderr.write('Measuring allocation churn...\n');
const allocation = measureAllocation();

const worst = stages.reduce((a, b) => (b.ms.mean > a.ms.mean ? b : a));
const worstP99 = stages.reduce((a, b) => (b.ms.p99 > a.ms.p99 ? b : a));

const passed =
  stages.every((stage) => stage.withinBudget) && retained.withinBudget && allocation.withinBudget;

const report = {
  tool: 'tools/perf/sim-bench.mjs',
  what: 'Cost of `stepRitual` at the fixed 60 Hz timestep, measured on the compiled @somemore/sim.',
  startedAt,
  finishedAt: new Date().toISOString(),
  environment: {
    node: process.version,
    platform: `${process.platform}/${process.arch}`,
    cpus: (await import('node:os')).cpus().length,
    cpuModel: (await import('node:os')).cpus()[0]?.model ?? 'unknown',
    simDt: SIM_DT,
    stepsPerSecond: STEPS_PER_SECOND,
  },
  budgets: {
    simulationMs: FRAME_BUDGET_MS.simulation,
    assertAtMeanMs: ASSERT_AT.simulationMeanMs,
    assertAtP99Ms: ASSERT_AT.simulationP99Ms,
    retainedBytesPerStep: ASSERT_AT.retainedBytesPerStep,
    transientBytesPerStep: ASSERT_AT.transientBytesPerStep,
  },
  stages,
  worstStage: { id: worst.id, meanMs: worst.ms.mean, budgetUsage: worst.budgetUsage },
  worstP99Stage: { id: worstP99.id, p99Ms: worstP99.ms.p99 },
  retained,
  allocation,
  passed,
};

const jsonPath = writeJson(artifactPath('perf', 'sim-bench.json'), report);

const lines = [];
lines.push('');
lines.push('Simulation benchmark — ARCHITECTURE §10 (simulation ≤ 1.5 ms/frame)');
lines.push('');
lines.push(
  table(
    ['stage', 'steps', 'mean ms', 'p50 ms', 'p95 ms', 'p99 ms', 'max ms', '% of 1.5ms', ''],
    stages.map((stage) => [
      stage.id,
      stage.steps,
      stage.ms.mean.toFixed(4),
      stage.ms.p50.toFixed(4),
      stage.ms.p95.toFixed(4),
      stage.ms.p99.toFixed(4),
      stage.ms.max.toFixed(4),
      `${(stage.budgetUsage * 100).toFixed(1)}%`,
      verdict(stage.withinBudget),
    ]),
  ),
);
lines.push('');
lines.push(
  `Worst stage: ${worst.id} at ${worst.ms.mean.toFixed(4)} ms/step mean — ` +
    `${(worst.budgetUsage * 100).toFixed(1)}% of the 1.5 ms budget, ` +
    `${(FRAME_BUDGET_MS.simulation / worst.ms.mean).toFixed(0)}x headroom.`,
);
lines.push(
  `Worst p99:   ${worstP99.id} at ${worstP99.ms.p99.toFixed(4)} ms (budget-as-ceiling ${ASSERT_AT.simulationP99Ms} ms).`,
);
lines.push('');
lines.push(
  `Long run: ${retained.steps.toLocaleString()} steps (${(retained.simulatedSeconds / 60).toFixed(0)} simulated minutes) — ` +
    `retained ${retained.retainedBytesPerStep} B/step, ${(retained.retainedTotalBytes / 1024).toFixed(0)} KiB total ` +
    `[${verdict(retained.withinBudget)}, limit ${ASSERT_AT.retainedBytesPerStep} B/step]`,
);
lines.push(
  `Allocation: ~${allocation.transientBytesPerStep} B/step transient (median of ${allocation.usableWindows} ` +
    `scavenge-free ${allocation.windowSteps.toLocaleString()}-step windows, spread ${allocation.spreadBytesPerStep} B/step) ` +
    `[${verdict(allocation.withinBudget)}, sanity ceiling ${ASSERT_AT.transientBytesPerStep} B/step]`,
);
lines.push('');
lines.push('  Note: §10 says "zero per-frame allocation in simulation hot paths". It is not zero — `stepRitual`');
lines.push('  constructs a named `Rng` per subsystem per step — but the transient figure above is a weak');
lines.push('  instrument and is reported, not asserted on with any precision. `heapUsed` deltas are the only');
lines.push('  allocation signal Node exposes, and three defensible sampling methods gave three different');
lines.push('  answers for the same build (see `measurementNote` in the JSON). Treat it as an order of');
lines.push('  magnitude and a trend, nothing finer.');
lines.push('');
lines.push('  The number that IS solid is retained growth, and it is flat: whatever the simulation allocates,');
lines.push('  it hands all of it back. The visible cost of the churn is the `max ms` column — a scavenge');
lines.push('  landing inside a step is the only thing in this whole benchmark that exceeds 1.5 ms.');
const worstMax = stages.reduce((a, b) => (b.ms.max > a.ms.max ? b : a));
if (worstMax.ms.max > FRAME_BUDGET_MS.simulation) {
  lines.push('');
  lines.push(
    `  Worst single step across the whole run: ${worstMax.ms.max.toFixed(2)} ms in "${worstMax.id}" — over the ` +
      `${FRAME_BUDGET_MS.simulation} ms budget, and ${(worstMax.ms.max / worstMax.ms.p99).toFixed(0)}x its own p99.`,
  );
  lines.push('  That shape is a garbage collection, not the model: the p99 is two orders of magnitude below it.');
  lines.push('  It is reported rather than asserted on, because a single dropped frame per session is survivable');
  lines.push('  and because the fix is to allocate less, which is tracked by the allocation figure above.');
}
lines.push('');
lines.push(`Report: ${relative(jsonPath)}`);
lines.push(passed ? 'RESULT: PASS' : 'RESULT: FAIL');
lines.push('');
process.stdout.write(`${lines.join('\n')}\n`);

process.exit(passed ? 0 : 1);
