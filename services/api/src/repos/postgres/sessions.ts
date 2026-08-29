import type { AuthorityRecord, Session } from '@somemore/protocol';
import { ApiError } from '../../errors.js';
import { PgError, UNIQUE_VIOLATION, type PgPool } from '../../db/wire/index.js';
import type { AuthorityRepository, SessionRepository } from '../interfaces.js';
import { DocTable } from './support.js';

function liveSessionConflict(campsiteId: string, cause: unknown): ApiError {
  return new ApiError('conflict', 'This campsite already has a live session.', {
    details: { campsiteId },
    cause,
  });
}

/** Backs `sessions` and the presence list inside each session document. */
export function createPostgresSessionRepository(pool: PgPool): SessionRepository {
  const table = new DocTable<Session>(pool, {
    table: 'sessions',
    entityName: 'session',
    primaryKey: ['id'],
    keyOf: (s) => [s.id],
    project: (s) => ({
      campsite_id: s.campsiteId,
      host_account_id: s.hostAccountId,
      state: s.state,
      started_at: s.startedAt,
    }),
  });

  return {
    async create(session) {
      try {
        return await table.insert(session);
      } catch (error) {
        // `sessions_one_live_per_campsite` fired: someone else opened the fire
        // first. The domain checks for this too; the index is what makes the
        // check true when two hosts press the button in the same millisecond.
        // `DocTable.insert` has already turned the unique violation into a
        // `conflict`; this re-words it in the domain's own terms.
        const constraint =
          error instanceof ApiError &&
          typeof error.details === 'object' &&
          error.details !== null &&
          'constraint' in error.details
            ? error.details.constraint
            : null;
        if (error instanceof PgError && error.code === UNIQUE_VIOLATION) {
          throw liveSessionConflict(session.campsiteId, error);
        }
        if (constraint === 'sessions_one_live_per_campsite') {
          throw liveSessionConflict(session.campsiteId, error);
        }
        throw error;
      }
    },

    async get(sessionId) {
      return table.find([sessionId]);
    },

    async listByCampsite(campsiteId) {
      return table.list('campsite_id = $1', [campsiteId], 'seq');
    },

    async findActiveByCampsite(campsiteId) {
      return table.first("campsite_id = $1 AND state IN ('lobby', 'active')", [campsiteId], 'seq');
    },

    async update(sessionId, mutate) {
      return table.mutate([sessionId], mutate);
    },
  };
}

/**
 * Backs `object_authority`.
 *
 * The fencing `sequence` is a real column, not just a document field, because
 * arbitration between two clients grabbing the same marshmallow has to happen
 * in one statement. `put` therefore locks the row it is replacing.
 */
export function createPostgresAuthorityRepository(pool: PgPool): AuthorityRepository {
  const table = new DocTable<AuthorityRecord>(pool, {
    table: 'object_authority',
    entityName: 'authority record',
    primaryKey: ['session_id', 'object_id'],
    keyOf: (r) => [r.sessionId, r.objectId],
    project: (r) => ({
      holder_account_id: r.holderAccountId,
      sequence: r.sequence,
      granted_at: r.grantedAt,
      expires_at: r.expiresAt,
    }),
  });

  return {
    async get(sessionId, objectId) {
      return table.find([sessionId, objectId]);
    },

    async put(record) {
      return table.put(record);
    },

    async listBySession(sessionId) {
      return table.list('session_id = $1', [sessionId], 'seq');
    },

    /**
     * Release everything a disconnecting player was holding, in one statement,
     * bumping each fencing sequence so a late packet from the departed client
     * is rejected rather than replayed.
     */
    async releaseAllHeldBy(sessionId, accountId, at) {
      const rows = await pool.many<{ doc: AuthorityRecord }>(
        `UPDATE somemore.object_authority
            SET holder_account_id = NULL,
                sequence = sequence + 1,
                granted_at = $3::text::timestamptz,
                expires_at = NULL,
                doc = doc || jsonb_build_object(
                  'holderAccountId', NULL::text,
                  'grantedAt', $3::text,
                  'expiresAt', NULL::text,
                  'sequence', (doc ->> 'sequence')::int + 1
                )
          WHERE session_id = $1 AND holder_account_id = $2
        RETURNING doc`,
        [sessionId, accountId, at],
      );
      return rows.map((row) => row.doc);
    },
  };
}
