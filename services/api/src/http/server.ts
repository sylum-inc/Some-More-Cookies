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
  readBody,
  validate,
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
      if (!METHODS.includes(method)) throw new ApiError('method_not_allowed', `${method} is not supported.`);

      const matched = router.match(method, url.pathname);
      if (matched === null) throw new ApiError('not_found', `No route for ${method} ${url.pathname}.`);
      if (!('route' in matched)) {
        throw new ApiError('method_not_allowed', `${method} is not allowed here.`, {
          headers: { allow: matched.allowed.join(', ') },
        });
      }

      const { route, params: rawParams } = matched;
      const rawBody = await readBody(req, config.maxBodyBytes);
      const parsedBody =
        route.rawBodyOnly === true ? {} : parseJsonBody(rawBody, headers['content-type']);

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

      const extraHeaders = { ...(result.headers ?? {}) };
      if (replayed) extraHeaders['idempotent-replay'] = 'true';
      writeJson(res, result.status, result.body, extraHeaders);
      log.info('http.request', { status: result.status, ms: Date.now() - startedAt, replayed });
    } catch (error) {
      const apiError = toApiError(error);
      if (apiError.status >= 500) {
        log.error('http.error', { code: apiError.code, message: apiError.message, error: String(error) });
      } else {
        log.warn('http.error', { code: apiError.code, status: apiError.status, message: apiError.message });
      }
      writeJson(
        res,
        apiError.status,
        errorEnvelope(apiError.code, apiError.message, requestId, apiError.details),
        { ...apiError.headers, 'x-schema-version': SCHEMA_VERSION },
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
