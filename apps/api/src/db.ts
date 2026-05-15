import type { PGlite } from '@electric-sql/pglite'
import { type PgliteDatabase, drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { type PostgresJsDatabase, drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export type ProsaDatabase = PostgresJsDatabase | PgliteDatabase
export type ExecutableSqlClient = { exec: (sql: string) => Promise<unknown> }

/** Parameterized SQL accessor. Returns rows in object form. */
export type RawExec = <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>

export type DatabaseHandle = {
  db: ProsaDatabase
  raw: ExecutableSqlClient
  rawExec: RawExec
  close: () => Promise<void>
}

export async function openPostgresDatabase(connectionUrl: string): Promise<DatabaseHandle> {
  const client = postgres(connectionUrl, { max: 10, prepare: false })
  const db = drizzlePg(client)
  const rawExec: RawExec = async (sql, params = []) => {
    const result = await client.unsafe(sql, params as never[])
    return Array.from(result) as Array<Record<string, unknown>> as never
  }
  return {
    db,
    raw: {
      exec: async (sql) => {
        await client.unsafe(sql)
      },
    },
    rawExec,
    close: async () => {
      await client.end({ timeout: 5 })
    },
  }
}

export function openPgliteDatabase(client: PGlite): DatabaseHandle {
  const db = drizzlePglite(client)
  const rawExec: RawExec = async <Row = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<Row[]> => {
    const result = await client.query<Row>(sql, params)
    return result.rows
  }
  return {
    db,
    raw: { exec: (sql) => client.exec(sql) },
    rawExec,
    close: async () => {
      await client.close()
    },
  }
}
