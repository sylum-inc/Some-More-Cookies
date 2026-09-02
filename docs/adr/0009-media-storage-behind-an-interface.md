# ADR-0009 — Photo bytes behind a `MediaStorage` interface, with a real local-disk adapter

**Status:** accepted

## Context

Photo mode has always produced real images (spec §10) and had nowhere to put them. They were data URLs in `localStorage`, hard-capped at twenty-four with a comment saying "until object storage exists". The service modelled photo *metadata* — a storage key, a size, a visibility — and there were no media routes at all: nothing had ever accepted an image byte.

The blocker is genuine and external: there is no bucket, no credentials, no CDN origin (README, Blocker 3). The precedent for that situation in this repository is `PaymentProvider` and `VoiceRoom` — an interface, an adapter structured against the real API that reports `not_configured` without credentials, and a second adapter that actually works so the path exists and can be tested.

## Decision

**`MediaStorage` (`services/api/src/media/types.ts`) is the only seam through which image bytes move.** Same shape of honesty as `PaymentProvider`: `isConfigured()`, `unavailableReason()`, and a structured result from every method. Nothing here throws for a missing credential, because "degrade, never block" (ARCHITECTURE §1.5) is not compatible with an exception on the photo path.

Two adapters:

* **`createLocalMediaStorage`** — writes to a directory with `node:fs`. This is a **real implementation, not a mock**: atomic writes through a temp file and a rename, keys re-validated and path-resolved against the root, content type decided by sniffing the bytes on every read. A single instance with a volume can genuinely run on it. What it is not is *shared*: two instances behind a load balancer do not see each other's directory.
* **`createS3MediaStorage`** — structured against the real S3 REST API, with SigV4 implemented over `node:crypto` and pinned against AWS's own published `get-vanilla` test vector. It has never been run against a live bucket. With no credentials it reports `not_configured`, and the upload endpoint answers `200` with a structured report and a `device_local` fallback.

**The upload is two requests**, because that is the shape a pre-signed object-storage URL has: `POST /v1/media/uploads` returns a ticket, `PUT /v1/media/uploads/:photoId` sends the bytes. The day a bucket exists, the ticket names the provider's URL and the client's code does not change.

**The ticket is an HMAC, not a row.** `smu1.<payload>.<hmac>` over the same secret session tokens use. A pending-upload table would need a migration, a sweeper for tickets nobody redeems, and a shared view across instances; an HMAC needs none of those. It names the account, and the upload still requires that account's bearer token, so a leaked ticket alone is worth nothing.

**Everything a photo endpoint has to get right that a JSON endpoint does not is decided above the adapter**, so swapping local disk for S3 cannot loosen it:

| Concern | Decision |
| --- | --- |
| Content type | Decided by the bytes' magic number, on the way in **and** on the way out. The client's header is compared to that and never believed. A file claiming to be a PNG and is not is `415`, and nothing is written. |
| Size | Enforced at the HTTP edge before buffering: `content-length` is refused up front, and the running total cuts off a client that lied. A per-route ceiling (8 MB) rather than raising `MAX_BODY_BYTES` for the ninety endpoints that have no business receiving eight megabytes. |
| Path traversal | Keys are minted server-side and never proposed. The adapter validates the key again and then checks the *resolved* path is inside the root, because a key can be character-legal and still escape. |
| Serving as a document | Four image types are storable; the served type is the sniffed one; and `nosniff`, `default-src 'none'; sandbox`, `X-Frame-Options: DENY` and `Content-Disposition: inline` go on every binary response from one place in `http/router.ts`. |
| Who may read | `private` (the default) is owner-only; `campsite` is that campsite's members; `link` is anyone holding the id; `public` is anyone, signed out. Blocks always win. **A photo you may not see is a 404**, not a 403 — whether a private photo exists is not a stranger's business either. |

**Privacy defaults to private.** `PhotoVisibilitySchema` defaults to `private` in the protocol, the upload request never widens it, and the client never sends a visibility a person did not choose.

## Consequences

* The whole path exists, works and is tested today, on a machine with no cloud account: request, store, serve, authorize, delete.
* `apps/web` stops treating twenty-four as a cap on the album. It is now a cap on how many *un-uploaded* photos a device carries; once bytes are safely stored the data URL is dropped and the entry stays. That is the actual player-visible payoff.
* The API now serves bytes, which it did not before: `RouteResult.raw`, `Route.binaryBody` and `Route.maxBodyBytes` are new, and `writeBytes` is the only thing allowed to emit them.
* Cost: the local adapter is not a production answer for more than one instance, and says so at boot (`config.local_media_storage`) and at `GET /v1/meta`. The S3 adapter's signature is proved and its *behaviour against a real endpoint* is not — bucket policy, CORS on a browser's direct PUT, lifecycle rules and the retention policy the Passport's delete promise needs are all untested. See README, Blocker 3.
* No new runtime dependency: `node:fs`, `node:crypto`, `node:path`, zod.
