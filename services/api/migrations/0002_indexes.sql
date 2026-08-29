-- 0002_indexes: the lookups the repository interfaces actually perform.
--
-- Every index here exists because a method on an interface in
-- `src/repos/interfaces.ts` would otherwise be a sequential scan.

SET LOCAL search_path = somemore, public;

-- identity ------------------------------------------------------------------
-- AccountRepository has no secondary lookups; merges follow the pointer.
CREATE INDEX accounts_merged_into_idx ON accounts (merged_into_account_id)
  WHERE merged_into_account_id IS NOT NULL;

-- IdentityRepository.listByAccount / reassignAccount.
CREATE INDEX identities_account_idx ON identities (account_id);
-- IdentityRepository.countAccountsByAnonymousSubject.
CREATE INDEX identities_anonymous_subject_idx ON identities (subject)
  WHERE provider = 'anonymous';

-- MagicLinkRepository: expiry sweeps and per-address rate limiting.
CREATE INDEX magic_links_email_idx ON magic_links (lower(email), created_at DESC);
CREATE INDEX magic_links_expiry_idx ON magic_links (expires_at) WHERE consumed_at IS NULL;

-- passport ------------------------------------------------------------------
-- PhotoRepository.listByAccount / reassignAccount.
CREATE INDEX photos_owner_idx ON photos (owner_account_id, created_at DESC);
CREATE INDEX photos_campsite_idx ON photos (campsite_id) WHERE campsite_id IS NOT NULL;
CREATE INDEX photos_sandwich_idx ON photos (sandwich_id) WHERE sandwich_id IS NOT NULL;

-- campsites -----------------------------------------------------------------
-- CampsiteRepository.listByOwner / reassignAccount.
CREATE INDEX campsites_owner_idx ON campsites (owner_account_id);
CREATE INDEX campsites_public_idx ON campsites (last_active_at DESC) WHERE privacy = 'public';
-- CampsiteRepository.listByMember: membership lives inside the aggregate, so
-- the containment query `doc->'members' @> '[{"accountId": …}]'` is what the
-- interface needs, and a jsonb_path_ops GIN index is what makes it cheap.
CREATE INDEX campsites_members_idx ON campsites USING gin ((doc -> 'members') jsonb_path_ops);

-- InviteRepository.listByCampsite / findByToken / findByCampCode.
CREATE INDEX campsite_invites_campsite_idx ON campsite_invites (campsite_id);
CREATE UNIQUE INDEX campsite_invites_token_idx ON campsite_invites (token);
CREATE INDEX campsite_invites_camp_code_idx ON campsite_invites (camp_code) WHERE revoked_at IS NULL;

-- worldState ----------------------------------------------------------------
CREATE INDEX world_traces_campsite_idx ON world_traces (campsite_id);
-- The nightly sweep walks traces by how long they have been decaying.
CREATE INDEX world_traces_sweep_idx ON world_traces (last_decayed_at)
  WHERE promoted_landmark_id IS NULL;
CREATE INDEX landmarks_campsite_idx ON landmarks (campsite_id, promoted_at);

-- sessions ------------------------------------------------------------------
CREATE INDEX sessions_campsite_idx ON sessions (campsite_id, started_at DESC);
-- AuthorityRepository.releaseAllHeldBy.
CREATE INDEX object_authority_holder_idx ON object_authority (session_id, holder_account_id)
  WHERE holder_account_id IS NOT NULL;
CREATE INDEX object_authority_lease_idx ON object_authority (expires_at)
  WHERE expires_at IS NOT NULL;

-- sandwiches ----------------------------------------------------------------
CREATE INDEX sandwich_records_account_idx ON sandwich_records (account_id, created_at DESC);
CREATE INDEX sandwich_records_campsite_idx ON sandwich_records (campsite_id, created_at DESC);
-- SandwichRepository.bestScoreForAccount.
CREATE INDEX sandwich_records_best_score_idx ON sandwich_records (account_id, overall_score DESC);

-- rewards -------------------------------------------------------------------
CREATE INDEX reward_grants_account_idx ON reward_grants (account_id, granted_at DESC);
CREATE INDEX reward_grants_account_reward_idx ON reward_grants (account_id, reward_id);
CREATE INDEX reward_claims_account_idx ON reward_claims (account_id, requested_at DESC);
CREATE INDEX reward_claims_review_queue_idx ON reward_claims (requested_at)
  WHERE state IN ('pending', 'validating');

-- commerce ------------------------------------------------------------------
CREATE INDEX carts_account_idx ON carts (account_id);
CREATE INDEX orders_account_idx ON orders (account_id, created_at DESC);
CREATE INDEX orders_fulfillment_queue_idx ON orders (status, created_at)
  WHERE status IN ('paid', 'in_production', 'packed');
CREATE INDEX promotion_redemptions_account_idx ON promotion_redemptions (promotion_id, account_id);
CREATE INDEX idempotency_expiry_idx ON idempotency_records (expires_at);

-- moderation ----------------------------------------------------------------
CREATE INDEX moderation_reports_reporter_idx ON moderation_reports (reporter_account_id, created_at DESC);
CREATE INDEX moderation_reports_queue_idx ON moderation_reports (priority DESC, created_at)
  WHERE state IN ('open', 'reviewing');
CREATE INDEX account_blocks_blocked_idx ON account_blocks (blocked_account_id);

-- analytics -----------------------------------------------------------------
CREATE INDEX analytics_events_name_time_idx ON analytics_events (name, occurred_at DESC);
CREATE INDEX analytics_events_account_idx ON analytics_events (account_id, occurred_at DESC)
  WHERE account_id IS NOT NULL;
