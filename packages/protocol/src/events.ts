import { z } from 'zod';
import {
  IdSchema,
  JsonValueSchema,
  PlatformSchema,
  SemVerSchema,
  TimestampSchema,
} from './common.js';

/**
 * Telemetry is deliberately small and named. Analytics never carries PII: no
 * emails, no addresses, no free text from players. Anything unbounded belongs
 * in a moderation report, not an event.
 */
export const EventNameValues = [
  'app_opened',
  'account_bootstrapped',
  'identity_linked',
  'campsite_created',
  'campsite_joined',
  'session_started',
  'session_ended',
  'marshmallow_roast_started',
  'marshmallow_roast_completed',
  'marshmallow_ignited',
  'smore_assembled',
  'machine_run_started',
  'machine_run_completed',
  'sandwich_saved',
  'sandwich_photographed',
  'sandwich_shared',
  'sandwich_eaten',
  'trace_left',
  'landmark_promoted',
  'reward_claimed',
  'shop_viewed',
  'cart_item_added',
  'checkout_started',
  'order_placed',
  'order_delivered',
  'accessibility_setting_changed',
  'error_surfaced',
] as const;
export const EventNameSchema = z.enum(EventNameValues);
export type EventName = z.infer<typeof EventNameSchema>;

export const AnalyticsEventSchema = z.object({
  /** Client-generated so a retried batch de-duplicates server-side. */
  id: IdSchema,
  name: EventNameSchema,
  occurredAt: TimestampSchema,
  accountId: IdSchema.nullable().default(null),
  sessionId: IdSchema.nullable().default(null),
  campsiteId: IdSchema.nullable().default(null),
  platform: PlatformSchema,
  appVersion: SemVerSchema,
  schemaVersion: SemVerSchema,
  props: z.record(z.string().max(40), JsonValueSchema).default({}),
});
export type AnalyticsEvent = z.infer<typeof AnalyticsEventSchema>;

export const IngestedEventSchema = AnalyticsEventSchema.extend({
  receivedAt: TimestampSchema,
  /** Set for events that arrived after the account they name was merged away. */
  remappedFromAccountId: IdSchema.nullable().default(null),
});
export type IngestedEvent = z.infer<typeof IngestedEventSchema>;

export const EventBatchSchema = z.object({
  events: z.array(AnalyticsEventSchema).min(1).max(100),
});
export type EventBatch = z.infer<typeof EventBatchSchema>;

export const EventBatchResultSchema = z.object({
  accepted: z.number().int().min(0),
  duplicates: z.number().int().min(0),
});
export type EventBatchResult = z.infer<typeof EventBatchResultSchema>;
