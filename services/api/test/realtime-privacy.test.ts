import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { QR_JOIN_PREFIX } from '@somemore/protocol';
import { openWebSocket } from '../src/realtime/client.js';
import {
  bootstrap,
  expectUpgradeRejected,
  fireside,
  joinMessage,
  key,
  startRealtimeHarness,
  type RealtimeHarness,
} from './realtime-harness.js';

let rig: RealtimeHarness;

beforeEach(async () => {
  rig = await startRealtimeHarness();
});

afterEach(async () => {
  await rig.close();
});

/*
 * Campsites are private by default (spec §9). The socket must not be a way
 * around that, and it must not become a way to enumerate session ids either —
 * a stranger gets the same `not_found` the HTTP API gives.
 */
describe('privacy', () => {
  it('refuses a stranger with no invite, and does not confirm the session exists', async () => {
    const { session } = await fireside(rig.api);
    const stranger = await bootstrap(rig.api, 'Stranger');
    const client = await rig.connect(stranger);

    client.send(joinMessage(session.id));
    const error = await client.waitFor('error');
    expect(error.code).toBe('not_found');
    expect(error.message).not.toContain(session.id);

    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);
    expect(client.all('welcome')).toHaveLength(0);
    expect(client.all('snapshot')).toHaveLength(0);
  });

  it('lets an invite link in', async () => {
    const { session, newInvite } = await fireside(rig.api);
    const invite = await newInvite();
    const newcomer = await bootstrap(rig.api, 'Invited');
    const client = await rig.connect(newcomer);

    client.send(joinMessage(session.id, { join: { method: 'invite_link', token: invite.token } }));
    const welcome = await client.waitFor('welcome');
    expect(welcome.accountId).toBe(newcomer.accountId);
    const snapshot = await client.waitFor('snapshot');
    expect(snapshot.participants.map((p) => p.accountId)).toContain(newcomer.accountId);
  });

  it('lets a spoken camp code in', async () => {
    const { session, newInvite } = await fireside(rig.api);
    const invite = await newInvite();
    const newcomer = await bootstrap(rig.api, 'Spoken');
    const client = await rig.connect(newcomer);

    client.send(joinMessage(session.id, { join: { method: 'camp_code', code: invite.campCode } }));
    await client.waitFor('welcome');
  });

  it('lets a QR payload in', async () => {
    const { session, newInvite } = await fireside(rig.api);
    const invite = await newInvite();
    const newcomer = await bootstrap(rig.api, 'Scanned');
    const client = await rig.connect(newcomer);

    client.send(joinMessage(session.id, { join: { method: 'qr', payload: `${QR_JOIN_PREFIX}${invite.token}` } }));
    await client.waitFor('welcome');
  });

  it('does not accept a campsite’s own code while the campsite is private', async () => {
    const { campsite, session } = await fireside(rig.api);
    expect(campsite.privacy).toBe('private');
    const newcomer = await bootstrap(rig.api, 'Chancer');
    const client = await rig.connect(newcomer);

    client.send(joinMessage(session.id, { join: { method: 'camp_code', code: campsite.campCode } }));
    const error = await client.waitFor('error');
    expect(error.code).toBe('forbidden');
    expect(error.message).toContain('private');
  });

  it('accepts a campsite’s own code once the owner has opened it up', async () => {
    const { host, campsite, session } = await fireside(rig.api);
    const opened = await rig.api.request(`/v1/campsites/${campsite.id}`, {
      method: 'PATCH',
      token: host.token,
      body: { privacy: 'public' },
    });
    expect(opened.status).toBe(200);

    const newcomer = await bootstrap(rig.api, 'Welcome');
    const client = await rig.connect(newcomer);
    client.send(joinMessage(session.id, { join: { method: 'camp_code', code: campsite.campCode } }));
    await client.waitFor('welcome');
  });

  it('refuses a revoked or exhausted invite', async () => {
    const { host, campsite, session } = await fireside(rig.api);
    const created = await rig.api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: host.token,
      body: { idempotencyKey: key('inv'), grantsRole: 'guest', maxUses: 1 },
    });
    const invite = created.body.invite ?? created.body;

    const first = await bootstrap(rig.api, 'First');
    const firstClient = await rig.connect(first);
    firstClient.send(joinMessage(session.id, { join: { method: 'invite_link', token: invite.token } }));
    await firstClient.waitFor('welcome');

    const second = await bootstrap(rig.api, 'Second');
    const secondClient = await rig.connect(second);
    secondClient.send(joinMessage(session.id, { join: { method: 'invite_link', token: invite.token } }));
    const error = await secondClient.waitFor('error');
    expect(error.code).toBe('forbidden');
  });

  it('will not open a socket without a valid token at all', async () => {
    const withoutToken = await expectUpgradeRejected(openWebSocket({ url: rig.wsUrl }));
    expect(withoutToken.status).toBe(401);

    const withNonsense = await expectUpgradeRejected(openWebSocket({ url: rig.wsUrl, token: 'sm1.not.a.token' }));
    expect(withNonsense.status).toBe(401);
  });

  it('refuses a client speaking an incompatible protocol major', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send({ t: 'join', sessionId: session.id, schemaVersion: '99.0.0' });
    const error = await client.waitFor('error');
    expect(error.code).toBe('unsupported_version');
    const closed = await client.waitForClose();
    expect(closed.code).toBe(1008);
  });
});
