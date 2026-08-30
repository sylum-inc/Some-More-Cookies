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
    /**
     * The public halves of the signing keys.
     *
     * Deliberately unauthenticated, because a public key is not a secret and
     * publishing it is the entire point of choosing Ed25519 (ADR-0008): a phone
     * that has fetched this once can reject a forged, mistyped or expired
     * wrapper at a campsite with no signal, without ever asking us. It is also
     * how a key rotation reaches installed clients without a store release.
     *
     * Cached hard: keys change on the order of years, and a client that cannot
     * reach us falls back to whatever it last stored — or, failing that, to
     * asking the service, which is the honest degradation rather than a
     * pretended verdict.
     */
    defineRoute({
      method: 'GET',
      path: '/v1/codes/keys',
      auth: 'none',
      summary: 'Ed25519 public keys, so a client can verify a code with no network.',
      async handle() {
        return {
          status: 200,
          body: codes.verificationKeys(),
          headers: { 'cache-control': 'public, max-age=3600, stale-while-revalidate=86400' },
        };
      },
    }),

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
