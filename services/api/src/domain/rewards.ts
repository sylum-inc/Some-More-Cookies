import { createHash } from 'node:crypto';
import {
  canTransitionClaim,
  type AntiAbuseContext,
  type AntiAbuseSignal,
  type ClaimRewardRequest,
  type ClaimRewardResult,
  type RewardClaim,
  type RewardDefinition,
  type RewardGrant,
  type RewardPrerequisite,
  type RewardSource,
  type SandwichRecord,
} from '@somemore/protocol';
import { ApiError, conflict, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { PassportService } from './passport.js';
import type { DomainDeps } from './types.js';

/**
 * Rewards.
 *
 * Two tiers, two very different code paths:
 *  - `standard` (stamps, points, cosmetics, unlocks) is granted inline by
 *    gameplay. Cheap to be wrong about.
 *  - `high` (real-world perks: a free kit, an event ticket) is never granted by
 *    the client asking nicely. It goes through `claim`, which enforces
 *    claim-once, a per-account velocity limit, prerequisite re-derivation from
 *    server-side records, and a device/nonce anti-abuse pass.
 */
export interface RewardsService {
  listCatalog(): Promise<RewardDefinition[]>;
  listGrants(accountId: string): Promise<RewardGrant[]>;
  grant(accountId: string, code: string, source: RewardSource): Promise<RewardGrant | null>;
  grantGameplayRewards(accountId: string, sandwich: SandwichRecord): Promise<RewardGrant[]>;
  claim(accountId: string, request: ClaimRewardRequest, context: ClaimContext): Promise<ClaimRewardResult>;
  /** Used by commerce when a reward grant is redeemed against an order. */
  consumeGrant(accountId: string, grantId: string, orderId: string): Promise<RewardGrant>;
}

export interface ClaimContext {
  readonly clientIp: string;
}

const RISK_WEIGHTS: Readonly<Record<AntiAbuseSignal, number>> = {
  device_shared_across_accounts: 0.45,
  claim_velocity_exceeded: 0.4,
  account_too_young: 0.2,
  duplicate_client_nonce: 0.6,
  prerequisites_unmet: 1,
  ip_reputation: 0.3,
  emulator_suspected: 0.3,
  unlinked_account: 0.15,
};

const AUTO_REJECT_RISK = 0.5;
const MANUAL_REVIEW_RISK = 0.25;

export function createRewardsService(deps: DomainDeps, passports: PassportService): RewardsService {
  const { repos, clock, ids, config, logger, rateLimiter } = deps;

  function hashIp(ip: string): string {
    return createHash('sha256').update(`${config.ipHashSalt}:${ip}`).digest('hex');
  }

  async function available(definition: RewardDefinition, nowIso: string): Promise<boolean> {
    if (!definition.active) return false;
    if (definition.availableFrom !== null && definition.availableFrom > nowIso) return false;
    if (definition.availableUntil !== null && definition.availableUntil <= nowIso) return false;
    return true;
  }

  /** Re-derive every prerequisite from server-owned records. Never trust input. */
  async function unmetPrerequisites(accountId: string, prerequisites: readonly RewardPrerequisite[]): Promise<string[]> {
    const unmet: string[] = [];
    for (const prerequisite of prerequisites) {
      switch (prerequisite.kind) {
        case 'stamp': {
          const passport = await repos.passports.get(accountId);
          const stamp = passport?.stamps.find((s) => s.code === prerequisite.code);
          if ((stamp?.count ?? 0) < prerequisite.count) unmet.push(`stamp:${prerequisite.code}`);
          break;
        }
        case 'sandwiches_made': {
          const made = await repos.sandwiches.countByAccount(accountId);
          if (made < prerequisite.count) unmet.push(`sandwiches_made:${prerequisite.count}`);
          break;
        }
        case 'min_sandwich_score': {
          const best = await repos.sandwiches.bestScoreForAccount(accountId);
          if (best < prerequisite.score) unmet.push(`min_sandwich_score:${prerequisite.score}`);
          break;
        }
        case 'points': {
          const passport = await repos.passports.get(accountId);
          if ((passport?.stats.points ?? 0) < prerequisite.points) unmet.push(`points:${prerequisite.points}`);
          break;
        }
        case 'account_age_hours': {
          const account = await repos.accounts.get(accountId);
          const ageHours =
            account === null ? 0 : (clock.now().getTime() - Date.parse(account.createdAt)) / 3_600_000;
          if (ageHours < prerequisite.hours) unmet.push(`account_age_hours:${prerequisite.hours}`);
          break;
        }
        case 'linked_identity': {
          const identities = await repos.identities.listByAccount(accountId);
          if (!identities.some((i) => i.provider === prerequisite.provider)) {
            unmet.push(`linked_identity:${prerequisite.provider}`);
          }
          break;
        }
      }
    }
    return unmet;
  }

  async function applyGrantSideEffects(accountId: string, definition: RewardDefinition, grantId: string): Promise<void> {
    const now = clock.isoNow();
    switch (definition.kind) {
      case 'stamp':
        await passports.addStamp(accountId, {
          code: definition.code,
          name: definition.name,
          description: definition.description,
          rarity: definition.rarity,
          earnedAt: now,
          campsiteId: null,
          count: 1,
        });
        break;
      case 'patch':
        await passports.addPatch(accountId, {
          code: definition.code,
          name: definition.name,
          rarity: definition.rarity,
          earnedAt: now,
          slot: 'cover',
          equipped: false,
        });
        break;
      case 'perk':
        if (definition.payloadCode !== null && definition.payloadCode.startsWith('ticket_')) {
          await passports.addTicketStub(accountId, {
            code: definition.payloadCode,
            eventName: definition.name,
            venue: null,
            issuedAt: now,
            admittedAt: null,
            orderId: null,
            rewardGrantId: grantId,
          });
        }
        break;
      default:
        break;
    }
    if (definition.points > 0) await passports.addPoints(accountId, definition.points);
  }

  async function createGrant(
    accountId: string,
    definition: RewardDefinition,
    source: RewardSource,
  ): Promise<RewardGrant> {
    const now = clock.isoNow();
    const grant = await repos.rewardGrants.create({
      id: ids.next(ID_PREFIX.grant),
      accountId,
      rewardId: definition.id,
      rewardCode: definition.code,
      kind: definition.kind,
      valueTier: definition.valueTier,
      points: definition.points,
      status: 'granted',
      source,
      grantedAt: now,
      revokedAt: null,
      consumedAt: null,
      redeemedOnOrderId: null,
    });
    await repos.rewardDefinitions.update(definition.id, (d) => ({ ...d, globalClaimed: d.globalClaimed + 1 }));
    await applyGrantSideEffects(accountId, definition, grant.id);
    return grant;
  }

  const service: RewardsService = {
    async listCatalog() {
      const nowIso = clock.isoNow();
      const all = await repos.rewardDefinitions.list();
      const visible: RewardDefinition[] = [];
      for (const definition of all) {
        if (await available(definition, nowIso)) visible.push(definition);
      }
      return visible;
    },

    async listGrants(accountId) {
      return repos.rewardGrants.listByAccount(accountId);
    },

    async grant(accountId, code, source) {
      const definition = await repos.rewardDefinitions.getByCode(code);
      if (definition === null) throw notFound(`No reward called ${code}.`);
      if (!(await available(definition, clock.isoNow()))) return null;
      if (definition.valueTier === 'high') {
        throw new ApiError('forbidden', 'High-value rewards must go through the validated claim flow.');
      }
      const held = await repos.rewardGrants.countForAccountAndReward(accountId, definition.id);
      if (held >= definition.perAccountLimit) return null;
      if (definition.globalLimit !== null && definition.globalClaimed >= definition.globalLimit) return null;
      const unmet = await unmetPrerequisites(accountId, definition.prerequisites);
      if (unmet.length > 0) return null;
      return createGrant(accountId, definition, source);
    },

    async grantGameplayRewards(accountId, sandwich) {
      const source: RewardSource = { type: 'gameplay', sandwichId: sandwich.id, campsiteId: sandwich.campsiteId };
      const granted: RewardGrant[] = [];
      for (const code of ['first_roast', 'golden_brown', 'machine_whisperer']) {
        const grant = await service.grant(accountId, code, source);
        if (grant !== null) granted.push(grant);
      }
      return granted;
    },

    async claim(accountId, request, context) {
      const nowIso = clock.isoNow();
      const definition = await repos.rewardDefinitions.getByCode(request.rewardCode);
      if (definition === null) throw notFound(`No reward called ${request.rewardCode}.`);
      if (!(await available(definition, nowIso))) throw conflict('That reward is not available right now.');

      // Claim-once, regardless of idempotency key: a second attempt with a new
      // key is a genuine duplicate claim, not a retry.
      const held = await repos.rewardGrants.countForAccountAndReward(accountId, definition.id);
      if (held >= definition.perAccountLimit) {
        throw new ApiError('reward_already_claimed', 'You have already claimed that reward.', {
          details: { rewardCode: definition.code, perAccountLimit: definition.perAccountLimit },
        });
      }

      if (definition.valueTier === 'standard') {
        const unmet = await unmetPrerequisites(accountId, definition.prerequisites);
        if (unmet.length > 0) {
          throw new ApiError('precondition_failed', 'You have not earned that yet.', { details: { unmet } });
        }
        const grant = await createGrant(accountId, definition, { type: 'gameplay' });
        return { status: 'granted', grant, claim: null };
      }

      /* ---- high-value path ---------------------------------------------- */

      const openClaim = await repos.rewardClaims.findByAccountAndReward(accountId, definition.id);
      if (openClaim !== null) {
        throw new ApiError('reward_already_claimed', 'You already have a claim open for that reward.', {
          details: { claimId: openClaim.id, state: openClaim.state },
        });
      }

      const decision = rateLimiter.consume(
        `reward_claim:${accountId}`,
        config.rewardClaimsPerWindow,
        config.rewardClaimWindowSeconds,
      );
      if (!decision.allowed) {
        throw new ApiError('rate_limited', 'Too many reward claims. Slow down.', {
          headers: { 'retry-after': String(Math.max(1, Math.ceil((decision.resetAt.getTime() - clock.now().getTime()) / 1000))) },
          details: { limit: config.rewardClaimsPerWindow, windowSeconds: config.rewardClaimWindowSeconds },
        });
      }

      const signals: AntiAbuseSignal[] = [];
      const duplicateNonce = await repos.rewardClaims.findByNonce(request.clientNonce);
      if (duplicateNonce !== null) signals.push('duplicate_client_nonce');

      const accountsOnDevice = await repos.identities.countAccountsByAnonymousSubject(request.deviceId);
      if (accountsOnDevice > 2) signals.push('device_shared_across_accounts');

      const windowStart = new Date(clock.now().getTime() - config.rewardClaimWindowSeconds * 1000).toISOString();
      const claimsInWindow = await repos.rewardClaims.countSince(accountId, windowStart);
      if (claimsInWindow >= config.rewardClaimsPerWindow) signals.push('claim_velocity_exceeded');

      const account = await repos.accounts.get(accountId);
      const ageHours = account === null ? 0 : (clock.now().getTime() - Date.parse(account.createdAt)) / 3_600_000;
      if (ageHours < 0) signals.push('account_too_young');

      const identities = await repos.identities.listByAccount(accountId);
      if (!identities.some((i) => i.provider !== 'anonymous')) signals.push('unlinked_account');

      const unmet = await unmetPrerequisites(accountId, definition.prerequisites);
      if (unmet.length > 0) signals.push('prerequisites_unmet');

      const riskScore = Math.min(1, signals.reduce((sum, signal) => sum + RISK_WEIGHTS[signal], 0));
      const antiAbuse: AntiAbuseContext = {
        deviceId: request.deviceId,
        ipHash: hashIp(context.clientIp),
        clientNonce: request.clientNonce,
        riskScore: Number(riskScore.toFixed(4)),
        signals,
        claimsInWindow,
        accountsOnDevice: Math.max(1, accountsOnDevice),
        duplicateOfClaimId: duplicateNonce?.id ?? null,
      };

      const claim = await repos.rewardClaims.create({
        id: ids.next(ID_PREFIX.claim),
        accountId,
        rewardId: definition.id,
        rewardCode: definition.code,
        state: 'pending',
        requestedAt: nowIso,
        updatedAt: nowIso,
        decidedAt: null,
        expiresAt: new Date(clock.now().getTime() + 7 * 24 * 3_600_000).toISOString(),
        antiAbuse,
        rejectionReason: null,
        grantId: null,
        fulfillmentRef: null,
        idempotencyKey: request.idempotencyKey,
      });

      const validating = await advance(claim.id, 'validating', nowIso);

      if (definition.globalLimit !== null && definition.globalClaimed >= definition.globalLimit) {
        const rejected = await reject(validating.id, 'This reward has run out.', nowIso);
        return { status: 'rejected', claim: rejected, signals: rejected.antiAbuse.signals };
      }

      if (riskScore >= AUTO_REJECT_RISK) {
        const reason =
          unmet.length > 0 ? `Prerequisites not met: ${unmet.join(', ')}` : 'Automated anti-abuse checks failed.';
        const rejected = await reject(validating.id, reason, nowIso);
        logger.warn('rewards.claim_rejected', { accountId, rewardCode: definition.code, signals, riskScore });
        return { status: 'rejected', claim: rejected, signals };
      }

      if (riskScore >= MANUAL_REVIEW_RISK) {
        logger.info('rewards.claim_pending_review', { accountId, rewardCode: definition.code, riskScore });
        return { status: 'pending_review', claim: validating };
      }

      const approved = await advance(validating.id, 'approved', nowIso);
      const grant = await createGrant(accountId, definition, { type: 'gameplay' });
      const fulfilled = await repos.rewardClaims.update(approved.id, (c) => ({
        ...c,
        state: 'fulfilled',
        grantId: grant.id,
        fulfillmentRef: definition.payloadCode,
        decidedAt: nowIso,
        updatedAt: nowIso,
      }));
      logger.info('rewards.claim_fulfilled', { accountId, rewardCode: definition.code, grantId: grant.id });
      return { status: 'granted', grant, claim: fulfilled };
    },

    async consumeGrant(accountId, grantId, orderId) {
      const grant = await repos.rewardGrants.get(grantId);
      if (grant === null || grant.accountId !== accountId) throw notFound('No such reward grant.');
      if (grant.status !== 'granted') throw conflict('That reward has already been used.');
      return repos.rewardGrants.update(grantId, (g) => ({
        ...g,
        status: 'consumed',
        consumedAt: clock.isoNow(),
        redeemedOnOrderId: orderId,
      }));
    },
  };

  async function advance(claimId: string, to: RewardClaim['state'], nowIso: string): Promise<RewardClaim> {
    const current = await repos.rewardClaims.get(claimId);
    if (current === null) throw notFound('No such claim.');
    if (!canTransitionClaim(current.state, to)) {
      throw new ApiError('illegal_state_transition', `A claim cannot go from ${current.state} to ${to}.`);
    }
    return repos.rewardClaims.update(claimId, (c) => ({ ...c, state: to, updatedAt: nowIso }));
  }

  async function reject(claimId: string, reason: string, nowIso: string): Promise<RewardClaim> {
    const rejected = await advance(claimId, 'rejected', nowIso);
    return repos.rewardClaims.update(rejected.id, (c) => ({
      ...c,
      rejectionReason: reason,
      decidedAt: nowIso,
      updatedAt: nowIso,
    }));
  }

  return service;
}
