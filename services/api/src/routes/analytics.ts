import { EventBatchSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** analytics domain: bounded, named, de-duplicated telemetry. */
export function analyticsRoutes(services: ServiceRegistry): AnyRoute[] {
  const { analytics } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/events',
      auth: 'optional',
      summary: 'Ingest a batch of telemetry events.',
      body: EventBatchSchema,
      async handle(ctx) {
        const result = await analytics.ingest(ctx.auth?.accountId ?? null, ctx.body);
        return { status: 202, body: result };
      },
    }),
  ];
}
