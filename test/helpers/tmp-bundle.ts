import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import type Database from 'better-sqlite3'
import { type Bundle, closeBundle, initBundle } from '../../src/core/bundle.js'

export interface TempBundle {
  bundle: Bundle
  path: string
  cleanup: () => Promise<void>
}

export async function createTempBundle(): Promise<TempBundle> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'prosa-test-'))
  const bundle = await initBundle(dir)
  return {
    bundle,
    path: dir,
    cleanup: async () => {
      closeBundle(bundle)
      await rm(dir, { recursive: true, force: true })
    },
  }
}

/** Run a `SELECT count(*) AS n FROM …` query and return n (0 if missing). */
export function queryCount(db: Database.Database, sql: string, ...params: readonly unknown[]): number {
  const row = db.prepare<unknown[], { n: number }>(sql).get(...params)
  return row?.n ?? 0
}
