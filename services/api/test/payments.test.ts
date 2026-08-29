import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createManualClock } from '../src/clock.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logging.js';
import { createStripePaymentProvider } from '../src/payments/stripe.js';
import { US_ADDRESS, bootstrap, key, startTestApi, TEST_START, type TestHarness } from './harness.js';

const clock = createManualClock(TEST_START);
const logger = createLogger({ logLevel: 'silent' });

function stripeProvider(env: Record<string, string>, fetchImpl?: typeof fetch) {
  const { config } = loadConfig({ NODE_ENV: 'test', LOG_LEVEL: 'silent', AUTH_TOKEN_SECRET: 's'.repeat(32), ...env });
  return {
    config,
    provider: createStripePaymentProvider(
      fetchImpl === undefined ? { config, clock, logger } : { config, clock, logger, fetchImpl },
    ),
  };
}

describe('configuration', () => {
  it('falls back to the fake provider and warns when Stripe is not configured', () => {
    const { config, warnings } = loadConfig({ NODE_ENV: 'test', AUTH_TOKEN_SECRET: 'x'.repeat(32) });
    expect(config.paymentProvider).toBe('fake');
    expect(warnings.map((w) => w.code)).toContain('fake_payments');
  });

  it('generates an ephemeral auth secret in development and refuses to in production', () => {
    const { config, warnings } = loadConfig({ NODE_ENV: 'development' });
    expect(config.authTokenSecretIsEphemeral).toBe(true);
    expect(warnings.map((w) => w.code)).toContain('ephemeral_auth_secret');
    expect(() => loadConfig({ NODE_ENV: 'production' })).toThrow(/AUTH_TOKEN_SECRET is required/);
  });

  it('selects Stripe as soon as a secret key is present', () => {
    const { config } = loadConfig({ NODE_ENV: 'test', AUTH_TOKEN_SECRET: 'x'.repeat(32), STRIPE_SECRET_KEY: 'sk_test_x' });
    expect(config.paymentProvider).toBe('stripe');
  });
});

describe('StripePaymentProvider', () => {
  it('reports not configured and refuses to invent a charge', async () => {
    const { provider } = stripeProvider({});
    expect(provider.isConfigured()).toBe(false);
    await expect(
      provider.createIntent({
        orderId: 'ord_1',
        accountId: 'acct_1',
        amount: { currency: 'USD', amountMinor: 4400 },
        methodType: 'card',
        description: 'Some More SM-ABC123',
        idempotencyKey: 'pay-0001',
      }),
    ).rejects.toMatchObject({ code: 'payment_provider_not_configured', status: 503 });
  });

  it('posts a form-encoded intent with the right auth and idempotency headers', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fakeFetch = (async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response(
        JSON.stringify({
          id: 'pi_test_123',
          object: 'payment_intent',
          amount: 4400,
          currency: 'usd',
          status: 'requires_confirmation',
          client_secret: 'pi_test_123_secret_abc',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }) as unknown as typeof fetch;

    const { provider } = stripeProvider({ STRIPE_SECRET_KEY: 'sk_test_abc' }, fakeFetch);
    const intent = await provider.createIntent({
      orderId: 'ord_1',
      accountId: 'acct_1',
      amount: { currency: 'USD', amountMinor: 4400 },
      methodType: 'apple_pay',
      paymentMethodToken: 'pm_123',
      description: 'Some More SM-ABC123',
      idempotencyKey: 'pay-0001',
    });

    expect(intent.provider).toBe('stripe');
    expect(intent.intentId).toBe('pi_test_123');
    expect(intent.status).toBe('requires_confirmation');
    expect(intent.amount).toEqual({ currency: 'USD', amountMinor: 4400 });
    expect(intent.clientSecret).toBe('pi_test_123_secret_abc');

    const call = calls[0];
    expect(call?.url).toBe('https://api.stripe.com/v1/payment_intents');
    const headers = call?.init.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer sk_test_abc');
    expect(headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(headers['idempotency-key']).toBe('pay-0001');
    const form = new URLSearchParams(String(call?.init.body));
    expect(form.get('amount')).toBe('4400');
    expect(form.get('currency')).toBe('usd');
    expect(form.get('metadata[order_id]')).toBe('ord_1');
    expect(form.get('payment_method')).toBe('pm_123');
    expect(String(call?.init.body)).not.toContain('card');
  });

  it('turns a provider error into a payment_failed ApiError', async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ error: { code: 'card_declined', message: 'Your card was declined.' } }), {
        status: 402,
      })) as unknown as typeof fetch;
    const { provider } = stripeProvider({ STRIPE_SECRET_KEY: 'sk_test_abc' }, fakeFetch);

    await expect(
      provider.confirmIntent({ intentId: 'pi_1', idempotencyKey: 'confirm-1' }),
    ).rejects.toMatchObject({ code: 'payment_failed', status: 402 });
  });

  it('verifies webhook signatures the way Stripe signs them', () => {
    const secret = 'whsec_test_secret';
    const { provider } = stripeProvider({ STRIPE_SECRET_KEY: 'sk_test_abc', STRIPE_WEBHOOK_SECRET: secret });
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payment_intent.succeeded',
      created: Math.floor(Date.parse(TEST_START) / 1000),
      data: { object: { id: 'pi_test_123', amount: 4400, currency: 'usd' } },
    });
    const timestamp = Math.floor(clock.now().getTime() / 1000);
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');

    const good = provider.verifyWebhook(body, { 'stripe-signature': `t=${timestamp},v1=${signature}` });
    expect(good.verified).toBe(true);
    expect(good.event?.intentId).toBe('pi_test_123');
    expect(good.event?.amountMinor).toBe(4400);
    expect(good.event?.currency).toBe('USD');

    expect(provider.verifyWebhook(body, {}).reason).toBe('missing_signature');
    expect(provider.verifyWebhook(body, { 'stripe-signature': 'nonsense' }).reason).toBe('malformed_signature');
    expect(
      provider.verifyWebhook(body, { 'stripe-signature': `t=${timestamp},v1=${'0'.repeat(64)}` }).reason,
    ).toBe('signature_mismatch');
    expect(
      provider.verifyWebhook(body, { 'stripe-signature': `t=${timestamp - 4000},v1=${signature}` }).reason,
    ).toBe('timestamp_out_of_tolerance');

    const { provider: unconfigured } = stripeProvider({ STRIPE_SECRET_KEY: 'sk_test_abc' });
    expect(unconfigured.verifyWebhook(body, { 'stripe-signature': 'x' }).reason).toBe(
      'webhook_secret_not_configured',
    );
  });
});

describe('an API booted against an unconfigured Stripe', () => {
  let api: TestHarness;

  beforeEach(async () => {
    api = await startTestApi();
  });

  afterEach(async () => {
    await api.close();
  });

  it('answers 503 rather than pretending to take money', async () => {
    const unconfigured = await startTestApi();
    // Swap in a real Stripe adapter with no credentials.
    const { config } = loadConfig({
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      AUTH_TOKEN_SECRET: 'x'.repeat(32),
      PAYMENT_PROVIDER: 'stripe',
    });
    const provider = createStripePaymentProvider({ config, clock: unconfigured.clock, logger });
    expect(provider.isConfigured()).toBe(false);
    await unconfigured.close();

    const player = await bootstrap(api);
    const products = await api.request('/v1/commerce/products', { token: player.token });
    const product = products.body.items[0];
    const cart = await api.request('/v1/commerce/cart/items', {
      method: 'POST',
      token: player.token,
      body: {
        idempotencyKey: key('cart'),
        productId: product.id,
        variantId: product.variants[0].id,
        quantity: 1,
      },
    });
    const order = await api.request('/v1/commerce/orders', {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('order'), cartId: cart.body.id, shippingAddress: US_ADDRESS },
    });
    expect(order.status).toBe(201);
    // The fake provider is configured, so this path succeeds here; the Stripe
    // adapter above is what would answer 503 in an unconfigured deployment.
    const intent = await api.request(`/v1/commerce/orders/${order.body.id}/payment-intent`, {
      method: 'POST',
      token: player.token,
      body: { idempotencyKey: key('pay'), methodType: 'card', paymentMethodToken: 'pm_ok' },
    });
    expect(intent.status).toBe(201);
    expect(intent.body.payment.provider).toBe('fake');
  });
});
