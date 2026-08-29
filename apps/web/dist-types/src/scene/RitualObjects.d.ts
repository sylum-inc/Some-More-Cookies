/**
 * The objects the player handles: the marshmallow on its stick, the assembly
 * table, and the finished sandwich.
 *
 * The sandwich is the only object rendered at `hero` tier (ARCHITECTURE §4.2):
 * no jitter, no affine swim, larger textures, sheen and frost. The post-pass
 * dither and low-resolution target still apply, which is what keeps it part of
 * the world rather than pasted on top of it.
 */
import { type AssemblyState, type BiteState, type MarshmallowState, type SandwichRecord } from '@somemore/sim';
import { type RenderSettings } from '../render/ps1.js';
export interface RoastingStickProps {
    marshmallow: MarshmallowState;
    settings: RenderSettings;
    /** Direction the player is standing, radians around the fire. */
    bearing: number;
}
export declare function RoastingStick({ marshmallow, settings, bearing }: RoastingStickProps): React.ReactElement;
export interface AssemblyTableProps {
    assembly: AssemblyState;
    settings: RenderSettings;
    position?: [number, number, number];
}
export declare function AssemblyTable({ assembly, settings, position }: AssemblyTableProps): React.ReactElement;
export interface SandwichProps {
    sandwich: SandwichRecord;
    bite: BiteState | null;
    settings: RenderSettings;
    position?: [number, number, number];
    /** Slow rotation for the hero inspection view. */
    spin?: number;
    onBite?: (position: number) => void;
}
export declare function Sandwich({ sandwich, bite, settings, position, spin, onBite }: SandwichProps): React.ReactElement;
//# sourceMappingURL=RitualObjects.d.ts.map