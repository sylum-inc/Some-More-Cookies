import { z } from 'zod';
import { SCHEMA_VERSION, API_VERSION, SCHEMA_MAJOR } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

export function healthRoutes(services: ServiceRegistry): AnyRoute[] {
  return [
    defineRoute({
      method: 'GET',
      path: '/health',
      auth: 'none',
      summary: 'Liveness probe.',
      /*
       * Liveness *and* the one dependency this process cannot fake its way
       * around. The body says whether storage is reachable and how busy the
       * pool is; it never says where the database is, who connects to it, or
       * what the driver's complaint was. A probe endpoint is public, and a DSN
       * in a 503 body is how connection strings end up in screenshots.
       */
      handle: async () => {
        const database = services.database;
        if (database === null) {
          return {
            status: 200,
            body: {
              ok: true,
              schemaVersion: SCHEMA_VERSION,
              persistence: 'memory' as const,
              database: { configured: false },
            },
          };
        }
        const health = await database.health();
        return {
          status: health.reachable && health.error === null ? 200 : 503,
          body: {
            ok: health.reachable && health.error === null,
            schemaVersion: SCHEMA_VERSION,
            persistence: 'postgres' as const,
            database: {
              configured: true,
              reachable: health.reachable,
              latencyMs: health.latencyMs,
              error: health.error,
              pool: health.pool,
            },
          },
        };
      },
    }),
    defineRoute({
      method: 'GET',
      path: '/v1/meta',
      auth: 'none',
      summary: 'Contract version and the capabilities this deployment actually has.',
      params: z.object({}),
      handle: () => ({
        status: 200,
        body: {
          schemaVersion: SCHEMA_VERSION,
          schemaMajor: SCHEMA_MAJOR,
          apiVersion: API_VERSION,
          paymentProvider: services.capabilities.paymentProvider,
          paymentsConfigured: services.capabilities.paymentsConfigured,
          mailer: services.capabilities.mailer,
          persistence: services.capabilities.persistence,
        },
      }),
    }),
  ];
}
