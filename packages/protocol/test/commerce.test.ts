import { describe, expect, it } from 'vitest';
import {
  AddCartItemRequestSchema,
  AddressSchema,
  CancelOrderRequestSchema,
  CartSchema,
  CreateOrderRequestSchema,
  CreatePaymentIntentRequestSchema,
  CreateRefundRequestSchema,
  IdempotencyRecordSchema,
  NON_CANCELLABLE_STATUSES,
  ORDER_TRANSITIONS,
  OrderSchema,
  OrderStatusValues,
  PaymentMethodTypeSchema,
  PaymentRefSchema,
  PaymentWebhookEventSchema,
  ProductSchema,
  PromotionSchema,
  REFUND_TRANSITIONS,
  RefundSchema,
  TransitionOrderRequestSchema,
  canTransitionOrder,
  canTransitionRefund,
} from '../src/index.js';
import { NOW, LATER, address, shippingQuote, taxQuote } from './fixtures.js';

const usd = (n: number) => ({ currency: 'USD', amountMinor: n });

const product = {
  id: 'prd_1',
  sku: 'SM-KIT-001',
  name: 'Some More Kit',
  kind: 'physical',
  basePrice: usd(3200),
  variants: [
    { id: 'var_1', sku: 'SM-KIT-001-4', name: 'Four pack', priceDelta: usd(0) },
  ],
  createdAt: NOW,
  updatedAt: NOW,
};

describe('catalog', () => {
  it('parses the flagship product with defaults', () => {
    const parsed = ProductSchema.parse(product);
    expect(parsed.status).toBe('draft');
    expect(parsed.requiresShipping).toBe(true);
    expect(parsed.maxPerOrder).toBe(4);
    expect(parsed.shipsToCountries).toEqual(['US']);
    expect(parsed.variants[0]?.inventoryPolicy).toBe('track');
  });

  it('rejects a product with no variants, a lowercase sku or negative price', () => {
    expect(ProductSchema.safeParse({ ...product, variants: [] }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...product, sku: 'sm-kit-001' }).success).toBe(false);
    expect(ProductSchema.safeParse({ ...product, basePrice: usd(-100) }).success).toBe(false);
  });
});

describe('cart', () => {
  it('starts empty with a subtotal', () => {
    const cart = CartSchema.parse({
      id: 'crt_1',
      accountId: 'acct_1',
      currency: 'USD',
      subtotal: usd(0),
      createdAt: NOW,
      updatedAt: NOW,
      revision: 0,
    });
    expect(cart.items).toEqual([]);
    expect(cart.convertedOrderId).toBeNull();
  });

  it('requires an idempotency key and a positive quantity to add an item', () => {
    expect(AddCartItemRequestSchema.safeParse({ productId: 'prd_1', variantId: 'var_1' }).success).toBe(false);
    expect(
      AddCartItemRequestSchema.safeParse({ idempotencyKey: 'cart-0001', productId: 'prd_1', variantId: 'var_1', quantity: 0 })
        .success,
    ).toBe(false);
    expect(
      AddCartItemRequestSchema.parse({ idempotencyKey: 'cart-0001', productId: 'prd_1', variantId: 'var_1' }).quantity,
    ).toBe(1);
  });
});

describe('addresses and quote boundaries', () => {
  it('requires a two-letter uppercase country', () => {
    expect(AddressSchema.safeParse(address).success).toBe(true);
    expect(AddressSchema.safeParse({ ...address, country: 'usa' }).success).toBe(false);
    expect(AddressSchema.safeParse({ ...address, line1: '' }).success).toBe(false);
  });

  it('captures tax and shipping as expiring boundary objects', () => {
    expect(taxQuote.expiresAt).toBe(LATER);
    expect(shippingQuote.requiresColdChain).toBe(true);
  });
});

describe('order state machine', () => {
  it('walks the happy path', () => {
    const path = ['created', 'awaiting_payment', 'paid', 'in_production', 'packed', 'shipped', 'delivered'] as const;
    for (let i = 0; i < path.length - 1; i += 1) {
      const from = path[i]!;
      const to = path[i + 1]!;
      expect(canTransitionOrder(from, to)).toBe(true);
    }
  });

  it('forbids skipping and going backwards', () => {
    expect(canTransitionOrder('created', 'shipped')).toBe(false);
    expect(canTransitionOrder('paid', 'awaiting_payment')).toBe(false);
    expect(canTransitionOrder('delivered', 'shipped')).toBe(false);
    expect(canTransitionOrder('refunded', 'paid')).toBe(false);
    expect(ORDER_TRANSITIONS.refunded).toEqual([]);
  });

  it('allows cancellation only before the goods leave', () => {
    expect(canTransitionOrder('paid', 'cancelled')).toBe(true);
    expect(canTransitionOrder('packed', 'cancelled')).toBe(true);
    expect(canTransitionOrder('shipped', 'cancelled')).toBe(false);
    expect(canTransitionOrder('delivered', 'cancelled')).toBe(false);
    for (const status of NON_CANCELLABLE_STATUSES) {
      expect(canTransitionOrder(status, 'cancelled')).toBe(false);
    }
  });

  it('allows refunds from every post-payment status', () => {
    for (const status of ['paid', 'in_production', 'packed', 'shipped', 'delivered'] as const) {
      expect(canTransitionOrder(status, 'refunded')).toBe(true);
      expect(canTransitionOrder(status, 'partially_refunded')).toBe(true);
    }
    expect(canTransitionOrder('created', 'refunded')).toBe(false);
  });

  it('covers every declared status in the transition table', () => {
    for (const status of OrderStatusValues) {
      expect(ORDER_TRANSITIONS[status]).toBeDefined();
    }
  });

  it('enforces the refund state machine', () => {
    expect(canTransitionRefund('requested', 'pending')).toBe(true);
    expect(canTransitionRefund('pending', 'succeeded')).toBe(true);
    expect(canTransitionRefund('succeeded', 'failed')).toBe(false);
    expect(canTransitionRefund('failed', 'requested')).toBe(true);
    expect(REFUND_TRANSITIONS.succeeded).toEqual([]);
  });
});

describe('order record', () => {
  const order = {
    id: 'ord_1',
    reference: 'SM-7K3Q9F',
    accountId: 'acct_1',
    cartId: 'crt_1',
    currency: 'USD',
    status: 'paid',
    statusHistory: [{ from: null, to: 'created', at: NOW, actor: 'customer' }],
    lines: [
      {
        id: 'lin_1',
        productId: 'prd_1',
        variantId: 'var_1',
        sku: 'SM-KIT-001-4',
        name: 'Some More Kit — Four pack',
        quantity: 1,
        unitPrice: usd(3200),
        lineSubtotal: usd(3200),
      },
    ],
    subtotal: usd(3200),
    discountTotal: usd(0),
    tax: taxQuote,
    shipping: shippingQuote,
    total: usd(4400),
    refundedTotal: usd(0),
    shippingAddress: address,
    fulfillment: {},
    createdAt: NOW,
    updatedAt: NOW,
    idempotencyKey: 'order-0001',
    schemaVersion: '1.0.0',
  };

  it('parses a paid order', () => {
    const parsed = OrderSchema.parse(order);
    expect(parsed.payment).toBeNull();
    expect(parsed.refunds).toEqual([]);
    expect(parsed.cancellation).toBeNull();
    expect(parsed.fulfillment.trackingNumber).toBeNull();
  });

  it('rejects a bad reference, an empty order and an unknown status', () => {
    expect(OrderSchema.safeParse({ ...order, reference: 'ORDER-1' }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, lines: [] }).success).toBe(false);
    expect(OrderSchema.safeParse({ ...order, status: 'in_transit' }).success).toBe(false);
  });
});

describe('payments', () => {
  it('treats wallets as method types, not providers', () => {
    expect(PaymentMethodTypeSchema.options).toEqual(['apple_pay', 'google_pay', 'card', 'test']);
    const ref = PaymentRefSchema.parse({
      provider: 'stripe',
      intentId: 'pi_123',
      status: 'requires_confirmation',
      methodType: 'apple_pay',
      amount: usd(4400),
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(ref.displayLabel).toBeNull();
    expect(PaymentRefSchema.safeParse({ ...ref, provider: 'paypal' }).success).toBe(false);
  });

  it('never accepts card fields on a payment intent request', () => {
    const shape = Object.keys(CreatePaymentIntentRequestSchema.shape);
    expect(shape).toEqual(expect.arrayContaining(['methodType', 'paymentMethodToken', 'idempotencyKey']));
    expect(shape).not.toContain('cardNumber');
    expect(shape).not.toContain('cvc');
    const parsed = CreatePaymentIntentRequestSchema.parse({
      idempotencyKey: 'pay-0001',
      methodType: 'card',
      cardNumber: '4242424242424242',
      cvc: '123',
    });
    expect('cardNumber' in parsed).toBe(false);
    expect('cvc' in parsed).toBe(false);
  });

  it('validates webhook events', () => {
    expect(
      PaymentWebhookEventSchema.safeParse({
        id: 'evt_1',
        type: 'payment_intent.succeeded',
        provider: 'stripe',
        intentId: 'pi_123',
        amountMinor: 4400,
        currency: 'USD',
        occurredAt: NOW,
      }).success,
    ).toBe(true);
    expect(
      PaymentWebhookEventSchema.safeParse({
        id: 'evt_1',
        type: 'invoice.paid',
        provider: 'stripe',
        intentId: 'pi_123',
        amountMinor: 4400,
        currency: 'USD',
        occurredAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe('every mutating commerce request carries an idempotency key', () => {
  const schemas = {
    AddCartItem: AddCartItemRequestSchema,
    CreateOrder: CreateOrderRequestSchema,
    CreatePaymentIntent: CreatePaymentIntentRequestSchema,
    TransitionOrder: TransitionOrderRequestSchema,
    CreateRefund: CreateRefundRequestSchema,
    CancelOrder: CancelOrderRequestSchema,
  };

  it('declares idempotencyKey on all of them', () => {
    for (const [name, schema] of Object.entries(schemas)) {
      expect(Object.keys(schema.shape), name).toContain('idempotencyKey');
      expect(schema.safeParse({}).success, name).toBe(false);
    }
  });

  it('rejects a too-short or unsafe key', () => {
    expect(
      CreateOrderRequestSchema.safeParse({ idempotencyKey: 'abc', cartId: 'crt_1', shippingAddress: address }).success,
    ).toBe(false);
    expect(
      CreateOrderRequestSchema.safeParse({
        idempotencyKey: 'order 0001 please',
        cartId: 'crt_1',
        shippingAddress: address,
      }).success,
    ).toBe(false);
  });
});

describe('promotions and idempotency records', () => {
  it('validates a promotion rule union', () => {
    const base = { id: 'pro_1', code: 'FIRSTFIRE', name: 'First Fire', startsAt: NOW };
    expect(PromotionSchema.safeParse({ ...base, rule: { kind: 'percent_off', percent: 15 } }).success).toBe(true);
    expect(PromotionSchema.safeParse({ ...base, rule: { kind: 'free_shipping' } }).success).toBe(true);
    expect(PromotionSchema.safeParse({ ...base, rule: { kind: 'percent_off', percent: 150 } }).success).toBe(false);
    expect(PromotionSchema.safeParse({ ...base, code: 'first fire', rule: { kind: 'free_shipping' } }).success).toBe(
      false,
    );
  });

  it('validates the stored idempotency record', () => {
    expect(
      IdempotencyRecordSchema.safeParse({
        key: 'order-0001',
        accountId: 'acct_1',
        endpoint: 'POST /v1/commerce/orders',
        requestHash: 'b'.repeat(64),
        state: 'completed',
        statusCode: 201,
        responseBody: '{}',
        createdAt: NOW,
        completedAt: NOW,
        expiresAt: LATER,
      }).success,
    ).toBe(true);
    expect(
      IdempotencyRecordSchema.safeParse({
        key: 'order-0001',
        accountId: 'acct_1',
        endpoint: 'POST /v1/commerce/orders',
        requestHash: 'tooshort',
        state: 'completed',
        statusCode: 201,
        responseBody: '{}',
        createdAt: NOW,
        completedAt: NOW,
        expiresAt: LATER,
      }).success,
    ).toBe(false);
  });
});

describe('refunds', () => {
  it('parses a refund and rejects a negative amount', () => {
    const refund = {
      id: 'ref_1',
      orderId: 'ord_1',
      amount: usd(4400),
      reason: 'melted',
      state: 'requested',
      requestedBy: 'customer',
      createdAt: NOW,
      updatedAt: NOW,
      idempotencyKey: 'refund-0001',
    };
    expect(RefundSchema.safeParse(refund).success).toBe(true);
    expect(RefundSchema.safeParse({ ...refund, amount: usd(-1) }).success).toBe(false);
    expect(RefundSchema.safeParse({ ...refund, reason: 'boredom' }).success).toBe(false);
  });
});
