import { afterEach, beforeEach, expect, it } from 'vitest';
import { US_ADDRESS, bootstrap, key, startTestApi, type TestHarness } from '../../services/api/test/harness.js';

let api: TestHarness;
beforeEach(async () => { api = await startTestApi({ LIVE_OPS_TOKEN: 'ops' }); });
afterEach(async () => { await api.close(); });

it('probe', async () => {
  const player = await bootstrap(api);
  const products = await api.request('/v1/commerce/products', { token: player.token });
  const product = products.body.items[0];
  const fourPack = product.variants[0];
  const added = await api.request('/v1/commerce/cart/items', { method: 'POST', token: player.token, body: { idempotencyKey: key('cart'), productId: product.id, variantId: fourPack.id, quantity: 1 } });
  const order = await api.request('/v1/commerce/orders', { method: 'POST', token: player.token, body: { idempotencyKey: key('order'), cartId: added.body.id, shippingAddress: US_ADDRESS, email: 'rowan@example.com' } });
  console.log('ORDER', order.status);
  const intent = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, { method: 'POST', token: player.token, body: { idempotencyKey: key('pay'), methodType: 'apple_pay', paymentMethodToken: 'pm_fake_wallet' } });
  console.log('INTENT', intent.status);
  const confirmed = await api.request(`/v1/commerce/orders/${order.body.id}/payment/confirm`, { method: 'POST', token: player.token, body: { idempotencyKey: key('confirm') } });
  console.log('CONFIRM', confirmed.status, confirmed.body?.status, 'fulfillment=', JSON.stringify(confirmed.body?.fulfillment));
  const refund = await api.request(`/v1/commerce/orders/${confirmed.body.id}/refunds`, { method: 'POST', token: player.token, body: { idempotencyKey: key('refund'), reason: 'requested_by_customer' } });
  console.log('REFUND', refund.status, JSON.stringify(refund.body).slice(0, 600));
  expect(true).toBe(true);
});
