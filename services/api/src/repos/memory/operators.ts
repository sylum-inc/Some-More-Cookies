import type { OperatorGrant } from '@somemore/protocol';

import type { OperatorGrantRepository } from '../interfaces.js';

/**
 * Backs `operator_capabilities` (README, Blocker 9).
 *
 * Keyed by account *and* capability, so revoking one thing from one person
 * leaves everything else they hold alone — which is the whole difference
 * between this and the shared secret it replaces.
 */
export function createMemoryOperatorGrantRepository(): OperatorGrantRepository {
  const rows = new Map<string, OperatorGrant>();
  const keyOf = (accountId: string, capability: string): string => `${accountId} ${capability}`;

  return {
    async listFor(accountId) {
      return [...rows.values()].filter((g) => g.accountId === accountId && g.revokedAt === null);
    },
    async listAll() {
      return [...rows.values()].filter((g) => g.revokedAt === null);
    },
    async grant(grant) {
      // Idempotent, and a re-grant after a revoke clears the revocation rather
      // than leaving a live row that says it was taken away.
      const stored: OperatorGrant = { ...grant, revokedAt: null };
      rows.set(keyOf(grant.accountId, grant.capability), stored);
      return stored;
    },
    async revoke(accountId, capabilities, atIso) {
      let revoked = 0;
      for (const capability of capabilities) {
        const key = keyOf(accountId, capability);
        const existing = rows.get(key);
        if (existing === undefined || existing.revokedAt !== null) continue;
        rows.set(key, { ...existing, revokedAt: atIso });
        revoked += 1;
      }
      return revoked;
    },
  };
}
