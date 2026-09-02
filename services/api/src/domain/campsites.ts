import {
  CampsiteSchema,
  QR_JOIN_PREFIX,
  SCHEMA_VERSION,
  codeToUri,
  parseQrJoinPayload,
  parseSomeMoreCode,
  roleAtLeast,
  type Campsite,
  type CampsiteInvite,
  type CampsiteSummary,
  type CreateCampsiteRequest,
  type CreateInviteRequest,
  type JoinCampsiteRequest,
  type MaintenanceEvent,
  type MemberRole,
  type RecordMaintenanceRequest,
  type SM01,
  type UpdateCampsiteRequest,
} from '@somemore/protocol';
import { ApiError, forbidden, notFound, preconditionFailed } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import type { CodeSigner } from '../codes/signing.js';
import type { PassportService } from './passport.js';
import type { DomainDeps } from './types.js';

/**
 * Campsites: the persistent place a player's fire lives. Every campsite is
 * private by default, owns exactly one serialized SM-01, and accumulates world
 * traces that decay (see worldState.ts).
 */
export interface CampsiteService {
  create(accountId: string, request: CreateCampsiteRequest): Promise<Campsite>;
  get(accountId: string, campsiteId: string): Promise<Campsite>;
  update(accountId: string, campsiteId: string, request: UpdateCampsiteRequest): Promise<Campsite>;
  listForAccount(accountId: string): Promise<CampsiteSummary[]>;
  createInvite(accountId: string, campsiteId: string, request: CreateInviteRequest): Promise<CampsiteInvite>;
  join(accountId: string, request: JoinCampsiteRequest): Promise<{ campsite: Campsite; role: MemberRole }>;
  getMachine(accountId: string, campsiteId: string): Promise<SM01>;
  recordMaintenance(accountId: string, campsiteId: string, request: RecordMaintenanceRequest): Promise<SM01>;
  /** Shared with worldState/sessions: throws unless the caller is a member. */
  requireMember(accountId: string, campsiteId: string, minimumRole?: MemberRole): Promise<Campsite>;
  /**
   * What to put in the QR image for an invite.
   *
   * A signed `somemore://c/SM1.…` code when this deployment has keys, and the
   * unsigned `somemore://join?t=…` form when it does not — because a campfire
   * with no QR is worse than a campfire whose QR is only as strong as the
   * invite token behind it, which is what it has always been. Both are accepted
   * by `join`, so a code printed today keeps working after keys arrive.
   */
  qrPayloadFor(invite: CampsiteInvite): string;
}

const WEAR_COMPONENTS = ['drum', 'press', 'chiller', 'dispenser', 'hopper', 'belt'] as const;

export function createCampsiteService(
  deps: DomainDeps,
  passports: PassportService,
  signer: CodeSigner,
): CampsiteService {
  const { repos, clock, ids, logger } = deps;

  /**
   * Turn a scanned QR into an invite token.
   *
   * One format serves the whole product, so this tries the signed code first:
   * a forged or tampered camp QR is rejected by an Ed25519 check before the
   * invite table is touched at all. The legacy unsigned payload stays
   * supported — codes already in the wild must keep working, and a deployment
   * with no keys still has to be able to invite a friend to a fire.
   */
  function inviteTokenFromQr(payload: string): string {
    const parsed = parseSomeMoreCode(payload);
    if (parsed.ok) {
      const verdict = signer.verify(parsed.code);
      if (verdict === 'not_configured') {
        throw new ApiError(
          'service_not_configured',
          'This deployment cannot verify signed codes (no CODE_VERIFY_PUBLIC_KEYS).',
        );
      }
      if (verdict !== 'ok') {
        throw new ApiError('code_invalid', 'That does not look like a Some More code.', {
          details: { reason: 'invalid' },
        });
      }
      if (parsed.code.body.kind !== 'camp') {
        throw new ApiError('code_invalid', 'That code is not a campsite invite.', {
          details: { reason: 'wrong_kind' },
        });
      }
      const expiry = parsed.code.body.expiresAtUnix;
      if (expiry !== 0 && expiry * 1000 <= clock.now().getTime()) {
        throw new ApiError('code_invalid', 'That invite has expired.', { details: { reason: 'expired' } });
      }
      return parsed.code.body.ref;
    }
    const token = parseQrJoinPayload(payload);
    if (token === null) throw notFound('That QR code is not a Some More invite.');
    return token;
  }

  function memberRole(campsite: Campsite, accountId: string): MemberRole | null {
    const member = campsite.members.find((m) => m.accountId === accountId);
    if (member === undefined || member.banned) return null;
    return member.role;
  }

  async function load(campsiteId: string): Promise<Campsite> {
    const campsite = await repos.campsites.get(campsiteId);
    if (campsite === null) throw notFound('No such campsite.');
    return campsite;
  }

  async function requireMember(accountId: string, campsiteId: string, minimumRole: MemberRole = 'viewer'): Promise<Campsite> {
    const campsite = await load(campsiteId);
    const role = memberRole(campsite, accountId);
    if (role === null) {
      // Public campsites are readable by anyone; everything else is a 404 to
      // non-members so that ids are not enumerable.
      if (campsite.privacy === 'public' && minimumRole === 'viewer') return campsite;
      throw notFound('No such campsite.');
    }
    if (!roleAtLeast(role, minimumRole)) throw forbidden(`This action requires the ${minimumRole} role or higher.`);
    return campsite;
  }

  async function mintCampCode(): Promise<string> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const code = ids.campCode();
      const [campsiteClash, inviteClash] = await Promise.all([
        repos.campsites.findByCampCode(code),
        repos.invites.findByCampCode(code),
      ]);
      if (campsiteClash === null && inviteClash === null) return code;
    }
    throw new ApiError('internal_error', 'Could not mint a unique camp code.');
  }

  function newMachine(now: string): SM01 {
    return {
      model: 'SM-01',
      serialNumber: ids.machineSerial(),
      firmwareVersion: '2.1.0',
      installedAt: now,
      wear: { drum: 0, press: 0, chiller: 0, dispenser: 0, hopper: 0, belt: 0 },
      cyclesRun: 0,
      jamsCleared: 0,
      lastRunAt: null,
      lastServicedAt: null,
      maintenanceHistory: [],
      quirks: [],
      finishCode: 'factory_enamel',
      operational: true,
    };
  }

  function summarize(campsite: Campsite): CampsiteSummary {
    return {
      id: campsite.id,
      environmentId: campsite.environmentId,
      name: campsite.name,
      privacy: campsite.privacy,
      ownerAccountId: campsite.ownerAccountId,
      createdAt: campsite.createdAt,
      lastActiveAt: campsite.lastActiveAt,
      memberCount: campsite.members.filter((m) => !m.banned).length,
      machineSerial: campsite.machine.serialNumber,
    };
  }

  return {
    requireMember,

    qrPayloadFor(invite) {
      const expiresAtUnix = Math.floor(Date.parse(invite.expiresAt) / 1000);
      const signed = signer.mint({
        kind: 'camp',
        // Campsite invites are not a print run; `invite` is the pseudo-batch
        // that says so, and nothing in `code_batches` ever refers to it.
        batchId: 'invite',
        ref: invite.token,
        expiresAtUnix,
      });
      return signed === null ? `${QR_JOIN_PREFIX}${invite.token}` : codeToUri(signed.token);
    },

    async create(accountId, request) {
      const now = clock.isoNow();
      const passport = await repos.passports.get(accountId);
      const privacy = request.privacy ?? passport?.settings.defaultCampsitePrivacy ?? 'private';
      const campsite = CampsiteSchema.parse({
        id: ids.next(ID_PREFIX.campsite),
        environmentId: request.environmentId,
        seed: request.seed ?? Math.floor(Math.random() * 0xffffffff),
        ownerAccountId: accountId,
        name: request.name,
        privacy,
        campCode: await mintCampCode(),
        members: [{ accountId, role: 'owner', joinedAt: now, joinedVia: 'owner' }],
        machine: newMachine(now),
        createdAt: now,
        updatedAt: now,
        lastActiveAt: now,
        revision: 0,
        schemaVersion: SCHEMA_VERSION,
      });
      const created = await repos.campsites.create(campsite);
      await passports.recordVisit(accountId, created);
      logger.info('campsite.created', { campsiteId: created.id, privacy: created.privacy });
      return created;
    },

    async get(accountId, campsiteId) {
      return requireMember(accountId, campsiteId);
    },

    async update(accountId, campsiteId, request) {
      const campsite = await requireMember(accountId, campsiteId, 'cohost');
      if (request.expectedRevision !== undefined && request.expectedRevision !== campsite.revision) {
        throw preconditionFailed('The campsite changed since you last read it.', {
          expectedRevision: request.expectedRevision,
          actualRevision: campsite.revision,
        });
      }
      if (request.privacy !== undefined && campsite.ownerAccountId !== accountId) {
        throw forbidden('Only the owner can change who can see this campsite.');
      }
      return repos.campsites.update(campsiteId, (c) => ({
        ...c,
        name: request.name ?? c.name,
        privacy: request.privacy ?? c.privacy,
        machine: request.machineFinishCode === undefined ? c.machine : { ...c.machine, finishCode: request.machineFinishCode },
        updatedAt: clock.isoNow(),
        revision: c.revision + 1,
      }));
    },

    async listForAccount(accountId) {
      const campsites = await repos.campsites.listByMember(accountId);
      return campsites
        .sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt))
        .map(summarize);
    },

    async createInvite(accountId, campsiteId, request) {
      await requireMember(accountId, campsiteId, 'cohost');
      const now = clock.now();
      const invite: CampsiteInvite = {
        id: ids.next(ID_PREFIX.invite),
        campsiteId,
        token: ids.token(24),
        campCode: await mintCampCode(),
        createdBy: accountId,
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + request.ttlMinutes * 60_000).toISOString(),
        maxUses: request.maxUses,
        uses: 0,
        revokedAt: null,
        grantsRole: request.grantsRole,
      };
      return repos.invites.create(invite);
    },

    async join(accountId, request) {
      const nowIso = clock.isoNow();
      let invite: CampsiteInvite | null = null;
      let campsite: Campsite | null = null;
      let via: 'invite_link' | 'camp_code' | 'qr' = 'camp_code';

      if (request.join.method === 'invite_link' || request.join.method === 'qr') {
        via = request.join.method;
        const token =
          request.join.method === 'invite_link' ? request.join.token : inviteTokenFromQr(request.join.payload);
        invite = await repos.invites.findByToken(token);
        if (invite === null) throw notFound('That invite is not valid.');
      } else {
        via = 'camp_code';
        invite = await repos.invites.findByCampCode(request.join.code);
        if (invite === null) {
          campsite = await repos.campsites.findByCampCode(request.join.code);
          if (campsite === null) throw notFound('No campfire answers to that code.');
          if (campsite.privacy === 'private' || campsite.privacy === 'invite_only') {
            // Private by default means a camp code alone is not enough.
            throw forbidden('That campsite is private. Ask the owner for an invite link.');
          }
        }
      }

      let grantsRole: MemberRole = 'guest';
      if (invite !== null) {
        if (invite.revokedAt !== null) throw forbidden('That invite was revoked.');
        if (invite.expiresAt <= nowIso) throw forbidden('That invite has expired.');
        if (invite.uses >= invite.maxUses) throw forbidden('That invite has been used up.');
        grantsRole = invite.grantsRole;
        campsite = await load(invite.campsiteId);
      }
      if (campsite === null) throw notFound('No such campsite.');

      const existing = campsite.members.find((m) => m.accountId === accountId);
      if (existing !== undefined && existing.banned) throw forbidden('You are not welcome at that fire.');

      if (existing === undefined) {
        campsite = await repos.campsites.update(campsite.id, (c) => ({
          ...c,
          members: [...c.members, { accountId, role: grantsRole, joinedAt: nowIso, lastSeenAt: nowIso, joinedVia: via, banned: false }],
          lastActiveAt: nowIso,
          updatedAt: nowIso,
          revision: c.revision + 1,
        }));
        if (invite !== null) {
          await repos.invites.update(invite.id, (i) => ({ ...i, uses: i.uses + 1 }));
        }
      } else {
        grantsRole = existing.role;
        campsite = await repos.campsites.update(campsite.id, (c) => ({
          ...c,
          members: c.members.map((m) => (m.accountId === accountId ? { ...m, lastSeenAt: nowIso } : m)),
          lastActiveAt: nowIso,
        }));
      }

      await passports.recordVisit(accountId, campsite);
      logger.info('campsite.joined', { campsiteId: campsite.id, via, role: grantsRole });
      return { campsite, role: grantsRole };
    },

    async getMachine(accountId, campsiteId) {
      const campsite = await requireMember(accountId, campsiteId);
      return campsite.machine;
    },

    async recordMaintenance(accountId, campsiteId, request) {
      const campsite = await requireMember(accountId, campsiteId, 'guest');
      const now = clock.isoNow();
      const component = request.component ?? null;
      const before = component === null
        ? Math.max(...WEAR_COMPONENTS.map((c) => campsite.machine.wear[c]))
        : campsite.machine.wear[component];

      const reduction = {
        clean: 0.1,
        lubricate: 0.15,
        replace_part: 1,
        descale: 0.3,
        firmware_update: 0,
        recalibrate: 0.05,
        factory_reset: 1,
      }[request.kind];

      const wear = { ...campsite.machine.wear };
      for (const key of WEAR_COMPONENTS) {
        if (component !== null && key !== component && request.kind !== 'factory_reset') continue;
        wear[key] = Math.max(0, Number((wear[key] - reduction).toFixed(4)));
      }
      const after = component === null ? Math.max(...WEAR_COMPONENTS.map((c) => wear[c])) : wear[component];

      const event: MaintenanceEvent = {
        id: ids.next(ID_PREFIX.maintenance),
        kind: request.kind,
        at: now,
        performedBy: accountId,
        component,
        wearBefore: Number(before.toFixed(4)),
        wearAfter: Number(after.toFixed(4)),
        notes: request.notes,
      };

      // A factory reset wipes the machine's personality. Players are warned.
      const quirks = request.kind === 'factory_reset' ? [] : campsite.machine.quirks;

      const updated = await repos.campsites.update(campsiteId, (c) => ({
        ...c,
        machine: {
          ...c.machine,
          wear,
          quirks,
          operational: true,
          lastServicedAt: now,
          maintenanceHistory: [...c.machine.maintenanceHistory, event].slice(-500),
        },
        updatedAt: now,
        revision: c.revision + 1,
      }));
      return updated.machine;
    },
  };
}
