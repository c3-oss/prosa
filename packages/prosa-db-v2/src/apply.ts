// Boot-time schema application + required-table check.
//
// `applySchemaV2(client)` runs every DDL block in order. All statements
// use `CREATE ... IF NOT EXISTS` so the call is idempotent: re-running
// against the same database produces zero changes.
//
// `assertSchemaV2(client)` queries `information_schema.tables` for every
// load-bearing table and throws when one is missing. The API server
// calls it at boot so a missing migration crashes the process before
// it serves traffic.

import { DEVICES_SCHEMA_SQL } from './schema/devices.js'
import { PACKS_SCHEMA_SQL } from './schema/packs.js'
import { PROJECTION_SCHEMA_SQL } from './schema/projection.js'
import { PROMOTION_SCHEMA_SQL } from './schema/promotion.js'
import { SEARCH_SCHEMA_SQL } from './schema/search.js'

/**
 * Minimal subset of a Postgres client interface used by this package.
 * `pg`, `postgres`, and `@electric-sql/pglite` all conform.
 */
export interface SqlClient {
  /**
   * Execute a SQL string. Implementations may return whatever shape
   * they want; `applySchemaV2` does not consume the result.
   */
  exec?: (sql: string) => Promise<unknown>
  /** `pg`-style `query` helper as a fallback. */
  query?: (sql: string) => Promise<unknown>
}

async function execSql(client: SqlClient, sql: string): Promise<void> {
  if (typeof client.exec === 'function') {
    await client.exec(sql)
    return
  }
  if (typeof client.query === 'function') {
    await client.query(sql)
    return
  }
  throw new Error('applySchemaV2: client must expose exec() or query()')
}

export const SCHEMA_BLOCKS: Array<{ name: string; sql: string }> = [
  { name: 'devices', sql: DEVICES_SCHEMA_SQL },
  { name: 'promotion', sql: PROMOTION_SCHEMA_SQL },
  { name: 'packs', sql: PACKS_SCHEMA_SQL },
  { name: 'projection', sql: PROJECTION_SCHEMA_SQL },
  { name: 'search', sql: SEARCH_SCHEMA_SQL },
]

export async function applySchemaV2(client: SqlClient): Promise<void> {
  for (const block of SCHEMA_BLOCKS) {
    await execSql(client, block.sql)
  }
}

/**
 * Tables that must exist for the API server to boot. Missing any of
 * these implies an incomplete migration; the server refuses to start.
 */
export const REQUIRED_TABLES: readonly string[] = [
  'device',
  'promotion_staging',
  'remote_authority_v2',
  'receipt',
  'remote_pack',
  'remote_pack_entry',
  'remote_object',
  'receipt_pack_grant',
  'projection_session',
  'projection_message',
  'projection_tool_call',
  'projection_tool_result',
  'projection_event',
  'projection_content_block',
  'projection_artifact',
  'projection_edge',
  'projection_project',
  'projection_raw_record',
  'projection_source_file',
  'projection_turn',
  'search_doc',
  'search_generation_current',
]

export class SchemaCheckError extends Error {
  override name = 'SchemaCheckError'
  constructor(public readonly missing: readonly string[]) {
    super(`schema check failed: missing tables ${missing.join(', ')}`)
  }
}

/**
 * Query `information_schema.tables` for every required table. Throws
 * `SchemaCheckError` listing the missing ones. The result rows shape
 * varies by driver; this helper expects a `rows` array of
 * `{ table_name: string }` objects.
 */
export async function assertSchemaV2(client: {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Array<{ table_name?: string }> }>
}): Promise<void> {
  const result = await client.query(
    'SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema()',
    [],
  )
  const present = new Set<string>()
  for (const row of result.rows) {
    if (row.table_name) present.add(row.table_name)
  }
  const missing = REQUIRED_TABLES.filter((t) => !present.has(t))
  if (missing.length > 0) throw new SchemaCheckError(missing)
}
