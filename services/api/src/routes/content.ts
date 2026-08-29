import { z } from 'zod';
import { ContentKindSchema, ContentSlugSchema } from '@somemore/protocol';
import { defineRoute, type AnyRoute } from '../http/router.js';
import type { ServiceRegistry } from '../services.js';

/**
 * Content delivery: the read side of live ops.
 *
 * Public, cacheable, and — the part that matters — *optional*. The client boots
 * from the catalogue compiled into it and asks for this afterwards. A 304, a
 * timeout, a 500 and a DNS failure are all the same thing to a campsite: the
 * overlay it already had, or none.
 *
 * `If-None-Match` is honoured with a strong validator that covers both the
 * release version and which activation windows are open right now, so a phone
 * on one bar of signal spends a few hundred bytes finding out nothing changed —
 * and finds out on the same request when a meteor shower starts.
 */
export function contentRoutes(services: ServiceRegistry): AnyRoute[] {
  const { liveOps } = services;
  return [
    defineRoute({
      method: 'GET',
      path: '/v1/content/manifest',
      auth: 'optional',
      summary: 'The published content overlay, with an ETag for conditional fetches.',
      async handle(ctx) {
        const manifest = await liveOps.manifest();
        const headers: Record<string, string> = {
          etag: manifest.etag,
          // Short, because activation windows turn over on their own; the
          // conditional request is what makes that cheap rather than the TTL.
          'cache-control': 'public, max-age=60, stale-while-revalidate=600',
          vary: 'accept-encoding',
        };
        const presented = ctx.headers['if-none-match'];
        if (presented !== undefined && matchesEtag(presented, manifest.etag)) {
          return { status: 304, headers };
        }
        return { status: 200, body: manifest, headers };
      },
    }),

    defineRoute({
      method: 'GET',
      path: '/v1/content/documents/:kind/:slug',
      auth: 'optional',
      summary: 'One published content document, addressed by kind and slug.',
      params: z.object({ kind: ContentKindSchema, slug: ContentSlugSchema }),
      async handle(ctx) {
        const document = await liveOps.publishedDocument(ctx.params.kind, ctx.params.slug);
        const etag = `"${document.checksum.slice(0, 32)}"`;
        const headers = { etag, 'cache-control': 'public, max-age=300' };
        const presented = ctx.headers['if-none-match'];
        if (presented !== undefined && matchesEtag(presented, etag)) {
          return { status: 304, headers };
        }
        return { status: 200, body: document, headers };
      },
    }),
  ];
}

/**
 * RFC 9110 §13.1.2: `If-None-Match` is a comma-separated list, may be `*`, and
 * may carry weak markers. We emit strong validators, but a proxy is entitled to
 * weaken one, so `W/"x"` is treated as matching `"x"` here.
 */
function matchesEtag(header: string, etag: string): boolean {
  const normalize = (value: string): string => value.trim().replace(/^W\//, '');
  const target = normalize(etag);
  return header
    .split(',')
    .map(normalize)
    .some((candidate) => candidate === '*' || candidate === target);
}
