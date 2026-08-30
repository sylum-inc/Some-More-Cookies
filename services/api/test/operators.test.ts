import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { OPS_TOKEN_HEADER } from '../src/routes/liveops.js';
import { bootstrap, key, startTestApi, type Player, type TestHarness } from './harness.js';

/**
 * The operator model (README, Blocker 9).
 *
 * What it replaces: one shared secret. Holding `LIVE_OPS_TOKEN` meant you could
 * draft a document, publish it to every player, mint a hundred thousand codes,
 * advance somebody's order and refund it — all the same permission, held by
 * everybody who had the string, with no way to take it back from one person.
 *
 * These are about the *model*: how the first operator is made, that the shared
 * string can no longer do anything else, and that a capability can be taken
 * back from one person. That capabilities actually gate the live-ops and
 * commerce routes is asserted where those routes live.
 */

const OPS_TOKEN = 'bootstrap-token-for-tests-only';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi({ LIVE_OPS_TOKEN: OPS_TOKEN });
});

afterEach(async () => {
  await api.close();
});

function grant(actor: Player, body: unknown, token?: string) {
  return api.request('/v1/operators/grants', {
    method: 'POST',
    token: actor.token,
    ...(token === undefined ? {} : { headers: { [OPS_TOKEN_HEADER]: token } }),
    body,
  });
}

describe('making the first operator', () => {
  it('lets the bootstrap secret appoint somebody, once', async () => {
    const founder = await bootstrap(api, 'Founder');
    const second = await bootstrap(api, 'Second');

    const appointed = await grant(
      founder,
      { idempotencyKey: key('grant'), accountId: founder.accountId, role: 'admin' },
      OPS_TOKEN,
    );
    expect(appointed.status).toBe(201);

    /*
     * And now it is spent. The shared string cannot quietly add a second
     * administrator behind the back of the first — which is the difference
     * between a bootstrap and a standing permission, and the whole reason it is
     * safe to leave the variable set.
     */
    const again = await grant(
      second,
      { idempotencyKey: key('grant'), accountId: second.accountId, role: 'admin' },
      OPS_TOKEN,
    );
    expect(again.status).toBe(403);
    expect(again.body.error.message).toMatch(/already has an operator/i);
  });

  it('refuses a wrong bootstrap token of the same length', async () => {
    // The comparison is constant-time over digests, so neither the value nor
    // its length leaks. This is the same assertion the live-ops suite used to
    // make, moved to the one route the token still opens.
    const player = await bootstrap(api, 'Camper');
    const attempt = await grant(
      player,
      { idempotencyKey: key('grant'), accountId: player.accountId, role: 'admin' },
      `${OPS_TOKEN}Z`.slice(1),
    );
    expect(attempt.status).toBe(403);
  });

  it('refuses an ordinary player with no token at all', async () => {
    const player = await bootstrap(api, 'Camper');
    const attempt = await grant(player, {
      idempotencyKey: key('grant'),
      accountId: player.accountId,
      role: 'admin',
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.message).toContain('operators:grant');
  });

  it('cannot be reached without an account at all', async () => {
    // Two credentials, one of which is a real account, so every appointment is
    // attributable to somebody.
    const attempt = await api.request('/v1/operators/grants', {
      method: 'POST',
      headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
      body: { idempotencyKey: key('grant'), accountId: 'acct_nobody', role: 'admin' },
    });
    expect(attempt.status).toBe(401);
  });
});

describe('holding, and losing, a capability', () => {
  async function founder(): Promise<Player> {
    const player = await bootstrap(api, 'Founder');
    const appointed = await grant(
      player,
      { idempotencyKey: key('grant'), accountId: player.accountId, role: 'admin' },
      OPS_TOKEN,
    );
    expect(appointed.status).toBe(201);
    return player;
  }

  it('tells an account what it may do, and an ordinary player that it may do nothing', async () => {
    const admin = await founder();
    const camper = await bootstrap(api, 'Camper');

    const mine = await api.request('/v1/operators/me', { token: admin.token });
    expect(mine.status).toBe(200);
    expect(mine.body.capabilities).toContain('operators:grant');
    expect(mine.body.capabilities).toContain('codes:mint');

    const theirs = await api.request('/v1/operators/me', { token: camper.token });
    expect(theirs.status).toBe(200);
    expect(theirs.body.capabilities).toEqual([]);
    // The vocabulary is published, so a console does not have to hard-code it.
    expect(theirs.body.available).toContain('content:publish');
    expect(Object.keys(theirs.body.roles)).toContain('editor');
  });

  it('expands a role into capabilities, and grants a list verbatim', async () => {
    const admin = await founder();
    const author = await bootstrap(api, 'Author');
    const oddjob = await bootstrap(api, 'Oddjob');

    await grant(admin, { idempotencyKey: key('g'), accountId: author.accountId, role: 'editor' });
    await grant(admin, {
      idempotencyKey: key('g'),
      accountId: oddjob.accountId,
      capabilities: ['moderation:action'],
    });

    const authorSees = await api.request('/v1/operators/me', { token: author.token });
    expect(authorSees.body.capabilities.sort()).toEqual(['content:draft', 'content:publish']);

    const oddjobSees = await api.request('/v1/operators/me', { token: oddjob.token });
    expect(oddjobSees.body.capabilities).toEqual(['moderation:action']);
  });

  it('takes one capability back from one person and leaves the rest alone', async () => {
    const admin = await founder();
    const editor = await bootstrap(api, 'Editor');
    await grant(admin, { idempotencyKey: key('g'), accountId: editor.accountId, role: 'editor' });

    const revoked = await api.request('/v1/operators/revocations', {
      method: 'POST',
      token: admin.token,
      body: {
        idempotencyKey: key('r'),
        accountId: editor.accountId,
        capabilities: ['content:publish'],
      },
    });
    expect(revoked.status).toBe(200);
    expect(revoked.body.revoked).toBe(1);

    const left = await api.request('/v1/operators/me', { token: editor.token });
    expect(left.body.capabilities, 'revoking one took the other with it').toEqual(['content:draft']);

    // Revoking again is not an error; it is simply nothing left to take.
    const second = await api.request('/v1/operators/revocations', {
      method: 'POST',
      token: admin.token,
      body: {
        idempotencyKey: key('r'),
        accountId: editor.accountId,
        capabilities: ['content:publish'],
      },
    });
    expect(second.body.revoked).toBe(0);
  });

  it('gives a capability back after it was taken away', async () => {
    // A revocation is stored rather than deleted, so re-granting has to clear
    // it rather than leave a live row that says it was withdrawn.
    const admin = await founder();
    const editor = await bootstrap(api, 'Editor');
    await grant(admin, { idempotencyKey: key('g'), accountId: editor.accountId, role: 'editor' });
    await api.request('/v1/operators/revocations', {
      method: 'POST',
      token: admin.token,
      body: { idempotencyKey: key('r'), accountId: editor.accountId, capabilities: ['content:draft'] },
    });
    expect((await api.request('/v1/operators/me', { token: editor.token })).body.capabilities).toEqual([
      'content:publish',
    ]);

    await grant(admin, {
      idempotencyKey: key('g'),
      accountId: editor.accountId,
      capabilities: ['content:draft'],
    });
    const back = await api.request('/v1/operators/me', { token: editor.token });
    expect(back.body.capabilities.sort()).toEqual(['content:draft', 'content:publish']);
  });

  it('refuses to let an operator without operators:grant hand out powers', async () => {
    // The separation applies to the granting itself, or the model has a hole
    // in the middle of it.
    const admin = await founder();
    const editor = await bootstrap(api, 'Editor');
    const friend = await bootstrap(api, 'Friend');
    await grant(admin, { idempotencyKey: key('g'), accountId: editor.accountId, role: 'editor' });

    const attempt = await grant(editor, {
      idempotencyKey: key('g'),
      accountId: friend.accountId,
      role: 'admin',
    });
    expect(attempt.status).toBe(403);
    expect(attempt.body.error.message).toContain('operators:grant');
  });

  it('shows who holds the keys, to somebody who may ask', async () => {
    const admin = await founder();
    const editor = await bootstrap(api, 'Editor');
    await grant(admin, { idempotencyKey: key('g'), accountId: editor.accountId, role: 'editor' });

    const roster = await api.request('/v1/operators', { token: admin.token });
    expect(roster.status).toBe(200);
    const held = roster.body.items.filter((g: { accountId: string }) => g.accountId === editor.accountId);
    expect(held.map((g: { capability: string }) => g.capability).sort()).toEqual([
      'content:draft',
      'content:publish',
    ]);
    // Attributable: every grant records who made it.
    expect(held[0].grantedByAccountId).toBe(admin.accountId);

    const nosy = await api.request('/v1/operators', { token: editor.token });
    expect(nosy.status).toBe(403);
  });
});
