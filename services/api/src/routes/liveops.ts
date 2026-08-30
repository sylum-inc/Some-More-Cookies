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
import type { OperatorCapability } from '@somemore/protocol';
import { defineRoute, type AnyRoute, type RequestContext } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/**
 * The bootstrap header, used by `routes/operators.ts` and nothing here.
 *
 * It lives in this module for history: it used to be the credential every
 * route below demanded. Since ADR-0011 it appoints the first operator on a
 * deployment that has none, and opens nothing else.
 */
export const OPS_TOKEN_HEADER = 'x-somemore-ops-token';

/**
 * Live-ops authoring: the write side of the content service, and the mint.
 *
 * Every route here needs a valid player bearer token whose account holds the
 * capability that route names — `content:draft` to write a document,
 * `content:publish` to put one in front of players, `codes:mint` to press a
 * batch (ADR-0011). The capability is checked in the handler, next to the work
 * it guards, so the permission a reader sees here is the permission the service
 * enforces.
 *
 * This replaces one shared `LIVE_OPS_TOKEN` that authorized all of it at once,
 * for everybody who had the string, with no way to take it back from one
 * person. A refusal names the capability that was missing, because the person
 * reading it is usually an operator who needs to know which one to ask for.
 */
export function liveOpsRoutes(services: ServiceRegistry): AnyRoute[] {
  const { liveOps, codes, operatorDirectory } = services;

  /**
   * The account, once it has been established it may do this particular thing.
   *
   * This used to take a shared secret and grant *everything* — draft, publish,
   * mint, all one permission held by everybody who had the string. Now each
   * route names the capability it needs, which is what makes "may draft" and
   * "may mint a hundred thousand codes" different jobs (README, Blocker 9).
   */
  async function operator(
    ctx: RequestContext<unknown, unknown>,
    capability: OperatorCapability,
  ): Promise<string> {
    const auth = ctx.requireAuth();
    await operatorDirectory.require(auth.accountId, capability);
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
        await operator(ctx, 'content:draft');
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
        const actor = await operator(ctx, 'content:draft');
        return { status: 201, body: await liveOps.createDocument(actor, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/documents',
      auth: 'required',
      summary: 'List content documents, optionally filtered by kind, slug or status.',
      async handle(ctx) {
        await operator(ctx, 'content:draft');
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
        await operator(ctx, 'content:draft');
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
        const actor = await operator(ctx, 'content:publish');
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
        await operator(ctx, 'content:publish');
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
        const actor = await operator(ctx, 'content:publish');
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
        const actor = await operator(ctx, 'codes:mint');
        return { status: 201, body: await codes.createBatch(actor, ctx.body) };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/live-ops/code-batches',
      auth: 'required',
      summary: 'Every print run, with minted and redeemed counts.',
      async handle(ctx) {
        await operator(ctx, 'codes:mint');
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
        const actor = await operator(ctx, 'codes:mint');
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
        const actor = await operator(ctx, 'codes:mint');
        return { status: 200, body: await codes.retire(actor, ctx.params.batchId, ctx.body) };
      },
    }),
  ];
}
