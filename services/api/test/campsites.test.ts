import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function mintInvite(owner: any, campsiteId: string, body: Record<string, unknown> = {}) {
  const response = await api.request(`/v1/campsites/${campsiteId}/invites`, {
    method: 'POST',
    token: owner.token,
    body: { idempotencyKey: key('inv'), ...body },
  });
  expect(response.status).toBe(201);
  return response.body;
}

describe('creating a campsite', () => {
  it('is private by default and comes with its own SM-01', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player, { name: 'Pine Hollow', environmentId: 'pine_hollow' });

    expect(campsite.privacy).toBe('private');
    expect(campsite.ownerAccountId).toBe(player.accountId);
    expect(campsite.campCode).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
    expect(campsite.machine.model).toBe('SM-01');
    expect(campsite.machine.serialNumber).toMatch(/^SM01-(?:19|20)\d{2}[A-Z]-\d{5}-[A-Z]$/);
    expect(campsite.machine.cyclesRun).toBe(0);
    expect(campsite.members).toHaveLength(1);
    expect(campsite.members[0].role).toBe('owner');

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.visitedCampsites).toHaveLength(1);
  });

  it('follows the passport default privacy when the request omits it', async () => {
    const player = await bootstrap(api);
    await api.request('/v1/passport', {
      method: 'PATCH',
      token: player.token,
      body: { settings: { defaultCampsitePrivacy: 'friends' } },
    });
    const response = await api.request('/v1/campsites', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('camp'), name: 'Friendly Fire' },
    });
    expect(response.body.privacy).toBe('friends');
  });
});

describe('privacy enforcement', () => {
  it('hides a private campsite from non-members entirely', async () => {
    const owner = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const read = await api.request(`/v1/campsites/${campsite.id}`, { token: stranger.token });
    expect(read.status).toBe(404);

    const machine = await api.request(`/v1/campsites/${campsite.id}/machine`, { token: stranger.token });
    expect(machine.status).toBe(404);

    const world = await api.request(`/v1/campsites/${campsite.id}/world`, { token: stranger.token });
    expect(world.status).toBe(404);
  });

  it('refuses a camp code join for a private campsite but allows it for a public one', async () => {
    const owner = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const blocked = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: campsite.campCode } },
    });
    expect(blocked.status).toBe(403);
    expect(blocked.body.error.message).toMatch(/private/i);

    await api.request(`/v1/campsites/${campsite.id}`, {
      method: 'PATCH',
      token: owner.token,
      body: { privacy: 'public' },
    });

    const allowed = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: campsite.campCode } },
    });
    expect(allowed.status).toBe(200);
    expect(allowed.body.role).toBe('guest');
  });

  it('lets only the owner change privacy, and only cohosts edit at all', async () => {
    const owner = await bootstrap(api);
    const guest = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const invite = await mintInvite(owner, campsite.id, { grantsRole: 'guest' });
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: guest.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.invite.token } },
    });

    const guestEdit = await api.request(`/v1/campsites/${campsite.id}`, {
      method: 'PATCH',
      token: guest.token,
      body: { name: 'Guest Rename' },
    });
    expect(guestEdit.status).toBe(403);

    const cohostInvite = await mintInvite(owner, campsite.id, { grantsRole: 'cohost' });
    const cohost = await bootstrap(api);
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: cohost.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: cohostInvite.invite.token } },
    });

    const cohostRename = await api.request(`/v1/campsites/${campsite.id}`, {
      method: 'PATCH',
      token: cohost.token,
      body: { name: 'Cohost Rename' },
    });
    expect(cohostRename.status).toBe(200);
    expect(cohostRename.body.name).toBe('Cohost Rename');

    const cohostPrivacy = await api.request(`/v1/campsites/${campsite.id}`, {
      method: 'PATCH',
      token: cohost.token,
      body: { privacy: 'public' },
    });
    expect(cohostPrivacy.status).toBe(403);
    expect(cohostPrivacy.body.error.message).toMatch(/owner/i);
  });
});

describe('joining', () => {
  it('joins by invite link, camp code and QR payload', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const linkInvite = await mintInvite(owner, campsite.id);
    const byLink = await bootstrap(api);
    const linkJoin = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: byLink.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: linkInvite.invite.token } },
    });
    expect(linkJoin.status).toBe(200);
    expect(linkJoin.body.campsite.members).toHaveLength(2);

    const codeInvite = await mintInvite(owner, campsite.id);
    const byCode = await bootstrap(api);
    const codeJoin = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: byCode.token,
      body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: codeInvite.invite.campCode } },
    });
    expect(codeJoin.status).toBe(200);

    const qrInvite = await mintInvite(owner, campsite.id);
    const byQr = await bootstrap(api);
    const qrJoin = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: byQr.token,
      body: { idempotencyKey: key('join'), join: { method: 'qr', payload: qrInvite.qrPayload } },
    });
    expect(qrJoin.status).toBe(200);
    expect(qrJoin.body.campsite.members).toHaveLength(4);
  });

  it('rejects an expired invite, a used-up invite and an unknown code', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const shortLived = await mintInvite(owner, campsite.id, { ttlMinutes: 5 });
    api.clock.advance(6 * 60 * 1000);
    const expired = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: (await bootstrap(api)).token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: shortLived.invite.token } },
    });
    expect(expired.status).toBe(403);
    expect(expired.body.error.message).toMatch(/expired/i);

    const singleUse = await mintInvite(owner, campsite.id, { maxUses: 1 });
    const firstGuest = await bootstrap(api);
    const secondGuest = await bootstrap(api);
    const used = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: firstGuest.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: singleUse.invite.token } },
    });
    expect(used.status).toBe(200);
    const exhausted = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: secondGuest.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: singleUse.invite.token } },
    });
    expect(exhausted.status).toBe(403);
    expect(exhausted.body.error.message).toMatch(/used up/i);

    const unknown = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: secondGuest.token,
      body: { idempotencyKey: key('join'), join: { method: 'camp_code', code: 'ZZZZZZ' } },
    });
    expect(unknown.status).toBe(404);
  });

  it('lists only the campsites you belong to', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    await createCampsite(api, player, { name: 'Mine' });
    await createCampsite(api, stranger, { name: 'Theirs' });

    const list = await api.request('/v1/campsites', { token: player.token });
    expect(list.body.items).toHaveLength(1);
    expect(list.body.items[0].name).toBe('Mine');
    expect(list.body.items[0].memberCount).toBe(1);
  });
});

describe('the SM-01', () => {
  it('records maintenance, reduces wear and keeps the history', async () => {
    const owner = await bootstrap(api);
    const campsite = await createCampsite(api, owner);

    const serviced = await api.request(`/v1/campsites/${campsite.id}/machine/maintenance`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('mnt'), kind: 'descale', component: 'chiller', notes: 'crunchy' },
    });

    expect(serviced.status).toBe(201);
    expect(serviced.body.maintenanceHistory).toHaveLength(1);
    expect(serviced.body.maintenanceHistory[0].kind).toBe('descale');
    expect(serviced.body.maintenanceHistory[0].performedBy).toBe(owner.accountId);
    expect(serviced.body.lastServicedAt).not.toBeNull();

    const machine = await api.request(`/v1/campsites/${campsite.id}/machine`, { token: owner.token });
    expect(machine.body.wear.chiller).toBe(0);
    expect(machine.body.serialNumber).toBe(campsite.machine.serialNumber);
  });

  it('refuses maintenance from a non-member', async () => {
    const owner = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, owner);
    const response = await api.request(`/v1/campsites/${campsite.id}/machine/maintenance`, {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('mnt'), kind: 'clean' },
    });
    expect(response.status).toBe(404);
  });
});
