import { ApiError } from '../../errors.js';

/** Deep copy on the way in and out so callers can never mutate stored state. */
export function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Minimal keyed store shared by the in-memory repositories. It exists so each
 * repository below is only the *interesting* part of its persistence: the
 * lookups and the invariants, not eleven copies of get/put.
 */
export class MemoryTable<T> {
  private readonly rows = new Map<string, T>();

  constructor(
    private readonly entityName: string,
    private readonly keyOf: (row: T) => string,
  ) {}

  insert(row: T): T {
    const key = this.keyOf(row);
    if (this.rows.has(key)) {
      throw new ApiError('conflict', `${this.entityName} ${key} already exists.`);
    }
    this.rows.set(key, copy(row));
    return copy(row);
  }

  put(row: T): T {
    this.rows.set(this.keyOf(row), copy(row));
    return copy(row);
  }

  find(key: string): T | null {
    const row = this.rows.get(key);
    return row === undefined ? null : copy(row);
  }

  require(key: string): T {
    const row = this.rows.get(key);
    if (row === undefined) throw new ApiError('not_found', `${this.entityName} ${key} was not found.`);
    return copy(row);
  }

  mutate(key: string, mutate: (current: T) => T): T {
    const current = this.require(key);
    const next = mutate(current);
    this.rows.set(key, copy(next));
    return copy(next);
  }

  remove(key: string): boolean {
    return this.rows.delete(key);
  }

  all(): T[] {
    return [...this.rows.values()].map((row) => copy(row));
  }

  filter(predicate: (row: T) => boolean): T[] {
    return this.all().filter(predicate);
  }

  first(predicate: (row: T) => boolean): T | null {
    for (const row of this.rows.values()) {
      if (predicate(row)) return copy(row);
    }
    return null;
  }

  get size(): number {
    return this.rows.size;
  }
}
