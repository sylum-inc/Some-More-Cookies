/**
 * Client store.
 *
 * Deliberately tiny and dependency-free. The simulation owns gameplay state
 * and is advanced in the render loop; React only needs to know when
 * *presentation-relevant* things change (stage, settings, Passport), so a
 * full reactive binding over 32 marshmallow patches at 60 Hz would be pure
 * waste. Scene components read simulation state directly each frame.
 */
import { type RitualStage, type RitualState, type SandwichRecord, type WeatherProfile } from '@somemore/sim';
import { type QualityTier, type RenderSettings } from '../render/ps1.js';
export interface AccessibilitySettings {
    /** Automatic marshmallow rotation, rad/s. 0 = manual. */
    autoRotate: number;
    /** Assembly magnetic assist, 0..1. */
    assemblyAssist: number;
    /** Subtitles for audio events. */
    subtitles: boolean;
    /** UI text scale multiplier. */
    textScale: number;
    /** Haptics on capable devices. */
    haptics: boolean;
    /** Simplified single-tap gestures. */
    simplifiedGestures: boolean;
    /** High-contrast UI. */
    highContrast: boolean;
}
export declare const DEFAULT_ACCESSIBILITY: AccessibilitySettings;
export interface AudioSettings {
    master: number;
    ambience: number;
    fire: number;
    machine: number;
    foley: number;
    ui: number;
    voice: number;
    muted: boolean;
    reducedIntensity: boolean;
}
export declare const DEFAULT_AUDIO: AudioSettings;
/** A saved photo. Stored as a data URL locally until object storage exists. */
export interface PassportPhoto {
    id: string;
    dataUrl: string;
    caption: string;
    takenAt: number;
    environmentId: string;
    stage: RitualStage;
}
export interface PassportEntry {
    id: string;
    sandwich: SandwichRecord;
    photoId?: string;
    note?: string;
    savedAt: number;
}
export interface PassportState {
    /** Anonymous device identity until an account is linked. */
    playerId: string;
    createdAt: number;
    displayName: string;
    entries: PassportEntry[];
    photos: PassportPhoto[];
    stamps: string[];
    visitedEnvironments: string[];
    /** Total sandwiches made, all time. */
    sandwichCount: number;
    linkedProvider: 'none' | 'apple' | 'google' | 'email';
}
export interface AppState {
    ritual: RitualState;
    stage: RitualStage;
    render: RenderSettings;
    accessibility: AccessibilitySettings;
    audio: AudioSettings;
    quality: QualityTier;
    passport: PassportState;
    /** Which overlay is open, if any. */
    overlay: 'none' | 'passport' | 'settings' | 'photo' | 'hero' | 'terminal' | 'service';
    /** Transient subtitle line. */
    subtitle: string | null;
    /** Whether audio has been unlocked by a user gesture. */
    audioReady: boolean;
    environmentId: string;
    campsiteSeed: string;
}
type Listener = () => void;
export declare class Store {
    private listeners;
    state: AppState;
    constructor(options: {
        environmentId: string;
        campsiteSeed: string;
        weatherProfile?: WeatherProfile;
    });
    subscribe: (listener: Listener) => (() => void);
    getSnapshot: () => AppState;
    /** Replaces state and notifies. Only for presentation-relevant changes. */
    set(partial: Partial<AppState>): void;
    /** Notifies without changing the object — used after in-place sim mutation. */
    touch(): void;
    setStageFromRitual(): void;
    updateRender(partial: Partial<RenderSettings>): void;
    updateAccessibility(partial: Partial<AccessibilitySettings>): void;
    updateAudio(partial: Partial<AudioSettings>): void;
    setSubtitle(line: string | null): void;
    setOverlay(overlay: AppState['overlay']): void;
    /** Saves a sandwich to the Passport, with its stamp. */
    saveSandwich(sandwich: SandwichRecord, note?: string, photoId?: string): PassportEntry;
    addPhoto(photo: PassportPhoto): void;
    private persistPassport;
    private persistSettings;
}
export {};
//# sourceMappingURL=store.d.ts.map