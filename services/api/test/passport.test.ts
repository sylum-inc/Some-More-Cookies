import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

describe('reading and writing your own passport', () => {
  it('starts with private defaults and full accessibility settings', async () => {
    const player = await bootstrap(api, 'Rowan');
    const response = await api.request('/v1/passport', { token: player.token });

    expect(response.status).toBe(200);
    expect(response.body.accountId).toBe(player.accountId);
    expect(response.body.revision).toBe(0);
    expect(response.body.settings.defaultCampsitePrivacy).toBe('private');
    expect(response.body.settings.showOnLeaderboards).toBe(false);
    expect(response.body.settings.accessibility).toMatchObject({
      reducedMotion: false,
      textScale: 1,
      captionsEnabled: true,
      colorVisionMode: 'none',
      aimAssist: 'off',
    });
    expect(response.body.stamps).toEqual([]);
    expect(response.body.sandwichIds).toEqual([]);
  });

  it('patches settings without clobbering the rest, and bumps the revision', async () => {
    const player = await bootstrap(api);
    const patched = await api.request('/v1/passport', {
      method: 'PATCH',
      token: player.token,
      body: {
        displayName: 'Rowan Ash',
        handle: 'rowan_ash',
        settings: { accessibility: { reducedMotion: true, textScale: 1.5, aimAssist: 'strong' } },
      },
    });

    expect(patched.status).toBe(200);
    expect(patched.body.displayName).toBe('Rowan Ash');
    expect(patched.body.handle).toBe('rowan_ash');
    expect(patched.body.revision).toBe(1);
    expect(patched.body.settings.accessibility.reducedMotion).toBe(true);
    expect(patched.body.settings.accessibility.textScale).toBe(1.5);
    // Untouched accessibility fields survive the patch.
    expect(patched.body.settings.accessibility.captionsEnabled).toBe(true);
    expect(patched.body.settings.defaultPhotoVisibility).toBe('private');
  });

  it('honours optimistic concurrency and rejects a stale write', async () => {
    const player = await bootstrap(api);
    await api.request('/v1/passport', { method: 'PATCH', token: player.token, body: { bio: 'one' } });
    const stale = await api.request('/v1/passport', {
      method: 'PATCH',
      token: player.token,
      body: { bio: 'two', expectedRevision: 0 },
    });
    expect(stale.status).toBe(412);
    expect(stale.body.error.code).toBe('precondition_failed');
    expect(stale.body.error.details.actualRevision).toBe(1);
  });

  it('rejects a taken handle and an invalid one', async () => {
    const first = await bootstrap(api);
    const second = await bootstrap(api);
    await api.request('/v1/passport', { method: 'PATCH', token: first.token, body: { handle: 'ember' } });

    const taken = await api.request('/v1/passport', { method: 'PATCH', token: second.token, body: { handle: 'ember' } });
    expect(taken.status).toBe(409);
    expect(taken.body.error.code).toBe('conflict');

    const invalid = await api.request('/v1/passport', { method: 'PATCH', token: second.token, body: { handle: 'NO' } });
    expect(invalid.status).toBe(422);
  });
});

describe('photos and notes', () => {
  it('registers a photo by storage key and never accepts bytes', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const photo = await api.request('/v1/passport/photos', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('photo'),
        storageKey: `campsites/${campsite.id}/photos/first.jpg`,
        contentType: 'image/jpeg',
        width: 1920,
        height: 1080,
        byteSize: 512_000,
        capturedAt: '2026-08-29T12:00:00.000Z',
        campsiteId: campsite.id,
        caption: 'the first one',
      },
    });

    expect(photo.status).toBe(201);
    expect(photo.body.ownerAccountId).toBe(player.accountId);
    expect(photo.body.visibility).toBe('private');
    expect(photo.body).not.toHaveProperty('data');

    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.photos).toHaveLength(1);
    expect(passport.body.stats.photosTaken).toBe(1);
  });

  it('refuses a traversal storage key and a photo on someone else\'s campsite', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    const campsite = await createCampsite(api, stranger);

    const traversal = await api.request('/v1/passport/photos', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('photo'),
        storageKey: '../../secrets/key.jpg',
        contentType: 'image/jpeg',
        width: 10,
        height: 10,
        byteSize: 10,
        capturedAt: '2026-08-29T12:00:00.000Z',
      },
    });
    expect(traversal.status).toBe(422);

    const foreign = await api.request('/v1/passport/photos', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('photo'),
        storageKey: 'campsites/x/photos/a.jpg',
        contentType: 'image/jpeg',
        width: 10,
        height: 10,
        byteSize: 10,
        capturedAt: '2026-08-29T12:00:00.000Z',
        campsiteId: campsite.id,
      },
    });
    expect(foreign.status).toBe(403);
  });

  it('adds and tears out notes, and cannot touch another player\'s note', async () => {
    const player = await bootstrap(api);
    const other = await bootstrap(api);
    const note = await api.request('/v1/passport/notes', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('note'), body: 'the fire hissed when it started to rain' },
    });
    expect(note.status).toBe(201);

    const foreignDelete = await api.request(`/v1/passport/notes/${note.body.id}`, {
      method: 'DELETE',
      token: other.token,
    });
    expect(foreignDelete.status).toBe(404);

    const deleted = await api.request(`/v1/passport/notes/${note.body.id}`, {
      method: 'DELETE',
      token: player.token,
    });
    expect(deleted.status).toBe(204);
    const passport = await api.request('/v1/passport', { token: player.token });
    expect(passport.body.notes).toEqual([]);
  });
});

describe('another player\'s passport', () => {
  it('is private by default', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    const response = await api.request(`/v1/passports/${stranger.accountId}`, { token: player.token });
    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('forbidden');
  });

  it('is visible when the owner opts into leaderboards, and only in the public projection', async () => {
    const player = await bootstrap(api);
    const shared = await bootstrap(api, 'Ember');
    await api.request('/v1/passport', {
      method: 'PATCH',
      token: shared.token,
      body: { settings: { showOnLeaderboards: true } },
    });
    await api.request('/v1/passport/notes', {
      method: 'POST',
      token: shared.token,
      body: { idempotencyKey: key('note'), body: 'private thoughts' },
    });

    const response = await api.request(`/v1/passports/${shared.accountId}`, { token: player.token });
    expect(response.status).toBe(200);
    expect(response.body.displayName).toBe('Ember');
    expect(response.body).not.toHaveProperty('notes');
    expect(response.body).not.toHaveProperty('photos');
    expect(response.body).not.toHaveProperty('settings');
    expect(response.body.stats).toEqual({ sandwichesMade: 0, perfectRoasts: 0, campfireMinutes: 0 });
  });

  it('is visible to someone who shares a campsite with you', async () => {
    const owner = await bootstrap(api, 'Owner');
    const guest = await bootstrap(api, 'Guest');
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    await api.request('/v1/campsites/join', {
      method: 'POST',
      token: guest.token,
      body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
    });

    const response = await api.request(`/v1/passports/${owner.accountId}`, { token: guest.token });
    expect(response.status).toBe(200);
    expect(response.body.displayName).toBe('Owner');
  });

  it('disappears entirely for someone the owner has blocked', async () => {
    const player = await bootstrap(api);
    const blocker = await bootstrap(api);
    await api.request('/v1/passport', {
      method: 'PATCH',
      token: blocker.token,
      body: { settings: { showOnLeaderboards: true } },
    });
    await api.request('/v1/moderation/blocks', {
      method: 'POST',
      token: blocker.token,
      body: { idempotencyKey: key('block'), blockedAccountId: player.accountId },
    });

    const response = await api.request(`/v1/passports/${blocker.accountId}`, { token: player.token });
    expect(response.status).toBe(404);
  });
});
