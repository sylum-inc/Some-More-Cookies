import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PgPool, parseDatabaseUrl, type PgClient, type PoolLogger } from './wire/index.js';

/**
 * Forward-only migration runner.
 *
 * The rules, and why each one is there:
 *
 *  1. **Ordering is the filename.** `NNNN_name.sql`, applied in ascending
 *     numeric order. A gap is fine; a duplicate number is a hard error,
 *     because two people numbering the same migration means one of them is
 *     about to be skipped on somebody's database.
 *  2. **Every applied migration is recorded** in `somemore.schema_migrations`
 *     with its checksum. Re-running is a no-op: that is what makes boot-time
 *     migration safe.
 *  3. **A changed checksum is a hard error.** Editing a migration that has
 *     already been applied somewhere produces two different schemas with the
 *     same version number. Write a new migration instead.
 *  4. **Forward only.** There is no `down`. A rollback is a new migration, so
 *     the path that runs in production is the path that was tested.
 *  5. **One transaction per migration**, plus an advisory lock across the whole
 *     run, so several instances booting at once cannot interleave.
 */

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly filename: string;
  readonly sql: string;
  readonly checksum: string;
}

export interface AppliedMigration {
  readonly version: number;
  readonly name: string;
  readonly checksum: string;
  readonly appliedAt: string;
  readonly durationMs: number;
}

export interface MigrationResult {
  readonly applied: readonly Migration[];
  readonly skipped: readonly number[];
  readonly currentVersion: number;
}

/** 64-bit key for `pg_advisory_lock`; arbitrary but stable ("somemore" x 2). */
const MIGRATION_LOCK_KEY = 7735951420173219n % 2147483647n;

const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');

export function checksumOf(sql: string): string {
  // Newlines are normalised so a checkout with CRLF endings does not look like
  // a tampered migration.
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export async function loadMigrations(directory: string = MIGRATIONS_DIR): Promise<Migration[]> {
  const entries = (await readdir(directory)).filter((name) => name.endsWith('.sql')).sort();
  const migrations: Migration[] = [];
  const seen = new Map<number, string>();

  for (const filename of entries) {
    const match = /^(\d+)[_-](.+)\.sql$/.exec(filename);
    if (match === null) {
      throw new Error(`migrations: "${filename}" is not named NNNN_description.sql`);
    }
    const version = Number.parseInt(match[1] ?? '', 10);
    const name = match[2] ?? filename;
    const clash = seen.get(version);
    if (clash !== undefined) {
      throw new Error(`migrations: version ${version} is claimed by both "${clash}" and "${filename}"`);
    }
    seen.set(version, filename);
    const sql = await readFile(path.join(directory, filename), 'utf8');
    migrations.push({ version, name, filename, sql, checksum: checksumOf(sql) });
  }

  return migrations.sort((a, b) => a.version - b.version);
}

async function ensureLedger(client: PgClient): Promise<void> {
  await client.simple(`
    CREATE SCHEMA IF NOT EXISTS somemore;
    CREATE TABLE IF NOT EXISTS somemore.schema_migrations (
      version     integer     PRIMARY KEY,
      name        text        NOT NULL,
      checksum    text        NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now(),
      duration_ms integer     NOT NULL DEFAULT 0
    );
  `);
}

export async function listApplied(client: PgClient): Promise<AppliedMigration[]> {
  await ensureLedger(client);
  const rows = await client.many<{
    version: number;
    name: string;
    checksum: string;
    applied_at: string;
    duration_ms: number;
  }>(
    `SELECT version, name, checksum, to_char(applied_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS applied_at, duration_ms
       FROM somemore.schema_migrations ORDER BY version`,
  );
  return rows.map((row) => ({
    version: row.version,
    name: row.name,
    checksum: row.checksum,
    appliedAt: row.applied_at,
    durationMs: row.duration_ms,
  }));
}

export interface MigrateOptions {
  readonly directory?: string;
  readonly logger?: Pick<PoolLogger, 'debug' | 'warn'> & { info?: (m: string, f?: Record<string, unknown>) => void };
}

/**
 * Apply every migration the database has not seen, in order. Safe to call on
 * every boot and safe to call from several processes at once.
 */
export async function migrate(pool: PgPool, options: MigrateOptions = {}): Promise<MigrationResult> {
  const migrations = await loadMigrations(options.directory);
  const log = options.logger;

  return pool.withClient(async (client) => {
    await ensureLedger(client);
    // Serialise concurrent boots. The lock is released when the session ends,
    // and explicitly below, so a crashed migrator cannot wedge the fleet.
    await client.query('SELECT pg_advisory_lock($1::bigint)', [Number(MIGRATION_LOCK_KEY)]);
    try {
      const applied = await listApplied(client);
      const byVersion = new Map(applied.map((row) => [row.version, row]));

      for (const previous of applied) {
        const known = migrations.find((m) => m.version === previous.version);
        if (known === undefined) {
          throw new Error(
            `migrations: the database has applied version ${previous.version} ("${previous.name}") but no such ` +
              'file exists. This checkout is older than the database.',
          );
        }
        if (known.checksum !== previous.checksum) {
          throw new Error(
            `migrations: ${known.filename} has changed since it was applied ` +
              `(recorded ${previous.checksum.slice(0, 12)}…, on disk ${known.checksum.slice(0, 12)}…). ` +
              'Migrations are immutable — add a new one instead.',
          );
        }
      }

      const pending = migrations.filter((m) => !byVersion.has(m.version));
      const skipped = migrations.filter((m) => byVersion.has(m.version)).map((m) => m.version);

      for (const migration of pending) {
        const startedAt = Date.now();
        await client.query('BEGIN');
        try {
          await client.simple(migration.sql);
          const durationMs = Date.now() - startedAt;
          await client.query(
            `INSERT INTO somemore.schema_migrations (version, name, checksum, duration_ms)
             VALUES ($1::int, $2::text, $3::text, $4::int)`,
            [migration.version, migration.name, migration.checksum, durationMs],
          );
          await client.query('COMMIT');
          log?.info?.('db.migration_applied', {
            version: migration.version,
            name: migration.name,
            durationMs,
          });
        } catch (error) {
          await client.query('ROLLBACK');
          throw new Error(
            `migrations: ${migration.filename} failed and was rolled back: ${(error as Error).message}`,
            { cause: error },
          );
        }
      }

      const currentVersion = migrations.reduce((max, m) => Math.max(max, m.version), 0);
      return { applied: pending, skipped, currentVersion };
    } finally {
      await client.query('SELECT pg_advisory_unlock($1::bigint)', [Number(MIGRATION_LOCK_KEY)]);
    }
  }, { skipGate: true });
}

/**
 * Drop every object this schema owns. Only ever used by tests and by
 * `migrate.ts reset`; it refuses to run against anything that is not obviously
 * a development database unless forced.
 */
export async function resetSchema(pool: PgPool, options: { force?: boolean } = {}): Promise<void> {
  const database = pool.config.database;
  const looksDisposable = /(test|dev|local|_tmp)/i.test(database) || options.force === true;
  if (!looksDisposable) {
    throw new Error(
      `refusing to drop schema "somemore" in database "${database}" — pass force to prove you meant it`,
    );
  }
  await pool.withClient((client) => client.simple('DROP SCHEMA IF EXISTS somemore CASCADE'), { skipGate: true });
}

/**
 * Empty every table the application writes to, leaving the schema and the
 * migration ledger alone. This is how the test suite gets a factory-reset
 * database between cases without paying to re-run migrations each time.
 *
 * `RESTART IDENTITY` matters: `seq` is the insertion order several repository
 * methods sort by, and a test that inherits a high watermark from the previous
 * one is a test that passes for the wrong reason.
 */
export async function truncateData(pool: PgPool): Promise<void> {
  await pool.withClient(async (client) => {
    const rows = await client.many<{ name: string }>(
      `SELECT quote_ident(tablename) AS name
         FROM pg_tables
        WHERE schemaname = 'somemore' AND tablename <> 'schema_migrations'`,
    );
    if (rows.length === 0) return;
    const tables = rows.map((row) => `somemore.${row.name}`).join(', ');
    await client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  }, { skipGate: true });
}

/* -------------------------------------------------------------------------- */
/* CLI: node --experimental-strip-types src/db/migrate.ts [up|status|reset]     */
/* -------------------------------------------------------------------------- */

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'up';
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url.trim().length === 0) {
    console.error('DATABASE_URL is not set. Nothing to migrate.');
    process.exitCode = 2;
    return;
  }

  const pool = new PgPool(parseDatabaseUrl(url, { applicationName: 'somemore-migrate', maxConnections: 2 }));
  try {
    if (command === 'status') {
      const [onDisk, applied] = await Promise.all([
        loadMigrations(),
        pool.withClient((client) => listApplied(client), { skipGate: true }),
      ]);
      const appliedVersions = new Set(applied.map((row) => row.version));
      for (const migration of onDisk) {
        const mark = appliedVersions.has(migration.version) ? 'applied' : 'PENDING';
        console.log(`${String(migration.version).padStart(4, '0')}  ${mark.padEnd(8)} ${migration.name}`);
      }
      return;
    }

    if (command === 'reset') {
      await resetSchema(pool, { force: process.argv.includes('--force') });
      console.log('schema dropped');
    }

    if (command === 'up' || command === 'reset') {
      const result = await migrate(pool, { logger: { debug() {}, warn() {}, info: (m, f) => console.log(m, f) } });
      console.log(
        result.applied.length === 0
          ? `database is up to date at version ${result.currentVersion}`
          : `applied ${result.applied.length} migration(s); now at version ${result.currentVersion}`,
      );
      return;
    }

    console.error(`unknown command "${command}". Use: up | status | reset [--force]`);
    process.exitCode = 2;
  } finally {
    await pool.end();
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]).replace(/\.(ts|js)$/, '') === fileURLToPath(import.meta.url).replace(/\.(ts|js)$/, '');

if (invokedDirectly) {
  await main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
