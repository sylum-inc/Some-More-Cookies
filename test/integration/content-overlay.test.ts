/**
 * The content overlay, across the seam.
 *
 * Not a mocked fetch and not a hand-written manifest: this boots the real API
 * with its real live-ops domain, publishes a real document through the real
 * authoring routes, and then drives the real client the campfire uses. The
 * seam is the thing under test, and a mock of one half cannot test a seam.
 *
 * The four claims, in the order they matter:
 *
 *  1. A published seasonal event reaches a client and **changes its world**.
 *  2. A returning client with a current ETag gets a **304 and no payload**.
 *  3. A client that cannot reach the service gets a campsite **byte-identical**
 *     to the compiled-in catalogue.
 *  4. A window opening **flips the manifest with nobody publishing anything**,
 *     because activation is evaluated against the service's clock.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { getEnvironment } from '@somemore/content';
import { bootstrap, key, startTestApi, type Player, type TestHarness,
  grantOperator,
} from '../../services/api/test/harness.js';
import { OPS_TOKEN_HEADER } from '../../services/api/src/routes/liveops.js';
import {
  applyOverlay,
  clearCachedOverlay,
  fetchOverlay,
  overlayForBoot,
  readCachedOverlay,
  refreshOverlay,
} from '../../apps/web/src/net/overlay.js';

const OPS_TOKEN = 'ops-token-for-tests-only';

/** A localStorage for a node process. The client is allowed to have one. */
class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key_: string): string | null {
    return this.map.get(key_) ?? null;
  }
  setItem(key_: string, value: string): void {
    this.map.set(key_, value);
  }
  removeItem(key_: string): void {
    this.map.delete(key_);
  }
}

let api: TestHarness;
let operator: Player;

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  api = await startTestApi({ LIVE_OPS_TOKEN: OPS_TOKEN });
  operator = await bootstrap(api, 'Live Ops');
  // A real operator account with real capabilities (README, Blocker 9).
  await grantOperator(api, operator.accountId, { role: 'admin' });
  clearCachedOverlay();
});

afterEach(async () => {
  await api.close();
});

async function ops(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return api.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    token: operator.token,
    ...(body === undefined ? {} : { body }),
  });
}

/** Draft and publish one document, the way a person would in the console. */
async function publish(options: {
  kind: string;
  slug: string;
  title: string;
  body: unknown;
  activation?: { startsAt: string | null; endsAt: string | null } | null;
}): Promise<string> {
  const draft = await ops('/v1/live-ops/documents', {
    idempotencyKey: key('doc'),
    kind: options.kind,
    slug: options.slug,
    title: options.title,
    body: options.body,
    activation: options.activation ?? null,
    notes: '',
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);

  const staged = await ops(`/v1/live-ops/documents/${draft.body.id}/transitions`, {
    idempotencyKey: key('t'),
    to: 'staged',
    notes: '',
  });
  expect(staged.status, JSON.stringify(staged.body)).toBe(200);

  const published = await ops(`/v1/live-ops/documents/${draft.body.id}/transitions`, {
    idempotencyKey: key('t'),
    to: 'published',
    notes: '',
  });
  expect(published.status, JSON.stringify(published.body)).toBe(200);
  return draft.body.id as string;
}

const METEOR_SHOWER = {
  id: 'perseids_weekend',
  name: 'Perseids Weekend',
  tagline: 'The sky is busy this weekend. Look up.',
  kind: 'sky-event',
  environments: ['*'],
  skyEvent: 'aurora',
  intensity: 0.75,
  rewardCodes: [],
  stations: [],
  performanceCost: 'light',
  note: 'Three nights. A gift, never a gate.',
};

const BASE = getEnvironment('pine_hollow');
if (!BASE) throw new Error('pine_hollow is missing');

describe('a published seasonal event reaches a client and changes its world', () => {
  it('turns up in the manifest and lands on the campsite the client builds', async () => {
    // Before: nothing published, so the manifest is empty and a client is on
    // its compiled catalogue.
    const empty = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(empty.fetch.kind).toBe('fresh');
    expect(empty.result.changed).toBe(false);
    expect(empty.result.environment).toBe(BASE);

    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
    });

    const after = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(after.fetch.kind).toBe('fresh');
    expect(after.result.changed).toBe(true);
    expect(after.result.source).toBe('network');
    expect(after.result.events.map((event) => event.name)).toEqual(['Perseids Weekend']);

    // The world genuinely changed: this campsite can now produce an aurora,
    // and is more likely to produce something at all.
    expect(BASE.weather.skyEvents).not.toContain('aurora');
    expect(after.result.environment.weather.skyEvents).toContain('aurora');
    expect(after.result.environment.weather.skyEventChance).toBeGreaterThan(BASE.weather.skyEventChance);
    // ...and nothing the event did not mention moved.
    expect(after.result.environment.wildlife).toBe(BASE.wildlife);
    expect(after.result.environment.scene).toBe(BASE.scene);

    // And the next launch is instant: the campsite is built from the cache,
    // synchronously, before anything touches the network.
    const booted = overlayForBoot('pine_hollow');
    expect(booted.source).toBe('cache');
    expect(booted.environment.weather.skyEvents).toContain('aurora');
  });

  it('adds programming to the dial, everywhere it was aimed', async () => {
    await publish({
      kind: 'station_programming',
      slug: 'night_freight',
      title: 'Night Freight',
      body: {
        id: 'night_freight',
        name: 'Night Freight',
        environments: ['pine_hollow'],
        stations: [
          {
            id: 'night_freight_1',
            dial: 91.7,
            band: 'fm',
            name: 'Night Freight',
            character: 'lofi',
            reception: 0.62,
            note: 'A tape loop somebody left running in a signal hut.',
          },
        ],
        note: 'Extra programming while the window is open.',
      },
    });

    const here = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(here.result.environment.radio.stations.map((s) => s.id)).toContain('night_freight_1');

    // Aimed at pine_hollow only, so a different campsite is untouched.
    const elsewhere = await refreshOverlay({ environmentId: 'lantern_mesa', baseUrl: api.baseUrl });
    expect(elsewhere.result.changed).toBe(false);
  });
});

describe('the service refuses to publish what a client would have to refuse', () => {
  it('rejects a gating event at publish time, with dotted paths', async () => {
    const draft = await ops('/v1/live-ops/documents', {
      idempotencyKey: key('doc'),
      kind: 'seasonal_event',
      slug: 'gated_weekend',
      title: 'Gated Weekend',
      // Spec §5.5 and §8: seasonal content may never gate anything.
      body: { ...METEOR_SHOWER, id: 'gated_weekend', exclusive: true },
      activation: null,
      notes: '',
    });
    expect(draft.status).toBe(201);
    await ops(`/v1/live-ops/documents/${draft.body.id}/transitions`, {
      idempotencyKey: key('t'),
      to: 'staged',
      notes: '',
    });
    const published = await ops(`/v1/live-ops/documents/${draft.body.id}/transitions`, {
      idempotencyKey: key('t'),
      to: 'published',
      notes: '',
    });

    expect(published.status).toBe(422);
    expect(published.body.error.code).toBe('content_invalid');
    const issues = published.body.error.details.issues as { path: string; message: string }[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]?.path).toContain('gated_weekend.');

    // ...and because it never published, no client ever sees it.
    const overlay = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(overlay.result.changed).toBe(false);
  });
});

describe('caching', () => {
  it('answers a returning client with 304 and no payload', async () => {
    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
    });

    const first = await fetchOverlay({ baseUrl: api.baseUrl });
    expect(first.kind).toBe('fresh');
    if (first.kind !== 'fresh') throw new Error('expected a payload');
    expect(first.etag.length).toBeGreaterThan(2);

    // Straight back, with the validator we were given.
    const second = await fetchOverlay({ baseUrl: api.baseUrl, etag: first.etag });
    expect(second.kind).toBe('unchanged');

    // And confirm at the HTTP level that nothing moved.
    const raw = await fetch(`${api.baseUrl}/v1/content/manifest`, {
      headers: { 'if-none-match': first.etag },
    });
    expect(raw.status).toBe(304);
    expect((await raw.text()).length).toBe(0);

    // A stale validator gets the whole thing.
    const stale = await fetchOverlay({ baseUrl: api.baseUrl, etag: '"not-the-current-one"' });
    expect(stale.kind).toBe('fresh');
  });

  it('caches only a payload it could parse, so a bad response cannot poison a launch', async () => {
    const before = readCachedOverlay();
    const result = await refreshOverlay({
      environmentId: 'pine_hollow',
      baseUrl: api.baseUrl,
      fetchImpl: async () =>
        new Response(JSON.stringify({ nonsense: true }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    });
    expect(result.fetch.kind).toBe('failed');
    expect(readCachedOverlay()).toEqual(before);
    expect(result.result.environment).toBe(BASE);
  });
});

describe('an unreachable service leaves the world identical to the compiled-in catalogue', () => {
  it('is byte-identical, and is not an error', async () => {
    clearCachedOverlay();
    const result = await refreshOverlay({
      environmentId: 'pine_hollow',
      baseUrl: api.baseUrl,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });

    expect(result.fetch.kind).toBe('failed');
    // Object identity, not deep equality: the client did not so much as clone
    // the compiled manifest, let alone change it.
    expect(result.result.environment).toBe(BASE);
    expect(result.result.changed).toBe(false);
    expect(result.result.events).toEqual([]);
    expect(result.result.source).toBe('none');
  });

  it('still gets the last known overlay when the service is down', async () => {
    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
    });
    // One good fetch, which leaves a cache behind.
    await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });

    // Now the depot falls over. An offline launch keeps the meteor shower.
    const offline = await refreshOverlay({
      environmentId: 'pine_hollow',
      baseUrl: api.baseUrl,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    expect(offline.result.source).toBe('cache');
    expect(offline.result.environment.weather.skyEvents).toContain('aurora');
  });

  it('survives a service that answers 500 for the manifest', async () => {
    const result = await refreshOverlay({
      environmentId: 'pine_hollow',
      baseUrl: api.baseUrl,
      fetchImpl: async () => new Response('the depot fell over', { status: 500 }),
    });
    expect(result.fetch.kind).toBe('failed');
    expect(result.result.environment).toBe(BASE);
  });
});

describe('a window opens on the service’s clock, not on anybody else’s', () => {
  it('flips the manifest — and the ETag — with nobody publishing anything', async () => {
    // Starts in an hour by the service's clock, which the harness controls.
    const opensAt = new Date(api.clock.now().getTime() + 3_600_000).toISOString();
    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
      activation: { startsAt: opensAt, endsAt: null },
    });

    const before = await fetchOverlay({ baseUrl: api.baseUrl });
    if (before.kind !== 'fresh') throw new Error('expected a payload');
    expect(before.manifest.documents[0]?.active).toBe(false);
    expect(before.manifest.activeEventSlugs).toEqual([]);

    // A client applying that manifest changes nothing: the event exists, and
    // is not on yet.
    expect(applyOverlay(BASE, before.manifest, 'network').changed).toBe(false);

    // The weekend arrives. Nobody publishes anything.
    api.clock.advance(2 * 3_600_000);

    // The phone polls with the validator it had, and learns about it on the
    // request that would otherwise have been a 304. That is the whole point of
    // an ETag that covers activation state.
    const after = await fetchOverlay({ baseUrl: api.baseUrl, etag: before.etag });
    expect(after.kind).toBe('fresh');
    if (after.kind !== 'fresh') throw new Error('expected a payload');
    expect(after.etag).not.toBe(before.etag);
    expect(after.manifest.documents[0]?.active).toBe(true);
    expect(after.manifest.activeEventSlugs).toEqual(['perseids_weekend']);

    const applied = applyOverlay(BASE, after.manifest, 'network');
    expect(applied.changed).toBe(true);
    expect(applied.environment.weather.skyEvents).toContain('aurora');
  });

  it('closes it again, half-open, without anybody touching it', async () => {
    const now = api.clock.now().getTime();
    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
      activation: { startsAt: null, endsAt: new Date(now + 3_600_000).toISOString() },
    });

    const open = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(open.result.changed).toBe(true);

    api.clock.advance(3_600_000);
    const shut = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(shut.result.changed).toBe(false);
    expect(shut.result.environment).toBe(BASE);
  });
});

describe('rollback', () => {
  it('takes a bad publish off every client, forward-only', async () => {
    await publish({
      kind: 'seasonal_event',
      slug: 'perseids_weekend',
      title: 'Perseids Weekend',
      body: METEOR_SHOWER,
    });
    const live = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(live.result.changed).toBe(true);
    const badRelease = live.result.releaseVersion;

    // Roll back to release 0... which does not exist, so roll back to the
    // *previous* release. With one publish there is exactly one release, so
    // retire the document instead and confirm the client loses the event.
    const documents = await ops('/v1/live-ops/documents?slug=perseids_weekend&status=published');
    expect(documents.status).toBe(200);
    const documentId = documents.body.items[0].id as string;
    const retired = await ops(`/v1/live-ops/documents/${documentId}/transitions`, {
      idempotencyKey: key('t'),
      to: 'retired',
      notes: 'wrong environment list',
    });
    expect(retired.status).toBe(200);

    const gone = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(gone.result.changed).toBe(false);
    expect(gone.result.environment).toBe(BASE);

    // Forward-only: the release history kept every step, and the retirement is
    // a release of its own rather than a rewind.
    const releases = await ops('/v1/live-ops/releases');
    const versions = (releases.body.items as { version: number; reason: string }[]).map((r) => r.version);
    expect(Math.max(...versions)).toBeGreaterThan(badRelease);

    // Now put it back by rolling forward to the release that had it.
    const rolled = await ops('/v1/live-ops/releases/rollback', {
      idempotencyKey: key('rb'),
      toVersion: badRelease,
      note: 'it was right after all',
    });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(201);
    expect(rolled.body.reason).toBe('rollback');
    expect(rolled.body.rolledBackFromVersion).toBe(badRelease);

    const back = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: api.baseUrl });
    expect(back.result.changed).toBe(true);
    expect(back.result.environment.weather.skyEvents).toContain('aurora');
  });
});

describe('authoring is honest about not being configured', () => {
  it('refuses an unappointed player by name, and keeps serving the manifest', async () => {
    /*
     * This used to assert a `503 service_not_configured` naming
     * `LIVE_OPS_TOKEN`, because authoring was gated on that secret being set.
     * That was authorization wearing a configuration's clothes: publishing
     * content needs no credential and no external service. The real question is
     * "may this person" (README, Blocker 9), and the answer names the
     * capability rather than an environment variable.
     */
    const bare = await startTestApi();
    try {
      const player = await bootstrap(bare, 'Live Ops');

      const status = await bare.request('/v1/live-ops/status', { token: player.token });
      expect(status.status).toBe(200);

      const attempt = await bare.request('/v1/live-ops/documents', {
        method: 'POST',
        token: player.token,
        headers: { [OPS_TOKEN_HEADER]: 'anything' },
        body: {
          idempotencyKey: key('doc'),
          kind: 'seasonal_event',
          slug: 'nope',
          title: 'Nope',
          body: METEOR_SHOWER,
          activation: null,
          notes: '',
        },
      });
      expect(attempt.status).toBe(403);
      expect(attempt.body.error.message).toContain('content:draft');

      // Reads still work, and a client is still a working client.
      const overlay = await refreshOverlay({ environmentId: 'pine_hollow', baseUrl: bare.baseUrl });
      expect(overlay.fetch.kind).toBe('fresh');
      expect(overlay.result.environment).toBe(BASE);
    } finally {
      await bare.close();
    }
  });
});
