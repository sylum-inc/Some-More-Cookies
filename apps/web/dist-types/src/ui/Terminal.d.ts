/**
 * The Some More terminal (spec §11).
 *
 * Commerce is subordinate to the experience. No purchase surface exists
 * before the product reveal, and the fiction is maintained through this
 * terminal until conventional checkout UI is genuinely required.
 *
 * Launch catalogue: the flagship roasted-marshmallow sandwich only.
 */
import { type SandwichRecord } from '@somemore/sim';
export interface TerminalProps {
    sandwich: SandwichRecord;
    onClose: () => void;
    textScale: number;
}
export declare function Terminal({ sandwich, onClose, textScale }: TerminalProps): React.ReactElement;
/** The colour token re-export keeps the terminal palette discoverable. */
export declare const TERMINAL_ACCENT: "#8fd4ff";
//# sourceMappingURL=Terminal.d.ts.map