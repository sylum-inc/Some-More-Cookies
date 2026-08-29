/**
 * Bridges the simulation to the audio engine.
 *
 * The simulation knows nothing about audio (ADR-0001), and the audio engine
 * knows nothing about the ritual. This is the single place the two meet, so
 * the mapping from world state to sound is inspectable in one file.
 */

import {
  fireSignals,
  isEmberBed,
  type MachineEvent,
  type RitualState,
} from '@somemore/sim';
import { AudioEngine } from './engine.js';
import { AMBIENCE_PRESETS } from './ambience.js';
import type { AudioSettings } from '../state/store.js';

export type FoleySound = 'blow-out' | 'graham-snap' | 'chocolate-fracture' | 'squish' | 'bite' | 'stick';

export class AudioBridge {
  private engine: AudioEngine | null = null;
  private started = false;
  private pendingSettings: AudioSettings | null = null;
  private lastCompressor = 0;
  private lastFan = 0;
  private crtOn = false;

  /** Called from a user gesture — browsers require one before audio starts. */
  async unlock(): Promise<boolean> {
    if (!this.engine) {
      try {
        this.engine = new AudioEngine({ ambienceProfile: AMBIENCE_PRESETS.pineRidge });
      } catch {
        // No WebAudio at all: the product must still be fully playable, so
        // this fails silently and every later call becomes a no-op.
        return false;
      }
    }
    const ok = await this.engine.resume();
    if (ok && !this.started) {
      this.engine.startBeds();
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

  /** Called once per simulation step. */
  update(ritual: RitualState): void {
    const engine = this.engine;
    if (!engine || !this.started) return;

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
      if (ritual.marshmallow.ignitedThisStep) foley.ignitionWhoosh();
      if (ritual.marshmallow.extinguishedThisStep) foley.blowOut();
    }

    void isEmberBed;
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
    void this.engine?.close();
    this.engine = null;
    this.started = false;
  }
}
