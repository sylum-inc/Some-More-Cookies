/**
 * The Some More SM-01 transformation freezer (spec §3).
 *
 * A major branded artifact, treated as a plausible industrial object: late
 * 1990s refrigeration, early-Y2K technology, restrained functional
 * minimalism. Its colour is *functional* — amber while hot and processing,
 * icy blue during freezing and transformation. Never decorative.
 *
 * The machine is explicitly Some More technology and is not a mystery
 * (spec §3.5). Every campsite's unit is serialized, worn, and quirky in its
 * own deterministic way, which is how a player recognises *their* machine.
 */

import { approach, clamp, clamp01, lerp, smoothstep } from './math.js';
import { Rng, hashString, mixSeeds } from './rng.js';

/** The twelve stages of the signature ritual, in order. */
export type MachineStage =
  | 'idle'
  | 'loaded'
  | 'door-closing'
  | 'door-closed'
  | 'latched'
  | 'armed'
  | 'processing'
  | 'freezing'
  | 'transforming'
  | 'complete'
  | 'unlatched'
  | 'opening'
  | 'revealed'
  | 'fault';

/** What the operator can do. Every one maps to a physical control. */
export type MachineAction =
  | { type: 'load' }
  | { type: 'close-door' }
  | { type: 'engage-latch' }
  | { type: 'set-program'; program: MachineProgram }
  | { type: 'confirm' }
  | { type: 'pull-lever' }
  | { type: 'release-latch' }
  | { type: 'open-door' }
  | { type: 'take-sandwich' }
  | { type: 'reset' };

/** The dial. Affects the run, never gates it. */
export type MachineProgram = 'standard' | 'soft-set' | 'deep-freeze';

export interface ProgramProfile {
  readonly id: MachineProgram;
  readonly label: string;
  /** Seconds of amber processing. */
  readonly processSeconds: number;
  /** Seconds of blue freezing. */
  readonly freezeSeconds: number;
  /** Seconds of the transformation proper. */
  readonly transformSeconds: number;
  /** How much frost develops, 0..1. */
  readonly frostTarget: number;
  /** Effect on the finished ice cream's firmness, 0..1. */
  readonly firmness: number;
}

export const PROGRAMS: Record<MachineProgram, ProgramProfile> = {
  'soft-set': {
    id: 'soft-set',
    label: 'SOFT SET',
    processSeconds: 11,
    freezeSeconds: 15,
    transformSeconds: 10,
    frostTarget: 0.45,
    firmness: 0.32,
  },
  standard: {
    id: 'standard',
    label: 'STANDARD',
    processSeconds: 14,
    freezeSeconds: 22,
    transformSeconds: 14,
    frostTarget: 0.7,
    firmness: 0.6,
  },
  'deep-freeze': {
    id: 'deep-freeze',
    label: 'DEEP FREEZE',
    processSeconds: 16,
    freezeSeconds: 32,
    transformSeconds: 18,
    frostTarget: 1,
    firmness: 0.88,
  },
};

/** A quirk is flavour and recognition, never a difficulty tax (spec §3.3). */
export interface MachineQuirk {
  readonly id: string;
  readonly label: string;
  /** A short line the service panel prints about it. */
  readonly note: string;
}

export const QUIRK_POOL: readonly MachineQuirk[] = [
  { id: 'double-relay', label: 'Relay 2 double-clicks', note: 'R2 contact chatter — within tolerance.' },
  { id: 'rough-fan', label: 'Condenser fan ramps rough', note: 'Fan bearing noted noisy at start-up.' },
  { id: 'flicker-segment', label: 'Display segment flickers', note: 'VFD segment 4C intermittent.' },
  { id: 'sticky-door', label: 'Door needs a second push', note: 'Gasket compression high. Seal good.' },
  { id: 'slow-amber', label: 'Amber lamp warms slowly', note: 'Indicator lamp aged. Function normal.' },
  { id: 'loud-compressor', label: 'Compressor starts loud', note: 'Start capacitor within spec.' },
  { id: 'early-frost', label: 'Frosts early on the left panel', note: 'Insulation settling, panel L.' },
  { id: 'long-hold', label: 'Holds the tone a beat too long', note: 'Completion tone timing +0.4s.' },
  { id: 'warm-latch', label: 'Latch runs warm', note: 'Solenoid heat normal for duty cycle.' },
  { id: 'proud-badge', label: 'Badge sits slightly proud', note: 'Cosmetic. Not scheduled.' },
];

export interface MaintenanceEntry {
  readonly date: string;
  readonly code: string;
  readonly note: string;
}

/** Everything that makes one physical unit distinct. Derived from a seed. */
export interface MachineIdentity {
  readonly serial: string;
  readonly model: 'SM-01';
  /** Year of manufacture in the fiction. */
  readonly built: number;
  /** 0..1 overall wear: scuffs, paint loss, decal fade. */
  readonly wear: number;
  /** 0..1 how faded the front decals are. */
  readonly decalFade: number;
  /** 0..1 how dented the enamel is. */
  readonly denting: number;
  readonly quirks: readonly MachineQuirk[];
  readonly stickers: readonly string[];
  readonly maintenance: readonly MaintenanceEntry[];
  /** Total sandwiches this unit has produced in the fiction. */
  readonly lifetimeRuns: number;
}

const STICKER_POOL = [
  'CAMPGROUND INSPECTION 08',
  'SERVICE — DO NOT PAINT',
  'DEPT. OF PARKS · CLEARED',
  'PROPERTY OF SOME MORE',
  'HANDLE COLD SURFACES WITH CARE',
  'LOT 14',
  'RETURN TO DEPOT IF FOUND',
  'TESTED · PASSED',
  'THIS UNIT RUNS QUIET',
  'NIGHT USE PERMITTED',
];

/**
 * Derives a unit's full identity from a campsite seed.
 *
 * Deterministic, so a player's machine is *their* machine on every device and
 * after every reinstall — which is the point of serialising it at all.
 */
export function deriveMachineIdentity(campsiteSeed: number | string, environmentId: string): MachineIdentity {
  const base = typeof campsiteSeed === 'string' ? hashString(campsiteSeed) : campsiteSeed;
  const rng = new Rng(mixSeeds(base, hashString(`sm01:${environmentId}`)));

  const built = rng.int(1997, 2003);
  const wear = clamp01(rng.range(0.12, 0.9));
  const lifetimeRuns = rng.int(180, 21000);

  // Serial: SM01-<year><letter>-<5 digits>-<check>
  const letters = 'ABCDEFGHJKLMNPRSTVWXZ';
  const letter = letters[rng.int(0, letters.length - 1)] ?? 'A';
  const digits = String(rng.int(10000, 99999));
  const checkChar = letters[(hashString(`${built}${letter}${digits}`) % letters.length + letters.length) % letters.length] ?? 'A';
  const serial = `SM01-${built}${letter}-${digits}-${checkChar}`;

  // One to three quirks, more likely on a worn unit.
  const quirkCount = wear > 0.66 ? rng.int(2, 3) : wear > 0.35 ? rng.int(1, 2) : rng.int(0, 1);
  const quirkPool = rng.shuffle([...QUIRK_POOL]);
  const quirks = quirkPool.slice(0, quirkCount);

  const stickerCount = rng.int(1, 4);
  const stickers = rng.shuffle([...STICKER_POOL]).slice(0, stickerCount);

  const maintenance: MaintenanceEntry[] = [];
  const entryCount = rng.int(2, 5);
  let year = built + rng.int(0, 2);
  for (let i = 0; i < entryCount; i++) {
    year += rng.int(1, 4);
    const month = rng.int(1, 12);
    const day = rng.int(1, 28);
    const codes = ['PM-01', 'PM-02', 'RPR-11', 'RPR-27', 'CAL-03', 'SEAL-08', 'FLD-04'];
    const notes = [
      'Routine service. Charge nominal.',
      'Door seal replaced.',
      'Condenser cleaned. Airflow restored.',
      'Thermostat recalibrated.',
      'Relay bank inspected.',
      'Transferred from depot.',
      'Field service call — no fault found.',
      'Lamp assembly replaced.',
    ];
    maintenance.push({
      date: `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`,
      code: codes[rng.int(0, codes.length - 1)] ?? 'PM-01',
      note: notes[rng.int(0, notes.length - 1)] ?? 'Routine service.',
    });
  }

  return {
    serial,
    model: 'SM-01',
    built,
    wear,
    decalFade: clamp01(wear * rng.range(0.6, 1.1)),
    denting: clamp01(wear * rng.range(0.3, 0.9)),
    quirks,
    stickers,
    maintenance,
    lifetimeRuns,
  };
}

export interface MachineState {
  identity: MachineIdentity;
  stage: MachineStage;
  program: MachineProgram;
  /** Seconds elapsed in the current stage. */
  stageElapsed: number;
  /** Total run seconds since the lever was pulled. */
  runElapsed: number;
  /** 0..1 progress through the whole run. */
  progress: number;
  /** Door open angle, 0 = shut, 1 = fully open. */
  door: number;
  /** Latch travel, 0 = released, 1 = engaged. */
  latch: number;
  /** Lever throw, 0 = up, 1 = fully pulled. */
  lever: number;
  /** Amber indicator brightness, 0..1. */
  amber: number;
  /** Blue indicator brightness, 0..1. */
  blue: number;
  /** Frost coverage on the shell and window, 0..1. */
  frost: number;
  /** Interior chamber temperature, °C. */
  chamberTempC: number;
  /** Compressor running state, 0..1 (ramps). */
  compressor: number;
  /** Fan speed, 0..1. */
  fan: number;
  /** Cold vapour spilling out, 0..1. */
  vapour: number;
  /** Whether a s'more is inside. */
  loaded: boolean;
  /** Whether a finished sandwich is on the tray. */
  hasSandwich: boolean;
  /** One-shot events emitted this step, consumed by audio and particles. */
  events: MachineEvent[];
  /** Confirmed program selection — the machine will not run unconfirmed. */
  confirmed: boolean;
  /** Rolling counter for frost crackle scheduling. */
  crackleAccumulator: number;
}

export type MachineEvent =
  | 'latch-clunk'
  | 'latch-release'
  | 'switch-detent'
  | 'relay-1'
  | 'relay-2'
  | 'relay-3'
  | 'compressor-start'
  | 'compressor-stop'
  | 'fan-ramp'
  | 'refrigerant-flow'
  | 'frost-crackle'
  | 'stage-amber'
  | 'stage-blue'
  | 'completion-tone'
  | 'door-seal'
  | 'door-open'
  | 'vapour-release'
  | 'beep-confirm'
  | 'beep-reject'
  | 'lever-throw';

export function createMachine(campsiteSeed: number | string, environmentId: string): MachineState {
  return {
    identity: deriveMachineIdentity(campsiteSeed, environmentId),
    stage: 'idle',
    program: 'standard',
    stageElapsed: 0,
    runElapsed: 0,
    progress: 0,
    door: 0,
    latch: 0,
    lever: 0,
    amber: 0,
    blue: 0,
    frost: 0,
    chamberTempC: 12,
    compressor: 0,
    fan: 0,
    vapour: 0,
    loaded: false,
    hasSandwich: false,
    events: [],
    confirmed: false,
    crackleAccumulator: 0,
  };
}

function emit(machine: MachineState, event: MachineEvent): void {
  machine.events.push(event);
}

function setStage(machine: MachineState, stage: MachineStage): void {
  if (machine.stage === stage) return;
  machine.stage = stage;
  machine.stageElapsed = 0;
}

/** Whether an action is legal right now. Used to gate controls, not to scold. */
export function canPerform(machine: MachineState, action: MachineAction['type']): boolean {
  switch (action) {
    case 'load':
      return machine.stage === 'idle' && !machine.loaded && machine.door > 0.6;
    case 'close-door':
      return machine.door > 0.05 && (machine.stage === 'idle' || machine.stage === 'loaded' || machine.stage === 'revealed');
    case 'engage-latch':
      return machine.stage === 'door-closed' && machine.latch < 0.99;
    case 'set-program':
      return machine.stage === 'latched' || machine.stage === 'armed';
    case 'confirm':
      return machine.stage === 'latched' || machine.stage === 'armed';
    case 'pull-lever':
      return machine.stage === 'armed' && machine.confirmed && machine.loaded;
    case 'release-latch':
      return machine.stage === 'complete';
    case 'open-door':
      return machine.stage === 'unlatched' || machine.stage === 'idle' || machine.stage === 'revealed';
    case 'take-sandwich':
      return machine.stage === 'revealed' && machine.hasSandwich;
    case 'reset':
      return true;
    default:
      return false;
  }
}

/**
 * Applies an operator action.
 *
 * Returns true when it was accepted. A rejected action gives a small reject
 * beep rather than an error message — the machine communicates like an
 * appliance, not like software.
 */
export function performAction(machine: MachineState, action: MachineAction): boolean {
  if (!canPerform(machine, action.type)) {
    if (action.type !== 'reset') emit(machine, 'beep-reject');
    return false;
  }

  switch (action.type) {
    case 'load':
      machine.loaded = true;
      setStage(machine, 'loaded');
      return true;
    case 'close-door':
      setStage(machine, 'door-closing');
      return true;
    case 'engage-latch':
      machine.latch = 1;
      emit(machine, 'latch-clunk');
      setStage(machine, 'latched');
      return true;
    case 'set-program':
      machine.program = action.program;
      machine.confirmed = false;
      emit(machine, 'switch-detent');
      setStage(machine, 'latched');
      return true;
    case 'confirm':
      machine.confirmed = true;
      emit(machine, 'beep-confirm');
      setStage(machine, 'armed');
      return true;
    case 'pull-lever':
      machine.lever = 1;
      emit(machine, 'lever-throw');
      emit(machine, 'relay-1');
      setStage(machine, 'processing');
      machine.runElapsed = 0;
      return true;
    case 'release-latch':
      machine.latch = 0;
      emit(machine, 'latch-release');
      setStage(machine, 'unlatched');
      return true;
    case 'open-door':
      setStage(machine, 'opening');
      emit(machine, 'door-open');
      return true;
    case 'take-sandwich':
      machine.hasSandwich = false;
      machine.loaded = false;
      setStage(machine, 'idle');
      machine.lever = 0;
      machine.confirmed = false;
      return true;
    case 'reset':
      machine.stage = 'idle';
      machine.stageElapsed = 0;
      machine.runElapsed = 0;
      machine.progress = 0;
      machine.lever = 0;
      machine.latch = 0;
      machine.confirmed = false;
      machine.loaded = false;
      machine.hasSandwich = false;
      return true;
    default:
      return false;
  }
}

/** Total run duration for the selected program. */
export function runDuration(program: MachineProgram): number {
  const p = PROGRAMS[program];
  return p.processSeconds + p.freezeSeconds + p.transformSeconds;
}

/**
 * Advances the machine one fixed timestep.
 *
 * Quirks are applied here as small timing and behaviour offsets — audible and
 * visible, never punishing.
 */
export function stepMachine(machine: MachineState, dt: number): void {
  machine.events.length = 0;
  machine.stageElapsed += dt;

  const profile = PROGRAMS[machine.program];
  const hasQuirk = (id: string) => machine.identity.quirks.some((q) => q.id === id);

  // Door animation.
  const doorTarget = doorTargetFor(machine.stage);
  const doorSpeed = hasQuirk('sticky-door') && machine.stage === 'door-closing' ? 0.9 : 1.6;
  const previousDoor = machine.door;
  machine.door = approach(machine.door, doorTarget, doorSpeed, dt);
  // A heavy door with a gasket does not ease asymptotically shut — it reaches
  // the seal and thunks the last of the way closed. Snapping here also keeps
  // the close from taking forever, since an exponential approach never
  // actually arrives.
  if (machine.stage === 'door-closing' && previousDoor > 0.06 && machine.door <= 0.06) {
    machine.door = 0;
    emit(machine, 'door-seal');
    setStage(machine, 'door-closed');
  }
  if (machine.stage === 'opening' && machine.door > 0.92) {
    setStage(machine, 'revealed');
    emit(machine, 'vapour-release');
    machine.vapour = 1;
  }

  switch (machine.stage) {
    case 'processing': {
      machine.runElapsed += dt;
      // Amber: the s'more is still warm and the machine is working on it.
      const ambeRate = hasQuirk('slow-amber') ? 1.1 : 3.2;
      machine.amber = approach(machine.amber, 1, ambeRate, dt);
      machine.blue = approach(machine.blue, 0, 4, dt);
      if (machine.stageElapsed < dt * 2) emit(machine, 'stage-amber');
      // Relays and compressor engage in a believable order.
      scheduleOnce(machine, 'relay-2', 0.6);
      scheduleOnce(machine, 'compressor-start', 1.4);
      scheduleOnce(machine, 'fan-ramp', 2.1);
      if (hasQuirk('double-relay')) scheduleOnce(machine, 'relay-2', 0.72);
      machine.compressor = approach(machine.compressor, 1, hasQuirk('loud-compressor') ? 0.8 : 1.2, dt);
      machine.fan = approach(machine.fan, hasQuirk('rough-fan') ? 0.82 : 0.9, 0.7, dt);
      machine.chamberTempC = approach(machine.chamberTempC, -4, 0.16, dt);
      if (machine.stageElapsed >= profile.processSeconds) {
        setStage(machine, 'freezing');
        emit(machine, 'relay-3');
        emit(machine, 'stage-blue');
      }
      break;
    }
    case 'freezing': {
      machine.runElapsed += dt;
      // The moment the transformation becomes real: amber gives way to blue.
      machine.amber = approach(machine.amber, 0.06, 1.4, dt);
      machine.blue = approach(machine.blue, 1, 1.1, dt);
      machine.compressor = approach(machine.compressor, 1, 1.5, dt);
      machine.fan = approach(machine.fan, 1, 1.2, dt);
      machine.chamberTempC = approach(machine.chamberTempC, -26, 0.2, dt);
      scheduleOnce(machine, 'refrigerant-flow', 2.4);
      const frostRate = hasQuirk('early-frost') ? 0.16 : 0.11;
      machine.frost = clamp01(machine.frost + frostRate * dt);
      stepFrostCrackle(machine, dt);
      if (machine.stageElapsed >= profile.freezeSeconds) setStage(machine, 'transforming');
      break;
    }
    case 'transforming': {
      machine.runElapsed += dt;
      machine.blue = approach(machine.blue, 1, 2, dt);
      machine.chamberTempC = approach(machine.chamberTempC, -32, 0.25, dt);
      machine.frost = clamp01(approach(machine.frost, profile.frostTarget, 0.35, dt));
      stepFrostCrackle(machine, dt);
      if (machine.stageElapsed >= profile.transformSeconds) {
        setStage(machine, 'complete');
        machine.hasSandwich = true;
        emit(machine, 'completion-tone');
        emit(machine, 'compressor-stop');
      }
      break;
    }
    case 'complete': {
      machine.compressor = approach(machine.compressor, 0, 0.9, dt);
      machine.fan = approach(machine.fan, 0.12, 0.8, dt);
      machine.blue = approach(machine.blue, 0.7, 1, dt);
      stepFrostCrackle(machine, dt);
      break;
    }
    case 'unlatched':
    case 'opening':
    case 'revealed': {
      machine.compressor = approach(machine.compressor, 0, 1.4, dt);
      machine.fan = approach(machine.fan, 0, 1.2, dt);
      machine.blue = approach(machine.blue, 0.35, 0.8, dt);
      // Frost sublimates slowly once the door is open.
      machine.frost = approach(machine.frost, machine.frost * 0.75, 0.12, dt);
      machine.vapour = approach(machine.vapour, 0, 0.5, dt);
      machine.chamberTempC = approach(machine.chamberTempC, 4, 0.05, dt);
      break;
    }
    default: {
      machine.amber = approach(machine.amber, 0, 2, dt);
      machine.blue = approach(machine.blue, 0, 2, dt);
      machine.compressor = approach(machine.compressor, 0, 2, dt);
      machine.fan = approach(machine.fan, 0, 2, dt);
      machine.frost = approach(machine.frost, 0, 0.05, dt);
      machine.vapour = approach(machine.vapour, 0, 1.2, dt);
      break;
    }
  }

  const total = runDuration(machine.program);
  machine.progress = clamp01(machine.runElapsed / total);
}

function doorTargetFor(stage: MachineStage): number {
  switch (stage) {
    case 'idle':
      return 1;
    case 'loaded':
      return 1;
    case 'door-closing':
      return 0;
    case 'opening':
    case 'revealed':
      return 1;
    default:
      return 0;
  }
}

/** Emits an event exactly once, when the stage clock passes a threshold. */
function scheduleOnce(machine: MachineState, event: MachineEvent, at: number): void {
  const dt = 1 / 60;
  if (machine.stageElapsed >= at && machine.stageElapsed - dt < at) emit(machine, event);
}

function stepFrostCrackle(machine: MachineState, dt: number): void {
  // Denser ticking as frost thickens.
  const rate = machine.frost * 5.5;
  machine.crackleAccumulator += rate * dt;
  while (machine.crackleAccumulator >= 1) {
    machine.crackleAccumulator -= 1;
    emit(machine, 'frost-crackle');
  }
}

/** Telemetry recorded for the sandwich's provenance. */
export interface MachineRunRecord {
  serial: string;
  program: MachineProgram;
  durationSeconds: number;
  peakFrost: number;
  minChamberTempC: number;
  quirkIds: string[];
  firmness: number;
}

export function recordRun(machine: MachineState): MachineRunRecord {
  return {
    serial: machine.identity.serial,
    program: machine.program,
    durationSeconds: machine.runElapsed,
    peakFrost: machine.frost,
    minChamberTempC: machine.chamberTempC,
    quirkIds: machine.identity.quirks.map((q) => q.id),
    firmness: PROGRAMS[machine.program].firmness,
  };
}

/** The service panel readout — a quiet piece of environmental storytelling. */
export function servicePanelLines(machine: MachineState): string[] {
  const id = machine.identity;
  const lines = [
    `SOME MORE  ·  MODEL ${id.model}`,
    `SERIAL ${id.serial}`,
    `BUILT ${id.built}`,
    `LIFETIME RUNS ${id.lifetimeRuns.toLocaleString('en-US')}`,
    '',
    'MAINTENANCE',
  ];
  for (const entry of id.maintenance) lines.push(`  ${entry.date}  ${entry.code}  ${entry.note}`);
  if (id.quirks.length > 0) {
    lines.push('', 'NOTED');
    for (const quirk of id.quirks) lines.push(`  ${quirk.note}`);
  }
  return lines;
}

/**
 * Indicator colour as linear RGB. Amber → blue is the machine's whole visual
 * language, so it is defined once, here, rather than in the renderer.
 */
export function indicatorColor(machine: MachineState): [number, number, number] {
  const amber: [number, number, number] = [1, 0.62, 0.16];
  const blue: [number, number, number] = [0.42, 0.78, 1];
  const t = clamp01(machine.blue / Math.max(0.0001, machine.blue + machine.amber));
  const intensity = clamp(Math.max(machine.amber, machine.blue), 0, 1);
  return [
    lerp(amber[0], blue[0], t) * intensity,
    lerp(amber[1], blue[1], t) * intensity,
    lerp(amber[2], blue[2], t) * intensity,
  ];
}

/** Text for the small VFD display, including a flickering-segment quirk. */
export function displayText(machine: MachineState): string {
  switch (machine.stage) {
    case 'idle':
      return machine.door > 0.5 ? 'OPEN' : 'READY';
    case 'loaded':
      return 'LOADED';
    case 'door-closing':
      return 'CLOSING';
    case 'door-closed':
      return 'LATCH';
    case 'latched':
      return PROGRAMS[machine.program].label;
    case 'armed':
      return 'ARMED';
    case 'processing':
      return `PROC ${formatCountdown(machine, PROGRAMS[machine.program].processSeconds)}`;
    case 'freezing':
      return `FRZ ${formatCountdown(machine, PROGRAMS[machine.program].freezeSeconds)}`;
    case 'transforming':
      return 'TRANSFORM';
    case 'complete':
      return 'DONE';
    case 'unlatched':
      return 'OPEN DOOR';
    case 'opening':
      return 'OPENING';
    case 'revealed':
      return 'TAKE';
    case 'fault':
      return 'SERVICE';
    default:
      return '';
  }
}

function formatCountdown(machine: MachineState, total: number): string {
  const remaining = Math.max(0, total - machine.stageElapsed);
  return String(Math.ceil(remaining)).padStart(2, '0');
}

/** Smoothed 0..1 signal for how "cold" the machine looks — drives frost shaders. */
export function coldness(machine: MachineState): number {
  return clamp01(smoothstep(10, -30, machine.chamberTempC) * 0.6 + machine.frost * 0.4);
}
