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
// shapes don't have. The conflict-free subset applied here keeps
// the v1 shapes intact so legacy tRPC routes (sync.commit,
// sync.verifyPromotion, reads-v0.*) keep working against existing
// projection rows.
//
// G7 cutover lives in a dedicated helper (`applyV2ProjectionCutover`,
// below) that production boot calls separately. Tests that exercise
// only the v2 surface call `applySchemaV2` directly; tests that
// exercise legacy v1 routes go through `applyV2PromotionSubsetSchema`
// and skip the cutover so v1 paths keep their v1 projection shape.
//
// What the subset creates:
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

// G7 cutover: drop v1 projection_* tables before applying v2
// `PROJECTION_SCHEMA_SQL`. v1 left these empty (CQ-124 documents
// the constraint), so the drop is safe on fresh deploys and on
// Lane 5 deployments alike. `IF EXISTS` keeps the call
// idempotent: a fresh database with no v1 tables proceeds
// silently; a re-applied cutover is also a no-op because the v2
// `CREATE TABLE IF NOT EXISTS` skips already-present tables.
//
// Owned by `applyV2ProjectionCutover` (below). The subset never
// runs this drop so legacy tRPC routes (sync.commit,
// sync.verifyPromotion, reads-v0.*) keep working in tests that
// exercise the v1 path.
const DROP_V1_PROJECTION_TABLES_SQL = `
DROP TABLE IF EXISTS projection_session CASCADE;
DROP TABLE IF EXISTS projection_message CASCADE;
DROP TABLE IF EXISTS projection_tool_call CASCADE;
DROP TABLE IF EXISTS projection_tool_result CASCADE;
DROP TABLE IF EXISTS projection_event CASCADE;
DROP TABLE IF EXISTS projection_content_block CASCADE;
DROP TABLE IF EXISTS projection_artifact CASCADE;
DROP TABLE IF EXISTS projection_edge CASCADE;
DROP TABLE IF EXISTS projection_project CASCADE;
DROP TABLE IF EXISTS projection_turn CASCADE;
`

// CQ-124 + Lane 9: `projection_source_file` and
// `projection_raw_record` exist only in v2 (the v1 schema has neither
// table). The migration flow needs them when re-projecting a tenant,
// so the conflict-free subset applies them explicitly. The rest of
// `projection_*` stays v1-owned until the cutover runs.
const PROJECTION_V2_ONLY_SQL = `
CREATE TABLE IF NOT EXISTS projection_source_file (
  tenant_id        TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  source_tool      TEXT NOT NULL,
  path             TEXT NOT NULL,
  file_kind        TEXT NOT NULL,
  content_hash     TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  pack_digest      TEXT NOT NULL,
  payload          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, source_file_id)
);
CREATE TABLE IF NOT EXISTS projection_raw_record (
  tenant_id        TEXT NOT NULL,
  raw_record_id    TEXT NOT NULL,
  source_file_id   TEXT NOT NULL,
  record_kind      TEXT NOT NULL,
  ordinal          INTEGER,
  content_hash     TEXT NOT NULL,
  object_id        TEXT NOT NULL,
  payload          JSONB NOT NULL,
  PRIMARY KEY (tenant_id, raw_record_id)
);
`

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
  await execSql(client, PROJECTION_V2_ONLY_SQL)
}

/**
 * G7 cutover — drop the v1 projection tables (and their FK cascade)
 * and apply the full v2 `PROJECTION_SCHEMA_SQL`. After this runs,
 * the v2 `read --authority remote` endpoints can serve rows from
 * `projection_session` etc. with their `store_id` + `receipt_id`
 * columns intact.
 *
 * Production boot calls this AFTER `applyV2PromotionSubsetSchema`
 * so the v1 projection rows (empty per CQ-124) are cleared before
 * the v2 shape replaces them. Legacy tRPC test paths that still
 * expect the v1 projection shape skip the cutover — they apply
 * only the subset.
 *
 * Idempotent: the drops are `IF EXISTS` and the v2 schema uses
 * `CREATE TABLE IF NOT EXISTS`, so a re-applied cutover is a no-op
 * once the cutover has run successfully once.
 */
export async function applyV2ProjectionCutover(client: SqlClient): Promise<void> {
  await execSql(client, DROP_V1_PROJECTION_TABLES_SQL)
  await execSql(client, PROJECTION_SCHEMA_SQL)
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
  'receipt_audit_state',
  'search_generation_current',
  'projection_source_file',
  'projection_raw_record',
]

/**
 * G7 cutover — the v2 projection tables created by
 * `applyV2ProjectionCutover`. Production boot includes these in
 * the post-cutover fail-fast gate so a missing table after the
 * drop+create cycle crashes the process before traffic.
 */
export const V2_PROJECTION_CUTOVER_TABLES: readonly string[] = [
  'projection_session',
  'projection_message',
  'projection_tool_call',
  'projection_tool_result',
  'projection_event',
  'projection_content_block',
  'projection_artifact',
  'projection_edge',
  'projection_project',
  'projection_turn',
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
