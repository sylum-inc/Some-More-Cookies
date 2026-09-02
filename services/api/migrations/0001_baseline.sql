-- 0001_baseline: the durable shape of every repository interface.
--
-- Derived from `services/api/sql/schema.sql`, which stays the normalised
-- reference model and the documentation of which table backs which interface.
-- What lives here is the *aggregate* form of that model: one table per
-- repository aggregate root, with
--
--   * real, typed, indexed columns for every field a repository interface
--     actually queries, filters, sorts or aggregates on, and
--   * a `doc jsonb` column holding the canonical protocol object.
--
-- Why: the repository contract is `create(entity)` / `get(id)` /
-- `update(id, mutate)` over Zod-validated protocol aggregates, and the
-- in-memory implementation is the reference semantics. Shredding those
-- aggregates across sixty tables and reassembling them would put a lossy
-- mapping layer between the wire contract and storage, for no query we make.
-- Every invariant `schema.sql` declares with a UNIQUE or partial index is
-- declared here too (see 0003_invariants.sql) — the database, not hope, still
-- enforces claim-once, one open cart, one live session and friends.
--
-- Deliberately NOT carried over: cross-aggregate foreign keys. Repository
-- interfaces are per-aggregate and promise no write ordering between them
-- (an analytics event may name an account that never existed), so an FK there
-- would be an invariant the domain does not actually hold.
--
-- Never in this file, exactly as in schema.sql: card numbers, CVCs, raw client
-- IPs, image bytes.
--
-- Every table carries `seq bigserial`: the insertion order the in-memory
-- repositories get for free from a `Map`, and which several interfaces expose
-- (list-by-account is "newest first, then the order they arrived"). Without it,
-- rows minted in the same millisecond with random UUIDs come back shuffled.

CREATE SCHEMA IF NOT EXISTS somemore;
SET LOCAL search_path = somemore, public;

-- ---------------------------------------------------------------------------
-- identity
-- ---------------------------------------------------------------------------

CREATE TABLE accounts (
  seq        bigserial   NOT NULL,
  id                     text        PRIMARY KEY,
  status                 text        NOT NULL,
  anonymous              boolean     NOT NULL,
  merged_into_account_id text,
  created_at             timestamptz NOT NULL,
  updated_at             timestamptz NOT NULL,
  doc                    jsonb       NOT NULL
);

CREATE TABLE identities (
  seq        bigserial   NOT NULL,
  id             text        PRIMARY KEY,
  account_id     text        NOT NULL,
  provider       text        NOT NULL,
  subject        text        NOT NULL,
  email          text,
  email_verified boolean     NOT NULL DEFAULT false,
  created_at     timestamptz NOT NULL,
  doc            jsonb       NOT NULL
);

CREATE TABLE magic_links (
  seq        bigserial   NOT NULL,
  token                   text        PRIMARY KEY,
  email                   text        NOT NULL,
  requested_by_account_id text,
  created_at              timestamptz NOT NULL,
  expires_at              timestamptz NOT NULL,
  consumed_at             timestamptz,
  doc                     jsonb       NOT NULL
);

-- ---------------------------------------------------------------------------
-- passport
-- ---------------------------------------------------------------------------

CREATE TABLE passports (
  seq        bigserial   NOT NULL,
  account_id text        PRIMARY KEY,
  handle     text,
  updated_at timestamptz NOT NULL,
  doc        jsonb       NOT NULL
);

CREATE TABLE photos (
  seq        bigserial   NOT NULL,
  id               text        PRIMARY KEY,
  owner_account_id text        NOT NULL,
  campsite_id      text,
  sandwich_id      text,
  created_at       timestamptz NOT NULL,
  doc              jsonb       NOT NULL
);

-- ---------------------------------------------------------------------------
-- campsites
-- ---------------------------------------------------------------------------

CREATE TABLE campsites (
  seq        bigserial   NOT NULL,
  id               text        PRIMARY KEY,
  owner_account_id text        NOT NULL,
  camp_code        text        NOT NULL,
  privacy          text        NOT NULL,
  created_at       timestamptz NOT NULL,
  last_active_at   timestamptz NOT NULL,
  doc              jsonb       NOT NULL
);

CREATE TABLE campsite_invites (
  seq        bigserial   NOT NULL,
  id          text        PRIMARY KEY,
  campsite_id text        NOT NULL,
  token       text        NOT NULL,
  camp_code   text        NOT NULL,
  created_at  timestamptz NOT NULL,
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  doc         jsonb       NOT NULL
);

-- ---------------------------------------------------------------------------
-- worldState
-- ---------------------------------------------------------------------------

CREATE TABLE world_traces (
  seq        bigserial   NOT NULL,
  id                  text        PRIMARY KEY,
  campsite_id         text        NOT NULL,
  created_at          timestamptz NOT NULL,
  last_decayed_at     timestamptz NOT NULL,
  promoted_landmark_id text,
  doc                 jsonb       NOT NULL
);

CREATE TABLE landmarks (
  seq        bigserial   NOT NULL,
  id             text        PRIMARY KEY,
  campsite_id    text        NOT NULL,
  origin_trace_id text       NOT NULL,
  promoted_at    timestamptz NOT NULL,
  doc            jsonb       NOT NULL
);

-- ---------------------------------------------------------------------------
-- sessions
-- ---------------------------------------------------------------------------

CREATE TABLE sessions (
  seq        bigserial   NOT NULL,
  id          text        PRIMARY KEY,
  campsite_id text        NOT NULL,
  host_account_id text    NOT NULL,
  state       text        NOT NULL,
  started_at  timestamptz NOT NULL,
  doc         jsonb       NOT NULL
);

-- The fencing sequence lives in `sequence`, not only in the document, so a
-- hand-off can be arbitrated with a single conditional UPDATE.
CREATE TABLE object_authority (
  seq        bigserial   NOT NULL,
  session_id        text        NOT NULL,
  object_id         text        NOT NULL,
  holder_account_id text,
  sequence          integer     NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  granted_at        timestamptz NOT NULL,
  expires_at        timestamptz,
  doc               jsonb       NOT NULL,
  PRIMARY KEY (session_id, object_id)
);

-- ---------------------------------------------------------------------------
-- sandwiches
-- ---------------------------------------------------------------------------

CREATE TABLE sandwich_records (
  seq        bigserial   NOT NULL,
  id            text             PRIMARY KEY,
  account_id    text             NOT NULL,
  campsite_id   text,
  overall_score double precision NOT NULL DEFAULT 0,
  created_at    timestamptz      NOT NULL,
  doc           jsonb            NOT NULL
);

-- ---------------------------------------------------------------------------
-- rewards
-- ---------------------------------------------------------------------------

CREATE TABLE reward_definitions (
  seq        bigserial   NOT NULL,
  id   text  PRIMARY KEY,
  code text  NOT NULL,
  doc  jsonb NOT NULL
);

-- `merged_in` marks a grant that arrived on this account because another
-- account was absorbed into it, rather than because this player claimed it.
-- Claim-once (0003) applies to claims; a merge is not a claim, and a player who
-- earned the same stamp on two devices must not lose one by signing in.
CREATE TABLE reward_grants (
  seq        bigserial   NOT NULL,
  id         text        PRIMARY KEY,
  account_id text        NOT NULL,
  reward_id  text        NOT NULL,
  status     text        NOT NULL,
  merged_in  boolean     NOT NULL DEFAULT false,
  granted_at timestamptz NOT NULL,
  doc        jsonb       NOT NULL
);

CREATE TABLE reward_claims (
  seq        bigserial   NOT NULL,
  id           text        PRIMARY KEY,
  account_id   text        NOT NULL,
  reward_id    text        NOT NULL,
  state        text        NOT NULL,
  client_nonce text        NOT NULL,
  requested_at timestamptz NOT NULL,
  doc          jsonb       NOT NULL
);

-- ---------------------------------------------------------------------------
-- commerce
-- ---------------------------------------------------------------------------

CREATE TABLE products (
  seq        bigserial   NOT NULL,
  id  text  PRIMARY KEY,
  doc jsonb NOT NULL
);

CREATE TABLE carts (
  seq        bigserial   NOT NULL,
  id                 text        PRIMARY KEY,
  account_id         text        NOT NULL,
  converted_order_id text,
  created_at         timestamptz NOT NULL,
  doc                jsonb       NOT NULL
);

CREATE TABLE orders (
  seq        bigserial   NOT NULL,
  id                text        PRIMARY KEY,
  account_id        text        NOT NULL,
  payment_intent_id text,
  status            text        NOT NULL,
  created_at        timestamptz NOT NULL,
  doc               jsonb       NOT NULL
);

CREATE TABLE promotions (
  seq        bigserial   NOT NULL,
  id   text  PRIMARY KEY,
  code text  NOT NULL,
  doc  jsonb NOT NULL
);

CREATE TABLE promotion_redemptions (
  seq          bigserial   PRIMARY KEY,
  promotion_id text        NOT NULL,
  account_id   text        NOT NULL,
  order_id     text        NOT NULL,
  redeemed_at  timestamptz NOT NULL DEFAULT now()
);

-- Replay safety for every mutating endpoint. The primary key is the
-- (account scope, endpoint, key) tuple, so `begin` is an INSERT ... ON CONFLICT
-- DO NOTHING and two racing replays cannot both win.
CREATE TABLE idempotency_records (
  seq        bigserial   NOT NULL,
  account_scope text        NOT NULL,
  endpoint      text        NOT NULL,
  key           text        NOT NULL,
  request_hash  text        NOT NULL,
  state         text        NOT NULL CHECK (state IN ('in_progress', 'completed')),
  status_code   integer,
  response_body text,
  created_at    timestamptz NOT NULL,
  completed_at  timestamptz,
  expires_at    timestamptz NOT NULL,
  PRIMARY KEY (account_scope, endpoint, key)
);

-- ---------------------------------------------------------------------------
-- moderation
-- ---------------------------------------------------------------------------

CREATE TABLE moderation_reports (
  seq        bigserial   NOT NULL,
  id                  text        PRIMARY KEY,
  reporter_account_id text        NOT NULL,
  target_kind         text        NOT NULL,
  state               text        NOT NULL,
  priority            text        NOT NULL,
  created_at          timestamptz NOT NULL,
  doc                 jsonb       NOT NULL
);

CREATE TABLE account_blocks (
  seq        bigserial   NOT NULL,
  blocker_account_id text        NOT NULL,
  blocked_account_id text        NOT NULL,
  created_at         timestamptz NOT NULL,
  doc                jsonb       NOT NULL,
  PRIMARY KEY (blocker_account_id, blocked_account_id),
  CONSTRAINT account_blocks_not_self CHECK (blocker_account_id <> blocked_account_id)
);

-- ---------------------------------------------------------------------------
-- analytics
-- ---------------------------------------------------------------------------

-- `seq` is the ingest order the in-memory reference implementation preserves;
-- `list(limit)` is the last `limit` rows by `seq`, oldest first.
CREATE TABLE analytics_events (
  seq         bigserial   PRIMARY KEY,
  id          text        NOT NULL,
  name        text        NOT NULL,
  account_id  text,
  occurred_at timestamptz NOT NULL,
  doc         jsonb       NOT NULL
);
