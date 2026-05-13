import Database, { type Database as DatabaseType, type Statement } from 'better-sqlite3'

export type Db = DatabaseType

export function openDb(path: string): Db {
  const db = new Database(path)
  // page_size must be set before any table is created. On an existing DB it
  // is a no-op (changing requires VACUUM). 16 KiB pages cut B-tree depth and
  // pack more rows per page — measurable wins on insert-heavy workloads.
  db.pragma('page_size = 16384')
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  // Reduce contention on long imports.
  db.pragma('busy_timeout = 5000')
  // 256 MiB page cache (default is 2 MiB) — keeps the working set of long
  // imports in memory and avoids re-reading hot index pages from disk.
  db.pragma('cache_size = -262144')
  // 256 MiB mmap window for read-side; cheap on macOS/Linux and lets SQLite
  // skip pread() syscalls when pages are already paged in.
  db.pragma('mmap_size = 268435456')
  // Keep temp btrees (used by FTS5 merges, large IN lists) in RAM.
  db.pragma('temp_store = MEMORY')
  // Default 1000 pages (~4 MiB) causes a WAL checkpoint every few hundred
  // INSERTs during compile; bump to ~80 MiB so checkpoints don't interrupt
  // the steady-state write loop.
  db.pragma('wal_autocheckpoint = 20000')
  return db
}

export function closeDb(db: Db): void {
  db.close()
}

const stmtCache = new WeakMap<Db, Map<string, Statement>>()

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
  let cache = stmtCache.get(db)
  if (!cache) {
    cache = new Map()
    stmtCache.set(db, cache)
  }
  let stmt = cache.get(sql)
  if (!stmt) {
    stmt = db.prepare(sql)
    cache.set(sql, stmt)
  }
  return stmt as Statement<TParams, TRow>
}

export function transactional<T>(db: Db, fn: () => T): T {
  const wrapped = db.transaction(fn)
  return wrapped()
}
