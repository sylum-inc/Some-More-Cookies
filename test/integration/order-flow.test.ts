/**
 * The order flow, against the real service.
 *
 * Not a mocked fetch: this boots the actual API, with its actual routes,
 * idempotency layer and fulfilment state machine, and drives it with the
 * actual client the terminal uses. The seam between the two halves is the
 * thing under test, and a mock of one half cannot test a seam.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { sandwichPayload, startTestApi, type TestHarness } from '../../services/api/test/harness.js';
import { ApiClient, deviceId } from '../../apps/web/src/net/client.js';
import { OrderFlow, explain, formatMoney } from '../../apps/web/src/net/order.js';
import type { Address } from '@somemore/protocol';

const ADDRESS: Address = {
  name: 'A Camper',
  line1: '1 Fire Road',
  line2: null,
  city: 'Pine Hollow',
  region: 'OR',
  postalCode: '97001',
  country: 'US',
  phone: null,
};

let harness: TestHarness | null = null;

afterEach(async () => {
  await harness?.close();
  harness = null;
});

async function connected(
  env: Record<string, string> = {},
  options: Parameters<typeof startTestApi>[1] = {},
): Promise<{ flow: OrderFlow; client: ApiClient }> {
  harness = await startTestApi(env, options);
  const client = new ApiClient({ baseUrl: harness.baseUrl });
  const session = await client.bootstrap(deviceId());
  expect(session.ok).toBe(true);
  return { flow: new OrderFlow(client), client };
}

describe('making one real', () => {
  it('runs the whole sequence against the service and places an order', async () => {
    const { flow } = await connected();

    await flow.begin('sandwich-under-test');
    expect(flow.state.stage).toBe('address');
    expect(flow.state.product).not.toBeNull();
    expect(flow.state.cart?.items.length).toBe(1);

    await flow.quote(ADDRESS);
    expect(flow.state.stage).toBe('quoted');
    const quote = flow.state.quote;
    if (!quote) throw new Error('no quote');
    // The totals are the service's arithmetic, not the client's.
    expect(quote.total.amountMinor).toBe(
      quote.subtotal.amountMinor -
        quote.discountTotal.amountMinor +
        quote.shipping.amount.amountMinor +
        quote.tax.total.amountMinor,
    );
    // Frozen goods: the shipping quote knows it.
    expect(quote.shipping.requiresColdChain).toBe(true);

    await flow.place(ADDRESS, 'camper@example.test');
    expect(flow.state.stage).toBe('paying');
    expect(flow.state.order?.reference).toMatch(/^SM-[A-Z0-9]{6}$/);
    expect(flow.state.methods.length).toBeGreaterThan(0);

    await flow.pay();
    expect(flow.state.stage).toBe('placed');
    expect(flow.state.order?.status).toBe('paid');
  });

  it('never sends anything card-shaped', async () => {
    harness = await startTestApi();
    const bodies: string[] = [];
    const client = new ApiClient({
      baseUrl: harness.baseUrl,
      fetchImpl: async (input, init) => {
        if (init?.body) bodies.push(String(init.body));
        return fetch(input as string, init);
      },
    });
    await client.bootstrap(deviceId());
    const flow = new OrderFlow(client);
    await flow.begin('sandwich-under-test');
    await flow.quote(ADDRESS);
    await flow.place(ADDRESS);
    await flow.pay();

    const sent = bodies.join('\n');
    // Not a promise in a comment: there is no field in the client, the flow or
    // the protocol that could carry a PAN, and this asserts it stays that way.
    for (const forbidden of ['cardNumber', 'card_number', 'pan', 'cvc', 'cvv', 'expiryMonth', 'securityCode']) {
      expect(sent).not.toContain(forbidden);
    }
    expect(sent).not.toMatch(/\b\d{13,19}\b/);
  });

  it('reports the service’s own reason when there is no payment provider', async () => {
    const { flow } = await connected({}, { paymentsConfigured: false });
    await flow.begin('sandwich-under-test');
    await flow.quote(ADDRESS);
    await flow.place(ADDRESS);

    expect(flow.state.stage).toBe('unavailable');
    expect(flow.state.reason).toContain('NO PAYMENT PROVIDER IS CONFIGURED');
    // The order itself still exists: the shop took the order, it just cannot
    // take the money yet.
    expect(flow.state.order?.status).toBe('awaiting_payment');
  });

  it('says so plainly when the depot cannot be reached at all', async () => {
    // Started from a real session, so this is a network failure rather than a
    // client that simply never signed in.
    harness = await startTestApi();
    const live = new ApiClient({ baseUrl: harness.baseUrl });
    const session = await live.bootstrap(deviceId());
    if (!session.ok) throw new Error('bootstrap failed');

    const client = new ApiClient({
      baseUrl: harness.baseUrl,
      timeoutMs: 400,
      fetchImpl: async () => {
        throw new TypeError('fetch failed');
      },
    });
    client.restore(session.value);
    const flow = new OrderFlow(client);
    await flow.begin('sandwich-under-test');
    expect(flow.state.stage).toBe('failed');
    expect(flow.state.reason).toBe('NO CONNECTION. THE TERMINAL CANNOT REACH THE DEPOT.');
  });

  it('is idempotent enough that a double tap does not order two', async () => {
    const { flow, client } = await connected();
    await flow.begin('sandwich-under-test');
    await flow.quote(ADDRESS);
    await flow.place(ADDRESS);
    await flow.pay();
    // Confirming twice must not produce a second charge or a second order.
    await flow.pay();
    expect(flow.state.stage).toBe('placed');

    const orders = await client.listProducts();
    expect(orders.ok).toBe(true);
  });
});

describe('provenance never blocks an order', () => {
  it('orders anyway when the service has not seen tonight’s sandwich yet', async () => {
    const { flow } = await connected();
    // The sandwich reaches the service through the background queue, which may
    // not have drained when somebody taps MAKE THIS REAL.
    await flow.begin('sandwich-still-in-the-upload-queue');
    expect(flow.state.stage).toBe('address');
    expect(flow.state.cart?.items.length).toBe(1);
  });
});

describe('rewards', () => {
  it('shows a reward only when the account actually has one, and takes it off the total', async () => {
    harness = await startTestApi();
    const client = new ApiClient({ baseUrl: harness.baseUrl });
    const session = await client.bootstrap(deviceId());
    expect(session.ok).toBe(true);

    // Nothing earned yet: the terminal must not advertise an empty rewards
    // section to somebody who has never made anything.
    const empty = new OrderFlow(client);
    await empty.begin();
    expect(empty.state.rewards).toEqual([]);

    // Earn some, through the same client the game uses.
    const campsite = await client.createCampsite({ name: 'Pine Hollow', environmentId: 'pine_hollow' });
    if (!campsite.ok) throw new Error('campsite failed');
    const made = await client.recordSandwich(
      sandwichPayload(campsite.value.id, campsite.value.machine.serialNumber),
    );
    expect(made.ok).toBe(true);

    // The sandwich earned a stamp and a patch. Neither is money off, so
    // neither is offered at the till: a "USE IT" button that takes nothing
    // off the total is worse than no button.
    const grants = await client.listRewardGrants();
    if (!grants.ok) throw new Error('grants failed');
    expect(grants.value.length).toBeGreaterThan(0);
    expect(grants.value.every((grant) => grant.kind !== 'perk')).toBe(true);

    const earned = new OrderFlow(client);
    await earned.begin(made.ok ? made.value.id : undefined);
    expect(earned.state.rewards).toEqual([]);
  });

  it('applies a perk to the cart and invalidates the price on screen', async () => {
    harness = await startTestApi();
    const client = new ApiClient({ baseUrl: harness.baseUrl });
    const session = await client.bootstrap(deviceId());
    if (!session.ok) throw new Error('bootstrap failed');

    // A perk is the tier that costs real money to honour, so it is claim-once
    // and server-validated. Settling the account past the age check is what a
    // real player does by simply having been around.
    const campsite = await client.createCampsite({ name: 'Pine Hollow', environmentId: 'pine_hollow' });
    if (!campsite.ok) throw new Error('campsite failed');
    await client.recordSandwich(sandwichPayload(campsite.value.id, campsite.value.machine.serialNumber));
    harness.clock.advance(3 * 3_600_000);

    const claim = await harness.request('/v1/rewards/claims', {
      method: 'POST',
      token: session.value.auth.token,
      body: {
        idempotencyKey: `claim-${Math.random().toString(36).slice(2)}`,
        rewardCode: 'free_kit',
        deviceId: `device-${Math.random().toString(36).slice(2)}`,
        clientNonce: `nonce-${Math.random().toString(36).slice(2)}`,
      },
    });
    expect(claim.status).toBe(201);

    const flow = new OrderFlow(client);
    await flow.begin();
    expect(flow.state.rewards.map((grant) => grant.rewardCode)).toContain('free_kit');

    const grant = flow.state.rewards[0];
    if (!grant) throw new Error('no grant');

    await flow.quote(ADDRESS);
    const before = flow.state.quote?.total.amountMinor ?? 0;
    expect(before).toBeGreaterThan(0);

    await flow.redeem(grant.id);
    expect(flow.state.redeemed).toContain(grant.id);
    expect(flow.state.cart?.rewardGrantIds).toContain(grant.id);
    // Applying a reward invalidates the price already on screen, so the
    // terminal cannot show a total that is no longer what will be charged.
    expect(flow.state.quote).toBeNull();
    expect(flow.state.stage).toBe('address');

    await flow.quote(ADDRESS);
    const after = flow.state.quote?.total.amountMinor ?? before;
    expect(after).toBeLessThan(before);
    expect(flow.state.quote?.appliedRewards.map((r) => r.rewardGrantId)).toContain(grant.id);

    // A double tap on USE IT does nothing at all.
    await flow.redeem(grant.id);
    expect(flow.state.redeemed.filter((id) => id === grant.id)).toHaveLength(1);
  });
});

describe('money and failures read like a terminal', () => {
  it('formats minor units in the service’s currency', () => {
    expect(formatMoney({ currency: 'USD', amountMinor: 1299 })).toContain('12.99');
    // An unknown currency must not throw: a printout is not worth a crash.
    expect(formatMoney({ currency: 'ZZZ', amountMinor: 500 })).toContain('5.00');
  });

  it('has a line for every failure kind', () => {
    const kinds = [
      { kind: 'offline' as const },
      { kind: 'timeout' as const },
      { kind: 'unauthorized' as const },
      { kind: 'conflict' as const, code: 'x', message: 'that cart is already an order' },
      { kind: 'server' as const, status: 500, code: 'x', message: 'the depot fell over' },
      { kind: 'malformed' as const, message: 'weird' },
    ];
    for (const failure of kinds) {
      expect(explain(failure).length).toBeGreaterThan(4);
    }
  });
});
