import type { PGlite } from '@electric-sql/pglite'
import { type PgliteDatabase, drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { type PostgresJsDatabase, drizzle as drizzlePg } from 'drizzle-orm/postgres-js'
import postgres from 'postgres'

export type ProsaDatabase = PostgresJsDatabase | PgliteDatabase
export type ExecutableSqlClient = { exec: (sql: string) => Promise<unknown> }

/** Parameterized SQL accessor. Returns rows in object form. */
export type RawExec = <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>
export type RawTx = RawExec

export type DatabaseHandle = {
  db: ProsaDatabase
  raw: ExecutableSqlClient
  rawExec: RawExec
  transaction: <T>(fn: (tx: RawTx) => Promise<T>) => Promise<T>
  close: () => Promise<void>
}

export async function openPostgresDatabase(connectionUrl: string): Promise<DatabaseHandle> {
  const client = postgres(connectionUrl, { max: 10, prepare: false })
  const db = drizzlePg(client)
  const rawExec: RawExec = async (sql, params = []) => {
    const result = await client.unsafe(sql, params as never[])
    return Array.from(result) as Array<Record<string, unknown>> as never
  }
  const transaction = async <T>(fn: (tx: RawTx) => Promise<T>): Promise<T> => {
    const result = await client.begin(async (txClient) => {
      const txExec: RawExec = async (sql, params = []) => {
        const result = await txClient.unsafe(sql, params as never[])
        return Array.from(result) as Array<Record<string, unknown>> as never
      }
      return fn(txExec)
    })
    return result as T
  }
  return {
    db,
    raw: {
      exec: async (sql) => {
        await client.unsafe(sql)
      },
    },
    rawExec,
    transaction,
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
  const transaction = async <T>(fn: (tx: RawTx) => Promise<T>): Promise<T> => {
    await client.exec('BEGIN')
    try {
      const result = await fn(rawExec)
      await client.exec('COMMIT')
      return result
    } catch (error) {
      await client.exec('ROLLBACK')
      throw error
    }
  }
  return {
    db,
    raw: { exec: (sql) => client.exec(sql) },
    rawExec,
    transaction,
    close: async () => {
      await client.close()
    },
  }
}
