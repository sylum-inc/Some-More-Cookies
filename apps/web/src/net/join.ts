/**
 * How a person ends up at somebody else's fire.
 *
 * Spec §9: joining is diegetic and lobby-less, and the join *paths* are invite
 * links, camp codes, QR joins and Passport invites. All four are the same
 * thing on this wire — a `JoinMethod` presented with the first message — so
 * this module's whole job is to read one out of a URL and hand it over.
 *
 * There is no lobby, no room list and no "connect" screen: a link is walked
 * down like a trail, and if the link is wrong you simply arrive at your own
 * campsite instead, which is a perfectly good place to be (ARCHITECTURE §1.5).
 */

import { QR_JOIN_PREFIX, type JoinMethod } from '@somemore/protocol';

export interface JoinIntent {
  /** The session to walk into. */
  readonly sessionId: string;
  /** Membership proof, for somebody who is not already at this campsite. */
  readonly join?: JoinMethod;
  /**
   * An explicit socket URL.
   *
   * Present for development and for the two-browser end-to-end test, where
   * the service is on a different port from the page. In a deployment the
   * socket shares an origin with the API and this is derived.
   */
  readonly wsUrl?: string;
  /**
   * An explicit bearer token.
   *
   * Normally the client's own session token is used. This exists so a harness
   * can put two independent players in two browser contexts without either of
   * them bootstrapping an account first.
   */
  readonly token?: string;
}

/**
 * Read a join out of a query string.
 *
 * `?fire=<sessionId>` is the whole of it, plus one of `&invite=`, `&code=` or
 * `&qr=` when the arriving player is not already a member.
 */
export function parseJoin(search: string): JoinIntent | null {
  const params = new URLSearchParams(search);
  const sessionId = params.get('fire');
  if (sessionId === null || sessionId.length === 0) return null;

  const invite = params.get('invite');
  const code = params.get('code');
  const qr = params.get('qr');
  const wsUrl = params.get('ws');
  const token = params.get('token');

  let join: JoinMethod | undefined;
  if (invite !== null && invite.length >= 16) join = { method: 'invite_link', token: invite };
  else if (code !== null && code.length > 0) join = { method: 'camp_code', code: code.toUpperCase() };
  else if (qr !== null && qr.startsWith(QR_JOIN_PREFIX)) join = { method: 'qr', payload: qr };

  return {
    sessionId,
    ...(join === undefined ? {} : { join }),
    ...(wsUrl === null ? {} : { wsUrl }),
    ...(token === null ? {} : { token }),
  };
}

/**
 * The realtime endpoint for a given API base.
 *
 * An empty base means same origin, which is the deployed shape: the socket
 * shares a port, a TLS terminator and an auth model with the REST API (see
 * `attachRealtime`), so `https://` becomes `wss://` and nothing else changes.
 */
export function realtimeUrl(apiBaseUrl: string, path = '/v1/realtime', origin?: string): string {
  const base = apiBaseUrl.replace(/\/$/, '');
  const root = origin ?? (typeof location === 'undefined' ? 'http://127.0.0.1' : location.origin);

  /*
   * The base is one of three things, and all three have to work:
   *
   *  - empty, meaning "wherever this page came from" (the ordinary case);
   *  - a full URL, meaning a service on another origin (`VITE_API_URL`);
   *  - a *path*, meaning this app is served from a subdirectory and its
   *    service is behind the same prefix.
   *
   * The last is why the path is joined relatively rather than as a
   * root-absolute one. `new URL('/v1/realtime', 'http://host/prefix')` throws
   * away `/prefix` — silently, and the socket then opens against a service
   * that is not there.
   */
  const absolute = base.length === 0 ? root : base.includes('://') ? base : new URL(base, root).toString();
  const source = absolute.endsWith('/') ? absolute : `${absolute}/`;
  const url = new URL(path.replace(/^\//, ''), source);
  url.protocol = url.protocol === 'https:' ? 'wss:' : url.protocol === 'http:' ? 'ws:' : url.protocol;
  return url.toString();
}
