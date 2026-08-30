import { z } from 'zod';

/* -------------------------------------------------------------------------- */
/* Primitives                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Opaque identifier. Ids are server-minted, URL-safe and stable forever.
 * Format: `<prefix>_<uuid-ish>`; we only constrain the character set and length
 * so that storage adapters (Postgres `text`) and URLs stay predictable.
 */
export const IdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'ids must be URL-safe');

export const TimestampSchema = z.iso.datetime({ offset: true });

export const UnitIntervalSchema = z.number().min(0).max(1);

export const NonNegativeIntSchema = z.number().int().min(0);

export const PositiveIntSchema = z.number().int().min(1);

/** uint32 world seed — the sim derives every deterministic detail from this. */
export const SeedSchema = z.number().int().min(0).max(0xffffffff);

export const SemVerSchema = z.string().regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);

export const LocaleSchema = z.string().regex(/^[a-z]{2}(?:-[A-Z]{2})?$/);

export const CountryCodeSchema = z.string().regex(/^[A-Z]{2}$/);

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

export const PlatformValues = ['ios', 'android', 'web', 'macos', 'windows', 'visionos'] as const;
export const PlatformSchema = z.enum(PlatformValues);
export type Platform = z.infer<typeof PlatformSchema>;

/**
 * Client-supplied key that makes a mutating operation replay-safe.
 * Same key + same payload => original result; same key + different payload =>
 * `idempotency_key_conflict`.
 */
export const IdempotencyKeySchema = z
  .string()
  .min(8)
  .max(200)
  .regex(/^[A-Za-z0-9_.:-]+$/, 'idempotency keys must be URL-safe');

/** Mixin: every mutating request in this protocol carries an idempotency key. */
export const IdempotentRequestSchema = z.object({
  idempotencyKey: IdempotencyKeySchema,
});

/** Wrap any request object so that it requires an idempotency key. */
export function withIdempotency<Shape extends z.ZodRawShape>(schema: z.ZodObject<Shape>) {
  return schema.extend({ idempotencyKey: IdempotencyKeySchema });
}

/* -------------------------------------------------------------------------- */
/* Geometry                                                                    */
/* -------------------------------------------------------------------------- */

export const Vec3Schema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
});
export type Vec3 = z.infer<typeof Vec3Schema>;

/* -------------------------------------------------------------------------- */
/* Money                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Money is always integer minor units (cents) plus an ISO-4217 currency.
 * Never floats, never strings — rounding happens once, at quote time.
 */
export const MoneySchema = z.object({
  currency: CurrencySchema,
  amountMinor: z.number().int(),
});
export type Money = z.infer<typeof MoneySchema>;

export const NonNegativeMoneySchema = MoneySchema.extend({
  amountMinor: NonNegativeIntSchema,
});

export function money(amountMinor: number, currency = 'USD'): Money {
  return { currency, amountMinor };
}

export function addMoney(a: Money, b: Money): Money {
  if (a.currency !== b.currency) throw new Error(`currency mismatch: ${a.currency} vs ${b.currency}`);
  return { currency: a.currency, amountMinor: a.amountMinor + b.amountMinor };
}

export function multiplyMoney(a: Money, factor: number): Money {
  return { currency: a.currency, amountMinor: Math.round(a.amountMinor * factor) };
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                        */
/* -------------------------------------------------------------------------- */

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.string(), JsonValueSchema),
  ]),
);

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

export const ApiErrorCodeValues = [
  'bad_request',
  'validation_failed',
  'unauthorized',
  'forbidden',
  'not_found',
  'method_not_allowed',
  'conflict',
  'idempotency_key_conflict',
  'idempotency_key_required',
  'illegal_state_transition',
  'rate_limited',
  'precondition_failed',
  'payload_too_large',
  'unsupported_media_type',
  'payment_provider_not_configured',
  'payment_failed',
  'webhook_signature_invalid',
  'reward_already_claimed',
  'anti_abuse_rejected',
  // live ops + the physical/digital bridge
  'content_invalid',
  'code_invalid',
  'code_already_redeemed',
  'code_revoked',
  'service_not_configured',
  'schema_version_unsupported',
  'raw_card_data_rejected',
  'internal_error',
] as const;
export const ApiErrorCodeSchema = z.enum(ApiErrorCodeValues);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

/** Every non-2xx response body in the service has exactly this shape. */
export const ErrorEnvelopeSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    requestId: z.string(),
    details: JsonValueSchema.optional(),
  }),
});
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

export const PageRequestSchema = z.object({
  cursor: z.string().max(256).optional(),
  limit: z.number().int().min(1).max(100).default(25),
});
export type PageRequest = z.infer<typeof PageRequestSchema>;

export function pageSchema<T extends z.ZodType>(item: T) {
  return z.object({
    items: z.array(item),
    nextCursor: z.string().nullable(),
  });
}

/* -------------------------------------------------------------------------- */
/* PCI guard                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Field names that must never appear anywhere in a request body. We are not,
 * and never will be, in scope for raw PAN handling: card details go straight
 * from the client SDK to the payment provider and only a provider token or
 * intent id ever reaches us.
 */
export const FORBIDDEN_CARD_FIELDS: readonly string[] = [
  'cardnumber',
  'card_number',
  'cardnum',
  'pan',
  'primaryaccountnumber',
  'cvc',
  'cvv',
  'cvv2',
  'csc',
  'securitycode',
  'expmonth',
  'exp_month',
  'expyear',
  'exp_year',
  'track1',
  'track2',
];

/**
 * The two shapes a person actually writes a card number in, and only where a
 * person would have written one.
 *
 * `PAN_BARE` is thirteen to nineteen digits in a row; `PAN_GROUPED` is the
 * same digits in the groups printed on the card, with one consistent
 * separator — 4-4-4-4 and 4-4-4-3 for most schemes, 4-6-5 for Amex, 4-4-4-4-3
 * for the nineteen-digit ones. Nothing else is how a card number gets typed.
 *
 * The `[0-9A-Za-z_-]` lookarounds are the part that took a second attempt. A
 * candidate has to be delimited by whitespace, punctuation or the ends of the
 * string — because a run of digits *inside* an identifier is an identifier.
 * Without that guard a v4 UUID hands over `6250-7247-4727-9`, four-four-four
 * and Luhn-clean, roughly one time in eighty thousand, and a suite that mints
 * a few hundred ids a run goes quietly flaky. It also means a PAN glued to a
 * word is not caught, which is the honest limit of the whole idea: this scan
 * exists to turn a client's mistake into a loud refusal, not to defeat someone
 * who is trying to smuggle a card number past it.
 */
const PAN_BARE = /(?<![0-9A-Za-z_-])[0-9]{13,19}(?![0-9A-Za-z_-])/g;
const PAN_GROUPED =
  /(?<![0-9A-Za-z_-])(?:[0-9]{4}([ -])[0-9]{4}\1[0-9]{4}\1[0-9]{3,4}(?:\1[0-9]{3})?|[0-9]{4}([ -])[0-9]{6}\2[0-9]{5})(?![0-9A-Za-z_-])/g;

function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Luhn check, used to distinguish a real PAN from an arbitrary long number. */
export function looksLikeCardNumber(value: string): boolean {
  const digits = value.replace(/[ -]/g, '');
  if (!/^\d{13,19}$/.test(digits)) return false;
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    const ch = digits[i];
    if (ch === undefined) return false;
    let d = ch.charCodeAt(0) - 48;
    if (double) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    double = !double;
  }
  return sum % 10 === 0;
}

/**
 * Does this string contain a card number *anywhere in it*?
 *
 * The obvious version — Luhn-check the whole string — only catches a PAN that
 * is a field of its own, and the way a PAN actually reaches an API it has no
 * business reaching is inside free text: a delivery note, a gift message, a
 * campsite somebody named after the card they were holding. So every delimited
 * digit run is checked, not just the whole value.
 */
export function stringCarriesPan(value: string): boolean {
  if (value.length > 100_000) return false;
  // `matchAll` on a /g regex needs no lastIndex bookkeeping, which a shared
  // module-level /g regex with `.test()` very much would.
  for (const pattern of [PAN_BARE, PAN_GROUPED]) {
    for (const match of value.matchAll(pattern)) {
      if (looksLikeCardNumber(match[0])) return true;
    }
  }
  return false;
}

/**
 * Deep-scan an arbitrary decoded JSON body for raw card data. Used by the API
 * edge *before* schema parsing (which would otherwise silently strip the keys)
 * so that a client mistake is loudly rejected instead of quietly dropped.
 */
/**
 * How deep the scan will walk before it gives up.
 *
 * The cap has to exist: this runs on every request body, before validation, and
 * an unbounded recursive walk over a hostile hundred-thousand-deep body is a
 * stack overflow rather than a rejection. Twelve is more than double the
 * deepest thing the product legitimately has — the largest environment manifest
 * in the catalogue is five.
 */
export const MAX_SCANNABLE_DEPTH = 12;

/**
 * What the scan found, including the case where it could not finish.
 *
 * The third outcome is the point. This used to return a plain `false` past the
 * depth cap, and the argument for that was that a body nested deeper than
 * twelve is not a shape any route's schema accepts — so the data would be
 * rejected anyway.
 *
 * **That argument was wrong, and this is the bug it hid.** `JsonValueSchema` is
 * recursive with no depth bound, and the live-ops document routes take exactly
 * that and store what they are given. Measured: a body with `cardNumber` under
 * sixteen levels of nesting is reported clean by the scan *and* accepted by
 * Zod. There was a real path to storing a card number in this service, and it
 * was guarded by a function that answered "no card data here" when what it
 * meant was "I stopped looking".
 *
 * So the scan now says which of those it means, and the caller refuses both.
 * "I could not check this" is not a pass.
 */
export type CardScanResult = 'clean' | 'card-data' | 'too-deep';

export function scanForCardData(value: unknown, depth = 0): CardScanResult {
  if (value === null || value === undefined) return 'clean';
  if (depth > MAX_SCANNABLE_DEPTH) return 'too-deep';
  if (typeof value === 'string') return stringCarriesPan(value) ? 'card-data' : 'clean';
  if (typeof value !== 'object') return 'clean';

  // `too-deep` is remembered rather than returned at once, because a body that
  // is both too deep *and* carries a card number at a shallower level should be
  // reported as what it actually is.
  let deep = false;
  if (Array.isArray(value)) {
    for (const child of value) {
      const found = scanForCardData(child, depth + 1);
      if (found === 'card-data') return 'card-data';
      if (found === 'too-deep') deep = true;
    }
    return deep ? 'too-deep' : 'clean';
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_CARD_FIELDS.includes(normalizeKey(key))) return 'card-data';
    const found = scanForCardData(child, depth + 1);
    if (found === 'card-data') return 'card-data';
    if (found === 'too-deep') deep = true;
  }
  return deep ? 'too-deep' : 'clean';
}

/**
 * The narrow question: does this definitely carry card data?
 *
 * Kept because it reads well at a call site that has already established the
 * body is scannable. Anything guarding an ingress wants `scanForCardData`,
 * because a `false` from here still means "or I could not tell".
 */
export function containsRawCardData(value: unknown): boolean {
  return scanForCardData(value) === 'card-data';
}
