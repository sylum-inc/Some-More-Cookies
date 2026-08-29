import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  SCHEMA_VERSION,
  containsRawCardData,
  type ApiErrorCode,
  type ErrorEnvelope,
  type JsonValue,
} from '@somemore/protocol';
import { ApiError } from '../errors.js';
import type { Logger } from '../logging.js';

export type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

export interface AuthContext {
  readonly accountId: string;
  readonly token: string;
  readonly issuedAt: Date;
  readonly expiresAt: Date;
}

export interface RequestContext<Params, Body> {
  readonly requestId: string;
  readonly method: HttpMethod;
  readonly path: string;
  readonly routePath: string;
  readonly params: Params;
  readonly query: URLSearchParams;
  readonly body: Body;
  readonly rawBody: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly auth: AuthContext | null;
  readonly log: Logger;
  readonly idempotencyKey: string | null;
  readonly clientIp: string;
  /** Throws `unauthorized` when the route was declared `auth: 'optional'`. */
  requireAuth(): AuthContext;
}

export interface RouteResult {
  readonly status: number;
  readonly body?: unknown;
  readonly headers?: Record<string, string>;
}

export type AuthRequirement = 'required' | 'optional' | 'none';

export interface Route<Params = unknown, Body = unknown> {
  readonly method: HttpMethod;
  /** Pattern with `:name` segments, e.g. `/v1/campsites/:campsiteId`. */
  readonly path: string;
  readonly auth: AuthRequirement;
  readonly summary: string;
  readonly params?: z.ZodType<Params>;
  readonly body?: z.ZodType<Body>;
  /** When true the route is replay-protected and requires an idempotency key. */
  readonly idempotent?: boolean;
  /** Raw-body routes (payment webhooks) skip JSON parsing and the card scan. */
  readonly rawBodyOnly?: boolean;
  handle(ctx: RequestContext<Params, Body>): Promise<RouteResult> | RouteResult;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export type AnyRoute = Route<any, any>;

/** Helper that preserves per-route generics while allowing a mixed table. */
export function defineRoute<Params, Body>(route: Route<Params, Body>): AnyRoute {
  return route as AnyRoute;
}

interface CompiledRoute {
  readonly route: AnyRoute;
  readonly segments: readonly string[];
  readonly paramNames: readonly string[];
}

export interface MatchResult {
  readonly route: AnyRoute;
  readonly params: Record<string, string>;
}

export class Router {
  private readonly compiled: CompiledRoute[] = [];

  constructor(routes: readonly AnyRoute[] = []) {
    for (const route of routes) this.add(route);
  }

  add(route: AnyRoute): this {
    const segments = splitPath(route.path);
    const paramNames = segments.filter((s) => s.startsWith(':')).map((s) => s.slice(1));
    this.compiled.push({ route, segments, paramNames });
    return this;
  }

  get routes(): readonly AnyRoute[] {
    return this.compiled.map((c) => c.route);
  }

  /**
   * Returns the matched route, or the set of methods allowed at this path when
   * the path matches but the method does not (so we can answer 405 honestly).
   */
  match(method: string, path: string): MatchResult | { allowed: HttpMethod[] } | null {
    const segments = splitPath(path);
    const allowed = new Set<HttpMethod>();
    for (const candidate of this.compiled) {
      const params = matchSegments(candidate.segments, segments);
      if (params === null) continue;
      allowed.add(candidate.route.method);
      if (candidate.route.method === method) return { route: candidate.route, params };
    }
    if (allowed.size > 0) return { allowed: [...allowed] };
    return null;
  }
}

function splitPath(path: string): string[] {
  return path.split('/').filter((s) => s.length > 0);
}

function matchSegments(pattern: readonly string[], actual: readonly string[]): Record<string, string> | null {
  if (pattern.length !== actual.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i += 1) {
    const p = pattern[i];
    const a = actual[i];
    if (p === undefined || a === undefined) return null;
    if (p.startsWith(':')) {
      const decoded = safeDecode(a);
      if (decoded === null) return null;
      params[p.slice(1)] = decoded;
      continue;
    }
    if (p !== a) return null;
  }
  return params;
}

function safeDecode(value: string): string | null {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Wire helpers                                                                */
/* -------------------------------------------------------------------------- */

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`;
}

export function hashRequest(method: string, routePath: string, rawBody: string): string {
  return createHash('sha256').update(`${method} ${routePath}\n${rawBody}`).digest('hex');
}

export function errorEnvelope(code: ApiErrorCode, message: string, requestId: string, details?: JsonValue): ErrorEnvelope {
  return details === undefined
    ? { error: { code, message, requestId } }
    : { error: { code, message, requestId, details } };
}

export function normalizeHeaders(raw: IncomingMessage['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[key.toLowerCase()] = Array.isArray(value) ? value.join(',') : value;
  }
  return out;
}

export async function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.byteLength;
    if (size > maxBytes) {
      throw new ApiError('payload_too_large', `Request body exceeds ${maxBytes} bytes.`);
    }
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function parseJsonBody(rawBody: string, contentType: string | undefined): unknown {
  if (rawBody.trim().length === 0) return {};
  if (contentType !== undefined && !contentType.includes('application/json')) {
    throw new ApiError('unsupported_media_type', 'Expected application/json.');
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(rawBody);
  } catch {
    throw new ApiError('bad_request', 'Request body is not valid JSON.');
  }
  if (containsRawCardData(decoded)) {
    // Loud, deliberate rejection: we are never in PCI scope for raw card data.
    throw new ApiError(
      'raw_card_data_rejected',
      'Raw card data must never be sent to this API. Tokenize with the payment provider SDK instead.',
    );
  }
  return decoded;
}

export function validate<T>(schema: z.ZodType<T>, value: unknown, where: 'body' | 'params' | 'query'): T {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  const details = result.error.issues.map((issue) => ({
    path: issue.path.map((p) => String(p)).join('.'),
    code: issue.code,
    message: issue.message,
  }));
  throw new ApiError('validation_failed', `Invalid request ${where}.`, {
    details: { where, issues: details } as unknown as JsonValue,
  });
}

export function writeJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload).toString(),
    'x-schema-version': SCHEMA_VERSION,
    ...headers,
  });
  res.end(payload);
}
