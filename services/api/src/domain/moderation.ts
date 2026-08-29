import type { Block, CreateBlockRequest, CreateReportRequest, ModerationReport } from '@somemore/protocol';
import { badRequest, conflict, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { DomainDeps } from './types.js';

/**
 * Minimal, honest moderation: report a thing, block a person. Reports are
 * queued for human review — there is no automated actioning, and child-safety
 * reports are flagged urgent and never auto-dismissed.
 */
export interface ModerationService {
  report(accountId: string, request: CreateReportRequest): Promise<ModerationReport>;
  listMyReports(accountId: string): Promise<ModerationReport[]>;
  block(accountId: string, request: CreateBlockRequest): Promise<Block>;
  unblock(accountId: string, blockedAccountId: string): Promise<void>;
  listBlocks(accountId: string): Promise<Block[]>;
}

export function createModerationService(deps: DomainDeps): ModerationService {
  const { repos, clock, ids, logger } = deps;

  return {
    async report(accountId, request) {
      const now = clock.isoNow();
      const report = await repos.moderation.createReport({
        id: ids.next(ID_PREFIX.report),
        reporterAccountId: accountId,
        target: request.target,
        reason: request.reason,
        details: request.details,
        state: 'open',
        createdAt: now,
        updatedAt: now,
        priority: request.reason === 'child_safety' ? 'urgent' : 'standard',
      });
      logger.warn('moderation.report_filed', {
        reportId: report.id,
        reason: report.reason,
        priority: report.priority,
        targetKind: report.target.kind,
      });
      return report;
    },

    async listMyReports(accountId) {
      return repos.moderation.listReportsByReporter(accountId);
    },

    async block(accountId, request) {
      if (request.blockedAccountId === accountId) throw badRequest('You cannot block yourself.');
      const target = await repos.accounts.get(request.blockedAccountId);
      if (target === null) throw notFound('No such account.');
      if (await repos.moderation.isBlocked(accountId, request.blockedAccountId)) {
        throw conflict('You have already blocked that player.');
      }
      return repos.moderation.createBlock({
        blockerAccountId: accountId,
        blockedAccountId: request.blockedAccountId,
        createdAt: clock.isoNow(),
      });
    },

    async unblock(accountId, blockedAccountId) {
      const removed = await repos.moderation.deleteBlock(accountId, blockedAccountId);
      if (!removed) throw notFound('You have not blocked that player.');
    },

    async listBlocks(accountId) {
      return repos.moderation.listBlocks(accountId);
    },
  };
}
