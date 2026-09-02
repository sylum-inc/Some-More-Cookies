/**
 * Making one real.
 *
 * The terminal used to say "PAYMENT UNAVAILABLE" without ever asking anyone.
 * The order domain, the fulfilment state machine, the idempotency layer and
 * two payment providers were all implemented and tested on the service side,
 * and the client had never once spoken to them — so the honest-looking message
 * was in fact a guess, and would have kept being a guess after a processor was
 * configured.
 *
 * This drives the real sequence: catalogue → cart → quote → order → payment
 * intent → confirm. Where it cannot proceed, it says exactly why, using what
 * the service said rather than what the client assumed.
 *
 * Two rules from the spec shape this file:
 *
 *  1. **Commerce is subordinate** (§11). Nothing here is constructed, called
 *     or prefetched before the reveal. The flow is created when the terminal
 *     opens and discarded when it closes.
 *  2. **Never store raw payment-card data.** There is no field in this module,
 *     in `ApiClient`, or in the protocol that could carry a card number. What
 *     crosses the wire is a provider-minted token, and the `test` method type
 *     carries nothing at all.
 */

import type {
  Address,
  Cart,
  CartQuote,
  Money,
  Order,
  PaymentMethodType,
  Product,
  RewardGrant,
} from '@somemore/protocol';
import type { ApiClient, ApiFailure } from './client.js';

/** Where the flow has got to. Every terminal screen maps to one of these. */
export type OrderStage =
  | 'idle'
  | 'loading'
  | 'address'
  | 'quoting'
  | 'quoted'
  | 'placing'
  | 'paying'
  | 'placed'
  | 'unavailable'
  | 'failed';

export interface OrderFlowState {
  stage: OrderStage;
  product: Product | null;
  cart: Cart | null;
  quote: CartQuote | null;
  order: Order | null;
  /** Payment method types the *service* says it can take, in offer order. */
  methods: PaymentMethodType[];
  /**
   * Reward grants this account holds that can come off this order.
   *
   * Almost always empty, and that is correct: rewards are rare, and a terminal
   * that shows an empty rewards section to everybody would be advertising.
   */
  rewards: RewardGrant[];
  /** Grant ids already applied to the cart, so a double tap does nothing. */
  redeemed: string[];
  /**
   * Why the flow stopped, in the service's words.
   *
   * Set on `unavailable` and `failed`. Never invented locally: if the service
   * is simply unreachable, that is what it says.
   */
  reason: string | null;
  /** The underlying failure, for logging and for the offline indicator. */
  failure: ApiFailure | null;
}

function initialState(): OrderFlowState {
  return {
    stage: 'idle',
    product: null,
    cart: null,
    quote: null,
    order: null,
    methods: [],
    rewards: [],
    redeemed: [],
    reason: null,
    failure: null,
  };
}

/** Turns an API failure into a line a person would accept reading. */
export function explain(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'offline':
      return 'NO CONNECTION. THE TERMINAL CANNOT REACH THE DEPOT.';
    case 'timeout':
      return 'THE DEPOT DID NOT ANSWER IN TIME.';
    case 'unauthorized':
      return 'THIS PASSPORT IS NOT RECOGNISED BY THE DEPOT.';
    case 'conflict':
      return failure.message.toUpperCase();
    case 'server':
      return failure.message.toUpperCase();
    case 'malformed':
      return 'THE DEPOT ANSWERED IN A FORMAT THIS TERMINAL DOES NOT KNOW.';
    default:
      return 'UNAVAILABLE.';
  }
}

/**
 * `payment_provider_not_configured` is the one failure that is not an error.
 *
 * It means the whole order path worked and there is genuinely no processor
 * behind it — which is a deployment fact, not a bug, and the terminal should
 * say so plainly rather than showing a failure.
 */
function isNotConfigured(failure: ApiFailure): boolean {
  return (
    (failure.kind === 'conflict' || failure.kind === 'server') &&
    failure.code === 'payment_provider_not_configured'
  );
}

/**
 * A grant that is worth offering at a checkout.
 *
 * A stamp and a patch are *in-world* rewards: they belong in the Passport, and
 * putting them behind a "USE IT" button at a till would mean offering somebody
 * money off and then taking nothing off. Only a `perk` — the tier that costs
 * real money to honour — is a thing an order can consume.
 */
function isRedeemable(grant: RewardGrant): boolean {
  return grant.status === 'granted' && grant.redeemedOnOrderId === null && grant.kind === 'perk';
}

/**
 * The methods a provider can take.
 *
 * The wallets come first because on a phone, at a campsite, at midnight, a
 * wallet is the only checkout anybody will actually finish.
 */
function methodsFor(provider: string): PaymentMethodType[] {
  if (provider === 'fake') return ['test'];
  return ['apple_pay', 'google_pay', 'card'];
}

/** The service has not seen that sandwich yet — the upload is still in flight. */
function isUnknownSandwich(failure: ApiFailure): boolean {
  return failure.kind === 'server' && failure.status === 404 && failure.code === 'not_found';
}

export class OrderFlow {
  private readonly client: ApiClient;
  private readonly listeners = new Set<(state: OrderFlowState) => void>();
  state: OrderFlowState = initialState();

  constructor(client: ApiClient) {
    this.client = client;
  }

  subscribe(listener: (state: OrderFlowState) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private set(partial: Partial<OrderFlowState>): void {
    this.state = { ...this.state, ...partial };
    for (const listener of this.listeners) listener(this.state);
  }

  reset(): void {
    this.set(initialState());
  }

  /**
   * Loads the catalogue and puts one sandwich in the cart.
   *
   * Called when the terminal's order screen opens — after the reveal, never
   * before it.
   *
   * `sandwichId` is *provenance*, not identity: the one you made tonight, so
   * the order can be tied back to it. The sandwich reaches the service through
   * the background sync queue, which by design has not necessarily finished by
   * the time somebody taps MAKE THIS REAL — so if the service does not know
   * that sandwich yet, the order goes ahead without the link rather than
   * failing. Losing a provenance line is a far smaller loss than losing the
   * order.
   */
  async begin(sandwichId?: string): Promise<void> {
    this.set({ stage: 'loading', reason: null, failure: null });

    const products = await this.client.listProducts();
    if (!products.ok) return this.stop(products.error);

    // The launch catalogue is one product (spec §11). If that ever grows, the
    // flagship is still the one the terminal offers off the back of a reveal.
    const product =
      products.value.find((candidate) => candidate.status === 'active' && candidate.kind === 'physical') ??
      products.value[0];
    if (!product) {
      return this.set({
        stage: 'unavailable',
        reason: 'THE DEPOT HAS NOTHING TO SHIP RIGHT NOW.',
      });
    }

    const variant = product.variants.find((candidate) => candidate.active) ?? product.variants[0];
    if (!variant) {
      return this.set({
        stage: 'unavailable',
        reason: 'THAT ITEM IS NOT IN PRODUCTION RIGHT NOW.',
      });
    }

    let cart = await this.client.addCartItem({
      productId: product.id,
      variantId: variant.id,
      quantity: 1,
      ...(sandwichId ? { sandwichId } : {}),
    });
    if (!cart.ok && sandwichId && isUnknownSandwich(cart.error)) {
      cart = await this.client.addCartItem({
        productId: product.id,
        variantId: variant.id,
        quantity: 1,
      });
    }
    if (!cart.ok) return this.stop(cart.error);

    this.set({ stage: 'address', product, cart: cart.value });

    // Rewards are looked up after the cart exists and never block it: a
    // rewards lookup that fails must not stop somebody buying a s'more.
    const grants = await this.client.listRewardGrants();
    if (grants.ok) {
      this.set({ rewards: grants.value.filter(isRedeemable) });
    }
  }

  /** Takes a granted reward off this order. */
  async redeem(rewardGrantId: string): Promise<void> {
    if (this.state.redeemed.includes(rewardGrantId)) return;
    const result = await this.client.redeemReward(rewardGrantId);
    if (!result.ok) return this.stop(result.error);
    this.set({
      cart: result.value,
      redeemed: [...this.state.redeemed, rewardGrantId],
      // The price has changed, so any quote on screen is stale.
      quote: null,
      stage: 'address',
    });
  }

  /** Prices the cart for a real address: tax and shipping come from the service. */
  async quote(address: Address): Promise<void> {
    this.set({ stage: 'quoting', reason: null, failure: null });
    const result = await this.client.quoteCart(address);
    if (!result.ok) return this.stop(result.error);
    this.set({ stage: 'quoted', quote: result.value });
  }

  /** Places the order, then finds out how this deployment can be paid. */
  async place(address: Address, email?: string): Promise<void> {
    const cart = this.state.cart;
    if (!cart) return this.set({ stage: 'failed', reason: 'THE CART WENT AWAY.' });

    this.set({ stage: 'placing', reason: null, failure: null });
    const order = await this.client.createOrder({
      cartId: cart.id,
      shippingAddress: address,
      ...(email ? { email } : {}),
      ...(this.state.quote ? { expectedTotal: this.state.quote.total } : {}),
    });
    if (!order.ok) return this.stop(order.error);
    this.set({ order: order.value });

    // Which payment methods exist is a property of the *deployment*, so the
    // client asks it rather than guessing. This is why the terminal will start
    // taking real payments the moment a processor is configured, with no
    // change here: the screen it shows is a function of the answer.
    const meta = await this.client.fetchMeta();
    if (!meta.ok) return this.stop(meta.error);

    if (!meta.value.paymentsConfigured) {
      return this.set({
        stage: 'unavailable',
        reason: `NO PAYMENT PROVIDER IS CONFIGURED (${meta.value.paymentProvider.toUpperCase()}).`,
      });
    }

    this.set({ methods: methodsFor(meta.value.paymentProvider), stage: 'paying' });
  }

  /**
   * Creates the intent and confirms it.
   *
   * `token` is whatever the provider's own SDK minted. It is optional because
   * the fake provider does not need one, and it is a *token* because a card
   * number must never reach this code path — there is no field anywhere in
   * this module, in `ApiClient` or in the protocol that could carry one.
   */
  async pay(method?: PaymentMethodType, token?: string): Promise<void> {
    const order = this.state.order;
    if (!order) return this.set({ stage: 'failed', reason: 'THERE IS NO ORDER TO PAY FOR.' });

    // A double tap must not create a second intent. The service would refuse
    // it anyway — an order in `paid` does not need one — but refusing to ask
    // is better than showing a failure for something that already worked.
    if (order.payment?.status === 'succeeded' || order.status !== 'awaiting_payment') {
      if (order.status === 'paid') return this.set({ stage: 'placed' });
    }

    this.set({ stage: 'paying', reason: null, failure: null });

    const methodType = method ?? this.state.methods[0] ?? 'test';
    const intent = await this.client.createPaymentIntent(order.id, methodType, token);
    if (!intent.ok) {
      if (isNotConfigured(intent.error)) {
        return this.set({
          stage: 'unavailable',
          failure: intent.error,
          reason:
            intent.error.kind === 'conflict' || intent.error.kind === 'server'
              ? intent.error.message.toUpperCase()
              : 'NO PAYMENT PROVIDER IS CONFIGURED.',
        });
      }
      return this.stop(intent.error);
    }

    const result = await this.client.confirmPayment(order.id, token);
    if (!result.ok) return this.stop(result.error);

    if (result.value.status === 'payment_failed') {
      const code = result.value.payment?.failureCode ?? 'unknown';
      return this.set({
        stage: 'failed',
        order: result.value,
        reason: `PAYMENT DECLINED (${code.toUpperCase()}).`,
      });
    }

    this.set({ stage: 'placed', order: result.value });
  }

  private stop(failure: ApiFailure): void {
    this.set({
      stage: isNotConfigured(failure) ? 'unavailable' : 'failed',
      failure,
      reason: explain(failure),
    });
  }
}

/** Formats minor units as a price. The service is the source of currency. */
export function formatMoney(amount: Money): string {
  const major = amount.amountMinor / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: amount.currency }).format(major);
  } catch {
    return `${major.toFixed(2)} ${amount.currency}`;
  }
}
