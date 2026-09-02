/**
 * The content overlay, client side.
 *
 * The service has had a complete live-ops content system since ADR-0007 and
 * nothing has ever fetched it: `grep "v1/content" apps/web/src` returned
 * nothing, which meant a published meteor-shower weekend changed exactly
 * nobody's night. This is the half that reaches a player.
 *
 * One rule outranks every other thing in this file, and it is ARCHITECTURE
 * §1.5: **a client with no signal keeps working, identically, from its own
 * catalogue.** So:
 *
 *  - the campsite is built from `@somemore/content` and from the *cache*, both
 *    of which are synchronous. Nothing here is ever on the boot path;
 *  - the network fetch happens after the world is already running, behind an
 *    `If-None-Match`, and its only job is to leave a better cache behind for
 *    next time (plus the parts that are safe to apply live — see
 *    `liveApplicable` below);
 *  - every failure mode — offline, timeout, 500, a payload this build cannot
 *    parse, a document that does not validate — resolves to "the campsite you
 *    already had".
 *
 * ## Why rejection is structural rather than hoped-for
 *
 * A hostile or merely broken overlay document must not be able to break a
 * running world. Three layers, in order, and a document has to survive all
 * three before it touches anything:
 *
 *  1. **The envelope is parsed by the protocol's own zod schema.** A manifest
 *     that is not a `ContentManifest` is discarded whole. There is no partial
 *     read of a malformed envelope.
 *  2. **Every document body is re-validated by `@somemore/content`'s
 *     validator** — the same one the compiled catalogue passes and the same one
 *     the service publishes behind. The service is not trusted to have been
 *     running the version of the validator this build ships; a rule tightened
 *     after a publish is caught here.
 *  3. **The merged environment is validated again, as a whole.** A document can
 *     be individually valid and still produce an environment that is not, so
 *     the *result* is checked before it is handed to the simulation. If it
 *     fails, the base environment is returned untouched. That is the structural
 *     part: the only way an overlay reaches the world is by producing something
 *     that would have been legal to compile in.
 *
 * A document that fails any layer is dropped and named in `rejected`; the rest
 * of the overlay still applies. One bad seasonal event does not cost you the
 * radio programming.
 *
 * ## Why it is an overlay and not a replacement
 *
 * Base content stays authoritative for everything the overlay does not mention.
 * Seasonal events *add*: a sky event is added to the profile's repertoire and
 * raises its likelihood, a weather event leans the weights, stations are
 * appended to the dial. Nothing is removed, because a player mid-session in an
 * environment that lost its lake is not a state worth having — and the content
 * schema says the same thing in its own comment.
 */

import {
  ContentManifestSchema,
  type ContentManifest,
  type ManifestDocument,
} from '@somemore/protocol';
import {
  getEnvironment,
  validateEnvironment,
  validateSeasonalEvent,
  validateStationProgramming,
  type EnvironmentManifest,
  type RadioStation,
  type SeasonalEventManifest,
  type StationProgrammingManifest,
} from '@somemore/content';
import type { SkyEvent, WeatherKind, WeatherProfile } from '@somemore/sim';
import type { ApiFailure, ApiResult } from './client.js';

/** Bumped only when the cached shape changes; a stale key is simply ignored. */
const CACHE_KEY = 'some-more/content-overlay/v2';

/** What the device remembers between launches. */
export interface CachedOverlay {
  /** The last manifest the service served in full. */
  manifest: ContentManifest;
  /** Its strong validator, sent back as `If-None-Match`. */
  etag: string;
  /** Device clock, for diagnostics only — never for deciding what is active. */
  fetchedAt: number;
}

/** Where the overlay in force came from, so the UI can be honest about it. */
export type OverlaySource = 'network' | 'cache' | 'none';

/** One event the overlay turned on, in words a person would read. */
export interface AppliedEvent {
  slug: string;
  name: string;
  tagline: string;
  kind: SeasonalEventManifest['kind'];
  /** What it actually did to this campsite, for the arrival card and the log. */
  effect: string;
}

/** A document that did not survive validation, and why. */
export interface RejectedDocument {
  kind: ManifestDocument['kind'];
  slug: string;
  issues: string[];
}

export interface OverlayResult {
  /** The environment to build the world from. The base one, if nothing applied. */
  environment: EnvironmentManifest;
  /** Whether anything at all changed. `false` means "identical to compiled-in". */
  changed: boolean;
  events: AppliedEvent[];
  rejected: RejectedDocument[];
  source: OverlaySource;
  releaseVersion: number;
}

/* -------------------------------------------------------------------------- */
/* Cache                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The last overlay this device saw, or null.
 *
 * Synchronous and total: a corrupt entry, a quota-cleared store, a build whose
 * schema has moved on — all of them are "no overlay", never a throw. This is
 * called during boot, so it is not allowed to be interesting.
 */
export function readCachedOverlay(): CachedOverlay | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return null;
    const record = parsed as Record<string, unknown>;
    const manifest = ContentManifestSchema.safeParse(record['manifest']);
    if (!manifest.success) return null;
    const etag = typeof record['etag'] === 'string' ? record['etag'] : '';
    if (etag.length === 0) return null;
    return {
      manifest: manifest.data,
      etag,
      fetchedAt: typeof record['fetchedAt'] === 'number' ? record['fetchedAt'] : 0,
    };
  } catch {
    return null;
  }
}

/** Writes the cache, or does not. Failing to cache is not worth telling anyone. */
export function writeCachedOverlay(entry: CachedOverlay): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(entry));
  } catch {
    /* Quota, private mode, a locked-down browser: the world does not care. */
  }
}

/** Used by tests and by "forget what you know about the season". */
export function clearCachedOverlay(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch {
    /* ignore */
  }
}

/* -------------------------------------------------------------------------- */
/* Fetching                                                                    */
/* -------------------------------------------------------------------------- */

/** What a conditional fetch can come back as. */
export type OverlayFetch =
  | { kind: 'fresh'; manifest: ContentManifest; etag: string }
  /** The service confirmed the cached copy is still current. No payload moved. */
  | { kind: 'unchanged' }
  | { kind: 'failed'; failure: ApiFailure };

/**
 * The manifest is public and unauthenticated, so this deliberately does not go
 * through `ApiClient` — it must work before anybody has an account, and before
 * `bootstrap` has finished, which is exactly when a returning player's phone
 * would otherwise be sitting on a stale season.
 *
 * The `If-None-Match` is the whole economy of the thing: a returning client
 * spends a few hundred bytes finding out nothing changed, and finds out about a
 * window opening on the same request, because the server's ETag covers
 * activation state as well as release version (ADR-0007).
 */
export async function fetchOverlay(options: {
  baseUrl?: string;
  etag?: string | null;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<OverlayFetch> {
  const base = (options.baseUrl ?? '').replace(/\/$/, '');
  const doFetch = options.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 6000);
  try {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (options.etag) headers['if-none-match'] = options.etag;
    const response = await doFetch(`${base}/v1/content/manifest`, {
      method: 'GET',
      headers,
      signal: controller.signal,
    });

    if (response.status === 304) return { kind: 'unchanged' };
    if (!response.ok) {
      return {
        kind: 'failed',
        failure: {
          kind: 'server',
          status: response.status,
          code: 'content_manifest_unavailable',
          message: response.statusText,
        },
      };
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      return { kind: 'failed', failure: { kind: 'malformed', message: 'The manifest was not JSON.' } };
    }
    const parsed = ContentManifestSchema.safeParse(payload);
    if (!parsed.success) {
      // Layer 1. A manifest this build cannot understand is not partially
      // applied; it is discarded, and the campsite carries on with what it had.
      return {
        kind: 'failed',
        failure: { kind: 'malformed', message: 'The manifest did not match the shared contract.' },
      };
    }
    // Prefer the server's header, fall back to the one inside the payload; they
    // are the same value, and a proxy is entitled to have weakened the header.
    const etag = response.headers.get('etag') ?? parsed.data.etag;
    return { kind: 'fresh', manifest: parsed.data, etag };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      return { kind: 'failed', failure: { kind: 'timeout' } };
    }
    return { kind: 'failed', failure: { kind: 'offline' } };
  } finally {
    clearTimeout(timer);
  }
}

/* -------------------------------------------------------------------------- */
/* Merging                                                                     */
/* -------------------------------------------------------------------------- */

function issuesToStrings(issues: readonly { path: string; message: string }[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}

/** Does this document's `environments` list cover the campsite we are in? */
function targets(list: readonly unknown[] | undefined, environmentId: string): boolean {
  if (!Array.isArray(list)) return false;
  return list.some((entry) => entry === '*' || entry === environmentId);
}

/** Stations are appended, never replaced, and never twice under one id. */
function mergeStations(
  existing: readonly RadioStation[],
  extra: readonly RadioStation[],
): readonly RadioStation[] {
  const seen = new Set(existing.map((station) => station.id));
  const added = extra.filter((station) => {
    if (seen.has(station.id)) return false;
    seen.add(station.id);
    return true;
  });
  return added.length === 0 ? existing : [...existing, ...added];
}

/**
 * A sky event, leaned into rather than forced.
 *
 * `intensity` is 0 for a rumour and 1 for unmistakable, so it moves the
 * campsite's own chance toward certainty rather than replacing it: a place that
 * rarely sees anything still sees this, and a place that often does sees it
 * more. The event is *added* to the repertoire — a meteor-shower weekend at a
 * campsite that also gets heat lightning gets both.
 *
 * It is emphatically not a gate. `skyEventChance` is a probability the world
 * rolls against, and spec §5.5 is explicit that a rare sky event is a gift; a
 * player who logs in on the wrong night has lost nothing they needed.
 */
function withSkyEvent(profile: WeatherProfile, event: SkyEvent, intensity: number): WeatherProfile {
  const events = profile.skyEvents.includes(event) ? profile.skyEvents : [...profile.skyEvents, event];
  return {
    ...profile,
    skyEvents: events,
    skyEventChance: Math.min(1, profile.skyEventChance + intensity * (1 - profile.skyEventChance)),
  };
}

/**
 * A weather event, as a thumb on the scale.
 *
 * The weights are relative, so "more likely" means "a larger share of the
 * total". At intensity 1 the named kind is about as likely as everything else
 * put together, which reads as *this weekend it snows* without ever removing
 * the chance of a clear night — the campsite keeps its personality.
 */
function withWeatherLean(profile: WeatherProfile, kind: WeatherKind, intensity: number): WeatherProfile {
  const total = Object.values(profile.weights).reduce<number>((sum, weight) => sum + (weight ?? 0), 0);
  const base = total > 0 ? total : 1;
  return {
    ...profile,
    weights: {
      ...profile.weights,
      [kind]: (profile.weights[kind] ?? 0) + intensity * base,
    },
  };
}

/** Applies one validated seasonal event. Returns the new environment and a line. */
function applySeasonalEvent(
  environment: EnvironmentManifest,
  event: SeasonalEventManifest,
): { environment: EnvironmentManifest; effect: string } {
  let next = environment;
  const effects: string[] = [];

  if (event.kind === 'sky-event' && event.skyEvent !== undefined && event.skyEvent !== 'none') {
    next = { ...next, weather: withSkyEvent(next.weather, event.skyEvent, event.intensity) };
    effects.push(`${event.skyEvent.replace(/-/g, ' ')} in the sky here`);
  }

  if (event.kind === 'weather' && event.weather !== undefined) {
    next = { ...next, weather: withWeatherLean(next.weather, event.weather, event.intensity) };
    effects.push(`${event.weather.replace(/-/g, ' ')} more likely`);
  }

  // Stations ride along with any kind, because the schema permits them on any
  // kind and a weekend with its own broadcast is the cheapest possible way to
  // make an event feel like it is happening to the place rather than to a
  // settings object.
  if (event.stations.length > 0) {
    const stations = mergeStations(next.radio.stations, event.stations);
    if (stations !== next.radio.stations) {
      next = { ...next, radio: { ...next.radio, stations } };
      effects.push(`${event.stations.length} extra station(s) on the dial`);
    }
  }

  // `campsite` and `flavour` events carry no world-shaped payload in the
  // content schema — they are announcements, and the honest thing is to say so
  // rather than invent a mechanical effect the author did not author.
  if (effects.length === 0) effects.push('announced, with nothing to change in the world');

  return { environment: next, effect: effects.join('; ') };
}

/**
 * Fold a manifest onto one compiled-in environment.
 *
 * Pure, synchronous, and total: it cannot throw, and the worst case it can
 * produce is the environment it was given. Everything expensive about live ops
 * — deciding *what is active* — already happened on the server against the
 * server's clock (ADR-0007), so this never looks at a clock at all. It reads
 * `document.active`, which is the server's answer, and does not second-guess
 * it; a device whose clock is wound forward learns nothing.
 */
export function applyOverlay(
  base: EnvironmentManifest,
  manifest: ContentManifest | null,
  source: OverlaySource,
): OverlayResult {
  const empty: OverlayResult = {
    environment: base,
    changed: false,
    events: [],
    rejected: [],
    source: manifest === null ? 'none' : source,
    releaseVersion: manifest?.releaseVersion ?? 0,
  };
  if (manifest === null) return empty;

  const rejected: RejectedDocument[] = [];
  const events: AppliedEvent[] = [];
  let environment = base;

  try {
    for (const document of manifest.documents) {
      // The server said this window is shut. It is the only clock that counts.
      if (!document.active) continue;

      const body = document.body as unknown;
      const record = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;

      if (document.kind === 'environment') {
        if (document.slug !== base.id) continue;
        // Layer 2. The whole replacement environment goes through the same
        // validator the twelve compiled ones pass.
        const issues = validateEnvironment(body, document.slug);
        if (issues.length > 0) {
          rejected.push({ kind: document.kind, slug: document.slug, issues: issuesToStrings(issues) });
          continue;
        }
        environment = body as EnvironmentManifest;
        continue;
      }

      if (document.kind === 'seasonal_event') {
        if (!targets(record['environments'] as readonly unknown[] | undefined, base.id)) continue;
        const issues = validateSeasonalEvent(body, document.slug);
        if (issues.length > 0) {
          rejected.push({ kind: document.kind, slug: document.slug, issues: issuesToStrings(issues) });
          continue;
        }
        const event = body as SeasonalEventManifest;
        const applied = applySeasonalEvent(environment, event);
        environment = applied.environment;
        events.push({
          slug: document.slug,
          name: event.name,
          tagline: event.tagline,
          kind: event.kind,
          effect: applied.effect,
        });
        continue;
      }

      if (document.kind === 'station_programming') {
        if (!targets(record['environments'] as readonly unknown[] | undefined, base.id)) continue;
        const issues = validateStationProgramming(body, document.slug);
        if (issues.length > 0) {
          rejected.push({ kind: document.kind, slug: document.slug, issues: issuesToStrings(issues) });
          continue;
        }
        const programming = body as StationProgrammingManifest;
        const stations = mergeStations(environment.radio.stations, programming.stations);
        if (stations !== environment.radio.stations) {
          environment = { ...environment, radio: { ...environment.radio, stations } };
        }
        continue;
      }

      // `reward_definition` is a wire contract, not world data. It reaches a
      // player through the rewards service when a code or a claim grants it,
      // not by being folded into a campsite.
    }

    if (environment === base) return { ...empty, rejected, source };

    // Layer 3. The *result* has to be something that would have been legal to
    // compile in. Two individually valid documents can still combine into an
    // environment that is not (two stations landing on the same dial position,
    // say), and the simulation is entitled to assume a valid manifest.
    const finalIssues = validateEnvironment(environment, environment.id);
    if (finalIssues.length > 0) {
      return {
        environment: base,
        changed: false,
        events: [],
        rejected: [
          ...rejected,
          { kind: 'environment', slug: base.id, issues: issuesToStrings(finalIssues) },
        ],
        source,
        releaseVersion: manifest.releaseVersion,
      };
    }

    return {
      environment,
      changed: true,
      events,
      rejected,
      source,
      releaseVersion: manifest.releaseVersion,
    };
  } catch {
    // Belt and braces. Nothing above should be able to throw — the validators
    // are total and every read is guarded — but this function runs on the boot
    // path of a product whose first requirement is that the world starts, and
    // "the overlay had a bug" must never be able to mean "there is no campsite".
    return { ...empty, rejected, source };
  }
}

/* -------------------------------------------------------------------------- */
/* The boot-path entry point                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The overlay to build tonight's world with, decided synchronously.
 *
 * Reads the cache — a `localStorage.getItem` and a zod parse, no network, no
 * promise — and folds it onto the compiled environment. A first-ever launch has
 * no cache and gets the compiled catalogue, which is exactly right: the world
 * is complete without us.
 */
export function overlayForBoot(environmentId: string): OverlayResult {
  const base = getEnvironment(environmentId);
  if (!base) {
    throw new Error(`Unknown environment "${environmentId}"`);
  }
  const cached = readCachedOverlay();
  return applyOverlay(base, cached?.manifest ?? null, cached === null ? 'none' : 'cache');
}

/**
 * Refresh the cache in the background, and report what a refreshed overlay
 * would do to this campsite.
 *
 * Called *after* the world is running. What it returns is deliberately advisory
 * — the caller decides how much of it is safe to apply to a session already in
 * progress. See `liveApplicable` for where that line is and why.
 */
export async function refreshOverlay(options: {
  environmentId: string;
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}): Promise<{ result: OverlayResult; fetch: OverlayFetch }> {
  const cached = readCachedOverlay();
  const outcome = await fetchOverlay({
    ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    etag: cached?.etag ?? null,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });

  const base = getEnvironment(options.environmentId);
  if (!base) {
    // Cannot happen from `main.tsx`, which resolved the environment already.
    return { result: applyOverlay({} as EnvironmentManifest, null, 'none'), fetch: outcome };
  }

  if (outcome.kind === 'fresh') {
    writeCachedOverlay({ manifest: outcome.manifest, etag: outcome.etag, fetchedAt: Date.now() });
    return { result: applyOverlay(base, outcome.manifest, 'network'), fetch: outcome };
  }

  // `unchanged` and `failed` are the same thing to a campsite: whatever the
  // cache already said, which is what the world was already built from.
  return {
    result: applyOverlay(base, cached?.manifest ?? null, cached === null ? 'none' : 'cache'),
    fetch: outcome,
  };
}

/**
 * What of a mid-session overlay change is safe to apply to a running world.
 *
 * The weather profile is: it is a plain data field the model rolls against, so
 * swapping it changes what *might* happen next and disturbs nothing that has
 * already happened. A meteor shower that turns on while you are sitting there
 * is the best possible version of this feature.
 *
 * The radio is not, and neither is a whole-environment replacement. Rebuilding
 * the dial mid-session would yank the tuning out from under somebody who is
 * listening to a station, and replacing the environment would change the ground
 * under a player who is standing on it. Both wait for the next arrival, which
 * is at most one night away and costs nobody anything. This is the same
 * reasoning the content schema uses for why an event may add but never remove.
 */
export function liveApplicable(result: OverlayResult): { weather: WeatherProfile } | null {
  return result.changed ? { weather: result.environment.weather } : null;
}

/** A line for the sync/debug readout. Never shown as an error to a player. */
export function describeOverlay(result: OverlayResult, failure?: ApiFailure | null): string {
  if (result.source === 'none') {
    return failure ? `no overlay (${failure.kind})` : 'no overlay; compiled catalogue only';
  }
  const parts = [`release ${result.releaseVersion} from ${result.source}`];
  if (result.events.length > 0) parts.push(result.events.map((event) => event.name).join(', '));
  if (result.rejected.length > 0) parts.push(`${result.rejected.length} document(s) rejected`);
  return parts.join(' · ');
}

/** Convenience for callers that already hold an `ApiResult`-shaped failure. */
export function overlayFailure(fetch: OverlayFetch): ApiResult<ContentManifest> | null {
  if (fetch.kind === 'fresh') return { ok: true, value: fetch.manifest };
  if (fetch.kind === 'failed') return { ok: false, error: fetch.failure };
  return null;
}
