import { applySchema } from '@c3-oss/prosa-db'
import { PROMOTION_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import type { FastifyInstance } from 'fastify'
import { buildApp } from '../../src/app.js'
import { type ProsaAuth, createAuth } from '../../src/auth.js'
import { type ProsaApiConfig, loadConfig } from '../../src/config.js'
import { type DatabaseHandle, openPgliteDatabase } from '../../src/db.js'

export type TestApp = {
  app: FastifyInstance
  auth: ProsaAuth
  config: ProsaApiConfig
  db: DatabaseHandle
  pglite: PGlite
  objectStore: MemoryObjectStore
  close: () => Promise<void>
}

export async function buildTestApp(overrides: Partial<NodeJS.ProcessEnv> = {}): Promise<TestApp> {
  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:3000',
    ...overrides,
  } as NodeJS.ProcessEnv)
  const pglite = new PGlite()
  await applySchema(pglite)
  // v1 + v2 share table names (`projection_session`, `search_doc`,
  // `remote_object`, `device`) with incompatible column sets, so we
  // can't blanket-apply `applySchemaV2` on top of v1. Lane 10 cutover
  // handles the production migration. For Lane 5 tests we need the v2
  // promotion tables (`promotion_staging`, `remote_authority_v2`,
  // `receipt`, `legacy_receipt_archive`), which do not collide with v1.
  await pglite.exec(PROMOTION_SCHEMA_SQL)
  const db = openPgliteDatabase(pglite)
  const auth = createAuth({ config, db: db.db })
  const objectStore = new MemoryObjectStore()
  const app = await buildApp({
    config,
    auth,
    db: db.db,
    rawExec: db.rawExec,
    transaction: db.transaction,
    objectStore,
    loggerEnabled: false,
  })
  return {
    app,
    auth,
    config,
    db,
    pglite,
    objectStore,
    close: async () => {
      await app.close()
      await pglite.close()
    },
  }
}
