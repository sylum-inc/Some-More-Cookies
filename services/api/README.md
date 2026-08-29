# `@somemore/api`

The backend for **Some More** — the campfire world where you roast a
marshmallow, build a hot s'more, feed it to an SM-01, and walk away with a
roasted-marshmallow ice cream sandwich and a Campfire Passport full of proof.

It is one deployable service: a `node:http` server with a small typed router,
nine domain modules behind explicit interfaces, and a repository layer with a
complete in-memory implementation plus a matching PostgreSQL schema.

* Zero runtime dependencies beyond `zod` and the Node standard library.
* Every wire contract comes from `@somemore/protocol` and is versioned.
* Commerce is subordinate to the experience: one flagship product, and nothing
  in the shop can gate the campfire.

---

## Running it

```bash
# from the repo root
npm run api                 # node --experimental-strip-types services/api/src/main.ts
curl localhost:8787/health
curl localhost:8787/v1/meta # what this deployment can actually do
```

Everything is in memory. Restarting the process is a factory reset: accounts,
campsites, sandwiches and orders are all gone. That is deliberate for local dev
and for the tests; see **Blockers** for what production needs.

### Tests

```bash
npx vitest run services/api/test packages/protocol/test
```

The API tests boot the real HTTP server on port `0` and drive it with `fetch` —
no mocked router, no supertest, no in-process shortcuts. Time is injected
(`createManualClock`) so decay, expiry and rate-limit windows are tested by
fast-forwarding rather than sleeping.

### Typecheck

```bash
npx tsc -b packages/protocol services/api
```

---

## Environment variables

| Variable | Required | Default | What it does |
| --- | --- | --- | --- |
| `PORT` | no | `8787` | Listen port. |
| `HOST` | no | `127.0.0.1` | Listen address. |
| `NODE_ENV` | no | `development` | `production` hardens several defaults (see below). |
| `LOG_LEVEL` | no | `info` (`silent` in tests) | `debug` \| `info` \| `warn` \| `error` \| `silent`. |
| `AUTH_TOKEN_SECRET` | **in production** | random per boot | HMAC-SHA256 key for session tokens. Missing in dev ⇒ an ephemeral secret is generated and a warning is logged; every restart then invalidates all tokens. Missing in production ⇒ the process refuses to start. |
| `AUTH_TOKEN_TTL_SECONDS` | no | `2592000` (30 days) | Session token lifetime. |
| `MAGIC_LINK_TTL_SECONDS` | no | `900` | Sign-in link lifetime. |
| `IP_HASH_SALT` | recommended | random per boot | Salt for hashing client IPs before they touch an anti-abuse record. Raw IPs are never stored. |
| `PAYMENT_PROVIDER` | no | `stripe` if a key is set, else `fake` | Force `fake` for local dev. |
| `STRIPE_SECRET_KEY` | for real payments | — | Absent ⇒ the Stripe adapter reports "not configured" and payment endpoints answer `503`, never a fake success. |
| `STRIPE_PUBLISHABLE_KEY` | no | — | Returned to clients as `publishableKeyHint`. |
| `STRIPE_WEBHOOK_SECRET` | for real payments | — | Absent ⇒ webhook verification fails closed. |
| `STRIPE_API_BASE` | no | `https://api.stripe.com` | Override for a mock/proxy. |
| `MEDIA_BUCKET` | no | `somemore-media-dev` | Object-storage bucket name for photo keys. |
| `MEDIA_KEY_PREFIX` | no | `campsites` | Key prefix for uploads. |
| `IDEMPOTENCY_TTL_SECONDS` | no | `86400` | How long a replay key is honoured. |
| `MAX_BODY_BYTES` | no | `524288` | Request body cap. |
| `REWARD_CLAIM_WINDOW_SECONDS` | no | `3600` | High-value reward claim window. |
| `REWARD_CLAIMS_PER_WINDOW` | no | `3` | Claims allowed per account per window. |
| `MAGIC_LINKS_PER_WINDOW` | no | `5` | Sign-in links per email address per hour. |

No secret has a committed value. `loadConfig()` is the only thing in the service
that reads `process.env`.

---

## Domain boundaries

Nine modules under `src/domain/`. Each owns its aggregate, exposes an interface,
and reaches other domains only through those interfaces (wired in `src/app.ts`).
Route handlers never touch a repository; repositories never contain rules.

| Module | Owns | Notable rules it enforces |
| --- | --- | --- |
| `identity` | accounts, identities, magic links, tokens | Anonymous device bootstrap; linking Apple/Google/email **without losing progress**; the three merge policies and every conflict branch. |
| `passport` | the Campfire Passport | Stamps, photos, notes, patches, ticket stubs, discoveries, visited campsites, settings (accessibility included); optimistic concurrency; the single cross-account visibility rule. |
| `campsites` | campsites, members, invites, the SM-01 | Private by default; role ladder (`owner > cohost > guest > viewer`); camp code / invite link / QR joins; machine wear, quirks and maintenance history. |
| `worldState` | traces and landmarks | Exponential decay, sweeping, the distinct-witness quorum for landmark promotion. |
| `sessions` | live sessions, presence, authority | One live session per campsite; authority leases with a fencing sequence; release-on-disconnect. |
| `sandwiches` | the canonical sandwich record | The server scores every sandwich; a client cannot award itself a legendary. |
| `rewards` | definitions, grants, claims | Standard rewards inline; high-value rewards claim-once, rate-limited, prerequisite-verified server-side, with anti-abuse signals and a review state machine. |
| `commerce` | catalog, cart, quotes, orders, refunds | The order fulfillment state machine, tax/shipping boundary objects, promotions, reward redemption, idempotency on every mutation. |
| `moderation` | reports and blocks | Child-safety reports are urgent and never auto-dismissed; blocks make you invisible to the blocked account. |
| `analytics` | telemetry ingest | Named events only, de-duplicated by client-minted id, never trusting a client-declared account id. |

### Layers

```
routes/        HTTP shape only: path, method, schemas, status codes
  ↓
domain/        all the rules; the only place decisions are made
  ↓
repos/         persistence only; interfaces + in-memory impls (+ sql/schema.sql)
```

Cross-cutting: `http/router.ts` (matching, validation, error envelope),
`http/server.ts` (request ids, logging, body limits, auth, idempotency),
`idempotency.ts`, `auth/tokens.ts`, `payments/`, `mailer.ts`, `ratelimit.ts`.

---

## Route table

64 routes. `auth=required` means a valid bearer token; `auth=optional` means the
route works signed-out but behaves better signed in; `auth=none` is deliberately
public. Every route marked **idem** requires an idempotency key (body
`idempotencyKey`, or the `Idempotency-Key` header).

| Method | Path | Auth | Idem | Summary |
| --- | --- | --- | --- | --- |
| `GET` | `/health` | none | - | Liveness probe. |
| `GET` | `/v1/meta` | none | - | Contract version and the capabilities this deployment actually has. |
| `POST` | `/v1/auth/anonymous` | none | - | Bootstrap an anonymous, device-backed account and issue a token. |
| `GET` | `/v1/auth/me` | required | - | Return the current account, its identities and a fresh token. |
| `POST` | `/v1/auth/refresh` | required | - | Exchange a valid token for a fresh one. |
| `POST` | `/v1/auth/link` | required | yes | Attach an Apple/Google/email identity, with an explicit merge policy. |
| `POST` | `/v1/auth/magic-link` | optional | yes | Send a sign-in link to an email address. |
| `GET` | `/v1/passport` | required | - | Read your own Campfire Passport in full. |
| `PATCH` | `/v1/passport` | required | - | Update your display name, handle, bio, avatar or settings. |
| `POST` | `/v1/passport/photos` | required | yes | Register an uploaded photo (metadata and storage key only). |
| `POST` | `/v1/passport/notes` | required | yes | Scribble a note into the passport. |
| `DELETE` | `/v1/passport/notes/:noteId` | required | - | Tear a note out. |
| `GET` | `/v1/passports/:accountId` | required | - | Read another player's public passport, if they allow it. |
| `POST` | `/v1/campsites` | required | yes | Pitch a new campsite (private by default) with its own SM-01. |
| `GET` | `/v1/campsites` | required | - | List the campsites you belong to. |
| `GET` | `/v1/campsites/:campsiteId` | required | - | Read one campsite. |
| `PATCH` | `/v1/campsites/:campsiteId` | required | - | Rename a campsite, change its privacy (owner only) or refinish the machine. |
| `POST` | `/v1/campsites/:campsiteId/invites` | required | yes | Mint an invite link + camp code + QR payload. |
| `POST` | `/v1/campsites/join` | required | yes | Join a campsite by invite link, camp code or QR. |
| `GET` | `/v1/campsites/:campsiteId/machine` | required | - | Read the serialized SM-01: wear, quirks, maintenance history. |
| `POST` | `/v1/campsites/:campsiteId/machine/maintenance` | required | yes | Service the SM-01. |
| `GET` | `/v1/campsites/:campsiteId/world` | required | - | Read the live world state: traces with decay applied, plus landmarks. |
| `POST` | `/v1/campsites/:campsiteId/traces` | required | yes | Leave a mark on the world. |
| `POST` | `/v1/campsites/:campsiteId/traces/:traceId/witness` | required | - | Notice a trace: counts toward the landmark promotion quorum. |
| `POST` | `/v1/campsites/:campsiteId/traces/:traceId/landmark` | required | yes | Promote a witnessed trace into a named, non-decaying landmark. |
| `POST` | `/v1/campsites/:campsiteId/sessions` | required | yes | Open a live session at a campsite. |
| `GET` | `/v1/sessions/:sessionId` | required | - | Read a session and everyone present. |
| `POST` | `/v1/sessions/:sessionId/join` | required | - | Arrive at the fire. |
| `POST` | `/v1/sessions/:sessionId/leave` | required | - | Leave; anything you were holding is released. |
| `POST` | `/v1/sessions/:sessionId/presence` | required | - | Heartbeat: position, facing, activity, mute state. |
| `POST` | `/v1/sessions/:sessionId/state` | required | - | Move the session through its lifecycle. |
| `GET` | `/v1/sessions/:sessionId/authority` | required | - | Who currently owns each shared object. |
| `POST` | `/v1/sessions/:sessionId/authority` | required | - | Hand off (or release) authority over a shared object. |
| `POST` | `/v1/sandwiches` | required | yes | Record a produced sandwich. The server scores it. |
| `GET` | `/v1/sandwiches` | required | - | List your sandwiches, newest first. |
| `GET` | `/v1/sandwiches/:sandwichId` | required | - | Read one sandwich, if it is yours or shared with you. |
| `PATCH` | `/v1/sandwiches/:sandwichId` | required | - | Name it, share it, pick a hero photo, or eat it. |
| `GET` | `/v1/rewards` | required | - | The reward catalog available right now. |
| `GET` | `/v1/rewards/grants` | required | - | Everything you have been granted. |
| `POST` | `/v1/rewards/claims` | required | yes | Claim a reward. High-value rewards are server-validated and claim-once. |
| `GET` | `/v1/commerce/products` | optional | - | The catalog. One flagship product at launch. |
| `GET` | `/v1/commerce/products/:productId` | optional | - | One product with its variants. |
| `GET` | `/v1/commerce/cart` | required | - | Your open cart, created on first read. |
| `POST` | `/v1/commerce/cart/items` | required | yes | Add a variant to the cart. |
| `PATCH` | `/v1/commerce/cart/items/:itemId` | required | yes | Change a line quantity (0 removes it). |
| `DELETE` | `/v1/commerce/cart/items/:itemId` | required | - | Remove a line. |
| `POST` | `/v1/commerce/cart/promotions` | required | yes | Apply a promotion code. |
| `POST` | `/v1/commerce/cart/rewards` | required | yes | Redeem an earned reward against the cart. |
| `POST` | `/v1/commerce/cart/quote` | required | - | Price the cart for an address: discounts, tax and shipping boundaries. |
| `POST` | `/v1/commerce/orders` | required | yes | Convert a cart into an order awaiting payment. |
| `GET` | `/v1/commerce/orders` | required | - | Your orders, newest first. |
| `GET` | `/v1/commerce/orders/:orderId` | required | - | Read one order. |
| `POST` | `/v1/commerce/orders/:orderId/payment-intent` | required | yes | Create a provider payment intent. Apple Pay / Google Pay / card are method types. |
| `POST` | `/v1/commerce/orders/:orderId/payment/confirm` | required | yes | Confirm the payment intent and move the order to paid. |
| `POST` | `/v1/commerce/orders/:orderId/transitions` | required | yes | Advance fulfillment: in_production -> packed -> shipped -> delivered. |
| `POST` | `/v1/commerce/orders/:orderId/refunds` | required | yes | Refund all or part of an order. |
| `POST` | `/v1/commerce/orders/:orderId/cancel` | required | yes | Cancel an order that has not shipped. |
| `POST` | `/v1/commerce/webhooks/payments` | none | - | Payment provider webhook. Authenticated by provider signature, not a token. |
| `POST` | `/v1/moderation/reports` | required | yes | Report an account, campsite, photo, sandwich, note or landmark. |
| `GET` | `/v1/moderation/reports` | required | - | Reports you have filed. |
| `POST` | `/v1/moderation/blocks` | required | yes | Block a player. |
| `GET` | `/v1/moderation/blocks` | required | - | Everyone you have blocked. |
| `DELETE` | `/v1/moderation/blocks/:accountId` | required | - | Unblock a player. |
| `POST` | `/v1/events` | optional | - | Ingest a batch of telemetry events. |

### Error envelope

Every non-2xx response is exactly:

```json
{ "error": { "code": "validation_failed", "message": "Invalid request body.",
             "requestId": "req_9f2c…", "details": { "…": "…" } } }
```

`code` comes from a closed enum in the protocol (`ApiErrorCode`), and the
`x-request-id` header on every response matches `error.requestId`.

---

## Idempotency

Required on every mutating operation, not just commerce. The contract:

| Situation | Result |
| --- | --- |
| Same key, same payload, completed | The **original** response, plus `Idempotent-Replay: true`. The handler does not run again. |
| Same key, different payload | `409 idempotency_key_conflict` |
| Same key, same payload, still in flight | `409 conflict` with `Retry-After` |
| Handler threw | The key is **released** — a failed call never poisons a key |
| Header and body key disagree | `400 bad_request` |

Keys are scoped to `(account, endpoint, key)`, so two players may use the same
key, and the same key on two endpoints is two different operations.

---

## Payments

`PaymentProvider` (`src/payments/types.ts`) is the only seam through which money
moves: `createIntent`, `confirmIntent`, `refund`, `verifyWebhook`.

* **`StripePaymentProvider`** — structured against Stripe's real REST shape
  (form-encoded bodies, `Authorization: Bearer`, an `Idempotency-Key` header per
  call, `t=…,v1=…` webhook signatures over `${timestamp}.${body}` with a
  timestamp tolerance and `timingSafeEqual`). It reads config from the
  environment and, with no `STRIPE_SECRET_KEY`, answers
  `503 payment_provider_not_configured` instead of pretending.
* **`FakePaymentProvider`** — deterministic, in-process, used by tests and local
  dev. Models the same intent state machine and signs webhooks the same way, so
  the webhook path is genuinely exercised. Present the token
  `pm_fake_declined` to force a decline.

**Apple Pay, Google Pay and card are payment *method types*, not providers.**
They are one field on the intent and one column in the database.

### Card data

The API refuses raw card data at the edge. `containsRawCardData()` deep-scans
every decoded JSON body for forbidden field names (`cardNumber`, `cvc`,
`exp_month`, …) and for Luhn-valid PAN-shaped strings, and rejects the request
with `400 raw_card_data_rejected` *before* schema parsing (which would otherwise
silently strip the fields). Nothing card-shaped exists in the protocol, in the
domain, or in `sql/schema.sql`. We store a provider intent id and a method type.

---

## Auth

1. `POST /v1/auth/anonymous` with a device id ⇒ account + identity + passport +
   token. No email, no password, no friction. Re-bootstrapping the same device
   returns the same account.
2. `POST /v1/auth/link` attaches Apple, Google or email to that account.
3. Tokens are stateless: `sm1.<base64url(payload)>.<base64url(hmac-sha256)>`,
   verified with `timingSafeEqual`, carrying `sub`, `iat`, `exp` and the
   protocol major.

### The merge conflict, explicitly

Signing in with an identity that already belongs to another account is a
first-class outcome, not an error:

| `mergePolicy` | Behaviour |
| --- | --- |
| `abort` (default) | `409` with `status: "conflict"`, both account ids, the retry policies, and a **preview** of what each side would bring (sandwiches, stamps, campsites) so the player can choose. Nothing is written. |
| `keep_current` | The account you are signed into survives; the other is absorbed. |
| `keep_existing` | The account that already owns the identity survives; your current progress is absorbed into it and a **new token** is issued. |

There is no "discard" policy. A merge moves identities, photos, sandwiches,
campsites (ownership and membership), reward grants, orders and every passport
collection, combines stats, remaps telemetry, and returns a `MergeReport` with
per-collection counts and an explicit list of how non-mergeable singletons
(display name, handle, settings) were resolved. Tokens minted before a merge
keep working: they follow the `merged_into_account_id` pointer.

---

## Rewards

Standard rewards (stamps, patches, points, unlocks) are granted inline by
gameplay and are cheap to be wrong about. High-value rewards — a real kit, an
event ticket — go through `POST /v1/rewards/claims`, which:

* refuses a second claim (**claim-once**) regardless of idempotency key;
* rate-limits claims per account per window (`429` with `Retry-After`);
* **re-derives every prerequisite from server-owned records** — sandwich count,
  best score, points, account age, linked identity. Client evidence is ignored;
* scores anti-abuse signals (duplicate client nonce, device shared across
  accounts, claim velocity, brand-new account, unlinked account, unmet
  prerequisites) into a risk score;
* then either fulfils the claim, parks it in `validating` for human review, or
  rejects it — a real state machine (`pending → validating → approved →
  fulfilled`), with `rejected`/`expired` as terminal states.

Claims store a **salted hash** of the client IP, never the IP.

---

## What is mocked, faked or stubbed

Everything here is honest about being a placeholder. None of it silently
pretends to be the real thing.

| Thing | Status | Where |
| --- | --- | --- |
| Persistence | **In memory.** Complete implementations of every repository interface; lost on restart. | `src/repos/memory/` |
| PostgreSQL | Schema written and verified against PostgreSQL 16, but **no adapter and no database**. | `sql/schema.sql` |
| Payments | `FakePaymentProvider` by default. Stripe adapter written but never run against live credentials. | `src/payments/` |
| Email | `ConsoleMailer` logs the message and warns that nothing was delivered. Magic-link tokens are returned in the response body outside production so local flows work. | `src/mailer.ts` |
| Apple / Google sign-in | The id token's `sub` claim is read but **not cryptographically verified** — no JWKS fetch, no `aud`/`iss`/`nonce` check, because there are no client credentials. Contained in one function. | `resolveCredentialSubject()` in `src/domain/identity.ts` |
| Object storage | The API stores keys and metadata only. There is no bucket, no pre-signed upload URL endpoint. | `src/domain/passport.ts` |
| Sales tax | Flat internal table by US state, marked `internal_flat` on the quote. | `quoteTax()` in `src/domain/commerce.ts` |
| Shipping rates | Flat $12 two-day frozen, marked `internal_flat`. | `quoteShipping()` |
| Operator/admin auth | Fulfillment transitions authorize the **order owner**, because no staff RBAC exists yet. | `POST /v1/commerce/orders/:orderId/transitions` |
| Rate limiting | In-process fixed windows; does not survive a restart or span instances. | `src/ratelimit.ts` |
| Realtime | Presence and authority are HTTP request/response. There is no WebSocket or WebRTC transport. | `src/domain/sessions.ts` |

---

## Blockers

Everything below is external and unavailable. Each line says exactly what is
needed to go live. Nothing in the code is blocked *on itself* — every one of
these is a credential, a provisioned service or a contract.

1. **Stripe account and API keys** — no account exists.
   *Needed:* `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, a webhook endpoint
   registered against `/v1/commerce/webhooks/payments` and its
   `STRIPE_WEBHOOK_SECRET`, plus Apple Pay domain verification and a Google Pay
   merchant id. The adapter is written; it has never made a real call.
   *Also needed:* a decision on who the merchant of record is, and PCI SAQ-A
   confirmation (we never touch card data, so SAQ-A should apply).
2. **PostgreSQL instance** — no database is provisioned.
   *Needed:* a Postgres 15+ instance, a connection string, a migration runner,
   and the Postgres implementations of the repository interfaces.
   `sql/schema.sql` applies cleanly to PostgreSQL 16 today and documents which
   interface each table backs.
3. **Object storage for photos** — no bucket.
   *Needed:* an S3/R2/GCS bucket, credentials, a CDN origin, and a pre-signed
   upload endpoint. The API deliberately never touches image bytes; it needs
   somewhere to point the keys at, plus a retention and deletion policy that
   satisfies the passport's delete-my-account promise.
4. **Email provider** — none configured; `ConsoleMailer` delivers nothing.
   *Needed:* Postmark/SES/Resend credentials, a verified sending domain with
   SPF/DKIM/DMARC, and templates for the magic link and order receipts. **Until
   this exists, email sign-in cannot work outside dev**, and account recovery is
   effectively impossible for a player who loses their device.
5. **Apple and Google sign-in credentials** — no client ids.
   *Needed:* an Apple Services ID + key for Sign in with Apple, a Google OAuth
   client id, and then real id-token verification (JWKS fetch and cache, RS256
   signature check, `aud`/`iss`/`exp`/`nonce` validation) in
   `resolveCredentialSubject`. Today an unverified token is accepted, which is
   fine for local dev and unacceptable in production.
6. **Realtime transport (WebRTC / LiveKit)** — nothing is provisioned.
   *Needed:* a LiveKit (or equivalent SFU) deployment, an API key/secret, TURN
   servers, and a token-minting endpoint here. Presence and authority hand-off
   are modelled and enforced over HTTP; the low-latency transport that carries
   them at 30–60 Hz, plus voice, does not exist. This is the largest gap between
   "the rules are right" and "it feels like sitting at a fire together".
7. **Tax engine** — flat internal rates today.
   *Needed:* an Avalara/TaxJar account and nexus configuration. Frozen food is
   taxed inconsistently across US states; the internal table will be wrong
   somewhere, and being wrong about sales tax is a legal problem, not a bug.
8. **Fulfillment and cold-chain carrier** — no contract.
   *Needed:* a 3PL that ships frozen, a carrier account for rates and labels
   (EasyPost/Shippo), real transit-time data, and a webhook for delivery events.
   Until then, shipping is a flat $12 guess and fulfillment transitions are
   driven by hand.
9. **Staff/admin authentication** — none.
   *Needed:* an operator identity provider and a role model, so fulfillment
   transitions, refunds beyond the customer's own order, reward-claim review and
   moderation actioning stop authorizing the customer.
10. **Moderation review tooling and on-call** — reports queue up with nobody
    reading them. *Needed:* a review queue UI, an actioning path (suspend,
    remove content, ban), an appeals process, and a documented escalation for
    `child_safety` reports, which are marked urgent and must be answered by a
    human under a legal clock.
11. **Shared cache / distributed rate limiting** — in-process only.
    *Needed:* Redis (or equivalent) once there is more than one instance;
    otherwise reward-claim and magic-link limits are per-process and trivially
    bypassed by hitting a different node.
12. **Secrets management and deployment target** — no host, no secret store, no
    TLS termination, no CI deploy. *Needed:* a runtime (Fly/Render/ECS), a
    secrets manager for `AUTH_TOKEN_SECRET`/`IP_HASH_SALT`/provider keys, and a
    log/metrics sink for the structured JSON this service already emits.

### Not blockers, but decisions someone owes us

* Data retention and deletion: how long do we keep photos, telemetry and merged
  accounts? The passport implies "forever"; privacy law implies otherwise.
* Whether the flagship product ships internationally at launch — today the
  catalog says `shipsToCountries: ["US"]` and the API refuses everything else.
* Whether reward-claim review is human-in-the-loop from day one, or whether we
  auto-approve below a risk threshold and accept some fraud.
