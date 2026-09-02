import { describe, expect, it } from 'vitest';
import {
  CODE_URI_PREFIX,
  CodeBatchSchema,
  CodeBodySchema,
  base64UrlToBytes,
  bytesToBase64Url,
  codeSigningInput,
  codeToUri,
  encodeCodeBody,
  formatSomeMoreCode,
  parseSomeMoreCode,
  stripCodeUri,
  utf8Bytes,
  type CodeBody,
} from '../src/index.js';

const BODY: CodeBody = {
  version: 1,
  kind: 'pkg',
  keyId: 'k1',
  batchId: 'bat_ZmFrZQ',
  ref: '00000a',
  nonce: 'Jq7dP2nX9wKe',
  expiresAtUnix: 1_790_000_000,
};

const SIGNATURE = new Uint8Array(64).fill(7);

describe('base64url', () => {
  it('round-trips every byte length modulo 3', () => {
    for (let length = 0; length < 40; length += 1) {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i += 1) bytes[i] = (i * 37 + length) & 0xff;
      const encoded = bytesToBase64Url(bytes);
      expect(encoded).not.toMatch(/[+/=]/);
      expect([...(base64UrlToBytes(encoded) ?? [])]).toEqual([...bytes]);
    }
  });

  it('refuses characters that are not base64url and impossible lengths', () => {
    expect(base64UrlToBytes('a+b/')).toBeNull();
    expect(base64UrlToBytes('AAAAA')).toBeNull();
  });
});

describe('the code body', () => {
  it('encodes as a canonical, positional string so signer and verifier agree', () => {
    expect(encodeCodeBody(BODY)).toBe('1|pkg|k1|bat_ZmFrZQ|00000a|Jq7dP2nX9wKe|1790000000');
  });

  it('signs over the version tag as well as the body', () => {
    expect(codeSigningInput(BODY)).toBe(`SM1.${bytesToBase64Url(utf8Bytes(encodeCodeBody(BODY)))}`);
  });

  it('refuses field values that could collide with the delimiter or a URI', () => {
    expect(CodeBodySchema.safeParse({ ...BODY, batchId: 'bat|evil' }).success).toBe(false);
    expect(CodeBodySchema.safeParse({ ...BODY, ref: 'a b' }).success).toBe(false);
    expect(CodeBodySchema.safeParse({ ...BODY, keyId: 'K1' }).success).toBe(false);
    // A nonce below 48 bits would make one code in a run guessable from another.
    expect(CodeBodySchema.safeParse({ ...BODY, nonce: 'short' }).success).toBe(false);
  });
});

describe('parsing a scanned code', () => {
  const token = formatSomeMoreCode(BODY, SIGNATURE);

  it('round-trips through the printed URI form', () => {
    expect(codeToUri(token)).toBe(`${CODE_URI_PREFIX}${token}`);
    expect(stripCodeUri(codeToUri(token))).toBe(token);
    const parsed = parseSomeMoreCode(codeToUri(token));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.code.body).toEqual(BODY);
    expect([...parsed.code.signature]).toEqual([...SIGNATURE]);
    expect(parsed.code.signedInput).toBe(codeSigningInput(BODY));
  });

  it('stays under 512 characters so it fits a printable QR and the join schema', () => {
    expect(codeToUri(token).length).toBeLessThan(256);
  });

  it('rejects anything that is not shaped like one of ours', () => {
    expect(parseSomeMoreCode('').ok).toBe(false);
    expect(parseSomeMoreCode('hello').ok).toBe(false);
    expect(parseSomeMoreCode('SM2.abc.def')).toEqual({ ok: false, reason: 'unsupported_version' });
    expect(parseSomeMoreCode(`SM1.$$$.${bytesToBase64Url(SIGNATURE)}`)).toEqual({
      ok: false,
      reason: 'bad_encoding',
    });
    // A 64-byte Ed25519 signature is the only length we accept, so a truncated
    // one is refused before any key is consulted.
    expect(parseSomeMoreCode(formatSomeMoreCode(BODY, SIGNATURE.subarray(0, 32)))).toEqual({
      ok: false,
      reason: 'bad_encoding',
    });
  });

  it('refuses a body whose canonical form is not what was signed', () => {
    // `00000a` re-encoded with a leading space would verify under one encoding
    // and be stored under another; the round-trip check catches it.
    const smuggled = bytesToBase64Url(utf8Bytes('1|pkg|k1|bat_ZmFrZQ|00000a|Jq7dP2nX9wKe|01790000000'));
    expect(parseSomeMoreCode(`SM1.${smuggled}.${bytesToBase64Url(SIGNATURE)}`).ok).toBe(false);
  });

  it('refuses a body with the wrong number of fields', () => {
    const short = bytesToBase64Url(utf8Bytes('1|pkg|k1|bat_ZmFrZQ|00000a'));
    expect(parseSomeMoreCode(`SM1.${short}.${bytesToBase64Url(SIGNATURE)}`)).toEqual({
      ok: false,
      reason: 'bad_field',
    });
  });

  it('carries no account, no value and no credential', () => {
    const parsed = parseSomeMoreCode(token);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const fields = Object.keys(parsed.code.body).sort();
    expect(fields).toEqual(['batchId', 'expiresAtUnix', 'keyId', 'kind', 'nonce', 'ref', 'version']);
  });
});

describe('code batches', () => {
  it('defaults to an active, one-per-account run that has minted nothing', () => {
    const batch = CodeBatchSchema.parse({
      id: 'bat_1',
      label: 'Spring 26 wrapper',
      kind: 'pkg',
      keyId: 'k1',
      entitlement: { type: 'reward', rewardCode: 'free_kit' },
      plannedSize: 10_000,
      createdAt: '2026-08-29T12:00:00.000Z',
      createdBy: 'acct_1',
      updatedAt: '2026-08-29T12:00:00.000Z',
    });
    expect(batch.status).toBe('active');
    expect(batch.mintedCount).toBe(0);
    expect(batch.perAccountLimit).toBe(1);
    expect(batch.retiredAt).toBeNull();
    expect(batch.flaggedAt).toBeNull();
  });

  it('models the entitlement on the run, not in the code', () => {
    const base = {
      id: 'bat_1',
      label: 'Run',
      kind: 'pkg' as const,
      keyId: 'k1',
      plannedSize: 10,
      createdAt: '2026-08-29T12:00:00.000Z',
      createdBy: 'acct_1',
      updatedAt: '2026-08-29T12:00:00.000Z',
    };
    expect(CodeBatchSchema.safeParse({ ...base, entitlement: { type: 'campsite_invite' } }).success).toBe(true);
    expect(CodeBatchSchema.safeParse({ ...base, entitlement: { type: 'cash' } }).success).toBe(false);
  });
});
