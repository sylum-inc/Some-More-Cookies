/**
 * The Some More SM-01 transformation freezer (spec §3).
 *
 * Late-1990s industrial refrigeration, early-Y2K technology, restrained
 * functional minimalism. Silver aluminium, industrial white enamel, smoked
 * translucent plastic, dark rubber. Colour is functional only: amber while
 * hot and processing, icy blue while freezing and transforming.
 *
 * Every control is a real object the player operates. There is no "run" button
 * anywhere in this file.
 */
import { type MachineAction, type MachineState } from '@somemore/sim';
import { type RenderSettings } from '../render/ps1.js';
export interface MachineProps {
    machine: MachineState;
    settings: RenderSettings;
    onAction: (action: MachineAction) => void;
    /** Highlights whichever control the player should operate next. */
    hintEnabled?: boolean;
}
export declare function Machine({ machine, settings, onAction, hintEnabled }: MachineProps): React.ReactElement;
//# sourceMappingURL=Machine.d.ts.map