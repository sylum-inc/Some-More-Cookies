import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { InputIntentSchema, type InputIntent, type StampedInput } from '@somemore/protocol';
import type { RealtimeClient } from '../src/realtime/client.js';
import { SimMirror, digest } from './realtime-replay.js';
import {
  bootstrap,
  fireside,
  joinMessage,
  settle,
  startRealtimeHarness,
  until,
  type RealtimeHarness,
} from './realtime-harness.js';

let rig: RealtimeHarness;

beforeEach(async () => {
  rig = await startRealtimeHarness();
});

afterEach(async () => {
  await rig.close();
});

const MARSHMALLOW = 'obj_marshmallow_1';

async function joinedClient(client: RealtimeClient, sessionId: string): Promise<RealtimeClient> {
  client.send(joinMessage(sessionId));
  await client.waitFor('snapshot');
  return client;
}

/** Send an intent and wait for the server to place it in the timeline. */
async function sendIntent(client: RealtimeClient, intent: InputIntent): Promise<StampedInput> {
  const parsed = InputIntentSchema.parse(intent);
  const seq = client.send({ t: 'input', intent: parsed });
  const ack = await client.waitFor('ack', (message) => message.seq === seq);
  return { tick: ack.tick, serverSeq: ack.serverSeq, accountId: '', clientSeq: seq, intent: parsed };
}

async function grab(client: RealtimeClient, accountId: string, objectId: string, kind: 'marshmallow' | 'skewer' | 'prop') {
  const seq = client.send({
    t: 'authority',
    request: {
      objectId,
      objectKind: kind,
      toAccountId: accountId,
      reason: 'grab',
      expectedSequence: 0,
      leaseSeconds: 600,
    },
  });
  return client.waitFor('authority', (message) => message.record.objectId === objectId && message.reason === 'grab');
}

describe('two at the same fire', () => {
  it('relays one player’s inputs to the other, stamped into a shared timeline', async () => {
    const { host, guest, session } = await fireside(rig.api);

    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    await hostClient.waitFor('snapshot');

    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');

    // The host hears the guest arrive before the guest says anything.
    const arrival = await hostClient.waitFor('arrival');
    expect(arrival.participant.accountId).toBe(guest.accountId);
    expect(arrival.path.waypoints.length).toBeGreaterThanOrEqual(2);

    await grab(hostClient, host.accountId, MARSHMALLOW, 'marshmallow');
    const stamped = await sendIntent(hostClient, {
      kind: 'move_marshmallow',
      objectId: MARSHMALLOW,
      position: { x: 0, y: 0.4, z: 0.5 },
      rotation: 0.5,
      blow: 0,
    } as InputIntent);

    const relayed = await guestClient.waitFor('input');
    expect(relayed.stamped.accountId).toBe(host.accountId);
    expect(relayed.stamped.tick).toBe(stamped.tick);
    expect(relayed.stamped.serverSeq).toBe(stamped.serverSeq);
    expect(relayed.stamped.intent).toEqual(stamped.intent);

    // And back the other way: tending the fire needs no authority at all.
    const guestSeq = guestClient.send({ t: 'input', intent: { kind: 'tend_fire', action: { action: 'rake' } } });
    await guestClient.waitFor('ack', (m) => m.seq === guestSeq);
    const atHost = await hostClient.waitFor('input', (m) => m.stamped.accountId === guest.accountId);
    expect(atHost.stamped.intent).toMatchObject({ kind: 'tend_fire' });
  });

  it('gives every accepted message a strictly increasing server sequence', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('snapshot');
    await grab(client, host.accountId, MARSHMALLOW, 'marshmallow');

    const seqs: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      const stamped = await sendIntent(client, {
        kind: 'move_marshmallow',
        objectId: MARSHMALLOW,
        position: { x: 0, y: 0.4, z: 0.5 },
        rotation: i * 0.2,
        blow: 0,
      } as InputIntent);
      seqs.push(stamped.serverSeq);
    }
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(seqs.length);
  });

  it('drops a replayed or out-of-order client sequence', async () => {
    const { host, session } = await fireside(rig.api);
    const client = await rig.connect(host);
    client.send(joinMessage(session.id));
    await client.waitFor('welcome');

    client.sendRaw({ seq: 1, t: 'chat', text: 'first' });
    const error = await client.waitFor('error', (m) => m.code === 'sequence_stale');
    expect(error.message).toContain('not ahead of');
  });

  it('treats a second device as the same person, not a second arrival', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await joinedClient(await rig.connect(host), session.id);

    const phone = await joinedClient(await rig.connect(guest), session.id);
    await hostClient.waitFor('arrival');
    const laptop = await joinedClient(await rig.connect(guest), session.id);
    await settle(6);

    // One person walked out of the trees, not two.
    expect(hostClient.all('arrival')).toHaveLength(1);
    const snapshot = laptop.all('snapshot')[0];
    expect(snapshot?.participants.filter((p) => p.accountId === guest.accountId)).toHaveLength(1);

    // Losing one device does not take their marshmallow off them.
    await grab(phone, guest.accountId, MARSHMALLOW, 'marshmallow');
    phone.terminate();
    await settle(6);
    expect(hostClient.all('departure')).toHaveLength(0);

    const seq = laptop.send({
      t: 'input',
      intent: { kind: 'move_marshmallow', objectId: MARSHMALLOW, position: { x: 0, y: 0.4, z: 0.5 }, rotation: 0.3 },
    });
    await laptop.waitFor('ack', (m) => m.seq === seq);

    // Their last device leaving is the departure.
    laptop.send({ t: 'depart', manner: 'walk_off' });
    const departure = await hostClient.waitFor('departure');
    expect(departure.accountId).toBe(guest.accountId);
  });

  it('carries a departure as a walk back up the trail', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    await hostClient.waitFor('snapshot');

    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');
    await hostClient.waitFor('arrival');

    guestClient.send({ t: 'depart', manner: 'walk_off' });
    const departure = await hostClient.waitFor('departure');
    expect(departure.accountId).toBe(guest.accountId);
    expect(departure.manner).toBe('walk_off');
    expect(departure.path?.waypoints.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(departure.path?.glanceBack).toBe(true);
  });
});

/*
 * The claim in ADR-0006, tested end to end: a player who arrives late is given
 * the seed and the input history, replays it locally, and lands on a
 * marshmallow that is identical patch for patch to the one the players who
 * were there the whole time are looking at. No simulation state is ever sent.
 */
describe('a late joiner reconstructs the world exactly', () => {
  it('replays seed plus input history to an identical simulation', async () => {
    const { host, guest, campsite, session, newInvite } = await fireside(rig.api);

    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    const hostSnapshot = await hostClient.waitFor('snapshot');
    expect(hostSnapshot.seed).toBe(campsite.seed);
    expect(hostSnapshot.environmentId).toBe(campsite.environmentId);

    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');

    await grab(hostClient, host.accountId, MARSHMALLOW, 'marshmallow');

    // A real roast: light the fire up, start roasting, then turn the
    // marshmallow steadily while easing it towards the coals.
    const mine: StampedInput[] = [];
    const record = async (intent: InputIntent) => {
      const stamped = await sendIntent(hostClient, intent);
      mine.push({ ...stamped, accountId: host.accountId });
    };

    await record({ kind: 'tend_fire', action: { action: 'add_log', woodId: 'oak', grade: 'log' } } as InputIntent);
    await record({ kind: 'begin_roast', objectId: MARSHMALLOW } as InputIntent);

    for (let i = 0; i < 45; i += 1) {
      // One second of wall clock per input, so the intents land on ticks a
      // whole second apart and the roast has time to actually happen.
      rig.api.clock.advance(1_000);
      await record({
        kind: 'move_marshmallow',
        objectId: MARSHMALLOW,
        position: { x: 0, y: 0.36, z: 0.42 - i * 0.002 },
        rotation: i * 0.7,
        blow: 0,
      } as InputIntent);
    }

    const totalInputs = mine.length;
    await until(() => guestClient.all('input').length === totalInputs);

    // Somebody who has never been here before, arriving with an invite.
    const latecomer = await bootstrap(rig.api, 'Latecomer');
    const invite = await newInvite();
    const lateClient = await rig.connect(latecomer);
    lateClient.send(joinMessage(session.id, { join: { method: 'invite_link', token: invite.token } }));
    const snapshot = await lateClient.waitFor('snapshot');

    expect(snapshot.truncated).toBe(false);
    expect(snapshot.inputs).toHaveLength(totalInputs);
    expect(snapshot.seed).toBe(campsite.seed);
    // Not one byte of simulation state crossed the wire.
    expect(JSON.stringify(snapshot)).not.toContain('temperatureC');
    expect(JSON.stringify(snapshot)).not.toContain('patches');

    const finalTick = Math.max(...snapshot.inputs.map((s) => s.tick));

    // Three independent paths to the same world:
    //   host       — its own intents, applied on the tick the server acked
    //   guest      — the relayed stream, received live
    //   latecomer  — the snapshot, replayed from nothing
    const hostMirror = new SimMirror(campsite.seed, campsite.environmentId).enqueue(...mine).advanceTo(finalTick);
    const guestMirror = new SimMirror(campsite.seed, campsite.environmentId)
      .enqueue(...guestClient.all('input').map((m) => m.stamped))
      .advanceTo(finalTick);
    const lateMirror = new SimMirror(campsite.seed, campsite.environmentId)
      .enqueue(...snapshot.inputs)
      .advanceTo(finalTick);

    const fromHost = digest(hostMirror.ritual);
    expect(digest(guestMirror.ritual)).toEqual(fromHost);
    expect(digest(lateMirror.ritual)).toEqual(fromHost);

    // ...and the roast is a real one, not an untouched marshmallow that would
    // match trivially.
    expect(lateMirror.ritual.stage).toBe('roasting');
    const roast = (fromHost as { roast: { brown: number; peakTempC: number } }).roast;
    expect(roast.brown).toBeGreaterThan(0.02);
    expect(roast.peakTempC).toBeGreaterThan(100);
    expect(lateMirror.ritual.marshmallow.rotationTravel).toBeGreaterThan(1);
  }, 30_000);

  it('resumes from a tick for a reconnecting client', async () => {
    const { host, guest, session } = await fireside(rig.api);

    // Somebody has to stay by the fire: the session ends when the last person
    // leaves, so a reconnect only makes sense while the fire is still lit.
    const hostClient = await rig.connect(host);
    hostClient.send(joinMessage(session.id));
    await hostClient.waitFor('snapshot');

    const guestClient = await rig.connect(guest);
    guestClient.send(joinMessage(session.id));
    await guestClient.waitFor('snapshot');

    await grab(hostClient, host.accountId, MARSHMALLOW, 'marshmallow');
    await sendIntent(hostClient, { kind: 'begin_roast', objectId: MARSHMALLOW } as InputIntent);
    rig.api.clock.advance(2_000);
    const later = await sendIntent(hostClient, {
      kind: 'move_marshmallow',
      objectId: MARSHMALLOW,
      position: { x: 0, y: 0.4, z: 0.5 },
      rotation: 1,
      blow: 0,
    } as InputIntent);
    expect(later.tick).toBeGreaterThan(0);

    guestClient.close();
    await guestClient.waitForClose();
    await settle();

    const resumed = await rig.connect(guest);
    resumed.send(joinMessage(session.id, { sinceTick: later.tick }));
    const snapshot = await resumed.waitFor('snapshot');
    expect(snapshot.fromTick).toBe(later.tick);
    expect(snapshot.inputs.length).toBeGreaterThan(0);
    expect(snapshot.inputs.every((s) => s.tick >= later.tick)).toBe(true);
    expect(snapshot.inputs.some((s) => s.serverSeq === later.serverSeq)).toBe(true);
    // The marshmallow is still in the host's hand across the reconnect.
    expect(snapshot.authority.find((r) => r.objectId === MARSHMALLOW)?.holderAccountId).toBe(host.accountId);
  });
});
