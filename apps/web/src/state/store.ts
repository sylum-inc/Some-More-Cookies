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

/**
 * A saved photo.
 *
 * `dataUrl` is the local copy and the source of truth until an upload lands.
 * Once `remoteId` is set the bytes are safely in object storage, `url` points
 * at them, and the data URL is dropped — which is what lets the Passport keep
 * more photographs than `localStorage` could ever have held.
 */
export interface PassportPhoto {
  id: string;
  /** The local copy. Empty once the bytes live somewhere better. */
  dataUrl: string;
  caption: string;
  takenAt: number;
  environmentId: string;
  stage: RitualStage;
  /** Server-side photo id, once the upload succeeded. */
  remoteId?: string;
  /** Where to fetch it. Relative to the API today; a CDN origin later. */
  url?: string;
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
  /**
   * Codes redeemed off a wrapper or an event card (spec §14, ADR-0008).
   *
   * The grant itself is the service's — it was server-validated when it was
   * issued, which is what keeps a high-value reward from being something you
   * can guess. What is kept here is the *ticket stub*: what it was, when, and
   * which print run it came off, so the Passport can show it on a device that
   * is offline and so the memory survives a service it cannot reach. It is a
   * memento, never the entitlement.
   */
  redeemedCodes: RedeemedCodeStub[];
}

/** A ticket stub for something scanned. Never the reward itself. */
export interface RedeemedCodeStub {
  id: string;
  /** The service's own sentence: "free_kit added to your Passport." */
  awarded: string;
  batchId: string;
  redeemedAt: number;
}

/**
 * A live-ops event that is running tonight (spec §14, ADR-0007).
 *
 * Deliberately a *description*, not a mechanism: the mechanism already landed
 * on the environment manifest before the world was built. This is what the
 * arrival card and the Passport read so the player is told, in words, that the
 * sky is doing something unusual this weekend — because §12 says nothing may
 * be delivered through a single channel, and "there are more meteors than
 * usual" is otherwise a thing you have to notice.
 */
export interface ActiveContentEvent {
  slug: string;
  name: string;
  tagline: string;
  /** What it did to this campsite, in plain words. */
  effect: string;
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
  overlay: 'none' | 'passport' | 'settings' | 'photo' | 'hero' | 'terminal' | 'service' | 'radio' | 'scan' | 'campfire';
  /** Transient subtitle line. */
  subtitle: string | null;
  /** Whether audio has been unlocked by a user gesture. */
  audioReady: boolean;
  environmentId: string;
  campsiteSeed: string;
  /** Live-ops events in force tonight. Empty is the ordinary case. */
  liveEvents: ActiveContentEvent[];
  /**
   * Where the content overlay came from.
   *
   * `'none'` is not a failure and is never shown as one: it is what a first
   * launch, an offline device and a deployment with nothing published all look
   * like, and all three are complete campsites.
   */
  overlaySource: 'network' | 'cache' | 'none';
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
    redeemedCodes: [],
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

  /**
   * The shared fire, when a link brought this session to one.
   *
   * Deliberately not in `AppState`: it changes many times a second and nothing
   * in React should re-render for it. The scene reads it inside the frame loop
   * and the interface reads it through the campfire's own `onChange`.
   */
  campfire: import('../net/campfire.js').Campfire | null = null;

  constructor(options: {
    environmentId: string;
    campsiteSeed: string;
    weatherProfile?: WeatherProfile;
    /** The manifest slice the world systems read. */
    world?: RitualWorldContent;
    /** From the scene manifest, so the shore lands inside the campsite. */
    walkableRadiusM?: number;
    /** Live-ops events the overlay applied before the world was built. */
    liveEvents?: readonly ActiveContentEvent[];
    overlaySource?: 'network' | 'cache' | 'none';
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
      liveEvents: options.liveEvents ? [...options.liveEvents] : [],
      overlaySource: options.overlaySource ?? 'none',
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

  /**
   * Take the shared world in place of the local one.
   *
   * Arriving at somebody else's fire means arriving at *their* campsite: their
   * seed, their environment, their SM-01 with its own serial. The shared world
   * is rebuilt from the snapshot (ADR-0006) and swapped in here, which is the
   * only moment in a session when the ritual object is replaced.
   *
   * The campsite seed becomes the numeric one the session was opened with,
   * stringified, so every client derives the same terrain, the same trees and
   * the same machine wear from it — a per-device seed here would put everybody
   * at a differently shaped campsite while agreeing perfectly about the fire.
   */
  adoptRitual(ritual: RitualState, seed: number, environmentId: string): void {
    this.set({
      ritual,
      stage: ritual.stage,
      environmentId,
      campsiteSeed: String(seed),
    });
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
   * A content overlay that landed *after* the world was built.
   *
   * Only the weather profile is applied to a session already in progress, and
   * only because it is a plain data field the model rolls against: swapping it
   * changes what might happen next and disturbs nothing that already happened.
   * A meteor shower that turns on while you are sitting there is the best
   * version of this feature.
   *
   * The dial and the environment itself are deliberately *not* applied live —
   * rebuilding the radio would yank the tuning away from somebody listening to
   * a station, and swapping the environment would change the ground under
   * somebody standing on it. Those wait for the next arrival, which is at most
   * one night away. See `net/overlay.ts` (`liveApplicable`).
   */
  applyLiveContent(options: {
    events: readonly ActiveContentEvent[];
    source: AppState['overlaySource'];
    weather?: WeatherProfile;
  }): void {
    if (options.weather) this.state.ritual.weather.profile = options.weather;
    this.set({ liveEvents: [...options.events], overlaySource: options.source });
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

  /**
   * Files a redeemed code in the Passport.
   *
   * Called after the service has already said yes: the reward lives in the
   * account, and this is the stub that makes it visible at a campsite with no
   * signal. Idempotent by redemption id, because a retried tap must not put two
   * stubs on the page.
   */
  recordRedeemedCode(stub: RedeemedCodeStub): void {
    const existing = this.state.passport.redeemedCodes ?? [];
    if (existing.some((entry) => entry.id === stub.id)) return;
    const passport: PassportState = {
      ...this.state.passport,
      redeemedCodes: [stub, ...existing].slice(0, 60),
    };
    this.set({ passport });
    this.persistPassport();
  }

  /**
   * How many photographs may still be carrying their own bytes.
   *
   * Not a cap on the album. A data URL is a quarter of a megabyte of base64 in
   * a five-megabyte quota, so there is a hard limit on how many of *those* a
   * device can hold — but a photo whose bytes are in object storage costs a
   * URL, and there is no reason to throw one of those away.
   */
  private static readonly LOCAL_PHOTO_BYTES_CAP = 24;

  addPhoto(photo: PassportPhoto): void {
    /*
     * The cap applies to un-uploaded photos only.
     *
     * It used to apply to the album, with a comment saying "until object
     * storage exists" — so a twenty-fifth photograph deleted the first, and a
     * player who took a lot of pictures lost last week to make room for
     * tonight. Now the oldest photo whose bytes have safely landed simply
     * stops carrying them, and the entry stays.
     */
    const photos = [photo, ...this.state.passport.photos];
    let carrying = 0;
    const trimmed = photos.map((entry) => {
      if (!entry.dataUrl) return entry;
      carrying += 1;
      if (carrying <= Store.LOCAL_PHOTO_BYTES_CAP) return entry;
      // Past the cap and still un-uploaded: this one has to go, bytes and all.
      return entry.remoteId ? { ...entry, dataUrl: '' } : null;
    });

    const passport = {
      ...this.state.passport,
      photos: trimmed.filter((entry): entry is PassportPhoto => entry !== null).slice(0, 400),
    };
    this.set({ passport });
    this.persistPassport();
  }

  /**
   * The bytes reached object storage, so the device does not have to hold them.
   *
   * Called by the sync queue, never by the ritual. Dropping the data URL is the
   * whole player-visible payoff of the upload path: the Passport stops being an
   * album that forgets.
   */
  markPhotoUploaded(localPhotoId: string, remoteId: string, url: string): void {
    const photos = this.state.passport.photos.map((entry) =>
      entry.id === localPhotoId ? { ...entry, remoteId, url, dataUrl: '' } : entry,
    );
    if (photos.every((entry, index) => entry === this.state.passport.photos[index])) return;
    this.set({ passport: { ...this.state.passport, photos } });
    this.persistPassport();
  }

  /**
   * Replace this campsite's memory with the one the service merged.
   *
   * Local-first: only ever called with the *result* of a successful sync, so a
   * service that cannot be reached leaves everything here untouched and the
   * player never notices. The merge itself happened server-side — a second one
   * here, with its own rules, is how two devices come to disagree about a place
   * they both went to.
   */
  applyCampsiteMemory(memory: CampsiteMemory): void {
    if (memory.campsiteSeed !== this.state.campsiteSeed) return;
    const passport: PassportState = {
      ...this.state.passport,
      campsites: { ...this.state.passport.campsites, [memory.campsiteSeed]: memory },
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
      // silently. Losing a photo must never interrupt the ritual. Uploaded
      // photos survive this — they cost a URL, and it is the data URLs that
      // filled the quota in the first place.
      try {
        let kept = 0;
        const trimmed = {
          ...this.state.passport,
          photos: this.state.passport.photos
            .map((entry) => {
              if (!entry.dataUrl) return entry;
              kept += 1;
              return kept <= 4 ? entry : entry.remoteId ? { ...entry, dataUrl: '' } : null;
            })
            .filter((entry): entry is PassportPhoto => entry !== null),
        };
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
