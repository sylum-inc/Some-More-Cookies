/**
 * The Campfire Passport (spec §6.2).
 *
 * A field journal, a campground registration booklet, a disposable photo
 * album, a scrapbook, and a PS1 memory card — explicitly *not* a card grid or
 * a dashboard. It is opened, never landed on.
 */
import type { PassportState } from '../state/store.js';
export interface PassportProps {
    passport: PassportState;
    onClose: () => void;
    onLink: (provider: 'apple' | 'google' | 'email') => void;
    textScale: number;
}
export declare function Passport({ passport, onClose, onLink, textScale }: PassportProps): React.ReactElement;
//# sourceMappingURL=Passport.d.ts.map