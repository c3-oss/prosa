import type { Db } from '../db.js'
import { SQL_001_INIT } from './sql/001_init.js'
import { SQL_002_SEARCH_INDEX_STATUS } from './sql/002_search_index_status.js'
import { SQL_003_ANALYTICS_VIEWS } from './sql/003_analytics_views.js'
import { SQL_004_TANTIVY_CHECKPOINT } from './sql/004_tantivy_checkpoint.js'

interface Migration {
  version: number
  name: string
  sql: string
}

// Order matters. Each entry is a self-contained set of DDL statements run
// inside a single transaction together with its bookkeeping insert.
const MIGRATIONS: readonly Migration[] = [
  { version: 1, name: 'init', sql: SQL_001_INIT },
  { version: 2, name: 'search_index_status', sql: SQL_002_SEARCH_INDEX_STATUS },
  { version: 3, name: 'analytics_views', sql: SQL_003_ANALYTICS_VIEWS },
  { version: 4, name: 'tantivy_checkpoint', sql: SQL_004_TANTIVY_CHECKPOINT },
]

export function runMigrations(db: Db): { applied: number[] } {
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
