import type { CodeBatch, CodeRedemption, ContentDocument, ContentRelease } from '@somemore/protocol';
import { ApiError } from '../../errors.js';
import type {
  CodeBatchRepository,
  CodeRedemptionRepository,
  ContentDocumentRepository,
  ContentReleaseRepository,
} from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `content_documents`. */
export function createMemoryContentDocumentRepository(): ContentDocumentRepository {
  const table = new MemoryTable<ContentDocument>('content document', (d) => d.id);
  return {
    async create(document) {
      // Mirrors `content_documents_kind_slug_version`: one row per version.
      const clash = table.first((d) => d.kind === document.kind && d.slug === document.slug && d.version === document.version);
      if (clash !== null) {
        throw new ApiError('conflict', `content document ${document.kind}/${document.slug} v${document.version} already exists.`);
      }
      return table.insert(document);
    },
    async get(documentId) {
      return table.find(documentId);
    },
    async update(documentId, mutate) {
      const next = table.mutate(documentId, mutate);
      // Mirrors `content_documents_one_published`, the partial unique index
      // that stops two versions of one slug being live at the same time.
      if (next.status === 'published') {
        const others = table.filter(
          (d) => d.kind === next.kind && d.slug === next.slug && d.status === 'published' && d.id !== next.id,
        );
        if (others.length > 0) {
          throw new ApiError('conflict', `${next.kind}/${next.slug} already has a published version.`);
        }
      }
      return next;
    },
    async list(filter) {
      return table
        .filter(
          (d) =>
            (filter?.kind === undefined || d.kind === filter.kind) &&
            (filter?.slug === undefined || d.slug === filter.slug) &&
            (filter?.status === undefined || d.status === filter.status),
        )
        .sort((a, b) => (a.kind === b.kind ? (a.slug === b.slug ? a.version - b.version : a.slug.localeCompare(b.slug)) : a.kind.localeCompare(b.kind)));
    },
    async latestVersion(kind, slug) {
      return table
        .filter((d) => d.kind === kind && d.slug === slug)
        .reduce((highest, d) => Math.max(highest, d.version), 0);
    },
    async findPublished(kind, slug) {
      return table.first((d) => d.kind === kind && d.slug === slug && d.status === 'published');
    },
    async listPublished() {
      return table
        .filter((d) => d.status === 'published')
        .sort((a, b) => (a.kind === b.kind ? a.slug.localeCompare(b.slug) : a.kind.localeCompare(b.kind)));
    },
  };
}

/** Backs `content_releases`. Append-only: there is no update method on purpose. */
export function createMemoryContentReleaseRepository(): ContentReleaseRepository {
  const table = new MemoryTable<ContentRelease>('content release', (r) => r.id);
  return {
    async create(release) {
      const clash = table.first((r) => r.version === release.version);
      if (clash !== null) throw new ApiError('conflict', `content release ${release.version} already exists.`);
      return table.insert(release);
    },
    async latest() {
      return table.all().sort((a, b) => b.version - a.version)[0] ?? null;
    },
    async getByVersion(version) {
      return table.first((r) => r.version === version);
    },
    async list(limit = 50) {
      return table.all().sort((a, b) => b.version - a.version).slice(0, limit);
    },
  };
}

/** Backs `code_batches`. */
export function createMemoryCodeBatchRepository(): CodeBatchRepository {
  const table = new MemoryTable<CodeBatch>('code batch', (b) => b.id);
  return {
    async create(batch) {
      return table.insert(batch);
    },
    async get(batchId) {
      return table.find(batchId);
    },
    async list() {
      return table.all().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    async update(batchId, mutate) {
      return table.mutate(batchId, mutate);
    },
  };
}

/**
 * Backs `code_redemptions`.
 *
 * The two uniqueness rules here are the reference semantics for the two unique
 * indexes in `0004_liveops_and_codes.sql`. In memory they hold because nothing
 * interleaves; in Postgres they hold because the database says so. The API
 * suite runs against both, which is how we know they agree.
 */
export function createMemoryCodeRedemptionRepository(): CodeRedemptionRepository {
  const table = new MemoryTable<CodeRedemption>('code redemption', (r) => r.id);
  return {
    async redeem(redemption, options) {
      const sameCode = table.first((r) => r.batchId === redemption.batchId && r.codeRef === redemption.codeRef);
      if (sameCode !== null) {
        throw new ApiError('code_already_redeemed', 'That code has already been used.', {
          details: { batchId: redemption.batchId, reason: 'already_redeemed' },
        });
      }
      if (options.perAccountUnique) {
        const sameAccount = table.first(
          (r) => r.batchId === redemption.batchId && r.accountId === redemption.accountId,
        );
        if (sameAccount !== null) {
          throw new ApiError('code_already_redeemed', 'You have already redeemed a code from this run.', {
            details: { batchId: redemption.batchId, reason: 'limit_reached' },
          });
        }
      }
      return table.insert(redemption);
    },
    async get(redemptionId) {
      return table.find(redemptionId);
    },
    async findByCode(batchId, codeRef) {
      return table.first((r) => r.batchId === batchId && r.codeRef === codeRef);
    },
    async countForBatch(batchId) {
      return table.filter((r) => r.batchId === batchId).length;
    },
    async countForAccountAndBatch(accountId, batchId) {
      return table.filter((r) => r.accountId === accountId && r.batchId === batchId).length;
    },
    async countForBatchSince(batchId, sinceIso) {
      return table.filter((r) => r.batchId === batchId && r.redeemedAt >= sinceIso).length;
    },
    async listByAccount(accountId) {
      return table
        .filter((r) => r.accountId === accountId)
        .sort((a, b) => b.redeemedAt.localeCompare(a.redeemedAt));
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const redemption of table.filter((r) => r.accountId === fromAccountId)) {
        table.put({ ...redemption, accountId: toAccountId });
        moved += 1;
      }
      return moved;
    },
  };
}
