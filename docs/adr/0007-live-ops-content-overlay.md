# ADR-0007 — Live content is a versioned overlay with append-only releases

**Status:** accepted

## Context

Environments, seasonal events, station programming and reward definitions are
compiled into the client through `packages/content`. That is right for the base
catalogue: the campfire must start with no network (ARCHITECTURE §1.5), and
twelve authored environments are not something to download at boot.

It is wrong for anything that changes after ship. A meteor-shower weekend, a
winter campsite, a limited flavour and a reward that turns on in March are
operations, not builds (spec §14), and shipping a client update for each of them
means the schedule is set by app-store review.

Three things had to be true of whatever we built:

1. A client that never reaches the service is a fully working client.
2. A document that violates the content rules must be rejected when an operator
   publishes it, not when a player's phone renders it.
3. A bad publish must be undoable in seconds, by a person, without a deploy.

## Decision

**Content documents with a lifecycle, assembled into an append-only release
history, served as an overlay behind cache validators.**

- A document is `(kind, slug, version)` plus a body and an activation window. It
  moves `draft → staged → published → retired`. There is no un-publish: taking
  something down is `retired`, which is its own event.
- **Validation on publish reuses `packages/content/src/validate.ts`** — the same
  validator the compiled catalogue passes — plus referential checks that need
  storage (does this event name an environment that exists; does it offer a
  reward anybody defined). Reward definitions are validated by the protocol's
  own Zod schema, because rewards are a wire contract rather than content.
  Issues come back as `{ path, message }` with dotted paths, all of them at
  once, so a person can fix the document rather than play whack-a-mole.
- Every publish, retirement and rollback appends an immutable numbered
  **release**: exactly which document versions were live. Nothing is ever
  rewritten.
- **A rollback is a new release.** Promoting release 7 does not resurrect
  retired rows; it republishes those bodies as *new* document versions and
  retires whatever the target release did not contain. Release 12 records that
  it reproduces release 7. Forward-only, for the same reason the migration
  runner is forward-only: the state that ships is a state that was recorded, and
  "what was live at 03:14" stays answerable after three rollbacks in a row.
- **Delivery is `GET /v1/content/manifest`** with a strong ETag and
  `If-None-Match` support. The client boots from its compiled catalogue and
  applies the manifest afterwards. The payload literally contains
  `overlay: true`, and the schema does not permit `false`.
- **Activation is evaluated server-side against the injected clock**, never
  `Date.now()` in a handler and never a time the client sent. The ETag covers
  both the release version and the current activation state, so a window opening
  flips the validator without anybody publishing anything — a phone polling with
  a stale ETag learns about the meteor shower on the request that would
  otherwise have been a 304.

## Alternatives considered

**Serve the whole catalogue from the service.** Rejected: it makes the network
part of the boot path, which is the one thing ARCHITECTURE §1.5 forbids, and it
would mean the first run of a fresh install has no world until a fetch lands.

**Mutate documents in place and keep a change log.** Rejected: the log then has
to be trusted to be complete, and a rollback is a replay of it. Immutable
versions plus immutable releases make the same question a lookup.

**A second validator inside the service.** Rejected explicitly. Two validators
are two answers to one question, and the day they disagree is the day live ops
publishes something the client refuses to load.

**Weak ETags / `Last-Modified`.** Rejected: activation state changes on a clock,
not on a write, so a modification date would go stale while the content did not.

## Consequences

- Adding a live content kind is a validator function and an enum member. The
  lifecycle, releases, rollback, manifest and caching are already there.
- The manifest is public and cacheable, which adds two routes to the
  deliberately-public list in `routes.test.ts`. That is intentional: it is the
  same data that ships inside the client.
- Rollback re-runs validation. A validator that has tightened since the original
  publish can therefore block a rollback. That is deliberate — the alternative is
  knowingly republishing content we now consider broken — but it means tightening
  a rule is a decision with a blast radius, and the error says exactly which
  document and which path.
- `services/api` now depends on `@somemore/content`, which depends on
  `packages/sim`. The direction is unchanged (`sim → content → api`); nothing
  content-side learns about the service.
- Authoring is gated by `LIVE_OPS_TOKEN` **and** a normal bearer token. That is
  not RBAC and does not pretend to be; see the blocker on staff authentication.
  With the variable unset the service is read-only and says so, with the missing
  variable named.
