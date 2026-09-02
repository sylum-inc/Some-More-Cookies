import {
  capabilitiesFor,
  type GrantOperatorRequest,
  type OperatorCapability,
  type OperatorGrant,
  type RevokeOperatorRequest,
} from '@somemore/protocol';

import { forbidden } from '../errors.js';
import type { DomainDeps } from './types.js';

/**
 * Who may do operator things (README, Blocker 9).
 *
 * The blocker asked for "an operator identity provider and a role model", and
 * only the second half was ever the dependency. This is that half. An identity
 * provider maps people to accounts, which the service already has, so buying
 * one later federates into this model rather than replacing it — which is why
 * the blocker is closed rather than narrowed. See ADR-0011.
 *
 * What it replaces: one shared secret, held by everybody who had the string,
 * granting every operator power at once, with no way to take it back from one
 * person. What it is: capabilities, granted and revoked per account, checked
 * one at a time at the point of use, and recorded with who granted them.
 *
 * `LIVE_OPS_TOKEN` still exists and no longer authorizes anything. It is the
 * bootstrap credential — the way the *first* operator is made on a deployment
 * that has none — and after that it is not needed, because
 * `operators:grant` is itself a capability somebody holds.
 */
export interface OperatorDirectory {
  /** Live capabilities held by an account. Empty for everybody ordinary. */
  capabilitiesOf(accountId: string): Promise<OperatorCapability[]>;
  /** Throws `forbidden` naming the capability, which is what an operator needs to read. */
  require(accountId: string, capability: OperatorCapability): Promise<void>;
  has(accountId: string, capability: OperatorCapability): Promise<boolean>;
  grant(request: GrantOperatorRequest, grantedByAccountId: string | null): Promise<OperatorGrant[]>;
  revoke(request: RevokeOperatorRequest): Promise<number>;
  /** Everybody who holds anything. The "who has the keys" question. */
  roster(): Promise<OperatorGrant[]>;
}

export function createOperatorDirectory(deps: DomainDeps): OperatorDirectory {
  const { repos, clock, logger } = deps;

  return {
    async capabilitiesOf(accountId) {
      const grants = await repos.operatorGrants.listFor(accountId);
      return grants.map((g) => g.capability);
    },

    async has(accountId, capability) {
      const grants = await repos.operatorGrants.listFor(accountId);
      return grants.some((g) => g.capability === capability);
    },

    async require(accountId, capability) {
      const grants = await repos.operatorGrants.listFor(accountId);
      if (grants.some((g) => g.capability === capability)) return;
      /*
       * The message names the capability, on purpose. This is not an oracle a
       * stranger can farm — you already had to authenticate as somebody to see
       * it — and the person most likely to read it is an operator who has been
       * given the wrong bundle and needs to know which one to ask for.
       */
      throw forbidden(`This action needs the ${capability} capability.`);
    },

    async grant(request, grantedByAccountId) {
      const capabilities = capabilitiesFor(request);
      const grantedAt = clock.isoNow();
      const granted: OperatorGrant[] = [];
      for (const capability of capabilities) {
        granted.push(
          await repos.operatorGrants.grant({
            accountId: request.accountId,
            capability,
            grantedByAccountId,
            grantedAt,
            revokedAt: null,
          }),
        );
      }
      // Logged rather than silent: handing somebody the ability to publish to
      // every player is the sort of thing that should be findable afterwards.
      logger.warn('operators.granted', {
        accountId: request.accountId,
        capabilities,
        grantedByAccountId,
      });
      return granted;
    },

    async revoke(request) {
      const revoked = await repos.operatorGrants.revoke(
        request.accountId,
        request.capabilities,
        clock.isoNow(),
      );
      logger.warn('operators.revoked', {
        accountId: request.accountId,
        capabilities: request.capabilities,
        revoked,
      });
      return revoked;
    },

    async roster() {
      return repos.operatorGrants.listAll();
    },
  };
}
