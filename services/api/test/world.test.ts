import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function joinAs(campsiteId: string, owner: any, role: 'cohost' | 'guest' = 'guest') {
  const invite = await api.request(`/v1/campsites/${campsiteId}/invites`, {
    method: 'POST',
    token: owner.token,
    body: { idempotencyKey: key('inv'), grantsRole: role },
  });
  const player = await bootstrap(api);
  const joined = await api.request('/v1/campsites/join', {
    method: 'POST',
    token: player.token,
    body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
  });
  expect(joined.status).toBe(200);
  return player;
}

function trace(overrides: Record<string, unknown> = {}) {
  return {
    idempotencyKey: key('trace'),
    kind: 'scorch',
    position: { x: 1.5, y: 0, z: -2 },
    intensity: 1,
    decayRatePerHour: 0.1,
    ...overrides,
  };
}

describe('world traces', () => {
  it('records a trace and reads it back with decay applied', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const created = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace(),
    });
    expect(created.status).toBe(201);
    expect(created.body.witnessAccountIds).toEqual([owner.accountId]);
    expect(created.body.promotedLandmarkId).toBeNull();

    const fresh = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(fresh.body.traces).toHaveLength(1);
    expect(fresh.body.traces[0].currentIntensity).toBe(1);

    api.clock.advance(10 * 3_600_000);
    const later = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(later.body.traces[0].currentIntensity).toBeCloseTo(Math.exp(-1), 4);
    expect(later.body.sweptTraceIds).toEqual([]);
  });

  it('sweeps a trace once it has faded past the threshold', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const created = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace({ kind: 'ash', decayRatePerHour: 2 }),
    });

    api.clock.advance(6 * 3_600_000);
    const swept = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(swept.body.traces).toEqual([]);
    expect(swept.body.sweptTraceIds).toEqual([created.body.id]);

    const again = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(again.body.sweptTraceIds).toEqual([]);
  });

  it('refuses traces from non-members', async () => {
    const owner = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const response = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: stranger.token,
      body: trace(),
    });
    expect(response.status).toBe(404);
  });
});

describe('landmark promotion', () => {
  it('requires a quorum of distinct witnesses before a trace becomes a landmark', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const created = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace({ kind: 'stone_ring', decayRatePerHour: 0.01 }),
    });

    const tooSoon = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/landmark`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('lmk'), name: 'The Ash Ring' },
    });
    expect(tooSoon.status).toBe(412);
    expect(tooSoon.body.error.details.unmet.join(' ')).toMatch(/witnesses 1 < 2/);

    const friend = await joinAs(campsite.id, owner, 'guest');
    const witnessed = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/witness`, {
      method: 'POST',
      token: friend.token,
    });
    expect(witnessed.status).toBe(200);
    expect(witnessed.body.witnessAccountIds).toHaveLength(2);

    const promoted = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/landmark`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('lmk'), name: 'The Ash Ring', description: 'Where it started.' },
    });
    expect(promoted.status).toBe(201);
    expect(promoted.body.name).toBe('The Ash Ring');
    expect(promoted.body.permanence).toBe('persistent');
    expect(promoted.body.citations).toBe(2);

    const world = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(world.body.landmarks).toHaveLength(1);
    expect(world.body.traces[0].promotedLandmarkId).toBe(promoted.body.id);

    const passport = await api.request('/v1/passport', { token: owner.token });
    expect(passport.body.discoveries.some((d: any) => d.kind === 'landmark')).toBe(true);
  });

  it('keeps a promoted landmark alive forever while unpromoted traces fade', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const keeper = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace({ kind: 'carving', decayRatePerHour: 1 }),
    });
    const doomed = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace({ kind: 'ash', decayRatePerHour: 1 }),
    });

    const friend = await joinAs(campsite.id, owner);
    await api.request(`/v1/campsites/${campsite.id}/traces/${keeper.body.id}/witness`, {
      method: 'POST',
      token: friend.token,
    });
    const promoted = await api.request(`/v1/campsites/${campsite.id}/traces/${keeper.body.id}/landmark`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('lmk'), name: 'The Carving' },
    });
    expect(promoted.status).toBe(201);

    api.clock.advance(5 * 24 * 3_600_000);
    const world = await api.request(`/v1/campsites/${campsite.id}/world`, { token: owner.token });
    expect(world.body.sweptTraceIds).toContain(doomed.body.id);
    expect(world.body.traces).toHaveLength(1);
    expect(world.body.traces[0].id).toBe(keeper.body.id);
    expect(world.body.landmarks).toHaveLength(1);
  });

  it('only lets cohosts and above promote, and refuses a double promotion', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const created = await api.request(`/v1/campsites/${campsite.id}/traces`, {
      method: 'POST',
      token: owner.token,
      body: trace({ decayRatePerHour: 0 }),
    });
    const guest = await joinAs(campsite.id, owner, 'guest');
    await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/witness`, {
      method: 'POST',
      token: guest.token,
    });

    const byGuest = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/landmark`, {
      method: 'POST',
      token: guest.token,
      body: { idempotencyKey: key('lmk'), name: 'Guest Landmark' },
    });
    expect(byGuest.status).toBe(403);

    const first = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/landmark`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('lmk'), name: 'Owner Landmark' },
    });
    expect(first.status).toBe(201);

    const second = await api.request(`/v1/campsites/${campsite.id}/traces/${created.body.id}/landmark`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('lmk'), name: 'Again' },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('conflict');
  });
});
