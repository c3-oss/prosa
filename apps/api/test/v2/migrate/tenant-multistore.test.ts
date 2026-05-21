// Lane 9 — CQ-159 multi-store migration.
//
// `POST /v2/migrate/tenant` previously wrote one synthetic
// `migration-multi` receipt store id while inserting authority rows
// for each real store. Lane 6 authority refresh joins
// `receipt.store_id` to the requested store, so those rows could not
// resolve. The same synthetic store id meant per-store v1 receipts
// were never archived.
//
// The route now issues one signed v2 receipt per migrated store and
// archives each real store's v1 receipts.

import { describe, expect, it } from 'vitest'

import { buildTestApp } from '../../helpers/test-app.js'
import { ensureLegacyV1ReceiptTable, seedLegacyCodexSource, signupWithTenant } from './helpers.js'

describe('POST /v2/migrate/tenant: CQ-159 multi-store', () => {
  it("issues a resolvable per-store receipt for every migrated store and archives each store's v1 receipts", async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'multi@example.com', 'MultiCo', 'multico')
      const tenantId = auth.tenant.id
      const storeA = 'store-a'
      const storeB = 'store-b'

      await ensureLegacyV1ReceiptTable(t)
      // Seed one v1 receipt per real store.
      await t.db.rawExec(
        `INSERT INTO legacy_v1_receipt (receipt_id, tenant_id, store_id, payload, signature)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb), ($6, $2, $7, $8::jsonb, $5::jsonb)`,
        [
          'rcpt_legacy_a',
          tenantId,
          storeA,
          JSON.stringify({ legacy: true, store: 'a' }),
          JSON.stringify({ algorithm: 'legacy-hmac', value: 'aa' }),
          'rcpt_legacy_b',
          storeB,
          JSON.stringify({ legacy: true, store: 'b' }),
        ],
      )

      await seedLegacyCodexSource({
        t,
        tenantId,
        storeId: storeA,
        sessionId: 'sess_codex_a',
        storageKey: `tenants/${tenantId}/v1/objects/A.zst`,
      })
      await seedLegacyCodexSource({
        t,
        tenantId,
        storeId: storeB,
        sessionId: 'sess_codex_b',
        storageKey: `tenants/${tenantId}/v1/objects/B.zst`,
      })

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
          'x-prosa-tenant-id': tenantId,
        },
        payload: { tenantId },
      })
      if (response.statusCode !== 200) {
        // eslint-disable-next-line no-console
        console.error('migrate failed', response.statusCode, response.body)
      }
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        receiptIdsByStore: Record<string, string>
        storeIds: string[]
        archivedReceiptIds: string[]
      }

      expect(body.storeIds.sort()).toEqual([storeA, storeB].sort())
      expect(body.receiptIdsByStore[storeA]).toMatch(/^rcpt_/)
      expect(body.receiptIdsByStore[storeB]).toMatch(/^rcpt_/)
      expect(body.receiptIdsByStore[storeA]).not.toBe(body.receiptIdsByStore[storeB])

      // remote_authority_v2 has a resolvable row per real store, whose
      // current_receipt_id joins to a `receipt` row with the SAME
      // store_id. Lane 6 authority refresh tuple-matches on store_id,
      // so this is the load-bearing assertion for CQ-159.
      for (const storeId of [storeA, storeB]) {
        // CQ-159 (final review): public `/v2/stores/<store>/authority`
        // must resolve EACH migrated store on its own, not just via
        // raw SQL state. The route joins `remote_authority_v2` to
        // `receipt` on `(tenant_id, current_receipt_id, store_id)`,
        // so a synthetic `migration-multi` receipt id would 404 here.
        const authorityRoute = await t.app.inject({
          method: 'GET',
          url: `/v2/stores/${storeId}/authority`,
          headers: {
            authorization: `Bearer ${auth.token}`,
            'x-prosa-tenant-id': tenantId,
          },
        })
        expect(authorityRoute.statusCode).toBe(200)
        const authBody = authorityRoute.json() as {
          status: string
          receipt?: { payload: { receiptId: string; storeId: string } }
        }
        expect(authBody.status).toBe('updated')
        expect(authBody.receipt?.payload.receiptId).toBe(body.receiptIdsByStore[storeId])
        expect(authBody.receipt?.payload.storeId).toBe(storeId)
      }

      // No synthetic `migration-multi` receipt or authority row exists.
      const synthetic = await t.db.rawExec<{ receipt_id: string }>(
        `SELECT receipt_id FROM receipt WHERE store_id = 'migration-multi'`,
      )
      expect(synthetic).toHaveLength(0)
      const syntheticAuthority = await t.db.rawExec<{ store_id: string }>(
        `SELECT store_id FROM remote_authority_v2 WHERE store_id = 'migration-multi'`,
      )
      expect(syntheticAuthority).toHaveLength(0)

      // CQ-159: each real store's legacy v1 receipts moved into
      // legacy_receipt_archive and removed from the active source.
      expect(body.archivedReceiptIds.sort()).toEqual(['rcpt_legacy_a', 'rcpt_legacy_b'].sort())
      for (const [storeId, legacyId] of [
        [storeA, 'rcpt_legacy_a'],
        [storeB, 'rcpt_legacy_b'],
      ] as const) {
        const stillActive = await t.db.rawExec(`SELECT 1 FROM legacy_v1_receipt WHERE receipt_id = $1`, [legacyId])
        expect(stillActive).toHaveLength(0)
        const archived = await t.db.rawExec<{ store_id: string }>(
          `SELECT store_id FROM legacy_receipt_archive WHERE receipt_id = $1`,
          [legacyId],
        )
        expect(archived).toHaveLength(1)
        expect(archived[0]!.store_id).toBe(storeId)
      }
    } finally {
      await t.close()
    }
  }, 90_000)
})
