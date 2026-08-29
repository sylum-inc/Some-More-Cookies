/**
 * Minting and verifying Some More codes.
 *
 * The format itself lives in `@somemore/protocol/codes` — pure, node-free, and
 * shared with the client so a phone can reject a mistyped code offline. What
 * lives here is the part that needs keys: Ed25519 over `node:crypto`, a
 * keyring that supports rotation, and the honest "not configured" report.
 *
 * Three properties this module exists to hold:
 *
 *  1. **No secret is ever committed.** Keys come from the environment. With
 *     none, `status()` says `not_configured`, minting refuses and verification
 *     refuses — it never falls back to accepting everything, which is the one
 *     failure mode that would turn a missing env var into free ice cream.
 *  2. **Verification is a signature check, not a comparison.** Ed25519
 *     verification has no data-dependent branch on the signature, so there is
 *     no timing oracle. Where this module does compare secrets (the live-ops
 *     token) it uses `timingSafeEqual` over fixed-length digests.
 *  3. **Rotation without a reprint.** A code names the key that signed it, so
 *     old print runs keep verifying after the minting key changes: the new key
 *     mints, every configured key verifies.
 */

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import {
  bytesToBase64Url,
  codeSigningInput,
  formatSomeMoreCode,
  type CodeBody,
  type CodeKind,
  type CodeSigningStatus,
  type ParsedCode,
} from '@somemore/protocol';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../logging.js';

/* -------------------------------------------------------------------------- */
/* Raw Ed25519 keys <-> node KeyObjects                                        */
/* -------------------------------------------------------------------------- */

/*
 * `node:crypto` wants DER, and the thing an operator can actually paste into a
 * secret store is 32 raw bytes. These two prefixes are the fixed ASN.1 headers
 * for Ed25519 keys (RFC 8410) — constants, not secrets, and short enough to
 * read: OID 1.3.101.112 wrapped in a PrivateKeyInfo / SubjectPublicKeyInfo.
 * Both raw and DER inputs are accepted so neither format is a papercut.
 */
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

export function ed25519PrivateKeyFrom(material: Buffer): KeyObject {
  if (material.length === 32) {
    return createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, material]),
      format: 'der',
      type: 'pkcs8',
    });
  }
  return createPrivateKey({ key: material, format: 'der', type: 'pkcs8' });
}

export function ed25519PublicKeyFrom(material: Buffer): KeyObject {
  if (material.length === 32) {
    return createPublicKey({
      key: Buffer.concat([SPKI_ED25519_PREFIX, material]),
      format: 'der',
      type: 'spki',
    });
  }
  return createPublicKey({ key: material, format: 'der', type: 'spki' });
}

export interface GeneratedCodeKeyPair {
  /** Base64 of the 32-byte seed. Goes in `CODE_SIGNING_PRIVATE_KEY`. */
  readonly privateKeyBase64: string;
  /** Base64 of the 32-byte public key. Goes in `CODE_VERIFY_PUBLIC_KEYS`. */
  readonly publicKeyBase64: string;
}

/**
 * Mint a key pair. Used by tests and by whoever sets up the secret store; the
 * result is never written to disk by this service and never logged.
 */
export function generateCodeKeyPair(): GeneratedCodeKeyPair {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const pkcs8 = privateKey.export({ format: 'der', type: 'pkcs8' });
  const spki = publicKey.export({ format: 'der', type: 'spki' });
  return {
    privateKeyBase64: pkcs8.subarray(PKCS8_ED25519_PREFIX.length).toString('base64'),
    publicKeyBase64: spki.subarray(SPKI_ED25519_PREFIX.length).toString('base64'),
  };
}

/* -------------------------------------------------------------------------- */
/* The signer                                                                  */
/* -------------------------------------------------------------------------- */

export type CodeVerdict = 'ok' | 'unknown_key' | 'bad_signature' | 'not_configured';

export interface MintRequest {
  readonly kind: CodeKind;
  readonly batchId: string;
  readonly ref: string;
  /** Unix seconds; 0 for a code that does not expire on its own. */
  readonly expiresAtUnix: number;
}

export interface CodeSigner {
  status(): CodeSigningStatus;
  isConfigured(): boolean;
  canMint(): boolean;
  /** The key id new codes are signed with, or null when minting is unavailable. */
  mintingKeyId(): string | null;
  /** A complete code string, or null when this deployment cannot mint. */
  mint(request: MintRequest): { body: CodeBody; token: string } | null;
  /** Constant-time by construction: an Ed25519 verify, not a string compare. */
  verify(code: ParsedCode): CodeVerdict;
}

interface Keyring {
  readonly mintingKeyId: string | null;
  readonly privateKey: KeyObject | null;
  readonly publicKeys: ReadonlyMap<string, KeyObject>;
  readonly problems: readonly string[];
}

function decodeBase64(value: string): Buffer | null {
  try {
    const buffer = Buffer.from(value, 'base64');
    return buffer.length === 0 ? null : buffer;
  } catch {
    return null;
  }
}

function buildKeyring(config: ApiConfig, logger: Logger): Keyring {
  const problems: string[] = [];
  const publicKeys = new Map<string, KeyObject>();
  let privateKey: KeyObject | null = null;

  for (const [keyId, material] of Object.entries(config.codeVerifyPublicKeys)) {
    const bytes = decodeBase64(material);
    if (bytes === null) {
      problems.push(`CODE_VERIFY_PUBLIC_KEYS entry "${keyId}" is not valid base64`);
      continue;
    }
    try {
      publicKeys.set(keyId, ed25519PublicKeyFrom(bytes));
    } catch {
      problems.push(`CODE_VERIFY_PUBLIC_KEYS entry "${keyId}" is not an Ed25519 public key`);
    }
  }

  const mintingKeyId = config.codeSigningKeyId;
  if (config.codeSigningPrivateKey !== null) {
    if (mintingKeyId === null) {
      problems.push('CODE_SIGNING_PRIVATE_KEY is set but CODE_SIGNING_KEY_ID is not');
    } else {
      const bytes = decodeBase64(config.codeSigningPrivateKey);
      if (bytes === null) {
        problems.push('CODE_SIGNING_PRIVATE_KEY is not valid base64');
      } else {
        try {
          privateKey = ed25519PrivateKeyFrom(bytes);
          // Deriving the public half means a deployment that can mint can
          // always verify what it minted, even if somebody forgot the
          // CODE_VERIFY_PUBLIC_KEYS entry for the current key.
          if (!publicKeys.has(mintingKeyId)) {
            publicKeys.set(mintingKeyId, createPublicKey(privateKey));
          }
        } catch {
          problems.push('CODE_SIGNING_PRIVATE_KEY is not an Ed25519 private key');
        }
      }
    }
  }

  for (const problem of problems) logger.error('codes.key_material_invalid', { problem });

  return {
    mintingKeyId: privateKey === null ? null : mintingKeyId,
    privateKey,
    publicKeys,
    problems,
  };
}

export function createCodeSigner(deps: { config: ApiConfig; logger: Logger }): CodeSigner {
  const logger = deps.logger.child({ component: 'codes' });
  const keyring = buildKeyring(deps.config, logger);

  function unavailableReason(): string | null {
    if (keyring.publicKeys.size > 0) return null;
    const gaps: string[] = [];
    if (deps.config.codeSigningPrivateKey === null) gaps.push('CODE_SIGNING_PRIVATE_KEY');
    if (deps.config.codeSigningKeyId === null) gaps.push('CODE_SIGNING_KEY_ID');
    if (Object.keys(deps.config.codeVerifyPublicKeys).length === 0) gaps.push('CODE_VERIFY_PUBLIC_KEYS');
    const missing = gaps.length === 0 ? 'no usable key material' : `${gaps.join(', ')} not set`;
    const invalid = keyring.problems.length === 0 ? '' : ` (${keyring.problems.join('; ')})`;
    return `Code signing is not configured: ${missing}${invalid}. See README "Blockers".`;
  }

  return {
    status() {
      const reason = unavailableReason();
      if (reason !== null) {
        // Degrade honestly. Scanning is switched off; it never degrades to
        // "accept anything", which is the only outcome worth guarding against.
        return { status: 'not_configured', reason, fallback: 'scanning_disabled' };
      }
      const keyIds = [...keyring.publicKeys.keys()].sort((a, b) =>
        a === keyring.mintingKeyId ? -1 : b === keyring.mintingKeyId ? 1 : a.localeCompare(b),
      );
      return { status: 'ready', keyIds: keyIds as [string, ...string[]], canMint: keyring.privateKey !== null };
    },

    isConfigured() {
      return unavailableReason() === null;
    },

    canMint() {
      return keyring.privateKey !== null && keyring.mintingKeyId !== null;
    },

    mintingKeyId() {
      return keyring.mintingKeyId;
    },

    mint(request) {
      const keyId = keyring.mintingKeyId;
      const privateKey = keyring.privateKey;
      if (keyId === null || privateKey === null) return null;
      const body: CodeBody = {
        version: 1,
        kind: request.kind,
        keyId,
        batchId: request.batchId,
        ref: request.ref,
        // 96 bits. The nonce is not a secret and not a capability; it is what
        // makes one code in a run unrelated to its neighbours, so scraping one
        // wrapper off Instagram tells you nothing about the next box.
        nonce: bytesToBase64Url(randomBytes(9)),
        expiresAtUnix: request.expiresAtUnix,
      };
      const signature = sign(null, Buffer.from(codeSigningInput(body), 'utf8'), privateKey);
      return { body, token: formatSomeMoreCode(body, new Uint8Array(signature)) };
    },

    verify(code) {
      if (!this.isConfigured()) return 'not_configured';
      const publicKey = keyring.publicKeys.get(code.body.keyId);
      if (publicKey === undefined) return 'unknown_key';
      const ok = verify(
        null,
        Buffer.from(code.signedInput, 'utf8'),
        publicKey,
        Buffer.from(code.signature),
      );
      return ok ? 'ok' : 'bad_signature';
    },
  };
}

/* -------------------------------------------------------------------------- */
/* Operator authentication (a stopgap, and labelled as one)                    */
/* -------------------------------------------------------------------------- */

/**
 * There is no staff identity provider yet (README, Blocker 9), so live-ops
 * writes are gated by a shared secret in `LIVE_OPS_TOKEN` *on top of* a normal
 * bearer token. Two things, one of which is a real account, is meaningfully
 * better than a shared secret alone; it is still not RBAC, and the blocker
 * stays open until it is.
 */
export interface OperatorGate {
  isConfigured(): boolean;
  unavailableReason(): string | null;
  /** Constant-time over sha256 digests, so token length never leaks either. */
  matches(presented: string | undefined): boolean;
}

export function createOperatorGate(config: ApiConfig): OperatorGate {
  const expected = config.liveOpsToken;
  return {
    isConfigured: () => expected !== null,
    unavailableReason: () =>
      expected === null
        ? 'Live-ops authoring is not configured: LIVE_OPS_TOKEN is not set. Reads still work. See README "Blockers".'
        : null,
    matches(presented) {
      if (expected === null || presented === undefined) return false;
      const a = digest(expected);
      const b = digest(presented);
      return timingSafeEqual(a, b);
    },
  };
}

/**
 * Hashing both sides first makes them the same fixed length, so
 * `timingSafeEqual` cannot throw on a length mismatch and the comparison leaks
 * nothing — not even how long the real token is.
 */
function digest(value: string): Buffer {
  return createHash('sha256').update(value, 'utf8').digest();
}
