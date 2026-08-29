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
  activeTraces,
  createRitual,
  nightEpoch,
  describeSighting,
  discoveredSecrets,
  residents,
  type DiscoveryRecord,
  type RitualStage,
  type RitualState,
  type RitualWorldContent,
  type SandwichRecord,
  type Trace,
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
  /**
   * Use a virtual joystick instead of tap-to-move.
   * An alternate control scheme (spec §12), not a preference for its own sake:
   * tap-to-move needs an accurate tap, which a joystick does not.
   */
  virtualJoystick: boolean;
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
  virtualJoystick: false,
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

/**
 * What a campsite remembers about a player, and a player about a campsite.
 *
 * This is the local half of the significance model (spec §6): the world does
 * not reset between visits, so the fourth time you come back to Pine Hollow
 * the fox that has seen you three times before behaves like it has. Nothing
 * here is a score or a completion state — `visits` is an ordinal, `secrets`
 * is what you happened to notice, and `traces` carry only the disposition the
 * significance model chose, never the value behind it (§6.4).
 */
export interface CampsiteMemory {
  campsiteSeed: string;
  environmentId: string;
  /** How many times this player has arrived here. 1 on the first night. */
  visits: number;
  lastVisitAt: number;
  /** Secrets noticed here, this visit and every earlier one. */
  secrets: DiscoveryRecord[];
  /** Visits each recognisable resident has been seen on, by individual id. */
  residents: Record<string, number>;
  /** Traces the significance model kept. Faded ones are dropped on load. */
  traces: Trace[];
  /** Lines worth reading back, newest first. Never a count, never a total. */
  sightings: string[];
  /**
   * Constellations this player has picked out from here.
   *
   * Not a set to complete: there is no total anywhere, and a player who never
   * looks up loses nothing. It is remembered for the same reason a resident
   * fox's visits are — so the world behaves as though it has met you.
   */
  constellations: string[];
}

function createCampsiteMemory(campsiteSeed: string, environmentId: string): CampsiteMemory {
  return {
    campsiteSeed,
    environmentId,
    visits: 0,
    lastVisitAt: 0,
    secrets: [],
    residents: {},
    traces: [],
    sightings: [],
    constellations: [],
  };
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
  /** Per-campsite memory, keyed by campsite seed. */
  campsites: Record<string, CampsiteMemory>;
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
  overlay: 'none' | 'passport' | 'settings' | 'photo' | 'hero' | 'terminal' | 'service' | 'radio';
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
    campsites: {},
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

  constructor(options: {
    environmentId: string;
    campsiteSeed: string;
    weatherProfile?: WeatherProfile;
    /** The manifest slice the world systems read. */
    world?: RitualWorldContent;
    /** From the scene manifest, so the shore lands inside the campsite. */
    walkableRadiusM?: number;
  }) {
    const settings = loadSettings();
    if (prefersReducedMotion()) {
      settings.render.reducedMotion = true;
      settings.render.jitter = Math.min(settings.render.jitter, 0.35);
    }
    const passport = loadPassport();
    const now = Date.now();

    // The campsite remembers. A returning player arrives at a place that has
    // already met them, which is the whole of the significance model's
    // outward behaviour (spec §6.2).
    const remembered =
      passport.campsites[options.campsiteSeed] ??
      createCampsiteMemory(options.campsiteSeed, options.environmentId);
    const memory: CampsiteMemory = {
      ...createCampsiteMemory(options.campsiteSeed, options.environmentId),
      ...remembered,
      environmentId: options.environmentId,
      visits: remembered.visits + 1,
      lastVisitAt: now,
      // Traces that have fully faded are gone; the world does not hoard.
      traces: activeTraces(remembered.traces, now, 96),
    };
    passport.campsites = { ...passport.campsites, [options.campsiteSeed]: memory };

    this.state = {
      ritual: createRitual({
        campsiteSeed: options.campsiteSeed,
        environmentId: options.environmentId,
        weatherProfile: options.weatherProfile,
        assemblyAssist: settings.accessibility.assemblyAssist,
        autoRotate: settings.accessibility.autoRotate,
        now,
        ...(options.world ? { world: options.world } : {}),
        visitIndex: memory.visits,
        priorVisits: memory.residents,
        knownSecrets: memory.secrets,
        knownConstellations: memory.constellations,
        // Tonight's real date at the campsite's own small hours. The date is
        // real — the moon phase and any shower on are genuinely tonight's —
        // and the hour is two in the morning, because that is when the world
        // is (spec §5.5, and `nightEpoch`).
        skyEpochMs: nightEpoch(new Date(now), -73),
        ...(options.walkableRadiusM ? { walkableRadiusM: options.walkableRadiusM } : {}),
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

    // Written immediately, not at the end of the session: the visit happened
    // the moment somebody walked in, and a tab that closes on the trail must
    // still count as having been here.
    this.persistPassport();
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

  /**
   * Folds what happened tonight back into this campsite's memory.
   *
   * Safe to call as often as you like: everything it merges is idempotent, so
   * the render loop can call it on a slow cadence and the unload handler can
   * call it once more without producing duplicates.
   */
  rememberCampsite(): CampsiteMemory {
    const ritual = this.state.ritual;
    const seed = this.state.campsiteSeed;
    const previous =
      this.state.passport.campsites[seed] ?? createCampsiteMemory(seed, this.state.environmentId);

    const residentVisits: Record<string, number> = { ...previous.residents };
    for (const individual of residents(ritual.wildlife)) {
      const seen = individual.visits;
      if (seen > (residentVisits[individual.id] ?? 0)) residentVisits[individual.id] = seen;
    }

    const secrets = [...previous.secrets];
    const knownSecretIds = new Set(secrets.map((record) => record.secretId));
    for (const record of discoveredSecrets(ritual.discovery)) {
      if (knownSecretIds.has(record.secretId)) continue;
      knownSecretIds.add(record.secretId);
      secrets.push(record);
    }

    const traces = [...previous.traces];
    const knownTraceIds = new Set(traces.map((trace) => trace.id));
    for (const trace of ritual.traces) {
      // A trace the model decided should fade is real in the world tonight,
      // but it is not something the Passport carries forward.
      if (trace.disposition === 'fade') continue;
      if (knownTraceIds.has(trace.id)) continue;
      knownTraceIds.add(trace.id);
      traces.push(trace);
    }

    const sightings = [...previous.sightings];
    for (const event of ritual.wildlifeEvents) {
      if (event.kind !== 'appeared') continue;
      const line = describeSighting(event);
      if (sightings[0] === line) continue;
      sightings.unshift(line);
    }

    // Anything picked out of the sky tonight, folded in without duplicates.
    const constellations = [...(previous.constellations ?? [])];
    for (const id of ritual.stargazing.recognised) {
      if (!constellations.includes(id)) constellations.push(id);
    }

    const memory: CampsiteMemory = {
      campsiteSeed: seed,
      environmentId: this.state.environmentId,
      visits: Math.max(previous.visits, ritual.options.visitIndex),
      lastVisitAt: Date.now(),
      secrets,
      residents: residentVisits,
      traces: activeTraces(traces, Date.now(), 96),
      sightings: sightings.slice(0, 40),
      constellations,
    };

    const passport: PassportState = {
      ...this.state.passport,
      campsites: { ...this.state.passport.campsites, [seed]: memory },
    };
    this.set({ passport });
    this.persistPassport();
    return memory;
  }

  /** This campsite's memory, for the Passport's campsite page. */
  campsiteMemory(): CampsiteMemory {
    return (
      this.state.passport.campsites[this.state.campsiteSeed] ??
      createCampsiteMemory(this.state.campsiteSeed, this.state.environmentId)
    );
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
