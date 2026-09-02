import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentIntentStatus, PaymentMethodType, PaymentWebhookEvent } from '@somemore/protocol';
import type { ApiConfig } from '../config.js';
import type { Clock } from '../clock.js';
import { ApiError } from '../errors.js';
import type { Logger } from '../logging.js';
import type {
  ConfirmIntentInput,
  CreateIntentInput,
  PaymentProvider,
  ProviderIntent,
  ProviderRefund,
  RefundInput,
  WebhookVerification,
} from './types.js';

/*
 * Stripe adapter.
 *
 * Structured against Stripe's real REST shape (form-encoded bodies, `Bearer`
 * secret key, `Idempotency-Key` header, `t=,v1=` webhook signatures) but it has
 * never been run against live credentials — no Stripe account exists for this
 * project yet. See README "Blockers".
 *
 * Method types map onto Stripe as follows:
 *   apple_pay / google_pay -> automatic_payment_methods, wallet chosen client-side
 *   card                   -> automatic_payment_methods with card enabled
 * They are NOT separate providers, and no card data ever passes through here.
 */

/** Stripe's `PaymentIntent.status` values, mapped onto our protocol's. */
const INTENT_STATUS_MAP: Readonly<Record<string, PaymentIntentStatus>> = {
  requires_payment_method: 'requires_payment_method',
  requires_confirmation: 'requires_confirmation',
  requires_action: 'requires_confirmation',
  requires_capture: 'processing',
  processing: 'processing',
  succeeded: 'succeeded',
  canceled: 'canceled',
};

const REFUND_STATUS_MAP: Readonly<Record<string, ProviderRefund['status']>> = {
  pending: 'pending',
  requires_action: 'pending',
  succeeded: 'succeeded',
  failed: 'failed',
  canceled: 'failed',
};

const WEBHOOK_TYPE_MAP: Readonly<Record<string, PaymentWebhookEvent['type']>> = {
  'payment_intent.succeeded': 'payment_intent.succeeded',
  'payment_intent.payment_failed': 'payment_intent.payment_failed',
  'payment_intent.canceled': 'payment_intent.canceled',
  'charge.refunded': 'charge.refunded',
};

interface StripePaymentIntentResponse {
  id: string;
  object: string;
  amount: number;
  currency: string;
  status: string;
  client_secret?: string | null;
  last_payment_error?: { code?: string; decline_code?: string } | null;
  payment_method_types?: string[];
  charges?: { data?: Array<{ payment_method_details?: { card?: { brand?: string; last4?: string } } }> };
}

interface StripeRefundResponse {
  id: string;
  amount: number;
  currency: string;
  status: string;
  failure_reason?: string | null;
}

interface StripeErrorResponse {
  error?: { type?: string; code?: string; message?: string; decline_code?: string };
}

export interface StripeProviderDeps {
  readonly config: ApiConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Injectable for tests; defaults to global fetch. */
  readonly fetchImpl?: typeof fetch;
  /** Tolerance for webhook timestamp skew, in seconds. */
  readonly webhookToleranceSeconds?: number;
}

export function createStripePaymentProvider(deps: StripeProviderDeps): PaymentProvider {
  const { config, clock, logger } = deps;
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const tolerance = deps.webhookToleranceSeconds ?? 300;

  function requireKey(): string {
    if (config.stripeSecretKey === null) {
      throw new ApiError(
        'payment_provider_not_configured',
        'Stripe is not configured: STRIPE_SECRET_KEY is absent. Set it, or run with PAYMENT_PROVIDER=fake.',
      );
    }
    return config.stripeSecretKey;
  }

  async function call<T>(path: string, form: Record<string, string>, idempotencyKey: string): Promise<T> {
    const secret = requireKey();
    const body = new URLSearchParams(form).toString();
    let response: Response;
    try {
      response = await doFetch(`${config.stripeApiBase}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${secret}`,
          'content-type': 'application/x-www-form-urlencoded',
          'idempotency-key': idempotencyKey,
          'stripe-version': '2024-06-20',
        },
        body,
      });
    } catch (cause) {
      logger.error('stripe.request_failed', { path, error: String(cause) });
      throw new ApiError('payment_failed', 'Could not reach the payment provider.', { cause });
    }
    const text = await response.text();
    let parsed: unknown;
    try {
      parsed = text.length > 0 ? JSON.parse(text) : {};
    } catch {
      throw new ApiError('payment_failed', 'Payment provider returned an unreadable response.');
    }
    if (!response.ok) {
      const err = (parsed as StripeErrorResponse).error;
      logger.warn('stripe.error', { path, status: response.status, code: err?.code });
      throw new ApiError('payment_failed', err?.message ?? `Payment provider error (${response.status}).`, {
        details: { code: err?.code ?? null, declineCode: err?.decline_code ?? null },
      });
    }
    return parsed as T;
  }

  function toProviderIntent(raw: StripePaymentIntentResponse, methodType: PaymentMethodType): ProviderIntent {
    const card = raw.charges?.data?.[0]?.payment_method_details?.card;
    return {
      provider: 'stripe',
      intentId: raw.id,
      status: INTENT_STATUS_MAP[raw.status] ?? 'processing',
      amount: { currency: raw.currency.toUpperCase(), amountMinor: raw.amount },
      methodType,
      clientSecret: raw.client_secret ?? null,
      displayLabel:
        card?.brand !== undefined && card.last4 !== undefined ? `${card.brand} ${card.last4}` : null,
      failureCode: raw.last_payment_error?.decline_code ?? raw.last_payment_error?.code ?? null,
    };
  }

  return {
    name: 'stripe',

    isConfigured: () => config.stripeSecretKey !== null,

    async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
      const form: Record<string, string> = {
        amount: String(input.amount.amountMinor),
        currency: input.amount.currency.toLowerCase(),
        description: input.description,
        'metadata[order_id]': input.orderId,
        'metadata[account_id]': input.accountId,
        'metadata[method_type]': input.methodType,
        'automatic_payment_methods[enabled]': 'true',
      };
      if (input.paymentMethodToken !== undefined) {
        form['payment_method'] = input.paymentMethodToken;
        form['confirm'] = 'false';
      }
      if (input.returnUrl !== undefined) form['return_url'] = input.returnUrl;
      const raw = await call<StripePaymentIntentResponse>('/v1/payment_intents', form, input.idempotencyKey);
      return toProviderIntent(raw, input.methodType);
    },

    async confirmIntent(input: ConfirmIntentInput): Promise<ProviderIntent> {
      const form: Record<string, string> = {};
      if (input.paymentMethodToken !== undefined) form['payment_method'] = input.paymentMethodToken;
      const raw = await call<StripePaymentIntentResponse>(
        `/v1/payment_intents/${encodeURIComponent(input.intentId)}/confirm`,
        form,
        input.idempotencyKey,
      );
      const methodType = (raw.payment_method_types?.[0] === 'card' ? 'card' : 'card') as PaymentMethodType;
      return toProviderIntent(raw, methodType);
    },

    async refund(input: RefundInput): Promise<ProviderRefund> {
      const raw = await call<StripeRefundResponse>(
        '/v1/refunds',
        {
          payment_intent: input.intentId,
          amount: String(input.amount.amountMinor),
          'metadata[reason]': input.reason,
        },
        input.idempotencyKey,
      );
      return {
        provider: 'stripe',
        refundId: raw.id,
        status: REFUND_STATUS_MAP[raw.status] ?? 'pending',
        amount: { currency: raw.currency.toUpperCase(), amountMinor: raw.amount },
        failureCode: raw.failure_reason ?? null,
      };
    },

    /**
     * Implements Stripe's signature scheme: header `t=<unix>,v1=<hex hmac>`
     * over `${timestamp}.${rawBody}` keyed by the endpoint's webhook secret.
     */
    verifyWebhook(rawBody, headers): WebhookVerification {
      if (config.stripeWebhookSecret === null) {
        return { verified: false, reason: 'webhook_secret_not_configured' };
      }
      const header = headers['stripe-signature'];
      if (header === undefined) return { verified: false, reason: 'missing_signature' };

      let timestamp: string | undefined;
      const candidates: string[] = [];
      for (const piece of header.split(',')) {
        const [key = '', value = ''] = piece.split('=');
        if (key.trim() === 't') timestamp = value.trim();
        if (key.trim() === 'v1') candidates.push(value.trim());
      }
      if (timestamp === undefined || candidates.length === 0) {
        return { verified: false, reason: 'malformed_signature' };
      }
      const age = Math.abs(Math.floor(clock.now().getTime() / 1000) - Number(timestamp));
      if (!Number.isFinite(age) || age > tolerance) return { verified: false, reason: 'timestamp_out_of_tolerance' };

      const expected = createHmac('sha256', config.stripeWebhookSecret)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const matched = candidates.some((candidate) => {
        const a = Buffer.from(expected, 'utf8');
        const b = Buffer.from(candidate, 'utf8');
        return a.length === b.length && timingSafeEqual(a, b);
      });
      if (!matched) return { verified: false, reason: 'signature_mismatch' };

      let parsed: { id?: string; type?: string; created?: number; data?: { object?: Record<string, unknown> } };
      try {
        parsed = JSON.parse(rawBody) as typeof parsed;
      } catch {
        return { verified: false, reason: 'invalid_json' };
      }
      const mapped = parsed.type === undefined ? undefined : WEBHOOK_TYPE_MAP[parsed.type];
      if (mapped === undefined) return { verified: true, reason: 'ignored_event_type' };

      const object = parsed.data?.object ?? {};
      const intentId =
        typeof object['payment_intent'] === 'string'
          ? object['payment_intent']
          : typeof object['id'] === 'string'
            ? object['id']
            : '';
      if (intentId === '') return { verified: true, reason: 'event_without_intent' };

      const lastError = object['last_payment_error'] as { code?: string; decline_code?: string } | undefined;
      return {
        verified: true,
        event: {
          id: parsed.id ?? 'evt_unknown',
          type: mapped,
          provider: 'stripe',
          intentId,
          amountMinor: typeof object['amount'] === 'number' ? object['amount'] : 0,
          currency: typeof object['currency'] === 'string' ? object['currency'].toUpperCase() : 'USD',
          occurredAt: new Date((parsed.created ?? Math.floor(clock.now().getTime() / 1000)) * 1000).toISOString(),
          failureCode: lastError?.decline_code ?? lastError?.code ?? null,
          refundId: typeof object['refund'] === 'string' ? object['refund'] : null,
        },
      };
    },
  };
}
