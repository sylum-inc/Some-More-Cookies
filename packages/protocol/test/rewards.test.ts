import { describe, expect, it } from 'vitest';
import {
  AntiAbuseContextSchema,
  CLAIM_TRANSITIONS,
  ClaimRewardRequestSchema,
  ClaimRewardResultSchema,
  RewardClaimSchema,
  RewardDefinitionSchema,
  RewardGrantSchema,
  RewardPrerequisiteSchema,
  canTransitionClaim,
} from '../src/index.js';
import { NOW } from './fixtures.js';

describe('reward definitions', () => {
  it('defaults to a standard, single-claim reward', () => {
    const def = RewardDefinitionSchema.parse({
      id: 'rwd_1',
      code: 'first_roast',
      kind: 'stamp',
      name: 'First Roast',
    });
    expect(def.valueTier).toBe('standard');
    expect(def.perAccountLimit).toBe(1);
    expect(def.globalLimit).toBeNull();
    expect(def.active).toBe(true);
  });

  it('rejects a non-slug code, unknown kind and zero limits', () => {
    const base = { id: 'rwd_1', code: 'first_roast', kind: 'stamp', name: 'First Roast' };
    expect(RewardDefinitionSchema.safeParse({ ...base, code: 'First Roast' }).success).toBe(false);
    expect(RewardDefinitionSchema.safeParse({ ...base, kind: 'nft' }).success).toBe(false);
    expect(RewardDefinitionSchema.safeParse({ ...base, perAccountLimit: 0 }).success).toBe(false);
  });

  it('models prerequisites as a discriminated union', () => {
    expect(RewardPrerequisiteSchema.safeParse({ kind: 'sandwiches_made', count: 10 }).success).toBe(true);
    expect(RewardPrerequisiteSchema.safeParse({ kind: 'min_sandwich_score', score: 0.9 }).success).toBe(true);
    expect(RewardPrerequisiteSchema.safeParse({ kind: 'linked_identity', provider: 'apple' }).success).toBe(true);
    expect(RewardPrerequisiteSchema.safeParse({ kind: 'linked_identity', provider: 'anonymous' }).success).toBe(false);
    expect(RewardPrerequisiteSchema.safeParse({ kind: 'vibes' }).success).toBe(false);
  });
});

describe('grants', () => {
  it('requires a typed source', () => {
    const grant = {
      id: 'grt_1',
      accountId: 'acct_1',
      rewardId: 'rwd_1',
      rewardCode: 'first_roast',
      kind: 'stamp',
      valueTier: 'standard',
      source: { type: 'gameplay', sandwichId: 'swh_1' },
      grantedAt: NOW,
    };
    expect(RewardGrantSchema.parse(grant).status).toBe('granted');
    expect(RewardGrantSchema.safeParse({ ...grant, source: { type: 'magic' } }).success).toBe(false);
    expect(RewardGrantSchema.safeParse({ ...grant, source: { type: 'admin' } }).success).toBe(false);
    expect(
      RewardGrantSchema.safeParse({ ...grant, source: { type: 'admin', actor: 'ops', reason: 'support ticket' } })
        .success,
    ).toBe(true);
  });
});

describe('high-value claims', () => {
  const antiAbuse = {
    deviceId: 'device-abc-123456',
    ipHash: 'a'.repeat(64),
    clientNonce: 'nonce-abcdefgh',
    riskScore: 0.1,
    signals: [],
  };

  it('requires a hashed ip, never a raw one', () => {
    expect(AntiAbuseContextSchema.safeParse(antiAbuse).success).toBe(true);
    expect(AntiAbuseContextSchema.safeParse({ ...antiAbuse, ipHash: '203.0.113.9' }).success).toBe(false);
    expect(AntiAbuseContextSchema.safeParse({ ...antiAbuse, riskScore: 2 }).success).toBe(false);
    expect(AntiAbuseContextSchema.safeParse({ ...antiAbuse, signals: ['bad_vibes'] }).success).toBe(false);
  });

  it('parses a claim with defaults', () => {
    const claim = RewardClaimSchema.parse({
      id: 'clm_1',
      accountId: 'acct_1',
      rewardId: 'rwd_9',
      rewardCode: 'free_kit',
      state: 'pending',
      requestedAt: NOW,
      updatedAt: NOW,
      expiresAt: NOW,
      antiAbuse,
      idempotencyKey: 'claim-0001',
    });
    expect(claim.grantId).toBeNull();
    expect(claim.fulfillmentRef).toBeNull();
  });

  it('enforces the claim state machine', () => {
    expect(canTransitionClaim('pending', 'validating')).toBe(true);
    expect(canTransitionClaim('validating', 'approved')).toBe(true);
    expect(canTransitionClaim('approved', 'fulfilled')).toBe(true);
    expect(canTransitionClaim('pending', 'fulfilled')).toBe(false);
    expect(canTransitionClaim('rejected', 'approved')).toBe(false);
    expect(canTransitionClaim('fulfilled', 'rejected')).toBe(false);
    expect(CLAIM_TRANSITIONS.expired).toEqual([]);
  });

  it('requires device and nonce on the claim request', () => {
    expect(ClaimRewardRequestSchema.safeParse({ idempotencyKey: 'claim-0001', rewardCode: 'free_kit' }).success).toBe(
      false,
    );
    expect(
      ClaimRewardRequestSchema.safeParse({
        idempotencyKey: 'claim-0001',
        rewardCode: 'free_kit',
        deviceId: 'device-abc-123456',
        clientNonce: 'nonce-abcdefgh',
      }).success,
    ).toBe(true);
  });

  it('models the three claim outcomes', () => {
    expect(ClaimRewardResultSchema.safeParse({ status: 'maybe' }).success).toBe(false);
    const claim = RewardClaimSchema.parse({
      id: 'clm_1',
      accountId: 'acct_1',
      rewardId: 'rwd_9',
      rewardCode: 'free_kit',
      state: 'rejected',
      requestedAt: NOW,
      updatedAt: NOW,
      expiresAt: NOW,
      antiAbuse,
      idempotencyKey: 'claim-0001',
    });
    expect(
      ClaimRewardResultSchema.safeParse({ status: 'rejected', claim, signals: ['claim_velocity_exceeded'] }).success,
    ).toBe(true);
  });
});
