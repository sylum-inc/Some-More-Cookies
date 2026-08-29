/**
 * Code-authored low-poly geometry (ADR-0002).
 *
 * PS1 geometry is simple enough that generating it in code is practical, and
 * doing so lets the marshmallow's patch grid and the sandwich's bite state map
 * directly onto vertices — the simulation drives the mesh rather than
 * selecting between canned meshes.
 */
import * as THREE from 'three';
import { type BiteState, type MarshmallowState, type SandwichRecord } from '@somemore/sim';
export interface MarshmallowMesh {
    geometry: THREE.BufferGeometry;
    /** Updates vertex colours and sag from simulation state. */
    update(marshmallow: MarshmallowState): void;
    dispose(): void;
}
/**
 * Builds a marshmallow whose vertices correspond 1:1 with simulation patches,
 * so browning, charring and flame appear exactly where the model put them.
 *
 * Non-indexed with flat shading: faceted is correct for the art direction and
 * lets each quad take its own patch colour without bleeding into neighbours.
 */
export declare function createMarshmallowMesh(marshmallow: MarshmallowState): MarshmallowMesh;
/** Perimeter segments used to build each layer. Multiple of BITE_POSITIONS. */
export declare const SANDWICH_SEGMENTS: number;
/**
 * Rounded-square perimeter radius at an angle — graham crackers are square,
 * so a plain cylinder would read as a cake rather than a sandwich.
 */
export declare function squareRadius(angle: number, half: number, cornerRadius?: number): number;
/**
 * Bite depth at an arbitrary angle, interpolated between the eight recorded
 * bite positions so the removed geometry has smooth edges.
 */
export declare function biteDepthAtAngle(bite: BiteState | null, angle: number): number;
export interface SandwichLayerMesh {
    geometry: THREE.BufferGeometry;
    kind: 'graham' | 'chocolate' | 'cream';
    offsetX: number;
    offsetZ: number;
    y: number;
    thickness: number;
}
/**
 * Builds the five layers of a sandwich, with bites actually removed from the
 * geometry (spec deviation D3) rather than swapped between bite-state meshes.
 */
export declare function buildSandwichGeometry(sandwich: SandwichRecord, bite: BiteState | null, halfWidth?: number): SandwichLayerMesh[];
/** A low-poly conifer: two or three stacked cones plus a trunk. */
export declare function createTreeGeometry(seed: number, height?: number): THREE.BufferGeometry;
/** An irregular low-poly rock. */
export declare function createRockGeometry(seed: number, size?: number): THREE.BufferGeometry;
/** A split log for the fire and the woodpile. */
export declare function createLogGeometry(length?: number, radius?: number): THREE.BufferGeometry;
/** Merges geometries without pulling in an addon. */
export declare function mergeGeometries(geometries: readonly THREE.BufferGeometry[]): THREE.BufferGeometry;
/**
 * Terrain grid with seeded undulation. Deliberately low-resolution: PS1
 * ground was coarse, and a coarse grid is also what makes vertex jitter read
 * as authentic rather than as noise.
 */
export declare function createTerrainGeometry(size?: number, segments?: number, seed?: number, amplitude?: number): THREE.BufferGeometry;
//# sourceMappingURL=geometry.d.ts.map