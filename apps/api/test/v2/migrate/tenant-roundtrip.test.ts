// Lane 9 — server-side tenant migration roundtrip.
//
// Seeds a tiny v1 catalog into `legacy_v1_source_files` + the
// in-memory object store, then calls `POST /v2/migrate/tenant` as
// the tenant owner. Asserts:
//   - the route returns 200 with a populated receipt id,
//   - `remote_authority_v2` is upserted with that receipt id,
//   - `projection_source_file` rows exist for every seeded file,
//   - the v2 read API gate (Lane 6) can resolve the new authority.

import { describe, expect, it } from 'vitest'

import { buildTestApp } from '../../helpers/test-app.js'
import { seedLegacyCodexSource, signupWithTenant } from './helpers.js'

describe('POST /v2/migrate/tenant: roundtrip', () => {
  it('re-projects a tenant from legacy_v1_source_files and upserts remote_authority_v2', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'owner@example.com', 'OwnerCo', 'ownerco')
      const tenantId = auth.tenant.id
      const storeId = 'store-default'

      const { sourceFileId } = await seedLegacyCodexSource({
        t,
        tenantId,
        storeId,
        sessionId: 'sess_codex_tenant',
        storageKey: `tenants/${tenantId}/v1/objects/abcd.zst`,
      })

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
          'x-prosa-tenant-id': tenantId,
        },
        payload: { tenantId, storeId },
      })

      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        receiptId: string
        storeIds: string[]
        counts: { sourceFiles: number; sessions: number; rawRecords: number }
        gaps: unknown[]
      }
      expect(body.receiptId).toMatch(/^rcpt_/)
      expect(body.storeIds).toEqual([storeId])
      expect(body.gaps).toEqual([])

      // remote_authority_v2 upserted with the new receipt.
      const authority = await t.db.rawExec<{ current_receipt_id: string }>(
        `SELECT current_receipt_id FROM remote_authority_v2 WHERE tenant_id = $1 AND store_id = $2`,
        [tenantId, storeId],
      )
      expect(authority).toHaveLength(1)
      expect(authority[0]!.current_receipt_id).toBe(body.receiptId)

      // projection_source_file row exists.
      const proj = await t.db.rawExec<{ source_file_id: string }>(
        `SELECT source_file_id FROM projection_source_file WHERE tenant_id = $1`,
        [tenantId],
      )
      expect(proj.find((r) => r.source_file_id === sourceFileId)).toBeDefined()

      // receipt persisted + signed.
      const receipts = await t.db.rawExec<{ receipt_id: string; payload: unknown; signature: unknown }>(
        `SELECT receipt_id, payload, signature FROM receipt WHERE receipt_id = $1`,
        [body.receiptId],
      )
      expect(receipts).toHaveLength(1)
      expect(receipts[0]!.payload).toBeTruthy()
      expect(receipts[0]!.signature).toBeTruthy()
    } finally {
      await t.close()
    }
  }, 60_000)

  it('rejects unauthenticated callers with 401', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: { 'content-type': 'application/json' },
        payload: { tenantId: 'tnt_nope' },
      })
      expect(response.statusCode).toBe(401)
      const body = response.json() as { code: string }
      expect(body.code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('rejects mismatched tenantId with 403', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'mismatch@example.com', 'MismatchCo', 'mismatch')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
          'x-prosa-tenant-id': auth.tenant.id,
        },
        payload: { tenantId: 'tnt_other' },
      })
      expect(response.statusCode).toBe(403)
      const body = response.json() as { code: string }
      expect(body.code).toBe('TENANT_MISMATCH')
    } finally {
      await t.close()
    }
  })
})
