import type { PGlite } from '@electric-sql/pglite'
import { type PgliteDatabase, drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { type PostgresJsDatabase, drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export type ProsaDatabase = PostgresJsDatabase | PgliteDatabase
export type ExecutableSqlClient = { exec: (sql: string) => Promise<unknown> }

export type DatabaseHandle = {
  db: ProsaDatabase
  raw: ExecutableSqlClient
  close: () => Promise<void>
}

export async function openPostgresDatabase(connectionUrl: string): Promise<DatabaseHandle> {
  const client = postgres(connectionUrl, { max: 10, prepare: false })
  const db = drizzlePg(client)
  return {
    db,
    raw: {
      exec: async (sql) => {
        await client.unsafe(sql)
      },
    },
    close: async () => {
      await client.end({ timeout: 5 })
    },
  }
}

export function openPgliteDatabase(client: PGlite): DatabaseHandle {
  const db = drizzlePglite(client)
  return {
    db,
    raw: { exec: (sql) => client.exec(sql) },
    close: async () => {
      await client.close()
    },
  }
}
