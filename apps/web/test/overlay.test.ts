/**
 * The content overlay, on its own.
 *
 * The seam tests in `test/integration/content-overlay.test.ts` drive this
 * against the real service. These are the cases a real service will not
 * conveniently produce: a hostile document, a document that is individually
 * fine but combines into something invalid, a corrupt cache, a payload from a
 * future schema.
 *
 * The property every one of them is really asserting is the same: **the worst
 * thing an overlay can do is nothing.**
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { getEnvironment } from '@somemore/content';
import type { ContentManifest, ManifestDocument } from '@somemore/protocol';
import {
  applyOverlay,
  clearCachedOverlay,
  fetchOverlay,
  overlayForBoot,
  readCachedOverlay,
  writeCachedOverlay,
  liveApplicable,
  describeOverlay,
} from '../src/net/overlay.js';

/* A localStorage that behaves, for a node environment that has none. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

const BASE = getEnvironment('pine_hollow');
if (!BASE) throw new Error('pine_hollow is missing from the catalogue');

function manifest(documents: ManifestDocument[], releaseVersion = 3): ContentManifest {
  return {
    releaseVersion,
    evaluatedAt: '2026-08-30T02:00:00.000Z',
    schemaVersion: '0.0.0',
    etag: '"deadbeef"',
    documents,
    activeEventSlugs: documents.filter((d) => d.kind === 'seasonal_event' && d.active).map((d) => d.slug),
    overlay: true,
  };
}

function meteorShower(overrides: Record<string, unknown> = {}): ManifestDocument {
  return {
    kind: 'seasonal_event',
    slug: 'perseids_weekend',
    version: 1,
    checksum: 'a'.repeat(64),
    title: 'Perseids Weekend',
    body: {
      id: 'perseids_weekend',
      name: 'Perseids Weekend',
      tagline: 'The sky is busy this weekend.',
      kind: 'sky-event',
      environments: ['*'],
      skyEvent: 'meteor-shower',
      intensity: 0.8,
      rewardCodes: [],
      stations: [],
      performanceCost: 'light',
      note: 'Three nights in August.',
      ...overrides,
    },
    activation: null,
    active: true,
  };
}

describe('the merge', () => {
  it('leaves the compiled environment exactly alone when there is nothing to apply', () => {
    const result = applyOverlay(BASE, null, 'none');
    expect(result.environment).toBe(BASE);
    expect(result.changed).toBe(false);
    expect(result.source).toBe('none');
    expect(liveApplicable(result)).toBeNull();
  });

  it('adds a sky event to the campsite’s repertoire and raises its likelihood', () => {
    expect(BASE.weather.skyEvents).not.toContain('aurora');
    const result = applyOverlay(BASE, manifest([meteorShower({ skyEvent: 'aurora' })]), 'network');

    expect(result.changed).toBe(true);
    expect(result.environment.weather.skyEvents).toContain('aurora');
    // Additive: the campsite keeps whatever it already had.
    for (const event of BASE.weather.skyEvents) {
      expect(result.environment.weather.skyEvents).toContain(event);
    }
    expect(result.environment.weather.skyEventChance).toBeGreaterThan(BASE.weather.skyEventChance);
    expect(result.environment.weather.skyEventChance).toBeLessThanOrEqual(1);
    // Everything the overlay did not mention is still the base's.
    expect(result.environment.wildlife).toBe(BASE.wildlife);
    expect(result.environment.scene).toBe(BASE.scene);
    expect(result.events[0]?.name).toBe('Perseids Weekend');
  });

  it('leans the weather weights without removing a campsite’s personality', () => {
    const document = meteorShower({ kind: 'weather', weather: 'snow', skyEvent: undefined, intensity: 1 });
    const result = applyOverlay(BASE, manifest([document]), 'network');

    expect(result.changed).toBe(true);
    const weights = result.environment.weather.weights;
    expect(weights['snow']).toBeGreaterThan(BASE.weather.weights['snow'] ?? 0);
    // A clear night is still possible. Nothing is ever removed.
    expect(weights['clear']).toBe(BASE.weather.weights['clear']);
  });

  it('appends stations to the dial without duplicating one already there', () => {
    const existing = BASE.radio.stations[0];
    if (!existing) throw new Error('pine_hollow has no stations');
    const station = {
      id: 'night_freight_1',
      dial: 91.3,
      band: 'fm',
      name: 'Night Freight',
      character: 'lofi',
      reception: 0.6,
      note: 'A tape loop.',
    };
    const document: ManifestDocument = {
      kind: 'station_programming',
      slug: 'night_freight',
      version: 1,
      checksum: 'b'.repeat(64),
      title: 'Night Freight',
      body: {
        id: 'night_freight',
        name: 'Night Freight',
        environments: ['pine_hollow'],
        // The second entry is the campsite's own station, sent again. It must
        // not land twice, or the dial would have two locks on one frequency.
        stations: [station, { ...existing }],
        note: 'Extra programming.',
      },
      activation: null,
      active: true,
    };

    const result = applyOverlay(BASE, manifest([document]), 'network');
    expect(result.changed).toBe(true);
    const ids = result.environment.radio.stations.map((s) => s.id);
    expect(ids).toContain('night_freight_1');
    expect(ids.filter((id) => id === existing.id)).toHaveLength(1);
    expect(result.environment.radio.stations.length).toBe(BASE.radio.stations.length + 1);
  });

  it('ignores a document whose window the server says is shut', () => {
    const result = applyOverlay(BASE, manifest([{ ...meteorShower(), active: false }]), 'network');
    expect(result.changed).toBe(false);
    expect(result.environment).toBe(BASE);
  });

  it('ignores an event aimed at a different campsite', () => {
    const document = meteorShower();
    (document.body as Record<string, unknown>)['environments'] = ['lantern_mesa'];
    const result = applyOverlay(BASE, manifest([document]), 'network');
    expect(result.changed).toBe(false);
  });

  it('does not recompute the window itself — the server’s clock is the only one', () => {
    // A window that closed a year ago, but which the server says is open.
    // The client renders what it was told; a device clock is not evidence.
    const document = meteorShower();
    document.activation = { startsAt: '2020-01-01T00:00:00.000Z', endsAt: '2020-01-02T00:00:00.000Z' };
    document.active = true;
    expect(applyOverlay(BASE, manifest([document]), 'network').changed).toBe(true);

    // ...and the converse: a window that is open by this machine's clock but
    // which the server says is shut changes nothing.
    document.activation = null;
    document.active = false;
    expect(applyOverlay(BASE, manifest([document]), 'network').changed).toBe(false);
  });
});

describe('rejection is structural', () => {
  it('drops a document that fails the content validator, and names it', () => {
    // `exclusive` is rejected by name: seasonal content may never gate
    // anything (spec §5.5, §8), and the validator says so.
    const hostile = meteorShower({ exclusive: true });
    const result = applyOverlay(BASE, manifest([hostile]), 'network');

    expect(result.changed).toBe(false);
    expect(result.environment).toBe(BASE);
    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0]?.slug).toBe('perseids_weekend');
    expect(result.rejected[0]?.issues.join(' ')).toContain('gate');
  });

  it('keeps applying the rest of the overlay after one bad document', () => {
    const result = applyOverlay(
      BASE,
      manifest([
        // Aimed at us, and nonsense: a kind that does not exist and an
        // intensity that is not a number.
        {
          ...meteorShower(),
          slug: 'broken_one',
          body: { id: 'broken_one', kind: 'not-a-kind', environments: ['*'], intensity: 'loud' },
        },
        meteorShower({ skyEvent: 'aurora' }),
      ]),
      'network',
    );

    expect(result.rejected.map((r) => r.slug)).toContain('broken_one');
    expect(result.changed).toBe(true);
    expect(result.environment.weather.skyEvents).toContain('aurora');
  });

  it('refuses an environment replacement that is not a valid environment', () => {
    const result = applyOverlay(
      BASE,
      manifest([
        {
          kind: 'environment',
          slug: 'pine_hollow',
          version: 9,
          checksum: 'c'.repeat(64),
          title: 'Pine Hollow (broken)',
          body: { id: 'pine_hollow', name: 'Pine Hollow' },
          activation: null,
          active: true,
        },
      ]),
      'network',
    );

    expect(result.changed).toBe(false);
    expect(result.environment).toBe(BASE);
    expect(result.rejected[0]?.issues.length).toBeGreaterThan(3);
  });

  it('accepts an environment replacement that is a valid environment', () => {
    const replacement = { ...BASE, tagline: 'A quieter hollow, this month.' };
    const result = applyOverlay(
      BASE,
      manifest([
        {
          kind: 'environment',
          slug: 'pine_hollow',
          version: 9,
          checksum: 'c'.repeat(64),
          title: 'Pine Hollow',
          body: replacement as never,
          activation: null,
          active: true,
        },
      ]),
      'network',
    );
    expect(result.changed).toBe(true);
    expect(result.environment.tagline).toBe('A quieter hollow, this month.');
  });

  it('throws the whole merge away if the result would not have been legal to compile in', () => {
    /*
     * Layer 3, and the reason it exists. Each of these documents passes
     * `validateStationProgramming` on its own — six stations, unique ids,
     * legal bands. Together they push the campsite's dial past the twelve
     * stations `validateEnvironment` allows, and a merged environment that
     * would not have been legal to compile in must never reach the simulation.
     */
    const block = (prefix: string): ManifestDocument => ({
      kind: 'station_programming',
      slug: prefix,
      version: 1,
      checksum: 'd'.repeat(64),
      title: prefix,
      body: {
        id: prefix,
        name: prefix,
        environments: ['*'],
        stations: Array.from({ length: 6 }, (_unused, index) => ({
          id: `${prefix}_${index}`,
          dial: 90 + index / 10,
          band: 'fm',
          name: `${prefix} ${index}`,
          character: 'lofi',
          reception: 0.5,
          note: 'A tape loop.',
        })),
        note: 'Too much programming.',
      },
      activation: null,
      active: true,
    });

    // One block alone fits, and applies.
    const fits = applyOverlay(BASE, manifest([block('one')]), 'network');
    expect(fits.changed).toBe(true);
    expect(fits.environment.radio.stations.length).toBe(BASE.radio.stations.length + 6);

    // Two do not, and the campsite is handed back exactly as it was compiled.
    const overflows = applyOverlay(BASE, manifest([block('one'), block('two')]), 'network');
    expect(overflows.changed).toBe(false);
    expect(overflows.environment).toBe(BASE);
    expect(overflows.rejected.some((entry) => entry.kind === 'environment')).toBe(true);
    expect(overflows.rejected.at(-1)?.issues.join(' ')).toContain('stations');
  });

  it('survives a body that is not an object at all', () => {
    for (const body of [null, 42, 'a string', []]) {
      const result = applyOverlay(
        BASE,
        manifest([{ ...meteorShower(), body: body as never }]),
        'network',
      );
      expect(result.changed).toBe(false);
      expect(result.environment).toBe(BASE);
    }
  });
});

describe('the cache', () => {
  it('round-trips a manifest', () => {
    const value = manifest([meteorShower()]);
    writeCachedOverlay({ manifest: value, etag: '"abc"', fetchedAt: 1 });
    const back = readCachedOverlay();
    expect(back?.etag).toBe('"abc"');
    expect(back?.manifest.documents).toHaveLength(1);
  });

  it('treats a corrupt entry as no overlay rather than as an error', () => {
    localStorage.setItem('some-more/content-overlay/v2', '{not json');
    expect(readCachedOverlay()).toBeNull();
    expect(() => overlayForBoot('pine_hollow')).not.toThrow();
    expect(overlayForBoot('pine_hollow').changed).toBe(false);
  });

  it('treats an entry from a schema this build does not know as no overlay', () => {
    localStorage.setItem(
      'some-more/content-overlay/v2',
      JSON.stringify({ manifest: { releaseVersion: 'not a number' }, etag: '"x"' }),
    );
    expect(readCachedOverlay()).toBeNull();
  });

  it('refuses a cached manifest with no etag, because it could never be revalidated', () => {
    writeCachedOverlay({ manifest: manifest([]), etag: '', fetchedAt: 0 });
    expect(readCachedOverlay()).toBeNull();
  });

  it('boots from the cache, synchronously, with no network at all', () => {
    writeCachedOverlay({ manifest: manifest([meteorShower({ skyEvent: 'aurora' })]), etag: '"e"', fetchedAt: 0 });
    const result = overlayForBoot('pine_hollow');
    expect(result.source).toBe('cache');
    expect(result.environment.weather.skyEvents).toContain('aurora');
  });

  it('boots from the compiled catalogue when the cache is empty', () => {
    clearCachedOverlay();
    const result = overlayForBoot('pine_hollow');
    expect(result.source).toBe('none');
    expect(result.environment).toBe(BASE);
  });
});

describe('fetching', () => {
  it('reports a 304 as unchanged rather than as a payload', async () => {
    const outcome = await fetchOverlay({
      etag: '"same"',
      fetchImpl: async () => new Response(null, { status: 304 }),
    });
    expect(outcome.kind).toBe('unchanged');
  });

  it('sends the cached etag as If-None-Match', async () => {
    let sent: string | null = null;
    await fetchOverlay({
      etag: '"cached"',
      fetchImpl: async (_input, init) => {
        sent = (init?.headers as Record<string, string> | undefined)?.['if-none-match'] ?? null;
        return new Response(null, { status: 304 });
      },
    });
    expect(sent).toBe('"cached"');
  });

  it('rejects a payload that does not match the contract, whole', async () => {
    const outcome = await fetchOverlay({
      fetchImpl: async () =>
        new Response(JSON.stringify({ releaseVersion: 1, overlay: false }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.failure.kind).toBe('malformed');
  });

  it('reports an unreachable service as offline, and does not throw', async () => {
    const outcome = await fetchOverlay({
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.failure.kind).toBe('offline');
  });

  it('gives up rather than hanging', async () => {
    const outcome = await fetchOverlay({
      timeoutMs: 20,
      fetchImpl: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    });
    expect(outcome.kind).toBe('failed');
    if (outcome.kind === 'failed') expect(outcome.failure.kind).toBe('timeout');
  });
});

describe('what it says about itself', () => {
  it('never describes an absent overlay as a failure', () => {
    expect(describeOverlay(applyOverlay(BASE, null, 'none'))).toContain('compiled catalogue');
  });

  it('names the release and the events when there are some', () => {
    const line = describeOverlay(applyOverlay(BASE, manifest([meteorShower()], 7), 'network'));
    expect(line).toContain('release 7');
    expect(line).toContain('Perseids Weekend');
  });
});
