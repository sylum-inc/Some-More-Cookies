/**
 * The RFC 6455 opening handshake.
 *
 * A WebSocket upgrade is an ordinary HTTP request that we answer with 101 and
 * a proof that we understood it: `base64(sha1(clientKey + GUID))`. That is the
 * entire cryptographic content of the handshake — it exists to defend caches
 * and proxies from being tricked into treating the stream as HTTP, not to
 * authenticate anybody. Authentication is the bearer token, checked separately.
 */

import { createHash, randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import {
  REALTIME_BEARER_SUBPROTOCOL_PREFIX,
  REALTIME_SUBPROTOCOL,
} from '@somemore/protocol';

/** The magic string from RFC 6455 §1.3. Not a secret; it is in the RFC. */
export const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const WS_VERSION = '13';

/** `Sec-WebSocket-Accept` for a given client key. */
export function acceptKey(clientKey: string): string {
  return createHash('sha1').update(`${clientKey}${WS_GUID}`, 'utf8').digest('base64');
}

/** A fresh 16-byte client nonce, base64 encoded (§4.1). */
export function generateClientKey(): string {
  return randomBytes(16).toString('base64');
}

function headerValue(headers: IncomingHttpHeaders, name: string): string | undefined {
  const raw = headers[name];
  if (raw === undefined) return undefined;
  return Array.isArray(raw) ? raw.join(', ') : raw;
}

export interface HandshakeRejection {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

export interface HandshakeRequest {
  readonly key: string;
  readonly subprotocols: readonly string[];
  /** Bearer token, from the header, the query string, or the subprotocol list. */
  readonly token: string | null;
  readonly url: URL;
}

/**
 * Validate an upgrade request.
 *
 * Returns either the parsed request or a rejection to write back as a plain
 * HTTP response — a failed upgrade is answered with HTTP, not with a close
 * frame, because there is no WebSocket yet.
 */
export function parseUpgradeRequest(input: {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingHttpHeaders;
}): { ok: true; request: HandshakeRequest } | { ok: false; rejection: HandshakeRejection } {
  const method = (input.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    return { ok: false, rejection: { status: 405, code: 'method_not_allowed', message: 'Upgrade requires GET.' } };
  }

  const upgrade = headerValue(input.headers, 'upgrade');
  if (upgrade === undefined || upgrade.toLowerCase() !== 'websocket') {
    return { ok: false, rejection: { status: 400, code: 'bad_request', message: 'Expected Upgrade: websocket.' } };
  }

  const connection = headerValue(input.headers, 'connection') ?? '';
  if (!connection.toLowerCase().split(',').some((part) => part.trim() === 'upgrade')) {
    return { ok: false, rejection: { status: 400, code: 'bad_request', message: 'Expected Connection: Upgrade.' } };
  }

  const version = headerValue(input.headers, 'sec-websocket-version');
  if (version !== WS_VERSION) {
    return {
      ok: false,
      rejection: { status: 426, code: 'bad_request', message: 'Only WebSocket version 13 is supported.' },
    };
  }

  const key = headerValue(input.headers, 'sec-websocket-key');
  if (key === undefined || !isValidClientKey(key)) {
    return { ok: false, rejection: { status: 400, code: 'bad_request', message: 'Missing or malformed Sec-WebSocket-Key.' } };
  }

  const host = headerValue(input.headers, 'host') ?? 'localhost';
  let url: URL;
  try {
    url = new URL(input.url ?? '/', `http://${host}`);
  } catch {
    return { ok: false, rejection: { status: 400, code: 'bad_request', message: 'Malformed request target.' } };
  }

  const subprotocols = (headerValue(input.headers, 'sec-websocket-protocol') ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  return {
    ok: true,
    request: { key, subprotocols, token: extractToken(input.headers, url, subprotocols), url },
  };
}

/** 16 random bytes, base64 encoded — 24 characters ending in `==`. */
export function isValidClientKey(key: string): boolean {
  if (!/^[A-Za-z0-9+/]{22}==$/.test(key)) return false;
  return Buffer.from(key, 'base64').length === 16;
}

/**
 * Three ways to present a bearer token, because browsers cannot set headers on
 * a WebSocket:
 *
 *  1. `Authorization: Bearer …`     — native and mobile clients
 *  2. `somemore.bearer.<token>` in `Sec-WebSocket-Protocol` — browsers
 *  3. `?token=…`                    — last resort; it lands in access logs, so
 *                                     it is accepted but not recommended.
 */
export function extractToken(
  headers: IncomingHttpHeaders,
  url: URL,
  subprotocols: readonly string[],
): string | null {
  const authorization = headerValue(headers, 'authorization');
  if (authorization !== undefined) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    const token = match?.[1]?.trim();
    if (token !== undefined && token.length > 0) return token;
  }
  for (const protocol of subprotocols) {
    if (protocol.startsWith(REALTIME_BEARER_SUBPROTOCOL_PREFIX)) {
      const token = protocol.slice(REALTIME_BEARER_SUBPROTOCOL_PREFIX.length);
      if (token.length > 0) return token;
    }
  }
  const query = url.searchParams.get('token');
  return query !== null && query.length > 0 ? query : null;
}

/** The 101 response. `\r\n` line endings, terminated by a blank line. */
export function buildAcceptResponse(key: string, options: { subprotocol?: string | null } = {}): string {
  const lines = [
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
  ];
  if (options.subprotocol !== undefined && options.subprotocol !== null) {
    lines.push(`Sec-WebSocket-Protocol: ${options.subprotocol}`);
  }
  return `${lines.join('\r\n')}\r\n\r\n`;
}

/** A failed upgrade, as an HTTP response with the service's error envelope. */
export function buildRejectionResponse(rejection: HandshakeRejection, requestId: string): string {
  const body = JSON.stringify({
    error: { code: rejection.code, message: rejection.message, requestId },
  });
  const bytes = Buffer.byteLength(body, 'utf8');
  return [
    `HTTP/1.1 ${rejection.status} ${statusText(rejection.status)}`,
    'Content-Type: application/json; charset=utf-8',
    `Content-Length: ${bytes}`,
    `x-request-id: ${requestId}`,
    'Connection: close',
    '',
    body,
  ].join('\r\n');
}

function statusText(status: number): string {
  switch (status) {
    case 400:
      return 'Bad Request';
    case 401:
      return 'Unauthorized';
    case 403:
      return 'Forbidden';
    case 404:
      return 'Not Found';
    case 405:
      return 'Method Not Allowed';
    case 426:
      return 'Upgrade Required';
    case 429:
      return 'Too Many Requests';
    case 503:
      return 'Service Unavailable';
    default:
      return 'Error';
  }
}

/** Pick the sub-protocol to echo. We only ever speak one. */
export function negotiateSubprotocol(offered: readonly string[]): string | null {
  return offered.includes(REALTIME_SUBPROTOCOL) ? REALTIME_SUBPROTOCOL : null;
}

/** Client side: does this 101 response actually answer our key? */
export function verifyAcceptResponse(rawHead: string, sentKey: string): { ok: true; subprotocol: string | null } | { ok: false; reason: string } {
  const [statusLine = '', ...headerLines] = rawHead.split('\r\n');
  const status = /^HTTP\/1\.1 (\d{3})/.exec(statusLine)?.[1];
  if (status !== '101') return { ok: false, reason: `Server answered ${status ?? statusLine} instead of 101.` };

  const headers = new Map<string, string>();
  for (const line of headerLines) {
    const index = line.indexOf(':');
    if (index <= 0) continue;
    headers.set(line.slice(0, index).trim().toLowerCase(), line.slice(index + 1).trim());
  }
  if ((headers.get('upgrade') ?? '').toLowerCase() !== 'websocket') return { ok: false, reason: 'Missing Upgrade: websocket.' };
  if (!(headers.get('connection') ?? '').toLowerCase().includes('upgrade')) return { ok: false, reason: 'Missing Connection: Upgrade.' };
  const accept = headers.get('sec-websocket-accept');
  if (accept !== acceptKey(sentKey)) return { ok: false, reason: 'Sec-WebSocket-Accept does not match the key we sent.' };
  return { ok: true, subprotocol: headers.get('sec-websocket-protocol') ?? null };
}
