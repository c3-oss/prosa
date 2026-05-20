// CQ-126: server boot must apply the conflict-free v2 promotion +
// packs + search-generation tables before binding the port. The v2
// routes query them on the very first request — a v1-only schema
// must NOT pass boot and then 500 on `BeginPromotion`.
//
// Boot now applies that subset via the single canonical helper
// `applyV2PromotionSubsetSchema` exported from `@c3-oss/prosa-db-v2`,
// and the load-bearing table list lives at
// `V2_PROMOTION_SUBSET_TABLES`. This test pins the boot surface; the
// architectural v1/v2 shared-name problem itself remains tracked by
// CQ-124 (the full Lane 10 cutover).

import { applySchema } from '@c3-oss/prosa-db'
import { V2_PROMOTION_SUBSET_TABLES, applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { buildApp } from '../../src/app.js'
import { createAuth } from '../../src/auth.js'
import { loadConfig } from '../../src/config.js'
import { openPgliteDatabase } from '../../src/db.js'
import { type TestApp, buildTestApp } from '../helpers/test-app.js'

async function signupWithTenant(t: TestApp, email: string, tenantName: string, tenantSlug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; user: { id: string; email: string }; tenant: { id: string } } }
    }
  ).result.data
}

describe('CQ-126: server boot applies the conflict-free v2 schema via the canonical helper', () => {
  it('applyV2PromotionSubsetSchema creates every table in V2_PROMOTION_SUBSET_TABLES on a fresh v1 database', async () => {
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      await applyV2PromotionSubsetSchema(pglite)

      const db = openPgliteDatabase(pglite)
      const rows = await db.rawExec<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)`,
        [V2_PROMOTION_SUBSET_TABLES as readonly string[]],
      )
      const present = new Set(rows.map((r) => r.tablename))
      const missing = V2_PROMOTION_SUBSET_TABLES.filter((t) => !present.has(t))
      expect(missing).toEqual([])
    } finally {
      await pglite.close()
    }
  })

  it('re-applying the helper is idempotent (no errors on the second call)', async () => {
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      await applyV2PromotionSubsetSchema(pglite)
      await applyV2PromotionSubsetSchema(pglite)
      // If any CREATE / ALTER / DO block were non-idempotent
      // the second call would throw before we reach this assertion.
      expect(true).toBe(true)
    } finally {
      await pglite.close()
    }
  })

  it('unauthenticated BeginPromotion against a v1+v2-boot database returns 401, not "relation does not exist"', async () => {
    // Repro the original bug surface: with v1-only schema,
    // BeginPromotion fails on `remote_authority_v2`. With boot now
    // applying the conflict-free subset, the unauthenticated route
    // returns 401 — proof the SQL query plan resolves.
    const config = loadConfig({
      PROSA_RUNTIME_MODE: 'test',
      PROSA_OBJECT_STORE_DRIVER: 'memory',
      PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
      PROSA_API_URL: 'http://127.0.0.1:3000',
    } as NodeJS.ProcessEnv)
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      await applyV2PromotionSubsetSchema(pglite)
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

  it('authenticated BeginPromotion against a v1+v2-boot database reaches the v2 query layer cleanly', async () => {
    // The reviewer flagged that a 401 by itself only proves the
    // auth ladder runs before the SQL — it does NOT prove the v2
    // query path executes against the boot-applied schema. Here we
    // sign up a real tenant and drive an authenticated
    // BeginPromotion. A fresh bundle must return `needs_inventory`
    // (200), proving:
    //
    //  - `remote_authority_v2` SELECT in the fast path resolves;
    //  - `promotion_staging` INSERT (race-safe partial unique)
    //    resolves;
    //  - `device` SELECT/UPSERT in `claimDevice` resolves.
    //
    // If any of those tables were missing the route would 500 on
    // "relation does not exist".
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'cq126-boot@example.com', 'AcmeBoot', 'acme-boot-126')
      const FIXTURE_HEX_A = '11'.repeat(32)
      const FIXTURE_HEX_B = '22'.repeat(32)
      const FIXTURE_HEX_C = '33'.repeat(32)
      const FIXTURE_HEX_D = '44'.repeat(32)
      const FIXTURE_HEX_E = '55'.repeat(32)
      const storeId = 'store-cq126'
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: {
          authorization: `Bearer ${account.token}`,
          'content-type': 'application/json',
        },
        payload: {
          protocolVersion: 2,
          tenantId: account.tenant.id,
          storeId,
          storePath: '/home/test/store',
          head: {
            bundleFormat: 2,
            storeId,
            storePath: '/home/test/store',
            epoch: 0,
            parserVersion: '0.1.0',
            createdAt: '2026-05-20T00:00:00.000Z',
            previousBundleRoot: null,
            bundleRoot: FIXTURE_HEX_A,
            rawSourceRoot: FIXTURE_HEX_B,
            manifestDigest: `blake3:${FIXTURE_HEX_C}`,
            counts: {
              sourceFiles: 0,
              rawRecords: 0,
              objects: 0,
              sessions: 1,
              messages: 1,
              events: 0,
              contentBlocks: 0,
              turns: 0,
              toolCalls: 0,
              toolResults: 0,
              artifacts: 0,
              edges: 0,
              searchDocs: 1,
              projectionRows: 2,
            },
            segments: [],
          },
          inventories: {
            objectInventorySegment: {
              segmentId: 'seg-objects-cq126',
              kind: 'inventory_object',
              digest: `blake3:${FIXTURE_HEX_D}`,
              logicalRoot: 'objects/inv',
              compression: 'zstd',
              byteLength: 1024,
            },
            projectionInventorySegment: {
              segmentId: 'seg-projection-cq126',
              kind: 'inventory_projection',
              digest: `blake3:${FIXTURE_HEX_E}`,
              logicalRoot: 'projection/inv',
              compression: 'zstd',
              byteLength: 2048,
            },
          },
          device: { deviceId: 'dev-cq126' },
        } as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { status: string; promotionId?: string }
      expect(body.status).toBe('needs_inventory')
      expect(typeof body.promotionId).toBe('string')

      // A `promotion_staging` row must exist for the authenticated
      // request — proves the boot-applied schema accepts the
      // INSERT path.
      const rows = await t.db.rawExec<{ id: string; status: string }>(
        `SELECT id, status FROM promotion_staging WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(rows.length).toBe(1)
      expect(rows[0]?.id).toBe(body.promotionId)
      expect(rows[0]?.status).toBe('open')
    } finally {
      await t.close()
    }
  })
})
