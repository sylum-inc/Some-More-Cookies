import { checkSchemaCompatibility, type EventBatch, type EventBatchResult, type IngestedEvent } from '@somemore/protocol';
import { ApiError } from '../errors.js';
import type { DomainDeps } from './types.js';

/**
 * Telemetry ingest. Events are named, bounded and de-duplicated by client-minted
 * id so a retried batch is free. Events are stamped with the authenticated
 * account when there is one — a client cannot attribute events to someone else.
 */
export interface AnalyticsService {
  ingest(accountId: string | null, batch: EventBatch, origin: { clientIp: string }): Promise<EventBatchResult>;
  recentEvents(limit?: number): Promise<IngestedEvent[]>;
}

export function createAnalyticsService(deps: DomainDeps): AnalyticsService {
  const { repos, clock, config, logger, rateLimiter } = deps;

  return {
    async ingest(accountId, batch, origin) {
      /*
       * This route is `auth: 'optional'` because telemetry starts before an
       * account does, and it writes a row per event — so an open door plus a
       * hundred events a request is unbounded storage growth for anyone with
       * curl. Metered by address rather than by account for exactly the reason
       * it is open: the caller may not have one.
       *
       * The address is only trustworthy because of `TRUSTED_PROXY_HOPS`; the
       * limiter is in-process (README Blocker 11), so a second instance
       * doubles this number.
       */
      const decision = rateLimiter.consume(`events:${origin.clientIp}`, config.eventBatchesPerHour, 3600);
      if (!decision.allowed) {
        logger.warn('analytics.ingest_velocity', { accountId, count: decision.count });
        throw new ApiError('rate_limited', 'Too much telemetry from here at once.', {
          headers: {
            'retry-after': String(Math.max(1, Math.ceil((decision.resetAt.getTime() - clock.now().getTime()) / 1000))),
          },
        });
      }
      const receivedAt = clock.isoNow();
      const events: IngestedEvent[] = [];
      for (const event of batch.events) {
        const compatibility = checkSchemaCompatibility(event.schemaVersion);
        if (!compatibility.compatible) {
          throw new ApiError('schema_version_unsupported', `Event schema version ${event.schemaVersion} is not supported.`, {
            details: { reason: compatibility.reason ?? null },
          });
        }
        events.push({
          ...event,
          // Never trust a client-declared account id.
          accountId: accountId ?? null,
          receivedAt,
          remappedFromAccountId: null,
        });
      }
      return repos.analytics.append(events);
    },

    async recentEvents(limit = 50) {
      return repos.analytics.list(limit);
    },
  };
}
