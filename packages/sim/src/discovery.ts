/**
 * Secrets and environmental storytelling (spec §8).
 *
 * Mystery here is told by the world, never by a quest: a secret surfaces
 * because a player happened to be in a place, or was quiet long enough, or had
 * the radio on the right frequency when the fog came down. This module tracks
 * those conditions and decides when a secret has been *noticed*.
 *
 * Three spec rules are structural rather than aspirational:
 *
 * 1. **All mystery is optional.** `SecretDefinition.optional` and
 *    `gatesNothing` are literal `true`, exactly as in the content schema, so a
 *    gating secret cannot be constructed. {@link assertNoGating} enforces the
 *    same thing at runtime for data arriving from untyped sources, and
 *    {@link DiscoveryOutcome} has no field for a reward, an unlock, a key or a
 *    flag — there is nowhere to put one.
 * 2. **Some events happen once and leave evidence.** A `oneTime` secret fires
 *    at most once per campsite per player and then contributes a permanent
 *    evidence mark, so a player who was elsewhere still finds the story.
 * 3. **Nothing is a checklist.** The readouts here exist to feed the
 *    significance model and the audio engine. There is no completion
 *    percentage, and `discoverySignals` deliberately reports no total.
 *
 * `SecretDefinition` is structurally identical to `SecretEntry` in
 * `@somemore/content`'s schema, so `EnvironmentManifest.secrets` can be passed
 * straight to {@link createDiscovery}. This package does not import content:
 * content depends on `sim`, and that dependency must not invert.
 *
 * This module decides and emits. It never persists: evidence for the
 * significance model comes out through {@link discoveryEvidence}.
 */

import { clamp01, lerp } from './math.js';
import { Rng, hashString, mixSeeds } from './rng.js';
import { createEvidence, type SignificanceEvidence } from './significance.js';
import type { SkyEvent, WeatherKind } from './weather.js';
import type { RadioBand } from './radio.js';
import type { ActivityWindow } from './wildlife.js';

/* -------------------------------------------------------------------------- */
/* Content-shaped input                                                       */
/* -------------------------------------------------------------------------- */

/** How a secret reaches the player. Mirrors the content schema exactly. */
export type MysteryChannel =
  | 'radio'
  | 'notes'
  | 'serial-numbers'
  | 'diagnostics'
  | 'strange-objects'
  | 'distant-sounds'
  | 'wildlife-behaviour'
  | 'recurring-figures'
  | 'campsite-changes';

/**
 * An optional discovery.
 *
 * `optional` and `gatesNothing` are literal `true`: a secret that blocks
 * essential functionality or a major reward is not expressible in this type,
 * which is the runtime half of the guarantee the content schema makes.
 */
export interface SecretDefinition {
  readonly id: string;
  readonly title: string;
  /** How a player stumbles into it. */
  readonly discovery: string;
  /** What it says, without saying it. */
  readonly telling: string;
  readonly channels: readonly MysteryChannel[];
  /** Fires at most once per campsite per player. */
  readonly oneTime: boolean;
  /** Required when `oneTime`: what remains afterward for everyone else. */
  readonly leavesEvidence: string | null;
  /** 0..1 how often it surfaces at all. Higher surfaces more readily. */
  readonly rarity: number;
  readonly optional: true;
  readonly gatesNothing: true;
}

/**
 * Everything a discovery can produce.
 *
 * There is no `unlocks`, no `reward`, no `grants` and no `flag`. Adding one
 * would be adding a gate, and the spec forbids it, so the shape simply has
 * nowhere to put it.
 */
export interface DiscoveryOutcome {
  readonly telling: string;
  readonly evidence: string | null;
}

/**
 * Throws if data arriving from an untyped source (JSON, a network payload, a
 * cast) claims to gate something. The type system covers TypeScript callers;
 * this covers everyone else.
 */
export function assertNoGating(secrets: readonly SecretDefinition[]): void {
  for (const secret of secrets) {
    if (secret.optional !== true || secret.gatesNothing !== true) {
      throw new Error(
        `Secret "${secret.id}" is not optional or claims to gate something. ` +
          'Essential functionality and major rewards must remain reachable by other paths (spec §8).',
      );
    }
    if (secret.oneTime && !secret.leavesEvidence) {
      throw new Error(
        `One-time secret "${secret.id}" leaves no evidence. A missed one-time event must never strand anyone (spec §8).`,
      );
    }
  }
}

/* -------------------------------------------------------------------------- */
/* Conditions                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What has to be true for a secret to be noticeable.
 *
 * All the conditions attached to a secret must hold together, and hold for a
 * while, before it can surface. None of them is ever *told* to the player.
 */
export type DiscoveryCondition =
  /** Standing somewhere in particular. */
  | { readonly kind: 'at-place'; readonly placeId: string }
  /** Genuinely still and quiet for this long, in seconds. */
  | { readonly kind: 'quiet'; readonly seconds: number }
  /** The weather is doing one of these. */
  | { readonly kind: 'weather'; readonly kinds: readonly WeatherKind[] }
  /** A rare sky event is happening. Gifts, not gates — see below. */
  | { readonly kind: 'sky-event'; readonly event: SkyEvent }
  /** The radio is on a frequency, clearly enough to hear it. */
  | {
      readonly kind: 'tuned';
      readonly stationId?: string;
      readonly dial?: number;
      readonly band?: RadioBand;
      /** Dial units of tolerance around `dial`. */
      readonly tolerance?: number;
      readonly clarity?: number;
    }
  /** Something has been photographed at some point this session. */
  | { readonly kind: 'photographed'; readonly subjectId: string }
  /** Looking closely at a prop — crouched with a flashlight, binoculars up. */
  | { readonly kind: 'inspecting'; readonly targetId: string }
  /** An animal is present, optionally a particular one. */
  | { readonly kind: 'wildlife'; readonly speciesId?: string; readonly persistentOnly?: boolean }
  /** This is at least the nth visit to the campsite. */
  | { readonly kind: 'visits'; readonly count: number }
  /** The right part of the night. */
  | { readonly kind: 'time-of-night'; readonly window: ActivityWindow }
  /** The fire is at least this alive. */
  | { readonly kind: 'fire'; readonly minIntensity: number };

/** Extra or replacement conditions for a secret, supplied by the integrator. */
export interface SecretConditions {
  readonly secretId: string;
  readonly conditions: readonly DiscoveryCondition[];
}

/**
 * Default conditions inferred from a secret's channels.
 *
 * Content authors write prose, not predicates, so a secret with no explicit
 * conditions still behaves sensibly: a radio secret needs the radio on, a
 * distant-sounds secret needs quiet, a campsite-changes secret needs a return
 * visit. An integrator overrides any of it with {@link SecretConditions}.
 */
export function defaultConditions(secret: SecretDefinition): readonly DiscoveryCondition[] {
  const conditions: DiscoveryCondition[] = [];
  for (const channel of secret.channels) {
    switch (channel) {
      case 'radio':
        conditions.push({ kind: 'tuned', clarity: 0.4 });
        break;
      case 'notes':
      case 'strange-objects':
      case 'serial-numbers':
      case 'diagnostics':
        conditions.push({ kind: 'inspecting', targetId: secret.id });
        break;
      case 'distant-sounds':
        conditions.push({ kind: 'quiet', seconds: 40 });
        break;
      case 'recurring-figures':
        conditions.push({ kind: 'quiet', seconds: 25 });
        break;
      case 'wildlife-behaviour':
        conditions.push({ kind: 'wildlife' });
        break;
      case 'campsite-changes':
        conditions.push({ kind: 'visits', count: 2 });
        break;
      default:
        break;
    }
  }
  return conditions;
}

/* -------------------------------------------------------------------------- */
/* Observation                                                                */
/* -------------------------------------------------------------------------- */

/** What the world looks like this step, as far as noticing things goes. */
export interface DiscoveryObservation {
  /** Named places the player is currently inside. */
  places: readonly string[];
  /** Seconds of genuine stillness — `WildlifeState.stillnessSeconds` fits. */
  stillnessSeconds: number;
  weatherKind: WeatherKind;
  skyEvent: SkyEvent;
  /** What the radio is receiving, or null when it is off. */
  radio: { stationId: string | null; dial: number; band: RadioBand; clarity: number } | null;
  /** Subjects photographed during this step. */
  photographed: readonly string[];
  /** Animals present right now. */
  wildlife: readonly { speciesId: string; persistent: boolean }[];
  /** What the player is looking at closely, if anything. */
  inspecting: string | null;
  window: ActivityWindow;
  /** 0..1. */
  fireIntensity: number;
}

export function createObservation(overrides: Partial<DiscoveryObservation> = {}): DiscoveryObservation {
  return {
    places: [],
    stillnessSeconds: 0,
    weatherKind: 'clear',
    skyEvent: 'none',
    radio: null,
    photographed: [],
    wildlife: [],
    inspecting: null,
    window: 'early-night',
    fireIntensity: 0.5,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Records and events                                                         */
/* -------------------------------------------------------------------------- */

export interface DiscoveryRecord {
  readonly secretId: string;
  /** Seconds into the session it surfaced. */
  readonly at: number;
  /** Which visit to the campsite this was. */
  readonly visitIndex: number;
  readonly oneTime: boolean;
  /** What it left behind. Null for secrets that leave nothing. */
  readonly evidence: string | null;
}

/**
 * A permanent mark left by a one-time event.
 *
 * This is the mechanism behind "a missed one-time event never strands anyone":
 * the tin has been opened, so on every later visit it simply sits closed on
 * the table where anyone can see it.
 */
export interface EvidenceMark {
  readonly secretId: string;
  readonly title: string;
  readonly evidence: string;
  readonly visitIndex: number;
}

export type DiscoveryEventKind = 'discovered' | 'noticing';

export interface DiscoveryEvent {
  readonly kind: DiscoveryEventKind;
  readonly at: number;
  readonly secretId: string;
  readonly title: string;
  /** What it says, without saying it. */
  readonly telling: string;
  readonly channels: readonly MysteryChannel[];
  readonly oneTime: boolean;
  readonly evidence: string | null;
  /** 0..1 how unusual this is — the inverse of the content's surfacing rate. */
  readonly unusualness: number;
}

/* -------------------------------------------------------------------------- */
/* State                                                                      */
/* -------------------------------------------------------------------------- */

interface SecretRuntime {
  readonly secret: SecretDefinition;
  readonly conditions: readonly DiscoveryCondition[];
  /** Seconds the conditions have held continuously. */
  heldSeconds: number;
  /** Seconds they must hold before it can surface. */
  readonly requiredSeconds: number;
  /** True once the player is close enough that the world starts to hint. */
  noticing: boolean;
  discovered: boolean;
}

export interface DiscoveryConfig {
  readonly campsiteSeed: number | string;
  readonly secrets: readonly SecretDefinition[];
  /** Explicit conditions, replacing the channel-derived defaults. */
  readonly conditions?: readonly SecretConditions[];
  /** Which visit to this campsite this is. 1 is the first. */
  readonly visitIndex?: number;
  /** What this player already found here, on this or an earlier visit. */
  readonly known?: readonly DiscoveryRecord[];
  /** Subjects already photographed, if the caller is restoring a session. */
  readonly photographed?: readonly string[];
}

export interface DiscoveryState {
  readonly seed: number;
  readonly visitIndex: number;
  readonly secrets: readonly SecretRuntime[];
  /** Everything found, earliest first — this visit's finds appended. */
  readonly records: DiscoveryRecord[];
  /** Subjects photographed this session, latched. */
  readonly photographed: string[];
  elapsed: number;
  events: DiscoveryEvent[];
}

/** Base chance per second once the conditions have been held long enough. */
const SURFACE_RATE = 0.22;

export function createDiscovery(config: DiscoveryConfig): DiscoveryState {
  assertNoGating(config.secrets);
  const seed =
    typeof config.campsiteSeed === 'string' ? hashString(config.campsiteSeed) : config.campsiteSeed >>> 0;
  const known = config.known ?? [];
  const overrides = new Map<string, readonly DiscoveryCondition[]>();
  for (const entry of config.conditions ?? []) overrides.set(entry.secretId, entry.conditions);

  const secrets: SecretRuntime[] = config.secrets.map((secret) => {
    const alreadyFound = known.some((record) => record.secretId === secret.id);
    return {
      secret,
      conditions: overrides.get(secret.id) ?? defaultConditions(secret),
      heldSeconds: 0,
      // A common secret asks for a few seconds of the right conditions; a rare
      // one asks for a real stretch of them.
      requiredSeconds: lerp(26, 5, clamp01(secret.rarity)),
      noticing: false,
      // A one-time secret that has already happened never happens again.
      discovered: alreadyFound && secret.oneTime,
    };
  });

  return {
    seed,
    visitIndex: config.visitIndex ?? 1,
    secrets,
    records: [...known],
    photographed: [...(config.photographed ?? [])],
    elapsed: 0,
    events: [],
  };
}

/* -------------------------------------------------------------------------- */
/* Evaluation                                                                 */
/* -------------------------------------------------------------------------- */

function conditionMet(
  condition: DiscoveryCondition,
  observation: DiscoveryObservation,
  state: DiscoveryState,
): boolean {
  switch (condition.kind) {
    case 'at-place':
      return observation.places.includes(condition.placeId);
    case 'quiet':
      return observation.stillnessSeconds >= condition.seconds;
    case 'weather':
      return condition.kinds.includes(observation.weatherKind);
    case 'sky-event':
      return observation.skyEvent === condition.event;
    case 'tuned': {
      const radio = observation.radio;
      if (!radio) return false;
      if (radio.clarity < (condition.clarity ?? 0.4)) return false;
      if (condition.band !== undefined && radio.band !== condition.band) return false;
      if (condition.stationId !== undefined && radio.stationId !== condition.stationId) return false;
      if (condition.dial !== undefined) {
        const tolerance = condition.tolerance ?? 0.05;
        if (Math.abs(radio.dial - condition.dial) > tolerance) return false;
      }
      return true;
    }
    case 'photographed':
      return state.photographed.includes(condition.subjectId);
    case 'inspecting':
      return observation.inspecting === condition.targetId;
    case 'wildlife': {
      return observation.wildlife.some((animal) => {
        if (condition.speciesId !== undefined && animal.speciesId !== condition.speciesId) return false;
        if (condition.persistentOnly === true && !animal.persistent) return false;
        return true;
      });
    }
    case 'visits':
      return state.visitIndex >= condition.count;
    case 'time-of-night':
      return observation.window === condition.window;
    case 'fire':
      return observation.fireIntensity >= condition.minIntensity;
    default:
      return false;
  }
}

/** True when every condition on a secret currently holds. */
export function conditionsHold(
  state: DiscoveryState,
  secretId: string,
  observation: DiscoveryObservation,
): boolean {
  const runtime = state.secrets.find((candidate) => candidate.secret.id === secretId);
  if (!runtime) return false;
  return runtime.conditions.every((condition) => conditionMet(condition, observation, state));
}

/* -------------------------------------------------------------------------- */
/* Stepping                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Advances the discovery model by one fixed timestep.
 *
 * A secret surfaces when its conditions have held long enough and a seeded
 * roll against its surfacing rate comes up. Nothing is ever forced on the
 * player, and nothing is ever withheld from them either: a secret that never
 * surfaces costs a player nothing at all.
 */
export function stepDiscovery(
  state: DiscoveryState,
  observation: DiscoveryObservation,
  dt: number,
  rng: Rng,
): void {
  state.elapsed += dt;

  for (const subject of observation.photographed) {
    if (!state.photographed.includes(subject)) state.photographed.push(subject);
  }

  for (const runtime of state.secrets) {
    if (runtime.discovered) continue;
    // A secret with no conditions at all never surfaces: an environment that
    // forgot to say how something is found should stay quiet, not fire at
    // random. Every content channel maps to a default, so this is only ever
    // reached by a secret with no channels.
    const holds =
      runtime.conditions.length > 0 &&
      runtime.conditions.every((condition) => conditionMet(condition, observation, state));

    if (!holds) {
      // Attention lapses faster than it accumulates, but not instantly — a
      // moment's distraction does not cost the whole approach.
      runtime.heldSeconds = Math.max(0, runtime.heldSeconds - dt * 1.5);
      runtime.noticing = false;
      continue;
    }

    runtime.heldSeconds += dt;
    if (!runtime.noticing && runtime.heldSeconds >= runtime.requiredSeconds * 0.6) {
      runtime.noticing = true;
      // The world leans in slightly. Sound design, not a marker.
      state.events.push(buildEvent('noticing', runtime, state));
    }
    if (runtime.heldSeconds < runtime.requiredSeconds) continue;

    const chance = SURFACE_RATE * clamp01(runtime.secret.rarity) * dt;
    if (!rng.chance(chance)) continue;

    runtime.discovered = true;
    const evidence = runtime.secret.oneTime ? runtime.secret.leavesEvidence : null;
    state.records.push({
      secretId: runtime.secret.id,
      at: state.elapsed,
      visitIndex: state.visitIndex,
      oneTime: runtime.secret.oneTime,
      evidence,
    });
    state.events.push(buildEvent('discovered', runtime, state));
  }
}

function buildEvent(kind: DiscoveryEventKind, runtime: SecretRuntime, state: DiscoveryState): DiscoveryEvent {
  return {
    kind,
    at: state.elapsed,
    secretId: runtime.secret.id,
    title: runtime.secret.title,
    telling: runtime.secret.telling,
    channels: runtime.secret.channels,
    oneTime: runtime.secret.oneTime,
    evidence: runtime.secret.oneTime ? runtime.secret.leavesEvidence : null,
    unusualness: clamp01(1 - runtime.secret.rarity),
  };
}

/* -------------------------------------------------------------------------- */
/* Readouts                                                                   */
/* -------------------------------------------------------------------------- */

export function drainDiscoveryEvents(state: DiscoveryState): DiscoveryEvent[] {
  const events = state.events;
  state.events = [];
  return events;
}

/** Everything found here, this visit and before. */
export function discoveredSecrets(state: DiscoveryState): readonly DiscoveryRecord[] {
  return state.records;
}

export function hasDiscovered(state: DiscoveryState, secretId: string): boolean {
  return state.records.some((record) => record.secretId === secretId);
}

/**
 * The permanent marks left by one-time events.
 *
 * The renderer places these on every later visit. That is why nobody is ever
 * stranded by a missed event: the story is still standing in the world.
 */
export function permanentEvidence(state: DiscoveryState): readonly EvidenceMark[] {
  const marks: EvidenceMark[] = [];
  for (const record of state.records) {
    if (!record.oneTime || !record.evidence) continue;
    const runtime = state.secrets.find((candidate) => candidate.secret.id === record.secretId);
    marks.push({
      secretId: record.secretId,
      title: runtime ? runtime.secret.title : record.secretId,
      evidence: record.evidence,
      visitIndex: record.visitIndex,
    });
  }
  return marks;
}

/**
 * The outcome of a discovery: what it says and what it leaves.
 *
 * Note what is absent. There is no unlock, and there is no path from here to
 * one — which is the guarantee, expressed as a type (§8).
 */
export function outcomeOf(secret: SecretDefinition): DiscoveryOutcome {
  return { telling: secret.telling, evidence: secret.oneTime ? secret.leavesEvidence : null };
}

export interface DiscoverySignals {
  /** How many things this player has noticed here. Never shown as a total. */
  found: number;
  /** True while the world is leaning in toward something. */
  noticing: boolean;
  /** Permanent marks currently standing in the world. */
  evidenceMarks: number;
}

/**
 * Signals for audio and the significance model.
 *
 * Deliberately reports no denominator: there is no "3 of 7" anywhere in this
 * product, because that would turn a place into a checklist (§5.3).
 */
export function discoverySignals(state: DiscoveryState): DiscoverySignals {
  return {
    found: state.records.length,
    noticing: state.secrets.some((runtime) => runtime.noticing && !runtime.discovered),
    evidenceMarks: permanentEvidence(state).length,
  };
}

/**
 * Turns a discovery into evidence for the significance model.
 *
 * The rarity handed over is the *inverse* of the content's surfacing rate: a
 * secret that rarely surfaces is a rare thing to have seen. A one-time event
 * always counts as a first.
 */
export function discoveryEvidence(
  event: DiscoveryEvent,
  overrides: Partial<SignificanceEvidence> = {},
): SignificanceEvidence {
  return createEvidence('discovery', {
    rarity: event.unusualness,
    isFirst: true,
    interactionCount: 1,
    ...overrides,
  });
}

/**
 * A stable per-secret RNG stream.
 *
 * Handed out so a caller can vary the *presentation* of a discovery — which
 * of three ways the lantern crosses the road tonight — without disturbing the
 * discovery model's own sequence.
 */
export function secretStream(state: DiscoveryState, secretId: string): Rng {
  return new Rng(mixSeeds(state.seed, hashString(`secret:${secretId}`)));
}
