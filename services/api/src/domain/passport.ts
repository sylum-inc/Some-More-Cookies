import {
  CampfirePassportSchema,
  PassportSettingsSchema,
  SCHEMA_VERSION,
  type CampfirePassport,
  type Campsite,
  type CreateNoteRequest,
  type Discovery,
  type Note,
  type Patch,
  type PhotoRef,
  type PublicPassport,
  type RegisterPhotoRequest,
  type SandwichRecord,
  type Stamp,
  type TicketStub,
  type UpdatePassportRequest,
} from '@somemore/protocol';
import { conflict, forbidden, notFound, preconditionFailed } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { DomainDeps } from './types.js';

/**
 * The Campfire Passport is the player's durable identity in the world: their
 * stamps, photos, sandwiches, notes, patches, ticket stubs, discoveries, the
 * campsites they have visited and their settings (accessibility included).
 *
 * Everything here is scoped to one account. Cross-account reads go through
 * `getPublicFor`, which is the only place the privacy rules live.
 */
export interface PassportService {
  create(accountId: string, displayName: string): Promise<CampfirePassport>;
  getOwn(accountId: string): Promise<CampfirePassport>;
  update(accountId: string, request: UpdatePassportRequest): Promise<CampfirePassport>;
  getPublicFor(viewerAccountId: string, targetAccountId: string): Promise<PublicPassport>;
  /**
   * `photoId` is supplied when the bytes were uploaded against a ticket that
   * already named the photo — the media path mints the id before the image
   * exists so the client can address it, and re-minting one here would give
   * back a different photo than the one somebody just uploaded to.
   */
  registerPhoto(accountId: string, request: RegisterPhotoRequest, photoId?: string): Promise<PhotoRef>;
  addNote(accountId: string, request: CreateNoteRequest): Promise<Note>;
  deleteNote(accountId: string, noteId: string): Promise<void>;
  addStamp(accountId: string, stamp: Omit<Stamp, 'id'>): Promise<Stamp>;
  addPatch(accountId: string, patch: Omit<Patch, 'id'>): Promise<Patch>;
  addTicketStub(accountId: string, stub: Omit<TicketStub, 'id'>): Promise<TicketStub>;
  addDiscovery(accountId: string, discovery: Omit<Discovery, 'id'>): Promise<Discovery>;
  addPoints(accountId: string, points: number): Promise<void>;
  recordSandwich(accountId: string, sandwich: SandwichRecord): Promise<void>;
  recordVisit(accountId: string, campsite: Campsite): Promise<void>;
}

export function createPassportService(deps: DomainDeps): PassportService {
  const { repos, clock, ids } = deps;

  async function require(accountId: string): Promise<CampfirePassport> {
    const passport = await repos.passports.get(accountId);
    if (passport === null) throw notFound('This account has no Campfire Passport.');
    return passport;
  }

  function touch(passport: CampfirePassport): CampfirePassport {
    return { ...passport, updatedAt: clock.isoNow(), revision: passport.revision + 1 };
  }

  return {
    async create(accountId, displayName) {
      const now = clock.isoNow();
      const passport = CampfirePassportSchema.parse({
        accountId,
        displayName,
        issuedAt: now,
        updatedAt: now,
        revision: 0,
        schemaVersion: SCHEMA_VERSION,
        settings: PassportSettingsSchema.parse({}),
        stats: {},
      });
      return repos.passports.create(passport);
    },

    getOwn: require,

    async update(accountId, request) {
      const current = await require(accountId);
      if (request.expectedRevision !== undefined && request.expectedRevision !== current.revision) {
        throw preconditionFailed('The passport changed since you last read it.', {
          expectedRevision: request.expectedRevision,
          actualRevision: current.revision,
        });
      }
      if (request.handle !== undefined && request.handle !== current.handle) {
        const taken = await repos.passports.findByHandle(request.handle);
        if (taken !== null && taken.accountId !== accountId) {
          throw conflict('That handle is already taken.', { handle: request.handle });
        }
      }
      if (request.avatarPhotoId !== undefined && request.avatarPhotoId !== null) {
        const photo = await repos.photos.get(request.avatarPhotoId);
        if (photo === null || photo.ownerAccountId !== accountId) {
          throw notFound('That photo does not exist on this passport.');
        }
      }

      const settings =
        request.settings === undefined
          ? current.settings
          : PassportSettingsSchema.parse({
              ...current.settings,
              ...request.settings,
              pushNotifications: { ...current.settings.pushNotifications, ...(request.settings.pushNotifications ?? {}) },
              accessibility: { ...current.settings.accessibility, ...(request.settings.accessibility ?? {}) },
            });

      return repos.passports.update(accountId, (p) =>
        touch({
          ...p,
          displayName: request.displayName ?? p.displayName,
          handle: request.handle ?? p.handle,
          bio: request.bio ?? p.bio,
          avatarPhotoId: request.avatarPhotoId === undefined ? p.avatarPhotoId : request.avatarPhotoId,
          settings,
        }),
      );
    },

    /**
     * The only cross-account passport read. A passport is visible when it is
     * your own, when the owner opted into leaderboards, or when you and the
     * owner currently share a campsite. Blocks always win.
     */
    async getPublicFor(viewerAccountId, targetAccountId) {
      const target = await repos.passports.get(targetAccountId);
      if (target === null) throw notFound('No such passport.');

      if (viewerAccountId !== targetAccountId) {
        if (await repos.moderation.isBlocked(targetAccountId, viewerAccountId)) {
          throw notFound('No such passport.');
        }
        const optedIn = target.settings.showOnLeaderboards;
        let sharesCampsite = false;
        if (!optedIn) {
          const mine = await repos.campsites.listByMember(viewerAccountId);
          sharesCampsite = mine.some((c) => c.members.some((m) => m.accountId === targetAccountId && !m.banned));
        }
        if (!optedIn && !sharesCampsite) {
          throw forbidden('That passport is private.');
        }
      }

      return {
        accountId: target.accountId,
        displayName: target.displayName,
        handle: target.handle,
        bio: target.bio,
        avatarPhotoId: target.avatarPhotoId,
        issuedAt: target.issuedAt,
        stamps: target.stamps,
        patches: target.patches,
        stats: {
          sandwichesMade: target.stats.sandwichesMade,
          perfectRoasts: target.stats.perfectRoasts,
          campfireMinutes: target.stats.campfireMinutes,
        },
      };
    },

    async registerPhoto(accountId, request, photoId) {
      await require(accountId);
      if (request.campsiteId !== null && request.campsiteId !== undefined) {
        const campsite = await repos.campsites.get(request.campsiteId);
        if (campsite === null || !campsite.members.some((m) => m.accountId === accountId && !m.banned)) {
          throw forbidden('You are not a member of that campsite.');
        }
      }
      const now = clock.isoNow();
      const photo: PhotoRef = {
        ...request,
        id: photoId ?? ids.next(ID_PREFIX.photo),
        ownerAccountId: accountId,
        createdAt: now,
      };
      const stored = await repos.photos.create(photo);
      await repos.passports.update(accountId, (p) =>
        touch({ ...p, photos: [...p.photos, stored], stats: { ...p.stats, photosTaken: p.stats.photosTaken + 1 } }),
      );
      return stored;
    },

    async addNote(accountId, request) {
      const now = clock.isoNow();
      const note: Note = {
        id: ids.next(ID_PREFIX.note),
        body: request.body,
        createdAt: now,
        updatedAt: now,
        pinned: request.pinned,
        campsiteId: request.campsiteId ?? null,
        sandwichId: request.sandwichId ?? null,
      };
      await repos.passports.update(accountId, (p) => touch({ ...p, notes: [...p.notes, note] }));
      return note;
    },

    async deleteNote(accountId, noteId) {
      const current = await require(accountId);
      if (!current.notes.some((n) => n.id === noteId)) throw notFound('No such note.');
      await repos.passports.update(accountId, (p) => touch({ ...p, notes: p.notes.filter((n) => n.id !== noteId) }));
    },

    async addStamp(accountId, stamp) {
      const existing = (await require(accountId)).stamps.find((s) => s.code === stamp.code);
      if (existing !== undefined) {
        const bumped: Stamp = { ...existing, count: existing.count + 1, earnedAt: stamp.earnedAt };
        await repos.passports.update(accountId, (p) =>
          touch({ ...p, stamps: p.stamps.map((s) => (s.id === existing.id ? bumped : s)) }),
        );
        return bumped;
      }
      const created: Stamp = { ...stamp, id: ids.next(ID_PREFIX.stamp) };
      await repos.passports.update(accountId, (p) => touch({ ...p, stamps: [...p.stamps, created] }));
      return created;
    },

    async addPatch(accountId, patch) {
      const created: Patch = { ...patch, id: ids.next(ID_PREFIX.patch) };
      await repos.passports.update(accountId, (p) => touch({ ...p, patches: [...p.patches, created] }));
      return created;
    },

    async addTicketStub(accountId, stub) {
      const created: TicketStub = { ...stub, id: ids.next(ID_PREFIX.ticket) };
      await repos.passports.update(accountId, (p) => touch({ ...p, ticketStubs: [...p.ticketStubs, created] }));
      return created;
    },

    async addDiscovery(accountId, discovery) {
      const current = await require(accountId);
      const already = current.discoveries.find((d) => d.code === discovery.code);
      if (already !== undefined) return already;
      const created: Discovery = { ...discovery, id: ids.next(ID_PREFIX.discovery) };
      await repos.passports.update(accountId, (p) => touch({ ...p, discoveries: [...p.discoveries, created] }));
      return created;
    },

    async addPoints(accountId, points) {
      if (points === 0) return;
      await repos.passports.update(accountId, (p) =>
        touch({ ...p, stats: { ...p.stats, points: Math.max(0, p.stats.points + points) } }),
      );
    },

    async recordSandwich(accountId, sandwich) {
      await repos.passports.update(accountId, (p) =>
        touch({
          ...p,
          sandwichIds: p.sandwichIds.includes(sandwich.id) ? p.sandwichIds : [...p.sandwichIds, sandwich.id],
          stats: {
            ...p.stats,
            marshmallowsRoasted: p.stats.marshmallowsRoasted + 1,
            marshmallowsIgnited: p.stats.marshmallowsIgnited + (sandwich.roast.ignited ? 1 : 0),
            sandwichesMade: p.stats.sandwichesMade + 1,
            perfectRoasts: p.stats.perfectRoasts + (sandwich.roast.grade === 'golden' && sandwich.roast.evenness >= 0.9 ? 1 : 0),
            machineRuns: p.stats.machineRuns + 1,
          },
        }),
      );
    },

    async recordVisit(accountId, campsite) {
      const now = clock.isoNow();
      await repos.passports.update(accountId, (p) => {
        const existing = p.visitedCampsites.find((v) => v.campsiteId === campsite.id);
        const visited = existing === undefined
          ? [
              ...p.visitedCampsites,
              {
                campsiteId: campsite.id,
                environmentId: campsite.environmentId,
                firstVisitedAt: now,
                lastVisitedAt: now,
                visitCount: 1,
                nickname: null,
              },
            ]
          : p.visitedCampsites.map((v) =>
              v.campsiteId === campsite.id ? { ...v, lastVisitedAt: now, visitCount: v.visitCount + 1 } : v,
            );
        return touch({ ...p, visitedCampsites: visited });
      });
    },
  };
}

/** Shared by the merge path in the identity module. */
export function mergePassportCollections(
  surviving: CampfirePassport,
  absorbed: CampfirePassport,
  mergedAt: string,
): { passport: CampfirePassport; moved: Record<string, number> } {
  const stampByCode = new Map(surviving.stamps.map((s) => [s.code, s]));
  let movedStamps = 0;
  for (const stamp of absorbed.stamps) {
    const existing = stampByCode.get(stamp.code);
    if (existing === undefined) stampByCode.set(stamp.code, stamp);
    else stampByCode.set(stamp.code, { ...existing, count: existing.count + stamp.count });
    movedStamps += 1;
  }

  const discoveryCodes = new Set(surviving.discoveries.map((d) => d.code));
  const discoveries = [...surviving.discoveries];
  let movedDiscoveries = 0;
  for (const discovery of absorbed.discoveries) {
    if (discoveryCodes.has(discovery.code)) continue;
    discoveryCodes.add(discovery.code);
    discoveries.push(discovery);
    movedDiscoveries += 1;
  }

  const visitedById = new Map(surviving.visitedCampsites.map((v) => [v.campsiteId, v]));
  let movedVisits = 0;
  for (const visit of absorbed.visitedCampsites) {
    const existing = visitedById.get(visit.campsiteId);
    if (existing === undefined) visitedById.set(visit.campsiteId, visit);
    else {
      visitedById.set(visit.campsiteId, {
        ...existing,
        firstVisitedAt: existing.firstVisitedAt < visit.firstVisitedAt ? existing.firstVisitedAt : visit.firstVisitedAt,
        lastVisitedAt: existing.lastVisitedAt > visit.lastVisitedAt ? existing.lastVisitedAt : visit.lastVisitedAt,
        visitCount: existing.visitCount + visit.visitCount,
      });
    }
    movedVisits += 1;
  }

  const sandwichIds = [...new Set([...surviving.sandwichIds, ...absorbed.sandwichIds])];

  const passport: CampfirePassport = {
    ...surviving,
    updatedAt: mergedAt,
    revision: surviving.revision + 1,
    stamps: [...stampByCode.values()],
    photos: [...surviving.photos, ...absorbed.photos.map((p) => ({ ...p, ownerAccountId: surviving.accountId }))],
    sandwichIds,
    notes: [...surviving.notes, ...absorbed.notes],
    patches: [...surviving.patches, ...absorbed.patches],
    ticketStubs: [...surviving.ticketStubs, ...absorbed.ticketStubs],
    discoveries,
    visitedCampsites: [...visitedById.values()],
    stats: {
      marshmallowsRoasted: surviving.stats.marshmallowsRoasted + absorbed.stats.marshmallowsRoasted,
      marshmallowsIgnited: surviving.stats.marshmallowsIgnited + absorbed.stats.marshmallowsIgnited,
      sandwichesMade: surviving.stats.sandwichesMade + absorbed.stats.sandwichesMade,
      sandwichesEaten: surviving.stats.sandwichesEaten + absorbed.stats.sandwichesEaten,
      perfectRoasts: surviving.stats.perfectRoasts + absorbed.stats.perfectRoasts,
      machineRuns: surviving.stats.machineRuns + absorbed.stats.machineRuns,
      photosTaken: surviving.stats.photosTaken + absorbed.stats.photosTaken,
      campfireMinutes: surviving.stats.campfireMinutes + absorbed.stats.campfireMinutes,
      points: surviving.stats.points + absorbed.stats.points,
    },
  };

  return {
    passport,
    moved: {
      stamps: movedStamps,
      photos: absorbed.photos.length,
      notes: absorbed.notes.length,
      patches: absorbed.patches.length,
      ticketStubs: absorbed.ticketStubs.length,
      discoveries: movedDiscoveries,
      visitedCampsites: movedVisits,
    },
  };
}
