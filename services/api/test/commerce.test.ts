import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FAKE_DECLINE_TOKEN } from '../src/payments/fake.js';
import {
  US_ADDRESS,
  bootstrap,
  createCampsite,
  key,
  sandwichPayload,
  startTestApi,
  type TestHarness,
} from './harness.js';

let api: TestHarness;

beforeEach(async () => {
  api = await startTestApi();
});

afterEach(async () => {
  await api.close();
});

async function catalog(token: string) {
  const products = await api.request('/v1/commerce/products', { token });
  const product = products.body.items[0];
  return { product, fourPack: product.variants[0], eightPack: product.variants[1] };
}

async function cartWithKit(token: string, quantity = 1) {
  const { product, fourPack } = await catalog(token);
  const added = await api.request('/v1/commerce/cart/items', {
    method: 'POST',
    token,
    body: { idempotencyKey: key('cart'), productId: product.id, variantId: fourPack.id, quantity },
  });
  expect(added.status).toBe(201);
  return added.body;
}

async function paidOrder(token: string) {
  const cart = await cartWithKit(token);
  const order = await api.request('/v1/commerce/orders', {
    method: 'POST',
    token,
    body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS, email: 'rowan@example.com' },
  });
  expect(order.status).toBe(201);
  const intent = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
    method: 'POST',
    token,
    body: { idempotencyKey: key('pay'), methodType: 'apple_pay', paymentMethodToken: 'pm_fake_wallet' },
  });
  expect(intent.status).toBe(201);
  const confirmed = await api.request(`/v1/commerce/orders/${order.body.id}/payment/confirm`, {
    method: 'POST',
    token,
    body: { idempotencyKey: key('confirm') },
  });
  expect(confirmed.status).toBe(200);
  return confirmed.body;
}

describe('catalog', () => {
  it('has exactly one flagship product at launch', async () => {
    const player = await bootstrap(api);
    const response = await api.request('/v1/commerce/products', { token: player.token });
    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(1);
    const product = response.body.items[0];
    expect(product.sku).toBe('SM-KIT-001');
    expect(product.status).toBe('active');
    expect(product.basePrice).toEqual({ currency: 'USD', amountMinor: 3200 });
    expect(product.variants).toHaveLength(2);
    expect(product.maxPerOrder).toBe(4);
    expect(product.shipsToCountries).toEqual(['US']);
  });
});

describe('cart', () => {
  it('creates a cart on first read and prices lines', async () => {
    const player = await bootstrap(api);
    const cart = await api.request('/v1/commerce/cart', { token: player.token });
    expect(cart.status).toBe(200);
    expect(cart.body.items).toEqual([]);
    expect(cart.body.subtotal).toEqual({ currency: 'USD', amountMinor: 0 });

    const { product, eightPack } = await catalog(player.token);
    const added = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cart'), productId: product.id, variantId: eightPack.id, quantity: 2 },
    });
    expect(added.body.items[0].unitPrice.amountMinor).toBe(5600);
    expect(added.body.items[0].lineSubtotal.amountMinor).toBe(11_200);
    expect(added.body.subtotal.amountMinor).toBe(11_200);
  });

  it('enforces the per-order cap and lets lines be changed or removed', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token, 4);
    const { product, fourPack } = await catalog(player.token);

    const tooMany = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cart'), productId: product.id, variantId: fourPack.id, quantity: 1 },
    });
    expect(tooMany.status).toBe(409);
    expect(tooMany.body.error.details.maxPerOrder).toBe(4);

    const itemId = cart.items[0].id;
    const reduced = await api.request(`/v1/commerce/cart/items/${itemId}`, {
      method: 'PATCH',
      token: player.token,
      body: { idempotencyKey: key('cart'), quantity: 2 },
    });
    expect(reduced.body.subtotal.amountMinor).toBe(6400);

    const removed = await api.request(`/v1/commerce/cart/items/${itemId}`, {
      method: 'DELETE',
      token: player.token,
    });
    expect(removed.body.items).toEqual([]);
  });

  it('links a cart line back to the sandwich that inspired it', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const sandwich = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });
    const { product, fourPack } = await catalog(player.token);
    const added = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('cart'),
        productId: product.id,
        variantId: fourPack.id,
        sandwichId: sandwich.body.id,
      },
    });
    expect(added.body.items[0].sandwichId).toBe(sandwich.body.id);
  });
});

describe('quoting', () => {
  it('quotes tax and shipping as expiring boundary objects', async () => {
    const player = await bootstrap(api);
    await cartWithKit(player.token);

    const oregon = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: { shippingAddress: US_ADDRESS },
    });
    expect(oregon.status).toBe(200);
    expect(oregon.body.subtotal.amountMinor).toBe(3200);
    expect(oregon.body.tax.provider).toBe('internal_flat');
    expect(oregon.body.tax.total.amountMinor).toBe(0);
    expect(oregon.body.shipping.amount.amountMinor).toBe(1200);
    expect(oregon.body.shipping.requiresColdChain).toBe(true);
    expect(Date.parse(oregon.body.shipping.expiresAt)).toBeGreaterThan(Date.parse(oregon.body.shipping.calculatedAt));
    expect(oregon.body.total.amountMinor).toBe(4400);

    const california = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: { shippingAddress: { ...US_ADDRESS, region: 'CA', city: 'Truckee', postalCode: '96161' } },
    });
    expect(california.body.tax.total.amountMinor).toBe(232);
    expect(california.body.total.amountMinor).toBe(4632);
  });

  it('refuses to ship where the product cannot go', async () => {
    const player = await bootstrap(api);
    await cartWithKit(player.token);
    const response = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: {
        shippingAddress: { ...US_ADDRESS, country: 'FR', region: 'Occitanie', postalCode: '31000', city: 'Toulouse' },
      },
    });
    expect(response.status).toBe(412);
    expect(response.body.error.details.shipsToCountries).toEqual(['US']);
  });

  it('applies a promotion code and refuses to stack an exclusive one', async () => {
    const player = await bootstrap(api);
    await cartWithKit(player.token);

    const applied = await api.request('/v1/commerce/cart/promotions', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('promo'), code: 'firstfire' },
    });
    expect(applied.status).toBe(200);
    expect(applied.body.promotionCodes).toEqual(['FIRSTFIRE']);

    const quote = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: { shippingAddress: US_ADDRESS },
    });
    expect(quote.body.discountTotal.amountMinor).toBe(480);
    expect(quote.body.total.amountMinor).toBe(3200 - 480 + 1200);
    expect(quote.body.appliedPromotions[0].code).toBe('FIRSTFIRE');

    const stacked = await api.request('/v1/commerce/cart/promotions', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('promo'), code: 'FREESHIP' },
    });
    expect(stacked.status).toBe(409);

    const unknown = await api.request('/v1/commerce/cart/promotions', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('promo'), code: 'NOPE' },
    });
    expect(unknown.status).toBe(404);
  });

  it('redeems an earned reward as a free kit', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber),
    });
    api.clock.advance(3 * 3_600_000);
    const claim = await api.request('/v1/rewards/claims', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('claim'),
        rewardCode: 'free_kit',
        deviceId: 'device-reward-000001',
        clientNonce: 'nonce-reward-0001',
      },
    });
    expect(claim.body.status).toBe('granted');

    await cartWithKit(player.token);
    const redeemed = await api.request('/v1/commerce/cart/rewards', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('redeem'), rewardGrantId: claim.body.grant.id },
    });
    expect(redeemed.status).toBe(200);

    const quote = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: { shippingAddress: US_ADDRESS },
    });
    expect(quote.body.appliedRewards[0].rewardCode).toBe('free_kit');
    expect(quote.body.discountTotal.amountMinor).toBe(3200);
    expect(quote.body.total.amountMinor).toBe(1200);

    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: quote.body.cartId, shippingAddress: US_ADDRESS },
    });
    expect(order.status).toBe(201);
    expect(order.body.redeemedRewardGrantIds).toEqual([claim.body.grant.id]);

    const grants = await api.request('/v1/rewards/grants', { token: player.token });
    const used = grants.body.items.find((g: any) => g.id === claim.body.grant.id);
    expect(used.status).toBe('consumed');
    expect(used.redeemedOnOrderId).toBe(order.body.id);
  });
});

describe('the full commerce path', () => {
  it('goes catalog -> cart -> order -> payment -> fulfillment -> delivered -> refund', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token, 2);

    const quote = await api.request('/v1/commerce/cart/quote', {
      method: 'POST',
      token: player.token,
      body: { shippingAddress: US_ADDRESS },
    });
    expect(quote.body.total.amountMinor).toBe(6400 + 1200);

    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('order'),
        cartId: cart.id,
        shippingAddress: US_ADDRESS,
        email: 'rowan@example.com',
        expectedTotal: quote.body.total,
      },
    });
    expect(order.status).toBe(201);
    expect(order.body.status).toBe('awaiting_payment');
    expect(order.body.reference).toMatch(/^SM-[A-Z0-9]{6}$/);
    expect(order.body.lines).toHaveLength(1);
    expect(order.body.total.amountMinor).toBe(7600);
    expect(order.body.statusHistory.map((h: any) => h.to)).toEqual(['created', 'awaiting_payment']);

    // Inventory moved when the order was taken.
    const product = (await api.request('/v1/commerce/products', { token: player.token })).body.items[0];
    expect(product.variants[0].inventoryQuantity).toBe(498);

    const intent = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('pay'), methodType: 'apple_pay', paymentMethodToken: 'pm_fake_wallet' },
    });
    expect(intent.status).toBe(201);
    expect(intent.body.payment.provider).toBe('fake');
    expect(intent.body.payment.methodType).toBe('apple_pay');
    expect(intent.body.payment.amount.amountMinor).toBe(7600);
    expect(intent.body.clientSecret).toContain('secret');

    // The client secret is returned but never persisted on the order.
    const stored = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: player.token });
    expect(JSON.stringify(stored.body)).not.toContain('secret');

    const confirmed = await api.request(`/v1/commerce/orders/${order.body.id}/payment/confirm`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('confirm') },
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.status).toBe('paid');
    expect(confirmed.body.payment.status).toBe('succeeded');

    for (const [to, tracking] of [
      ['in_production', undefined],
      ['packed', undefined],
      ['shipped', { carrier: 'ColdRun', service: 'two_day_frozen', trackingNumber: 'CR123456789' }],
      ['delivered', undefined],
    ] as const) {
      const moved = await api.request(`/v1/commerce/orders/${order.body.id}/transitions`, {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey: key('move'), to, note: `to ${to}`, ...(tracking === undefined ? {} : { tracking }) },
      });
      expect(moved.status, `${to}: ${JSON.stringify(moved.body)}`).toBe(200);
      expect(moved.body.status).toBe(to);
    }

    const delivered = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: player.token });
    expect(delivered.body.fulfillment.trackingNumber).toBe('CR123456789');
    expect(delivered.body.fulfillment.deliveredAt).not.toBeNull();
    expect(delivered.body.statusHistory.map((h: any) => h.to)).toEqual([
      'created',
      'awaiting_payment',
      'paid',
      'in_production',
      'packed',
      'shipped',
      'delivered',
    ]);

    const refunded = await api.request(`/v1/commerce/orders/${order.body.id}/refunds`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('refund'), reason: 'melted' },
    });
    expect(refunded.status).toBe(201);
    expect(refunded.body.status).toBe('refunded');
    expect(refunded.body.refundedTotal.amountMinor).toBe(7600);
    expect(refunded.body.refunds).toHaveLength(1);
    expect(refunded.body.refunds[0].state).toBe('succeeded');
    expect(refunded.body.refunds[0].providerRefundId).toMatch(/^re_fake_/);
  });

  it('supports a partial refund and then a full one', async () => {
    const player = await bootstrap(api);
    const order = await paidOrder(player.token);

    const partial = await api.request(`/v1/commerce/orders/${order.id}/refunds`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('refund'), amountMinor: 1000, reason: 'damaged_in_transit' },
    });
    expect(partial.status).toBe(201);
    expect(partial.body.status).toBe('partially_refunded');
    expect(partial.body.refundedTotal.amountMinor).toBe(1000);

    const tooMuch = await api.request(`/v1/commerce/orders/${order.id}/refunds`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('refund'), amountMinor: 99_999, reason: 'goodwill' },
    });
    expect(tooMuch.status).toBe(400);
    expect(tooMuch.body.error.details.remaining).toBe(3400);

    const rest = await api.request(`/v1/commerce/orders/${order.id}/refunds`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('refund'), reason: 'requested_by_customer' },
    });
    expect(rest.body.status).toBe('refunded');
    expect(rest.body.refundedTotal.amountMinor).toBe(4400);
  });
});

describe('order legality and authorization', () => {
  it('refuses illegal transitions and reserved statuses', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token);
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS },
    });

    const skipping = await api.request(`/v1/commerce/orders/${order.body.id}/transitions`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('move'), to: 'shipped' },
    });
    expect(skipping.status).toBe(409);
    expect(skipping.body.error.code).toBe('illegal_state_transition');

    const reserved = await api.request(`/v1/commerce/orders/${order.body.id}/transitions`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('move'), to: 'paid' },
    });
    expect(reserved.status).toBe(400);

    const bogus = await api.request(`/v1/commerce/orders/${order.body.id}/transitions`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('move'), to: 'incinerated' },
    });
    expect(bogus.status).toBe(422);
  });

  it('cancels before shipping and refuses after', async () => {
    const player = await bootstrap(api);
    const order = await paidOrder(player.token);

    const cancelled = await api.request(`/v1/commerce/orders/${order.id}/cancel`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cancel'), reason: 'changed my mind' },
    });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.status).toBe('cancelled');
    expect(cancelled.body.cancellation.restocked).toBe(true);

    const product = (await api.request('/v1/commerce/products', { token: player.token })).body.items[0];
    expect(product.variants[0].inventoryQuantity).toBe(500);

    const shipped = await paidOrder(player.token);
    for (const to of ['in_production', 'packed', 'shipped'] as const) {
      await api.request(`/v1/commerce/orders/${shipped.id}/transitions`, {
        method: 'POST',
        token: player.token,
        body: { idempotencyKey: key('move'), to },
      });
    }
    const tooLate = await api.request(`/v1/commerce/orders/${shipped.id}/cancel`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cancel'), reason: 'too late' },
    });
    expect(tooLate.status).toBe(409);
    expect(tooLate.body.error.message).toMatch(/too far/i);
  });

  it('rejects a stale expected total', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token);
    const response = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('order'),
        cartId: cart.id,
        shippingAddress: US_ADDRESS,
        expectedTotal: { currency: 'USD', amountMinor: 1 },
      },
    });
    expect(response.status).toBe(409);
    expect(response.body.error.details.actual).toBe(4400);
  });

  it('keeps orders and carts private to their owner', async () => {
    const player = await bootstrap(api);
    const stranger = await bootstrap(api);
    const cart = await cartWithKit(player.token);
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS },
    });

    const read = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: stranger.token });
    expect(read.status).toBe(403);

    const pay = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('pay'), methodType: 'card' },
    });
    expect(pay.status).toBe(403);

    const hijack = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: stranger.token,
      body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS },
    });
    expect(hijack.status).toBe(403);

    const mine = await api.request('/v1/commerce/orders', { token: stranger.token });
    expect(mine.body.items).toEqual([]);
  });

  it('surfaces a declined payment as 402 and leaves the order recoverable', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token);
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS },
    });
    await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('pay'), methodType: 'card', paymentMethodToken: FAKE_DECLINE_TOKEN },
    });

    const declined = await api.request(`/v1/commerce/orders/${order.body.id}/payment/confirm`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('confirm') },
    });
    expect(declined.status).toBe(402);
    expect(declined.body.error.code).toBe('payment_failed');
    expect(declined.body.error.details.failureCode).toBe('card_declined');

    const after = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: player.token });
    expect(after.body.status).toBe('payment_failed');

    const retry = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('pay'), methodType: 'card', paymentMethodToken: 'pm_fake_good' },
    });
    expect(retry.status).toBe(201);
    const paid = await api.request(`/v1/commerce/orders/${order.body.id}/payment/confirm`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('confirm') },
    });
    expect(paid.body.status).toBe('paid');
  });
});

describe('payment webhooks', () => {
  it('marks an order paid from a signed provider event', async () => {
    const player = await bootstrap(api);
    const cart = await cartWithKit(player.token);
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.id, shippingAddress: US_ADDRESS },
    });
    const intent = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('pay'), methodType: 'google_pay', paymentMethodToken: 'pm_fake_wallet' },
    });

    const event = JSON.stringify({
      id: 'evt_test_1',
      type: 'payment_intent.succeeded',
      intentId: intent.body.payment.intentId,
      amountMinor: 4400,
      currency: 'USD',
      occurredAt: api.clock.isoNow(),
    });

    const unsigned = await api.request('/v1/commerce/webhooks/payments', {
      method: 'POST',
      rawBody: event,
    });
    expect(unsigned.status).toBe(400);
    expect(unsigned.body.error.code).toBe('webhook_signature_invalid');

    const tampered = await api.request('/v1/commerce/webhooks/payments', {
      method: 'POST',
      rawBody: event,
      headers: { 'x-somemore-signature': 't=1,v1=deadbeef' },
    });
    expect(tampered.status).toBe(400);

    const signed = await api.request('/v1/commerce/webhooks/payments', {
      method: 'POST',
      rawBody: event,
      headers: api.payments.signWebhook(event),
    });
    expect(signed.status).toBe(200);
    expect(signed.body).toEqual({ handled: true, orderId: order.body.id });

    const paid = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: player.token });
    expect(paid.body.status).toBe('paid');
    expect(paid.body.statusHistory.at(-1).actor).toBe('payment_webhook');

    // Replaying the same event is harmless.
    const replay = await api.request('/v1/commerce/webhooks/payments', {
      method: 'POST',
      rawBody: event,
      headers: api.payments.signWebhook(event),
    });
    expect(replay.status).toBe(200);
    const unchanged = await api.request(`/v1/commerce/orders/${order.body.id}`, { token: player.token });
    expect(unchanged.body.statusHistory).toHaveLength(paid.body.statusHistory.length);
  });
});
