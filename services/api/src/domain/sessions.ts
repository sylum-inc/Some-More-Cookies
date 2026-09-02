import {
  authorityHandoffDenial,
  canTransitionSession,
  type AuthorityHandoffRequest,
  type AuthorityHandoffResult,
  type AuthorityRecord,
  type CreateSessionRequest,
  type HeartbeatRequest,
  type MemberRole,
  type Presence,
  type Session,
  type SessionState,
} from '@somemore/protocol';
import { conflict, forbidden, illegalTransition, notFound } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { CampsiteService } from './campsites.js';
import type { DomainDeps } from './types.js';

/**
 * Live sessions at a campsite: who is present, and who currently owns each
 * shared object.
 *
 * Authority is a server-arbitrated lease with a fencing sequence, so two
 * clients grabbing the same marshmallow in the same frame resolve
 * deterministically instead of both thinking they won.
 */
export interface SessionService {
  create(accountId: string, campsiteId: string, request: CreateSessionRequest): Promise<Session>;
  get(accountId: string, sessionId: string): Promise<Session>;
  join(accountId: string, sessionId: string): Promise<Session>;
  leave(accountId: string, sessionId: string): Promise<Session>;
  heartbeat(accountId: string, sessionId: string, request: HeartbeatRequest): Promise<Presence>;
  transition(accountId: string, sessionId: string, to: SessionState): Promise<Session>;
  listAuthority(accountId: string, sessionId: string): Promise<AuthorityRecord[]>;
  handoff(accountId: string, sessionId: string, request: AuthorityHandoffRequest): Promise<AuthorityHandoffResult>;
}

export function createSessionService(deps: DomainDeps, campsites: CampsiteService): SessionService {
  const { repos, clock, ids, logger } = deps;

  async function load(sessionId: string): Promise<Session> {
    const session = await repos.sessions.get(sessionId);
    if (session === null) throw notFound('No such session.');
    return session;
  }

  async function requireVisible(accountId: string, sessionId: string): Promise<{ session: Session; role: MemberRole }> {
    const session = await load(sessionId);
    const campsite = await campsites.requireMember(accountId, session.campsiteId);
    const member = campsite.members.find((m) => m.accountId === accountId);
    return { session, role: member?.role ?? 'viewer' };
  }

  return {
    async create(accountId, campsiteId, request) {
      await campsites.requireMember(accountId, campsiteId, 'cohost');
      const open = await repos.sessions.findActiveByCampsite(campsiteId);
      if (open !== null) {
        throw conflict('This campsite already has a live session.', { sessionId: open.id });
      }
      const now = clock.isoNow();
      const session: Session = {
        id: ids.next(ID_PREFIX.session),
        campsiteId,
        hostAccountId: accountId,
        state: 'lobby',
        startedAt: now,
        endedAt: null,
        maxMembers: request.maxMembers,
        presence: [],
        authorityEpoch: 0,
      };
      const created = await repos.sessions.create(session);
      logger.info('session.created', { sessionId: created.id, campsiteId });
      return created;
    },

    async get(accountId, sessionId) {
      const { session } = await requireVisible(accountId, sessionId);
      return session;
    },

    async join(accountId, sessionId) {
      const { session, role } = await requireVisible(accountId, sessionId);
      if (session.state === 'ended' || session.state === 'ending') {
        throw conflict('That session has ended.');
      }
      const now = clock.isoNow();
      const already = session.presence.find((p) => p.accountId === accountId);
      if (already === undefined && session.presence.filter((p) => p.connection !== 'disconnected').length >= session.maxMembers) {
        throw conflict('That campfire is full.', { maxMembers: session.maxMembers });
      }

      return repos.sessions.update(sessionId, (s) => {
        const presence: Presence = already ?? {
          accountId,
          sessionId,
          connection: 'connected',
          joinedAt: now,
          lastHeartbeatAt: now,
          role,
          position: null,
          facingY: 0,
          activity: 'idle',
          micMuted: true,
        };
        const next = { ...presence, connection: 'connected' as const, lastHeartbeatAt: now, role };
        return {
          ...s,
          state: s.state === 'lobby' ? 'active' : s.state,
          presence: [...s.presence.filter((p) => p.accountId !== accountId), next],
        };
      });
    },

    async leave(accountId, sessionId) {
      const { session } = await requireVisible(accountId, sessionId);
      const now = clock.isoNow();
      // Dropping out releases everything you were holding, immediately.
      await repos.authority.releaseAllHeldBy(sessionId, accountId, now);
      const updated = await repos.sessions.update(sessionId, (s) => ({
        ...s,
        presence: s.presence.map((p) =>
          p.accountId === accountId ? { ...p, connection: 'disconnected' as const, lastHeartbeatAt: now } : p,
        ),
        authorityEpoch: s.authorityEpoch + 1,
      }));
      const stillHere = updated.presence.some((p) => p.connection !== 'disconnected');
      if (!stillHere && session.state !== 'ended') {
        return repos.sessions.update(sessionId, (s) => ({ ...s, state: 'ended', endedAt: now }));
      }
      return updated;
    },

    async heartbeat(accountId, sessionId, request) {
      const { session } = await requireVisible(accountId, sessionId);
      const present = session.presence.find((p) => p.accountId === accountId);
      if (present === undefined) throw forbidden('You are not in that session.');
      const now = clock.isoNow();
      const updated = await repos.sessions.update(sessionId, (s) => ({
        ...s,
        presence: s.presence.map((p) =>
          p.accountId === accountId
            ? {
                ...p,
                connection: request.connection,
                lastHeartbeatAt: now,
                position: request.position ?? p.position,
                facingY: request.facingY ?? p.facingY,
                activity: request.activity ?? p.activity,
                micMuted: request.micMuted ?? p.micMuted,
              }
            : p,
        ),
      }));
      const mine = updated.presence.find((p) => p.accountId === accountId);
      if (mine === undefined) throw notFound('Presence disappeared.');
      return mine;
    },

    async transition(accountId, sessionId, to) {
      const session = await load(sessionId);
      if (session.hostAccountId !== accountId) {
        await campsites.requireMember(accountId, session.campsiteId, 'cohost');
      }
      if (!canTransitionSession(session.state, to)) {
        throw illegalTransition(`A session cannot go from ${session.state} to ${to}.`, {
          from: session.state,
          to,
        });
      }
      const now = clock.isoNow();
      return repos.sessions.update(sessionId, (s) => ({
        ...s,
        state: to,
        endedAt: to === 'ended' ? now : s.endedAt,
      }));
    },

    async listAuthority(accountId, sessionId) {
      await requireVisible(accountId, sessionId);
      return repos.authority.listBySession(sessionId);
    },

    /**
     * Authority hand-off. The legality rules live in the protocol so the client
     * can predict the outcome; the server is the only thing that can actually
     * change the record, and it bumps the fencing sequence every time.
     */
    async handoff(accountId, sessionId, request) {
      const { session } = await requireVisible(accountId, sessionId);
      const campsite = await campsites.requireMember(accountId, session.campsiteId);
      const now = clock.isoNow();

      const current: AuthorityRecord = (await repos.authority.get(sessionId, request.objectId)) ?? {
        sessionId,
        objectId: request.objectId,
        objectKind: request.objectKind,
        holderAccountId: null,
        grantedAt: now,
        expiresAt: null,
        sequence: 0,
        locked: false,
      };

      const isMember = campsite.members.some((m) => m.accountId === accountId && !m.banned);
      const isHost = session.hostAccountId === accountId;
      const targetPresent =
        request.toAccountId === null ||
        session.presence.some((p) => p.accountId === request.toAccountId && p.connection !== 'disconnected');

      const denial = authorityHandoffDenial({
        record: current,
        requesterAccountId: accountId,
        request: {
          expectedSequence: request.expectedSequence,
          reason: request.reason,
          toAccountId: request.toAccountId,
        },
        requesterIsHost: isHost,
        requesterIsMember: isMember,
        targetIsPresent: targetPresent,
        sessionState: session.state,
      });

      if (denial !== null) {
        logger.debug('session.authority_denied', { sessionId, objectId: request.objectId, reason: denial });
        return { status: 'denied', reason: denial, current };
      }

      const granted: AuthorityRecord = {
        ...current,
        objectKind: request.objectKind,
        holderAccountId: request.toAccountId,
        grantedAt: now,
        expiresAt:
          request.toAccountId === null
            ? null
            : new Date(clock.now().getTime() + request.leaseSeconds * 1000).toISOString(),
        sequence: current.sequence + 1,
        locked: request.objectKind === 'sm01' ? current.locked : false,
      };
      const stored = await repos.authority.put(granted);
      await repos.sessions.update(sessionId, (s) => ({ ...s, authorityEpoch: s.authorityEpoch + 1 }));
      return { status: 'granted', record: stored };
    },
  };
}
