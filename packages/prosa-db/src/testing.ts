import { PGlite } from '@electric-sql/pglite'
import { type PgliteDatabase, drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { applySchema } from './migrate.js'

export type TestDb = {
  client: PGlite
  db: PgliteDatabase
  /** Drop and reapply the schema in-place. */
  reset: () => Promise<void>
  close: () => Promise<void>
}

export async function createTestDb(): Promise<TestDb> {
  const client = new PGlite()
  await applySchema(client)
  const db = drizzlePglite(client)
  return {
    client,
    db,
    async reset() {
      await client.exec('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
      await applySchema(client)
    },
    async close() {
      await client.close()
    },
  }
}
