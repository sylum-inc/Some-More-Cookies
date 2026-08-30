import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrap, createCampsite, key, sandwichPayload, startTestApi, type TestHarness } from './harness.js';

/*
 * The adversary's file.
 *
 * Everything here was written by attacking the running service rather than by
 * reading it, and every case is an attempt to get something the service says
 * nobody can have: somebody else's account, a second free kit, a rate limit
 * that does not apply to me, a card number in the database.
 *
 * A case that passes is a defence that holds. A case that had to be written as
 * `expect(...).toBe(<the wrong answer>)` would be a claim rather than a
 * defence, so there are none of those: where the service is currently wrong,
 * the assertion states what it must do and the test fails until it does.
 */

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

/** A syntactically perfect, entirely unsigned OIDC id token for any subject. */
function forgeIdToken(subject: string, email?: string): string {
  const b64 = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const claims: Record<string, unknown> = { sub: subject, iss: 'https://accounts.google.com', aud: 'anything' };
  if (email !== undefined) claims['email'] = email;
  return `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64(claims)}.${Buffer.from('not-a-signature').toString('base64url')}`;
}

describe('identity: a token nobody verified is not a credential', () => {
  /*
   * The whole of Sign in with Apple / Google is "the issuer said this is them".
   * `resolveCredentialSubject` reads `sub` out of an *unverified* JWT, so the
   * claim is only ever as strong as whoever typed it — which is anybody.
   */
  it('refuses a link credential this deployment cannot verify', async () => {
    const attacker = await bootstrap(api, 'Attacker');
    const response = await api.request('/v1/auth/link', {
      method: 'POST',
      token: attacker.token,
      body: {
        idempotencyKey: key('link'),
        mergePolicy: 'abort',
        credential: { provider: 'google', idToken: forgeIdToken('victim-google-subject'), nonce: 'nonce-from-the-client' },
      },
    });
    expect(response.status).toBe(503);
    expect(response.body.error.code).toBe('service_not_configured');
    expect(response.body.error.message).toMatch(/GOOGLE_OIDC_CLIENT_ID|not configured/i);
  });

  it('does not let a forged token absorb somebody else’s account', async () => {
    // The victim signs in for real. Their provider subject is not a secret —
    // it appears in every id token their own device has ever handled.
    const victim = await bootstrap(api, 'Victim');
    const campsite = await createCampsite(api, victim);
    const made = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: victim.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });
    expect(made.status).toBe(201);
    await api.request('/v1/auth/link', {
      method: 'POST',
      token: victim.token,
      body: {
        idempotencyKey: key('link'),
        mergePolicy: 'abort',
        credential: { provider: 'google', idToken: forgeIdToken('victim-google-subject'), nonce: 'nonce-from-the-client' },
      },
    });

    const attacker = await bootstrap(api, 'Attacker');
    const takeover = await api.request('/v1/auth/link', {
      method: 'POST',
      token: attacker.token,
      body: {
        idempotencyKey: key('link'),
        // `keep_current` means "absorb the other account into mine".
        mergePolicy: 'keep_current',
        credential: { provider: 'google', idToken: forgeIdToken('victim-google-subject'), nonce: 'nonce-from-the-client' },
      },
    });
    expect(takeover.body.status).not.toBe('merged');

    // Whatever happened above, the victim's sandwich is still the victim's.
    const stolen = await api.request('/v1/sandwiches', { token: attacker.token });
    expect(stolen.body.items).toHaveLength(0);
  });
});

describe('rate limiting: a header is not an identity', () => {
  /*
   * `code_fail:<ipHash>` is the budget that makes working through a scraped
   * list of wrapper codes expensive. The IP it hashes comes from
   * `X-Forwarded-For` with no trusted-proxy configuration, so the client picks
   * its own bucket.
   */
  it('does not let X-Forwarded-For refresh the code failure budget', async () => {
    const player = await bootstrap(api);
    const attempt = (ip: string) =>
      api.request('/v1/codes/redeem', {
        method: 'POST',
        token: player.token,
        headers: { 'x-forwarded-for': ip },
        body: { idempotencyKey: key('scan'), code: 'SM1.not-a-real-code.nope' },
      });

    const statuses: number[] = [];
    for (let i = 0; i < 40; i += 1) statuses.push((await attempt(`203.0.113.${i}`)).status);

    // CODE_FAILURES_PER_WINDOW is 20. Forty guesses from one socket must not
    // all be answered, whatever the client claims its address is.
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(0);
  });
});

describe('rewards: claim-once under concurrency', () => {
  async function settledPlayerWithASandwich() {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const made = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });
    expect(made.status).toBe(201);
    api.clock.advance(3 * 3_600_000);
    return player;
  }

  /*
   * Two requests, two idempotency keys, one player, one legendary perk with
   * `perAccountLimit: 1`. The `held >= perAccountLimit` read cannot decide
   * this — between it and the insert the other request is in flight — so
   * whatever wins has to be the store.
   */
  it('grants a legendary perk once even when two claims race', async () => {
    const player = await settledPlayerWithASandwich();
    const claim = () =>
      api.request('/v1/rewards/claims', {
        method: 'POST',
        token: player.token,
        body: {
          idempotencyKey: key('claim'),
          rewardCode: 'free_kit',
          deviceId: `device-${key('d')}`,
          clientNonce: `nonce-${key('n')}`,
        },
      });

    await Promise.all([claim(), claim()]);

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    const kits = grants.body.items.filter((grant: any) => grant.rewardCode === 'free_kit');
    expect(kits).toHaveLength(1);
  });
});

describe('cards: the API is never in scope for a PAN', () => {
  /*
   * `containsRawCardData` tests a string with `PAN_LIKE` and then re-tests the
   * *whole* string with the Luhn check, so a card number with a word next to
   * it is not a card number. A support note, a delivery instruction and a gift
   * message are all free text.
   */
  it('rejects a card number embedded in a longer string', async () => {
    const player = await bootstrap(api);
    const response = await api.request('/v1/campsites', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('camp'),
        name: 'my card is 4242 4242 4242 4242 thanks',
      },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('raw_card_data_rejected');
  });
});
