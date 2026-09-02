/**
 * Headless audio analysis — the answer to "nobody has heard it".
 *
 * Builds `lab.ts` (which imports the real audio engine unmodified), loads the
 * bundle into a blank Chromium page, renders every signature sound through a
 * real `OfflineAudioContext`, and measures the resulting PCM.
 *
 * Run: `npm run audio:analyse`
 *      `npm run audio:analyse -- --only latch-clunk,frost-crackle`
 *
 * What this can prove and what it cannot is stated in the report itself and in
 * `tools/README.md`. Short version: it proves the sounds are *well-formed*. It
 * cannot prove they sound good.
 */

import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { build } from 'vite';

import { REPO_ROOT, artifactPath, relative, round, table, verdict, writeJson, writeText, wrap } from '../lib/io.mjs';
import { RELATIONS, SOUNDS, UNIVERSAL } from './sounds.mjs';

const OUT_DIR = resolve(REPO_ROOT, 'tools/audio/.build');
const BUNDLE = join(OUT_DIR, 'audio-lab.iife.js');

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;
const keepBundle = args.includes('--keep-bundle');

/* -------------------------------------------------------------------------- */
/* Build                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Bundled with Vite rather than executed with a TypeScript runner, for one
 * reason: the audio engine has to run in a browser, because a browser is the
 * only thing here with a WebAudio implementation. Node has none, and the fake
 * context in `audio/testing.ts` deliberately produces no samples.
 */
async function buildLab() {
  process.stderr.write('Bundling the audio lab...\n');
  await build({
    root: REPO_ROOT,
    logLevel: 'warn',
    configFile: false,
    build: {
      outDir: OUT_DIR,
      emptyOutDir: true,
      minify: false,
      target: 'es2022',
      lib: {
        entry: resolve(REPO_ROOT, 'tools/audio/lab.ts'),
        formats: ['iife'],
        name: 'SomeMoreAudioLab',
        fileName: () => 'audio-lab.iife.js',
      },
    },
  });
  if (!existsSync(BUNDLE)) {
    throw new Error(`vite produced no bundle at ${BUNDLE}; found ${readdirSync(OUT_DIR).join(', ')}`);
  }
}

/* -------------------------------------------------------------------------- */
/* Browser                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * Same browser-resolution rule as `playwright.config.ts`: this environment
 * ships a pre-provisioned Chromium whose version may not match the one this
 * Playwright release would download, and downloading is off.
 */
function findChromium() {
  const fromEnv = process.env['SOME_MORE_CHROMIUM'];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const root = process.env['PLAYWRIGHT_BROWSERS_PATH'];
  if (!root || !existsSync(root)) return undefined;
  return readdirSync(root)
    .filter((entry) => entry.startsWith('chromium-'))
    .sort()
    .reverse()
    .map((entry) => join(root, entry, 'chrome-linux', 'chrome'))
    .find((candidate) => existsSync(candidate));
}

/* -------------------------------------------------------------------------- */
/* Checking                                                                    */
/* -------------------------------------------------------------------------- */

/** Reads a dotted path, or a `+`-joined sum of band-energy fractions. */
function valueAt(metrics, path) {
  if (path.startsWith('bandEnergy.') && path.includes('+')) {
    return path
      .slice('bandEnergy.'.length)
      .split('+')
      .reduce((total, band) => total + (metrics.bandEnergy[band] ?? 0), 0);
  }
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), metrics);
}

function checkSound(sound, metrics) {
  const results = [];
  const skip = new Set(sound.skipUniversal ?? []);
  const expectations = { ...Object.fromEntries(Object.entries(UNIVERSAL).filter(([key]) => !skip.has(key))), ...sound.expect };

  for (const [path, [min, max]] of Object.entries(expectations)) {
    const value = valueAt(metrics, path);
    const ok = typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    results.push({ path, value: typeof value === 'number' ? round(value, 6) : value, min, max, ok });
  }
  // A rendered sound that is entirely silent passes almost any range check by
  // accident, so silence is called out separately unless it is the point.
  if (metrics.silent && !skip.has('peak')) {
    results.push({ path: 'silent', value: true, min: false, max: false, ok: false });
  }
  return results;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

await buildLab();

const executablePath = findChromium();
process.stderr.write(`Launching Chromium${executablePath ? ` (${executablePath})` : ''}...\n`);
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--no-sandbox', '--autoplay-policy=no-user-gesture-required'],
});

const results = [];
const metricsById = {};
let pageErrors = [];

try {
  const page = await browser.newPage();
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto('about:blank');
  await page.addScriptTag({ path: BUNDLE });
  await page.waitForFunction(() => Boolean(window.__audioLab));

  const selected = SOUNDS.filter((sound) => !only || only.has(sound.id));
  if (selected.length === 0) throw new Error(`--only matched no sounds. Known ids: ${SOUNDS.map((s) => s.id).join(', ')}`);

  for (const sound of selected) {
    process.stderr.write(`  rendering ${sound.id} (${sound.seconds}s)...\n`);
    const rendered = await page.evaluate(
      (request) => window.__audioLab.render(request),
      { id: sound.id, script: sound.script, seconds: sound.seconds, ...(sound.arg !== undefined ? { arg: sound.arg } : {}) },
    );
    metricsById[sound.id] = rendered.metrics;
    const checks = checkSound(sound, rendered.metrics);
    results.push({
      id: sound.id,
      label: sound.label,
      why: sound.why,
      seconds: sound.seconds,
      metrics: rendered.metrics,
      checks,
      passed: checks.every((check) => check.ok),
    });
  }
} finally {
  await browser.close();
}

const relationResults = RELATIONS.filter((relation) =>
  // A relation can only be evaluated if every sound it names was rendered.
  !only || [...only].length === SOUNDS.length ? true : relationInputsPresent(relation, metricsById),
).map((relation) => {
  let ok = false;
  let detail = '';
  try {
    ok = Boolean(relation.check(metricsById));
    detail = relation.describe(metricsById);
  } catch (error) {
    ok = false;
    detail = `could not evaluate: ${String(error)}`;
  }
  return { id: relation.id, claim: relation.claim, why: relation.why, detail, ok };
});

function relationInputsPresent(relation, metrics) {
  try {
    relation.describe(metrics);
    return true;
  } catch {
    return false;
  }
}

const soundsPassed = results.every((result) => result.passed);
const relationsPassed = relationResults.every((relation) => relation.ok);
const passed = soundsPassed && relationsPassed && pageErrors.length === 0;

const PROVES = [
  'Every sound listed actually renders to audio. They are not silent, not scheduled-but-never-triggered, and not dependent on a real AudioContext to exist.',
  'None of them clips, and none carries a DC offset.',
  'Each one has the spectral character its design brief claims: the latch is low-frequency dominant, the frost crackle is high, the completion tone is tonal and dark, the fan is broadband.',
  'Each has a plausible envelope — a transient is a transient, a bed sustains, a ramp ramps.',
  'The relationships between sounds hold: the latch sits far below the frost, embers read brighter than flames, the completion tone is quieter than the machinery around it, and the five relays are measurably distinguishable.',
  'A dead fire renders exact silence, all the way to the samples rather than only in the parameter mapping.',
];

const CANNOT_PROVE = [
  'That any of it sounds good. Timbre, taste and the line between "industrial" and "annoying" are human judgements and no measurement here substitutes for them.',
  'That the SM-01 sequence has the right pacing. The gaps between events carry the machine\'s narrative, and whether those gaps feel right needs a listener.',
  'That the mix balances. Every sound is measured in isolation through a unit gain, not through the engine\'s buses, master, limiter and reverb sends, and not against each other at their in-game levels.',
  'That it is comfortable over a long session. Fatigue, harshness and the CRT whine\'s audibility vary by listener and by playback system.',
  'Spatialisation. HRTF panning is not exercised here, and it cannot be evaluated without ears.',
  'How it sounds on a phone speaker, which reproduces almost none of the low end the latch and the compressor are built on — the single largest gap between this report and the shipped experience.',
];

const report = {
  tool: 'tools/audio/analyse.mjs',
  what: 'Offline rendering and measurement of the procedural audio engine, via a real OfflineAudioContext in Chromium.',
  capturedAt: new Date().toISOString(),
  sampleRate: 48000,
  soundsAnalysed: results.length,
  passed,
  pageErrors,
  proves: PROVES,
  cannotProve: CANNOT_PROVE,
  universalExpectations: UNIVERSAL,
  sounds: results,
  relations: relationResults,
};

const jsonPath = writeJson(artifactPath('audio', 'report.json'), report);

/* -------------------------------------------------------------------------- */
/* Human summary                                                               */
/* -------------------------------------------------------------------------- */

const lines = [];
lines.push('');
lines.push('Audio analysis — offline render of the procedural engine');
lines.push('');
lines.push(
  table(
    ['sound', 'peak dBFS', 'rms dBFS', 'centroid Hz', 'flatness', 'attack s', 'decay s', 'active s', 'DC', ''],
    results.map((result) => {
      const m = result.metrics;
      return [
        result.id,
        m.peakDbfs === -Infinity ? '-inf' : m.peakDbfs.toFixed(1),
        m.rmsDbfs === -Infinity ? '-inf' : m.rmsDbfs.toFixed(1),
        m.spectralCentroidHz.toFixed(0),
        m.spectralFlatness.toFixed(3),
        m.envelope.attackSeconds.toFixed(3),
        m.envelope.decaySeconds.toFixed(3),
        m.envelope.activeSeconds.toFixed(2),
        m.dcOffset.toExponential(1),
        verdict(result.passed),
      ];
    }),
  ),
);

lines.push('');
lines.push('Relationships between sounds:');
for (const relation of relationResults) {
  lines.push(`  [${verdict(relation.ok)}] ${relation.claim}`);
  lines.push(`         ${relation.detail}`);
}

const failures = results.flatMap((result) =>
  result.checks.filter((check) => !check.ok).map((check) => ({ id: result.id, ...check })),
);
if (failures.length > 0) {
  lines.push('');
  lines.push('Failed expectations:');
  for (const failure of failures) {
    lines.push(`  ${failure.id}: ${failure.path} = ${failure.value}, expected ${failure.min}..${failure.max}`);
  }
}

lines.push('');
lines.push('What this proves:');
for (const item of PROVES) lines.push(wrap(`- ${item}`));
lines.push('');
lines.push('What it cannot prove — nobody has still heard this:');
for (const item of CANNOT_PROVE) lines.push(wrap(`- ${item}`));
lines.push('');
lines.push(`Report: ${relative(jsonPath)}`);
lines.push(passed ? 'RESULT: PASS' : 'RESULT: FAIL');
lines.push('');

const summary = lines.join('\n');
process.stdout.write(`${summary}\n`);

/* A committed, readable write-up for anyone who will not run the tool. */
const markdown = [
  '# Audio analysis report',
  '',
  `Generated by \`tools/audio/analyse.mjs\` on ${report.capturedAt}.`,
  '',
  'Every sound below was rendered through a real `OfflineAudioContext` in Chromium, using the',
  'unmodified synthesis code in `apps/web/src/audio`, and measured from the resulting PCM.',
  '',
  '## Measurements',
  '',
  '| sound | peak dBFS | rms dBFS | centroid Hz | flatness | attack s | decay s | active s | verdict |',
  '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | --- |',
  ...results.map((result) => {
    const m = result.metrics;
    return `| ${result.id} | ${m.peakDbfs === -Infinity ? '−inf' : m.peakDbfs.toFixed(1)} | ${
      m.rmsDbfs === -Infinity ? '−inf' : m.rmsDbfs.toFixed(1)
    } | ${m.spectralCentroidHz.toFixed(0)} | ${m.spectralFlatness.toFixed(3)} | ${m.envelope.attackSeconds.toFixed(
      3,
    )} | ${m.envelope.decaySeconds.toFixed(3)} | ${m.envelope.activeSeconds.toFixed(2)} | ${verdict(result.passed)} |`;
  }),
  '',
  '## Relationships',
  '',
  ...relationResults.flatMap((relation) => [
    `**${verdict(relation.ok)} — ${relation.claim}.** ${relation.detail}`,
    '',
    relation.why,
    '',
  ]),
  '## What this proves',
  '',
  ...PROVES.map((item) => `- ${item}`),
  '',
  '## What it does not prove',
  '',
  'Shortfall S7 in `IMPLEMENTATION_PLAN.md` says "no human has listened to it". That is still true.',
  'This report narrows the risk; it does not close it.',
  '',
  ...CANNOT_PROVE.map((item) => `- ${item}`),
  '',
].join('\n');

writeText(artifactPath('audio', 'report.md'), markdown);

if (!keepBundle) {
  const { rmSync } = await import('node:fs');
  rmSync(OUT_DIR, { recursive: true, force: true });
}

process.exit(passed ? 0 : 1);
