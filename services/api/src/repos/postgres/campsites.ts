import type { Campsite, CampsiteInvite } from '@somemore/protocol';
import type { PgPool } from '../../db/wire/index.js';
import type { CampsiteRepository, InviteRepository } from '../interfaces.js';
import { DocTable } from './support.js';

/** Backs `campsites`, its member list and the embedded SM-01. */
export function createPostgresCampsiteRepository(pool: PgPool): CampsiteRepository {
  const table = new DocTable<Campsite>(pool, {
    table: 'campsites',
    entityName: 'campsite',
    primaryKey: ['id'],
    keyOf: (c) => [c.id],
    project: (c) => ({
      owner_account_id: c.ownerAccountId,
      camp_code: c.campCode,
      privacy: c.privacy,
      created_at: c.createdAt,
      last_active_at: c.lastActiveAt,
    }),
  });

  return {
    async create(campsite) {
      return table.insert(campsite);
    },

    async get(campsiteId) {
      return table.find([campsiteId]);
    },

    async update(campsiteId, mutate) {
      return table.mutate([campsiteId], mutate);
    },

    async findByCampCode(campCode) {
      return table.first('camp_code = $1', [campCode]);
    },

    /**
     * Membership is part of the campsite aggregate, so this is a jsonb
     * containment query against `campsites_members_idx` rather than a join —
     * `@>` matches a member object with this account id that is not banned.
     */
    async listByMember(accountId) {
      return table.list(
        "doc -> 'members' @> $1::jsonb",
        [JSON.stringify([{ accountId, banned: false }])],
        'seq',
      );
    },

    async listByOwner(accountId) {
      return table.list('owner_account_id = $1', [accountId], 'seq');
    },

    /**
     * Merge support. Both ownership and membership move, the surviving account
     * keeps the strongest of the two roles, and a duplicate membership row
     * collapses into one — exactly what the in-memory implementation does, but
     * inside a transaction so a half-merged campsite is not observable.
     */
    async reassignAccount(fromAccountId, toAccountId) {
      return pool.transaction(async (tx) => {
        const rows = await tx.many<{ doc: Campsite }>(
          `SELECT doc FROM somemore.campsites
            WHERE owner_account_id = $1 OR doc -> 'members' @> $2::jsonb
            ORDER BY id
              FOR UPDATE`,
          [fromAccountId, JSON.stringify([{ accountId: fromAccountId }])],
        );

        let moved = 0;
        for (const { doc: campsite } of rows) {
          const ownsIt = campsite.ownerAccountId === fromAccountId;
          const memberIndex = campsite.members.findIndex((m) => m.accountId === fromAccountId);
          if (!ownsIt && memberIndex === -1) continue;

          const alreadyThere = campsite.members.some((m) => m.accountId === toAccountId);
          const members = campsite.members
            .filter((m) => !(alreadyThere && m.accountId === fromAccountId))
            .map((m) => (m.accountId === fromAccountId ? { ...m, accountId: toAccountId } : m));
          if (ownsIt) {
            for (const member of members) {
              if (member.accountId === toAccountId) member.role = 'owner';
            }
          }
          const next: Campsite = {
            ...campsite,
            ownerAccountId: ownsIt ? toAccountId : campsite.ownerAccountId,
            members,
          };
          await tx.query(
            `UPDATE somemore.campsites SET owner_account_id = $2, doc = $3::jsonb WHERE id = $1`,
            [next.id, next.ownerAccountId, next],
          );
          moved += 1;
        }
        return moved;
      });
    },
  };
}

/** Backs `campsite_invites`. */
export function createPostgresInviteRepository(pool: PgPool): InviteRepository {
  const table = new DocTable<CampsiteInvite>(pool, {
    table: 'campsite_invites',
    entityName: 'invite',
    primaryKey: ['id'],
    keyOf: (i) => [i.id],
    project: (i) => ({
      campsite_id: i.campsiteId,
      token: i.token,
      camp_code: i.campCode,
      created_at: i.createdAt,
      expires_at: i.expiresAt,
      revoked_at: i.revokedAt,
    }),
  });

  return {
    async create(invite) {
      return table.insert(invite);
    },
    async get(inviteId) {
      return table.find([inviteId]);
    },
    async findByToken(token) {
      return table.first('token = $1', [token]);
    },
    async findByCampCode(campCode) {
      return table.first('camp_code = $1 AND revoked_at IS NULL', [campCode], 'seq');
    },
    async listByCampsite(campsiteId) {
      return table.list('campsite_id = $1', [campsiteId], 'seq');
    },
    async update(inviteId, mutate) {
      return table.mutate([inviteId], mutate);
    },
  };
}
