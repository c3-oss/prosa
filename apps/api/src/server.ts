import { applySchema } from '@c3-oss/prosa-db'
import { buildApp } from './app.js'
import { createAuth } from './auth.js'
import { loadConfig } from './config.js'
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
