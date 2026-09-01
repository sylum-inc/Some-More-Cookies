/**
 * Bridges the simulation to the audio engine.
 *
 * The simulation knows nothing about audio (ADR-0001), and the audio engine
 * knows nothing about the ritual. This is the single place the two meet, so
 * the mapping from world state to sound is inspectable in one file.
 */

import {
  animalsPresentInto,
  currentReception,
  currentSegment,
  describeReception,
  describeSighting,
  fireSignals,
  isEmberBed,
  wildlifeSignals,
  type WildlifeAnimal,
  type MachineEvent,
  type RadioEvent,
  type RitualState,
  type WildlifeEvent,
} from '@somemore/sim';
import { AudioEngine, type AudioEngineOptions } from './engine.js';
import { AMBIENCE_PRESETS, ambienceFromCampsite, type CampsiteAmbienceSpec } from './ambience.js';
import { hashSeed } from './rng.js';
import type { RadioProgramme } from './radio.js';
import type { WildlifeAnimalAudio } from './wildlife.js';
import type { AudioSettings } from '../state/store.js';

export type FoleySound = 'blow-out' | 'graham-snap' | 'chocolate-fracture' | 'squish' | 'bite' | 'stick';

/** Structural: `Vec3` from the simulation and a THREE.Vector3 both satisfy it. */
export interface Vec3Like {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/**
 * A line describing something the player just *heard*.
 *
 * Spec §12: no information travels through one channel only, so anything the
 * radio or the wildlife layer says out loud has to be sayable in text as well.
 * The copy comes from `describeReception` and `describeSighting` in the
 * simulation — the bridge never invents a parallel vocabulary — and the caller
 * decides whether the player has subtitles switched on. That keeps the audio
 * engine free of any dependency on the store.
 */
export interface AudioCue {
  readonly kind: 'radio' | 'wildlife';
  readonly text: string;
}

/**
 * A reader over one of the simulation's rolling event logs.
 *
 * `ritual.radioEvents` and `ritual.wildlifeEvents` are bounded *logs*, not
 * queues: nothing drains them, and old entries fall off the front. Replaying
 * the whole log every frame would fire the same call sixty times a second, so
 * this remembers the last entry it handled and hands back only what has arrived
 * since. If the log rolled over completely between two updates (a long stall,
 * or a tab that was backgrounded) the anchor is gone; the reader then plays
 * only the newest few, because dumping sixty banked one-shots into the mix at
 * once is worse than missing some.
 */
class EventLogReader<T> {
  private last: T | null = null;

  constructor(private readonly burstLimit = 4) {}

  take(log: readonly T[], out: T[]): T[] {
    out.length = 0;
    if (log.length === 0) {
      this.last = null;
      return out;
    }
    const anchor = this.last;
    let from = 0;
    if (anchor !== null) {
      const index = log.lastIndexOf(anchor);
      from = index >= 0 ? index + 1 : Math.max(0, log.length - this.burstLimit);
    }
    for (let i = Math.max(from, log.length - this.burstLimit); i < log.length; i += 1) {
      const event = log[i];
      if (event !== undefined) out.push(event);
    }
    this.last = log[log.length - 1] ?? null;
    return out;
  }

  reset(): void {
    this.last = null;
  }
}

export class AudioBridge {
  private engineValue: AudioEngine | null = null;
  private started = false;
  private pendingSettings: AudioSettings | null = null;
  private lastCompressor = 0;
  private lastFan = 0;
  private crtOn = false;
  private marshmallowBurning = false;

  // --- radio ---------------------------------------------------------------
  private radioOn = false;
  private radioBand: string | null = null;
  private radioStationId: string | null = null;
  private radioSegmentIndex = -1;
  private bleedStationId: string | null = null;
  private bleedSegmentIndex = -1;
  private readonly radioEvents = new EventLogReader<RadioEvent>();
  private readonly radioScratch: RadioEvent[] = [];

  // --- wildlife ------------------------------------------------------------
  private readonly wildlifeEvents = new EventLogReader<WildlifeEvent>();
  private readonly wildlifeScratch: WildlifeEvent[] = [];
  /** Rewritten in place every frame; the wildlife kit copies out of it. */
  private readonly animalScratch: WildlifeAnimalAudio[] = [];
  /** Reused between frames so the per-frame sort allocates nothing. */
  private readonly presentScratch: WildlifeAnimal[] = [];
  private watchedNow = false;

  /**
   * Move the listener.
   *
   * Without this every emitter in the engine sits at the origin along with the
   * listener, and nothing is anywhere: an animal behind you and an animal in
   * front of you sound identical, which is the one thing the wildlife layer
   * exists to avoid. `up` is assumed to be world up, which is true of this
   * camera; `updateListener` orthonormalises whatever it is given anyway.
   */
  listener(position: Vec3Like, forward: Vec3Like): void {
    this.engine?.listenerUpdate(
      { x: position.x, y: position.y, z: position.z },
      { x: forward.x, y: forward.y, z: forward.z },
      { x: 0, y: 1, z: 0 },
    );
  }

  /** Place the fixed emitters. The campsite layout lives in the scene, not here. */
  placeEmitters(positions: {
    fire?: readonly [number, number, number];
    machine?: readonly [number, number, number];
    radio?: readonly [number, number, number];
  }): void {
    const engine = this.engine;
    if (!engine) return;
    if (positions.fire) engine.setFirePosition(...positions.fire);
    if (positions.machine) engine.setMachinePosition(...positions.machine);
    if (positions.radio) engine.setRadioPosition(...positions.radio);
  }

  /**
   * @param engineOptions Merged over the bridge's defaults. Exists so a test
   * can inject a headless context; the game passes nothing.
   */
  constructor(private readonly engineOptions: AudioEngineOptions = {}) {}

  /**
   * The campsite this bridge is at, and therefore what it sounds like.
   *
   * Set before `unlock`, because the profile is handed to the engine when it
   * is built. Every campsite used to get `pineRidge` whatever it was, so a
   * snowfield with no insects and a canyon with a river in it were the same
   * bed of pine wind — twelve written soundscapes, one mix.
   */
  private campsite: { id: string; spec: CampsiteAmbienceSpec } | null = null;

  setCampsite(id: string, spec: CampsiteAmbienceSpec): void {
    this.campsite = { id, spec };
    // Already running: swap the bed rather than waiting for the next session.
    const engine = this.engineValue;
    if (engine) engine.setAmbienceProfile(ambienceFromCampsite(id, spec));
  }

  /** The engine, once unlocked. Read-only inspection, for tests and dev tools. */
  get engine(): AudioEngine | null {
    return this.engineValue;
  }

  /** Called from a user gesture — browsers require one before audio starts. */
  async unlock(): Promise<boolean> {
    if (!this.engineValue) {
      try {
        this.engineValue = new AudioEngine({
          ambienceProfile: this.campsite
            ? ambienceFromCampsite(this.campsite.id, this.campsite.spec)
            : AMBIENCE_PRESETS.pineRidge,
          ...this.engineOptions,
        });
      } catch {
        // No WebAudio at all: the product must still be fully playable, so
        // this fails silently and every later call becomes a no-op.
        return false;
      }
    }
    const ok = await this.engineValue.resume();
    if (ok && !this.started) {
      this.engineValue.startBeds();
      this.started = true;
      if (this.pendingSettings) this.applySettings(this.pendingSettings);
    }
    return ok;
  }

  applySettings(settings: AudioSettings): void {
    if (!this.engine) {
      this.pendingSettings = settings;
      return;
    }
    this.engine.setMasterVolume(settings.master);
    this.engine.setMuted(settings.muted);
    this.engine.setReducedAudioIntensity(settings.reducedIntensity);
    this.engine.setBusVolume('ambience', settings.ambience);
    this.engine.setBusVolume('fire', settings.fire);
    this.engine.setBusVolume('machine', settings.machine);
    this.engine.setBusVolume('foley', settings.foley);
    this.engine.setBusVolume('ui', settings.ui);
    this.engine.setBusVolume('voice', settings.voice);
  }

  /**
   * Called once per simulation step.
   *
   * Returns the line describing whatever was most worth *saying* this step, or
   * null. The caller decides what to do with it (spec §12 — subtitles); the
   * audio engine has no idea a settings store exists.
   */
  update(ritual: RitualState): AudioCue | null {
    const engine = this.engine;
    if (!engine || !this.started) return null;
    let cue: AudioCue | null = null;

    // --- Fire bed ---------------------------------------------------------
    const signals = fireSignals(ritual.fire);
    engine.setFireState({
      intensity: signals.intensity,
      emberHeat: signals.emberHeat,
      fuelLoad: signals.fuelLoad,
      windSpeed: Math.min(1, signals.windSpeed / 6),
      // Crackles are emitted as discrete events by the fire model, so the
      // continuous rate is derived from how lively the fire currently is.
      crackleRate: Math.min(1, ritual.fire.cracklesThisStep * 0.5 + signals.intensity * 0.35),
    });

    // --- Ambience ---------------------------------------------------------
    // Insects fall quiet when it is cold or wet; the engine handles that from
    // the conditions alone.
    engine.setAmbienceConditions({
      windSpeed: Math.min(1, ritual.weather.windSpeed / 6),
      temperatureC: ritual.weather.temperatureC,
      wetness: Math.min(1, ritual.weather.precipitation + ritual.weather.humidity * 0.3),
    });

    // --- Marshmallow sizzle ----------------------------------------------
    if (ritual.stage === 'roasting') {
      let heat = 0;
      let moisture = 0;
      let browning = 0;
      let scorch = 0;
      for (const patch of ritual.marshmallow.patches) {
        heat += Math.max(0, patch.temperatureC - 90);
        moisture += patch.moisture;
        browning += patch.brown;
        scorch += patch.char;
      }
      const count = Math.max(1, ritual.marshmallow.patches.length);
      engine.setSizzleState({
        heat: Math.min(1, heat / count / 120),
        moisture: Math.min(1, moisture / count / 0.45),
        browning: browning / count,
        scorch: scorch / count,
      });
    } else {
      engine.setSizzleState({ heat: 0, scorch: 0 });
    }

    // --- Machine events ---------------------------------------------------
    const kit = engine.machine;
    if (kit) {
      for (const event of ritual.machine.events) this.playMachineEvent(event);

      // Continuous machine state.
      const compressor = ritual.machine.compressor;
      if (compressor > 0.05 && this.lastCompressor <= 0.05) kit.compressorStart();
      if (compressor <= 0.05 && this.lastCompressor > 0.05) kit.compressorStop();
      this.lastCompressor = compressor;

      const fan = ritual.machine.fan;
      if (Math.abs(fan - this.lastFan) > 0.08) {
        kit.fanRamp(fan);
        this.lastFan = fan;
      }

      kit.frostCrackle(ritual.machine.frost);

      // The CRT whine belongs to the panel being awake, nothing more.
      const shouldWhine = ritual.machine.stage !== 'idle';
      if (shouldWhine !== this.crtOn) {
        kit.crtWhine(shouldWhine);
        this.crtOn = shouldWhine;
      }
    }

    // --- Marshmallow ignition --------------------------------------------
    const foley = engine.foley;
    if (foley) {
      /*
       * One whoosh per fire, not one per patch.
       *
       * The model tracks ignition per patch, correctly — thirty-two of them,
       * catching one after another as the flame spreads. Playing the whoosh on
       * every `ignitedThisStep` therefore fired it twenty-six times during a
       * single ten-second burn, roughly every four hundred milliseconds. A
       * marshmallow catches fire once and then burns; the spreading is what the
       * sustained flame is for, not a stutter of separate ignitions.
       */
      const burning = ritual.marshmallow.burning;
      if (burning && !this.marshmallowBurning) foley.ignitionWhoosh();
      this.marshmallowBurning = burning;
      if (ritual.marshmallow.extinguishedThisStep) foley.blowOut();
    }

    // --- Radio ------------------------------------------------------------
    const radioCue = this.updateRadio(ritual);
    if (radioCue) cue = radioCue;

    // --- Wildlife ---------------------------------------------------------
    const wildlifeCue = this.updateWildlife(ritual);
    // A sighting outranks a station identifying itself: it is the rarer event
    // and the one a player is more likely to have missed.
    if (wildlifeCue) cue = wildlifeCue;

    void isEmberBed;
    return cue;
  }

  /* ----------------------------------------------------------------- radio */

  /**
   * Continuous reception, edge-triggered power and band, and one programme
   * block per station slot.
   *
   * The same pattern as `compressorStart`/`compressorStop` above: the
   * simulation exposes state, not transitions, so the transitions are found by
   * comparing against what was last pushed into the kit.
   */
  private updateRadio(ritual: RitualState): AudioCue | null {
    const kit = this.engine?.radio;
    if (!kit) return null;
    const radio = ritual.radio;

    // Band first: changing band invalidates everything the receiver was hearing.
    if (radio.band !== this.radioBand) {
      if (this.radioBand !== null) kit.bandChange();
      this.radioBand = radio.band;
      this.radioStationId = null;
      this.radioSegmentIndex = -1;
      this.bleedStationId = null;
      this.bleedSegmentIndex = -1;
    }

    if (radio.on !== this.radioOn) {
      kit.setPower(radio.on);
      this.radioOn = radio.on;
      if (!radio.on) {
        this.radioStationId = null;
        this.radioSegmentIndex = -1;
        this.bleedStationId = null;
        this.bleedSegmentIndex = -1;
        this.radioEvents.reset();
      }
    }

    // The step has already computed exactly this reception, weather and
    // compressor noise included, so reading it costs nothing. Calling
    // `radioReadout` here allocated a fresh readout sixty times a second
    // against ARCHITECTURE §10.
    const readout = currentReception(ritual);
    kit.setReception({
      clarity: readout.clarity,
      hiss: readout.hiss,
      bleed: readout.bleed,
      // The SM-01's compressor is already folded into this by the simulation.
      hum: readout.hum,
      detune: readout.detune,
      halfWidth: radio.bands[radio.band].halfWidth,
      volume: radio.volume,
      band: radio.band,
    });

    if (radio.on) {
      this.syncStation(ritual, 'primary', readout.stationId);
      // Only bother synthesising the neighbour when it is actually audible.
      this.syncStation(ritual, 'bleed', readout.bleed > 0.08 ? readout.bleedFromId : null);
    }

    let cue: AudioCue | null = null;
    for (const event of this.radioEvents.take(ritual.radioEvents, this.radioScratch)) {
      // `locked` and `segment` are the two moments where what you are hearing
      // changes into something else describable.
      if (event.kind === 'locked' || event.kind === 'segment') {
        const line = describeReception(radio);
        if (line) cue = { kind: 'radio', text: line };
      }
    }
    return cue;
  }

  /** Push a station's current block into one of the receiver's two slots. */
  private syncStation(ritual: RitualState, slot: 'primary' | 'bleed', stationId: string | null): void {
    const kit = this.engine?.radio;
    if (!kit) return;
    const currentId = slot === 'primary' ? this.radioStationId : this.bleedStationId;
    const currentIndex = slot === 'primary' ? this.radioSegmentIndex : this.bleedSegmentIndex;

    if (!stationId) {
      if (currentId !== null) {
        kit.playSegment(slot, null);
        if (slot === 'primary') {
          this.radioStationId = null;
          this.radioSegmentIndex = -1;
        } else {
          this.bleedStationId = null;
          this.bleedSegmentIndex = -1;
        }
      }
      return;
    }

    const segment = currentSegment(ritual.radio, stationId);
    if (!segment) return;
    if (stationId === currentId && segment.index === currentIndex) return;

    const programme: RadioProgramme = {
      kind: segment.kind,
      // Straight from the simulation: this is the whole reason it hands one over.
      seed: segment.seed >>> 0,
      // Stable per station, so an ident is the same sting every time it airs.
      stationSeed: hashSeed(`station:${stationId}`),
      intensity: segment.intensity,
      durationSeconds: segment.durationSeconds,
    };
    kit.playSegment(slot, programme);
    if (slot === 'primary') {
      this.radioStationId = stationId;
      this.radioSegmentIndex = segment.index;
    } else {
      this.bleedStationId = stationId;
      this.bleedSegmentIndex = segment.index;
    }
  }

  /* -------------------------------------------------------------- wildlife */

  private updateWildlife(ritual: RitualState): AudioCue | null {
    const kit = this.engine?.wildlife;
    if (!kit) return null;

    // Continuous: where everything is, and what it is doing.
    const animals = animalsPresentInto(ritual, this.presentScratch);
    this.animalScratch.length = 0;
    for (const animal of animals) {
      this.animalScratch.push({
        id: animal.individual.id,
        speciesId: animal.species.id,
        shyness: animal.species.shyness,
        curiosity: animal.species.curiosity,
        x: animal.position.x,
        y: animal.position.y,
        z: animal.position.z,
        distanceM: animal.distanceM,
        phase: animal.phase,
        alarm: animal.alarm,
        interest: animal.interest,
      });
    }
    kit.setAnimals(this.animalScratch);

    const signals = wildlifeSignals(ritual.wildlife);
    if (signals.watched !== this.watchedNow || signals.watched) {
      const watcher = animals.find((animal) => animal.phase === 'watching' && animal.species.shyness > 0.6);
      kit.setWatched(
        signals.watched,
        watcher?.position.x ?? 0,
        watcher?.position.y ?? 0,
        watcher?.position.z ?? -5,
      );
      this.watchedNow = signals.watched;
    }

    // Edge-triggered: the log is a rolling readout, so only what is new plays.
    let cue: AudioCue | null = null;
    for (const event of this.wildlifeEvents.take(ritual.wildlifeEvents, this.wildlifeScratch)) {
      const animal = animals.find((candidate) => candidate.individual.id === event.individualId);
      const x = animal?.position.x ?? event.position.x;
      const y = animal?.position.y ?? event.position.y;
      const z = animal?.position.z ?? event.position.z;
      const distanceM = animal?.distanceM ?? Math.hypot(x, z);
      const species = animal?.species;
      const shyness = species?.shyness ?? event.rarity;
      const curiosity = species?.curiosity ?? 0.5;

      switch (event.kind) {
        case 'appeared':
          // Announcing itself, once, from wherever it came out of the dark.
          kit.call({
            id: event.individualId,
            speciesId: event.speciesId,
            shyness,
            curiosity,
            x,
            y,
            z,
            distanceM,
            alarm: animal?.alarm ?? 0,
          });
          cue = { kind: 'wildlife', text: describeSighting(event) };
          break;
        case 'startled':
          kit.startle({ speciesId: event.speciesId, shyness, curiosity, x, y, z, distanceM });
          break;
        case 'took-object':
          kit.tookObject(x, y, z, distanceM);
          break;
        case 'investigated':
          kit.rustle(x, y, z, distanceM, 0.45);
          break;
        case 'settled':
        case 'left-trace':
        case 'departed':
        default:
          // Nothing of their own: settling is the *absence* of noise, a trace is
          // a mark rather than a sound, and a departure is already covered by
          // the movement the animal makes on its way out.
          break;
      }
    }
    return cue;
  }

  private playMachineEvent(event: MachineEvent): void {
    const kit = this.engine?.machine;
    if (!kit) return;
    switch (event) {
      case 'latch-clunk':
      case 'latch-release':
        kit.latchClunk();
        break;
      case 'switch-detent':
      case 'lever-throw':
        kit.switchDetent();
        break;
      case 'relay-1':
        kit.relayClick(0);
        break;
      case 'relay-2':
        kit.relayClick(1);
        break;
      case 'relay-3':
        kit.relayClick(2);
        break;
      case 'refrigerant-flow':
        kit.refrigerantFlow();
        break;
      // The pull-down beats. A stage thermostat clicking out is a relay by any
      // other name, and a bleed-down before changeover is refrigerant moving —
      // so both are voiced from the existing kit rather than waiting on their
      // own synthesis. They are distinct *events* in the model, which is what
      // matters; giving them their own voices later changes nothing here.
      case 'thermostat-click':
        kit.relayClick(1);
        break;
      case 'pressure-equalise':
        kit.refrigerantFlow();
        break;
      case 'completion-tone':
        kit.completionTone();
        break;
      case 'door-seal':
      case 'door-open':
        kit.doorOpen();
        break;
      case 'vapour-release':
        kit.vaporRelease();
        break;
      case 'beep-confirm':
        kit.beep('confirm');
        break;
      case 'beep-reject':
        kit.beep('deny');
        break;
      default:
        break;
    }
  }

  playFoley(sound: FoleySound): void {
    const foley = this.engine?.foley;
    if (!foley) return;
    switch (sound) {
      case 'blow-out':
        foley.blowOut();
        break;
      case 'graham-snap':
      case 'bite':
        foley.grahamSnap();
        break;
      case 'chocolate-fracture':
        foley.chocolateFracture();
        break;
      case 'squish':
        foley.squish();
        break;
      case 'stick':
        foley.stickHandling();
        break;
      default:
        break;
    }
  }

  dispose(): void {
    void this.engineValue?.close();
    this.engineValue = null;
    this.started = false;
    this.radioOn = false;
    this.radioBand = null;
    this.radioStationId = null;
    this.radioSegmentIndex = -1;
    this.bleedStationId = null;
    this.bleedSegmentIndex = -1;
    this.watchedNow = false;
    this.radioEvents.reset();
    this.wildlifeEvents.reset();
  }
}
