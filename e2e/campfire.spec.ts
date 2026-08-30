import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { sampleRenderer } from './instrument.js';
import { SHOTS } from './helpers.js';
import { STATIC_BUDGETS } from '../tools/budgets.mjs';

/**
 * Two browsers, one campfire.
 *
 * Every other test in this suite proves something about one client. This one
 * exists because two people at a fire is a claim no single-client test can
 * make, and because it is a *picture*: the question "does the campsite feel
 * like a place with somebody else in it" is answered by looking, which is why
 * this file captures screenshots rather than only asserting.
 *
 * The service is real. A `node:http` API with the realtime transport attached
 * is started on its own port, two accounts are bootstrapped through the actual
 * HTTP routes, an invite is actually redeemed, and each browser opens an
 * actual WebSocket. Nothing here is stubbed.
 *
 * The two pages arrive by link, which is the only way to arrive: there is no
 * lobby (spec §9), so a shared fire is a URL somebody sends you.
 */

const API_PORT = 8791;
const API_ORIGIN = `http://127.0.0.1:${API_PORT}`;
const WS_URL = `ws://127.0.0.1:${API_PORT}/v1/realtime`;

/**
 * This spec serves the built client itself, on its own port.
 *
 * The shared `webServer` in the config is started with `reuseExistingServer`,
 * which is right for every other project and wrong for this one: a preview
 * somebody else started can be stopped and rebuilt underneath a run, and a
 * two-browser test that takes two minutes is long enough for that to happen.
 * It happened twice. Its own server is a few seconds of start-up in exchange
 * for a result that means something.
 */
const WEB_PORT = 4179;
const WEB_ORIGIN = `http://127.0.0.1:${WEB_PORT}`;

let api: ChildProcess | null = null;
let web: ChildProcess | null = null;
/**
 * Every context this spec opens.
 *
 * Closed in `afterEach` rather than at the end of each test: a test that fails
 * half way leaves its browsers open otherwise, and Chromium throttles the
 * animation frames of pages that are not in front — so the leaked pages of one
 * failed test are why the *next* one never leaves the trail. That cascade cost
 * an hour, and is exactly the kind of thing that makes a suite look flaky when
 * it is not.
 */
const contexts: BrowserContext[] = [];
/** Uncaught page exceptions, per page, so a stalled render loop can be named. */
const pageFailures = new WeakMap<Page, string[]>();

/**
 * The bit of the simulation this spec reads.
 *
 * A type alias rather than a helper, because everything inside `page.evaluate`
 * runs in the browser and cannot reach a function defined out here — only
 * types, which are gone by then.
 */
type PageRitual = {
  seed: number;
  stage: string;
  tick: number;
  fire: { flame: number; logs: unknown[] };
};

interface Player {
  accountId: string;
  token: string;
}

async function call(
  path: string,
  options: { method?: string; token?: string; body?: unknown } = {},
): Promise<{ status: number; body: any }> {
  const response = await fetch(`${API_ORIGIN}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      'content-type': 'application/json',
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
  const text = await response.text();
  return { status: response.status, body: text.length > 0 ? JSON.parse(text) : undefined };
}

function key(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2)}-${Date.now()}`;
}

async function bootstrapPlayer(name: string): Promise<Player> {
  const response = await call('/v1/auth/anonymous', {
    method: 'POST',
    body: {
      device: { deviceId: `device-${key('d')}`, platform: 'web', appVersion: '0.3.0', locale: 'en-GB' },
      displayName: name,
    },
  });
  if (response.status !== 201) throw new Error(`bootstrap failed: ${JSON.stringify(response.body)}`);
  return { accountId: response.body.account.id, token: response.body.auth.token };
}

test.beforeAll(async () => {
  api = spawn(
    process.execPath,
    ['--experimental-strip-types', '--import', './dev/ts-extensions.mjs', 'src/main.ts'],
    {
      cwd: resolve(process.cwd(), 'services/api'),
      env: { ...process.env, PORT: String(API_PORT), LOG_LEVEL: 'warn' },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  api.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[api] ${chunk.toString()}`));

  web = spawn('npm', ['run', 'preview', '--workspace', '@somemore/web', '--', '--port', String(WEB_PORT)], {
    cwd: process.cwd(),
    env: { ...process.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  web.stderr?.on('data', (chunk: Buffer) => process.stderr.write(`[web] ${chunk.toString()}`));

  await waitForUp(`${API_ORIGIN}/v1/meta`, 'the API');
  await waitForUp(`${WEB_ORIGIN}/`, 'the client');
});

async function waitForUp(url: string, what: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`${what} never came up at ${url}`);
    await new Promise((done) => setTimeout(done, 250));
  }
}

test.afterEach(async () => {
  for (const context of contexts.splice(0, contexts.length)) {
    await context.close().catch(() => undefined);
  }
});

test.afterAll(() => {
  api?.kill('SIGTERM');
  api = null;
  web?.kill('SIGTERM');
  web = null;
});

/** A host with a campsite and an open session, and an invite for a friend. */
async function openACampfire(): Promise<{
  host: Player;
  guest: Player;
  sessionId: string;
  campsiteId: string;
  seed: number;
}> {
  const host = await bootstrapPlayer('Host');
  const campsite = await call('/v1/campsites', {
    method: 'POST',
    token: host.token,
    body: { idempotencyKey: key('camp'), name: 'Pine Hollow', environmentId: 'pine_hollow' },
  });
  expect(campsite.status, JSON.stringify(campsite.body)).toBe(201);

  const invite = await call(`/v1/campsites/${campsite.body.id}/invites`, {
    method: 'POST',
    token: host.token,
    body: { idempotencyKey: key('inv'), grantsRole: 'guest', maxUses: 20 },
  });
  expect(invite.status).toBe(201);
  const inviteToken = (invite.body.invite ?? invite.body).token as string;

  const guest = await bootstrapPlayer('Guest');
  const joined = await call('/v1/campsites/join', {
    method: 'POST',
    token: guest.token,
    body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: inviteToken } },
  });
  expect([200, 201]).toContain(joined.status);

  const session = await call(`/v1/campsites/${campsite.body.id}/sessions`, {
    method: 'POST',
    token: host.token,
    body: { idempotencyKey: key('ses') },
  });
  expect(session.status, JSON.stringify(session.body)).toBe(201);

  return {
    host,
    guest,
    sessionId: session.body.id,
    campsiteId: campsite.body.id,
    seed: campsite.body.seed,
  };
}

/** Walk a browser down the link and wait until it is at the fire. */
async function walkIn(browser: Browser, player: Player, sessionId: string): Promise<Page> {
  const context = await browser.newContext();
  contexts.push(context);
  const page = await context.newPage();
  /*
   * Collected rather than thrown from the listener.
   *
   * A throw inside a `pageerror` handler goes nowhere useful — the test still
   * fails, but on whatever it was waiting for, with no mention of the
   * exception that actually stopped the render loop. An error in `useFrame`
   * unmounts the canvas and the page simply stops advancing, which looks
   * exactly like a slow machine.
   */
  const failures: string[] = [];
  pageFailures.set(page, failures);
  page.on('pageerror', (error) => failures.push(error.message));
  const url = `${WEB_ORIGIN}/?fire=${encodeURIComponent(sessionId)}&token=${encodeURIComponent(player.token)}&ws=${encodeURIComponent(WS_URL)}`;
  await page.goto(url);
  await page.waitForFunction(() => window.__someMore?.campfire?.joined === true, undefined, { timeout: 30_000 });
  /*
   * Out of the trees and into the clearing, so the camera is at the fire.
   *
   * `bringToFront` first, and it is not incidental: Chromium throttles a
   * background tab's animation frames to nothing, and the client advances the
   * simulation and publishes the ritual stage from inside its render loop. A
   * page that has never been in front never leaves the trail, and the first
   * screenshot this spec ever took was of a title card for exactly that
   * reason. Anything that needs a frame to have run needs the page in front.
   */
  await page.bringToFront();
  await page.evaluate(() => window.__someMore!.actions['arrive']!());
  try {
    /*
     * The ritual's own stage, not the store's copy of it.
     *
     * `arrive` mutates the simulation synchronously; the store's `stage` is
     * published from inside the render loop, and a headless Chromium page that
     * has just been brought to the front does not always have its animation
     * frames back yet. Waiting on the copy made this spec look flaky when the
     * only thing that was slow was the browser. `awaitFrames` is where the
     * loop is actually required to be running.
     */
    await page.waitForFunction(
      () => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.stage !== 'arriving',
      undefined,
      { timeout: 15_000 },
    );
  } catch (error) {
    const failures = pageFailures.get(page) ?? [];
    throw new Error(
      `never left the trail after arriving.${failures.length > 0 ? ` Page errors: ${failures.join(' | ')}` : ' No page errors were reported.'}`,
      { cause: error },
    );
  }
  return page;
}

/**
 * Wait until the page is genuinely rendering again.
 *
 * The shared tick only advances when the frame loop runs, so this is the one
 * honest test for "is this page alive" — and everything that takes a picture
 * needs it to be true.
 */
async function awaitFrames(page: Page): Promise<void> {
  await page.bringToFront();
  const before = await page.evaluate(
    () => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.tick,
  );
  await page.waitForFunction(
    (start) => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.tick > (start as number),
    before,
    { timeout: 20_000 },
  );
}

/** Turn the local player to look at somebody. A person looking at a person. */
async function lookAt(page: Page, accountId: string): Promise<void> {
  await page.bringToFront();
  await page.evaluate((id) => {
    const fire = window.__someMore!.campfire!;
    const player = window.__someMore!.player!;
    const them = fire.roster.get(id);
    if (them === null) return;
    player.facing = Math.atan2(them.position.z - player.position.z, them.position.x - player.position.x);
    player.pitch = -0.06;
  }, accountId);
  await page.waitForTimeout(500);
}

/**
 * Stand back far enough that the fire and the other person are both in shot.
 *
 * Not a camera trick: the player walks to a spot on the far side of the ring
 * and looks across it, which is what somebody does when they want to see who
 * they are sitting with. Two people at one fire is a *picture*, and a picture
 * with only one of the two things in it proves nothing.
 */
async function framePortrait(page: Page, accountId: string): Promise<number> {
  await awaitFrames(page);
  const separation = await page.evaluate((id) => {
    const fire = window.__someMore!.campfire!;
    const player = window.__someMore!.player!;
    const them = fire.roster.get(id);
    if (them === null) return 0;
    /*
     * Stand on the far side of the fire from them, far enough back that they
     * are a person rather than a wall.
     *
     * The first version stood a fixed 2.6 m from the fire on the opposite
     * bearing, which is fine until the other person is *near* the fire — then
     * "opposite them" is barely a metre from where they are standing, and the
     * screenshot is the inside of somebody's jacket. It was, once. The
     * distance is now measured from them, not from the pit.
     */
    const bearing = Math.atan2(them.position.z, them.position.x);
    const theirs = Math.hypot(them.position.x, them.position.z);
    const back = Math.min(6, Math.max(2.4, 5 - theirs));
    player.position.x = Math.cos(bearing + Math.PI) * back;
    player.position.z = Math.sin(bearing + Math.PI) * back;
    player.moveTarget = null;
    // Looking at them, through the fire, so both are in the shot.
    player.facing = Math.atan2(them.position.z - player.position.z, them.position.x - player.position.x);
    player.pitch = -0.08;
    return Math.hypot(them.position.x - player.position.x, them.position.z - player.position.z);
  }, accountId);
  await page.waitForTimeout(700);
  /*
   * A screenshot taken from inside somebody is not evidence of anything, and
   * the point of this spec is the picture. Fail rather than capture it.
   */
  expect(separation, 'the camera should be looking at a person, not standing in one').toBeGreaterThan(2);
  return separation;
}

/** Wait until presence has brought somebody in off the arrival seat. */
async function settledByTheFire(page: Page, accountId: string): Promise<void> {
  await page.waitForFunction(
    (id) => {
      const them = window.__someMore!.campfire!.roster.get(id as string);
      if (them === null || them.phase !== 'here') return false;
      return Math.hypot(them.position.x, them.position.z) < 3.4;
    },
    accountId,
    { timeout: 40_000 },
  );
}

test.describe('two at the same fire', () => {
  test('shares a campsite, a fire, and a marshmallow', async ({ browser }) => {
    const { host, guest, sessionId, seed } = await openACampfire();

    const one = await walkIn(browser, host, sessionId);
    const two = await walkIn(browser, guest, sessionId);

    // Both rebuilt the same campsite from a seed and a list of intents. Not
    // one patch temperature crossed the wire (ADR-0006).
    for (const page of [one, two]) {
      const world = await page.evaluate(() => ({
        seed: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.seed,
        environmentId: (window.__someMore!.store.state as { environmentId: string }).environmentId,
        joined: window.__someMore!.campfire!.joined,
      }));
      expect(world.seed).toBe(seed);
      expect(world.environmentId).toBe('pine_hollow');
      expect(world.joined).toBe(true);
    }

    // Each sees exactly one other person, and calls them the same thing.
    const namesOne = await one.evaluate(() =>
      window.__someMore!.campfire!.roster.everyone.map((p) => ({ id: p.accountId, name: p.name })),
    );
    const namesTwo = await two.evaluate(() =>
      window.__someMore!.campfire!.roster.everyone.map((p) => ({ id: p.accountId, name: p.name })),
    );
    expect(namesOne).toHaveLength(1);
    expect(namesTwo).toHaveLength(1);
    expect(namesOne[0]!.id).toBe(guest.accountId);
    expect(namesTwo[0]!.id).toBe(host.accountId);

    /*
     * The arrival. The guest is on a trail, not at the fire, and only becomes
     * legible part way down it — which is what `silhouetteAtMs` is for. Wait
     * the walk out rather than skipping it: it is the join, and a screenshot
     * taken before it finishes is a screenshot of an empty clearing.
     */
    await one.waitForFunction(
      (id) => (window.__someMore!.campfire!.roster.get(id as string)?.phase ?? '') === 'here',
      guest.accountId,
      { timeout: 30_000 },
    );
    await two.waitForFunction(
      (id) => (window.__someMore!.campfire!.roster.get(id as string)?.phase ?? '') === 'here',
      host.accountId,
      { timeout: 30_000 },
    );

    // Presence brings them in off the arrival seat and up to the fire; only
    // then is there a picture of two people at one fire to take.
    await settledByTheFire(one, guest.accountId);
    await settledByTheFire(two, host.accountId);

    await framePortrait(one, guest.accountId);
    await one.screenshot({ path: `${SHOTS}/campfire-two-players-host-view.png` });
    await framePortrait(two, host.accountId);
    await two.screenshot({ path: `${SHOTS}/campfire-two-players-guest-view.png` });

    await lookAt(one, guest.accountId);
    await one.screenshot({ path: `${SHOTS}/campfire-close.png` });

    // Somebody else is genuinely drawn: a group of meshes with a name over it.
    const drawn = await one.evaluate(() => {
      const three = window.__someMore!.three as { scene: { getObjectByName(name: string): unknown } } | undefined;
      const root = three?.scene.getObjectByName('campfire-people') as
        | { children: { visible: boolean; position: { x: number; y: number; z: number }; children: unknown[] }[] }
        | undefined;
      if (root === undefined) return null;
      const visible = root.children.filter((child) => child.visible);
      return visible.map((child) => ({
        x: Number(child.position.x.toFixed(3)),
        y: Number(child.position.y.toFixed(3)),
        z: Number(child.position.z.toFixed(3)),
        parts: child.children.length,
      }));
    });
    expect(drawn).not.toBeNull();
    expect(drawn!).toHaveLength(1);
    const them = drawn![0]!;
    // Standing on the ground, at the fire, and *not inside the fire pit* —
    // which is exactly the sort of defect a green unit suite cannot see.
    expect(Math.hypot(them.x, them.z)).toBeGreaterThan(0.9);
    expect(Math.hypot(them.x, them.z)).toBeLessThan(14);
    expect(Math.abs(them.y)).toBeLessThan(1.2);

    /*
     * The fire is shared. The host puts a log on; the guest's fire — a
     * different simulation, in a different browser, in a different process —
     * has that log in it, because the intent travelled and both replayed it.
     */
    const logsBefore = await two.evaluate(() => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.fire.logs.length);
    await one.evaluate(() => window.__someMore!.campfire!.tendFire({ type: 'add-log', woodId: 'oak', placement: 0.8 }));
    await two.waitForFunction(
      (before) => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.fire.logs.length > (before as number),
      logsBefore,
      { timeout: 15_000 },
    );

    // And the other way, with an action that needs no permission at all.
    await two.evaluate(() => window.__someMore!.campfire!.tendFire({ type: 'rake' }));
    await one.waitForTimeout(600);

    /*
     * The marshmallow. The host picks it up; the guest cannot take it out of
     * their hands, because the protocol has no verb for that and the shared
     * rule refuses it before a message is even sent (spec §9).
     */
    await one.evaluate(() => window.__someMore!.campfire!.beginRoast());
    await two.waitForFunction(
      (id) => window.__someMore!.campfire!.authority.holderOf('obj_marshmallow_1') === (id as string),
      host.accountId,
      { timeout: 15_000 },
    );
    const refusal = await two.evaluate(() =>
      window.__someMore!.campfire!.authority.wouldDeny({
        objectId: 'obj_marshmallow_1',
        objectKind: 'marshmallow',
        reason: 'grab',
        toAccountId: null,
      }),
    );
    expect(refusal).toBe('not_holder');

    // Held out, taken, and carried across rather than teleported: for the
    // length of the mutual hold both of them have a hand on it.
    await one.evaluate(
      (id) => window.__someMore!.campfire!.offer('obj_marshmallow_1', 'marshmallow', id as string),
      guest.accountId,
    );
    await two.waitForFunction(
      (id) => window.__someMore!.campfire!.authority.holderOf('obj_marshmallow_1') === (id as string),
      guest.accountId,
      { timeout: 15_000 },
    );
    // `lastHold` rather than `hold`: the mutual window is a quarter of a
    // second and is swept the moment it closes, which is right — but a test
    // that polls cannot be looking at that exact instant.
    const hold = await two.evaluate(() => {
      const authority = window.__someMore!.campfire!.authority;
      const held = authority.lastHold;
      if (held === null || held === undefined) return null;
      return {
        drivers: [...authority.drivers('obj_marshmallow_1', held.startedTick)],
        span: held.untilTick - held.startedTick,
        progress: authority.handoffProgress('obj_marshmallow_1', held.startedTick),
      };
    });
    expect(hold).not.toBeNull();
    expect(hold!.drivers.sort()).toEqual([host.accountId, guest.accountId].sort());
    expect(hold!.span).toBeGreaterThan(0);
    expect(hold!.progress).toBe(0);

    await one.bringToFront();
    await one.screenshot({ path: `${SHOTS}/campfire-handoff.png` });

    /*
     * Saying something, and being heard. Voice is not configured in this
     * deployment, so the service says so and the fire carries on with text and
     * gesture — which is the path §12 requires to exist anyway.
     */
    const voice = await one.evaluate(() => ({
      status: window.__someMore!.campfire!.voice.status,
      recording: window.__someMore!.campfire!.voice.recording,
      reason: window.__someMore!.campfire!.voice.reason,
    }));
    expect(voice.recording).toBe(false);
    expect(['idle', 'text_and_gesture']).toContain(voice.status);

    await one.evaluate(() => window.__someMore!.campfire!.say('pull up a log'));
    await two.waitForFunction(
      () => window.__someMore!.campfire!.chat.some((line) => line.text === 'pull up a log'),
      undefined,
      { timeout: 15_000 },
    );
    await two.evaluate(() => window.__someMore!.campfire!.gesture('wave', null));
    await one.waitForFunction(
      () => window.__someMore!.campfire!.gestures.some((g) => g.gesture === 'wave'),
      undefined,
      { timeout: 15_000 },
    );

    // The panel: reachable with a key, and it says who is here in words.
    await one.bringToFront();
    await one.keyboard.press('k');
    await expect(one.getByRole('dialog', { name: 'At the fire' })).toBeVisible();
    await expect(
      one.getByRole('dialog', { name: 'At the fire' }).getByText(namesOne[0]!.name, { exact: true }),
    ).toBeVisible();
    await one.screenshot({ path: `${SHOTS}/campfire-panel.png` });
    await one.keyboard.press('Escape');

    /*
     * Leaving is walking off, not vanishing. The guest departs; the host sees
     * them on the trail for a few seconds before the trees take them.
     */
    await two.evaluate(() => window.__someMore!.campfire!.depart('walk_off'));
    await one.waitForFunction(
      (id) => (window.__someMore!.campfire!.roster.get(id as string)?.phase ?? 'gone') === 'leaving',
      guest.accountId,
      { timeout: 15_000 },
    );
    await lookAt(one, guest.accountId);
    await one.screenshot({ path: `${SHOTS}/campfire-departure.png` });
    await one.waitForFunction(
      (id) => window.__someMore!.campfire!.roster.get(id as string) === null,
      guest.accountId,
      { timeout: 30_000 },
    );

    // The host is alone at their own fire, and the fire is still lit.
    const after = await one.evaluate(() => ({
      people: window.__someMore!.campfire!.roster.visible.length,
      flame: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.fire.flame,
      joined: window.__someMore!.campfire!.joined,
    }));
    expect(after.people).toBe(0);
    expect(after.flame).toBeGreaterThan(0);
    expect(after.joined).toBe(true);

  });

  test('stays inside the render budget with somebody else at the fire', async ({ browser }) => {
    const { host, guest, sessionId } = await openACampfire();
    const one = await walkIn(browser, host, sessionId);
    const two = await walkIn(browser, guest, sessionId);
    await one.waitForFunction(
      (id) => (window.__someMore!.campfire!.roster.get(id as string)?.phase ?? '') === 'here',
      guest.accountId,
      { timeout: 30_000 },
    );

    // A busy fire, the whole campsite in shot, and the other person in it.
    // Framed from across the ring rather than from the player's arrival spot:
    // a camera pointed away from the campsite culls most of it, and a budget
    // measured on a nearly empty frustum is not a budget measurement.
    await settledByTheFire(one, guest.accountId);
    await one.evaluate(() => {
      const actions = window.__someMore!.actions;
      for (let i = 0; i < 3; i += 1) actions['addLog']!('oak' as never);
      actions['rake']!();
    });
    await framePortrait(one, guest.accountId);

    let worst = await sampleRenderer(one, 'campfire-two-players', 12);
    for (let sweep = 0; sweep < 5; sweep += 1) {
      await one.evaluate(() => window.__someMore!.actions['advanceSeconds']!(4 as never));
      const sample = await sampleRenderer(one, 'campfire-two-players', 12);
      if (sample.drawCalls > worst.drawCalls) worst = sample;
    }
    console.log(
      `  two at the fire: ${worst.drawCalls} draw calls, ${worst.triangles} triangles, ${worst.dynamicLights} dynamic lights`,
    );

    expect(worst.drawCalls).toBeLessThanOrEqual(STATIC_BUDGETS.drawCalls);
    expect(worst.triangles).toBeLessThanOrEqual(STATIC_BUDGETS.triangles);
    /*
     * The one that matters. ARCHITECTURE §10 allows six dynamic lights in the
     * explorable world and the empty campsite already spends four. A remote
     * player is drawn with emissive geometry and an additive glow rather than
     * a light of their own, so four people at a fire cost the budget nothing —
     * see the note at the top of `scene/Campfire.tsx`.
     */
    expect(worst.dynamicLights).toBeLessThanOrEqual(STATIC_BUDGETS.dynamicLights);

  });

  test('carries on alone when the service goes away mid-roast', async ({ browser }) => {
    const { host, guest, sessionId } = await openACampfire();
    const one = await walkIn(browser, host, sessionId);
    const two = await walkIn(browser, guest, sessionId);
    await one.waitForFunction(
      (id) => (window.__someMore!.campfire!.roster.get(id as string)?.phase ?? '') === 'here',
      guest.accountId,
      { timeout: 30_000 },
    );

    await one.evaluate(() => window.__someMore!.campfire!.beginRoast());
    await one.waitForFunction(() => (window.__someMore!.store.state as { ritual: PageRitual }).ritual.stage === 'roasting', undefined, {
      timeout: 15_000,
    });

    // The guest's browser loses the socket. Nothing else about their night
    // changes: the fire is still burning, the marshmallow is still there, and
    // the page does not reload (ARCHITECTURE §1.5).
    const before = await two.evaluate(() => ({
      stage: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.stage,
      tick: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.tick,
    }));
    await two.evaluate(() => window.__someMore!.campfire!.transport!.dispose());
    await two.bringToFront();
    await two.waitForTimeout(1_500);
    const after = await two.evaluate(() => ({
      stage: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.stage,
      joined: window.__someMore!.campfire!.joined,
      tick: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.tick,
      flame: (window.__someMore!.store.state as { ritual: PageRitual }).ritual.fire.flame,
    }));
    expect(after.joined).toBe(false);
    expect(after.stage).toBe(before.stage);
    expect(after.flame).toBeGreaterThan(0);
    await two.screenshot({ path: `${SHOTS}/campfire-alone-again.png` });

  });
});
