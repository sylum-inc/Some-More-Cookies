/**
 * `apps/web/src/audio` — the fully procedural audio engine for Some More.
 *
 * Nothing here loads an asset; every sound is synthesised at runtime. See
 * `README.md` in this directory for the synthesis approach behind each sound
 * and for the simulation-state to audio-parameter mapping tables.
 *
 * Typical wiring:
 *
 * ```ts
 * const engine = new AudioEngine({ seed: campsiteId, ambienceProfile: AMBIENCE_PRESETS.lakeside });
 * button.addEventListener('click', async () => {
 *   if (await engine.resume()) engine.startBeds();
 * });
 * // every frame:
 * engine.setFireState({ intensity, emberHeat, fuelLoad, windSpeed, crackleRate });
 * ```
 */

export { AudioEngine } from './engine.js';
export type { AudioEngineOptions, EngineStatus } from './engine.js';

export { BUS_NAMES, BUS_DESCRIPTIONS, DEFAULT_BUS_VOLUMES, MixerState, gainToVolume, isBusName, volumeToGain } from './buses.js';
export type { BusName, MixerChange, MixerListener, MixerSnapshot } from './buses.js';

export {
  DEFAULT_FIRE_BED_OPTIONS,
  DEFAULT_FIRE_STATE,
  FireBed,
  MAX_CRACKLE_RATE,
  createFireVoiceParams,
  mapFireState,
} from './fire.js';
export type { FireAudioState, FireBedOptions, FireVoiceParams } from './fire.js';

export {
  AMBIENCE_PRESETS,
  BIRD_KINDS,
  BIRD_SPECS,
  DEFAULT_AMBIENCE_CONDITIONS,
  DEFAULT_AMBIENCE_OPTIONS,
  DEFAULT_AMBIENCE_PROFILE,
  NightAmbience,
  birdCallRate,
  insectActivity,
  insectVoiceCount,
  nightFactor,
  resolveAmbienceProfile,
  windCutoff,
  windLevel,
} from './ambience.js';
export type {
  AmbienceConditions,
  AmbienceOptions,
  AmbienceProfile,
  AmbienceProfileInput,
  BirdCallSpec,
  BirdCharacter,
  BirdKind,
  InsectCharacter,
  ReverbCharacter,
  RoomToneCharacter,
  WaterCharacter,
  WindCharacter,
} from './ambience.js';

export {
  BEEP_KINDS,
  BEEP_SPECS,
  COMPRESSOR_HARMONICS,
  DEFAULT_MACHINE_OPTIONS,
  FAN_BLADES,
  FAN_MAX_RPM,
  MachineKit,
  RELAY_CHARACTERS,
  RELAY_COUNT,
  compressorFrequencies,
  createFanCurve,
  fanCurve,
  frostTickRate,
  relayCharacter,
} from './machine.js';
export type { BeepKind, BeepSpec, FanCurve, MachineKitOptions, RelayCharacter } from './machine.js';

export {
  DEFAULT_FOLEY_OPTIONS,
  DEFAULT_SIZZLE_STATE,
  FOOTSTEP_MATERIALS,
  FOOTSTEP_SPECS,
  FoleyKit,
  STICK_ACTIONS,
  createSizzleParams,
  footstepSpec,
  isFootstepMaterial,
  sizzleParams,
} from './foley.js';
export type { FoleyOptions, FootstepMaterial, FootstepSpec, SizzleParams, SizzleState, StickAction } from './foley.js';

export {
  DEFAULT_SPATIAL_OPTIONS,
  HRTF_SOURCE_BUDGET,
  SpatialEmitter,
  choosePanningModel,
  computeDistanceGain,
  crossVec3,
  distanceBetween,
  dotVec3,
  normalizeVec3,
  orthonormalizeBasis,
  updateListener,
} from './spatial.js';
export type { SpatialOptions, SpatialQuality, Vec3 } from './spatial.js';

export {
  ImpulseCache,
  SPACE_PRESETS,
  SPACE_TYPES,
  generateImpulseResponse,
  impulseSampleCount,
  mixingTimeSeconds,
  tailEnvelope,
} from './impulse.js';
export type { EarlyReflection, GeneratedImpulse, ImpulseSpec, SpaceType } from './impulse.js';

export { DEFAULT_REVERB_OPTIONS, DEFAULT_REVERB_SENDS, ReverbBus } from './reverb.js';
export type { ReverbOptions } from './reverb.js';

export { DEFAULT_NOISE_BANK_OPTIONS, NoiseBank } from './buffers.js';
export type { NoiseBankOptions } from './buffers.js';

export {
  correlation,
  crossfadeLoopInPlace,
  fillBlueNoise,
  fillBrownNoise,
  fillGrain,
  fillImpulseTrain,
  fillPinkNoise,
  fillVelvetNoise,
  fillWhiteNoise,
  generateNoise,
  loopEndFor,
  normalizeInPlace,
  peakOf,
  rmsOf,
  windowedRms,
  zeroCrossingRate,
} from './noise.js';
export type { NoiseKind } from './noise.js';

export {
  FULL_INTENSITY,
  REDUCED_INTENSITY,
  TAIL_FLOOR_DB,
  adsrDuration,
  adsrValueAt,
  applyAttackHold,
  applyPercussive,
  applyRelease,
  expDecayValue,
  glideTo,
  percussiveDuration,
  percussiveValueAt,
  safeFrequency,
  shapePercussive,
  shapingFor,
  tailSeconds,
  timeConstantForDecay,
} from './envelopes.js';
export type { AdsrEnvelope, AutomatableParam, IntensityShaping, PercussiveEnvelope } from './envelopes.js';

export { createRng, hashSeed, poissonExpectedCount, poissonInterval } from './rng.js';
export type { Rng } from './rng.js';

export { GrainVoicePool, LookaheadWindow, ObjectPool, PoissonScheduler } from './voices.js';
export type { GrainVoice, PoolStats } from './voices.js';

export { Synth } from './synth.js';
export type { LayerDeps, PumpableLayer } from './layer.js';

export {
  connectChain,
  createAudioContext,
  isAudioContextSupported,
  resolveAudioContextConstructor,
  safeDisconnect,
  safeStop,
  toAudioBuffer,
} from './context.js';
export type { AudioContextFactory } from './context.js';

export * as audioMath from './math.js';
