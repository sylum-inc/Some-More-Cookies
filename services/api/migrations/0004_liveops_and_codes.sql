-- 0004_liveops_and_codes: content that changes after ship, and the physical
-- codes that connect a printed wrapper to an account.
--
-- Same shape as 0001: typed, indexed columns for whatever a repository
-- interface queries, plus a `doc jsonb` holding the canonical protocol object.
-- Same rule too: every invariant the in-memory repositories enforce by hand is
-- declared here as an index, because "check, then write" is only a rule while
-- nothing interleaves.
--
-- Never in this file: a minted code. The service does not store the codes it
-- prints — the mint response is the only copy, and it goes to the print vendor.
-- A redemption row records `(batch_id, code_ref)`, which is enough to enforce
-- claim-once and to answer "which run did this come from", and not enough to
-- reconstruct a code, because the signature is not here.
--
-- Never in this file, exactly as in 0001: card numbers, CVCs, raw client IPs
-- (redemptions carry a salted hash), image bytes.

SET LOCAL search_path = somemore, public;

-- ---------------------------------------------------------------------------
-- live ops: content documents and releases
-- ---------------------------------------------------------------------------

CREATE TABLE content_documents (
  seq                  bigserial   NOT NULL,
  id                   text        PRIMARY KEY,
  kind                 text        NOT NULL,
  slug                 text        NOT NULL,
  version              integer     NOT NULL,
  status               text        NOT NULL,
  checksum             text        NOT NULL,
  activation_starts_at timestamptz,
  activation_ends_at   timestamptz,
  created_at           timestamptz NOT NULL,
  updated_at           timestamptz NOT NULL,
  published_at         timestamptz,
  doc                  jsonb       NOT NULL
);

-- `(kind, slug)` is the thing being versioned; a version number is claimed once.
CREATE UNIQUE INDEX content_documents_kind_slug_version
  ON content_documents (kind, slug, version);

-- At most one live version of a document, ever. Two operators publishing v4 and
-- v5 of the same environment in the same second would otherwise both succeed
-- and the manifest would contain whichever the read happened to see.
CREATE UNIQUE INDEX content_documents_one_published
  ON content_documents (kind, slug)
  WHERE status = 'published';

-- Manifest assembly reads every published document in one go.
CREATE INDEX content_documents_published_idx
  ON content_documents (kind, slug)
  WHERE status = 'published';

-- Live-ops listings filter by status, then by what changed most recently.
CREATE INDEX content_documents_status_idx ON content_documents (status, updated_at DESC);

-- Releases are append-only: a numbered, immutable snapshot of what was live.
-- There is no UPDATE path in the repository interface, and no `down` here, for
-- the same reason the migration runner is forward-only — a rollback is a new
-- release, so the state that ships is a state that was recorded.
CREATE TABLE content_releases (
  seq        bigserial   NOT NULL,
  id         text        PRIMARY KEY,
  version    integer     NOT NULL,
  reason     text        NOT NULL,
  created_at timestamptz NOT NULL,
  doc        jsonb       NOT NULL
);

CREATE UNIQUE INDEX content_releases_version_unique ON content_releases (version);
CREATE INDEX content_releases_recent_idx ON content_releases (version DESC);

-- ---------------------------------------------------------------------------
-- codes: print runs and their redemptions
-- ---------------------------------------------------------------------------

CREATE TABLE code_batches (
  seq            bigserial   NOT NULL,
  id             text        PRIMARY KEY,
  label          text        NOT NULL,
  kind           text        NOT NULL,
  key_id         text        NOT NULL,
  status         text        NOT NULL,
  minted_count   integer     NOT NULL DEFAULT 0,
  redeemed_count integer     NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL,
  doc            jsonb       NOT NULL
);

CREATE INDEX code_batches_status_idx ON code_batches (status, created_at DESC);

CREATE TABLE code_redemptions (
  seq         bigserial   NOT NULL,
  id          text        PRIMARY KEY,
  batch_id    text        NOT NULL,
  code_ref    text        NOT NULL,
  account_id  text        NOT NULL,
  redeemed_at timestamptz NOT NULL,
  -- `account_id` when the batch is one-per-account, NULL otherwise. A partial
  -- unique index cannot consult another table, so the rule the batch declares
  -- is projected onto the row that has to obey it.
  per_account_key text,
  doc         jsonb       NOT NULL
);

-- Claim-once, enforced by the database rather than by application logic. Two
-- phones scanning the same wrapper at the same instant both read "not redeemed"
-- and both try to insert; exactly one wins and the other is told the code has
-- been used. This is the same shape as
-- `reward_grants_one_live_per_account_reward`, for the same reason.
CREATE UNIQUE INDEX code_redemptions_one_per_code
  ON code_redemptions (batch_id, code_ref);

-- One redemption per account per run, where the run says so. This is what stops
-- somebody buying one box and redeeming a scraped photo of somebody else's.
CREATE UNIQUE INDEX code_redemptions_one_per_account
  ON code_redemptions (batch_id, per_account_key)
  WHERE per_account_key IS NOT NULL;

CREATE INDEX code_redemptions_account_idx ON code_redemptions (account_id, redeemed_at DESC);
-- Velocity: "how much of this run was redeemed in the last hour" is the signal
-- that a print run has been posted to the internet.
CREATE INDEX code_redemptions_batch_idx ON code_redemptions (batch_id, redeemed_at DESC);
