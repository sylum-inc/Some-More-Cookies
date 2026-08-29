/**
 * Test rig for the realtime transport.
 *
 * Boots the real HTTP app on an ephemeral port, attaches the real WebSocket
 * transport to it, and drives it with the real hand-written client. Nothing is
 * stubbed except the clock (manual, so ticks and rate-limit windows are exact
 * rather than racy) and the voice provider (there is no SFU in CI).
 */

import type { AddressInfo } from 'node:net';
import { createTokenSigner } from '../src/auth/tokens.js';
import { createLogger } from '../src/logging.js';
import { attachRealtime } from '../src/realtime/index.js';
import { createFakeVoiceRoom, type FakeVoiceRoom } from '../src/realtime/voice.js';
import type { RealtimeHandle } from '../src/realtime/types.js';
import type { RealtimeLimitsConfig } from '../src/realtime/limits.js';
import { HandshakeFailure, RealtimeClient, type RealtimeClientOptions } from '../src/realtime/client.js';
import { REALTIME_PATH, SCHEMA_VERSION } from '@somemore/protocol';
import { bootstrap, createCampsite, key, startTestApi, type Player, type TestHarness } from './harness.js';

export const AUTH_SECRET = 'test-token-secret-do-not-ship';

export interface RealtimeHarness {
  readonly api: TestHarness;
  readonly realtime: RealtimeHandle;
  readonly voice: FakeVoiceRoom;
  readonly wsUrl: string;
  connect(player: Player, options?: Partial<RealtimeClientOptions>): Promise<RealtimeClient>;
  close(): Promise<void>;
}

export async function startRealtimeHarness(
  options: { limits?: Partial<RealtimeLimitsConfig>; env?: Record<string, string> } = {},
): Promise<RealtimeHarness> {
  const api = await startTestApi(options.env ?? {});
  const tokens = createTokenSigner(AUTH_SECRET, api.app.config.authTokenTtlSeconds);
  const voice = createFakeVoiceRoom(api.clock);

  const realtime = attachRealtime(api.app.server, {
    sessions: api.app.services.sessions,
    campsites: api.app.services.campsites,
    blocks: api.app.repos.moderation,
    // Exactly the check the HTTP edge performs: same signer, same account
    // status rule. There is no second auth model for the socket.
    authenticate: async (token, now) => {
      const payload = tokens.verify(token, now);
      const account = await api.app.services.identity.requireActiveAccount(payload.sub);
      return { accountId: account.id };
    },
    clock: api.clock,
    logger: createLogger({ logLevel: 'silent' }),
    voice,
    limits: options.limits,
    // No background timer: tests call `realtime.sweep()` when they mean to.
    sweepIntervalMs: null,
  });

  const address = api.app.server.address() as AddressInfo;
  const wsUrl = `ws://127.0.0.1:${address.port}${REALTIME_PATH}`;

  const clients: RealtimeClient[] = [];

  return {
    api,
    realtime,
    voice,
    wsUrl,

    async connect(player, clientOptions = {}) {
      const client = await RealtimeClient.connect({ url: wsUrl, token: player.token, ...clientOptions });
      clients.push(client);
      return client;
    },

    async close() {
      for (const client of clients) client.terminate();
      await realtime.close();
      // Upgraded sockets are not HTTP requests, so `server.close()` will wait
      // on them forever unless they are dropped first.
      api.app.server.closeAllConnections();
      await api.close();
    },
  };
}

/**
 * Two friends and a fire: a host who owns the campsite and a guest who has
 * already redeemed an invite, plus an unused invite and camp code for the
 * privacy tests.
 */
export async function fireside(api: TestHarness) {
  const host = await bootstrap(api, 'Host');
  const campsite = await createCampsite(api, host);

  const inviteResponse = await api.request(`/v1/campsites/${campsite.id}/invites`, {
    method: 'POST',
    token: host.token,
    body: { idempotencyKey: key('inv'), grantsRole: 'guest', maxUses: 20 },
  });
  const invite = inviteResponse.body.invite ?? inviteResponse.body;

  const guest = await bootstrap(api, 'Guest');
  const guestJoin = await api.request('/v1/campsites/join', {
    method: 'POST',
    token: guest.token,
    body: { idempotencyKey: key('join'), join: { method: 'invite_link', token: invite.token } },
  });
  if (guestJoin.status !== 200 && guestJoin.status !== 201) {
    throw new Error(`guest join failed: ${JSON.stringify(guestJoin.body)}`);
  }

  const sessionResponse = await api.request(`/v1/campsites/${campsite.id}/sessions`, {
    method: 'POST',
    token: host.token,
    body: { idempotencyKey: key('ses') },
  });
  if (sessionResponse.status !== 201) throw new Error(`session create failed: ${JSON.stringify(sessionResponse.body)}`);

  return {
    host,
    guest,
    campsite,
    invite,
    session: sessionResponse.body,
    /** A fresh invite for somebody who has never been here. */
    async newInvite(role: 'guest' | 'viewer' | 'cohost' = 'guest') {
      const response = await api.request(`/v1/campsites/${campsite.id}/invites`, {
        method: 'POST',
        token: host.token,
        body: { idempotencyKey: key('inv'), grantsRole: role, maxUses: 20 },
      });
      return response.body.invite ?? response.body;
    },
  };
}

/** The `join` message body every test starts with. */
export function joinMessage(sessionId: string, extra: Record<string, unknown> = {}) {
  return { t: 'join' as const, sessionId, schemaVersion: SCHEMA_VERSION, ...extra };
}

/** Assert that an upgrade was refused, and hand back the HTTP failure. */
export async function expectUpgradeRejected(promise: Promise<unknown>): Promise<HandshakeFailure> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HandshakeFailure) return error;
    throw error;
  }
  throw new Error('Expected the upgrade to be rejected, but it succeeded.');
}

/** Wait until `predicate` holds, polling the microtask queue. */
export async function until(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('Condition never became true.');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/** Let every pending socket write and handler settle. */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
}

export { bootstrap, createCampsite, key };
export type { Player };
