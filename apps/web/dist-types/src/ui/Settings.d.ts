/**
 * Settings.
 *
 * Accessibility is part of the architecture, not a bolted-on screen
 * (spec §12). The same knobs serve art direction and access: "reduce
 * dithering" is both.
 */
import type { AccessibilitySettings, AudioSettings } from '../state/store.js';
import type { RenderSettings } from '../render/ps1.js';
export interface SettingsProps {
    render: RenderSettings;
    accessibility: AccessibilitySettings;
    audio: AudioSettings;
    onRender: (partial: Partial<RenderSettings>) => void;
    onAccessibility: (partial: Partial<AccessibilitySettings>) => void;
    onAudio: (partial: Partial<AudioSettings>) => void;
    onClose: () => void;
}
export declare function Settings({ render, accessibility, audio, onRender, onAccessibility, onAudio, onClose, }: SettingsProps): React.ReactElement;
//# sourceMappingURL=Settings.d.ts.map