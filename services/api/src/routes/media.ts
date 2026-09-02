import { z } from 'zod';
import { IdSchema, RequestPhotoUploadBodySchema } from '@somemore/protocol';
import { ApiError } from '../errors.js';
import { defineRoute, type AnyRoute, type RouteResult } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/**
 * media domain: the bytes behind a photograph.
 *
 * Three requests, in the order a camera uses them: ask for somewhere to put
 * it, put it, look at it. The split is not ceremony — it is the shape of a
 * pre-signed object-storage URL, so the day this deployment gets a bucket the
 * client keeps making exactly these calls and only the URL in the ticket
 * changes.
 *
 * The upload route is the only one in the service that takes bytes rather than
 * JSON, and everything that makes that safe is declared right here where it
 * can be read in one go: a per-route body ceiling well below what the ticket
 * will accept, no JSON parsing, and a domain that decides what the bytes are
 * from the bytes.
 */
export function mediaRoutes(services: ServiceRegistry): AnyRoute[] {
  const { media, capabilities } = services;

  return [
    defineRoute({
      method: 'GET',
      path: '/v1/media/status',
      auth: 'none',
      summary: 'Whether this deployment can store photo bytes, and where.',
      handle: () => ({
        status: 200,
        body: capabilities.mediaConfigured
          ? {
              status: 'ready' as const,
              provider: capabilities.mediaStorage,
              bucket: capabilities.mediaBucket,
              maxBytes: capabilities.mediaMaxBytes,
            }
          : {
              status: 'not_configured' as const,
              provider: capabilities.mediaStorage,
              reason: capabilities.mediaUnavailableReason ?? 'Object storage is not configured.',
              fallback: 'device_local' as const,
            },
      }),
    }),
    defineRoute({
      method: 'POST',
      path: '/v1/media/uploads',
      auth: 'required',
      idempotent: true,
      summary: 'Ask for somewhere to put a photo.',
      body: RequestPhotoUploadBodySchema,
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const { idempotencyKey: _key, ...request } = ctx.body;
        const ticket = await media.requestUpload(auth.accountId, request);
        /*
         * `not_configured` is a 200, not a 503, and that is deliberate. The
         * question the client asked was "where do I put this", and "nowhere,
         * here is why" is a complete and correct answer to it — the same call
         * `realtime/voice.ts` makes when there is no SFU. A 503 would put a
         * failure in front of a player who has a photograph in their hand.
         */
        return { status: 200, body: ticket };
      },
    }),

    defineRoute({
      method: 'PUT',
      path: '/v1/media/uploads/:photoId',
      auth: 'required',
      binaryBody: true,
      // Eight megabytes, against a 512 KB default for everything else. The
      // ticket carries the same number and the domain checks it again; this is
      // the one that stops the stream, before anything is buffered.
      maxBodyBytes: 8 * 1024 * 1024,
      summary: 'Upload the bytes for a photo, against an upload ticket.',
      params: z.object({ photoId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        const token = ctx.headers['x-upload-ticket'];
        if (token === undefined || token.length === 0) {
          throw new ApiError(
            'bad_request',
            'This upload needs the ticket from POST /v1/media/uploads, in x-upload-ticket.',
          );
        }
        const stored = await media.completeUpload({
          accountId: auth.accountId,
          uploadToken: token,
          bytes: ctx.rawBytes,
          declaredContentType: ctx.headers['content-type'],
        });
        // The ticket named this photo before the bytes existed; a mismatch
        // means a ticket for one photo is being spent on another's URL.
        if (stored.photo.id !== ctx.params.photoId) {
          throw new ApiError('bad_request', 'That upload ticket is for a different photo.');
        }
        return { status: 201, body: stored };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/media/:photoId',
      /*
       * Optional, not required: a `public` or `link` photo is readable signed
       * out, which is what sharing an image means. Everything else still needs
       * to be you, and a private photo answers 404 to a stranger rather than
       * 403 — whether it exists is not a stranger's business either.
       */
      auth: 'optional',
      summary: 'Fetch a photo, if you are allowed to see it.',
      params: z.object({ photoId: IdSchema }),
      async handle(ctx): Promise<RouteResult> {
        const viewer = ctx.auth?.accountId ?? null;
        const result = await media.read(viewer, ctx.params.photoId);
        if (result.redirectTo !== null) {
          return { status: 302, headers: { location: result.redirectTo, 'cache-control': 'private, max-age=60' } };
        }
        return {
          status: 200,
          raw: { bytes: result.bytes, contentType: result.contentType },
          headers: {
            // A public photo may sit in a shared cache; anything narrower may
            // not, or one person's browser cache becomes another's.
            'cache-control':
              result.photo.visibility === 'public'
                ? 'public, max-age=86400, immutable'
                : 'private, no-store',
            etag: `"${result.photo.id}"`,
          },
        };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/media/:photoId/meta',
      auth: 'optional',
      summary: 'Read a photo’s metadata without fetching the image.',
      params: z.object({ photoId: IdSchema }),
      async handle(ctx) {
        const viewer = ctx.auth?.accountId ?? null;
        return { status: 200, body: await media.describe(viewer, ctx.params.photoId) };
      },
    }),

    defineRoute({
      method: 'DELETE',
      path: '/v1/media/:photoId',
      auth: 'required',
      summary: 'Delete a photo, its bytes and its Passport entry.',
      params: z.object({ photoId: IdSchema }),
      async handle(ctx) {
        const auth = ctx.requireAuth();
        await media.remove(auth.accountId, ctx.params.photoId);
        return { status: 204 };
      },
    }),

  ];
}
