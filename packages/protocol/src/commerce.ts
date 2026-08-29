import { z } from 'zod';
import {
  CountryCodeSchema,
  CurrencySchema,
  IdSchema,
  MoneySchema,
  NonNegativeIntSchema,
  NonNegativeMoneySchema,
  PositiveIntSchema,
  SemVerSchema,
  TimestampSchema,
  UnitIntervalSchema,
  withIdempotency,
} from './common.js';

/*
 * Commerce is deliberately subordinate to the experience: the shop exists so a
 * player can hold the thing they just made. It is a custom domain model — no
 * off-the-shelf cart semantics — with one flagship product at launch.
 *
 * PCI SCOPE: no schema in this file accepts a card number, CVC or expiry. The
 * client collects payment details with the provider's own SDK; we only ever see
 * a provider intent id, a provider payment-method token and a method *type*.
 */

/* -------------------------------------------------------------------------- */
/* Catalog                                                                     */
/* -------------------------------------------------------------------------- */

export const ProductKindValues = ['physical', 'digital', 'experience'] as const;
export const ProductKindSchema = z.enum(ProductKindValues);

export const ProductStatusValues = ['draft', 'active', 'sold_out', 'retired'] as const;
export const ProductStatusSchema = z.enum(ProductStatusValues);
export type ProductStatus = z.infer<typeof ProductStatusSchema>;

export const InventoryPolicyValues = ['track', 'infinite'] as const;
export const InventoryPolicySchema = z.enum(InventoryPolicyValues);

export const ProductVariantSchema = z.object({
  id: IdSchema,
  sku: z.string().min(1).max(64).regex(/^[A-Z0-9-]+$/),
  name: z.string().min(1).max(80),
  /** Added to the product's base price; may be negative for a bundle discount. */
  priceDelta: MoneySchema,
  inventoryPolicy: InventoryPolicySchema.default('track'),
  inventoryQuantity: NonNegativeIntSchema.default(0),
  weightGrams: NonNegativeIntSchema.default(0),
  attributes: z.record(z.string().max(40), z.string().max(80)).default({}),
  active: z.boolean().default(true),
});
export type ProductVariant = z.infer<typeof ProductVariantSchema>;

export const ProductSchema = z.object({
  id: IdSchema,
  sku: z.string().min(1).max(64).regex(/^[A-Z0-9-]+$/),
  name: z.string().min(1).max(120),
  subtitle: z.string().max(160).default(''),
  description: z.string().max(4000).default(''),
  kind: ProductKindSchema,
  status: ProductStatusSchema.default('draft'),
  basePrice: NonNegativeMoneySchema,
  variants: z.array(ProductVariantSchema).min(1).max(24),
  imageKeys: z.array(z.string().max(512)).max(12).default([]),
  requiresShipping: z.boolean().default(true),
  /** Tax category handed to the tax boundary (e.g. prepared frozen food). */
  taxCode: z.string().max(32).default('food_frozen'),
  maxPerOrder: PositiveIntSchema.max(20).default(4),
  /** Countries we can actually ship a frozen product to today. */
  shipsToCountries: z.array(CountryCodeSchema).min(1).default(['US']),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Product = z.infer<typeof ProductSchema>;

/* -------------------------------------------------------------------------- */
/* Cart                                                                        */
/* -------------------------------------------------------------------------- */

export const CartItemSchema = z.object({
  id: IdSchema,
  productId: IdSchema,
  variantId: IdSchema,
  sku: z.string().max(64),
  name: z.string().max(160),
  quantity: PositiveIntSchema.max(20),
  unitPrice: NonNegativeMoneySchema,
  lineSubtotal: NonNegativeMoneySchema,
  /** Optional link back to the sandwich that inspired the purchase. */
  sandwichId: IdSchema.nullable().default(null),
  addedAt: TimestampSchema,
});
export type CartItem = z.infer<typeof CartItemSchema>;

export const CartSchema = z.object({
  id: IdSchema,
  accountId: IdSchema,
  currency: CurrencySchema,
  items: z.array(CartItemSchema).max(20).default([]),
  promotionCodes: z.array(z.string().max(64)).max(4).default([]),
  rewardGrantIds: z.array(IdSchema).max(4).default([]),
  subtotal: NonNegativeMoneySchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  revision: NonNegativeIntSchema,
  /** Set once the cart has been converted; a converted cart is read-only. */
  convertedOrderId: IdSchema.nullable().default(null),
});
export type Cart = z.infer<typeof CartSchema>;

export const AddCartItemRequestSchema = withIdempotency(
  z.object({
    productId: IdSchema,
    variantId: IdSchema,
    quantity: PositiveIntSchema.max(20).default(1),
    sandwichId: IdSchema.optional(),
  }),
);
export type AddCartItemRequest = z.infer<typeof AddCartItemRequestSchema>;

export const UpdateCartItemRequestSchema = withIdempotency(
  z.object({ quantity: NonNegativeIntSchema.max(20) }),
);
export type UpdateCartItemRequest = z.infer<typeof UpdateCartItemRequestSchema>;

export const ApplyPromotionRequestSchema = withIdempotency(
  z.object({ code: z.string().min(1).max(64) }),
);
export type ApplyPromotionRequest = z.infer<typeof ApplyPromotionRequestSchema>;

export const RedeemRewardRequestSchema = withIdempotency(
  z.object({ rewardGrantId: IdSchema }),
);
export type RedeemRewardRequest = z.infer<typeof RedeemRewardRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Addresses, tax and shipping boundaries                                      */
/* -------------------------------------------------------------------------- */

export const AddressSchema = z.object({
  name: z.string().min(1).max(120),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().default(null),
  city: z.string().min(1).max(100),
  region: z.string().min(1).max(100),
  postalCode: z.string().min(2).max(20),
  country: CountryCodeSchema,
  phone: z.string().max(32).nullable().default(null),
});
export type Address = z.infer<typeof AddressSchema>;

/**
 * Boundary object. Tax is NOT computed by this service in production — it comes
 * from a tax engine. The quote is captured verbatim on the order so a refund or
 * an audit can reproduce it, and it expires.
 */
export const TaxQuoteSchema = z.object({
  provider: z.enum(['internal_flat', 'external']),
  providerQuoteId: z.string().max(128).nullable().default(null),
  calculatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
  taxableSubtotal: NonNegativeMoneySchema,
  lines: z
    .array(
      z.object({
        name: z.string().max(80),
        jurisdiction: z.string().max(80),
        rate: UnitIntervalSchema,
        amount: NonNegativeMoneySchema,
      }),
    )
    .max(12),
  total: NonNegativeMoneySchema,
  /** true => tax added on top of prices (US); false => already included (EU). */
  exclusive: z.boolean().default(true),
});
export type TaxQuote = z.infer<typeof TaxQuoteSchema>;

/** Boundary object for the carrier rate. Also captured verbatim on the order. */
export const ShippingQuoteSchema = z.object({
  provider: z.enum(['internal_flat', 'external']),
  providerQuoteId: z.string().max(128).nullable().default(null),
  carrier: z.string().max(64),
  service: z.string().max(64),
  /** Frozen goods ship insulated; this is the surcharge-inclusive rate. */
  amount: NonNegativeMoneySchema,
  estimatedDeliveryDays: z.object({ min: PositiveIntSchema, max: PositiveIntSchema }),
  requiresColdChain: z.boolean().default(true),
  calculatedAt: TimestampSchema,
  expiresAt: TimestampSchema,
});
export type ShippingQuote = z.infer<typeof ShippingQuoteSchema>;

export const QuoteCartRequestSchema = z.object({
  shippingAddress: AddressSchema,
});
export type QuoteCartRequest = z.infer<typeof QuoteCartRequestSchema>;

export const CartQuoteSchema = z.object({
  cartId: IdSchema,
  currency: CurrencySchema,
  subtotal: NonNegativeMoneySchema,
  discountTotal: NonNegativeMoneySchema,
  tax: TaxQuoteSchema,
  shipping: ShippingQuoteSchema,
  total: NonNegativeMoneySchema,
  appliedPromotions: z.array(
    z.object({ code: z.string().max(64), promotionId: IdSchema, discount: NonNegativeMoneySchema }),
  ),
  appliedRewards: z.array(
    z.object({ rewardGrantId: IdSchema, rewardCode: z.string().max(64), discount: NonNegativeMoneySchema }),
  ),
});
export type CartQuote = z.infer<typeof CartQuoteSchema>;

/* -------------------------------------------------------------------------- */
/* Promotions                                                                  */
/* -------------------------------------------------------------------------- */

export const PromotionKindSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent_off'), percent: z.number().min(1).max(100) }),
  z.object({ kind: z.literal('amount_off'), amount: NonNegativeMoneySchema }),
  z.object({ kind: z.literal('free_shipping') }),
]);
export type PromotionKind = z.infer<typeof PromotionKindSchema>;

export const PromotionSchema = z.object({
  id: IdSchema,
  code: z.string().min(1).max(64).regex(/^[A-Z0-9_-]+$/),
  name: z.string().min(1).max(80),
  rule: PromotionKindSchema,
  startsAt: TimestampSchema,
  endsAt: TimestampSchema.nullable().default(null),
  minSubtotal: NonNegativeMoneySchema.nullable().default(null),
  maxRedemptions: PositiveIntSchema.nullable().default(null),
  redemptionsUsed: NonNegativeIntSchema.default(0),
  perAccountLimit: PositiveIntSchema.default(1),
  stackable: z.boolean().default(false),
  active: z.boolean().default(true),
});
export type Promotion = z.infer<typeof PromotionSchema>;

/* -------------------------------------------------------------------------- */
/* Payments                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Apple Pay / Google Pay / card are payment METHOD TYPES, not providers. They
 * all resolve to one provider intent. `test` only exists for the fake provider.
 */
export const PaymentMethodTypeValues = ['apple_pay', 'google_pay', 'card', 'test'] as const;
export const PaymentMethodTypeSchema = z.enum(PaymentMethodTypeValues);
export type PaymentMethodType = z.infer<typeof PaymentMethodTypeSchema>;

export const PaymentProviderNameValues = ['stripe', 'fake'] as const;
export const PaymentProviderNameSchema = z.enum(PaymentProviderNameValues);
export type PaymentProviderName = z.infer<typeof PaymentProviderNameSchema>;

export const PaymentIntentStatusValues = [
  'requires_payment_method',
  'requires_confirmation',
  'processing',
  'succeeded',
  'canceled',
  'failed',
] as const;
export const PaymentIntentStatusSchema = z.enum(PaymentIntentStatusValues);
export type PaymentIntentStatus = z.infer<typeof PaymentIntentStatusSchema>;

/** What we persist about a payment. Note the absence of anything card-shaped. */
export const PaymentRefSchema = z.object({
  provider: PaymentProviderNameSchema,
  intentId: z.string().min(1).max(128),
  status: PaymentIntentStatusSchema,
  methodType: PaymentMethodTypeSchema,
  amount: NonNegativeMoneySchema,
  /** Provider's brand/last4 display string, if the provider chooses to give one. */
  displayLabel: z.string().max(64).nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  failureCode: z.string().max(64).nullable().default(null),
});
export type PaymentRef = z.infer<typeof PaymentRefSchema>;

export const CreatePaymentIntentRequestSchema = withIdempotency(
  z.object({
    methodType: PaymentMethodTypeSchema,
    /** Provider-side token produced by the client SDK. Never card data. */
    paymentMethodToken: z.string().min(1).max(256).optional(),
    returnUrl: z.url().max(512).optional(),
  }),
);
export type CreatePaymentIntentRequest = z.infer<typeof CreatePaymentIntentRequestSchema>;

/** The one place a provider client secret is allowed: the response, never storage. */
export const PaymentIntentResponseSchema = z.object({
  payment: PaymentRefSchema,
  clientSecret: z.string().nullable(),
  publishableKeyHint: z.string().nullable(),
});
export type PaymentIntentResponse = z.infer<typeof PaymentIntentResponseSchema>;

export const ConfirmPaymentRequestSchema = withIdempotency(
  z.object({
    paymentMethodToken: z.string().min(1).max(256).optional(),
  }),
);
export type ConfirmPaymentRequest = z.infer<typeof ConfirmPaymentRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Orders & the fulfillment state machine                                      */
/* -------------------------------------------------------------------------- */

export const OrderStatusValues = [
  'created',
  'awaiting_payment',
  'payment_failed',
  'paid',
  'in_production',
  'packed',
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
  'partially_refunded',
] as const;
export const OrderStatusSchema = z.enum(OrderStatusValues);
export type OrderStatus = z.infer<typeof OrderStatusSchema>;

/**
 * The single source of truth for order legality. Both the API and any admin
 * tooling must go through `canTransitionOrder`.
 *
 *   created → awaiting_payment → paid → in_production → packed → shipped → delivered
 *                 ↘ payment_failed ↗                     ↘ cancelled (pre-ship)
 *   paid/…/delivered → refunded | partially_refunded
 */
export const ORDER_TRANSITIONS: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = Object.freeze({
  created: ['awaiting_payment', 'cancelled'],
  awaiting_payment: ['paid', 'payment_failed', 'cancelled'],
  payment_failed: ['awaiting_payment', 'cancelled'],
  paid: ['in_production', 'cancelled', 'refunded', 'partially_refunded'],
  in_production: ['packed', 'cancelled', 'refunded', 'partially_refunded'],
  packed: ['shipped', 'cancelled', 'refunded', 'partially_refunded'],
  shipped: ['delivered', 'refunded', 'partially_refunded'],
  delivered: ['refunded', 'partially_refunded'],
  cancelled: ['refunded'],
  refunded: [],
  partially_refunded: ['refunded'],
});

export function canTransitionOrder(from: OrderStatus, to: OrderStatus): boolean {
  return ORDER_TRANSITIONS[from].includes(to);
}

/** Statuses after which the physical goods are gone and cancellation is out. */
export const NON_CANCELLABLE_STATUSES: readonly OrderStatus[] = [
  'shipped',
  'delivered',
  'cancelled',
  'refunded',
];

export const OrderLineSchema = z.object({
  id: IdSchema,
  productId: IdSchema,
  variantId: IdSchema,
  sku: z.string().max(64),
  name: z.string().max(160),
  quantity: PositiveIntSchema.max(20),
  unitPrice: NonNegativeMoneySchema,
  lineSubtotal: NonNegativeMoneySchema,
  sandwichId: IdSchema.nullable().default(null),
});
export type OrderLine = z.infer<typeof OrderLineSchema>;

export const OrderStatusEventSchema = z.object({
  from: OrderStatusSchema.nullable(),
  to: OrderStatusSchema,
  at: TimestampSchema,
  actor: z.enum(['customer', 'system', 'operator', 'payment_webhook']),
  note: z.string().max(200).default(''),
});
export type OrderStatusEvent = z.infer<typeof OrderStatusEventSchema>;

export const RefundReasonValues = [
  'requested_by_customer',
  'damaged_in_transit',
  'melted',
  'never_arrived',
  'duplicate',
  'fraudulent',
  'goodwill',
] as const;
export const RefundReasonSchema = z.enum(RefundReasonValues);

export const RefundStateValues = ['requested', 'pending', 'succeeded', 'failed'] as const;
export const RefundStateSchema = z.enum(RefundStateValues);
export type RefundState = z.infer<typeof RefundStateSchema>;

export const REFUND_TRANSITIONS: Readonly<Record<RefundState, readonly RefundState[]>> = Object.freeze({
  requested: ['pending', 'failed'],
  pending: ['succeeded', 'failed'],
  succeeded: [],
  failed: ['requested'],
});

export function canTransitionRefund(from: RefundState, to: RefundState): boolean {
  return REFUND_TRANSITIONS[from].includes(to);
}

export const RefundSchema = z.object({
  id: IdSchema,
  orderId: IdSchema,
  amount: NonNegativeMoneySchema,
  reason: RefundReasonSchema,
  state: RefundStateSchema,
  providerRefundId: z.string().max(128).nullable().default(null),
  requestedBy: z.enum(['customer', 'operator', 'system']),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  failureCode: z.string().max(64).nullable().default(null),
  idempotencyKey: z.string().max(200),
});
export type Refund = z.infer<typeof RefundSchema>;

export const CancellationSchema = z.object({
  requestedAt: TimestampSchema,
  requestedBy: z.enum(['customer', 'operator', 'system']),
  reason: z.string().max(200),
  restocked: z.boolean().default(false),
});
export type Cancellation = z.infer<typeof CancellationSchema>;

export const FulfillmentSchema = z.object({
  carrier: z.string().max(64).nullable().default(null),
  service: z.string().max(64).nullable().default(null),
  trackingNumber: z.string().max(64).nullable().default(null),
  coldChainPackId: z.string().max(64).nullable().default(null),
  producedAt: TimestampSchema.nullable().default(null),
  packedAt: TimestampSchema.nullable().default(null),
  shippedAt: TimestampSchema.nullable().default(null),
  deliveredAt: TimestampSchema.nullable().default(null),
  estimatedDeliveryAt: TimestampSchema.nullable().default(null),
});
export type Fulfillment = z.infer<typeof FulfillmentSchema>;

export const OrderSchema = z.object({
  id: IdSchema,
  /** Short human-quotable reference, e.g. `SM-7K3Q9F`. */
  reference: z.string().regex(/^SM-[A-Z0-9]{6}$/),
  accountId: IdSchema,
  cartId: IdSchema,
  currency: CurrencySchema,
  status: OrderStatusSchema,
  statusHistory: z.array(OrderStatusEventSchema).max(100),
  lines: z.array(OrderLineSchema).min(1).max(20),
  subtotal: NonNegativeMoneySchema,
  discountTotal: NonNegativeMoneySchema,
  tax: TaxQuoteSchema,
  shipping: ShippingQuoteSchema,
  total: NonNegativeMoneySchema,
  refundedTotal: NonNegativeMoneySchema,
  shippingAddress: AddressSchema,
  email: z.email().max(320).nullable().default(null),
  payment: PaymentRefSchema.nullable().default(null),
  appliedPromotionCodes: z.array(z.string().max(64)).max(4).default([]),
  redeemedRewardGrantIds: z.array(IdSchema).max(4).default([]),
  fulfillment: FulfillmentSchema,
  refunds: z.array(RefundSchema).max(20).default([]),
  cancellation: CancellationSchema.nullable().default(null),
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
  idempotencyKey: z.string().max(200),
  schemaVersion: SemVerSchema,
});
export type Order = z.infer<typeof OrderSchema>;

export const CreateOrderRequestSchema = withIdempotency(
  z.object({
    cartId: IdSchema,
    shippingAddress: AddressSchema,
    email: z.email().max(320).optional(),
    /** Must match the quote the customer was shown, or we re-quote and 409. */
    expectedTotal: NonNegativeMoneySchema.optional(),
  }),
);
export type CreateOrderRequest = z.infer<typeof CreateOrderRequestSchema>;

export const TransitionOrderRequestSchema = withIdempotency(
  z.object({
    to: OrderStatusSchema,
    note: z.string().max(200).default(''),
    tracking: z
      .object({
        carrier: z.string().max(64),
        service: z.string().max(64),
        trackingNumber: z.string().max(64),
      })
      .optional(),
  }),
);
export type TransitionOrderRequest = z.infer<typeof TransitionOrderRequestSchema>;

export const CreateRefundRequestSchema = withIdempotency(
  z.object({
    /** Omit for a full refund of the remaining refundable amount. */
    amountMinor: NonNegativeIntSchema.optional(),
    reason: RefundReasonSchema.default('requested_by_customer'),
  }),
);
export type CreateRefundRequest = z.infer<typeof CreateRefundRequestSchema>;

export const CancelOrderRequestSchema = withIdempotency(
  z.object({ reason: z.string().min(1).max(200) }),
);
export type CancelOrderRequest = z.infer<typeof CancelOrderRequestSchema>;

/* -------------------------------------------------------------------------- */
/* Webhooks                                                                    */
/* -------------------------------------------------------------------------- */

export const PaymentWebhookEventTypeValues = [
  'payment_intent.succeeded',
  'payment_intent.payment_failed',
  'payment_intent.canceled',
  'charge.refunded',
] as const;
export const PaymentWebhookEventTypeSchema = z.enum(PaymentWebhookEventTypeValues);
export type PaymentWebhookEventType = z.infer<typeof PaymentWebhookEventTypeSchema>;

export const PaymentWebhookEventSchema = z.object({
  id: z.string().min(1).max(128),
  type: PaymentWebhookEventTypeSchema,
  provider: PaymentProviderNameSchema,
  intentId: z.string().min(1).max(128),
  amountMinor: NonNegativeIntSchema,
  currency: CurrencySchema,
  occurredAt: TimestampSchema,
  failureCode: z.string().max(64).nullable().default(null),
  refundId: z.string().max(128).nullable().default(null),
});
export type PaymentWebhookEvent = z.infer<typeof PaymentWebhookEventSchema>;

/* -------------------------------------------------------------------------- */
/* Idempotency records                                                         */
/* -------------------------------------------------------------------------- */

export const IdempotencyStateValues = ['in_progress', 'completed'] as const;
export const IdempotencyStateSchema = z.enum(IdempotencyStateValues);

export const IdempotencyRecordSchema = z.object({
  key: z.string().max(200),
  accountId: IdSchema,
  endpoint: z.string().max(200),
  requestHash: z.string().length(64),
  state: IdempotencyStateSchema,
  statusCode: z.number().int().min(100).max(599).nullable(),
  responseBody: z.string().nullable(),
  createdAt: TimestampSchema,
  completedAt: TimestampSchema.nullable(),
  expiresAt: TimestampSchema,
});
export type IdempotencyRecord = z.infer<typeof IdempotencyRecordSchema>;
