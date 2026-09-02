/**
 * Marshmallow roasting.
 *
 * This is the tactile heart of Some More (spec §4.2), so it is a real thermal
 * model rather than a timer. The marshmallow surface is divided into patches
 * on a latitude × longitude grid; each patch independently tracks temperature,
 * moisture, browning, char, blistering and melt.
 *
 * The two properties that make it *feel* right:
 *
 *  1. **Sugar is a poor conductor.** Neighbour conduction is deliberately weak,
 *     so one-sided roasting stays one-sided. This is the entire reason
 *     rotation matters.
 *  2. **Moisture must boil off first.** Surface temperature stalls near 100 °C
 *     until the patch dries, then climbs fast — which is why a marshmallow
 *     resists, resists, and then suddenly goes.
 *
 * There is no failure state. A burned marshmallow is a story (spec §4.2).
 */

import { clamp, clamp01, inverseLerp, lerp, mean, sigmoid, smoothstep, standardDeviation } from './math.js';
import { orientationFactor, sampleHeat } from './heatfield.js';
import type { FireState } from './fire.js';
import type { Rng } from './rng.js';
import { vec3, type Vec3 } from './types.js';

// --- Tuning ---------------------------------------------------------------
// Every constant that shapes how roasting *feels* lives here, together, so it
// can be tuned rapidly against real input timelines (risk R1).
export const ROAST_TUNING = {
  /** Latitude bands and longitude columns. 8×4 = 32 patches at full quality. */
  longitudeCount: 8,
  latitudeCount: 4,
  /** °C the surface starts at. */
  startTempC: 12,
  /** Heat lost to the night air per second per °C above ambient. */
  coolingRate: 0.11,
  /** Extra cooling from wind chill at 1 m/s. */
  windCooling: 0.02,
  /** Heat absorbed per unit of incoming flux. */
  absorption: 0.85,
  /** Weak on purpose — see note (1) above. */
  conduction: 0.055,
  /** Starting surface moisture. */
  startMoisture: 0.45,
  /** Temperature at which surface water begins boiling off. */
  boilTempC: 98,
  /** Rate moisture leaves the surface once boiling. */
  evaporationRate: 0.022,
  /**
   * Fraction of incoming heat consumed by evaporation while the surface is
   * still wet. Tapers as the patch dries, which is what turns the stall into
   * a *release* rather than a wall.
   */
  latentFractionMax: 0.94,
  /** Browning (caramelisation) midpoint and steepness. */
  brownMidpointC: 152,
  brownSteepness: 0.09,
  brownRate: 0.017,
  /** Charring starts well above browning. */
  charMidpointC: 224,
  charSteepness: 0.11,
  charRate: 0.02,
  /** Blistering happens when a browning patch heats *fast*. */
  blisterRate: 0.5,
  blisterHeatingThreshold: 5.5,
  /** Interior melt accumulates from total heat soak. */
  meltRate: 0.0032,
  meltTempC: 85,
  /** Melt at which the marshmallow slides off the stick. */
  meltFallThreshold: 1,
  /** Ignition needs char, temperature, and air all at once. */
  ignitionTempC: 236,
  ignitionCharThreshold: 0.5,
  /** Self-heating once alight, °C/s. */
  flameSelfHeat: 62,
  /** How fast fire spreads to neighbouring patches, per second. */
  flameSpread: 1.35,
  /** Seconds a patch burns before consuming its available fuel. */
  flameBurnRate: 0.11,
  /** Blowing this hard extinguishes. */
  blowExtinguishThreshold: 0.45,
} as const;

export interface Patch {
  /** Unit-sphere-ish surface normal in marshmallow local space. */
  readonly normal: Vec3;
  /** Local-space offset from the marshmallow centre. */
  readonly offset: Vec3;
  /** Which longitude column (0..longitudeCount-1). */
  readonly column: number;
  /** Which latitude band (0..latitudeCount-1). */
  readonly row: number;
  temperatureC: number;
  moisture: number;
  brown: number;
  char: number;
  blister: number;
  /** 0 = not alight, 1 = fully alight. */
  aflame: number;
  /** Fuel remaining for flame at this patch. */
  fuel: number;
  /** Cached heating rate from the previous step, used for blistering. */
  lastHeatingRate: number;
}

export interface MarshmallowState {
  patches: Patch[];
  /** Rotation of the marshmallow about the stick axis, radians. */
  rotation: number;
  /** Angular velocity, rad/s — used to detect and reward steady turning. */
  angularVelocity: number;
  /** World position of the marshmallow centre. */
  position: Vec3;
  /** Interior melt, 0..1+. Past 1 the marshmallow falls off the stick. */
  melt: number;
  /** Sag from melting, drives the geometry droop. */
  sag: number;
  /** True once it has slid off the stick. */
  fallen: boolean;
  /** Whether any patch is currently alight. */
  burning: boolean;
  /** Seconds spent roasting. */
  elapsed: number;
  /** Total rotation travelled, radians — how much the player actually turned it. */
  rotationTravel: number;
  /** Seconds spent with any patch aflame. */
  flameSeconds: number;
  /** Ignition events this session — a story beat, not a penalty. */
  ignitionCount: number;
  /** Radius of the marshmallow in metres. */
  readonly radius: number;
  /** Half-length along the stick axis. */
  readonly halfLength: number;
  /** Set when the marshmallow ignites this step, for one-shot audio/particles. */
  ignitedThisStep: boolean;
  /** Set when it is blown out this step. */
  extinguishedThisStep: boolean;
}

/** Builds the patch grid for a capsule-ish marshmallow. */
export function createMarshmallow(options?: {
  longitudeCount?: number;
  latitudeCount?: number;
  radius?: number;
  halfLength?: number;
  startTempC?: number;
  moisture?: number;
}): MarshmallowState {
  const lon = options?.longitudeCount ?? ROAST_TUNING.longitudeCount;
  const lat = options?.latitudeCount ?? ROAST_TUNING.latitudeCount;
  const radius = options?.radius ?? 0.026;
  const halfLength = options?.halfLength ?? 0.024;
  const patches: Patch[] = [];

  for (let row = 0; row < lat; row++) {
    // Latitude runs along the stick axis (local Y), from one flat end to the other.
    const v = lat === 1 ? 0.5 : row / (lat - 1);
    const axial = lerp(-1, 1, v);
    for (let col = 0; col < lon; col++) {
      const theta = (col / lon) * Math.PI * 2;
      const nx = Math.cos(theta);
      const nz = Math.sin(theta);
      // Ends of the capsule tilt their normals outward along the axis.
      const endBias = Math.abs(axial) ** 2.2 * Math.sign(axial);
      const normal = normalise(vec3(nx * (1 - Math.abs(endBias) * 0.55), endBias * 0.85, nz * (1 - Math.abs(endBias) * 0.55)));
      patches.push({
        normal,
        offset: vec3(nx * radius, axial * halfLength, nz * radius),
        column: col,
        row,
        temperatureC: options?.startTempC ?? ROAST_TUNING.startTempC,
        moisture: options?.moisture ?? ROAST_TUNING.startMoisture,
        brown: 0,
        char: 0,
        blister: 0,
        aflame: 0,
        fuel: 1,
        lastHeatingRate: 0,
      });
    }
  }

  return {
    patches,
    rotation: 0,
    angularVelocity: 0,
    position: vec3(0, 0.5, 0.55),
    melt: 0,
    sag: 0,
    fallen: false,
    burning: false,
    elapsed: 0,
    rotationTravel: 0,
    flameSeconds: 0,
    ignitionCount: 0,
    radius,
    halfLength,
    ignitedThisStep: false,
    extinguishedThisStep: false,
  };
}

function normalise(v: Vec3): Vec3 {
  const len = Math.sqrt(v.x * v.x + v.y * v.y + v.z * v.z) || 1;
  return vec3(v.x / len, v.y / len, v.z / len);
}

/** Player input for one simulation step. */
export interface RoastInput {
  /** Desired marshmallow centre in world space (set by the stick/hand). */
  position: Vec3;
  /** Absolute rotation about the stick axis, radians. */
  rotation: number;
  /** 0..1 blow strength, for extinguishing a flaming marshmallow. */
  blow?: number;
}

// Scratch objects reused every step — the simulation budget forbids per-frame
// allocation in this hot path.
const worldNormal = vec3();
const worldPoint = vec3();

/**
 * Advances the marshmallow one fixed timestep.
 *
 * Deterministic given the same fire, input and RNG stream.
 */
export function stepRoast(
  marshmallow: MarshmallowState,
  fire: FireState,
  input: RoastInput,
  dt: number,
  rng: Rng,
): void {
  const T = ROAST_TUNING;
  marshmallow.elapsed += dt;
  marshmallow.ignitedThisStep = false;
  marshmallow.extinguishedThisStep = false;

  // --- Motion -----------------------------------------------------------
  const previousRotation = marshmallow.rotation;
  if (!marshmallow.fallen) {
    marshmallow.position.x = input.position.x;
    marshmallow.position.y = input.position.y;
    marshmallow.position.z = input.position.z;
    marshmallow.rotation = input.rotation;
  }
  const rotationDelta = marshmallow.rotation - previousRotation;
  marshmallow.angularVelocity = dt > 0 ? rotationDelta / dt : 0;
  marshmallow.rotationTravel += Math.abs(rotationDelta);

  const cos = Math.cos(marshmallow.rotation);
  const sin = Math.sin(marshmallow.rotation);
  const windCool = T.windCooling * fire.windSpeed;
  const blow = clamp01(input.blow ?? 0);

  let anyFlame = false;
  let heatSoak = 0;

  const patches = marshmallow.patches;
  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i] as Patch;

    // Rotate the patch into world space about the stick axis (local Y).
    worldNormal.x = patch.normal.x * cos - patch.normal.z * sin;
    worldNormal.y = patch.normal.y;
    worldNormal.z = patch.normal.x * sin + patch.normal.z * cos;

    worldPoint.x = marshmallow.position.x + (patch.offset.x * cos - patch.offset.z * sin);
    worldPoint.y = marshmallow.position.y + patch.offset.y;
    worldPoint.z = marshmallow.position.z + (patch.offset.x * sin + patch.offset.z * cos);

    const heat = sampleHeat(fire, worldPoint);
    const facing = orientationFactor(worldNormal, worldPoint, fire);

    // Radiant heat is strongly directional; convective heat much less so,
    // because hot gas flows around the object.
    const incoming = (heat.radiant * facing + heat.convective * lerp(0.55, 1, facing)) * T.absorption;

    // --- Evaporation ---------------------------------------------------
    // While there is surface moisture and the patch is at boiling point, the
    // incoming energy goes into evaporation instead of temperature. This is
    // the stall that makes the later browning feel sudden.
    let latent = 0;
    if (patch.moisture > 0.001 && patch.temperatureC >= T.boilTempC - 8) {
      const evaporation = Math.min(
        patch.moisture,
        T.evaporationRate * clamp01(incoming / 10) * dt,
      );
      patch.moisture -= evaporation;
      // A wet surface cannot climb much past boiling: almost all the incoming
      // energy goes into driving water off. As the patch dries the fraction
      // falls away, so temperature is released smoothly rather than snapping.
      latent = incoming * T.latentFractionMax * clamp01(patch.moisture * 4.5);
    }

    // --- Self-sustaining flame ------------------------------------------
    let selfHeat = 0;
    if (patch.aflame > 0.01) {
      anyFlame = true;
      selfHeat = T.flameSelfHeat * patch.aflame;
      patch.fuel = Math.max(0, patch.fuel - T.flameBurnRate * patch.aflame * dt);
      // Blowing, wind and running out of fuel all put it out.
      const extinguish =
        (blow > T.blowExtinguishThreshold ? (blow - T.blowExtinguishThreshold) * 6 : 0) +
        (patch.fuel <= 0 ? 2.5 : 0) +
        smoothstep(2.5, 6, fire.windSpeed) * 0.9;
      patch.aflame = clamp01(patch.aflame + (0.9 - extinguish) * dt);
      if (patch.aflame <= 0.01) {
        patch.aflame = 0;
        marshmallow.extinguishedThisStep = true;
      }
    }

    // --- Temperature -----------------------------------------------------
    const cooling = (patch.temperatureC - heat.airTempC) * (T.coolingRate + windCool);
    const heatingRate = incoming - latent + selfHeat - cooling;
    patch.temperatureC = Math.max(fire.config.ambientC - 4, patch.temperatureC + heatingRate * dt);
    patch.lastHeatingRate = heatingRate;
    heatSoak += Math.max(0, patch.temperatureC - T.meltTempC);

    // --- Browning --------------------------------------------------------
    // Dry sugar caramelises; wet sugar does not. The moisture gate is why a
    // damp patch stays pale even while it is hot.
    const dryGate = 1 - smoothstep(0.02, 0.22, patch.moisture);
    const brownDrive = sigmoid(patch.temperatureC, T.brownMidpointC, T.brownSteepness) * dryGate;
    patch.brown = clamp01(patch.brown + brownDrive * T.brownRate * dt);

    // --- Charring --------------------------------------------------------
    // Charring is what happens to sugar that has *already* caramelised: the
    // browning reactions run first and the surface carbonises through them.
    // Without that ordering, both sigmoids saturate together over a hot enough
    // fire and char simply accumulates faster than brown, because its rate is
    // higher. Measured over open flame, that is exactly what happened — char
    // 0.27 against brown 0.23 at thirty seconds, char ahead at every step —
    // so a marshmallow held in the flames went from pale to blackening
    // *without ever passing through golden*. The one outcome the whole product
    // is named after was unreachable on the first fire a player meets.
    //
    // Gating on the patch's own browning fixes the ordering at every
    // temperature rather than by retuning two rates against one fire.
    const charDrive =
      sigmoid(patch.temperatureC, T.charMidpointC, T.charSteepness) *
      dryGate *
      smoothstep(0.18, 0.62, patch.brown);
    patch.char = clamp01(patch.char + charDrive * T.charRate * dt);

    // --- Blistering ------------------------------------------------------
    // Bubbles form when a browning surface is heated hard and fast.
    if (heatingRate > T.blisterHeatingThreshold && patch.brown > 0.15 && patch.brown < 0.95) {
      const turbulenceBoost = 0.6 + heat.turbulence * 0.8;
      patch.blister = clamp01(
        patch.blister + T.blisterRate * clamp01(heatingRate / 22) * turbulenceBoost * dt,
      );
    }

    // --- Ignition --------------------------------------------------------
    if (
      patch.aflame <= 0 &&
      patch.fuel > 0.05 &&
      patch.char >= T.ignitionCharThreshold &&
      patch.temperatureC >= T.ignitionTempC &&
      fire.oxygen > 0.2
    ) {
      // A small stochastic element so ignition is a moment, not a formula the
      // player can compute — but seeded, so it still replays exactly.
      const ignitionChance = clamp01((patch.temperatureC - T.ignitionTempC) / 60) * 0.55;
      if (heat.inFlame || rng.chance(ignitionChance * dt * 60 * 0.05)) {
        patch.aflame = 0.35;
        marshmallow.ignitedThisStep = true;
        marshmallow.ignitionCount++;
        anyFlame = true;
      }
    }
  }

  // --- Neighbour conduction and flame spread ------------------------------
  // Done in a second pass so the result does not depend on iteration order —
  // an ordering dependency here would be a determinism bug across platforms.
  applyConductionAndSpread(marshmallow, dt, blow);

  // --- Melt and sag -------------------------------------------------------
  const soakNormalised = heatSoak / Math.max(1, patches.length * 120);
  marshmallow.melt = clamp(marshmallow.melt + soakNormalised * T.meltRate * dt, 0, 2);
  marshmallow.sag = smoothstep(0.25, 1, marshmallow.melt);

  if (!marshmallow.fallen && marshmallow.melt >= T.meltFallThreshold) {
    // Not a failure — it lands in the fire, sizzles, and the player gets
    // another marshmallow (spec §4.2).
    marshmallow.fallen = true;
  }

  marshmallow.burning = anyFlame;
  if (anyFlame) marshmallow.flameSeconds += dt;
}

const conductionScratch: number[] = [];
const spreadScratch: number[] = [];

function applyConductionAndSpread(marshmallow: MarshmallowState, dt: number, blow: number): void {
  const T = ROAST_TUNING;
  const patches = marshmallow.patches;
  const lon = T.longitudeCount;
  conductionScratch.length = patches.length;
  spreadScratch.length = patches.length;

  const columns = uniqueColumnCount(patches);
  const rows = uniqueRowCount(patches);

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i] as Patch;
    let tempSum = 0;
    let flameSum = 0;
    let count = 0;
    // Four-neighbour stencil, wrapping around longitude (it is a cylinder) and
    // clamping across latitude (the ends are caps, not a torus).
    const neighbourIndices = [
      indexOf(patch.row, (patch.column + 1) % columns, columns),
      indexOf(patch.row, (patch.column - 1 + columns) % columns, columns),
      patch.row > 0 ? indexOf(patch.row - 1, patch.column, columns) : -1,
      patch.row < rows - 1 ? indexOf(patch.row + 1, patch.column, columns) : -1,
    ];
    for (const n of neighbourIndices) {
      if (n < 0 || n >= patches.length) continue;
      const other = patches[n] as Patch;
      tempSum += other.temperatureC;
      flameSum += other.aflame;
      count++;
    }
    conductionScratch[i] = count > 0 ? tempSum / count - patch.temperatureC : 0;
    spreadScratch[i] = count > 0 ? flameSum / count : 0;
  }
  void lon;

  for (let i = 0; i < patches.length; i++) {
    const patch = patches[i] as Patch;
    patch.temperatureC += (conductionScratch[i] as number) * T.conduction * dt * 60 * 0.1;
    const neighbourFlame = spreadScratch[i] as number;
    if (patch.aflame <= 0 && neighbourFlame > 0.25 && patch.fuel > 0.05 && blow < T.blowExtinguishThreshold) {
      patch.aflame = clamp01(patch.aflame + T.flameSpread * neighbourFlame * dt * 0.5);
      if (patch.aflame > 0.02) marshmallow.burning = true;
    }
  }
}

function uniqueColumnCount(patches: readonly Patch[]): number {
  let max = 0;
  for (const p of patches) if (p.column > max) max = p.column;
  return max + 1;
}

function uniqueRowCount(patches: readonly Patch[]): number {
  let max = 0;
  for (const p of patches) if (p.row > max) max = p.row;
  return max + 1;
}

function indexOf(row: number, column: number, columns: number): number {
  return row * columns + column;
}

/** Extinguishes every flame — the blow-out gesture, applied as an event. */
export function blowOut(marshmallow: MarshmallowState): boolean {
  let extinguished = false;
  for (const patch of marshmallow.patches) {
    if (patch.aflame > 0) {
      patch.aflame = 0;
      extinguished = true;
    }
  }
  if (extinguished) {
    marshmallow.burning = false;
    marshmallow.extinguishedThisStep = true;
  }
  return extinguished;
}

// --- Outcome summary -------------------------------------------------------

/** Descriptive outcome classes. Never ranked, never scored (spec §4.5). */
export type RoastDescriptor =
  | 'pale'
  | 'lightly-golden'
  | 'evenly-golden'
  | 'deeply-caramelised'
  | 'blistered'
  | 'patchy'
  | 'one-sided'
  | 'charred'
  | 'ember';

export interface RoastSummary {
  /** Mean browning across all patches, 0..1. */
  brown: number;
  /** Mean char, 0..1. */
  char: number;
  /** Mean blistering, 0..1. */
  blister: number;
  /** 1 = perfectly even, 0 = wildly uneven. */
  evenness: number;
  /** How lopsided the roast is between opposing sides, 0..1. */
  sidedness: number;
  /** Peak temperature reached anywhere on the surface. */
  peakTempC: number;
  melt: number;
  fallen: boolean;
  ignitionCount: number;
  flameSeconds: number;
  seconds: number;
  rotationTravel: number;
  descriptors: RoastDescriptor[];
  /** Human-readable phrase for the Passport. Descriptive, never a grade. */
  label: string;
}

export function summariseRoast(marshmallow: MarshmallowState): RoastSummary {
  const patches = marshmallow.patches;
  const browns = patches.map((p) => p.brown);
  const chars = patches.map((p) => p.char);
  const blisters = patches.map((p) => p.blister);
  const temps = patches.map((p) => p.temperatureC);

  const brown = mean(browns);
  const char = mean(chars);
  const blister = mean(blisters);
  const evenness = clamp01(1 - standardDeviation(browns) * 2.6);
  const peakTempC = temps.reduce((a, b) => (b > a ? b : a), -Infinity);

  // Sidedness compares each longitude column against the one opposite it.
  const columns = uniqueColumnCount(patches);
  let sideDiff = 0;
  let comparisons = 0;
  for (let c = 0; c < Math.floor(columns / 2); c++) {
    const a = columnMean(patches, c, columns);
    const b = columnMean(patches, c + Math.floor(columns / 2), columns);
    sideDiff += Math.abs(a - b);
    comparisons++;
  }
  const sidedness = comparisons > 0 ? clamp01(sideDiff / comparisons * 1.8) : 0;

  const descriptors: RoastDescriptor[] = [];
  if (char > 0.55 || marshmallow.flameSeconds > 6) descriptors.push('ember');
  else if (char > 0.3) descriptors.push('charred');
  if (blister > 0.35) descriptors.push('blistered');
  if (sidedness > 0.35) descriptors.push('one-sided');
  else if (evenness < 0.45) descriptors.push('patchy');
  if (brown < 0.12) descriptors.push('pale');
  else if (brown < 0.35) descriptors.push('lightly-golden');
  else if (brown < 0.72) {
    descriptors.push(evenness > 0.62 && sidedness < 0.3 ? 'evenly-golden' : 'lightly-golden');
  } else descriptors.push('deeply-caramelised');

  return {
    brown,
    char,
    blister,
    evenness,
    sidedness,
    peakTempC: Number.isFinite(peakTempC) ? peakTempC : 0,
    melt: marshmallow.melt,
    fallen: marshmallow.fallen,
    ignitionCount: marshmallow.ignitionCount,
    flameSeconds: marshmallow.flameSeconds,
    seconds: marshmallow.elapsed,
    rotationTravel: marshmallow.rotationTravel,
    descriptors,
    label: describeRoast(descriptors, marshmallow),
  };
}

function columnMean(patches: readonly Patch[], column: number, columns: number): number {
  let total = 0;
  let count = 0;
  for (const p of patches) {
    if (p.column % columns === column) {
      total += p.brown + p.char;
      count++;
    }
  }
  return count > 0 ? total / count : 0;
}

function describeRoast(descriptors: readonly RoastDescriptor[], marshmallow: MarshmallowState): string {
  if (marshmallow.fallen) return 'Lost to the fire';
  if (descriptors.includes('ember')) {
    return marshmallow.ignitionCount > 0 ? 'Blackened and blown out' : 'Burnt through';
  }
  if (descriptors.includes('charred')) return 'Well past golden';
  if (descriptors.includes('evenly-golden')) {
    return descriptors.includes('blistered') ? 'Golden and blistered' : 'Evenly golden';
  }
  if (descriptors.includes('one-sided')) return 'Golden on one side';
  if (descriptors.includes('deeply-caramelised')) return 'Deeply caramelised';
  if (descriptors.includes('pale')) return 'Barely warmed';
  if (descriptors.includes('patchy')) return 'Patchy but promising';
  return 'Lightly toasted';
}

/**
 * Per-patch colour used by the renderer's vertex colours.
 * Kept in the simulation package so browning is defined once and the
 * headless tests can assert on the same values the player sees.
 */
export function patchColor(patch: Patch, out: [number, number, number]): [number, number, number] {
  // Cream → gold → deep brown → black, then a glowing overlay when aflame.
  const brown = patch.brown;
  const char = patch.char;
  const cream: [number, number, number] = [0.97, 0.94, 0.86];
  const gold: [number, number, number] = [0.83, 0.58, 0.25];
  const deep: [number, number, number] = [0.42, 0.22, 0.09];
  const black: [number, number, number] = [0.09, 0.07, 0.06];

  let r: number;
  let g: number;
  let b: number;
  if (brown < 0.5) {
    const t = inverseLerp(0, 0.5, brown);
    r = lerp(cream[0], gold[0], t);
    g = lerp(cream[1], gold[1], t);
    b = lerp(cream[2], gold[2], t);
  } else {
    const t = inverseLerp(0.5, 1, brown);
    r = lerp(gold[0], deep[0], t);
    g = lerp(gold[1], deep[1], t);
    b = lerp(gold[2], deep[2], t);
  }
  const charT = smoothstep(0.1, 0.85, char);
  r = lerp(r, black[0], charT);
  g = lerp(g, black[1], charT);
  b = lerp(b, black[2], charT);

  if (patch.aflame > 0) {
    const glow = patch.aflame * 0.7;
    r = clamp01(r + glow * 0.9);
    g = clamp01(g + glow * 0.35);
    b = clamp01(b + glow * 0.05);
  }
  out[0] = r;
  out[1] = g;
  out[2] = b;
  return out;
}
