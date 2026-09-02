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

    /**
     * Fenced write. The row only moves forward: a record whose `sequence` is
     * not strictly greater than the stored one is refused.
     *
     * This is the difference between the in-memory and the durable version.
     * In memory, two clients grabbing the same marshmallow read the same
     * `sequence`, both compute `sequence + 1`, and the second write silently
     * overwrites the first — both clients believe they hold the object. Here
     * the loser's write matches no row, and it is told so; the fencing token
     * stops being decorative and starts arbitrating.
     */
    async put(record) {
      const row = await pool.maybeOne<{ doc: AuthorityRecord }>(
        `INSERT INTO somemore.object_authority
           (session_id, object_id, holder_account_id, sequence, granted_at, expires_at, doc)
         VALUES ($1, $2, $3, $4::int, $5::text::timestamptz, $6::text::timestamptz, $7::jsonb)
         ON CONFLICT (session_id, object_id) DO UPDATE
            SET holder_account_id = EXCLUDED.holder_account_id,
                sequence          = EXCLUDED.sequence,
                granted_at        = EXCLUDED.granted_at,
                expires_at        = EXCLUDED.expires_at,
                doc               = EXCLUDED.doc
          WHERE object_authority.sequence < EXCLUDED.sequence
        RETURNING doc`,
        [
          record.sessionId,
          record.objectId,
          record.holderAccountId,
          record.sequence,
          record.grantedAt,
          record.expiresAt,
          record,
        ],
      );
      if (row === null) {
        const current = await table.find([record.sessionId, record.objectId]);
        throw new ApiError('conflict', 'Authority for that object has already moved on.', {
          details: {
            objectId: record.objectId,
            expectedSequence: record.sequence - 1,
            currentSequence: current?.sequence ?? null,
          },
        });
      }
      return row.doc;
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
