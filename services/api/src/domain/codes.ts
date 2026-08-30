import { createHash } from 'node:crypto';
import {
  CodeBatchSchema,
  codeToUri,
  parseSomeMoreCode,
  type CodeBatch,
  type CodeRedemption,
  type CodeRejection,
  type CodeSigningStatus,
  type CodeVerificationKeys,
  type CreateCodeBatchRequest,
  type MintCodesRequest,
  type MintCodesResult,
  type RedeemCodeRequest,
  type RedeemCodeResult,
  type RetireCodeBatchRequest,
} from '@somemore/protocol';
import { ApiError, conflict, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { CodeSigner } from '../codes/signing.js';
import type { RewardsService } from './rewards.js';
import type { DomainDeps } from './types.js';

/**
 * The physical ↔ digital bridge (spec §14): print runs, minting, and the
 * redemption path a player's camera lands on.
 *
 * The threat this module is written against is specific and certain: **someone
 * will photograph a wrapper and post it**, and someone else will scrape the
 * photo. Five things follow from that, in order of how much work they save:
 *
 *  1. A code is not a bearer token. Redeeming one requires an authenticated
 *     account, and the code carries nothing about what it is worth, so a
 *     scraped photo is not obviously worth scraping.
 *  2. A forged code is rejected by a signature check, before any storage is
 *     touched. Guessing is not a strategy: 96 bits of nonce inside a signed
 *     body means there is nothing to guess *at*.
 *  3. Claim-once is a unique index, not an `if`. Two people scanning the same
 *     posted photo at the same instant produce one grant and one refusal.
 *  4. Failures are rate limited per account *and* per salted IP hash, so
 *     working through a scraped list costs an attacker far more than it costs
 *     us. Every rejection reason a stranger can see is the same word.
 *  5. A run that starts being redeemed unusually fast is flagged for a human.
 *     It is not auto-retired: pulling a live run punishes everyone holding a
 *     real box, and that is a decision a person makes.
 */
export interface CodesService {
  signingStatus(): CodeSigningStatus;
  /** The public halves, for a client that verifies offline. Never the private. */
  verificationKeys(): CodeVerificationKeys;
  createBatch(actor: string, request: CreateCodeBatchRequest): Promise<CodeBatch>;
  listBatches(): Promise<CodeBatch[]>;
  getBatch(batchId: string): Promise<CodeBatch>;
  mint(actor: string, batchId: string, request: MintCodesRequest): Promise<MintCodesResult>;
  retire(actor: string, batchId: string, request: RetireCodeBatchRequest): Promise<CodeBatch>;
  redeem(accountId: string, request: RedeemCodeRequest, context: RedeemContext): Promise<RedeemCodeResult>;
  listRedemptions(accountId: string): Promise<CodeRedemption[]>;
}

export interface RedeemContext {
  readonly clientIp: string;
}

/** Player-facing text. Deliberately identical for every "no" that is not ours. */
const REJECTION_MESSAGES: Readonly<Record<CodeRejection, string>> = {
  malformed: 'That does not look like a Some More code.',
  bad_signature: 'That does not look like a Some More code.',
  unknown_key: 'That does not look like a Some More code.',
  unknown_batch: 'That does not look like a Some More code.',
  never_minted: 'That does not look like a Some More code.',
  expired: 'That code has expired.',
  batch_retired: 'That code is no longer being honoured.',
  batch_not_active: 'That code is not active yet.',
  already_redeemed: 'That code has already been used.',
  limit_reached: 'You have already redeemed a code from this run.',
  wrong_kind: 'That code is not redeemable here.',
};

export function createCodesService(
  deps: DomainDeps,
  signer: CodeSigner,
  rewards: RewardsService,
): CodesService {
  const { repos, clock, ids, config, logger, rateLimiter } = deps;

  function hashIp(ip: string): string {
    return createHash('sha256').update(`${config.ipHashSalt}:${ip}`).digest('hex');
  }

  function requireSigning(): void {
    const status = signer.status();
    if (status.status === 'not_configured') {
      throw new ApiError('service_not_configured', status.reason);
    }
  }

  function requireMinting(): void {
    requireSigning();
    if (!signer.canMint()) {
      throw new ApiError(
        'service_not_configured',
        'This deployment can verify codes but cannot mint them: no CODE_SIGNING_PRIVATE_KEY.',
      );
    }
  }

  /**
   * One place where a redemption says no.
   *
   * Everything a stranger could use as an oracle collapses into `code_invalid`
   * with the reason `invalid`; the reasons a real customer needs (expired,
   * withdrawn, already used) are distinguished because they are already obvious
   * from the code itself or from the fact that it worked once.
   */
  /*
   * `async` because the failure counter it feeds is now shared (Blocker 11),
   * and the counter has to land before the refusal is answered: the enforcing
   * check is a `peek` on the *next* request, so an unawaited write lets a fast
   * attacker out-run their own budget.
   *
   * It *builds* the error rather than throwing it, and every caller writes
   * `throw await rejection(...)`. TypeScript only applies never-return
   * narrowing to a direct call, not to an `await`, so an async function that
   * threw would have quietly stopped narrowing at thirteen call sites — which
   * is how the first attempt at this failed, loudly and immediately, with
   * "'batch' is possibly null" four lines further down.
   */
  async function rejection(
    reason: CodeRejection,
    ipHash: string,
    accountId: string,
  ): Promise<ApiError> {
    const failures = await rateLimiter.consume(
      `code_fail:${ipHash}`,
      config.codeFailuresPerWindow,
      config.codeRedemptionWindowSeconds,
    );
    if (!failures.allowed) {
      logger.warn('codes.failure_velocity', { accountId, count: failures.count });
    }
    const opaque: readonly CodeRejection[] = [
      'malformed',
      'bad_signature',
      'unknown_key',
      'unknown_batch',
      'never_minted',
      'wrong_kind',
    ];
    if (opaque.includes(reason)) {
      return new ApiError('code_invalid', REJECTION_MESSAGES[reason], {
        details: { reason: 'invalid' },
      });
    }
    if (reason === 'expired') {
      return new ApiError('code_invalid', REJECTION_MESSAGES.expired, { details: { reason } });
    }
    if (reason === 'batch_retired' || reason === 'batch_not_active') {
      return new ApiError('code_revoked', REJECTION_MESSAGES[reason], { details: { reason } });
    }
    return new ApiError('code_already_redeemed', REJECTION_MESSAGES[reason], { details: { reason } });
  }

  async function loadBatch(batchId: string): Promise<CodeBatch> {
    const batch = await repos.codeBatches.get(batchId);
    if (batch === null) throw notFound('No such code batch.');
    return batch;
  }

  return {
    signingStatus: () => signer.status(),

    verificationKeys: () => signer.verificationKeys(),

    async createBatch(actor, request) {
      requireMinting();
      const keyId = signer.mintingKeyId();
      if (keyId === null) throw new ApiError('service_not_configured', 'No minting key is configured.');
      const now = clock.isoNow();
      const batch = CodeBatchSchema.parse({
        // Short on purpose: the batch id travels inside every printed code, and
        // every character is QR modules on a wrapper.
        id: `${ID_PREFIX.codeBatch}_${ids.token(6)}`,
        label: request.label,
        kind: request.kind,
        keyId,
        entitlement: request.entitlement,
        status: 'active',
        mintedCount: 0,
        plannedSize: request.plannedSize,
        redeemedCount: 0,
        perAccountLimit: request.perAccountLimit,
        activeFrom: request.activeFrom,
        activeUntil: request.activeUntil,
        codeTtlDays: request.codeTtlDays,
        createdAt: now,
        createdBy: actor,
        updatedAt: now,
        retiredAt: null,
        retiredReason: null,
        flaggedAt: null,
        flagReason: null,
      } satisfies Record<string, unknown>);
      const created = await repos.codeBatches.create(batch);
      logger.info('codes.batch_created', {
        batchId: created.id,
        kind: created.kind,
        plannedSize: created.plannedSize,
      });
      return created;
    },

    listBatches: () => repos.codeBatches.list(),

    getBatch: loadBatch,

    /**
     * Mint a run.
     *
     * This response is the **only** copy of the codes. They are not written to
     * the database, not logged, and not recoverable — there is nothing here for
     * a leaked backup to contain. What the service keeps is the batch and, once
     * somebody scans, a redemption row.
     */
    async mint(actor, batchId, request) {
      requireMinting();
      const batch = await loadBatch(batchId);
      if (batch.status !== 'active') {
        throw conflict('That batch is not accepting new codes.', { status: batch.status });
      }
      if (batch.mintedCount + request.count > batch.plannedSize) {
        throw conflict('That would mint more codes than the run was planned for.', {
          plannedSize: batch.plannedSize,
          mintedCount: batch.mintedCount,
          requested: request.count,
        });
      }

      const expiresAtUnix =
        batch.codeTtlDays === null
          ? 0
          : Math.floor((clock.now().getTime() + batch.codeTtlDays * 86_400_000) / 1000);

      const minted: MintCodesResult['minted'] = [];
      for (let i = 0; i < request.count; i += 1) {
        const ref = (batch.mintedCount + i).toString(16).padStart(6, '0');
        const code = signer.mint({ kind: batch.kind, batchId: batch.id, ref, expiresAtUnix });
        if (code === null) throw new ApiError('service_not_configured', 'Minting key disappeared mid-run.');
        minted.push({ ref, token: code.token, uri: codeToUri(code.token) });
      }

      const updated = await repos.codeBatches.update(batch.id, (b) => ({
        ...b,
        mintedCount: b.mintedCount + minted.length,
        updatedAt: clock.isoNow(),
      }));
      logger.info('codes.minted', { batchId: batch.id, count: minted.length, total: updated.mintedCount, actor });
      return { batchId: batch.id, minted, mintedCount: updated.mintedCount, storedByService: false };
    },

    /**
     * Retire one run.
     *
     * Batch-scoped on purpose: a leaked print order is a leaked print order, and
     * invalidating every code ever printed because one warehouse pallet ended up
     * on eBay would be the wrong blast radius. Codes from other runs keep working.
     */
    async retire(actor, batchId, request) {
      requireSigning();
      const now = clock.isoNow();
      const retired = await repos.codeBatches.update(batchId, (b) => ({
        ...b,
        status: 'retired',
        retiredAt: b.retiredAt ?? now,
        retiredReason: b.retiredReason ?? request.reason,
        updatedAt: now,
      }));
      logger.warn('codes.batch_retired', { batchId, actor, reason: request.reason });
      return retired;
    },

    async redeem(accountId, request, context) {
      requireSigning();
      const ipHash = hashIp(context.clientIp);

      // Velocity, before anything else. A scraper working through a list should
      // hit this long before it learns whether any single code was real.
      const attempts = await rateLimiter.consume(
        `code_redeem:${accountId}`,
        config.codeRedemptionsPerWindow,
        config.codeRedemptionWindowSeconds,
      );
      const failures = await rateLimiter.peek(
        `code_fail:${ipHash}`,
        config.codeFailuresPerWindow,
        config.codeRedemptionWindowSeconds,
      );
      if (!attempts.allowed || !failures.allowed) {
        const resetAt = attempts.allowed ? failures.resetAt : attempts.resetAt;
        throw new ApiError('rate_limited', 'Too many code scans. Give it a minute.', {
          headers: {
            'retry-after': String(Math.max(1, Math.ceil((resetAt.getTime() - clock.now().getTime()) / 1000))),
          },
        });
      }

      const parsed = parseSomeMoreCode(request.code);
      if (!parsed.ok) throw await rejection('malformed', ipHash, accountId);

      const verdict = signer.verify(parsed.code);
      if (verdict === 'unknown_key') throw await rejection('unknown_key', ipHash, accountId);
      if (verdict !== 'ok') throw await rejection('bad_signature', ipHash, accountId);

      const body = parsed.code.body;
      const nowMs = clock.now().getTime();
      if (body.expiresAtUnix !== 0 && body.expiresAtUnix * 1000 <= nowMs) {
        throw await rejection('expired', ipHash, accountId);
      }
      // A campsite invite is a join, not a redemption; it goes through
      // `POST /v1/campsites/join`, which is where membership rules live.
      if (body.kind === 'camp') throw await rejection('wrong_kind', ipHash, accountId);

      const batch = await repos.codeBatches.get(body.batchId);
      if (batch === null) throw await rejection('unknown_batch', ipHash, accountId);
      if (batch.kind !== body.kind) throw await rejection('unknown_batch', ipHash, accountId);
      if (batch.status === 'retired') throw await rejection('batch_retired', ipHash, accountId);
      if (batch.status === 'paused') throw await rejection('batch_not_active', ipHash, accountId);

      const nowIso = clock.isoNow();
      if (batch.activeFrom !== null && nowIso < batch.activeFrom) throw await rejection('batch_not_active', ipHash, accountId);
      if (batch.activeUntil !== null && nowIso >= batch.activeUntil) throw await rejection('batch_not_active', ipHash, accountId);

      // A signature already proves we minted it, so this is belt-and-braces
      // against a key that leaked without our noticing: a serial beyond what
      // the run ever printed cannot be a real wrapper.
      const serial = Number.parseInt(body.ref, 16);
      if (!Number.isFinite(serial) || serial < 0 || serial >= batch.mintedCount) {
        throw await rejection('never_minted', ipHash, accountId);
      }

      const held = await repos.codeRedemptions.countForAccountAndBatch(accountId, batch.id);
      if (held >= batch.perAccountLimit) throw await rejection('limit_reached', ipHash, accountId);

      const redemption: CodeRedemption = {
        id: ids.next(ID_PREFIX.codeRedemption),
        batchId: batch.id,
        codeRef: body.ref,
        accountId,
        redeemedAt: nowIso,
        ipHash,
        deviceId: request.deviceId ?? null,
        grantId: null,
        riskScore: 0,
      };

      // The database decides. Not this function, and not the count above it:
      // between that read and this insert, another request may have won, and
      // the unique index is the only thing that knows.
      let stored: CodeRedemption;
      try {
        stored = await repos.codeRedemptions.redeem(redemption, {
          perAccountUnique: batch.perAccountLimit === 1,
        });
      } catch (error) {
        // A real code presented twice is exactly what working through a scraped
        // list looks like, so it counts against the failure budget too.
        if (error instanceof ApiError && error.code === 'code_already_redeemed') {
          await rateLimiter.consume(
            `code_fail:${ipHash}`,
            config.codeFailuresPerWindow,
            config.codeRedemptionWindowSeconds,
          );
        }
        throw error;
      }

      let grantId: string | null = null;
      let awarded = 'Thanks for scanning.';
      if (batch.entitlement.type === 'reward') {
        const grant = await rewards.grantFromCode(accountId, batch.entitlement.rewardCode, {
          type: 'code',
          batchId: batch.id,
          codeRef: body.ref,
        });
        grantId = grant?.id ?? null;
        /*
         * The reward's *name*, not its code.
         *
         * `awarded` is described in the protocol as "what the player actually
         * got, in words the terminal can print", and it was printing
         * `free_kit added to your Passport.` — which is a database key on a
         * campground booklet. Caught by screenshotting the panel: it worked
         * perfectly and read like a log line. The definition already carries a
         * written name; the code falls back only if somebody defined a reward
         * without one, which the schema does not allow.
         */
        const definition =
          grant === null ? null : await repos.rewardDefinitions.getByCode(grant.rewardCode);
        const name = definition?.name ?? grant?.rewardCode ?? '';
        awarded =
          grant === null
            ? 'You already have this one — nothing new to add to the Passport.'
            : `${name} added to your Passport.`;
      } else if (batch.entitlement.type === 'content') {
        awarded = `Unlocked: ${batch.entitlement.documentSlug}.`;
      }

      if (grantId !== null) {
        stored = await repos.codeRedemptions
          .get(stored.id)
          .then((current) => ({ ...(current ?? stored), grantId }));
      }

      const updatedBatch = await repos.codeBatches.update(batch.id, (b) => ({
        ...b,
        redeemedCount: b.redeemedCount + 1,
        updatedAt: nowIso,
      }));

      // Velocity on the run itself. A wrapper photographed and shared widely
      // looks exactly like this, and a human should look at it — but nobody's
      // real box stops working because of a graph.
      const windowStart = new Date(nowMs - config.codeRedemptionWindowSeconds * 1000).toISOString();
      const recent = await repos.codeRedemptions.countForBatchSince(batch.id, windowStart);
      if (recent >= config.codeBatchVelocityFlag && updatedBatch.flaggedAt === null) {
        await repos.codeBatches.update(batch.id, (b) => ({
          ...b,
          flaggedAt: nowIso,
          flagReason: `${recent} redemptions in ${config.codeRedemptionWindowSeconds}s — review whether this run is public.`,
          updatedAt: nowIso,
        }));
        logger.warn('codes.batch_flagged', { batchId: batch.id, recent });
      }

      logger.info('codes.redeemed', { batchId: batch.id, codeRef: body.ref, grantId });
      return { status: 'redeemed', batchId: batch.id, awarded, grantId, redemption: stored };
    },

    listRedemptions: (accountId) => repos.codeRedemptions.listByAccount(accountId),
  };
}
