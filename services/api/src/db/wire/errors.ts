/**
 * A structured `ErrorResponse` from the backend. The SQLSTATE `code` is the
 * only field callers should branch on; everything else is for humans and logs.
 */
export class PgError extends Error {
  readonly severity: string;
  readonly code: string;
  readonly detail: string | undefined;
  readonly hint: string | undefined;
  readonly constraint: string | undefined;
  readonly table: string | undefined;
  readonly column: string | undefined;
  readonly where: string | undefined;
  readonly position: string | undefined;

  constructor(fields: ReadonlyMap<string, string>) {
    super(fields.get('M') ?? 'postgres: unknown error');
    this.name = 'PgError';
    this.severity = fields.get('S') ?? fields.get('V') ?? 'ERROR';
    this.code = fields.get('C') ?? 'XX000';
    this.detail = fields.get('D');
    this.hint = fields.get('H');
    this.constraint = fields.get('n');
    this.table = fields.get('t');
    this.column = fields.get('c');
    this.where = fields.get('W');
    this.position = fields.get('P');
  }
}

/** 23505 unique_violation — the one every repository has an opinion about. */
export const UNIQUE_VIOLATION = '23505';
export const FOREIGN_KEY_VIOLATION = '23503';
export const CHECK_VIOLATION = '23514';
export const SERIALIZATION_FAILURE = '40001';
export const DEADLOCK_DETECTED = '40P01';
export const ADMIN_SHUTDOWN = '57P01';
export const CRASH_SHUTDOWN = '57P02';
export const CANNOT_CONNECT_NOW = '57P03';
export const TOO_MANY_CONNECTIONS = '53300';

/**
 * Transient in the "retrying the whole operation may well succeed" sense:
 * a lost connection, a server that is still starting, a serialization failure
 * or a deadlock victim. Never a constraint violation — retrying that is just a
 * slower way to fail.
 */
export function isRetryable(error: unknown): boolean {
  if (error instanceof PgConnectionError) return true;
  if (!(error instanceof PgError)) return false;
  return (
    error.code === SERIALIZATION_FAILURE ||
    error.code === DEADLOCK_DETECTED ||
    error.code === CANNOT_CONNECT_NOW ||
    error.code === TOO_MANY_CONNECTIONS ||
    error.code === ADMIN_SHUTDOWN ||
    error.code === CRASH_SHUTDOWN ||
    error.code.startsWith('08')
  );
}

/** Socket-level failures: refused, reset, timed out, TLS refused. */
export class PgConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PgConnectionError';
  }
}
