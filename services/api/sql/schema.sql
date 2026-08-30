-- =============================================================================
-- Some More - PostgreSQL schema (v1, matches @somemore/protocol SCHEMA_VERSION 1.0.0)
-- =============================================================================
--
-- This schema is the drop-in target for the Postgres repository adapter. Every
-- table below is annotated with the repository interface it backs, defined in
-- `services/api/src/repos/interfaces.ts`. The in-memory implementations in
-- `services/api/src/repos/memory/` are the reference behaviour: where this file
-- declares a UNIQUE constraint, the memory implementation enforces the same
-- invariant by hand.
--
-- Conventions
--   * ids are text, prefixed and server-minted (`acct_...`, `cmp_...`).
--   * money is (currency char(3), amount_minor bigint) - never floats.
--   * timestamps are timestamptz, always UTC.
--   * enums are real Postgres enum types so a typo cannot reach the table.
--   * child collections are real tables, not JSONB, wherever they are queried;
--     JSONB is used only for opaque blobs the service never filters on.
--
-- NOT IN THIS FILE (deliberately)
--   * card numbers, CVCs, expiry dates. We store provider intent ids only.
--   * raw client IPs. Anti-abuse stores a salted sha-256 hash.
--   * image bytes. Photos are object-storage keys plus metadata.
--
-- Requires: PostgreSQL 15+.

BEGIN;

-- Case-insensitive text for emails and handles.
CREATE EXTENSION IF NOT EXISTS citext;

CREATE SCHEMA IF NOT EXISTS somemore;
SET search_path = somemore, public;

-- ---------------------------------------------------------------------------
-- Enum types
-- ---------------------------------------------------------------------------

CREATE TYPE account_status      AS ENUM ('active', 'suspended', 'merged', 'deleted');
CREATE TYPE auth_provider       AS ENUM ('anonymous', 'apple', 'google', 'email');
CREATE TYPE platform            AS ENUM ('ios', 'android', 'web', 'macos', 'windows', 'visionos');

CREATE TYPE photo_visibility    AS ENUM ('private', 'campsite', 'link', 'public');
CREATE TYPE image_content_type  AS ENUM ('image/jpeg', 'image/png', 'image/webp', 'image/avif');
CREATE TYPE rarity              AS ENUM ('common', 'uncommon', 'rare', 'legendary');
CREATE TYPE patch_slot          AS ENUM ('cover', 'spine', 'inside_front', 'inside_back');
CREATE TYPE discovery_kind      AS ENUM ('landmark', 'recipe', 'critter', 'lore', 'quirk', 'constellation');

CREATE TYPE campsite_privacy    AS ENUM ('private', 'invite_only', 'friends', 'public');
CREATE TYPE member_role         AS ENUM ('owner', 'cohost', 'guest', 'viewer');
CREATE TYPE joined_via          AS ENUM ('owner', 'invite_link', 'camp_code', 'qr', 'friend', 'restore');
CREATE TYPE invite_role         AS ENUM ('cohost', 'guest', 'viewer');

CREATE TYPE machine_component   AS ENUM ('drum', 'press', 'chiller', 'dispenser', 'hopper', 'belt');
CREATE TYPE maintenance_kind    AS ENUM ('clean', 'lubricate', 'replace_part', 'descale',
                                         'firmware_update', 'recalibrate', 'factory_reset');
CREATE TYPE quirk_severity      AS ENUM ('charming', 'minor', 'major');

CREATE TYPE trace_kind          AS ENUM ('ash', 'footprint', 'carving', 'spill', 'scorch', 'wrapper',
                                         'log_stack', 'stone_ring', 'chalk', 'melt_puddle');
CREATE TYPE landmark_permanence AS ENUM ('session', 'persistent', 'canonical');

CREATE TYPE session_state       AS ENUM ('lobby', 'active', 'ending', 'ended');
CREATE TYPE connection_state    AS ENUM ('connecting', 'connected', 'idle', 'disconnected');
CREATE TYPE presence_activity   AS ENUM ('idle', 'roasting', 'assembling', 'machine',
                                         'photographing', 'eating', 'browsing_shop');
CREATE TYPE authority_object_kind AS ENUM ('marshmallow', 'skewer', 'sm01', 'sandwich',
                                           'camera', 'firewood', 'prop');

CREATE TYPE roast_grade         AS ENUM ('raw', 'pale', 'golden', 'toasted', 'charred', 'cremated');
CREATE TYPE machine_program     AS ENUM ('classic', 'double_churn', 'quick_freeze', 'slow_set', 'experimental');
CREATE TYPE machine_run_outcome AS ENUM ('success', 'partial', 'jam', 'aborted');
CREATE TYPE sandwich_share_state AS ENUM ('private', 'link', 'campsite', 'public');

CREATE TYPE reward_kind         AS ENUM ('stamp', 'points', 'cosmetic', 'unlock', 'patch', 'perk');
CREATE TYPE reward_value_tier   AS ENUM ('standard', 'high');
CREATE TYPE reward_grant_status AS ENUM ('granted', 'revoked', 'consumed');
CREATE TYPE claim_state         AS ENUM ('pending', 'validating', 'approved', 'rejected', 'fulfilled', 'expired');

CREATE TYPE product_kind        AS ENUM ('physical', 'digital', 'experience');
CREATE TYPE product_status      AS ENUM ('draft', 'active', 'sold_out', 'retired');
CREATE TYPE inventory_policy    AS ENUM ('track', 'infinite');
CREATE TYPE order_status        AS ENUM ('created', 'awaiting_payment', 'payment_failed', 'paid',
                                         'in_production', 'packed', 'shipped', 'delivered',
                                         'cancelled', 'refunded', 'partially_refunded');
CREATE TYPE order_actor         AS ENUM ('customer', 'system', 'operator', 'payment_webhook');
CREATE TYPE payment_provider    AS ENUM ('stripe', 'fake');
CREATE TYPE payment_method_type AS ENUM ('apple_pay', 'google_pay', 'card', 'test');
CREATE TYPE payment_intent_status AS ENUM ('requires_payment_method', 'requires_confirmation', 'processing',
                                           'succeeded', 'canceled', 'failed');
CREATE TYPE refund_state        AS ENUM ('requested', 'pending', 'succeeded', 'failed');
CREATE TYPE refund_reason       AS ENUM ('requested_by_customer', 'damaged_in_transit', 'melted',
                                         'never_arrived', 'duplicate', 'fraudulent', 'goodwill');
CREATE TYPE promotion_kind      AS ENUM ('percent_off', 'amount_off', 'free_shipping');
CREATE TYPE quote_provider      AS ENUM ('internal_flat', 'external');
CREATE TYPE idempotency_state   AS ENUM ('in_progress', 'completed');

CREATE TYPE report_target_kind  AS ENUM ('account', 'campsite', 'photo', 'sandwich', 'note', 'landmark');
CREATE TYPE report_reason       AS ENUM ('harassment', 'hate_speech', 'sexual_content', 'violence',
                                         'self_harm', 'spam', 'impersonation', 'child_safety', 'other');
CREATE TYPE report_state        AS ENUM ('open', 'reviewing', 'actioned', 'dismissed');
CREATE TYPE report_priority     AS ENUM ('standard', 'urgent');

-- ---------------------------------------------------------------------------
-- identity domain
-- ---------------------------------------------------------------------------

-- Backs AccountRepository.
CREATE TABLE accounts (
  id                      text PRIMARY KEY,
  status                  account_status NOT NULL DEFAULT 'active',
  anonymous               boolean        NOT NULL DEFAULT true,
  merged_into_account_id  text           REFERENCES accounts (id) ON DELETE SET NULL,
  schema_version          text           NOT NULL,
  created_at              timestamptz    NOT NULL DEFAULT now(),
  updated_at              timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT accounts_merge_pointer_requires_merged_status
    CHECK ((merged_into_account_id IS NULL) OR (status = 'merged')),
  CONSTRAINT accounts_no_self_merge CHECK (merged_into_account_id IS DISTINCT FROM id)
);
CREATE INDEX accounts_merged_into_idx ON accounts (merged_into_account_id)
  WHERE merged_into_account_id IS NOT NULL;

-- Backs IdentityRepository. UNIQUE (provider, subject) is the invariant that
-- makes account linking and merge-conflict detection possible.
CREATE TABLE identities (
  id                    text          PRIMARY KEY,
  account_id            text          NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  provider              auth_provider NOT NULL,
  subject               text          NOT NULL,
  email                 citext,
  email_verified        boolean       NOT NULL DEFAULT false,
  display_name_hint     text,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  last_authenticated_at timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT identities_provider_subject_unique UNIQUE (provider, subject),
  CONSTRAINT identities_email_required_for_email_provider
    CHECK (provider <> 'email' OR email IS NOT NULL)
);
CREATE INDEX identities_account_idx ON identities (account_id);
-- At most one *verified* identity per email address across the service.
CREATE UNIQUE INDEX identities_verified_email_unique ON identities (email)
  WHERE email_verified AND email IS NOT NULL;
-- Anti-abuse: how many accounts have bootstrapped on one device.
CREATE INDEX identities_anonymous_subject_idx ON identities (subject)
  WHERE provider = 'anonymous';
-- One identity per provider per account (the `provider_already_linked` conflict).
CREATE UNIQUE INDEX identities_one_per_provider_per_account ON identities (account_id, provider);

-- Backs MagicLinkRepository. Single-use, short-lived.
CREATE TABLE magic_links (
  token                    text        PRIMARY KEY,
  email                    citext      NOT NULL,
  requested_by_account_id  text        REFERENCES accounts (id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  expires_at               timestamptz NOT NULL,
  consumed_at              timestamptz,
  CONSTRAINT magic_links_expiry_after_creation CHECK (expires_at > created_at)
);
CREATE INDEX magic_links_email_idx ON magic_links (email, created_at DESC);
CREATE INDEX magic_links_expiry_idx ON magic_links (expires_at) WHERE consumed_at IS NULL;

-- ---------------------------------------------------------------------------
-- passport domain
-- ---------------------------------------------------------------------------

-- Backs PassportRepository (root row). Child collections are the tables below.
CREATE TABLE passports (
  account_id      text        PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  display_name    text        NOT NULL CHECK (char_length(display_name) BETWEEN 1 AND 40),
  handle          citext      UNIQUE CHECK (handle IS NULL OR handle ~ '^[a-z0-9][a-z0-9_]{1,22}[a-z0-9]$'),
  bio             text        NOT NULL DEFAULT '' CHECK (char_length(bio) <= 280),
  avatar_photo_id text,
  revision        integer     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  schema_version  text        NOT NULL,
  -- Settings are read and written whole, never filtered on: JSONB is right here.
  settings        jsonb       NOT NULL,
  stats           jsonb       NOT NULL,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- Backs PhotoRepository. Object-storage keys and metadata only - never bytes.
CREATE TABLE photos (
  id               text               PRIMARY KEY,
  owner_account_id text               NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  storage_key      text               NOT NULL UNIQUE CHECK (storage_key !~ '\.\.'),
  thumbnail_key    text,
  content_type     image_content_type NOT NULL,
  width            integer            NOT NULL CHECK (width > 0),
  height           integer            NOT NULL CHECK (height > 0),
  byte_size        bigint             NOT NULL CHECK (byte_size >= 0),
  campsite_id      text,
  sandwich_id      text,
  caption          text               CHECK (caption IS NULL OR char_length(caption) <= 280),
  visibility       photo_visibility   NOT NULL DEFAULT 'private',
  camera_preset    text,
  captured_at      timestamptz        NOT NULL,
  created_at       timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX photos_owner_idx ON photos (owner_account_id, created_at DESC);
CREATE INDEX photos_campsite_idx ON photos (campsite_id) WHERE campsite_id IS NOT NULL;
CREATE INDEX photos_sandwich_idx ON photos (sandwich_id) WHERE sandwich_id IS NOT NULL;

-- Backs PassportRepository (stamps collection).
CREATE TABLE passport_stamps (
  id          text        PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  code        text        NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  name        text        NOT NULL,
  description text        NOT NULL DEFAULT '',
  rarity      rarity      NOT NULL DEFAULT 'common',
  campsite_id text,
  count       integer     NOT NULL DEFAULT 1 CHECK (count >= 1),
  earned_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passport_stamps_one_row_per_code UNIQUE (account_id, code)
);

-- Backs PassportRepository (notes collection). Player-authored UGC.
CREATE TABLE passport_notes (
  id          text        PRIMARY KEY,
  account_id  text        NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  body        text        NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  pinned      boolean     NOT NULL DEFAULT false,
  campsite_id text,
  sandwich_id text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX passport_notes_account_idx ON passport_notes (account_id, created_at DESC);

-- Backs PassportRepository (patches collection).
CREATE TABLE passport_patches (
  id         text        PRIMARY KEY,
  account_id text        NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  code       text        NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  name       text        NOT NULL,
  rarity     rarity      NOT NULL DEFAULT 'common',
  slot       patch_slot  NOT NULL DEFAULT 'cover',
  equipped   boolean     NOT NULL DEFAULT false,
  earned_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT passport_patches_one_row_per_code UNIQUE (account_id, code)
);

-- Backs PassportRepository (ticket stubs collection).
CREATE TABLE passport_ticket_stubs (
  id              text        PRIMARY KEY,
  account_id      text        NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  code            text        NOT NULL,
  event_name      text        NOT NULL,
  venue           text,
  order_id        text,
  reward_grant_id text,
  issued_at       timestamptz NOT NULL DEFAULT now(),
  admitted_at     timestamptz
);

-- Backs PassportRepository (discoveries collection).
CREATE TABLE passport_discoveries (
  id            text           PRIMARY KEY,
  account_id    text           NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  code          text           NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  kind          discovery_kind NOT NULL,
  name          text           NOT NULL,
  campsite_id   text,
  first_finder  boolean        NOT NULL DEFAULT false,
  discovered_at timestamptz    NOT NULL DEFAULT now(),
  CONSTRAINT passport_discoveries_one_row_per_code UNIQUE (account_id, code)
);

-- Backs PassportRepository (visited campsites collection).
CREATE TABLE passport_visited_campsites (
  account_id       text        NOT NULL REFERENCES passports (account_id) ON DELETE CASCADE,
  campsite_id      text        NOT NULL,
  environment_id   text        NOT NULL,
  nickname         text,
  visit_count      integer     NOT NULL DEFAULT 1 CHECK (visit_count >= 1),
  first_visited_at timestamptz NOT NULL DEFAULT now(),
  last_visited_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (account_id, campsite_id)
);

-- ---------------------------------------------------------------------------
-- campsites domain
-- ---------------------------------------------------------------------------

-- Backs CampsiteRepository (root row).
CREATE TABLE campsites (
  id               text             PRIMARY KEY,
  environment_id   text             NOT NULL CHECK (environment_id ~ '^[a-z0-9_]+$'),
  seed             bigint           NOT NULL CHECK (seed BETWEEN 0 AND 4294967295),
  owner_account_id text             NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  name             text             NOT NULL CHECK (char_length(name) BETWEEN 1 AND 60),
  -- Private by default, at the storage layer too.
  privacy          campsite_privacy NOT NULL DEFAULT 'private',
  camp_code        text             NOT NULL UNIQUE
                     CHECK (camp_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  promotion_rule   jsonb            NOT NULL,
  revision         integer          NOT NULL DEFAULT 0 CHECK (revision >= 0),
  schema_version   text             NOT NULL,
  created_at       timestamptz      NOT NULL DEFAULT now(),
  updated_at       timestamptz      NOT NULL DEFAULT now(),
  last_active_at   timestamptz      NOT NULL DEFAULT now(),
  archived_at      timestamptz
);
CREATE INDEX campsites_owner_idx ON campsites (owner_account_id);
CREATE INDEX campsites_public_idx ON campsites (last_active_at DESC) WHERE privacy = 'public';

-- Backs CampsiteRepository (members collection).
CREATE TABLE campsite_members (
  campsite_id  text        NOT NULL REFERENCES campsites (id) ON DELETE CASCADE,
  account_id   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  role         member_role NOT NULL DEFAULT 'guest',
  joined_via   joined_via  NOT NULL DEFAULT 'owner',
  banned       boolean     NOT NULL DEFAULT false,
  joined_at    timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz,
  PRIMARY KEY (campsite_id, account_id)
);
CREATE INDEX campsite_members_account_idx ON campsite_members (account_id);
-- Exactly one owner per campsite.
CREATE UNIQUE INDEX campsite_members_single_owner ON campsite_members (campsite_id)
  WHERE role = 'owner';

-- Backs CampsiteRepository (the serialized SM-01). One machine per campsite.
CREATE TABLE sm01_machines (
  campsite_id       text        PRIMARY KEY REFERENCES campsites (id) ON DELETE CASCADE,
  serial_number     text        NOT NULL UNIQUE CHECK (serial_number ~ '^SM01-[A-Z0-9]{4}-[A-Z0-9]{4}$'),
  firmware_version  text        NOT NULL,
  finish_code       text        NOT NULL DEFAULT 'factory_enamel',
  operational       boolean     NOT NULL DEFAULT true,
  cycles_run        integer     NOT NULL DEFAULT 0 CHECK (cycles_run >= 0),
  jams_cleared      integer     NOT NULL DEFAULT 0 CHECK (jams_cleared >= 0),
  wear_drum         real        NOT NULL DEFAULT 0 CHECK (wear_drum      BETWEEN 0 AND 1),
  wear_press        real        NOT NULL DEFAULT 0 CHECK (wear_press     BETWEEN 0 AND 1),
  wear_chiller      real        NOT NULL DEFAULT 0 CHECK (wear_chiller   BETWEEN 0 AND 1),
  wear_dispenser    real        NOT NULL DEFAULT 0 CHECK (wear_dispenser BETWEEN 0 AND 1),
  wear_hopper       real        NOT NULL DEFAULT 0 CHECK (wear_hopper    BETWEEN 0 AND 1),
  wear_belt         real        NOT NULL DEFAULT 0 CHECK (wear_belt      BETWEEN 0 AND 1),
  installed_at      timestamptz NOT NULL DEFAULT now(),
  last_run_at       timestamptz,
  last_serviced_at  timestamptz
);

-- Backs CampsiteRepository (machine.maintenanceHistory).
CREATE TABLE sm01_maintenance_events (
  id           text              PRIMARY KEY,
  campsite_id  text              NOT NULL REFERENCES sm01_machines (campsite_id) ON DELETE CASCADE,
  kind         maintenance_kind  NOT NULL,
  component    machine_component,
  performed_by text              NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  wear_before  real              NOT NULL CHECK (wear_before BETWEEN 0 AND 1),
  wear_after   real              NOT NULL CHECK (wear_after  BETWEEN 0 AND 1),
  notes        text              NOT NULL DEFAULT '',
  at           timestamptz       NOT NULL DEFAULT now()
);
CREATE INDEX sm01_maintenance_campsite_idx ON sm01_maintenance_events (campsite_id, at DESC);

-- Backs CampsiteRepository (machine.quirks). A machine's earned personality.
CREATE TABLE sm01_quirks (
  campsite_id           text            NOT NULL REFERENCES sm01_machines (campsite_id) ON DELETE CASCADE,
  code                  text            NOT NULL CHECK (code ~ '^[a-z0-9_]+$'),
  name                  text            NOT NULL,
  description           text            NOT NULL DEFAULT '',
  severity              quirk_severity  NOT NULL,
  acquired_from_run_id  text,
  effects               jsonb           NOT NULL,
  acquired_at           timestamptz     NOT NULL DEFAULT now(),
  PRIMARY KEY (campsite_id, code)
);

-- Backs InviteRepository.
CREATE TABLE campsite_invites (
  id           text        PRIMARY KEY,
  campsite_id  text        NOT NULL REFERENCES campsites (id) ON DELETE CASCADE,
  token        text        NOT NULL UNIQUE,
  camp_code    text        NOT NULL UNIQUE
                 CHECK (camp_code ~ '^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$'),
  created_by   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  grants_role  invite_role NOT NULL DEFAULT 'guest',
  max_uses     integer     NOT NULL DEFAULT 10 CHECK (max_uses BETWEEN 1 AND 100),
  uses         integer     NOT NULL DEFAULT 0  CHECK (uses >= 0),
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  revoked_at   timestamptz,
  CONSTRAINT campsite_invites_uses_within_max CHECK (uses <= max_uses)
);
CREATE INDEX campsite_invites_campsite_idx ON campsite_invites (campsite_id);

-- ---------------------------------------------------------------------------
-- worldState domain
-- ---------------------------------------------------------------------------

-- Backs WorldTraceRepository. Traces decay; the read model applies
-- intensity * exp(-decay_rate_per_hour * hours) at query time.
CREATE TABLE world_traces (
  id                    text        PRIMARY KEY,
  campsite_id           text        NOT NULL REFERENCES campsites (id) ON DELETE CASCADE,
  kind                  trace_kind  NOT NULL,
  pos_x                 real        NOT NULL,
  pos_y                 real        NOT NULL,
  pos_z                 real        NOT NULL,
  rotation_y            real        NOT NULL DEFAULT 0,
  scale                 real        NOT NULL DEFAULT 1 CHECK (scale BETWEEN 0.05 AND 20),
  created_by            text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  intensity             real        NOT NULL CHECK (intensity BETWEEN 0 AND 1),
  decay_rate_per_hour   real        NOT NULL CHECK (decay_rate_per_hour BETWEEN 0 AND 10),
  text                  text        CHECK (text IS NULL OR char_length(text) <= 120),
  promoted_landmark_id  text,
  created_at            timestamptz NOT NULL DEFAULT now(),
  last_decayed_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX world_traces_campsite_idx ON world_traces (campsite_id);
-- Sweep job: unpromoted traces, oldest decay first.
CREATE INDEX world_traces_sweep_idx ON world_traces (last_decayed_at)
  WHERE promoted_landmark_id IS NULL;

-- Backs WorldTraceRepository (witness quorum for landmark promotion).
CREATE TABLE world_trace_witnesses (
  trace_id     text        NOT NULL REFERENCES world_traces (id) ON DELETE CASCADE,
  account_id   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  witnessed_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (trace_id, account_id)
);

-- Backs LandmarkRepository. A promoted trace stops decaying and gets a name.
CREATE TABLE landmarks (
  id               text                PRIMARY KEY,
  campsite_id      text                NOT NULL REFERENCES campsites (id) ON DELETE CASCADE,
  origin_trace_id  text                REFERENCES world_traces (id) ON DELETE SET NULL,
  name             text                NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  kind             trace_kind          NOT NULL,
  pos_x            real                NOT NULL,
  pos_y            real                NOT NULL,
  pos_z            real                NOT NULL,
  permanence       landmark_permanence NOT NULL DEFAULT 'persistent',
  citations        integer             NOT NULL DEFAULT 0 CHECK (citations >= 0),
  description      text                NOT NULL DEFAULT '',
  promoted_by      text                NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  promoted_at      timestamptz         NOT NULL DEFAULT now(),
  CONSTRAINT landmarks_one_per_trace UNIQUE (origin_trace_id)
);
CREATE INDEX landmarks_campsite_idx ON landmarks (campsite_id);

-- ---------------------------------------------------------------------------
-- sessions domain
-- ---------------------------------------------------------------------------

-- Backs SessionRepository.
CREATE TABLE sessions (
  id               text          PRIMARY KEY,
  campsite_id      text          NOT NULL REFERENCES campsites (id) ON DELETE CASCADE,
  host_account_id  text          NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  state            session_state NOT NULL DEFAULT 'lobby',
  max_members      integer       NOT NULL DEFAULT 8 CHECK (max_members BETWEEN 1 AND 16),
  authority_epoch  bigint        NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0),
  started_at       timestamptz   NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  CONSTRAINT sessions_ended_has_timestamp CHECK (state <> 'ended' OR ended_at IS NOT NULL)
);
-- At most one live session per campsite.
CREATE UNIQUE INDEX sessions_one_live_per_campsite ON sessions (campsite_id)
  WHERE state IN ('lobby', 'active');

-- Backs SessionRepository (presence collection).
CREATE TABLE session_presence (
  session_id        text              NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  account_id        text              NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  connection        connection_state  NOT NULL DEFAULT 'connecting',
  role              member_role       NOT NULL DEFAULT 'guest',
  activity          presence_activity NOT NULL DEFAULT 'idle',
  pos_x             real,
  pos_y             real,
  pos_z             real,
  facing_y          real              NOT NULL DEFAULT 0,
  mic_muted         boolean           NOT NULL DEFAULT true,
  joined_at         timestamptz       NOT NULL DEFAULT now(),
  last_heartbeat_at timestamptz       NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, account_id)
);
CREATE INDEX session_presence_stale_idx ON session_presence (last_heartbeat_at)
  WHERE connection <> 'disconnected';

-- Backs AuthorityRepository. `sequence` is the fencing token: a hand-off must
-- present the sequence it believes is current, and every grant increments it.
CREATE TABLE object_authority (
  session_id         text                  NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  object_id          text                  NOT NULL,
  object_kind        authority_object_kind NOT NULL,
  holder_account_id  text                  REFERENCES accounts (id) ON DELETE SET NULL,
  sequence           bigint                NOT NULL DEFAULT 0 CHECK (sequence >= 0),
  locked             boolean               NOT NULL DEFAULT false,
  granted_at         timestamptz           NOT NULL DEFAULT now(),
  expires_at         timestamptz,
  PRIMARY KEY (session_id, object_id)
);
CREATE INDEX object_authority_holder_idx ON object_authority (session_id, holder_account_id)
  WHERE holder_account_id IS NOT NULL;
CREATE INDEX object_authority_lease_idx ON object_authority (expires_at)
  WHERE expires_at IS NOT NULL;

-- ---------------------------------------------------------------------------
-- sandwiches domain
-- ---------------------------------------------------------------------------

-- Backs SandwichRepository. The canonical record of one produced sandwich.
-- Roast/assembly/run detail is stored as JSONB because it is written once and
-- read whole; the columns pulled out are the ones we actually query on.
CREATE TABLE sandwich_records (
  id                text                 PRIMARY KEY,
  account_id        text                 NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  campsite_id       text                 NOT NULL REFERENCES campsites (id) ON DELETE RESTRICT,
  session_id        text                 REFERENCES sessions (id) ON DELETE SET NULL,
  name              text                 CHECK (name IS NULL OR char_length(name) <= 60),
  roast_grade       roast_grade          NOT NULL,
  roast             jsonb                NOT NULL,
  assembly          jsonb                NOT NULL,
  machine_run_id    text                 NOT NULL UNIQUE,
  machine_serial    text                 NOT NULL,
  machine_program   machine_program      NOT NULL,
  machine_outcome   machine_run_outcome  NOT NULL,
  machine_run       jsonb                NOT NULL,
  overall_score     real                 NOT NULL CHECK (overall_score BETWEEN 0 AND 1),
  rarity            rarity               NOT NULL,
  flavor_tags       text[]               NOT NULL DEFAULT '{}',
  hero_photo_id     text                 REFERENCES photos (id) ON DELETE SET NULL,
  share_state       sandwich_share_state NOT NULL DEFAULT 'private',
  saved_to_passport boolean              NOT NULL DEFAULT true,
  order_id          text,
  schema_version    text                 NOT NULL,
  created_at        timestamptz          NOT NULL DEFAULT now(),
  updated_at        timestamptz          NOT NULL DEFAULT now(),
  consumed_at       timestamptz
);
CREATE INDEX sandwich_records_account_idx ON sandwich_records (account_id, created_at DESC);
CREATE INDEX sandwich_records_campsite_idx ON sandwich_records (campsite_id, created_at DESC);
CREATE INDEX sandwich_records_best_score_idx ON sandwich_records (account_id, overall_score DESC);
CREATE INDEX sandwich_records_public_idx ON sandwich_records (created_at DESC)
  WHERE share_state = 'public';

-- Backs SandwichRepository (photo refs).
CREATE TABLE sandwich_photos (
  sandwich_id text    NOT NULL REFERENCES sandwich_records (id) ON DELETE CASCADE,
  photo_id    text    NOT NULL REFERENCES photos (id) ON DELETE CASCADE,
  position    integer NOT NULL DEFAULT 0,
  PRIMARY KEY (sandwich_id, photo_id)
);

-- ---------------------------------------------------------------------------
-- rewards domain
-- ---------------------------------------------------------------------------

-- Backs RewardDefinitionRepository. Seeded from domain/seed.ts.
CREATE TABLE reward_definitions (
  id              text              PRIMARY KEY,
  code            text              NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  kind            reward_kind       NOT NULL,
  name            text              NOT NULL,
  description     text              NOT NULL DEFAULT '',
  rarity          rarity            NOT NULL DEFAULT 'common',
  value_tier      reward_value_tier NOT NULL DEFAULT 'standard',
  points          integer           NOT NULL DEFAULT 0 CHECK (points >= 0),
  payload_code    text,
  prerequisites   jsonb             NOT NULL DEFAULT '[]'::jsonb,
  per_account_limit integer         NOT NULL DEFAULT 1 CHECK (per_account_limit >= 1),
  global_limit    integer           CHECK (global_limit IS NULL OR global_limit >= 1),
  global_claimed  integer           NOT NULL DEFAULT 0 CHECK (global_claimed >= 0),
  active          boolean           NOT NULL DEFAULT true,
  available_from  timestamptz,
  available_until timestamptz,
  CONSTRAINT reward_definitions_window CHECK (
    available_from IS NULL OR available_until IS NULL OR available_until > available_from),
  CONSTRAINT reward_definitions_within_global_limit CHECK (
    global_limit IS NULL OR global_claimed <= global_limit)
);

-- Backs RewardGrantRepository.
CREATE TABLE reward_grants (
  id                   text                PRIMARY KEY,
  account_id           text                NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reward_id            text                NOT NULL REFERENCES reward_definitions (id) ON DELETE RESTRICT,
  reward_code          text                NOT NULL,
  kind                 reward_kind         NOT NULL,
  value_tier           reward_value_tier   NOT NULL,
  points               integer             NOT NULL DEFAULT 0 CHECK (points >= 0),
  status               reward_grant_status NOT NULL DEFAULT 'granted',
  source               jsonb               NOT NULL,
  redeemed_on_order_id text,
  granted_at           timestamptz         NOT NULL DEFAULT now(),
  revoked_at           timestamptz,
  consumed_at          timestamptz
);
CREATE INDEX reward_grants_account_idx ON reward_grants (account_id, granted_at DESC);
-- Claim-once for single-grant rewards, enforced by the database, not by hope.
CREATE UNIQUE INDEX reward_grants_one_live_per_account_reward
  ON reward_grants (account_id, reward_id)
  WHERE status <> 'revoked';

-- Backs RewardClaimRepository: the audited path for real-world perks.
CREATE TABLE reward_claims (
  id                text        PRIMARY KEY,
  account_id        text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  reward_id         text        NOT NULL REFERENCES reward_definitions (id) ON DELETE RESTRICT,
  reward_code       text        NOT NULL,
  state             claim_state NOT NULL DEFAULT 'pending',
  device_id         text        NOT NULL,
  -- Salted sha-256 of the client IP. The raw IP is never stored.
  ip_hash           char(64)    NOT NULL,
  client_nonce      text        NOT NULL,
  risk_score        real        NOT NULL DEFAULT 0 CHECK (risk_score BETWEEN 0 AND 1),
  signals           text[]      NOT NULL DEFAULT '{}',
  claims_in_window  integer     NOT NULL DEFAULT 0 CHECK (claims_in_window >= 0),
  accounts_on_device integer    NOT NULL DEFAULT 1 CHECK (accounts_on_device >= 1),
  duplicate_of_claim_id text    REFERENCES reward_claims (id) ON DELETE SET NULL,
  rejection_reason  text,
  grant_id          text        REFERENCES reward_grants (id) ON DELETE SET NULL,
  fulfillment_ref   text,
  idempotency_key   text        NOT NULL,
  requested_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  decided_at        timestamptz,
  expires_at        timestamptz NOT NULL,
  CONSTRAINT reward_claims_decided_states CHECK (
    state NOT IN ('approved', 'rejected', 'fulfilled') OR decided_at IS NOT NULL)
);
-- One open/succeeded claim per account per reward.
CREATE UNIQUE INDEX reward_claims_one_open_per_account_reward
  ON reward_claims (account_id, reward_id)
  WHERE state <> 'rejected' AND state <> 'expired';
CREATE UNIQUE INDEX reward_claims_nonce_unique ON reward_claims (client_nonce);
CREATE INDEX reward_claims_velocity_idx ON reward_claims (account_id, requested_at DESC);
CREATE INDEX reward_claims_device_idx ON reward_claims (device_id, requested_at DESC);
CREATE INDEX reward_claims_review_queue_idx ON reward_claims (requested_at)
  WHERE state IN ('pending', 'validating');

-- ---------------------------------------------------------------------------
-- commerce domain
-- ---------------------------------------------------------------------------

-- Backs ProductRepository. Launch catalog is exactly one flagship product.
CREATE TABLE products (
  id                 text           PRIMARY KEY,
  sku                text           NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9-]+$'),
  name               text           NOT NULL,
  subtitle           text           NOT NULL DEFAULT '',
  description        text           NOT NULL DEFAULT '',
  kind               product_kind   NOT NULL,
  status             product_status NOT NULL DEFAULT 'draft',
  base_currency      char(3)        NOT NULL,
  base_amount_minor  bigint         NOT NULL CHECK (base_amount_minor >= 0),
  requires_shipping  boolean        NOT NULL DEFAULT true,
  tax_code           text           NOT NULL DEFAULT 'food_frozen',
  max_per_order      integer        NOT NULL DEFAULT 4 CHECK (max_per_order BETWEEN 1 AND 20),
  ships_to_countries char(2)[]      NOT NULL DEFAULT '{US}',
  image_keys         text[]         NOT NULL DEFAULT '{}',
  created_at         timestamptz    NOT NULL DEFAULT now(),
  updated_at         timestamptz    NOT NULL DEFAULT now()
);

-- Backs ProductRepository (variants collection).
CREATE TABLE product_variants (
  id                 text             PRIMARY KEY,
  product_id         text             NOT NULL REFERENCES products (id) ON DELETE CASCADE,
  sku                text             NOT NULL UNIQUE CHECK (sku ~ '^[A-Z0-9-]+$'),
  name               text             NOT NULL,
  price_delta_minor  bigint           NOT NULL DEFAULT 0,
  inventory_policy   inventory_policy NOT NULL DEFAULT 'track',
  inventory_quantity integer          NOT NULL DEFAULT 0 CHECK (inventory_quantity >= 0),
  weight_grams       integer          NOT NULL DEFAULT 0 CHECK (weight_grams >= 0),
  attributes         jsonb            NOT NULL DEFAULT '{}'::jsonb,
  active             boolean          NOT NULL DEFAULT true
);
CREATE INDEX product_variants_product_idx ON product_variants (product_id);

-- Backs CartRepository.
CREATE TABLE carts (
  id                  text        PRIMARY KEY,
  account_id          text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  currency            char(3)     NOT NULL,
  subtotal_minor      bigint      NOT NULL DEFAULT 0 CHECK (subtotal_minor >= 0),
  promotion_codes     text[]      NOT NULL DEFAULT '{}',
  reward_grant_ids    text[]      NOT NULL DEFAULT '{}',
  converted_order_id  text,
  revision            integer     NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- One open cart per account.
CREATE UNIQUE INDEX carts_one_open_per_account ON carts (account_id)
  WHERE converted_order_id IS NULL;

-- Backs CartRepository (items collection).
CREATE TABLE cart_items (
  id                 text        PRIMARY KEY,
  cart_id            text        NOT NULL REFERENCES carts (id) ON DELETE CASCADE,
  product_id         text        NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  variant_id         text        NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  sku                text        NOT NULL,
  name               text        NOT NULL,
  quantity           integer     NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_minor   bigint      NOT NULL CHECK (unit_price_minor >= 0),
  line_subtotal_minor bigint     NOT NULL CHECK (line_subtotal_minor >= 0),
  sandwich_id        text        REFERENCES sandwich_records (id) ON DELETE SET NULL,
  added_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cart_items_one_line_per_variant UNIQUE (cart_id, variant_id)
);

-- Backs PromotionRepository.
CREATE TABLE promotions (
  id                 text           PRIMARY KEY,
  code               text           NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]+$'),
  name               text           NOT NULL,
  kind               promotion_kind NOT NULL,
  percent            real           CHECK (percent IS NULL OR percent BETWEEN 1 AND 100),
  amount_off_minor   bigint         CHECK (amount_off_minor IS NULL OR amount_off_minor >= 0),
  min_subtotal_minor bigint         CHECK (min_subtotal_minor IS NULL OR min_subtotal_minor >= 0),
  max_redemptions    integer        CHECK (max_redemptions IS NULL OR max_redemptions >= 1),
  redemptions_used   integer        NOT NULL DEFAULT 0 CHECK (redemptions_used >= 0),
  per_account_limit  integer        NOT NULL DEFAULT 1 CHECK (per_account_limit >= 1),
  stackable          boolean        NOT NULL DEFAULT false,
  active             boolean        NOT NULL DEFAULT true,
  starts_at          timestamptz    NOT NULL DEFAULT now(),
  ends_at            timestamptz,
  CONSTRAINT promotions_rule_shape CHECK (
    (kind = 'percent_off'   AND percent IS NOT NULL AND amount_off_minor IS NULL) OR
    (kind = 'amount_off'    AND amount_off_minor IS NOT NULL AND percent IS NULL) OR
    (kind = 'free_shipping' AND percent IS NULL AND amount_off_minor IS NULL)),
  CONSTRAINT promotions_window CHECK (ends_at IS NULL OR ends_at > starts_at)
);

-- Backs PromotionRepository (per-account redemption ledger).
CREATE TABLE promotion_redemptions (
  promotion_id text        NOT NULL REFERENCES promotions (id) ON DELETE CASCADE,
  account_id   text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  order_id     text        NOT NULL,
  redeemed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promotion_id, order_id)
);
CREATE INDEX promotion_redemptions_account_idx ON promotion_redemptions (promotion_id, account_id);

-- Backs OrderRepository.
--
-- Tax and shipping are captured as whole quote objects, verbatim, so a refund
-- or an audit can reproduce exactly what the customer was shown at checkout.
-- NOTE: no card data. `payment_intent_id` is a provider reference and nothing
-- more; the client secret is returned to the client and never persisted.
CREATE TABLE orders (
  id                    text                  PRIMARY KEY,
  reference             text                  NOT NULL UNIQUE CHECK (reference ~ '^SM-[A-Z0-9]{6}$'),
  account_id            text                  NOT NULL REFERENCES accounts (id) ON DELETE RESTRICT,
  cart_id               text                  NOT NULL REFERENCES carts (id) ON DELETE RESTRICT,
  currency              char(3)               NOT NULL,
  status                order_status          NOT NULL DEFAULT 'created',
  subtotal_minor        bigint                NOT NULL CHECK (subtotal_minor >= 0),
  discount_total_minor  bigint                NOT NULL DEFAULT 0 CHECK (discount_total_minor >= 0),
  tax_quote             jsonb                 NOT NULL,
  tax_provider          quote_provider        NOT NULL,
  tax_total_minor       bigint                NOT NULL CHECK (tax_total_minor >= 0),
  shipping_quote        jsonb                 NOT NULL,
  shipping_provider     quote_provider        NOT NULL,
  shipping_total_minor  bigint                NOT NULL CHECK (shipping_total_minor >= 0),
  total_minor           bigint                NOT NULL CHECK (total_minor >= 0),
  refunded_total_minor  bigint                NOT NULL DEFAULT 0 CHECK (refunded_total_minor >= 0),
  shipping_address      jsonb                 NOT NULL,
  email                 citext,
  payment_provider      payment_provider,
  payment_intent_id     text,
  payment_status        payment_intent_status,
  payment_method_type   payment_method_type,
  payment_display_label text,
  payment_failure_code  text,
  applied_promotion_codes text[]              NOT NULL DEFAULT '{}',
  redeemed_reward_grant_ids text[]            NOT NULL DEFAULT '{}',
  fulfillment           jsonb                 NOT NULL DEFAULT '{}'::jsonb,
  cancellation          jsonb,
  idempotency_key       text                  NOT NULL,
  schema_version        text                  NOT NULL,
  created_at            timestamptz           NOT NULL DEFAULT now(),
  updated_at            timestamptz           NOT NULL DEFAULT now(),
  CONSTRAINT orders_refund_within_total CHECK (refunded_total_minor <= total_minor),
  CONSTRAINT orders_payment_fields_together CHECK (
    (payment_intent_id IS NULL AND payment_provider IS NULL AND payment_status IS NULL) OR
    (payment_intent_id IS NOT NULL AND payment_provider IS NOT NULL AND payment_status IS NOT NULL))
);
CREATE INDEX orders_account_idx ON orders (account_id, created_at DESC);
CREATE UNIQUE INDEX orders_payment_intent_idx ON orders (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
CREATE INDEX orders_fulfillment_queue_idx ON orders (status, created_at)
  WHERE status IN ('paid', 'in_production', 'packed');

-- Backs OrderRepository (lines collection). Immutable once written.
CREATE TABLE order_lines (
  id                  text    PRIMARY KEY,
  order_id            text    NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  product_id          text    NOT NULL REFERENCES products (id) ON DELETE RESTRICT,
  variant_id          text    NOT NULL REFERENCES product_variants (id) ON DELETE RESTRICT,
  sku                 text    NOT NULL,
  name                text    NOT NULL,
  quantity            integer NOT NULL CHECK (quantity BETWEEN 1 AND 20),
  unit_price_minor    bigint  NOT NULL CHECK (unit_price_minor >= 0),
  line_subtotal_minor bigint  NOT NULL CHECK (line_subtotal_minor >= 0),
  sandwich_id         text    REFERENCES sandwich_records (id) ON DELETE SET NULL
);
CREATE INDEX order_lines_order_idx ON order_lines (order_id);

-- Backs OrderRepository (statusHistory). Append-only audit of the state machine.
CREATE TABLE order_status_events (
  id           bigserial    PRIMARY KEY,
  order_id     text         NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  from_status  order_status,
  to_status    order_status NOT NULL,
  actor        order_actor  NOT NULL,
  note         text         NOT NULL DEFAULT '',
  at           timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX order_status_events_order_idx ON order_status_events (order_id, at);

-- Backs OrderRepository (refunds collection).
CREATE TABLE refunds (
  id                 text          PRIMARY KEY,
  order_id           text          NOT NULL REFERENCES orders (id) ON DELETE CASCADE,
  amount_minor       bigint        NOT NULL CHECK (amount_minor > 0),
  reason             refund_reason NOT NULL,
  state              refund_state  NOT NULL DEFAULT 'requested',
  provider_refund_id text,
  requested_by       text          NOT NULL,
  failure_code       text,
  idempotency_key    text          NOT NULL,
  created_at         timestamptz   NOT NULL DEFAULT now(),
  updated_at         timestamptz   NOT NULL DEFAULT now(),
  CONSTRAINT refunds_idempotent_per_order UNIQUE (order_id, idempotency_key)
);
CREATE INDEX refunds_order_idx ON refunds (order_id, created_at);

-- Backs IdempotencyRepository. The (account_scope, endpoint, key) primary key
-- is what makes `INSERT ... ON CONFLICT DO NOTHING` a safe concurrency gate.
CREATE TABLE idempotency_records (
  account_scope text              NOT NULL,
  endpoint      text              NOT NULL,
  key           text              NOT NULL,
  request_hash  char(64)          NOT NULL,
  state         idempotency_state NOT NULL DEFAULT 'in_progress',
  status_code   integer           CHECK (status_code IS NULL OR status_code BETWEEN 100 AND 599),
  response_body jsonb,
  created_at    timestamptz       NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  expires_at    timestamptz       NOT NULL,
  PRIMARY KEY (account_scope, endpoint, key),
  CONSTRAINT idempotency_completed_has_response CHECK (
    state <> 'completed' OR (status_code IS NOT NULL AND completed_at IS NOT NULL))
);
CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

-- ---------------------------------------------------------------------------
-- moderation domain
-- ---------------------------------------------------------------------------

-- Backs ModerationRepository (reports).
CREATE TABLE moderation_reports (
  id                  text               PRIMARY KEY,
  reporter_account_id text               NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  target_kind         report_target_kind NOT NULL,
  target_id           text               NOT NULL,
  reason              report_reason      NOT NULL,
  details             text               NOT NULL DEFAULT '' CHECK (char_length(details) <= 1000),
  state               report_state       NOT NULL DEFAULT 'open',
  priority            report_priority    NOT NULL DEFAULT 'standard',
  created_at          timestamptz        NOT NULL DEFAULT now(),
  updated_at          timestamptz        NOT NULL DEFAULT now()
);
CREATE INDEX moderation_reports_reporter_idx ON moderation_reports (reporter_account_id, created_at DESC);
CREATE INDEX moderation_reports_target_idx ON moderation_reports (target_kind, target_id);
-- The review queue: urgent first, oldest first.
CREATE INDEX moderation_reports_queue_idx ON moderation_reports (priority DESC, created_at)
  WHERE state IN ('open', 'reviewing');

-- Backs ModerationRepository (blocks).
CREATE TABLE account_blocks (
  blocker_account_id text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  blocked_account_id text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  created_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (blocker_account_id, blocked_account_id),
  CONSTRAINT account_blocks_no_self_block CHECK (blocker_account_id <> blocked_account_id)
);
CREATE INDEX account_blocks_blocked_idx ON account_blocks (blocked_account_id);

-- ---------------------------------------------------------------------------
-- analytics domain
-- ---------------------------------------------------------------------------

-- Backs AnalyticsRepository. A write-ahead buffer in front of the warehouse;
-- `id` is client-minted so a retried batch de-duplicates on arrival.
-- No PII: no emails, no addresses, no player free text.
CREATE TABLE analytics_events (
  id                       text        PRIMARY KEY,
  name                     text        NOT NULL,
  account_id               text        REFERENCES accounts (id) ON DELETE SET NULL,
  session_id               text,
  campsite_id              text,
  platform                 platform    NOT NULL,
  app_version              text        NOT NULL,
  schema_version           text        NOT NULL,
  props                    jsonb       NOT NULL DEFAULT '{}'::jsonb,
  remapped_from_account_id text,
  occurred_at              timestamptz NOT NULL,
  received_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX analytics_events_name_time_idx ON analytics_events (name, occurred_at DESC);
CREATE INDEX analytics_events_account_idx ON analytics_events (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;

COMMIT;

-- Notes for the Postgres adapter
--   * `citext` is used for emails and handles; enable it with
--     `CREATE EXTENSION IF NOT EXISTS citext;` before running this file.
--   * Account merges are a single transaction: UPDATE every table with an
--     account_id from the absorbed id to the surviving id, then mark the
--     absorbed account `merged` with `merged_into_account_id` set. The partial
--     unique indexes above (reward_grants, carts, campsite_members) are the
--     ones a merge must reconcile rather than blindly re-point.
--   * Sweeping faded traces and expired idempotency records are cron jobs, not
--     request-path work: see `world_traces_sweep_idx` and `idempotency_expiry_idx`.

-- Backs RateLimiter (README Blocker 11): the shared velocity windows. Fixed
-- windows, matching `createMemoryRateLimiter` exactly — the two have to be the
-- same thing or testing against one says nothing about the other.
CREATE TABLE rate_limit_windows (
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 0,
  reset_at  timestamptz NOT NULL
);
CREATE INDEX rate_limit_windows_reset_idx ON rate_limit_windows (reset_at);
