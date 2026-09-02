-- Shared rate-limit windows (README Blocker 11).
--
-- The velocity limiter counted in process memory, so two instances of this
-- service were two budgets. Claim-once was never at risk — that is
-- `reward_grants_one_live_per_account_reward`, a partial unique index, and it
-- holds across instances regardless — but every *rate* in the service was
-- per-process, including anonymous signups and telemetry ingest.
--
-- A fixed window rather than a sliding one, matching the in-memory
-- implementation exactly: the two have to be the same thing, or testing
-- against one says nothing about the other.
CREATE TABLE IF NOT EXISTS rate_limit_windows (
  -- The limiter's own composite key: `code_fail:<ip hash>`, `anon_signup:<ip
  -- hash>`, `reward_claim:<account id>`. Opaque here on purpose — this table
  -- knows about budgets, not about what is being budgeted.
  key       text        PRIMARY KEY,
  count     integer     NOT NULL DEFAULT 0,
  reset_at  timestamptz NOT NULL
);

-- For the sweep. Without it, deleting expired windows is a sequential scan of
-- a table whose whole purpose is to be written to constantly.
CREATE INDEX IF NOT EXISTS rate_limit_windows_reset_idx ON rate_limit_windows (reset_at);
