/**
 * The soundscape, rendered and made inspectable.
 *
 * Nobody has ever assessed this game's audio. Five rounds of art direction have
 * graded the pictures; the fire, the weather, the wildlife, the radio, the
 * SM-01 and the footsteps have been graded by nobody, and "cozy and slightly
 * eerie" is at least half sound.
 *
 * This tool renders the *shipping* audio path offline and writes, for each
 * named scene in `scenes.ts`:
 *
 *   artifacts/audio/<id>.wav              16-bit PCM, so a person can listen
 *   artifacts/audio/<id>.spectrogram.png  log frequency, dB, labelled axes
 *   artifacts/audio/<id>.envelope.png     RMS and peak over time, in dBFS
 *   artifacts/audio/<id>.json             the measurements behind both
 *
 * Run: `npm run audio:soundscape`
 *      `npm run audio:soundscape -- --only fire-burning,weather-storm`
 *
 * # What this cannot do
 *
 * **It cannot listen.** Every finding it supports is a finding about a
 * measurement or a picture of one. It can prove that there is nothing below
 * 180 Hz in a bed, that an envelope repeats every 4.1 seconds, that a crackle
 * stream has 14 discrete transients a second or none at all, and that two
 * scenes are the same numbers. It cannot prove that any of it sounds good,
 * that the pacing is right, or that a night at this fire is somewhere you
 * would want to sit down. Those need ears and this has none.
 *
 * # Why no browser
 *
 * `tools/audio/analyse.mjs` renders through Chromium because it wants a real
 * `OfflineAudioContext`. This does not: `apps/web/src/audio/offline.ts` is a
 * WebAudio simulator in plain TypeScript that reads the same `FakeAudioContext`
 * the engine is built against and evaluates it to PCM in Node. That is faster,
 * it needs no `apps/web/dist`, and — because it renders whatever graph the
 * engine actually built — it answers the one question a browser render would
 * also answer: does this sound reach the output bus at all.
 *
 * Its two documented approximations are restated on every artefact it writes:
 * `ConvolverNode` renders silence (so the reverb return is off and every level
 * is the dry mix), and HRTF is equal-power panning (direction survives,
 * spectral colouring does not).
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createServer } from 'vite';

import {
  analyse,
  averageSpectrum,
  bufferLoopEstimate,
  loopEstimate,
  rmsEnvelope,
  spectrogram,
  transients,
} from './analysis.js';
import { encodeWav, envelopeImage, spectrogramImage } from './plot.mjs';
import { REPO_ROOT, artifactPath, relative, round, table, verdict, writeJson, writeText, wrap } from '../lib/io.mjs';

const args = process.argv.slice(2);
const onlyArg = args.indexOf('--only');
const only = onlyArg >= 0 ? new Set((args[onlyArg + 1] ?? '').split(',').filter(Boolean)) : null;
const skipDeterminism = args.includes('--no-determinism');

/* -------------------------------------------------------------------------- */
/* Loading the engine                                                          */
/* -------------------------------------------------------------------------- */

/**
 * Vite in middleware mode, used only as a TypeScript loader.
 *
 * `ssrLoadModule` transpiles on demand in this process, so the audio engine,
 * the simulation, the PNG codec in `e2e/strip.ts` and the bitmap font in
 * `apps/web/src/render/bitmapFont.ts` all load as themselves, unbundled and
 * unmodified. The aliases are copied from `vitest.config.ts` so the module
 * graph resolves exactly as it does under test.
 */
async function loader() {
  return createServer({
    root: REPO_ROOT,
    logLevel: 'error',
    configFile: false,
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    resolve: {
      alias: {
        '@somemore/sim': join(REPO_ROOT, 'packages/sim/src/index.ts'),
        '@somemore/content': join(REPO_ROOT, 'packages/content/src/index.ts'),
        '@somemore/protocol': join(REPO_ROOT, 'packages/protocol/src/index.ts'),
      },
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Measuring                                                                   */
/* -------------------------------------------------------------------------- */

const BUDGET_MS = 0.5; // ARCHITECTURE.md §10, "Audio scheduling (main thread)".

/** dB, floored rather than -Infinity, so the JSON stays numeric. */
const db = (amplitude) => (amplitude > 0 ? Math.max(-200, 20 * Math.log10(amplitude)) : -200);

/**
 * Energy in named octave-ish bands, from the render's own average spectrum.
 *
 * Coarser than `analysis.js`'s `BANDS` on purpose: this set is chosen to
 * answer the questions being asked of the mix — is there a low end at all
 * (`sub`, `bass`), is everything piled into the same place (`presence`), is
 * there any air (`air`) — rather than to describe a spectrum in general.
 */
const MIX_BANDS = Object.freeze({
  'sub 20-60': [20, 60],
  'low 60-120': [60, 120],
  'bass 120-300': [120, 300],
  'lowmid 300-1k': [300, 1000],
  'mid 1k-4k': [1000, 4000],
  'high 4k-8k': [4000, 8000],
  'air 8k+': [8000, Infinity],
});

function mixBands(magnitudes, binHz) {
  const totals = {};
  let overall = 0;
  for (const name of Object.keys(MIX_BANDS)) totals[name] = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    const hz = bin * binHz;
    const energy = magnitudes[bin] * magnitudes[bin];
    overall += energy;
    for (const [name, [lo, hi]] of Object.entries(MIX_BANDS)) {
      if (hz >= lo && hz < hi) {
        totals[name] += energy;
        break;
      }
    }
  }
  if (overall > 0) for (const name of Object.keys(totals)) totals[name] /= overall;
  return totals;
}

/**
 * The lowest frequency carrying real energy.
 *
 * Defined as the lowest bin at or above which the spectrum stays within 20 dB
 * of its own peak — i.e. where the bed actually starts, not where the FFT's
 * noise floor happens to sit. "There is nothing below 180 Hz" is a claim this
 * number, and only this number, is allowed to make.
 */
function lowestSubstantialHz(magnitudes, binHz, downDb = 20) {
  let peak = 0;
  for (let bin = 1; bin < magnitudes.length; bin += 1) if (magnitudes[bin] > peak) peak = magnitudes[bin];
  if (peak <= 0) return 0;
  const threshold = peak * 10 ** (-downDb / 20);
  for (let bin = 1; bin < magnitudes.length; bin += 1) {
    if (magnitudes[bin] >= threshold) return bin * binHz;
  }
  return 0;
}

/** Median of a plain array. Used for inter-onset intervals. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

/**
 * The largest sample-to-sample step in the render.
 *
 * A click is a step; a fade is a slope. Reimplementing this here rather than
 * importing `largestDiscontinuity` from `offline.ts` would be duplication, so
 * it is passed in from the loaded module instead.
 */
function measure(rendered, offline) {
  const { audio, scene } = rendered;
  const channels = [audio.channels[0], audio.channels[1]];
  const rate = audio.sampleRate;

  const mono = new Float64Array(channels[0].length);
  for (let i = 0; i < mono.length; i += 1) mono[i] = (channels[0][i] + channels[1][i]) * 0.5;

  const base = analyse(channels, rate);
  /*
   * Frame-averaged, not one FFT over the whole render.
   *
   * `offline.spectrumOf` transforms the entire window at once, which is right
   * for a 300 ms latch clunk and wrong for a thirty-second bed: a single
   * million-point FFT of a stochastic signal is a comb of noise, and the band
   * splits taken from it wander by whole percent between runs. `averageSpectrum`
   * averages overlapping Hann frames weighted by their own energy, which is
   * what these questions are actually about.
   */
  const { magnitudes, binHz } = averageSpectrum(mono, rate, 4096, 2048);

  const onsets = transients(mono, rate);
  const loop = loopEstimate(mono, rate, 0.25, scene.seconds / 2);
  const buffer = bufferLoopEstimate(mono, rate, 0.5, scene.seconds / 2);
  // The loudest short-window RMS in the render, on the same 3 ms window the
  // onset detector uses, so `peakToMedian` compares like with like.
  const shortEnvelope = rmsEnvelope(mono, Math.max(4, Math.round(0.003 * rate)));
  let envelopePeak = 0;
  for (let i = 0; i < shortEnvelope.length; i += 1) if (shortEnvelope[i] > envelopePeak) envelopePeak = shortEnvelope[i];
  const click = offline.largestDiscontinuity(audio);
  const step = offline.largestEnvelopeStep(audio);

  return {
    id: scene.id,
    label: scene.label,
    question: scene.question,
    seconds: scene.seconds,
    sampleRate: rate,

    level: {
      peak: round(base.peak, 6),
      peakDbfs: round(base.peakDbfs, 2),
      rms: round(base.rms, 6),
      rmsDbfs: round(base.rmsDbfs, 2),
      crestFactor: round(base.crestFactor, 3),
      clippedSamples: base.clippedSamples,
      silent: base.silent,
    },
    dc: {
      offset: round(base.dcOffset, 8),
      offsetRatio: round(base.dcOffsetRatio, 6),
    },
    spectrum: {
      centroidHz: round(base.spectralCentroidHz, 1),
      rolloff85Hz: round(base.spectralRolloff85Hz, 1),
      flatness: round(base.spectralFlatness, 4),
      lowestSubstantialHz: round(lowestSubstantialHz(magnitudes, binHz), 1),
      bands: Object.fromEntries(Object.entries(mixBands(magnitudes, binHz)).map(([k, v]) => [k, round(v, 5)])),
    },
    /**
     * The crackle question, in numbers.
     *
     * `perSecond` near zero on a fire that is supposed to be burning means the
     * bed is a noise band with an envelope on it. A healthy crackle stream has
     * many onsets per second and an interval spread — `intervalSpread` well
     * above zero — because a Poisson process is irregular and a tremolo is not.
     */
    transients: {
      count: onsets.count,
      perSecond: round(onsets.perSecond, 2),
      medianIntervalSeconds: round(median(onsets.intervals), 4),
      intervalSpread: round(
        onsets.intervals.length > 1
          ? Math.sqrt(
              onsets.intervals.reduce((sum, value) => sum + (value - median(onsets.intervals)) ** 2, 0) /
                onsets.intervals.length,
            ) / Math.max(median(onsets.intervals), 1e-9)
          : 0,
        3,
      ),
      /*
       * How far the loudest moment rises over the ordinary one.
       *
       * The single number the crackle question turns on. Filtered noise, with
       * no events in it whatsoever, lands near 3 over a render this long
       * simply because a Gaussian has a tail — so a bed of discrete transients
       * has to beat that by a wide margin before "it has structure" means
       * anything. The `control-pink-noise` scene exists to supply the
       * comparison rather than leave it to intuition.
       */
      peakToMedian: round(onsets.medianFloor > 0 ? envelopePeak / onsets.medianFloor : 0, 3),
      /** Onsets per second at a sweep of thresholds — the shape of the tail. */
      perSecondByRise: Object.fromEntries(
        [1.5, 2, 2.5, 3, 4, 6].map((rise) => [`x${rise}`, round(transients(mono, rate, 0.003, rise).perSecond, 2)]),
      ),
    },
    /**
     * Autocorrelation of the RMS envelope. A correlation near 1 at a lag well
     * inside the render is the measurable form of "it loops audibly".
     */
    repetition: {
      strongestLagSeconds: round(loop.lagSeconds, 3),
      correlation: round(loop.correlation, 4),
      /*
       * Read this, not `correlation`.
       *
       * A stationary bed correlates with itself at every lag and scores a raw
       * 0.95 while repeating nothing — the `control-pink-noise` row is a
       * single non-looping buffer and proves it. Prominence is the height of
       * the best lag over the median across lags, which is zero for a smooth
       * envelope and large for a real repeat.
       */
      prominence: round(loop.prominence, 4),
      medianCorrelation: round(loop.medianCorrelation, 4),
      searchedFromSeconds: round(loop.searchedFromSeconds, 3),
      searchedToSeconds: round(loop.searchedToSeconds, 3),
      conclusive: loop.conclusive,
      /*
       * The other kind of repeat: the same PCM again, not the same pattern.
       *
       * Every continuous bed here is a looping `AudioBuffer`, so this is the
       * measurement that answers "does the noise bed loop" — and it is
       * sample-exact, which the envelope search cannot be.
       */
      buffer: {
        lagSeconds: round(buffer.lagSeconds, 4),
        correlation: round(buffer.correlation, 4),
        conclusive: buffer.conclusive,
      },
    },
    discontinuity: {
      largestSampleStep: round(click.delta, 6),
      largestSampleStepAtSeconds: round(click.atSeconds, 3),
      largestEnvelopeStepRatio: round(step.ratio, 4),
      largestEnvelopeStepAtSeconds: round(step.atSeconds, 3),
    },
    stereo: {
      correlation: base.stereoCorrelation,
      leftRmsDbfs: round(db(offline.renderChannelRms(audio, 0)), 2),
      rightRmsDbfs: round(db(offline.renderChannelRms(audio, 1)), 2),
    },
    /*
     * Each submix bus, rendered on its own.
     *
     * The instrument for "a sound that never reaches the output bus". A bus
     * reading -200 dBFS in a scene that ought to be feeding it is not a quiet
     * bus, it is an unconnected one — and that is indistinguishable, from the
     * outside, from a sound nobody wrote.
     */
    buses:
      rendered.buses === null
        ? null
        : Object.fromEntries(Object.entries(rendered.buses).map(([bus, rms]) => [bus, round(db(rms), 2)])),
    scheduling: {
      frames: rendered.frames,
      totalMs: round(rendered.schedulingMs, 3),
      perFrameMs: round(rendered.schedulingMs / Math.max(1, rendered.frames), 4),
      budgetMs: BUDGET_MS,
      withinBudget: rendered.schedulingMs / Math.max(1, rendered.frames) <= BUDGET_MS,
      eventsScheduled: rendered.eventsScheduled,
    },
    caveats: [
      'Rendered by apps/web/src/audio/offline.ts, a WebAudio simulator, not a browser.',
      'ConvolverNode renders silence, so the reverb return is off: this is the dry mix.',
      'HRTF is equal-power panning; direction is preserved, spectral colouring is not.',
      'Rendered at 24 kHz, so nothing above 12 kHz is measured.',
      'Nobody has heard this. Every number here is a measurement, not a judgement.',
    ],
  };
}

/* -------------------------------------------------------------------------- */
/* Run                                                                         */
/* -------------------------------------------------------------------------- */

const server = await loader();
process.stderr.write('Loading the audio engine (TypeScript, in Node, no browser)...\n');

const scenesModule = await server.ssrLoadModule('/tools/audio/scenes.ts');
const offline = await server.ssrLoadModule('/apps/web/src/audio/offline.ts');
const strip = await server.ssrLoadModule('/e2e/strip.ts');
const font = await server.ssrLoadModule('/apps/web/src/render/bitmapFont.ts');

const outDir = artifactPath('audio');
mkdirSync(outDir, { recursive: true });

const write = (name, buffer) => {
  const path = join(outDir, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, buffer);
  return path;
};

const selected = scenesModule.SCENES.filter((scene) => !only || only.has(scene.id));
if (selected.length === 0 && !(only && only.has('control-pink-noise'))) {
  throw new Error(`--only matched no scenes. Known ids: ${scenesModule.SCENES.map((s) => s.id).join(', ')}`);
}

const measurements = [];
const jobs = [
  ...selected.map((scene) => ({ id: scene.id, run: () => scenesModule.renderScene(scene) })),
  // The reference row, rendered last so it reads as the baseline under the
  // scenes it exists to be compared against.
  ...(!only || only.has('control-pink-noise')
    ? [{ id: 'control-pink-noise', run: () => scenesModule.renderNoiseControl(30) }]
    : []),
];

for (const job of jobs) {
  process.stderr.write(`  ${job.id}...`);
  const started = Date.now();
  const rendered = await job.run();
  const scene = rendered.scene;
  const metrics = measure(rendered, offline);

  const channels = [rendered.audio.channels[0], rendered.audio.channels[1]];
  const rate = rendered.audio.sampleRate;
  const mono = new Float64Array(channels[0].length);
  for (let i = 0; i < mono.length; i += 1) mono[i] = (channels[0][i] + channels[1][i]) * 0.5;

  write(`${scene.id}.wav`, encodeWav(channels, rate));

  const subtitle = `${metrics.level.peakDbfs}DBFS PEAK  ${metrics.level.rmsDbfs}DBFS RMS  DRY MIX NO REVERB`;
  const spec = spectrogram(mono, rate, 1024, 512);
  write(
    `${scene.id}.spectrogram.png`,
    strip.encodePng(
      spectrogramImage(spec, { glyphFor: font.glyphFor, title: scene.id, subtitle, maxHz: Math.min(11000, rate / 2) }),
    ),
  );
  write(
    `${scene.id}.envelope.png`,
    strip.encodePng(
      envelopeImage(channels, rate, {
        glyphFor: font.glyphFor,
        title: scene.id,
        subtitle: `PEAK DARK RMS BRIGHT  CREST ${metrics.level.crestFactor}`,
      }),
    ),
  );
  writeJson(join(outDir, `${scene.id}.json`), metrics);

  measurements.push(metrics);
  process.stderr.write(` ${((Date.now() - started) / 1000).toFixed(1)}s\n`);
}

/* -------------------------------------------------------------------------- */
/* Determinism                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * ADR-0001 forbids unseeded randomness in the simulation, and the engine seeds
 * its own RNG from the campsite so a place sounds the same everywhere. Neither
 * had ever been checked against the samples, which is the only place the claim
 * can actually fail.
 */
let determinism = null;
if (!skipDeterminism) {
  const scene = selected.find((candidate) => candidate.id === 'fire-burning') ?? selected[0];
  process.stderr.write(`  determinism: rendering ${scene.id} twice...\n`);
  const [first, second] = await scenesModule.renderTwice(scene);
  let largest = 0;
  for (let c = 0; c < 2; c += 1) {
    const a = first.channels[c];
    const b = second.channels[c];
    for (let i = 0; i < a.length; i += 1) {
      const delta = Math.abs(a[i] - b[i]);
      if (delta > largest) largest = delta;
    }
  }
  determinism = { scene: scene.id, largestSampleDifference: largest, identical: largest === 0 };
}

await server.close();

/* -------------------------------------------------------------------------- */
/* Report                                                                      */
/* -------------------------------------------------------------------------- */

const CANNOT_ANSWER = [
  'Whether any of it sounds good. Timbre, taste, and the line between "eerie" and "unpleasant" are human judgements.',
  'Whether the fire is cozy. A measurement can say the crackle has structure; only a listener can say it is comforting.',
  'Whether the SM-01\'s pacing works. The gaps between its events carry the machine\'s narrative and only ears read gaps.',
  'How the reverb sounds. ConvolverNode renders silence offline, so no measurement here has been through a reverb at all.',
  'How the spatialisation sounds. HRTF is rendered as equal-power panning, so the whole point of HRTF is absent.',
  'How it sounds on a phone speaker, which reproduces almost none of the low end — the largest gap between this and the shipped experience.',
  'Whether it is comfortable across a two-hour session. Fatigue and harshness vary by listener and by playback system.',
];

const report = {
  tool: 'tools/audio/soundscape.mjs',
  what: 'Offline render and measurement of the shipping audio path, scene by scene, in Node with no browser.',
  capturedAt: new Date().toISOString(),
  renderer: 'apps/web/src/audio/offline.ts (WebAudio simulator)',
  sampleRate: measurements[0]?.sampleRate ?? null,
  budgetMs: BUDGET_MS,
  determinism,
  cannotAnswer: CANNOT_ANSWER,
  scenes: measurements,
};
const jsonPath = writeJson(artifactPath('audio', 'soundscape.json'), report);

const lines = [];
lines.push('');
lines.push('The soundscape, measured — nobody has still heard it');
lines.push('');
lines.push(
  table(
    ['scene', 'peak dB', 'rms dB', 'crest', 'centroid', '<120Hz', 'onset/s x2', 'pk/med', 'buf loop', 'buf r', 'L-R', 'sched ms', ''],
    measurements.map((m) => [
      m.id,
      m.level.peakDbfs.toFixed(1),
      m.level.rmsDbfs.toFixed(1),
      m.level.crestFactor.toFixed(1),
      `${m.spectrum.centroidHz.toFixed(0)}Hz`,
      (m.spectrum.bands['sub 20-60'] + m.spectrum.bands['low 60-120']).toFixed(3),
      m.transients.perSecondByRise['x2'].toFixed(1),
      m.transients.peakToMedian.toFixed(2),
      `${m.repetition.buffer.lagSeconds.toFixed(2)}s`,
      m.repetition.buffer.correlation.toFixed(3),
      m.stereo.correlation === null ? '-' : m.stereo.correlation.toFixed(3),
      m.scheduling.perFrameMs.toFixed(3),
      verdict(m.scheduling.withinBudget && !m.level.silent && m.level.clippedSamples === 0),
    ]),
  ),
);

const silent = measurements.filter((m) => m.level.silent);
if (silent.length > 0) {
  lines.push('');
  lines.push('Scenes that rendered silence — a sound that never reaches the bus looks exactly like one nobody wrote:');
  for (const m of silent) lines.push(`  ${m.id}: peak ${m.level.peakDbfs} dBFS`);
}

/*
 * The bus table, which is where the wiring gaps show.
 *
 * A bus at -200 dBFS is not quiet, it is unconnected. Some of these are
 * expected — `machine` is silent when nobody is operating the SM-01, `voice`
 * carries other players and there are none — so what matters is a bus that is
 * silent in a scene built to feed it.
 */
const withBuses = measurements.filter((m) => m.buses !== null);
if (withBuses.length > 0) {
  lines.push('');
  lines.push('Per-bus RMS in dBFS, each bus rendered on its own. "-200" is exact digital silence:');
  lines.push(
    table(
      ['scene', ...Object.keys(withBuses[0].buses)],
      withBuses.map((m) => [m.id, ...Object.values(m.buses).map((value) => (value <= -199 ? 'silent' : value.toFixed(1)))]),
    ),
  );
}

if (determinism) {
  lines.push('');
  lines.push(
    `Determinism (${determinism.scene}, rendered twice): ${
      determinism.identical ? 'sample-identical' : `differs by ${determinism.largestSampleDifference}`
    } [${verdict(determinism.identical)}]`,
  );
}

lines.push('');
lines.push('What this cannot answer — it has no ears:');
for (const item of CANNOT_ANSWER) lines.push(wrap(`- ${item}`));
lines.push('');
lines.push(`Renders, plots and per-scene JSON: ${relative(outDir)}`);
lines.push(`Report: ${relative(jsonPath)}`);
lines.push('');

const summary = lines.join('\n');
process.stdout.write(`${summary}\n`);
writeText(artifactPath('audio', 'soundscape.md'), `# Soundscape measurements\n\n\`\`\`\n${summary}\n\`\`\`\n`);
