/**
 * `AudioEngine` — the single entry point for the game.
 *
 * Lifecycle: constructing an engine touches nothing. No AudioContext exists
 * until `resume()` is called from a real user gesture, which is both what
 * browsers require and what makes the whole module importable in Node. Volumes,
 * mute, the reduced-intensity flag and the ambience profile can all be set
 * before the context exists and are applied when the graph is built.
 *
 * Graph:
 *
 *   layer -> [spatial emitter] -> bus gain -+-> master gain -> limiter -> out
 *                                           |
 *                                           +-> reverb send -> convolver ---^
 *
 * The limiter is a safety net, not a mix tool: it exists so that no combination
 * of simulation state can produce a painful peak.
 */

import type { AmbienceConditions, AmbienceProfile, AmbienceOptions } from './ambience.js';
import { DEFAULT_AMBIENCE_PROFILE, NightAmbience } from './ambience.js';
import type { NoiseBankOptions } from './buffers.js';
import { NoiseBank } from './buffers.js';
import type { BusName, MixerSnapshot } from './buses.js';
import { BUS_NAMES, MixerState } from './buses.js';
import type { AudioContextFactory } from './context.js';
import { createAudioContext, isAudioContextSupported, safeDisconnect } from './context.js';
import type { FireAudioState, FireBedOptions } from './fire.js';
import { FireBed } from './fire.js';
import type { FoleyOptions, SizzleState } from './foley.js';
import { FoleyKit } from './foley.js';
import { ImpulseCache, type SpaceType } from './impulse.js';
import type { LayerDeps, PumpableLayer } from './layer.js';
import type { MachineKitOptions } from './machine.js';
import { MachineKit } from './machine.js';
import type { ReverbOptions } from './reverb.js';
import { DEFAULT_REVERB_SENDS, ReverbBus } from './reverb.js';
import type { Rng } from './rng.js';
import { createRng, hashSeed } from './rng.js';
import type { SpatialOptions, SpatialQuality, Vec3 } from './spatial.js';
import { SpatialEmitter, updateListener } from './spatial.js';

export type EngineStatus = 'idle' | 'running' | 'suspended' | 'closed' | 'unsupported';

export interface AudioEngineOptions {
  /** Injected for tests, or to pin a sample rate. Defaults to the platform constructor. */
  contextFactory?: AudioContextFactory;
  sampleRate?: number;
  /** Number or string; strings are hashed. Makes a campsite sound identical everywhere. */
  seed?: number | string;
  spatialQuality?: SpatialQuality;
  /** Place the fire and the machine in 3D rather than connecting them dry to their bus. */
  spatialiseLayers?: boolean;
  ambienceProfile?: AmbienceProfile;
  reverb?: Partial<ReverbOptions>;
  mixer?: Partial<MixerSnapshot>;
  noiseBank?: Partial<NoiseBankOptions>;
  fire?: Partial<FireBedOptions>;
  ambience?: Partial<AmbienceOptions>;
  machine?: Partial<MachineKitOptions>;
  foley?: Partial<FoleyOptions>;
  /** Internal scheduling timer, in ms. 0 disables it so a host can drive `pump` itself. */
  pumpIntervalMs?: number;
}

/** Limiter settings. The reduced-intensity variant clamps harder and earlier. */
/** Default RNG seed when the host does not supply one. */
const DEFAULT_SEED = hashSeed('some-more');

const LIMITER_NORMAL = { threshold: -6, knee: 6, ratio: 12, attack: 0.003, release: 0.25 };
const LIMITER_REDUCED = { threshold: -16, knee: 12, ratio: 20, attack: 0.001, release: 0.4 };

export class AudioEngine {
  readonly mixer: MixerState;
  private readonly options: AudioEngineOptions;
  private readonly seed: number;
  private readonly impulses = new ImpulseCache();

  private ctx: AudioContext | null = null;
  private rngValue: Rng;
  private bank: NoiseBank | null = null;
  private masterGain: GainNode | null = null;
  private limiter: DynamicsCompressorNode | null = null;
  private busGains: Partial<Record<BusName, GainNode>> = {};
  private reverbBus: ReverbBus | null = null;
  private fireLayer: FireBed | null = null;
  private ambienceLayer: NightAmbience | null = null;
  private machineLayer: MachineKit | null = null;
  private foleyLayer: FoleyKit | null = null;
  private fireEmitterValue: SpatialEmitter | null = null;
  private machineEmitterValue: SpatialEmitter | null = null;
  private readonly emitters = new Set<SpatialEmitter>();
  private readonly pumpables: PumpableLayer[] = [];
  private pumpTimer: ReturnType<typeof setInterval> | null = null;
  private statusValue: EngineStatus = 'idle';
  private ambienceProfileValue: AmbienceProfile;
  private unsubscribeMixer: (() => void) | null = null;

  constructor(options: AudioEngineOptions = {}) {
    this.options = options;
    this.seed = typeof options.seed === 'string' ? hashSeed(options.seed) : (options.seed ?? DEFAULT_SEED);
    this.rngValue = createRng(this.seed);
    this.mixer = new MixerState(options.mixer);
    this.ambienceProfileValue = options.ambienceProfile ?? DEFAULT_AMBIENCE_PROFILE;
  }

  /* ------------------------------------------------------------ inspection */

  get status(): EngineStatus {
    return this.statusValue;
  }

  get context(): AudioContext | null {
    return this.ctx;
  }

  get initialized(): boolean {
    return this.ctx !== null;
  }

  static get supported(): boolean {
    return isAudioContextSupported();
  }

  get fire(): FireBed | null {
    return this.fireLayer;
  }

  get ambience(): NightAmbience | null {
    return this.ambienceLayer;
  }

  get machine(): MachineKit | null {
    return this.machineLayer;
  }

  get foley(): FoleyKit | null {
    return this.foleyLayer;
  }

  get reverb(): ReverbBus | null {
    return this.reverbBus;
  }

  get rng(): Rng {
    return this.rngValue;
  }

  /** The `GainNode` for a bus, or null before the graph exists. */
  busInput(bus: BusName): GainNode | null {
    return this.busGains[bus] ?? null;
  }

  get fireEmitter(): SpatialEmitter | null {
    return this.fireEmitterValue;
  }

  get machineEmitter(): SpatialEmitter | null {
    return this.machineEmitterValue;
  }

  /* -------------------------------------------------------------- lifecycle */

  /**
   * Create the context if needed and start (or restart) audio. Must be called
   * from a user gesture the first time. Returns false when WebAudio is
   * unavailable — the game must remain fully playable in that case.
   */
  async resume(): Promise<boolean> {
    if (!this.ctx) {
      const factory = this.options.contextFactory ?? createAudioContext;
      const created = factory(this.options.sampleRate ? { sampleRate: this.options.sampleRate } : undefined);
      if (!created) {
        this.statusValue = 'unsupported';
        return false;
      }
      this.ctx = created;
      this.build(created);
    }
    const ctx = this.ctx;
    if (typeof ctx.resume === 'function' && ctx.state !== 'running') {
      try {
        await ctx.resume();
      } catch {
        /* the browser may still be waiting for a gesture */
      }
    }
    this.statusValue = ctx.state === 'suspended' ? 'suspended' : 'running';
    this.startPumpTimer();
    return this.statusValue === 'running';
  }

  async suspend(): Promise<void> {
    this.stopPumpTimer();
    const ctx = this.ctx;
    if (!ctx) return;
    if (typeof ctx.suspend === 'function' && ctx.state === 'running') {
      try {
        await ctx.suspend();
      } catch {
        /* ignore */
      }
    }
    this.statusValue = 'suspended';
  }

  /** Tear everything down. The engine can be `resume()`d again afterwards. */
  async close(): Promise<void> {
    this.stopPumpTimer();
    this.unsubscribeMixer?.();
    this.unsubscribeMixer = null;
    this.fireLayer?.dispose();
    this.ambienceLayer?.dispose();
    this.machineLayer?.dispose();
    this.foleyLayer?.dispose();
    for (const emitter of this.emitters) emitter.dispose();
    this.emitters.clear();
    this.reverbBus?.dispose();
    for (const bus of BUS_NAMES) safeDisconnect(this.busGains[bus]);
    safeDisconnect(this.masterGain);
    safeDisconnect(this.limiter);
    this.bank?.dispose();

    this.fireLayer = null;
    this.ambienceLayer = null;
    this.machineLayer = null;
    this.foleyLayer = null;
    this.fireEmitterValue = null;
    this.machineEmitterValue = null;
    this.reverbBus = null;
    this.busGains = {};
    this.masterGain = null;
    this.limiter = null;
    this.bank = null;
    this.pumpables.length = 0;

    const ctx = this.ctx;
    this.ctx = null;
    this.statusValue = 'closed';
    if (ctx && typeof ctx.close === 'function') {
      try {
        await ctx.close();
      } catch {
        /* already closed */
      }
    }
  }

  private build(ctx: AudioContext): void {
    this.rngValue = createRng(this.seed);
    this.bank = new NoiseBank(ctx, this.options.noiseBank);

    this.limiter = ctx.createDynamicsCompressor();
    this.applyLimiterSettings();
    this.limiter.connect(ctx.destination);

    this.masterGain = ctx.createGain();
    this.masterGain.gain.value = this.mixer.masterGain();
    this.masterGain.connect(this.limiter);

    for (const bus of BUS_NAMES) {
      const gain = ctx.createGain();
      gain.gain.value = this.mixer.busGain(bus);
      gain.connect(this.masterGain);
      this.busGains[bus] = gain;
    }

    this.reverbBus = new ReverbBus(
      ctx,
      this.masterGain,
      { space: this.ambienceProfileValue.reverb.space, wet: this.ambienceProfileValue.reverb.wet, ...this.options.reverb },
      this.impulses,
    );
    for (const bus of BUS_NAMES) {
      const gain = this.busGains[bus];
      if (gain) this.reverbBus.createSend(bus, gain, DEFAULT_REVERB_SENDS[bus]);
    }

    const spatialise = this.options.spatialiseLayers !== false;
    const spatialOptions: Partial<SpatialOptions> = { panningModel: this.options.spatialQuality ?? 'auto' };

    const fireBusInput = this.busGains.fire;
    const machineBusInput = this.busGains.machine;
    let fireDestination: AudioNode | undefined = fireBusInput;
    let machineDestination: AudioNode | undefined = machineBusInput;

    if (spatialise && fireBusInput) {
      this.fireEmitterValue = new SpatialEmitter(ctx, fireBusInput, { ...spatialOptions, refDistance: 1.5, maxDistance: 40 });
      this.emitters.add(this.fireEmitterValue);
      fireDestination = this.fireEmitterValue.input;
    }
    if (spatialise && machineBusInput) {
      this.machineEmitterValue = new SpatialEmitter(ctx, machineBusInput, { ...spatialOptions, refDistance: 2, maxDistance: 55 });
      this.emitters.add(this.machineEmitterValue);
      machineDestination = this.machineEmitterValue.input;
    }

    const deps = (destination: AudioNode): LayerDeps => ({
      ctx,
      destination,
      bank: this.bank as NoiseBank,
      rng: this.rngValue,
      mixer: this.mixer,
    });

    if (fireDestination) {
      this.fireLayer = new FireBed(deps(fireDestination), this.options.fire);
      this.pumpables.push(this.fireLayer);
    }
    const ambienceBus = this.busGains.ambience;
    if (ambienceBus) {
      this.ambienceLayer = new NightAmbience(deps(ambienceBus), this.ambienceProfileValue, this.options.ambience);
      this.pumpables.push(this.ambienceLayer);
    }
    if (machineDestination) {
      this.machineLayer = new MachineKit(deps(machineDestination), this.options.machine);
      this.pumpables.push(this.machineLayer);
    }
    const foleyBus = this.busGains.foley;
    if (foleyBus) {
      this.foleyLayer = new FoleyKit(deps(foleyBus), this.options.foley);
      this.pumpables.push(this.foleyLayer);
    }

    this.unsubscribeMixer = this.mixer.subscribe((change) => this.onMixerChange(change));
  }

  private onMixerChange(change: BusName | 'master' | 'mute' | 'reducedIntensity'): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const now = ctx.currentTime;
    if (change === 'reducedIntensity') {
      this.applyLimiterSettings();
      return;
    }
    if (change === 'master' || change === 'mute') {
      this.masterGain?.gain.setTargetAtTime(this.mixer.masterGain(), now, 0.02);
      // A restore() can change every bus at once, so refresh them all.
      for (const bus of BUS_NAMES) {
        this.busGains[bus]?.gain.setTargetAtTime(this.mixer.busGain(bus), now, 0.02);
      }
      return;
    }
    this.busGains[change]?.gain.setTargetAtTime(this.mixer.busGain(change), now, 0.02);
  }

  private applyLimiterSettings(): void {
    const limiter = this.limiter;
    if (!limiter) return;
    const settings = this.mixer.reducedAudioIntensity ? LIMITER_REDUCED : LIMITER_NORMAL;
    limiter.threshold.value = settings.threshold;
    limiter.knee.value = settings.knee;
    limiter.ratio.value = settings.ratio;
    limiter.attack.value = settings.attack;
    limiter.release.value = settings.release;
  }

  /* ------------------------------------------------------------------ mixer */

  setBusVolume(bus: BusName, volume: number): void {
    this.mixer.setBusVolume(bus, volume);
  }

  getBusVolume(bus: BusName): number {
    return this.mixer.getBusVolume(bus);
  }

  setMasterVolume(volume: number): void {
    this.mixer.setMasterVolume(volume);
  }

  getMasterVolume(): number {
    return this.mixer.getMasterVolume();
  }

  setMuted(muted: boolean): void {
    this.mixer.setMuted(muted);
  }

  toggleMute(): boolean {
    return this.mixer.toggleMute();
  }

  get muted(): boolean {
    return this.mixer.muted;
  }

  /**
   * Accessibility: tames sudden loud transients. Peaks are scaled, attacks are
   * stretched, and the safety limiter clamps earlier and harder.
   */
  setReducedAudioIntensity(reduced: boolean): void {
    this.mixer.setReducedAudioIntensity(reduced);
  }

  get reducedAudioIntensity(): boolean {
    return this.mixer.reducedAudioIntensity;
  }

  snapshot(): MixerSnapshot {
    return this.mixer.snapshot();
  }

  /* --------------------------------------------------------------- content */

  get ambienceProfile(): Readonly<AmbienceProfile> {
    return this.ambienceProfileValue;
  }

  /** Swap campsite. Applies the profile's reverb space too. */
  setAmbienceProfile(profile: AmbienceProfile): void {
    this.ambienceProfileValue = profile;
    this.ambienceLayer?.setProfile(profile);
    this.reverbBus?.setSpace(profile.reverb.space);
    this.reverbBus?.setWet(profile.reverb.wet);
  }

  setSpace(space: SpaceType, wet?: number): void {
    this.reverbBus?.setSpace(space);
    if (wet !== undefined) this.reverbBus?.setWet(wet);
  }

  /** Convenience passthrough; no-op before `resume()`. */
  setFireState(state: Partial<FireAudioState>): void {
    this.fireLayer?.setState(state);
  }

  setAmbienceConditions(conditions: Partial<AmbienceConditions>): void {
    this.ambienceLayer?.setConditions(conditions);
  }

  setSizzleState(state: Partial<SizzleState>): void {
    this.foleyLayer?.setSizzleState(state);
  }

  /** Start the continuous beds. Safe to call repeatedly. */
  startBeds(): void {
    this.fireLayer?.start();
    this.ambienceLayer?.start();
  }

  stopBeds(): void {
    this.fireLayer?.stop();
    this.ambienceLayer?.stop();
  }

  /* -------------------------------------------------------------- spatial */

  /** Move the listener. `forward`/`up` need not be orthonormal. */
  listenerUpdate(position: Vec3, forward: Vec3, up: Vec3): void {
    if (!this.ctx) return;
    updateListener(this.ctx, position, forward, up);
  }

  setFirePosition(x: number, y: number, z: number): void {
    this.fireEmitterValue?.setPosition(x, y, z);
  }

  setMachinePosition(x: number, y: number, z: number): void {
    this.machineEmitterValue?.setPosition(x, y, z);
  }

  /**
   * A positioned source on `bus`. Anything can be connected to `emitter.input`,
   * including a remote player's `MediaStream` via `attachMediaStream` — which is
   * how multiplayer spatial voice will attach to this same panner path.
   */
  createEmitter(bus: BusName, options: Partial<SpatialOptions> = {}): SpatialEmitter | null {
    const ctx = this.ctx;
    const target = this.busGains[bus];
    if (!ctx || !target) return null;
    const emitter = new SpatialEmitter(
      ctx,
      target,
      { panningModel: this.options.spatialQuality ?? 'auto', ...options },
      this.emitters.size,
    );
    this.emitters.add(emitter);
    return emitter;
  }

  releaseEmitter(emitter: SpatialEmitter): void {
    if (!this.emitters.delete(emitter)) return;
    emitter.dispose();
  }

  get emitterCount(): number {
    return this.emitters.size;
  }

  /* --------------------------------------------------------------- pumping */

  /**
   * Drive every stochastic layer's look-ahead scheduling. Called automatically
   * on a timer; a host that prefers to own the loop can pass
   * `pumpIntervalMs: 0` and call this itself. Returns the number of events
   * scheduled across all layers.
   */
  pump(now?: number): number {
    const ctx = this.ctx;
    if (!ctx) return 0;
    const time = now ?? ctx.currentTime;
    let total = 0;
    for (let i = 0; i < this.pumpables.length; i += 1) {
      const layer = this.pumpables[i];
      if (layer) total += layer.pump(time);
    }
    return total;
  }

  private startPumpTimer(): void {
    if (this.pumpTimer !== null) return;
    const interval = this.options.pumpIntervalMs ?? 60;
    if (interval <= 0) return;
    const timer = (globalThis as { setInterval?: typeof setInterval }).setInterval;
    if (typeof timer !== 'function') return;
    this.pumpTimer = timer(() => {
      this.pump();
    }, interval);
  }

  private stopPumpTimer(): void {
    if (this.pumpTimer === null) return;
    const clear = (globalThis as { clearInterval?: typeof clearInterval }).clearInterval;
    if (typeof clear === 'function') clear(this.pumpTimer);
    this.pumpTimer = null;
  }
}
