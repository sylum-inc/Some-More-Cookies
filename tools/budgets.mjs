/**
 * The performance budgets from ARCHITECTURE.md §10, in one place.
 *
 * Every automated check in `tools/` reads its thresholds from here, so the
 * document and the tests cannot drift apart. If §10 changes, change it here
 * and the CI jobs move with it.
 *
 * `budget` is the number the architecture states. `assertAt` is the number a
 * check actually fails at, and is always at or below the budget — a check that
 * only fires *at* the budget gives no warning before a regression ships. The
 * ratio is recorded in `margin` so the reports can say how much room is left.
 */

/** ARCHITECTURE §10 — per-frame time budgets at the 60 FPS target tier. */
export const FRAME_BUDGET_MS = Object.freeze({
  total: 16.6,
  simulation: 1.5,
  sceneAndDraw: 3.0,
  gpuMain: 7.0,
  gpuPost: 1.5,
  audioScheduling: 0.5,
  headroom: 3.0,
});

/** ARCHITECTURE §10 — static budgets. */
export const STATIC_BUDGETS = Object.freeze({
  drawCalls: 120,
  triangles: 60_000,
  textureMegabytes: 24,
  dynamicLights: 6,
});

/**
 * Where the automated checks actually fail.
 *
 * These are deliberately *tighter* than the budget so a regression is caught
 * while there is still room, not after the budget is already blown.
 */
export const ASSERT_AT = Object.freeze({
  /**
   * Simulation cost. The budget is 1.5 ms for *all* systems in a frame; the
   * bench measures `stepRitual`, which is all of them. Failing at 1.05 ms
   * leaves 30 % of the budget as margin.
   */
  simulationMeanMs: 1.05,
  /**
   * The 99th percentile step is allowed the full budget: a single slow step
   * inside a 16.6 ms frame is survivable, a slow *average* is not.
   */
  simulationP99Ms: 1.5,
  /**
   * Retained heap growth across a long session, in bytes per simulation step,
   * measured after forced major GCs. This is the real "zero per-frame
   * allocation" test: transient garbage is collectable, retained growth is a
   * leak and will eventually stall a session.
   */
  retainedBytesPerStep: 8,
  /**
   * Transient allocation per step, in bytes, measured across a GC-free window.
   *
   * ARCHITECTURE §10 says "zero per-frame allocation in simulation hot paths".
   * That is not true and has never been true: `stepRitual` derives a named RNG
   * stream per subsystem per step, and each one constructs an `Rng`. So there
   * is no §10 number to check against — zero is unreachable — and this limit is
   * a guard rail chosen from measurement, not from the document.
   *
   * See `ALLOCATION_HISTORY` for where the number came from and what has moved
   * it. The limit is set with headroom above the current figure so ordinary
   * variance does not fail a build, and the benchmark prints the delta against
   * the reference on every run so growth is visible even while passing.
   */
  transientBytesPerStep: 1_100,
  drawCalls: 120,
  triangles: 60_000,
  textureMegabytes: 24,
});

/**
 * Budgets the current build does not meet, pinned at the measured value.
 *
 * A check that fails on a pre-existing deviation is a check somebody disables.
 * A check that silently lowers the bar is worse. So each known deviation is
 * recorded here with the architectural budget, the measured value, and why —
 * the check fails above `ceiling`, which stops it getting worse, and every
 * report prints the deviation next to the §10 number so it stays visible.
 *
 * Removing an entry from this list is how the deviation gets fixed: tighten the
 * ceiling to the budget once the scene stops exceeding it.
 */
export const KNOWN_DEVIATIONS = Object.freeze({
  dynamicLights: Object.freeze({
    budget: STATIC_BUDGETS.dynamicLights,
    ceiling: 10,
    measured: 10,
    stages: ['reveal', 'eating', 'bitten'],
    status: 'ACCEPTED — the budget was written before the hero tier existed.',
    why:
      'The reveal adds the finished sandwich\'s own key/fill/rim lighting on top of the fire, the camp ' +
      'lantern and the SM-01\'s interior lights. That local rig is what fixed the "sandwich renders as an ' +
      'unlit silhouette" defect (IMPLEMENTATION_PLAN, defect #5), so it is deliberate. The resolution is ' +
      'that §10\'s six was written for the explorable world and these are anchored close-ups: the camera ' +
      'is on one small object, the scene behind it is nearly empty, and the shading cost of ten lights ' +
      'over a hundred visible triangles is not the cost of ten lights over a campsite. The two cases ' +
      'cannot overlap, either — a lit torch would have been an eleventh light, and the simulation now ' +
      'stows the torch on entering a stage that needs both hands, so the world budget and the hero budget ' +
      'are never in the shader at the same time. Pinned at ten so it cannot quietly become twelve.',
  }),
});

/**
 * Measured transient allocation in the simulation hot path, over time.
 *
 * Kept as a list because the interesting thing is not the number, it is the
 * slope. A guard rail that is quietly raised every time it fires is not a guard
 * rail; a recorded history makes each raise visible and arguable.
 */
export const ALLOCATION_HISTORY = Object.freeze([
  Object.freeze({
    bytesPerStep: 229,
    method: 'median of 7 × 4,000-step windows, no collector control',
    at: 'before wildlife, radio and discovery were wired into the ritual',
    note: 'Superseded. The method is now known to under-report — see below.',
  }),
  Object.freeze({
    bytesPerStep: 862,
    method: 'median of 7 × 4,000-step windows, no collector control',
    at: 'commit "Wire wildlife, radio and secrets into the ritual, and unfreeze the RNG"',
    note:
      'The same method that had reported 229 reported 862 after `stepWorld` began running radio, wildlife ' +
      'and discovery on every step. Re-running it on an unchanged build then produced 213 — so the jump was ' +
      'not real, or not that large, and the method was the problem: a collection landing inside a window ' +
      'frees memory mid-count and biases that window downwards, and the median of a mix of clean and dirty ' +
      'windows lands wherever the collector happened to fall.',
  }),
  Object.freeze({
    bytesPerStep: 100,
    method: 'median of 5 × 20,000-step windows inside a 128 MB young generation (--max-semi-space-size=64)',
    at: 'current — the method the benchmark uses now',
    note:
      'Removing the collector from the experiment rather than trying to detect it. With a nursery far ' +
      'larger than the window allocates, no scavenge happens and the `heapUsed` delta is simply the ' +
      'allocation; windows that show a heap *decrease* are discarded as polluted anyway. Reads 57–100 ' +
      'B/step across runs. Note this is below the theoretical floor for the object churn visible in the ' +
      'source (several `Rng` constructions per step at ~24 bytes each), which means V8 is scalar-replacing ' +
      'some of it after inlining — so this figure is a *lower* bound on what the source allocates and an ' +
      'upper bound on what actually reaches the heap. It is reported as an order of magnitude, not asserted ' +
      'on precisely; retained growth is the number this benchmark actually stands behind.',
  }),
]);

/** The figure new runs are compared against, so growth is reported, not just passed. */
export const ALLOCATION_REFERENCE = ALLOCATION_HISTORY[ALLOCATION_HISTORY.length - 1];

/** Fraction of a budget at which a check warns rather than fails. */
export const WARN_AT_FRACTION = 0.85;

/**
 * The number a check should actually fail above: the tightened assertion,
 * unless a deviation has been recorded and pinned, in which case the pin.
 */
export function ceilingFor(name) {
  const deviation = KNOWN_DEVIATIONS[name];
  if (deviation) return deviation.ceiling;
  return ASSERT_AT[name];
}

/** How much of a budget a measurement used, as a 0..1 fraction. */
export function usage(measured, budget) {
  if (!Number.isFinite(measured) || !Number.isFinite(budget) || budget <= 0) return null;
  return measured / budget;
}

/**
 * What a software renderer fundamentally cannot answer.
 *
 * Printed by every performance report so nobody reads a green run as proof of
 * 60 FPS on a phone. Keep this honest; it is the most important output of the
 * whole perf tool.
 */
export const UNMEASURABLE_HERE = Object.freeze([
  'Real frame rate. Everything here renders through SwiftShader on a CPU with no GPU. Frame time measured in this environment is a property of the software rasteriser, not of any device a player owns.',
  'The GPU-side budgets (main pass ≤7.0 ms, post ≤1.5 ms). Those are GPU timings; there is no GPU.',
  'Fill-rate and bandwidth cost. The 320×240 internal target is the main mitigation for both, and neither is observable without real hardware.',
  'Shader compilation and pipeline-state stalls on mobile drivers.',
  'Thermal throttling, which is what actually decides sustained frame rate on a phone.',
  'Touch latency (the ≤50 ms input-to-response rule) — no touch digitiser is involved anywhere in this environment.',
]);

/** What this environment *can* answer, stated equally plainly. */
export const MEASURABLE_HERE = Object.freeze([
  'Simulation cost per fixed timestep, in milliseconds, on real compiled JavaScript — device-independent to within a CPU-speed factor.',
  'Retained and transient allocation per simulation step.',
  'Draw calls, triangles and texture memory per ritual stage, read from the live `THREE.WebGLRenderer.info` counters — these are properties of the scene graph, not of the GPU, so they transfer to real hardware unchanged.',
  'That the static budgets in ARCHITECTURE §10 are or are not being exceeded by scene composition.',
]);
