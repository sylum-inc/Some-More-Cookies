# ADR-0011 — Operators hold named capabilities, not a shared secret

**Status:** accepted

## Context

Every authoring surface in the service was gated by one string. `LIVE_OPS_TOKEN`
arrived as `x-somemore-ops-token` alongside an ordinary bearer token, and
holding it meant you could draft a document, publish it to every player, mint a
hundred thousand codes, advance somebody's order and refund it.

Two credentials, one of which is a real account in the audit trail, is better
than a shared secret alone — the trail says *who*. But it says nothing about
*may*, and it has three properties that get worse the moment more than one
person does this work:

1. **No separation.** The person scheduling a meteor-shower weekend and the
   person authorising a refund hold the identical permission.
2. **No revocation.** Somebody leaves and the only remedy is rotating a string
   that everybody else is also using.
3. **No least privilege for the console.** `apps/console` had to enable every
   control for whoever pasted the string, so a copywriter was one mis-click
   from a print run.

This was recorded as Blocker 9, "waiting on a staff identity provider" — an
external dependency, and therefore something nobody could act on.

## Decision

**The blocker's premise was wrong.** What the service needed was not somebody
else's directory of humans but its own model of what a human may do. Accounts
already exist, are already authenticated, and are already attributable.

### Capabilities, not roles, are the unit

Eight of them: `content:draft`, `content:publish`, `codes:mint`,
`commerce:fulfill`, `commerce:refund`, `moderation:action`, `rewards:review`,
`operators:grant`. Each route names the one it requires, so the permission a
reader sees in `routes/` is the permission the service checks.

Roles (`author`, `editor`, `printer`, `fulfilment`, `support`, `admin`) expand
into capabilities at the moment of granting and are not stored. A role is a
convenience for the person doing the granting; storing it would mean a later
edit to a role definition silently re-permissioning people who were granted it
months ago.

### Granting is itself a capability

`operators:grant` gates the grant route. Without this the model has a hole in
the middle of it: anyone who could author could appoint themselves anything.

### Revocations are stored, not deleted

`revoked_at` on the row, mirrored into the document, rather than `DELETE`. A
revocation is a fact about a person and a moment, and a missing row cannot say
when a permission was taken away or by whom. Re-granting clears the revocation
rather than inserting a second row, so there is exactly one row per (account,
capability) and no history that contradicts itself.

### The shared secret becomes a bootstrap, and is spent

A fresh database has no operators, so something has to make the first one.
`LIVE_OPS_TOKEN` does that and nothing else, and it stops working the moment any
account holds `operators:grant`. That is the difference between a bootstrap and
a standing permission, and it is what makes leaving the variable set in a
running deployment safe. It must still arrive alongside a real account, so even
the first appointment is attributable.

## Consequences

* An SSO provider, if one is ever bought, federates *into* this model — it maps
  people to accounts, which the service already has. It does not replace it.
* `apps/console` reads `/v1/operators/me` at boot and disables each control from
  the capability its route checks, so permission is visible before the click
  rather than as a 403 after it.
* The in-memory and PostgreSQL repositories both implement the same interface,
  so the model is testable without a database — which is also how the one
  genuinely database-shaped bug in it hid for a while. The revoke statement
  bound a single placeholder as both a `timestamptz` and a text value, which
  only a real planner rejects (`42P08`). Recorded here because it is the
  argument for the Postgres suite existing at all: an adapter that is only ever
  exercised in memory is an adapter that has not been exercised.
