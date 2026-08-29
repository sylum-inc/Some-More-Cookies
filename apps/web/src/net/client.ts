/**
 * The client's view of the Some More service.
 *
 * Until this existed, the client and the API had never spoken: two
 * well-tested halves with no seam between them. Everything the Passport knew
 * lived in `localStorage` and nothing left the device.
 *
 * Two rules shape this layer:
 *
 *  1. **The ritual must never wait on the network.** Play is local-first
 *     (ARCHITECTURE §7). Every call here is allowed to fail, and failing must
 *     do nothing worse than leave the local state alone. A campsite with no
 *     signal is still a campsite.
 *  2. **The contracts are shared, not restated.** Requests and responses are
 *     validated with the same zod schemas the server uses, so a drift between
 *     the two is a type error rather than a production surprise.
 */

import type { z } from 'zod';
import {
  AuthSessionSchema,
  CampfirePassportSchema,
  CampsiteSchema,
  SandwichRecordSchema,
  SCHEMA_VERSION,
  type AuthSession,
  type CampfirePassport,
  type Campsite,
  type SandwichRecord as WireSandwichRecord,
} from '@somemore/protocol';

export interface ApiClientOptions {
  /** Base URL of the service. Empty string means same origin. */
  baseUrl?: string;
  /** Milliseconds before a request is abandoned. */
  timeoutMs?: number;
  /** Injected for tests. */
  fetchImpl?: typeof fetch;
  /** Called whenever the session token changes, so it can be persisted. */
  onSession?: (session: AuthSession | null) => void;
}

/** Why a call did not succeed. The caller decides whether to care. */
export type ApiFailure =
  | { kind: 'offline' }
  | { kind: 'timeout' }
  | { kind: 'unauthorized' }
  | { kind: 'conflict'; code: string; message: string }
  | { kind: 'server'; status: number; code: string; message: string }
  | { kind: 'malformed'; message: string };

export type ApiResult<T> = { ok: true; value: T } | { ok: false; error: ApiFailure };

const DEFAULT_TIMEOUT = 8000;

/** Deterministic-enough idempotency keys without pulling in a uuid library. */
export function idempotencyKey(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && 'getRandomValues' in crypto) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  // RFC 4122 version 4.
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class ApiClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private readonly onSession: ((session: AuthSession | null) => void) | undefined;
  private session: AuthSession | null = null;
  /** Set once a call has failed with a network error, to stop hammering. */
  private offlineUntil = 0;

  constructor(options: ApiClientOptions = {}) {
    this.baseUrl = (options.baseUrl ?? '').replace(/\/$/, '');
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
    this.fetchImpl = options.fetchImpl ?? ((...args) => fetch(...args));
    this.onSession = options.onSession;
  }

  get authenticated(): boolean {
    return this.session !== null;
  }

  get accountId(): string | null {
    return this.session?.account.id ?? null;
  }

  /** Restores a persisted session without re-bootstrapping. */
  restore(session: AuthSession | null): void {
    this.session = session;
  }

  /** True when a recent call failed with a network error. */
  get offline(): boolean {
    return Date.now() < this.offlineUntil;
  }

  // --- Identity ---------------------------------------------------------

  /**
   * Creates or resumes an anonymous account for this device.
   *
   * Anonymous play is instant and never blocks on this (spec §6.1) — the
   * caller fires it and carries on.
   */
  async bootstrap(deviceId: string, displayName?: string): Promise<ApiResult<AuthSession>> {
    const result = await this.request('POST', '/v1/auth/anonymous', AuthSessionSchema, {
      body: {
        device: {
          deviceId,
          platform: 'web',
          appVersion: SCHEMA_VERSION,
          ...(typeof navigator !== 'undefined' && navigator.language ? { locale: navigator.language } : {}),
          ...(typeof Intl !== 'undefined'
            ? { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }
            : {}),
        },
        ...(displayName ? { displayName } : {}),
      },
      authenticated: false,
    });
    if (result.ok) {
      this.session = result.value;
      this.onSession?.(result.value);
    }
    return result;
  }

  /** Links this anonymous account to a real identity, keeping its history. */
  async link(provider: 'apple' | 'google' | 'email', credential: string): Promise<ApiResult<AuthSession>> {
    const result = await this.request('POST', '/v1/auth/link', AuthSessionSchema, {
      body: { idempotencyKey: idempotencyKey(), provider, credential },
    });
    if (result.ok) {
      this.session = result.value;
      this.onSession?.(result.value);
    }
    return result;
  }

  signOut(): void {
    this.session = null;
    this.onSession?.(null);
  }

  // --- Passport ---------------------------------------------------------

  fetchPassport(): Promise<ApiResult<CampfirePassport>> {
    return this.request('GET', '/v1/passport', CampfirePassportSchema, {});
  }

  // --- Campsites --------------------------------------------------------

  /**
   * Creates the server-side campsite a sandwich record has to belong to.
   *
   * Private by default: the request omits `privacy` so the player's own
   * setting decides, and that setting is itself private (spec §9).
   */
  createCampsite(options: { name: string; environmentId: string; seed?: number }): Promise<ApiResult<Campsite>> {
    return this.request('POST', '/v1/campsites', CampsiteSchema, {
      body: {
        idempotencyKey: idempotencyKey(),
        name: options.name,
        environmentId: options.environmentId,
        ...(options.seed === undefined ? {} : { seed: options.seed }),
      },
    });
  }

  // --- Sandwiches -------------------------------------------------------

  /**
   * Records a sandwich server-side.
   *
   * The record carries the seed and the summaries, so the server can
   * re-derive the object to validate any reward attached to it (ADR-0006).
   */
  recordSandwich(body: Record<string, unknown>): Promise<ApiResult<WireSandwichRecord>> {
    return this.request('POST', '/v1/sandwiches', SandwichRecordSchema, { body });
  }

  // --- Plumbing ---------------------------------------------------------

  /**
   * One request.
   *
   * Everything funnels through here so that timeout, offline detection,
   * authentication, error shaping and response validation are decided in one
   * place rather than per call site.
   */
  private async request<S extends z.ZodType>(
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    path: string,
    schema: S,
    options: { body?: unknown; authenticated?: boolean },
  ): Promise<ApiResult<z.infer<S>>> {
    if (this.offline) return { ok: false, error: { kind: 'offline' } };

    const needsAuth = options.authenticated !== false;
    if (needsAuth && !this.session) return { ok: false, error: { kind: 'unauthorized' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'content-type': 'application/json',
          ...(needsAuth && this.session ? { authorization: `Bearer ${this.session.auth.token}` } : {}),
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });

      const text = await response.text();
      const payload: unknown = text.length > 0 ? safeJson(text) : undefined;

      if (!response.ok) {
        const envelope = payload as { error?: { code?: string; message?: string } } | undefined;
        const code = envelope?.error?.code ?? 'unknown';
        const message = envelope?.error?.message ?? response.statusText;
        if (response.status === 401 || response.status === 403) {
          // A rejected token is worse than useless; drop it so the next call
          // bootstraps cleanly instead of failing forever.
          this.session = null;
          this.onSession?.(null);
          return { ok: false, error: { kind: 'unauthorized' } };
        }
        if (response.status === 409 || code === 'idempotency_key_conflict') {
          return { ok: false, error: { kind: 'conflict', code, message } };
        }
        return { ok: false, error: { kind: 'server', status: response.status, code, message } };
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        // The server said yes but sent something this build does not
        // understand — most likely a schema version drift.
        return { ok: false, error: { kind: 'malformed', message: 'Response did not match the shared contract.' } };
      }
      return { ok: true, value: parsed.data as z.infer<S> };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: { kind: 'timeout' } };
      }
      // Back off briefly so a dead server does not cost a request per action.
      this.offlineUntil = Date.now() + 5000;
      return { ok: false, error: { kind: 'offline' } };
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * A stable per-device identifier.
 *
 * Not a fingerprint: a random value this device generated and stored, which
 * is what lets an anonymous Passport survive a reload without asking anyone
 * to sign in.
 */
export function deviceId(): string {
  const KEY = 'some-more/device/v1';
  try {
    const existing = localStorage.getItem(KEY);
    if (existing) return existing;
    const created = idempotencyKey();
    localStorage.setItem(KEY, created);
    return created;
  } catch {
    return idempotencyKey();
  }
}
