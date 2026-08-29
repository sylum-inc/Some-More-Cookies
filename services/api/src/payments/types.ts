import type {
  Money,
  PaymentIntentStatus,
  PaymentMethodType,
  PaymentProviderName,
  PaymentWebhookEvent,
} from '@somemore/protocol';

export interface CreateIntentInput {
  readonly orderId: string;
  readonly accountId: string;
  readonly amount: Money;
  readonly methodType: PaymentMethodType;
  readonly paymentMethodToken?: string | undefined;
  readonly returnUrl?: string | undefined;
  readonly description: string;
  /** Forwarded to the provider so a retried checkout never double-charges. */
  readonly idempotencyKey: string;
}

export interface ProviderIntent {
  readonly provider: PaymentProviderName;
  readonly intentId: string;
  readonly status: PaymentIntentStatus;
  readonly amount: Money;
  readonly methodType: PaymentMethodType;
  /** Returned to the client for SDK confirmation; NEVER persisted. */
  readonly clientSecret: string | null;
  readonly displayLabel: string | null;
  readonly failureCode: string | null;
}

export interface ConfirmIntentInput {
  readonly intentId: string;
  readonly paymentMethodToken?: string | undefined;
  readonly idempotencyKey: string;
}

export interface RefundInput {
  readonly intentId: string;
  readonly amount: Money;
  readonly reason: string;
  readonly idempotencyKey: string;
}

export interface ProviderRefund {
  readonly provider: PaymentProviderName;
  readonly refundId: string;
  readonly status: 'pending' | 'succeeded' | 'failed';
  readonly amount: Money;
  readonly failureCode: string | null;
}

export interface WebhookVerification {
  readonly verified: boolean;
  readonly reason?: string;
  readonly event?: PaymentWebhookEvent;
}

/**
 * The single seam between the commerce domain and any real money movement.
 *
 * Apple Pay, Google Pay and card are METHOD TYPES that all flow through one
 * provider — they are not separate providers. Implementations must never accept
 * or return raw card data; a provider token or intent id is the most sensitive
 * value allowed to cross this interface.
 */
export interface PaymentProvider {
  readonly name: PaymentProviderName;
  /** False when credentials are missing; the API then answers 503, not 500. */
  isConfigured(): boolean;
  createIntent(input: CreateIntentInput): Promise<ProviderIntent>;
  confirmIntent(input: ConfirmIntentInput): Promise<ProviderIntent>;
  refund(input: RefundInput): Promise<ProviderRefund>;
  verifyWebhook(rawBody: string, headers: Readonly<Record<string, string>>): WebhookVerification;
}
