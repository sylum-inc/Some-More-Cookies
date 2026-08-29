import { checkSchemaCompatibility, type EventBatch, type EventBatchResult, type IngestedEvent } from '@somemore/protocol';
import { ApiError } from '../errors.js';
import type { DomainDeps } from './types.js';

/**
 * Telemetry ingest. Events are named, bounded and de-duplicated by client-minted
 * id so a retried batch is free. Events are stamped with the authenticated
 * account when there is one — a client cannot attribute events to someone else.
 */
export interface AnalyticsService {
  ingest(accountId: string | null, batch: EventBatch): Promise<EventBatchResult>;
  recentEvents(limit?: number): Promise<IngestedEvent[]>;
}

export function createAnalyticsService(deps: DomainDeps): AnalyticsService {
  const { repos, clock } = deps;

  return {
    async ingest(accountId, batch) {
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
