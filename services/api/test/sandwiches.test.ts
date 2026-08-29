import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, sandwichPayload, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function make(player: any, campsite: any, overrides: Record<string, unknown> = {}) {
  return api.request('/v1/sandwiches', {
    method: 'POST',
    token: player.token,
    body: sandwichPayload(campsite.id, campsite.machine.serialNumber, overrides),
  });
}

describe('recording a sandwich', () => {
  it('scores it on the server, mints a run id, and files it in the passport', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    const response = await make(player, campsite);
    expect(response.status).toBe(201);
    expect(response.body.accountId).toBe(player.accountId);
    expect(response.body.overallScore).toBeGreaterThan(0.85);
    expect(['rare', 'legendary']).toContain(response.body.rarity);
    expect(response.body.machineRun.runId).toMatch(/^run_/);
    expect(response.body.shareState).toBe('private');
    expect(response.body.consumedAt).toBeNull();

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.sandwichIds).toEqual([response.body.id]);
    expect(passport.body.stats.sandwichesMade).toBe(1);
    expect(passport.body.stats.machineRuns).toBe(1);
    expect(passport.body.stats.perfectRoasts).toBe(1);
  });

  it('ignores a client that tries to award itself a legendary', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const response = await make(player, campsite, {
      overallScore: 1,
      rarity: 'legendary',
      id: 'swh_i_made_this_up',
      accountId: 'acct_someone_else',
      roast: {
        ...sandwichPayload(campsite.id, campsite.machine.serialNumber).roast,
        grade: 'cremated',
        evenness: 0.1,
        dropped: true,
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.id).not.toBe('swh_i_made_this_up');
    expect(response.body.accountId).toBe(player.accountId);
    expect(response.body.rarity).not.toBe('legendary');
    expect(response.body.overallScore).toBeLessThan(0.7);
  });

  it('wears the machine and counts the cycle', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await make(player, campsite);
    await make(player, campsite);

    const machine = await api.request(`/v1/campsites/${campsite.id}/machine`, { token: player.token });
    expect(machine.body.cyclesRun).toBe(2);
    expect(machine.body.wear.press).toBeCloseTo(0.004, 6);
    expect(machine.body.lastRunAt).not.toBeNull();
  });

  it('gives the machine a quirk when a run goes sideways', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const base = sandwichPayload(campsite.id, campsite.machine.serialNumber);
    await make(player, campsite, {
      machineRun: { ...base.machineRun, anomalies: ['chill_overshoot'], outcome: 'partial' },
    });

    const machine = await api.request(`/v1/campsites/${campsite.id}/machine`, { token: player.token });
    expect(machine.body.quirks).toHaveLength(1);
    expect(machine.body.quirks[0].code).toBe('frost_whisper');
    expect(machine.body.quirks[0].severity).toBe('charming');
  });

  it('rejects a run from a different machine and a malformed roast', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    const wrongMachine = await make(player, campsite, {
      machineRun: {
        ...sandwichPayload(campsite.id, campsite.machine.serialNumber).machineRun,
        machineSerial: 'SM01-ZZZZ-ZZZZ',
      },
    });
    expect(wrongMachine.status).toBe(400);
    expect(wrongMachine.body.error.code).toBe('bad_request');

    const malformed = await make(player, campsite, {
      roast: { ...sandwichPayload(campsite.id, campsite.machine.serialNumber).roast, grade: 'incinerated' },
    });
    expect(malformed.status).toBe(422);
  });

  it('refuses to record a sandwich at a campsite you are not in', async () => {
    const owner = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const response = await make(stranger, campsite);
    expect(response.status).toBe(404);
  });
});

describe('sharing and eating', () => {
  it('keeps a sandwich private until it is shared', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const sandwich = (await make(player, campsite)).body;

    const denied = await api.request(`/v1/sandwiches/${sandwich.id}`, { token: stranger.token });
    expect(denied.status).toBe(403);

    const shared = await api.request(`/v1/sandwiches/${sandwich.id}`, {
      method: 'PATCH',
      token: player.token,
      body: { shareState: 'public', name: 'The Golden One' },
    });
    expect(shared.status).toBe(200);
    expect(shared.body.name).toBe('The Golden One');

    const allowed = await api.request(`/v1/sandwiches/${sandwich.id}`, { token: stranger.token });
    expect(allowed.status).toBe(200);
  });

  it('records eating it exactly once', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const sandwich = (await make(player, campsite)).body;

    const eaten = await api.request(`/v1/sandwiches/${sandwich.id}`, {
      method: 'PATCH',
      token: player.token,
      body: { consumed: true },
    });
    expect(eaten.body.consumedAt).not.toBeNull();

    api.clock.advance(60_000);
    const again = await api.request(`/v1/sandwiches/${sandwich.id}`, {
      method: 'PATCH',
      token: player.token,
      body: { consumed: true },
    });
    expect(again.body.consumedAt).toBe(eaten.body.consumedAt);

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.stats.sandwichesEaten).toBe(1);
  });

  it('refuses edits from someone else', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const sandwich = (await make(player, campsite)).body;

    const response = await api.request(`/v1/sandwiches/${sandwich.id}`, {
      method: 'PATCH',
      token: stranger.token,
      body: { name: 'Mine now' },
    });
    expect(response.status).toBe(403);
  });
});
