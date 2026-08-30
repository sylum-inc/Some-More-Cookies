import {
  GrantOperatorRequestSchema,
  OPERATOR_ROLES,
  OperatorCapabilityValues,
  RevokeOperatorRequestSchema,
} from '@somemore/protocol';

import { ApiError } from '../errors.js';
import { defineRoute, type AnyRoute, type RequestContext } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';
import { OPS_TOKEN_HEADER } from './liveops.js';

/**
 * Handing out operator powers, and taking them back (README, Blocker 9).
 *
 * There are two ways to be allowed to grant, and the difference between them is
 * the whole point of this file.
 *
 * **The capability.** Somebody who holds `operators:grant` can grant and revoke.
 * That is the ordinary path, it is per-person, and it can be taken away from
 * one person without touching anybody else.
 *
 * **The bootstrap.** `LIVE_OPS_TOKEN` — which used to authorize every operator
 * action in the service — now authorizes exactly one: making the first
 * operator on a deployment that has none. It is the answer to "who grants the
 * granter", and it is deliberately the *only* thing it can still do. A
 * deployment that has finished bootstrapping can unset it and lose nothing.
 *
 * There is still no external identity provider, and there does not need to be:
 * the blocker was framed as waiting on one, but what it actually wanted was the
 * service's own model of what a person may do, and accounts already existed.
 * An SSO provider, if one is ever bought, maps people to accounts and federates
 * into this — it does not replace it. See ADR-0011.
 */
export function operatorRoutes(services: ServiceRegistry): AnyRoute[] {
  const { operators, operatorDirectory } = services;

  /**
   * Establishes the right to grant, by capability or by bootstrap.
   *
   * The bootstrap is refused once anybody holds `operators:grant`, so the
   * shared secret cannot be used to quietly add a second administrator behind
   * the back of the first. After that it is a string that opens nothing.
   */
  async function mayGrant(ctx: RequestContext<unknown, unknown>): Promise<string> {
    const auth = ctx.requireAuth();
    if (await operatorDirectory.has(auth.accountId, 'operators:grant')) return auth.accountId;

    const presented = ctx.headers[OPS_TOKEN_HEADER];
    if (presented !== undefined && operators.matches(presented)) {
      const roster = await operatorDirectory.roster();
      if (roster.some((g) => g.capability === 'operators:grant')) {
        throw new ApiError(
          'forbidden',
          `This deployment already has an operator who can grant. ${OPS_TOKEN_HEADER} bootstraps the first one only; ask them.`,
        );
      }
      return auth.accountId;
    }

    throw new ApiError(
      'forbidden',
      `Granting operator capabilities needs the operators:grant capability, or ${OPS_TOKEN_HEADER} while this deployment has no operators at all.`,
    );
  }

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/operators/me',
      auth: 'required',
      summary: 'What this account is allowed to do. Empty for every ordinary player.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 200,
          body: {
            accountId: auth.accountId,
            capabilities: await operatorDirectory.capabilitiesOf(auth.accountId),
            // Published so an operator console does not have to hard-code them,
            // and so "what could I be given" is answerable without reading this
            // source.
            available: OperatorCapabilityValues,
            roles: OPERATOR_ROLES,
          },
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/operators',
      auth: 'required',
      summary: 'Everybody who holds anything. Needs operators:grant.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        await operatorDirectory.require(auth.accountId, 'operators:grant');
        return { status: 200, body: { items: await operatorDirectory.roster() } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/operators/grants',
      auth: 'required',
      idempotent: true,
      summary: 'Grant capabilities, by list or by role.',
      body: GrantOperatorRequestSchema,
      async handle(ctx) {
        const grantedBy = await mayGrant(ctx);
        const granted = await operatorDirectory.grant(ctx.body, grantedBy);
        return { status: 201, body: { items: granted } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/operators/revocations',
      auth: 'required',
      idempotent: true,
      summary: 'Take capabilities back from one account.',
      body: RevokeOperatorRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        await operatorDirectory.require(auth.accountId, 'operators:grant');
        /*
         * Deliberately no self-revocation guard. An administrator who wants to
         * drop their own `operators:grant` — because they are leaving, or
         * because they have just made somebody else the administrator — should
         * be able to, and a service that refuses is a service where the last
         * person to leave cannot close the door behind them. The bootstrap can
         * always make a new first operator if a deployment ends up with none.
         */
        const revoked = await operatorDirectory.revoke(ctx.body);
        return { status: 200, body: { revoked } };
      },
    }),
  ];
}
