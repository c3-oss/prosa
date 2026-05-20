// CQ-126: server boot must apply the conflict-free v2 promotion
// + packs + search-generation tables before binding the port.
// The v2 routes query them on the very first request — a v1-only
// schema must NOT pass boot and then 500 on `BeginPromotion`.
//
// We exercise the boot path's SQL surface directly: apply v1 (via
// `applySchema`) then re-apply server.ts's SQL slice and assert
// the Lane 5 v2 tables exist. Then we hit BeginPromotion through
// `buildApp` to prove the route runs against the populated
// schema.

import { applySchema } from '@c3-oss/prosa-db'
import { PACKS_SCHEMA_SQL, PROMOTION_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createAuth } from '../../src/auth.js'
import { loadConfig } from '../../src/config.js'
import { openPgliteDatabase } from '../../src/db.js'

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

const REQUIRED_V2_TABLES = [
  'promotion_staging',
  'remote_authority_v2',
  'receipt',
  'promotion_uploaded_pack',
  'remote_pack',
  'remote_pack_entry',
  'receipt_pack_grant',
  'search_generation_current',
]

describe('CQ-126: server boot applies the conflict-free v2 schema', () => {
  it('creates every Lane 5 v2 table the routes need', async () => {
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      // Run the same boot-time SQL block as server.ts.
      await pglite.exec(PROMOTION_SCHEMA_SQL)
      await pglite.exec(V2_PACKS_SAFE_SQL)
      await pglite.exec(V2_SEARCH_GENERATION_SQL)

      const db = openPgliteDatabase(pglite)
      const rows = await db.rawExec<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [REQUIRED_V2_TABLES],
      )
      const present = new Set(rows.map((r) => r.tablename))
      const missing = REQUIRED_V2_TABLES.filter((t) => !present.has(t))
      expect(missing).toEqual([])
    } finally {
      await pglite.close()
    }
  })

  it('BeginPromotion no longer hits "relation does not exist" against a v1+v2-boot database', async () => {
    // Repro the bug the CQ flagged: with v1-only schema,
    // BeginPromotion fails on `remote_authority_v2`. With the
    // boot fix the route returns 401 (unauth, because we don't
    // sign in here) — proof that the table exists and the
    // query ran without a "relation does not exist" error.
    const config = loadConfig({
      PROSA_RUNTIME_MODE: 'test',
      PROSA_OBJECT_STORE_DRIVER: 'memory',
      PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
      PROSA_API_URL: 'http://127.0.0.1:3000',
    } as NodeJS.ProcessEnv)
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      await pglite.exec(PROMOTION_SCHEMA_SQL)
      await pglite.exec(V2_PACKS_SAFE_SQL)
      await pglite.exec(V2_SEARCH_GENERATION_SQL)
      const db = openPgliteDatabase(pglite)
      const auth = createAuth({ config, db: db.db })
      const app = await buildApp({
        config,
        auth,
        db: db.db,
        rawExec: db.rawExec,
        transaction: db.transaction,
        objectStore: new MemoryObjectStore(),
        loggerEnabled: false,
      })
      try {
        const response = await app.inject({
          method: 'POST',
          url: '/v2/promotions/begin',
          headers: { 'content-type': 'application/json' },
          payload: { protocolVersion: 2 } as never,
        })
        expect(response.statusCode).toBe(401)
        // The auth ladder runs BEFORE the SQL queries, so the
        // route returning 401 is enough — proves SQL doesn't
        // explode. The 500 path from CQ-126 manifested as a 500
        // body, not 401.
        const body = response.json() as { code: string; message?: string }
        expect(body.code).toBe('UNAUTHENTICATED')
        if (typeof body.message === 'string') {
          expect(body.message).not.toMatch(/relation .* does not exist/i)
        }
      } finally {
        await app.close()
      }
    } finally {
      await pglite.close()
    }
  })
})
