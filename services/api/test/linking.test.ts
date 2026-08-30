import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, sandwichPayload, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  // Apple/Google id tokens cannot be verified without issuer credentials
  // (README Blocker 5), so the service refuses them unless a deployment opts
  // in. These cases are about what linking *does*, so they opt in.
  api = await startTestApi({ AUTH_ALLOW_UNVERIFIED_OIDC: 'true' });
});

afterEach(async () => {
  await api.close();
});

async function magicToken(email: string): Promise<string> {
  const response = await api.request('/v1/auth/magic-link', {
    method: 'POST',
    body: { idempotencyKey: key('ml'), email },
  });
  expect(response.status).toBe(202);
  return response.body.devToken as string;
}

function googleIdToken(sub: string, email?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify(email === undefined ? { sub } : { sub, email })).toString('base64url');
  return `${header}.${payload}.signature-not-verified-in-dev`;
}

describe('linking a durable identity', () => {
  it('attaches email to an anonymous account without losing progress', async () => {
    const player = await bootstrap(api, 'Rowan');
    const campsite = await createCampsite(api, player);
    await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });

    const token = await magicToken('rowan@example.com');
    const linked = await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: token } },
    });

    expect(linked.status).toBe(200);
    expect(linked.body.status).toBe('linked');
    expect(linked.body.identity.provider).toBe('email');
    expect(linked.body.identity.emailVerified).toBe(true);

    const me = await api.request('/v1/auth/me', { token: player.token });
    expect(me.body.account.anonymous).toBe(false);
    expect(me.body.identities.map((i: any) => i.provider).sort()).toEqual(['anonymous', 'email']);

    const sandwiches = await api.request('/v1/sandwiches', { token: player.token });
    expect(sandwiches.body.items).toHaveLength(1);
  });

  it('is a no-op when the same identity is presented twice', async () => {
    const player = await bootstrap(api);
    const first = await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'google', idToken: googleIdToken('google-sub-1'), nonce: 'nonce-abcdefgh' },
      },
    });
    expect(first.body.status).toBe('linked');

    const again = await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'google', idToken: googleIdToken('google-sub-1'), nonce: 'nonce-abcdefgh' },
      },
    });
    expect(again.status).toBe(200);
    expect(again.body.status).toBe('already_linked');
  });

  it('reports a provider_already_linked conflict for a second identity from the same provider', async () => {
    const player = await bootstrap(api);
    await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'google', idToken: googleIdToken('google-sub-a'), nonce: 'nonce-abcdefgh' },
      },
    });
    const second = await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'google', idToken: googleIdToken('google-sub-b'), nonce: 'nonce-abcdefgh' },
      },
    });
    expect(second.status).toBe(409);
    expect(second.body.status).toBe('conflict');
    expect(second.body.conflict).toBe('provider_already_linked');
    expect(second.body.resolutions).toEqual([]);
  });

  it('rejects a used or expired magic link', async () => {
    const player = await bootstrap(api);
    const token = await magicToken('single@example.com');
    const first = await api.request('/v1/auth/link', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: token } },
    });
    expect(first.body.status).toBe('linked');

    const other = await bootstrap(api);
    const reuse = await api.request('/v1/auth/link', {
      method: 'POST',
      token: other.token,
      body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: token } },
    });
    expect(reuse.status).toBe(401);

    const expiring = await magicToken('slow@example.com');
    api.clock.advance(16 * 60 * 1000);
    const expired = await api.request('/v1/auth/link', {
      method: 'POST',
      token: other.token,
      body: { idempotencyKey: key('link'), credential: { provider: 'email', magicLinkToken: expiring } },
    });
    expect(expired.status).toBe(401);
    expect(expired.body.error.message).toMatch(/expired/i);
  });
});

describe('the merge conflict', () => {
  it('aborts by default, then merges the whole account on retry, losing nothing', async () => {
    // The plane: an established account, already signed in with email.
    const established = await bootstrap(api, 'Rowan');
    const oldCampsite = await createCampsite(api, established, { name: 'Old Fire' });
    for (let i = 0; i < 2; i += 1) {
      const made = await api.request('/v1/sandwiches', {
        method: 'POST',
        token: established.token,
        body: sandwichPayload(oldCampsite.id, oldCampsite.machine.serialNumber),
      });
      expect(made.status).toBe(201);
    }
    const linked = await api.request('/v1/auth/link', {
      method: 'POST',
      token: established.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'email', magicLinkToken: await magicToken('rowan@example.com') },
      },
    });
    expect(linked.body.status).toBe('linked');

    // The couch: a fresh anonymous account with a week of progress on it.
    const couch = await bootstrap(api, 'Couch Rowan');
    const newCampsite = await createCampsite(api, couch, { name: 'Couch Fire' });
    const couchSandwich = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: couch.token,
      body: sandwichPayload(newCampsite.id, newCampsite.machine.serialNumber),
    });
    expect(couchSandwich.status).toBe(201);

    // Signing in with the same email must NOT silently pick a side.
    const conflict = await api.request('/v1/auth/link', {
      method: 'POST',
      token: couch.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'email', magicLinkToken: await magicToken('rowan@example.com') },
      },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.status).toBe('conflict');
    expect(conflict.body.conflict).toBe('identity_owned_by_other_account');
    expect(conflict.body.currentAccountId).toBe(couch.accountId);
    expect(conflict.body.existingAccountId).toBe(established.accountId);
    expect(conflict.body.resolutions).toEqual(['keep_existing', 'keep_current']);
    expect(conflict.body.preview.current.sandwiches).toBe(1);
    expect(conflict.body.preview.existing.sandwiches).toBe(2);

    // Nothing changed on either account yet.
    expect((await api.request('/v1/sandwiches', { token: couch.token })).body.items).toHaveLength(1);

    // The player chooses: keep the account that already owns the email.
    const merged = await api.request('/v1/auth/link', {
      method: 'POST',
      token: couch.token,
      body: {
        idempotencyKey: key('link'),
        mergePolicy: 'keep_existing',
        credential: { provider: 'email', magicLinkToken: await magicToken('rowan@example.com') },
      },
    });
    expect(merged.status).toBe(200);
    expect(merged.body.status).toBe('merged');
    expect(merged.body.accountId).toBe(established.accountId);
    expect(merged.body.report.survivingAccountId).toBe(established.accountId);
    expect(merged.body.report.mergedAccountId).toBe(couch.accountId);
    expect(merged.body.report.moved.sandwiches).toBe(1);
    expect(merged.body.report.moved.campsites).toBe(1);
    expect(merged.body.report.moved.identities).toBe(1);
    expect(merged.body.report.resolutions.some((r: any) => r.field === 'displayName')).toBe(true);

    // Every sandwich from both sides now lives on one account.
    const survivingToken = merged.body.auth.token as string;
    const allSandwiches = await api.request('/v1/sandwiches', { token: survivingToken });
    expect(allSandwiches.body.items).toHaveLength(3);

    const campsites = await api.request('/v1/campsites', { token: survivingToken });
    expect(campsites.body.items.map((c: any) => c.name).sort()).toEqual(['Couch Fire', 'Old Fire']);
    for (const campsite of campsites.body.items) {
      expect(campsite.ownerAccountId).toBe(established.accountId);
    }

    const passport = await api.request('/v1/passport', { token: survivingToken });
    expect(passport.body.stats.sandwichesMade).toBe(3);
    expect(passport.body.visitedCampsites).toHaveLength(2);

    // The absorbed account's old token still resolves, to the surviving account.
    const oldTokenSession = await api.request('/v1/auth/me', { token: couch.token });
    expect(oldTokenSession.status).toBe(200);
    expect(oldTokenSession.body.account.id).toBe(established.accountId);
  });

  it('can instead keep the current account and absorb the other one', async () => {
    const first = await bootstrap(api, 'First');
    await createCampsite(api, first, { name: 'First Fire' });
    await api.request('/v1/auth/link', {
      method: 'POST',
      token: first.token,
      body: {
        idempotencyKey: key('link'),
        credential: { provider: 'apple', identityToken: 'opaque-apple-token-1', nonce: 'nonce-abcdefgh' },
      },
    });

    const second = await bootstrap(api, 'Second');
    await createCampsite(api, second, { name: 'Second Fire' });
    const merged = await api.request('/v1/auth/link', {
      method: 'POST',
      token: second.token,
      body: {
        idempotencyKey: key('link'),
        mergePolicy: 'keep_current',
        credential: { provider: 'apple', identityToken: 'opaque-apple-token-1', nonce: 'nonce-abcdefgh' },
      },
    });

    expect(merged.body.status).toBe('merged');
    expect(merged.body.accountId).toBe(second.accountId);
    expect(merged.body.report.mergedAccountId).toBe(first.accountId);

    const campsites = await api.request('/v1/campsites', { token: second.token });
    expect(campsites.body.items).toHaveLength(2);
    const firstSession = await api.request('/v1/auth/me', { token: first.token });
    expect(firstSession.body.account.id).toBe(second.accountId);
  });
});
