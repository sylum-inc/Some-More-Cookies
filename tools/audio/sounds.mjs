/**
 * What gets rendered, and what each one has to be true of.
 *
 * The ranges below are **claims about the sound design**, expressed as
 * measurable properties, not arbitrary numbers pulled tight around whatever
 * the build happens to produce. A latch clunk that stops being low-frequency
 * dominant is no longer a latch clunk; a completion tone that becomes bright
 * and loud is no longer restrained. Those are the regressions worth catching,
 * and they are the only ones asserted here.
 *
 * Each range was set by rendering the sound, reading the measurement, and then
 * choosing bounds that encode the *intent* with real room either side — see
 * `artifacts/audio/report.json` for the measured value next to every bound.
 *
 * A path may name a dotted field of the analysis (`envelope.attackSeconds`) or
 * a sum of band-energy fractions (`bandEnergy.sub+low`).
 */

/** Applied to every sound: the things that are always defects. */
export const UNIVERSAL = Object.freeze({
  clippedSamples: [0, 0],
  /*
   * DC offset wastes headroom, thumps on start and stop, and pushes a speaker
   * cone off centre. 1 % of full scale is the conventional line, and every
   * sound here is well inside it — the largest measured is the fire bed at
   * 0.0064 (0.64 % of full scale, 1.0 % of its own peak), which comes from the
   * brown-noise rumble: `fillBrownNoise` is a leaky integrator with a pole at
   * 0.998, so it high-passes at only ~15 Hz and a four-second loop's mean is
   * not exactly zero. Inaudible, but it is real and it is worth knowing about.
   */
  dcOffset: [-0.01, 0.01],
  dcOffsetRatio: [0, 0.05],
  // Nothing in this game should ever approach full scale on its own; the
  // engine's limiter is a safety net, not a mix stage.
  peak: [0.0005, 0.95],
});

export const SOUNDS = Object.freeze([
  {
    id: 'latch-clunk',
    label: 'SM-01 latch — the heavy two-stage clunk',
    script: 'latch-clunk',
    seconds: 1.6,
    why:
      'The signature sound of the machine: a bright scrape as the handle travels, a ~70 ms gap, then a ' +
      '92→52 Hz thunk and an inharmonic steel-panel ring. It must be dominated by low frequencies — a ' +
      'bright clunk reads as plastic, and the whole point of this sound is mass.',
    expect: {
      'bandEnergy.sub+low': [0.35, 1],
      spectralCentroidHz: [40, 900],
      'envelope.attackSeconds': [0, 0.15],
      'envelope.activeSeconds': [0.08, 1.4],
      rms: [0.002, 0.3],
    },
  },
  {
    id: 'switch-detent',
    label: 'Panel switch detent',
    script: 'switch-detent',
    seconds: 0.6,
    why: 'A tick, a plastic ping and a return-spring click. Tiny, bright, and over almost immediately.',
    expect: {
      spectralCentroidHz: [700, 9000],
      'envelope.activeSeconds': [0.0005, 0.25],
      peak: [0.005, 0.7],
    },
  },
  ...[0, 1, 2, 3, 4].map((index) => ({
    id: `relay-click-${index}`,
    label: `Relay ${index} click`,
    script: 'relay-click',
    arg: index,
    seconds: 0.6,
    why:
      'Five relays the player is expected to tell apart by ear: coil thump then contact snap, differing in ' +
      'register, brightness, bounce count and decay. Each must be a short transient, not a tone.',
    expect: {
      'envelope.attackSeconds': [0, 0.05],
      'envelope.activeSeconds': [0.0005, 0.3],
      spectralFlatness: [0.001, 1],
      peak: [0.005, 0.8],
    },
  })),
  {
    id: 'compressor-start',
    label: 'Compressor start — contactor, spin-up, running hum',
    script: 'compressor-start',
    seconds: 3.5,
    why:
      'An induction motor pulling in: a contactor click, a harmonic stack gliding from 42 % to running ' +
      'speed over 1.1 s, then a sustained hum with mains ripple. It is the sound that tells the player the ' +
      'machine is working, so it has to sustain rather than decay, and it has to be low.',
    expect: {
      'bandEnergy.sub+low': [0.3, 1],
      spectralCentroidHz: [30, 1400],
      // Sustained, not a one-shot: audible for most of the render.
      'envelope.activeSeconds': [1.5, 3.5],
      rms: [0.002, 0.35],
    },
  },
  {
    id: 'compressor-stop',
    label: 'Compressor stop — hum droops and dies, refrigerant equalises',
    script: 'compressor-stop',
    seconds: 4,
    why: 'The counterpart. The hum has to actually stop: the tail must be quieter than the body.',
    expect: {
      'bandEnergy.sub+low': [0.2, 1],
      'envelope.activeSeconds': [0.5, 4],
    },
  },
  {
    id: 'fan-ramp',
    label: 'Condenser fan ramping to full speed',
    script: 'fan-ramp',
    arg: 1,
    seconds: 3,
    why:
      'Low-passed pink noise whose cutoff and level ramp, plus a blade tone at blades × rpm / 60. It has to ' +
      'be broadband (a fan is air, not a note) and it has to *ramp* — quieter at the start than at the end.',
    expect: {
      spectralFlatness: [0.005, 1],
      'envelope.attackSeconds': [0.2, 3],
      'envelope.activeSeconds': [0.5, 3],
      rms: [0.002, 0.35],
    },
  },
  {
    id: 'refrigerant-flow',
    label: 'Refrigerant through the capillary',
    script: 'refrigerant-flow',
    seconds: 3,
    why: 'Band-passed velvet noise wandering in centre frequency, with descending resonant gurgles.',
    expect: {
      'envelope.activeSeconds': [0.3, 3],
      spectralFlatness: [0.002, 1],
    },
  },
  {
    id: 'frost-crackle',
    label: 'Frost crackle at high coverage',
    script: 'frost-crackle',
    arg: 0.85,
    seconds: 3,
    why:
      'Poisson ticks at 5–11 kHz, fractions of a millisecond long, very quiet. Ice is a tiny, high sound; ' +
      'this is the sound that must sit at the opposite end of the spectrum from the latch. If it ever ' +
      'becomes low-frequency dominant, something has gone badly wrong.',
    expect: {
      spectralCentroidHz: [3000, 20000],
      'bandEnergy.high+air': [0.5, 1],
      'bandEnergy.sub+low': [0, 0.15],
      // Quiet by design.
      peak: [0.0005, 0.35],
      rms: [0.00002, 0.05],
    },
  },
  {
    id: 'completion-tone',
    label: 'Completion tone — C5 → G4 with a relay underneath',
    script: 'completion-tone',
    seconds: 3,
    why:
      'The most easily ruined sound in the product. The brief is "a machine finishing a cycle and dropping ' +
      'its contactor, not a reward". Measurably: it must be a *tone* (low spectral flatness, not noise), ' +
      'centred low (it is low-passed at 2 kHz and its partials are 392–523 Hz), quieter than the latch, and ' +
      'it must have a soft attack and a long decay rather than a bright jingle\'s fast attack and short tail.',
    expect: {
      spectralCentroidHz: [150, 1400],
      spectralFlatness: [0, 0.15],
      'bandEnergy.high+air': [0, 0.1],
      // Soft attack: nothing snaps on. The relay click underneath is what
      // stops this from being zero.
      'envelope.attackSeconds': [0.005, 0.6],
      // Long decay relative to the attack — a tone that rings out.
      'envelope.decaySeconds': [0.15, 2.5],
      // Restrained: the design caps the fundamental at 0.2 and the octave at
      // 0.05, so anything near full scale means the shaping broke.
      peak: [0.01, 0.5],
    },
  },
  {
    id: 'beep-confirm',
    label: 'Panel beep — confirm',
    script: 'beep-confirm',
    seconds: 0.6,
    why: 'A 1997 panel beeper: flat, short, low-passed, peak capped at 0.26.',
    expect: {
      peak: [0.01, 0.4],
      'envelope.activeSeconds': [0.01, 0.3],
      spectralFlatness: [0, 0.35],
    },
  },
  {
    id: 'beep-deny',
    label: 'Panel beep — deny (two falling steps)',
    script: 'beep-deny',
    seconds: 0.8,
    why: 'Two low beeps, falling. Reads as "no" without being punitive, so it must stay quiet and dull.',
    expect: {
      peak: [0.01, 0.4],
      spectralCentroidHz: [100, 2500],
    },
  },
  {
    id: 'door-open',
    label: 'Insulated door opening — gasket peel, seal thump, air inrush',
    script: 'door-open',
    seconds: 2.5,
    why: 'The reveal begins with this. Heavy, low, and long enough to feel like a door rather than a click.',
    expect: {
      'bandEnergy.sub+low': [0.15, 1],
      'envelope.activeSeconds': [0.1, 2.5],
    },
  },
  {
    id: 'vapor-release',
    label: 'Vapour release',
    script: 'vapor-release',
    seconds: 2,
    why: 'A valve cracking, then a band-pass swept 3 k→700 Hz. Broadband, not tonal.',
    expect: {
      spectralFlatness: [0.002, 1],
      'envelope.activeSeconds': [0.05, 2],
    },
  },
  {
    id: 'fire-bed',
    label: 'Fire bed — flaming, fuelled, light wind',
    script: 'fire-bed',
    seconds: 4,
    why:
      'The continuous bed under most of the product: pink-noise roar, white-noise hiss, brown-noise rumble, ' +
      'velvet ember fizz and Poisson crackles. It must be broadband, continuous (active for essentially the ' +
      'whole render), and dominated by the low end — a fire that is mostly hiss sounds like rain.',
    expect: {
      spectralFlatness: [0.001, 1],
      'bandEnergy.sub+low': [0.2, 1],
      'envelope.activeSeconds': [3, 4],
      rms: [0.002, 0.4],
    },
  },
  {
    id: 'fire-embers',
    label: 'Fire bed — burned down to coals',
    script: 'fire-embers',
    seconds: 4,
    why:
      'The roasting surface. Ember fizz is designed to be loudest when flames are *low*, so this state must ' +
      'still make sound, and must be brighter than the flaming bed (the fizz sits at 1.8–3.6 kHz while the ' +
      'roar and rumble have gone).',
    expect: {
      'envelope.activeSeconds': [2, 4],
      rms: [0.00005, 0.3],
    },
  },
  {
    id: 'fire-dead',
    label: 'Fire bed — dead',
    script: 'fire-dead',
    seconds: 3,
    why:
      'A dead fire has to produce exactly nothing. The README states it as a design rule ("silence is ' +
      'information too") and the state→parameter mapping is written to guarantee it; this is the check that ' +
      'the guarantee survives all the way to the samples.',
    expect: {
      peak: [0, 0.002],
      rms: [0, 0.0005],
    },
    // The universal peak floor asserts a sound is audible; this one must not be.
    skipUniversal: ['peak'],
  },
  {
    id: 'sizzle',
    label: 'Marshmallow sizzle — hot and wet',
    script: 'sizzle',
    seconds: 3,
    why: 'Band-passed velvet steam plus bubble grains. Continuous, broadband, and not loud.',
    expect: {
      'envelope.activeSeconds': [1.5, 3],
      spectralFlatness: [0.001, 1],
      peak: [0.0005, 0.6],
    },
  },
  {
    id: 'graham-snap',
    label: 'Graham cracker snapping',
    script: 'graham-snap',
    seconds: 1,
    why: 'A modal tick plus scattered crumbs. Short, transient, with crumbs arriving after the break.',
    expect: {
      'envelope.attackSeconds': [0, 0.08],
      'envelope.activeSeconds': [0.001, 0.8],
    },
  },
  {
    id: 'chocolate-fracture',
    label: 'Chocolate fracturing',
    script: 'chocolate-fracture',
    seconds: 1,
    why: 'A higher, cleaner, glassier version of the snap with almost no crumble — so it must be brighter.',
    expect: {
      'envelope.attackSeconds': [0, 0.08],
      spectralCentroidHz: [300, 14000],
    },
  },
  {
    id: 'ignition-whoosh',
    label: 'Marshmallow catching fire',
    script: 'ignition-whoosh',
    seconds: 2,
    why: 'A swell opening upward. Broadband, with a slower attack than any of the impacts.',
    expect: {
      spectralFlatness: [0.002, 1],
      'envelope.activeSeconds': [0.05, 2],
    },
  },
  {
    id: 'impulse-clearing',
    label: 'Reverb impulse response — clearing',
    script: 'impulse-clearing',
    seconds: 3,
    why:
      'Not a game sound but the thing every other sound is convolved with. Measured here because a broken ' +
      'IR ruins everything downstream: it must decay (not sustain), and it must be decorrelated between ' +
      'channels or the reverb collapses to mono.',
    expect: {
      'envelope.activeSeconds': [0.05, 3],
      stereoCorrelation: [-0.6, 0.8],
    },
  },
]);

/**
 * Relationships between sounds.
 *
 * These are the assertions that actually pin the *design* down. An absolute
 * spectral centroid can drift with a filter tweak; "the latch is lower than the
 * frost crackle" cannot drift without the sound design having changed.
 */
/** Fraction of energy below 300 Hz. */
const low = (metrics) => metrics.bandEnergy.sub + metrics.bandEnergy.low;

export const RELATIONS = Object.freeze([
  {
    id: 'latch-below-frost',
    claim: 'The latch clunk is lower-pitched than the frost crackle',
    why:
      'The two ends of the SM-01\'s vocabulary. Mass at the bottom, ice at the top. If these ever converge, ' +
      'the machine stops reading as a machine.',
    check: (m) => m['latch-clunk'].spectralCentroidHz * 3 < m['frost-crackle'].spectralCentroidHz,
    describe: (m) =>
      `latch ${m['latch-clunk'].spectralCentroidHz} Hz vs frost ${m['frost-crackle'].spectralCentroidHz} Hz ` +
      `(ratio ${(m['frost-crackle'].spectralCentroidHz / m['latch-clunk'].spectralCentroidHz).toFixed(1)}x, needs > 3x)`,
  },
  {
    id: 'completion-restrained',
    claim: 'The completion tone is quieter than the latch it follows',
    why:
      'The reward moment must not be the loudest thing in the sequence. A completion sound louder than the ' +
      'machinery is the exact "bright jingle" failure the design brief rules out.',
    check: (m) => m['completion-tone'].peak <= m['latch-clunk'].peak,
    describe: (m) => `completion peak ${m['completion-tone'].peak} vs latch peak ${m['latch-clunk'].peak}`,
  },
  {
    id: 'completion-is-tonal',
    claim: 'The completion tone is more tonal than any machine noise',
    why: 'It is the only pitched sound in the kit. If its flatness approaches the fan\'s, it has become noise.',
    check: (m) => m['completion-tone'].spectralFlatness < m['fan-ramp'].spectralFlatness,
    describe: (m) =>
      `completion flatness ${m['completion-tone'].spectralFlatness} vs fan ${m['fan-ramp'].spectralFlatness}`,
  },
  {
    id: 'embers-brighter-than-flames',
    claim: 'A burned-down bed has lost the low end a flaming one is built on',
    why:
      'Ember fizz is designed to be loudest when the flames are low, and the roar and rumble that dominate ' +
      'a flaming fire are gone. This is what makes "the fire has burned down" audible without being told. ' +
      'Measured on band energy rather than spectral centroid on purpose: both states are broadband noise, ' +
      'so their centroids sit within 0.2 % of each other (9872 Hz vs 9884 Hz) and comparing them would be a ' +
      'coin toss dressed up as a test. Where the *energy* sits is not close at all.',
    check: (m) => low(m['fire-bed']) > 0.3 && low(m['fire-embers']) < low(m['fire-bed']) / 3,
    describe: (m) =>
      `flames ${(low(m['fire-bed']) * 100).toFixed(0)}% of energy below 300 Hz vs embers ` +
      `${(low(m['fire-embers']) * 100).toFixed(0)}% (needs flames > 30% and embers < a third of that)`,
  },
  {
    id: 'chocolate-brighter-than-graham',
    claim: 'Chocolate fractures brighter than a graham cracker snaps',
    why: 'Glassy versus crumbly. The design says so; this is whether the samples agree.',
    check: (m) => m['chocolate-fracture'].spectralCentroidHz > m['graham-snap'].spectralCentroidHz,
    describe: (m) =>
      `chocolate ${m['chocolate-fracture'].spectralCentroidHz} Hz vs graham ${m['graham-snap'].spectralCentroidHz} Hz`,
  },
  {
    id: 'relays-distinguishable',
    claim: 'The five relays are distinguishable by ear-relevant measurements',
    why:
      'The player is expected to learn which relay just fired. That only works if they differ in more than ' +
      'random noise: this requires the brightest and dullest to differ by at least 40 %.',
    check: (m) => {
      const centroids = [0, 1, 2, 3, 4].map((i) => m[`relay-click-${i}`].spectralCentroidHz);
      return Math.max(...centroids) > Math.min(...centroids) * 1.4;
    },
    describe: (m) => {
      const centroids = [0, 1, 2, 3, 4].map((i) => m[`relay-click-${i}`].spectralCentroidHz);
      return `centroids ${centroids.map((c) => Math.round(c)).join(', ')} Hz`;
    },
  },
  {
    id: 'dead-fire-is-silent',
    claim: 'A dead fire renders true silence',
    why: 'Not "quiet" — nothing. Asserted on the samples, not on the parameter mapping.',
    check: (m) => m['fire-dead'].peak < 0.002,
    describe: (m) => `dead-fire peak ${m['fire-dead'].peak} (${m['fire-dead'].peakDbfs} dBFS)`,
  },
]);
