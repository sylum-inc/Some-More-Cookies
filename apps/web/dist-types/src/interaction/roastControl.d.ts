/**
 * Roasting input mapping (spec §4.2).
 *
 * "The player moves the marshmallow closer/farther from the fire and rotates
 * it manually." On touch this must be *one continuous drag* controlling both
 * axes, because asking a thumb to operate two separate controls over a fire is
 * exactly the fiddliness the spec warns about (risk R7).
 *
 * Mapping: vertical drag = distance from the heat, horizontal drag = rotation
 * about the stick. Both are relative to where the drag started, so the
 * marshmallow never jumps when a finger lands.
 *
 * Pure and DOM-free so it can be unit tested headlessly.
 */
import { type Vec3 } from '@somemore/sim';
export interface RoastControlConfig {
    /** Closest the marshmallow can get to the fire centre, metres. */
    minRadius: number;
    /** Furthest, metres. */
    maxRadius: number;
    /** Height above the ground at the closest radius. */
    minHeight: number;
    /** Height at the furthest radius. */
    maxHeight: number;
    /** Metres of radius change per pixel of vertical drag. */
    radiusPerPixel: number;
    /** Radians of rotation per pixel of horizontal drag. */
    rotationPerPixel: number;
    /** Where the marshmallow starts, as a 0..1 position along the radius band. */
    startPosition: number;
}
export declare const DEFAULT_ROAST_CONTROL: RoastControlConfig;
export interface RoastPose {
    position: Vec3;
    rotation: number;
    /** 0..1 along the radius band — used for the non-numeric heat indicator. */
    proximity: number;
}
export declare class RoastController {
    private readonly config;
    /** 0..1 along the band; 0 = closest to the fire. */
    private position;
    private rotation;
    private dragging;
    private startX;
    private startY;
    private startPositionAtDrag;
    private startRotationAtDrag;
    /** Angle around the fire the player stands at. */
    private bearing;
    constructor(config?: Partial<RoastControlConfig>, bearing?: number);
    begin(x: number, y: number): void;
    move(x: number, y: number): void;
    end(): void;
    get isDragging(): boolean;
    /** Rotates without moving — used by the automatic-rotation assist. */
    addRotation(delta: number): void;
    /** Moves along the band directly — used by keyboard and gamepad input. */
    nudge(positionDelta: number, rotationDelta: number): void;
    setBearing(bearing: number): void;
    /** Current world pose of the marshmallow, with the fire pit at the origin. */
    pose(out?: RoastPose): RoastPose;
    /** Total rotation applied so far, radians. */
    get totalRotation(): number;
    /** How far along the band, 0 = in the coals, 1 = well back. */
    get bandPosition(): number;
}
/**
 * Maps a pointer position on screen to an assembly offset on the table plane.
 *
 * Kept separate from the 3D raycast so the mapping itself is testable and so
 * a keyboard or gamepad can drive the same path.
 */
export declare function screenToTableOffset(pointerX: number, pointerY: number, anchorX: number, anchorY: number, metresPerPixel?: number): Vec3;
/**
 * Detects a blow-out gesture: a fast shake or a quick upward flick.
 *
 * Real blowing needs microphone permission, which must never be required
 * (spec §5.5 on permissions), so the gesture is the primary path and the mic
 * an optional enhancement.
 */
export declare class BlowGestureDetector {
    private samples;
    private lastTriggered;
    /** Feeds a pointer sample. Returns true when a blow-out is recognised. */
    sample(x: number, timeMs: number): boolean;
    reset(): void;
}
//# sourceMappingURL=roastControl.d.ts.map