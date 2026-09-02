import { z } from 'zod';
import {
  AuthorityHandoffRequestSchema,
  CreateSessionRequestSchema,
  HeartbeatRequestSchema,
  IdSchema,
  SessionStateSchema,
} from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

const sessionParams = z.object({ sessionId: IdSchema });

/** sessions domain: presence and shared-object authority. */
export function sessionRoutes(services: ServiceRegistry): AnyRoute[] {
  const { sessions } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/sessions',
      auth: 'required',
      idempotent: true,
      summary: 'Open a live session at a campsite.',
      params: z.object({ campsiteId: IdSchema }),
      body: CreateSessionRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await sessions.create(auth.accountId, ctx.params.campsiteId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/sessions/:sessionId',
      auth: 'required',
      summary: 'Read a session and everyone present.',
      params: sessionParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sessions.get(auth.accountId, ctx.params.sessionId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/sessions/:sessionId/join',
      auth: 'required',
      summary: 'Arrive at the fire.',
      params: sessionParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sessions.join(auth.accountId, ctx.params.sessionId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/sessions/:sessionId/leave',
      auth: 'required',
      summary: 'Leave; anything you were holding is released.',
      params: sessionParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sessions.leave(auth.accountId, ctx.params.sessionId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/sessions/:sessionId/presence',
      auth: 'required',
      summary: 'Heartbeat: position, facing, activity, mute state.',
      params: sessionParams,
      body: HeartbeatRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sessions.heartbeat(auth.accountId, ctx.params.sessionId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/sessions/:sessionId/state',
      auth: 'required',
      summary: 'Move the session through its lifecycle.',
      params: sessionParams,
      body: z.object({ to: SessionStateSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await sessions.transition(auth.accountId, ctx.params.sessionId, ctx.body.to) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/sessions/:sessionId/authority',
      auth: 'required',
      summary: 'Who currently owns each shared object.',
      params: sessionParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await sessions.listAuthority(auth.accountId, ctx.params.sessionId) } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/sessions/:sessionId/authority',
      auth: 'required',
      summary: 'Hand off (or release) authority over a shared object.',
      params: sessionParams,
      body: AuthorityHandoffRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const result = await sessions.handoff(auth.accountId, ctx.params.sessionId, ctx.body);
        return { status: result.status === 'granted' ? 200 : 409, body: result };
      },
    }),
  ];
}
