/**
 * The world: scene composition, camera direction, and the simulation loop.
 *
 * The simulation is advanced here on a fixed timestep and read directly by
 * scene components each frame. React is not in the hot path — re-rendering a
 * component tree at 60 Hz to move a marshmallow would blow the entire frame
 * budget on reconciliation.
 */
import { type RitualState } from '@somemore/sim';
import { type QualityTier } from '../render/ps1.js';
import type { Store } from '../state/store.js';
import type { RoastController } from '../interaction/roastControl.js';
/** Where everything stands. The fire pit is the origin of the world. */
export declare const LAYOUT: {
    /** The player's bearing around the fire, radians. */
    playerBearing: number;
    /** How far the player stands from the fire while roasting. */
    playerDistance: number;
    assemblyTable: [number, number, number];
    machine: [number, number, number];
    /** Yaw so the machine's face (+Z in its local frame) looks into the clearing. */
    machineRotation: number;
    trailStart: [number, number, number];
};
/** Transforms a point in the machine's local frame into world space. */
export declare function machineToWorld(local: [number, number, number]): [number, number, number];
/**
 * How far the player turns away from the fire to look at the sandwich.
 * Composing it against the flames washed the object out and read as
 * levitation.
 */
export declare const HOLD_TURN = 1.15;
/** Where the sandwich is held while being inspected and eaten. */
export declare function holdPoint(): [number, number, number];
export interface WorldProps {
    store: Store;
    roastControl: RoastController;
    quality: QualityTier;
    onFrame?: (frameMs: number) => void;
    /** Set while the arrival walk is playing. */
    arrivalRef: React.MutableRefObject<number>;
    onSimStep?: (ritual: RitualState) => void;
}
export declare function World({ store, roastControl, quality, onFrame, arrivalRef, onSimStep }: WorldProps): React.ReactElement;
//# sourceMappingURL=World.d.ts.map