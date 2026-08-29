-- 0003_invariants: the rules the database refuses to let the service break.
--
-- Each of these mirrors an invariant `sql/schema.sql` declares and the
-- in-memory repositories enforce by hand. Under concurrency, "enforce by hand"
-- means "check, then hope"; these indexes are what make the same rule hold when
-- two requests race. The Postgres repositories translate each violation into
-- the same ApiError the single-threaded path would have produced.

SET LOCAL search_path = somemore, public;

-- One identity per (provider, subject), forever. This is what stops a second
-- account being minted for a device that already bootstrapped.
CREATE UNIQUE INDEX identities_provider_subject_unique ON identities (provider, subject);
-- One account per verified email address.
CREATE UNIQUE INDEX identities_verified_email_unique ON identities (lower(email))
  WHERE email IS NOT NULL AND email_verified;

-- NOT one identity per provider per account, though `sql/schema.sql` says so.
-- That index is incompatible with the merge the product actually promises: a
-- player who roasted on their phone and again on the couch has two `anonymous`
-- identities, one per device, and absorbing one account into the other has to
-- carry both — "a merge is never a reset". The index would fail the merge and
-- lose a device's history. What genuinely must be unique is (provider,
-- subject), above, and that is what stops a device bootstrapping twice.

-- Handles are unique case-insensitively; the passport claims one on write.
CREATE UNIQUE INDEX passports_handle_unique ON passports (lower(handle)) WHERE handle IS NOT NULL;

-- A camp code is spoken out loud to join; it must address exactly one campsite.
CREATE UNIQUE INDEX campsites_camp_code_unique ON campsites (camp_code);

-- One live session per campsite. `create` checks first; this makes the check
-- true even when two hosts press the button in the same millisecond.
CREATE UNIQUE INDEX sessions_one_live_per_campsite ON sessions (campsite_id)
  WHERE state IN ('lobby', 'active');

-- Reward codes address definitions; grants are claim-once per account.
CREATE UNIQUE INDEX reward_definitions_code_unique ON reward_definitions (code);
-- Claim-once, enforced by the database rather than by hope: two requests
-- racing for the same one-per-player reward both read a count of zero, and the
-- loser's INSERT is refused here. `merged_in` is excluded because a grant that
-- arrived with an absorbed account was not claimed by this player twice — see
-- the note on `reward_grants.merged_in` in 0001.
CREATE UNIQUE INDEX reward_grants_one_live_per_account_reward
  ON reward_grants (account_id, reward_id)
  WHERE status <> 'revoked' AND NOT merged_in;

-- One open or succeeded claim per account per reward.
CREATE UNIQUE INDEX reward_claims_one_open_per_account_reward
  ON reward_claims (account_id, reward_id)
  WHERE state <> 'rejected' AND state <> 'expired';

-- NOT unique, deliberately, and this is the one place these migrations diverge
-- from `sql/schema.sql`.
--
-- `schema.sql` declares `reward_claims_nonce_unique`. The rewards domain does
-- something more useful with a replayed nonce than refusing the insert: it
-- *records* the second claim, raises the `duplicate_client_nonce` anti-abuse
-- signal, and points `antiAbuse.duplicateOfClaimId` at the original — which is
-- how a fraud reviewer sees the pair. A unique index would make the second
-- claim unstorable and throw that evidence away. The index therefore exists for
-- the lookup (`findByNonce`) and not for exclusion.
CREATE INDEX reward_claims_nonce_idx ON reward_claims (client_nonce, requested_at);

-- One open cart per account, and one order per payment intent.
CREATE UNIQUE INDEX carts_one_open_per_account ON carts (account_id)
  WHERE converted_order_id IS NULL;
CREATE UNIQUE INDEX orders_payment_intent_unique ON orders (payment_intent_id)
  WHERE payment_intent_id IS NOT NULL;
CREATE UNIQUE INDEX promotions_code_unique ON promotions (code);

-- Telemetry is de-duplicated by the client-minted event id.
CREATE UNIQUE INDEX analytics_events_id_unique ON analytics_events (id);
