# Audio engine

A fully procedural WebAudio engine. **There are no audio assets in this project
and none can be added** — every sound here is synthesised at runtime from
oscillators, JS-generated noise buffers, biquad filters, envelopes and
convolution with impulse responses that are also generated in JS.

Nothing is created at import time. Constructing an `AudioEngine` touches no
browser API; an `AudioContext` is created only inside `resume()`, which browsers
require to be called from a user gesture. That is also what makes the whole
module importable and testable in Node.

```ts
import { AudioEngine, AMBIENCE_PRESETS } from './audio/index.js';

const engine = new AudioEngine({ seed: campsiteId, ambienceProfile: AMBIENCE_PRESETS.lakeside });

startButton.addEventListener('click', async () => {
  if (await engine.resume()) engine.startBeds();
});

// every simulation frame — allocates nothing:
engine.setFireState({ intensity, emberHeat, fuelLoad, windSpeed, crackleRate });
engine.setAmbienceConditions({ temperatureC, windSpeed, timeOfDay, playerLoudness });
engine.listenerUpdate(cameraPosition, cameraForward, cameraUp);
```

---

## Files and public surface

### `index.ts`
Barrel. Everything below is re-exported from here except `testing.ts`, which is
deliberately excluded so the fake context never reaches the bundle.

### `engine.ts` — `AudioEngine`
| Member | Purpose |
| --- | --- |
| `new AudioEngine(options?)` | Never touches WebAudio. |
| `resume(): Promise<boolean>` | Lazily creates the context and builds the graph. `false` = unsupported/blocked. |
| `suspend()`, `close()` | Pause; full teardown (re-`resume()`able). |
| `status`, `context`, `initialized`, `AudioEngine.supported` | Lifecycle inspection. |
| `mixer` | The `MixerState` (see below). |
| `setBusVolume(bus, 0..1)`, `getBusVolume`, `setMasterVolume`, `getMasterVolume` | Per-bus and master level. |
| `setMuted`, `toggleMute`, `muted` | Global mute. |
| `setReducedAudioIntensity(bool)`, `reducedAudioIntensity` | Accessibility. |
| `snapshot()` | Serialisable mixer state for settings persistence. |
| `fire`, `ambience`, `machine`, `foley`, `reverb` | The layers (null before `resume()`). |
| `setFireState`, `setAmbienceConditions`, `setSizzleState` | Hot-path passthroughs. |
| `startBeds()`, `stopBeds()` | Start/stop the continuous fire + ambience beds. |
| `setAmbienceProfile(profile)`, `setSpace(space, wet?)` | Campsite change. |
| `listenerUpdate(pos, forward, up)` | Listener transform. |
| `setFirePosition`, `setMachinePosition` | Move the built-in emitters. |
| `createEmitter(bus, opts?)`, `releaseEmitter`, `emitterCount` | Ad-hoc positioned sources. |
| `busInput(bus)` | The bus `GainNode`, for custom routing. |
| `pump(now?)` | Drives stochastic scheduling. Automatic on a timer unless `pumpIntervalMs: 0`. |

Options: `contextFactory`, `sampleRate`, `seed` (number or string), `spatialQuality`,
`spatialiseLayers`, `ambienceProfile`, `reverb`, `mixer`, `noiseBank`, `fire`,
`ambience`, `machine`, `foley`, `pumpIntervalMs`.

**Graph**

```
layer ─▶ [SpatialEmitter ─▶ PannerNode] ─▶ bus gain ─┬─▶ master gain ─▶ limiter ─▶ destination
                                                     └─▶ reverb send ─▶ convolver ─▶ tone ─┘
```

The limiter (`DynamicsCompressorNode`) is a safety net, not a mix tool: it
guarantees no combination of simulation state can produce a painful peak.

### `buses.ts` — mixer state machine (pure)
`BUS_NAMES` = `ambience | fire | machine | foley | ui | voice`, plus
`BUS_DESCRIPTIONS` (settings-UI copy) and `DEFAULT_BUS_VOLUMES`.
`MixerState` holds volumes, mute and the reduced-intensity flag, emits
`MixerChange` notifications, and exposes `busGain`, `masterGain`,
`effectiveGain`, `isSilent`, `snapshot`/`restore`/`reset`. It knows nothing
about WebAudio, so bus behaviour is fully testable headlessly and volumes set
before `resume()` are not lost. `volumeToGain`/`gainToVolume` implement the
squared fader curve (a 0.5 slider lands near −12 dB).

### `fire.ts` — `FireBed`
`FireAudioState`, `FireVoiceParams`, `createFireVoiceParams()`,
`mapFireState(state, out)` (pure, allocation-free), `MAX_CRACKLE_RATE`.
`FireBed`: `start`, `stop`, `setState`, `crackleNow`, `pump`, `state`, `params`,
`cracklesScheduled`, `dispose`.

### `ambience.ts` — `NightAmbience`
`AmbienceProfile` and its sub-shapes (`WindCharacter`, `InsectCharacter`,
`WaterCharacter`, `BirdCharacter`, `RoomToneCharacter`, `ReverbCharacter`),
`DEFAULT_AMBIENCE_PROFILE`, `resolveAmbienceProfile(input, base?)`,
`AMBIENCE_PRESETS` (`lakeside`, `pineRidge`, `canyonMouth`, `winterHollow`),
`AmbienceConditions`, and the pure curves `nightFactor`, `insectActivity`,
`birdCallRate`, `windLevel`, `windCutoff`, `insectVoiceCount`. `BIRD_SPECS`
describes the loon/owl/nightjar calls as data.
`NightAmbience`: `start`, `stop`, `setProfile`, `setConditions`, `pump`,
`insectActivityLevel`, `insectVoicesActive`, `birdCallsScheduled`, `dispose`.

### `machine.ts` — `MachineKit` (SM-01)
Pure data: `RELAY_CHARACTERS` / `relayCharacter(index)` / `RELAY_COUNT`,
`BEEP_KINDS` / `BEEP_SPECS`, `fanCurve(speed, out)` / `createFanCurve` /
`FAN_MAX_RPM` / `FAN_BLADES`, `frostTickRate(intensity)`,
`COMPRESSOR_HARMONICS`, `compressorFrequencies(mainsHz, slip)`.

Methods (each returns the audio-clock time it finishes, and takes an optional
`when` for scheduling ahead):
`latchClunk()`, `switchDetent()`, `relayClick(index)`, `compressorStart()`,
`compressorStop()`, `fanRamp(targetSpeed, rampSeconds?)`,
`refrigerantFlow(when?, duration?)`, `frostCrackle(intensity)`,
`completionTone()`, `beep(kind)`, `crtWhine(on)`, `doorOpen()`,
`vaporRelease(when?, strength?)`, plus `pump`, `compressorRunning`, `fanSpeed`,
`fanParams`, `frostIntensity`, `crtOn`, `dispose`.

### `foley.ts` — `FoleyKit`
`SizzleState`, `SizzleParams`, `sizzleParams(state, out)` (pure),
`FOOTSTEP_MATERIALS` / `FOOTSTEP_SPECS` / `footstepSpec`, `STICK_ACTIONS`.
Methods: `startSizzle`, `stopSizzle`, `setSizzleState`, `pump`,
`ignitionWhoosh(scale?)`, `blowOut(strength?)`, `grahamSnap()`,
`chocolateFracture()`, `squish(strength?)`, `stickHandling(action)`,
`footstep(material, intensity?)`, `dispose`.

### `spatial.ts`
`SpatialEmitter` (`input`, `panner`, `setPosition`, `setOrientation`, `setGain`,
`attach(node)`, `attachMediaStream(stream)`, `detachMediaStream`, `dispose`),
`updateListener(ctx, pos, forward, up)`, and the pure helpers
`computeDistanceGain`, `choosePanningModel`, `orthonormalizeBasis`,
`normalizeVec3`, `crossVec3`, `dotVec3`, `distanceBetween`,
`DEFAULT_SPATIAL_OPTIONS`, `HRTF_SOURCE_BUDGET`.

### `impulse.ts` / `reverb.ts`
`SPACE_TYPES` (`openForest`, `clearing`, `canyon`, `snowfield`, `indoorSmall`),
`SPACE_PRESETS`, `ImpulseSpec`, `generateImpulseResponse(spec, sampleRate, seed)`,
`impulseSampleCount`, `tailEnvelope`, `mixingTimeSeconds`, `ImpulseCache`.
`ReverbBus` (`input`, `setSpace`, `setWet`, `setDamping`, `createSend`,
`space`, `wet`, `dispose`) and `DEFAULT_REVERB_SENDS`.

### `noise.ts` / `buffers.ts`
`fillWhiteNoise`, `fillPinkNoise`, `fillBrownNoise`, `fillBlueNoise`,
`fillVelvetNoise`, `fillGrain`, `fillImpulseTrain`, `generateNoise`,
`crossfadeLoopInPlace`, `loopEndFor`, `normalizeInPlace`, and the analysis
helpers `peakOf`, `rmsOf`, `zeroCrossingRate`, `windowedRms`, `correlation`.
`NoiseBank` caches the `AudioBuffer`s (`loop`, `loopEnd`, `grain`,
`grainForBrightness`, `velvet`) that every layer shares.

### `envelopes.ts`, `math.ts`, `rng.ts`, `voices.ts`, `synth.ts`, `layer.ts`, `context.ts`
Envelope maths (`percussiveValueAt`, `adsrValueAt`, `timeConstantForDecay`,
`tailSeconds`, `applyPercussive`, `applyAttackHold`, `applyRelease`,
`shapePercussive`, `FULL_INTENSITY`/`REDUCED_INTENSITY`); scalar helpers
(`math.ts`, re-exported as `audioMath`); the seeded RNG and
`poissonInterval`/`hashSeed`; pooling and scheduling (`ObjectPool`,
`PoissonScheduler`, `LookaheadWindow`, `GrainVoicePool`); the shared one-shot
primitives (`Synth`); the layer dependency bundle (`LayerDeps`); and the
context guards (`createAudioContext`, `isAudioContextSupported`,
`toAudioBuffer`, `safeStop`, `safeDisconnect`, `connectChain`).

### `testing.ts` (not exported from `index.ts`)
`FakeAudioContext` and friends: a headless WebAudio stand-in that records every
`AudioParam` automation event and every source start/stop, so scheduling can be
asserted exactly. `createFakeAudioContext()`.

---

## Synthesis approach

### Fire
| Layer | Method |
| --- | --- |
| Roar | Looping **pink** noise → resonant low-pass. Pink, not white, because moving air is 1/f. |
| Hiss | Looping **white** noise → high-pass. Steam and wood gas escaping. |
| Rumble | Looping **brown** noise → low-pass at 55–145 Hz. What makes a fire feel *big*. |
| Embers | Sparse **velvet** noise → high band-pass. The coal bed working after the flames drop. |
| Crackles | Poisson-scheduled grains from the shared grain bank, band-passed, fast attack + exponential tail, randomly panned and pitched. ~9 % are a lower, duller, longer "pop" — a sap pocket letting go. |
| Wind | Not a layer: a sine LFO summed into the roar's **gain** *and* **cutoff** params. WebAudio adds connected signals to a param's automation value, so this coexists with the `setTargetAtTime` moves the state update makes. |

### Night ambience
Wind is band-passed pink noise with a slow gust LFO modulating level and cutoff
together, plus a brighter "through the trees" band. Water is brown noise for the
body with a band-passed detail layer, distance-filtered. Insects are band-passed
**triangle** pulse trains — several voices, each detuned, each gated by its own
Poisson process, `pulsesPerChirp` blips at `chirpRateHz`. Birds are two-operator
FM with a swept carrier and a band-pass to place them in the distance. Room tone
is a very quiet low-passed brown bed.

### SM-01 (the signature kit)
Three techniques do most of the work:

* **Modal synthesis for solids.** A noise grain excites parallel high-Q
  band-passes. *Inharmonic* partial ratios (148/331/517/883/1291 Hz for the latch
  panel) read as struck steel; near-harmonic ratios read as wood.
* **Two-stage transients.** Heavy mechanisms travel before they arrive. The latch
  is a bright scrape, a ~70 ms gap, then a 92→52 Hz thunk plus the panel ring.
  That gap is most of what sells the mass.
* **Contact bounce.** Relay contacts chatter for a millisecond or two; three
  decaying micro-ticks is the difference between "relay" and "click".

| Sound | Approach |
| --- | --- |
| `latchClunk` | Scrape (band-pass swept 2.6 k→1.3 k) → gap → thunk + broadband impact + inharmonic steel ring. |
| `switchDetent` | 0.6 ms tick at 3.4 kHz + short plastic modal ping + a quieter return-spring click 21 ms later. |
| `relayClick(i)` | Coil thump (62–210 Hz) then contact snap (0.9–5.2 kHz) with 0–3 bounces. Five characters differing in register, brightness, bounce count and decay. |
| `compressorStart` | Contactor click; harmonic stack glides from 42 % to running speed over 1.1 s under a broadband surge; settles into a hum with mains ripple at 2× line, casing rattle, and a permanent 0.063 Hz ±0.4 % pitch drift. |
| `compressorStop` | Contactor click, hum droops and dies over 0.75 s, then refrigerant equalising. |
| `fanRamp` | Looping pink noise → low-pass whose cutoff and level ramp, plus a faint triangle blade tone at `blades × rpm / 60`. |
| `refrigerantFlow` | Band-passed velvet noise with an LFO wandering the centre frequency, plus 3–6 descending resonant gurgles. |
| `frostCrackle` | Poisson ticks at 5–11 kHz, 0.3–9 ms long, very quiet; rate is superlinear in frost coverage. |
| `completionTone` | C5 → G4, sine + quiet triangle octave, soft attack, long decay, low-passed, with a relay click underneath. A machine dropping its contactor, not a reward. |
| `beep(kind)` | `confirm` / `deny` (two falling steps) / `nudge` / `tick`. Square or triangle, low-passed, 2 ms edges, peak ≤ 0.26. |
| `crtWhine(on)` | ~8.4 kHz sine + a quiet 2nd harmonic, gain 0.012, 0.13 Hz wobble. Deliberately an octave below a real 15.7 kHz flyback, which is inaudible to many adults and painful to the rest. |
| `doorOpen` | Gasket peel (band-pass swept 900→260 Hz) → seal thump → latch + insulated-panel ring → air inrush. |
| `vaporRelease` | Valve crack, then a band-pass swept 3 k→700 Hz over 0.42 s, plus a low pressure component. |

### Foley
Sizzle is band-passed velvet noise (steam) plus Poisson bubble grains and a
low-passed brown "scorch" roar. One-shots use the same three `Synth`
primitives: `ignitionWhoosh` is a swell opening upward, `grahamSnap` is a modal
tick plus 5–9 scattered crumbs, `chocolateFracture` is a higher, cleaner, glassy
version with almost no crumble, `squish` sweeps a low band downward, footsteps
are a body thump plus a stochastic grain cluster whose density, brightness, Q and
decay come from `FOOTSTEP_SPECS`.

### Reverb
Each space is data (`ImpulseSpec`) rendered to a stereo IR: pre-delay silence,
a diffuse tail of damped, optionally sparse noise under an exponential envelope,
energy building linearly over the **mixing time** so early reflections are
audible as distinct events, then discrete reflections stamped on top with a
per-channel time jitter for width. IRs are peak-normalised as a pair (preserving
the stereo image), scaled to the preset gain, and cached per space + sample rate
+ seed.

---

## Simulation state → audio parameters

### `FireAudioState` (all 0..1, clamped; NaN/Infinity collapse to the minimum)

| Input | Drives |
| --- | --- |
| `intensity` | Roar gain (`0.52·smoothstep(0.02, 0.65, i)`) and cutoff (150→1700 Hz, log); hiss gain and cutoff (1.6→5.2 kHz); the upper half of rumble via `smoothstep(0.25, 0.8, i)`; crackle rate ×`(0.25+0.75i)` and peak; roar Q 0.6→1.5. |
| `emberHeat` | Ember fizz gain `0.14·e·(1−0.55i)` — loudest when flames are *low* — and centre 1.8→3.6 kHz; crackle brightness and centre frequency. |
| `fuelLoad` | Rumble gain and cutoff (55→145 Hz); hiss volatiles `(0.35+0.65f)`; crackle peak. |
| `windSpeed` | ×1.25 boost on roar gain and hiss; +15 % on roar cutoff; crackle rate ×`(1+0.45w)`; flutter LFO depth (∝ roar gain) and rate 0.22→2.8 Hz; cutoff modulation depth. |
| `crackleRate` | Poisson λ base, 0.4→24 events/s, capped at `MAX_CRACKLE_RATE` (40). |

A dead fire (`intensity = emberHeat = 0`) produces **exactly zero** crackles —
silence is information too.

### `AmbienceConditions`

| Input | Drives |
| --- | --- |
| `windSpeed` | Wind level ×0.35→1.6, band centre ×0.7→1.9, leaf band 2.6→4.8 kHz, gust depth; suppresses insects above 0.45 and birds above 0.55. |
| `temperatureC` | Insects fade in across `minTemperatureC … +7 °C` and are **exactly zero** below it. |
| `playerLoudness` | Insects hush from `loudnessThreshold` over +0.25; birds stop by 0.95. |
| `timeOfDay` (0..1, 0 = midnight) | `nightFactor` — full at night, zero at midday, smooth dusk/dawn ramps. Scales insects ×0.25→1 and birds ×0.35→1. |
| `wetness` | Insects ×`(1 − 0.65·wetness)`. |

### `SizzleState`

| Input | Drives |
| --- | --- |
| `heat` × `moisture` | Hiss gain (needs both) and bubble pop rate (0→16/s). |
| `moisture` | Hiss centre 2.2→6.2 kHz and Q 0.6→2.6 as it dries; caramel crackle needs it *low*. |
| `browning` | Caramel pop rate (0→7/s) and pop centre 1.6→5.2 kHz. |
| `scorch` | Low roar `0.22·scorch^1.5` — only near ignition. |

### Machine
`fanRamp(speed)` → level `0.34·s^1.15`, cutoff 260→5200 Hz (log), blade tone
`s·1450/60·7` Hz, blade level `0.055·s²`.
`frostCrackle(i)` → `0.35 + 13·i^1.6` ticks/s, capped at 18.

---

## Accessibility

* **Every bus is independently adjustable**, with human-readable descriptions in
  `BUS_DESCRIPTIONS` for the settings UI, plus a master fader and a global mute.
  Volumes survive being set before audio exists and are serialisable via
  `snapshot()`/`restore()`.
* **`setReducedAudioIntensity(true)`** tames sudden loud transients rather than
  simply turning things down: peaks are scaled ×0.55, attacks are stretched ×3.5,
  a hard ceiling of 0.4 applies to every one-shot, and the safety limiter drops
  from −6 dB/12:1 to −16 dB/20:1. It is applied inside the `Synth` primitives, so
  no call site can forget it.
* **Nothing depends on hearing.** The engine is a redundant channel: it never
  carries information that is not also available visually, and every mapping is
  a pure function the UI can read (`mapFireState`, `insectActivity`,
  `fanCurve`, `frostTickRate`) to drive an equivalent visual or haptic cue. When
  WebAudio is unavailable, `resume()` returns `false`, every method becomes a
  no-op, and the game is unaffected.

---

## Performance

* **The per-frame path allocates nothing.** `setState`/`setConditions`/
  `setSizzleState` write into pre-built parameter objects and call
  `setTargetAtTime`. There is a regression test asserting that 200 `setFireState`
  calls create zero nodes.
* **Voices are pooled.** `GrainVoicePool` reuses gain/filter/panner chains and
  steals the oldest voice under extreme density. `ObjectPool` provides the same
  for plain objects. WebAudio forces one allocation per one-shot
  (`AudioBufferSourceNode`/`OscillatorNode` are single-use by spec) and those are
  thrown away immediately; no `onended` closures are attached in hot paths.
* **Buffers are shared.** `NoiseBank` builds each looping texture and each grain
  once and hands the same `AudioBuffer` to every layer. `ImpulseCache` memoises
  generated IRs per space + sample rate + seed.
* **Scheduling is look-ahead, not per-frame.** `PoissonScheduler` writes event
  times into a caller-owned `Float64Array` (bounded — surplus events are dropped
  and counted), and `LookaheadWindow` collapses long gaps so a backgrounded tab
  never dumps a backlog on return.
* **Determinism.** All randomness comes from a seeded `mulberry32` stream, so a
  campsite sounds identical on every client and tests can assert exact schedules.

---

## Tests

```
npx vitest run apps/web/test/audio.test.ts
```

Covers the pure maths directly (noise colour ordering by zero-crossing rate,
velvet impulse density, IR length/pre-delay/decay-monotonicity/early-reflection
prominence/stereo decorrelation/damping, Poisson interval mean and budget
behaviour, envelope phases, all four state→parameter mappings including hostile
input, and the mixer state machine), and drives the engine end-to-end against
`FakeAudioContext` for graph construction, bus routing, mute, reduced intensity,
crackle scheduling rates, the latch's two-stage timing, relay distinguishability,
compressor spin-up, fan geometry, spatial placement and determinism.
