import {
  DEFAULT_LANDMARK_PROMOTION_RULE,
  TRACE_SWEEP_THRESHOLD,
  decayedIntensity,
  type CreateTraceRequest,
  type Landmark,
  type PromoteLandmarkRequest,
  type WorldState,
  type WorldTrace,
} from '@somemore/protocol';
import { ApiError, conflict, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { CampsiteService } from './campsites.js';
import type { PassportService } from './passport.js';
import type { DomainDeps } from './types.js';

/**
 * Persistent world traces and their promotion into landmarks.
 *
 * A trace is a mark a player left: ash, a carving, a scorch on a stone. Traces
 * decay exponentially and are swept away below a threshold. A trace that enough
 * *distinct* players witness before it fades can be promoted to a Landmark,
 * which stops decaying and gets a name — that is how a campsite accumulates
 * history instead of clutter.
 */
export interface WorldStateService {
  addTrace(accountId: string, campsiteId: string, request: CreateTraceRequest): Promise<WorldTrace>;
  read(accountId: string, campsiteId: string): Promise<WorldState>;
  witness(accountId: string, campsiteId: string, traceId: string): Promise<WorldTrace>;
  promote(
    accountId: string,
    campsiteId: string,
    traceId: string,
    request: PromoteLandmarkRequest,
  ): Promise<Landmark>;
}

export function createWorldStateService(
  deps: DomainDeps,
  campsites: CampsiteService,
  passports: PassportService,
): WorldStateService {
  const { repos, clock, ids, logger } = deps;

  function currentIntensity(trace: WorldTrace, nowMs: number): number {
    return decayedIntensity(trace.intensity, trace.decayRatePerHour, nowMs - Date.parse(trace.lastDecayedAt));
  }

  return {
    async addTrace(accountId, campsiteId, request) {
      await campsites.requireMember(accountId, campsiteId, 'guest');
      const now = clock.isoNow();
      const trace: WorldTrace = {
        id: ids.next(ID_PREFIX.trace),
        campsiteId,
        kind: request.kind,
        position: request.position,
        rotationY: request.rotationY,
        scale: request.scale,
        createdBy: accountId,
        createdAt: now,
        intensity: request.intensity,
        decayRatePerHour: request.decayRatePerHour,
        lastDecayedAt: now,
        witnessAccountIds: [accountId],
        text: request.text ?? null,
        promotedLandmarkId: null,
      };
      return repos.traces.create(trace);
    },

    /**
     * Read model: applies decay, sweeps anything that has faded past the
     * threshold, and returns the surviving traces plus the landmarks.
     */
    async read(accountId, campsiteId) {
      await campsites.requireMember(accountId, campsiteId);
      const nowMs = clock.now().getTime();
      const [traces, landmarks] = await Promise.all([
        repos.traces.listByCampsite(campsiteId),
        repos.landmarks.listByCampsite(campsiteId),
      ]);

      const live: Array<WorldTrace & { currentIntensity: number }> = [];
      const swept: string[] = [];
      for (const trace of traces) {
        const intensity = currentIntensity(trace, nowMs);
        if (intensity < TRACE_SWEEP_THRESHOLD && trace.promotedLandmarkId === null) {
          await repos.traces.delete(trace.id);
          swept.push(trace.id);
          continue;
        }
        live.push({ ...trace, currentIntensity: Number(intensity.toFixed(6)) });
      }

      return {
        campsiteId,
        observedAt: clock.isoNow(),
        traces: live,
        landmarks,
        sweptTraceIds: swept,
      };
    },

    async witness(accountId, campsiteId, traceId) {
      await campsites.requireMember(accountId, campsiteId, 'guest');
      const trace = await repos.traces.get(traceId);
      if (trace === null || trace.campsiteId !== campsiteId) throw notFound('No such trace.');
      if (trace.witnessAccountIds.includes(accountId)) return trace;
      return repos.traces.update(traceId, (t) => ({
        ...t,
        witnessAccountIds: [...t.witnessAccountIds, accountId].slice(-64),
        // Being noticed keeps a trace alive a little longer.
        intensity: Math.min(1, currentIntensity(t, clock.now().getTime()) + 0.05),
        lastDecayedAt: clock.isoNow(),
      }));
    },

    async promote(accountId, campsiteId, traceId, request) {
      const campsite = await campsites.requireMember(accountId, campsiteId, 'cohost');
      const trace = await repos.traces.get(traceId);
      if (trace === null || trace.campsiteId !== campsiteId) throw notFound('No such trace.');
      if (trace.promotedLandmarkId !== null) {
        throw conflict('That trace is already a landmark.', { landmarkId: trace.promotedLandmarkId });
      }

      const rule = campsite.promotionRule ?? DEFAULT_LANDMARK_PROMOTION_RULE;
      const nowMs = clock.now().getTime();
      const intensity = currentIntensity(trace, nowMs);
      const ageMinutes = (nowMs - Date.parse(trace.createdAt)) / 60_000;
      const witnesses = new Set(trace.witnessAccountIds).size;
      const existing = await repos.landmarks.listByCampsite(campsiteId);

      const unmet: string[] = [];
      if (intensity < rule.minIntensity) unmet.push(`intensity ${intensity.toFixed(2)} < ${rule.minIntensity}`);
      if (witnesses < rule.minDistinctWitnesses) {
        unmet.push(`witnesses ${witnesses} < ${rule.minDistinctWitnesses}`);
      }
      if (ageMinutes < rule.minAgeMinutes) unmet.push(`age ${ageMinutes.toFixed(1)}m < ${rule.minAgeMinutes}m`);
      if (existing.length >= rule.maxLandmarksPerCampsite) unmet.push('campsite landmark limit reached');
      if (unmet.length > 0) {
        throw new ApiError('precondition_failed', 'This trace has not earned landmark status yet.', {
          details: { unmet, rule },
        });
      }

      const now = clock.isoNow();
      const landmark = await repos.landmarks.create({
        id: ids.next(ID_PREFIX.landmark),
        campsiteId,
        originTraceId: trace.id,
        name: request.name,
        kind: trace.kind,
        position: trace.position,
        promotedAt: now,
        promotedBy: accountId,
        permanence: request.permanence,
        citations: witnesses,
        description: request.description,
      });
      await repos.traces.update(trace.id, (t) => ({
        ...t,
        promotedLandmarkId: landmark.id,
        decayRatePerHour: 0,
        intensity: Math.max(intensity, 0.6),
        lastDecayedAt: now,
      }));
      await repos.campsites.update(campsiteId, (c) => ({
        ...c,
        landmarks: [...c.landmarks, landmark],
        updatedAt: now,
        revision: c.revision + 1,
      }));
      await passports.addDiscovery(accountId, {
        code: `landmark_${landmark.kind}`,
        kind: 'landmark',
        name: landmark.name,
        discoveredAt: now,
        campsiteId,
        firstFinder: existing.length === 0,
      });
      logger.info('worldstate.landmark_promoted', { campsiteId, landmarkId: landmark.id, witnesses });
      return landmark;
    },
  };
}
