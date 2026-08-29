import type { CodeBatch, CodeRedemption, ContentDocument, ContentRelease } from '@somemore/protocol';
import { ApiError } from '../../errors.js';
import { PgError, UNIQUE_VIOLATION, type PgPool } from '../../db/wire/index.js';
import type {
  CodeBatchRepository,
  CodeRedemptionRepository,
  ContentDocumentRepository,
  ContentReleaseRepository,
} from '../interfaces.js';
import { DocTable } from './support.js';

/** The constraint name a failed insert blamed, whatever wrapped the failure. */
function constraintOf(error: unknown): string | null {
  if (error instanceof PgError) return error.constraint ?? null;
  if (
    error instanceof ApiError &&
    typeof error.details === 'object' &&
    error.details !== null &&
    'constraint' in error.details &&
    typeof error.details.constraint === 'string'
  ) {
    return error.details.constraint;
  }
  return null;
}

/** Backs `content_documents`. */
export function createPostgresContentDocumentRepository(pool: PgPool): ContentDocumentRepository {
  const table = new DocTable<ContentDocument>(pool, {
    table: 'content_documents',
    entityName: 'content document',
    primaryKey: ['id'],
    keyOf: (d) => [d.id],
    project: (d) => ({
      kind: d.kind,
      slug: d.slug,
      version: d.version,
      status: d.status,
      checksum: d.checksum,
      activation_starts_at: d.activation?.startsAt ?? null,
      activation_ends_at: d.activation?.endsAt ?? null,
      created_at: d.createdAt,
      updated_at: d.updatedAt,
      published_at: d.publishedAt,
    }),
  });

  return {
    async create(document) {
      try {
        return await table.insert(document);
      } catch (error) {
        if (constraintOf(error) === 'content_documents_kind_slug_version') {
          throw new ApiError(
            'conflict',
            `content document ${document.kind}/${document.slug} v${document.version} already exists.`,
            { cause: error },
          );
        }
        throw error;
      }
    },

    async get(documentId) {
      return table.find([documentId]);
    },

    /**
     * The publish path goes through here, so the partial unique index
     * `content_documents_one_published` is what decides a race between two
     * operators publishing different versions of the same slug. The loser gets
     * the same `conflict` the sequential path would have produced.
     */
    async update(documentId, mutate) {
      try {
        return await table.mutate([documentId], mutate);
      } catch (error) {
        if (constraintOf(error) === 'content_documents_one_published' || (error instanceof PgError && error.code === UNIQUE_VIOLATION && error.constraint === 'content_documents_one_published')) {
          throw new ApiError('conflict', 'That document already has a published version.', { cause: error });
        }
        throw error;
      }
    },

    async list(filter) {
      const where: string[] = [];
      const params: string[] = [];
      if (filter?.kind !== undefined) {
        params.push(filter.kind);
        where.push(`kind = $${params.length}`);
      }
      if (filter?.slug !== undefined) {
        params.push(filter.slug);
        where.push(`slug = $${params.length}`);
      }
      if (filter?.status !== undefined) {
        params.push(filter.status);
        where.push(`status = $${params.length}`);
      }
      const clause = where.length === 0 ? 'true' : where.join(' AND ');
      return table.list(clause, params, 'kind, slug, version');
    },

    async latestVersion(kind, slug) {
      const row = await pool.maybeOne<{ v: number | null }>(
        'SELECT max(version)::int AS v FROM somemore.content_documents WHERE kind = $1 AND slug = $2',
        [kind, slug],
      );
      return row?.v ?? 0;
    },

    async findPublished(kind, slug) {
      return table.first("kind = $1 AND slug = $2 AND status = 'published'", [kind, slug]);
    },

    async listPublished() {
      return table.list("status = 'published'", [], 'kind, slug');
    },
  };
}

/** Backs `content_releases`. Append-only by design; there is no update. */
export function createPostgresContentReleaseRepository(pool: PgPool): ContentReleaseRepository {
  const table = new DocTable<ContentRelease>(pool, {
    table: 'content_releases',
    entityName: 'content release',
    primaryKey: ['id'],
    keyOf: (r) => [r.id],
    project: (r) => ({ version: r.version, reason: r.reason, created_at: r.createdAt }),
  });

  return {
    async create(release) {
      try {
        return await table.insert(release);
      } catch (error) {
        if (constraintOf(error) === 'content_releases_version_unique') {
          throw new ApiError('conflict', `content release ${release.version} already exists.`, { cause: error });
        }
        throw error;
      }
    },
    async latest() {
      return table.first('true', [], 'version DESC');
    },
    async getByVersion(version) {
      return table.first('version = $1', [version]);
    },
    async list(limit = 50) {
      const rows = await pool.many<{ doc: ContentRelease }>(
        'SELECT doc FROM somemore.content_releases ORDER BY version DESC LIMIT $1',
        [limit],
      );
      return rows.map((row) => row.doc);
    },
  };
}

/** Backs `code_batches`. */
export function createPostgresCodeBatchRepository(pool: PgPool): CodeBatchRepository {
  const table = new DocTable<CodeBatch>(pool, {
    table: 'code_batches',
    entityName: 'code batch',
    primaryKey: ['id'],
    keyOf: (b) => [b.id],
    project: (b) => ({
      label: b.label,
      kind: b.kind,
      key_id: b.keyId,
      status: b.status,
      minted_count: b.mintedCount,
      redeemed_count: b.redeemedCount,
      created_at: b.createdAt,
    }),
  });

  return {
    async create(batch) {
      return table.insert(batch);
    },
    async get(batchId) {
      return table.find([batchId]);
    },
    async list() {
      return table.all('created_at, seq');
    },
    async update(batchId, mutate) {
      return table.mutate([batchId], mutate);
    },
  };
}

/**
 * Backs `code_redemptions`.
 *
 * The insert is written by hand rather than through `DocTable` because
 * `per_account_key` is not a field of the protocol object: it is the batch's
 * per-account rule projected onto the row that has to obey it, so a partial
 * unique index can enforce it without consulting another table.
 */
export function createPostgresCodeRedemptionRepository(pool: PgPool): CodeRedemptionRepository {
  return {
    async redeem(redemption, options) {
      try {
        await pool.query(
          `INSERT INTO somemore.code_redemptions
             (id, batch_id, code_ref, account_id, redeemed_at, per_account_key, doc)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
          [
            redemption.id,
            redemption.batchId,
            redemption.codeRef,
            redemption.accountId,
            redemption.redeemedAt,
            options.perAccountUnique ? redemption.accountId : null,
            redemption as unknown as Record<string, unknown>,
          ],
        );
      } catch (error) {
        if (error instanceof PgError && error.code === UNIQUE_VIOLATION) {
          if (error.constraint === 'code_redemptions_one_per_code') {
            throw new ApiError('code_already_redeemed', 'That code has already been used.', {
              details: { batchId: redemption.batchId, reason: 'already_redeemed' },
              cause: error,
            });
          }
          if (error.constraint === 'code_redemptions_one_per_account') {
            throw new ApiError('code_already_redeemed', 'You have already redeemed a code from this run.', {
              details: { batchId: redemption.batchId, reason: 'limit_reached' },
              cause: error,
            });
          }
          throw new ApiError('conflict', 'code redemption already exists.', { cause: error });
        }
        throw error;
      }
      return structuredClone(redemption);
    },

    async get(redemptionId) {
      const row = await pool.maybeOne<{ doc: CodeRedemption }>(
        'SELECT doc FROM somemore.code_redemptions WHERE id = $1',
        [redemptionId],
      );
      return row === null ? null : row.doc;
    },

    async findByCode(batchId, codeRef) {
      const row = await pool.maybeOne<{ doc: CodeRedemption }>(
        'SELECT doc FROM somemore.code_redemptions WHERE batch_id = $1 AND code_ref = $2',
        [batchId, codeRef],
      );
      return row === null ? null : row.doc;
    },

    async countForBatch(batchId) {
      const row = await pool.maybeOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM somemore.code_redemptions WHERE batch_id = $1',
        [batchId],
      );
      return row?.n ?? 0;
    },

    async countForAccountAndBatch(accountId, batchId) {
      const row = await pool.maybeOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM somemore.code_redemptions WHERE account_id = $1 AND batch_id = $2',
        [accountId, batchId],
      );
      return row?.n ?? 0;
    },

    async countForBatchSince(batchId, sinceIso) {
      const row = await pool.maybeOne<{ n: number }>(
        'SELECT count(*)::int AS n FROM somemore.code_redemptions WHERE batch_id = $1 AND redeemed_at >= $2::timestamptz',
        [batchId, sinceIso],
      );
      return row?.n ?? 0;
    },

    async listByAccount(accountId) {
      const rows = await pool.many<{ doc: CodeRedemption }>(
        'SELECT doc FROM somemore.code_redemptions WHERE account_id = $1 ORDER BY redeemed_at DESC, seq DESC',
        [accountId],
      );
      return rows.map((row) => row.doc);
    },

    /**
     * Merge support. `per_account_key` moves with the account, and the
     * one-per-account index can legitimately refuse: two accounts that each
     * redeemed a code from the same run cannot both keep it once they are one
     * account. Rather than fail the merge, the absorbed row keeps its own code
     * but drops out of the per-account rule — the redemption really did happen
     * twice, on two accounts, before they were joined.
     */
    async reassignAccount(fromAccountId, toAccountId) {
      const result = await pool.query(
        `UPDATE somemore.code_redemptions
            SET account_id = $2,
                per_account_key = NULL,
                doc = jsonb_set(doc, '{accountId}', to_jsonb($2::text), true)
          WHERE account_id = $1`,
        [fromAccountId, toAccountId],
      );
      return result.rowCount;
    },
  };
}
