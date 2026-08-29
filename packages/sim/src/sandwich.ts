/**
 * The finished Some More sandwich.
 *
 *   graham cracker cookie → chocolate → roasted-marshmallow ice cream
 *   → chocolate → graham cracker cookie
 *
 * This module is where the ritual becomes the product. Everything the player
 * did — how evenly they turned the marshmallow, whether they let it catch,
 * how carefully they stacked it, which machine ran it — is carried forward
 * deterministically into the object they are about to want to eat
 * (spec §4.5).
 *
 * Classes are descriptive, never ranked. There are no stars and no score.
 */

import { clamp, clamp01, inverseLerp, lerp, roundTo, smoothstep } from './math.js';
import type { AssemblySummary } from './assembly.js';
import type { MachineRunRecord } from './machine.js';
import type { RoastSummary } from './roasting.js';
import { Rng, hashString } from './rng.js';

export type SandwichClass =
  | 'Classic'
  | 'Golden'
  | 'Ember'
  | 'Snowdrift'
  | 'Lopsided'
  | 'Immaculate'
  | 'Driftwood'
  | 'Midnight';

export interface SandwichAppearance {
  /** Base ice cream colour, linear RGB. */
  creamColor: [number, number, number];
  /** Colour of the caramelised swirl running through it. */
  swirlColor: [number, number, number];
  /** How pronounced the swirl is, 0..1. */
  swirlStrength: number;
  /** Dark toasted flecks through the ice cream, 0..1. */
  fleckDensity: number;
  /** Surface texture from blistering, 0..1. */
  surfaceTexture: number;
  /** Thickness of the ice cream layer in metres. */
  creamThickness: number;
  /** Edge bulge from squish, 0..1. */
  edgeBulge: number;
  /** Overall lean of the stack, radians. */
  lean: number;
  /** Per-layer horizontal offsets in metres, bottom to top. */
  layerOffsets: readonly [number, number, number, number, number];
  /** Crumbs clinging to the edges, 0..1. */
  crumbs: number;
  /** Chocolate smear visible at the edge, 0..1. */
  smear: number;
  /** Frost on the surface, 0..1. */
  frost: number;
  /** Condensation beading, 0..1. */
  condensation: number;
  /** Chocolate sheen, 0..1 — the fidelity bump's signature. */
  sheen: number;
  /** Firmness, affects how the bite fractures. */
  firmness: number;
}

export interface SandwichRecord {
  readonly id: string;
  readonly createdAt: number;
  readonly class: SandwichClass;
  /** A short descriptive phrase for the Passport. Never a grade. */
  readonly caption: string;
  readonly appearance: SandwichAppearance;
  readonly roast: RoastSummary;
  readonly assembly: AssemblySummary;
  readonly machine: MachineRunRecord;
  readonly environmentId: string;
  /** Deterministic seed so the exact object can be rebuilt anywhere. */
  readonly seed: number;
}

export interface DeriveSandwichInput {
  roast: RoastSummary;
  assembly: AssemblySummary;
  machine: MachineRunRecord;
  environmentId: string;
  campsiteSeed: number | string;
  createdAt: number;
  /** Monotonic index of this sandwich within the campsite, for unique ids. */
  index: number;
}

/**
 * Derives the finished sandwich. Pure and deterministic: the same inputs
 * always produce the same object, which is what lets the server re-derive a
 * sandwich record to validate a real-world reward (ADR-0006).
 */
export function deriveSandwich(input: DeriveSandwichInput): SandwichRecord {
  const { roast, assembly, machine } = input;
  const baseSeed =
    typeof input.campsiteSeed === 'string' ? hashString(input.campsiteSeed) : input.campsiteSeed;
  const seed = hashString(`${baseSeed}:${machine.serial}:${input.index}`);
  const rng = new Rng(seed);

  // --- Ice cream colour -------------------------------------------------
  // Pale cream at one end, deep toasted caramel at the other.
  const pale: [number, number, number] = [0.96, 0.92, 0.83];
  const toasted: [number, number, number] = [0.78, 0.6, 0.36];
  const browning = clamp01(roast.brown);
  const creamColor: [number, number, number] = [
    lerp(pale[0], toasted[0], browning),
    lerp(pale[1], toasted[1], browning),
    lerp(pale[2], toasted[2], browning),
  ];

  // A dark caramel swirl, deepened by char.
  const swirlColor: [number, number, number] = [
    lerp(0.62, 0.26, clamp01(roast.char * 1.4)),
    lerp(0.42, 0.16, clamp01(roast.char * 1.4)),
    lerp(0.22, 0.11, clamp01(roast.char * 1.4)),
  ];

  // Uneven roasting makes a *more* beautiful swirl — one of the places where
  // an imperfect roast produces a better-looking object, which is deliberate:
  // it keeps "bad" outcomes desirable.
  const swirlStrength = clamp01(0.25 + (1 - roast.evenness) * 0.55 + roast.sidedness * 0.3);

  // Char becomes dark toasted flecks — the Ember signature.
  const fleckDensity = clamp01(roast.char * 1.15 + roast.flameSeconds * 0.045);

  const surfaceTexture = clamp01(roast.blister * 0.85 + roast.melt * 0.2);

  // --- Geometry from assembly -------------------------------------------
  const squish = clamp01(assembly.squish);
  const creamThickness = lerp(0.016, 0.009, squish);
  const edgeBulge = clamp01(squish * 0.9 + roast.melt * 0.25);

  // Five layers: graham, chocolate, ice cream, chocolate, graham. The
  // recorded assembly offsets are reused so the frozen object inherits the
  // hot s'more's exact lean.
  const spread = assembly.misalignment;
  const layerOffsets: [number, number, number, number, number] = [
    0,
    roundTo(spread * 0.6 + rng.normal(0, 0.0006), 5),
    roundTo(spread * rng.range(0.8, 1.2), 5),
    roundTo(spread * 0.7 + rng.normal(0, 0.0006), 5),
    roundTo(spread * rng.range(0.9, 1.3), 5),
  ];

  // --- Machine contribution ---------------------------------------------
  const frost = clamp01(machine.peakFrost * 0.85 + rng.range(-0.05, 0.08));
  const condensation = clamp01(0.25 + (1 - machine.peakFrost) * 0.45);
  const sheen = clamp01(0.55 + machine.firmness * 0.3 - assembly.smear * 0.2);

  const appearance: SandwichAppearance = {
    creamColor,
    swirlColor,
    swirlStrength,
    fleckDensity,
    surfaceTexture,
    creamThickness,
    edgeBulge,
    lean: assembly.lean,
    layerOffsets,
    crumbs: clamp01(assembly.crumbs),
    smear: clamp01(assembly.smear),
    frost,
    condensation,
    sheen,
    firmness: machine.firmness,
  };

  const sandwichClass = classify(roast, assembly, machine, input.environmentId);

  return {
    id: `sm-${seed.toString(36)}-${input.index}`,
    createdAt: input.createdAt,
    class: sandwichClass,
    caption: caption(sandwichClass, roast, assembly),
    appearance,
    roast,
    assembly,
    machine,
    environmentId: input.environmentId,
    seed,
  };
}

function classify(
  roast: RoastSummary,
  assembly: AssemblySummary,
  machine: MachineRunRecord,
  environmentId: string,
): SandwichClass {
  // Order matters: the most characterful class wins, so a striking sandwich is
  // never flattened into "Classic".
  if (roast.flameSeconds > 5 || roast.char > 0.5) return 'Ember';
  if (environmentId.includes('shore') && machine.quirkIds.length >= 2) return 'Driftwood';
  if (machine.program === 'deep-freeze' && machine.peakFrost > 0.85) return 'Snowdrift';
  if (roast.brown > 0.45 && roast.evenness > 0.7 && assembly.tidiness > 0.85) return 'Immaculate';
  if (assembly.tidiness < 0.35) return 'Lopsided';
  if (roast.brown > 0.4 && roast.evenness > 0.55) return 'Golden';
  if (roast.brown < 0.15) return 'Midnight';
  return 'Classic';
}

function caption(sandwichClass: SandwichClass, roast: RoastSummary, assembly: AssemblySummary): string {
  switch (sandwichClass) {
    case 'Ember':
      return roast.ignitionCount > 0
        ? 'Caught fire. Blown out. Better for it.'
        : 'Taken past golden, on purpose.';
    case 'Immaculate':
      return 'Turned steadily. Stacked square. Nothing to fix.';
    case 'Lopsided':
      return `${assembly.label}. Still perfect.`;
    case 'Snowdrift':
      return 'Held in deep freeze until the frost took.';
    case 'Golden':
      return 'Golden most of the way round.';
    case 'Driftwood':
      return 'Salt in the air and an old machine.';
    case 'Midnight':
      return 'Barely warmed. Cold through and quiet.';
    default:
      return 'One s’more, made properly.';
  }
}

// --- Eating ----------------------------------------------------------------

/** Eight bite positions around the sandwich's perimeter. */
export const BITE_POSITIONS = 8;

export interface BiteState {
  /** Per-position bite depth, 0..1. */
  readonly depths: number[];
  /** Total fraction eaten, 0..1. */
  eaten: number;
  /** Crumbs shed on the most recent bite. */
  crumbsThisBite: number;
  /** Whether the chocolate fractured on the most recent bite. */
  fracturedThisBite: boolean;
  bites: number;
  finished: boolean;
}

export function createBiteState(): BiteState {
  return {
    depths: new Array(BITE_POSITIONS).fill(0) as number[],
    eaten: 0,
    crumbsThisBite: 0,
    fracturedThisBite: false,
    bites: 0,
    finished: false,
  };
}

/**
 * Takes a bite at a perimeter position.
 *
 * Bites remove real geometry (spec deviation D3): the depth array is consumed
 * directly by the mesh builder, so the object visibly gets smaller and messier
 * rather than swapping between canned bite-state meshes.
 */
export function takeBite(
  bite: BiteState,
  sandwich: SandwichRecord,
  position: number,
  rng: Rng,
): BiteState {
  if (bite.finished) return bite;
  const index = ((position % BITE_POSITIONS) + BITE_POSITIONS) % BITE_POSITIONS;
  const current = bite.depths[index] ?? 0;
  // A bite in the same place goes deeper but yields less each time.
  const appetite = lerp(0.55, 0.28, current);
  bite.depths[index] = clamp01(current + appetite);

  // Neighbouring positions erode slightly — you cannot bite a disc cleanly.
  const left = (index - 1 + BITE_POSITIONS) % BITE_POSITIONS;
  const right = (index + 1) % BITE_POSITIONS;
  bite.depths[left] = clamp01((bite.depths[left] ?? 0) + appetite * 0.18);
  bite.depths[right] = clamp01((bite.depths[right] ?? 0) + appetite * 0.18);

  bite.bites++;
  bite.crumbsThisBite = clamp01(0.2 + sandwich.appearance.crumbs * 0.6 + rng.range(0, 0.25));
  // Firm chocolate fractures; soft chocolate bends.
  bite.fracturedThisBite = rng.chance(clamp01(sandwich.appearance.firmness * 0.85 + 0.1));

  let total = 0;
  for (const d of bite.depths) total += d;
  bite.eaten = clamp01(total / BITE_POSITIONS);
  bite.finished = bite.eaten >= 0.92;
  return bite;
}

/** How cold the sandwich still is, 0..1 — drives breath vapour and shiver cues. */
export function biteColdness(bite: BiteState, sandwich: SandwichRecord, secondsOut: number): number {
  const melting = smoothstep(0, 180, secondsOut);
  return clamp01((sandwich.appearance.frost * 0.5 + 0.5) * (1 - melting) * (1 - bite.eaten * 0.35));
}

/** A quiet closing line when the last bite is taken. Never a fanfare. */
export function finishingLine(sandwich: SandwichRecord, bite: BiteState): string | null {
  if (!bite.finished) return null;
  if (bite.bites <= 3) return 'Gone in three.';
  if (sandwich.class === 'Ember') return 'The burnt edges were the best part.';
  return 'Nothing left but crumbs.';
}

/**
 * Appetite check used by the recurring evaluation (spec §16.1): a crude but
 * honest signal that the derived appearance is in an appetising range rather
 * than grey, flat or black. Used by tests to catch regressions in the
 * derivation maths.
 */
export function appetiteSignals(sandwich: SandwichRecord): {
  warmth: number;
  contrast: number;
  richness: number;
} {
  const a = sandwich.appearance;
  const warmth = clamp01(a.creamColor[0] - a.creamColor[2] + 0.5);
  const contrast = clamp01(
    Math.abs(a.creamColor[0] - a.swirlColor[0]) + Math.abs(a.creamColor[1] - a.swirlColor[1]),
  );
  const richness = clamp01(a.sheen * 0.4 + a.swirlStrength * 0.35 + a.fleckDensity * 0.25);
  return {
    warmth: roundTo(warmth, 4),
    contrast: roundTo(contrast, 4),
    richness: roundTo(richness, 4),
  };
}

/** Layer geometry used by the mesh builder and the hero inspection view. */
export interface SandwichLayer {
  readonly kind: 'graham' | 'chocolate' | 'cream';
  readonly thickness: number;
  readonly offsetX: number;
  readonly offsetZ: number;
}

export function sandwichLayers(sandwich: SandwichRecord): SandwichLayer[] {
  const a = sandwich.appearance;
  const angleFor = (i: number) => (i * 2.399963229728653) % (Math.PI * 2); // golden angle
  const offsets = a.layerOffsets;
  const kinds: SandwichLayer['kind'][] = ['graham', 'chocolate', 'cream', 'chocolate', 'graham'];
  const thicknesses = [0.007, 0.0028, a.creamThickness, 0.0028, 0.007];
  return kinds.map((kind, i) => {
    const magnitude = offsets[i] ?? 0;
    const angle = angleFor(i);
    return {
      kind,
      thickness: thicknesses[i] ?? 0.005,
      offsetX: Math.cos(angle) * magnitude,
      offsetZ: Math.sin(angle) * magnitude,
    };
  });
}

/** Total height of the assembled sandwich in metres. */
export function sandwichHeight(sandwich: SandwichRecord): number {
  return sandwichLayers(sandwich).reduce((total, layer) => total + layer.thickness, 0);
}

/** Maps a class to a Passport stamp id. */
export function stampForClass(sandwichClass: SandwichClass): string {
  return `stamp-${sandwichClass.toLowerCase()}`;
}

/** Used by tests and the terminal to show provenance in a human way. */
export function provenanceLines(sandwich: SandwichRecord): string[] {
  return [
    `CLASS  ${sandwich.class.toUpperCase()}`,
    `ROAST  ${sandwich.roast.label}`,
    `STACK  ${sandwich.assembly.label}`,
    `UNIT   ${sandwich.machine.serial}`,
    `CYCLE  ${sandwich.machine.program.toUpperCase()} · ${Math.round(sandwich.machine.durationSeconds)}s`,
    `TURNED ${(sandwich.roast.rotationTravel / (Math.PI * 2)).toFixed(1)} turns`,
    inverseLerp(0, 1, sandwich.appearance.frost) > 0.7 ? 'NOTE   Heavy frost' : '',
  ].filter((line) => line.length > 0);
}

/** Clamp helper re-export for consumers building UI from appearance values. */
export const clampAppearance = (value: number): number => clamp(value, 0, 1);
