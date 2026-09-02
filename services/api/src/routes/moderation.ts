import { z } from 'zod';
import { CreateBlockRequestSchema, CreateReportRequestSchema, IdSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** moderation domain. */
export function moderationRoutes(services: ServiceRegistry): AnyRoute[] {
  const { moderation } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/moderation/reports',
      auth: 'required',
      idempotent: true,
      summary: 'Report an account, campsite, photo, sandwich, note or landmark.',
      body: CreateReportRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await moderation.report(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/moderation/reports',
      auth: 'required',
      summary: 'Reports you have filed.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await moderation.listMyReports(auth.accountId) } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/moderation/blocks',
      auth: 'required',
      idempotent: true,
      summary: 'Block a player.',
      body: CreateBlockRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await moderation.block(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/moderation/blocks',
      auth: 'required',
      summary: 'Everyone you have blocked.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await moderation.listBlocks(auth.accountId) } };
      },
    }),

    defineRoute({
      method: 'DELETE',
      path: '/v1/moderation/blocks/:accountId',
      auth: 'required',
      summary: 'Unblock a player.',
      params: z.object({ accountId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        await moderation.unblock(auth.accountId, ctx.params.accountId);
        return { status: 204 };
      },
    }),
  ];
}
