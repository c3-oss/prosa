// Lane 9 — `legacy_receipt_archive` movement.
//
// Seeds a v1 receipt into a test-only `legacy_v1_receipt` table and
// asserts that after `POST /v2/migrate/tenant` runs:
//   - the row is moved into `legacy_receipt_archive`,
//   - the original row is deleted from `legacy_v1_receipt`,
//   - v2 reads do NOT accept the archived row as authority
//     (`remote_authority_v2` points at the freshly minted v2 receipt
//     instead).

import { describe, expect, it } from 'vitest'

import { buildTestApp } from '../../helpers/test-app.js'
import { ensureLegacyV1ReceiptTable, seedLegacyCodexSource, signupWithTenant } from './helpers.js'

describe('migrate-tenant: legacy receipts archived', () => {
  it('moves v1 receipts to legacy_receipt_archive and points authority at the new v2 receipt', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'archive@example.com', 'ArchiveCo', 'archive')
      const tenantId = auth.tenant.id
      const storeId = 'store-archive'

      await ensureLegacyV1ReceiptTable(t)
      const legacyReceiptId = 'rcpt_legacy_v1_42'
      await t.db.rawExec(
        `INSERT INTO legacy_v1_receipt (receipt_id, tenant_id, store_id, payload, signature)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [
          legacyReceiptId,
          tenantId,
          storeId,
          JSON.stringify({ legacy: true, receiptId: legacyReceiptId }),
          JSON.stringify({ algorithm: 'legacy-hmac', value: 'deadbeef' }),
        ],
      )

      await seedLegacyCodexSource({
        t,
        tenantId,
        storeId,
        sessionId: 'sess_codex_archive',
        storageKey: `tenants/${tenantId}/v1/objects/archive.zst`,
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
      const body = response.json() as { receiptId: string; archivedReceiptIds: string[] }
      expect(body.archivedReceiptIds).toContain(legacyReceiptId)

      // v1 receipt moved out of the source table.
      const legacy = await t.db.rawExec<{ receipt_id: string }>(
        `SELECT receipt_id FROM legacy_v1_receipt WHERE receipt_id = $1`,
        [legacyReceiptId],
      )
      expect(legacy).toHaveLength(0)

      // v1 receipt now in legacy_receipt_archive.
      const archived = await t.db.rawExec<{ receipt_id: string; tenant_id: string; store_id: string }>(
        `SELECT receipt_id, tenant_id, store_id FROM legacy_receipt_archive WHERE receipt_id = $1`,
        [legacyReceiptId],
      )
      expect(archived).toHaveLength(1)
      expect(archived[0]!.tenant_id).toBe(tenantId)
      expect(archived[0]!.store_id).toBe(storeId)

      // remote_authority_v2 points at the new v2 receipt, NOT the legacy one.
      const authority = await t.db.rawExec<{ current_receipt_id: string }>(
        `SELECT current_receipt_id FROM remote_authority_v2 WHERE tenant_id = $1 AND store_id = $2`,
        [tenantId, storeId],
      )
      expect(authority).toHaveLength(1)
      expect(authority[0]!.current_receipt_id).toBe(body.receiptId)
      expect(authority[0]!.current_receipt_id).not.toBe(legacyReceiptId)

      // The legacy receipt id MUST NOT appear in the active `receipt`
      // table — v2 reads only consult that table for authority.
      const activeReceipt = await t.db.rawExec<{ receipt_id: string }>(
        `SELECT receipt_id FROM receipt WHERE receipt_id = $1`,
        [legacyReceiptId],
      )
      expect(activeReceipt).toHaveLength(0)
    } finally {
      await t.close()
    }
  }, 60_000)

  it('records gaps for missing storage and still archives any v1 receipts', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signupWithTenant(t, 'gaps@example.com', 'GapsCo', 'gaps')
      const tenantId = auth.tenant.id
      const storeId = 'store-gaps'

      await ensureLegacyV1ReceiptTable(t)
      const legacyReceiptId = 'rcpt_legacy_v1_gaps'
      await t.db.rawExec(
        `INSERT INTO legacy_v1_receipt (receipt_id, tenant_id, store_id, payload, signature)
         VALUES ($1, $2, $3, $4::jsonb, $5::jsonb)`,
        [legacyReceiptId, tenantId, storeId, JSON.stringify({ legacy: true }), JSON.stringify({})],
      )

      // Insert a legacy source file pointing at a non-existent
      // storage key so the migrator records a gap.
      await t.db.rawExec(
        `INSERT INTO legacy_v1_source_files (
           tenant_id, store_id, source_file_id, source_tool, path, file_kind, content_hash, storage_key
         )
         VALUES ($1, $2, $3, 'codex', '/legacy/missing.jsonl', 'session_jsonl', 'deadbeef', 'missing-key')`,
        [tenantId, storeId, 'sf_missing'],
      )

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
        gaps: Array<{ source_file_id: string; reason: string }>
        archivedReceiptIds: string[]
      }
      expect(body.gaps.length).toBeGreaterThan(0)
      expect(body.gaps[0]!.reason).toBe('raw_bytes_missing')
      expect(body.archivedReceiptIds).toContain(legacyReceiptId)

      // The gap is also persisted to the audit table.
      const persistedGaps = await t.db.rawExec<{ source_file_id: string; reason: string }>(
        `SELECT source_file_id, reason FROM legacy_v1_migration_gap WHERE tenant_id = $1`,
        [tenantId],
      )
      expect(persistedGaps).toHaveLength(1)
      expect(persistedGaps[0]!.reason).toBe('raw_bytes_missing')
    } finally {
      await t.close()
    }
  }, 60_000)
})
