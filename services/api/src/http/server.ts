import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { ZodError } from 'zod';
import { SCHEMA_VERSION, type JsonValue } from '@somemore/protocol';
import { ApiError } from '../errors.js';
import type { Clock } from '../clock.js';
import type { ApiConfig } from '../config.js';
import type { Logger } from '../logging.js';
import type { IdempotencyLayer } from '../idempotency.js';
import {
  Router,
  errorEnvelope,
  hashRequest,
  newRequestId,
  normalizeHeaders,
  parseJsonBody,
  readBodyBytes,
  validate,
  writeBytes,
  writeJson,
  type AuthContext,
  type HttpMethod,
  type RequestContext,
  type RouteResult,
} from './router.js';

export interface ServerDeps {
  readonly router: Router;
  readonly config: ApiConfig;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly idempotency: IdempotencyLayer;
  /** Resolves a bearer token to an account, or throws `unauthorized`. */
  authenticate(token: string, now: Date): Promise<AuthContext>;
}

const METHODS: readonly string[] = ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'];

/*
 * Cross-origin access.
 *
 * There was none, which was fine while the only browser client was served from
 * the same origin — and is not fine now that there is a live-ops console on its
 * own origin, and will not be fine for any deployment that puts the client on a
 * CDN and the API on an API host. Two rules, and they are different rules:
 *
 *  - **Public read routes answer `*`.** `/health`, `/v1/meta`, the content
 *    manifest and the code verification keys are public, cacheable, and carry
 *    nothing about anybody. Anything that can `curl` them can already read
 *    them; refusing a browser buys nothing and breaks the offline-verification
 *    story, which needs the keys reachable from wherever the client is served.
 *  - **Everything else needs a named origin.** `Access-Control-Allow-Origin` is
 *    echoed only for an exact match in `CORS_ALLOWED_ORIGINS`, never `*` and
 *    never a reflected unknown origin, because these routes carry a bearer
 *    token and — for live ops — a shared staff secret. Empty by default: a
 *    deployment says who may talk to it, out loud, in an environment variable.
 *
 * The token is in an `Authorization` header rather than a cookie, so this is
 * not a CSRF surface: a cross-site form post cannot attach one, and a
 * cross-origin `fetch` that tries needs a preflight it will not get.
 */
const CORS_REQUEST_HEADERS = 'authorization, content-type, idempotency-key, if-none-match, x-somemore-ops-token';
/** What a browser client is allowed to *read* off a response. */
const CORS_EXPOSED_HEADERS = 'etag, retry-after, x-request-id, x-schema-version, idempotent-replay, location';

function clientIpOf(req: IncomingMessage, headers: Readonly<Record<string, string>>): string {
  const forwarded = headers['x-forwarded-for'];
  if (forwarded !== undefined) {
    const first = forwarded.split(',')[0]?.trim();
    if (first !== undefined && first.length > 0) return first;
  }
  return req.socket.remoteAddress ?? '0.0.0.0';
}

/**
 * The HTTP edge. Its whole job: request ids, structured logs, body limits,
 * JSON parsing, schema validation, auth, idempotency, and a single JSON error
 * envelope. No business logic lives here.
 */
export function createApiServer(deps: ServerDeps): Server {
  const { router, config, clock, logger, idempotency } = deps;

  const allowedOrigins = new Set(config.corsAllowedOrigins);

  /**
   * The CORS headers for one request, or none.
   *
   * `publicRoute` is derived from the matched route rather than from a second
   * hand-maintained list, so a route that starts requiring auth tightens its
   * CORS answer on its own. The rule is **a GET that does not require auth**:
   * a GET is not a mutation, and none of these carry an ambient credential —
   * the bearer token is an explicit header, never a cookie, so there is
   * nothing a stranger's page could make a browser attach.
   */
  function corsHeaders(origin: string | undefined, publicRoute: boolean): Record<string, string> {
    if (origin === undefined) return {};
    if (publicRoute) {
      // No credentials, so `*` is both safe and cacheable by a shared proxy.
      return { 'access-control-allow-origin': '*', 'access-control-expose-headers': CORS_EXPOSED_HEADERS };
    }
    if (!allowedOrigins.has(origin)) return { vary: 'origin' };
    return {
      'access-control-allow-origin': origin,
      'access-control-allow-credentials': 'true',
      'access-control-expose-headers': CORS_EXPOSED_HEADERS,
      vary: 'origin',
    };
  }

  return createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      logger.error('http.unhandled', { error: String(error) });
      if (!res.headersSent) {
        writeJson(res, 500, errorEnvelope('internal_error', 'Something went wrong.', 'req_unknown'));
      }
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const requestId = newRequestId();
    const startedAt = Date.now();
    const headers = normalizeHeaders(req.headers);
    const url = new URL(req.url ?? '/', `http://${headers['host'] ?? 'localhost'}`);
    const method = (req.method ?? 'GET').toUpperCase();
    const log = logger.child({ requestId, method, path: url.pathname });

    res.setHeader('x-request-id', requestId);

    try {
      /*
       * Preflight, answered before routing and before authentication.
       *
       * A preflight carries no credentials by definition, so requiring a bearer
       * token for one would mean no browser could ever reach an authenticated
       * route. The route is looked up with the *intended* method so the answer
       * is about the request the browser is actually about to make.
       */
      if (method === 'OPTIONS') {
        const origin = headers['origin'];
        const intended = (headers['access-control-request-method'] ?? 'GET').toUpperCase();
        const preflight = router.match(intended, url.pathname);
        const isPublic =
          intended === 'GET' && preflight !== null && 'route' in preflight && preflight.route.auth !== 'required';
        const allow = corsHeaders(origin, isPublic);
        if (allow['access-control-allow-origin'] === undefined) {
          // Not an origin this deployment knows. Say no by saying nothing:
          // the browser blocks the real request, and we have not confirmed
          // anything about what does or does not exist here.
          writeJson(res, 204, undefined, allow);
          return;
        }
        writeJson(res, 204, undefined, {
          ...allow,
          'access-control-allow-methods': METHODS.join(', '),
          'access-control-allow-headers': headers['access-control-request-headers'] ?? CORS_REQUEST_HEADERS,
          'access-control-max-age': '600',
        });
        return;
      }

      if (!METHODS.includes(method)) throw new ApiError('method_not_allowed', `${method} is not supported.`);

      const matched = router.match(method, url.pathname);
      if (matched === null) throw new ApiError('not_found', `No route for ${method} ${url.pathname}.`);
      if (!('route' in matched)) {
        throw new ApiError('method_not_allowed', `${method} is not allowed here.`, {
          headers: { allow: matched.allowed.join(', ') },
        });
      }

      const { route, params: rawParams } = matched;
      const bodyLimit = route.maxBodyBytes ?? config.maxBodyBytes;
      const rawBytes = await readBodyBytes(req, bodyLimit);
      // A photograph is not text, and decoding eight megabytes of JPEG to
      // UTF-8 to throw the result away is both wasteful and a way to mangle
      // bytes that a later hash is supposed to match.
      const rawBody = route.binaryBody === true ? '' : rawBytes.toString('utf8');
      const parsedBody =
        route.rawBodyOnly === true || route.binaryBody === true
          ? {}
          : parseJsonBody(rawBody, headers['content-type']);

      let auth: AuthContext | null = null;
      if (route.auth !== 'none') {
        const authorization = headers['authorization'];
        const token = authorization === undefined ? null : /^Bearer\s+(.+)$/i.exec(authorization.trim())?.[1] ?? null;
        if (token === null) {
          if (route.auth === 'required') throw new ApiError('unauthorized', 'A bearer token is required.');
        } else {
          auth = await deps.authenticate(token, clock.now());
        }
      }

      const params = route.params === undefined ? rawParams : validate(route.params, rawParams, 'params');
      const body = route.body === undefined ? parsedBody : validate(route.body, parsedBody, 'body');

      const bodyKey =
        typeof parsedBody === 'object' && parsedBody !== null && 'idempotencyKey' in parsedBody
          ? String((parsedBody as { idempotencyKey: unknown }).idempotencyKey)
          : null;
      const headerKey = headers['idempotency-key'] ?? null;
      if (bodyKey !== null && headerKey !== null && bodyKey !== headerKey) {
        throw new ApiError(
          'bad_request',
          'The Idempotency-Key header and the body idempotencyKey disagree.',
        );
      }
      const idempotencyKey = bodyKey ?? headerKey;

      const ctx: RequestContext<unknown, unknown> = {
        requestId,
        method: method as HttpMethod,
        path: url.pathname,
        routePath: route.path,
        params,
        query: url.searchParams,
        body,
        rawBody,
        rawBytes,
        headers,
        auth,
        log,
        idempotencyKey,
        clientIp: clientIpOf(req, headers),
        requireAuth() {
          if (auth === null) throw new ApiError('unauthorized', 'A bearer token is required.');
          return auth;
        },
      };

      let result: RouteResult;
      let replayed = false;

      if (route.idempotent === true) {
        if (idempotencyKey === null) {
          throw new ApiError(
            'idempotency_key_required',
            'This endpoint requires an idempotency key (body `idempotencyKey` or the Idempotency-Key header).',
          );
        }
        const execution = await idempotency.run(
          {
            scope: auth?.accountId ?? `anon:${ctx.clientIp}`,
            endpoint: `${method} ${route.path}`,
            key: idempotencyKey,
            requestHash: hashRequest(method, route.path, rawBody),
          },
          async () => {
            const inner = await route.handle(ctx);
            return { status: inner.status, body: inner.body };
          },
        );
        replayed = execution.replayed;
        result = { status: execution.status, body: execution.body };
      } else {
        result = await route.handle(ctx);
      }

      const extraHeaders = {
        ...corsHeaders(headers['origin'], method === 'GET' && route.auth !== 'required'),
        ...(result.headers ?? {}),
      };
      if (replayed) extraHeaders['idempotent-replay'] = 'true';
      if (result.raw !== undefined) {
        writeBytes(res, result.status, result.raw.bytes, result.raw.contentType, extraHeaders);
      } else {
        writeJson(res, result.status, result.body, extraHeaders);
      }
      log.info('http.request', { status: result.status, ms: Date.now() - startedAt, replayed });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status >= 500) {
        log.error('http.error', { code: apiError.code, message: apiError.message, error: String(error) });
      } else {
        log.warn('http.error', { code: apiError.code, status: apiError.status, message: apiError.message });
      }
      /*
       * Errors carry the CORS headers too. Without them a 401 or a 422 reaches
       * the browser as an opaque network failure, and a console that cannot
       * read "LIVE_OPS_TOKEN is not set" is a console that looks broken for a
       * reason nobody can see — which is the exact failure this whole screen
       * exists to avoid. The route is unknown here (that may be *why* we are
       * in the catch), so the conservative, credentialed answer is used.
       */
      writeJson(
        res,
        apiError.status,
        errorEnvelope(apiError.code, apiError.message, requestId, apiError.details),
        {
          ...corsHeaders(headers['origin'], false),
          ...apiError.headers,
          'x-schema-version': SCHEMA_VERSION,
        },
      );
    }
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error;
  if (error instanceof ZodError) {
    return new ApiError('validation_failed', 'Invalid request.', {
      details: { issues: error.issues.map((i) => i.message) } as unknown as JsonValue,
    });
  }
  return new ApiError('internal_error', 'Something went wrong.', { cause: error });
}
