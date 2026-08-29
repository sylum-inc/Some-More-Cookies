/**
 * Contract version constants for @somemore/protocol.
 *
 * `SCHEMA_VERSION` is the wire-contract version shared by every client and the
 * API service. It is embedded in auth tokens, persisted records and telemetry
 * events so that we can detect and migrate stale clients.
 *
 * Bump rules:
 *  - PATCH: documentation / description-only changes.
 *  - MINOR: additive, backwards compatible (new optional field, new enum member
 *    that old clients may safely ignore).
 *  - MAJOR: any removal, rename, narrowing, or semantic change.
 */
export const SCHEMA_VERSION = '1.0.0' as const;

/** Numeric major of {@link SCHEMA_VERSION}, cheap to compare on the wire. */
export const SCHEMA_MAJOR = 1 as const;

/** URL prefix every versioned HTTP route lives under. */
export const API_VERSION = 'v1' as const;

/** Oldest `SCHEMA_VERSION` major the current service still accepts. */
export const MIN_SUPPORTED_SCHEMA_MAJOR = 1 as const;

export interface SchemaCompatibility {
  readonly compatible: boolean;
  readonly reason?: 'unparseable' | 'too_old' | 'too_new';
}

/** Compare a client-reported schema version against what this build serves. */
export function checkSchemaCompatibility(clientVersion: string): SchemaCompatibility {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(clientVersion);
  if (!match) return { compatible: false, reason: 'unparseable' };
  const major = Number(match[1]);
  if (major < MIN_SUPPORTED_SCHEMA_MAJOR) return { compatible: false, reason: 'too_old' };
  if (major > SCHEMA_MAJOR) return { compatible: false, reason: 'too_new' };
  return { compatible: true };
}
