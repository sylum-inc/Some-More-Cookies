-- Operator capabilities (README, Blocker 9).
--
-- Before this there was one shared secret. Holding `LIVE_OPS_TOKEN` meant you
-- could draft a document, publish it to every player, mint a hundred thousand
-- codes, advance somebody's order and refund it — all the same permission, held
-- by everyone who had the string, with no way to take it back from one person.
--
-- One row per (account, capability). Revoking sets `revoked_at` rather than
-- deleting: a revocation is a fact about a person and a moment, and a missing
-- row cannot say when, or by whom.
CREATE TABLE IF NOT EXISTS operator_capabilities (
  account_id  text        NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  capability  text        NOT NULL,
  revoked_at  timestamptz,
  doc         jsonb       NOT NULL,
  PRIMARY KEY (account_id, capability)
);

-- The question every authorization asks: what does this account hold *now*.
CREATE INDEX IF NOT EXISTS operator_capabilities_live_idx
  ON operator_capabilities (account_id)
  WHERE revoked_at IS NULL;
