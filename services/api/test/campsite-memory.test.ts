/**
 * Campsite memory, over the wire and through the merge.
 *
 * Two things this suite is really about. First, that a campsite which
 * remembers you survives the device it was learned on — which means the merge
 * rules have to be right, not merely present. Second, that §6.4 holds
 * structurally: no significance score crosses the wire, in either direction,
 * and the assertion is on the serialised bytes rather than on a shape.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CampsiteMemorySnapshotSchema,
  SyncedTraceSchema,
  TRACE_LIFETIME_SECONDS,
  type CampsiteMemorySnapshot,
} from '@somemore/protocol';
import {
  absorbCampsiteMemory,
  emptyMemory,
  mergeCampsiteMemory,
  totalVisits,
} from '../src/domain/memoryMerge.js';
import { bootstrap, createCampsite, key, startTestApi, TEST_START, type Player, type TestHarness } from './harness.js';

/** An unsigned Google-shaped id token; the service reads `sub` and says so. */
function googleIdToken(subject: string): string {
  const part = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  return `${part({ alg: 'RS256' })}.${part({ sub: subject })}.signature-not-verified`;
}

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

const DAY = 86_400_000;

function snapshot(overrides: Partial<CampsiteMemorySnapshot> = {}): CampsiteMemorySnapshot {
  return CampsiteMemorySnapshotSchema.parse({
    deviceId: 'device-phone',
    environmentId: 'pine_hollow',
    deviceVisits: 1,
    lastVisitAt: TEST_START,
    secrets: [],
    residents: {},
    traces: [],
    sightings: [],
    constellations: [],
    ...overrides,
  });
}

function trace(id: string, disposition: 'keep' | 'passport' | 'landmark', createdAt = TEST_START) {
  return SyncedTraceSchema.parse({ id, kind: 'discovery', createdAt, disposition });
}

async function sync(player: Player, campsiteId: string, body: CampsiteMemorySnapshot) {
  return api.request(`/v1/campsites/${campsiteId}/memory`, {
    method: 'PUT',
    token: player.token,
    body,
  });
}

/* -------------------------------------------------------------------------- */
/* Over the wire                                                               */
/* -------------------------------------------------------------------------- */

describe('a campsite that remembers you', () => {
  it('answers a campsite it has never heard of with nothing, not an error', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    expect(read.status).toBe(200);
    expect(read.body.visits).toBe(0);
    expect(read.body.traces).toEqual([]);
  });

  it('stores what a device pushed and hands it back', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    const pushed = await sync(
      player,
      campsite.id,
      snapshot({
        deviceVisits: 3,
        residents: { 'fox-1': 2 },
        secrets: [{ secretId: 'the_tin', at: 412, visitIndex: 2, oneTime: true, evidence: 'an open tin' }],
        traces: [trace('secret:the_tin', 'passport')],
        sightings: ['A red fox at the edge of the light.'],
        constellations: ['ursa_major'],
      }),
    );
    expect(pushed.status).toBe(200);
    expect(pushed.body.visits).toBe(3);
    expect(pushed.body.residents['fox-1']).toBe(2);

    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    expect(read.body.visits).toBe(3);
    expect(read.body.secrets).toHaveLength(1);
    expect(read.body.traces).toHaveLength(1);
    expect(read.body.sightings).toEqual(['A red fox at the edge of the light.']);
    expect(read.body.constellations).toEqual(['ursa_major']);
  });

  it('reaches a second device: the same account, a different phone', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await sync(
      player,
      campsite.id,
      snapshot({ deviceId: 'device-phone', deviceVisits: 4, residents: { 'fox-1': 3 } }),
    );

    // A second device with nothing of its own. It reports its own zero nights
    // and receives everything the campsite already knows.
    const onTablet = await sync(
      player,
      campsite.id,
      snapshot({ deviceId: 'device-tablet', deviceVisits: 0 }),
    );
    expect(onTablet.status).toBe(200);
    expect(onTablet.body.visits).toBe(4);
    expect(onTablet.body.residents['fox-1']).toBe(3);
  });

  it('lists every campsite that remembers you, which is what a lost phone restores from', async () => {
    const player = await bootstrap(api);
    const one = await createCampsite(api, player, { name: 'Pine Hollow' });
    const two = await createCampsite(api, player, { name: 'Lantern Mesa' });
    await sync(player, one.id, snapshot({ deviceVisits: 2 }));
    await sync(player, two.id, snapshot({ deviceVisits: 5, environmentId: 'lantern_mesa' }));

    const all = await api.request('/v1/passport/campsites', { token: player.token });
    expect(all.status).toBe(200);
    expect(all.body.items).toHaveLength(2);
    const byId = new Map(all.body.items.map((m: { campsiteId: string; visits: number }) => [m.campsiteId, m.visits]));
    expect(byId.get(one.id)).toBe(2);
    expect(byId.get(two.id)).toBe(5);
  });

  it('is one memory per player, not one per campsite', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    const friend = await bootstrap(api);
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: friend.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
    });

    await sync(owner, campsite.id, snapshot({ deviceVisits: 9 }));
    await sync(friend, campsite.id, snapshot({ deviceId: 'device-friend', deviceVisits: 1 }));

    const asOwner = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: owner.token });
    const asFriend = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: friend.token });
    // The place is shared; what it remembers about each of you is not.
    expect(asOwner.body.visits).toBe(9);
    expect(asFriend.body.visits).toBe(1);
  });

  it('refuses a stranger', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const stranger = await bootstrap(api);
    const pushed = await sync(stranger, campsite.id, snapshot());
    expect([403, 404]).toContain(pushed.status);
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: stranger.token });
    expect([403, 404]).toContain(read.status);
  });

  it('carries campsite memory through an account merge, because a merge is never a reset', async () => {
    // Two anonymous accounts — the same person on two phones, each of which
    // bootstrapped its own account before either was linked to anything.
    const first = await bootstrap(api);
    const campsite = await createCampsite(api, first);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: first.token,
      body: { idempotencyKey: key('inv') },
    });
    const second = await bootstrap(api);
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: second.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
    });

    await sync(first, campsite.id, snapshot({ deviceId: 'phone', deviceVisits: 6, residents: { 'fox-1': 4 } }));
    await sync(second, campsite.id, snapshot({ deviceId: 'tablet', deviceVisits: 2, residents: { 'fox-1': 1 } }));

    // The first phone signs in with Google.
    const linkedFirst = await api.request('/v1/auth/link', {
      method: 'POST',
      token: first.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'google', idToken: googleIdToken('the-same-person'), nonce: 'nonce-abcdefgh' },
      },
    });
    expect(linkedFirst.body.status).toBe('linked');

    // Then the second one does, with the same Google account. That is a merge,
    // and the campsite that remembered the second phone must survive it.
    const merged = await api.request('/v1/auth/link', {
      method: 'POST',
      token: second.token,
      body: {
        idempotencyKey: key('link'),
        mergePolicy: 'keep_current',
        credential: { provider: 'google', idToken: googleIdToken('the-same-person'), nonce: 'nonce-abcdefgh' },
      },
    });
    expect(merged.body.status).toBe('merged');

    const after = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: second.token });
    // Six nights on the phone plus two on the tablet, counted once each.
    expect(after.body.visits).toBe(8);
    expect(after.body.residents['fox-1']).toBe(4);
  });
});

/* -------------------------------------------------------------------------- */
/* Merging two offline devices, over the wire                                  */
/* -------------------------------------------------------------------------- */

describe('two devices, both offline, both visiting', () => {
  it('loses nothing and double-counts nothing', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    // The phone has been here five times and syncs.
    let state = await sync(player, campsite.id, snapshot({ deviceId: 'phone', deviceVisits: 5 }));
    expect(state.body.visits).toBe(5);

    // The tablet arrives for the first time, offline until now.
    state = await sync(player, campsite.id, snapshot({ deviceId: 'tablet', deviceVisits: 1 }));
    expect(state.body.visits).toBe(6);

    // Both then camp twice more with no signal, and both sync.
    state = await sync(player, campsite.id, snapshot({ deviceId: 'phone', deviceVisits: 7 }));
    state = await sync(player, campsite.id, snapshot({ deviceId: 'tablet', deviceVisits: 3 }));
    expect(state.body.visits).toBe(10);

    // And a re-sync of an unchanged device adds nothing at all. This is the
    // failure mode that summing totals would have: the campsite would grow
    // every time the client called, which it does on a timer.
    state = await sync(player, campsite.id, snapshot({ deviceId: 'phone', deviceVisits: 7 }));
    state = await sync(player, campsite.id, snapshot({ deviceId: 'tablet', deviceVisits: 3 }));
    expect(state.body.visits).toBe(10);
  });

  it('unions what each device noticed', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    await sync(
      player,
      campsite.id,
      snapshot({
        deviceId: 'phone',
        deviceVisits: 2,
        secrets: [{ secretId: 'the_tin', at: 100, visitIndex: 1, oneTime: true, evidence: 'an open tin' }],
        traces: [trace('secret:the_tin', 'keep')],
        constellations: ['ursa_major'],
        sightings: ['A red fox.'],
      }),
    );
    const merged = await sync(
      player,
      campsite.id,
      snapshot({
        deviceId: 'tablet',
        deviceVisits: 2,
        secrets: [{ secretId: 'the_radio', at: 200, visitIndex: 1, oneTime: false, evidence: null }],
        traces: [trace('secret:the_radio', 'passport')],
        constellations: ['orion'],
        sightings: ['A barred owl, twice.'],
      }),
    );

    expect(merged.body.secrets.map((s: { secretId: string }) => s.secretId).sort()).toEqual([
      'the_radio',
      'the_tin',
    ]);
    expect(merged.body.traces.map((t: { id: string }) => t.id).sort()).toEqual([
      'secret:the_radio',
      'secret:the_tin',
    ]);
    expect(merged.body.constellations.sort()).toEqual(['orion', 'ursa_major']);
    expect(merged.body.sightings).toHaveLength(2);
  });

  it('keeps the stronger disposition when both devices know the same trace', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await sync(player, campsite.id, snapshot({ deviceId: 'phone', traces: [trace('skip:3', 'keep')] }));
    const merged = await sync(
      player,
      campsite.id,
      snapshot({ deviceId: 'tablet', traces: [trace('skip:3', 'landmark')] }),
    );
    expect(merged.body.traces[0].disposition).toBe('landmark');

    // And it does not go back down when the weaker device syncs again.
    const again = await sync(
      player,
      campsite.id,
      snapshot({ deviceId: 'phone', traces: [trace('skip:3', 'keep')] }),
    );
    expect(again.body.traces[0].disposition).toBe('landmark');
  });

  it('sweeps a trace whose lifetime has run out, on the server’s clock', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await sync(
      player,
      campsite.id,
      snapshot({ traces: [trace('a', 'keep'), trace('b', 'passport'), trace('c', 'landmark')] }),
    );

    // Fifteen days: `keep` is fourteen, `passport` is ninety, a landmark never.
    api.clock.advance(15 * DAY);
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    expect(read.body.traces.map((t: { id: string }) => t.id).sort()).toEqual(['b', 'c']);
    expect(read.body.expiredTraceIds).toEqual(['a']);

  });

  it('lets a landmark outlive everything else, ninety days on', async () => {
    // A year of simulated time needs a token that lasts a year; the default is
    // thirty days, and an expired token is not what this case is about.
    const longLived = await startTestApi({ AUTH_TOKEN_TTL_SECONDS: '31536000' });
    try {
      const player = await bootstrap(longLived);
      const campsite = await createCampsite(longLived, player);
      await longLived.request(`/v1/campsites/${campsite.id}/memory`, {
        method: 'PUT',
        token: player.token,
        body: snapshot({ traces: [trace('b', 'passport'), trace('c', 'landmark')] }),
      });
      longLived.clock.advance(120 * DAY);
      const later = await longLived.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
      expect(later.body.traces.map((t: { id: string }) => t.id)).toEqual(['c']);
    } finally {
      await longLived.close();
    }
  });

  it('will not let a device with a fast clock mint an immortal trace', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    // A phone set a year forward.
    const future = new Date(api.clock.now().getTime() + 365 * DAY).toISOString();
    const pushed = await sync(player, campsite.id, snapshot({ traces: [trace('skewed', 'keep', future)] }));
    // Clamped to the server's now, so it fades on the same schedule as an
    // honest one rather than a year later.
    expect(Date.parse(pushed.body.traces[0].createdAt)).toBeLessThanOrEqual(api.clock.now().getTime());

    api.clock.advance(15 * DAY);
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    expect(read.body.traces).toHaveLength(0);
  });

  it('tells the client what the server’s clock says, so a skewed device can re-base', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const pushed = await sync(player, campsite.id, snapshot());
    expect(pushed.body.observedAt).toBe(new Date(api.clock.now()).toISOString());
  });
});

/* -------------------------------------------------------------------------- */
/* §6.4: the score does not exist out here                                     */
/* -------------------------------------------------------------------------- */

describe('the significance score never crosses the wire', () => {
  it('refuses a snapshot that tries to smuggle one, rather than stripping it', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);

    const smuggled = await api.request(`/v1/campsites/${campsite.id}/memory`, {
      method: 'PUT',
      token: player.token,
      rawBody: JSON.stringify({
        ...snapshot(),
        traces: [
          {
            id: 'secret:the_tin',
            kind: 'discovery',
            createdAt: TEST_START,
            disposition: 'keep',
            // Neither the score nor the evidence it is computed from is a
            // field here, and `.strict()` makes that a refusal rather than a
            // silent strip — a stripped field is a field somebody will assume
            // arrived.
            score: 0.87,
          },
        ],
      }),
    });
    expect(smuggled.status).toBe(422);
    expect(smuggled.body.error.code).toBe('validation_failed');
  });

  it('refuses a `fade` disposition, because a faded trace is not a thing to carry', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const faded = await api.request(`/v1/campsites/${campsite.id}/memory`, {
      method: 'PUT',
      token: player.token,
      rawBody: JSON.stringify({
        ...snapshot(),
        traces: [{ id: 'x', kind: 'photo', createdAt: TEST_START, disposition: 'fade' }],
      }),
    });
    expect(faded.status).toBe(422);
  });

  it('has nothing score-shaped in any response body, on the bytes', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const bodies: string[] = [];

    const push = await sync(
      player,
      campsite.id,
      snapshot({
        deviceVisits: 4,
        traces: [trace('a', 'keep'), trace('b', 'landmark')],
        secrets: [{ secretId: 'the_tin', at: 12, visitIndex: 1, oneTime: true, evidence: 'a tin' }],
      }),
    );
    bodies.push(JSON.stringify(push.body));
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    bodies.push(JSON.stringify(read.body));
    const listed = await api.request('/v1/passport/campsites', { token: player.token });
    bodies.push(JSON.stringify(listed.body));

    const wire = bodies.join('\n');
    for (const forbidden of [
      '"score"',
      '"significance"',
      '"weight"',
      '"rarity"',
      '"dwellSeconds"',
      '"interactionCount"',
      '"photographed"',
      '"explicitlyPreserved"',
      '"lifetimeSeconds"',
      '"payload"',
      '"evidence":{',
    ]) {
      expect(wire).not.toContain(forbidden);
    }
    // And a trace on the wire has exactly four keys, so there is no room.
    for (const body of [push.body, read.body]) {
      for (const t of body.traces) expect(Object.keys(t).sort()).toEqual(['createdAt', 'disposition', 'id', 'kind']);
    }
  });

  it('never reports the per-device breakdown, only the total', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await sync(player, campsite.id, snapshot({ deviceId: 'phone-abc', deviceVisits: 2 }));
    const read = await api.request(`/v1/campsites/${campsite.id}/memory`, { token: player.token });
    const wire = JSON.stringify(read.body);
    // How many phones somebody camps from is not a campsite page's business.
    expect(wire).not.toContain('deviceVisits');
    expect(wire).not.toContain('phone-abc');
    expect(read.body.visits).toBe(2);
  });
});

/* -------------------------------------------------------------------------- */
/* The merge rules, as arithmetic                                              */
/* -------------------------------------------------------------------------- */

describe('the merge rules', () => {
  const NOW = Date.parse(TEST_START);
  const base = () =>
    emptyMemory({ campsiteId: 'cmp_1', accountId: 'acct_1', environmentId: 'pine_hollow', now: TEST_START });

  it('sums per-device counters and never lets one go backwards', () => {
    let memory = base();
    memory = mergeCampsiteMemory(memory, snapshot({ deviceId: 'a', deviceVisits: 3 }), NOW).merged;
    memory = mergeCampsiteMemory(memory, snapshot({ deviceId: 'b', deviceVisits: 2 }), NOW).merged;
    expect(totalVisits(memory.deviceVisits)).toBe(5);

    // A retried sync carrying a stale counter — the client persists its ledger
    // before it knows the request landed — must not undo a night.
    memory = mergeCampsiteMemory(memory, snapshot({ deviceId: 'a', deviceVisits: 1 }), NOW).merged;
    expect(totalVisits(memory.deviceVisits)).toBe(5);
  });

  it('is idempotent: merging the same snapshot twice changes nothing but the revision', () => {
    const one = snapshot({
      deviceId: 'a',
      deviceVisits: 2,
      residents: { 'fox-1': 2 },
      traces: [trace('t', 'keep')],
      secrets: [{ secretId: 's', at: 1, visitIndex: 1, oneTime: false, evidence: null }],
      sightings: ['x'],
      constellations: ['orion'],
    });
    const first = mergeCampsiteMemory(base(), one, NOW).merged;
    const second = mergeCampsiteMemory(first, one, NOW).merged;
    expect({ ...second, revision: 0 }).toEqual({ ...first, revision: 0 });
  });

  it('is order-independent: two devices merge to the same place either way', () => {
    const a = snapshot({
      deviceId: 'a',
      deviceVisits: 2,
      traces: [trace('t1', 'keep'), trace('shared', 'keep')],
      secrets: [{ secretId: 's1', at: 5, visitIndex: 2, oneTime: false, evidence: null }],
      constellations: ['orion'],
    });
    const b = snapshot({
      deviceId: 'b',
      deviceVisits: 3,
      traces: [trace('t2', 'passport'), trace('shared', 'landmark')],
      secrets: [{ secretId: 's1', at: 5, visitIndex: 1, oneTime: false, evidence: 'earlier' }],
      constellations: ['ursa_major'],
    });
    const ab = mergeCampsiteMemory(mergeCampsiteMemory(base(), a, NOW).merged, b, NOW).merged;
    const ba = mergeCampsiteMemory(mergeCampsiteMemory(base(), b, NOW).merged, a, NOW).merged;

    expect(totalVisits(ab.deviceVisits)).toBe(totalVisits(ba.deviceVisits));
    expect(ab.traces).toEqual(ba.traces);
    expect(ab.secrets).toEqual(ba.secrets);
    // The earliest record of a secret is the one that is kept, whichever
    // device happened to arrive first.
    expect(ab.secrets[0]?.visitIndex).toBe(1);
    expect(new Set(ab.constellations)).toEqual(new Set(ba.constellations));
  });

  it('takes the max of an animal’s visits, clamped to the nights there have been', () => {
    let memory = base();
    memory = mergeCampsiteMemory(
      memory,
      snapshot({ deviceId: 'a', deviceVisits: 3, residents: { 'fox-1': 3 } }),
      NOW,
    ).merged;
    memory = mergeCampsiteMemory(
      memory,
      snapshot({ deviceId: 'b', deviceVisits: 2, residents: { 'fox-1': 2 } }),
      NOW,
    ).merged;
    // Max, not sum: the fox turned up on three of your five nights as far as
    // any one device could tell, and five would be a fox on more nights than
    // there have been.
    expect(memory.residents['fox-1']).toBe(3);

    // And a device that reports more sightings than there are nights is
    // clamped rather than believed.
    memory = mergeCampsiteMemory(
      memory,
      snapshot({ deviceId: 'c', deviceVisits: 0, residents: { 'fox-1': 900 } }),
      NOW,
    ).merged;
    expect(memory.residents['fox-1']).toBe(totalVisits(memory.deviceVisits));
  });

  it('derives a trace lifetime from its disposition and nothing else', () => {
    expect(TRACE_LIFETIME_SECONDS.keep).toBe(14 * 86_400);
    expect(TRACE_LIFETIME_SECONDS.passport).toBe(90 * 86_400);
    // A landmark does not fade, and `null` rather than `Infinity` because
    // `JSON.stringify(Infinity)` is `null` anyway and a lie in a type is worse
    // than an absence.
    expect(TRACE_LIFETIME_SECONDS.landmark).toBeNull();
  });

  it('folds one account’s memory into another without summing a device twice', () => {
    const mine = mergeCampsiteMemory(
      base(),
      snapshot({ deviceId: 'phone', deviceVisits: 4, traces: [trace('t', 'keep')] }),
      NOW,
    ).merged;
    const theirs = mergeCampsiteMemory(
      emptyMemory({ campsiteId: 'cmp_1', accountId: 'acct_2', environmentId: 'pine_hollow', now: TEST_START }),
      // The same physical device, previously bootstrapped as a different
      // anonymous account. Its nights are its nights, counted once.
      snapshot({ deviceId: 'phone', deviceVisits: 4, traces: [trace('t', 'landmark')] }),
      NOW,
    ).merged;

    const absorbed = absorbCampsiteMemory(mine, theirs, NOW);
    expect(totalVisits(absorbed.deviceVisits)).toBe(4);
    expect(absorbed.traces[0]?.disposition).toBe('landmark');
  });
});
