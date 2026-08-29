import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_VERSION } from '@somemore/protocol';
import { bootstrap, key, startTestApi, type TestHarness } from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

describe('anonymous bootstrap', () => {
  it('mints an account, an identity, a passport and a token', async () => {
    const response = await api.request('/v1/auth/anonymous', {
      method: 'POST',
      body: {
        device: { deviceId: 'device-first-0001', platform: 'ios', appVersion: '0.3.0' },
        displayName: 'Rowan',
      },
    });

    expect(response.status).toBe(201);
    expect(response.body.account.anonymous).toBe(true);
    expect(response.body.account.status).toBe('active');
    expect(response.body.identities).toHaveLength(1);
    expect(response.body.identities[0].provider).toBe('anonymous');
    expect(response.body.auth.token).toMatch(/^sm1\./);
    expect(response.headers.get('x-schema-version')).toBe(SCHEMA_VERSION);
    expect(response.headers.get('x-request-id')).toMatch(/^req_/);

    const passport = await api.request('/v1/passport', { token: response.body.auth.token });
    expect(passport.status).toBe(200);
    expect(passport.body.displayName).toBe('Rowan');
  });

  it('returns the same account when the same device bootstraps again', async () => {
    const body = {
      device: { deviceId: 'device-same-00001', platform: 'android', appVersion: '0.3.0' },
    };
    const first = await api.request('/v1/auth/anonymous', { method: 'POST', body });
    const second = await api.request('/v1/auth/anonymous', { method: 'POST', body });
    expect(second.body.account.id).toBe(first.body.account.id);
  });

  it('rejects a malformed bootstrap with a validation envelope', async () => {
    const response = await api.request('/v1/auth/anonymous', {
      method: 'POST',
      body: { device: { deviceId: 'short', platform: 'ios', appVersion: 'nope' } },
    });
    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe('validation_failed');
    expect(response.body.error.requestId).toMatch(/^req_/);
    expect(response.body.error.details.where).toBe('body');
  });
});

describe('token verification', () => {
  it('rejects a missing, malformed or tampered token', async () => {
    const player = await bootstrap(api);

    const missing = await api.request('/v1/passport');
    expect(missing.status).toBe(401);
    expect(missing.body.error.code).toBe('unauthorized');

    const malformed = await api.request('/v1/passport', { token: 'not-a-token' });
    expect(malformed.status).toBe(401);

    const parts = player.token.split('.');
    const tampered = `${parts[0]}.${parts[1]}.${'A'.repeat((parts[2] ?? '').length)}`;
    const forged = await api.request('/v1/passport', { token: tampered });
    expect(forged.status).toBe(401);
  });

  it('rejects an expired token', async () => {
    const player = await bootstrap(api);
    api.clock.advance(31 * 24 * 3_600_000);
    const response = await api.request('/v1/passport', { token: player.token });
    expect(response.status).toBe(401);
    expect(response.body.error.message).toMatch(/expired/i);
  });

  it('returns the session and refreshes a token', async () => {
    const player = await bootstrap(api);
    const me = await api.request('/v1/auth/me', { token: player.token });
    expect(me.status).toBe(200);
    expect(me.body.account.id).toBe(player.accountId);

    api.clock.advance(60_000);
    const refreshed = await api.request('/v1/auth/refresh', { method: 'POST', token: player.token, body: {} });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accountId).toBe(player.accountId);
    const withNew = await api.request('/v1/auth/me', { token: refreshed.body.token });
    expect(withNew.status).toBe(200);
  });
});

describe('magic link', () => {
  it('sends a link through the mailer and hands back a dev token outside production', async () => {
    const response = await api.request('/v1/auth/magic-link', {
      method: 'POST',
      body: { idempotencyKey: key('ml'), email: 'Rowan@Example.com' },
    });
    expect(response.status).toBe(202);
    expect(response.body.sent).toBe(true);
    expect(api.mailer.sent).toHaveLength(1);
    expect(api.mailer.sent[0]?.to).toBe('rowan@example.com');
    expect(response.body.devToken).toBe(api.mailer.lastToken());
  });

  it('rate limits repeated requests for the same address', async () => {
    for (let i = 0; i < 5; i += 1) {
      const ok = await api.request('/v1/auth/magic-link', {
        method: 'POST',
        body: { idempotencyKey: key('ml'), email: 'flood@example.com' },
      });
      expect(ok.status).toBe(202);
    }
    const limited = await api.request('/v1/auth/magic-link', {
      method: 'POST',
      body: { idempotencyKey: key('ml'), email: 'flood@example.com' },
    });
    expect(limited.status).toBe(429);
    expect(limited.body.error.code).toBe('rate_limited');
    expect(limited.headers.get('retry-after')).not.toBeNull();
  });
});

describe('routing errors', () => {
  it('404s an unknown path and 405s a known path with the wrong method', async () => {
    const missing = await api.request('/v1/nope');
    expect(missing.status).toBe(404);
    expect(missing.body.error.code).toBe('not_found');

    const wrongMethod = await api.request('/v1/passport', { method: 'DELETE' });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.get('allow')).toContain('GET');
  });

  it('rejects non-JSON bodies and raw card data', async () => {
    const player = await bootstrap(api);
    const badJson = await api.request('/v1/passport', {
      method: 'PATCH',
      token: player.token,
      rawBody: '{not json',
    });
    expect(badJson.status).toBe(400);
    expect(badJson.body.error.code).toBe('bad_request');

    const cardData = await api.request('/v1/passport', {
      method: 'PATCH',
      token: player.token,
      body: { displayName: 'Rowan', cardNumber: '4242424242424242', cvc: '123' },
    });
    expect(cardData.status).toBe(400);
    expect(cardData.body.error.code).toBe('raw_card_data_rejected');
  });

  it('reports capabilities at /v1/meta', async () => {
    const meta = await api.request('/v1/meta');
    expect(meta.status).toBe(200);
    expect(meta.body.schemaVersion).toBe(SCHEMA_VERSION);
    expect(meta.body.paymentProvider).toBe('fake');
    expect(meta.body.persistence).toBe('memory');
  });
});
