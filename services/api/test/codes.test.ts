import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  codeToUri,
  formatSomeMoreCode,
  parseSomeMoreCode,
  type CodeBody,
} from '@somemore/protocol';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { bootstrap, createCampsite, key, startTestApi, type Player, type TestHarness } from './harness.js';
import { generateCodeKeyPair, ed25519PrivateKeyFrom } from '../src/codes/signing.js';
import { OPS_TOKEN_HEADER } from '../src/routes/liveops.js';

/*
 * Codes, over HTTP, against whichever backend this run is exercising.
 *
 * Everything here is a "somebody photographed a wrapper" story. The important
 * ones: a forged code is refused before storage is touched, the same real code
 * twice is refused by the database, and retiring one compromised print run does
 * not break every code we ever printed.
 */

const OPS_TOKEN = 'ops-token-for-tests-only';
const KEYS = generateCodeKeyPair();

/** A second, unrelated key pair: what a forger would have. */
const FORGER = generateCodeKeyPair();

function opsEnv(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    LIVE_OPS_TOKEN: OPS_TOKEN,
    CODE_SIGNING_KEY_ID: 'k1',
    CODE_SIGNING_PRIVATE_KEY: KEYS.privateKeyBase64,
    CODE_VERIFY_PUBLIC_KEYS: `k1:${KEYS.publicKeyBase64}`,
    // One case links a Google identity to prove a merge carries redemptions.
    AUTH_ALLOW_UNVERIFIED_OIDC: 'true',
    ...overrides,
  };
}

let api: TestHarness;
let operator: Player;

async function ops(path: string, body: unknown, method: 'POST' | 'GET' = 'POST') {
  return api.request(path, {
    method,
    token: operator.token,
    headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
    ...(method === 'GET' ? {} : { body }),
  });
}

async function mintRun(count = 3, overrides: Record<string, unknown> = {}) {
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
  return { batch: batch.body, codes: minted.body.minted as Array<{ ref: string; token: string; uri: string }> };
}

async function redeem(player: Player, code: string) {
  return api.request('/v1/codes/redeem', {
    method: 'POST',
    token: player.token,
    body: { idempotencyKey: key('redeem'), code },
  });
}

/** Re-sign an arbitrary body with a key we do not trust. */
function forge(body: CodeBody, privateKeyBase64: string): string {
  const privateKey = ed25519PrivateKeyFrom(Buffer.from(privateKeyBase64, 'base64'));
  const parsedInput = `SM1.${Buffer.from(
    [body.version, body.kind, body.keyId, body.batchId, body.ref, body.nonce, body.expiresAtUnix].join('|'),
    'utf8',
  ).toString('base64url')}`;
  const signature = sign(null, Buffer.from(parsedInput, 'utf8'), privateKey);
  return formatSomeMoreCode(body, new Uint8Array(signature));
}

beforeEach(async () => {
  api = await startTestApi(opsEnv());
  operator = await bootstrap(api, 'Operator');
});

afterEach(async () => {
  await api.close();
});

describe('minting a run', () => {
  it('hands back the codes once and stores none of them', async () => {
    const { batch, codes } = await mintRun(5);
    expect(codes).toHaveLength(5);
    expect(codes.map((c) => c.ref)).toEqual(['000000', '000001', '000002', '000003', '000004']);
    for (const code of codes) expect(code.uri).toBe(codeToUri(code.token));

    const listed = await ops('/v1/live-ops/code-batches', null, 'GET');
    const stored = JSON.stringify(listed.body);
    expect(listed.body.items[0].mintedCount).toBe(5);
    // The batch record must not contain a code, a nonce or a signature.
    for (const code of codes) expect(stored).not.toContain(code.token);
  });

  it('produces a code short enough to print and scan', async () => {
    const { codes } = await mintRun(1);
    expect(codes[0]!.uri.length).toBeLessThan(220);
  });

  it('refuses to mint past the size the run was planned for', async () => {
    const { batch } = await mintRun(1, { plannedSize: 2 });
    const over = await ops(`/v1/live-ops/code-batches/${batch.id}/mint`, {
      idempotencyKey: key('mint'),
      count: 5,
    });
    expect(over.status).toBe(409);
  });
});

describe('redeeming a real code', () => {
  it('grants what the run entitles you to, and says what you got', async () => {
    const { batch, codes } = await mintRun();
    const player = await bootstrap(api, 'Camper');

    const redeemed = await redeem(player, codes[0]!.uri);
    expect(redeemed.status, JSON.stringify(redeemed.body)).toBe(201);
    expect(redeemed.body.status).toBe('redeemed');
    expect(redeemed.body.batchId).toBe(batch.id);
    // The reward's written name, because `awarded` is player-facing copy and
    // `free_kit` is a database key.
    expect(redeemed.body.awarded).toBe('A Kit, On Us added to your Passport.');

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    const kit = grants.body.items.find((g: { rewardCode: string }) => g.rewardCode === 'free_kit');
    expect(kit).toBeDefined();
    // Provenance for a fraud reviewer: which run, which code in it.
    expect(kit.source).toEqual({ type: 'code', batchId: batch.id, codeRef: codes[0]!.ref });
  });

  it('grants a high-value reward without the gameplay prerequisites, because the code is the proof', async () => {
    // `free_kit` normally needs a sandwich and a good score. This player has
    // neither — they have a box, which is a stronger claim than either.
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Camper');
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
  });

  it('records a salted IP hash and never the address itself', async () => {
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Camper');
    const redeemed = await redeem(player, codes[0]!.token);
    expect(redeemed.body.redemption.ipHash).toHaveLength(64);
    expect(JSON.stringify(redeemed.body.redemption)).not.toContain('127.0.0.1');
  });

  it('lists what you have redeemed', async () => {
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Camper');
    await redeem(player, codes[0]!.token);
    const listed = await api.request('/v1/codes/redemptions', { token: player.token });
    expect(listed.body.items).toHaveLength(1);
    expect(listed.body.items[0].codeRef).toBe(codes[0]!.ref);
  });
});

describe('merging two accounts', () => {
  it('carries redeemed codes across, because the box was genuinely bought', async () => {
    const { codes } = await mintRun(2);
    const phone = await bootstrap(api, 'Phone');
    const couch = await bootstrap(api, 'Couch');
    expect((await redeem(phone, codes[0]!.token)).status).toBe(201);
    expect((await redeem(couch, codes[1]!.token)).status).toBe(201);

    const appleCredential = {
      provider: 'apple' as const,
      identityToken: 'opaque-apple-token-for-codes-test',
      nonce: 'nonce-abcdefgh',
    };
    const linked = await api.request('/v1/auth/link', {
      method: 'POST',
      token: phone.token,
      body: { idempotencyKey: key('link'), credential: appleCredential },
    });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);

    const second = await api.request('/v1/auth/link', {
      method: 'POST',
      token: couch.token,
      body: { idempotencyKey: key('link'), mergePolicy: 'keep_existing', credential: appleCredential },
    });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(second.body.status).toBe('merged');
    expect(second.body.report.moved.codeRedemptions).toBe(1);

    const survivor = second.body.report.survivingAccountId === phone.accountId ? phone : couch;
    const listed = await api.request('/v1/codes/redemptions', { token: survivor.token });
    expect(listed.body.items).toHaveLength(2);
  });
});

describe('a forged code', () => {
  it('is rejected when signed with a key we do not hold', async () => {
    const { codes } = await mintRun();
    const parsed = parseSomeMoreCode(codes[0]!.token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const forged = forge(parsed.code.body, FORGER.privateKeyBase64);
    expect(forged).not.toBe(codes[0]!.token);

    const player = await bootstrap(api, 'Camper');
    const rejected = await redeem(player, forged);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('code_invalid');
    expect(rejected.body.error.details.reason).toBe('invalid');

    // And nothing was written: the real code still works afterwards.
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
  });

  it('is rejected when a single character of the body is altered', async () => {
    const { codes } = await mintRun();
    const token = codes[0]!.token;
    const [tag, body, signature] = token.split('.') as [string, string, string];
    const flipped = body.slice(0, -1) + (body.endsWith('A') ? 'B' : 'A');
    const player = await bootstrap(api, 'Camper');
    const rejected = await redeem(player, `${tag}.${flipped}.${signature}`);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('code_invalid');
  });

  it('is rejected when it names a key this deployment does not know', async () => {
    const { codes } = await mintRun();
    const parsed = parseSomeMoreCode(codes[0]!.token);
    if (!parsed.ok) return;
    const forged = forge({ ...parsed.code.body, keyId: 'k9' }, FORGER.privateKeyBase64);
    const player = await bootstrap(api, 'Camper');
    const rejected = await redeem(player, forged);
    expect(rejected.status).toBe(400);
    // Same word as every other "no": an attacker learns nothing about why.
    expect(rejected.body.error.details.reason).toBe('invalid');
  });

  it('is rejected when it is not shaped like one of ours at all', async () => {
    const player = await bootstrap(api, 'Camper');
    for (const attempt of ['not-a-code-at-all', 'SM1.aaaa.bbbb', 'somemore://c/SM9.a.b']) {
      const rejected = await redeem(player, attempt);
      expect(rejected.status, attempt).toBe(400);
      expect(rejected.body.error.details.reason).toBe('invalid');
    }
  });

  it('is rejected when the serial was never printed', async () => {
    // Only three codes were minted; a signed code for the thousandth would mean
    // the key leaked, and the run's own minted count catches it.
    const { batch, codes } = await mintRun(3);
    const parsed = parseSomeMoreCode(codes[0]!.token);
    if (!parsed.ok) return;
    const beyond = forge({ ...parsed.code.body, ref: '0003e8' }, KEYS.privateKeyBase64);
    const player = await bootstrap(api, 'Camper');
    const rejected = await redeem(player, beyond);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.reason).toBe('invalid');
    expect(batch.mintedCount).toBe(0);
  });
});

describe('an expired code', () => {
  it('stops working once its own expiry has passed', async () => {
    const { codes } = await mintRun(2, { codeTtlDays: 30 });
    const player = await bootstrap(api, 'Camper');
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);

    api.clock.advance(31 * 86_400_000);
    const other = await bootstrap(api, 'Later');
    const rejected = await redeem(other, codes[1]!.token);
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.details.reason).toBe('expired');
  });
});

describe('claim-once', () => {
  it('refuses the same code a second time, from the same account', async () => {
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Camper');
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
    const again = await redeem(player, codes[0]!.token);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('code_already_redeemed');
  });

  it('refuses a code somebody else already used — the Instagram case', async () => {
    const { codes } = await mintRun();
    const buyer = await bootstrap(api, 'Buyer');
    const scraper = await bootstrap(api, 'Scraper');
    expect((await redeem(buyer, codes[0]!.token)).status).toBe(201);

    const stolen = await redeem(scraper, codes[0]!.token);
    expect(stolen.status).toBe(409);
    expect(stolen.body.error.code).toBe('code_already_redeemed');
    expect(stolen.body.error.details.reason).toBe('already_redeemed');

    const grants = await api.request('/v1/rewards/grants', { token: scraper.token });
    expect(grants.body.items).toHaveLength(0);
  });

  it('holds the one-per-account rule across different codes from one run', async () => {
    const { codes } = await mintRun(3);
    const player = await bootstrap(api, 'Camper');
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
    const second = await redeem(player, codes[1]!.token);
    expect(second.status).toBe(409);
    expect(second.body.error.details.reason).toBe('limit_reached');
  });

  it('allows more than one when the run says so', async () => {
    const { codes } = await mintRun(3, { perAccountLimit: 2 });
    const player = await bootstrap(api, 'Camper');
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
    expect((await redeem(player, codes[1]!.token)).status).toBe(201);
    expect((await redeem(player, codes[2]!.token)).status).toBe(409);
  });
});

describe('retiring a compromised run', () => {
  it('stops that run and leaves every other run working', async () => {
    const leaked = await mintRun(2, { label: 'Leaked pallet' });
    const fine = await mintRun(2, { label: 'Everything else' });

    const retired = await ops(`/v1/live-ops/code-batches/${leaked.batch.id}/retire`, {
      idempotencyKey: key('retire'),
      reason: 'A pallet of wrappers was photographed for a reel.',
    });
    expect(retired.status).toBe(200);
    expect(retired.body.status).toBe('retired');
    expect(retired.body.retiredReason).toContain('reel');

    const unlucky = await bootstrap(api, 'Unlucky');
    const dead = await redeem(unlucky, leaked.codes[0]!.token);
    expect(dead.status).toBe(403);
    expect(dead.body.error.code).toBe('code_revoked');
    expect(dead.body.error.details.reason).toBe('batch_retired');

    const lucky = await bootstrap(api, 'Lucky');
    expect((await redeem(lucky, fine.codes[0]!.token)).status).toBe(201);
  });

  it('refuses codes from a run whose window has not opened, then honours them when it has', async () => {
    const { codes } = await mintRun(2, { activeFrom: '2026-09-01T00:00:00.000Z' });
    const early = await bootstrap(api, 'Early');
    const tooSoon = await redeem(early, codes[0]!.token);
    expect(tooSoon.status).toBe(403);
    expect(tooSoon.body.error.details.reason).toBe('batch_not_active');

    api.clock.set(new Date('2026-09-02T00:00:00.000Z'));
    expect((await redeem(early, codes[0]!.token)).status).toBe(201);
  });
});

describe('rate limiting a scraper', () => {
  it('cuts off an account that is working through a list of guesses', async () => {
    const player = await bootstrap(api, 'Scraper');
    const statuses: number[] = [];
    for (let i = 0; i < 14; i += 1) {
      statuses.push((await redeem(player, `SM1.aaaa${i}.bbbb`)).status);
    }
    // Ten attempts an hour by default, then the door closes.
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);

    const limited = await redeem(player, 'SM1.zzz.yyy');
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0);
  });

  it('lets an honest player back in once the window rolls over', async () => {
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Fumbler');
    for (let i = 0; i < 12; i += 1) await redeem(player, `SM1.aaaa${i}.bbbb`);
    expect((await redeem(player, codes[0]!.token)).status).toBe(429);

    api.clock.advance(3_601_000);
    expect((await redeem(player, codes[0]!.token)).status).toBe(201);
  });
});

describe('campsite QR joins use the same format', () => {
  it('mints a signed camp code that the join endpoint accepts', async () => {
    const owner = await bootstrap(api, 'Owner');
    const friend = await bootstrap(api, 'Friend');
    const campsite = await createCampsite(api, owner);

    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv'), grantsRole: 'guest' },
    });
    expect(invite.status).toBe(201);
    const qr = invite.body.qrPayload as string;
    expect(qr.startsWith('somemore://c/SM1.')).toBe(true);

    const parsed = parseSomeMoreCode(qr);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.code.body.kind).toBe('camp');
    // The invite token is the ref: one grammar, not two.
    expect(parsed.code.body.ref).toBe(invite.body.invite.token);

    const joined = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: friend.token,
      body: { idempotencyKey: key('join'), join: { method: 'qr', payload: qr } },
    });
    expect(joined.status, JSON.stringify(joined.body)).toBe(200);
    expect(joined.body.role).toBe('guest');
    expect(
      joined.body.campsite.members.find((m: { accountId: string }) => m.accountId === friend.accountId).joinedVia,
    ).toBe('qr');
  });

  it('refuses a forged camp QR before it ever looks at the invite table', async () => {
    const owner = await bootstrap(api, 'Owner');
    const stranger = await bootstrap(api, 'Stranger');
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    const parsed = parseSomeMoreCode(invite.body.qrPayload);
    if (!parsed.ok) return;

    const forged = forge(parsed.code.body, FORGER.privateKeyBase64);
    const rejected = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('join'), join: { method: 'qr', payload: forged } },
    });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error.code).toBe('code_invalid');

    const campsiteAfter = await api.request(`/v1/campsites/${campsite.id}`, { token: owner.token });
    expect(campsiteAfter.body.members).toHaveLength(1);
  });

  it('still accepts the unsigned legacy payload, so codes in the wild keep working', async () => {
    const owner = await bootstrap(api, 'Owner');
    const friend = await bootstrap(api, 'Friend');
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    const joined = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: friend.token,
      body: {
        idempotencyKey: key('join'),
        join: { method: 'qr', payload: `somemore://join?t=${invite.body.invite.token}` },
      },
    });
    expect(joined.status).toBe(200);
  });

  it('refuses a package code presented as a campsite invite, and vice versa', async () => {
    const { codes } = await mintRun();
    const player = await bootstrap(api, 'Confused');
    const wrongWay = await api.request('/v1/campsites/join', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('join'), join: { method: 'qr', payload: codes[0]!.token } },
    });
    expect(wrongWay.status).toBe(400);
    expect(wrongWay.body.error.details.reason).toBe('wrong_kind');

    const owner = await bootstrap(api, 'Owner');
    const campsite = await createCampsite(api, owner);
    const invite = await api.request(`/v1/campsites/${campsite.id}/invites`, {
      method: 'POST',
      token: owner.token,
      body: { idempotencyKey: key('inv') },
    });
    const asRedemption = await redeem(player, invite.body.qrPayload);
    expect(asRedemption.status).toBe(400);
    expect(asRedemption.body.error.details.reason).toBe('invalid');
  });
});

describe('a deployment with no code keys', () => {
  it('disables scanning honestly rather than accepting anything', async () => {
    const bare = await startTestApi({ LIVE_OPS_TOKEN: OPS_TOKEN });
    try {
      const player = await bootstrap(bare, 'Camper');
      const status = await bare.request('/v1/live-ops/status', { token: player.token });
      expect(status.body.codes.status).toBe('not_configured');
      expect(status.body.codes.fallback).toBe('scanning_disabled');
      expect(status.body.codes.reason).toContain('CODE_SIGNING_PRIVATE_KEY');

      const attempt = await bare.request('/v1/codes/redeem', {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey: key('redeem'), code: 'SM1.aaaa.bbbb' },
      });
      expect(attempt.status).toBe(503);
      expect(attempt.body.error.code).toBe('service_not_configured');

      const meta = await bare.request('/v1/meta');
      expect(meta.body.codeVerification).toBe(false);
      expect(meta.body.codeMinting).toBe(false);
    } finally {
      await bare.close();
    }
  });

  it('still lets friends join by QR, using the unsigned form', async () => {
    const bare = await startTestApi({});
    try {
      const owner = await bootstrap(bare, 'Owner');
      const friend = await bootstrap(bare, 'Friend');
      const campsite = await createCampsite(bare, owner);
      const invite = await bare.request(`/v1/campsites/${campsite.id}/invites`, {
        method: 'POST',
        token: owner.token,
        body: { idempotencyKey: key('inv') },
      });
      // Degrade, never block: no keys means no signature, not no campfire.
      expect(invite.body.qrPayload.startsWith('somemore://join?t=')).toBe(true);
      const joined = await bare.request('/v1/campsites/join', {
        method: 'POST',
        token: friend.token,
        body: { idempotencyKey: key('join'), join: { method: 'qr', payload: invite.body.qrPayload } },
      });
      expect(joined.status).toBe(200);
    } finally {
      await bare.close();
    }
  });
});

describe('a deployment that can verify but not mint', () => {
  it('honours codes signed elsewhere and refuses to print new ones', async () => {
    const readOnly = await startTestApi({
      LIVE_OPS_TOKEN: OPS_TOKEN,
      CODE_VERIFY_PUBLIC_KEYS: `k1:${KEYS.publicKeyBase64}`,
    });
    try {
      const player = await bootstrap(readOnly, 'Operator');
      const status = await readOnly.request('/v1/live-ops/status', { token: player.token });
      expect(status.body.codes.status).toBe('ready');
      expect(status.body.codes.canMint).toBe(false);

      const attempt = await readOnly.request('/v1/live-ops/code-batches', {
        method: 'POST',
        token: player.token,
        headers: { [OPS_TOKEN_HEADER]: OPS_TOKEN },
        body: {
          idempotencyKey: key('batch'),
          label: 'Nope',
          entitlement: { type: 'reward', rewardCode: 'free_kit' },
          plannedSize: 10,
        },
      });
      expect(attempt.status).toBe(503);
      expect(attempt.body.error.message).toContain('CODE_SIGNING_PRIVATE_KEY');
    } finally {
      await readOnly.close();
    }
  });
});

describe('key material handling', () => {
  it('accepts a raw 32-byte seed and a PKCS8 DER blob as the same key', () => {
    const { privateKey } = generateKeyPairSync('ed25519');
    const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
    const seed = pkcs8.subarray(pkcs8.length - 32);
    const fromSeed = ed25519PrivateKeyFrom(seed);
    const fromDer = ed25519PrivateKeyFrom(Buffer.from(pkcs8));
    const message = Buffer.from('same key, two encodings');
    expect(sign(null, message, fromSeed).equals(sign(null, message, fromDer))).toBe(true);
    expect(createPrivateKey(privateKey.export({ format: 'pem', type: 'pkcs8' })).asymmetricKeyType).toBe('ed25519');
  });
});
