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

// CQ-124: v1 (`packages/prosa-db`) and v2 (`packages/prosa-db-v2`)
// share four table names with incompatible column sets:
// `device`, `remote_object`, `projection_session`, `search_doc`.
// Running `applySchemaV2` on top of v1 fails because
// `CREATE TABLE IF NOT EXISTS` skips the colliding tables and
// later `CREATE INDEX` statements reference columns the v1
// shapes don't have. Until Lane 10 cutover migrates the v1 rows
// off those names, production + tests apply only the
// CONFLICT-FREE subset of v2 here:
//
// - promotion (`promotion_staging`, `remote_authority_v2`,
//   `receipt`, `legacy_receipt_archive`, `promotion_uploaded_pack`);
// - packs (`remote_pack`, `remote_pack_entry`,
//   `receipt_pack_grant`, `pack_audit_state`, `pack_gc_state`,
//   minus the colliding `remote_object` block);
// - the per-(tenant, store) `search_generation_current` pointer
//   from the search schema. The colliding `search_doc` block
//   stays v1-only.
//
// `device`, `remote_object`, `projection_*`, and `search_doc`
// remain v1-owned for Lane 5; CQ-124 outlines the v1->v2
// migration that Lane 10 will land.
const SEARCH_GENERATION_ONLY_SQL = `
CREATE TABLE IF NOT EXISTS search_generation_current (
  tenant_id              TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  generation_id          TEXT NOT NULL,
  receipt_id             TEXT NOT NULL,
  promoted_at            TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id)
);
ALTER TABLE search_generation_current ADD COLUMN IF NOT EXISTS store_id TEXT;
UPDATE search_generation_current SET store_id = '' WHERE store_id IS NULL;
ALTER TABLE search_generation_current ALTER COLUMN store_id SET NOT NULL;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_index i
      JOIN pg_class c ON c.oid = i.indrelid
     WHERE c.relname = 'search_generation_current'
       AND i.indisprimary
       AND (SELECT count(*) FROM pg_attribute a
              WHERE a.attrelid = c.oid
                AND a.attnum = ANY(i.indkey)) = 1
  ) THEN
    ALTER TABLE search_generation_current DROP CONSTRAINT search_generation_current_pkey;
    ALTER TABLE search_generation_current ADD PRIMARY KEY (tenant_id, store_id);
  END IF;
END;
$$;
`

const PACKS_NO_REMOTE_OBJECT_SQL = PACKS_SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS remote_object[\s\S]*?\);/u, '')

/**
 * Apply the conflict-free subset of the v2 schema on top of the
 * v1 schema. See the comment above for which tables are
 * included / excluded. Idempotent — every CREATE uses
 * `IF NOT EXISTS`, every ALTER uses `IF NOT EXISTS` or a guarded
 * DO block.
 *
 * The caller is responsible for running `applySchema` (v1)
 * first; this helper assumes v1 already exists in the database.
 */
export async function applyV2PromotionSubsetSchema(client: SqlClient): Promise<void> {
  await execSql(client, PROMOTION_SCHEMA_SQL)
  await execSql(client, PACKS_NO_REMOTE_OBJECT_SQL)
  await execSql(client, SEARCH_GENERATION_ONLY_SQL)
}

/**
 * Tables the conflict-free subset creates. Production boot uses
 * this list as a fail-fast gate after applying the subset.
 */
export const V2_PROMOTION_SUBSET_TABLES: readonly string[] = [
  'promotion_staging',
  'remote_authority_v2',
  'receipt',
  'legacy_receipt_archive',
  'legacy_v1_source_files',
  'legacy_v1_migration_gap',
  'promotion_uploaded_pack',
  'remote_pack',
  'remote_pack_entry',
  'receipt_pack_grant',
  'pack_audit_state',
  'pack_gc_state',
  'search_generation_current',
]

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
