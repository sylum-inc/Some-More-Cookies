import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

async function kitVariant(token: string) {
  const products = await api.request('/v1/commerce/products', { token });
  const product = products.body.items[0];
  return { productId: product.id, variantId: product.variants[0].id };
}

describe('replaying a mutating request', () => {
  it('returns the original response and does not run the handler twice', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const body = { idempotencyKey: key('cart'), productId, variantId, quantity: 1 };

    const first = await api.request('/v1/commerce/cart/items', { method: 'POST', token: player.token, body });
    expect(first.status).toBe(201);
    expect(first.headers.get('idempotent-replay')).toBeNull();
    expect(first.body.items[0].quantity).toBe(1);

    const replay = await api.request('/v1/commerce/cart/items', { method: 'POST', token: player.token, body });
    expect(replay.status).toBe(201);
    expect(replay.headers.get('idempotent-replay')).toBe('true');
    expect(replay.body).toEqual(first.body);

    // The cart really only has one kit in it.
    const cart = await api.request('/v1/commerce/cart', { token: player.token });
    expect(cart.body.items).toHaveLength(1);
    expect(cart.body.items[0].quantity).toBe(1);
    expect(cart.body.revision).toBe(1);
  });

  it('creates exactly one order for a retried checkout', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const cart = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cart'), productId, variantId, quantity: 1 },
    });

    const orderBody = {
      idempotencyKey: key('order'),
      cartId: cart.body.id,
      shippingAddress: US_ADDRESS,
      email: 'rowan@example.com',
    };
    const first = await api.request('/v1/commerce/orders', { method: 'POST', token: player.token, body: orderBody });
    const second = await api.request('/v1/commerce/orders', { method: 'POST', token: player.token, body: orderBody });

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('idempotent-replay')).toBe('true');

    const orders = await api.request('/v1/commerce/orders', { token: player.token });
    expect(orders.body.items).toHaveLength(1);

    // Without the key, the same checkout is refused because the cart converted.
    const third = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { ...orderBody, idempotencyKey: key('order') },
    });
    expect(third.status).toBe(409);
  });

  it('charges once when a payment intent request is retried', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const cart = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('cart'), productId, variantId, quantity: 1 },
    });
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.body.id, shippingAddress: US_ADDRESS },
    });

    const payBody = { idempotencyKey: key('pay'), methodType: 'card', paymentMethodToken: 'pm_fake_good' };
    const first = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: payBody,
    });
    const retry = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: payBody,
    });
    expect(retry.body.payment.intentId).toBe(first.body.payment.intentId);
    expect(retry.headers.get('idempotent-replay')).toBe('true');
  });
});

describe('key conflicts', () => {
  it('409s when the same key is reused with a different payload', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const sameKey = key('cart');

    const first = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: sameKey, productId, variantId, quantity: 1 },
    });
    expect(first.status).toBe(201);

    const conflict = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: sameKey, productId, variantId, quantity: 3 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error.code).toBe('idempotency_key_conflict');
    expect(conflict.body.error.details.key).toBe(sameKey);

    const cart = await api.request('/v1/commerce/cart', { token: player.token });
    expect(cart.body.items[0].quantity).toBe(1);
  });

  it('scopes keys per account, so two players may use the same key', async () => {
    const first = await bootstrap(api);
    const second = await bootstrap(api);
    const { productId, variantId } = await kitVariant(first.token);
    const sharedKey = 'checkout-shared-key-0001';

    const a = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: first.token,
      body: { idempotencyKey: sharedKey, productId, variantId, quantity: 1 },
    });
    const b = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: second.token,
      body: { idempotencyKey: sharedKey, productId, variantId, quantity: 2 },
    });

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers.get('idempotent-replay')).toBeNull();
    expect(b.body.items[0].quantity).toBe(2);
  });

  it('scopes keys per endpoint', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const sharedKey = 'same-key-two-endpoints';

    const cart = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: sharedKey, productId, variantId, quantity: 1 },
    });
    expect(cart.status).toBe(201);

    const note = await api.request('/v1/passport/notes', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: sharedKey, body: 'different endpoint, same key' },
    });
    expect(note.status).toBe(201);
  });

  it('rejects a header key that disagrees with the body key', async () => {
    const player = await bootstrap(api);
    const { productId, variantId } = await kitVariant(player.token);
    const response = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      headers: { 'idempotency-key': 'header-key-0001' },
      body: { idempotencyKey: 'body-key-0001', productId, variantId, quantity: 1 },
    });
    expect(response.status).toBe(400);
    expect(response.body.error.message).toMatch(/disagree/);
  });

  it('does not poison a key when the handler fails', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const sharedKey = key('swh');

    const wrong = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, 'SM01-2001Z-99999-Z', { idempotencyKey: sharedKey }),
    });
    expect(wrong.status).toBe(400);

    const corrected = await api.request('/v1/sandwiches', {
      method: 'POST',
      token: player.token,
      body: sandwichPayload(campsite.id, campsite.machine.serialNumber, { idempotencyKey: sharedKey }),
    });
    expect(corrected.status).toBe(201);
  });
});

describe('non-commerce mutations are replay-safe too', () => {
  it('creates one campsite for a retried request', async () => {
    const player = await bootstrap(api);
    const body = { idempotencyKey: key('camp'), name: 'Retry Hollow' };

    const first = await api.request('/v1/campsites', { method: 'POST', token: player.token, body });
    const second = await api.request('/v1/campsites', { method: 'POST', token: player.token, body });
    expect(second.body.id).toBe(first.body.id);
    expect(second.headers.get('idempotent-replay')).toBe('true');

    const list = await api.request('/v1/campsites', { token: player.token });
    expect(list.body.items).toHaveLength(1);
  });

  it('records one sandwich for a retried submission', async () => {
    const player = await bootstrap(api);
    const campsite = await createCampsite(api, player);
    const body = sandwichPayload(campsite.id, campsite.machine.serialNumber);

    const first = await api.request('/v1/sandwiches', { method: 'POST', token: player.token, body });
    const second = await api.request('/v1/sandwiches', { method: 'POST', token: player.token, body });
    expect(second.body.id).toBe(first.body.id);

    const list = await api.request('/v1/sandwiches', { token: player.token });
    expect(list.body.items).toHaveLength(1);

    const machine = await api.request(`/v1/campsites/${campsite.id}/machine`, { token: player.token });
    expect(machine.body.cyclesRun).toBe(1);
  });
});
