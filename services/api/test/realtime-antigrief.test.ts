import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputIntentKindValues, NON_EXPRESSIBLE_INTENTS } from '@somemore/protocol';
import type { RealtimeClient } from '../src/realtime/client.js';
import { fireside, joinMessage, settle, startRealtimeHarness, until, type RealtimeHarness } from './realtime-harness.js';

let rig: RealtimeHarness;

beforeEach(async () => {
  rig = await startRealtimeHarness();
});

afterEach(async () => {
  await rig.close();
});

async function joined(client: RealtimeClient, sessionId: string) {
  client.send(joinMessage(sessionId));
  await client.waitFor('snapshot');
  return client;
}

/** Did the server take this message, or refuse it? */
async function outcome(client: RealtimeClient, seq: number): Promise<'ack' | 'error'> {
  const acked = () => client.all('ack').some((m) => m.seq === seq);
  const refused = () => client.all('error').some((m) => m.seq === seq);
  await until(() => acked() || refused());
  return acked() ? 'ack' : 'error';
}

/*
 * "Mild physical silliness is allowed; griefing is not" (spec §9). The defence
 * is layered: the destructive verbs do not exist, the constructive ones are
 * gated on authority, what is left is metered, and a block is absolute.
 */
describe('anti-grief', () => {
  it('has no message for a destructive action on somebody else’s work', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await joined(await rig.connect(host), session.id);

    let seq = 100;
    for (const verb of NON_EXPRESSIBLE_INTENTS.slice(0, 6)) {
      seq += 1;
      client.sendRaw({ seq, t: 'input', intent: { kind: verb, objectId: 'obj_marshmallow_1', targetAccountId: 'acct_x' } });
      const error = await client.waitFor('error', (m) => m.code === 'invalid_message' && m.message.length > 0);
      expect(error.code).toBe('invalid_message');
      client.received.length = 0;
    }
    // The vocabulary really is closed.
    for (const verb of NON_EXPRESSIBLE_INTENTS) {
      expect(InputIntentKindValues as readonly string[]).not.toContain(verb);
    }
  });

  it('will not relay an intent aimed at an object somebody else is holding', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    hostClient.send({
      t: 'authority',
      request: {
        objectId: 'obj_sm01',
        objectKind: 'sm01',
        toAccountId: host.accountId,
        reason: 'grab',
        expectedSequence: 0,
        leaseSeconds: 300,
      },
    });
    await hostClient.waitFor('authority');
    await guestClient.waitFor('authority');

    // Mid-run, and somebody else tries to hit reset.
    const seq = guestClient.send({
      t: 'input',
      intent: { kind: 'machine_control', objectId: 'obj_sm01', control: 'reset' },
    });
    const error = await guestClient.waitFor('error', (m) => m.seq === seq);
    expect(error.code).toBe('no_authority');
    await settle();
    expect(hostClient.all('input')).toHaveLength(0);
  });

  it('cools down repeated interference with somebody who is mid-task', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    // The guest settles in to roast.
    const presenceSeq = guestClient.send({ t: 'presence', presence: { connection: 'connected', activity: 'roasting' } });
    await guestClient.waitFor('ack', (m) => m.seq === presenceSeq);
    await until(() => hostClient.all('presence').some((m) => m.presence.activity === 'roasting'));

    // The host starts fanning the fire at them, over and over.
    const accepted: number[] = [];
    const refused: number[] = [];
    for (let i = 0; i < 18; i += 1) {
      const seq = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'fan', strength: 1 } } });
      if ((await outcome(hostClient, seq)) === 'ack') accepted.push(seq);
      else refused.push(seq);
    }

    // Tending the fire together is fine; doing it at somebody is not.
    expect(accepted.length).toBe(rig.realtime.limits.interferencePerMinute);
    expect(refused.length).toBeGreaterThan(0);
    const cooldown = hostClient.all('error').find((m) => m.code === 'interference_cooldown');
    expect(cooldown).toBeDefined();
    expect(cooldown?.retryAfterMs).toBeGreaterThan(0);

    // And it is a cooldown, not a ban: time passes, the fire can be tended.
    rig.api.clock.advance(rig.realtime.limits.interferenceCooldownMs + 20_000);
    const later = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await hostClient.waitFor('ack', (m) => m.seq === later);
  });

  it('does not meter the same action when nobody is mid-task', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    await joined(await rig.connect(guest), session.id);

    for (let i = 0; i < 18; i += 1) {
      const seq = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
      await hostClient.waitFor('ack', (m) => m.seq === seq);
    }
    expect(hostClient.all('error')).toHaveLength(0);
  });

  it('stops relaying a blocked player, in both directions', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    // Before the block, the guest sees what the host does.
    const before = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await hostClient.waitFor('ack', (m) => m.seq === before);
    await until(() => guestClient.all('input').length === 1);

    const blockSeq = guestClient.send({ t: 'block', accountId: host.accountId });
    await guestClient.waitFor('ack', (m) => m.seq === blockSeq);

    // The host carries on. The server accepts it — a block is invisible to the
    // person who was blocked — but nothing reaches the guest.
    const after = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'fan' } } });
    await hostClient.waitFor('ack', (m) => m.seq === after);
    const chat = hostClient.send({ t: 'chat', text: 'hey' });
    await hostClient.waitFor('ack', (m) => m.seq === chat);
    await settle(6);
    expect(guestClient.all('input')).toHaveLength(1);
    expect(guestClient.all('chat')).toHaveLength(0);

    // ...and the wall is symmetric: the guest's own inputs stop reaching the host.
    const fromGuest = guestClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await guestClient.waitFor('ack', (m) => m.seq === fromGuest);
    await settle(6);
    expect(hostClient.all('input')).toHaveLength(0);
    expect(hostClient.all('chat')).toHaveLength(0);
  });

  it('leaves a blocked player out of a later snapshot too', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    const blockSeq = guestClient.send({ t: 'block', accountId: host.accountId });
    await guestClient.waitFor('ack', (m) => m.seq === blockSeq);

    const seq = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await hostClient.waitFor('ack', (m) => m.seq === seq);

    guestClient.close();
    await guestClient.waitForClose();
    await settle();

    const rejoined = await rig.connect(guest);
    rejoined.send(joinMessage(session.id));
    const snapshot = await rejoined.waitFor('snapshot');
    expect(snapshot.inputs.some((s) => s.accountId === host.accountId)).toBe(false);
  });

  it('lets a block be lifted', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joined(await rig.connect(host), session.id);
    const guestClient = await joined(await rig.connect(guest), session.id);

    const blockSeq = guestClient.send({ t: 'block', accountId: host.accountId });
    await guestClient.waitFor('ack', (m) => m.seq === blockSeq);
    const unblockSeq = guestClient.send({ t: 'unblock', accountId: host.accountId });
    await guestClient.waitFor('ack', (m) => m.seq === unblockSeq);

    const seq = hostClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await hostClient.waitFor('ack', (m) => m.seq === seq);
    await until(() => guestClient.all('input').length === 1);
  });

  it('refuses to block yourself', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await joined(await rig.connect(host), session.id);
    const seq = client.send({ t: 'block', accountId: host.accountId });
    const error = await client.waitFor('error', (m) => m.seq === seq);
    expect(error.code).toBe('invalid_message');
  });
});
