import { z } from 'zod';
import {
  CreateCampsiteRequestSchema,
  CreateInviteRequestSchema,
  CampsiteMemorySnapshotSchema,
  CreateTraceRequestSchema,
  IdSchema,
  JoinCampsiteRequestSchema,
  PromoteLandmarkRequestSchema,
  RecordMaintenanceRequestSchema,
  UpdateCampsiteRequestSchema,
} from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

const campsiteParams = z.object({ campsiteId: IdSchema });
const traceParams = z.object({ campsiteId: IdSchema, traceId: IdSchema });

/** campsites + worldState domains. */
export function campsiteRoutes(services: ServiceRegistry): AnyRoute[] {
  const { campsites, worldState } = services;
  return [
    defineRoute({
      method: 'POST',
      path: '/v1/campsites',
      auth: 'required',
      idempotent: true,
      summary: 'Pitch a new campsite (private by default) with its own SM-01.',
      body: CreateCampsiteRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await campsites.create(auth.accountId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/campsites',
      auth: 'required',
      summary: 'List the campsites you belong to.',
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: { items: await campsites.listForAccount(auth.accountId), nextCursor: null } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/campsites/:campsiteId',
      auth: 'required',
      summary: 'Read one campsite.',
      params: campsiteParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await campsites.get(auth.accountId, ctx.params.campsiteId) };
      },
    }),

    defineRoute({
      method: 'PATCH',
      path: '/v1/campsites/:campsiteId',
      auth: 'required',
      summary: 'Rename a campsite, change its privacy (owner only) or refinish the machine.',
      params: campsiteParams,
      body: UpdateCampsiteRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await campsites.update(auth.accountId, ctx.params.campsiteId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/invites',
      auth: 'required',
      idempotent: true,
      summary: 'Mint an invite link + camp code + QR payload.',
      params: campsiteParams,
      body: CreateInviteRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const invite = await campsites.createInvite(auth.accountId, ctx.params.campsiteId, ctx.body);
        // Signed when this deployment has code keys, legacy when it does not;
        // `join` accepts both, so the QR path never depends on a credential.
        return {
          status: 201,
          body: { invite, qrPayload: campsites.qrPayloadFor(invite) },
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/invites/:token',
      auth: 'required',
      summary: 'Where an invite leads: the campsite, and its live session if one is open.',
      params: z.object({ token: z.string().min(1) }),
      async handle(ctx) {
        ctx.requireAuth();
        return { status: 200, body: await campsites.resolveInvite(ctx.params.token) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/join',
      auth: 'required',
      idempotent: true,
      summary: 'Join a campsite by invite link, camp code or QR.',
      body: JoinCampsiteRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const { campsite, role } = await campsites.join(auth.accountId, ctx.body);
        return { status: 200, body: { campsite, role } };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/campsites/:campsiteId/machine',
      auth: 'required',
      summary: 'Read the serialized SM-01: wear, quirks, maintenance history.',
      params: campsiteParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await campsites.getMachine(auth.accountId, ctx.params.campsiteId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/machine/maintenance',
      auth: 'required',
      idempotent: true,
      summary: 'Service the SM-01.',
      params: campsiteParams,
      body: RecordMaintenanceRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 201,
          body: await campsites.recordMaintenance(auth.accountId, ctx.params.campsiteId, ctx.body),
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/campsites/:campsiteId/world',
      auth: 'required',
      summary: 'Read the live world state: traces with decay applied, plus landmarks.',
      params: campsiteParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await worldState.read(auth.accountId, ctx.params.campsiteId) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/campsites/:campsiteId/memory',
      auth: 'required',
      summary: 'Read what this campsite remembers about you.',
      params: z.object({ campsiteId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 200, body: await worldState.readMemory(auth.accountId, ctx.params.campsiteId) };
      },
    }),

    defineRoute({
      method: 'PUT',
      path: '/v1/campsites/:campsiteId/memory',
      auth: 'required',
      /*
       * Not idempotency-keyed, and that is the design rather than an omission:
       * the merge is idempotent in itself, so a replayed snapshot produces the
       * same state. A key would only add a way for the second sync of an
       * unchanged campsite to be a 409.
       */
      summary: 'Fold this device’s account of a campsite into the merged memory.',
      params: z.object({ campsiteId: IdSchema }),
      body: CampsiteMemorySnapshotSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 200,
          body: await worldState.syncMemory(auth.accountId, ctx.params.campsiteId, ctx.body),
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/traces',
      auth: 'required',
      idempotent: true,
      summary: 'Leave a mark on the world.',
      params: campsiteParams,
      body: CreateTraceRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return { status: 201, body: await worldState.addTrace(auth.accountId, ctx.params.campsiteId, ctx.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/traces/:traceId/witness',
      auth: 'required',
      summary: 'Notice a trace: counts toward the landmark promotion quorum.',
      params: traceParams,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 200,
          body: await worldState.witness(auth.accountId, ctx.params.campsiteId, ctx.params.traceId),
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/campsites/:campsiteId/traces/:traceId/landmark',
      auth: 'required',
      idempotent: true,
      summary: 'Promote a witnessed trace into a named, non-decaying landmark.',
      params: traceParams,
      body: PromoteLandmarkRequestSchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        return {
          status: 201,
          body: await worldState.promote(auth.accountId, ctx.params.campsiteId, ctx.params.traceId, ctx.body),
        };
      },
    }),
  ];
}
