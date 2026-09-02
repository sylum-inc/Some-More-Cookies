import { ApiError } from '../../errors.js';
import { PgError, UNIQUE_VIOLATION, type PgClient, type PgPool, type SqlParameter } from '../../db/wire/index.js';

/**
 * Shared plumbing for the Postgres repositories.
 *
 * The in-memory implementations in `../memory/` are the reference semantics —
 * every method here exists to reproduce one of them exactly, including which
 * `ApiError` it throws. `MemoryTable` is the shape being mirrored; `DocTable`
 * is the same contract with a transaction and a row lock behind it.
 */

export interface DocTableSpec<T> {
  /** Unqualified table name inside the `somemore` schema. */
  readonly table: string;
  /** Human name used in error messages, matching the in-memory repository. */
  readonly entityName: string;
  /** Primary-key column names, in order. */
  readonly primaryKey: readonly string[];
  /** Extract the primary-key values from an entity. */
  readonly keyOf: (row: T) => readonly string[];
  /** Projected columns (excluding `doc` and the primary key). */
  readonly project: (row: T) => Record<string, SqlParameter>;
}

/** The `key` a MemoryTable would have used, for identical error messages. */
function displayKey(key: readonly string[]): string {
  return key.join(':');
}

/**
 * One aggregate table: typed columns for what we query, a `doc` column for the
 * canonical protocol object.
 */
export class DocTable<T> {
  private readonly pool: PgPool;
  private readonly spec: DocTableSpec<T>;

  constructor(pool: PgPool, spec: DocTableSpec<T>) {
    this.pool = pool;
    this.spec = spec;
  }

  get table(): string {
    return this.spec.table;
  }

  private columnsFor(row: T): { names: string[]; values: SqlParameter[] } {
    const names = [...this.spec.primaryKey];
    const values: SqlParameter[] = [...this.spec.keyOf(row)];
    for (const [name, value] of Object.entries(this.spec.project(row))) {
      names.push(name);
      values.push(value);
    }
    names.push('doc');
    values.push(row as unknown as Record<string, unknown>);
    return { names, values };
  }

  private whereKey(from = 1): string {
    return this.spec.primaryKey.map((name, i) => `${name} = $${i + from}`).join(' AND ');
  }

  /** Mirrors `MemoryTable.insert`: a duplicate key is a `conflict`. */
  async insert(row: T, client?: PgClient): Promise<T> {
    const { names, values } = this.columnsFor(row);
    const sql =
      `INSERT INTO somemore.${this.spec.table} (${names.join(', ')}) ` +
      `VALUES (${values.map((_, i) => (names[i] === 'doc' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')})`;
    try {
      await (client ?? this.pool).query(sql, values);
    } catch (error) {
      if (error instanceof PgError && error.code === UNIQUE_VIOLATION) {
        throw new ApiError(
          'conflict',
          `${this.spec.entityName} ${displayKey(this.spec.keyOf(row))} already exists.`,
          { cause: error, details: { constraint: error.constraint ?? null } },
        );
      }
      throw error;
    }
    return structuredClone(row);
  }

  /** Mirrors `MemoryTable.put`: insert or replace, no complaints. */
  async put(row: T, client?: PgClient): Promise<T> {
    const { names, values } = this.columnsFor(row);
    const assignments = names
      .filter((name) => !this.spec.primaryKey.includes(name))
      .map((name) => `${name} = EXCLUDED.${name}`)
      .join(', ');
    const sql =
      `INSERT INTO somemore.${this.spec.table} (${names.join(', ')}) ` +
      `VALUES (${values.map((_, i) => (names[i] === 'doc' ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(', ')}) ` +
      `ON CONFLICT (${this.spec.primaryKey.join(', ')}) DO UPDATE SET ${assignments}`;
    await (client ?? this.pool).query(sql, values);
    return structuredClone(row);
  }

  async find(key: readonly string[], client?: PgClient): Promise<T | null> {
    const row = await (client ?? this.pool).maybeOne<{ doc: T }>(
      `SELECT doc FROM somemore.${this.spec.table} WHERE ${this.whereKey()}`,
      key,
    );
    return row === null ? null : row.doc;
  }

  /** First matching document, or null. `where` is appended after `WHERE`. */
  async first(where: string, params: readonly SqlParameter[] = [], order?: string): Promise<T | null> {
    const row = await this.pool.maybeOne<{ doc: T }>(
      `SELECT doc FROM somemore.${this.spec.table} WHERE ${where}` +
        `${order === undefined ? '' : ` ORDER BY ${order}`} LIMIT 1`,
      params,
    );
    return row === null ? null : row.doc;
  }

  async list(where: string, params: readonly SqlParameter[] = [], order?: string): Promise<T[]> {
    const rows = await this.pool.many<{ doc: T }>(
      `SELECT doc FROM somemore.${this.spec.table} WHERE ${where}` +
        `${order === undefined ? '' : ` ORDER BY ${order}`}`,
      params,
    );
    return rows.map((row) => row.doc);
  }

  async all(order?: string): Promise<T[]> {
    const rows = await this.pool.many<{ doc: T }>(
      `SELECT doc FROM somemore.${this.spec.table}${order === undefined ? '' : ` ORDER BY ${order}`}`,
    );
    return rows.map((row) => row.doc);
  }

  async count(where?: string, params: readonly SqlParameter[] = []): Promise<number> {
    const row = await this.pool.maybeOne<{ n: number }>(
      `SELECT count(*)::int AS n FROM somemore.${this.spec.table}${where === undefined ? '' : ` WHERE ${where}`}`,
      params,
    );
    return row?.n ?? 0;
  }

  /**
   * Read-modify-write, mirroring `MemoryTable.mutate`.
   *
   * The in-memory version is atomic because JavaScript is single-threaded.
   * Here the same guarantee needs a transaction and `SELECT … FOR UPDATE`:
   * without the row lock, two concurrent `update()` calls would both read the
   * pre-image and the second write would silently discard the first.
   */
  async mutate(key: readonly string[], mutate: (current: T) => T, client?: PgClient): Promise<T> {
    const run = async (tx: PgClient): Promise<T> => {
      const row = await tx.maybeOne<{ doc: T }>(
        `SELECT doc FROM somemore.${this.spec.table} WHERE ${this.whereKey()} FOR UPDATE`,
        key,
      );
      if (row === null) {
        throw new ApiError('not_found', `${this.spec.entityName} ${displayKey(key)} was not found.`);
      }
      const next = mutate(row.doc);
      const projected = this.spec.project(next);
      const assignments: string[] = [];
      const values: SqlParameter[] = [];
      let index = key.length + 1;
      for (const [name, value] of Object.entries(projected)) {
        assignments.push(`${name} = $${index}`);
        values.push(value);
        index += 1;
      }
      assignments.push(`doc = $${index}::jsonb`);
      values.push(next as unknown as Record<string, unknown>);
      await tx.query(
        `UPDATE somemore.${this.spec.table} SET ${assignments.join(', ')} WHERE ${this.whereKey()}`,
        [...key, ...values],
      );
      // Callers may mutate what they receive, exactly as with MemoryTable.
      return structuredClone(next);
    };
    return client === undefined ? this.pool.transaction(run) : run(client);
  }

  async remove(key: readonly string[], client?: PgClient): Promise<boolean> {
    const result = await (client ?? this.pool).query(
      `DELETE FROM somemore.${this.spec.table} WHERE ${this.whereKey()}`,
      key,
    );
    return result.rowCount > 0;
  }

  /**
   * Bulk account reassignment used by merges. Rewrites the projected column and
   * the matching key inside the document in one statement, then returns the
   * number of rows moved.
   */
  async reassign(
    column: string,
    docPath: string,
    fromAccountId: string,
    toAccountId: string,
  ): Promise<number> {
    const result = await this.pool.query(
      `UPDATE somemore.${this.spec.table}
          SET ${column} = $2,
              doc = jsonb_set(doc, '{${docPath}}', to_jsonb($2::text), true)
        WHERE ${column} = $1`,
      [fromAccountId, toAccountId],
    );
    return result.rowCount;
  }
}
