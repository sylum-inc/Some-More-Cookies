# `@somemore/api`

The backend for **Some More** — the campfire world where you roast a
marshmallow, build a hot s'more, feed it to an SM-01, and walk away with a
roasted-marshmallow ice cream sandwich and a Campfire Passport full of proof.

It is one deployable service: a `node:http` server with a small typed router,
eleven domain modules behind explicit interfaces, and a repository layer with two
complete implementations — in memory for local dev and tests, PostgreSQL for
anything that has to survive a restart.

* Zero runtime dependencies beyond `zod` and the Node standard library. That
  includes the database: there is no `pg`, no ORM. `src/db/wire/` is a
  PostgreSQL v3 wire-protocol client written against `node:net`.
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

With no `DATABASE_URL`, everything is in memory and restarting the process is a
factory reset: accounts, campsites, sandwiches and orders are all gone. The
service says so at boot (`config.memory_persistence`) and at `GET /v1/meta`
(`"persistence": "memory"`). That is the right default for local dev — the
campfire works with nothing installed.

Set `DATABASE_URL` and the same binary is durable instead. Nothing else changes:
same routes, same rules, same responses.

```bash
DATABASE_URL=postgres://somemore:somemore@127.0.0.1:5432/somemore npm run api
curl localhost:8787/health   # now reports database reachability
```

### Running Postgres locally

Any PostgreSQL 15+ will do. Two ways to get one:

```bash
# 1. A throwaway cluster in a temp directory — no system service, no root
initdb -D /tmp/somemore-pg -U postgres --auth-local=trust --auth-host=scram-sha-256 \
       --pwfile=<(echo somemore_dev)
pg_ctl -D /tmp/somemore-pg -l /tmp/somemore-pg/server.log \
       -o "-c listen_addresses=127.0.0.1 -c port=5433 -c unix_socket_directories=/tmp/somemore-pg" \
       -w start
createdb -h 127.0.0.1 -p 5433 -U postgres somemore
createdb -h 127.0.0.1 -p 5433 -U postgres somemore_test

export DATABASE_URL='postgres://postgres:somemore_dev@127.0.0.1:5433/somemore?sslmode=disable'

# ...and when you are done
pg_ctl -D /tmp/somemore-pg stop
```

```bash
# 2. Docker, if you would rather not have a cluster on your laptop
docker run --rm -e POSTGRES_PASSWORD=somemore_dev -p 5433:5432 postgres:16
```

The service needs no extensions and no superuser: it creates one schema
(`somemore`) and the tables inside it. `CREATE DATABASE` privileges are needed
only by the test harness, which gives each vitest worker its own database.

### The migration workflow

Migrations are plain SQL in `migrations/`, named `NNNN_description.sql`, applied
in ascending order and recorded with their checksum in
`somemore.schema_migrations`.

```bash
npm run migrate --workspace @somemore/api          # apply anything pending
npm run migrate:status --workspace @somemore/api   # what is applied, what is not
npm run migrate:reset --workspace @somemore/api    # drop the schema and rebuild
```

The service also applies pending migrations itself, on the first query after
boot (`DATABASE_AUTO_MIGRATE=false` turns that off for deployments that
migrate as a separate step). Every query issued before that finishes waits for
it, so there is no window in which a request meets a half-built schema.

Four rules, each of which exists because of a specific way this goes wrong:

| Rule | Why |
| --- | --- |
| **Forward only.** No `down`. | A rollback is a new migration, so the path that runs in production is a path that was tested. |
| **Re-running is a no-op.** | Boot-time migration has to be safe on every instance, every restart. |
| **Editing an applied migration is a hard error.** | Two databases with the same version number and different schemas is the worst failure mode there is. Add a new file. |
| **One number per file.** | Duplicate numbering silently skips somebody's migration. |

To add one: write `migrations/0004_whatever.sql`, run `npm run migrate`. Until a
migration has been applied anywhere you care about, editing it in place is fine
— drop the database and start again. After that, it is immutable.

### Testing against a real database

The entire API suite runs against both backends. `DATABASE_URL` is the only
switch:

```bash
npx vitest run services/api/test                     # in-memory
DATABASE_URL=... npx vitest run services/api/test    # the same suite, on Postgres
```

Each vitest worker gets its own database (`<name>_w<n>`, created on demand), and
every test case starts from a truncated schema — the closest a real database
gets to `new Map()`. `services/api/test/postgres.test.ts` adds the cases that
only a real database can fail: two requests racing on one idempotency key, two
simultaneous claims of a one-per-player reward, contended authority hand-off,
concurrent read-modify-write on one aggregate, and migration re-run idempotency.
Those are skipped, loudly, without `DATABASE_URL`.

### Tests

```bash
npx vitest run services/api/test packages/protocol/test
DATABASE_URL=postgres://... npx vitest run services/api/test   # and again, durably
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
| `DATABASE_URL` | **in production** | — | `postgres://user:pass@host:port/db?sslmode=…`. Present ⇒ durable Postgres storage. Absent ⇒ in-memory repositories and a `memory_persistence` warning. |
| `DATABASE_AUTO_MIGRATE` | no | `true` | Apply pending migrations on first use. Set `false` when a deploy pipeline migrates separately. |
| `DATABASE_POOL_MAX` | no | `10` | Maximum pooled connections. Requests beyond this queue rather than opening more. |
| `DATABASE_POOL_MIN` | no | `0` | Connections kept open when idle. |
| `DATABASE_IDLE_TIMEOUT_MS` | no | `30000` | How long an idle connection lingers before it is closed. |
| `DATABASE_ACQUIRE_TIMEOUT_MS` | no | `10000` | How long a request waits for a free connection before failing. |
| `DATABASE_CONNECT_TIMEOUT_MS` | no | `10000` | TCP + handshake timeout for one new connection. |
| `DATABASE_STATEMENT_TIMEOUT_MS` | no | `15000` | `statement_timeout` set on every connection, so one pathological query cannot pin a pool slot forever. |
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
| `LIVE_OPS_TOKEN` | for authoring | — | Shared secret presented as `x-somemore-ops-token` *alongside* a normal bearer token. Absent ⇒ the content service is read-only and every authoring route answers `503 service_not_configured`. Not RBAC; see Blocker 9. |
| `CODE_SIGNING_KEY_ID` | for minting | — | Which key new codes are signed with, e.g. `k1`. |
| `CODE_SIGNING_PRIVATE_KEY` | for minting | — | Base64 Ed25519 private key (a raw 32-byte seed or a PKCS8 DER blob). Absent ⇒ codes can still be *verified* if public keys are set, but none can be minted. |
| `CODE_VERIFY_PUBLIC_KEYS` | for scanning | — | `keyId:base64,keyId:base64`. Old print runs keep verifying after a rotation. Absent *and* no private key ⇒ scanning is disabled with a structured `not_configured`, never permissively. |
| `CODE_REDEMPTION_WINDOW_SECONDS` | no | `3600` | Window for both redemption limits below. |
| `CODE_REDEMPTIONS_PER_WINDOW` | no | `10` | Scan attempts per account per window. |
| `CODE_FAILURES_PER_WINDOW` | no | `20` | Failed scans per salted IP hash per window. |
| `CODE_BATCH_VELOCITY_FLAG` | no | `200` | Redemptions per run per window above which the run is flagged for human review (never auto-retired). |

The connection string may also carry pool settings as query parameters
(`pool_max`, `pool_min`, `idle_timeout_ms`, `acquire_timeout_ms`,
`connect_timeout_ms`, `statement_timeout_ms`, `search_path`, `sslmode`); the
environment variables above win where both are given.

No secret has a committed value. `loadConfig()` is the only thing in the service
that reads `process.env`. `DATABASE_URL` is never logged, never returned by
`/health`, and never appears in an error body — the health probe reports a
category (`unreachable`, `not_migrated`) and pool occupancy, nothing more.

---

## Domain boundaries

Eleven modules under `src/domain/`. Each owns its aggregate, exposes an interface,
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
| `liveOps` | content documents, releases, the manifest | `draft → staged → published → retired`; validation at publish time using `@somemore/content`'s validator; append-only numbered releases; rollback as a forward-only republish; activation windows evaluated against the injected clock. |
| `codes` | print runs, minting, redemption | Ed25519 signatures, claim-once by unique index, per-run retirement, per-account and per-IP-hash rate limits, velocity flagging. |

### Layers

```
routes/        HTTP shape only: path, method, schemas, status codes
  ↓
domain/        all the rules; the only place decisions are made
  ↓
repos/         persistence only; interfaces + two implementations
                 memory/     reference semantics, used by dev and tests
                 postgres/   the same semantics, durably
  ↓
db/            migrations, pool, health, and wire/ — the protocol client
```

Cross-cutting: `http/router.ts` (matching, validation, error envelope),
`http/server.ts` (request ids, logging, body limits, auth, idempotency),
`idempotency.ts`, `auth/tokens.ts`, `payments/`, `mailer.ts`, `ratelimit.ts`.

---

## Route table

80 routes. `auth=required` means a valid bearer token; `auth=optional` means the
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
| `GET` | `/v1/content/manifest` | optional | - | The published content overlay, with an ETag; `If-None-Match` answers `304`. |
| `GET` | `/v1/content/documents/:kind/:slug` | optional | - | One published content document, with its own ETag. |
| `GET` | `/v1/live-ops/status` | required | - | Whether this deployment can author content and mint codes. |
| `POST` | `/v1/live-ops/documents/validate` | required | - | Dry-run the publish gate against a body without storing anything. |
| `POST` | `/v1/live-ops/documents` | required | yes | Draft the next version of a content document. |
| `GET` | `/v1/live-ops/documents` | required | - | List documents, filtered by kind, slug or status. |
| `GET` | `/v1/live-ops/documents/:documentId` | required | - | Read one document at one version, in any status. |
| `POST` | `/v1/live-ops/documents/:documentId/transitions` | required | yes | Move a document through its lifecycle. Publishing runs validation. |
| `GET` | `/v1/live-ops/releases` | required | - | The append-only release history. |
| `POST` | `/v1/live-ops/releases/rollback` | required | yes | Undo a bad publish by republishing an earlier release. No deploy. |
| `POST` | `/v1/live-ops/code-batches` | required | yes | Open a print run. |
| `GET` | `/v1/live-ops/code-batches` | required | - | Every print run, with minted and redeemed counts. |
| `POST` | `/v1/live-ops/code-batches/:batchId/mint` | required | yes | Mint codes. This response is the only copy that exists. |
| `POST` | `/v1/live-ops/code-batches/:batchId/retire` | required | yes | Retire one compromised run. Every other run keeps working. |
| `POST` | `/v1/codes/redeem` | required | yes | Redeem a scanned code. Claim-once is enforced by the database. |
| `GET` | `/v1/codes/redemptions` | required | - | Codes you have redeemed, newest first. |

Every `/v1/live-ops/*` route needs **two** credentials: a valid bearer token
*and* the `x-somemore-ops-token` header. See **Live ops** below.

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

## Live ops

Environments, seasonal events, station programming and reward definitions ship
compiled into the client (`packages/content`). That is right for the base
catalogue — the campfire has to start with no network — and wrong for anything
that changes after ship. Live ops is the service side of the second half.

Everything here is an **overlay**. The client boots from what it was built with,
fetches the manifest afterwards, and applies whatever it got. A timeout, a 500,
a 304 and a DNS failure are all the same thing to a campsite: the overlay it
already had, or none. `ContentManifest` says so in the payload — `overlay: true`,
and the schema does not permit `false`.

### The lifecycle

`draft → staged → published → retired`. There is no un-publish: taking something
down is `retired`, which is an event of its own, and `published → staged` is not
a legal move. Publishing straight from `draft` is refused, because a preview step
you can skip is not a preview step.

`(kind, slug)` is the thing being versioned; each edit is a new immutable
version. Two operators drafting the same slug at the same instant both compute
`max(version) + 1`, the unique index refuses one, and the service takes the next
number and retries rather than handing a person a 409 for something they did
nothing to cause.

### Validation happens at publish time, on our machine

A document that violates the content rules is an operator's `422
content_invalid`, never a player's broken campsite. Every problem comes back at
once, as `{ path, message }` with dotted paths:

```json
{ "error": { "code": "content_invalid",
  "message": "That document has 4 problem(s) and was not published.",
  "details": { "issues": [
    { "path": "manual_bad.intensity", "message": "must be within [0, 1] (got 5)" },
    { "path": "manual_bad.skyEvent", "message": "a sky-event with skyEvent \"none\" would change nothing" },
    { "path": "manual_bad.environments[0]", "message": "no environment \"nowhere\" is compiled in or published" }
  ] } } }
```

The rules come from **`packages/content/src/validate.ts`** — the same validator
the compiled catalogue passes. A second validator would be a second answer to
one question, and the day they disagreed is the day live ops published something
the client refused to load. Reward definitions are checked against the
protocol's own Zod schema instead, because rewards are a wire contract rather
than content; the Zod paths are flattened to the same dotted form so an operator
sees one kind of error.

Two checks need storage and therefore live in the domain: an event may not name
an environment that is neither compiled in nor published, and it may not offer a
reward code nobody defined. Both are silent failures otherwise — the sort nobody
notices for a week.

`POST /v1/live-ops/documents/validate` runs the whole gate and stores nothing.

### Releases and rollback

Every publish, retirement and rollback appends an immutable numbered **release**:
exactly which document versions were live. Nothing is rewritten.

Rolling back promotes an earlier release *forward*. It does not resurrect
retired rows; it republishes those bodies as new document versions and retires
whatever the target did not contain, then records release *N+1* with
`rolledBackFromVersion`. Same reasoning as the migration runner having no
`down`: the state that ships is a state that was recorded, and "what was live at
03:14" is still answerable after three rollbacks in a row.

Rollback re-runs validation, so a validator that has tightened since the
original publish can block one. That is deliberate — the alternative is
knowingly republishing content we now consider broken — and the error names the
document and the path.

### Delivery

```bash
curl -i localhost:8787/v1/content/manifest
# ETag: "62d7f9f679f39dbdb23367c55c1dff83"
curl -o /dev/null -w '%{http_code} %{size_download}\n' \
  localhost:8787/v1/content/manifest -H 'if-none-match: "62d7f9…"'
# 304 0
```

The ETag is a strong validator over the release version **and the current
activation state**, so a seasonal window opening flips it without anybody
publishing anything: a phone polling with a stale ETag finds out about the
meteor shower on the request that would otherwise have been a 304. Weak (`W/"…"`)
and listed (`"a", "b"`) validators are accepted, because a proxy is entitled to
send them.

### Seasonal events

Time-bounded content — a meteor-shower weekend, a winter campsite, a limited
flavour — carries an activation window and is evaluated **server-side against
the injected clock**. Not `Date.now()` in a handler, and never a time the client
sent: a phone with its clock wound forward is the oldest trick there is, and a
limited edition is exactly what it would be pointed at. Windows are half-open,
so two events that abut are never both live for a millisecond.

Content may not gate anything. `exclusive` and `gates` are not expressible and
the validator rejects them by name, because spec §5.5 and §8 say rare events are
gifts and a missed window must strand nobody.

### Authoring authentication, and what it is not

Every `/v1/live-ops/*` route requires a valid bearer token **and** the
`x-somemore-ops-token` header, compared in constant time over sha256 digests so
neither the value nor its length leaks. Two credentials, one of which is a real
account in the audit trail, is meaningfully better than a shared secret alone.

It is still not RBAC, and it does not pretend to be — there is no staff identity
provider (Blocker 9). With `LIVE_OPS_TOKEN` unset, reads keep working and every
authoring route answers `503 service_not_configured` naming the variable.

---

## Codes: the physical bridge

One format for every scannable thing Some More prints or shows — a wrapper, an
event card, and the QR a player holds up so a friend can join their fire.

```
somemore://c/SM1.<base64url(body)>.<base64url(ed25519 signature)>

body = "1|pkg|k1|bat_bu9OU7k-|000000|HLud_w2POl5P|0"
        ^ ^   ^  ^            ^      ^            ^
        | |   |  |            |      |            expiry, unix seconds (0 = never)
        | |   |  |            |      96-bit per-code nonce
        | |   |  |            serial in the run, or the invite token for `camp`
        | |   |  which print run
        | |   which key signed it
        | pkg | evt | camp
        format version
```

162 characters as a URI. A canonical positional body rather than JSON, because a
signature covers exact bytes; the parser re-encodes what it parsed and refuses
anything that does not round-trip.

### What is not in a code, and why

A code on a mass-produced wrapper is **public**. It will be photographed and
posted. So it carries **no account, name or email**; **no auth token, session
token or capability**; **no reward id, sku or value**; and no secret of any kind.
The entitlement lives on the *batch*, server-side, so a run printed for one
promotion can be repointed, downgraded or switched off after the boxes are in a
warehouse — and a photo of a wrapper never advertises "this is the free-kit one".

Redeeming always requires an authenticated account, which is what makes a
scraped code worth nothing on its own.

### Minting

```bash
POST /v1/live-ops/code-batches          # label, kind, entitlement, size, window
POST /v1/live-ops/code-batches/:id/mint # count -> the codes
```

**The mint response is the only copy that exists.** Codes are not written to the
database, not logged and not recoverable; there is nothing here for a leaked
backup to contain. A redemption row records `(batch_id, code_ref)` — enough to
enforce claim-once and to answer "which run was this", and not enough to
reconstruct a code, because the signature is not stored. A lost print file is a
reprint, and that is the right trade.

### Claim-once, decided by the database

`code_redemptions_one_per_code` is unique on `(batch_id, code_ref)`.
`code_redemptions_one_per_account` is a partial unique index on
`(batch_id, per_account_key)`, where `per_account_key` is the batch's
one-per-account rule projected onto the row that has to obey it (a partial index
cannot consult another table). Two phones scanning the same posted photo at the
same instant produce one grant and one `409 code_already_redeemed`, whatever
order the requests interleave in. Same shape as
`reward_grants_one_live_per_account_reward`, for the same reason, and
`test/postgres.test.ts` races them.

### Retiring a compromised run

`POST /v1/live-ops/code-batches/:id/retire` stops **that run**. Codes from every
other run keep working. That is the whole reason `batchId` is in the payload: a
leaked pallet is a leaked pallet, and invalidating every code ever printed would
be the wrong blast radius.

### Abuse

Someone will scrape codes off Instagram. The design assumes it:

* A forged code dies at the signature check, before storage is touched.
* There is nothing to enumerate: 96 bits of nonce inside a signed body.
* Failures are rate-limited per account **and** per salted IP hash. A real code
  presented a second time counts as a failure, because that is exactly what
  working through a scraped list looks like.
* Every "no" a stranger can provoke is the same word. `malformed`, `bad
  signature`, `unknown key`, `unknown batch` and `never minted` all answer `400
  code_invalid` with `details.reason: "invalid"`. Only the reasons a real
  customer needs — `expired`, `batch_retired`, `already_redeemed`,
  `limit_reached` — are distinguished, and each of those is already obvious to
  somebody holding the box.
* A serial beyond what the run minted is refused — the check that buys time if a
  signing key ever leaks.
* A run redeemed unusually fast is **flagged for a human, not auto-retired**.
  Pulling a live run punishes everyone holding a real box; a person decides.
* Redemption records a **salted hash** of the client IP, never the address.

### Campsite QR joins use the same format

`POST /v1/campsites/:id/invites` returns a signed `camp` code whose `ref` is the
invite token, and `POST /v1/campsites/join` accepts it — so a forged or tampered
camp QR is rejected by a signature check *before* the invite table is read. The
legacy `somemore://join?t=…` payload is still accepted, and is what an invite
falls back to when this deployment has no keys, because a campfire with no QR is
worse than a QR that is only as strong as the invite behind it (which is what it
has always been). A `pkg` code presented to `join`, or a `camp` code presented to
`redeem`, is refused.

### With no keys configured

Scanning is **disabled**, honestly: `GET /v1/live-ops/status` reports
`{"status":"not_configured","fallback":"scanning_disabled","reason":"… CODE_SIGNING_PRIVATE_KEY …"}`
and `POST /v1/codes/redeem` answers `503 service_not_configured`. It never
degrades to accepting everything — that is the one failure mode that would turn
a missing environment variable into free ice cream. A deployment holding only
public keys verifies codes signed elsewhere and refuses to mint.

---

## Persistence

Two implementations of the same twenty-six repository interfaces. Which one you
get is decided in exactly one place (`createApp` in `src/app.ts`) by exactly one
question: is `DATABASE_URL` set?

`src/repos/memory/` is the reference. It is small enough to read in one sitting,
and it defines what every method means. `src/repos/postgres/` mirrors it method
for method, down to which `ApiError` each failure raises — which is why the
whole API suite runs against both rather than against a separate set of
"database tests".

### The wire client

There is no `pg` dependency, and adding one was not on the table (ADR-0005:
this service depends on `zod` and the Node standard library, and that is all).
`src/db/wire/` is a PostgreSQL v3 frontend/backend protocol client over
`node:net`, about 900 lines:

| File | What it is |
| --- | --- |
| `buffer.ts` | Message framing: a writer that lays out one frontend message, a reader for one backend message, and a stream parser that turns arbitrary TCP chunks into whole messages. |
| `scram.ts` | SCRAM-SHA-256 (RFC 7677) and md5 password auth. |
| `codec.ts` | Text-format parameter encoding and result decoding by column OID. |
| `connection.ts` | One socket: startup, authentication, simple query, extended query (Parse/Bind/Describe/Execute/Sync), `ErrorResponse`, transactions, cancellation. |
| `pool.ts` | Bounded pool, idle reaping, acquire timeouts, transient-failure retry, `BEGIN`/`COMMIT`/`ROLLBACK`, and the liveness probe `/health` uses. |
| `url.ts` | `DATABASE_URL` parsing and the redaction used everywhere the config is logged. |

**What it supports.** Startup with `trust`, cleartext, `md5` and
`SCRAM-SHA-256` authentication (SCRAM is what a default Postgres 14+ negotiates,
and it is what this was developed against). Parameterised queries through the
extended protocol, so values never touch SQL text. Multi-statement simple
queries, which is what a migration file is. Transactions with `SELECT … FOR
UPDATE`. `sslmode=disable|prefer|require`. Query cancellation over a second
connection.

**What it does not.** Each limitation is a deliberate omission, not an
unfinished edge:

* **Binary result format.** Everything is text. Binary would need a codec per
  type for a saving this service would not measure.
* **TLS certificate verification.** `sslmode=require` encrypts but does not
  verify the server certificate; `verify-ca` and `verify-full` are accepted as
  aliases for `require` rather than silently pretending to check a chain. A
  managed database reached over the public internet needs this finished first —
  it is one `tls.connect` option and a CA bundle, but it is not done.
* **SCRAM channel binding.** The client advertises `n,,` (not supported), which
  is legal and honest: nothing here terminates TLS itself, so there is no
  channel to bind to.
* **Full SASLprep.** Passwords are NFKC-normalised, and one containing the
  control characters SASLprep prohibits is rejected rather than mangled into
  something that will not authenticate.
* **`COPY`, `LISTEN`/`NOTIFY`, prepared-statement caching, read replicas.**
  Nothing in this service uses them.
* **GSSAPI/SSPI authentication.** Unsupported methods produce a clear error
  naming what the client does speak, rather than hanging.
* **Retry is not exactly-once.** The pool retries transient failures — lost
  connections, serialization failures, deadlock victims — with backoff. A
  connection dropped *after* the server committed but before the reply arrived
  will be retried, and the retry will fail on a unique violation rather than
  writing twice, because every insert carries a server-minted id. That turns a
  silent duplicate into a loud conflict, which is the right trade, but it is
  not the same as exactly-once.

### Schema shape

`migrations/` is derived from `sql/schema.sql`, which remains the normalised
reference model and the documentation of which table backs which interface. The
migrated schema is the *aggregate* form of it: one table per repository
aggregate root, with real typed and indexed columns for every field an interface
queries, sorts or aggregates on, plus a `doc jsonb` holding the canonical
protocol object.

That is a deliberate trade, and the reasoning is worth stating plainly. The
repository contract is `create(entity)` / `get(id)` / `update(id, mutate)` over
Zod-validated protocol aggregates; the in-memory implementation is the reference
semantics. Shredding those aggregates across sixty tables and reassembling them
would insert a lossy mapping layer between the wire contract and storage in
exchange for queries this service does not make. What the normalised schema
*does* buy — the invariants — is kept in full: every `UNIQUE` and partial index
`schema.sql` declares is declared in `migrations/0003_invariants.sql`, and the
Postgres repositories translate each violation back into the `ApiError` the
single-threaded path would have produced.

Three things in `sql/schema.sql` did not survive contact with the reference
semantics, and the migrations say so where they diverge:

| `schema.sql` says | What the migrations do | Why |
| --- | --- | --- |
| `identities_one_per_provider_per_account` | Not created. | A player who roasted on their phone and again on the couch has two `anonymous` identities, one per device. Absorbing one account into the other must carry both — "a merge is never a reset". The index fails the merge and loses a device's history. `(provider, subject)` stays unique, and that is what stops a device bootstrapping twice. |
| `reward_claims_nonce_unique` | A plain index. | The rewards domain does something more useful with a replayed nonce than refusing the insert: it records the second claim, raises `duplicate_client_nonce`, and points `antiAbuse.duplicateOfClaimId` at the original. A unique index makes that evidence unstorable. |
| Cross-aggregate foreign keys | Not created. | Repository interfaces are per-aggregate and promise no write ordering between them — an analytics event may legitimately name an account that never existed. An FK there is an invariant the domain does not hold. |

Claim-once *is* enforced by the database:
`reward_grants_one_live_per_account_reward` is a partial unique index, and it is
what makes two simultaneous taps on "claim my free kit" produce one grant and
one `reward_already_claimed` instead of two kits. Grants that arrive on an
account through a merge are marked `merged_in` and excluded, because a merge is
not a second claim.

### Atomicity and locking

`update(id, mutate)` is read-modify-write. In memory it is atomic because
JavaScript is single-threaded; in Postgres it is a transaction with
`SELECT … FOR UPDATE`, without which two concurrent updates both read the
pre-image and the second silently discards the first. Beyond that:

* **Idempotency** — `begin` is one `INSERT … ON CONFLICT DO NOTHING`. There is
  no window between checking and claiming a key, because there is no check.
* **Magic links** — consumed with `UPDATE … WHERE consumed_at IS NULL
  RETURNING`, so two clients following the same emailed link race in the
  database and exactly one wins.
* **Authority hand-off** — the fencing `sequence` is a real column and `put` is
  an upsert guarded by `WHERE object_authority.sequence < EXCLUDED.sequence`.
  The loser of a contended grab is told so, rather than both clients believing
  they hold the marshmallow. This is strictly stronger than the in-memory
  behaviour, which is why the test for it is Postgres-only.
* **Account merges** — ownership and membership move inside one transaction, so
  a half-merged campsite is never observable.

### Connection health

`GET /health` reports whether storage is reachable, how long the probe took, and
pool occupancy; it answers `503` when the database is unreachable or the schema
failed to migrate. It never returns the host, database name, user, or the
driver's own message. Individual API requests that fail because storage is down
answer `500` — the protocol's `ApiErrorCode` enum is closed and has no
"storage unavailable" member, so `/health` is the signal a load balancer should
read, not the status of one request.

---

## What is mocked, faked or stubbed

Everything here is honest about being a placeholder. None of it silently
pretends to be the real thing.

| Thing | Status | Where |
| --- | --- | --- |
| Persistence | **Real, both ways.** In-memory repositories when `DATABASE_URL` is unset (lost on restart, deliberately); PostgreSQL when it is set. | `src/repos/memory/`, `src/repos/postgres/` |
| PostgreSQL driver | Hand-written wire-protocol client, no `pg` dependency. Exercised by the full API suite against a live PostgreSQL 16. TLS certificate verification is **not** implemented — see **Persistence → What it does not**. | `src/db/wire/` |
| Payments | `FakePaymentProvider` by default. Stripe adapter written but never run against live credentials. | `src/payments/` |
| Email | `ConsoleMailer` logs the message and warns that nothing was delivered. Magic-link tokens are returned in the response body outside production so local flows work. | `src/mailer.ts` |
| Apple / Google sign-in | The id token's `sub` claim is read but **not cryptographically verified** — no JWKS fetch, no `aud`/`iss`/`nonce` check, because there are no client credentials. Contained in one function. | `resolveCredentialSubject()` in `src/domain/identity.ts` |
| Object storage | The API stores keys and metadata only. There is no bucket, no pre-signed upload URL endpoint. | `src/domain/passport.ts` |
| Sales tax | Flat internal table by US state, marked `internal_flat` on the quote. | `quoteTax()` in `src/domain/commerce.ts` |
| Shipping rates | Flat $12 two-day frozen, marked `internal_flat`. | `quoteShipping()` |
| Operator/admin auth | Fulfillment transitions authorize the **order owner**, because no staff RBAC exists yet. Live-ops authoring is gated by a shared `LIVE_OPS_TOKEN` on top of a bearer token — better than a secret alone, still not a role model. | `POST /v1/commerce/orders/:orderId/transitions`, `src/routes/liveops.ts` |
| Code print vendor | Minting is real and the codes verify; nothing turns them into artwork. There is no vendor, no imposition file, no QR image, no proof workflow. | `src/domain/codes.ts` |
| Code signing keys | Real Ed25519 over `node:crypto`, but no key exists outside a developer's shell. No HSM, no rotation schedule, no key-compromise runbook. | `src/codes/signing.ts` |
| Rate limiting | In-process fixed windows; does not survive a restart or span instances. | `src/ratelimit.ts` |
| Realtime | Presence and authority are HTTP request/response. There is no WebSocket or WebRTC transport. | `src/domain/sessions.ts` |

---

## Blockers

Everything below is external and unavailable. Each line says exactly what is
needed to go live. Nothing in the code is blocked *on itself* — every one of
these is a credential, a provisioned service or a contract.

**Resolved by the persistence work** (see **Persistence** above):

* ~~*Blocker 2, PostgreSQL* — a migration runner and the Postgres
  implementations of the repository interfaces.~~ Both exist. `migrations/` is a
  real forward-only runner with checksums, and `src/repos/postgres/` implements
  every one of the twenty-six interfaces. The entire API suite passes against a
  live PostgreSQL 16. What remains of that blocker is *a provisioned instance
  and a connection string* — the part that was always going to be somebody
  else's purchase order, restated below.
* ~~*"Persistence is in memory"*~~ has moved out of **What is mocked** — it is
  now a supported mode rather than a placeholder.

Two blockers are *narrowed* rather than removed:

* **Blocker 11, shared cache / distributed rate limiting.** Reward-claim
  claim-once no longer depends on process memory: it is a partial unique index,
  so it holds across instances today. What still does not is the *velocity*
  limiter in `src/ratelimit.ts`, which remains in-process. The consequence is
  smaller than it was — a second instance can no longer let a player claim two
  free kits, only claim slightly faster than intended.
* **Blocker 12, secrets and deployment.** `DATABASE_URL` joins
  `AUTH_TOKEN_SECRET` and `IP_HASH_SALT` on the list of things the secret store
  has to hold.

1. **Stripe account and API keys** — no account exists.
   *Needed:* `STRIPE_SECRET_KEY`, `STRIPE_PUBLISHABLE_KEY`, a webhook endpoint
   registered against `/v1/commerce/webhooks/payments` and its
   `STRIPE_WEBHOOK_SECRET`, plus Apple Pay domain verification and a Google Pay
   merchant id. The adapter is written; it has never made a real call.
   *Also needed:* a decision on who the merchant of record is, and PCI SAQ-A
   confirmation (we never touch card data, so SAQ-A should apply).
2. **A provisioned PostgreSQL instance** — the code is ready; the server is not
   bought. *Needed:* a managed Postgres 15+ instance, its `DATABASE_URL` in a
   secret store, a backup and point-in-time-recovery policy, and a decision on
   whether migrations run at boot (`DATABASE_AUTO_MIGRATE`, the default) or as a
   separate deploy step. *Also needed before pointing this at a managed
   instance over the public internet:* TLS certificate verification in the wire
   client — `sslmode=require` currently encrypts without verifying the server
   certificate, which is fine over a private network and not fine over the
   internet. Everything else on this line is done: schema, migration runner,
   repositories, pool, health checks, and a test suite that runs against a real
   database.
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
9. **Staff/admin authentication** — none. *Narrowed, not closed:* live-ops
   authoring now needs a bearer token **and** `LIVE_OPS_TOKEN`, so it is not
   reachable by an ordinary player, and every action is attributed to a real
   account id. That is one shared secret with no roles, no per-person
   revocation, and no separation between "may draft" and "may mint 100,000
   codes". *Needed:* an operator identity provider and a role model, so
   fulfillment transitions, refunds beyond the customer's own order,
   reward-claim review, content publishing, code minting and moderation
   actioning stop authorizing the customer.
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
    secrets manager for `AUTH_TOKEN_SECRET`/`IP_HASH_SALT`/`DATABASE_URL`/
    `LIVE_OPS_TOKEN`/`CODE_SIGNING_PRIVATE_KEY`/provider keys, and a
    log/metrics sink for the structured JSON this service already emits.
13. **A code signing key, and somewhere to keep it** — the code is finished;
    no key exists. *Needed:* an Ed25519 key pair generated into the secret
    store (`generateCodeKeyPair()` in `src/codes/signing.ts` will mint one, and
    deliberately writes nothing to disk), a decision on whether the private half
    lives in an HSM/KMS rather than an environment variable, a rotation schedule,
    and a written key-compromise procedure. The format already supports rotation
    — a code names the key that signed it and every configured key verifies —
    but a rotation nobody has rehearsed is not a rotation. Until a key exists,
    scanning is disabled and says so; nothing pretends.
14. **A print vendor and an artwork pipeline** — codes are minted and verified;
    nothing turns them into something you can print. *Needed:* a vendor
    contract, a secure channel for the mint response (it is the only copy of the
    run and must not travel by email), QR image generation at a tested module
    size and error-correction level for the substrate, an imposition/serialised
    -print workflow, and a physical proof scanned by a real phone camera under
    real light before a run is ordered. The wrapper is where this system either
    works or does not, and none of that has been tested on paper.
15. **A live-ops console** — every authoring route exists and none of them has a
    screen. *Needed:* an operator UI for drafting, previewing (the manifest a
    given release *would* produce, at a chosen time), diffing versions, scheduling
    windows, one-click rollback, and reading the release history. Today this is
    `curl`, which is fine for an engineer and not fine for the person who
    actually schedules a meteor-shower weekend.

### Not blockers, but decisions someone owes us

* Data retention and deletion: how long do we keep photos, telemetry and merged
  accounts? The passport implies "forever"; privacy law implies otherwise.
* Whether the flagship product ships internationally at launch — today the
  catalog says `shipsToCountries: ["US"]` and the API refuses everything else.
* Whether reward-claim review is human-in-the-loop from day one, or whether we
  auto-approve below a risk threshold and accept some fraud.
