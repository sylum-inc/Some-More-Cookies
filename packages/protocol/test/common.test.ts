import { describe, expect, it } from 'vitest';
import {
  ErrorEnvelopeSchema,
  IdSchema,
  IdempotencyKeySchema,
  MoneySchema,
  PageRequestSchema,
  TimestampSchema,
  addMoney,
  containsRawCardData,
  JsonValueSchema,
  MAX_SCANNABLE_DEPTH,
  scanForCardData,
  stringCarriesPan,
  looksLikeCardNumber,
  money,
  multiplyMoney,
  pageSchema,
} from '../src/index.js';

describe('primitives', () => {
  it('accepts URL-safe ids and rejects hostile ones', () => {
    expect(IdSchema.safeParse('acct_01J8Z').success).toBe(true);
    expect(IdSchema.safeParse('').success).toBe(false);
    expect(IdSchema.safeParse('../../etc/passwd').success).toBe(false);
    expect(IdSchema.safeParse('has space').success).toBe(false);
    expect(IdSchema.safeParse('x'.repeat(200)).success).toBe(false);
  });

  it('accepts ISO timestamps only', () => {
    expect(TimestampSchema.safeParse(new Date().toISOString()).success).toBe(true);
    expect(TimestampSchema.safeParse('2026-08-29').success).toBe(false);
    expect(TimestampSchema.safeParse(1_756_000_000_000).success).toBe(false);
  });

  it('constrains idempotency keys', () => {
    expect(IdempotencyKeySchema.safeParse('order-create-01J8ZQ').success).toBe(true);
    expect(IdempotencyKeySchema.safeParse('short').success).toBe(false);
    expect(IdempotencyKeySchema.safeParse('has spaces here').success).toBe(false);
  });
});

describe('money', () => {
  it('is integer minor units with an ISO currency', () => {
    expect(MoneySchema.safeParse({ currency: 'USD', amountMinor: 3200 }).success).toBe(true);
    expect(MoneySchema.safeParse({ currency: 'usd', amountMinor: 3200 }).success).toBe(false);
    expect(MoneySchema.safeParse({ currency: 'USD', amountMinor: 32.5 }).success).toBe(false);
  });

  it('adds and multiplies safely', () => {
    expect(addMoney(money(3200), money(1200))).toEqual({ currency: 'USD', amountMinor: 4400 });
    expect(multiplyMoney(money(3200), 0.0725)).toEqual({ currency: 'USD', amountMinor: 232 });
    expect(() => addMoney(money(100, 'USD'), money(100, 'EUR'))).toThrow(/currency mismatch/);
  });
});

describe('error envelope + pagination', () => {
  it('validates the error envelope shape', () => {
    expect(
      ErrorEnvelopeSchema.safeParse({
        error: { code: 'not_found', message: 'nope', requestId: 'req_1' },
      }).success,
    ).toBe(true);
    expect(
      ErrorEnvelopeSchema.safeParse({ error: { code: 'teapot', message: 'x', requestId: 'r' } }).success,
    ).toBe(false);
  });

  it('defaults and bounds the page request', () => {
    expect(PageRequestSchema.parse({})).toEqual({ limit: 25 });
    expect(PageRequestSchema.safeParse({ limit: 500 }).success).toBe(false);
    const page = pageSchema(IdSchema);
    expect(page.safeParse({ items: ['a', 'b'], nextCursor: null }).success).toBe(true);
  });
});

describe('raw card data guard', () => {
  it('detects PAN-shaped strings by Luhn', () => {
    expect(looksLikeCardNumber('4242424242424242')).toBe(true);
    expect(looksLikeCardNumber('4242 4242 4242 4242')).toBe(true);
    expect(looksLikeCardNumber('4242424242424241')).toBe(false);
    expect(looksLikeCardNumber('12345')).toBe(false);
  });

  it('rejects forbidden field names anywhere in the body', () => {
    expect(containsRawCardData({ payment: { cardNumber: 'x' } })).toBe(true);
    expect(containsRawCardData({ a: [{ cvc: '123' }] })).toBe(true);
    expect(containsRawCardData({ exp_month: 12 })).toBe(true);
    expect(containsRawCardData({ paymentMethodToken: 'pm_123', methodType: 'apple_pay' })).toBe(false);
  });

  it('rejects a PAN smuggled into an innocent field', () => {
    expect(containsRawCardData({ note: '4242424242424242' })).toBe(true);
    expect(containsRawCardData({ note: 'my order reference is SM-7K3Q9F' })).toBe(false);
  });

  /*
   * The audit recorded this as "not fixed, argued": past twelve levels the scan
   * gave up and returned `false`, and the argument was that nothing nested that
   * deeply survives schema validation anyway.
   *
   * The argument was wrong. `JsonValueSchema` is recursive with no depth bound
   * and the live-ops document routes take exactly that, so a card number under
   * sixteen levels of nesting was reported clean *and* accepted *and* stored.
   */
  it('says when it could not finish looking, rather than saying it found nothing', () => {
    let deep: unknown = { cardNumber: '4242424242424242' };
    for (let i = 0; i < 15; i += 1) deep = { nest: deep };

    expect(scanForCardData(deep)).toBe('too-deep');
    expect(JsonValueSchema.safeParse(deep).success, 'the schema was the backstop').toBe(true);

    // Shallow enough to see is still seen, and clean is still clean.
    let shallow: unknown = { cardNumber: '4242424242424242' };
    for (let i = 0; i < 3; i += 1) shallow = { nest: shallow };
    expect(scanForCardData(shallow)).toBe('card-data');
    expect(scanForCardData({ a: { b: { c: 'nothing here' } } })).toBe('clean');
  });

  it('reports card data it can see even when part of the body is too deep', () => {
    // Otherwise the more hostile body gets the milder error.
    let deep: unknown = { harmless: true };
    for (let i = 0; i < 15; i += 1) deep = { nest: deep };
    expect(scanForCardData({ cvc: '123', buried: deep })).toBe('card-data');
  });

  it('walks to the documented depth, and no further', () => {
    const at = (levels: number): unknown => {
      let value: unknown = { cvc: '123' };
      for (let i = 0; i < levels; i += 1) value = { nest: value };
      return value;
    };
    expect(scanForCardData(at(MAX_SCANNABLE_DEPTH - 1))).toBe('card-data');
    expect(scanForCardData(at(MAX_SCANNABLE_DEPTH + 2))).toBe('too-deep');
  });

  /*
   * A card number reaches an API it has no business reaching inside free
   * text — a delivery note, a gift message, a campsite named after whatever
   * was on the desk. Luhn-checking the whole field only ever caught the case
   * where the PAN *is* the field.
   */
  it('finds a PAN written the way a person writes one', () => {
    for (const text of [
      'my card is 4242 4242 4242 4242 thanks',
      'card: 4242-4242-4242-4242.',
      'amex 3782 822463 10005',
      'leave it with 4000056655665556 please',
    ]) {
      expect(stringCarriesPan(text)).toBe(true);
    }
  });

  /*
   * And leaves identifiers alone. A run of digits inside a hyphenated or
   * alphanumeric token is a token: `6250-7247-4727-9` is four-four-four and
   * Luhn-clean, and it is the middle of a v4 UUID.
   */
  it('does not mistake this service’s own ids for card numbers', () => {
    for (const text of [
      'swh-0eca6250-7247-4727-9a05-b5e355d6233e',
      'SM01-4X7Q-92BK',
      '2026-08-30T03:00:00.000Z',
      'call me on 555 0134',
      // Thirteen digits, but not a card number: Luhn says no.
      '1234567890123',
    ]) {
      expect(stringCarriesPan(text)).toBe(false);
    }
  });
});
