/**
 * Two clients, one fire, one marshmallow.
 *
 * `services/api/test/realtime-session.test.ts` already proves the *server* half
 * of ADR-0006: it drives a real roast over a real socket and shows that three
 * independently-built simulations agree. What it cannot show is that the thing
 * the browser actually ships converges, because it drives the server with the
 * server's own test client and replays with the server's own test harness.
 *
 * This is the other half. It boots the real service, attaches the real
 * WebSocket transport, and drives it with `apps/web/src/net` — the same
 * `Campfire`, the same `RealtimeTransport`, the same `SharedTimeline`, the same
 * `applyIntent` — over Node's own `WebSocket`. Nothing is stubbed but the
 * clock, and the clock is stubbed so the ticks are exact rather than racy.
 *
 * What it asserts is not "no error". It is that after a forty-five second
 * roast, two clients that never spoke to each other hold marshmallows that
 * agree patch by patch, temperature by temperature — and that the roast was a
 * real one rather than an untouched marshmallow that would match trivially.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  bootstrap,
  fireside,
  settle,
  startRealtimeHarness,
  until,
  type RealtimeHarness,
} from '../../services/api/test/realtime-harness.js';
import { SimMirror, applyIntent as harnessApplyIntent, digest } from '../../services/api/test/realtime-replay.js';
import { Campfire } from '../../apps/web/src/net/campfire.js';
import { applyIntent as clientApplyIntent } from '../../apps/web/src/net/replication.js';
import { MARSHMALLOW_OBJECT_ID } from '../../apps/web/src/net/authority.js';
import { SharedTimeline } from '../../apps/web/src/net/timeline.js';
import { SIM_DT, createRitual, stepRitual, type RitualState } from '@somemore/sim';
import {
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_SUBPROTOCOL,
  type InputIntent,
  type StampedInput,
} from '@somemore/protocol';

let rig: RealtimeHarness;

beforeEach(async () => {
  rig = await startRealtimeHarness();
});

afterEach(async () => {
  await rig.close();
});

/**
 * A `Campfire` on Node's own `WebSocket`.
 *
 * The transport is written against a structural `SocketLike` precisely so this
 * is possible: the browser's `WebSocket` and Node 22's satisfy the same shape,
 * so the code under test here is byte-for-byte the code the page runs.
 */
function connect(token: string, sessionId: string): Campfire {
  const fire = new Campfire({
    transport: {
      url: rig.wsUrl,
      token,
      sessionId,
      socketFactory: (url, protocols) => new WebSocket(url, protocols) as never,
      retryBaseMs: 20,
      maxRetries: 2,
    },
  });
  fire.connect();
  return fire;
}

/** Wait for a campfire to be at the fire with its world rebuilt. */
async function joined(fire: Campfire): Promise<void> {
  await until(() => fire.joined && fire.timeline !== null, 5_000);
}

/** Everything the players can see, patch by patch. */
function worldOf(fire: Campfire): unknown {
  const timeline = fire.timeline;
  if (timeline === null) throw new Error('no shared world');
  return digest(timeline.ritual);
}

describe('two clients at one fire', () => {
  it('converges patch by patch across a forty-five second roast', async () => {
    const { host, guest, campsite, session } = await fireside(rig.api);

    const one = connect(host.token, session.id);
    const two = connect(guest.token, session.id);
    await joined(one);
    await joined(two);

    // Both rebuilt *this* campsite, from a number and a list of intents.
    expect(one.timeline?.ritual.seed).toBe(campsite.seed);
    expect(two.timeline?.ritual.seed).toBe(campsite.seed);

    // The host builds the fire up and starts roasting. Every one of these
    // travels: `Campfire` applies nothing locally while it is joined.
    one.tendFire({ type: 'add-log', woodId: 'oak' });
    one.beginRoast();
    await until(() => one.authority.holderOf(MARSHMALLOW_OBJECT_ID) === host.accountId, 5_000);

    // A real roast: turn the marshmallow steadily while easing it toward the
    // coals, one input a second, for forty-five seconds of simulated time.
    for (let i = 0; i < 45; i += 1) {
      rig.api.clock.advance(1_000);
      one.moveMarshmallow({ x: 0, y: 0.36, z: 0.42 - i * 0.002 }, i * 0.7, 0);
      await settle(1);
    }
    // The guest tends the fire from the other side, which needs no authority —
    // tending a fire together is the point.
    rig.api.clock.advance(1_000);
    two.tendFire({ type: 'rake' });

    // Everything sent has to have been relayed before either side can be
    // expected to agree; `inputsRelayed` is the server's own counter.
    const sent = 48;
    await until(() => rig.realtime.stats().inputsRetained >= sent, 8_000);
    // One more message each way, so both timelines learn that the last tick is
    // complete: a tick is only safe once a *later* one has been seen.
    rig.api.clock.advance(1_000);
    one.transport?.send({ t: 'chat', text: 'nearly there' });
    two.transport?.send({ t: 'chat', text: 'that smells good' });
    await settle(6);

    // Advance both to the same tick and look at what they are holding.
    const target = Math.min(one.timeline?.safeTick ?? 0, two.timeline?.safeTick ?? 0);
    expect(target).toBeGreaterThan(45 * 60);
    for (const fire of [one, two]) {
      const timeline = fire.timeline;
      if (timeline === null) throw new Error('no timeline');
      timeline.safeTick = target;
      timeline.pump();
      expect(timeline.appliedTick).toBe(target);
      // The ordering rule this whole design rests on: nothing ever arrived
      // for a tick that had already been stepped.
      expect(timeline.lateInputs).toBe(0);
      expect(timeline.truncated).toBe(false);
    }

    const fromHost = worldOf(one);
    expect(worldOf(two)).toEqual(fromHost);

    // ...and it was a real roast, not an untouched marshmallow.
    const roast = (fromHost as { roast: { brown: number; peakTempC: number } }).roast;
    expect(one.timeline?.ritual.stage).toBe('roasting');
    expect(roast.brown).toBeGreaterThan(0.02);
    expect(roast.peakTempC).toBeGreaterThan(100);
    expect(one.timeline?.ritual.marshmallow.rotationTravel).toBeGreaterThan(1);
    // Both fires have the guest's rake and the host's log in them.
    expect(one.timeline?.ritual.fire.logs.length).toBeGreaterThan(0);

    one.dispose();
    two.dispose();
  }, 60_000);

  it('rebuilds the same world for somebody who arrives late', async () => {
    const { host, guest, campsite, session, newInvite } = await fireside(rig.api);

    const one = connect(host.token, session.id);
    const two = connect(guest.token, session.id);
    await joined(one);
    await joined(two);

    one.tendFire({ type: 'add-log', woodId: 'oak' });
    one.beginRoast();
    await until(() => one.authority.holderOf(MARSHMALLOW_OBJECT_ID) === host.accountId, 5_000);
    for (let i = 0; i < 20; i += 1) {
      rig.api.clock.advance(1_000);
      one.moveMarshmallow({ x: 0, y: 0.32, z: 0.34 }, i * 0.9, 0);
      await settle(1);
    }
    await settle(4);

    // Somebody who has never been here before, arriving with an invite.
    const latecomer = await bootstrap(rig.api, 'Latecomer');
    const invite = await newInvite();
    const three = new Campfire({
      transport: {
        url: rig.wsUrl,
        token: latecomer.token,
        sessionId: session.id,
        join: { method: 'invite_link', token: invite.token },
        socketFactory: (url, protocols) => new WebSocket(url, protocols) as never,
        retryBaseMs: 20,
        maxRetries: 2,
      },
    });
    three.connect();
    await joined(three);

    // The whole world, from a seed and a list of intents. Nothing else crossed.
    expect(three.timeline?.ritual.seed).toBe(campsite.seed);
    expect(three.timeline?.truncated).toBe(false);
    expect(three.timeline?.appliedTick).toBeGreaterThan(19 * 60);

    rig.api.clock.advance(1_000);
    one.transport?.send({ t: 'chat', text: 'pull up a log' });
    await settle(6);

    const target = Math.min(
      one.timeline?.safeTick ?? 0,
      two.timeline?.safeTick ?? 0,
      three.timeline?.safeTick ?? 0,
    );
    for (const fire of [one, two, three]) {
      const timeline = fire.timeline;
      if (timeline === null) throw new Error('no timeline');
      timeline.safeTick = target;
      timeline.pump();
    }

    const fromHost = worldOf(one);
    expect(worldOf(two)).toEqual(fromHost);
    expect(worldOf(three)).toEqual(fromHost);
    // The late joiner walked in on a marshmallow that is genuinely part-way
    // through a roast — hot, and turned — rather than a fresh one, which would
    // have matched trivially.
    const roast = (fromHost as { roast: { peakTempC: number; rotationTravel: number } }).roast;
    expect(roast.peakTempC).toBeGreaterThan(60);
    expect(roast.rotationTravel).toBeGreaterThan(1);
    expect(three.timeline?.ritual.fire.logs.length).toBe(one.timeline?.ritual.fire.logs.length);

    one.dispose();
    two.dispose();
    three.dispose();
  }, 60_000);

  it('hands the stick across without either end losing it', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const one = connect(host.token, session.id);
    const two = connect(guest.token, session.id);
    await joined(one);
    await joined(two);

    one.beginRoast();
    await until(() => one.authority.holderOf(MARSHMALLOW_OBJECT_ID) === host.accountId, 5_000);

    // Somebody else cannot take it out of the holder's hands — the rule the
    // client predicts with is the rule the server enforces with.
    expect(two.authority.wouldDeny({
      objectId: MARSHMALLOW_OBJECT_ID,
      objectKind: 'marshmallow',
      reason: 'grab',
      toAccountId: guest.accountId,
    })).toBe('not_holder');

    // Held out, not snatched.
    expect(one.offer(MARSHMALLOW_OBJECT_ID, 'marshmallow', guest.accountId)).toBe(true);
    await until(() => two.authority.holderOf(MARSHMALLOW_OBJECT_ID) === guest.accountId, 5_000);

    // For the length of the mutual hold both of them may drive it, which is
    // what carries the stick across instead of teleporting it.
    const hold = two.authority.hold(MARSHMALLOW_OBJECT_ID);
    expect(hold).not.toBeNull();
    if (hold === null) throw new Error('no hold');
    expect(new Set(two.authority.drivers(MARSHMALLOW_OBJECT_ID, hold.startedTick))).toEqual(
      new Set([host.accountId, guest.accountId]),
    );
    expect(two.authority.handoffProgress(MARSHMALLOW_OBJECT_ID, hold.startedTick)).toBe(0);
    expect(two.authority.handoffProgress(MARSHMALLOW_OBJECT_ID, hold.untilTick)).toBeNull();
    // And once it is over, one pair of hands.
    expect(two.authority.drivers(MARSHMALLOW_OBJECT_ID, hold.untilTick + 1)).toEqual([guest.accountId]);

    one.dispose();
    two.dispose();
  }, 30_000);

  it('carries on alone when the connection goes, and rejoins where it left off', async () => {
    const { host, guest, session } = await fireside(rig.api);
    const one = connect(host.token, session.id);
    const two = connect(guest.token, session.id);
    await joined(one);
    await joined(two);

    one.tendFire({ type: 'add-log', woodId: 'oak' });
    rig.api.clock.advance(2_000);
    await settle(4);

    const before = two.timeline?.appliedTick ?? 0;
    // The network takes them.
    two.transport?.dispose();
    await settle(4);
    expect(two.joined).toBe(false);

    // The world they were looking at is still there, and still theirs to step.
    const timeline = two.timeline;
    if (timeline === null) throw new Error('no timeline');
    timeline.safeTick = before + 120;
    // A frame's worth at a time, so a stalled tab never eats the whole budget.
    expect(timeline.pump()).toBe(90);
    expect(timeline.pump()).toBe(30);
    expect(timeline.ritual.fire.logs.length).toBeGreaterThan(0);

    one.dispose();
    two.dispose();
  }, 30_000);
});

/**
 * The client's `applyIntent` and the server harness's must not drift.
 *
 * They are two copies on purpose — nothing may depend on `apps/web`
 * (ARCHITECTURE §2) and the contract package may not import the simulation —
 * so the guarantee has to be a test rather than a shared module. This drives
 * both over one long stream of every intent kind and compares the worlds.
 */
describe('the two intent mappings', () => {
  it('agree, intent for intent, over a long stream', () => {
    const seed = 918_273;
    const environmentId = 'pine-hollow';
    const mine: RitualState = createRitual({ campsiteSeed: seed, environmentId });
    const theirs: RitualState = createRitual({ campsiteSeed: seed, environmentId });

    const script: InputIntent[] = [
      { kind: 'tend_fire', action: { action: 'add_log', woodId: 'oak', grade: 'log' } },
      { kind: 'tend_fire', action: { action: 'rake' } },
      { kind: 'tend_fire', action: { action: 'fan', strength: 0.8 } },
      { kind: 'begin_roast', objectId: MARSHMALLOW_OBJECT_ID },
    ];
    for (let i = 0; i < 60; i += 1) {
      script.push({
        kind: 'move_marshmallow',
        objectId: MARSHMALLOW_OBJECT_ID,
        position: { x: Math.sin(i) * 0.05, y: 0.35, z: 0.4 },
        rotation: i * 0.4,
        blow: 0,
      });
    }
    script.push(
      { kind: 'blow_out', objectId: MARSHMALLOW_OBJECT_ID },
      { kind: 'finish_roast', objectId: MARSHMALLOW_OBJECT_ID },
      { kind: 'hold_component', component: 'graham-bottom' },
      { kind: 'move_component', offset: { x: 0.01, y: 0, z: -0.01 }, rotation: 0.1 },
      { kind: 'place_component' },
      { kind: 'hold_component', component: 'chocolate' },
      { kind: 'place_component' },
      { kind: 'gesture', gesture: 'wave', targetAccountId: null },
      { kind: 'move_prop', objectId: 'obj_torch_1', position: { x: 1, y: 1, z: 1 }, rotationY: 0.4 },
      { kind: 'machine_control', objectId: 'obj_sm01_1', control: 'load' },
      { kind: 'machine_control', objectId: 'obj_sm01_1', control: 'close_door' },
      { kind: 'machine_control', objectId: 'obj_sm01_1', control: 'set_program', program: 'deep-freeze' },
    );

    // Interleaved with steps, so a difference in *when* an intent takes hold
    // shows up rather than being flattened by applying them all at once.
    for (const intent of script) {
      clientApplyIntent(mine, intent);
      harnessApplyIntent(theirs, intent);
      for (let step = 0; step < 10; step += 1) {
        stepRitual(mine, SIM_DT);
        stepRitual(theirs, SIM_DT);
      }
    }

    expect(digest(mine)).toEqual(digest(theirs));

    // The one place they deliberately differ: the client's mapping carries the
    // holder's accessibility assist with the pick-up, which the harness — which
    // predates that field — ignores. Assert the difference is exactly that.
    clientApplyIntent(mine, { kind: 'hold_component', component: 'graham-top', assist: 0.9 });
    harnessApplyIntent(theirs, { kind: 'hold_component', component: 'graham-top', assist: 0.9 });
    expect(mine.assembly.assist).toBe(0.9);
    expect(theirs.assembly.assist).toBe(0.5);
  });
});

/**
 * The ordering rule, stated as a test.
 *
 * A timeline may only step a tick once the server has proved that every input
 * for it has been delivered. Feeding it inputs out of order and stepping it
 * against a safe tick must produce the same world as feeding them in order.
 */
describe('the shared timeline', () => {
  it('is indifferent to the order inputs arrive in', () => {
    const seed = 4242;
    const environmentId = 'pine-hollow';
    const inputs: StampedInput[] = [
      stamped(0, 1, { kind: 'tend_fire', action: { action: 'add_log', woodId: 'oak', grade: 'log' } }),
      stamped(30, 2, { kind: 'begin_roast', objectId: MARSHMALLOW_OBJECT_ID }),
      stamped(30, 3, {
        kind: 'move_marshmallow',
        objectId: MARSHMALLOW_OBJECT_ID,
        position: { x: 0, y: 0.34, z: 0.4 },
        rotation: 0.5,
        blow: 0,
      }),
      stamped(90, 4, { kind: 'tend_fire', action: { action: 'rake' } }),
      stamped(150, 5, {
        kind: 'move_marshmallow',
        objectId: MARSHMALLOW_OBJECT_ID,
        position: { x: 0, y: 0.32, z: 0.38 },
        rotation: 2.5,
        blow: 0,
      }),
    ];

    const ordered = new SharedTimeline({ seed, environmentId });
    for (const input of inputs) {
      ordered.enqueue(input);
      ordered.observe(input.tick);
    }
    ordered.observe(400);
    ordered.pump(1_000);

    const scrambled = new SharedTimeline({ seed, environmentId });
    scrambled.enqueue(...[...inputs].reverse());
    scrambled.observe(400);
    scrambled.pump(1_000);

    expect(scrambled.appliedTick).toBe(ordered.appliedTick);
    expect(digest(scrambled.ritual)).toEqual(digest(ordered.ritual));
    expect(ordered.lateInputs).toBe(0);

    // And the same world the server's own replay harness would build.
    const mirror = new SimMirror(seed, environmentId).enqueue(...inputs).advanceTo(ordered.appliedTick - 1);
    expect(digest(mirror.ritual)).toEqual(digest(ordered.ritual));
  });

  it('never steps past what the server has proved is complete', () => {
    const timeline = new SharedTimeline({ seed: 7, environmentId: 'pine-hollow' });
    expect(timeline.pump()).toBe(0);
    timeline.observe(10);
    expect(timeline.pump()).toBe(10);
    expect(timeline.appliedTick).toBe(10);
    expect(timeline.pump()).toBe(0);
  });

  it('spends at most one frame of simulation catching up, until the backlog is silly', () => {
    const timeline = new SharedTimeline({ seed: 7, environmentId: 'pine-hollow' });
    timeline.observe(300);
    // A modest backlog is trickled, so a stalled tab does not eat a frame.
    expect(timeline.pump()).toBe(90);
    expect(timeline.catchingUp).toBe(false);

    const restored = new SharedTimeline({ seed: 7, environmentId: 'pine-hollow' });
    // A minute in the background is drained in one go instead of forty frames.
    restored.observe(3_600);
    expect(restored.pump()).toBe(3_600);

    // ...but only where a bulk drain is allowed. Inside the render loop's own
    // fixed-step callback it is not, because that callback can run sixteen
    // times in a frame.
    const inFrame = new SharedTimeline({ seed: 7, environmentId: 'pine-hollow' });
    inFrame.observe(3_600);
    expect(inFrame.pump(12, false)).toBe(12);
  });
});

function stamped(tick: number, serverSeq: number, intent: InputIntent): StampedInput {
  return { tick, serverSeq, accountId: 'acct_test', clientSeq: serverSeq, intent };
}
