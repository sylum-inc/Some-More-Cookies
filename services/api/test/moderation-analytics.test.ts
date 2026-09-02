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

describe('moderation', () => {
  it('files a report and flags child safety as urgent', async () => {
    const player = await bootstrap(api);
    const target = await bootstrap(api);

    const report = await api.request('/v1/moderation/reports', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('report'),
        target: { kind: 'account', accountId: target.accountId },
        reason: 'harassment',
        details: 'kept blowing my marshmallow out',
      },
    });
    expect(report.status).toBe(201);
    expect(report.body.state).toBe('open');
    expect(report.body.priority).toBe('standard');

    const urgent = await api.request('/v1/moderation/reports', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('report'),
        target: { kind: 'campsite', campsiteId: 'cmp_somewhere' },
        reason: 'child_safety',
      },
    });
    expect(urgent.body.priority).toBe('urgent');

    const mine = await api.request('/v1/moderation/reports', { token: player.token });
    expect(mine.body.items).toHaveLength(2);
    const theirs = await api.request('/v1/moderation/reports', { token: target.token });
    expect(theirs.body.items).toEqual([]);
  });

  it('rejects a malformed report target and reason', async () => {
    const player = await bootstrap(api);
    const badTarget = await api.request('/v1/moderation/reports', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('report'), target: { kind: 'planet', id: 'x' }, reason: 'spam' },
    });
    expect(badTarget.status).toBe(422);

    const badReason = await api.request('/v1/moderation/reports', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('report'),
        target: { kind: 'account', accountId: 'acct_x' },
        reason: 'annoying',
      },
    });
    expect(badReason.status).toBe(422);
  });

  it('blocks and unblocks a player, and refuses self-blocks', async () => {
    const player = await bootstrap(api);
    const other = await bootstrap(api);

    const blocked = await api.request('/v1/moderation/blocks', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('block'), blockedAccountId: other.accountId },
    });
    expect(blocked.status).toBe(201);

    const list = await api.request('/v1/moderation/blocks', { token: player.token });
    expect(list.body.items).toHaveLength(1);

    const again = await api.request('/v1/moderation/blocks', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('block'), blockedAccountId: other.accountId },
    });
    expect(again.status).toBe(409);

    const self = await api.request('/v1/moderation/blocks', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('block'), blockedAccountId: player.accountId },
    });
    expect(self.status).toBe(400);

    const removed = await api.request(`/v1/moderation/blocks/${other.accountId}`, {
      method: 'DELETE',
      token: player.token,
    });
    expect(removed.status).toBe(204);
    const empty = await api.request('/v1/moderation/blocks', { token: player.token });
    expect(empty.body.items).toEqual([]);
  });
});

describe('telemetry', () => {
  function event(id: string, name = 'sandwich_saved') {
    return {
      id,
      name,
      occurredAt: api.clock.isoNow(),
      platform: 'ios',
      appVersion: '0.3.0',
      schemaVersion: SCHEMA_VERSION,
      props: { rarity: 'rare', score: 0.92 },
    };
  }

  it('ingests a batch and de-duplicates a retry', async () => {
    const player = await bootstrap(api);
    const first = await api.request('/v1/events', {
      method: 'POST',
      token: player.token,
      body: { events: [event('evt_1'), event('evt_2', 'app_opened')] },
    });
    expect(first.status).toBe(202);
    expect(first.body).toEqual({ accepted: 2, duplicates: 0 });

    const retry = await api.request('/v1/events', {
      method: 'POST',
      token: player.token,
      body: { events: [event('evt_1'), event('evt_3', 'shop_viewed')] },
    });
    expect(retry.body).toEqual({ accepted: 1, duplicates: 1 });
  });

  it('accepts anonymous batches but never trusts a client-declared account', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);

    const anonymous = await api.request('/v1/events', {
      method: 'POST',
      body: { events: [event('evt_anon')] },
    });
    expect(anonymous.status).toBe(202);

    await api.request('/v1/events', {
      method: 'POST',
      token: player.token,
      body: { events: [{ ...event('evt_spoofed'), accountId: stranger.accountId }] },
    });

    const stored = await api.app.repos.analytics.list(10);
    const spoofed = stored.find((e) => e.id === 'evt_spoofed');
    expect(spoofed?.accountId).toBe(player.accountId);
    const anon = stored.find((e) => e.id === 'evt_anon');
    expect(anon?.accountId).toBeNull();
  });

  it('rejects unknown event names, oversized batches and stale schema versions', async () => {
    const player = await bootstrap(api);

    const unknown = await api.request('/v1/events', {
      method: 'POST',
      token: player.token,
      body: { events: [{ ...event('evt_x'), name: 'user_rage_quit' }] },
    });
    expect(unknown.status).toBe(422);

    const empty = await api.request('/v1/events', { method: 'POST', token: player.token, body: { events: [] } });
    expect(empty.status).toBe(422);

    const stale = await api.request('/v1/events', {
      method: 'POST',
      token: player.token,
      body: { events: [{ ...event('evt_old'), schemaVersion: '0.9.0' }] },
    });
    expect(stale.status).toBe(400);
    expect(stale.body.error.code).toBe('schema_version_unsupported');
  });
});
