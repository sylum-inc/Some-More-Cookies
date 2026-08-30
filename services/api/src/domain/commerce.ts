import {
  NON_CANCELLABLE_STATUSES,
  SCHEMA_VERSION,
  canTransitionOrder,
  type AddCartItemRequest,
  type Address,
  type ApplyPromotionRequest,
  type CancelOrderRequest,
  type Cart,
  type CartItem,
  type CartQuote,
  type CreateOrderRequest,
  type CreatePaymentIntentRequest,
  type CreateRefundRequest,
  type ConfirmPaymentRequest,
  type Money,
  type Order,
  type OrderLine,
  type OrderStatus,
  type PaymentIntentResponse,
  type Product,
  type ProductVariant,
  type Refund,
  type RedeemRewardRequest,
  type ShippingQuote,
  type TaxQuote,
  type TransitionOrderRequest,
  type UpdateCartItemRequest,
} from '@somemore/protocol';
import { ApiError, badRequest, conflict, forbidden, illegalTransition, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { RewardsService } from './rewards.js';
import type { DomainDeps } from './types.js';

/**
 * Commerce.
 *
 * Deliberately subordinate to the experience: one flagship product, a cart, an
 * order with an explicit fulfillment state machine, and a payment provider that
 * is the ONLY thing allowed to touch money. Tax and shipping arrive as expiring
 * boundary objects captured verbatim onto the order so a refund or an audit can
 * reproduce exactly what the customer was shown.
 */
export interface CommerceService {
  listProducts(): Promise<Product[]>;
  getProduct(productId: string): Promise<Product>;
  getCart(accountId: string): Promise<Cart>;
  addItem(accountId: string, request: AddCartItemRequest): Promise<Cart>;
  updateItem(accountId: string, itemId: string, request: UpdateCartItemRequest): Promise<Cart>;
  removeItem(accountId: string, itemId: string): Promise<Cart>;
  applyPromotion(accountId: string, request: ApplyPromotionRequest): Promise<Cart>;
  redeemReward(accountId: string, request: RedeemRewardRequest): Promise<Cart>;
  quote(accountId: string, address: Address): Promise<CartQuote>;
  createOrder(accountId: string, request: CreateOrderRequest): Promise<Order>;
  getOrder(accountId: string, orderId: string): Promise<Order>;
  listOrders(accountId: string): Promise<Order[]>;
  createPaymentIntent(
    accountId: string,
    orderId: string,
    request: CreatePaymentIntentRequest,
  ): Promise<PaymentIntentResponse>;
  confirmPayment(accountId: string, orderId: string, request: ConfirmPaymentRequest): Promise<Order>;
  transitionOrder(
    accountId: string,
    orderId: string,
    request: TransitionOrderRequest,
    actor?: CommerceActor,
  ): Promise<Order>;
  refundOrder(
    accountId: string,
    orderId: string,
    request: CreateRefundRequest,
    actor?: CommerceActor,
  ): Promise<Order>;
  cancelOrder(accountId: string, orderId: string, request: CancelOrderRequest): Promise<Order>;
  handlePaymentWebhook(rawBody: string, headers: Readonly<Record<string, string>>): Promise<{ handled: boolean; orderId: string | null }>;
}

/**
 * Who is asking.
 *
 * There is no staff identity provider yet (README, Blocker 9), so "operator"
 * here means the caller presented the shared `LIVE_OPS_TOKEN` on top of a real
 * bearer token — the same two-credential gate live-ops writes use. It is not
 * RBAC and does not pretend to be; what it does is stop the *customer* path
 * from being an operator path, which it was.
 *
 * Defaulted to `'customer'` at every entry point on purpose: a new call site
 * that forgets to say gets the least privilege, not the most.
 */
export type CommerceActor = 'customer' | 'operator';

/**
 * Whether a customer may refund this order without an operator.
 *
 * Asked of the fulfillment timestamps rather than of the status, because the
 * status collapses: an order refunded in part is `partially_refunded` whether
 * it is sitting in the freezer or already on somebody's doorstep, and the
 * question here is only ever whether the goods have left the building. Until
 * they are packed, a self-service refund is ordinary customer service. After
 * that it is a decision about product that is already gone, and "order it,
 * ship it, refund it in full" was a free-product machine.
 */
function customerMayRefund(order: Order): boolean {
  const f = order.fulfillment;
  return f.packedAt == null && f.shippedAt == null && f.deliveredAt == null;
}

const CURRENCY = 'USD';

/**
 * BOUNDARY: sales tax. In production this call goes to a tax engine
 * (Avalara/TaxJar). No account exists yet, so we quote from a small internal
 * table and mark the quote `internal_flat`. See README "Blockers".
 */
const US_TAX_RATES: Readonly<Record<string, number>> = {
  OR: 0,
  MT: 0,
  NH: 0,
  DE: 0,
  CA: 0.0725,
  NY: 0.08875,
  WA: 0.065,
  TX: 0.0625,
  IL: 0.0625,
};
const DEFAULT_US_TAX_RATE = 0.06;

/** BOUNDARY: carrier rates. Flat frozen two-day until a carrier is contracted. */
const FLAT_SHIPPING_MINOR = 1200;
const QUOTE_TTL_MINUTES = 30;

export function createCommerceService(deps: DomainDeps, rewards: RewardsService): CommerceService {
  const { repos, clock, ids, logger, payments, config } = deps;

  const money = (amountMinor: number): Money => ({ currency: CURRENCY, amountMinor });

  function quoteExpiry(): { calculatedAt: string; expiresAt: string } {
    const calculatedAt = clock.isoNow();
    const expiresAt = new Date(clock.now().getTime() + QUOTE_TTL_MINUTES * 60_000).toISOString();
    return { calculatedAt, expiresAt };
  }

  function quoteTax(taxableMinor: number, address: Address): TaxQuote {
    const { calculatedAt, expiresAt } = quoteExpiry();
    const rate = address.country === 'US' ? (US_TAX_RATES[address.region.toUpperCase()] ?? DEFAULT_US_TAX_RATE) : 0;
    const amount = Math.round(taxableMinor * rate);
    return {
      provider: 'internal_flat',
      providerQuoteId: null,
      calculatedAt,
      expiresAt,
      taxableSubtotal: money(taxableMinor),
      lines:
        rate === 0
          ? []
          : [
              {
                name: 'Sales tax',
                jurisdiction: `${address.country}-${address.region.toUpperCase()}`,
                rate,
                amount: money(amount),
              },
            ],
      total: money(amount),
      exclusive: true,
    };
  }

  function quoteShipping(address: Address, free: boolean): ShippingQuote {
    const { calculatedAt, expiresAt } = quoteExpiry();
    return {
      provider: 'internal_flat',
      providerQuoteId: null,
      carrier: 'ColdRun',
      service: 'two_day_frozen',
      amount: money(free ? 0 : FLAT_SHIPPING_MINOR),
      estimatedDeliveryDays: { min: 2, max: 3 },
      requiresColdChain: true,
      calculatedAt,
      expiresAt,
    };
  }

  async function resolveVariant(productId: string, variantId: string): Promise<{ product: Product; variant: ProductVariant }> {
    const product = await repos.products.get(productId);
    if (product === null) throw notFound('No such product.');
    if (product.status !== 'active') throw conflict('That product is not on sale right now.');
    const variant = product.variants.find((v) => v.id === variantId);
    if (variant === undefined || !variant.active) throw notFound('No such variant.');
    return { product, variant };
  }

  function unitPriceFor(product: Product, variant: ProductVariant): Money {
    return money(product.basePrice.amountMinor + variant.priceDelta.amountMinor);
  }

  function subtotalOf(items: readonly CartItem[]): Money {
    return money(items.reduce((sum, item) => sum + item.lineSubtotal.amountMinor, 0));
  }

  async function openCart(accountId: string): Promise<Cart> {
    const existing = await repos.carts.findOpenByAccount(accountId);
    if (existing !== null) return existing;
    const now = clock.isoNow();
    return repos.carts.create({
      id: ids.next(ID_PREFIX.cart),
      accountId,
      currency: CURRENCY,
      items: [],
      promotionCodes: [],
      rewardGrantIds: [],
      subtotal: money(0),
      createdAt: now,
      updatedAt: now,
      revision: 0,
      convertedOrderId: null,
    });
  }

  async function mutateCart(accountId: string, mutate: (cart: Cart) => Cart): Promise<Cart> {
    const cart = await openCart(accountId);
    return repos.carts.update(cart.id, (current) => {
      if (current.convertedOrderId !== null) throw conflict('That cart has already become an order.');
      const next = mutate(current);
      return {
        ...next,
        subtotal: subtotalOf(next.items),
        updatedAt: clock.isoNow(),
        revision: current.revision + 1,
      };
    });
  }

  /** The one place discounts are computed, for both quoting and ordering. */
  async function computeQuote(accountId: string, cart: Cart, address: Address): Promise<CartQuote> {
    if (cart.items.length === 0) throw conflict('Your cart is empty.');
    for (const item of cart.items) {
      const product = await repos.products.get(item.productId);
      if (product === null) throw notFound('A product in your cart no longer exists.');
      if (!product.shipsToCountries.includes(address.country)) {
        throw new ApiError('precondition_failed', `We cannot ship ${product.name} to ${address.country} yet.`, {
          details: { productId: product.id, shipsToCountries: product.shipsToCountries },
        });
      }
    }

    const subtotal = subtotalOf(cart.items);
    let discountMinor = 0;
    let freeShipping = false;
    const appliedPromotions: CartQuote['appliedPromotions'] = [];

    for (const code of cart.promotionCodes) {
      const promotion = await repos.promotions.getByCode(code);
      if (promotion === null || !promotion.active) continue;
      const nowIso = clock.isoNow();
      if (promotion.startsAt > nowIso) continue;
      if (promotion.endsAt !== null && promotion.endsAt <= nowIso) continue;
      if (promotion.minSubtotal !== null && subtotal.amountMinor < promotion.minSubtotal.amountMinor) continue;
      if (promotion.maxRedemptions !== null && promotion.redemptionsUsed >= promotion.maxRedemptions) continue;

      let promotionDiscount = 0;
      if (promotion.rule.kind === 'percent_off') {
        promotionDiscount = Math.round((subtotal.amountMinor * promotion.rule.percent) / 100);
      } else if (promotion.rule.kind === 'amount_off') {
        promotionDiscount = Math.min(subtotal.amountMinor - discountMinor, promotion.rule.amount.amountMinor);
      } else {
        freeShipping = true;
      }
      discountMinor += promotionDiscount;
      appliedPromotions.push({ code: promotion.code, promotionId: promotion.id, discount: money(promotionDiscount) });
    }

    const appliedRewards: CartQuote['appliedRewards'] = [];
    for (const grantId of cart.rewardGrantIds) {
      const grant = await repos.rewardGrants.get(grantId);
      if (grant === null || grant.accountId !== accountId || grant.status !== 'granted') continue;
      const definition = await repos.rewardDefinitions.get(grant.rewardId);
      const payloadCode = definition?.payloadCode ?? null;
      const line = cart.items.find((item) => item.sku === payloadCode);
      if (line === undefined) continue;
      const rewardDiscount = Math.min(line.unitPrice.amountMinor, subtotal.amountMinor - discountMinor);
      discountMinor += rewardDiscount;
      appliedRewards.push({ rewardGrantId: grant.id, rewardCode: grant.rewardCode, discount: money(rewardDiscount) });
    }

    discountMinor = Math.min(discountMinor, subtotal.amountMinor);
    const taxable = subtotal.amountMinor - discountMinor;
    const tax = quoteTax(taxable, address);
    const shipping = quoteShipping(address, freeShipping);
    const total = taxable + tax.total.amountMinor + shipping.amount.amountMinor;

    return {
      cartId: cart.id,
      currency: CURRENCY,
      subtotal,
      discountTotal: money(discountMinor),
      tax,
      shipping,
      total: money(total),
      appliedPromotions,
      appliedRewards,
    };
  }

  async function loadOrder(accountId: string, orderId: string): Promise<Order> {
    const order = await repos.orders.get(orderId);
    if (order === null) throw notFound('No such order.');
    if (order.accountId !== accountId) throw forbidden('That is not your order.');
    return order;
  }

  async function moveOrder(
    orderId: string,
    to: OrderStatus,
    actor: Order['statusHistory'][number]['actor'],
    note = '',
  ): Promise<Order> {
    const now = clock.isoNow();
    return repos.orders.update(orderId, (order) => {
      if (order.status === to) return order;
      if (!canTransitionOrder(order.status, to)) {
        throw illegalTransition(`An order cannot go from ${order.status} to ${to}.`, { from: order.status, to });
      }
      return {
        ...order,
        status: to,
        statusHistory: [...order.statusHistory, { from: order.status, to, at: now, actor, note }],
        updatedAt: now,
      };
    });
  }

  async function adjustInventory(lines: readonly OrderLine[], delta: number): Promise<void> {
    for (const line of lines) {
      const product = await repos.products.get(line.productId);
      if (product === null) continue;
      const variant = product.variants.find((v) => v.id === line.variantId);
      if (variant === undefined || variant.inventoryPolicy !== 'track') continue;
      await repos.products.update(product.id, (p) => ({
        ...p,
        variants: p.variants.map((v) =>
          v.id === line.variantId
            ? { ...v, inventoryQuantity: Math.max(0, v.inventoryQuantity + delta * line.quantity) }
            : v,
        ),
        updatedAt: clock.isoNow(),
      }));
    }
  }

  return {
    async listProducts() {
      const products = await repos.products.list();
      return products.filter((p) => p.status === 'active' || p.status === 'sold_out');
    },

    async getProduct(productId) {
      const product = await repos.products.get(productId);
      if (product === null) throw notFound('No such product.');
      return product;
    },

    getCart: openCart,

    async addItem(accountId, request) {
      const { product, variant } = await resolveVariant(request.productId, request.variantId);
      if (variant.inventoryPolicy === 'track' && variant.inventoryQuantity < request.quantity) {
        throw conflict('We do not have that many left.', { available: variant.inventoryQuantity });
      }
      if (request.sandwichId !== undefined) {
        const sandwich = await repos.sandwiches.get(request.sandwichId);
        if (sandwich === null || sandwich.accountId !== accountId) throw notFound('No such sandwich.');
      }
      const unitPrice = unitPriceFor(product, variant);
      const now = clock.isoNow();

      return mutateCart(accountId, (cart) => {
        const existing = cart.items.find((item) => item.variantId === variant.id);
        const nextQuantity = (existing?.quantity ?? 0) + request.quantity;
        if (nextQuantity > product.maxPerOrder) {
          throw conflict(`You can order at most ${product.maxPerOrder} of these at a time.`, {
            maxPerOrder: product.maxPerOrder,
          });
        }
        const line: CartItem = {
          id: existing?.id ?? ids.next(ID_PREFIX.cartItem),
          productId: product.id,
          variantId: variant.id,
          sku: variant.sku,
          name: `${product.name} - ${variant.name}`,
          quantity: nextQuantity,
          unitPrice,
          lineSubtotal: money(unitPrice.amountMinor * nextQuantity),
          sandwichId: request.sandwichId ?? existing?.sandwichId ?? null,
          addedAt: existing?.addedAt ?? now,
        };
        return {
          ...cart,
          items: existing === undefined ? [...cart.items, line] : cart.items.map((i) => (i.id === line.id ? line : i)),
        };
      });
    },

    async updateItem(accountId, itemId, request) {
      return mutateCart(accountId, (cart) => {
        const existing = cart.items.find((item) => item.id === itemId);
        if (existing === undefined) throw notFound('That item is not in your cart.');
        if (request.quantity === 0) return { ...cart, items: cart.items.filter((i) => i.id !== itemId) };
        const line: CartItem = {
          ...existing,
          quantity: request.quantity,
          lineSubtotal: money(existing.unitPrice.amountMinor * request.quantity),
        };
        return { ...cart, items: cart.items.map((i) => (i.id === itemId ? line : i)) };
      });
    },

    async removeItem(accountId, itemId) {
      return mutateCart(accountId, (cart) => {
        if (!cart.items.some((i) => i.id === itemId)) throw notFound('That item is not in your cart.');
        return { ...cart, items: cart.items.filter((i) => i.id !== itemId) };
      });
    },

    async applyPromotion(accountId, request) {
      const code = request.code.toUpperCase();
      const promotion = await repos.promotions.getByCode(code);
      if (promotion === null || !promotion.active) throw notFound('That code is not valid.');
      const nowIso = clock.isoNow();
      if (promotion.startsAt > nowIso || (promotion.endsAt !== null && promotion.endsAt <= nowIso)) {
        throw conflict('That code is not active right now.');
      }
      const used = await repos.promotions.countRedemptionsForAccount(promotion.id, accountId);
      if (used >= promotion.perAccountLimit) throw conflict('You have already used that code.');

      // Stacking is only legal when the incoming code AND every code already on
      // the cart opt into it.
      const current = await openCart(accountId);
      if (!current.promotionCodes.includes(code) && current.promotionCodes.length > 0) {
        const existing = await Promise.all(current.promotionCodes.map((c) => repos.promotions.getByCode(c)));
        const blocked = !promotion.stackable || existing.some((p) => p !== null && !p.stackable);
        if (blocked) {
          throw conflict('That code cannot be combined with the one already on your cart.', {
            existing: current.promotionCodes,
          });
        }
      }

      return mutateCart(accountId, (cart) =>
        cart.promotionCodes.includes(code) ? cart : { ...cart, promotionCodes: [...cart.promotionCodes, code] },
      );
    },

    async redeemReward(accountId, request) {
      const grant = await repos.rewardGrants.get(request.rewardGrantId);
      if (grant === null || grant.accountId !== accountId) throw notFound('No such reward.');
      if (grant.status !== 'granted') throw conflict('That reward has already been used.');
      return mutateCart(accountId, (cart) =>
        cart.rewardGrantIds.includes(grant.id)
          ? cart
          : { ...cart, rewardGrantIds: [...cart.rewardGrantIds, grant.id] },
      );
    },

    async quote(accountId, address) {
      const cart = await openCart(accountId);
      return computeQuote(accountId, cart, address);
    },

    async createOrder(accountId, request) {
      const cart = await repos.carts.get(request.cartId);
      if (cart === null) throw notFound('No such cart.');
      if (cart.accountId !== accountId) throw forbidden('That is not your cart.');
      if (cart.convertedOrderId !== null) throw conflict('That cart has already become an order.');

      const quote = await computeQuote(accountId, cart, request.shippingAddress);
      if (request.expectedTotal !== undefined && request.expectedTotal.amountMinor !== quote.total.amountMinor) {
        throw conflict('The price changed while you were checking out.', {
          expected: request.expectedTotal.amountMinor,
          actual: quote.total.amountMinor,
        });
      }

      for (const item of cart.items) {
        const { variant } = await resolveVariant(item.productId, item.variantId);
        if (variant.inventoryPolicy === 'track' && variant.inventoryQuantity < item.quantity) {
          throw conflict('We sold out while you were checking out.', { sku: item.sku });
        }
      }

      const now = clock.isoNow();
      const lines: OrderLine[] = cart.items.map((item) => ({
        id: ids.next(ID_PREFIX.orderLine),
        productId: item.productId,
        variantId: item.variantId,
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        lineSubtotal: item.lineSubtotal,
        sandwichId: item.sandwichId,
      }));

      const order: Order = {
        id: ids.next(ID_PREFIX.order),
        reference: ids.orderReference(),
        accountId,
        cartId: cart.id,
        currency: CURRENCY,
        status: 'created',
        statusHistory: [{ from: null, to: 'created', at: now, actor: 'customer', note: '' }],
        lines,
        subtotal: quote.subtotal,
        discountTotal: quote.discountTotal,
        tax: quote.tax,
        shipping: quote.shipping,
        total: quote.total,
        refundedTotal: money(0),
        shippingAddress: request.shippingAddress,
        email: request.email ?? null,
        payment: null,
        appliedPromotionCodes: quote.appliedPromotions.map((p) => p.code),
        redeemedRewardGrantIds: quote.appliedRewards.map((r) => r.rewardGrantId),
        fulfillment: {
          carrier: null,
          service: null,
          trackingNumber: null,
          coldChainPackId: null,
          producedAt: null,
          packedAt: null,
          shippedAt: null,
          deliveredAt: null,
          estimatedDeliveryAt: null,
        },
        refunds: [],
        cancellation: null,
        createdAt: now,
        updatedAt: now,
        idempotencyKey: request.idempotencyKey,
        schemaVersion: SCHEMA_VERSION,
      };

      const created = await repos.orders.create(order);
      await adjustInventory(lines, -1);
      await repos.carts.update(cart.id, (c) => ({ ...c, convertedOrderId: created.id, updatedAt: now }));
      for (const applied of quote.appliedPromotions) {
        await repos.promotions.update(applied.promotionId, (p) => ({ ...p, redemptionsUsed: p.redemptionsUsed + 1 }));
        await repos.promotions.recordRedemption(applied.promotionId, accountId, created.id);
      }
      for (const applied of quote.appliedRewards) {
        await rewards.consumeGrant(accountId, applied.rewardGrantId, created.id);
      }
      logger.info('commerce.order_created', { orderId: created.id, total: created.total.amountMinor });
      return moveOrder(created.id, 'awaiting_payment', 'system', 'Order created.');
    },

    getOrder: loadOrder,

    async listOrders(accountId) {
      return repos.orders.listByAccount(accountId);
    },

    async createPaymentIntent(accountId, orderId, request) {
      const order = await loadOrder(accountId, orderId);
      if (order.status !== 'awaiting_payment' && order.status !== 'payment_failed') {
        throw conflict(`An order in ${order.status} does not need a payment intent.`);
      }
      if (!payments.isConfigured()) {
        throw new ApiError(
          'payment_provider_not_configured',
          'No payment provider is configured. See README "Blockers".',
        );
      }

      const intent = await payments.createIntent({
        orderId: order.id,
        accountId,
        amount: order.total,
        methodType: request.methodType,
        paymentMethodToken: request.paymentMethodToken,
        returnUrl: request.returnUrl,
        description: `Some More ${order.reference}`,
        idempotencyKey: request.idempotencyKey,
      });

      const now = clock.isoNow();
      // Asking for a fresh intent after a decline puts the order back in the
      // queue for payment; `payment_failed` is a dead end otherwise.
      if (order.status === 'payment_failed') {
        await moveOrder(order.id, 'awaiting_payment', 'customer', 'Retrying payment.');
      }
      const updated = await repos.orders.update(order.id, (o) => ({
        ...o,
        payment: {
          provider: intent.provider,
          intentId: intent.intentId,
          status: intent.status,
          methodType: intent.methodType,
          amount: intent.amount,
          displayLabel: intent.displayLabel,
          createdAt: o.payment?.createdAt ?? now,
          updatedAt: now,
          failureCode: intent.failureCode,
        },
        updatedAt: now,
      }));

      return {
        payment: updated.payment ?? {
          provider: intent.provider,
          intentId: intent.intentId,
          status: intent.status,
          methodType: intent.methodType,
          amount: intent.amount,
          displayLabel: intent.displayLabel,
          createdAt: now,
          updatedAt: now,
          failureCode: intent.failureCode,
        },
        clientSecret: intent.clientSecret,
        publishableKeyHint: config.stripePublishableKey,
      };
    },

    async confirmPayment(accountId, orderId, request) {
      const order = await loadOrder(accountId, orderId);
      if (order.payment === null) throw conflict('That order has no payment intent yet.');
      if (order.status === 'paid') return order;

      const intent = await payments.confirmIntent({
        intentId: order.payment.intentId,
        paymentMethodToken: request.paymentMethodToken,
        idempotencyKey: request.idempotencyKey,
      });
      const now = clock.isoNow();
      await repos.orders.update(order.id, (o) => ({
        ...o,
        payment:
          o.payment === null
            ? null
            : { ...o.payment, status: intent.status, failureCode: intent.failureCode, displayLabel: intent.displayLabel, updatedAt: now },
        updatedAt: now,
      }));

      if (intent.status === 'succeeded') {
        return moveOrder(order.id, 'paid', 'customer', 'Payment confirmed.');
      }
      if (intent.status === 'failed' || intent.status === 'canceled') {
        await moveOrder(order.id, 'payment_failed', 'customer', intent.failureCode ?? 'Payment failed.');
        throw new ApiError('payment_failed', 'That payment did not go through.', {
          details: { failureCode: intent.failureCode, status: intent.status },
        });
      }
      const refreshed = await repos.orders.get(order.id);
      if (refreshed === null) throw notFound('No such order.');
      return refreshed;
    },

    /**
     * Operator-shaped fulfillment transitions. Payment, refund and cancellation
     * have their own endpoints because they have side effects beyond status.
     */
    async transitionOrder(accountId, orderId, request, actor = 'customer') {
      // Fulfillment is somebody else's job. A player marking their own order
      // shipped is not a workflow this product has, and combined with the
      // refund path below it used to be a way of being sent a sandwich for
      // nothing. The route gates on the operator token; this is the same rule
      // stated where the behaviour lives, so a future caller cannot bypass it
      // by going round the route.
      if (actor !== 'operator') {
        throw forbidden('Fulfillment transitions are an operator action.');
      }
      const order = await loadOrder(accountId, orderId);
      const restricted: OrderStatus[] = ['paid', 'refunded', 'partially_refunded', 'cancelled', 'awaiting_payment'];
      if (restricted.includes(request.to)) {
        throw badRequest(`Use the dedicated endpoint to move an order to ${request.to}.`);
      }
      if (!canTransitionOrder(order.status, request.to)) {
        throw illegalTransition(`An order cannot go from ${order.status} to ${request.to}.`, {
          from: order.status,
          to: request.to,
        });
      }
      const now = clock.isoNow();
      const moved = await moveOrder(orderId, request.to, 'operator', request.note);
      return repos.orders.update(moved.id, (o) => ({
        ...o,
        fulfillment: {
          ...o.fulfillment,
          carrier: request.tracking?.carrier ?? o.fulfillment.carrier,
          service: request.tracking?.service ?? o.fulfillment.service,
          trackingNumber: request.tracking?.trackingNumber ?? o.fulfillment.trackingNumber,
          producedAt: request.to === 'in_production' ? now : o.fulfillment.producedAt,
          packedAt: request.to === 'packed' ? now : o.fulfillment.packedAt,
          shippedAt: request.to === 'shipped' ? now : o.fulfillment.shippedAt,
          deliveredAt: request.to === 'delivered' ? now : o.fulfillment.deliveredAt,
        },
        updatedAt: now,
      }));
    },

    async refundOrder(accountId, orderId, request, actor = 'customer') {
      const order = await loadOrder(accountId, orderId);
      if (order.payment === null || order.payment.status !== 'succeeded') {
        throw conflict('There is nothing to refund on that order.');
      }
      if (actor !== 'operator' && !customerMayRefund(order)) {
        throw forbidden('An order that has been packed can only be refunded by an operator.');
      }
      const remaining = order.total.amountMinor - order.refundedTotal.amountMinor;
      const amountMinor = request.amountMinor ?? remaining;
      if (amountMinor <= 0 || amountMinor > remaining) {
        throw badRequest('That refund amount is not available on this order.', { remaining });
      }
      const target: OrderStatus = amountMinor === remaining ? 'refunded' : 'partially_refunded';
      if (!canTransitionOrder(order.status, target)) {
        throw illegalTransition(`An order in ${order.status} cannot be refunded.`, { from: order.status, to: target });
      }

      const providerRefund = await payments.refund({
        intentId: order.payment.intentId,
        amount: money(amountMinor),
        reason: request.reason,
        idempotencyKey: request.idempotencyKey,
      });

      const now = clock.isoNow();
      const refund: Refund = {
        id: ids.next(ID_PREFIX.refund),
        orderId: order.id,
        amount: money(amountMinor),
        reason: request.reason,
        state: providerRefund.status === 'succeeded' ? 'succeeded' : providerRefund.status === 'pending' ? 'pending' : 'failed',
        providerRefundId: providerRefund.refundId,
        requestedBy: actor,
        createdAt: now,
        updatedAt: now,
        failureCode: providerRefund.failureCode,
        idempotencyKey: request.idempotencyKey,
      };

      await repos.orders.update(order.id, (o) => ({
        ...o,
        refunds: [...o.refunds, refund],
        refundedTotal:
          refund.state === 'succeeded' ? money(o.refundedTotal.amountMinor + amountMinor) : o.refundedTotal,
        updatedAt: now,
      }));

      if (refund.state === 'failed') {
        throw new ApiError('payment_failed', 'The provider could not refund that charge.', {
          details: { failureCode: providerRefund.failureCode },
        });
      }
      if (refund.state !== 'succeeded') {
        const pending = await repos.orders.get(order.id);
        if (pending === null) throw notFound('No such order.');
        return pending;
      }
      await adjustInventory(order.lines, target === 'refunded' ? 1 : 0);
      logger.info('commerce.refunded', { orderId: order.id, amountMinor, target });
      return moveOrder(order.id, target, 'customer', request.reason);
    },

    async cancelOrder(accountId, orderId, request) {
      const order = await loadOrder(accountId, orderId);
      if (NON_CANCELLABLE_STATUSES.includes(order.status) || !canTransitionOrder(order.status, 'cancelled')) {
        throw illegalTransition('That order has gone too far to cancel. Ask for a refund instead.', {
          from: order.status,
        });
      }
      const now = clock.isoNow();
      await adjustInventory(order.lines, 1);
      const cancelled = await moveOrder(orderId, 'cancelled', 'customer', request.reason);
      return repos.orders.update(cancelled.id, (o) => ({
        ...o,
        cancellation: { requestedAt: now, requestedBy: 'customer', reason: request.reason, restocked: true },
        updatedAt: now,
      }));
    },

    async handlePaymentWebhook(rawBody, headers) {
      const verification = payments.verifyWebhook(rawBody, headers);
      if (!verification.verified) {
        throw new ApiError('webhook_signature_invalid', 'Webhook signature did not verify.', {
          details: { reason: verification.reason ?? null },
        });
      }
      const event = verification.event;
      if (event === undefined) return { handled: false, orderId: null };

      const order = await repos.orders.findByPaymentIntentId(event.intentId);
      if (order === null) {
        logger.warn('commerce.webhook_unmatched', { intentId: event.intentId, type: event.type });
        return { handled: false, orderId: null };
      }
      const now = clock.isoNow();

      if (event.type === 'payment_intent.succeeded') {
        await repos.orders.update(order.id, (o) => ({
          ...o,
          payment: o.payment === null ? null : { ...o.payment, status: 'succeeded', updatedAt: now },
          updatedAt: now,
        }));
        if (order.status !== 'paid' && canTransitionOrder(order.status, 'paid')) {
          await moveOrder(order.id, 'paid', 'payment_webhook', event.id);
        }
        return { handled: true, orderId: order.id };
      }

      if (event.type === 'payment_intent.payment_failed' || event.type === 'payment_intent.canceled') {
        const status = event.type === 'payment_intent.canceled' ? 'canceled' : 'failed';
        await repos.orders.update(order.id, (o) => ({
          ...o,
          payment:
            o.payment === null ? null : { ...o.payment, status, failureCode: event.failureCode, updatedAt: now },
          updatedAt: now,
        }));
        if (canTransitionOrder(order.status, 'payment_failed')) {
          await moveOrder(order.id, 'payment_failed', 'payment_webhook', event.failureCode ?? event.id);
        }
        return { handled: true, orderId: order.id };
      }

      return { handled: true, orderId: order.id };
    },
  };
}
