import { z } from 'zod';
import {
  AnonymousBootstrapRequestSchema,
  LinkIdentityRequestSchema,
  MagicLinkRequestSchema,
} from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** identity domain: anonymous bootstrap, session read, linking, magic links. */
export function authRoutes(services: ServiceRegistry): AnyRoute[] {
  const { identity } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/auth/anonymous',
      auth: 'none',
      idempotent: false,
      summary: 'Bootstrap an anonymous, device-backed account and issue a token.',
      body: AnonymousBootstrapRequestSchema,
      async handle(ctx) {
        const session = await identity.bootstrapAnonymous(ctx.body, { clientIp: ctx.clientIp });
        return { status: 201, body: session };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/auth/me',
      auth: 'required',
      summary: 'Return the current account, its identities and a fresh token.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await identity.getSession(auth.accountId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/refresh',
      auth: 'required',
      summary: 'Exchange a valid token for a fresh one.',
      body: z.object({}),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await identity.refresh(auth.accountId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/link',
      auth: 'required',
      idempotent: true,
      summary: 'Attach an Apple/Google/email identity, with an explicit merge policy.',
      body: LinkIdentityRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const outcome = await identity.linkIdentity(auth.accountId, ctx.body);
        const status = outcome.status === 'conflict' ? 409 : 200;
        return { status, body: outcome };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/auth/magic-link',
      auth: 'optional',
      idempotent: true,
      summary: 'Send a sign-in link to an email address.',
      body: MagicLinkRequestSchema,
      async handle(ctx) {
        const issued = await identity.requestMagicLink(ctx.auth?.accountId ?? null, ctx.body);
        return { status: 202, body: issued };
      },
    }),
  ];
}
