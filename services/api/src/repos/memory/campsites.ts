import type { Campsite, CampsiteInvite } from '@somemore/protocol';
import type { CampsiteRepository, InviteRepository } from '../interfaces.js';
import { MemoryTable } from './support.js';

/** Backs `campsites`, `campsite_members` and the embedded `sm01_machines`. */
export function createMemoryCampsiteRepository(): CampsiteRepository {
  const table = new MemoryTable<Campsite>('campsite', (c) => c.id);
  return {
    async create(campsite) {
      return table.insert(campsite);
    },
    async get(campsiteId) {
      return table.find(campsiteId);
    },
    async update(campsiteId, mutate) {
      return table.mutate(campsiteId, mutate);
    },
    async findByCampCode(campCode) {
      return table.first((c) => c.campCode === campCode);
    },
    async listByMember(accountId) {
      return table.filter((c) => c.members.some((m) => m.accountId === accountId && !m.banned));
    },
    async listByOwner(accountId) {
      return table.filter((c) => c.ownerAccountId === accountId);
    },
    async reassignAccount(fromAccountId, toAccountId) {
      let moved = 0;
      for (const campsite of table.all()) {
        const ownsIt = campsite.ownerAccountId === fromAccountId;
        const memberIndex = campsite.members.findIndex((m) => m.accountId === fromAccountId);
        if (!ownsIt && memberIndex === -1) continue;

        const alreadyThere = campsite.members.some((m) => m.accountId === toAccountId);
        const members = campsite.members
          .filter((m) => !(alreadyThere && m.accountId === fromAccountId))
          .map((m) => (m.accountId === fromAccountId ? { ...m, accountId: toAccountId } : m));
        // The surviving account keeps the strongest role of the two.
        if (ownsIt) {
          for (const member of members) {
            if (member.accountId === toAccountId) member.role = 'owner';
          }
        }
        table.put({
          ...campsite,
          ownerAccountId: ownsIt ? toAccountId : campsite.ownerAccountId,
          members,
        });
        moved += 1;
      }
      return moved;
    },
  };
}

/** Backs `campsite_invites`. */
export function createMemoryInviteRepository(): InviteRepository {
  const table = new MemoryTable<CampsiteInvite>('invite', (i) => i.id);
  return {
    async create(invite) {
      return table.insert(invite);
    },
    async get(inviteId) {
      return table.find(inviteId);
    },
    async findByToken(token) {
      return table.first((i) => i.token === token);
    },
    async findByCampCode(campCode) {
      return table.first((i) => i.campCode === campCode && i.revokedAt === null);
    },
    async listByCampsite(campsiteId) {
      return table.filter((i) => i.campsiteId === campsiteId);
    },
    async update(inviteId, mutate) {
      return table.mutate(inviteId, mutate);
    },
  };
}
