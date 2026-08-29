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
      handle: () => ({ status: 200, body: { ok: true, schemaVersion: SCHEMA_VERSION } }),
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
