# ADR-0008 — One signed, offline-verifiable code format for wrappers, events and campfires

**Status:** accepted

## Context

Spec §14 wants the real product and the digital world connected: package codes,
event QR links, collaboration drops. §9 already has a QR join path for
multiplayer, and `packages/protocol/src/session.ts` shipped
`somemore://join?t=<token>` for it.

The hard constraint is that **a code printed on a mass-produced wrapper is
public**. It will be photographed, posted, cropped, zoomed and scraped. Anything
that treats it as a secret is already wrong. Meanwhile spec §11 requires that
high-value rewards be server-validated and abuse-resistant.

## Decision

**One grammar for every scannable thing, signed with Ed25519, with the value
held server-side.**

```
somemore://c/SM1.<base64url(body)>.<base64url(signature)>

body = "1|<kind>|<keyId>|<batchId>|<ref>|<nonce>|<expiry>"
```

A canonical, positional, pipe-delimited body rather than JSON, because a
signature covers exact bytes and "re-serialise the object the way the signer
did" is a class of bug this format does not have. The parser re-encodes what it
parsed and refuses anything that does not round-trip.

**Why each field is there**

| Field | Why it is in the code |
| --- | --- |
| `version` | Lets the layout change without invalidating anything already printed; verification dispatches on it. |
| `kind` | `pkg` / `evt` / `camp`. One format for wrappers, event cards and campfire invites, so there is one parser and one signature check. |
| `keyId` | Key rotation without a reprint: the new key mints, every configured key still verifies. |
| `batchId` | Which print run. This is what makes a compromised run retirable **without invalidating every code ever printed**, and it is the key the entitlement hangs off. |
| `ref` | Which code within the run (a hex serial), or the invite token for `camp`. `(batch, ref)` is the identity the database enforces claim-once on. |
| `nonce` | 96 bits of per-code randomness, so one wrapper photographed on Instagram tells you nothing about the next box. There is nothing to enumerate. |
| `expiry` | Unix seconds, so a two-year-old wrapper stops being interesting without a database round trip. |

**What is deliberately kept out**

- **No account, name, email or any identifier of a person.** A code is minted
  months before anyone owns it, and a photographed wrapper must not identify the
  person who bought it.
- **No auth token, session token or capability.** The code authenticates
  *itself*, not a person; redeeming one always requires an authenticated
  account. A scraped code with nowhere to put it is worth nothing.
- **No reward id, sku, or monetary value.** A photo of a wrapper must not
  advertise "this is the free-kit code". The entitlement lives on the batch,
  server-side, and can be changed, downgraded or switched off after the boxes are
  already in a warehouse.
- **No secret of any kind**, and — because minted codes are never persisted —
  nothing in the database for a leaked backup to contain either. The mint
  response is the only copy; it goes to the print vendor.

**Why Ed25519 rather than an HMAC.** A truncated HMAC would be ~70 characters
shorter, but only we could check it. Ed25519 makes the code genuinely
offline-verifiable: the client ships the public key and can reject a mistyped or
forged code with no network at all, which matters at a campsite on one bar of
signal. Verification is a signature check rather than a comparison, so there is
no timing oracle; `node:crypto`'s `verify` does the whole job. A signed code is
162 characters as a URI, which is a comfortably printable QR.

**Claim-once is a database index, not application logic.**
`code_redemptions_one_per_code` is unique on `(batch_id, code_ref)`;
`code_redemptions_one_per_account` is a partial unique index on
`(batch_id, per_account_key)`, where `per_account_key` is the batch's
one-per-account rule projected onto the row that has to obey it (a partial index
cannot consult another table). Two phones scanning the same posted photo at the
same instant produce one grant and one refusal, regardless of interleaving. This
mirrors `reward_grants_one_live_per_account_reward` exactly, for the same reason.

**Abuse is designed for, not noted.**

- A forged code dies at the signature check, before storage is touched at all.
- Failures are rate-limited per account *and* per salted IP hash; a real code
  presented twice counts as a failure, because that is what working through a
  scraped list looks like.
- Every "no" a stranger can provoke is the same word (`invalid`): malformed, bad
  signature, unknown key, unknown batch and never-minted are indistinguishable
  from outside. Only the reasons a real customer needs — expired, withdrawn,
  already used — are distinguished, and each of those is already obvious to
  someone holding the box.
- A serial beyond what the run ever minted is refused, which is the check that
  survives a leaked signing key long enough to notice.
- A run being redeemed unusually fast is **flagged for a human, not
  auto-retired**: pulling a live run punishes everyone holding a real box, and
  that is a decision a person makes.

## Alternatives considered

**Keep `somemore://join?t=` and invent a second format for packaging.**
Rejected: two grammars, two parsers, two verification paths, and the campsite
join path would keep accepting an unsigned bearer token forever. The signed
format now serves `JoinMethod.qr` too, so a forged camp QR is rejected before the
invite table is read. The legacy payload is still accepted, because codes in the
wild must keep working and a deployment with no keys must still be able to invite
a friend to a fire.

**Store every minted code and look it up.** Rejected: it makes the mint a
database of valuable secrets, makes redemption a lookup rather than a proof, and
buys nothing the signature does not already provide.

**Put a signed entitlement in the code so redemption is stateless.** Rejected:
the wrapper then advertises what it is worth, and the promotion can never be
changed after printing.

**A short numeric code, checked against a table.** Rejected: enumerable, and
"how many codes do we have to hand out before someone finds one" becomes a real
question.

## Consequences

- Key material comes from `CODE_SIGNING_KEY_ID`, `CODE_SIGNING_PRIVATE_KEY` and
  `CODE_VERIFY_PUBLIC_KEYS`. With none set, scanning is **disabled with a
  structured `not_configured`** — it never degrades to accepting everything,
  which is the only failure mode that would turn a missing environment variable
  into free ice cream. A deployment may hold only public keys: it verifies codes
  signed elsewhere and refuses to mint.
- Redeeming a code may grant a `high`-tier reward without the gameplay
  prerequisites the claim flow enforces. That is the point: the signed code, its
  active run, and a database row that just won a uniqueness race *are* the
  server-side validation. Per-account limits, global caps and availability
  windows still apply.
- Because the service never stores codes, it cannot re-issue one. A lost print
  file is a reprint, and that is the right trade.
- Ed25519 is deterministic (RFC 8032), so the same body always yields the same
  code. Claim-once therefore keys on `(batch, ref)` rather than on a hash of the
  string, which would be the same thing with extra steps.
