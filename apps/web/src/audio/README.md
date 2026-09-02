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
Barrel. Everything below is re-exported from here except `testing.ts` and
`offline.ts`, which are deliberately excluded so the headless harness never
reaches the bundle.

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
| `fire`, `ambience`, `machine`, `foley`, `radio`, `wildlife`, `reverb` | The layers (null before `resume()`). |
| `setFireState`, `setAmbienceConditions`, `setSizzleState` | Hot-path passthroughs. |
| `startBeds()`, `stopBeds()` | Start/stop the continuous fire + ambience beds. |
| `setAmbienceProfile(profile)`, `setSpace(space, wet?)` | Campsite change. |
| `listenerUpdate(pos, forward, up)` | Listener transform. |
| `setFirePosition`, `setMachinePosition`, `setRadioPosition` | Move the built-in emitters. |
| `createEmitter(bus, opts?)`, `releaseEmitter`, `emitterCount` | Ad-hoc positioned sources. |
| `busInput(bus)` | The bus `GainNode`, for custom routing. |
| `pump(now?)` | Drives stochastic scheduling. Automatic on a timer unless `pumpIntervalMs: 0`. |

Options: `contextFactory`, `sampleRate`, `seed` (number or string), `spatialQuality`,
`spatialiseLayers`, `ambienceProfile`, `reverb`, `mixer`, `noiseBank`, `fire`,
`ambience`, `machine`, `foley`, `radio`, `wildlife`, `pumpIntervalMs`.

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

### `radio.ts` — `RadioKit`
Pure data and maths: `RadioBandKind`, `RadioSegmentKind`, `RadioAudioState` /
`DEFAULT_RADIO_STATE`, `RadioProgramme`, `BandCharacter` / `BAND_CHARACTERS` /
`bandCharacter(band)`, `RadioVoiceParams` / `createRadioVoiceParams()` /
`mapRadioState(state, out)` (pure, allocation-free), and the level ceilings
`RADIO_HISS_PEAK`, `RADIO_PROGRAMME_PEAK`, `RADIO_WHISTLE_PEAK`.

`RadioKit`: `setPower(on)`, `bandChange()`, `setReception(partial)`,
`playSegment('primary' | 'bleed', programme | null)`, `segmentOf(slot)`, plus
`pump`, `powered`, `state`, `params`, `programmeEvents`, `dispose`.

Routed to the **`ambience`** bus, through its own `SpatialEmitter` — the radio
is an object sitting on the log, so it is placed like one. It does not get a bus
of its own: it already has a diegetic volume knob (`RadioState.volume`), and one
more fader in the settings screen would be a knob to explain rather than a knob
anyone wants.

### `wildlife.ts` — `WildlifeKit`
Pure: `WildlifeAudioPhase`, `WildlifeAnimalAudio`, `WildlifeArchetype` /
`WILDLIFE_ARCHETYPES`, `WildlifeVoiceSpec`, `speciesVoice(id, shyness,
curiosity)`, `individualVoice(spec, individualId)`, `MAX_CALL_SECONDS`,
`PHASE_MOVEMENT_RATE` / `movementRate`, `PHASE_CALL_RATE` / `callRate`,
`WILDLIFE_AUDIBLE_METRES`, `distanceCutoffHz`.

`WildlifeKit`: `setAnimals(list)`, `setWatched(on, x, y, z)`, `call(animal)`,
`rustle(x, y, z, distanceM, effort)`, `twigSnap(...)`, `startle(animal)`,
`tookObject(...)`, `voiceFor(...)`, plus `start`, `pump`, `watched`, `tracked`,
`callsScheduled`, `dispose`. Also on the **`ambience`** bus; it owns a pool of
`SpatialEmitter`s because every animal is somewhere different.

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

### `testing.ts` / `offline.ts` (not exported from `index.ts`)
`FakeAudioContext` and friends: a headless WebAudio stand-in that records every
`AudioParam` automation event and every source start/stop, so scheduling can be
asserted exactly. `createFakeAudioContext()`.

`offline.ts` is the other half: `renderOffline(ctx, seconds)` evaluates that
recorded graph into real stereo PCM, so a test can assert on *sound* rather than
on call counts — level, pitch, stereo placement, spectral balance, envelope
shape, sample-exact determinism. It models param automation (including
`setTargetAtTime` starting from wherever the param genuinely is, and signals
connected into a param), RBJ biquads, oscillators, buffer sources with looping
and playback rate, both panners, delay and the compressor. It does **not** model
convolution — the reverb return renders as silence, so anything measured through
it is the dry mix — and it renders HRTF as equal-power panning. Those caveats are
listed at the top of the file and repeated wherever a test relies on them.
Measurement helpers: `renderPeak`, `renderRms`, `renderChannelRms`,
`largestDiscontinuity`, `largestEnvelopeStep`, `dominantFrequency`,
`spectrumOf`, `bandFraction`, `pannerGains`.

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

### The radio
A receiver, not a radio sound effect. Five things arrive at the speaker and mix
the way they mix in a real set.

| Layer | Method |
| --- | --- |
| Hiss | Looping white noise through a high-pass and a low-pass whose cutoff *and* level both track the noise floor. A station arriving narrows the static as well as quieting it, which is most of what "coming in" sounds like. |
| Carrier whistle | The heterodyne between the incoming carrier and the local oscillator: a sine (plus a little second harmonic) whose frequency is proportional to how far off-centre the dial is, gliding rather than stepping. |
| Programme | A `ProgrammeVoice` per slot — the tuned station and the one bleeding under it — built once and crossfaded between sub-layers, never rebuilt. |
| Bleed | A second `ProgrammeVoice`, quieter, with fewer pad voices, no consonants and a much lower cutoff: it has been through the skirt of the filter twice. |
| Mains hum | 2× line ripple with the line fundamental and its harmonics under it, low-passed — and placed **after** the volume control, as it is in a real set, so turning the radio down does not turn the hum down. |

**Zero beat is the whole cue.** The beat note is `|Δf|`, so the frequency
mapping is a V: it falls to nothing exactly on the station and rises on either
side. Its level is `carrier × beat`, where `carrier = exp(−x²·0.3)` (how much of
a carrier is arriving) and `beat = 1 − exp(−x²·14)` (a zero-frequency beat is
silence by definition). The level therefore peaks a little off-station and dies
as you land on it — turn the knob, and if the whistle descends you are getting
closer. This is why you rock an analogue dial back and forth to find the bottom.

Programme material is synthesised from `ProgrammeSegment.seed`, which the
simulation hands over expressly so the same broadcast is the same broadcast on
every device at that campsite. Nothing in a segment draws from the shared engine
RNG.

| Segment | Approach |
| --- | --- |
| `music-bed` | A seeded key, scale and four-chord progression. Sustained pad voices *glide* between chord tones (they are never restarted), through a low-pass at 1.3–2.9 kHz with a 0.63 Hz tape-wow LFO on their detune. A single held lead note every 6–22 s, rarer on a calmer bed. `intensity` sets chord length, brightness and how often the lead speaks. Built to be left on for twenty minutes. |
| `ident` | A three-to-five note sting plus a low chord and a tape swell, seeded from the **station**, not the airing — so it is the same jingle every time you find that station. |
| `spoken` | Formant synthesis: a glottal sawtooth through three band-passes gliding between real vowel targets at a syllable rate, with fricative bursts in front of some syllables and phrase-length pauses. It cannot form a word because there is nothing encoded — which is exactly right for a broadcast from too far away to make out. |
| `code` | Slow seeded tones in groups. Atmosphere only: the pitches carry nothing and nothing anywhere requires having heard one (spec §8). |
| `interference` | Band-passed noise with an LFO wandering the centre frequency, plus occasional bursts of something else beating against the carrier. |
| `silence` / `carrier` | Dead air and an unmodulated carrier: both nearly silent, both quieter than programme, and *different from each other* — a transmitter that is on but saying nothing is not the same sound as one that is off. |

Power and band changes are ramps, never switches, and the receiver's graph stays
alive across a power cycle (a stopped `OscillatorNode` can never be restarted,
and rebuilding the chain on every throw of the switch is one more chance to
click). Every continuous move in the file is a `setTargetAtTime`, which starts
from wherever the parameter genuinely is; reading `param.value` and ramping from
it is the classic way to introduce the click you were trying to avoid.

### Wildlife
Spatial first: the point of the system is an animal you can hear behind you and
cannot see. Everything goes through a `SpatialEmitter`.

There is **no per-species audio data in the content package** and none was added.
A species has an id, a `shyness` and a `curiosity`, and that is enough:

* **The id seeds the voice.** `speciesVoice` is pure, so a species sounds like
  itself everywhere, and a new species in a manifest gets a voice without anyone
  authoring one. Four archetypes — `whistle` (two-operator FM with a glide),
  `chitter` (fast AM buzz), `huff` (low and breathy), `trill` (a buzzy roll).
* **Shyness sets register and carry**: 420 Hz at `shyness 0` up to 2.5 kHz at
  `shyness 1`, quieter and with less breath behind it as it rises. Shyness is
  also rarity in this model, so the rarest thing at a campsite is also the
  thinnest sound in it.
* **Curiosity sets expression**: FM index, repeat count and interval width.
* **The individual id detunes it** by under a semitone with a few per cent on the
  length — enough to recognise the fox, never enough to read as another animal.

Movement foley is leaf litter: a soft body thump plus a stochastic grain cluster,
scheduled by a Poisson process whose rate comes from each animal's phase and
shyness, with a twig snap 7 % of the time (22 % for something fleeing). Distance
takes the top off (`distanceCutoffHz`) and the panner does the level, so the two
never fight. `startle` is a scramble plus optional wingbeats; `tookObject` is a
small knock and a drag.

**Being watched** is a low, quiet, slowly-rising presence at the watcher's
bearing: brown noise low-passed at 220 Hz, peak 0.014, four seconds of fade in
and out, no pitch and no transient, plus one small shift in the leaves every
twenty seconds or so. It is designed to be missed. Spec §2.1 forbids generic
horror and §2.2 forbids anything threatening, so this is deliberately *not* a
stinger, and the tests assert the level, the absence of any step, and that
nothing in it is bright.

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

### `RadioAudioState`

| Input | Drives |
| --- | --- |
| `hiss` | Hiss gain `0.22 · bandLevel · hiss^1.15`, low-pass cutoff (28 %→100 % of the band's ceiling) and high-pass together — level *and* bandwidth. |
| `detune` / `halfWidth` | `x = |detune| / halfWidth`. Whistle frequency `x · whistleSpan` (900 Hz per half-width on FM, 1250 on AM, 1500 on shortwave), capped at 4.6 kHz; whistle gain `0.085 · exp(−x²·0.3) · (1 − exp(−x²·14))`. |
| `clarity` | Programme gain `0.34 · clarity^0.75`, and opens the receiver's audio stage from 42 % to 100 % of the band's cutoff. |
| `bleed` | Bleed gain `0.34 · 0.42 · bleed^1.3 · (1 − 0.45·clarity)` and its cutoff, 700→1900 Hz. |
| `hum` | `0.055 · bandHumLevel · hum^1.1`, applied after the volume control. |
| `volume` | The diegetic knob. Scales hiss, whistle and both programme voices; never the hum. |
| `band` | `BAND_CHARACTERS`: audio bandwidth, hiss colour and level, whistle span, hum level. |

### `WildlifeAnimalAudio`

| Input | Drives |
| --- | --- |
| `speciesId` | Seeds the whole voice — archetype, glide, FM ratio, repeats, filter. |
| `shyness` | Base frequency 420→2500 Hz, peak 0.4→0.15, breath 0.55→0.06, filter Q 0.8→2.4, and ×1→×0.45 on how often it disturbs the undergrowth. |
| `curiosity` | FM index, repeat count, gap between repeats, interval width, and call rate ×0.55→×1.5. |
| `id` (individual) | ±a semitone, ±9 % duration, ±12 % peak. |
| `phase` | Rustle rate (`PHASE_MOVEMENT_RATE`: 3.2/s fleeing → 0.12/s watching → 0 absent) and call rate (`PHASE_CALL_RATE`). A watching animal is nearly silent, because stillness is the mechanic. |
| `distanceM` | Air and undergrowth take the top off (`distanceCutoffHz`); beyond 26 m there is nothing to hear over the fire. Level is the panner's job. |
| `alarm` | Shortens the call ×0.72, lifts it ×1.18 and adds a repeat above 0.6. |
| `interest` | Call rate ×0.7→×1.35. |

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
  `fanCurve`, `frostTickRate`, `mapRadioState`, `speciesVoice`, `movementRate`)
  to drive an equivalent visual or haptic cue. The two layers that carry the
  most information — the dial and the animals — also produce **subtitle lines**:
  `AudioBridge.update` returns an `AudioCue` whenever a station identifies
  itself, a segment changes, or something appears out of the dark. The copy is
  `describeReception` and `describeSighting` from the simulation, never a
  parallel vocabulary invented in the audio layer, and the caller decides
  whether the player has subtitles switched on. When
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
npx vitest run apps/web/test/audio.test.ts        # pure maths + scheduling
npx vitest run apps/web/test/audio-offline.test.ts   # the renderer's own proof
npx vitest run apps/web/test/audio-radio.test.ts
npx vitest run apps/web/test/audio-wildlife.test.ts
npx vitest run apps/web/test/audio-world.test.ts     # the bridge, and the whole mix
```

`audio.test.ts` covers the pure maths and the scheduling through
`FakeAudioContext`. The four newer files assert on **rendered samples** instead,
via `offline.ts`: the whistle's pitch really tracks the dial and really falls to
nothing on the station, hiss really dominates between stations, the same segment
seed really renders bit-identical samples twice, a call really lands on the
correct side of the stereo field, nothing steps at power on/off or a band change,
and the whole mix really stays inside the headroom.
`audio-offline.test.ts` exists because a confident number from a broken
instrument is worse than no number: it drives the renderer with sines, ramps,
filters and noise whose answers are known in closed form, and proves that the
envelope-step measure can tell a cut from a fade where a sample-delta measure
provably cannot.

Covers the pure maths directly (noise colour ordering by zero-crossing rate,
velvet impulse density, IR length/pre-delay/decay-monotonicity/early-reflection
prominence/stereo decorrelation/damping, Poisson interval mean and budget
behaviour, envelope phases, all four state→parameter mappings including hostile
input, and the mixer state machine), and drives the engine end-to-end against
`FakeAudioContext` for graph construction, bus routing, mute, reduced intensity,
crackle scheduling rates, the latch's two-stage timing, relay distinguishability,
compressor spin-up, fan geometry, spatial placement and determinism.
