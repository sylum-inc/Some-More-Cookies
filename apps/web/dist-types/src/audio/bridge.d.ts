/**
 * Bridges the simulation to the audio engine.
 *
 * The simulation knows nothing about audio (ADR-0001), and the audio engine
 * knows nothing about the ritual. This is the single place the two meet, so
 * the mapping from world state to sound is inspectable in one file.
 */
import { type RitualState } from '@somemore/sim';
import type { AudioSettings } from '../state/store.js';
export type FoleySound = 'blow-out' | 'graham-snap' | 'chocolate-fracture' | 'squish' | 'bite' | 'stick';
export declare class AudioBridge {
    private engine;
    private started;
    private pendingSettings;
    private lastCompressor;
    private lastFan;
    private crtOn;
    /** Called from a user gesture — browsers require one before audio starts. */
    unlock(): Promise<boolean>;
    applySettings(settings: AudioSettings): void;
    /** Called once per simulation step. */
    update(ritual: RitualState): void;
    private playMachineEvent;
    playFoley(sound: FoleySound): void;
    dispose(): void;
}
//# sourceMappingURL=bridge.d.ts.map