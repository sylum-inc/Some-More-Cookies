import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { PaymentIntentStatus, PaymentMethodType, PaymentWebhookEvent } from '@somemore/protocol';
import type { Clock } from '../clock.js';
import type {
  ConfirmIntentInput,
  CreateIntentInput,
  PaymentProvider,
  ProviderIntent,
  ProviderRefund,
  RefundInput,
  WebhookVerification,
} from './types.js';

export interface FakePaymentProviderOptions {
  readonly clock: Clock;
  /** Shared secret used to sign webhooks in dev/tests. */
  readonly webhookSecret?: string;
  /**
   * Amounts (in minor units) that must fail on confirm, so the failure path is
   * exercisable end to end without touching a real provider.
   */
  readonly declineAmounts?: readonly number[];
}

interface FakeIntent {
  intentId: string;
  orderId: string;
  status: PaymentIntentStatus;
  amountMinor: number;
  currency: string;
  methodType: PaymentMethodType;
  clientSecret: string;
  refundedMinor: number;
}

export interface FakePaymentProvider extends PaymentProvider {
  /** Test helper: sign a webhook body the way the provider would. */
  signWebhook(rawBody: string): Record<string, string>;
  getIntent(intentId: string): { status: PaymentIntentStatus; amountMinor: number } | null;
}

export const FAKE_DECLINE_AMOUNT_MINOR = 66_666;

/**
 * Deterministic in-process payment provider for local dev and tests. It models
 * the same state machine as Stripe: an intent is created, confirmed, and may be
 * refunded; webhooks are signed with a shared secret in the same
 * `t=<ts>,v1=<hmac>` scheme so webhook handling is genuinely tested.
 */
export function createFakePaymentProvider(options: FakePaymentProviderOptions): FakePaymentProvider {
  const { clock } = options;
  const secret = options.webhookSecret ?? 'whsec_fake_dev_secret';
  const declines = new Set<number>([FAKE_DECLINE_AMOUNT_MINOR, ...(options.declineAmounts ?? [])]);
  const intents = new Map<string, FakeIntent>();
  const byIdempotencyKey = new Map<string, string>();

  function toProviderIntent(intent: FakeIntent, failureCode: string | null = null): ProviderIntent {
    return {
      provider: 'fake',
      intentId: intent.intentId,
      status: intent.status,
      amount: { currency: intent.currency, amountMinor: intent.amountMinor },
      methodType: intent.methodType,
      clientSecret: intent.clientSecret,
      displayLabel: intent.methodType === 'card' ? 'Fake •••• 4242' : 'Fake wallet',
      failureCode,
    };
  }

  return {
    name: 'fake',
    isConfigured: () => true,

    async createIntent(input: CreateIntentInput): Promise<ProviderIntent> {
      const existingId = byIdempotencyKey.get(input.idempotencyKey);
      const existing = existingId === undefined ? undefined : intents.get(existingId);
      if (existing !== undefined) return toProviderIntent(existing);

      const intentId = `pi_fake_${randomUUID().replace(/-/g, '').slice(0, 20)}`;
      const intent: FakeIntent = {
        intentId,
        orderId: input.orderId,
        status: input.paymentMethodToken === undefined ? 'requires_payment_method' : 'requires_confirmation',
        amountMinor: input.amount.amountMinor,
        currency: input.amount.currency,
        methodType: input.methodType,
        clientSecret: `${intentId}_secret_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        refundedMinor: 0,
      };
      intents.set(intentId, intent);
      byIdempotencyKey.set(input.idempotencyKey, intentId);
      return toProviderIntent(intent);
    },

    async confirmIntent(input: ConfirmIntentInput): Promise<ProviderIntent> {
      const intent = intents.get(input.intentId);
      if (intent === undefined) {
        return {
          provider: 'fake',
          intentId: input.intentId,
          status: 'failed',
          amount: { currency: 'USD', amountMinor: 0 },
          methodType: 'test',
          clientSecret: null,
          displayLabel: null,
          failureCode: 'intent_not_found',
        };
      }
      if (intent.status === 'succeeded') return toProviderIntent(intent);
      if (declines.has(intent.amountMinor)) {
        intent.status = 'failed';
        return toProviderIntent(intent, 'card_declined');
      }
      intent.status = 'succeeded';
      return toProviderIntent(intent);
    },

    async refund(input: RefundInput): Promise<ProviderRefund> {
      const intent = intents.get(input.intentId);
      if (intent === undefined || intent.status !== 'succeeded') {
        return {
          provider: 'fake',
          refundId: `re_fake_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          status: 'failed',
          amount: input.amount,
          failureCode: 'charge_not_refundable',
        };
      }
      if (intent.refundedMinor + input.amount.amountMinor > intent.amountMinor) {
        return {
          provider: 'fake',
          refundId: `re_fake_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
          status: 'failed',
          amount: input.amount,
          failureCode: 'refund_exceeds_charge',
        };
      }
      intent.refundedMinor += input.amount.amountMinor;
      return {
        provider: 'fake',
        refundId: `re_fake_${randomUUID().replace(/-/g, '').slice(0, 16)}`,
        status: 'succeeded',
        amount: input.amount,
        failureCode: null,
      };
    },

    signWebhook(rawBody: string) {
      const timestamp = Math.floor(clock.now().getTime() / 1000);
      const mac = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
      return { 'x-somemore-signature': `t=${timestamp},v1=${mac}` };
    },

    verifyWebhook(rawBody, headers): WebhookVerification {
      const header = headers['x-somemore-signature'];
      if (header === undefined) return { verified: false, reason: 'missing_signature' };
      const parts = Object.fromEntries(
        header.split(',').map((piece) => {
          const [k = '', v = ''] = piece.split('=');
          return [k.trim(), v.trim()];
        }),
      );
      const timestamp = parts['t'];
      const provided = parts['v1'];
      if (timestamp === undefined || provided === undefined) return { verified: false, reason: 'malformed_signature' };
      const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
      const a = Buffer.from(expected, 'utf8');
      const b = Buffer.from(provided, 'utf8');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return { verified: false, reason: 'signature_mismatch' };

      let parsed: unknown;
      try {
        parsed = JSON.parse(rawBody);
      } catch {
        return { verified: false, reason: 'invalid_json' };
      }
      const event = parsed as Partial<PaymentWebhookEvent>;
      if (typeof event.type !== 'string' || typeof event.intentId !== 'string') {
        return { verified: false, reason: 'unrecognized_event' };
      }
      const intent = intents.get(event.intentId);
      if (intent !== undefined && event.type === 'payment_intent.succeeded') intent.status = 'succeeded';
      if (intent !== undefined && event.type === 'payment_intent.payment_failed') intent.status = 'failed';
      return {
        verified: true,
        event: {
          id: event.id ?? `evt_fake_${randomUUID().slice(0, 8)}`,
          type: event.type as PaymentWebhookEvent['type'],
          provider: 'fake',
          intentId: event.intentId,
          amountMinor: event.amountMinor ?? intent?.amountMinor ?? 0,
          currency: event.currency ?? intent?.currency ?? 'USD',
          occurredAt: event.occurredAt ?? clock.isoNow(),
          failureCode: event.failureCode ?? null,
          refundId: event.refundId ?? null,
        },
      };
    },

    getIntent(intentId) {
      const intent = intents.get(intentId);
      return intent === undefined ? null : { status: intent.status, amountMinor: intent.amountMinor };
    },
  };
}
