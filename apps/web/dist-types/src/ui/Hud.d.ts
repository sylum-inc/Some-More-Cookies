/**
 * The heads-up layer.
 *
 * Deliberately sparse. There are no quest markers, no XP, no objectives list
 * (spec §5.3). What is here: a quiet line of guidance when a player would
 * otherwise be stuck, a non-numeric heat reading during roasting, subtitles,
 * and the two corner affordances (Passport, settings).
 */
import type { RitualStage, RitualState } from '@somemore/sim';
export interface HudProps {
    ritual: RitualState;
    stage: RitualStage;
    subtitle: string | null;
    textScale: number;
    highContrast: boolean;
    subtitlesEnabled: boolean;
    onOpenPassport: () => void;
    onOpenSettings: () => void;
    onFinishRoasting: () => void;
    onTakeSandwich: () => void;
    onPhoto: () => void;
    onOpenTerminal: () => void;
}
export declare function Hud(props: HudProps): React.ReactElement;
//# sourceMappingURL=Hud.d.ts.map