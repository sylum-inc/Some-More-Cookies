import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputIntentSchema, type InputIntent } from '@somemore/protocol';
import type { RealtimeClient } from '../src/realtime/client.js';
import { fireside, joinMessage, settle, startRealtimeHarness, until, type RealtimeHarness } from './realtime-harness.js';

let rig: RealtimeHarness;

beforeEach(async () => {
  rig = await startRealtimeHarness();
});

afterEach(async () => {
  await rig.close();
});

const SKEWER = 'obj_skewer_1';

async function joined(client: RealtimeClient, sessionId: string) {
  client.send(joinMessage(sessionId));
  await client.waitFor('snapshot');
  return client;
}

function requestAuthority(
  client: RealtimeClient,
  request: {
    objectId?: string;
    objectKind?: 'skewer' | 'marshmallow' | 'prop';
    toAccountId: string | null;
    reason: 'grab' | 'release' | 'give' | 'host_override' | 'timeout' | 'disconnect';
    expectedSequence: number;
    leaseSeconds?: number;
  },
): number {
  return client.send({
    t: 'authority',
    request: {
      objectId: request.objectId ?? SKEWER,
      objectKind: request.objectKind ?? 'skewer',
      toAccountId: request.toAccountId,
      reason: request.reason,
      expectedSequence: request.expectedSequence,
      leaseSeconds: request.leaseSeconds ?? 60,
    },
  });
}

function move(client: RealtimeClient, rotation: number): number {
  const intent = InputIntentSchema.parse({
    kind: 'move_marshmallow',
    objectId: SKEWER,
    position: { x: 0, y: 0.4, z: 0.5 },
    rotation,
    blow: 0,
  } as InputIntent);
  return client.send({ t: 'input', intent });
}

describe('object authority over the wire', () => {
  it('grants an unheld object and tells everyone at the fire', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0 });
    const granted = await hostClient.waitFor('authority');
    expect(granted.record.holderAccountId).toBe(host.accountId);
    expect(granted.record.sequence).toBe(1);
    expect(granted.record.expiresAt).not.toBeNull();

    const seen = await guestClient.waitFor('authority');
    expect(seen.record.holderAccountId).toBe(host.accountId);
  });

  it('refuses to take a live object out of the holder’s hands', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0 });
    await hostClient.waitFor('authority');
    await guestClient.waitFor('authority');

    const seq = requestAuthority(guestClient, { toAccountId: guest.accountId, reason: 'grab', expectedSequence: 1 });
    const denied = await guestClient.waitFor('authority_denied', (m) => m.seq === seq);
    expect(denied.reason).toBe('not_holder');
    expect(denied.current.holderAccountId).toBe(host.accountId);

    // ...and the refusal is real: the guest still cannot drive the object.
    const inputSeq = move(guestClient, 1);
    const error = await guestClient.waitFor('error', (m) => m.seq === inputSeq);
    expect(error.code).toBe('no_authority');
  });

  it('refuses a snatch even from the host, who must say so explicitly', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(guestClient, { toAccountId: guest.accountId, reason: 'grab', expectedSequence: 0 });
    await guestClient.waitFor('authority');
    await hostClient.waitFor('authority');

    const sneaky = requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 1 });
    const denied = await hostClient.waitFor('authority_denied', (m) => m.seq === sneaky);
    expect(denied.reason).toBe('not_holder');

    // The deliberate moderation path still works.
    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'host_override', expectedSequence: 1 });
    const overridden = await hostClient.waitFor('authority', (m) => m.reason === 'host_override');
    expect(overridden.record.holderAccountId).toBe(host.accountId);
  });

  /**
   * The reason ADR-0006 insists on a mutual-hold window: without it the stick
   * would leave one hand and appear in the other on whichever frame the grant
   * landed, which reads as a teleport rather than a pass.
   */
  it('passes an object with a mutual-hold window so it never teleports', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0 });
    await hostClient.waitFor('authority');
    await guestClient.waitFor('authority');

    requestAuthority(hostClient, { toAccountId: guest.accountId, reason: 'give', expectedSequence: 1 });
    const handoff = await hostClient.waitFor('authority', (m) => m.reason === 'give');
    expect(handoff.record.holderAccountId).toBe(guest.accountId);
    expect(handoff.mutualHolders).toEqual([host.accountId, guest.accountId]);
    expect(handoff.mutualHoldUntilTick).toBeGreaterThan(handoff.tick);

    // Both hands are on it: the giver's motion is still relayed...
    const giverSeq = move(hostClient, 0.4);
    const giverAck = await hostClient.waitFor('ack', (m) => m.seq === giverSeq);
    expect(giverAck.tick).toBeLessThanOrEqual(handoff.mutualHoldUntilTick as number);
    // ...and so is the receiver's.
    const takerSeq = move(guestClient, 0.6);
    await guestClient.waitFor('ack', (m) => m.seq === takerSeq);

    // Once the window has passed, only the new holder drives it.
    rig.api.clock.advance(2_000);
    await rig.realtime.sweep();
    const lateSeq = move(hostClient, 0.9);
    const error = await hostClient.waitFor('error', (m) => m.seq === lateSeq);
    expect(error.code).toBe('no_authority');

    const stillWorks = move(guestClient, 1.1);
    await guestClient.waitFor('ack', (m) => m.seq === stillWorks);
  });

  it('rejects a hand-off that presents a stale fencing sequence', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0 });
    const granted = await hostClient.waitFor('authority');
    expect(granted.record.sequence).toBe(1);

    // Two clients raced; this one is still holding the pre-grab sequence.
    const stale = requestAuthority(hostClient, { toAccountId: null, reason: 'release', expectedSequence: 0 });
    const denied = await hostClient.waitFor('authority_denied', (m) => m.seq === stale);
    expect(denied.reason).toBe('sequence_stale');
    expect(denied.current.sequence).toBe(1);

    // Presenting the sequence the server just told us about works.
    requestAuthority(hostClient, { toAccountId: null, reason: 'release', expectedSequence: denied.current.sequence });
    const released = await hostClient.waitFor('authority', (m) => m.reason === 'release');
    expect(released.record.holderAccountId).toBeNull();
  });

  it('releases everything a dropped player was holding', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(guestClient, { toAccountId: guest.accountId, reason: 'grab', expectedSequence: 0 });
    await guestClient.waitFor('authority');
    await hostClient.waitFor('authority');

    // The network takes them: no close frame, just a dead socket.
    guestClient.terminate();

    const released = await hostClient.waitFor('authority', (m) => m.reason === 'disconnect');
    expect(released.record.objectId).toBe(SKEWER);
    expect(released.record.holderAccountId).toBeNull();

    const departure = await hostClient.waitFor('departure');
    expect(departure.accountId).toBe(guest.accountId);
    expect(departure.manner).toBe('dropped');
    expect(departure.releasedObjectIds).toContain(SKEWER);

    // The object is available again, at its new sequence.
    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: released.record.sequence });
    const regrabbed = await hostClient.waitFor('authority', (m) => m.reason === 'grab' && m.record.holderAccountId === host.accountId);
    expect(regrabbed.record.holderAccountId).toBe(host.accountId);
  });

  it('expires a lapsed lease and lets somebody else pick the object up', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0, leaseSeconds: 30 });
    const granted = await hostClient.waitFor('authority');
    await guestClient.waitFor('authority');

    // Nobody touched it for a minute; the lease is gone.
    rig.api.clock.advance(60_000);
    await rig.realtime.sweep();

    const expired = await guestClient.waitFor('authority_expired');
    expect(expired.record.objectId).toBe(SKEWER);
    expect(expired.record.holderAccountId).toBeNull();
    expect(expired.record.sequence).toBe(granted.record.sequence + 1);

    requestAuthority(guestClient, { toAccountId: guest.accountId, reason: 'grab', expectedSequence: expired.record.sequence });
    const taken = await guestClient.waitFor('authority', (m) => m.record.holderAccountId === guest.accountId);
    expect(taken.record.holderAccountId).toBe(guest.accountId);
  });

  it('expires a lapsed lease inline, without punishing the client that raced the timer', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    requestAuthority(hostClient, { toAccountId: host.accountId, reason: 'grab', expectedSequence: 0, leaseSeconds: 30 });
    const granted = await hostClient.waitFor('authority');
    await guestClient.waitFor('authority');

    rig.api.clock.advance(60_000);
    // No sweep: the guest's grab is what discovers the lapse. It presents the
    // sequence it last saw, which is correct as of the moment it was sent.
    requestAuthority(guestClient, {
      toAccountId: guest.accountId,
      reason: 'grab',
      expectedSequence: granted.record.sequence,
    });
    const taken = await guestClient.waitFor('authority', (m) => m.record.holderAccountId === guest.accountId);
    expect(taken.record.holderAccountId).toBe(guest.accountId);
    expect(taken.record.sequence).toBeGreaterThan(granted.record.sequence);
  });

  it('will not let a non-holder drive an object even between hand-offs', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);
    await settle();

    // Nobody holds it at all.
    const seq = move(guestClient, 0.2);
    const error = await guestClient.waitFor('error', (m) => m.seq === seq);
    expect(error.code).toBe('no_authority');
    await until(() => hostClient.all('input').length === 0);
  });
});
