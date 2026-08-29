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
export declare const TIER_PARAMS: Record<MaterialTier, Ps1Params>;
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
export declare const QUALITY: Record<QualityTier, QualitySettings>;
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
export declare const DEFAULT_RENDER_SETTINGS: RenderSettings;
/**
 * Injected into the vertex stage. Snapping happens in clip space *before* the
 * perspective divide, which is where the original hardware lost precision.
 */
export declare const PS1_VERTEX_CHUNK = "\nuniform float uJitterResolution;\nuniform float uJitterAmount;\nuniform float uAffineness;\nvarying vec2 vAffineUv;\nvarying float vAffineW;\nvarying float vViewDepth;\n\nvec4 ps1Snap(vec4 clipPosition) {\n  if (uJitterAmount <= 0.0 || clipPosition.w <= 0.0) return clipPosition;\n  // Convert to NDC, snap to a virtual raster, convert back.\n  vec2 ndc = clipPosition.xy / clipPosition.w;\n  vec2 grid = vec2(uJitterResolution, uJitterResolution * 0.75);\n  vec2 snapped = floor(ndc * grid + 0.5) / grid;\n  vec2 result = mix(ndc, snapped, uJitterAmount);\n  return vec4(result * clipPosition.w, clipPosition.z, clipPosition.w);\n}\n";
/**
 * Injected into the fragment stage. Recovers the affine UV by dividing the
 * interpolated UV*w by the interpolated w — the classic swim.
 */
export declare const PS1_FRAGMENT_CHUNK = "\nuniform float uAffineness;\nuniform float uDither;\nuniform float uColorDepth;\nvarying vec2 vAffineUv;\nvarying float vAffineW;\nvarying float vViewDepth;\n\nconst mat4 BAYER4 = mat4(\n   0.0,  8.0,  2.0, 10.0,\n  12.0,  4.0, 14.0,  6.0,\n   3.0, 11.0,  1.0,  9.0,\n  15.0,  7.0, 13.0,  5.0\n);\n\nfloat bayer4(vec2 pixel) {\n  int x = int(mod(pixel.x, 4.0));\n  int y = int(mod(pixel.y, 4.0));\n  vec4 row = (y == 0) ? BAYER4[0] : (y == 1) ? BAYER4[1] : (y == 2) ? BAYER4[2] : BAYER4[3];\n  float v = (x == 0) ? row.x : (x == 1) ? row.y : (x == 2) ? row.z : row.w;\n  return v / 16.0;\n}\n\nvec2 ps1Uv(vec2 perspectiveUv) {\n  if (uAffineness <= 0.0) return perspectiveUv;\n  vec2 affine = vAffineUv / max(vAffineW, 0.0001);\n  return mix(perspectiveUv, affine, uAffineness);\n}\n\nvec3 ps1Quantise(vec3 color, vec2 fragCoord) {\n  if (uColorDepth >= 8.0) return color;\n  float levels = pow(2.0, uColorDepth) - 1.0;\n  float threshold = (bayer4(fragCoord) - 0.5) * uDither / levels;\n  return floor(clamp(color + threshold, 0.0, 1.0) * levels + 0.5) / levels;\n}\n";
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
/**
 * Builds a standard Three.js material patched with the PS1 stages.
 *
 * Patching `MeshStandardMaterial` via `onBeforeCompile` rather than writing a
 * bespoke `ShaderMaterial` keeps Three's lighting, shadows and fog working —
 * the selective modern rendering the spec asks for sits *inside* the PS1
 * pipeline rather than beside it.
 */
export declare function createPs1Material(options?: Ps1MaterialOptions): THREE.MeshStandardMaterial;
/** Applies updated settings to every material built by `createPs1Material`. */
export declare function applyRenderSettings(settings: RenderSettings): void;
/** Releases a material from the registry (call alongside `dispose`). */
export declare function releasePs1Material(material: THREE.Material): void;
export declare function registeredMaterialCount(): number;
/**
 * Internal render size for a viewport. Kept pure so the resolution ladder can
 * be tested without a GPU.
 */
export declare function internalRenderSize(viewportWidth: number, viewportHeight: number, quality: QualitySettings, settings?: RenderSettings): {
    width: number;
    height: number;
};
/**
 * Picks a starting quality tier from a cheap capability probe.
 *
 * Deliberately not device-string sniffing (ARCHITECTURE §10) — this is a
 * starting guess that the frame-time monitor then corrects.
 */
export declare function probeQualityTier(input: {
    deviceMemoryGb?: number;
    hardwareConcurrency?: number;
    devicePixelRatio?: number;
    maxTextureSize?: number;
}): QualityTier;
/**
 * Rolling frame-time monitor that adjusts the tier.
 *
 * Hysteresis matters: a tier that oscillates is worse than a tier that is
 * slightly wrong, because every change causes a visible resolution pop.
 */
export declare class AdaptiveQuality {
    tier: QualityTier;
    private readonly targetMs;
    private readonly windowSize;
    private samples;
    private cooldown;
    constructor(tier: QualityTier, targetMs?: number, windowSize?: number);
    /** Feeds a frame time in milliseconds. Returns the tier to use. */
    sample(frameMs: number): QualityTier;
    private reset;
    get sampleCount(): number;
}
/** Ordered-dither threshold for a pixel — mirrors the shader, for tests. */
export declare function bayer4x4(x: number, y: number): number;
/** Quantises a channel with ordered dithering — mirrors the shader, for tests. */
export declare function quantiseChannel(value: number, depth: number, ditherThreshold: number, ditherAmount?: number): number;
/** Snaps an NDC position to the virtual raster — mirrors the shader, for tests. */
export declare function snapNdc(x: number, y: number, resolution: number, amount: number): [number, number];
//# sourceMappingURL=ps1.d.ts.map