import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3';

export type Db = DatabaseType;

export function openDb(path: string): Db {
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('synchronous = NORMAL');
  // Reduce contention on long imports.
  db.pragma('busy_timeout = 5000');
  return db;
}

export function closeDb(db: Db): void {
  db.close();
}

const stmtCache = new WeakMap<Db, Map<string, Statement>>();

/**
 * Cache prepared statements per database. Importers call the same INSERTs
 * thousands of times — preparing once cuts a lot of overhead and the cache
 * vanishes when the Db is garbage-collected.
 *
 * `TParams` defaults to `unknown[]` so callers don't have to type their
 * arguments. When precise typing matters, pass a tuple type as the first
 * generic argument and `Statement<TParams, TRow>` is returned directly.
 */
export function prepare<TParams extends unknown[] = unknown[], TRow = unknown>(
  db: Db,
  sql: string,
): Statement<TParams, TRow> {
  let cache = stmtCache.get(db);
  if (!cache) {
    cache = new Map();
    stmtCache.set(db, cache);
  }
  let stmt = cache.get(sql);
  if (!stmt) {
    stmt = db.prepare(sql);
    cache.set(sql, stmt);
  }
  return stmt as Statement<TParams, TRow>;
}

export function transactional<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn);
  return wrapped();
}
