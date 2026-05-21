import { applySchema } from '@c3-oss/prosa-db'
import { V2_PROMOTION_SUBSET_TABLES, applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
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
  await applySchema(dbHandle.raw)
  // CQ-126: apply the conflict-free v2 promotion + packs +
  // search-generation tables so the Lane 5 routes don't 500 on
  // "relation does not exist" at runtime. CQ-124's full v1 → v2
  // migration is the Lane 10 cutover; until then this is the
  // canonical safe subset.
  await applyV2PromotionSubsetSchema(dbHandle.raw)

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
    'projection_session',
    'search_doc',
  ] as const
  const requiredTables = [...v1RequiredTables, ...V2_PROMOTION_SUBSET_TABLES] as readonly string[]
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
