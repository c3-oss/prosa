import type { Db } from '../db.js'
import { SQL_001_INIT } from './sql/001_init.js'
import { SQL_002_SEARCH_INDEX_STATUS } from './sql/002_search_index_status.js'
import { SQL_003_ANALYTICS_VIEWS } from './sql/003_analytics_views.js'
import { SQL_004_TANTIVY_CHECKPOINT } from './sql/004_tantivy_checkpoint.js'
import { SQL_005_OBJECT_TRANSPORT_HASH } from './sql/005_object_transport_hash.js'
import { SQL_006_MESSAGE_RAW_RECORD_INDEX } from './sql/006_message_raw_record_index.js'
import { SQL_007_PROJECTION_FK_INDEXES } from './sql/007_projection_fk_indexes.js'

/**
 * One immutable schema migration entry.
 *
 * The `version` is the durable ordering key stored in `_prosa_migrations`;
 * `sql` may contain multiple DDL/DML statements.
 */
interface Migration {
  version: number
  name: string
  sql: string
}

/**
 * Ordered migration list applied to every opened bundle.
 *
 * Each entry is a self-contained set of DDL statements run inside a single
 * transaction together with its bookkeeping insert.
 */
const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: SQL_001_INIT },
  { version: 2, name: 'search_index_status', sql: SQL_002_SEARCH_INDEX_STATUS },
  { version: 3, name: 'analytics_views', sql: SQL_003_ANALYTICS_VIEWS },
  { version: 4, name: 'tantivy_checkpoint', sql: SQL_004_TANTIVY_CHECKPOINT },
  { version: 5, name: 'object_transport_hash', sql: SQL_005_OBJECT_TRANSPORT_HASH },
  { version: 6, name: 'message_raw_record_index', sql: SQL_006_MESSAGE_RAW_RECORD_INDEX },
  { version: 7, name: 'projection_fk_indexes', sql: SQL_007_PROJECTION_FK_INDEXES },
]

/** Result returned after running schema migrations. */
export interface MigrationResult {
  /** Migration versions applied during this call. */
  applied: number[]
}

/**
 * Apply all unapplied schema migrations and return the versions newly applied.
 *
 * The migrations table is created on demand. Each migration either fully
 * applies with its bookkeeping row or rolls back through SQLite's transaction
 * machinery; errors propagate to the caller.
 */
export function runMigrations(db: Db): MigrationResult {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _prosa_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `)

  const applied = new Set<number>(
    db
      .prepare<[], { version: number }>(`SELECT version FROM _prosa_migrations`)
      .all()
      .map((row) => row.version),
  )

  const newlyApplied: number[] = []

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const tx = db.transaction(() => {
      db.exec(migration.sql)
      db.prepare(`INSERT INTO _prosa_migrations(version, name, applied_at) VALUES (?, ?, ?)`).run(
        migration.version,
        migration.name,
        new Date().toISOString(),
      )
    })
    tx()
    newlyApplied.push(migration.version)
  }

  return { applied: newlyApplied }
}

/**
 * Read the highest applied schema version from the database.
 *
 * Returns 0 for an uninitialized database or if migration metadata cannot be
 * queried yet.
 */
export function currentSchemaVersion(db: Db): number {
  try {
    const row = db
      .prepare<[], { version: number | null }>(`SELECT MAX(version) AS version FROM _prosa_migrations`)
      .get()
    return row?.version ?? 0
  } catch {
    return 0
  }
}
