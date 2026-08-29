import { ClaimRewardRequestSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** rewards domain: catalog, grants, and the validated high-value claim flow. */
export function rewardRoutes(services: ServiceRegistry): AnyRoute[] {
  const { rewards } = services;
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/rewards',
      auth: 'required',
      summary: 'The reward catalog available right now.',
      async handle() {
        return { status: 200, body: { items: await rewards.listCatalog() } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/rewards/grants',
      auth: 'required',
      summary: 'Everything you have been granted.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await rewards.listGrants(auth.accountId) } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/rewards/claims',
      auth: 'required',
      idempotent: true,
      summary: 'Claim a reward. High-value rewards are server-validated and claim-once.',
      body: ClaimRewardRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const result = await rewards.claim(auth.accountId, ctx.body, { clientIp: ctx.clientIp });
        const status = result.status === 'granted' ? 201 : result.status === 'pending_review' ? 202 : 200;
        return { status, body: result };
      },
    }),
  ];
}
