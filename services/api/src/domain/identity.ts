import { createHash } from 'node:crypto';
import {
  SCHEMA_VERSION,
  type Account,
  type AnonymousBootstrapRequest,
  type AuthSession,
  type AuthToken,
  type Identity,
  type LinkCredential,
  type LinkIdentityOutcome,
  type LinkIdentityRequest,
  type MagicLinkIssued,
  type MagicLinkRequest,
  type MergeReport,
} from '@somemore/protocol';
import { ApiError, badRequest, notFound, unauthorized } from '../errors.js';
import { ID_PREFIX } from '../ids.js';
import { mergePassportCollections } from './passport.js';
import type { PassportService } from './passport.js';
import type { DomainDeps } from './types.js';

/**
 * Identity: anonymous device bootstrap, durable identity linking, and account
 * merges.
 *
 * The product rule this module exists to protect: a player who has been
 * roasting anonymously for a week and then signs in with Apple must never lose
 * a single sandwich. Every branch of `linkIdentity` is therefore explicit, and
 * no branch destroys data.
 */
export interface IdentityService {
  bootstrapAnonymous(request: AnonymousBootstrapRequest): Promise<AuthSession>;
  getSession(accountId: string): Promise<AuthSession>;
  refresh(accountId: string): Promise<AuthToken>;
  requireActiveAccount(accountId: string): Promise<Account>;
  linkIdentity(accountId: string, request: LinkIdentityRequest): Promise<LinkIdentityOutcome>;
  requestMagicLink(accountId: string | null, request: MagicLinkRequest): Promise<MagicLinkIssued>;
  hasLinkedProvider(accountId: string, provider: Identity['provider']): Promise<boolean>;
}

/**
 * Resolve an OIDC credential to a provider subject.
 *
 * BLOCKER: there are no Apple/Google client credentials for this project, so
 * the id token cannot be verified against the issuer's JWKS. We accept the
 * token's `sub` claim (or, for opaque dev tokens, the token itself) and record
 * that it is unverified. Wiring real verification is a contained change here:
 * fetch JWKS, verify RS256, check `aud`/`iss`/`nonce`, then return `sub`.
 */
export function resolveCredentialSubject(credential: LinkCredential): { subject: string; email: string | null } {
  if (credential.provider === 'email') {
    return { subject: credential.magicLinkToken, email: null };
  }
  const token = credential.provider === 'apple' ? credential.identityToken : credential.idToken;
  const parts = token.split('.');
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1] ?? '', 'base64url').toString('utf8')) as {
        sub?: unknown;
        email?: unknown;
      };
      if (typeof payload.sub === 'string' && payload.sub.length > 0) {
        return { subject: payload.sub, email: typeof payload.email === 'string' ? payload.email : null };
      }
    } catch {
      // fall through to the opaque-token path
    }
  }
  return { subject: `opaque:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`, email: null };
}

export function createIdentityService(deps: DomainDeps, passports: PassportService): IdentityService {
  const { repos, clock, ids, tokens, config, logger, mailer, rateLimiter } = deps;

  function issue(accountId: string): AuthToken {
    const signed = tokens.sign(accountId, clock.now());
    return {
      token: signed.token,
      accountId,
      issuedAt: signed.issuedAt.toISOString(),
      expiresAt: signed.expiresAt.toISOString(),
      schemaVersion: SCHEMA_VERSION,
    };
  }

  async function sessionFor(account: Account): Promise<AuthSession> {
    return {
      account,
      identities: await repos.identities.listByAccount(account.id),
      auth: issue(account.id),
    };
  }

  async function requireActiveAccount(accountId: string): Promise<Account> {
    const account = await repos.accounts.get(accountId);
    if (account === null) throw unauthorized('Unknown account.');
    if (account.status === 'merged' && account.mergedIntoAccountId !== null) {
      // A token minted before a merge still works: follow the pointer.
      const surviving = await repos.accounts.get(account.mergedIntoAccountId);
      if (surviving !== null && surviving.status === 'active') return surviving;
    }
    if (account.status !== 'active') throw unauthorized(`Account is ${account.status}.`);
    return account;
  }

  /** Move every owned row from `absorbed` onto `surviving` and report on it. */
  async function mergeAccounts(survivingId: string, absorbedId: string, now: string): Promise<MergeReport> {
    const survivingPassport = await repos.passports.get(survivingId);
    const absorbedPassport = await repos.passports.get(absorbedId);
    let movedCollections: Record<string, number> = {
      stamps: 0,
      photos: 0,
      notes: 0,
      patches: 0,
      ticketStubs: 0,
      discoveries: 0,
      visitedCampsites: 0,
    };

    if (survivingPassport !== null && absorbedPassport !== null) {
      const merged = mergePassportCollections(survivingPassport, absorbedPassport, now);
      movedCollections = merged.moved;
      await repos.passports.update(survivingId, () => merged.passport);
      await repos.passports.delete(absorbedId);
    }

    const [identities, photos, sandwiches, campsites, grants, orders] = await Promise.all([
      repos.identities.reassignAccount(absorbedId, survivingId),
      repos.photos.reassignAccount(absorbedId, survivingId),
      repos.sandwiches.reassignAccount(absorbedId, survivingId),
      repos.campsites.reassignAccount(absorbedId, survivingId),
      repos.rewardGrants.reassignAccount(absorbedId, survivingId),
      repos.orders.reassignAccount(absorbedId, survivingId),
    ]);
    await repos.analytics.remapAccount(absorbedId, survivingId);

    await repos.accounts.update(absorbedId, (a) => ({
      ...a,
      status: 'merged',
      mergedIntoAccountId: survivingId,
      updatedAt: now,
    }));
    await repos.accounts.update(survivingId, (a) => ({ ...a, anonymous: false, updatedAt: now }));

    const report: MergeReport = {
      survivingAccountId: survivingId,
      mergedAccountId: absorbedId,
      moved: {
        identities,
        stamps: movedCollections['stamps'] ?? 0,
        photos,
        sandwiches,
        notes: movedCollections['notes'] ?? 0,
        patches: movedCollections['patches'] ?? 0,
        ticketStubs: movedCollections['ticketStubs'] ?? 0,
        discoveries: movedCollections['discoveries'] ?? 0,
        visitedCampsites: movedCollections['visitedCampsites'] ?? 0,
        campsites,
        rewardGrants: grants,
        orders,
      },
      resolutions: [
        {
          field: 'displayName',
          kept: 'current',
          note: 'The surviving account keeps its display name; the other name is discarded, not the progress.',
        },
        { field: 'handle', kept: 'current', note: 'Handles are unique; the absorbed handle is released.' },
        { field: 'settings', kept: 'current', note: 'Including accessibility settings.' },
        { field: 'stats', kept: 'combined' },
      ],
      mergedAt: now,
    };
    logger.info('identity.merge_complete', { survivingId, absorbedId, moved: report.moved });
    return report;
  }

  async function progressPreview(accountId: string): Promise<{ sandwiches: number; stamps: number; campsites: number }> {
    const [sandwiches, passport, campsites] = await Promise.all([
      repos.sandwiches.countByAccount(accountId),
      repos.passports.get(accountId),
      repos.campsites.listByMember(accountId),
    ]);
    return { sandwiches, stamps: passport?.stamps.length ?? 0, campsites: campsites.length };
  }

  return {
    async bootstrapAnonymous(request) {
      const nowIso = clock.isoNow();
      const existing = await repos.identities.findByProviderSubject('anonymous', request.device.deviceId);
      if (existing !== null) {
        // Re-bootstrapping the same device returns the same account: a player
        // who reinstalls before linking should still find their fire.
        const account = await requireActiveAccount(existing.accountId);
        await repos.identities.update(existing.id, (i) => ({ ...i, lastAuthenticatedAt: nowIso }));
        return sessionFor(account);
      }

      const account = await repos.accounts.create({
        id: ids.next(ID_PREFIX.account),
        status: 'active',
        createdAt: nowIso,
        updatedAt: nowIso,
        mergedIntoAccountId: null,
        anonymous: true,
        schemaVersion: SCHEMA_VERSION,
      });
      await repos.identities.create({
        id: ids.next(ID_PREFIX.identity),
        accountId: account.id,
        provider: 'anonymous',
        subject: request.device.deviceId,
        email: null,
        emailVerified: false,
        displayNameHint: request.displayName ?? null,
        createdAt: nowIso,
        lastAuthenticatedAt: nowIso,
      });
      await passports.create(account.id, request.displayName ?? 'Camper');
      logger.info('identity.bootstrap', { accountId: account.id, platform: request.device.platform });
      return sessionFor(account);
    },

    async getSession(accountId) {
      const account = await requireActiveAccount(accountId);
      return sessionFor(account);
    },

    async refresh(accountId) {
      const account = await requireActiveAccount(accountId);
      return issue(account.id);
    },

    requireActiveAccount,

    async hasLinkedProvider(accountId, provider) {
      const identities = await repos.identities.listByAccount(accountId);
      return identities.some((i) => i.provider === provider);
    },

    async linkIdentity(accountId, request) {
      const nowIso = clock.isoNow();
      const account = await requireActiveAccount(accountId);
      const { credential } = request;

      let subject: string;
      let email: string | null = null;
      if (credential.provider === 'email') {
        const link = await repos.magicLinks.get(credential.magicLinkToken);
        if (link === null) throw unauthorized('That sign-in link is not valid.');
        if (link.consumedAt !== null) throw unauthorized('That sign-in link has already been used.');
        if (link.expiresAt <= nowIso) throw unauthorized('That sign-in link has expired.');
        subject = link.email.toLowerCase();
        email = link.email.toLowerCase();
      } else {
        const resolved = resolveCredentialSubject(credential);
        subject = resolved.subject;
        email = resolved.email;
      }

      const existingIdentity = await repos.identities.findByProviderSubject(credential.provider, subject);

      if (existingIdentity !== null && existingIdentity.accountId === account.id) {
        if (credential.provider === 'email') await repos.magicLinks.consume(credential.magicLinkToken, nowIso);
        return { status: 'already_linked', accountId: account.id, identity: existingIdentity };
      }

      if (existingIdentity !== null && existingIdentity.accountId !== account.id) {
        const otherAccount = await repos.accounts.get(existingIdentity.accountId);
        if (otherAccount === null) throw notFound('The account behind that identity is gone.');

        if (request.mergePolicy === 'abort') {
          const [current, existing] = await Promise.all([
            progressPreview(account.id),
            progressPreview(otherAccount.id),
          ]);
          return {
            status: 'conflict',
            conflict: 'identity_owned_by_other_account',
            currentAccountId: account.id,
            existingAccountId: otherAccount.id,
            resolutions: ['keep_existing', 'keep_current'],
            preview: { current, existing },
          };
        }

        const survivingId = request.mergePolicy === 'keep_current' ? account.id : otherAccount.id;
        const absorbedId = survivingId === account.id ? otherAccount.id : account.id;
        if (credential.provider === 'email') await repos.magicLinks.consume(credential.magicLinkToken, nowIso);
        const report = await mergeAccounts(survivingId, absorbedId, nowIso);
        const identity = await repos.identities.findByProviderSubject(credential.provider, subject);
        if (identity === null) throw new ApiError('internal_error', 'Identity vanished during merge.');
        return {
          status: 'merged',
          accountId: survivingId,
          identity,
          report,
          auth: issue(survivingId),
        };
      }

      // The identity is new. Two remaining conflicts to check.
      const alreadyOnProvider = (await repos.identities.listByAccount(account.id)).find(
        (i) => i.provider === credential.provider,
      );
      if (alreadyOnProvider !== undefined) {
        const [current, existing] = await Promise.all([
          progressPreview(account.id),
          progressPreview(account.id),
        ]);
        return {
          status: 'conflict',
          conflict: 'provider_already_linked',
          currentAccountId: account.id,
          existingAccountId: account.id,
          resolutions: [],
          preview: { current, existing },
        };
      }

      if (email !== null) {
        const emailOwner = await repos.identities.findVerifiedByEmail(email);
        if (emailOwner !== null && emailOwner.accountId !== account.id) {
          if (request.mergePolicy === 'abort') {
            const [current, existing] = await Promise.all([
              progressPreview(account.id),
              progressPreview(emailOwner.accountId),
            ]);
            return {
              status: 'conflict',
              conflict: 'email_in_use',
              currentAccountId: account.id,
              existingAccountId: emailOwner.accountId,
              resolutions: ['keep_existing', 'keep_current'],
              preview: { current, existing },
            };
          }
          const survivingId = request.mergePolicy === 'keep_current' ? account.id : emailOwner.accountId;
          const absorbedId = survivingId === account.id ? emailOwner.accountId : account.id;
          if (credential.provider === 'email') await repos.magicLinks.consume(credential.magicLinkToken, nowIso);
          const report = await mergeAccounts(survivingId, absorbedId, nowIso);
          const identity = await repos.identities.create({
            id: ids.next(ID_PREFIX.identity),
            accountId: survivingId,
            provider: credential.provider,
            subject,
            email,
            emailVerified: credential.provider === 'email',
            displayNameHint: null,
            createdAt: nowIso,
            lastAuthenticatedAt: nowIso,
          });
          return { status: 'merged', accountId: survivingId, identity, report, auth: issue(survivingId) };
        }
      }

      if (credential.provider === 'email') {
        const consumed = await repos.magicLinks.consume(credential.magicLinkToken, nowIso);
        if (consumed === null) throw unauthorized('That sign-in link has already been used.');
      }

      const identity = await repos.identities.create({
        id: ids.next(ID_PREFIX.identity),
        accountId: account.id,
        provider: credential.provider,
        subject,
        email,
        emailVerified: credential.provider === 'email',
        displayNameHint: null,
        createdAt: nowIso,
        lastAuthenticatedAt: nowIso,
      });
      await repos.accounts.update(account.id, (a) => ({ ...a, anonymous: false, updatedAt: nowIso }));
      logger.info('identity.linked', { accountId: account.id, provider: credential.provider });

      return { status: 'linked', accountId: account.id, identity, auth: issue(account.id) };
    },

    async requestMagicLink(accountId, request) {
      const email = request.email.toLowerCase();
      const decision = rateLimiter.consume(`magic_link:${email}`, config.magicLinksPerWindow, 3600);
      if (!decision.allowed) {
        throw new ApiError('rate_limited', 'Too many sign-in links requested for that address. Try again later.', {
          headers: { 'retry-after': String(Math.ceil((decision.resetAt.getTime() - clock.now().getTime()) / 1000)) },
        });
      }
      if (request.redirectPath !== undefined && !request.redirectPath.startsWith('/')) {
        throw badRequest('redirectPath must be app-relative.');
      }

      const token = `${ID_PREFIX.magicLink}_${ids.token(24)}`;
      const createdAt = clock.isoNow();
      const expiresAt = new Date(clock.now().getTime() + config.magicLinkTtlSeconds * 1000).toISOString();
      await repos.magicLinks.create({
        token,
        email,
        requestedByAccountId: accountId,
        createdAt,
        expiresAt,
        consumedAt: null,
      });

      await mailer.send({
        to: email,
        subject: 'Your Some More sign-in link',
        text:
          `Tap to bring your Campfire Passport to this device:\n\n`
          + `somemore://auth/magic?token=${token}${request.redirectPath === undefined ? '' : `&next=${request.redirectPath}`}\n\n`
          + `This link expires in ${Math.round(config.magicLinkTtlSeconds / 60)} minutes.`,
        magicLinkToken: token,
      });

      // The console mailer cannot deliver anything, so dev/test builds hand the
      // token back directly. Production never exposes it (see README Blockers).
      const devToken = config.nodeEnv === 'production' ? undefined : token;
      return devToken === undefined ? { sent: true, expiresAt } : { sent: true, expiresAt, devToken };
    },
  };
}
