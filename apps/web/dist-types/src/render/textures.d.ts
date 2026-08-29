/**
 * Procedural texture generation (ADR-0002).
 *
 * No binary assets exist, so every surface is drawn at runtime into a canvas.
 * This is not merely expedient: a PS1 look wants 64–128px textures with
 * nearest filtering, which is exactly the range procedural generation is good
 * at. Hand-painted 2048px art would have to be thrown away to get here.
 *
 * Every generator is seeded, so a campsite's machine wear, decals and serial
 * plate are reproducible from its serial number.
 */
import * as THREE from 'three';
export type TextureKey = 'graham' | 'chocolate' | 'marshmallow' | 'bark' | 'foliage' | 'dirt' | 'gravel' | 'grass' | 'water' | 'enamel' | 'aluminium' | 'smokedPlastic' | 'rubber' | 'frost' | 'ash' | 'ember' | 'stone' | 'canvas' | 'noise';
export interface TextureOptions {
    size?: number;
    seed?: number | string;
    /** Palette overrides, hex strings. */
    colors?: string[];
}
/**
 * Builds (or returns a cached) texture.
 *
 * Returns `null` when there is no DOM, so simulation-side tests can import
 * this module without a browser.
 */
export declare function getTexture(key: TextureKey, options?: TextureOptions): THREE.Texture | null;
/**
 * Draws the SM-01's front decal plate: brand, model, serial and warnings,
 * aged by the unit's wear.
 */
export declare function createMachineDecal(options: {
    serial: string;
    built: number;
    wear: number;
    decalFade: number;
    stickers: readonly string[];
    size?: number;
}): THREE.Texture | null;
/**
 * The finished sandwich's ice cream texture — hero tier, so it gets a larger
 * canvas, a real swirl, and toasted flecks derived from the roast.
 */
export declare function createIceCreamTexture(options: {
    creamColor: readonly [number, number, number];
    swirlColor: readonly [number, number, number];
    swirlStrength: number;
    fleckDensity: number;
    seed: number;
    size?: number;
}): THREE.Texture | null;
/** Number of textures currently cached — used by the performance HUD. */
export declare function textureCacheSize(): number;
export declare function clearTextureCache(): void;
/** Every generator key, for tests and the debug view. */
export declare const TEXTURE_KEYS: TextureKey[];
//# sourceMappingURL=textures.d.ts.map