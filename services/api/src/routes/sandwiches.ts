import { z } from 'zod';
import { CreateSandwichRequestSchema, IdSchema, UpdateSandwichRequestSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

const sandwichParams = z.object({ sandwichId: IdSchema });

/** sandwiches domain: the canonical record of what the SM-01 produced. */
export function sandwichRoutes(services: ServiceRegistry): AnyRoute[] {
  const { sandwiches } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/sandwiches',
      auth: 'required',
      idempotent: true,
      summary: 'Record a produced sandwich. The server scores it.',
      body: CreateSandwichRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await sandwiches.create(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/sandwiches',
      auth: 'required',
      summary: 'List your sandwiches, newest first.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await sandwiches.listMine(auth.accountId), nextCursor: null } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/sandwiches/:sandwichId',
      auth: 'required',
      summary: 'Read one sandwich, if it is yours or shared with you.',
      params: sandwichParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sandwiches.get(auth.accountId, ctx.params.sandwichId) };
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/sandwiches/:sandwichId',
      auth: 'required',
      summary: 'Name it, share it, pick a hero photo, or eat it.',
      params: sandwichParams,
      body: UpdateSandwichRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sandwiches.update(auth.accountId, ctx.params.sandwichId, ctx.body) };
      },
    }),
  ];
}
