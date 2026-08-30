# ADR-0010 — Campsite memory syncs as per-device counters, and the significance score has nowhere to ride

**Status:** accepted

## Context

`CampsiteMemory` in `apps/web/src/state/store.ts` is what a campsite remembers about a player: how many times they have arrived, which resident animals have been seen and on how many nights, which secrets they noticed, which constellations they picked out, and the `Trace`s the significance model chose to keep. It was written to `localStorage` and nothing more. A player who lost their phone lost every campsite that had ever met them.

The service already had a `worldState` domain, and the client had never spoken to it.

Two things make this harder than "PUT the object":

1. **Merging.** Two devices, both offline, both visiting the same campsite. There is no single-writer anywhere in the picture.
2. **§6.4.** The significance model is invisible: *never expose a memory score*. `packages/sim/src/index.ts` deliberately does not export `score`, and the comment there says why. Anything that persists a trace has to keep that true structurally, not by promising.

## Decision

### The score does not cross, because there is nowhere to put it

`SyncedTraceSchema` (`packages/protocol/src/memory.ts`) is `{ id, kind, createdAt, disposition }` and **`.strict()`**. That is four fields, one of which is a timestamp; the rest are identifiers and a three-valued enum.

* **The lifetime is not on the wire.** It is derived from the disposition (`TRACE_LIFETIME_SECONDS`), so there is no float in the payload that could be a score wearing a duration's clothes. It also removes a real bug: `Infinity` is `null` after `JSON.stringify`, and a landmark whose lifetime came back as `null` would have been a landmark that faded.
* **`fade` is not a member of the disposition enum.** A trace the model let go is not expressible. The client already dropped them; now the schema does.
* **The sim's free-form `payload` does not cross at all.** It is the *evidence* — rarity, dwell seconds, interaction counts, whether it was photographed — which is the input side of the same model, and a free-form record is exactly where a score would hide. Everything in it that a returning player actually notices is already carried by `secrets` and `residents`, which are facts about the place rather than opinions about the player. A trace that arrives from the service has an empty payload, and nothing reads one.
* **`.strict()` makes a smuggled field a `422`, not a silent strip.** A stripped field is a field somebody will later assume arrived.

The duplicated lifetime constant is pinned: `packages/protocol/test/memory.test.ts` drives the real `decideTrace` into each disposition and holds the answer against the table, so a retune of the model is a red test rather than a campsite forgetting three months early.

### Visits are a per-device grow-only counter, summed

Each device reports only the nights *it* was there. The server keeps `Record<deviceId, count>` and the total is the sum; a device re-sending its own counter replaces its entry rather than adding to it.

The two obvious rules are both wrong, and each is visibly wrong:

* `max` **loses**. Phone visits twice offline, tablet visits twice offline, the campsite decides it has been visited twice. A night that happened is gone.
* `sum of totals` **double-counts, and again on every re-sync**, because a device's total already includes the visits it learned from the server. The client pushes on a thirty-second timer, so this compounds while somebody sits by a fire.

Per-device counters are exact under both, and idempotent under re-sync. Nothing here needs a vector clock; the counters *are* the clock. The breakdown is never returned to the client — how many phones somebody camps from is not a campsite page's business — only the sum.

The client keeps a small ledger beside the store (`apps/web/src/net/memory.ts`): its own counter, and the last total it accepted, so new local nights are a delta.

### The rest of the merge

| Field | Rule | Why |
| --- | --- | --- |
| An animal's `visits` | `max`, clamped to the merged visit total | It means "how many of your nights this fox turned up on". Each device's number is a lower bound; summing would put a fox on more nights than there have been, which is the one way this number can be visibly wrong. `max` can only undercount, and an undercount reads as a shy fox. It is also exactly the rule `rememberCampsite` already applies locally — a different one here would make the same night merge differently depending on which side did it. |
| Secrets | Union by `secretId`, keeping the **earliest** record (lowest `visitIndex`, then `at`, then lexically) | A secret is noticed once; the fact worth keeping is the first time. Tie-breaking lexically makes the result independent of arrival order. |
| Traces | Union by id; on a collision, the **stronger disposition** and the **earlier `createdAt`** | A disposition only rises when the player cared more, so taking the weaker would forget something they meant to keep. The earlier birth is the honest age, not the flattering one. |
| Sightings | Set union, newest-arriving first, capped at 40 | Prose lines, not a tally. Both devices read the server's order back, so they converge. |
| Constellations | Set union, discovery order preserved | Not a set to complete (§7); a player who never looks up loses nothing. |
| `lastVisitAt` | `max`, clamped to the server's now | A display fact, not a counter. |

An account merge uses the same arithmetic (`absorbCampsiteMemory`), because a merge is never a reset (§6.1) and "the fox that has seen you three times" is exactly the progress the merge policies exist to protect.

### Clock skew is a real case, and it is handled at both ends

Traces fade on a wall clock and a phone's clock is not the server's.

1. **`createdAt` is clamped to the server's now on the way in.** A trace cannot have been created in the future; a phone set a week forward would otherwise mint traces that outlive every honest one.
2. **Expiry is evaluated only against the server clock**, on merge and again on read. A client is never asked when something faded.
3. **The response carries `observedAt`**, and the client re-bases every remote trace onto its own clock by the difference. Two devices a day apart see the same trace at the same strength.

A slow clock still costs its own traces some of their life. That is deliberate: correcting upward would resurrect things, and a trace that fades a little early is a campsite forgetting gently, which is what it does anyway (§6.3 — never punishing).

## Consequences

* A campsite that remembers you survives a lost device and reaches a second one. `GET /v1/passport/campsites` is what a new phone restores from.
* Local-first throughout. `syncCampsiteMemory` returns `null` on any failure and the local memory is left byte-identical; the player never learns anything happened. It is deliberately **not** on the retry queue: a campsite memory is a snapshot of a state that keeps changing, so a stale one waiting in a queue is worth less than the fresh one the next call sends, and the merge is idempotent so the next call fixes whatever this one missed.
* The route is **not idempotency-keyed**, because the merge is idempotent in itself. A key would only add a way for the second sync of an unchanged campsite to be a `409`.
* One new table, `campsite_memories`, keyed `(account_id, campsite_id)`. On Postgres `merge` is `INSERT … ON CONFLICT DO NOTHING` then `SELECT … FOR UPDATE`: a plain `FOR UPDATE` locks nothing when the row does not exist, which is exactly the case two devices hit on a campsite's first sync.
* Cost: the client's `visits` and the server's total can disagree for as long as a device is offline, and the client resolves that with `max` so a night in flight is never lost. Sightings converge as a *set* immediately and as an *order* once both devices have read the server's answer.
