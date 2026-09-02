/**
 * Offline code verification, on its own.
 *
 * The claim being tested is narrow and important: **a phone can refuse a
 * forged, mistyped or expired code with no network at all**, and it can never
 * do the opposite — a local pass is a necessary condition, never a sufficient
 * one, and with no key material at all the answer is "we cannot check that
 * here", never "fine".
 *
 * The signatures here are made with `node:crypto` exactly as the service makes
 * them, and checked through the same WebCrypto path a browser uses, so this is
 * the real algorithm on both sides rather than a stub agreeing with itself.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { codeSigningInput, formatSomeMoreCode, codeToUri, type CodeBody } from '@somemore/protocol';
import {
  CodeKeyring,
  ScanFlow,
  cameraScanSupported,
  keysFromBuild,
  parseKeyList,
  readCachedKeys,
  verifyCodeLocally,
  writeCachedKeys,
} from '../src/net/codes.js';
import type { ApiClient } from '../src/net/client.js';

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
}

beforeEach(() => {
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
});

/** A key pair, in the raw-32-byte-base64 form the service publishes. */
function keyPair(): { privateKey: ReturnType<typeof generateKeyPairSync>['privateKey']; publicKeyBase64: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const spki = publicKey.export({ format: 'der', type: 'spki' }) as Buffer;
  return { privateKey, publicKeyBase64: spki.subarray(12).toString('base64') };
}

const REAL = keyPair();
const FORGER = keyPair();

function body(overrides: Partial<CodeBody> = {}): CodeBody {
  return {
    version: 1,
    kind: 'pkg',
    keyId: 'k1',
    batchId: 'bat_test01',
    ref: '00000a',
    nonce: 'Jq7dP2nX9wKe',
    expiresAtUnix: 0,
    ...overrides,
  };
}

function signWith(privateKey: ReturnType<typeof generateKeyPairSync>['privateKey'], value: CodeBody): string {
  const signature = sign(null, Buffer.from(codeSigningInput(value), 'utf8'), privateKey);
  return formatSomeMoreCode(value, new Uint8Array(signature));
}

const NOW = Date.UTC(2026, 7, 30, 2, 0, 0);

describe('the keyring', () => {
  it('parses the same `id:base64,id:base64` list the service reads from its env', () => {
    expect(parseKeyList('k1:AAA,k2:BBB')).toEqual([
      { keyId: 'k1', publicKey: 'AAA' },
      { keyId: 'k2', publicKey: 'BBB' },
    ]);
    // Anything malformed is skipped rather than throwing: a bad env var must
    // not stop the app booting.
    expect(parseKeyList('nonsense,:,k1:AAA')).toEqual([{ keyId: 'k1', publicKey: 'AAA' }]);
    expect(parseKeyList(undefined)).toEqual([]);
    expect(parseKeyList('')).toEqual([]);
  });

  it('reads a build-time key list, because a public key inside a client is the idea', () => {
    expect(keysFromBuild({ VITE_CODE_VERIFY_PUBLIC_KEYS: 'k1:AAA' })).toEqual([{ keyId: 'k1', publicKey: 'AAA' }]);
    expect(keysFromBuild({})).toEqual([]);
  });

  it('caches keys on the device and reads them back', () => {
    writeCachedKeys([{ keyId: 'k1', publicKey: REAL.publicKeyBase64 }], 'k1');
    expect(readCachedKeys()).toEqual([{ keyId: 'k1', publicKey: REAL.publicKeyBase64 }]);
  });

  it('treats a corrupt key cache as no keys', () => {
    localStorage.setItem('some-more/code-keys/v1', 'not json at all');
    expect(readCachedKeys()).toEqual([]);
  });
});

describe('verifying without a network', () => {
  const keyring = new CodeKeyring([{ keyId: 'k1', publicKey: REAL.publicKeyBase64 }]);

  it('accepts a code we really signed', async () => {
    const verdict = await verifyCodeLocally(keyring, signWith(REAL.privateKey, body()), NOW);
    expect(verdict.ok).toBe(true);
  });

  it('accepts the `somemore://c/` wrapper a camera hands it', async () => {
    const token = signWith(REAL.privateKey, body());
    const verdict = await verifyCodeLocally(keyring, codeToUri(token), NOW);
    expect(verdict.ok).toBe(true);
  });

  it('refuses a forgery, with no request made', async () => {
    // Signed by a key we do not hold, but *claiming* to be ours: exactly what
    // somebody who read the format in the ADR would produce.
    const forged = signWith(FORGER.privateKey, body({ keyId: 'k1' }));
    const verdict = await verifyCodeLocally(keyring, forged, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a code whose body was edited after signing', async () => {
    const token = signWith(REAL.privateKey, body({ ref: '00000a' }));
    const [tag, encoded, signature] = token.split('.') as [string, string, string];
    // Re-encode a different serial under the original signature.
    const tampered = Buffer.from(
      '1|pkg|k1|bat_test01|ffffff|Jq7dP2nX9wKe|0',
      'utf8',
    ).toString('base64url');
    expect(encoded).not.toBe(tampered);
    const verdict = await verifyCodeLocally(keyring, `${tag}.${tampered}.${signature}`, NOW);
    expect(verdict).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses something that is not a code at all', async () => {
    for (const junk of ['', 'hello', 'SM1.', 'SM2.aaaa.bbbb', 'https://example.com']) {
      const verdict = await verifyCodeLocally(keyring, junk, NOW);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toBe('malformed');
    }
  });

  it('refuses an expired code, and says so in words a person can act on', async () => {
    const expired = signWith(REAL.privateKey, body({ expiresAtUnix: Math.floor(NOW / 1000) - 1 }));
    expect(await verifyCodeLocally(keyring, expired, NOW)).toEqual({ ok: false, reason: 'expired' });

    // One second the other way is still good. Half-open, like every other
    // window in this system.
    const fresh = signWith(REAL.privateKey, body({ expiresAtUnix: Math.floor(NOW / 1000) + 1 }));
    expect((await verifyCodeLocally(keyring, fresh, NOW)).ok).toBe(true);
  });

  it('checks the signature before the expiry, so a forger cannot choose the date', async () => {
    // Signed by the forger *and* long expired. The answer must be about the
    // signature: reading an expiry off an unsigned body would be reading a
    // number somebody else picked.
    const forged = signWith(FORGER.privateKey, body({ keyId: 'k1', expiresAtUnix: 1 }));
    expect(await verifyCodeLocally(keyring, forged, NOW)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('distinguishes a key it has never heard of from a forgery', async () => {
    const rotated = signWith(FORGER.privateKey, body({ keyId: 'k9' }));
    expect(await verifyCodeLocally(keyring, rotated, NOW)).toEqual({ ok: false, reason: 'unknown_key' });
  });

  it('verifies under a rotated key once it is added, without a reprint', async () => {
    const rotating = new CodeKeyring([{ keyId: 'k1', publicKey: REAL.publicKeyBase64 }]);
    const newKey = keyPair();
    const token = signWith(newKey.privateKey, body({ keyId: 'k2' }));
    expect((await verifyCodeLocally(rotating, token, NOW)).ok).toBe(false);
    rotating.add([{ keyId: 'k2', publicKey: newKey.publicKeyBase64 }]);
    expect((await verifyCodeLocally(rotating, token, NOW)).ok).toBe(true);
    // The old key still verifies. That is the whole point of naming the key.
    expect((await verifyCodeLocally(rotating, signWith(REAL.privateKey, body()), NOW)).ok).toBe(true);
  });

  it('with no key material says "cannot check", never "fine"', async () => {
    const empty = new CodeKeyring([]);
    const verdict = await verifyCodeLocally(empty, signWith(REAL.privateKey, body()), NOW);
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toBe('unverifiable');

    // And a missing key must not turn garbage into a maybe.
    const junk = await verifyCodeLocally(empty, 'not a code', NOW);
    expect(junk).toEqual({ ok: false, reason: 'malformed' });
  });
});

/* -------------------------------------------------------------------------- */
/* The flow                                                                    */
/* -------------------------------------------------------------------------- */

/** A client that records what it was asked, so "no request" is testable. */
function fakeClient(
  redeem: (code: string) => Promise<unknown> = async () => ({ ok: false, error: { kind: 'offline' } }),
): { client: ApiClient; calls: string[] } {
  const calls: string[] = [];
  const client = {
    authenticated: true,
    async redeemCode(code: string) {
      calls.push(code);
      return redeem(code);
    },
  } as unknown as ApiClient;
  return { client, calls };
}

describe('the scan flow', () => {
  const keyring = new CodeKeyring([{ keyId: 'k1', publicKey: REAL.publicKeyBase64 }]);

  it('refuses a forgery without touching the network', async () => {
    const { client, calls } = fakeClient();
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(FORGER.privateKey, body({ keyId: 'k1' })));

    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.decidedOffline).toBe(true);
    expect(flow.state.message).toContain('did not check out');
    expect(calls).toEqual([]);
  });

  it('refuses an expired code without touching the network', async () => {
    const { client, calls } = fakeClient();
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(REAL.privateKey, body({ expiresAtUnix: 1 })));
    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.message).toContain('expired');
    expect(calls).toEqual([]);
  });

  it('stops at the seam for a campfire invite, having checked the signature first', async () => {
    const { client, calls } = fakeClient();
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(REAL.privateKey, body({ kind: 'camp', ref: 'invite_abc' })));

    expect(flow.state.stage).toBe('camp_invite');
    expect(flow.state.inviteToken).toBe('invite_abc');
    // Joining a fire is not a redemption, and this flow does not try to make
    // it one — the multiplayer client takes the token from here.
    expect(calls).toEqual([]);
  });

  it('refuses a forged campfire invite before the invite table is ever read', async () => {
    const { client, calls } = fakeClient();
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(FORGER.privateKey, body({ kind: 'camp', keyId: 'k1', ref: 'invite_abc' })));
    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.inviteToken).toBeNull();
    expect(calls).toEqual([]);
  });

  it('presents a locally-valid code to the service and lands the reward', async () => {
    const redemption = {
      id: 'crd_1',
      batchId: 'bat_test01',
      codeRef: '00000a',
      accountId: 'acc_1',
      redeemedAt: '2026-08-30T02:00:00.000Z',
      ipHash: 'f'.repeat(64),
      deviceId: null,
      grantId: 'grt_1',
      riskScore: 0,
    };
    const granted: unknown[] = [];
    const { client, calls } = fakeClient(async () => ({
      ok: true,
      value: {
        status: 'redeemed',
        batchId: 'bat_test01',
        awarded: 'free_kit added to your Passport.',
        grantId: 'grt_1',
        redemption,
      },
    }));
    const flow = new ScanFlow(client, {
      keyring,
      now: () => NOW,
      onRedeemed: (result) => granted.push(result),
    });

    const token = signWith(REAL.privateKey, body());
    await flow.submit(token);

    expect(calls).toEqual([token]);
    expect(flow.state.stage).toBe('redeemed');
    expect(flow.state.awarded).toContain('free_kit');
    expect(granted).toHaveLength(1);
  });

  it('asks the service when it has no key material, rather than guessing either way', async () => {
    const { client, calls } = fakeClient();
    const flow = new ScanFlow(client, { keyring: new CodeKeyring([]), now: () => NOW });
    await flow.submit(signWith(REAL.privateKey, body()));
    expect(calls).toHaveLength(1);
    // The request failed (offline), so the answer is "we could not ask" —
    // never "that code is bad" and never "that code is fine".
    expect(flow.state.stage).toBe('unavailable');
  });

  it('repeats the service’s own words for a refusal it did not decide', async () => {
    const { client } = fakeClient(async () => ({
      ok: false,
      error: { kind: 'server', status: 409, code: 'code_already_redeemed', message: 'That code has already been used.' },
    }));
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(REAL.privateKey, body()));
    expect(flow.state.stage).toBe('rejected');
    expect(flow.state.message).toBe('That code has already been used.');
    expect(flow.state.decidedOffline).toBe(false);
  });

  it('says scanning is switched off when the deployment has no keys at all', async () => {
    const { client } = fakeClient(async () => ({
      ok: false,
      error: { kind: 'server', status: 503, code: 'service_not_configured', message: 'no keys' },
    }));
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit(signWith(REAL.privateKey, body()));
    expect(flow.state.stage).toBe('unavailable');
    expect(flow.state.message).toContain('switched off');
  });

  it('resets cleanly, so a second code does not inherit the first one’s verdict', async () => {
    const { client } = fakeClient();
    const flow = new ScanFlow(client, { keyring, now: () => NOW });
    await flow.submit('garbage');
    expect(flow.state.stage).toBe('rejected');
    flow.reset();
    expect(flow.state).toEqual({
      stage: 'idle',
      message: null,
      awarded: null,
      result: null,
      inviteToken: null,
      decidedOffline: false,
      failure: null,
    });
  });
});

describe('the camera', () => {
  it('reports itself unsupported where the browser has no BarcodeDetector', () => {
    // Node has neither, which is the same answer most phones give — and is
    // exactly why typing it in is the primary path rather than the fallback.
    expect(cameraScanSupported()).toBe(false);
  });
});
