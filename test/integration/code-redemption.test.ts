/**
 * Scanning a wrapper, across the seam.
 *
 * The real API mints real Ed25519-signed codes; the real client fetches the
 * real public keys and verifies them the way a browser does. Nothing here is
 * stubbed on either side, which matters especially for the offline half — a
 * signature check that only agrees with itself is not evidence of anything.
 *
 * The claims:
 *
 *  1. A forged code is refused **on the device**, with no request made at all.
 *  2. A real code redeems **once**; a replay is refused by the database.
 *  3. The reward lands where rewards already live.
 *  4. A retired print run stops working, and **every other run keeps working**.
 *  5. A deployment with no keys says so, and never degrades to accepting
 *     everything.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { codeSigningInput, formatSomeMoreCode, type CodeBody } from '@somemore/protocol';
import { bootstrap, key, startTestApi, type Player, type TestHarness } from '../../services/api/test/harness.js';
import { OPS_TOKEN_HEADER } from '../../services/api/src/routes/liveops.js';
import { ed25519PrivateKeyFrom, generateCodeKeyPair } from '../../services/api/src/codes/signing.js';
import { ApiClient, deviceId } from '../../apps/web/src/net/client.js';
import { CodeKeyring, ScanFlow, verifyCodeLocally } from '../../apps/web/src/net/codes.js';

const OPS_TOKEN = 'ops-token-for-tests-only';
const KEYS = generateCodeKeyPair();

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(k: string): string | null {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string): void {
    this.map.set(k, v);
  }
  removeItem(k: string): void {
    this.map.delete(k);
  }
}

function opsEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    LIVE_OPS_TOKEN: OPS_TOKEN,
    CODE_SIGNING_KEY_ID: 'k1',
    CODE_SIGNING_PRIVATE_KEY: KEYS.privateKeyBase64,
    CODE_VERIFY_PUBLIC_KEYS: `k1:${KEYS.publicKeyBase64}`,
    ...overrides,
  };
}

let api: TestHarness;
let operator: Player;

beforeEach(async () => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  api = await startTestApi(opsEnv());
  operator = await bootstrap(api, 'Live Ops');
});

afterEach(async () => {
  await api.close();
});

async function ops(path: string, body?: unknown): Promise<{ status: number; body: any }> {
  return api.request(path, {
    method: body === undefined ? 'GET' : 'POST',
    token: operator.token,
    headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
    ...(body === undefined ? {} : { body }),
  });
}

/** Open a print run and mint it, exactly as the console does. */
async function mintRun(
  count = 3,
  overrides: Record<string, unknown> = {},
): Promise<{ batchId: string; codes: { ref: string; token: string; uri: string }[] }> {
  const batch = await ops('/v1/live-ops/code-batches', {
    idempotencyKey: key('batch'),
    label: 'Spring 26 wrapper',
    kind: 'pkg',
    entitlement: { type: 'reward', rewardCode: 'free_kit' },
    plannedSize: 1000,
    ...overrides,
  });
  expect(batch.status, JSON.stringify(batch.body)).toBe(201);
  const minted = await ops(`/v1/live-ops/code-batches/${batch.body.id}/mint`, {
    idempotencyKey: key('mint'),
    count,
  });
  expect(minted.status, JSON.stringify(minted.body)).toBe(201);
  // The service never stores codes: this response is the only copy.
  expect(minted.body.storedByService).toBe(false);
  return { batchId: batch.body.id as string, codes: minted.body.minted };
}

/** A signed-in player, holding a keyring fetched the way the app fetches one. */
async function player(): Promise<{ client: ApiClient; keyring: CodeKeyring; flow: ScanFlow }> {
  const client = new ApiClient({ baseUrl: api.baseUrl });
  const session = await client.bootstrap(`${deviceId()}-${Math.random().toString(36).slice(2)}`);
  expect(session.ok).toBe(true);

  const keys = await client.fetchCodeKeys();
  expect(keys.ok).toBe(true);
  const keyring = new CodeKeyring(keys.ok ? keys.value.keys : []);
  return { client, keyring, flow: new ScanFlow(client, { keyring }) };
}

describe('the public keys are shippable, and are the ones that signed', () => {
  it('serves them unauthenticated, and never the private half', async () => {
    const response = await fetch(`${api.baseUrl}/v1/codes/keys`);
    expect(response.status).toBe(200);
    const payload = (await response.json()) as { keys: { keyId: string; publicKey: string }[]; mintingKeyId: string };

    expect(payload.mintingKeyId).toBe('k1');
    expect(payload.keys.map((k) => k.keyId)).toEqual(['k1']);
    expect(payload.keys[0]?.publicKey).toBe(KEYS.publicKeyBase64);
    // The response is exactly two fields. Nothing that could carry a secret.
    expect(JSON.stringify(payload)).not.toContain(KEYS.privateKeyBase64);
  });

  it('verifies a real minted code with those keys, offline', async () => {
    const { codes } = await mintRun(1);
    const { keyring } = await player();
    const token = codes[0]?.token;
    if (token === undefined) throw new Error('no code minted');
    const verdict = await verifyCodeLocally(keyring, token, api.clock.now().getTime());
    expect(verdict.ok).toBe(true);
  });
});

describe('a forged code is refused offline', () => {
  it('never reaches the service at all', async () => {
    const { batchId } = await mintRun(1);
    const { keyring, client } = await player();

    // What a forger has: the format from the ADR, a real batch id off a real
    // wrapper, and their own key.
    const forger = generateKeyPairSync('ed25519');
    const body: CodeBody = {
      version: 1,
      kind: 'pkg',
      keyId: 'k1',
      batchId,
      ref: '000000',
      nonce: 'Jq7dP2nX9wKe',
      expiresAtUnix: 0,
    };
    const signature = sign(null, Buffer.from(codeSigningInput(body), 'utf8'), forger.privateKey);
    const forged = formatSomeMoreCode(body, new Uint8Array(signature));

    const requests: string[] = [];
    const watched = new ApiClient({
      baseUrl: api.baseUrl,
      fetchImpl: async (input, init) => {
        requests.push(String(input));
        return fetch(input as string, init);
      },
    });
    watched.restore((client as unknown as { session: never }).session);

    const flow = new ScanFlow(watched, { keyring, now: () => api.clock.now().getTime() });
    await flow.submit(forged);

    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.decidedOffline).toBe(true);
    // The point: not one byte left the device.
    expect(requests).toEqual([]);
  });

  it('and the service would have refused it too, with the same word as everything else', async () => {
    const { batchId } = await mintRun(1);
    const forger = generateKeyPairSync('ed25519');
    const body: CodeBody = {
      version: 1,
      kind: 'pkg',
      keyId: 'k1',
      batchId,
      ref: '000000',
      nonce: 'Jq7dP2nX9wKe',
      expiresAtUnix: 0,
    };
    const signature = sign(null, Buffer.from(codeSigningInput(body), 'utf8'), forger.privateKey);
    const scanner = await bootstrap(api, 'Camper');
    const response = await api.request('/v1/codes/redeem', {
      method: 'POST',
      token: scanner.token,
      body: { idempotencyKey: key('r'), code: formatSomeMoreCode(body, new Uint8Array(signature)) },
    });
    // 400, and the reason is the single uniform word: malformed, bad
    // signature, unknown key, unknown batch and never-minted are all `invalid`
    // from outside, so a scraper learns nothing about how close it got.
    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe('code_invalid');
    expect(response.body.error.details.reason).toBe('invalid');
  });

  it('refuses an expired wrapper offline, by the code’s own date', async () => {
    // One day of life, then two days pass.
    const { codes } = await mintRun(1, { codeTtlDays: 1 });
    const { keyring, flow } = await player();
    const token = codes[0]?.token;
    if (token === undefined) throw new Error('no code minted');

    expect((await verifyCodeLocally(keyring, token, api.clock.now().getTime())).ok).toBe(true);

    // Two days later the wrapper is a souvenir, and the phone says so from
    // the expiry the service baked into the code — no round trip at all.
    const verdict = await verifyCodeLocally(keyring, token, api.clock.now().getTime() + 2 * 86_400_000);
    expect(verdict).toEqual({ ok: false, reason: 'expired' });

    // And the flow refuses it without a request, using the same clock.
    const expiredFlow = new ScanFlow(flow['client' as never] as unknown as ApiClient, {
      keyring,
      now: () => api.clock.now().getTime() + 2 * 86_400_000,
    });
    await expiredFlow.submit(token);
    expect(expiredFlow.state.stage).toBe('rejected');
    expect(expiredFlow.state.decidedOffline).toBe(true);
  });
});

describe('a real code redeems once, and a replay is refused', () => {
  it('grants a reward, files a stub, and refuses the same code the second time', async () => {
    const { codes, batchId } = await mintRun(2);
    const token = codes[0]?.token;
    if (token === undefined) throw new Error('no code minted');

    const stubs: unknown[] = [];
    const { client, keyring } = await player();
    const flow = new ScanFlow(client, {
      keyring,
      now: () => api.clock.now().getTime(),
      onRedeemed: (result) => stubs.push(result),
    });

    await flow.submit(token);
    expect(flow.state.stage, JSON.stringify(flow.state)).toBe('redeemed');
    expect(flow.state.result?.batchId).toBe(batchId);
    // Player-facing copy: the reward's written name, never its code.
    expect(flow.state.awarded).toBe('A Kit, On Us added to your Passport.');
    expect(stubs).toHaveLength(1);

    // The reward is where rewards already live: on the account, granted by the
    // service, with the print run recorded as its provenance.
    const grants = await client.listRewardGrants();
    expect(grants.ok).toBe(true);
    if (!grants.ok) throw new Error('no grants');
    const granted = grants.value.find((grant) => grant.rewardCode === 'free_kit');
    expect(granted).toBeDefined();
    expect(granted?.source.type).toBe('code');
    if (granted?.source.type === 'code') expect(granted.source.batchId).toBe(batchId);

    // And it is in the redemption history the Passport can read back.
    const history = await client.listCodeRedemptions();
    expect(history.ok).toBe(true);
    if (history.ok) expect(history.value.map((r) => r.codeRef)).toContain(codes[0]?.ref);

    // The replay. The same person, the same code: the database says no.
    await flow.submit(token);
    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.message).toMatch(/already/i);
  });

  it('refuses the same code to a second person, which is what a posted photo is', async () => {
    const { codes } = await mintRun(1);
    const token = codes[0]?.token;
    if (token === undefined) throw new Error('no code minted');

    const first = await player();
    await first.flow.submit(token);
    expect(first.flow.state.stage).toBe('redeemed');

    const second = await player();
    await second.flow.submit(token);
    expect(second.flow.state.stage).toBe('rejected');
    expect(second.flow.state.decidedOffline).toBe(false);
    expect(second.flow.state.message).toMatch(/already/i);
  });

  it('refuses a serial the run never printed, even though the signature is real', async () => {
    /*
     * The belt-and-braces check that survives a leaked signing key long enough
     * for somebody to notice. A signature proves we minted the *format*; a
     * serial past what the run ever printed cannot be a real wrapper.
     *
     * Two runs are minted; a code from the second is re-signed with the *real*
     * key under the first run's batch id at a serial that run never reached.
     * The signature verifies — on the device and on the service — and the
     * redemption is still refused.
     */
    const small = await mintRun(1);
    const scanner = await player();

    const body: CodeBody = {
      version: 1,
      kind: 'pkg',
      keyId: 'k1',
      batchId: small.batchId,
      // The run minted serial 000000 and nothing else.
      ref: '00ffff',
      nonce: 'Jq7dP2nX9wKe',
      expiresAtUnix: 0,
    };
    const privateKey = ed25519PrivateKeyFrom(Buffer.from(KEYS.privateKeyBase64, 'base64'));
    const signature = sign(null, Buffer.from(codeSigningInput(body), 'utf8'), privateKey);
    const genuine = formatSomeMoreCode(body, new Uint8Array(signature));

    // It is genuinely signed, so the phone lets it through to the service.
    expect((await verifyCodeLocally(scanner.keyring, genuine, api.clock.now().getTime())).ok).toBe(true);

    await scanner.flow.submit(genuine);
    expect(scanner.flow.state.stage).toBe('rejected');
    expect(scanner.flow.state.decidedOffline).toBe(false);
    // Uniform: indistinguishable from a forgery, from outside.
    expect(scanner.flow.state.message).toContain('does not look like a Some More code');
  });
});

describe('one compromised print run is retirable without breaking every other', () => {
  it('stops the retired run and leaves the rest working', async () => {
    const compromised = await mintRun(2);
    const healthy = await mintRun(2);

    const retired = await ops(`/v1/live-ops/code-batches/${compromised.batchId}/retire`, {
      idempotencyKey: key('ret'),
      reason: 'a pallet turned up on eBay',
    });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('retired');

    const person = await player();
    await person.flow.submit(compromised.codes[0]?.token ?? '');
    expect(person.flow.state.stage).toBe('rejected');
    expect(person.flow.state.message).toMatch(/no longer being honoured/i);
    // Refused by the service, not by the device: the signature is genuine and
    // the phone has no way to know a warehouse leaked.
    expect(person.flow.state.decidedOffline).toBe(false);

    const other = await player();
    await other.flow.submit(healthy.codes[0]?.token ?? '');
    expect(other.flow.state.stage).toBe('redeemed');
  });
});

describe('a campfire invite stops at the seam', () => {
  it('verifies the signature and hands over the token without redeeming it', async () => {
    const batch = await ops('/v1/live-ops/code-batches', {
      idempotencyKey: key('batch'),
      label: 'Campfire invites',
      kind: 'camp',
      entitlement: { type: 'campsite_invite' },
      plannedSize: 10,
    });
    expect(batch.status, JSON.stringify(batch.body)).toBe(201);
    const minted = await ops(`/v1/live-ops/code-batches/${batch.body.id}/mint`, {
      idempotencyKey: key('mint'),
      count: 1,
    });
    const token = minted.body.minted[0].token as string;

    const { flow, keyring } = await player();
    expect((await verifyCodeLocally(keyring, token, api.clock.now().getTime())).ok).toBe(true);

    await flow.submit(token);
    expect(flow.state.stage).toBe('camp_invite');
    expect(flow.state.inviteToken).toBe(minted.body.minted[0].ref);
    expect(flow.state.decidedOffline).toBe(true);

    // The service agrees this is not a redemption: `/v1/codes/redeem` refuses
    // a `camp` code, so nothing was lost by stopping here.
    const scanner = await bootstrap(api, 'Camper');
    const refused = await api.request('/v1/codes/redeem', {
      method: 'POST',
      token: scanner.token,
      body: { idempotencyKey: key('r'), code: token },
    });
    // `wrong_kind` collapses into the same uniform `code_invalid` as every
    // other refusal a stranger could provoke.
    expect(refused.status).toBe(400);
    expect(refused.body.error.code).toBe('code_invalid');
  });
});

describe('a deployment with no keys is honest', () => {
  it('says scanning is switched off, and never accepts anything', async () => {
    /*
     * Mint first. On the Postgres backend the harness truncates the shared
     * schema when it boots a second service, which takes the operator account
     * with it — so anything this case needs from the *first* service has to
     * exist before the second one starts. (On the in-memory backend the two
     * are independent and the ordering does not matter, which is exactly the
     * kind of difference running both backends is for.)
     */
    const real = await mintRun(1);
    const realToken = real.codes[0]?.token ?? '';

    const bare = await startTestApi({ LIVE_OPS_TOKEN: OPS_TOKEN });
    try {
      const keys = await fetch(`${bare.baseUrl}/v1/codes/keys`);
      expect(keys.status).toBe(200);
      const payload = (await keys.json()) as { keys: unknown[]; mintingKeyId: null };
      expect(payload.keys).toEqual([]);
      expect(payload.mintingKeyId).toBeNull();

      const client = new ApiClient({ baseUrl: bare.baseUrl });
      const session = await client.bootstrap('device-no-keys');
      expect(session.ok).toBe(true);

      // With no keys, the client cannot verify. It asks — and the service says
      // it is not configured, which is a different sentence from "that code is
      // bad" and a very different one from "here is your free kit".
      // A well-formed code from the *other* deployment. Real, and unusable here.
      const flow = new ScanFlow(client, { keyring: new CodeKeyring([]) });
      await flow.submit(realToken);
      expect(flow.state.stage).toBe('unavailable');
      expect(flow.state.message).toContain('switched off');
    } finally {
      await bare.close();
    }
  });
});
