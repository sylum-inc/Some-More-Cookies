/**
 * Client store.
 *
 * Deliberately tiny and dependency-free. The simulation owns gameplay state
 * and is advanced in the render loop; React only needs to know when
 * *presentation-relevant* things change (stage, settings, Passport), so a
 * full reactive binding over 32 marshmallow patches at 60 Hz would be pure
 * waste. Scene components read simulation state directly each frame.
 */

import {
  createRitual,
  type RitualStage,
  type RitualState,
  type SandwichRecord,
  type WeatherProfile,
} from '@somemore/sim';
import { DEFAULT_RENDER_SETTINGS, type QualityTier, type RenderSettings } from '../render/ps1.js';

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

export const DEFAULT_ACCESSIBILITY: AccessibilitySettings = {
  autoRotate: 0,
  assemblyAssist: 0.5,
  subtitles: true,
  textScale: 1,
  haptics: true,
  simplifiedGestures: false,
  highContrast: false,
};

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

export const DEFAULT_AUDIO: AudioSettings = {
  master: 0.8,
  ambience: 0.7,
  fire: 0.8,
  machine: 0.9,
  foley: 0.8,
  ui: 0.6,
  voice: 1,
  muted: false,
  reducedIntensity: false,
};

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

const STORAGE_KEY = 'some-more/passport/v1';
const SETTINGS_KEY = 'some-more/settings/v1';

function createPassport(): PassportState {
  return {
    playerId: `anon-${Math.random().toString(36).slice(2, 10)}`,
    createdAt: Date.now(),
    displayName: 'Camper',
    entries: [],
    photos: [],
    stamps: [],
    visitedEnvironments: [],
    sandwichCount: 0,
    linkedProvider: 'none',
  };
}

function loadPassport(): PassportState {
  if (typeof localStorage === 'undefined') return createPassport();
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return createPassport();
    const parsed = JSON.parse(raw) as Partial<PassportState>;
    return { ...createPassport(), ...parsed };
  } catch {
    // A corrupt Passport must never block the world (ARCHITECTURE §1.5).
    return createPassport();
  }
}

function loadSettings(): {
  render: RenderSettings;
  accessibility: AccessibilitySettings;
  audio: AudioSettings;
} {
  const fallback = {
    render: { ...DEFAULT_RENDER_SETTINGS },
    accessibility: { ...DEFAULT_ACCESSIBILITY },
    audio: { ...DEFAULT_AUDIO },
  };
  if (typeof localStorage === 'undefined') return fallback;
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw) as Partial<typeof fallback>;
    return {
      render: { ...fallback.render, ...parsed.render },
      accessibility: { ...fallback.accessibility, ...parsed.accessibility },
      audio: { ...fallback.audio, ...parsed.audio },
    };
  } catch {
    return fallback;
  }
}

/** Honours the OS reduced-motion preference on first run. */
function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export class Store {
  private listeners = new Set<Listener>();
  state: AppState;

  constructor(options: { environmentId: string; campsiteSeed: string; weatherProfile?: WeatherProfile }) {
    const settings = loadSettings();
    if (prefersReducedMotion()) {
      settings.render.reducedMotion = true;
      settings.render.jitter = Math.min(settings.render.jitter, 0.35);
    }
    const passport = loadPassport();

    this.state = {
      ritual: createRitual({
        campsiteSeed: options.campsiteSeed,
        environmentId: options.environmentId,
        weatherProfile: options.weatherProfile,
        assemblyAssist: settings.accessibility.assemblyAssist,
        autoRotate: settings.accessibility.autoRotate,
        now: Date.now(),
      }),
      stage: 'arriving',
      render: settings.render,
      accessibility: settings.accessibility,
      audio: settings.audio,
      quality: 'mid',
      passport,
      overlay: 'none',
      subtitle: null,
      audioReady: false,
      environmentId: options.environmentId,
      campsiteSeed: options.campsiteSeed,
    };
  }

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): AppState => this.state;

  /** Replaces state and notifies. Only for presentation-relevant changes. */
  set(partial: Partial<AppState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener();
  }

  /** Notifies without changing the object — used after in-place sim mutation. */
  touch(): void {
    this.state = { ...this.state };
    for (const listener of this.listeners) listener();
  }

  setStageFromRitual(): void {
    if (this.state.ritual.stage !== this.state.stage) {
      this.set({ stage: this.state.ritual.stage });
    }
  }

  updateRender(partial: Partial<RenderSettings>): void {
    const render = { ...this.state.render, ...partial };
    this.set({ render });
    this.persistSettings();
  }

  updateAccessibility(partial: Partial<AccessibilitySettings>): void {
    const accessibility = { ...this.state.accessibility, ...partial };
    // Assists are applied to the live simulation immediately.
    this.state.ritual.options.assemblyAssist = accessibility.assemblyAssist;
    this.state.ritual.options.autoRotate = accessibility.autoRotate;
    this.state.ritual.assembly.assist = accessibility.assemblyAssist;
    this.set({ accessibility });
    this.persistSettings();
  }

  updateAudio(partial: Partial<AudioSettings>): void {
    this.set({ audio: { ...this.state.audio, ...partial } });
    this.persistSettings();
  }

  setSubtitle(line: string | null): void {
    if (this.state.subtitle === line) return;
    this.set({ subtitle: line });
  }

  setOverlay(overlay: AppState['overlay']): void {
    this.set({ overlay });
  }

  /** Saves a sandwich to the Passport, with its stamp. */
  saveSandwich(sandwich: SandwichRecord, note?: string, photoId?: string): PassportEntry {
    const entry: PassportEntry = {
      id: sandwich.id,
      sandwich,
      savedAt: Date.now(),
      ...(note ? { note } : {}),
      ...(photoId ? { photoId } : {}),
    };
    const stamp = `stamp-${sandwich.class.toLowerCase()}`;
    const passport: PassportState = {
      ...this.state.passport,
      entries: [entry, ...this.state.passport.entries].slice(0, 200),
      stamps: this.state.passport.stamps.includes(stamp)
        ? this.state.passport.stamps
        : [...this.state.passport.stamps, stamp],
      visitedEnvironments: this.state.passport.visitedEnvironments.includes(sandwich.environmentId)
        ? this.state.passport.visitedEnvironments
        : [...this.state.passport.visitedEnvironments, sandwich.environmentId],
      sandwichCount: this.state.passport.sandwichCount + 1,
    };
    this.set({ passport });
    this.persistPassport();
    return entry;
  }

  addPhoto(photo: PassportPhoto): void {
    const passport = {
      ...this.state.passport,
      // Photos are data URLs until object storage exists, so the local cap is
      // low on purpose — a runaway Passport would break localStorage.
      photos: [photo, ...this.state.passport.photos].slice(0, 24),
    };
    this.set({ passport });
    this.persistPassport();
  }

  private persistPassport(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.state.passport));
    } catch {
      // Quota exceeded: drop the oldest photos and try once more, then give up
      // silently. Losing a photo must never interrupt the ritual.
      try {
        const trimmed = { ...this.state.passport, photos: this.state.passport.photos.slice(0, 4) };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(trimmed));
        this.state.passport = trimmed;
      } catch {
        /* ignore */
      }
    }
  }

  private persistSettings(): void {
    if (typeof localStorage === 'undefined') return;
    try {
      localStorage.setItem(
        SETTINGS_KEY,
        JSON.stringify({
          render: this.state.render,
          accessibility: this.state.accessibility,
          audio: this.state.audio,
        }),
      );
    } catch {
      /* ignore */
    }
  }
}
