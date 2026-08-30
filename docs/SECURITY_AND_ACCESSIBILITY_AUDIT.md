# Security and accessibility audit

**Status:** first adversarial pass · one session · everything below was run, not
read, unless it says otherwise
**Companions:** [`PRODUCT_SPEC.md`](../PRODUCT_SPEC.md) §9 §10 §11 §12 ·
[`ARCHITECTURE.md`](../ARCHITECTURE.md) §7 §10 §11 ·
[`services/api/README.md`](../services/api/README.md) "Blockers"

---

## 0. What this document is

The product had never been attacked and §12 had never been checked clause by
clause. This is that pass: an adversary's read of `services/api/src`, an
accessibility audit of the client against §12, and a deliberate attempt to
break the offline and degraded paths.

It is written to be *disbelieved*. This repository has been bitten once already
by a confident conclusion drawn from a badly-set-up measurement (defect #17 in
the implementation plan: four wrong diagnoses in a row from a test pose that
never had a fire in it), so every claim below carries its evidence class:

| Class | Means |
| --- | --- |
| **Verified** | A test or a probe was run and the number in this document came out of it. Both the before and the after were measured wherever a fix changed behaviour. |
| **Reasoned** | Read from the code and argued for, with no run behind it. Treat as a hypothesis. |
| **Unchecked** | Named here because it matters and could not be answered in this environment. §7 lists all of them together. |

### What was run

* `npx tsc -b` — clean, before and after.
* `npx vitest run` — **1570 passed, 23 skipped** across 89 files on the
  in-memory repositories (baseline before this work: 1526 passed, 23 skipped).
* `DATABASE_URL=… npx vitest run services/api test/integration` — **415 passed**
  across 33 files against PostgreSQL 16 on `127.0.0.1:5433` (baseline: 397).
  The 23 skips on the memory run are the Postgres-only cases; they run there.
* `npx playwright test --project=access` — the new §12 suite, **6 passed**.
* `npx playwright test --project=acceptance --project=activities --project=offline`
  — regression check on the three suites the client changes could plausibly
  have broken.

The `access` project is wired into CI as its own job (`npm run e2e:access`),
for the same reason every other kind of evidence has one: a §12 suite nobody
runs is a §12 suite that rots. I did **not** run `visual`, `perf`, `mobile`,
`campfire`, `redeem`, `console`, `night` or `pwa-update` — the client changes
here are attributes, two settings rows and key handling, none of which moves a
pixel in a ritual-stage baseline, but that is a *reason* and not a
measurement.

Every finding that was fixed has a test that fails against the code as it was
and passes against the code as it is; where the fix is a bound rather than a
behaviour, the before-and-after figure is quoted.

---

## 1. Security findings

Severity is about this product, not a generic scale: **critical** means
somebody else's account or somebody else's money; **high** means a stated
product constraint is not true; **medium** means an attacker gets something
they should not have had to pay for; **low** means a defence is thinner than
it reads.

| # | Finding | Severity | Where | State |
| --- | --- | --- | --- | --- |
| S1 | An unsigned Apple/Google id token is accepted, and linking merges on it — full account takeover | **critical** | `domain/identity.ts` | fixed |
| S2 | `X-Forwarded-For` is trusted with no proxy configuration, so a client picks its own rate-limit bucket | **medium** | `http/server.ts` | fixed |
| S3 | A WebSocket peer can pin unbounded memory with zero-length continuation frames | **medium** | `realtime/connection.ts` | fixed |
| S4 | Control frames bypassed backpressure, so a ping flood queues unbounded writes | **medium** | `realtime/connection.ts` | fixed |
| S5 | A card number inside free text was not detected | **medium** | `protocol/common.ts` | fixed |
| S6 | `sslmode=verify-full` was silently downgraded to no certificate verification | **medium** | `db/wire/url.ts` | fixed |
| S7 | The Postgres message parser would buffer toward any announced length | **low** | `db/wire/buffer.ts` | fixed |
| S8 | A server could declare SCRAM complete without proving it knows the password | **low** | `db/wire/connection.ts` | fixed |
| S9 | A customer can refund their own paid order, and drive fulfillment as `operator` | **high** | `domain/commerce.ts` | fixed (not by me — see below) |
| S10 | Anonymous account creation is unauthenticated and unmetered, which defeats every per-account limit | **medium** | `routes/auth.ts` | fixed |
| S11 | `POST /v1/events` is unauthenticated and unmetered storage growth | **medium** | `routes/analytics.ts` | fixed |
| S12 | `block` writes a row per message with no dedicated meter | **low** | `realtime/room.ts` | not fixed |
| S13 | `containsRawCardData` stops at twelve levels of nesting | **low** | `protocol/common.ts` | not fixed, argued below |

### S1 — Account takeover with a forged id token · critical · fixed

**Verified.** `resolveCredentialSubject` reads `sub` out of an Apple or Google
id token by base64-decoding the middle segment. Nothing verifies the signature —
the README says so honestly (Blocker 5: "Today an unverified token is accepted,
which is fine for local dev and unacceptable in production") — but the code did
not enforce what the README said, and *production had no different behaviour at
all*.

What that bought an attacker is not "a weaker credential". `linkIdentity`
resolves an existing identity by `(provider, subject)` and, with
`mergePolicy: 'keep_current'`, merges the account that owns it **into the
caller's**. A provider subject is not a secret. So:

```
POST /v1/auth/link            (bearer: a fresh anonymous account)
{ "mergePolicy": "keep_current",
  "credential": { "provider": "google",
                  "idToken": "<header>.<base64url {\"sub\":\"victim\"}>.<junk>",
                  "nonce": "…" } }
```

returned `status: "merged"`, and the victim's passport, photos, sandwiches,
campsites, reward grants, **orders** and code redemptions were reassigned to the
attacker. Measured with `services/api/test/adversarial.test.ts` → *"does not let
a forged token absorb somebody else's account"*, which asserted
`expect(takeover.body.status).not.toBe('merged')` and reported
`expected 'merged' not to be 'merged'`.

**Fix.** `requireVerifiableProvider()` runs before anything is read out of the
credential. Apple and Google are refused with `503 service_not_configured`
naming the blocker, in exactly the shape `codes/signing.ts`, `realtime/voice.ts`
and `media/` already use for a missing credential — the house rule being that a
missing env var must never degrade to *accepting everything*. A development
build opts in with `AUTH_ALLOW_UNVERIFIED_OIDC=true`, which is warned about at
boot (`ConfigWarning.unverified_oidc`) and **is ignored in production**:
`allowUnverifiedOidc` is `nodeEnv !== 'production' && envBool(...)`, so there is
no environment variable that turns this back on for a real deployment.

`/v1/meta` now reports `identityProviders`, so a client can stop offering a
button that cannot work — the same rule as `paymentsConfigured` (deviation D8).
The three test files that legitimately exercise linking now opt in explicitly,
which also documents at the call site that they are driving a development path.

**What this does not do:** it does not implement JWKS verification. Blocker 5 is
unchanged in substance; what changed is that the gap is now closed rather than
open, and the day the credentials exist the work is where the README already
says it is.

### S2 — A header is not an identity · medium · fixed

**Verified.** `clientIpOf` took the leftmost `X-Forwarded-For` entry
unconditionally. That value keys `code_fail:<ipHash>` — the budget in
`domain/codes.ts` whose entire purpose is to make working through a list of
wrapper codes scraped off Instagram expensive — and the anonymous idempotency
scope. One header, and every request is a fresh bucket.

Measured: three accounts, ten guesses each, one socket, thirty different claimed
addresses. `CODE_FAILURES_PER_WINDOW` is 20, so ten refusals were owed.
Before: **0 responses were `429`**. After: **≥10**, which is what the test now
asserts. Re-running the fixed code with `TRUSTED_PROXY_HOPS=1` reproduces the
old behaviour and the test fails again, so the assertion discriminates rather
than merely passing.

**Fix.** `TRUSTED_PROXY_HOPS` (default `0`). At zero the header is ignored
entirely and the socket is the only source of truth. At `n`, the entry `n` from
the *right* is taken — each proxy appends, so that is the last hop a client
could not have written — and a chain shorter than declared falls back to the
socket rather than trusting a short list.

### S3 and S4 — What an open WebSocket costs · medium · fixed

**Verified by measurement, before and after.** Both are legal RFC 6455 traffic,
and neither was visible to the per-connection message limiter, which only ever
counts *completed* messages.

**S3, the fragment flood.** A zero-length continuation frame is six bytes on the
wire and adds nothing to `fragmentBytes`, so `maxMessageBytes` never trips —
but each one pushed a `Buffer` into the accumulator. Measured: **200,000 frames,
1.2 MB of traffic, 200,001 buffers held** and the connection still `open`.
Fixed with a fragment ceiling (`maxMessageBytes / 512`, floor 16) plus two
things the first attempt missed and the probe caught: `handleFrame` now drops
data frames once the state is no longer `open` — without that, a violation
detected at frame 33 still ended up holding all 200,001, because `fail()` sets
`closing`, not `closed`, and `onData` kept parsing — and `fail()` releases the
accumulator. After: connection `closing`, accumulator `null`.

**S4, the ping flood.** The RFC requires a pong per ping, and `write()` skipped
the backpressure check for control frames. A peer that pings hard and never
reads therefore made the server mirror its traffic into a socket buffer nobody
was draining. Measured against a `Duplex` that never calls its write callback —
a peer with a full receive window: **6.35 MB unflushed from 6.55 MB of pings, on
a connection whose `maxBufferedBytes` was 1,024**, still `open`. Fixed by
applying the ceiling to every opcode except `close` — refusing to write a close
frame would mean refusing to hang up on the peer being hung up on. After:
**1,179 bytes** and `closing`.

Regression tests in `services/api/test/realtime-exhaustion.test.ts`, including
one that an ordinary three-frame fragmented message still gets through.

### S5 — A PAN in free text · medium · fixed

**Verified.** The string branch of `containsRawCardData` tested a value with a
PAN-shaped regex and then Luhn-checked the *whole* value, so it only ever caught
the case where the card number **is** the field. A campsite named
`my card is 4242 4242 4242 4242 thanks` was accepted with a `201`. Free text
reaches this API in campsite names, captions, notes, gift messages and support
reasons.

**Fix, and a false start worth recording.** The first version matched any
delimited 13–19 digit run with optional single separators. It was wrong, and the
suite told me so within one run: a v4 UUID yields `6250-7247-4727-9` — four,
four, four, and Luhn-clean — roughly one time in eighty thousand, and
`services/api/test/world.test.ts` failed on a campsite it could not create. The
shipped version matches only the two shapes a person writes a card number in
(a bare run, or the printed groups: 4-4-4-4, 4-4-4-3, 4-6-5, 4-4-4-4-3) **and**
requires the candidate to be delimited by something that is neither a digit nor
a hyphen nor a letter, because a run of digits inside an identifier is an
identifier.

Measured after: **0 false positives over 6,000,000 generated ids** (prefixed and
bare v4 UUIDs), and true on all five of the ways a person writes a card number,
false on eight identifier shapes this service actually mints. Tests in
`packages/protocol/test/common.test.ts`.

The honest limit, which is written into the code comment: a PAN glued to a word
(`ref-4242424242424242`) is not caught. This scan exists to turn a client
mistake into a loud refusal, not to defeat somebody deliberately smuggling a
card number past it — and the field-name guard, which is the load-bearing half,
is unchanged.

### S6, S7, S8 — The hand-rolled Postgres client · fixed

**S6, verified.** `parseDatabaseUrl` mapped `sslmode=verify-ca` and
`verify-full` onto `require`, and `require` connects with
`rejectUnauthorized: false`. An operator who typed the strongest setting libpq
has got exactly the protection of the weakest one, silently. That is worse than
the documented gap (README Blocker 2), because it is *believed*. Both now throw
at parse time with a message that names the limitation and tells you to write
`sslmode=require` and accept it. Refusing to start beats pretending.

**S7, reasoned then bounded.** `StreamParser.next()` read a four-byte length
chosen by the peer and had no upper bound, so a hostile or interposed server
could announce 2 GB and this process would `Buffer.concat` toward it. The
precondition is a server we cannot authenticate — which, until certificate
verification lands, is any server on the far side of `sslmode=require`. Now
capped at 64 MiB (two orders of magnitude above the largest `jsonb` document
this schema stores), checked before any body is waited for.

**S8, reasoned.** `AuthenticationOk` was accepted whether or not the SCRAM
exchange had finished. `finish()` is the only thing that verifies the server
signature, and skipping it hands a man-in-the-middle a session — and, with a
salt and iteration count of its own choosing, an offline crack of the client
proof it just collected. `AuthenticationOk` with an unfinished SCRAM session now
fails the connection. Not exercised against a real hostile server; the guard is
three lines and the reasoning is in the comment.

### S9 — A customer can refund their own order · high · fixed

**Found by reading, not by running** — the path is plainly there and the
existing `commerce.test.ts` exercises it as intended behaviour, so a
demonstrating test would have been asserting that a shipped feature should not
work. That is a product decision, not a defect an audit should quietly make, so
this was written up rather than fixed and the decision handed over. It was taken
while this pass was still running, and the fix is in.

**What it was.** `POST /v1/commerce/orders/:orderId/refunds` authorized on
`loadOrder`, which checks only that the order belongs to the caller. A customer
could therefore order, pay, and refund themselves in full — and
`POST …/transitions`, commented "Operator-shaped fulfillment transitions", let
the same customer drive `in_production → packed → shipped → delivered` with
`actor: 'operator'`. Frozen product plus a self-service full refund is free
product. README Blocker 9 covers the shape of this ("refunds beyond the
customer's own order … stop authorizing the customer") but not this exact case,
which is refunds *of* the customer's own order.

**What it is now.** Both routes take the operator half of the same two-credential
gate live ops already uses (`LIVE_OPS_TOKEN` in `x-somemore-ops-token`, on top of
a real bearer token). Fulfillment transitions are operator-only outright; a
refund stays a legitimate customer action until the goods leave the building,
and needs an operator beyond that. The rule is enforced in the domain as well as
at the route, so a future caller cannot go round it, and `requestedBy` on a
refund now records whoever actually asked instead of always saying `customer`.

"Left the building" is asked of `fulfillment.packedAt/shippedAt/deliveredAt`
rather than of `order.status`, because the status collapses: an order refunded
in part is `partially_refunded` whether it is still in the freezer or already on
somebody's doorstep, and a status test would have taken a legitimate refund away
from a customer who had part-refunded an order that never shipped.

With no `LIVE_OPS_TOKEN` configured the transitions route answers `503
service_not_configured` naming the variable, as every other unconfigured adapter
does, rather than a bare 403 that reads like a bug.

Five tests, all run: a customer cannot advance their own order (and the order
really does not move), a customer cannot refund one that has been packed, an
operator still can and it is recorded as theirs, a customer can still refund
their own unpacked order, and a *nearly* correct ops token is not an operator.
The four existing tests that drove fulfillment on a customer's token now present
the operator credential — that they did not is what made this finding easy to
miss, since the suite asserted the hole as a feature.

That was as far as one shared secret could be taken, and **Blocker 9 is now
closed**: `operator_capabilities` replaces the string with eight named
capabilities (`content:draft`, `content:publish`, `codes:mint`,
`commerce:fulfill`, `commerce:refund`, `moderation:action`, `rewards:review`,
`operators:grant`) and six roles that expand into them. `LIVE_OPS_TOKEN` no
longer opens a single route: it appoints the *first* operator and is spent the
moment anybody holds `operators:grant`, which is what makes it safe to leave the
variable set. Granting is itself a capability, so an editor cannot promote a
friend. A revocation is stored rather than deleted — `revoked_at` on the row,
mirrored into the document — because a missing row cannot say when a permission
was taken away or by whom, and a re-grant clears the revocation instead of
leaving a live row that says it was withdrawn.

One bug on that path is worth recording, because only a real server produced it.
The revoke statement bound one placeholder twice, once against a `timestamptz`
column and once through `to_jsonb(...::text)`; Postgres infers a parameter's
type from its use and rejects a parameter inferred two ways (`42P08`,
"inconsistent types deduced for parameter $3"). It passed against the in-memory
repositories and passed when the same SQL was run by hand in `psql`, because
literals are not parameters — it failed only when a parameterised statement met
a real planner. The fix is the pin the session and magic-link adapters already
used, `$3::text::timestamptz`. Every other reused placeholder in
`repos/postgres/` was then checked by hand; all were already consistent.

### S10 and S11 — The two doors that are open on purpose · fixed

**Verified.** `POST /v1/auth/anonymous` is `auth: 'none'`, `idempotent: false`,
and passed through no rate limiter; `POST /v1/events` is `auth: 'optional'`,
unmetered, and appends a row per event with up to a hundred per request. Both
are correctly *open* — the world boots without an account (§6.1) and telemetry
starts before one exists — and neither was allowed to be *free*.

The consequence of the first is the interesting one: every per-account budget in
this service (`reward_claim:<accountId>`, `code_redeem:<accountId>`,
`connectionsPerAccount` on the realtime edge) was priced at one HTTP request
for a fresh allowance.

I initially wrote this up as needing a decision, because a per-IP cap on account
creation has a real cost to real players — a school, a campsite with one
hotspot, a CGNAT range — and because the address itself was not trustworthy
until S2. It is now, so:

* `ANONYMOUS_SIGNUPS_PER_HOUR` (default 30) meters **minting a new account**,
  after the returning-device branch, so a reinstall costs nothing however many
  times it happens. That is a spec requirement, not a nicety (§6.1), and the
  test asserts it explicitly: with the whole allowance spent, the device that
  already has an account still gets it back, five times over.
* `EVENT_BATCHES_PER_HOUR` (default 600) meters telemetry ingest by address.

Both numbers are deliberately far above honest use and far below a farm — a
household touches the first a handful of times a day and a whole campsite
session is a few dozen of the second — and both are refusals a client can act
on (`429` with `Retry-After`) rather than silent drops.

**Now shared.** Both were in-process (README Blocker 11), so a second instance
doubled both numbers. `createPostgresRateLimiter` moves the window into
`rate_limit_windows`, counted by a single atomic upsert that decides in one
statement whether the existing window is still live or has expired — so two
instances share one allowance rather than one each, and no read-then-write
between them can lose a count. Redis was the assumed fix and stayed unbought;
the database was already there, already durable, and already the thing both
instances agree on. The limiter is chosen the same way every other adapter is:
Postgres when `DATABASE_URL` is set, memory otherwise.

Both remain only as good as `TRUSTED_PROXY_HOPS` makes the address, which is
S2's business and unchanged.

### S12 — `block` writes a row per message · low · fixed

`SessionRoom.handleBlock` wrote a moderation row for an arbitrary account id,
metered only by the 90/s global message bucket — a storage-growth nuisance
rather than an attack, since it needs a real account id to be interesting and
produces nothing but rows. It now has its own bucket in `ConnectionMeters`
alongside `chat` and `authority`. It was deferred last pass to avoid a conflict
with work in `services/api/src/realtime/`; that work has landed, so the reason
to leave it expired.

### S13 — The recursion cap in the card scan · low · fixed

`containsRawCardData` returned `false` past twelve levels of nesting, so card
data nested deeper was not seen. The original argument — that no route's Zod
schema accepts a body thirteen levels deep, so such a body is rejected anyway —
is still true, and raising the cap would still buy a theoretical gap for a real
recursion budget on every request. So the cap stayed and the *answer* changed.

The scan now returns three states rather than a boolean: `clean`, `card-data`,
and `too-deep`. The difference matters because "I looked and found nothing" and
"I stopped looking" are not the same claim, and a guard whose refusal to answer
is indistinguishable from a clean bill of health is one refactor away from
being wrong. `containsRawCardData` keeps its boolean shape for its callers by
asking for `card-data` explicitly, so nothing silently reads `too-deep` as
safe. The constraint this protects is absolute — never store raw card data —
and a guard on an absolute constraint should not be able to shrug.

### What was attacked and found sound

All **verified** unless marked.

* **SQL injection.** Every statement in `repos/postgres/` is parameterised.
  Table names come from static `DocTableSpec`s; every `where` fragment passed to
  `DocTable.first/list/count` is a literal with `$n` placeholders, checked at all
  40 call sites. Nothing user-supplied reaches a SQL string.
* **Session tokens.** `auth/tokens.ts` verifies the HMAC *before* parsing the
  payload, length-checks before `timingSafeEqual`, and pins the protocol major.
  A payload edited without re-signing does not verify.
* **Media authorization.** Storage keys are minted server-side and never
  proposed by a client; a private photo answers `404` to a stranger rather than
  `403`; a valid upload ticket for another account is a `403`; the served
  content type is sniffed from the bytes, not claimed; `writeBytes` puts
  `nosniff`, a sandboxed CSP, `X-Frame-Options: DENY` and
  `Cross-Origin-Resource-Policy` on every binary response.
* **Code signing.** Ed25519 with a keyring, verification is a signature check
  with no data-dependent branch, the body is round-trip-checked against its
  canonical encoding before it is trusted, the signature length is pinned at 64,
  claim-once is a partial unique index rather than an `if`, and every rejection
  a stranger can see collapses to one word. Minted codes are never stored. The
  live-ops shared secret is compared with `timingSafeEqual` over SHA-256
  digests, so token length does not leak either.
* **Reward claim-once under a race.** Two concurrent claims of a legendary
  `perAccountLimit: 1` perk with different idempotency keys produce exactly one
  grant, on **both** backends. On Postgres that is
  `reward_grants_one_live_per_account_reward`; on the in-memory repositories it
  is that no `await` in the path yields to a real I/O boundary, so the two
  handlers cannot interleave. The second of those was **an accident of the
  runtime rather than an invariant** — the memory repositories did not enforce
  claim-once themselves, though `sql/schema.sql` line 9 said they did. That file
  is open now, so `createMemoryRewardGrantRepository` enforces it, and the two
  backends make the same promise for the same reason instead of one of them
  passing because nothing happened to interleave.
* **CORS.** Credentialed routes echo only an exact configured origin, never a
  reflected one, never `*`; public GETs answer `*` with no credentials; the
  preflight is answered before authentication with the *intended* method, so a
  route that starts requiring auth tightens its own answer. The bearer token is
  a header and never a cookie, so there is no CSRF surface.
* **WebSocket handshake.** `Sec-WebSocket-Key` is length- and charset-checked,
  version 13 only, the path is checked, and authentication happens *before* a
  connection object exists. Masking is enforced in the right direction, reserved
  bits and opcodes are rejected, control frames may not be fragmented or exceed
  125 bytes, close codes are validated, and text must be valid UTF-8 —
  the parser is strict, which is the correct posture.
* **Realtime authorization.** A join for a session you are not a member of gets
  the same `not_found` the HTTP API gives, so session ids stay unenumerable.
  Inputs that touch an object require the lease on that object; a refusal costs
  interference budget; blocks are applied in both directions and to the
  late-joiner snapshot as well as the live relay.
* **Error messages.** `/health` reports reachability, latency and pool state and
  never the DSN, the host or the driver's complaint. `redactConfig` omits the
  password. No path was found that returns a key, a path or another account's
  existence.
* **Secrets.** No key material is committed. `AUTH_TOKEN_SECRET` is *required*
  in production — the service refuses to boot on a dev fallback — and every
  other missing credential produces a named `ConfigWarning` at boot and a
  structured `not_configured` at the route.

---

## 2. The standing product constraints, one at a time

| Constraint | Verdict | Evidence |
| --- | --- | --- |
| Never store raw payment-card data, anywhere | **holds, and now holds harder** | Field-name guard plus a Luhn scan that now sees free text (S5). Card data never enters the domain: only provider tokens and intent ids. The Stripe adapter's `displayLabel` carries brand + last4, which is permitted and is not a PAN. No log line writes a request body. |
| High-value rewards are server-validated, claim-once, abuse-resistant | **holds** | Prerequisites are re-derived from server-owned records, never from the request. `valueTier: 'high'` cannot be granted by the inline `grant()` path at all. Claim-once survives a two-request race on both backends (verified). Velocity, device-sharing, nonce-replay and account-age signals feed an auto-reject at 0.5 and human review at 0.25. |
| Campsite privacy defaults to private; voice is never recorded by default | **holds** | `CampsitePrivacySchema.default('private')`. `recording: false` is a *literal type* in `realtime/voice.ts`, not a setting — "record the campfire" is not expressible. Verified by reading the types; there is no provider to check against. |
| No secrets committed; degrade honestly and loudly without them | **now holds** | It did not, for identity: the one missing credential that degraded to *accepting everything* (S1). Fixed, and `/v1/meta` now says which providers can be verified. |
| The significance score is never exposed | **holds** | No `significance` field exists anywhere in `packages/protocol` or `services/api`. A trace carries a four-value `disposition` and a `lifetimeSeconds` derived from it — a coarse ordinal, deliberate, argued in ADR-0010 — and the evidence the model weighed never leaves the device. Nothing in `localStorage` carries a number either. |
| Mystery gates nothing | **holds** | Verified by inspection of the reward prerequisite kinds (`stamp`, `sandwiches_made`, `min_sandwich_score`, `points`, `account_age_hours`, `linked_identity`) — no prerequisite can name a secret or a one-time event, so no reward can be gated behind one. |
| Play never waits on the network | **holds, and is now harder to break** | The offline suite already proved a cold offline boot to a finished sandwich. This pass broke the *device's own* storage instead, which is the failure the offline path does not cover, and found one real defect (§4). |

---

## 3. Accessibility, against §12 clause by clause

§12 has three lists. Each clause below is quoted, then answered.

### Presentation

| §12 clause | State | Note |
| --- | --- | --- |
| subtitles | **now reaches assistive technology** | The setting and the on-screen band existed; the region had no `role`/`aria-live`, so a screen reader never announced the one feature whose whole job is carrying sound to somebody who cannot hear it. Now `role="status" aria-live="polite" aria-atomic="true"`. Same for the guidance line, which also changes without any focus moving. **Verified** by `e2e/access.spec.ts`. |
| text scaling | present | 0.85–1.8, multiplies every font size and every touch target. The bite ring's targets have a `Math.max(44, …)` floor so a reduced scale cannot take them under 44 px. |
| reduced motion | present | Honoured from `prefers-reduced-motion` on first run, and separately settable. |
| reduced flicker | present | `render.flicker`, 0–1. |
| contrast options | present | `accessibility.highContrast`, and `render.contrast`. |
| **colourblind-safe cues** | **gap** | There is no colourblind mode and no setting. See A5 below — the SM-01's amber/blue is a §3.1 *semantic* colour, and it is the one place this matters. |
| adjustable dithering / effects intensity | present | dither, jitter, affine, colour depth, resolution. |
| camera-shake control | present | `reducedMotion` damps shake and sway. |
| fire brightness control | present | 0.35–1.5, and §12's "genuinely tame the fire without removing it" is met by the floor being 0.35 rather than 0. |
| haptic control | present | on/off. |
| volume and ambience control | present | per-bus: master, ambience, fire, machine, foley, ui. `voice` is per-player in the campfire panel rather than on this screen. |

### Gameplay assists

| §12 clause | State | Note |
| --- | --- | --- |
| automatic marshmallow rotation | present | 0–2 rad/s. |
| simplified gestures | **was unreachable, now on the settings screen** | A1 below. |
| stronger assembly snapping | present | 0–1. |
| forgiving timing | present by design | There is no timing failure anywhere in the ritual — a burned marshmallow is a story (§4.2). |
| alternate control schemes | **was largely absent, now complete** | Three separate gaps: assembly and the SM-01 had no keyboard path at all (A2), and a keyboard player could not turn their head, which put every aimed activity in §5.2 behind a pointer (A7). |

### The three rules

> **Assists never change what the player can achieve, only the dexterity required.**

Holds. Every assist is a rate, a strength or an input mapping; none of them
changes an outcome, and the keyboard paths added below reach the same simulation
entry points the pointer does, so a keyboard-placed cracker is recorded with its
real offset and shows up on the finished sandwich exactly as a dragged one does.

> **No information is delivered through a single channel — anything audible has a visible counterpart and vice versa.**

Mostly holds and is well thought through: the roasting heat readout is a word
before it is a bar, the stone's grip is described in words, sitting gets a line
because otherwise it is invisible, and the radio dial has text as well as a
needle. Two gaps: A5 (the SM-01's colour states) and A6 (subtitles are the only
channel for some client-side failure messages, and they are behind a setting
that can be switched off).

> **The fire brightness and flicker controls must genuinely tame the fire without removing it.**

Holds by construction (`fireBrightness` floors at 0.35). **Unchecked** whether
it *looks* right at 0.35 — that is a picture, and §7 covers why I did not judge
one.

### The accessibility findings

| # | Finding | Severity | State |
| --- | --- | --- | --- |
| A1 | `simplifiedGestures` and `virtualJoystick` were implemented, persisted, honoured — and had no control anywhere | high | fixed |
| A2 | Assembly and the entire SM-01 ritual had no non-pointer path at all | **critical for §12** | fixed |
| A3 | Every keyboard path was undocumented; nothing told a player any key existed | high | fixed |
| A4 | Overlays are `role="dialog"` with names, but nothing moves focus into them and nothing traps it | medium | fixed |
| A5 | The canvas has no accessible alternative, and the SM-01's state is colour plus a display texture | medium | fixed |
| A6 | A settings-gated subtitle is the only channel for some failure messages | low | fixed |
| A7 | A keyboard player could not turn their head at all, so every aimed activity in §5.2 was behind a pointer | **critical for §12** | fixed |
| A8 | A pointer look delta was applied once per *simulation step* rather than once, so one drag turned the player as far as the renderer was slow | medium | fixed |

### A1 — Two assists a player could not reach · fixed

**Verified.** `accessibility.simplifiedGestures` and
`accessibility.virtualJoystick` are read by the input layer
(`App.tsx` lines around the pointer-down handler and the fire-tending panel),
are persisted, and survive a cold offline boot — `e2e/offline.spec.ts` asserts
exactly that. And there was no control for either. The only way to switch them
on was to write them into `localStorage`, **which is precisely what the offline
suite was doing**, so the green suite was evidence that the settings persisted
and evidence of nothing at all about whether a player could set them.

This is the §12 version of defect #11: every test that could have caught it set
the value directly, which is what a careful test does and is exactly why it
could not see this.

Fixed: two toggles under Assists. `e2e/access.spec.ts` checks them by role, sets
them through the interface, reads `localStorage` back, and then asserts the
consequence — with simplified gestures on, the fire-tending controls are present
wherever the player is standing.

### A2 — The ritual stopped, for anyone who cannot use a pointer · fixed

**Verified, and this is the finding I would keep if I could keep one.**

Roasting had a keyboard alternative from the start, and the code says so:
`// Keyboard alternative to the roasting drag (spec §12)`. Walking had one.
Every secondary activity had one — torch, binoculars, reclining, the stone, the
rod — each with its own comment citing §12.

Assembly did not. The SM-01 did not.

* Assembly is a pointer drag end to end: pick-up on `pointerdown`, the offset
  from pointer travel, set-down on `pointerup`. There was no branch for
  `stage === 'assembling'` in the key handler.
* The machine's twelve controls are `onClick` handlers on meshes inside the
  WebGL canvas. A `<canvas>` is one focusable thing at best and its contents are
  not in the accessibility tree at all, so the door, the latch, the program
  selector, the confirm and the lever were unreachable by keyboard **and**
  invisible to a screen reader.

So the §1.3 core ritual — the thing this whole product is — terminated at the
plate for a keyboard-only or switch-access player.

**Why the suite could not see it.** `e2e/stages.ts` and `e2e/ritual.spec.ts`
drive both stages through `window.__someMore.actions` — `holdComponent`,
`moveComponent`, `placeComponent`, `machine({type:'pull-lever'})`. Those are the
real simulation entry points, which is the right way to test the *simulation*
and cannot, by construction, tell you whether anybody can reach it. Same shape
as defects #5, #6, #10 and #11: a green suite means the assertions passed.

**Fix.** Keyboard paths for both, reaching the same entry points the pointer
does:

* Assembly — `Enter`/`Space` picks up and sets down; arrow keys shift the held
  piece by 3 mm a press (the drag writes offsets of a few millimetres, so the
  stack still comes out handmade); `[` and `]` turn it. Placement still
  genuinely matters, which is the point: this is not the "Build" button §1.3
  forbids.
* The SM-01 — one key per control: `L` load, `D` door, `X` latch, `1`/`2`/`3`
  program, `Enter` confirm, `P` lever. `canPerform` decides what `D` and `X`
  mean, which is exactly what the mesh under the pointer does. Deliberately
  **not** one key for the run: the twelve stages are the product, and a single
  "go" key would be the canned-video substitution §1.3 rules out.

Verified by a new Playwright project, `access`, whose rule is that once the
ritual reaches a stage under audit **nothing but `page.keyboard` may touch it**.
It walks in, roasts on the arrow keys, assembles four components with deliberate
offsets and rotations, runs the machine control by control, and takes the
sandwich off the tray — and asserts the stack is not four pieces placed
perfectly on top of each other, so the keyboard path is producing a handmade
sandwich and not a default one. Screenshots at
`artifacts/screenshots/a11y-*.png`.

### A7 — A keyboard player could not turn their head · fixed

**Verified.** Found by a second pair of eyes on this pass, and it is the larger
half of A2: the ritual was reachable on the keyboard, and the *campsite* was
not.

`player.facing` changes in exactly two places in `stepPlayer`
(`packages/sim/src/locomotion.ts`): from `intent.look`, and from walking toward
a tapped `moveTarget`. `intentRef.current.look` is written in exactly one place,
inside `onPointerMove`. And `KeyboardMovement.intent()` returned forward/strafe
only, with the arrow keys duplicating WASD. So on the keyboard a player could
translate around the campsite and never change which way they were facing.

Everything §5.2 offers is *aimed*. You could not look at the sky, aim the torch
(`pointTorch` reads `player.facing` and `player.pitch`), face the water to fish,
or look at an animal. The one interaction §5.2 calls out as the quietest and
most important — stillness, and what it brings to the treeline — was reachable,
and seeing what it brought was not.

**Fix.** WASD walks; the arrow keys look. This *removes* a duplication rather
than adding a binding, and it collides with nothing: every other arrow-key
meaning in the product belongs to an anchored stage where walking and looking
are both already off. The one exception is the stone, which is wound up with the
arrows while exploring, so looking is suspended for exactly as long as a stone
is in the hand — the same rule the pointer already follows, where a stone in
hand takes the drag away from looking.

The rate is 1.8 rad/s of yaw (a full turn in about three and a half seconds) and
1.4 rad/s of pitch, which crosses the whole clamped pitch range in a second.
Verified by `e2e/access.spec.ts` → *"the arrow keys look, and WASD does not"*,
which holds a key, checks the player turned, checks the turn **stops** when the
key comes up, checks pitch, and checks that walking still does not steer.

### A8 — A look delta was a rate by accident · fixed

**Verified by reading, fixed in the simulation, covered by unit test.** The
frame loop cleared `intentRef.current.look` *after* `advance()` returned — but
`advance` runs N fixed steps inside that call, and `stepPlayer` added
`intent.look.yaw` on every one of them. At 60 fps N is 1 and the bug is
invisible; under this environment's software renderer N is dozens, so one drag
turned the player dozens of times as far as it should. The comment above the
clear said "a look delta is consumed once, not once per simulation step", which
is what it was meant to do and not what it did.

This is the same family as defect #25 — input applied on the frame's clock
rather than on its own — and it is why A7's fix uses a separate field. A delta
and a rate are different things and the difference only shows up when the frame
rate moves:

* `MoveIntent.look` is a delta, and is now **spent by the step that applies
  it**, zeroed in place. Nothing outside the simulation has to remember to
  clear it, which is what went wrong.
* `MoveIntent.lookRate` is radians per second, multiplied by `dt`, applied on
  every step, and cleared by whoever set it when the key comes up.

`packages/sim/test/locomotion.test.ts` asserts both, including that a rate
produces the same turn over twice as many half-length steps — which is the
property the delta did not have.

### A3 — The keys were nowhere written down · fixed

An alternate control scheme nobody can find is not an alternate control scheme.
There was no key reference anywhere in the product. Settings now has a **Keys**
group listing every binding, under Assists because that is where somebody
looking for one would look. It is a list, not a rebinding screen; rebinding is
a larger thing and nobody has asked for it.

### A4 — Overlays: named, but focus is not managed · FIXED

**Was verified by reading; the fix is verified by test.** Every overlay
(`Settings`, `Passport`, `Terminal`, `RadioDial`, `Scan`, `Campfire`) had
`role="dialog"` with an `aria-label`, a close button with an accessible name,
and `Escape` to shut it. What none of them had was `aria-modal="true"`, a focus
move into the dialog on open, a trap, or restoration on close. Nothing anywhere
in `apps/web/src` called `.focus()` at all.

The practical consequence: somebody opening the Passport on a keyboard was not
taken to it, and could Tab straight back out into the HUD while the dialog
visually covered the screen. `Scan` and `Terminal` are the sharp cases — a code
entry form and a checkout.

**Fixed** with one shared `useDialog` hook rather than six copies
(`apps/web/src/ui/useDialog.ts`). It sets `aria-modal`, moves focus to the first
focusable thing in the panel — or to the panel itself, for one with nothing to
operate, because an empty Passport is still a place a reader should be taken —
cycles Tab and Shift+Tab within it, and returns focus to the control that opened
it.

Two details worth keeping, both of which the first version got wrong:

* **It does not steal focus.** If something inside the panel already has it (an
  autofocused field), it is left alone.
* **Restoration cannot test for containment.** By the time the cleanup runs,
  React has usually detached the panel and `document.activeElement` is `<body>`,
  so `panel.contains(active)` is false and the first version silently did
  nothing — it passed every assertion about the trap and failed the one about
  giving focus back. The question that actually matters is whether the *player*
  has moved focus somewhere else themselves; if they have, dragging them back
  would be the rude thing, and if focus has merely fallen to the document it
  belongs on the opener.

Two tests, one per overlay shape: focus lands inside, survives forty Tabs and
eight Shift+Tabs — more presses than either panel has controls, so a trap that
only holds for one lap fails — and comes back to the button on Escape.

### A5 — The canvas, and the machine's colour · FIXED

**Verified by reading; the fix is verified by test.** The `<canvas>` had no
`aria-label`, no role, and no textual alternative: everything a player does in
the world existed only as pixels as far as assistive technology was concerned.
Inside that sat a specific §12 breach — §3.2 makes the SM-01's colour semantic
(amber working, blue transforming, pulsing amber a fault) and `indicatorColor()`
was the only place that lived. `displayText()` exists but is rendered into the
panel *as a texture inside the canvas*, so it was never a second channel for
anybody who could not see the first one.

**Fixed, in the part that is a bug:** a visually-hidden live region narrates the
machine's state in words at every stage, and names the colour as well as the
state — "Running. The chamber light is amber", "Freezing. The chamber light has
turned blue", "Fault. The light is pulsing amber" — so the two channels describe
the same machine rather than two different ones. Hidden rather than shown
because the panel is the display for everyone who can see it, and a caption
repeating it would be noise. The canvas now carries a role and a name, so the
largest element on the page is no longer anonymous.

**And the half that was left open is closed too.** There is now a survey: `Q`
asks what is around you, and the campsite answers in prose — what is in reach,
how the fire is actually burning, what is close enough to walk to and in which
direction relative to your own body, where you are standing, the weather, and
whether anything is at the edge of the light.

Three things about it are deliberate. It is **asked for and never volunteered**,
because a world that describes itself unprompted is one nobody is standing in.
It is **shown as well as announced** — a survey only a screen reader receives
would be the §12 single-channel rule broken by the feature written to keep it.
And it is **prose**: bearings are "behind you and to the left" rather than
degrees, distances are paces rather than metres, and a place with no phrasing is
left out rather than mangled. The first version read an identifier straight into
a sentence — "You are in water-edge." — which is the difference between a survey
and a data dump.

It is composed from the same world the renderer draws: the walkable world's own
interactables, the fire's own state, the animals the simulation reports. Nothing
in it is a second description that could drift from the first.

What remains is a judgement rather than a gap: a survey is not a map, and
whether somebody could *navigate* this campsite without sight — as opposed to
knowing what is in it — has not been tested, because testing it needs a person
who does that.

### A6 — Subtitles as a single channel · FIXED

Some client-side failure reports went out through `store.setSubtitle` —
including the one raised when a deployment refuses to sign you in. Subtitles are
the text channel for something *audible* and they sit behind a setting a player
may have switched off, so a message that is not a transcript could vanish
without trace. The §12 rule about single channels, applied to the product's own
error reporting.

**Fixed** with a `notice` channel on the store, rendered unconditionally with
`role="status"`. There was exactly one call site, which is why this is small;
what it buys is a place for the next one to go.

---

## 4. Error, offline and degraded paths

### The "not configured" reports

**Verified by reading all of them, and by test for two.** The house pattern —
a structured report naming the environment variable, a named fallback, and
never a fake success — is followed by `payments/`, `media/` (a `200` with
`status: 'not_configured'` and `fallback: 'device_local'`, because "nowhere,
here is why" is a complete answer to "where do I put this"), `realtime/voice.ts`
(`recording: false` is a literal type), `codes/signing.ts` (scanning switches
off rather than accepting everything) and `routes/liveops.ts` (`503` naming
`LIVE_OPS_TOKEN`).

One was missing and is the reason S1 existed: identity had no such report. It
has one now.

### At the client

**Verified.** One dishonest path, found by following the fix for S1 outward:
`App.tsx`'s Passport link handler set `passport.linkedProvider` optimistically
and then ignored the result of `SyncEngine.link()`. The optimism is right — the
Passport is already this device's and linking uploads rather than replaces it
(§6.1) — but a service that refuses left the booklet saying "Linked with
google" forever. A Passport that claims an account exists when none does is the
one lie that object may not tell. It now reverts and says so.

### Breaking things on purpose

| What I broke | Result |
| --- | --- |
| `localStorage` holding a document that is valid JSON and the wrong shape | **defect found, fixed** — below |
| `localStorage` full: every write throws `QuotaExceededError` | Holds. The world opens, the session works, the Passport falls back to trimming photo data URLs, and a settings change that cannot be stored is still a settings change for tonight. Now covered by test. |
| `localStorage` holding invalid JSON | Already held; already tested. |
| A settings document from an older build | Holds — missing fields take defaults. Now covered by test. |
| The API returning a valid-but-wrong-shaped payload | Holds. Every client read goes through a Zod schema (`ServiceMetaSchema` and friends), and the sync queue treats a schema failure as a failure rather than as data. |
| A manifest from a newer schema version | Holds by design (ADR-0007): the client boots from the compiled catalogue and the overlay is an overlay. `overlaySource: 'none'` is explicitly not a failure state. |
| A hostile Postgres server | S6, S7, S8. |
| A hostile WebSocket peer | S3, S4. |

**The defect.** `loadSettings` merged the stored document into the defaults with
a spread and no validation, so every field in that file was trusted. That is not
just a crash risk: `accessibility.autoRotate` is handed straight to
`createRitual`, so a corrupt record containing `"fast"` put a `NaN` into the
marshmallow's rotation and **the roast stopped turning** — a silently broken
assist, for exactly the person who asked for it. `textScale` multiplies every
font size in the interface, so a string there renders `NaNpx` and silently
un-scales the text for exactly the person who asked for it to be larger.

Fixed with `sanitizeSettings`: numbers are numbers or they are the default, and
they are clamped to the range the settings screen offers; booleans are booleans;
anything that is not a plain object contributes nothing. Nothing rejects a
record — a settings file must never be a reason the campsite does not open.
Verified in `apps/web/test/degraded-storage.test.ts`, which also confirms the
Passport survives eight wrong-shaped documents and a full disk.

I did **not** find a break from killing the API mid-ritual, revoking the camera,
or dropping the WebSocket mid-hand-off; the first two are covered by existing
suites and the third belongs to the multiplayer workstream that is mid-flight.
§7 says which of those I actually ran.

---

## 5. What I changed

### Fixed

| Area | Files |
| --- | --- |
| S1 unverifiable OIDC refused; `/v1/meta` reports verifiable providers | `services/api/src/{config,app,services}.ts`, `routes/health.ts`, `domain/identity.ts` |
| S2 trusted-proxy-aware client IP | `services/api/src/{config,http/server}.ts` |
| S10/S11 per-address budgets on the two unauthenticated write paths | `services/api/src/{config.ts,domain/identity.ts,domain/analytics.ts,routes/auth.ts,routes/analytics.ts}` |
| S3/S4 WebSocket fragment ceiling and control-frame backpressure | `services/api/src/realtime/connection.ts` |
| S5 PAN detection in free text | `packages/protocol/src/common.ts` |
| S6/S7/S8 wire client: refuse `verify-*`, bound the parser, require SCRAM to finish | `services/api/src/db/wire/{url,buffer,connection}.ts` |
| A1 two assists on the settings screen · A3 the key reference | `apps/web/src/ui/Settings.tsx` |
| A2 keyboard paths for assembly and the SM-01 | `apps/web/src/App.tsx` |
| A7 the arrow keys look; WASD walks | `apps/web/src/{App.tsx,interaction/movementControl.ts}`, `apps/web/src/ui/{Hud,Settings}.tsx` |
| A8 a look delta is spent by the step that applies it; a held key is a rate | `packages/sim/src/locomotion.ts` |
| Subtitles and guidance announce | `apps/web/src/ui/Hud.tsx` |
| Settings sanitisation | `apps/web/src/state/store.ts` |
| The link UI stops claiming an account that does not exist | `apps/web/src/App.tsx` |

New tests: `services/api/test/adversarial.test.ts` (8),
`services/api/test/realtime-exhaustion.test.ts` (3),
`apps/web/test/degraded-storage.test.ts` (13), `e2e/access.spec.ts` (6, a new
Playwright project), plus cases added to
`packages/protocol/test/common.test.ts`, `services/api/test/db-wire.test.ts`,
`packages/sim/test/locomotion.test.ts` and `apps/web/test/movement.test.ts`.

### Deliberately not fixed

| # | Why |
| --- | --- |
| S12 `block` row growth | Small, and `realtime/` is under active work by another workstream. |
| S13 card-scan recursion cap | Argued above: the schema rejects the shape anyway, and raising it costs every request. |
| A5 navigating without sight | The survey says what is here; whether somebody could *navigate* by it has not been tested, because that needs a person who does. |
| Memory repositories do not enforce claim-once | They are for tests and dev, the HTTP path cannot race on them, and the schema comment that says otherwise is the thing to fix. |

---

## 6. Two things I got wrong

Recorded because the plan's entry on defect #17 is right that being wrong in a
particular way is worth keeping.

**I expected the in-memory backend to double-grant a legendary reward under a
concurrent claim, and it does not.** The reasoning was sound as far as it went —
the memory repositories enforce no claim-once rule of their own, and the domain
has many `await`s between reading the count and writing the grant. What I had
not accounted for is that none of those awaits crosses a real I/O boundary, so
the whole handler drains as microtasks before the next request's handler starts
and the two can never interleave. The test I wrote to demonstrate the defect
passed on both backends. I kept it, as a regression test for the thing I
believed was broken, and wrote down that the memory backend's safety is a
property of the runtime rather than an invariant.

**My first PAN detector was worse than the thing it replaced.** It matched any
delimited 13–19 digit run and made the suite intermittently red on a UUID that
happened to Luhn-check. It cost two more iterations to find the rule that
actually separates a card number from an identifier, and a six-million-sample
false-positive run to believe the result. A guard that occasionally refuses
legitimate content is not a stricter guard, it is a broken feature, and I nearly
shipped one in the name of a constraint marked non-negotiable.

---

**And one I did not find at all.** A2 — assembly and the SM-01 having no
keyboard path — was mine. A7 — that a keyboard player could not turn their head,
which puts *every aimed activity in the product* behind a pointer — was not: it
was found by somebody else reading the same code on the same day, after I had
declared "alternate control schemes" complete on the strength of having made the
*ritual* reachable. I audited the thing the spec's §1.3 table names and stopped
there, and §5.2 is half the product. The lesson is narrower than "look harder":
I checked that each interaction had a keyboard path and never checked that the
*camera* did, because the camera is not an interaction in any list.

---

## 7. What could not be checked here, and why

Stated plainly, because the value of everything above depends on knowing where
it stops.

**No screen reader.** There is no VoiceOver, no NVDA, no TalkBack and no
Orca in this environment. Every claim in §3 about assistive technology is a
claim about **markup**: roles, names, live-region attributes, and focus order as
the DOM defines it. That a `role="status"` region is *announced*, that it is
announced at the right moment, that `aria-atomic` reads the line whole, that the
dialog names are useful rather than merely present, and that the HUD's narration
is followable rather than a stream of interruptions — none of that is verified.
It is the single largest gap in this document. A11y markup being correct and a11y
being *usable* are different claims and I can only make the first.

**No browser but Chromium**, and headless Chromium at that. Focus-visible
styling, forced-colors / high-contrast mode, Safari's and Firefox's
accessibility trees, and iOS Safari's handling of `aria-live` inside a
`position: fixed` overlay are all unchecked.

**No touch device, and no switch or voice control.** Everything in §3 about
"alternate control schemes" was verified with a keyboard, and one thing about
it is a *judgement* rather than a measurement: whether 1.8 rad/s is a
comfortable turn rate, or whether a fixed rate should have acceleration, is
something you find out by holding the key on a real screen for ten minutes. Whether the keyboard
paths are *reachable* through switch access or voice control (which drive
focusable, named controls, not key bindings) is unknown — and it is the reason
A5 matters more than its severity suggests: a switch user needs named controls,
not shortcuts. This compounds the plan's existing shortfall S2.

**No real device, so no real screen.** Whether `fireBrightness: 0.35` still
reads as a fire, whether high contrast is actually higher contrast on an OLED at
night, whether the text at 1.8× still fits its containers on a 375 px phone —
all pictures, and this environment's SwiftShader renderer plus the plan's own
lesson about badly-set-up scenes means I did not try to judge them from a
screenshot.

**No hostile server, and no network in the middle.** S6, S7 and S8 are about
what a Postgres server on the far side of an unverified TLS connection can do.
The fixes were tested against synthesised bytes; none was tested against an
actual malicious server, because standing one up is a bigger piece of work than
the bugs warrant and the fixes are bounds rather than behaviours.

**No load.** Every resource-exhaustion figure in §1 comes from a single process
driving an in-memory `Duplex`. They are the right order of magnitude and they
show the fix works; they are not capacity numbers.

**No Stripe, no LiveKit, no bucket, no email.** Unchanged from the README's
blockers. The refusal paths were exercised; the success paths were not, because
they cannot be. That includes the one thing I most want checked: whether a real
Stripe webhook signature verifies against `verifyWebhook`, which has never seen
a real one.

**I did not kill the API mid-ritual, revoke the camera, or drop the WebSocket
mid-hand-off with a real second client.** The first is covered by
`e2e/offline.spec.ts` at a coarser grain (the whole ritual, offline, from a cold
document); the second is guarded in `Scan` by only constructing a camera behind
a button that says so, which I read but did not exercise; the third belongs to
the multiplayer workstream that was editing those files while this audit ran,
and driving it would have meant testing a moving target.

**Coverage of `apps/web/src/net/` and `apps/web/src/scene/` is read-only.**
Another workstream owns those two directories. Findings there are reported, not
edited, and the realtime client's timeline handling in particular got a reading
and not an attack.
