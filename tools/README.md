# `tools/` — automated evidence

Three claims in [`IMPLEMENTATION_PLAN.md`](../IMPLEMENTATION_PLAN.md) were
explicitly unsupported: touch feel (S2 / R7), real-hardware performance
(S3 / R8), and audio (S7 — "nobody has heard it"). This directory converts as
much of that as a machine can into measurements, stops the measurable parts
from regressing, and says plainly what is left over.

Every tool prints numbers, not just a verdict, and every tool writes a
machine-readable report under `artifacts/`.

```
tools/
├── budgets.mjs            ARCHITECTURE §10, in one place. Every check reads from here.
├── lib/io.mjs             Report paths, JSON writing, tables, percentiles.
├── vitest.config.mjs      Tests for the tools themselves.
├── perf/
│   ├── sim-bench.mjs      Headless simulation benchmark (CPU cost, allocation)
│   └── report.mjs         Merges the CPU and scene halves into one report
├── visual/
│   ├── rules.mjs          Pixel tolerances + baseline-free frame-health rules
│   ├── rules.test.js      Proof those rules actually fire on real defect shapes
│   └── measure.mjs        Re-measures the run-to-run pixel noise floor
├── audio/
│   ├── lab.ts             Renders the real synthesis graph in an OfflineAudioContext
│   ├── analysis.js        FFT, spectral measures, envelope, level, DC (no deps)
│   ├── analysis.test.js   Proof the analyser is correct, on signals with known answers
│   ├── sounds.mjs         What is rendered, and what must be true of each
│   └── analyse.mjs        Build → browser → render → measure → report
└── ci/local.mjs           The local equivalent of .github/workflows/ci.yml
```

Two Playwright suites live in `e2e/` because they need the running product:
`e2e/perf.spec.ts` and `e2e/visual.spec.ts`, sharing `e2e/stages.ts` (one
deterministic drive of the ritual) and `e2e/instrument.ts` (the in-page probes).

---

## Running everything

```bash
npm run ci:local             # every CI step, in workflow order
npm run ci:local -- --list   # what each step proves
npm run ci:local -- --only perf-sim,audio
npm run ci:local -- --skip acceptance
```

`tools/ci/local.mjs` and `.github/workflows/ci.yml` are written from the same
list of steps, and each workflow job names the step ids it corresponds to.
GitHub Actions cannot be executed in this environment, so that correspondence
is the only way the workflow's correctness is checkable here.

---

## One suite at a time, and never build while one is up

Two separate investigations in this repository lost real time to the same
cause, and it is worth stating as a rule rather than rediscovering a third
time.

**Playwright runs share a single `vite preview` on port 4173.** The config says
`reuseExistingServer: true`, which is right for a developer iterating and
wrong the moment two suites overlap. Running `npm run build` while a suite is
up rewrites `apps/web/dist` — new content hashes, new filenames — underneath
that server, so a page mid-test asks for an asset that no longer exists.
Playwright also wipes `test-results/` when it starts, so the diff images from
the *other* run vanish while somebody is reading them.

What that looks like when it bites you: a scatter of failures across unrelated
projects, each individually plausible, none reproducible in isolation. Both
times, the failures were read as real regressions first and diagnosed
correctly only afterwards. One of those runs reported ten failures across four
projects and every one of them was an artefact.

So:

- **Run one Playwright suite at a time.** In CI this is free — the workflow
  runs each project as its own job on its own machine. Locally it is a
  discipline.
- **Never run `npm run build` while a suite is up.** Build first, then test.
- **A suite that fails in a scatter across unrelated projects is contaminated
  until proven otherwise.** Re-run the failing project alone before believing
  it. `activities` "failing" 7 tests and passing 7/7 on its own is the
  signature.
- A spec that needs its own service should spawn it directly on an
  OS-assigned port rather than through `npm run` — which does not forward
  signals, so the server outlives the run and the next one dies on
  `EADDRINUSE`. `e2e/campfire.spec.ts` is the pattern.

## The individual tools

### `npm run perf:sim` — simulation benchmark

`tools/perf/sim-bench.mjs`. Imports the **compiled** `@somemore/sim` (from
`npx tsc -b`, unmodified) and calls `stepRitual` at the real fixed 60 Hz
timestep, in the real stage order, with player input applied every step the way
the client applies it.

Needs `--expose-gc --max-semi-space-size=64`, which the npm script supplies. The first is for
forced major collections between checkpoints; the second is what makes the
allocation measurement possible at all (see the honest findings below).

Measures three things:

| | |
| --- | --- |
| **Cost per step, by ritual stage** | Stages do wildly different work — roasting runs a 32-patch thermal model, assembly runs almost nothing — so a single average would hide the only stage that can blow the budget. Each stage reports mean/p50/p95/p99/max over minutes of simulated time. |
| **Long-session retained heap** | ~115,000 steps (half an hour of simulated play) with forced major GCs at checkpoints, and a least-squares slope of retained bytes against steps. A slope above zero is a leak that a short test cannot see. |
| **Transient allocation** | Heap growth across windows large enough to be meaningful and a young generation large enough that no scavenge happens inside them (`--max-semi-space-size=64`, which the npm script supplies). Reported, not precisely asserted — see below. |

**Proves:** the simulation is nowhere near its 1.5 ms budget, on real compiled
JavaScript, and a long session does not leak — retained heap growth is flat to
within a fraction of a byte per step across 115,000 steps.

**Cannot prove:** anything about a phone's CPU except by a scaling factor. A
mid-range mobile core is perhaps 3–5× slower than this runner's; at ~1 % of
budget that is still ~1 %, but the multiplier is an assumption, not a
measurement.

**Honest findings.**

ARCHITECTURE §10 says "zero per-frame allocation in simulation hot paths". It is
not zero and cannot be: `stepRitual` derives a named RNG stream per subsystem per
step and each one constructs an `Rng`. So there is no §10 number to check
against, and the limit in `tools/budgets.mjs` is a guard rail chosen from
measurement rather than from the document.

**The transient figure is a weak instrument, and the tool says so.** `heapUsed`
deltas are the only allocation signal Node exposes, and three defensible
sampling methods gave three different answers for the *same* build:

| Method | Reported | Why it is wrong |
| --- | --- | --- |
| Median of 7 × 4,000-step windows | 213–862 B/step, run to run | A collection landing inside a window frees memory mid-count, so dirty windows read *low*. The median lands wherever the collector happened to fall. |
| Maximum of 40 × 250-step windows | 4,000–7,600 B/step | The largest window is whichever one contained a heap expansion or a rare bursty step, not the typical rate. |
| Median of 5 × 20,000-step windows inside a 128 MB nursery | 57–172 B/step | The one in use. No scavenge can occur, so the delta *is* the allocation — but it sits below the theoretical floor implied by the source, which means V8 is scalar-replacing some of the churn after inlining. It is a lower bound on what the code allocates and an upper bound on what reaches the heap. |

Detecting dirty windows directly does not work either: `PerformanceObserver`
delivers `gc` entries asynchronously and the sampling loop is synchronous, so
entries arrive after the window they belong to has been classified.

The whole sequence is recorded in `ALLOCATION_HISTORY` in `tools/budgets.mjs`,
including the superseded numbers, because a benchmark that quietly replaces its
own history is not evidence. The figure is printed as an order of magnitude and
a trend; the pass/fail that this benchmark actually stands behind is **retained**
growth, which is rock solid at ~0.28 B/step over 115,000 steps.

**The one thing that does exceed the 1.5 ms budget is a garbage collection.**
The worst single step across a whole run lands between 1.5 ms and 22 ms
depending on the run, against a p99 two to three orders of magnitude below it.
That shape is a collector pause, not the model. It is reported and not asserted
on: one dropped frame in a session is survivable, and the fix is to allocate
less, which the allocation figure already tracks.

### `npm run perf:render` — renderer budget instrumentation

`e2e/perf.spec.ts` + `e2e/instrument.ts`. Drives the whole ritual and reads the
**live `THREE.WebGLRenderer` counters** from `window.__someMore.three.gl` at
every stage: `info.render.calls`, `info.render.triangles`, `info.memory`, plus a
scene-graph walk for lights, meshes and texture footprint.

Draw calls are recorded as the **peak over a burst of 20 consecutive frames**,
not one frame, because the fire's particle population changes every frame and a
single read undercounts at random. There is also a deliberate worst-case probe
on a second page: a fire loaded with four logs, swept across its whole life,
keeping the worst frame seen. Waiting for a bad frame to turn up by chance is
how a budget check becomes flaky.

**Proves:** draw calls, triangles, texture memory and light counts against
ARCHITECTURE §10. These are properties of *scene composition*, identical on a
phone and on this GPU-less runner, so they are real evidence about real
hardware.

**Cannot prove:** frame rate, GPU pass timings, fill rate, driver stalls,
thermal behaviour. There is no GPU here.

**Honest findings — two budgets in ARCHITECTURE §10 are currently exceeded.**

- **Draw calls: 121 against a budget of 120,** in the arrival frame. It was 115
  when this tool was first run and 121 after the campsite became explorable,
  which took the arrival scene from 148 objects to 175. The arrival shot is the
  worst case by construction — the whole campsite framed from the trail with
  nothing yet culled — and it is also the first thing a player ever sees, so it
  is the frame least able to afford a stall. Every stage after it sits at
  60–94 calls, so the budget itself is not wrong; the fix is batching or
  instancing the small scenery props. **Not accepted**, pinned at 121 so it
  cannot drift to 130 while it is dealt with. Owned by the render/scene
  workstream.
- **Dynamic lights: 10 against a budget of 6,** in the reveal, eating and
  bitten stages. The finished sandwich's own key/fill/rim rig — which is what
  fixed the "unlit silhouette" defect — sits on top of the fire, the lantern
  and the SM-01's interior lights. This one is deliberate, but it lands on the
  three most important stages in the product. Either §10 should say so or the
  hero lighting should be baked into the material. Pinned at 10.

Both are recorded in `tools/budgets.mjs` as `KNOWN_DEVIATIONS`, each with the
budget, the measured value, the stages, the reason and the route out. The check
fails *above the pin*, so a deviation cannot grow, and every report prints it
next to the §10 number so it cannot be forgotten. `tools/visual/rules.test.js`
asserts that no pin may exceed double its budget and that every pin carries a
written way to remove it — a pinning mechanism with no exit is just a lowered
budget.

### `npm run perf` / `npm run perf:report`

Runs both halves and merges them into `artifacts/perf/report.json` and
`report.md`. The report always prints what a software renderer cannot answer.
A green performance run here is **not** evidence of 60 FPS on a phone, and the
report says so in the same breath as every number.

### `npm run visual` — visual regression

`e2e/visual.spec.ts` + `tools/visual/rules.mjs`. Two independent checks at each
of sixteen ritual stages, because they fail on different things.

**1. Pixel comparison against a committed baseline.** Playwright's built-in
snapshot comparison; baselines are in `e2e/__screenshots__/` (set by
`snapshotPathTemplate` in `playwright.config.ts`, so they are one reviewable
directory rather than scattered beside specs). Catches "the picture changed".

**2. Frame health, from the luminance distribution.** Needs no baseline at all.
Re-renders the WebGL canvas synchronously (the way the in-game photo capture
does, since a drawing buffer is cleared once composited), samples it at 256 px
wide, and measures mean luminance, standard deviation, black/white fractions,
colour variety, warmth and a 4×4 tile grid. Catches "the picture is *broken*".

Three of the ten defects the previous session found by looking at the running
product were exactly that shape — an unlit sandwich, an entirely black assembly
stage, a reveal whiteout — and all three were invisible to a fully green test
suite. Check 2 catches all three, and `tools/visual/rules.test.js` drives it
with each of those defect shapes to prove it does.

There is also one cross-stage assertion that no pixel comparison could make
robustly: **amber gives way to blue**. The processing stage's measured warmth
(mean R−B) is +0.065 and the freezing stage's is −0.031, and the suite asserts
the relationship rather than either number.

#### Updating baselines

```bash
npm run visual:update        # rewrite every baseline from the current build
npm run visual:measure       # re-measure the run-to-run noise floor
```

`visual:update` is the deliberate path, and the diff it produces is meant to be
looked at. Updating baselines to make a red build green without opening the
diff is the one way this suite becomes worthless.

#### How the tolerances were chosen

Not guessed. `npm run visual:measure` re-runs the whole suite against the
committed baselines with **zero** tolerance and prints the resulting difference
ratio per stage — the run-to-run noise floor. Measured here: 0–3 % of pixels,
worst at `eating` (3 %), then `roasting`, `assembling` and `bitten` (2 %),
everything else at or below 1 %, and `machine-armed` matching pixel-for-pixel.

That noise has three sources, and it bounds how tight the tolerances can ever
be: the ordered 4×4 Bayer dither and 5:5:5 quantisation make flat areas differ
by a quantisation step; the vertex jitter snaps positions to a virtual raster;
and — the big one — the render loop advances the simulation by *wall-clock*
delta, so the flame's flicker phase at the instant of a screenshot is not
reproducible between runs. Stage *state* is reproducible. The exact pixels of
the fire are not.

The configured tolerances sit 4–12× above the measured noise, per stage, with
the reasoning written next to each in `tools/visual/rules.mjs`.

**Proves:** every stage renders a lit, structured, coloured picture that matches
a reviewed baseline, and the machine's amber→blue narrative is really in the
pixels.

**Cannot prove:** that the picture is good-looking, appetising, or well framed.
Those are human judgements, and a baseline is only ever as good as the person
who approved it. Risk R3 ("the sandwich may not look delicious") is not
addressed by any of this.

#### The roast check, and why it exists

The suite also measures what the roasting stages actually achieved — mean
browning, char, `roastInput.rotation`, and the spread between the lightest and
darkest patch — and prints it next to the frame metrics.

This is not a pixel question, but it decides whether `roasting`, `roasted` and
every baseline downstream of them (the finished sandwich's appearance is derived
from the roast) is a picture of the thing it is named after. A driver whose
input silently stops reaching the simulation still produces sixteen perfectly
plausible screenshots, and a pixel comparison against baselines captured under
the same broken driver will happily pass forever.

**It caught exactly that.** `ArrowLeft`/`ArrowRight` no longer turn the
marshmallow: the explorable-campsite work bound the arrow keys to walking, and
`movementControl`'s `normaliseKey` consumes them first, so
`roastInput.rotation` stays at `0` through 24 presses. The stages still roast —
walking around the fire changes the bearing — but one-sidedly (spread 0.16), and
the keyboard-only roasting path that spec §12 offers as the accessibility
alternative to the drag is currently broken. The acceptance suite asserts that
path directly and is correctly red for it; this suite reports it as a warning
rather than failing, because its job is baselines, not interaction — but it
refuses to bless them silently.

### `npm run audio:analyse` — offline audio analysis

`tools/audio/`. The answer to "nobody has heard it" — as far as a machine can
get.

`lab.ts` imports the **real** audio engine from `apps/web/src/audio`, unmodified,
and constructs the same `MachineKit`, `FireBed` and `FoleyKit` the game
constructs — against a real `OfflineAudioContext`. Vite bundles it (IIFE);
`analyse.mjs` injects the bundle into a blank Chromium page, renders each sound
to actual PCM, and measures it with `analysis.js`.

Why offline rendering rather than the `FakeAudioContext` in
`apps/web/src/audio/testing.ts`: the fake records automation events, which proves
the *scheduling* is right, and the 102-test audio suite already does that
thoroughly. It cannot prove the result is audible, that filters resonate where
they should, that nothing clips, or that the latch is low-frequency dominant.
Only samples can.

25 sounds are rendered: the SM-01's signature kit (latch clunk, switch detent,
all five relays, compressor start and stop, fan ramp, refrigerant flow, frost
crackle, completion tone, two beeps, door open, vapour release), the fire bed in
three states, foley (sizzle, graham snap, chocolate fracture, ignition whoosh),
and the clearing's reverb impulse response.

Measured per sound: peak, RMS, crest factor, dBFS, DC offset (absolute and
relative to peak), clipped-sample count, spectral centroid, 85 % rolloff,
spectral flatness, zero-crossing rate, energy in six bands, attack/decay/active
times from the RMS envelope, and stereo correlation.

Every range in `tools/audio/sounds.mjs` is a **claim about the sound design**
written as a measurable property — "the latch is low-frequency dominant", "the
frost crackle is high and quiet", "the completion tone is tonal, dark and
restrained" — with the reasoning next to it. Seven cross-sound relationships are
asserted too, because those pin the design down in a way absolute thresholds
cannot: the latch's centroid must sit far below the frost crackle's, the
completion tone must be quieter than the latch it follows and more tonal than
the fan, a burned-down fire must have lost the low end a flaming one is built
on, the five relays must be measurably distinguishable, and a dead fire must
render exact silence.

The analyser has its own test suite (`analysis.test.js`, 16 tests) driving it
with sines of known frequency, white noise, decaying exponentials and digital
silence — because a report full of confident numbers from a broken FFT is worse
than no report.

**Proves:** every sound renders to real audio; none clips; none carries a
meaningful DC offset; each has the spectral character and envelope its design
brief claims; and the relationships between them hold.

**Cannot prove — and this is the important half:**

- That any of it *sounds good*. Timbre and taste are human judgements.
- That the SM-01's sequence has the right *pacing*. The gaps between events
  carry the machine's narrative and no measurement here evaluates them.
- That the mix balances. Each sound is measured in isolation through a unit
  gain, not through the engine's buses, master, limiter and reverb sends, and
  not against the others at their in-game levels.
- That it is comfortable over a long session — fatigue and harshness vary by
  listener and system.
- Spatialisation. HRTF panning is not exercised and cannot be evaluated without
  ears.
- How it sounds on a phone speaker, which reproduces almost none of the low end
  the latch and the compressor are built on. This is the largest gap between
  the report and the shipped experience.

**Honest finding.** The fire bed carries a DC offset of −0.0064 (0.64 % of full
scale, 1.0 % of its own peak). It comes from the brown-noise rumble:
`fillBrownNoise` is a leaky integrator with a pole at 0.998, so it high-passes
at only ~15 Hz and a four-second loop's mean is not exactly zero. Inaudible, and
inside the conventional 1 %-of-full-scale line, but it is real, it is the
largest offset in the engine, and it is recorded rather than rounded away.

### `npm run test:tools`

The tests for the measuring instruments: `tools/audio/analysis.test.js` (16) and
`tools/visual/rules.test.js` (11). These run in CI's `verify` job alongside the
product's own suite, deliberately not merged into `npm test` — that script is
the product's suite and should stay that.

---

## Where the reports land

| Path | Written by |
| --- | --- |
| `artifacts/perf/sim-bench.json` | `npm run perf:sim` |
| `artifacts/perf/render-budget.json` | `npm run perf:render` |
| `artifacts/perf/report.json` · `report.md` | `npm run perf:report` |
| `artifacts/visual/frame-metrics.json` | `npm run visual` |
| `artifacts/visual/pixel-noise.json` | `npm run visual:measure` |
| `artifacts/audio/report.json` · `report.md` | `npm run audio:analyse` |
| `artifacts/ci/local-run.json` | `npm run ci:local` |
| `e2e/__screenshots__/*.png` | `npm run visual:update` — **committed**, they are the baselines |
| `artifacts/screenshots/*.png` | the acceptance suite (already gitignored) |

Every CI job uploads its own directory as a build artifact. The `.md` reports
are also appended to the GitHub job summary, so the numbers are on the run page
rather than buried in a log.

One loose end this workstream could not tidy: `.gitignore` covers
`artifacts/screenshots/*.png` but not the new `artifacts/perf`, `artifacts/audio`,
`artifacts/visual` or `artifacts/ci` directories, and root files other than
`package.json` and `playwright.config.ts` were out of scope here. Adding
`artifacts/**/*.json`, `artifacts/**/*.md` to `.gitignore` (keeping
`e2e/__screenshots__/` tracked, since those are the baselines) would stop
generated reports showing up as untracked noise.

---

## What is still not proved by any of this

Stated here rather than only in the individual reports, because it is the part
most easily lost:

| Claim | Status |
| --- | --- |
| **That the roast stages here were really roasted** | **Fixed, and now measured.** The explorable-campsite work briefly bound arrow keys to walking, and this driver roasts with those keys — so the roast stages were becoming pictures of a one-sided marshmallow while the pixel comparison passed happily against baselines captured under the same broken driver. The acceptance suite went red for it and the regression is fixed; this suite now reads back browning, char, rotation and one-sidedness on every run and warns by name if the marshmallow never turned, so the same silent degradation cannot recur. |
| **Touch feel** (S2, R7) | **Untouched by everything here.** No touch digitiser is involved anywhere in this environment. Playwright's synthetic pointer events are not a thumb on glass, and roasting is a two-axis drag whose whole risk is how it feels under one. This needs a phone. |
| **60 FPS on real hardware** (S3, R8) | **Narrowed, not closed.** What has been removed is the possibility that the simulation or the scene composition is the bottleneck: the model uses under 2 % of its frame budget and the scene draws ~121 calls of ~5 200 triangles. What remains — GPU main pass, post, fill rate, shader compilation, thermal throttling — is entirely device-side. |
| **Audio quality** (S7) | **Narrowed, not closed.** The sounds are provably well-formed. Whether they sound *good*, and whether the SM-01's sequence is paced right, still needs a person with speakers. |
| **"Does the sandwich look delicious?"** (R3) | Untouched. Visual regression proves the picture has not *changed*; appetite is a human judgement. |
| **Whether roasting is satisfying** (R1) | Untouched. The thermal model is provably correct and provably cheap. Neither of those is the question. |

A green CI run on this repository means: it compiles, the unit suite and the
acceptance suite pass, the simulation is fast and does not leak, the scene stays
inside its budgets except for two pinned, documented deviations, every stage
still looks like its baseline and is a well-formed frame, and every sound is
well-formed. It does not mean the product is good.
