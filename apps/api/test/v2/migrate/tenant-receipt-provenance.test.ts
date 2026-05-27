// Lane 9 — CQ-160 server-owned receipt provenance.
//
// `POST /v2/migrate/tenant` previously accepted a `serverRegion` value
// in the body and signed it into the migration receipt. A tenant admin
// could therefore obtain a valid signature over false server provenance.
//
// The route now rejects any request that sets `serverRegion` and signs
// the receipt with the server-configured region (or the default
// `'local'` when no config override is set).

import { describe, expect, it } from 'vitest'

import { buildTestApp } from '../../helpers/test-app.js'
import { seedLegacyCodexSource, signupWithTenant } from './helpers.js'

describe('POST /v2/migrate/tenant: CQ-160 receipt provenance', () => {
  it('rejects body-supplied serverRegion with 400 INVALID_REQUEST', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'provenance@example.com', 'ProvCo', 'provco')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
          'x-prosa-tenant-id': auth.tenant.id,
        },
        payload: { tenantId: auth.tenant.id, serverRegion: 'us-east-1' },
      })
      expect(response.statusCode).toBe(400)
      const body = response.json() as { code: string; message: string }
      expect(body.code).toBe('INVALID_REQUEST')
      expect(body.message).toMatch(/serverRegion/i)
    } finally {
      await t.close()
    }
  })

  it('signs the receipt with the server-configured region only', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'prov2@example.com', 'Prov2Co', 'prov2co')
      const tenantId = auth.tenant.id
      const storeId = 'store-provenance'
      await seedLegacyCodexSource({
        t,
        tenantId,
        storeId,
        sessionId: 'sess_codex_provenance',
        storageKey: `tenants/${tenantId}/v1/objects/prov.zst`,
      })

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/migrate/tenant',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${auth.token}`,
          'x-prosa-tenant-id': tenantId,
        },
        // No serverRegion field — the request is accepted.
        payload: { tenantId, storeId },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { receiptId: string }

      const rows = await t.db.rawExec<{ payload: { serverRegion: string } }>(
        `SELECT payload FROM receipt WHERE receipt_id = $1`,
        [body.receiptId],
      )
      expect(rows).toHaveLength(1)
      // Test app does not set a custom region; default is `'local'`.
      expect(rows[0]!.payload.serverRegion).toBe('local')
    } finally {
      await t.close()
    }
  })
})
