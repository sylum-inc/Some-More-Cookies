-- 0005_campsite_memory: what a campsite remembers about a player, durably.
--
-- Until this table existed, campsite memory lived in one device's
-- `localStorage` and nothing else. Losing the phone lost every place that had
-- met you: the fox that recognised you, the secrets you had noticed, the marks
-- the significance model chose to keep. This is where that stops being true.
--
-- Same shape as 0001: typed, indexed columns for whatever the repository
-- interface queries, plus a `doc jsonb` holding the record.
--
-- **Never in this file: a significance score.** §6.4 says the memory-importance
-- model is invisible, and that is a property of the storage as much as of the
-- UI. What a synced trace carries is an id, a kind, a birth time and a
-- three-valued disposition; the sim's free-form evidence payload — rarity,
-- dwell seconds, interaction counts, the things the score is computed *from* —
-- does not reach this service and therefore cannot reach this table. There is
-- no column for it and no key in the document that holds it.
--
-- Also never in this file, exactly as in 0001 and 0004: card numbers, CVCs,
-- raw client IPs, image bytes.

SET LOCAL search_path = somemore, public;

CREATE TABLE campsite_memories (
  seq            bigserial   NOT NULL,
  account_id     text        NOT NULL,
  campsite_id    text        NOT NULL,
  environment_id text        NOT NULL,
  last_visit_at  timestamptz NOT NULL,
  updated_at     timestamptz NOT NULL,
  doc            jsonb       NOT NULL,
  PRIMARY KEY (account_id, campsite_id)
);

-- Campsite memory is a relationship between a player and a place, so the
-- primary key above is also the invariant: one row per pair, and the merge
-- that folds two devices together is a locked read-modify-write on it rather
-- than a second row nobody would ever reconcile.

-- "Every campsite that remembers me", for a device restoring a lost Passport.
CREATE INDEX campsite_memories_account_idx ON campsite_memories (account_id, seq);

-- The eventual sweeper: rows nobody has touched in a very long time still hold
-- traces whose lifetimes ran out, and the read path sweeps them lazily today.
CREATE INDEX campsite_memories_updated_idx ON campsite_memories (updated_at);
