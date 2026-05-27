import { applySchema } from '@c3-oss/prosa-db'
import {
  V2_PROJECTION_CUTOVER_TABLES,
  V2_PROMOTION_SUBSET_TABLES,
  applyV2ProjectionCutover,
  applyV2PromotionSubsetSchema,
} from '@c3-oss/prosa-db-v2'
import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { loadConfig } from './config.js'
import { NOOP_METRICS, intervalScheduler, startProsaCron } from './cron/wire.js'
import { openPostgresDatabase } from './db.js'
import { createObjectStore } from './storage.js'

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
  // G7 cutover: `applySchema` (v1) re-creates `projection_session`
  // with the v1 column set and follows up with
  // `CREATE INDEX … (started_at)`. After the cutover has run, the
  // table holds the v2 shape (no `started_at`), so re-applying v1
  // on a subsequent boot would crash on the index step. Probe for
  // the cutover marker (a v2-only column) and skip v1 schema when
  // the cutover is already in place — the v1 tables it would
  // otherwise create live unchanged in the database from the
  // first-ever boot.
  const cutoverProbe = await dbHandle.rawExec<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'projection_session'
          AND column_name = 'store_id'
     ) AS exists`,
  )
  const cutoverAlreadyApplied = cutoverProbe[0]?.exists === true
  if (!cutoverAlreadyApplied) {
    await applySchema(dbHandle.raw)
  }
  // CQ-126: apply the conflict-free v2 promotion + packs +
  // search-generation tables so the Lane 5 routes don't 500 on
  // "relation does not exist" at runtime. CQ-124's full v1 → v2
  // migration is the Lane 10 cutover applied right after.
  await applyV2PromotionSubsetSchema(dbHandle.raw)
  // G7 cutover: drop v1 projection_* tables (empty per CQ-124)
  // and create the v2 projection schema so `read --authority remote`
  // and seal-promotion materialization have the columns they need.
  // Test-app skips this so legacy tRPC routes still see v1 shape.
  await applyV2ProjectionCutover(dbHandle.raw)

  // Spot-check that the bootstrap created the required tables before we let
  // any traffic through. If a key table is missing, fail fast.
  // CQ-124: the v2 surface is sourced from the canonical
  // `V2_PROMOTION_SUBSET_TABLES` export so the list cannot drift
  // from the SQL the subset helper actually applies.
  const v1RequiredTables = [
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
    'search_doc',
  ] as const
  const requiredTables = [
    ...v1RequiredTables,
    ...V2_PROMOTION_SUBSET_TABLES,
    ...V2_PROJECTION_CUTOVER_TABLES,
  ] as readonly string[]
  const found = await dbHandle.rawExec<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
    [requiredTables],
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

  // CQ-156: wire the Lane 8 audit + GC cron handlers into the
  // Fastify lifecycle. The handle is cancelled on `app.close()` so
  // background ticks never outlive the HTTP server. The audit/GC
  // bodies acquire a Postgres advisory lock per tick, so it is safe
  // to run the scheduler on every fleet worker.
  if (config.cronEnabled) {
    const cron = startProsaCron({
      rawExec: dbHandle.rawExec,
      transaction: dbHandle.transaction,
      objectStore,
      logger: app.log,
      metrics: NOOP_METRICS,
      scheduler: intervalScheduler(config.cronIntervalMs),
    })
    app.addHook('onClose', async () => {
      cron.cancel()
    })
  }

  await app.listen({ host: config.host, port: config.port })
}
