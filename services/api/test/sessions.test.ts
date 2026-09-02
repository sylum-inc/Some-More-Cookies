import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function fireside() {
  const owner = await bootstrap(api, 'Host');
  const campsite = await createCampsite(api, owner);
  const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
    method: 'POST',
    token: owner.token,
    body: { idempotencyKey: key('inv'), grantsRole: 'guest' },
  });
  const guest = await bootstrap(api, 'Guest');
  await api.request('/v1/campsites/join', {
    method: 'POST',
    token: guest.token,
    body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.body.invite.token } },
  });
  const session = await api.request(`/v1/campsites/${campsite.id}/sessions`, {
    method: 'POST',
    token: owner.token,
    body: { idempotencyKey: key('ses') },
  });
  expect(session.status).toBe(201);
  return { owner, guest, campsite, session: session.body };
}

describe('sessions', () => {
  it('opens one live session per campsite', async () => {
    const { owner, campsite, session } = await fireside();
    expect(session.state).toBe('lobby');
    expect(session.hostAccountId).toBe(owner.accountId);

    const second = await api.request(`/v1/campsites/${campsite.id}/sessions`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('ses') },
    });
    expect(second.status).toBe(409);
    expect(second.body.error.details.sessionId).toBe(session.id);
  });

  it('tracks presence through join, heartbeat and leave', async () => {
    const { owner, guest, session } = await fireside();

    const hostJoin = await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: owner.token });
    expect(hostJoin.status).toBe(200);
    expect(hostJoin.body.state).toBe('active');

    const guestJoin = await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: guest.token });
    expect(guestJoin.body.presence).toHaveLength(2);
    expect(guestJoin.body.presence.map((p: any) => p.role).sort()).toEqual(['guest', 'owner']);

    const heartbeat = await api.request(`/v1/sessions/${session.id}/presence`, {
      method: 'POST',
      token: guest.token,
      body: { connection: 'connected', activity: 'roasting', position: { x: 1, y: 0, z: 2 }, micMuted: false },
    });
    expect(heartbeat.status).toBe(200);
    expect(heartbeat.body.activity).toBe('roasting');
    expect(heartbeat.body.position).toEqual({ x: 1, y: 0, z: 2 });

    const left = await api.request(`/v1/sessions/${session.id}/leave`, { method: 'POST', token: guest.token });
    expect(left.body.presence.find((p: any) => p.accountId === guest.accountId).connection).toBe('disconnected');
  });

  it('hides sessions at campsites you do not belong to', async () => {
    const { session } = await fireside();
    const stranger = await bootstrap(api);
    const response = await api.request(`/v1/sessions/${session.id}`, { token: stranger.token });
    expect(response.status).toBe(404);
  });

  it('enforces the session lifecycle', async () => {
    const { owner, session } = await fireside();
    const illegal = await api.request(`/v1/sessions/${session.id}/state`, {
      method: 'POST',
      token: owner.token,
      body: { to: 'ending' },
    });
    expect(illegal.status).toBe(409);
    expect(illegal.body.error.code).toBe('illegal_state_transition');

    await api.request(`/v1/sessions/${session.id}/state`, { method: 'POST', token: owner.token, body: { to: 'active' } });
    const ending = await api.request(`/v1/sessions/${session.id}/state`, {
      method: 'POST',
      token: owner.token,
      body: { to: 'ending' },
    });
    expect(ending.status).toBe(200);
    const ended = await api.request(`/v1/sessions/${session.id}/state`, {
      method: 'POST',
      token: owner.token,
      body: { to: 'ended' },
    });
    expect(ended.body.state).toBe('ended');
    expect(ended.body.endedAt).not.toBeNull();
  });
});

describe('shared-object authority', () => {
  it('grants, hands off and fences with a sequence number', async () => {
    const { owner, guest, session } = await fireside();
    await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: owner.token });
    await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: guest.token });

    const grab = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: owner.token,
      body: {
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        toAccountId: owner.accountId,
        reason: 'grab',
        expectedSequence: 0,
      },
    });
    expect(grab.status).toBe(200);
    expect(grab.body.status).toBe('granted');
    expect(grab.body.record.holderAccountId).toBe(owner.accountId);
    expect(grab.body.record.sequence).toBe(1);
    expect(grab.body.record.expiresAt).not.toBeNull();

    // A stale fencing token loses, even from the rightful holder.
    const stale = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: owner.token,
      body: {
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        toAccountId: guest.accountId,
        reason: 'give',
        expectedSequence: 0,
      },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.status).toBe('denied');
    expect(stale.body.reason).toBe('sequence_stale');
    expect(stale.body.current.holderAccountId).toBe(owner.accountId);

    // Someone else cannot snatch it.
    const snatch = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: guest.token,
      body: {
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        toAccountId: guest.accountId,
        reason: 'grab',
        expectedSequence: 1,
      },
    });
    expect(snatch.status).toBe(409);
    expect(snatch.body.reason).toBe('not_holder');

    // The holder can hand it over.
    const handoff = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: owner.token,
      body: {
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        toAccountId: guest.accountId,
        reason: 'give',
        expectedSequence: 1,
      },
    });
    expect(handoff.status).toBe(200);
    expect(handoff.body.record.holderAccountId).toBe(guest.accountId);
    expect(handoff.body.record.sequence).toBe(2);

    const listed = await api.request(`/v1/sessions/${session.id}/authority`, { token: guest.token });
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].holderAccountId).toBe(guest.accountId);
  });

  it('refuses to hand an object to someone who is not present', async () => {
    const { owner, guest, session } = await fireside();
    await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: owner.token });

    const response = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: owner.token,
      body: {
        objectId: 'obj_skewer_1',
        objectKind: 'skewer',
        toAccountId: guest.accountId,
        reason: 'give',
        expectedSequence: 0,
      },
    });
    expect(response.status).toBe(409);
    expect(response.body.reason).toBe('target_not_present');
  });

  it('releases everything a player was holding when they leave', async () => {
    const { owner, guest, session } = await fireside();
    await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: owner.token });
    await api.request(`/v1/sessions/${session.id}/join`, { method: 'POST', token: guest.token });
    await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: guest.token,
      body: {
        objectId: 'obj_camera_1',
        objectKind: 'camera',
        toAccountId: guest.accountId,
        reason: 'grab',
        expectedSequence: 0,
      },
    });

    await api.request(`/v1/sessions/${session.id}/leave`, { method: 'POST', token: guest.token });

    const listed = await api.request(`/v1/sessions/${session.id}/authority`, { token: owner.token });
    expect(listed.body.items[0].holderAccountId).toBeNull();
    expect(listed.body.items[0].sequence).toBe(2);

    // And the object is grabbable again by whoever is still at the fire.
    const regrab = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: owner.token,
      body: {
        objectId: 'obj_camera_1',
        objectKind: 'camera',
        toAccountId: owner.accountId,
        reason: 'grab',
        expectedSequence: 2,
      },
    });
    expect(regrab.status).toBe(200);
    expect(regrab.body.record.holderAccountId).toBe(owner.accountId);
  });

  it('refuses authority calls from someone outside the campsite', async () => {
    const { session } = await fireside();
    const stranger = await bootstrap(api);
    const response = await api.request(`/v1/sessions/${session.id}/authority`, {
      method: 'POST',
      token: stranger.token,
      body: {
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        toAccountId: stranger.accountId,
        reason: 'grab',
        expectedSequence: 0,
      },
    });
    expect(response.status).toBe(404);
  });
});
