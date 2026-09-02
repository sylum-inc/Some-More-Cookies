/**
 * The PS1 render pipeline (ADR-0003).
 *
 * The look is reproduced from its *causes*, not applied as a filter:
 *
 *   1. Vertex jitter — the console had no sub-pixel vertex precision, so
 *      positions snapped to a coarse raster grid before the perspective
 *      divide. Reproducing it in clip space gives the real wobble, including
 *      the way it worsens with distance.
 *   2. Affine texture mapping — no perspective-correct interpolation, so
 *      textures swim across large triangles. Reproduced by carrying UV*w and
 *      dividing by an interpolated w.
 *   3. Low internal resolution + nearest upscale.
 *   4. Ordered dithering and colour quantisation.
 *   5. Short exponential fog.
 *
 * Every effect is per-material and per-tier controllable, which is what makes
 * both the sandwich fidelity bump and the accessibility "reduce effects"
 * setting possible.
 */

import * as THREE from 'three';

/** Material fidelity tiers (ARCHITECTURE §4.2). */
export type MaterialTier = 'ps1' | 'ps1Plus' | 'hero';

export interface Ps1Params {
  /** Virtual raster width for vertex snapping. Lower = more wobble. */
  jitterResolution: number;
  /** 0 = no jitter, 1 = full PS1 wobble. */
  jitterAmount: number;
  /** 0 = perspective correct, 1 = fully affine. */
  affineness: number;
  /** Distance where fog begins to bite. */
  fogNear: number;
  fogFar: number;
}

export const TIER_PARAMS: Record<MaterialTier, Ps1Params> = {
  ps1: { jitterResolution: 160, jitterAmount: 1, affineness: 1, fogNear: 4, fogFar: 26 },
  // The SM-01 is Some More technology: crisper decals, real specular, but
  // still clearly of this world.
  ps1Plus: { jitterResolution: 320, jitterAmount: 0.45, affineness: 0.35, fogNear: 6, fogFar: 34 },
  // The finished sandwich — the only object permitted the full bump.
  hero: { jitterResolution: 960, jitterAmount: 0, affineness: 0, fogNear: 10, fogFar: 60 },
};

/** Quality tiers scale cost, not art direction. */
export type QualityTier = 'low' | 'mid' | 'high';

export interface QualitySettings {
  /** Internal render height in pixels; width follows the aspect ratio. */
  internalHeight: number;
  shadowMapSize: number;
  maxParticles: number;
  textureScale: number;
  drawDistance: number;
  /** Marshmallow patch grid. */
  patchLongitude: number;
  patchLatitude: number;
  enableShadows: boolean;
}

export const QUALITY: Record<QualityTier, QualitySettings> = {
  low: {
    internalHeight: 180,
    shadowMapSize: 256,
    maxParticles: 90,
    textureScale: 0.5,
    drawDistance: 22,
    patchLongitude: 6,
    patchLatitude: 3,
    enableShadows: false,
  },
  mid: {
    internalHeight: 240,
    shadowMapSize: 512,
    maxParticles: 220,
    textureScale: 1,
    drawDistance: 30,
    patchLongitude: 8,
    patchLatitude: 4,
    enableShadows: true,
  },
  high: {
    internalHeight: 360,
    shadowMapSize: 1024,
    maxParticles: 420,
    textureScale: 1,
    drawDistance: 42,
    patchLongitude: 8,
    patchLatitude: 4,
    enableShadows: true,
  },
};

/**
 * Accessibility and art-direction dials.
 *
 * These are the *same* knobs: "reduce dithering" is both an accessibility
 * setting and an art control, which is why they live in one place
 * (ARCHITECTURE §11).
 */
export interface RenderSettings {
  /** 0 disables dithering entirely. */
  dither: number;
  /** 0 disables vertex jitter — helps motion sensitivity. */
  jitter: number;
  /** 0 disables affine swim. */
  affine: number;
  /** Colour depth per channel; 8 = no quantisation. */
  colorDepth: number;
  /** Multiplier on fire brightness (accessibility: fire brightness control). */
  fireBrightness: number;
  /** Multiplier on flicker speed and depth (reduced flicker). */
  flicker: number;
  /** Global contrast lift. */
  contrast: number;
  /** Reduced motion: damps camera shake and sway. */
  reducedMotion: boolean;
  /** Scales the internal resolution further. */
  resolutionScale: number;
}

export const DEFAULT_RENDER_SETTINGS: RenderSettings = {
  dither: 1,
  jitter: 1,
  affine: 1,
  colorDepth: 5,
  fireBrightness: 1,
  flicker: 1,
  contrast: 1,
  reducedMotion: false,
  resolutionScale: 1,
};

// --- Shader chunks ---------------------------------------------------------

/**
 * Injected into the vertex stage. Snapping happens in clip space *before* the
 * perspective divide, which is where the original hardware lost precision.
 */
export const PS1_VERTEX_CHUNK = /* glsl */ `
uniform float uJitterResolution;
uniform float uJitterAmount;
uniform float uAffineness;
varying vec2 vAffineUv;
varying float vAffineW;
varying float vViewDepth;

vec4 ps1Snap(vec4 clipPosition) {
  if (uJitterAmount <= 0.0 || clipPosition.w <= 0.0) return clipPosition;
  // Convert to NDC, snap to a virtual raster, convert back.
  vec2 ndc = clipPosition.xy / clipPosition.w;
  vec2 grid = vec2(uJitterResolution, uJitterResolution * 0.75);
  vec2 snapped = floor(ndc * grid + 0.5) / grid;
  vec2 result = mix(ndc, snapped, uJitterAmount);
  return vec4(result * clipPosition.w, clipPosition.z, clipPosition.w);
}
`;

/**
 * Injected into the fragment stage. Recovers the affine UV by dividing the
 * interpolated UV*w by the interpolated w — the classic swim.
 */
export const PS1_FRAGMENT_CHUNK = /* glsl */ `
uniform float uAffineness;
uniform float uDither;
uniform float uColorDepth;
varying vec2 vAffineUv;
varying float vAffineW;
varying float vViewDepth;

const mat4 BAYER4 = mat4(
   0.0,  8.0,  2.0, 10.0,
  12.0,  4.0, 14.0,  6.0,
   3.0, 11.0,  1.0,  9.0,
  15.0,  7.0, 13.0,  5.0
);

float bayer4(vec2 pixel) {
  int x = int(mod(pixel.x, 4.0));
  int y = int(mod(pixel.y, 4.0));
  vec4 row = (y == 0) ? BAYER4[0] : (y == 1) ? BAYER4[1] : (y == 2) ? BAYER4[2] : BAYER4[3];
  float v = (x == 0) ? row.x : (x == 1) ? row.y : (x == 2) ? row.z : row.w;
  return v / 16.0;
}

vec2 ps1Uv(vec2 perspectiveUv) {
  if (uAffineness <= 0.0) return perspectiveUv;
  vec2 affine = vAffineUv / max(vAffineW, 0.0001);
  return mix(perspectiveUv, affine, uAffineness);
}

vec3 ps1Quantise(vec3 color, vec2 fragCoord) {
  if (uColorDepth >= 8.0) return color;
  float levels = pow(2.0, uColorDepth) - 1.0;
  float threshold = (bayer4(fragCoord) - 0.5) * uDither / levels;
  return floor(clamp(color + threshold, 0.0, 1.0) * levels + 0.5) / levels;
}
`;

export interface Ps1MaterialOptions {
  tier?: MaterialTier;
  settings?: RenderSettings;
  map?: THREE.Texture | null;
  color?: THREE.ColorRepresentation;
  emissive?: THREE.ColorRepresentation;
  emissiveIntensity?: number;
  vertexColors?: boolean;
  transparent?: boolean;
  opacity?: number;
  side?: THREE.Side;
  roughness?: number;
  metalness?: number;
  flatShading?: boolean;
}

/** Uniforms shared by every PS1 material, so settings can be updated globally. */
export interface Ps1Uniforms {
  uJitterResolution: THREE.IUniform<number>;
  uJitterAmount: THREE.IUniform<number>;
  uAffineness: THREE.IUniform<number>;
  uDither: THREE.IUniform<number>;
  uColorDepth: THREE.IUniform<number>;
}

const materialRegistry = new Set<{ material: THREE.Material; uniforms: Ps1Uniforms; tier: MaterialTier }>();

/**
 * Builds a standard Three.js material patched with the PS1 stages.
 *
 * Patching `MeshStandardMaterial` via `onBeforeCompile` rather than writing a
 * bespoke `ShaderMaterial` keeps Three's lighting, shadows and fog working —
 * the selective modern rendering the spec asks for sits *inside* the PS1
 * pipeline rather than beside it.
 */
export function createPs1Material(options: Ps1MaterialOptions = {}): THREE.MeshStandardMaterial {
  const tier = options.tier ?? 'ps1';
  const settings = options.settings ?? DEFAULT_RENDER_SETTINGS;
  const params = TIER_PARAMS[tier];

  const material = new THREE.MeshStandardMaterial({
    map: options.map ?? null,
    color: options.color ?? 0xffffff,
    emissive: options.emissive ?? 0x000000,
    emissiveIntensity: options.emissiveIntensity ?? 1,
    vertexColors: options.vertexColors ?? false,
    transparent: options.transparent ?? false,
    opacity: options.opacity ?? 1,
    side: options.side ?? THREE.FrontSide,
    roughness: options.roughness ?? 0.85,
    metalness: options.metalness ?? 0,
    flatShading: options.flatShading ?? true,
  });

  const uniforms: Ps1Uniforms = {
    uJitterResolution: { value: params.jitterResolution },
    uJitterAmount: { value: params.jitterAmount * settings.jitter },
    uAffineness: { value: params.affineness * settings.affine },
    uDither: { value: settings.dither },
    uColorDepth: { value: settings.colorDepth },
  };

  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader.replace(
      '#include <common>',
      `#include <common>\n${PS1_VERTEX_CHUNK}`,
    );
    // Capture UV*w and w for the affine recovery, then snap the position.
    shader.vertexShader = shader.vertexShader.replace(
      '#include <project_vertex>',
      `#include <project_vertex>
      vAffineW = gl_Position.w;
      #ifdef USE_MAP
        vAffineUv = vMapUv * gl_Position.w;
      #else
        vAffineUv = vec2(0.0);
      #endif
      vViewDepth = -mvPosition.z;
      gl_Position = ps1Snap(gl_Position);`,
    );

    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <common>',
      `#include <common>\n${PS1_FRAGMENT_CHUNK}`,
    );
    // Sample the diffuse map through the affine UV.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <map_fragment>',
      `#ifdef USE_MAP
        vec4 ps1Sampled = texture2D(map, ps1Uv(vMapUv));
        diffuseColor *= ps1Sampled;
      #endif`,
    );
    // Quantise and dither at the very end, in screen space.
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>
      gl_FragColor.rgb = ps1Quantise(gl_FragColor.rgb, gl_FragCoord.xy);`,
    );
  };

  // Changing the key forces a recompile when tiers or settings change.
  material.customProgramCacheKey = () => `ps1-${tier}`;
  materialRegistry.add({ material, uniforms, tier });
  return material;
}

/** Applies updated settings to every material built by `createPs1Material`. */
export function applyRenderSettings(settings: RenderSettings): void {
  for (const entry of materialRegistry) {
    const params = TIER_PARAMS[entry.tier];
    entry.uniforms.uJitterAmount.value = params.jitterAmount * settings.jitter;
    entry.uniforms.uAffineness.value = params.affineness * settings.affine;
    entry.uniforms.uDither.value = settings.dither;
    entry.uniforms.uColorDepth.value = settings.colorDepth;
  }
}

/** Releases a material from the registry (call alongside `dispose`). */
export function releasePs1Material(material: THREE.Material): void {
  for (const entry of materialRegistry) {
    if (entry.material === material) {
      materialRegistry.delete(entry);
      return;
    }
  }
}

export function registeredMaterialCount(): number {
  return materialRegistry.size;
}

// --- Pure helpers (unit tested headlessly) ---------------------------------

/**
 * Internal render size for a viewport. Kept pure so the resolution ladder can
 * be tested without a GPU.
 */
export function internalRenderSize(
  viewportWidth: number,
  viewportHeight: number,
  quality: QualitySettings,
  settings: RenderSettings = DEFAULT_RENDER_SETTINGS,
): { width: number; height: number } {
  const aspect = viewportHeight > 0 ? viewportWidth / viewportHeight : 4 / 3;
  const height = Math.max(120, Math.round(quality.internalHeight * settings.resolutionScale));
  const width = Math.max(160, Math.round(height * aspect));
  return { width, height };
}

/**
 * Picks a starting quality tier from a cheap capability probe.
 *
 * Deliberately not device-string sniffing (ARCHITECTURE §10) — this is a
 * starting guess that the frame-time monitor then corrects.
 */
export function probeQualityTier(input: {
  deviceMemoryGb?: number;
  hardwareConcurrency?: number;
  devicePixelRatio?: number;
  maxTextureSize?: number;
}): QualityTier {
  const memory = input.deviceMemoryGb ?? 4;
  const cores = input.hardwareConcurrency ?? 4;
  const maxTexture = input.maxTextureSize ?? 4096;
  if (maxTexture < 4096 || memory <= 2 || cores <= 2) return 'low';
  if (memory >= 8 && cores >= 8) return 'high';
  return 'mid';
}

/**
 * Rolling frame-time monitor that adjusts the tier.
 *
 * Hysteresis matters: a tier that oscillates is worse than a tier that is
 * slightly wrong, because every change causes a visible resolution pop.
 */
export class AdaptiveQuality {
  private samples: number[] = [];
  private cooldown = 0;

  constructor(
    public tier: QualityTier,
    private readonly targetMs = 16.7,
    private readonly windowSize = 90,
  ) {}

  /** Feeds a frame time in milliseconds. Returns the tier to use. */
  sample(frameMs: number): QualityTier {
    if (Number.isFinite(frameMs) && frameMs > 0) {
      this.samples.push(frameMs);
      if (this.samples.length > this.windowSize) this.samples.shift();
    }
    if (this.cooldown > 0) {
      this.cooldown--;
      return this.tier;
    }
    if (this.samples.length < this.windowSize) return this.tier;

    const sorted = [...this.samples].sort((a, b) => a - b);
    // The 90th percentile, not the mean: a smooth average hides the stutters
    // players actually feel.
    const p90 = sorted[Math.floor(sorted.length * 0.9)] ?? this.targetMs;

    if (p90 > this.targetMs * 1.35 && this.tier !== 'low') {
      this.tier = this.tier === 'high' ? 'mid' : 'low';
      this.reset();
    } else if (p90 < this.targetMs * 0.7 && this.tier !== 'high') {
      this.tier = this.tier === 'low' ? 'mid' : 'high';
      this.reset();
    }
    return this.tier;
  }

  private reset(): void {
    this.samples = [];
    this.cooldown = this.windowSize;
  }

  get sampleCount(): number {
    return this.samples.length;
  }
}

/** Ordered-dither threshold for a pixel — mirrors the shader, for tests. */
export function bayer4x4(x: number, y: number): number {
  const matrix = [
    [0, 8, 2, 10],
    [12, 4, 14, 6],
    [3, 11, 1, 9],
    [15, 7, 13, 5],
  ];
  const row = matrix[((y % 4) + 4) % 4] as number[];
  return (row[((x % 4) + 4) % 4] as number) / 16;
}

/** Quantises a channel with ordered dithering — mirrors the shader, for tests. */
export function quantiseChannel(value: number, depth: number, ditherThreshold: number, ditherAmount = 1): number {
  if (depth >= 8) return value;
  const levels = 2 ** depth - 1;
  const biased = value + ((ditherThreshold - 0.5) * ditherAmount) / levels;
  const clamped = Math.min(1, Math.max(0, biased));
  return Math.floor(clamped * levels + 0.5) / levels;
}

/** Snaps an NDC position to the virtual raster — mirrors the shader, for tests. */
export function snapNdc(x: number, y: number, resolution: number, amount: number): [number, number] {
  if (amount <= 0) return [x, y];
  const gx = resolution;
  const gy = resolution * 0.75;
  const sx = Math.floor(x * gx + 0.5) / gx;
  const sy = Math.floor(y * gy + 0.5) / gy;
  return [x + (sx - x) * amount, y + (sy - y) * amount];
}
