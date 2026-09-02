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

import {
  AuthSessionSchema,
  CampfirePassportSchema,
  CodeRedemptionSchema,
  CodeVerificationKeysSchema,
  RedeemCodeResultSchema,
  CampsiteMemoryStateSchema,
  CampsiteSchema,
  CampsiteSummarySchema,
  PhotoUploadTicketSchema,
  StoredPhotoSchema,
  CartSchema,
  CartQuoteSchema,
  OrderSchema,
  PaymentIntentResponseSchema,
  ProductSchema,
  RewardGrantSchema,
  SandwichRecordSchema,
  SCHEMA_VERSION,
  type Address,
  type AuthSession,
  type CampfirePassport,
  type Campsite,
  type CampsiteMemorySnapshot,
  type CampsiteMemoryState,
  type CampsiteSummary,
  type PhotoUploadTicket,
  type RequestPhotoUploadRequest,
  type StoredPhoto,
  type CodeRedemption,
  type CodeVerificationKeys,
  type Cart,
  type Money,
  type CartQuote,
  type Order,
  type PaymentIntentResponse,
  type PaymentMethodType,
  type Product,
  type RedeemCodeResult,
  type RewardGrant,
  type SandwichRecord as WireSandwichRecord,
} from '@somemore/protocol';
import { z } from 'zod';

/**
 * The subset of `/v1/meta` the client acts on.
 *
 * Deliberately loose: a deployment is allowed to report capabilities this
 * build has never heard of, and a client that refuses to parse an unfamiliar
 * field would break on the next service release rather than ignore it.
 */
export const ServiceMetaSchema = z
  .object({
    schemaVersion: z.string(),
    apiVersion: z.string(),
    paymentProvider: z.string(),
    paymentsConfigured: z.boolean(),
    persistence: z.string(),
  })
  .loose();
export type ServiceMeta = z.infer<typeof ServiceMetaSchema>;

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

/**
 * Where the service is, when nobody has said.
 *
 * The app's own base with the trailing slash off — so `''` for every ordinary
 * build, which is byte-for-byte what it was, and `/Some-More-Cookies` for one
 * served from a subdirectory. An app that carries its own base should ask for
 * its service relative to itself: a root-absolute `/v1/...` from a project
 * page is not this app's service, it is whatever else that account publishes
 * at its root.
 *
 * `VITE_API_URL` still wins, for a service on another origin entirely.
 */
export function defaultApiBaseUrl(): string {
  const base = typeof import.meta.env === 'undefined' ? '/' : (import.meta.env.BASE_URL ?? '/');
  return base.replace(/\/$/, '');
}

/**
 * Where the service is, taking the build's word for it only when it said
 * something.
 *
 * `VITE_API_URL` is baked in at build time, and a build that was given the
 * variable *empty* — the Pages workflow does exactly that when its `api_url`
 * input is left blank — bakes in `""`, which a `??` fallback keeps. The first
 * deploy asked `github.io` for `/v1/auth/anonymous` at the account's root for
 * precisely that reason. Blank means nobody said, and nobody said means
 * relative to the app, which is what {@link defaultApiBaseUrl} is for.
 */
export function apiBaseUrlFrom(env: Record<string, unknown>, fallback: string): string {
  const configured = env['VITE_API_URL'];
  if (typeof configured !== 'string') return fallback;
  const trimmed = configured.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

/** {@link apiBaseUrlFrom} with this build's own environment. */
export function apiBaseUrl(): string {
  const env = typeof import.meta.env === 'undefined' ? {} : (import.meta.env as Record<string, unknown>);
  return apiBaseUrlFrom(env, defaultApiBaseUrl());
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

  /** The campsites this account belongs to. How a second device finds them. */
  async listCampsites(): Promise<ApiResult<CampsiteSummary[]>> {
    const result = await this.request(
      'GET',
      '/v1/campsites',
      z.object({ items: z.array(CampsiteSummarySchema) }),
      {},
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  fetchCampsite(campsiteId: string): Promise<ApiResult<Campsite>> {
    return this.request('GET', `/v1/campsites/${encodeURIComponent(campsiteId)}`, CampsiteSchema, {});
  }

  // --- Campsite memory ---------------------------------------------------
  //
  // What a campsite remembers about a player used to live in one device's
  // `localStorage` and nowhere else, so losing the phone lost every place that
  // had met you. These three calls are the other half of that.
  //
  // Nothing here carries a significance score, and the protocol has nowhere to
  // put one (`@somemore/protocol`, `memory.ts`): a synced trace is an id, a
  // kind, a birth time and a disposition, and the evidence the model weighed
  // stays on the device that produced it.

  /** Fold this device's account of a campsite into the merged memory. */
  syncCampsiteMemory(
    campsiteId: string,
    snapshot: CampsiteMemorySnapshot,
  ): Promise<ApiResult<CampsiteMemoryState>> {
    return this.request(
      'PUT',
      `/v1/campsites/${encodeURIComponent(campsiteId)}/memory`,
      CampsiteMemoryStateSchema,
      { body: snapshot },
    );
  }

  fetchCampsiteMemory(campsiteId: string): Promise<ApiResult<CampsiteMemoryState>> {
    return this.request(
      'GET',
      `/v1/campsites/${encodeURIComponent(campsiteId)}/memory`,
      CampsiteMemoryStateSchema,
      {},
    );
  }

  /** Every campsite that remembers this account — what a new device restores. */
  async listCampsiteMemories(): Promise<ApiResult<CampsiteMemoryState[]>> {
    const result = await this.request(
      'GET',
      '/v1/passport/campsites',
      z.object({ items: z.array(CampsiteMemoryStateSchema) }),
      {},
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  // --- Photos ------------------------------------------------------------
  //
  // Two calls, because that is the shape a pre-signed object-storage URL has:
  // ask where the bytes go, then send them there. The client does the same
  // thing whichever adapter is behind the seam, which is why this will keep
  // working unchanged on the day a bucket exists.
  //
  // A photo is private unless somebody chose otherwise — this never sends a
  // visibility the player did not pick, and the server's default is `private`.

  /** Ask the service where a photo goes. Never fails for a missing bucket. */
  requestPhotoUpload(request: RequestPhotoUploadRequest): Promise<ApiResult<PhotoUploadTicket>> {
    return this.request('POST', '/v1/media/uploads', PhotoUploadTicketSchema, {
      body: { idempotencyKey: idempotencyKey(), ...request },
    });
  }

  /**
   * Send the bytes.
   *
   * Not through `request`: this is the one call in the client that is not
   * JSON, and forcing it through the JSON path would mean base64 and a third
   * more bytes over somebody's phone connection for no reason at all.
   */
  async uploadPhotoBytes(
    ticket: Extract<PhotoUploadTicket, { status: 'ready' }>,
    bytes: Uint8Array,
  ): Promise<ApiResult<StoredPhoto>> {
    if (this.offline) return { ok: false, error: { kind: 'offline' } };
    if (!this.session) return { ok: false, error: { kind: 'unauthorized' } };

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs * 4);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${ticket.uploadUrl}`, {
        method: ticket.method,
        headers: {
          'content-type': ticket.contentType,
          'x-upload-ticket': ticket.uploadToken,
          authorization: `Bearer ${this.session.auth.token}`,
        },
        body: bytes as BodyInit,
        signal: controller.signal,
      });
      const text = await response.text();
      const payload: unknown = text.length > 0 ? safeJson(text) : undefined;
      if (!response.ok) {
        const envelope = payload as { error?: { code?: string; message?: string } } | undefined;
        return {
          ok: false,
          error: {
            kind: 'server',
            status: response.status,
            code: envelope?.error?.code ?? 'unknown',
            message: envelope?.error?.message ?? response.statusText,
          },
        };
      }
      const parsed = StoredPhotoSchema.safeParse(payload);
      if (!parsed.success) {
        return { ok: false, error: { kind: 'malformed', message: 'Response did not match the shared contract.' } };
      }
      return { ok: true, value: parsed.data };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        return { ok: false, error: { kind: 'timeout' } };
      }
      this.offlineUntil = Date.now() + 5000;
      return { ok: false, error: { kind: 'offline' } };
    } finally {
      clearTimeout(timer);
    }
  }

  deletePhoto(photoId: string): Promise<ApiResult<Record<string, unknown>>> {
    return this.request('DELETE', `/v1/media/${encodeURIComponent(photoId)}`, z.object({}).loose(), {});
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

  // --- Deployment capabilities ------------------------------------------

  /**
   * What this deployment can actually do.
   *
   * The client asks rather than assumes. Whether there is a payment provider,
   * and which one, is a property of the deployment the terminal is talking to
   * — so the terminal reads it off the wire and stops needing a code change
   * when a processor is finally configured.
   */
  fetchMeta(): Promise<ApiResult<ServiceMeta>> {
    return this.request('GET', '/v1/meta', ServiceMetaSchema, { authenticated: false });
  }

  // --- Codes ------------------------------------------------------------
  //
  // The physical bridge (spec §14, ADR-0008). A code is public, carries no
  // value and no capability, and is verified on the device before any of this
  // is reached — see `net/codes.ts`. What crosses the wire is a code that
  // already passed a local signature check, presented by an account, because
  // the entitlement lives on the print run and only the service knows it.

  /**
   * The Ed25519 public keys this deployment signs with.
   *
   * Unauthenticated on purpose: a public key is not a secret, and shipping it
   * is what lets a phone refuse a forged wrapper with no signal. Fetched once
   * and cached; a rotation reaches installed clients this way rather than
   * through a store release.
   */
  fetchCodeKeys(): Promise<ApiResult<CodeVerificationKeys>> {
    return this.request('GET', '/v1/codes/keys', CodeVerificationKeysSchema, { authenticated: false });
  }

  /**
   * Redeem a scanned code.
   *
   * Claim-once is a unique index on the service, not a check here: two phones
   * scanning the same posted photograph at the same instant produce one grant
   * and one refusal regardless of what this client believes.
   */
  redeemCode(code: string, deviceId?: string): Promise<ApiResult<RedeemCodeResult>> {
    return this.request('POST', '/v1/codes/redeem', RedeemCodeResultSchema, {
      body: {
        idempotencyKey: idempotencyKey(),
        code,
        ...(deviceId ? { deviceId } : {}),
      },
    });
  }

  /** Codes this account has already redeemed, newest first. */
  async listCodeRedemptions(): Promise<ApiResult<CodeRedemption[]>> {
    const result = await this.request(
      'GET',
      '/v1/codes/redemptions',
      z.object({ items: z.array(CodeRedemptionSchema) }),
      {},
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  // --- Commerce ---------------------------------------------------------
  //
  // Commerce is strictly subordinate to the ritual (spec §11): none of this is
  // reachable before the reveal, and every call here is allowed to fail
  // without touching the world. What it is *not* allowed to do is lie — if
  // there is no payment provider configured, the terminal says so because the
  // service said so, not because the client hard-coded a message.

  /**
   * The catalogue. At launch this is one product.
   *
   * The list routes wrap their payload in `{ items }`; this unwraps it so the
   * caller sees the collection it asked for rather than the envelope.
   */
  async listProducts(): Promise<ApiResult<Product[]>> {
    const result = await this.request(
      'GET',
      '/v1/commerce/products',
      z.object({ items: z.array(ProductSchema) }),
      { authenticated: false },
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  /** Reward grants this account holds. Empty is the normal case. */
  async listRewardGrants(): Promise<ApiResult<RewardGrant[]>> {
    const result = await this.request(
      'GET',
      '/v1/rewards/grants',
      z.object({ items: z.array(RewardGrantSchema) }),
      {},
    );
    return result.ok ? { ok: true, value: result.value.items } : result;
  }

  /**
   * Applies a granted reward to the open cart.
   *
   * The *grant* is what is redeemed, not a code typed in: a grant was already
   * server-validated when it was issued, which is what keeps a high-value
   * reward from being something you can guess (spec §10).
   */
  redeemReward(rewardGrantId: string): Promise<ApiResult<Cart>> {
    return this.request('POST', '/v1/commerce/cart/rewards', CartSchema, {
      body: { idempotencyKey: idempotencyKey(), rewardGrantId },
    });
  }

  /** Applies a promotion code someone typed in. */
  applyPromotion(code: string): Promise<ApiResult<Cart>> {
    return this.request('POST', '/v1/commerce/cart/promotions', CartSchema, {
      body: { idempotencyKey: idempotencyKey(), code },
    });
  }

  fetchCart(): Promise<ApiResult<Cart>> {
    return this.request('GET', '/v1/commerce/cart', CartSchema, {});
  }

  addCartItem(options: {
    productId: string;
    variantId: string;
    quantity?: number;
    /** The sandwich this order came out of, for provenance. */
    sandwichId?: string;
  }): Promise<ApiResult<Cart>> {
    return this.request('POST', '/v1/commerce/cart/items', CartSchema, {
      body: {
        idempotencyKey: idempotencyKey(),
        productId: options.productId,
        variantId: options.variantId,
        quantity: options.quantity ?? 1,
        ...(options.sandwichId ? { sandwichId: options.sandwichId } : {}),
      },
    });
  }

  quoteCart(address: Address): Promise<ApiResult<CartQuote>> {
    return this.request('POST', '/v1/commerce/cart/quote', CartQuoteSchema, {
      body: { shippingAddress: address },
    });
  }

  createOrder(options: {
    cartId: string;
    shippingAddress: Address;
    email?: string;
    expectedTotal?: Money;
  }): Promise<ApiResult<Order>> {
    return this.request('POST', '/v1/commerce/orders', OrderSchema, {
      body: {
        idempotencyKey: idempotencyKey(),
        cartId: options.cartId,
        shippingAddress: options.shippingAddress,
        ...(options.email ? { email: options.email } : {}),
        ...(options.expectedTotal === undefined ? {} : { expectedTotal: options.expectedTotal }),
      },
    });
  }

  /**
   * Asks the service to start a payment.
   *
   * `paymentMethodToken` is a provider-side token minted by the provider's own
   * SDK. Raw card data never reaches this client, this request or this
   * service — that is a hard product constraint, and the absence of any field
   * that could carry a PAN is how it is enforced rather than promised.
   */
  createPaymentIntent(
    orderId: string,
    methodType: PaymentMethodType,
    paymentMethodToken?: string,
  ): Promise<ApiResult<PaymentIntentResponse>> {
    return this.request(
      'POST',
      `/v1/commerce/orders/${encodeURIComponent(orderId)}/payment-intent`,
      PaymentIntentResponseSchema,
      {
        body: {
          idempotencyKey: idempotencyKey(),
          methodType,
          ...(paymentMethodToken ? { paymentMethodToken } : {}),
        },
      },
    );
  }

  confirmPayment(orderId: string, paymentMethodToken?: string): Promise<ApiResult<Order>> {
    return this.request(
      'POST',
      `/v1/commerce/orders/${encodeURIComponent(orderId)}/payment/confirm`,
      OrderSchema,
      {
        body: {
          idempotencyKey: idempotencyKey(),
          ...(paymentMethodToken ? { paymentMethodToken } : {}),
        },
      },
    );
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
    method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
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
        /*
         * A rejected *token* is worse than useless; drop it so the next call
         * bootstraps cleanly instead of failing forever.
         *
         * Keyed on the error code, not the status. Several perfectly ordinary
         * domain refusals are 403 — `code_revoked` when somebody scans a
         * wrapper from a retired print run, `anti_abuse_rejected` on a reward
         * claim — and treating those as a bad credential signed the player out
         * of their own account for holding the wrong box. Found by scanning a
         * retired batch and watching the session disappear. Only `unauthorized`
         * means "this token is not good"; everything else means "not this
         * request", and the token is fine.
         */
        if (code === 'unauthorized' || response.status === 401) {
          this.session = null;
          this.onSession?.(null);
          return { ok: false, error: { kind: 'unauthorized' } };
        }
        if (response.status === 403) {
          return { ok: false, error: { kind: 'server', status: 403, code, message } };
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
