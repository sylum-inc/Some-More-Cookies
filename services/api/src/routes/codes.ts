import { RedeemCodeRequestSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/**
 * The player-facing half of the physical bridge: a camera, a wrapper, and an
 * account. Authenticated on purpose — a code is not a bearer token, so it is
 * worth nothing to somebody who scraped it off a photograph and has nowhere to
 * put it.
 */
export function codeRoutes(services: ServiceRegistry): AnyRoute[] {
  const { codes } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/codes/redeem',
      auth: 'required',
      idempotent: true,
      summary: 'Redeem a scanned Some More code. Claim-once is enforced by the database.',
      body: RedeemCodeRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const result = await codes.redeem(auth.accountId, ctx.body, { clientIp: ctx.clientIp });
        return { status: 201, body: result, headers: { 'cache-control': 'no-store' } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/codes/redemptions',
      auth: 'required',
      summary: 'Codes you have redeemed, newest first.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await codes.listRedemptions(auth.accountId), nextCursor: null } };
      },
    }),
  ];
}
