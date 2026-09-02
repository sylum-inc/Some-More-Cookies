import {
  SCHEMA_VERSION,
  rarityForScore,
  scoreSandwich,
  type CreateSandwichRequest,
  type MachineQuirk,
  type SandwichRecord,
  type UpdateSandwichRequest,
} from '@somemore/protocol';
import { badRequest, forbidden, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { CampsiteService } from './campsites.js';
import type { PassportService } from './passport.js';
import type { RewardsService } from './rewards.js';
import type { DomainDeps } from './types.js';

/**
 * The sandwich record is the canonical artefact of the whole experience: the
 * roast, the assembly and the machine run that produced one roasted-marshmallow
 * ice cream sandwich, kept forever in the passport.
 *
 * The client simulates; the server judges. `overallScore` and `rarity` are
 * always recomputed here from the submitted telemetry — a client cannot claim a
 * legendary sandwich by asking for one.
 */
export interface SandwichService {
  create(accountId: string, request: CreateSandwichRequest): Promise<SandwichRecord>;
  get(accountId: string, sandwichId: string): Promise<SandwichRecord>;
  listMine(accountId: string): Promise<SandwichRecord[]>;
  update(accountId: string, sandwichId: string, request: UpdateSandwichRequest): Promise<SandwichRecord>;
}

const WEAR_COMPONENTS = ['drum', 'press', 'chiller', 'dispenser', 'hopper', 'belt'] as const;

export function createSandwichService(
  deps: DomainDeps,
  campsites: CampsiteService,
  passports: PassportService,
  rewards: RewardsService,
): SandwichService {
  const { repos, clock, ids, logger } = deps;

  return {
    async create(accountId, request) {
      const campsite = await campsites.requireMember(accountId, request.campsiteId, 'guest');
      if (request.machineRun.machineSerial !== campsite.machine.serialNumber) {
        throw badRequest('That machine run did not happen on this campsite\'s SM-01.', {
          expected: campsite.machine.serialNumber,
          received: request.machineRun.machineSerial,
        });
      }
      if (request.sessionId !== undefined) {
        const session = await repos.sessions.get(request.sessionId);
        if (session === null || session.campsiteId !== campsite.id) throw notFound('No such session.');
      }
      for (const photoId of request.photoIds) {
        const photo = await repos.photos.get(photoId);
        if (photo === null || photo.ownerAccountId !== accountId) throw notFound(`Unknown photo ${photoId}.`);
      }

      const now = clock.isoNow();
      const machineRun = { ...request.machineRun, runId: ids.next(ID_PREFIX.run) };
      const overallScore = scoreSandwich({
        roast: request.roast,
        assembly: request.assembly,
        machineRun,
      });

      const record: SandwichRecord = {
        id: ids.next(ID_PREFIX.sandwich),
        accountId,
        campsiteId: campsite.id,
        sessionId: request.sessionId ?? null,
        createdAt: now,
        updatedAt: now,
        schemaVersion: SCHEMA_VERSION,
        name: request.name ?? null,
        roast: request.roast,
        assembly: request.assembly,
        machineRun,
        overallScore,
        rarity: rarityForScore(overallScore),
        flavorTags: request.flavorTags,
        photoIds: request.photoIds,
        heroPhotoId: request.photoIds[0] ?? null,
        shareState: 'private',
        savedToPassport: true,
        consumedAt: null,
        orderId: null,
      };
      const created = await repos.sandwiches.create(record);

      // The machine wears, counts the cycle, and occasionally picks up a quirk.
      const wear = { ...campsite.machine.wear };
      for (const component of WEAR_COMPONENTS) {
        wear[component] = Math.min(1, Number((wear[component] + machineRun.wearDelta[component]).toFixed(6)));
      }
      const quirk = quirkFor(machineRun.anomalies, now, machineRun.runId);
      const quirks =
        quirk !== null && !campsite.machine.quirks.some((q) => q.code === quirk.code)
          ? [...campsite.machine.quirks, quirk]
          : campsite.machine.quirks;

      await repos.campsites.update(campsite.id, (c) => ({
        ...c,
        machine: {
          ...c.machine,
          wear,
          quirks,
          cyclesRun: c.machine.cyclesRun + 1,
          jamsCleared: c.machine.jamsCleared + (machineRun.outcome === 'jam' ? 1 : 0),
          lastRunAt: now,
        },
        lastActiveAt: now,
        updatedAt: now,
        revision: c.revision + 1,
      }));

      await passports.recordSandwich(accountId, created);
      await rewards.grantGameplayRewards(accountId, created);
      logger.info('sandwich.created', { sandwichId: created.id, score: overallScore, rarity: created.rarity });
      return created;
    },

    async get(accountId, sandwichId) {
      const record = await repos.sandwiches.get(sandwichId);
      if (record === null) throw notFound('No such sandwich.');
      if (record.accountId === accountId) return record;
      if (record.shareState === 'public' || record.shareState === 'link') return record;
      if (record.shareState === 'campsite') {
        const campsite = await repos.campsites.get(record.campsiteId);
        if (campsite !== null && campsite.members.some((m) => m.accountId === accountId && !m.banned)) return record;
      }
      throw forbidden('That sandwich is not shared with you.');
    },

    async listMine(accountId) {
      return repos.sandwiches.listByAccount(accountId);
    },

    async update(accountId, sandwichId, request) {
      const record = await repos.sandwiches.get(sandwichId);
      if (record === null) throw notFound('No such sandwich.');
      if (record.accountId !== accountId) throw forbidden('That is not your sandwich.');
      if (request.heroPhotoId !== undefined && request.heroPhotoId !== null && !record.photoIds.includes(request.heroPhotoId)) {
        throw badRequest('That photo is not attached to this sandwich.');
      }
      const now = clock.isoNow();
      const updated = await repos.sandwiches.update(sandwichId, (s) => ({
        ...s,
        name: request.name === undefined ? s.name : request.name,
        shareState: request.shareState ?? s.shareState,
        heroPhotoId: request.heroPhotoId === undefined ? s.heroPhotoId : request.heroPhotoId,
        savedToPassport: request.savedToPassport ?? s.savedToPassport,
        consumedAt: request.consumed === true ? (s.consumedAt ?? now) : s.consumedAt,
        updatedAt: now,
      }));
      if (request.consumed === true && record.consumedAt === null) {
        await repos.passports.update(accountId, (p) => ({
          ...p,
          stats: { ...p.stats, sandwichesEaten: p.stats.sandwichesEaten + 1 },
          updatedAt: now,
          revision: p.revision + 1,
        }));
      }
      return updated;
    },
  };
}

/** Machines earn their personality from what goes wrong inside them. */
function quirkFor(
  anomalies: readonly string[],
  now: string,
  runId: string,
): MachineQuirk | null {
  if (anomalies.includes('chill_overshoot')) {
    return {
      code: 'frost_whisper',
      name: 'Frost Whisper',
      description: 'Runs a touch colder than it should, and hums about it.',
      severity: 'charming',
      acquiredAt: now,
      acquiredFromRunId: runId,
      effects: { chillBiasSeconds: 4, pressBiasN: 0, jamChanceDelta: 0, flavorTag: 'extra_set' },
    };
  }
  if (anomalies.includes('belt_stall')) {
    return {
      code: 'sticky_belt',
      name: 'Sticky Belt',
      description: 'Hesitates on the hand-off. Needs a nudge.',
      severity: 'minor',
      acquiredAt: now,
      acquiredFromRunId: runId,
      effects: { chillBiasSeconds: 0, pressBiasN: 0, jamChanceDelta: 0.05, flavorTag: null },
    };
  }
  if (anomalies.includes('press_slip')) {
    return {
      code: 'lazy_press',
      name: 'Lazy Press',
      description: 'Leans on the sandwich a little less than the spec says.',
      severity: 'minor',
      acquiredAt: now,
      acquiredFromRunId: runId,
      effects: { chillBiasSeconds: 0, pressBiasN: -25, jamChanceDelta: 0, flavorTag: null },
    };
  }
  return null;
}
