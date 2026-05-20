import { applySchema } from '@c3-oss/prosa-db'
import { PACKS_SCHEMA_SQL, PROMOTION_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { loadConfig } from './config.js'
import { openPostgresDatabase } from './db.js'
import { createObjectStore } from './storage.js'

// CQ-126: the conflict-free subset of the v2 schema needed for
// Lane 5 promotion + receipts + packs. v1 + v2 share the names
// `projection_session`, `search_doc`, `remote_object`, `device`
// — those collide on column sets and are tracked separately in
// CQ-124. The slice below is safe to apply on top of v1; the
// `remote_object` block is stripped because v1 already owns
// that name.
const V2_PACKS_SAFE_SQL = PACKS_SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS remote_object[\s\S]*?\);/u, '')
const V2_SEARCH_GENERATION_SQL = `
CREATE TABLE IF NOT EXISTS search_generation_current (
  tenant_id              TEXT NOT NULL,
  store_id               TEXT NOT NULL,
  generation_id          TEXT NOT NULL,
  receipt_id             TEXT NOT NULL,
  promoted_at            TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, store_id)
);
`

export async function startServer(): Promise<void> {
  const config = loadConfig()
  if (!config.databaseUrl) {
    throw new Error('PROSA_DATABASE_URL is required to start the server')
  }
  const dbHandle = await openPostgresDatabase(config.databaseUrl)

  // Apply (or no-op verify) the prosa schema before binding the port. The
  // bootstrap is idempotent — every CREATE statement is `IF NOT EXISTS`. In
  // production, drizzle-kit migrations should be the primary path; the
  // bootstrap remains a safety net so the API never accepts traffic against
  // an empty database.
  await applySchema(dbHandle.raw)
  // CQ-126: apply the conflict-free v2 promotion + packs + search
  // generation tables so BeginPromotion/UploadSegment/Upload-
  // ObjectPack/SealPromotion/GetReceipt/GetPromotionStatus don't
  // hit "relation does not exist" at runtime. The full v2 schema
  // still collides with v1 on (projection_session, search_doc,
  // remote_object, device); CQ-124 owns that migration. Until
  // then, only the safe slice ships with production boot.
  await dbHandle.raw.exec(PROMOTION_SCHEMA_SQL)
  await dbHandle.raw.exec(V2_PACKS_SAFE_SQL)
  await dbHandle.raw.exec(V2_SEARCH_GENERATION_SQL)

  // Spot-check that the bootstrap created the required tables before we let
  // any traffic through. If a key table is missing, fail fast.
  const requiredTables = [
    'user',
    'session',
    'organization',
    'member',
    'device',
    'sync_batch',
    'sync_commit_idempotency',
    'remote_object',
    'remote_blob',
    'remote_object_location',
    'tenant_object',
    'projection_session',
    'search_doc',
    // CQ-126: v2 promotion surface.
    'promotion_staging',
    'remote_authority_v2',
    'receipt',
    'promotion_uploaded_pack',
    'remote_pack',
    'remote_pack_entry',
    'receipt_pack_grant',
    'search_generation_current',
  ] as const
  const found = await dbHandle.rawExec<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
    [requiredTables as unknown as string[]],
  )
  const presentNames = new Set(found.map((row) => row.tablename))
  const missing = requiredTables.filter((name) => !presentNames.has(name))
  if (missing.length > 0) {
    throw new Error(
      `Schema verification failed: missing required tables: ${missing.join(', ')}. Run drizzle-kit migrations or ensure the bootstrap SQL applied successfully.`,
    )
  }

  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = createObjectStore(config)
  const app = await buildApp({
    config,
    auth,
    db: dbHandle.db,
    rawExec: dbHandle.rawExec,
    transaction: dbHandle.transaction,
    objectStore,
  })
  await app.listen({ host: config.host, port: config.port })
}
