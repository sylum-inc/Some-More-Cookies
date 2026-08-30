import { z } from 'zod';
import {
  AddCartItemRequestSchema,
  ApplyPromotionRequestSchema,
  CancelOrderRequestSchema,
  ConfirmPaymentRequestSchema,
  CreateOrderRequestSchema,
  CreatePaymentIntentRequestSchema,
  CreateRefundRequestSchema,
  IdSchema,
  QuoteCartRequestSchema,
  RedeemRewardRequestSchema,
  TransitionOrderRequestSchema,
  UpdateCartItemRequestSchema,
} from '@somemore/protocol';
import { ApiError } from '../errors.js';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { RequestContext } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';
import { OPS_TOKEN_HEADER } from './liveops.js';

const orderParams = z.object({ orderId: IdSchema });

/**
 * commerce domain. Every mutating route here is idempotent by contract.
 * The webhook route is unauthenticated and raw-body: it is authenticated by the
 * provider's signature instead of a bearer token.
 */
export function commerceRoutes(services: ServiceRegistry): AnyRoute[] {
  const { commerce, operators } = services;

  /**
   * The operator half of the two-credential gate, shared with live ops.
   *
   * Two routes here are operator-shaped and were reachable by any customer
   * holding a bearer token for their own order: advancing fulfillment, and
   * refunding an order that has already shipped. Together those were a
   * free-product machine — order it, mark it shipped yourself, refund yourself
   * in full. Both now need `LIVE_OPS_TOKEN` on top of a real account, which is
   * not RBAC and does not pretend to be; README Blocker 9 stays open until
   * there is a staff identity provider.
   *
   * Returns the actor rather than throwing when the token is absent, because
   * a customer refunding their own unshipped order is a legitimate customer
   * action — the domain decides which of the two it will accept.
   */
  function actorOf(ctx: RequestContext<unknown, unknown>): 'customer' | 'operator' {
    return operators.matches(ctx.headers[OPS_TOKEN_HEADER]) ? 'operator' : 'customer';
  }

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/commerce/products',
      auth: 'optional',
      summary: 'The catalog. One flagship product at launch.',
      async handle() {
        return { status: 200, body: { items: await commerce.listProducts() } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/commerce/products/:productId',
      auth: 'optional',
      summary: 'One product with its variants.',
      params: z.object({ productId: IdSchema }),
      async handle(ctx) {
        return { status: 200, body: await commerce.getProduct(ctx.params.productId) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/commerce/cart',
      auth: 'required',
      summary: 'Your open cart, created on first read.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.getCart(auth.accountId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/cart/items',
      auth: 'required',
      idempotent: true,
      summary: 'Add a variant to the cart.',
      body: AddCartItemRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await commerce.addItem(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/commerce/cart/items/:itemId',
      auth: 'required',
      idempotent: true,
      summary: 'Change a line quantity (0 removes it).',
      params: z.object({ itemId: IdSchema }),
      body: UpdateCartItemRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.updateItem(auth.accountId, ctx.params.itemId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'DELETE',
      path: '/v1/commerce/cart/items/:itemId',
      auth: 'required',
      summary: 'Remove a line.',
      params: z.object({ itemId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.removeItem(auth.accountId, ctx.params.itemId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/cart/promotions',
      auth: 'required',
      idempotent: true,
      summary: 'Apply a promotion code.',
      body: ApplyPromotionRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.applyPromotion(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/cart/rewards',
      auth: 'required',
      idempotent: true,
      summary: 'Redeem an earned reward against the cart.',
      body: RedeemRewardRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.redeemReward(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/cart/quote',
      auth: 'required',
      summary: 'Price the cart for an address: discounts, tax and shipping boundaries.',
      body: QuoteCartRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.quote(auth.accountId, ctx.body.shippingAddress) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders',
      auth: 'required',
      idempotent: true,
      summary: 'Convert a cart into an order awaiting payment.',
      body: CreateOrderRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await commerce.createOrder(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/commerce/orders',
      auth: 'required',
      summary: 'Your orders, newest first.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await commerce.listOrders(auth.accountId) } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/commerce/orders/:orderId',
      auth: 'required',
      summary: 'Read one order.',
      params: orderParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.getOrder(auth.accountId, ctx.params.orderId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders/:orderId/payment-intent',
      auth: 'required',
      idempotent: true,
      summary: 'Create a provider payment intent. Apple Pay / Google Pay / card are method types.',
      params: orderParams,
      body: CreatePaymentIntentRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 201,
          body: await commerce.createPaymentIntent(auth.accountId, ctx.params.orderId, ctx.body),
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders/:orderId/payment/confirm',
      auth: 'required',
      idempotent: true,
      summary: 'Confirm the payment intent and move the order to paid.',
      params: orderParams,
      body: ConfirmPaymentRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.confirmPayment(auth.accountId, ctx.params.orderId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders/:orderId/transitions',
      auth: 'required',
      idempotent: true,
      summary: 'Advance fulfillment: in_production -> packed -> shipped -> delivered.',
      params: orderParams,
      body: TransitionOrderRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const actor = actorOf(ctx);
        if (actor !== 'operator') {
          const reason = operators.unavailableReason();
          throw new ApiError(
            reason === null ? 'forbidden' : 'service_not_configured',
            reason ??
              `Advancing fulfillment is an operator action and needs a valid ${OPS_TOKEN_HEADER} header.`,
          );
        }
        return {
          status: 200,
          body: await commerce.transitionOrder(auth.accountId, ctx.params.orderId, ctx.body, actor),
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders/:orderId/refunds',
      auth: 'required',
      idempotent: true,
      summary: 'Refund all or part of an order.',
      params: orderParams,
      body: CreateRefundRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 201,
          body: await commerce.refundOrder(auth.accountId, ctx.params.orderId, ctx.body, actorOf(ctx)),
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/orders/:orderId/cancel',
      auth: 'required',
      idempotent: true,
      summary: 'Cancel an order that has not shipped.',
      params: orderParams,
      body: CancelOrderRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await commerce.cancelOrder(auth.accountId, ctx.params.orderId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/commerce/webhooks/payments',
      auth: 'none',
      rawBodyOnly: true,
      summary: 'Payment provider webhook. Authenticated by provider signature, not a token.',
      async handle(ctx) {
        const result = await commerce.handlePaymentWebhook(ctx.rawBody, ctx.headers);
        return { status: 200, body: result };
      },
    }),
  ];
}
