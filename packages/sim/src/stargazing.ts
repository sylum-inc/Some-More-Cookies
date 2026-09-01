/**
 * Lying back and looking up (spec §5.2, §5.5).
 *
 * `astronomy.ts` already computes the real sun and moon, the real moon phase,
 * the real meteor showers and a constellation list. Until this module existed
 * none of that reached the player: the renderer scattered the constellations
 * decoratively around the dome and nobody could look at any of it.
 *
 * What this adds is the *looking*:
 *
 * - **Posture.** Standing, you can crane at the sky and your view wanders.
 *   Lying back on the log, your head is supported, the field is steady and the
 *   whole dome is above you. It is the difference between glancing up and
 *   stargazing, and it is the same idea as sitting: the reward for stopping.
 * - **Binoculars.** A narrow field, more reach into faint stars, and — because
 *   they are hand-held — much less steady unless you are lying back or braced.
 * - **Cloud.** Occlusion comes from the weather model's own `cloudCover`, so
 *   the sky and the weather can never disagree, and from the environment's
 *   `skyOpenness`, so a canyon site genuinely sees less sky than a salt flat.
 * - **Constellations are findable, not labelled.** Nothing is named until a
 *   player has actually held it in view. Even then the name is a note in the
 *   Passport, never a marker on the sky (§5.3).
 *
 * Meteor showers are gifts, not gates (§5.5): a shower makes the sky busier
 * and nothing anywhere in the product requires having seen one.
 */

import { clamp, clamp01, lerp, smoothstep, TAU, wrapAngle } from './math.js';
import { CONSTELLATIONS, horizonPositionOf, skyState, type Constellation, type SkyState } from './astronomy.js';
import { Rng } from './rng.js';
import { createEvidence, type SignificanceEvidence } from './significance.js';

/* -------------------------------------------------------------------------- */
/* Where you are and how you are lying                                        */
/* -------------------------------------------------------------------------- */

export type SkyPosture = 'standing' | 'reclined';

/** Field half-angle of the naked eye's attentive centre, radians (~14°). */
const NAKED_FIELD = 0.25;
/** Field half-angle through binoculars, radians (~3.5°). */
const GLASS_FIELD = 0.062;

/** How faint a star has to be before binoculars are the only way to it. */
const GLASS_REACH = 1.55;

/** Seconds a constellation must be held before it resolves into itself. */
const RECOGNISE_SECONDS = 4.5;

/** How often the sky is recomputed, in simulated seconds. */
const SKY_REFRESH_SECONDS = 20;

/** Meteors kept alive at once. A shower is busy, not infinite. */
const MAX_METEORS = 8;

export interface Meteor {
  /** Where it starts, radians. */
  azimuth: number;
  altitude: number;
  /** Direction it travels across the sky, radians. */
  heading: number;
  /** Radians of sky it crosses per second. */
  speed: number;
  /** Seconds since it lit. */
  age: number;
  /** Seconds it lasts. Most are under half a second. */
  lifeSeconds: number;
  /** 0..1 how bright. A shower's brightest are the ones people remember. */
  brightness: number;
  /** True once the player was looking near enough to have actually seen it. */
  seen: boolean;
}

/** One constellation, placed on tonight's sky. */
export interface SkyTarget {
  readonly id: string;
  readonly label: string;
  /** Radians. Azimuth from north, altitude above the horizon. */
  readonly azimuth: number;
  readonly altitude: number;
  /** 0..1 how well it is showing through cloud and canopy. */
  readonly clarity: number;
  /** Whether it is above the horizon at all. */
  readonly up: boolean;
  /** True once this player has held it in view and it resolved. */
  readonly known: boolean;
  readonly stars: readonly (readonly [number, number, number])[];
}

export type StargazingEventKind = 'looked-up' | 'recognised' | 'meteor' | 'meteor-seen';

export interface StargazingEvent {
  readonly kind: StargazingEventKind;
  readonly at: number;
  /** Constellation id, or the shower id for a meteor. Null for `looked-up`. */
  readonly subjectId: string | null;
  readonly label: string;
  /** 0..1 how unusual this is. */
  readonly rarity: number;
}

export interface StargazingConfig {
  /** Epoch milliseconds the session's sky is computed for. Injected, never read. */
  readonly epochMs: number;
  /**
   * How much faster the sky runs than the clock. 1 is real time.
   *
   * A night is nine or ten hours and a session is an hour or two, so at real
   * time the moon shifts about fifteen degrees and nothing else in the sky
   * appears to happen at all. The ritual sets this so that a session carries
   * the sky from late evening to first light — the moon genuinely crosses and
   * goes down, and the constellations that were rising when you arrived are
   * overhead by the time you are eating.
   */
  readonly timeScale?: number;
  readonly latitudeDeg?: number;
  readonly longitudeDeg?: number;
  /** 0..1 fraction of sky visible from the fire, from the scene manifest. */
  readonly skyOpenness?: number;
  /** Constellations this player has already picked out here. */
  readonly known?: readonly string[];
}

export interface StargazingState {
  posture: SkyPosture;
  binoculars: boolean;
  /** Where the player is looking, radians. */
  azimuth: number;
  altitude: number;
  /** 0..1 how steady the view is. Reclining helps; binoculars hurt. */
  steadiness: number;
  /** Field half-angle, radians. Narrower through the glasses. */
  fieldRadius: number;
  /** Constellations picked out. Never a total, never a set to complete. */
  readonly recognised: string[];
  /** What is currently being held in view, and for how long. */
  holdingId: string | null;
  holdSeconds: number;
  meteors: Meteor[];
  /**
   * Tonight's sky, refreshed on a slow cadence.
   *
   * Computed with **no cloud**, deliberately: this is the reference sky — sun,
   * moon and the wash they put over the stars — and the live `cloudCover` is
   * applied once, here, at the moment anything is read. Folding cloud into
   * both halves counted it twice, which made a merely hazy night unusable and
   * was measured at a campsite the model claimed was perfectly good for it.
   */
  sky: SkyState;
  /** 0..1 how much sky this campsite has. */
  readonly skyOpenness: number;
  readonly latitudeDeg: number;
  readonly longitudeDeg: number;
  readonly epochMs: number;
  /** How much faster the sky runs than the clock. */
  readonly timeScale: number;
  secondsUntilSkyRefresh: number;
  /** Seconds spent actually looking up. Feeds the significance model. */
  lookingSeconds: number;
  events: StargazingEvent[];
  elapsed: number;
}

/**
 * The date the sky is computed for.
 *
 * `epochMs` is injected by the caller (the ritual passes `options.now`), never
 * read from a clock here — ADR-0001. A caller with nothing to give falls back
 * to the curated night, which §5.5 requires to be as good as the real thing:
 * mid-August, mid-Perseids, a modest moon.
 */
const CURATED_EPOCH = Date.UTC(2024, 7, 12, 3, 0, 0);

export function createStargazing(config: StargazingConfig): StargazingState {
  const epochMs = config.epochMs > 0 ? config.epochMs : CURATED_EPOCH;
  const latitudeDeg = config.latitudeDeg ?? 44;
  const longitudeDeg = config.longitudeDeg ?? -73;
  return {
    posture: 'standing',
    binoculars: false,
    azimuth: 0,
    altitude: 0.35,
    steadiness: 0.35,
    fieldRadius: NAKED_FIELD,
    recognised: [...(config.known ?? [])],
    holdingId: null,
    holdSeconds: 0,
    meteors: [],
    timeScale: config.timeScale ?? 1,
    sky: skyState(new Date(epochMs), latitudeDeg, longitudeDeg, 0),
    skyOpenness: clamp01(config.skyOpenness ?? 0.6),
    latitudeDeg,
    longitudeDeg,
    epochMs,
    secondsUntilSkyRefresh: 0,
    lookingSeconds: 0,
    events: [],
    elapsed: 0,
  };
}

/* -------------------------------------------------------------------------- */
/* Intents                                                                    */
/* -------------------------------------------------------------------------- */

/** Lies back, or gets up again. */
export function setPosture(state: StargazingState, posture: SkyPosture): void {
  if (state.posture === posture) return;
  state.posture = posture;
  if (posture === 'reclined') {
    state.events.push({
      kind: 'looked-up',
      at: state.elapsed,
      subjectId: null,
      label: 'the sky',
      rarity: 0,
    });
  }
}

/** Raises or lowers the binoculars. */
export function setBinoculars(state: StargazingState, up: boolean): void {
  state.binoculars = up;
  state.fieldRadius = up ? GLASS_FIELD : NAKED_FIELD;
  // Changing what you are looking through breaks whatever you were holding.
  state.holdingId = null;
  state.holdSeconds = 0;
}

/**
 * Aims at a patch of sky.
 *
 * Absolute az/alt, because the client already owns the camera. Altitude is
 * clamped at the horizon: there is nothing to look at below it, and standing
 * up cannot see behind your own head.
 */
export function aimSky(state: StargazingState, azimuth: number, altitude: number): void {
  state.azimuth = wrapAngle(azimuth);
  const ceiling = Math.PI / 2;
  const floor = state.posture === 'reclined' ? 0.12 : -0.05;
  state.altitude = clamp(altitude, floor, ceiling);
}

/* -------------------------------------------------------------------------- */
/* Tonight's sky                                                              */
/* -------------------------------------------------------------------------- */

/**
 * Where the constellations actually are, right now, for this date and place.
 *
 * `clarity` folds in the sky's own brightness (moonlight washes out faint
 * stars), the cloud the weather model is producing, and how much sky this
 * campsite has at all. A constellation low on the horizon at a canyon site is
 * genuinely hard to see, which is the point.
 */
export function skyTargets(
  state: StargazingState,
  cloudCover: number,
  constellations: readonly Constellation[] = CONSTELLATIONS,
): SkyTarget[] {
  const date = new Date(state.epochMs + state.elapsed * 1000 * state.timeScale);
  const cloud = clamp01(cloudCover);
  const targets: SkyTarget[] = [];
  for (const constellation of constellations) {
    const { altitude, azimuth } = horizonPositionOf(
      constellation.raHours,
      constellation.decDeg,
      date,
      state.latitudeDeg,
      state.longitudeDeg,
    );
    // Low things are seen through more air and more trees.
    const height = smoothstep(-0.02, 0.6, altitude);
    const clarity = clamp01(state.sky.starVisibility * (1 - cloud * 0.95) * state.skyOpenness * height);
    targets.push({
      id: constellation.id,
      label: constellation.label,
      azimuth,
      altitude,
      clarity,
      up: altitude > 0.02,
      known: state.recognised.includes(constellation.id),
      stars: constellation.stars,
    });
  }
  return targets;
}

/** Angular separation between the aim and a target, radians. */
export function separation(
  aimAz: number,
  aimAlt: number,
  targetAz: number,
  targetAlt: number,
): number {
  const sinProduct = Math.sin(aimAlt) * Math.sin(targetAlt);
  const cosProduct = Math.cos(aimAlt) * Math.cos(targetAlt) * Math.cos(aimAz - targetAz);
  return Math.acos(clamp(sinProduct + cosProduct, -1, 1));
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * How steadily the view is held, 0..1.
 *
 * Lying back is what makes stargazing work: your head is supported, and the
 * binoculars rest on your face rather than being held at arm's length. Craning
 * upward while standing with a pair of glasses is genuinely useless, and the
 * model says so.
 */
export function steadinessFor(posture: SkyPosture, binoculars: boolean, altitude: number): number {
  const base = posture === 'reclined' ? 0.92 : 0.5;
  // Standing, the higher you crane the worse it gets.
  const crane = posture === 'reclined' ? 0 : smoothstep(0.5, 1.4, altitude) * 0.34;
  const glass = binoculars ? (posture === 'reclined' ? 0.08 : 0.28) : 0;
  return clamp01(base - crane - glass);
}

/**
 * How much of the sky is reaching the eye at the aim point, 0..1.
 *
 * Binoculars gather more light, so faint things resolve that would not
 * otherwise — which is the whole reason to raise them.
 */
export function viewingQuality(state: StargazingState, target: SkyTarget): number {
  const gain = state.binoculars ? GLASS_REACH : 1;
  return clamp01(target.clarity * gain * lerp(0.55, 1, state.steadiness));
}

/**
 * Advances the sky one fixed timestep.
 *
 * `rng` supplies only *when* meteors happen, never whether anything is
 * recognised or how the sky is positioned — those are astronomy and aim.
 */
export function stepStargazing(
  state: StargazingState,
  dt: number,
  input: { cloudCover: number; meteorShowerBoost?: number },
  rng: Rng,
): void {
  state.elapsed += dt;
  state.steadiness = steadinessFor(state.posture, state.binoculars, state.altitude);
  state.fieldRadius = state.binoculars ? GLASS_FIELD : NAKED_FIELD;

  // --- The sky itself, on a slow cadence ---------------------------------
  state.secondsUntilSkyRefresh -= dt;
  if (state.secondsUntilSkyRefresh <= 0) {
    state.secondsUntilSkyRefresh = SKY_REFRESH_SECONDS;
    // No cloud: the reference sky. Cloud is applied where it is read.
    state.sky = skyState(
      new Date(state.epochMs + state.elapsed * 1000 * state.timeScale),
      state.latitudeDeg,
      state.longitudeDeg,
      0,
    );
  }

  const lookingUp = state.posture === 'reclined' || state.altitude > 0.42;
  if (lookingUp) state.lookingSeconds += dt;

  // --- Holding a constellation in view -----------------------------------
  const targets = skyTargets(state, input.cloudCover);
  let held: SkyTarget | null = null;
  let bestSeparation = Infinity;
  for (const target of targets) {
    if (!target.up) continue;
    const gap = separation(state.azimuth, state.altitude, target.azimuth, target.altitude);
    if (gap < state.fieldRadius && gap < bestSeparation) {
      held = target;
      bestSeparation = gap;
    }
  }

  if (held && held.id === state.holdingId) {
    state.holdSeconds += dt * lerp(0.5, 1.35, state.steadiness);
  } else {
    state.holdingId = held ? held.id : null;
    state.holdSeconds = 0;
  }

  if (held && state.holdSeconds >= RECOGNISE_SECONDS && !state.recognised.includes(held.id)) {
    // It only resolves if you can actually see it — a constellation held in
    // view through solid overcast stays a patch of grey.
    if (viewingQuality(state, held) > 0.16) {
      state.recognised.push(held.id);
      state.events.push({
        kind: 'recognised',
        at: state.elapsed,
        subjectId: held.id,
        label: held.label,
        rarity: clamp01(1 - held.clarity) * 0.6 + 0.2,
      });
    }
  }

  // --- Meteors ------------------------------------------------------------
  stepMeteors(state, dt, input, rng);
}

function stepMeteors(
  state: StargazingState,
  dt: number,
  input: { cloudCover: number; meteorShowerBoost?: number },
  rng: Rng,
): void {
  const clarity = clamp01(
    state.sky.starVisibility * (1 - clamp01(input.cloudCover) * 0.95) * state.skyOpenness,
  );
  const shower = state.sky.meteorShower;
  const boost = 1 + clamp01(input.meteorShowerBoost ?? 0);
  // `meteorRate` is per minute in the astronomy model.
  const perSecond = (state.sky.meteorRate / 60) * clarity * boost;

  if (state.meteors.length < MAX_METEORS && rng.chance(perSecond * dt)) {
    // During a shower they radiate from a point; otherwise they are sporadic.
    const radiantAz = shower ? ((shower.shower.peakDay * 0.37) % TAU) : rng.range(0, TAU);
    const azimuth = shower ? radiantAz + rng.range(-0.9, 0.9) : rng.range(0, TAU);
    const altitude = rng.range(0.12, 1.35);
    state.meteors.push({
      azimuth,
      altitude,
      heading: shower ? Math.atan2(altitude - 0.9, 0.4) + rng.range(-0.3, 0.3) : rng.range(0, TAU),
      speed: rng.range(1.4, 3.6),
      age: 0,
      lifeSeconds: rng.range(0.28, 0.85),
      brightness: clamp01(rng.range(0.35, 1) * (shower ? 0.7 + shower.strength * 0.5 : 0.7)),
      seen: false,
    });
    state.events.push({
      kind: 'meteor',
      at: state.elapsed,
      subjectId: shower ? shower.shower.id : null,
      label: shower ? shower.shower.label : 'a meteor',
      rarity: shower ? clamp01(0.35 + shower.strength * 0.3) : 0.55,
    });
  }

  for (let i = state.meteors.length - 1; i >= 0; i--) {
    const meteor = state.meteors[i] as Meteor;
    meteor.age += dt;
    meteor.azimuth = wrapAngle(meteor.azimuth + Math.cos(meteor.heading) * meteor.speed * dt);
    meteor.altitude = clamp(meteor.altitude + Math.sin(meteor.heading) * meteor.speed * dt, -0.2, 1.5);

    // Seeing one is a matter of having been looking. The field for *noticing*
    // a streak is much wider than the field for reading a constellation —
    // peripheral vision is how anyone ever sees a meteor.
    if (!meteor.seen) {
      const gap = separation(state.azimuth, state.altitude, meteor.azimuth, meteor.altitude);
      const noticeField = state.binoculars ? state.fieldRadius * 1.5 : 0.95;
      if (gap < noticeField && meteor.brightness > 0.25) {
        meteor.seen = true;
        state.events.push({
          kind: 'meteor-seen',
          at: state.elapsed,
          subjectId: state.sky.meteorShower ? state.sky.meteorShower.shower.id : null,
          label: state.sky.meteorShower ? state.sky.meteorShower.shower.label : 'a meteor',
          rarity: clamp01(0.4 + meteor.brightness * 0.4),
        });
      }
    }

    if (meteor.age > meteor.lifeSeconds) state.meteors.splice(i, 1);
  }
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

export function drainStargazingEvents(state: StargazingState): StargazingEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

export interface SkySignals {
  /** True while lying back. */
  reclined: boolean;
  binoculars: boolean;
  /** 0..1 how good the sky is tonight, all things considered. */
  quality: number;
  /** Moon phase name — the one label the sky is always allowed to carry. */
  moonLabel: string;
  /** Name of the shower on tonight, or null. Gifts, never gates. */
  showerLabel: string | null;
  /** Meteors currently streaking. */
  meteors: number;
  /** What is being held in view, if it has been recognised. Otherwise null. */
  holding: string | null;
}

/**
 * Signals for the interface.
 *
 * `holding` is null for a constellation the player has not picked out yet —
 * which is the whole of "findable, not labelled by default". No count, no
 * total, no "3 of 5": the recognised list has a length and this readout
 * deliberately does not report it.
 */
export function skySignals(state: StargazingState, cloudCover: number): SkySignals {
  const targets = skyTargets(state, cloudCover);
  const holding = state.holdingId
    ? (targets.find((target) => target.id === state.holdingId) ?? null)
    : null;
  return {
    reclined: state.posture === 'reclined',
    binoculars: state.binoculars,
    quality: clamp01(state.sky.starVisibility * (1 - clamp01(cloudCover) * 0.95) * state.skyOpenness),
    moonLabel: state.sky.moon.label,
    showerLabel: state.sky.meteorShower ? state.sky.meteorShower.shower.label : null,
    meteors: state.meteors.length,
    holding: holding && holding.known ? holding.label : null,
  };
}

/**
 * Turns a sky moment into evidence for the significance model.
 *
 * A meteor seen during a named shower, or a constellation picked out for the
 * first time, is exactly the kind of thing a campsite should remember. The
 * value behind the decision never leaves this call (§6.4).
 */
export function stargazingEvidence(
  event: StargazingEvent,
  overrides: Partial<SignificanceEvidence> = {},
): SignificanceEvidence {
  const worldEvent = event.kind === 'meteor-seen' && event.subjectId !== null;
  return createEvidence(event.kind === 'recognised' ? 'discovery' : 'world-event', {
    rarity: event.rarity,
    isFirst: event.kind === 'recognised',
    duringWorldEvent: worldEvent,
    ...overrides,
  });
}

/** A warm line for the Passport. Never a compendium entry. */
export function describeSkyMoment(event: StargazingEvent): string {
  switch (event.kind) {
    case 'recognised':
      return `${event.label}, picked out of the dark.`;
    case 'meteor-seen':
      return event.subjectId ? `A ${event.label} meteor, right overhead.` : 'A meteor, out of nowhere.';
    case 'looked-up':
      return 'Lay back and looked up.';
    default:
      return '';
  }
}
