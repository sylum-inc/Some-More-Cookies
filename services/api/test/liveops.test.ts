import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { validateSeasonalEvent, validateStationProgramming } from '@somemore/content';
import { bootstrap, key, startTestApi, type Player, type TestHarness } from './harness.js';
import { OPS_TOKEN_HEADER } from '../src/routes/liveops.js';

/*
 * Live ops, over HTTP, against whichever backend this run is exercising.
 *
 * The cases below are the ones that would cost somebody a weekend if they were
 * wrong: a document that fails validation must not reach a player's phone, a
 * bad publish must be undoable without a deploy, a client with a stale ETag must
 * get a 304 rather than a payload, and a seasonal window must not open because
 * a phone says so.
 */

const OPS_TOKEN = 'ops-token-for-tests-only';

const PERSEID = {
  id: 'perseid_weekend',
  name: 'Perseid weekend',
  tagline: 'The sky is busy tonight.',
  kind: 'sky-event',
  environments: ['*'],
  skyEvent: 'meteor-shower',
  intensity: 0.7,
  rewardCodes: [],
  stations: [],
  performanceCost: 'light',
  note: 'A gift, never a gate: nothing here is reachable only during the window.',
};

const WINTER_DIAL = {
  id: 'winter_dial',
  name: 'Winter dial',
  environments: ['pine_hollow', 'meltwater_cirque'],
  stations: [
    {
      id: 'kold',
      dial: 88.5,
      band: 'fm',
      name: 'KOLD',
      character: 'lofi',
      reception: 0.62,
      note: 'Tape hiss and a snow warning that never quite arrives.',
    },
  ],
  note: 'Extra programming for the cold months.',
};

let api: TestHarness;
let operator: Player;

async function ops(path: string, body: unknown, method: 'POST' | 'GET' = 'POST') {
  return api.request(path, {
    method,
    token: operator.token,
    headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
    ...(method === 'GET' ? {} : { body }),
  });
}

async function draft(body: unknown, overrides: Record<string, unknown> = {}) {
  const response = await ops('/v1/live-ops/documents', {
    idempotencyKey: key('doc'),
    kind: 'seasonal_event',
    slug: (body as { id: string }).id,
    title: 'A document',
    body,
    ...overrides,
  });
  return response;
}

async function transition(documentId: string, to: string) {
  return ops(`/v1/live-ops/documents/${documentId}/transitions`, { idempotencyKey: key('tr'), to });
}

/** draft -> staged -> published in one go, asserting each step. */
async function publish(body: unknown, overrides: Record<string, unknown> = {}) {
  const created = await draft(body, overrides);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  expect((await transition(created.body.id, 'staged')).status).toBe(200);
  const published = await transition(created.body.id, 'published');
  return { created: created.body, published };
}

beforeEach(async () => {
  api = await startTestApi({ LIVE_OPS_TOKEN: OPS_TOKEN });
  operator = await bootstrap(api, 'Operator');
});

afterEach(async () => {
  await api.close();
});

describe('the publish gate', () => {
  it('reuses the content validator and reports every dotted path at once', async () => {
    const broken = { ...PERSEID, skyEvent: 'none', intensity: 4, performanceCost: 'enormous' };
    const created = await draft(broken);
    expect(created.status).toBe(201);
    await transition(created.body.id, 'staged');

    const published = await transition(created.body.id, 'published');
    expect(published.status).toBe(422);
    expect(published.body.error.code).toBe('content_invalid');

    const paths = published.body.error.details.issues.map((i: { path: string }) => i.path);
    expect(paths).toContain('perseid_weekend.skyEvent');
    expect(paths).toContain('perseid_weekend.intensity');
    expect(paths).toContain('perseid_weekend.performanceCost');

    // And nothing reached the manifest.
    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.body.documents).toHaveLength(0);
  });

  it('is the same validator the compiled catalogue passes', () => {
    // If these two ever disagree, live ops can publish something the client
    // would refuse to load — which is the whole failure this reuse prevents.
    expect(validateSeasonalEvent(PERSEID)).toEqual([]);
    expect(validateStationProgramming(WINTER_DIAL)).toEqual([]);
    expect(validateSeasonalEvent({ ...PERSEID, skyEvent: 'none' }).map((i) => i.path)).toContain(
      'perseid_weekend.skyEvent',
    );
  });

  it('refuses an event pointed at an environment that does not exist', async () => {
    const created = await draft({ ...PERSEID, environments: ['pine_hollow', 'not_a_place'] });
    await transition(created.body.id, 'staged');
    const published = await transition(created.body.id, 'published');
    expect(published.status).toBe(422);
    expect(published.body.error.details.issues[0].path).toBe('perseid_weekend.environments[1]');
  });

  it('refuses an event that offers a reward nobody defined', async () => {
    const created = await draft({ ...PERSEID, rewardCodes: ['a_kit_that_does_not_exist'] });
    await transition(created.body.id, 'staged');
    const published = await transition(created.body.id, 'published');
    expect(published.status).toBe(422);
    expect(published.body.error.details.issues[0].path).toBe('perseid_weekend.rewardCodes[0]');
  });

  it('refuses a body whose id disagrees with the slug it was filed under', async () => {
    const created = await ops('/v1/live-ops/documents', {
      idempotencyKey: key('doc'),
      kind: 'seasonal_event',
      slug: 'filed_as_this',
      title: 'Mismatched',
      body: PERSEID,
    });
    await transition(created.body.id, 'staged');
    const published = await transition(created.body.id, 'published');
    expect(published.status).toBe(422);
    expect(published.body.error.details.issues.map((i: { path: string }) => i.path)).toContain(
      'filed_as_this.id',
    );
  });

  it('will not publish straight from draft', async () => {
    const created = await draft(PERSEID);
    const published = await transition(created.body.id, 'published');
    expect(published.status).toBe(409);
    expect(published.body.error.code).toBe('illegal_state_transition');
  });

  it('dry-runs a body without storing anything', async () => {
    const checked = await ops('/v1/live-ops/documents/validate', {
      kind: 'seasonal_event',
      body: { ...PERSEID, intensity: 9 },
    });
    expect(checked.status).toBe(200);
    expect(checked.body.valid).toBe(false);
    expect(checked.body.issues[0].path).toBe('perseid_weekend.intensity');
    const listed = await ops('/v1/live-ops/documents', null, 'GET');
    expect(listed.body.items).toHaveLength(0);
  });
});

describe('the manifest', () => {
  it('is empty and still valid before anything is ever published', async () => {
    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.status).toBe(200);
    expect(manifest.body.releaseVersion).toBe(0);
    expect(manifest.body.overlay).toBe(true);
    expect(manifest.body.documents).toEqual([]);
  });

  it('is public, so a signed-out client can still overlay content', async () => {
    await publish(PERSEID);
    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.status).toBe(200);
    expect(manifest.body.documents).toHaveLength(1);
  });

  it('answers 304 with no body when the client already has this version', async () => {
    await publish(PERSEID);
    const first = await api.request('/v1/content/manifest');
    const etag = first.headers.get('etag');
    expect(etag).toBeTruthy();

    const second = await api.request('/v1/content/manifest', {
      headers: { 'if-none-match': etag as string },
    });
    expect(second.status).toBe(304);
    expect(second.body).toBeNull();
    expect(second.headers.get('etag')).toBe(etag);
  });

  it('accepts a weakened or listed validator, as a proxy is entitled to send', async () => {
    await publish(PERSEID);
    const first = await api.request('/v1/content/manifest');
    const etag = first.headers.get('etag') as string;
    for (const header of [`W/${etag}`, `"stale", ${etag}`, '*']) {
      const conditional = await api.request('/v1/content/manifest', {
        headers: { 'if-none-match': header },
      });
      expect(conditional.status, header).toBe(304);
    }
  });

  it('changes its ETag when something is published, so a stale client refetches', async () => {
    await publish(PERSEID);
    const before = (await api.request('/v1/content/manifest')).headers.get('etag');
    await publish(WINTER_DIAL, { kind: 'station_programming', slug: 'winter_dial' });
    const after = await api.request('/v1/content/manifest', {
      headers: { 'if-none-match': before as string },
    });
    expect(after.status).toBe(200);
    expect(after.headers.get('etag')).not.toBe(before);
    expect(after.body.documents).toHaveLength(2);
  });

  it('serves one document on its own, with its own validator', async () => {
    await publish(PERSEID);
    const document = await api.request('/v1/content/documents/seasonal_event/perseid_weekend');
    expect(document.status).toBe(200);
    expect(document.body.slug).toBe('perseid_weekend');
    const etag = document.headers.get('etag') as string;
    const again = await api.request('/v1/content/documents/seasonal_event/perseid_weekend', {
      headers: { 'if-none-match': etag },
    });
    expect(again.status).toBe(304);
    expect((await api.request('/v1/content/documents/seasonal_event/nothing_here')).status).toBe(404);
  });
});

describe('seasonal windows', () => {
  const window = { startsAt: '2026-09-01T00:00:00.000Z', endsAt: '2026-09-03T00:00:00.000Z' };

  it('does not activate before it opens, however published it is', async () => {
    // The harness clock is 2026-08-29, two days before the window.
    const { published } = await publish(PERSEID, { activation: window });
    expect(published.status).toBe(200);

    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.body.documents[0].active).toBe(false);
    expect(manifest.body.activeEventSlugs).toEqual([]);
  });

  it('opens and closes on the server clock, and the ETag moves with it', async () => {
    await publish(PERSEID, { activation: window });
    const closed = await api.request('/v1/content/manifest');
    const closedEtag = closed.headers.get('etag') as string;

    api.clock.set(new Date('2026-09-02T00:00:00.000Z'));
    const open = await api.request('/v1/content/manifest', { headers: { 'if-none-match': closedEtag } });
    expect(open.status).toBe(200);
    expect(open.body.documents[0].active).toBe(true);
    expect(open.body.activeEventSlugs).toEqual(['perseid_weekend']);

    // Half-open at the far end too: the instant it ends, it is over.
    api.clock.set(new Date('2026-09-03T00:00:00.000Z'));
    const expired = await api.request('/v1/content/manifest');
    expect(expired.body.documents[0].active).toBe(false);
    expect(expired.body.activeEventSlugs).toEqual([]);
  });

  it('ignores what the client thinks the time is', async () => {
    await publish(PERSEID, { activation: window });
    // Every lever a client has: a query parameter, a header, a body. None of
    // them reach the evaluation, which reads the injected clock and nothing else.
    const manifest = await api.request('/v1/content/manifest?at=2026-09-02T00:00:00.000Z', {
      headers: { date: 'Wed, 02 Sep 2026 00:00:00 GMT', 'x-client-time': '2026-09-02T00:00:00.000Z' },
    });
    expect(manifest.body.documents[0].active).toBe(false);
    expect(manifest.body.evaluatedAt).toBe('2026-08-29T12:00:00.000Z');
  });
});

describe('releases and rollback', () => {
  it('mints a numbered release for every publish and retirement', async () => {
    await publish(PERSEID);
    await publish(WINTER_DIAL, { kind: 'station_programming', slug: 'winter_dial' });
    const releases = await ops('/v1/live-ops/releases', null, 'GET');
    expect(releases.body.items.map((r: { version: number }) => r.version)).toEqual([2, 1]);
    expect(releases.body.items[0].reason).toBe('publish');
    expect(releases.body.items[0].entries).toHaveLength(2);
  });

  it('undoes a bad publish by promoting a previous release, with no deploy', async () => {
    // v1: the good one.
    const good = await publish(PERSEID, { activation: null });
    expect(good.published.status).toBe(200);
    const goodChecksum = (await api.request('/v1/content/manifest')).body.documents[0].checksum;

    // v2: valid, published, and wrong — the tagline nobody meant to ship.
    const bad = await publish({ ...PERSEID, tagline: 'BUY NOW BUY NOW BUY NOW' });
    expect(bad.published.status).toBe(200);
    const shipped = await api.request('/v1/content/manifest');
    expect(shipped.body.documents[0].body.tagline).toBe('BUY NOW BUY NOW BUY NOW');
    expect(shipped.body.releaseVersion).toBe(2);

    const rolledBack = await ops('/v1/live-ops/releases/rollback', {
      idempotencyKey: key('rb'),
      toVersion: 1,
      note: 'Wrong copy went out.',
    });
    expect(rolledBack.status, JSON.stringify(rolledBack.body)).toBe(201);
    expect(rolledBack.body.reason).toBe('rollback');
    expect(rolledBack.body.rolledBackFromVersion).toBe(1);

    const after = await api.request('/v1/content/manifest');
    expect(after.body.documents[0].body.tagline).toBe(PERSEID.tagline);
    expect(after.body.documents[0].checksum).toBe(goodChecksum);
    // Forward-only: the rollback is release 3, not a rewind to release 1.
    expect(after.body.releaseVersion).toBe(3);
    // And the document itself is a new version, not a resurrected old row.
    expect(after.body.documents[0].version).toBe(3);
  });

  it('takes down anything the target release did not contain', async () => {
    await publish(PERSEID);
    await publish(WINTER_DIAL, { kind: 'station_programming', slug: 'winter_dial' });
    expect((await api.request('/v1/content/manifest')).body.documents).toHaveLength(2);

    const rolledBack = await ops('/v1/live-ops/releases/rollback', {
      idempotencyKey: key('rb'),
      toVersion: 1,
      note: 'The dial was not ready.',
    });
    expect(rolledBack.status).toBe(201);
    const after = await api.request('/v1/content/manifest');
    expect(after.body.documents.map((d: { slug: string }) => d.slug)).toEqual(['perseid_weekend']);
  });

  it('refuses to roll back to the release that is already live', async () => {
    await publish(PERSEID);
    const again = await ops('/v1/live-ops/releases/rollback', {
      idempotencyKey: key('rb'),
      toVersion: 1,
      note: 'no-op',
    });
    expect(again.status).toBe(409);
  });

  it('retires a document and the manifest stops carrying it', async () => {
    const { created } = await publish(PERSEID);
    const retired = await transition(created.id, 'retired');
    expect(retired.status).toBe(200);
    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.body.documents).toEqual([]);
    expect(manifest.body.releaseVersion).toBe(2);
  });

  it('keeps at most one version of a slug live at a time', async () => {
    await publish(PERSEID);
    await publish({ ...PERSEID, tagline: 'A newer line entirely.' });
    const manifest = await api.request('/v1/content/manifest');
    expect(manifest.body.documents).toHaveLength(1);
    expect(manifest.body.documents[0].version).toBe(2);
  });
});

describe('authoring authorization', () => {
  it('refuses a player who has no operator token', async () => {
    const player = await bootstrap(api, 'Camper');
    const attempt = await api.request('/v1/live-ops/documents', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('doc'), kind: 'seasonal_event', slug: 'x', title: 'X', body: PERSEID },
    });
    expect(attempt.status).toBe(401);
  });

  it('refuses an operator token with no account behind it', async () => {
    const attempt = await api.request('/v1/live-ops/documents', {
      method: 'POST',
      headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
      body: { idempotencyKey: key('doc'), kind: 'seasonal_event', slug: 'x', title: 'X', body: PERSEID },
    });
    expect(attempt.status).toBe(401);
  });

  it('refuses a wrong operator token of the same length', async () => {
    const player = await bootstrap(api, 'Camper');
    const attempt = await api.request('/v1/live-ops/documents', {
      method: 'POST',
      token: player.token,
      headers: { [OPS_TOKEN_HEADER]: 'ops-token-for-tests-onlZ' },
      body: { idempotencyKey: key('doc'), kind: 'seasonal_event', slug: 'x', title: 'X', body: PERSEID },
    });
    expect(attempt.status).toBe(401);
  });
});

describe('a deployment with no live-ops credential', () => {
  it('serves reads and refuses authoring, loudly and specifically', async () => {
    const bare = await startTestApi({});
    try {
      const player = await bootstrap(bare, 'Camper');
      const manifest = await bare.request('/v1/content/manifest');
      expect(manifest.status).toBe(200);
      expect(manifest.body.overlay).toBe(true);

      const status = await bare.request('/v1/live-ops/status', { token: player.token });
      expect(status.body.liveOps.status).toBe('not_configured');
      expect(status.body.liveOps.fallback).toBe('read_only');
      expect(status.body.liveOps.reason).toContain('LIVE_OPS_TOKEN');

      const attempt = await bare.request('/v1/live-ops/documents', {
        method: 'POST',
        token: player.token,
        headers: { [OPS_TOKEN_HEADER]: 'anything' },
        body: { idempotencyKey: key('doc'), kind: 'seasonal_event', slug: 'x', title: 'X', body: PERSEID },
      });
      expect(attempt.status).toBe(503);
      expect(attempt.body.error.code).toBe('service_not_configured');
      expect(attempt.body.error.message).toContain('LIVE_OPS_TOKEN');
    } finally {
      await bare.close();
    }
  });
});
