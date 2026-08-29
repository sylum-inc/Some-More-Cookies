import { z } from 'zod';
import {
  ContentKindSchema,
  ContentSlugSchema,
  ContentStatusSchema,
  CreateCodeBatchRequestSchema,
  CreateContentDocumentRequestSchema,
  IdSchema,
  JsonValueSchema,
  MintCodesRequestSchema,
  RetireCodeBatchRequestSchema,
  RollbackReleaseRequestSchema,
  TransitionContentDocumentRequestSchema,
} from '@somemore/protocol';
import { ApiError } from '../errors.js';
import { defineRoute, type AnyRoute, type RequestContext } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/** The header an operator presents alongside their ordinary bearer token. */
export const OPS_TOKEN_HEADER = 'x-somemore-ops-token';

/**
 * Live-ops authoring: the write side of the content service, and the mint.
 *
 * Every route here needs **two** things: a valid player bearer token (so the
 * action has a real account attached to it in the audit trail) and the shared
 * `LIVE_OPS_TOKEN`. That is not RBAC and is not pretending to be — there is no
 * staff identity provider yet (README, Blocker 9). It is deliberately more than
 * a shared secret alone, and the blocker stays open until it is a role model.
 *
 * With no `LIVE_OPS_TOKEN` set, these routes answer `503
 * service_not_configured` with the missing variable named, exactly as the
 * payment and voice adapters do. They never quietly succeed and never quietly
 * no-op.
 */
export function liveOpsRoutes(services: ServiceRegistry): AnyRoute[] {
  const { liveOps, codes, operators } = services;

  /** Both credentials, or a 401/503 that says which one is missing. */
  function operator(ctx: RequestContext<unknown, unknown>): string {
    const auth = ctx.requireAuth();
    const reason = operators.unavailableReason();
    if (reason !== null) throw new ApiError('service_not_configured', reason);
    if (!operators.matches(ctx.headers[OPS_TOKEN_HEADER])) {
      throw new ApiError('unauthorized', `A valid ${OPS_TOKEN_HEADER} header is required for live ops.`);
    }
    return auth.accountId;
  }

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/status',
      auth: 'required',
      summary: 'Whether this deployment can author content and mint codes.',
      async handle(ctx) {
        ctx.requireAuth();
        return {
          status: 200,
          body: { liveOps: await liveOps.status(), codes: codes.signingStatus() },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/documents/validate',
      auth: 'required',
      summary: 'Dry-run the publish gate against a body without storing anything.',
      body: z.object({ kind: ContentKindSchema, body: JsonValueSchema }),
      async handle(ctx) {
        operator(ctx);
        return { status: 200, body: await liveOps.validate(ctx.body.kind, ctx.body.body) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/documents',
      auth: 'required',
      idempotent: true,
      summary: 'Draft a new version of a content document.',
      body: CreateContentDocumentRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return { status: 201, body: await liveOps.createDocument(actor, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/documents',
      auth: 'required',
      summary: 'List content documents, optionally filtered by kind, slug or status.',
      async handle(ctx) {
        operator(ctx);
        const kind = ContentKindSchema.safeParse(ctx.query.get('kind'));
        const slug = ContentSlugSchema.safeParse(ctx.query.get('slug'));
        const status = ContentStatusSchema.safeParse(ctx.query.get('status'));
        return {
          status: 200,
          body: {
            items: await liveOps.listDocuments({
              ...(kind.success ? { kind: kind.data } : {}),
              ...(slug.success ? { slug: slug.data } : {}),
              ...(status.success ? { status: status.data } : {}),
            }),
            nextCursor: null,
          },
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/documents/:documentId',
      auth: 'required',
      summary: 'Read one content document at one version, in any status.',
      params: z.object({ documentId: IdSchema }),
      async handle(ctx) {
        operator(ctx);
        return { status: 200, body: await liveOps.getDocument(ctx.params.documentId) };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/documents/:documentId/transitions',
      auth: 'required',
      idempotent: true,
      summary: 'Move a document through draft -> staged -> published -> retired.',
      params: z.object({ documentId: IdSchema }),
      body: TransitionContentDocumentRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return {
          status: 200,
          body: await liveOps.transition(actor, ctx.params.documentId, ctx.body),
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/releases',
      auth: 'required',
      summary: 'The append-only release history: what was live, and when.',
      async handle(ctx) {
        operator(ctx);
        const limit = Number.parseInt(ctx.query.get('limit') ?? '50', 10);
        return {
          status: 200,
          body: {
            items: await liveOps.listReleases(Number.isFinite(limit) ? Math.min(Math.max(limit, 1), 200) : 50),
            nextCursor: null,
          },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/releases/rollback',
      auth: 'required',
      idempotent: true,
      summary: 'Undo a bad publish by republishing an earlier release, with no deploy.',
      body: RollbackReleaseRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return { status: 201, body: await liveOps.rollback(actor, ctx.body) };
      },
    }),

    /* ---- code batches ---------------------------------------------------- */

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/code-batches',
      auth: 'required',
      idempotent: true,
      summary: 'Open a print run: what it entitles you to, how big, and when it is live.',
      body: CreateCodeBatchRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return { status: 201, body: await codes.createBatch(actor, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/code-batches',
      auth: 'required',
      summary: 'Every print run, with minted and redeemed counts.',
      async handle(ctx) {
        operator(ctx);
        return { status: 200, body: { items: await codes.listBatches(), nextCursor: null } };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/code-batches/:batchId/mint',
      auth: 'required',
      idempotent: true,
      summary: 'Mint codes for a run. This response is the only copy that exists.',
      params: z.object({ batchId: IdSchema }),
      body: MintCodesRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return {
          status: 201,
          body: await codes.mint(actor, ctx.params.batchId, ctx.body),
          // Belt and braces: a mint response must not sit in a proxy cache.
          headers: { 'cache-control': 'no-store' },
        };
      },
    }),

    defineRoute({
      method: 'POST',
      path: '/v1/live-ops/code-batches/:batchId/retire',
      auth: 'required',
      idempotent: true,
      summary: 'Retire one compromised run. Every other run keeps working.',
      params: z.object({ batchId: IdSchema }),
      body: RetireCodeBatchRequestSchema,
      async handle(ctx) {
        const actor = operator(ctx);
        return { status: 200, body: await codes.retire(actor, ctx.params.batchId, ctx.body) };
      },
    }),
  ];
}
