/**
 * The live-ops console's view of the service.
 *
 * ## Why this is a second app and not a route in the player client
 *
 * Every authoring route exists and none of them had a screen; the README calls
 * that Blocker 15 and says, correctly, that `curl` is fine for an engineer and
 * not fine for the person who schedules a meteor-shower weekend. This is that
 * screen. It lives in `apps/console/` rather than behind a flag in `apps/web/`
 * for three reasons, in order of how much they matter:
 *
 *  1. **A staff capability must not ship to players.** A route inside the
 *     player build ships the console's code, its route table and its shape to
 *     every phone, whether or not it is reachable. "Inert without a token" is a
 *     runtime property; not being in the bundle is a build property, and only
 *     one of those survives somebody reading the JavaScript.
 *  2. **The ops token must never be in a player build.** In a single app the
 *     obvious mistake is one `VITE_LIVE_OPS_TOKEN` away, and a `VITE_` variable
 *     is a string in a static asset that gets served, cached and copied. Here
 *     there is no such variable at all: the token is typed in by a person and
 *     held in `sessionStorage` for the length of a tab. Look for it in
 *     `vite.config.ts` — the absence is the point.
 *  3. **They are different products.** The campfire is warm paper and stamped
 *     ink; this is a terminal that has to show a hundred documents, a dotted
 *     validation path and a release number at two in the morning. Sharing a
 *     visual language would make both worse.
 *
 * The cost is a second deployment target, which is the right trade: it is
 * deployed behind whatever the operator network is, and a player never receives
 * a byte of it.
 *
 * ## Both credentials, honestly
 *
 * Every authoring call needs a bearer token *and* `x-somemore-ops-token`
 * (README, "Authoring authentication, and what it is not"). With no
 * `LIVE_OPS_TOKEN` on the service, the routes answer `503
 * service_not_configured` naming the variable — so this client surfaces that as
 * its own state rather than as a failure, because a deployment that has not
 * been given a token is not broken, it is read-only.
 */

import {
  CodeBatchSchema,
  CodeSigningStatusSchema,
  ContentDocumentSchema,
  ContentManifestSchema,
  ContentReleaseSchema,
  ContentValidationResultSchema,
  LiveOpsStatusSchema,
  MintCodesResultSchema,
  type CodeBatch,
  type CodeSigningStatus,
  type ContentDocument,
  type ContentKind,
  type ContentManifest,
  type ContentRelease,
  type ContentStatus,
  type ContentValidationResult,
  type LiveOpsStatus,
  type MintCodesResult,
} from '@somemore/protocol';
import { z } from 'zod';

export const OPS_TOKEN_HEADER = 'x-somemore-ops-token';

/** Why a call did not succeed, in the shapes the console has to render. */
export type OpsFailure =
  /** No `LIVE_OPS_TOKEN` on the service. Reads still work; authoring does not. */
  | { kind: 'not_configured'; message: string }
  /** Bearer token or ops token wrong or missing. */
  | { kind: 'unauthorized'; message: string }
  /** A document did not pass the publish gate. Dotted paths, all of them. */
  | { kind: 'invalid'; message: string; issues: { path: string; message: string }[] }
  | { kind: 'conflict'; message: string }
  | { kind: 'server'; status: number; code: string; message: string }
  | { kind: 'offline'; message: string }
  | { kind: 'malformed'; message: string };

export type OpsResult<T> = { ok: true; value: T } | { ok: false; error: OpsFailure };

export function describeFailure(failure: OpsFailure): string {
  return failure.message;
}

/** RFC 4122 v4, without a dependency. Every authoring write needs one. */
export function idempotencyKey(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export interface Credentials {
  baseUrl: string;
  /** An ordinary player bearer token. The audit trail hangs off its account. */
  bearer: string;
  /** The shared `LIVE_OPS_TOKEN`. Never persisted beyond this tab. */
  opsToken: string;
}

const SESSION_KEY = 'some-more-console/credentials/v1';

/**
 * Credentials live in `sessionStorage`, not `localStorage`.
 *
 * A shared staff secret that outlives the tab is a shared staff secret on a
 * laptop somebody leaves in a café. This is not RBAC and does not pretend to be
 * (README, Blocker 9); the least it can do is not persist.
 */
export function loadCredentials(): Credentials {
  const fallback: Credentials = { baseUrl: 'http://127.0.0.1:8787', bearer: '', opsToken: '' };
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return fallback;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return fallback;
    const record = parsed as Record<string, unknown>;
    return {
      baseUrl: typeof record['baseUrl'] === 'string' ? record['baseUrl'] : fallback.baseUrl,
      bearer: typeof record['bearer'] === 'string' ? record['bearer'] : '',
      opsToken: typeof record['opsToken'] === 'string' ? record['opsToken'] : '',
    };
  } catch {
    return fallback;
  }
}

export function saveCredentials(credentials: Credentials): void {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
  } catch {
    /* A locked-down browser just means typing it in again. */
  }
}

export function forgetCredentials(): void {
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* ignore */
  }
}

interface RequestOptions {
  method?: 'GET' | 'POST';
  body?: unknown;
  /** Authoring routes need the ops header; reads and status do not. */
  ops?: boolean;
}

export class OpsClient {
  constructor(private credentials: Credentials) {}

  update(credentials: Credentials): void {
    this.credentials = credentials;
  }

  get baseUrl(): string {
    return this.credentials.baseUrl.replace(/\/$/, '');
  }

  private async request<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<OpsResult<z.infer<S>>> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (this.credentials.bearer.length > 0) {
      headers['authorization'] = `Bearer ${this.credentials.bearer}`;
    }
    if (options.ops !== false && this.credentials.opsToken.length > 0) {
      headers[OPS_TOKEN_HEADER] = this.credentials.opsToken;
    }
    if (options.body !== undefined) headers['content-type'] = 'application/json';

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method: options.method ?? (options.body === undefined ? 'GET' : 'POST'),
        headers,
        /*
         * Never read a cached answer.
         *
         * Found by publishing a document and screenshotting the result: the
         * "what a phone gets" panel still said *release 0, 0 documents* while
         * the banner said release 1 was live. The manifest is served
         * `public, max-age=60` — which is exactly right for a player's phone,
         * and exactly wrong for the person who just pressed publish and needs
         * to know whether it worked. A console that shows a launch as
         * not-happened for a minute is a console people stop trusting, and at
         * 2am they go back to `curl`.
         *
         * Every read here is "what is true right now", so no read here is
         * cacheable. This is the console's problem to solve, not the service's:
         * the cache header on the manifest stays as it is.
         */
        cache: 'no-store',
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      });
    } catch {
      return {
        ok: false,
        error: { kind: 'offline', message: `Cannot reach ${this.baseUrl}. Is the service running?` },
      };
    }

    const text = await response.text();
    let payload: unknown;
    try {
      payload = text.length === 0 ? undefined : JSON.parse(text);
    } catch {
      payload = undefined;
    }

    if (!response.ok) {
      const envelope = payload as
        | { error?: { code?: string; message?: string; details?: { issues?: unknown } } }
        | undefined;
      const code = envelope?.error?.code ?? 'unknown';
      const message = envelope?.error?.message ?? response.statusText;

      if (code === 'service_not_configured') {
        return { ok: false, error: { kind: 'not_configured', message } };
      }
      if (response.status === 401 || response.status === 403) {
        return { ok: false, error: { kind: 'unauthorized', message } };
      }
      if (code === 'content_invalid') {
        // The whole point of the publish gate: every problem at once, each with
        // a dotted path an author can act on.
        const parsed = z
          .array(z.object({ path: z.string(), message: z.string() }))
          .safeParse(envelope?.error?.details?.issues);
        return {
          ok: false,
          error: { kind: 'invalid', message, issues: parsed.success ? parsed.data : [] },
        };
      }
      if (response.status === 409) return { ok: false, error: { kind: 'conflict', message } };
      return { ok: false, error: { kind: 'server', status: response.status, code, message } };
    }

    const parsed = schema.safeParse(payload);
    if (!parsed.success) {
      return {
        ok: false,
        error: {
          kind: 'malformed',
          message: 'The service answered in a shape this console does not know. Schema drift?',
        },
      };
    }
    return { ok: true, value: parsed.data as z.infer<S> };
  }

  /* --- signing in ------------------------------------------------------- */

  /**
   * An anonymous bearer token, for local development.
   *
   * A live-ops action is attributed to a real account id, which is the one
   * thing the shared-secret gate gets right. Against a dev service there is no
   * operator identity provider to sign into (Blocker 9), so an anonymous
   * account is the honest stand-in and is labelled as one in the UI.
   */
  async signInAnonymously(): Promise<OpsResult<{ token: string; accountId: string }>> {
    const result = await this.request(
      '/v1/auth/anonymous',
      z.object({ auth: z.object({ token: z.string() }), account: z.object({ id: z.string() }) }),
      {
        method: 'POST',
        ops: false,
        body: {
          device: { deviceId: `console-${idempotencyKey()}`, platform: 'web', appVersion: '0.0.0' },
          displayName: 'Live Ops',
        },
      },
    );
    return result.ok
      ? { ok: true, value: { token: result.value.auth.token, accountId: result.value.account.id } }
      : result;
  }

  /* --- status ----------------------------------------------------------- */

  status(): Promise<OpsResult<{ liveOps: LiveOpsStatus; codes: CodeSigningStatus }>> {
    return this.request(
      '/v1/live-ops/status',
      z.object({ liveOps: LiveOpsStatusSchema, codes: CodeSigningStatusSchema }),
    );
  }

  /* --- content ---------------------------------------------------------- */

  /** The manifest exactly as a player's phone would receive it. */
  manifest(): Promise<OpsResult<ContentManifest>> {
    return this.request('/v1/content/manifest', ContentManifestSchema, { ops: false });
  }

  /** Dry-run the publish gate. Writes nothing; the fastest possible feedback. */
  validate(kind: ContentKind, body: unknown): Promise<OpsResult<ContentValidationResult>> {
    return this.request('/v1/live-ops/documents/validate', ContentValidationResultSchema, {
      method: 'POST',
      body: { kind, body },
    });
  }

  async listDocuments(filter: {
    kind?: ContentKind;
    slug?: string;
    status?: ContentStatus;
  } = {}): Promise<OpsResult<ContentDocument[]>> {
    const query = new URLSearchParams();
    if (filter.kind) query.set('kind', filter.kind);
    if (filter.slug) query.set('slug', filter.slug);
    if (filter.status) query.set('status', filter.status);
    const suffix = query.toString();
    const result = await this.request(
      `/v1/live-ops/documents${suffix.length > 0 ? `?${suffix}` : ''}`,
      z.object({ items: z.array(ContentDocumentSchema) }),
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  createDocument(request: {
    kind: ContentKind;
    slug: string;
    title: string;
    body: unknown;
    activation: { startsAt: string | null; endsAt: string | null } | null;
    notes: string;
  }): Promise<OpsResult<ContentDocument>> {
    return this.request('/v1/live-ops/documents', ContentDocumentSchema, {
      method: 'POST',
      body: { idempotencyKey: idempotencyKey(), ...request },
    });
  }

  transition(documentId: string, to: ContentStatus, notes = ''): Promise<OpsResult<ContentDocument>> {
    return this.request(
      `/v1/live-ops/documents/${encodeURIComponent(documentId)}/transitions`,
      ContentDocumentSchema,
      { method: 'POST', body: { idempotencyKey: idempotencyKey(), to, notes } },
    );
  }

  async listReleases(limit = 50): Promise<OpsResult<ContentRelease[]>> {
    const result = await this.request(
      `/v1/live-ops/releases?limit=${limit}`,
      z.object({ items: z.array(ContentReleaseSchema) }),
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  /** Forward-only: this creates a *new* release reproducing an old one. */
  rollback(toVersion: number, note: string): Promise<OpsResult<ContentRelease>> {
    return this.request('/v1/live-ops/releases/rollback', ContentReleaseSchema, {
      method: 'POST',
      body: { idempotencyKey: idempotencyKey(), toVersion, note },
    });
  }

  /* --- code batches ----------------------------------------------------- */

  async listBatches(): Promise<OpsResult<CodeBatch[]>> {
    const result = await this.request(
      '/v1/live-ops/code-batches',
      z.object({ items: z.array(CodeBatchSchema) }),
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  createBatch(request: {
    label: string;
    kind: 'pkg' | 'evt' | 'camp';
    entitlement: unknown;
    plannedSize: number;
    perAccountLimit: number;
    codeTtlDays: number | null;
    activeFrom: string | null;
    activeUntil: string | null;
  }): Promise<OpsResult<CodeBatch>> {
    return this.request('/v1/live-ops/code-batches', CodeBatchSchema, {
      method: 'POST',
      body: { idempotencyKey: idempotencyKey(), ...request },
    });
  }

  /**
   * Mint a run.
   *
   * The response is the only copy that will ever exist — the service does not
   * store codes, by design, so a lost print file is a reprint. The UI says so
   * next to the download, because that is a thing an operator has to know
   * *before* they close the tab.
   */
  mint(batchId: string, count: number): Promise<OpsResult<MintCodesResult>> {
    return this.request(
      `/v1/live-ops/code-batches/${encodeURIComponent(batchId)}/mint`,
      MintCodesResultSchema,
      { method: 'POST', body: { idempotencyKey: idempotencyKey(), count } },
    );
  }

  retire(batchId: string, reason: string): Promise<OpsResult<CodeBatch>> {
    return this.request(
      `/v1/live-ops/code-batches/${encodeURIComponent(batchId)}/retire`,
      CodeBatchSchema,
      { method: 'POST', body: { idempotencyKey: idempotencyKey(), reason } },
    );
  }
}

/* -------------------------------------------------------------------------- */
/* Authoring helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * A starting document for each kind.
 *
 * Not a toy: these pass the validator as written, so an author's first action
 * is editing something real rather than debugging an empty object. The seasonal
 * event is the meteor-shower weekend the README keeps using as the example,
 * because that is the thing this console exists for.
 */
export const TEMPLATES: Readonly<Record<ContentKind, string>> = {
  seasonal_event: JSON.stringify(
    {
      id: 'perseids_weekend',
      name: 'Perseids Weekend',
      tagline: 'The sky is busy this weekend. Look up.',
      kind: 'sky-event',
      environments: ['*'],
      skyEvent: 'meteor-shower',
      intensity: 0.75,
      rewardCodes: [],
      stations: [],
      performanceCost: 'light',
      note: 'Three nights in August. Gifts, never gates — a player who misses it loses nothing.',
    },
    null,
    2,
  ),
  station_programming: JSON.stringify(
    {
      id: 'night_freight',
      name: 'Night Freight',
      environments: ['*'],
      stations: [
        {
          id: 'night_freight_1',
          dial: 91.7,
          band: 'fm',
          name: 'Night Freight',
          character: 'lofi',
          reception: 0.62,
          note: 'A tape loop somebody left running in a signal hut.',
        },
      ],
      note: 'Extra programming, everywhere, for as long as the window is open.',
    },
    null,
    2,
  ),
  reward_definition: JSON.stringify(
    {
      // A reward is a protocol contract rather than content, so it is checked
      // by `RewardDefinitionSchema`, and `code` — not `id` — has to equal the
      // document slug. The service says so with a dotted path if it does not.
      id: 'rwd_wrapper_patch',
      code: 'wrapper_patch',
      kind: 'patch',
      name: 'Wrapper Patch',
      description: 'For the first box.',
      rarity: 'uncommon',
      valueTier: 'standard',
      points: 0,
      payloadCode: null,
      prerequisites: [],
      perAccountLimit: 1,
      globalLimit: null,
      globalClaimed: 0,
      availableFrom: null,
      availableUntil: null,
      active: true,
    },
    null,
    2,
  ),
  environment: JSON.stringify(
    {
      id: 'replace_me',
      note: 'A whole environment is a large authored thing. Paste one from packages/content and edit it.',
    },
    null,
    2,
  ),
};

/** The legal next steps from a status, mirroring `CONTENT_TRANSITIONS`. */
export const NEXT_STATUS: Readonly<Record<ContentStatus, readonly ContentStatus[]>> = {
  draft: ['staged', 'retired'],
  staged: ['published', 'draft', 'retired'],
  published: ['retired'],
  retired: [],
};
