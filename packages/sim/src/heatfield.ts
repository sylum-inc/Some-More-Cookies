/**
 * The spatial heat field around a campfire.
 *
 * Two sources are modelled separately because they behave differently, and
 * that difference is the roasting skill curve (ARCHITECTURE §3.2):
 *
 *   Flame  — hot, tall, unstable, wind-deflected, and weak low down near the
 *            edge. Fast but uneven; the source of blistering and ignition.
 *   Embers — lower peak air temperature but steady, low, wide, and *boosted*
 *            by wind. Slow, even, and the way to a properly golden marshmallow.
 *
 * Nothing in the UI says this. The player finds it.
 */

import { clamp, clamp01, lerp, smoothstep } from './math.js';
import { fbm1D } from './rng.js';
import type { FireState } from './fire.js';
import type { Vec3 } from './types.js';

export interface HeatSample {
  /** Radiant flux arriving at the point, in heating units (°C/s at unit absorption). */
  radiant: number;
  /** Convective flux from the rising column of hot gas. */
  convective: number;
  /** Local air temperature in °C — drives cooling, not heating. */
  airTempC: number;
  /** How turbulent it is here, 0..1. Turbulence makes browning uneven. */
  turbulence: number;
  /** True when the point sits inside the visible flame envelope. */
  inFlame: boolean;
}

const reusableSample: HeatSample = {
  radiant: 0,
  convective: 0,
  airTempC: 0,
  turbulence: 0,
  inFlame: false,
};

/**
 * Samples the heat field at a world point (fire pit centred at the origin,
 * +Y up).
 *
 * Writes into a shared object by default: this is called once per marshmallow
 * patch per frame, and the simulation budget (≤1.5 ms) does not allow 32
 * allocations per step. Pass `out` when a persistent copy is needed.
 */
export function sampleHeat(fire: FireState, point: Vec3, out: HeatSample = reusableSample): HeatSample {
  const { config } = fire;
  const wind = fire.windSpeed;

  // --- Wind deflection --------------------------------------------------
  // The hot column leans downwind, increasingly with height. Sampling in the
  // *deflected* frame is what makes standing downwind of a windy fire hot and
  // standing upwind cold.
  const lean = smoothstep(0.2, 4, wind) * 0.85;
  const leanX = Math.cos(fire.windDirection) * lean * Math.max(0, point.y);
  const leanZ = Math.sin(fire.windDirection) * lean * Math.max(0, point.y);
  const dx = point.x - leanX;
  const dz = point.z - leanZ;
  const horizontal = Math.sqrt(dx * dx + dz * dz);
  const height = point.y;

  // --- Ember radiation --------------------------------------------------
  // Treated as a warm disc at ground level. The `+0.09` near-field softening
  // prevents a singularity when the marshmallow is laid right on the coals —
  // without it, touching the bed would produce infinite heat.
  // Radiance depends on how *hot* the coals are, not on how big the pile is:
  // a modest bed still glows at full strength, it simply covers less ground
  // (which `emberSpread` below accounts for). Scaling linearly with mass made
  // a naturally burned-down fire useless for roasting.
  const emberStrength = clamp01(fire.emberMass * 1.9) * clamp01((fire.emberTemp - 120) / 700);
  const emberDistSq = horizontal * horizontal + (height + 0.04) * (height + 0.04) + 0.14;
  // Coals radiate mostly upward, so being above the bed beats being beside it.
  const emberUpBias = lerp(0.45, 1, clamp01((height + 0.05) / (horizontal + 0.25)));
  // A wide bed is a wide source, so it falls off more gently than a point.
  const emberSpread = 1 + smoothstep(0, config.emberRadius * 2.2, horizontal) * 0.6;
  // Wind fans coals brighter — the opposite of its effect on flame.
  const emberWind = 1 + smoothstep(0.3, 3.5, wind) * 0.32;
  const radiantEmber = (emberStrength * 13 * emberUpBias * emberWind) / (emberDistSq * emberSpread);

  // --- Flame radiation --------------------------------------------------
  // Modelled as a source at roughly 40% of the flame's height.
  const flameCentreY = fire.flameHeight * 0.4;
  const flameDy = height - flameCentreY;
  // A flame column is a large *extended* source, not a point: the softening
  // term is generous so the falloff near the fire is gradual rather than
  // singular. Without it, a fully alight fire scorches everything within half
  // a metre and the whole browning band collapses.
  const flameDistSq = horizontal * horizontal + flameDy * flameDy + 0.16;
  const radiantFlame = (fire.flame * 3.2) / flameDistSq;

  // --- Convection -------------------------------------------------------
  // A rising column that widens and cools with height. Only points inside it
  // get convective heat, which is why holding the marshmallow *above* the fire
  // is fast and dangerous while holding it *beside* the fire is slow and safe.
  const columnRadius = config.emberRadius * 0.9 + height * 0.42;
  const insideColumn = 1 - smoothstep(columnRadius * 0.55, columnRadius, horizontal);
  const columnStrength = fire.flame * 0.75 + emberStrength * 0.45;
  // Hot gas cools as it rises and mixes.
  const heightFalloff = 1 / (1 + height * height * 2.6);
  const convective = insideColumn * columnStrength * 15 * heightFalloff * (height > -0.05 ? 1 : 0);

  // --- Local air temperature -------------------------------------------
  const airTempC =
    config.ambientC +
    insideColumn * columnStrength * 260 * heightFalloff +
    clamp01(emberStrength / (emberDistSq + 0.4)) * 45;

  // --- Turbulence -------------------------------------------------------
  // Noise-driven so it replays identically; scales with wind and flame.
  const turbulenceNoise = fbm1D(0x7c2b, fire.elapsed * 1.7 + horizontal * 3, 2);
  const turbulence = clamp01(
    (insideColumn * 0.6 + smoothstep(0.5, 3.5, wind) * 0.5) * (0.55 + turbulenceNoise * 0.9),
  );

  out.radiant = radiantEmber + radiantFlame;
  out.convective = convective;
  out.airTempC = airTempC;
  out.turbulence = turbulence;
  out.inFlame = insideColumn > 0.42 && height < fire.flameHeight && fire.flame > 0.12;
  return out;
}

/**
 * Directional heating factor for a surface patch: a Lambertian term against
 * the direction of the dominant heat source, softened so that a patch facing
 * away still receives some scattered heat (real fires are not point lights in
 * a vacuum).
 */
export function orientationFactor(
  patchNormal: Vec3,
  patchPosition: Vec3,
  fire: FireState,
): number {
  // Direction from the patch toward the hot region: the ember bed if the fire
  // has burned down, otherwise the middle of the flame.
  const sourceY = fire.flame > 0.25 ? fire.flameHeight * 0.35 : 0.02;
  let vx = -patchPosition.x;
  let vy = sourceY - patchPosition.y;
  let vz = -patchPosition.z;
  const len = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
  vx /= len;
  vy /= len;
  vz /= len;
  const dot = patchNormal.x * vx + patchNormal.y * vy + patchNormal.z * vz;
  // 0.22 floor: scattered and re-radiated heat reaches the shadowed side, so
  // an un-rotated marshmallow still slowly warms all over instead of staying
  // frozen on one face.
  return clamp(0.22 + 0.78 * Math.max(0, dot), 0, 1);
}

/**
 * A convenience readout used by the UI's non-numeric heat indicator (an
 * accessibility requirement: heat must be legible without relying on
 * colour alone).
 */
export type HeatBand = 'cold' | 'warm' | 'toasting' | 'browning' | 'scorching' | 'burning';

export function heatBand(fluxTotal: number): HeatBand {
  if (fluxTotal < 1.5) return 'cold';
  if (fluxTotal < 5) return 'warm';
  if (fluxTotal < 11) return 'toasting';
  if (fluxTotal < 20) return 'browning';
  if (fluxTotal < 34) return 'scorching';
  return 'burning';
}
