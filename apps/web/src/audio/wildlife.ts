/**
 * Wildlife.
 *
 * The point of the wildlife system is an animal you can hear behind you and
 * cannot see (spec §7), so this layer is spatial first and pretty second.
 * Everything it makes goes through a `SpatialEmitter`, and the two loudest
 * things a player will notice — something moving in the undergrowth, and a call
 * from a direction they were not looking — are both placed in 3D.
 *
 * There is no per-species audio data anywhere in the content package and none
 * is added here. A species has exactly two numbers, `shyness` and `curiosity`,
 * plus its id; that is enough:
 *
 *  - **The id seeds the voice.** `speciesVoice` is a pure function of
 *    `(id, shyness, curiosity)`, so a given species sounds like itself at every
 *    campsite on every device, and a new species in a manifest gets a voice
 *    without anybody authoring one.
 *  - **Shyness sets register and carry.** The animals you only ever *hear* are
 *    the small, high, quiet ones; the ones that walk into camp are lower,
 *    louder and breathier. Shyness is also rarity in this model, so the rarest
 *    thing at a campsite is also the thinnest sound in it, which is the right
 *    way round.
 *  - **Curiosity sets expression.** An incurious animal makes one flat note.
 *    A curious one inflects, repeats itself, and answers.
 *  - **The individual id detunes it.** A resident is the same species voice a
 *    few cents off with a slightly different length — enough that a player who
 *    has heard the fox a dozen times knows it is the fox, and never enough to
 *    read as a different animal.
 *
 * The `watched` correlate deserves its own note. Spec §2.2 forbids anything
 * that stalks or threatens, and §2.1 forbids generic horror outright, so being
 * watched is *not* a stinger. It is a low, quiet, slowly-rising presence at the
 * watcher's bearing — below a hundredth of full scale, four seconds of fade in
 * and out, no pitch, no transient, no dissonance — plus, very occasionally, one
 * small shift in the leaves. It is designed to be missed. A player who never
 * notices it has lost nothing; a player who does turns around, which is the
 * whole of the intended effect.
 */

import { clamp, clamp01, lerp, mapExp } from './math.js';
import { safeFrequency } from './envelopes.js';
import { safeDisconnect, safeStop } from './context.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import type { Rng } from './rng.js';
import { createRng, hashSeed } from './rng.js';
import { SpatialEmitter, type SpatialQuality } from './spatial.js';
import { Synth } from './synth.js';
import { LookaheadWindow, PoissonScheduler } from './voices.js';

/* -------------------------------------------------------------------------- */
/* Simulation-shaped input                                                     */
/* -------------------------------------------------------------------------- */

/** Structurally identical to `AnimalPhase` in `@somemore/sim`. */
export type WildlifeAudioPhase =
  | 'absent'
  | 'approaching'
  | 'watching'
  | 'investigating'
  | 'startled'
  | 'fleeing'
  | 'gone';

/** One animal, as the bridge describes it to the audio engine each frame. */
export interface WildlifeAnimalAudio {
  /** The individual's id: what makes a resident subtly recognisable. */
  id: string;
  speciesId: string;
  /** 0 = walks up to you, 1 = you will only ever hear it. */
  shyness: number;
  /** 0 = ignores the camp, 1 = investigates everything. */
  curiosity: number;
  x: number;
  y: number;
  z: number;
  distanceM: number;
  phase: WildlifeAudioPhase;
  alarm: number;
  interest: number;
}

/* -------------------------------------------------------------------------- */
/* Voices (pure)                                                               */
/* -------------------------------------------------------------------------- */

export type WildlifeArchetype = 'whistle' | 'chitter' | 'huff' | 'trill';

export const WILDLIFE_ARCHETYPES: readonly WildlifeArchetype[] = ['whistle', 'chitter', 'huff', 'trill'];

export interface WildlifeVoiceSpec {
  archetype: WildlifeArchetype;
  /** Carrier at the start of the call. */
  startHz: number;
  /** Where it lands. Rising and falling calls both exist. */
  endHz: number;
  /** FM operator ratio and index — the whole of the call's timbre. */
  modRatio: number;
  modIndex: number;
  /** One utterance. */
  durationSeconds: number;
  repeats: number;
  gapSeconds: number;
  /** Band-pass placed after the call, which is what sits it in the trees. */
  filterHz: number;
  filterQ: number;
  peak: number;
  /** 0 = a pure voice, 1 = mostly breath. */
  breath: number;
  /** Whether a startled departure includes wingbeats. */
  wingbeat: boolean;
}

/** Longest a single call may run, so nothing can hold a note forever. */
export const MAX_CALL_SECONDS = 2.6;

/**
 * Derive a species' voice from the only three things the content gives us.
 *
 * Pure and exported on purpose: the same relationship drives the visible cue
 * (a shy animal's call is drawn thinner and further away), so no information
 * here reaches the player through hearing alone (spec §12).
 */
export function speciesVoice(speciesId: string, shyness: number, curiosity: number): WildlifeVoiceSpec {
  const rng = createRng(hashSeed(`voice:${speciesId}`));
  const shy = clamp01(shyness);
  const curious = clamp01(curiosity);

  const archetype = rng.pick(WILDLIFE_ARCHETYPES, 'whistle');
  // Small and high is what survives a long way through trees, and shyness is
  // also rarity here: the animal you only ever hear should be the thin one.
  const base = mapExp(shy, 420, 2500) * rng.range(0.82, 1.24);
  // Rising or falling is a per-species coin flip; curiosity says how far it moves.
  const interval = lerp(1.03, 1.6, curious) * rng.range(0.85, 1.15);
  const rising = rng.bool(0.45);

  const spec: WildlifeVoiceSpec = {
    archetype,
    startHz: safeFrequency(rising ? base : base * interval),
    endHz: safeFrequency(rising ? base * interval : base),
    modRatio: 0,
    modIndex: 0,
    durationSeconds: 0,
    repeats: 1 + Math.round(curious * 3 * rng.range(0.6, 1.2)),
    gapSeconds: lerp(0.42, 0.16, curious) * rng.range(0.8, 1.3),
    filterHz: safeFrequency(base * rng.range(1.4, 2.6)),
    filterQ: lerp(0.8, 2.4, shy),
    // A bold animal is close, so it is loud; a shy one is a rumour.
    peak: lerp(0.4, 0.15, shy),
    breath: lerp(0.55, 0.06, shy),
    wingbeat: rng.bool(0.4),
  };

  switch (archetype) {
    case 'chitter':
      // Fast, dry, near-noise: a rapid AM buzz. Raccoons and squirrels.
      spec.modRatio = rng.range(0.012, 0.03);
      spec.modIndex = lerp(180, 520, curious);
      spec.durationSeconds = rng.range(0.16, 0.34);
      spec.repeats = Math.max(spec.repeats, 3);
      spec.gapSeconds = rng.range(0.07, 0.16);
      break;
    case 'huff':
      // Low, breathy, short. Something big enough not to bother hiding.
      spec.startHz = safeFrequency(spec.startHz * 0.45);
      spec.endHz = safeFrequency(spec.endHz * 0.4);
      spec.modRatio = rng.range(0.9, 1.4);
      spec.modIndex = lerp(10, 45, curious);
      spec.durationSeconds = rng.range(0.24, 0.5);
      spec.breath = Math.max(spec.breath, 0.5);
      spec.filterHz = safeFrequency(spec.filterHz * 0.5);
      break;
    case 'trill':
      // A buzzy mechanical roll, like a nightjar's.
      spec.modRatio = rng.range(0.02, 0.05);
      spec.modIndex = lerp(120, 380, curious);
      spec.durationSeconds = rng.range(0.5, 1.2);
      spec.repeats = Math.min(spec.repeats, 2);
      break;
    case 'whistle':
    default:
      // Two-operator FM with a glide. The clearest thing across a clearing.
      spec.modRatio = rng.range(1.6, 3.1);
      spec.modIndex = lerp(8, 90, curious) * rng.range(0.7, 1.3);
      spec.durationSeconds = rng.range(0.2, 0.62);
      break;
  }
  spec.durationSeconds = clamp(spec.durationSeconds, 0.05, MAX_CALL_SECONDS);
  spec.repeats = Math.max(1, Math.min(spec.repeats, 6));
  return spec;
}

/**
 * Shift a species voice onto one individual.
 *
 * Deliberately small. Recognising the fox is worth having (§7); mistaking it
 * for a different animal is not, so nothing here moves the pitch by more than
 * a semitone or the length by more than a tenth.
 */
export function individualVoice(spec: WildlifeVoiceSpec, individualId: string): WildlifeVoiceSpec {
  const rng = createRng(hashSeed(`individual:${individualId}`));
  const detune = rng.range(-0.055, 0.055); // roughly ±a semitone
  const scale = 1 + detune;
  return {
    ...spec,
    startHz: safeFrequency(spec.startHz * scale),
    endHz: safeFrequency(spec.endHz * scale),
    filterHz: safeFrequency(spec.filterHz * (1 + detune * 0.6)),
    durationSeconds: clamp(spec.durationSeconds * rng.range(0.92, 1.09), 0.05, MAX_CALL_SECONDS),
    gapSeconds: spec.gapSeconds * rng.range(0.9, 1.12),
    peak: spec.peak * rng.range(0.88, 1.12),
  };
}

/* -------------------------------------------------------------------------- */
/* Movement (pure)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * How often an animal in a given phase disturbs the undergrowth, in events per
 * second, before shyness is taken into account.
 *
 * A watching animal is nearly silent and that is the point: stillness is the
 * mechanic, and an animal that has settled to watch has to reward listening
 * rather than announce itself.
 */
export const PHASE_MOVEMENT_RATE: Readonly<Record<WildlifeAudioPhase, number>> = Object.freeze({
  absent: 0,
  approaching: 1.5,
  watching: 0.12,
  investigating: 0.85,
  startled: 2.4,
  fleeing: 3.2,
  gone: 0,
});

/** Beyond this there is nothing to hear over the fire. */
export const WILDLIFE_AUDIBLE_METRES = 26;

/**
 * How often an animal in a given phase says something, in calls per second.
 *
 * The simulation does not emit "call" events — it has no reason to — so the
 * audio layer decides when an animal is heard from, at a rate slow enough that
 * a call is always a small event. A settled animal watching the camp is the
 * likeliest to speak, which is the behaviour stillness is supposed to buy.
 */
export const PHASE_CALL_RATE: Readonly<Record<WildlifeAudioPhase, number>> = Object.freeze({
  absent: 0,
  approaching: 0.05,
  watching: 0.09,
  investigating: 0.055,
  startled: 0.11,
  fleeing: 0.02,
  gone: 0,
});

/** Call rate for one animal. Curious animals have more to say. */
export function callRate(phase: WildlifeAudioPhase, curiosity: number, distanceM: number): number {
  const base = PHASE_CALL_RATE[phase] ?? 0;
  if (base <= 0) return 0;
  if (!(distanceM < WILDLIFE_AUDIBLE_METRES * 1.6)) return 0;
  return base * lerp(0.55, 1.5, clamp01(curiosity));
}

/** Rustle rate for one animal: phase, shyness and distance together. */
export function movementRate(phase: WildlifeAudioPhase, shyness: number, distanceM: number): number {
  const base = PHASE_MOVEMENT_RATE[phase] ?? 0;
  if (base <= 0) return 0;
  if (!(distanceM < WILDLIFE_AUDIBLE_METRES)) return 0;
  // Shy animals place their feet carefully. They are also the ones worth hearing.
  return base * lerp(1, 0.45, clamp01(shyness));
}

/**
 * Air and undergrowth eat the top off a sound over distance. This is the only
 * distance treatment the kit applies itself; level is left to the panner, so
 * the two never fight.
 */
export function distanceCutoffHz(distanceM: number, brightHz: number): number {
  const d = clamp(distanceM, 0, WILDLIFE_AUDIBLE_METRES);
  return safeFrequency(mapExp(1 - d / WILDLIFE_AUDIBLE_METRES, brightHz * 0.22, brightHz));
}

/* -------------------------------------------------------------------------- */
/* Kit                                                                         */
/* -------------------------------------------------------------------------- */

export interface WildlifeKitOptions {
  /** Positioned voices. Sounds are short, so a handful covers a campsite. */
  emitters: number;
  panningModel: SpatialQuality;
  lookaheadSeconds: number;
  /** Peak level of the watched presence. Deliberately tiny. */
  watchedLevel: number;
  /** Seconds the watched presence takes to arrive, and to leave. */
  watchedFadeSeconds: number;
}

export const DEFAULT_WILDLIFE_OPTIONS: Readonly<WildlifeKitOptions> = Object.freeze({
  emitters: 6,
  panningModel: 'auto',
  lookaheadSeconds: 0.4,
  watchedLevel: 0.014,
  watchedFadeSeconds: 4,
});

interface VoiceSlot {
  emitter: SpatialEmitter;
  synth: Synth;
  busyUntil: number;
}

interface TrackedAnimal {
  id: string;
  speciesId: string;
  shyness: number;
  curiosity: number;
  alarm: number;
  x: number;
  y: number;
  z: number;
  distanceM: number;
  phase: WildlifeAudioPhase;
  /** Rustles per second. */
  rate: number;
  /** Calls per second. */
  voiceRate: number;
  spec: WildlifeVoiceSpec;
}

export class WildlifeKit implements PumpableLayer {
  private readonly options: WildlifeKitOptions;
  private readonly output: GainNode;
  private readonly slots: VoiceSlot[] = [];
  private readonly voiceCache = new Map<string, WildlifeVoiceSpec>();

  private readonly animals: TrackedAnimal[] = [];
  private animalCount = 0;

  private readonly movementScheduler: PoissonScheduler;
  private readonly callScheduler: PoissonScheduler;
  private readonly watchScheduler: PoissonScheduler;
  private readonly window: LookaheadWindow;
  private readonly eventTimes = new Float64Array(12);

  private readonly watchedEmitter: SpatialEmitter | null;
  private readonly watchedGain: GainNode;
  private readonly watchedFilter: BiquadFilterNode;
  private readonly watchedSource: AudioBufferSourceNode;
  private watchedValue = false;
  private started = false;
  private disposed = false;
  private callsPlayed = 0;

  constructor(
    private readonly deps: LayerDeps,
    options: Partial<WildlifeKitOptions> = {},
  ) {
    this.options = { ...DEFAULT_WILDLIFE_OPTIONS, ...options };
    const ctx = deps.ctx;

    this.output = ctx.createGain();
    this.output.gain.value = 1;
    this.output.connect(deps.destination);

    for (let i = 0; i < Math.max(1, this.options.emitters); i += 1) {
      const emitter = new SpatialEmitter(
        ctx,
        this.output,
        { panningModel: this.options.panningModel, refDistance: 1.2, maxDistance: 48, rolloffFactor: 1 },
        i,
      );
      this.slots.push({ emitter, synth: new Synth(deps, emitter.input), busyUntil: 0 });
    }

    // The watched presence: a low bed, its own emitter, nothing else.
    this.watchedEmitter = new SpatialEmitter(
      ctx,
      this.output,
      { panningModel: this.options.panningModel, refDistance: 3, maxDistance: 60, rolloffFactor: 0.6 },
      this.slots.length,
    );
    this.watchedFilter = ctx.createBiquadFilter();
    this.watchedFilter.type = 'lowpass';
    this.watchedFilter.frequency.value = 220;
    this.watchedFilter.Q.value = 0.6;
    this.watchedGain = ctx.createGain();
    this.watchedGain.gain.value = 0;
    this.watchedFilter.connect(this.watchedGain);
    this.watchedGain.connect(this.watchedEmitter.input);
    this.watchedSource = ctx.createBufferSource();
    this.watchedSource.buffer = deps.bank.loop('brown');
    this.watchedSource.loop = true;
    this.watchedSource.loopEnd = deps.bank.loopEnd('brown');
    this.watchedSource.playbackRate.value = 0.7;
    this.watchedSource.connect(this.watchedFilter);

    this.movementScheduler = new PoissonScheduler(deps.rng);
    this.callScheduler = new PoissonScheduler(deps.rng);
    this.watchScheduler = new PoissonScheduler(deps.rng);
    this.window = new LookaheadWindow(this.options.lookaheadSeconds);
  }

  get watched(): boolean {
    return this.watchedValue;
  }

  get callsScheduled(): number {
    return this.callsPlayed;
  }

  get tracked(): number {
    return this.animalCount;
  }

  /** The voice this species has everywhere, memoised. */
  voiceFor(speciesId: string, shyness: number, curiosity: number): WildlifeVoiceSpec {
    const cached = this.voiceCache.get(speciesId);
    if (cached) return cached;
    const spec = speciesVoice(speciesId, shyness, curiosity);
    this.voiceCache.set(speciesId, spec);
    return spec;
  }

  start(): void {
    if (this.started || this.disposed) return;
    this.started = true;
    const now = this.deps.ctx.currentTime;
    this.watchedSource.start(now, this.deps.rng.range(0, 1));
    this.window.reset(now);
  }

  private slotFor(time: number): VoiceSlot {
    let oldest: VoiceSlot | null = null;
    for (const slot of this.slots) {
      if (slot.busyUntil <= time) return slot;
      if (!oldest || slot.busyUntil < oldest.busyUntil) oldest = slot;
    }
    return oldest ?? (this.slots[0] as VoiceSlot);
  }

  private place(slot: VoiceSlot, x: number, y: number, z: number): void {
    // Placement is effectively instant: the emitter is silent between sounds,
    // so there is nothing for a fast move to zip.
    slot.emitter.setPosition(x, y, z, 0.001);
  }

  /**
   * Hot path. Rewrites the tracked animal list in place.
   *
   * Nothing is allocated once the list has been this long before, which matters
   * because this runs at simulation rate.
   */
  setAnimals(animals: readonly WildlifeAnimalAudio[]): void {
    if (this.disposed) return;
    this.animalCount = 0;
    let movement = 0;
    let voices = 0;
    for (let i = 0; i < animals.length; i += 1) {
      const animal = animals[i];
      if (!animal) continue;
      const rate = movementRate(animal.phase, animal.shyness, animal.distanceM);
      const voice = callRate(animal.phase, animal.curiosity, animal.distanceM);
      let tracked = this.animals[this.animalCount];
      if (!tracked) {
        tracked = {
          id: '',
          speciesId: '',
          shyness: 0,
          curiosity: 0,
          alarm: 0,
          x: 0,
          y: 0,
          z: 0,
          distanceM: 0,
          phase: 'absent',
          rate: 0,
          voiceRate: 0,
          spec: speciesVoice('', 0.5, 0.5),
        };
        this.animals.push(tracked);
      }
      tracked.id = animal.id;
      tracked.speciesId = animal.speciesId;
      tracked.shyness = clamp01(animal.shyness);
      tracked.curiosity = clamp01(animal.curiosity);
      tracked.alarm = clamp01(animal.alarm);
      tracked.x = animal.x;
      tracked.y = animal.y;
      tracked.z = animal.z;
      tracked.distanceM = animal.distanceM;
      tracked.phase = animal.phase;
      tracked.rate = rate;
      tracked.voiceRate = voice;
      tracked.spec = this.voiceFor(animal.speciesId, animal.shyness, animal.curiosity);
      this.animalCount += 1;
      movement += rate;
      voices += voice;
    }
    const now = this.deps.ctx.currentTime;
    this.movementScheduler.setRate(movement, now);
    this.callScheduler.setRate(voices, now);
  }

  /**
   * Something shy is watching from the dark.
   *
   * Cozy and slightly eerie, never threatening (spec §2.2). The level is capped
   * at a hundredth of full scale, the fade is measured in seconds, and there is
   * no transient anywhere in it — this cue can only ever be noticed, never
   * inflicted.
   */
  setWatched(watched: boolean, x = 0, y = 0, z = -4): void {
    if (this.disposed) return;
    const now = this.deps.ctx.currentTime;
    if (watched) this.watchedEmitter?.setPosition(x, y, z, 0.4);
    if (this.watchedValue === watched) return;
    this.watchedValue = watched;
    const fade = Math.max(this.options.watchedFadeSeconds, 0.5) / 3;
    // An exact zero, not a floor: a campsite with nothing watching is silent,
    // and silence is information too.
    this.watchedGain.gain.setTargetAtTime(watched ? Math.max(this.options.watchedLevel, 0) : 0, now, fade);
    // One small shift in the leaves every twenty seconds or so. Not a rhythm,
    // not a warning, and easy to put down to the wind.
    this.watchScheduler.setRate(watched ? 1 / 18 : 0, now);
  }

  /* ------------------------------------------------------------ one-shots */

  /**
   * A call.
   *
   * Two-operator FM through a band-pass, repeated as the species repeats
   * itself, with a breath layer for the ones that are more animal than bird.
   * Alarm shortens and sharpens it: a worried animal calls higher and tighter.
   */
  call(animal: Pick<WildlifeAnimalAudio, 'id' | 'speciesId' | 'shyness' | 'curiosity' | 'x' | 'y' | 'z' | 'distanceM' | 'alarm'>, when?: number): number {
    if (this.disposed) return 0;
    const spec = individualVoice(this.voiceFor(animal.speciesId, animal.shyness, animal.curiosity), animal.id);
    const slot = this.slotFor(when ?? this.deps.ctx.currentTime);
    this.place(slot, animal.x, animal.y, animal.z);
    const end = this.spawnCall(slot, spec, clamp01(animal.alarm), animal.distanceM, when);
    slot.busyUntil = end;
    this.callsPlayed += 1;
    return end;
  }

  private spawnCall(
    slot: VoiceSlot,
    spec: WildlifeVoiceSpec,
    alarm: number,
    distanceM: number,
    when?: number,
  ): number {
    const ctx = this.deps.ctx;
    const rng = this.deps.rng;
    const shaping = this.deps.mixer.shaping;
    const t = slot.synth.at(when);

    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = distanceCutoffHz(distanceM, spec.filterHz * lerp(1, 1.35, alarm));
    filter.Q.value = spec.filterQ;
    const out = ctx.createGain();
    out.gain.value = 1;
    filter.connect(out);
    out.connect(slot.emitter.input);

    // Alarm tightens everything: shorter, higher, more of them.
    const stretch = lerp(1, 0.72, alarm);
    const lift = lerp(1, 1.18, alarm);
    const repeats = Math.min(6, spec.repeats + (alarm > 0.6 ? 1 : 0));
    const peak = Math.min(spec.peak * shaping.peakScale, shaping.ceiling);

    let cursor = t;
    for (let r = 0; r < repeats; r += 1) {
      const duration = spec.durationSeconds * stretch * rng.range(0.94, 1.07);
      const carrier = ctx.createOscillator();
      carrier.type = 'sine';
      carrier.detune.value = rng.range(-14, 14);
      const amp = ctx.createGain();
      amp.gain.value = 0;
      carrier.connect(amp);
      amp.connect(filter);

      const modulator = ctx.createOscillator();
      modulator.type = 'sine';
      modulator.frequency.value = safeFrequency(spec.startHz * spec.modRatio, ctx.sampleRate);
      const modDepth = ctx.createGain();
      modDepth.gain.value = spec.modIndex;
      modulator.connect(modDepth);
      modDepth.connect(carrier.frequency);

      const f = carrier.frequency;
      f.setValueAtTime(safeFrequency(spec.startHz * lift, ctx.sampleRate), cursor);
      f.linearRampToValueAtTime(safeFrequency(spec.endHz * lift, ctx.sampleRate), cursor + duration);

      const attack = Math.min(duration * 0.3, 0.02 * shaping.attackScale);
      amp.gain.setValueAtTime(0, cursor);
      amp.gain.linearRampToValueAtTime(peak * rng.range(0.82, 1), cursor + attack);
      amp.gain.setTargetAtTime(0, cursor + duration * 0.55, duration * 0.25);
      amp.gain.setValueAtTime(0, cursor + duration + 0.12);

      carrier.start(cursor);
      carrier.stop(cursor + duration + 0.15);
      modulator.start(cursor);
      modulator.stop(cursor + duration + 0.15);

      if (spec.breath > 0.05) {
        // The air behind the voice. Everything with lungs has some.
        slot.synth.noiseBurst(
          cursor,
          distanceCutoffHz(distanceM, spec.filterHz * 1.6),
          1.4,
          attack,
          duration * 0.4,
          peak * spec.breath * 0.5,
          'bandpass',
          undefined,
          out,
        );
      }
      cursor += duration + spec.gapSeconds;
    }
    slot.synth.cleanupLater([filter, out], cursor - t + 0.4);
    return cursor;
  }

  /**
   * Something moving in the undergrowth: leaf litter, a scatter of grains with
   * a soft body under it. `effort` separates a careful step from a scramble.
   */
  rustle(x: number, y: number, z: number, distanceM: number, effort = 0.5, when?: number): number {
    if (this.disposed) return 0;
    const rng = this.deps.rng;
    const slot = this.slotFor(when ?? this.deps.ctx.currentTime);
    this.place(slot, x, y, z);
    const t = slot.synth.at(when);
    const force = clamp01(effort);
    const bright = distanceCutoffHz(distanceM, 5200);

    // The body of the step: soft, low, barely pitched.
    let end = slot.synth.thump(t, lerp(78, 132, force), lerp(48, 70, force), 0.03, 0.04, 0.05 + 0.09 * force);
    const grains = 4 + Math.round(force * 9);
    for (let i = 0; i < grains; i += 1) {
      const u = rng.next();
      end = Math.max(
        end,
        slot.synth.grain(
          t + u * u * lerp(0.06, 0.16, force),
          0.7,
          bright * rng.range(0.45, 1.05),
          rng.range(1.2, 3.4),
          0.0005,
          rng.range(0.006, 0.022),
          (0.035 + 0.07 * force) * rng.range(0.4, 1),
          rng.range(0.85, 1.45),
        ),
      );
    }
    slot.busyUntil = end;
    return end;
  }

  /** A twig going. The loudest thing a careless animal does. */
  twigSnap(x: number, y: number, z: number, distanceM: number, when?: number): number {
    if (this.disposed) return 0;
    const slot = this.slotFor(when ?? this.deps.ctx.currentTime);
    this.place(slot, x, y, z);
    const t = slot.synth.at(when);
    const bright = distanceCutoffHz(distanceM, 3600);
    slot.synth.noiseBurst(t, bright, 1.8, 0.0005, 0.008, 0.16, 'bandpass', bright * 0.55);
    // Near-harmonic partials: this is wood.
    const end = slot.synth.modalRing(t, [560, 1090, 1720], 12, 0.035, 0.13, slot.emitter.input, 0.5);
    slot.busyUntil = end;
    return end;
  }

  /**
   * Something bolting.
   *
   * A hard scramble away from the camp, and — for the species whose voice says
   * so — wingbeats. Loud by the standards of this layer and still nothing like
   * a scare: it is over in half a second and it recedes.
   */
  startle(animal: Pick<WildlifeAnimalAudio, 'speciesId' | 'shyness' | 'curiosity' | 'x' | 'y' | 'z' | 'distanceM'>, when?: number): number {
    if (this.disposed) return 0;
    const spec = this.voiceFor(animal.speciesId, animal.shyness, animal.curiosity);
    const rng = this.deps.rng;
    const slot = this.slotFor(when ?? this.deps.ctx.currentTime);
    this.place(slot, animal.x, animal.y, animal.z);
    const t = slot.synth.at(when);
    const bright = distanceCutoffHz(animal.distanceM, 4600);

    // The bolt: a burst of scrambling that thins out as it goes.
    let end = slot.synth.noiseBurst(t, bright, 1.1, 0.004, 0.13, 0.34, 'bandpass', bright * 0.35);
    for (let i = 0; i < 9; i += 1) {
      const u = i / 9;
      end = Math.max(
        end,
        slot.synth.grain(
          t + u * 0.34 + rng.range(0, 0.02),
          0.7,
          bright * rng.range(0.4, 1),
          rng.range(1, 3),
          0.0005,
          rng.range(0.006, 0.02),
          0.16 * (1 - u * 0.7),
          rng.range(0.8, 1.4),
        ),
      );
    }

    if (spec.wingbeat) {
      // Wingbeats: low broadband thumps at about ten a second, slowing.
      let interval = 0.09;
      let at = t + 0.03;
      for (let i = 0; i < 6; i += 1) {
        end = Math.max(
          end,
          slot.synth.noiseBurst(at, lerp(320, 180, i / 6), 0.9, 0.006, 0.035, 0.26 * (1 - i * 0.11), 'lowpass'),
        );
        at += interval;
        interval *= 1.09;
      }
    }
    slot.busyUntil = end;
    return end;
  }

  /**
   * An animal taking something: a small knock as it is picked up, then the
   * drag of it going.
   */
  tookObject(x: number, y: number, z: number, distanceM: number, when?: number): number {
    if (this.disposed) return 0;
    const slot = this.slotFor(when ?? this.deps.ctx.currentTime);
    this.place(slot, x, y, z);
    const t = slot.synth.at(when);
    const bright = distanceCutoffHz(distanceM, 3000);
    slot.synth.thump(t, 150, 88, 0.02, 0.035, 0.16);
    slot.synth.modalRing(t + 0.002, [430, 812, 1290], 10, 0.03, 0.12, slot.emitter.input, 0.45);
    // Dragged away over leaf litter.
    const end = slot.synth.noiseBurst(t + 0.07, bright * 0.6, 1.3, 0.03, 0.16, 0.09, 'bandpass', bright * 0.28);
    slot.busyUntil = end;
    return end;
  }

  /* --------------------------------------------------------------- pumping */

  pump(now: number): number {
    if (!this.started || this.disposed) return 0;
    const horizon = this.window.advance(now);
    if (horizon === null) return 0;

    let scheduled = 0;
    const moves = this.movementScheduler.collect(horizon, this.eventTimes);
    for (let i = 0; i < moves; i += 1) {
      const at = this.eventTimes[i] ?? now;
      const animal = this.pick('rate');
      if (!animal) break;
      // Most of what you hear is leaf litter; every so often a twig goes, and a
      // fleeing animal is far less careful about it.
      const careless = animal.phase === 'fleeing' || animal.phase === 'startled';
      if (this.deps.rng.bool(careless ? 0.22 : 0.07)) {
        this.twigSnap(animal.x, animal.y, animal.z, animal.distanceM, at);
      } else {
        const effort = careless ? 0.85 : animal.phase === 'investigating' ? 0.4 : 0.25;
        this.rustle(animal.x, animal.y, animal.z, animal.distanceM, effort, at);
      }
      scheduled += 1;
    }

    const calls = this.callScheduler.collect(horizon, this.eventTimes);
    for (let i = 0; i < calls; i += 1) {
      const at = this.eventTimes[i] ?? now;
      const animal = this.pick('voiceRate');
      if (!animal) break;
      this.call(animal, at);
      scheduled += 1;
    }

    const watches = this.watchScheduler.collect(horizon, this.eventTimes);
    for (let i = 0; i < watches; i += 1) {
      // A single, very quiet shift. Never a stinger — the same rustle everything
      // else uses, at the lowest effort it has.
      const at = this.eventTimes[i] ?? now;
      const animal = this.pickWatcher();
      if (!animal) break;
      this.rustle(animal.x, animal.y, animal.z, animal.distanceM, 0.12, at);
      scheduled += 1;
    }
    return scheduled;
  }

  /** Choose which animal a scheduled event belongs to, weighted by its own rate. */
  private pick(field: 'rate' | 'voiceRate'): TrackedAnimal | null {
    let total = 0;
    for (let i = 0; i < this.animalCount; i += 1) total += this.animals[i]?.[field] ?? 0;
    if (total <= 0) return null;
    let ticket = this.deps.rng.next() * total;
    for (let i = 0; i < this.animalCount; i += 1) {
      const animal = this.animals[i];
      if (!animal) continue;
      ticket -= animal[field];
      if (ticket <= 0) return animal;
    }
    return this.animals[this.animalCount - 1] ?? null;
  }

  private pickWatcher(): TrackedAnimal | null {
    for (let i = 0; i < this.animalCount; i += 1) {
      const animal = this.animals[i];
      if (animal && animal.phase === 'watching') return animal;
    }
    return null;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const end = this.deps.ctx.currentTime + 0.05;
    safeStop(this.watchedSource, end);
    safeDisconnect(this.watchedFilter);
    safeDisconnect(this.watchedGain);
    this.watchedEmitter?.dispose();
    for (const slot of this.slots) slot.emitter.dispose();
    this.slots.length = 0;
    this.animals.length = 0;
    this.animalCount = 0;
    safeDisconnect(this.output);
  }
}
