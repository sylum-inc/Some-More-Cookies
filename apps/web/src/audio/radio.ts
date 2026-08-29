/**
 * The camp radio.
 *
 * The design brief: this is a *receiver*, not a radio sound effect. Everything
 * a player does with the dial has to be answerable by ear, because tuning is
 * the interaction (spec §8) and a dial you can only read is not tactile.
 *
 * Five things arrive at the speaker, mixed the way they mix in a real set:
 *
 *  - **Hiss.** Filtered white noise. Between stations it is the whole sound,
 *    and its bandwidth as well as its level tracks the receiver's noise floor —
 *    a wide-open squelch is bright, a station quieting it makes it narrow and
 *    dull, which is most of what "coming in" sounds like.
 *  - **The carrier whistle.** A heterodyne: the beat between the incoming
 *    carrier and the local oscillator, so its pitch is proportional to how far
 *    off-centre the dial is and it falls to *zero beat* exactly on the station.
 *    This is the single most useful cue on the dial. Turn the knob; if the
 *    whistle descends you are approaching, if it climbs you have gone past.
 *    Physically the beat note is |Δf|, so the mapping is a V — which is exactly
 *    how tuning an analogue receiver by ear actually works, and why you rock
 *    the dial back and forth to find the bottom of it.
 *  - **Programme material**, synthesised from the segment seed the simulation
 *    hands over, so the same broadcast is the same broadcast on every device at
 *    that campsite.
 *  - **Bleed.** A second, quieter, duller station underneath, when a strong
 *    neighbour is muscling in.
 *  - **Mains hum.** A rectifier's 2× line ripple with a little of the line
 *    fundamental and third harmonic under it. It sits *after* the volume
 *    control, as it does in a real set, so turning the radio down does not turn
 *    the hum down — which is why hum is the thing you notice at low volume.
 *
 * Signal path:
 *
 *   hiss ┐
 *   whistle ├─▶ signal ─▶ volume ─▶ post ─▶ power ─▶ dip ─▶ out
 *   programme ┤                      ▲
 *   bleed ┘                        hum
 *
 * `power` and `dip` exist so that switching off, and changing band, are ramps
 * rather than switches. Every continuous move in this file is a
 * `setTargetAtTime`, which starts from wherever the parameter genuinely is;
 * reading `param.value` and ramping from it is the classic way to introduce the
 * click you were trying to avoid.
 *
 * The receiver's graph is built once and stays alive across a power cycle. A
 * stopped `OscillatorNode` can never be restarted, so switching off would mean
 * rebuilding the whole chain — wasteful, and one more chance to click.
 */

import { clamp, clamp01, lerp, mapExp, midiToHz } from './math.js';
import { safeFrequency } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import type { Rng } from './rng.js';
import { createRng } from './rng.js';
import { Synth } from './synth.js';
import { LookaheadWindow } from './voices.js';

/* -------------------------------------------------------------------------- */
/* Simulation-shaped input                                                     */
/* -------------------------------------------------------------------------- */

/**
 * The bands a receiver covers.
 *
 * Structurally identical to `RadioBand` in `@somemore/sim`; restated so the
 * audio engine keeps knowing nothing about the simulation (ADR-0001). The
 * bridge is the one place the two meet.
 */
export type RadioBandKind = 'fm' | 'am' | 'shortwave';

/** Structurally identical to `SegmentKind` in `@somemore/sim`. */
export type RadioSegmentKind =
  | 'music-bed'
  | 'ident'
  | 'spoken'
  | 'silence'
  | 'interference'
  | 'code'
  | 'carrier';

/** What the receiver is being handed every frame. All 0..1 unless noted. */
export interface RadioAudioState {
  /** How cleanly the tuned station is coming through. */
  clarity: number;
  /** The noise floor between stations. */
  hiss: number;
  /** How much a neighbouring station is muscling in. */
  bleed: number;
  /** Mains and machinery hum riding on the signal. */
  hum: number;
  /** Signed dial-units from the station's centre. Drives the whistle. */
  detune: number;
  /** The receiver's selectivity, in the same units as `detune`. */
  halfWidth: number;
  /** The diegetic volume knob. */
  volume: number;
  band: RadioBandKind;
}

export const DEFAULT_RADIO_STATE: Readonly<RadioAudioState> = Object.freeze({
  clarity: 0,
  hiss: 1,
  bleed: 0,
  hum: 0,
  detune: 0,
  halfWidth: 1,
  volume: 0.6,
  band: 'fm',
});

/** One block of a station's output, as the simulation describes it. */
export interface RadioProgramme {
  kind: RadioSegmentKind;
  /**
   * Per-airing seed. The simulation hands this over expressly so the audio
   * engine can synthesise the same material at the same campsite everywhere.
   */
  seed: number;
  /** Per-station seed: what makes one station's ident recognisably its own. */
  stationSeed: number;
  /** 0..1 how energetic this block is. */
  intensity: number;
  durationSeconds: number;
}

/* -------------------------------------------------------------------------- */
/* Band character (pure data)                                                  */
/* -------------------------------------------------------------------------- */

export interface BandCharacter {
  /** Top of the receiver's audio passband, in Hz. */
  audioCutoffHz: number;
  /** Bottom of it. AM sets are famously gutless below 200 Hz. */
  audioBassHz: number;
  /** Centre of the hiss when the squelch is wide open. */
  hissCutoffHz: number;
  /** Hiss level multiplier: shortwave is the noisiest place on the dial. */
  hissLevel: number;
  /** Hz of beat note per half-width of mistuning. */
  whistleSpanHz: number;
  /** How much hum the band's detector passes through. */
  humLevel: number;
}

/**
 * What each band sounds like.
 *
 * FM is wide and bright and either works or does not; AM is narrow, warm and
 * hummy; shortwave is narrower still, noisy, and whistles at the slightest
 * provocation because the dial covers megahertz.
 */
export const BAND_CHARACTERS: Readonly<Record<RadioBandKind, BandCharacter>> = Object.freeze({
  fm: { audioCutoffHz: 9000, audioBassHz: 110, hissCutoffHz: 7200, hissLevel: 1, whistleSpanHz: 900, humLevel: 0.5 },
  am: { audioCutoffHz: 3800, audioBassHz: 220, hissCutoffHz: 3000, hissLevel: 0.86, whistleSpanHz: 1250, humLevel: 1 },
  shortwave: {
    audioCutoffHz: 2900,
    audioBassHz: 260,
    hissCutoffHz: 2600,
    hissLevel: 1.1,
    whistleSpanHz: 1500,
    humLevel: 0.8,
  },
});

export function bandCharacter(band: RadioBandKind): BandCharacter {
  return BAND_CHARACTERS[band] ?? BAND_CHARACTERS.fm;
}

/* -------------------------------------------------------------------------- */
/* State -> parameters (pure)                                                  */
/* -------------------------------------------------------------------------- */

export interface RadioVoiceParams {
  hissGain: number;
  hissCutoffHz: number;
  hissBassHz: number;
  /** Beat note, in Hz. Zero exactly on the station. */
  whistleHz: number;
  whistleGain: number;
  programmeGain: number;
  bleedGain: number;
  /** How much of the top the bleeding station loses. */
  bleedCutoffHz: number;
  humGain: number;
  audioCutoffHz: number;
}

export function createRadioVoiceParams(): RadioVoiceParams {
  return {
    hissGain: 0,
    hissCutoffHz: 6000,
    hissBassHz: 300,
    whistleHz: 0,
    whistleGain: 0,
    programmeGain: 0,
    bleedGain: 0,
    bleedCutoffHz: 1400,
    humGain: 0,
    audioCutoffHz: 6000,
  };
}

/** Peak level any one part of the receiver is allowed to reach. */
export const RADIO_HISS_PEAK = 0.22;
export const RADIO_PROGRAMME_PEAK = 0.34;
export const RADIO_WHISTLE_PEAK = 0.085;

/**
 * Pure mapping from reception to synthesis parameters.
 *
 * Written as a pure function for the same reason `mapFireState` is: the UI can
 * read it to drive a visible signal-strength needle without the audio engine
 * existing, which is what keeps the dial usable with the sound off (spec §12).
 *
 * The whistle is the part worth reading twice. `carrier` is how much of a
 * carrier is arriving at all, so the whistle fades out as you leave a station
 * behind. `beat` is zero at perfect tune, because a zero-frequency beat is
 * silence by definition — that silence *is* the "you are on it" signal, and it
 * is why the level peaks a little off-station and dies as you land.
 */
export function mapRadioState(state: RadioAudioState, out: RadioVoiceParams): RadioVoiceParams {
  const character = bandCharacter(state.band);
  const clarity = clamp01(state.clarity);
  const hiss = clamp01(state.hiss);
  const bleed = clamp01(state.bleed);
  const hum = clamp01(state.hum);
  const halfWidth = Math.max(Math.abs(state.halfWidth), 1e-6);
  const offset = Number.isFinite(state.detune) ? Math.abs(state.detune) / halfWidth : 0;

  // Hiss: level and bandwidth together. A station arriving narrows the noise as
  // well as quieting it, which is what "the static closes up" sounds like.
  out.hissGain = RADIO_HISS_PEAK * character.hissLevel * Math.pow(hiss, 1.15);
  out.hissCutoffHz = safeFrequency(mapExp(0.25 + 0.75 * hiss, character.hissCutoffHz * 0.28, character.hissCutoffHz));
  out.hissBassHz = safeFrequency(character.audioBassHz * lerp(1.7, 0.9, hiss));

  // Heterodyne.
  const carrier = Math.exp(-offset * offset * 0.3);
  const beat = 1 - Math.exp(-offset * offset * 14);
  out.whistleHz = clamp(offset * character.whistleSpanHz, 0, 4600);
  out.whistleGain = RADIO_WHISTLE_PEAK * carrier * beat;

  out.programmeGain = RADIO_PROGRAMME_PEAK * Math.pow(clarity, 0.75);
  // A bleeding station is never as clear as the one you are tuned to, and it
  // has been through the same skirt of the filter twice.
  out.bleedGain = RADIO_PROGRAMME_PEAK * 0.42 * Math.pow(bleed, 1.3) * (1 - clarity * 0.45);
  out.bleedCutoffHz = safeFrequency(mapExp(bleed, 700, 1900));

  out.humGain = 0.055 * character.humLevel * Math.pow(hum, 1.1);
  // A strong signal opens the audio stage up; a weak one is all midrange.
  out.audioCutoffHz = safeFrequency(
    mapExp(0.35 + 0.65 * clarity, character.audioCutoffHz * 0.42, character.audioCutoffHz),
  );
  return out;
}

/* -------------------------------------------------------------------------- */
/* Programme synthesis data                                                    */
/* -------------------------------------------------------------------------- */

/** Scale shapes, in semitones. Minor and dorian carry most of the night. */
const SCALES: readonly (readonly number[])[] = Object.freeze([
  [0, 2, 3, 5, 7, 8, 10], // natural minor
  [0, 2, 3, 5, 7, 9, 10], // dorian
  [0, 2, 4, 5, 7, 9, 11], // major
  [0, 2, 4, 5, 7, 9, 10], // mixolydian
]);

/** Progressions as scale degrees. All of them resolve; none of them hurry. */
const PROGRESSIONS: readonly (readonly number[])[] = Object.freeze([
  [0, 5, 3, 4],
  [0, 3, 4, 3],
  [0, 6, 3, 4],
  [0, 4, 5, 3],
  [0, 2, 5, 4],
  [0, 3, 0, 5],
]);

/**
 * Vowel formants, in Hz, for an adult voice.
 *
 * These are the whole of the spoken layer. Three resonances moving between
 * vowel targets over a glottal buzz is unmistakably a person talking and is
 * incapable of forming a word, which is exactly the brief: a night broadcast
 * from too far away to make out. Nothing here can be decoded, because there is
 * nothing encoded.
 */
const VOWELS: readonly (readonly [number, number, number])[] = Object.freeze([
  [730, 1090, 2440], // as in "father"
  [530, 1840, 2480], // as in "bet"
  [270, 2290, 3010], // as in "beet"
  [570, 840, 2410], // as in "bought"
  [300, 870, 2240], // as in "boot"
  [500, 1500, 2500], // schwa
  [660, 1720, 2410], // as in "bat"
  [440, 1020, 2240], // as in "book"
]);

/** Formant Q values. F1 is the broadest; the higher formants are tighter. */
const FORMANT_Q: readonly [number, number, number] = [9, 16, 20];
const FORMANT_GAIN: readonly [number, number, number] = [1, 0.5, 0.22];

/* -------------------------------------------------------------------------- */
/* Programme voice                                                             */
/* -------------------------------------------------------------------------- */

interface ProgrammeVoiceOptions {
  /** Sustained pad voices. The bleeding station gets fewer; nobody can tell. */
  padVoices: number;
  /** Give this voice the breath-noise consonant layer. */
  breath: boolean;
  lookaheadSeconds: number;
}

interface PadVoice {
  osc: OscillatorNode;
  gain: GainNode;
}

/**
 * One station's audio.
 *
 * Every sub-layer is built once and gated by its own gain, so a segment change
 * is a set of crossfades rather than a graph rebuild. Nothing here reads the
 * shared engine RNG: all randomness comes from the segment seed the simulation
 * supplied, which is what makes a broadcast identical on every device.
 */
class ProgrammeVoice {
  readonly input: GainNode;
  private readonly options: ProgrammeVoiceOptions;
  private readonly tone: BiquadFilterNode;
  private readonly bass: BiquadFilterNode;

  private readonly padBus: GainNode;
  private readonly padFilter: BiquadFilterNode;
  private readonly padVoices: PadVoice[] = [];
  private readonly wowLfo: OscillatorNode;
  private readonly wowDepth: GainNode;

  private readonly leadBus: GainNode;
  private readonly toneBus: GainNode;

  private readonly speechBus: GainNode;
  private readonly glottal: OscillatorNode;
  private readonly glottalGain: GainNode;
  private readonly formants: BiquadFilterNode[] = [];
  private readonly breathSource: AudioBufferSourceNode | null = null;
  private readonly breathFilter: BiquadFilterNode | null = null;
  private readonly breathGain: GainNode | null = null;

  private readonly noiseBus: GainNode;
  private readonly sweepFilter: BiquadFilterNode;
  private readonly sweepLfo: OscillatorNode;
  private readonly sweepDepth: GainNode;

  private readonly roomBus: GainNode;

  private readonly synth: Synth;
  private readonly window: LookaheadWindow;
  private readonly sources: AudioBufferSourceNode[] = [];

  private segment: RadioProgramme | null = null;
  private rng: Rng = createRng(1);
  private started = false;
  private disposed = false;

  /** Musical state for the current bed. */
  private scale: readonly number[] = SCALES[0] as readonly number[];
  private progression: readonly number[] = PROGRESSIONS[0] as readonly number[];
  private rootMidi = 45;
  private chordIndex = 0;
  private chordSeconds = 10;
  private nextChordAt = 0;
  private nextEventAt = 0;
  private eventsScheduled = 0;

  constructor(
    private readonly deps: LayerDeps,
    destination: AudioNode,
    options: Partial<ProgrammeVoiceOptions> = {},
  ) {
    this.options = { padVoices: 4, breath: true, lookaheadSeconds: 0.5, ...options };
    const ctx = deps.ctx;

    this.input = ctx.createGain();
    this.input.gain.value = 0.0001;

    // The receiver's audio stage: a band, not a wire.
    this.bass = ctx.createBiquadFilter();
    this.bass.type = 'highpass';
    this.bass.frequency.value = 160;
    this.bass.Q.value = 0.7;
    this.tone = ctx.createBiquadFilter();
    this.tone.type = 'lowpass';
    this.tone.frequency.value = 3200;
    this.tone.Q.value = 0.8;
    this.bass.connect(this.tone);
    this.tone.connect(this.input);
    this.input.connect(destination);

    // --- pad ---------------------------------------------------------------
    this.padFilter = ctx.createBiquadFilter();
    this.padFilter.type = 'lowpass';
    this.padFilter.frequency.value = 2000;
    this.padFilter.Q.value = 0.9;
    this.padBus = ctx.createGain();
    this.padBus.gain.value = 0.0001;
    this.padFilter.connect(this.padBus);
    this.padBus.connect(this.bass);

    this.wowLfo = ctx.createOscillator();
    this.wowLfo.type = 'sine';
    this.wowLfo.frequency.value = 0.63;
    this.wowDepth = ctx.createGain();
    this.wowDepth.gain.value = 7; // cents of tape wow
    this.wowLfo.connect(this.wowDepth);

    for (let i = 0; i < Math.max(1, this.options.padVoices); i += 1) {
      const osc = ctx.createOscillator();
      osc.type = i % 2 === 0 ? 'triangle' : 'sine';
      osc.frequency.value = 220;
      const gain = ctx.createGain();
      gain.gain.value = 0.0001;
      osc.connect(gain);
      gain.connect(this.padFilter);
      this.wowDepth.connect(osc.detune);
      this.padVoices.push({ osc, gain });
    }

    this.leadBus = ctx.createGain();
    this.leadBus.gain.value = 0.0001;
    this.leadBus.connect(this.bass);

    this.toneBus = ctx.createGain();
    this.toneBus.gain.value = 0.0001;
    this.toneBus.connect(this.bass);

    // --- speech ------------------------------------------------------------
    this.speechBus = ctx.createGain();
    this.speechBus.gain.value = 0.0001;
    this.speechBus.connect(this.bass);

    this.glottal = ctx.createOscillator();
    this.glottal.type = 'sawtooth';
    this.glottal.frequency.value = 115;
    this.glottalGain = ctx.createGain();
    this.glottalGain.gain.value = 0;
    this.glottal.connect(this.glottalGain);

    for (let i = 0; i < 3; i += 1) {
      const formant = ctx.createBiquadFilter();
      formant.type = 'bandpass';
      formant.frequency.value = VOWELS[5]?.[i] ?? 500;
      formant.Q.value = FORMANT_Q[i] ?? 12;
      const level = ctx.createGain();
      level.gain.value = FORMANT_GAIN[i] ?? 0.3;
      this.glottalGain.connect(formant);
      formant.connect(level);
      level.connect(this.speechBus);
      this.formants.push(formant);
    }

    if (this.options.breath) {
      this.breathFilter = ctx.createBiquadFilter();
      this.breathFilter.type = 'bandpass';
      this.breathFilter.frequency.value = 4200;
      this.breathFilter.Q.value = 1.1;
      this.breathGain = ctx.createGain();
      this.breathGain.gain.value = 0;
      this.breathFilter.connect(this.breathGain);
      this.breathGain.connect(this.speechBus);
      const source = ctx.createBufferSource();
      source.buffer = deps.bank.loop('white');
      source.loop = true;
      source.loopEnd = deps.bank.loopEnd('white');
      source.connect(this.breathFilter);
      this.breathSource = source;
    }

    // --- interference ------------------------------------------------------
    this.sweepFilter = ctx.createBiquadFilter();
    this.sweepFilter.type = 'bandpass';
    this.sweepFilter.frequency.value = 1200;
    this.sweepFilter.Q.value = 4;
    this.noiseBus = ctx.createGain();
    this.noiseBus.gain.value = 0.0001;
    this.sweepFilter.connect(this.noiseBus);
    this.noiseBus.connect(this.bass);
    this.sweepLfo = ctx.createOscillator();
    this.sweepLfo.type = 'sine';
    this.sweepLfo.frequency.value = 0.11;
    this.sweepDepth = ctx.createGain();
    this.sweepDepth.gain.value = 700;
    this.sweepLfo.connect(this.sweepDepth);
    this.sweepDepth.connect(this.sweepFilter.frequency);
    const wash = ctx.createBufferSource();
    wash.buffer = deps.bank.loop('white');
    wash.loop = true;
    wash.loopEnd = deps.bank.loopEnd('white');
    wash.connect(this.sweepFilter);
    this.sources.push(wash);

    // --- dead air ----------------------------------------------------------
    // Even silence has a floor: a transmitter that is on but saying nothing is
    // not the same sound as a transmitter that is off.
    this.roomBus = ctx.createGain();
    this.roomBus.gain.value = 0.0001;
    const roomFilter = ctx.createBiquadFilter();
    roomFilter.type = 'lowpass';
    roomFilter.frequency.value = 420;
    roomFilter.connect(this.roomBus);
    this.roomBus.connect(this.bass);
    const room = ctx.createBufferSource();
    room.buffer = deps.bank.loop('brown');
    room.loop = true;
    room.loopEnd = deps.bank.loopEnd('brown');
    room.connect(roomFilter);
    this.sources.push(room);

    this.synth = new Synth(deps, this.leadBus);
    this.window = new LookaheadWindow(this.options.lookaheadSeconds);
  }

  get scheduled(): number {
    return this.eventsScheduled;
  }

  get currentSegment(): Readonly<RadioProgramme> | null {
    return this.segment;
  }

  start(when: number): void {
    if (this.started || this.disposed) return;
    this.started = true;
    for (const voice of this.padVoices) voice.osc.start(when);
    this.wowLfo.start(when);
    this.glottal.start(when);
    this.sweepLfo.start(when);
    for (const source of this.sources) source.start(when, 0);
    this.breathSource?.start(when, 0);
    this.window.reset(when);
  }

  /** The receiver's passband follows the signal. */
  setTone(cutoffHz: number, bassHz: number, smoothing: number): void {
    const now = this.deps.ctx.currentTime;
    this.tone.frequency.setTargetAtTime(safeFrequency(cutoffHz, this.deps.ctx.sampleRate), now, smoothing);
    this.bass.frequency.setTargetAtTime(safeFrequency(bassHz, this.deps.ctx.sampleRate), now, smoothing);
  }

  setLevel(gain: number, smoothing = 0.09): void {
    this.input.gain.setTargetAtTime(Math.max(gain, 0), this.deps.ctx.currentTime, smoothing);
  }

  /**
   * Switch to a new block of programming.
   *
   * Crossfades rather than cuts, and reseeds from the segment's own seed so the
   * material is a pure function of `(seed, kind, intensity)` — the property the
   * determinism test pins down.
   */
  play(segment: RadioProgramme | null, when: number): void {
    if (this.disposed) return;
    this.segment = segment;
    const fade = 0.3;
    const kind = segment?.kind ?? null;

    this.gate(this.padBus, kind === 'music-bed' ? this.padLevel(segment) : 0, fade);
    this.gate(this.leadBus, kind === 'music-bed' ? 0.6 : kind === 'ident' ? 0.9 : 0, fade);
    this.gate(this.toneBus, kind === 'code' || kind === 'ident' ? 0.9 : 0, fade);
    this.gate(this.speechBus, kind === 'spoken' ? 2.6 : 0, fade);
    this.gate(this.noiseBus, kind === 'interference' ? 0.5 : 0, fade);
    this.gate(this.roomBus, kind === 'silence' ? 0.07 : kind === 'carrier' ? 0.13 : 0.02, fade);

    if (!segment) {
      this.nextEventAt = Number.POSITIVE_INFINITY;
      this.nextChordAt = Number.POSITIVE_INFINITY;
      return;
    }

    this.rng = createRng(segment.seed >>> 0);
    const rng = this.rng;
    this.eventsScheduled = 0;

    if (segment.kind === 'music-bed') {
      this.scale = rng.pick(SCALES, SCALES[0] as readonly number[]);
      this.progression = rng.pick(PROGRESSIONS, PROGRESSIONS[0] as readonly number[]);
      // Low and warm. A late-night bed that sits up in the mix is a mistake.
      this.rootMidi = 33 + rng.int(0, 11);
      this.chordSeconds = lerp(15, 7.5, clamp01(segment.intensity));
      this.chordIndex = 0;
      this.padFilter.frequency.setTargetAtTime(
        safeFrequency(mapExp(clamp01(segment.intensity), 1300, 2900), this.deps.ctx.sampleRate),
        when,
        0.6,
      );
      this.applyChord(when, 0.05);
      this.nextChordAt = when + this.chordSeconds;
      this.nextEventAt = when + rng.range(2, 9);
    } else if (segment.kind === 'ident') {
      // The ident is seeded per *station*, not per airing: it is the one thing
      // about a station that has to be the same every time you find it.
      this.playIdent(when, createRng(segment.stationSeed >>> 0));
      this.nextChordAt = Number.POSITIVE_INFINITY;
      this.nextEventAt = Number.POSITIVE_INFINITY;
    } else if (segment.kind === 'spoken') {
      this.glottal.frequency.setValueAtTime(rng.range(92, 148), when);
      this.nextChordAt = Number.POSITIVE_INFINITY;
      this.nextEventAt = when + 0.1;
    } else if (segment.kind === 'code') {
      this.nextChordAt = Number.POSITIVE_INFINITY;
      this.nextEventAt = when + 0.6;
    } else if (segment.kind === 'interference') {
      this.sweepLfo.frequency.setTargetAtTime(rng.range(0.06, 0.24), when, 0.5);
      this.sweepDepth.gain.setTargetAtTime(rng.range(420, 1100), when, 0.5);
      this.nextChordAt = Number.POSITIVE_INFINITY;
      this.nextEventAt = when + rng.range(1.5, 5);
    } else {
      this.nextChordAt = Number.POSITIVE_INFINITY;
      this.nextEventAt = Number.POSITIVE_INFINITY;
    }
  }

  private padLevel(segment: RadioProgramme | null): number {
    return 0.5 + 0.35 * clamp01(segment?.intensity ?? 0);
  }

  private gate(node: GainNode, level: number, fade: number): void {
    node.gain.setTargetAtTime(Math.max(level, 0.00001), this.deps.ctx.currentTime, fade);
  }

  /** Move the pad onto the current chord. Voices glide; nothing restarts. */
  private applyChord(when: number, glide: number): void {
    const degrees = this.progression;
    const degree = degrees[this.chordIndex % degrees.length] ?? 0;
    const scale = this.scale;
    const count = this.padVoices.length;
    for (let i = 0; i < count; i += 1) {
      const voice = this.padVoices[i];
      if (!voice) continue;
      // Stacked thirds, spread across two octaves so it reads as a chord and
      // not as a cluster.
      const step = degree + (i % 3) * 2;
      const octave = Math.floor(i / 3);
      const semitone = (scale[step % scale.length] ?? 0) + 12 * (Math.floor(step / scale.length) + octave);
      const hz = midiToHz(this.rootMidi + semitone);
      voice.osc.frequency.setTargetAtTime(safeFrequency(hz, this.deps.ctx.sampleRate), when, glide);
      // The top of the chord is quieter, which is what stops a synthesised pad
      // sounding like a synthesised pad.
      voice.gain.gain.setTargetAtTime(0.29 / (1 + i * 0.55), when, 0.35);
    }
  }

  /** A short, seeded four-note sting. Each station has exactly one. */
  private playIdent(when: number, rng: Rng): void {
    const scale = rng.pick(SCALES, SCALES[0] as readonly number[]);
    const root = 57 + rng.int(-4, 5);
    const notes = 3 + rng.int(0, 2);
    const spacing = rng.range(0.15, 0.26);
    for (let i = 0; i < notes; i += 1) {
      const step = rng.int(0, scale.length - 1);
      const semitone = (scale[step] ?? 0) + (rng.bool(0.3) ? 12 : 0);
      this.playNote(when + i * spacing, midiToHz(root + semitone), 0.34, 0.2, this.toneBus, 'triangle');
    }
    // A chord under it, and the swell of an old jingle's tape.
    this.playNote(when, midiToHz(root - 12), 0.8, 0.16, this.toneBus, 'sine');
    this.synth.noiseBurst(when, 900, 0.7, 0.09, 0.22, 0.06, 'bandpass', 2400, this.toneBus);
  }

  /** One sustained note. Used for the bed's lead line and for idents. */
  private playNote(
    when: number,
    hz: number,
    seconds: number,
    peak: number,
    destination: AudioNode,
    wave: OscillatorType,
  ): void {
    const ctx = this.deps.ctx;
    const osc = ctx.createOscillator();
    osc.type = wave;
    osc.frequency.value = safeFrequency(hz, ctx.sampleRate);
    const gain = ctx.createGain();
    gain.gain.value = 0;
    osc.connect(gain);
    gain.connect(destination);

    const shaping = this.deps.mixer.shaping;
    const level = Math.min(peak * shaping.peakScale, shaping.ceiling);
    const attack = Math.min(seconds * 0.35, 0.09 * shaping.attackScale);
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(level, when + attack);
    gain.gain.setTargetAtTime(0, when + attack, seconds * 0.34);
    gain.gain.setValueAtTime(0, when + seconds + 0.25);
    osc.start(when);
    osc.stop(when + seconds + 0.3);
    this.synth.cleanupLater([gain], seconds + 0.4);
  }

  /**
   * One syllable of formant babble.
   *
   * A glottal buzz through three moving resonances. The formants glide rather
   * than jump, which is what turns a sequence of vowels into something with the
   * cadence of speech; the fricative in front of some of them supplies the
   * consonants. It cannot form a word and is not meant to.
   */
  private playSyllable(when: number, rng: Rng): number {
    const vowel = rng.pick(VOWELS, VOWELS[5] as readonly [number, number, number]);
    const length = rng.range(0.09, 0.21);
    const shaping = this.deps.mixer.shaping;
    const peak = Math.min(0.5 * shaping.peakScale, shaping.ceiling);

    for (let i = 0; i < this.formants.length; i += 1) {
      const formant = this.formants[i];
      if (!formant) continue;
      const target = (vowel[i] ?? 500) * rng.range(0.94, 1.07);
      formant.frequency.setTargetAtTime(safeFrequency(target, this.deps.ctx.sampleRate), when, 0.028);
    }

    // Intonation: every syllable drifts, and phrases fall at the end.
    const base = this.glottal.frequency.value;
    const target = clamp(base * rng.range(0.93, 1.08), 78, 205);
    this.glottal.frequency.setTargetAtTime(target, when, length * 0.6);

    const attack = 0.018 * shaping.attackScale;
    const g = this.glottalGain.gain;
    g.setValueAtTime(0, when);
    g.linearRampToValueAtTime(peak, when + attack);
    g.setValueAtTime(peak, when + length * 0.7);
    g.linearRampToValueAtTime(0, when + length);

    if (this.breathGain && this.breathFilter && rng.bool(0.42)) {
      const burst = rng.range(0.012, 0.03);
      this.breathFilter.frequency.setValueAtTime(
        safeFrequency(rng.range(2400, 6200), this.deps.ctx.sampleRate),
        when - burst,
      );
      const b = this.breathGain.gain;
      const level = Math.min(0.06 * shaping.peakScale, shaping.ceiling);
      b.setValueAtTime(0, Math.max(when - burst, 0));
      b.linearRampToValueAtTime(level, Math.max(when - burst * 0.5, 0.001));
      b.linearRampToValueAtTime(0, when + 0.01);
    }
    return when + length;
  }

  /** Schedule whatever the current segment owes the next lookahead window. */
  pump(now: number): number {
    if (!this.started || this.disposed) return 0;
    const horizon = this.window.advance(now);
    if (horizon === null) return 0;
    const segment = this.segment;
    if (!segment) return 0;

    let scheduled = 0;
    while (this.nextChordAt <= horizon) {
      this.chordIndex += 1;
      this.applyChord(this.nextChordAt, 1.4);
      this.nextChordAt += this.chordSeconds;
      scheduled += 1;
    }

    let guard = 0;
    while (this.nextEventAt <= horizon && guard++ < 64) {
      const rng = this.rng;
      switch (segment.kind) {
        case 'music-bed': {
          // A single held note over the bed, now and then. Rarely enough that
          // it is a surprise twenty minutes in rather than a pattern.
          const degrees = this.progression;
          const degree = degrees[this.chordIndex % degrees.length] ?? 0;
          const scale = this.scale;
          const step = degree + rng.int(0, 4) * 2;
          const semitone = (scale[step % scale.length] ?? 0) + 12 * (2 + Math.floor(step / scale.length));
          this.playNote(this.nextEventAt, midiToHz(this.rootMidi + semitone), rng.range(1.6, 3.6), 0.1, this.leadBus, 'sine');
          this.nextEventAt += rng.range(6, 22) * lerp(1.6, 0.7, clamp01(segment.intensity));
          break;
        }
        case 'spoken': {
          // Phrases of a few syllables with a breath between them.
          let cursor = this.nextEventAt;
          const syllables = rng.int(3, 9);
          for (let i = 0; i < syllables; i += 1) cursor = this.playSyllable(cursor, rng) + rng.range(0.01, 0.05);
          this.nextEventAt = cursor + (rng.bool(0.25) ? rng.range(0.9, 2.4) : rng.range(0.22, 0.7));
          break;
        }
        case 'code': {
          // Slow tones in groups. Atmosphere, never a puzzle: the pitches come
          // from the seed and carry nothing (spec §8 — mystery gates nothing).
          const pitch = midiToHz(69 + rng.int(-5, 7));
          this.playNote(this.nextEventAt, pitch, 0.42, 0.16, this.toneBus, 'sine');
          this.nextEventAt += rng.bool(0.2) ? rng.range(2.2, 3.4) : rng.range(0.95, 1.25);
          break;
        }
        case 'interference': {
          // Something else beating against the carrier for a moment.
          this.synth.noiseBurst(
            this.nextEventAt,
            rng.range(700, 2600),
            rng.range(2, 8),
            0.05,
            rng.range(0.12, 0.4),
            0.1,
            'bandpass',
            rng.range(400, 3000),
            this.noiseBus,
          );
          this.nextEventAt += rng.range(1.2, 6);
          break;
        }
        default:
          this.nextEventAt = Number.POSITIVE_INFINITY;
          break;
      }
      scheduled += 1;
    }
    this.eventsScheduled += scheduled;
    return scheduled;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const end = this.deps.ctx.currentTime + 0.05;
    for (const voice of this.padVoices) {
      safeStop(voice.osc, end);
      safeDisconnect(voice.gain);
    }
    safeStop(this.wowLfo, end);
    safeStop(this.glottal, end);
    safeStop(this.sweepLfo, end);
    safeStop(this.breathSource, end);
    for (const source of this.sources) safeStop(source, end);
    this.sources.length = 0;
    for (const formant of this.formants) safeDisconnect(formant);
    safeDisconnect(this.padFilter);
    safeDisconnect(this.padBus);
    safeDisconnect(this.leadBus);
    safeDisconnect(this.toneBus);
    safeDisconnect(this.speechBus);
    safeDisconnect(this.glottalGain);
    safeDisconnect(this.breathFilter);
    safeDisconnect(this.breathGain);
    safeDisconnect(this.noiseBus);
    safeDisconnect(this.sweepFilter);
    safeDisconnect(this.sweepDepth);
    safeDisconnect(this.roomBus);
    safeDisconnect(this.bass);
    safeDisconnect(this.tone);
    safeDisconnect(this.input);
  }
}

/* -------------------------------------------------------------------------- */
/* The receiver                                                                */
/* -------------------------------------------------------------------------- */

export interface RadioKitOptions {
  /** Line frequency. 60 Hz here, to match the SM-01's compressor. */
  mainsHz: number;
  /** Smoothing on the continuous reception parameters. */
  smoothingSeconds: number;
  /** Seconds the power ramp takes. Short, but never a step. */
  powerSeconds: number;
  lookaheadSeconds: number;
}

export const DEFAULT_RADIO_OPTIONS: Readonly<RadioKitOptions> = Object.freeze({
  mainsHz: 60,
  smoothingSeconds: 0.09,
  powerSeconds: 0.06,
  lookaheadSeconds: 0.5,
});

export class RadioKit implements PumpableLayer {
  private readonly options: RadioKitOptions;
  private readonly stateValue: RadioAudioState = { ...DEFAULT_RADIO_STATE };
  private readonly paramsValue: RadioVoiceParams = createRadioVoiceParams();

  private readonly output: GainNode;
  private readonly dipGain: GainNode;
  private readonly powerGain: GainNode;
  private readonly postVolume: GainNode;
  private readonly volumeGain: GainNode;
  private readonly signalBus: GainNode;

  private readonly hissGain: GainNode;
  private readonly hissLow: BiquadFilterNode;
  private readonly hissHigh: BiquadFilterNode;
  private readonly hissSource: AudioBufferSourceNode;

  private readonly whistle: OscillatorNode;
  private readonly whistleHarmonic: OscillatorNode;
  private readonly whistleGain: GainNode;
  private readonly whistleHarmonicGain: GainNode;

  private readonly humGain: GainNode;
  private readonly humOscillators: OscillatorNode[] = [];

  private readonly primary: ProgrammeVoice;
  private readonly bleed: ProgrammeVoice;

  private poweredValue = false;
  private started = false;
  private disposed = false;

  constructor(
    private readonly deps: LayerDeps,
    options: Partial<RadioKitOptions> = {},
  ) {
    this.options = { ...DEFAULT_RADIO_OPTIONS, ...options };
    const ctx = deps.ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);

    this.dipGain = ctx.createGain();
    this.dipGain.gain.value = 1;
    this.dipGain.connect(this.output);

    this.powerGain = ctx.createGain();
    this.powerGain.gain.value = 0;
    this.powerGain.connect(this.dipGain);

    this.postVolume = ctx.createGain();
    this.postVolume.gain.value = 1;
    this.postVolume.connect(this.powerGain);

    this.volumeGain = ctx.createGain();
    this.volumeGain.gain.value = DEFAULT_RADIO_STATE.volume;
    this.volumeGain.connect(this.postVolume);

    this.signalBus = ctx.createGain();
    this.signalBus.gain.value = 1;
    this.signalBus.connect(this.volumeGain);

    // --- hiss --------------------------------------------------------------
    this.hissHigh = ctx.createBiquadFilter();
    this.hissHigh.type = 'highpass';
    this.hissHigh.frequency.value = 300;
    this.hissHigh.Q.value = 0.7;
    this.hissLow = ctx.createBiquadFilter();
    this.hissLow.type = 'lowpass';
    this.hissLow.frequency.value = 6000;
    this.hissLow.Q.value = 0.7;
    this.hissGain = ctx.createGain();
    this.hissGain.gain.value = 0.0001;
    this.hissHigh.connect(this.hissLow);
    this.hissLow.connect(this.hissGain);
    this.hissGain.connect(this.signalBus);
    this.hissSource = ctx.createBufferSource();
    this.hissSource.buffer = deps.bank.loop('white');
    this.hissSource.loop = true;
    this.hissSource.loopEnd = deps.bank.loopEnd('white');
    this.hissSource.connect(this.hissHigh);

    // --- heterodyne --------------------------------------------------------
    this.whistleGain = ctx.createGain();
    this.whistleGain.gain.value = 0.0001;
    this.whistleGain.connect(this.signalBus);
    this.whistle = ctx.createOscillator();
    this.whistle.type = 'sine';
    this.whistle.frequency.value = 20;
    this.whistle.connect(this.whistleGain);
    // A real beat note is not a laboratory sine; a touch of second harmonic is
    // what makes it read as a receiver rather than a test tone.
    this.whistleHarmonicGain = ctx.createGain();
    this.whistleHarmonicGain.gain.value = 0.0001;
    this.whistleHarmonicGain.connect(this.signalBus);
    this.whistleHarmonic = ctx.createOscillator();
    this.whistleHarmonic.type = 'sine';
    this.whistleHarmonic.frequency.value = 40;
    this.whistleHarmonic.connect(this.whistleHarmonicGain);

    // --- mains hum ---------------------------------------------------------
    // After the volume control, exactly where a real set's is.
    this.humGain = ctx.createGain();
    this.humGain.gain.value = 0.0001;
    const humFilter = ctx.createBiquadFilter();
    humFilter.type = 'lowpass';
    humFilter.frequency.value = 640;
    humFilter.Q.value = 0.8;
    humFilter.connect(this.humGain);
    this.humGain.connect(this.postVolume);
    const mains = this.options.mainsHz;
    // Rectifier ripple at twice line dominates; the line fundamental and its
    // third harmonic sit under it.
    const humPartials: readonly [number, number][] = [
      [mains * 2, 1],
      [mains, 0.42],
      [mains * 4, 0.16],
      [mains * 6, 0.07],
    ];
    for (const partial of humPartials) {
      const osc = ctx.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = safeFrequency(partial[0], ctx.sampleRate);
      const gain = ctx.createGain();
      gain.gain.value = partial[1];
      osc.connect(gain);
      gain.connect(humFilter);
      this.humOscillators.push(osc);
    }

    // --- programme ---------------------------------------------------------
    this.primary = new ProgrammeVoice(deps, this.signalBus, {
      padVoices: 4,
      breath: true,
      lookaheadSeconds: this.options.lookaheadSeconds,
    });
    // The bleeding station is heard through the skirt of the filter: fewer
    // voices and no consonants, because none of that survives the trip.
    this.bleed = new ProgrammeVoice(deps, this.signalBus, {
      padVoices: 2,
      breath: false,
      lookaheadSeconds: this.options.lookaheadSeconds,
    });
  }

  get powered(): boolean {
    return this.poweredValue;
  }

  get state(): Readonly<RadioAudioState> {
    return this.stateValue;
  }

  get params(): Readonly<RadioVoiceParams> {
    return this.paramsValue;
  }

  /** Events scheduled by both programme voices so far. */
  get programmeEvents(): number {
    return this.primary.scheduled + this.bleed.scheduled;
  }

  private ensureStarted(when: number): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const rng = this.deps.rng;
    const loopEnd = this.deps.bank.loopEnd('white');
    this.hissSource.start(when, rng.range(0, Math.max(loopEnd - 0.05, 0.01)));
    this.whistle.start(when);
    this.whistleHarmonic.start(when);
    for (const osc of this.humOscillators) osc.start(when);
    this.primary.start(when);
    this.bleed.start(when);
  }

  /**
   * Throw the power switch.
   *
   * A ramp, not a step, in both directions — and the graph behind it keeps
   * running, gated to silence. Off is genuinely off: `powerGain` lands on a
   * hard zero once the ramp has decayed past audibility.
   */
  setPower(on: boolean): void {
    if (this.disposed || this.poweredValue === on) return;
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    this.poweredValue = on;
    this.ensureStarted(Math.max(now, 0));
    const tc = Math.max(this.options.powerSeconds, 0.005);
    const param = this.powerGain.gain;
    param.cancelScheduledValues(now);
    param.setTargetAtTime(on ? 1 : 0, now, tc);
    if (!on) {
      // Seven time constants below the target is 0.1 % of the level it started
      // from — inaudible, so landing on an exact zero there cannot click.
      param.setValueAtTime(0, now + tc * 7);
      this.primary.play(null, now);
      this.bleed.play(null, now);
    }
  }

  /**
   * Changing band.
   *
   * A real set mutes while the band switch is in transit, and everything the
   * receiver was hearing is gone on the far side. Dipping the output is both
   * the honest behaviour and the thing that stops the discontinuity.
   */
  bandChange(): void {
    if (this.disposed) return;
    const now = this.deps.ctx.currentTime;
    const param = this.dipGain.gain;
    param.cancelScheduledValues(now);
    // Fast enough to read as a switch, slow enough that the mute is a fade.
    param.setTargetAtTime(0, now, 0.03);
    param.setTargetAtTime(1, now + 0.14, 0.05);
    this.primary.play(null, now);
    this.bleed.play(null, now);
  }

  /** Hot path. Allocation-free partial update of the reception state. */
  setReception(next: Partial<RadioAudioState>): void {
    if (this.disposed) return;
    const state = this.stateValue;
    if (next.clarity !== undefined) state.clarity = clamp01(next.clarity);
    if (next.hiss !== undefined) state.hiss = clamp01(next.hiss);
    if (next.bleed !== undefined) state.bleed = clamp01(next.bleed);
    if (next.hum !== undefined) state.hum = clamp01(next.hum);
    if (next.detune !== undefined) state.detune = Number.isFinite(next.detune) ? next.detune : 0;
    if (next.halfWidth !== undefined && Number.isFinite(next.halfWidth)) state.halfWidth = next.halfWidth;
    if (next.volume !== undefined) state.volume = clamp01(next.volume);
    if (next.band !== undefined) state.band = next.band;
    this.applyReception();
  }

  private applyReception(): void {
    const ctx = this.deps.ctx;
    const now = ctx.currentTime;
    const tc = this.options.smoothingSeconds;
    const params = mapRadioState(this.stateValue, this.paramsValue);
    const shaping = this.deps.mixer.shaping;
    const scale = shaping.peakScale;

    this.hissGain.gain.setTargetAtTime(params.hissGain * scale, now, tc);
    this.hissLow.frequency.setTargetAtTime(params.hissCutoffHz, now, tc);
    this.hissHigh.frequency.setTargetAtTime(params.hissBassHz, now, tc);

    // The whistle glides. Sweeping the dial has to sound like one continuous
    // swoop; stepping the oscillator would be the zipper noise itself.
    const whistleHz = Math.max(params.whistleHz, 1);
    this.whistle.frequency.setTargetAtTime(safeFrequency(whistleHz, ctx.sampleRate), now, 0.05);
    this.whistleHarmonic.frequency.setTargetAtTime(safeFrequency(whistleHz * 2, ctx.sampleRate), now, 0.05);
    this.whistleGain.gain.setTargetAtTime(Math.max(params.whistleGain * scale, 0.00001), now, tc);
    this.whistleHarmonicGain.gain.setTargetAtTime(Math.max(params.whistleGain * 0.22 * scale, 0.00001), now, tc);

    this.humGain.gain.setTargetAtTime(Math.max(params.humGain * scale, 0.00001), now, tc * 2);
    this.volumeGain.gain.setTargetAtTime(this.stateValue.volume, now, 0.05);

    this.primary.setLevel(params.programmeGain * scale, tc);
    this.primary.setTone(params.audioCutoffHz, bandCharacter(this.stateValue.band).audioBassHz, tc * 3);
    this.bleed.setLevel(params.bleedGain * scale, tc);
    this.bleed.setTone(params.bleedCutoffHz, bandCharacter(this.stateValue.band).audioBassHz * 1.4, tc * 3);
  }

  /**
   * Hand the receiver a block of programming.
   *
   * `slot` is which station: the one you are tuned to, or the one bleeding
   * through underneath it. Passing `null` means that slot has nothing on it.
   */
  playSegment(slot: 'primary' | 'bleed', segment: RadioProgramme | null): void {
    if (this.disposed) return;
    const when = Math.max(this.deps.ctx.currentTime, 0);
    const voice = slot === 'primary' ? this.primary : this.bleed;
    voice.play(segment, when);
  }

  /** What each slot is currently playing. */
  segmentOf(slot: 'primary' | 'bleed'): Readonly<RadioProgramme> | null {
    return slot === 'primary' ? this.primary.currentSegment : this.bleed.currentSegment;
  }

  pump(now: number): number {
    if (this.disposed || !this.started || !this.poweredValue) return 0;
    return this.primary.pump(now) + this.bleed.pump(now);
  }

  dispose(): void {
    if (this.disposed) return;
    const end = this.deps.ctx.currentTime + 0.05;
    this.primary.dispose();
    this.bleed.dispose();
    this.disposed = true;
    safeStop(this.hissSource, end);
    safeStop(this.whistle, end);
    safeStop(this.whistleHarmonic, end);
    for (const osc of this.humOscillators) safeStop(osc, end);
    this.humOscillators.length = 0;
    safeDisconnect(this.hissHigh);
    safeDisconnect(this.hissLow);
    safeDisconnect(this.hissGain);
    safeDisconnect(this.whistleGain);
    safeDisconnect(this.whistleHarmonicGain);
    safeDisconnect(this.humGain);
    safeDisconnect(this.signalBus);
    safeDisconnect(this.volumeGain);
    safeDisconnect(this.postVolume);
    safeDisconnect(this.powerGain);
    safeDisconnect(this.dipGain);
    safeDisconnect(this.output);
  }
}
