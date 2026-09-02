/**
 * Physically assembling the hot s'more (spec §4.3).
 *
 * Stack order: graham → chocolate → marshmallow → graham.
 *
 * The method is **freeform placement with subtle magnetic assistance**. The
 * design tension is that placement must genuinely matter — offsets, rotation
 * and tilt survive all the way onto the finished frozen sandwich — while never
 * becoming fiddly on a phone. The magnet solves that: it pulls toward the
 * ideal without ever snapping exactly to it, so a careful player and a hasty
 * player produce visibly different objects and neither is fighting the input.
 *
 * There is no "correct" assembly and no score. A lopsided s'more is a
 * perfectly good s'more.
 */

import { clamp, clamp01, lerp, smoothstep, TAU } from './math.js';
import type { Rng } from './rng.js';
import { vec3, type Vec3 } from './types.js';

export type ComponentKind = 'graham-bottom' | 'chocolate' | 'marshmallow' | 'graham-top';

export const STACK_ORDER: readonly ComponentKind[] = [
  'graham-bottom',
  'chocolate',
  'marshmallow',
  'graham-top',
];

export interface AssemblyTuning {
  /** Radius within which the magnet has any effect, metres. */
  magnetRadius: number;
  /** Fraction of the remaining offset removed per second at full assist. */
  magnetStrength: number;
  /**
   * Never reaches zero: the residual offset is what makes each sandwich
   * handmade. Even at maximum accessibility assist, a floor of imperfection
   * remains, because a perfectly aligned sandwich is a *worse* object.
   */
  residualOffset: number;
  /** Rotational magnet, radians/second toward the nearest comfortable angle. */
  rotationMagnet: number;
  /** How much a hot marshmallow squishes under the top cracker. */
  squishFactor: number;
  /** Chocolate softening rate per second at marshmallow contact temperature. */
  chocolateSoftenRate: number;
}

export const DEFAULT_ASSEMBLY_TUNING: AssemblyTuning = {
  magnetRadius: 0.055,
  magnetStrength: 5.5,
  residualOffset: 0.004,
  rotationMagnet: 2.4,
  squishFactor: 0.55,
  chocolateSoftenRate: 0.28,
};

export interface PlacedComponent {
  readonly kind: ComponentKind;
  /** Placement relative to the ideal stack position, metres. */
  offset: Vec3;
  /** Yaw about the vertical axis, radians. */
  rotation: number;
  /** Tilt from level, radians. */
  tilt: number;
  /** 0..1 how compressed this component is. */
  squish: number;
  /** 0..1 how soft/melted (chocolate and marshmallow only). */
  softness: number;
  /** Crumbs shed during placement, 0..1. */
  crumbs: number;
  /** Smear left on the component below, 0..1. */
  smear: number;
  /** Seconds since placed. */
  restedFor: number;
  /** True once committed to the stack. */
  placed: boolean;
}

export interface AssemblyState {
  components: PlacedComponent[];
  /** The component currently held, if any. */
  heldKind: ComponentKind | null;
  /** Live position of the held component while dragging. */
  heldOffset: Vec3;
  heldRotation: number;
  /** How hot the marshmallow was when it entered the stack, °C. */
  marshmallowTempC: number;
  /** Assist strength, 0..1. Accessibility raises this; it never reaches 1. */
  assist: number;
  elapsed: number;
  tuning: AssemblyTuning;
  /** Set for one step when a component is committed — for audio and haptics. */
  placedThisStep: ComponentKind | null;
}

export function createAssembly(options?: {
  assist?: number;
  marshmallowTempC?: number;
  tuning?: Partial<AssemblyTuning>;
}): AssemblyState {
  return {
    components: [],
    heldKind: null,
    heldOffset: vec3(),
    heldRotation: 0,
    marshmallowTempC: options?.marshmallowTempC ?? 120,
    assist: clamp01(options?.assist ?? 0.5),
    elapsed: 0,
    tuning: { ...DEFAULT_ASSEMBLY_TUNING, ...options?.tuning },
    placedThisStep: null,
  };
}

/** The component the player should be placing next, or null when finished. */
export function nextComponent(assembly: AssemblyState): ComponentKind | null {
  const placedCount = assembly.components.filter((c) => c.placed).length;
  return STACK_ORDER[placedCount] ?? null;
}

export function isComplete(assembly: AssemblyState): boolean {
  return assembly.components.filter((c) => c.placed).length >= STACK_ORDER.length;
}

/** Picks up the next component in the stack order. */
export function pickUp(assembly: AssemblyState, kind?: ComponentKind): ComponentKind | null {
  const expected = nextComponent(assembly);
  if (!expected) return null;
  if (kind && kind !== expected) return null;
  assembly.heldKind = expected;
  assembly.heldOffset.x = 0;
  assembly.heldOffset.y = 0.08;
  assembly.heldOffset.z = 0;
  assembly.heldRotation = 0;
  return expected;
}

/** Moves the held component. Coordinates are relative to the ideal position. */
export function moveHeld(assembly: AssemblyState, offset: Vec3, rotation: number): void {
  if (!assembly.heldKind) return;
  assembly.heldOffset.x = offset.x;
  assembly.heldOffset.y = offset.y;
  assembly.heldOffset.z = offset.z;
  assembly.heldRotation = rotation;
}

/**
 * Applies the magnetic assist to the held component. Called every step while
 * dragging, so assist is felt continuously rather than snapping on release.
 */
export function stepAssembly(assembly: AssemblyState, dt: number, rng: Rng): void {
  assembly.elapsed += dt;
  assembly.placedThisStep = null;
  const t = assembly.tuning;

  if (assembly.heldKind) {
    const horizontal = Math.sqrt(
      assembly.heldOffset.x * assembly.heldOffset.x + assembly.heldOffset.z * assembly.heldOffset.z,
    );
    if (horizontal < t.magnetRadius) {
      // Falls off with distance so the magnet is felt as a gentle settling
      // near the target rather than a grab from across the table.
      const falloff = 1 - smoothstep(0, t.magnetRadius, horizontal);
      const pull = clamp01(t.magnetStrength * assembly.assist * falloff * dt);
      // The residual floor: never pull closer than this, so alignment stays
      // imperfect and the object stays handmade.
      const target = horizontal <= t.residualOffset ? horizontal : Math.max(t.residualOffset, horizontal * (1 - pull));
      const scale = horizontal > 0 ? target / horizontal : 1;
      assembly.heldOffset.x *= scale;
      assembly.heldOffset.z *= scale;

      // Rotation eases toward the nearest quarter turn (crackers are square-ish).
      const quarter = TAU / 4;
      const nearest = Math.round(assembly.heldRotation / quarter) * quarter;
      const rotPull = clamp01(t.rotationMagnet * assembly.assist * falloff * dt);
      assembly.heldRotation = lerp(assembly.heldRotation, nearest, rotPull);
    }
  }

  // Placed components continue to react: chocolate softens against a hot
  // marshmallow, marshmallow settles under the weight above it.
  for (const component of assembly.components) {
    if (!component.placed) continue;
    component.restedFor += dt;
    if (component.kind === 'chocolate') {
      const heat = clamp01((assembly.marshmallowTempC - 34) / 90);
      component.softness = clamp01(component.softness + t.chocolateSoftenRate * heat * dt);
      // Softening chocolate slumps into the cracker's texture.
      component.smear = clamp01(component.smear + component.softness * 0.12 * dt);
    }
    if (component.kind === 'marshmallow') {
      const heat = clamp01((assembly.marshmallowTempC - 40) / 110);
      component.softness = clamp01(component.softness * 0.995 + heat * 0.1 * dt);
    }
  }
  void rng;
}

/**
 * Commits the held component to the stack.
 *
 * Returns the placed component, or null when nothing was held.
 */
export function place(assembly: AssemblyState, rng: Rng): PlacedComponent | null {
  const kind = assembly.heldKind;
  if (!kind) return null;

  const t = assembly.tuning;
  const horizontal = Math.sqrt(
    assembly.heldOffset.x * assembly.heldOffset.x + assembly.heldOffset.z * assembly.heldOffset.z,
  );

  // A component dropped from a height lands harder: more crumbs, more tilt.
  const dropHeight = Math.max(0, assembly.heldOffset.y);
  const impact = clamp01(dropHeight / 0.12);

  // Tilt comes from how badly it is aligned plus how hard it landed, with a
  // little seeded variation so no two placements are identical.
  const tilt =
    clamp01(horizontal / 0.06) * 0.18 + impact * 0.1 + rng.normal(0, 0.012);

  const component: PlacedComponent = {
    kind,
    offset: vec3(assembly.heldOffset.x, 0, assembly.heldOffset.z),
    rotation: assembly.heldRotation,
    tilt: clamp(tilt, -0.35, 0.35),
    squish: 0,
    softness: kind === 'chocolate' ? 0.05 : kind === 'marshmallow' ? 0.4 : 0,
    crumbs: 0,
    smear: 0,
    restedFor: 0,
    placed: true,
  };

  // Graham crackers shed crumbs, more so when handled roughly.
  if (kind === 'graham-bottom' || kind === 'graham-top') {
    component.crumbs = clamp01(0.08 + impact * 0.5 + Math.abs(rng.normal(0, 0.06)));
  }

  // The top cracker presses down: the marshmallow squishes and the chocolate
  // smears. This is the moment the stack becomes one object.
  if (kind === 'graham-top') {
    const marshmallow = assembly.components.find((c) => c.kind === 'marshmallow');
    const chocolate = assembly.components.find((c) => c.kind === 'chocolate');
    const heatSoftness = clamp01((assembly.marshmallowTempC - 45) / 100);
    const press = clamp01(0.35 + impact * 0.65);
    if (marshmallow) {
      marshmallow.squish = clamp01(t.squishFactor * press * (0.5 + heatSoftness));
      marshmallow.smear = clamp01(marshmallow.smear + marshmallow.squish * 0.4);
    }
    if (chocolate) {
      chocolate.smear = clamp01(chocolate.smear + chocolate.softness * press * 0.8);
      chocolate.squish = clamp01(chocolate.softness * press * 0.5);
    }
  }

  assembly.components.push(component);
  assembly.heldKind = null;
  assembly.placedThisStep = kind;
  return component;
}

// --- Summary ---------------------------------------------------------------

export interface AssemblySummary {
  /** Mean horizontal misalignment in metres. */
  misalignment: number;
  /** Worst single misalignment. */
  maxMisalignment: number;
  /** Overall lean of the finished stack, radians. */
  lean: number;
  /** How compressed the marshmallow layer ended up, 0..1. */
  squish: number;
  /** Total crumbs shed, 0..1. */
  crumbs: number;
  /** Total smear, 0..1. */
  smear: number;
  /** Seconds taken to assemble. */
  seconds: number;
  /** 0..1 — how neat the stack is. Descriptive only, never shown as a score. */
  tidiness: number;
  label: string;
}

export function summariseAssembly(assembly: AssemblyState): AssemblySummary {
  const placed = assembly.components.filter((c) => c.placed);
  if (placed.length === 0) {
    return {
      misalignment: 0,
      maxMisalignment: 0,
      lean: 0,
      squish: 0,
      crumbs: 0,
      smear: 0,
      seconds: assembly.elapsed,
      tidiness: 1,
      label: 'Unassembled',
    };
  }

  let offsetTotal = 0;
  let offsetMax = 0;
  let lean = 0;
  let crumbs = 0;
  let smear = 0;
  let squish = 0;
  for (const c of placed) {
    const h = Math.sqrt(c.offset.x * c.offset.x + c.offset.z * c.offset.z);
    offsetTotal += h;
    if (h > offsetMax) offsetMax = h;
    lean += c.tilt;
    crumbs += c.crumbs;
    smear += c.smear;
    if (c.kind === 'marshmallow') squish = c.squish;
  }

  const misalignment = offsetTotal / placed.length;
  const tidiness = clamp01(1 - misalignment / 0.05 - Math.abs(lean) * 0.8);

  let label: string;
  if (tidiness > 0.82) label = 'Neatly stacked';
  else if (tidiness > 0.55) label = 'Honestly assembled';
  else if (tidiness > 0.3) label = 'Leaning, but holding';
  else label = 'Gloriously lopsided';

  return {
    misalignment,
    maxMisalignment: offsetMax,
    lean,
    squish,
    crumbs: clamp01(crumbs),
    smear: clamp01(smear),
    seconds: assembly.elapsed,
    tidiness,
    label,
  };
}
