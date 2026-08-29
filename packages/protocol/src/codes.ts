import { z } from 'zod';
import {
  IdSchema,
  NonNegativeIntSchema,
  PositiveIntSchema,
  TimestampSchema,
  UnitIntervalSchema,
  withIdempotency,
} from './common.js';

/**
 * `@somemore/protocol/codes` — the physical ↔ digital bridge (spec §14).
 *
 * One code format serves every scannable thing Some More prints or shows:
 * a wrapper on a box of sandwiches, a card at an event, and the QR a player
 * holds up so a friend can join their fire. There is exactly one grammar, one
 * parser and one signature check, because a second format is a second set of
 * bugs and a second thing to get wrong about what is safe to print.
 *
 * ## The shape of a code
 *
 * ```
 * somemore://c/SM1.<base64url(body)>.<base64url(signature)>
 *              ^^^ ^^^^^^^^^^^^^^^^  ^^^^^^^^^^^^^^^^^^^^^
 *              tag  canonical body   Ed25519 over "SM1.<body>"
 * ```
 *
 * The body is a canonical, positional, pipe-delimited string — not JSON.
 * A signature has to cover *exact bytes*, and "re-serialise the JSON the same
 * way the signer did" is a class of bug this format simply does not have.
 *
 * ```
 * 1|pkg|k1|bat_spring26|000f3a|Jq7dP2nX9wKe|1790000000
 * ^ ^   ^  ^            ^      ^            ^
 * | |   |  |            |      |            expiry, unix seconds (0 = never)
 * | |   |  |            |      per-code random nonce (>= 48 bits)
 * | |   |  |            reference: serial within the run, or an invite token
 * | |   |  batch id: which print run this code came from
 * | |   key id: which signing key, so keys rotate without a reprint
 * | kind: pkg | evt | camp
 * format version
 * ```
 *
 * ## What is deliberately NOT in a code
 *
 * A code printed on a mass-produced wrapper is **public**. It will be
 * photographed and posted. Therefore it is never a bearer token for anything
 * valuable, and it carries:
 *
 * - **no account, name, email or any other identifier of a person** — a code is
 *   minted long before anyone owns it, and a photographed wrapper must not
 *   identify the person who bought it;
 * - **no auth token, session token or capability** — the code authenticates
 *   *itself*, not a person. Redeeming one always requires an authenticated
 *   account, so a scraped code is worth nothing without one;
 * - **no reward id, sku, or monetary value** — a photo of a wrapper must not
 *   advertise "this one is the free kit". What a batch entitles you to lives
 *   server-side, keyed by batch id, and can be changed or revoked *after* the
 *   run is printed;
 * - **no secret** — the signature proves origin; there is nothing to keep
 *   hidden in the payload, and nothing in the database to steal either, because
 *   minted codes are never stored (only redemptions are).
 *
 * What it does carry is the minimum needed to answer four questions offline:
 * did we mint this (signature), is it still good (expiry), which run is it from
 * (batch, so one compromised run can be retired without invalidating every code
 * ever printed), and which code within that run (ref, so the database can
 * enforce claim-once on `(batch, ref)`).
 *
 * ## Why Ed25519 and not an HMAC
 *
 * An HMAC would be shorter, but only *we* could check it. Ed25519 makes the
 * code genuinely offline-verifiable: the client ships the public key and can
 * reject a mistyped or forged code with no network at all — which matters at a
 * campsite with one bar of signal, and which is also what keeps a scraper's
 * garbage from ever reaching storage. Verification is a signature check, not a
 * string comparison, so there is no timing side channel to leak.
 *
 * Nothing in this module imports a node built-in. Parsing and formatting are
 * pure; signing and verification live in the service (`src/codes/signing.ts`)
 * and in the client's WebCrypto path.
 */

/* -------------------------------------------------------------------------- */
/* base64url, without a dependency and without Buffer                          */
/* -------------------------------------------------------------------------- */

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

const B64URL_LOOKUP: Readonly<Record<string, number>> = (() => {
  const table: Record<string, number> = {};
  for (let i = 0; i < B64URL_ALPHABET.length; i += 1) {
    const ch = B64URL_ALPHABET[i];
    if (ch !== undefined) table[ch] = i;
  }
  return table;
})();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += B64URL_ALPHABET[b0 >> 2] ?? '';
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | ((b1 ?? 0) >> 4)] ?? '';
    if (b1 === undefined) break;
    out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | ((b2 ?? 0) >> 6)] ?? '';
    if (b2 === undefined) break;
    out += B64URL_ALPHABET[b2 & 0x3f] ?? '';
  }
  return out;
}

export function base64UrlToBytes(value: string): Uint8Array | null {
  if (value.length === 0) return new Uint8Array(0);
  if (value.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((value.length * 3) / 4));
  let outIndex = 0;
  let accumulator = 0;
  let bits = 0;
  for (const ch of value) {
    const digit = B64URL_LOOKUP[ch];
    if (digit === undefined) return null;
    accumulator = (accumulator << 6) | digit;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[outIndex] = (accumulator >> bits) & 0xff;
      outIndex += 1;
    }
  }
  return out.subarray(0, outIndex);
}

const UTF8 = new TextEncoder();

export function utf8Bytes(value: string): Uint8Array {
  return UTF8.encode(value);
}

/* -------------------------------------------------------------------------- */
/* The code grammar                                                            */
/* -------------------------------------------------------------------------- */

/** Version tag. Bumping it is how the body layout changes without a reprint. */
export const CODE_FORMAT_TAG = 'SM1';

/** What a phone camera opens. The bare `SM1.…` token is accepted too. */
export const CODE_URI_PREFIX = 'somemore://c/';

/**
 * `pkg`  — printed on physical product (a wrapper, a box, an insert).
 * `evt`  — an activation, a card handed out at an event, a collaboration drop.
 * `camp` — a campsite invite shown on a screen so a friend can join the fire.
 *
 * `camp` is the only kind whose `ref` is a bearer invite token, and it is the
 * only kind that is never printed on anything mass-produced: it is displayed,
 * short-lived, use-capped and revocable, exactly as an invite link already is.
 */
export const CodeKindValues = ['pkg', 'evt', 'camp'] as const;
export const CodeKindSchema = z.enum(CodeKindValues);
export type CodeKind = z.infer<typeof CodeKindSchema>;

export const CodeKeyIdSchema = z.string().regex(/^[a-z0-9_]{1,16}$/, 'key ids are lowercase and short');
export const CodeBatchIdSchema = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'batch ids must be URL-safe');
export const CodeRefSchema = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/, 'code refs must be base64url-safe');
export const CodeNonceSchema = z.string().regex(/^[A-Za-z0-9_-]{8,32}$/, 'nonces are base64url, >= 48 bits');

/** The signed part of a code. Every field is here because something needs it. */
export const CodeBodySchema = z.object({
  version: z.literal(1),
  kind: CodeKindSchema,
  keyId: CodeKeyIdSchema,
  batchId: CodeBatchIdSchema,
  /** Serial within the run (`pkg`/`evt`), or the invite token (`camp`). */
  ref: CodeRefSchema,
  nonce: CodeNonceSchema,
  /** Unix seconds. `0` means "never expires" — used by campsite-independent runs. */
  expiresAtUnix: NonNegativeIntSchema,
});
export type CodeBody = z.infer<typeof CodeBodySchema>;

const FIELD_SEPARATOR = '|';

/** Canonical body bytes. The signature is over `SM1.<base64url(this)>`. */
export function encodeCodeBody(body: CodeBody): string {
  return [
    String(body.version),
    body.kind,
    body.keyId,
    body.batchId,
    body.ref,
    body.nonce,
    String(body.expiresAtUnix),
  ].join(FIELD_SEPARATOR);
}

export const CodeParseFailureValues = [
  'malformed',
  'unsupported_version',
  'bad_encoding',
  'bad_field',
] as const;
export const CodeParseFailureSchema = z.enum(CodeParseFailureValues);
export type CodeParseFailure = z.infer<typeof CodeParseFailureSchema>;

export interface ParsedCode {
  /** The bare token, with any `somemore://c/` wrapper stripped. */
  readonly token: string;
  readonly body: CodeBody;
  /** Exactly the bytes the signature covers. */
  readonly signedInput: string;
  readonly signature: Uint8Array;
}

export type CodeParseResult =
  | { readonly ok: true; readonly code: ParsedCode }
  | { readonly ok: false; readonly reason: CodeParseFailure };

/** Strip the URI wrapper, if there is one. Case-sensitive on purpose. */
export function stripCodeUri(input: string): string {
  const trimmed = input.trim();
  return trimmed.startsWith(CODE_URI_PREFIX) ? trimmed.slice(CODE_URI_PREFIX.length) : trimmed;
}

/**
 * Parse a code without verifying it.
 *
 * Parsing never says whether a code is *real* — only whether it is shaped like
 * one. Verification needs a key and lives in the service; keeping the two apart
 * is what stops a caller accidentally trusting a parse.
 */
export function parseSomeMoreCode(input: string): CodeParseResult {
  if (typeof input !== 'string' || input.length === 0 || input.length > 512) {
    return { ok: false, reason: 'malformed' };
  }
  const token = stripCodeUri(input);
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [tag, encodedBody, encodedSignature] = parts as [string, string, string];
  if (tag !== CODE_FORMAT_TAG) return { ok: false, reason: 'unsupported_version' };

  const bodyBytes = base64UrlToBytes(encodedBody);
  const signature = base64UrlToBytes(encodedSignature);
  if (bodyBytes === null || signature === null) return { ok: false, reason: 'bad_encoding' };
  if (signature.length !== 64) return { ok: false, reason: 'bad_encoding' };

  let decoded: string;
  try {
    decoded = new TextDecoder('utf-8', { fatal: true }).decode(bodyBytes);
  } catch {
    return { ok: false, reason: 'bad_encoding' };
  }

  const fields = decoded.split(FIELD_SEPARATOR);
  if (fields.length !== 7) return { ok: false, reason: 'bad_field' };
  const [version, kind, keyId, batchId, ref, nonce, expiry] = fields as [
    string, string, string, string, string, string, string,
  ];
  if (version !== '1') return { ok: false, reason: 'unsupported_version' };
  if (!/^\d{1,10}$/.test(expiry)) return { ok: false, reason: 'bad_field' };

  const parsed = CodeBodySchema.safeParse({
    version: 1,
    kind,
    keyId,
    batchId,
    ref,
    nonce,
    expiresAtUnix: Number.parseInt(expiry, 10),
  });
  if (!parsed.success) return { ok: false, reason: 'bad_field' };

  // Round-trip check: the canonical encoding of what we parsed must be exactly
  // what was signed. Without this a body with, say, a leading zero on the
  // expiry would verify under one encoding and be stored under another.
  if (encodeCodeBody(parsed.data) !== decoded) return { ok: false, reason: 'bad_field' };

  return {
    ok: true,
    code: {
      token,
      body: parsed.data,
      signedInput: `${CODE_FORMAT_TAG}.${encodedBody}`,
      signature,
    },
  };
}

/** Assemble a code string from a body and its signature. */
export function formatSomeMoreCode(body: CodeBody, signature: Uint8Array): string {
  const encodedBody = bytesToBase64Url(utf8Bytes(encodeCodeBody(body)));
  return `${CODE_FORMAT_TAG}.${encodedBody}.${bytesToBase64Url(signature)}`;
}

/** The exact string signed for a body, so signer and verifier cannot diverge. */
export function codeSigningInput(body: CodeBody): string {
  return `${CODE_FORMAT_TAG}.${bytesToBase64Url(utf8Bytes(encodeCodeBody(body)))}`;
}

/** What goes on the wrapper / into the QR image. */
export function codeToUri(token: string): string {
  return `${CODE_URI_PREFIX}${token}`;
}

/* -------------------------------------------------------------------------- */
/* Batches                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * What redeeming a code from this run gets you.
 *
 * Entitlements live on the batch, never in the code, so a run that was printed
 * for one promotion can be repointed, downgraded or switched off entirely after
 * the boxes are already in a warehouse.
 */
export const CodeEntitlementSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('reward'), rewardCode: z.string().min(1).max(64) }),
  /** A code that unlocks a campaign's content but grants nothing on its own. */
  z.object({ type: z.literal('content'), documentSlug: z.string().min(1).max(64) }),
  z.object({ type: z.literal('campsite_invite') }),
]);
export type CodeEntitlement = z.infer<typeof CodeEntitlementSchema>;

export const CodeBatchStatusValues = ['active', 'paused', 'retired'] as const;
export const CodeBatchStatusSchema = z.enum(CodeBatchStatusValues);
export type CodeBatchStatus = z.infer<typeof CodeBatchStatusSchema>;

export const CodeBatchSchema = z.object({
  id: IdSchema,
  /** Human label for the run: "Spring 26 wrapper, print order 4471". */
  label: z.string().min(1).max(120),
  kind: CodeKindSchema,
  keyId: CodeKeyIdSchema,
  entitlement: CodeEntitlementSchema,
  status: CodeBatchStatusSchema.default('active'),
  /** How many codes have been minted; a `ref` beyond this was never printed. */
  mintedCount: NonNegativeIntSchema.default(0),
  /** Ceiling on the run. Minting past it is refused. */
  plannedSize: PositiveIntSchema.max(5_000_000),
  redeemedCount: NonNegativeIntSchema.default(0),
  /** One redemption per account, which is what a per-person promotion means. */
  perAccountLimit: PositiveIntSchema.max(100).default(1),
  /** Redemption window, evaluated server-side against the injected clock. */
  activeFrom: TimestampSchema.nullable().default(null),
  activeUntil: TimestampSchema.nullable().default(null),
  /** Baked into every code in the run so a wrapper expires without a lookup. */
  codeTtlDays: PositiveIntSchema.max(3650).nullable().default(null),
  createdAt: TimestampSchema,
  createdBy: z.string().max(64),
  updatedAt: TimestampSchema,
  retiredAt: TimestampSchema.nullable().default(null),
  retiredReason: z.string().max(240).nullable().default(null),
  /**
   * Set when redemption velocity says the run is probably on the internet.
   * Flagging is automatic; retiring is not — pulling a live run punishes every
   * honest customer holding a box, so a human decides.
   */
  flaggedAt: TimestampSchema.nullable().default(null),
  flagReason: z.string().max(240).nullable().default(null),
});
export type CodeBatch = z.infer<typeof CodeBatchSchema>;

export const CreateCodeBatchRequestSchema = withIdempotency(
  z.object({
    label: z.string().min(1).max(120),
    kind: CodeKindSchema.default('pkg'),
    entitlement: CodeEntitlementSchema,
    plannedSize: PositiveIntSchema.max(5_000_000),
    perAccountLimit: PositiveIntSchema.max(100).default(1),
    activeFrom: TimestampSchema.nullable().default(null),
    activeUntil: TimestampSchema.nullable().default(null),
    codeTtlDays: PositiveIntSchema.max(3650).nullable().default(null),
  }),
);
export type CreateCodeBatchRequest = z.infer<typeof CreateCodeBatchRequestSchema>;

/** Minting is the only moment a code string exists on our side of the wire. */
export const MintCodesRequestSchema = withIdempotency(
  z.object({ count: PositiveIntSchema.max(10_000) }),
);
export type MintCodesRequest = z.infer<typeof MintCodesRequestSchema>;

export const MintedCodeSchema = z.object({
  ref: CodeRefSchema,
  token: z.string().min(16).max(512),
  uri: z.string().min(16).max(560),
});
export type MintedCode = z.infer<typeof MintedCodeSchema>;

export const MintCodesResultSchema = z.object({
  batchId: IdSchema,
  minted: z.array(MintedCodeSchema),
  mintedCount: NonNegativeIntSchema,
  /**
   * Codes are never persisted. This response is the only copy; it goes to the
   * print vendor and nowhere else.
   */
  storedByService: z.literal(false),
});
export type MintCodesResult = z.infer<typeof MintCodesResultSchema>;

export const RetireCodeBatchRequestSchema = withIdempotency(
  z.object({ reason: z.string().min(1).max(240) }),
);
export type RetireCodeBatchRequest = z.infer<typeof RetireCodeBatchRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Redemption                                                                  */
/* -------------------------------------------------------------------------- */

export const CodeRedemptionSchema = z.object({
  id: IdSchema,
  batchId: IdSchema,
  codeRef: CodeRefSchema,
  accountId: IdSchema,
  redeemedAt: TimestampSchema,
  /** Salted hash. A raw client IP never reaches a redemption record. */
  ipHash: z.string().length(64),
  deviceId: z.string().max(128).nullable().default(null),
  grantId: IdSchema.nullable().default(null),
  riskScore: UnitIntervalSchema.default(0),
});
export type CodeRedemption = z.infer<typeof CodeRedemptionSchema>;

export const RedeemCodeRequestSchema = withIdempotency(
  z.object({
    /** The scanned string, with or without the `somemore://c/` wrapper. */
    code: z.string().min(8).max(512),
    deviceId: z.string().min(8).max(128).optional(),
  }),
);
export type RedeemCodeRequest = z.infer<typeof RedeemCodeRequestSchema>;

export const CodeRejectionValues = [
  'malformed',
  'bad_signature',
  'unknown_key',
  'expired',
  'unknown_batch',
  'batch_retired',
  'batch_not_active',
  'never_minted',
  'already_redeemed',
  'limit_reached',
  'wrong_kind',
] as const;
export const CodeRejectionSchema = z.enum(CodeRejectionValues);
export type CodeRejection = z.infer<typeof CodeRejectionSchema>;

/**
 * A successful redemption. Every failure is an `ApiError` instead — `code_invalid`,
 * `code_revoked` or `code_already_redeemed` — carrying a {@link CodeRejection}
 * in `error.details.reason`, so a scanner has one place to look and the service
 * has one error envelope.
 *
 * `code_invalid` covers "malformed", "bad signature", "unknown key", "unknown
 * batch" and "never minted" with a single, uniform reason of `invalid`.
 * Distinguishing them would tell someone feeding us guesses exactly how close
 * they were, which is the one thing a brute-force attempt needs.
 */
export const RedeemCodeResultSchema = z.object({
  status: z.literal('redeemed'),
  batchId: IdSchema,
  /** What the player actually got, in words the terminal can print. */
  awarded: z.string().max(160),
  grantId: IdSchema.nullable().default(null),
  redemption: CodeRedemptionSchema,
});
export type RedeemCodeResult = z.infer<typeof RedeemCodeResultSchema>;

/**
 * Signing-key availability, reported the way voice and payments report theirs:
 * a structured "not configured", never a throw and never a fake success.
 */
export const CodeSigningStatusSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('ready'),
    /** Key ids this deployment can verify; the first is the minting key. */
    keyIds: z.array(CodeKeyIdSchema).min(1).max(8),
    canMint: z.boolean(),
  }),
  z.object({
    status: z.literal('not_configured'),
    reason: z.string().max(240),
    /** Scanning degrades to "we cannot check that here", never to a free kit. */
    fallback: z.literal('scanning_disabled'),
  }),
]);
export type CodeSigningStatus = z.infer<typeof CodeSigningStatusSchema>;
