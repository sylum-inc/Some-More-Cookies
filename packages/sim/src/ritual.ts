/**
 * The ritual state machine (spec §1).
 *
 *   arrive → tend fire → roast → assemble → load → operate SM-01 →
 *   transform → reveal → inspect / photograph / share / save / order / eat
 *
 * This binds every subsystem into one advanceable session. It is the object
 * the renderer reads and the multiplayer layer replicates inputs into, and it
 * is what the headless tests drive to prove the whole loop works without a
 * browser.
 *
 * The campsite stays open before and after: `stage` never forces the player
 * forward, it only records where they are in the ritual.
 */

import {
  createEstablishedFire,
  fanFire,
  fireSignals,
  rakeEmbers,
  stepFire,
  addLog,
  type FireSignals,
  type FireState,
} from './fire.js';
import {
  createMarshmallow,
  stepRoast,
  summariseRoast,
  blowOut,
  type MarshmallowState,
  type RoastInput,
  type RoastSummary,
} from './roasting.js';
import {
  createAssembly,
  isComplete as assemblyComplete,
  place,
  pickUp,
  moveHeld,
  stepAssembly,
  summariseAssembly,
  nextComponent,
  type AssemblyState,
  type AssemblySummary,
  type ComponentKind,
} from './assembly.js';
import {
  createMachine,
  performAction,
  recordRun,
  stepMachine,
  type MachineAction,
  type MachineState,
} from './machine.js';
import { deriveSandwich, createBiteState, takeBite, type BiteState, type SandwichRecord } from './sandwich.js';
import { createWeather, stepWeather, weatherFireEffect, type WeatherProfile, type WeatherState, DEFAULT_WEATHER_PROFILE } from './weather.js';
import { Rng, hashString } from './rng.js';
import { clamp, clamp01 } from './math.js';
import { vec3, type Vec3, SIM_DT } from './types.js';

export type RitualStage =
  | 'arriving'
  | 'at-fire'
  | 'roasting'
  | 'assembling'
  | 'machine'
  | 'reveal'
  | 'eating'
  | 'after';

export interface RitualOptions {
  campsiteSeed: number | string;
  environmentId: string;
  weatherProfile?: WeatherProfile;
  /** Accessibility assists. */
  assemblyAssist?: number;
  /** Automatic marshmallow rotation, rad/s. 0 disables (the default). */
  autoRotate?: number;
  /** Epoch ms used for sandwich records. Injected so tests are deterministic. */
  now?: number;
}

export interface RitualState {
  stage: RitualStage;
  fire: FireState;
  weather: WeatherState;
  marshmallow: MarshmallowState;
  assembly: AssemblyState;
  machine: MachineState;
  bite: BiteState;
  sandwich: SandwichRecord | null;
  /** Where the player is holding the marshmallow. */
  roastInput: RoastInput;
  /** Sandwiches made this session — the index used for record ids. */
  sandwichCount: number;
  /** Seconds since the session began. */
  elapsed: number;
  /** Seconds the sandwich has been out of the machine, for melting cues. */
  sandwichAge: number;
  rng: Rng;
  options: Required<Omit<RitualOptions, 'weatherProfile'>> & { weatherProfile: WeatherProfile };
  /** Stage-change flag for one step, consumed by audio and UI. */
  stageChangedTo: RitualStage | null;
}

export function createRitual(options: RitualOptions): RitualState {
  const seed = typeof options.campsiteSeed === 'string' ? hashString(options.campsiteSeed) : options.campsiteSeed;
  const rng = new Rng(seed);
  const weatherProfile = options.weatherProfile ?? DEFAULT_WEATHER_PROFILE;
  const weather = createWeather(weatherProfile, rng.split('weather'));
  const fire = createEstablishedFire({
    ambientC: weather.temperatureC,
    exposure: weatherProfile.exposure,
  });

  return {
    stage: 'arriving',
    fire,
    weather,
    marshmallow: createMarshmallow(),
    assembly: createAssembly({ assist: options.assemblyAssist ?? 0.5 }),
    machine: createMachine(seed, options.environmentId),
    bite: createBiteState(),
    sandwich: null,
    roastInput: { position: vec3(0, 0.45, 0.75), rotation: 0, blow: 0 },
    sandwichCount: 0,
    elapsed: 0,
    sandwichAge: 0,
    rng,
    options: {
      campsiteSeed: seed,
      environmentId: options.environmentId,
      assemblyAssist: options.assemblyAssist ?? 0.5,
      autoRotate: options.autoRotate ?? 0,
      now: options.now ?? 0,
      weatherProfile,
    },
    stageChangedTo: null,
  };
}

function setStage(ritual: RitualState, stage: RitualStage): void {
  if (ritual.stage === stage) return;
  ritual.stage = stage;
  ritual.stageChangedTo = stage;
}

/** Advances every subsystem by one fixed timestep. */
export function stepRitual(ritual: RitualState, dt: number = SIM_DT): void {
  ritual.elapsed += dt;
  ritual.stageChangedTo = null;

  // Weather first: it feeds the fire.
  stepWeather(ritual.weather, dt, ritual.rng.split('weather-step'));
  const effect = weatherFireEffect(ritual.weather);
  ritual.fire.config.ambientC = effect.ambientC;
  // Precipitation suppresses flame gently — mood, not jeopardy.
  if (effect.suppression > 0) {
    ritual.fire.flame = clamp01(ritual.fire.flame - effect.suppression * 0.06 * dt);
  }

  stepFire(ritual.fire, dt, ritual.rng.split('fire'));

  if (ritual.stage === 'roasting') {
    // Accessibility: automatic rotation removes the dexterity requirement
    // without changing what the player can achieve.
    if (ritual.options.autoRotate > 0) {
      ritual.roastInput.rotation += ritual.options.autoRotate * dt;
    }
    stepRoast(ritual.marshmallow, ritual.fire, ritual.roastInput, dt, ritual.rng.split('roast'));
  }

  if (ritual.stage === 'assembling') {
    stepAssembly(ritual.assembly, dt, ritual.rng.split('assembly'));
  }

  if (ritual.stage === 'machine' || ritual.stage === 'reveal') {
    stepMachine(ritual.machine, dt);
    // The sandwich exists the moment the machine finishes, but the player
    // does not see it until the door opens — the reveal happens in world.
    if (ritual.machine.stage === 'revealed' && !ritual.sandwich) {
      ritual.sandwich = buildSandwich(ritual);
      setStage(ritual, 'reveal');
    }
  }

  if (ritual.stage === 'eating' || ritual.stage === 'after') {
    ritual.sandwichAge += dt;
  }
}

function buildSandwich(ritual: RitualState): SandwichRecord {
  ritual.sandwichCount++;
  return deriveSandwich({
    roast: summariseRoast(ritual.marshmallow),
    assembly: summariseAssembly(ritual.assembly),
    machine: recordRun(ritual.machine),
    environmentId: ritual.options.environmentId,
    campsiteSeed: ritual.options.campsiteSeed,
    createdAt: ritual.options.now + ritual.elapsed * 1000,
    index: ritual.sandwichCount,
  });
}

// --- Player intents --------------------------------------------------------
// Each is a small, replicable action (ADR-0006): multiplayer sends these, not
// simulation state.

export function arrive(ritual: RitualState): void {
  setStage(ritual, 'at-fire');
}

export function tendFire(
  ritual: RitualState,
  action: { type: 'add-log'; woodId: string; placement?: number } | { type: 'rake' } | { type: 'fan'; strength?: number },
): void {
  if (action.type === 'add-log') {
    const log = addLog(ritual.fire, action.woodId, action.placement ?? 0.6);
    // Wet weather means the wood you find is damp.
    const effect = weatherFireEffect(ritual.weather);
    log.moisture = clamp01(log.moisture + effect.fuelMoisture * 0.4);
  } else if (action.type === 'rake') {
    rakeEmbers(ritual.fire, 1);
  } else {
    fanFire(ritual.fire, action.strength ?? 1);
  }
  if (ritual.stage === 'arriving') setStage(ritual, 'at-fire');
}

export function beginRoasting(ritual: RitualState): void {
  ritual.marshmallow = createMarshmallow();
  setStage(ritual, 'roasting');
}

/** Positions the marshmallow. This is the core tactile input. */
export function moveMarshmallow(ritual: RitualState, position: Vec3, rotation: number, blow = 0): void {
  ritual.roastInput.position.x = position.x;
  ritual.roastInput.position.y = position.y;
  ritual.roastInput.position.z = position.z;
  if (ritual.options.autoRotate <= 0) ritual.roastInput.rotation = rotation;
  ritual.roastInput.blow = clamp01(blow);
}

export function blowOutMarshmallow(ritual: RitualState): boolean {
  return blowOut(ritual.marshmallow);
}

/**
 * Finishes roasting and moves to assembly. A fallen marshmallow simply means
 * taking another one — never a restart (spec §4.2).
 */
export function finishRoasting(ritual: RitualState): boolean {
  if (ritual.marshmallow.fallen) {
    beginRoasting(ritual);
    return false;
  }
  const summary = summariseRoast(ritual.marshmallow);
  // Peak surface temperature drives how much the chocolate softens.
  ritual.assembly = createAssembly({
    assist: ritual.options.assemblyAssist,
    marshmallowTempC: clamp(summary.peakTempC, 20, 260),
  });
  setStage(ritual, 'assembling');
  return true;
}

export function holdComponent(ritual: RitualState, kind?: ComponentKind): ComponentKind | null {
  return pickUp(ritual.assembly, kind);
}

export function moveComponent(ritual: RitualState, offset: Vec3, rotation: number): void {
  moveHeld(ritual.assembly, offset, rotation);
}

export function placeComponent(ritual: RitualState): boolean {
  const placed = place(ritual.assembly, ritual.rng.split('place'));
  if (!placed) return false;
  if (assemblyComplete(ritual.assembly)) setStage(ritual, 'machine');
  return true;
}

export function pendingComponent(ritual: RitualState): ComponentKind | null {
  return nextComponent(ritual.assembly);
}

export function operateMachine(ritual: RitualState, action: MachineAction): boolean {
  if (ritual.stage !== 'machine' && ritual.stage !== 'reveal' && ritual.stage !== 'after') {
    setStage(ritual, 'machine');
  }
  return performAction(ritual.machine, action);
}

/** Takes the sandwich off the tray and moves to eating. */
export function takeSandwich(ritual: RitualState): SandwichRecord | null {
  if (!ritual.sandwich) return null;
  performAction(ritual.machine, { type: 'take-sandwich' });
  ritual.bite = createBiteState();
  ritual.sandwichAge = 0;
  setStage(ritual, 'eating');
  return ritual.sandwich;
}

export function bite(ritual: RitualState, position: number): BiteState | null {
  if (!ritual.sandwich) return null;
  const state = takeBite(ritual.bite, ritual.sandwich, position, ritual.rng.split('bite'));
  if (state.finished) setStage(ritual, 'after');
  return state;
}

// --- Readouts --------------------------------------------------------------

export interface RitualSignals {
  fire: FireSignals;
  stage: RitualStage;
  roast: RoastSummary | null;
  assembly: AssemblySummary | null;
  machineProgress: number;
  weatherLabel: string;
}

export function ritualSignals(ritual: RitualState): RitualSignals {
  return {
    fire: fireSignals(ritual.fire),
    stage: ritual.stage,
    roast: ritual.stage === 'roasting' || ritual.stage === 'assembling' ? summariseRoast(ritual.marshmallow) : null,
    assembly: ritual.stage === 'assembling' ? summariseAssembly(ritual.assembly) : null,
    machineProgress: ritual.machine.progress,
    weatherLabel: ritual.weather.kind,
  };
}

/**
 * Runs the whole ritual headlessly from a scripted timeline.
 *
 * This is how the loop is proven without a browser, and how roasting is tuned
 * (risk R1) — drive real input timelines and inspect the outcome spread.
 */
export interface ScriptedStep {
  /** Seconds to advance before applying the action. */
  wait?: number;
  action?: (ritual: RitualState) => void;
}

export function runScript(ritual: RitualState, steps: readonly ScriptedStep[]): RitualState {
  for (const step of steps) {
    const seconds = step.wait ?? 0;
    const count = Math.round(seconds / SIM_DT);
    for (let i = 0; i < count; i++) stepRitual(ritual, SIM_DT);
    step.action?.(ritual);
  }
  return ritual;
}
