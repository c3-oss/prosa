// Lane 8 — hourly audit detects a missing pack.
//
// Seeds a `remote_pack` row, deletes the underlying object from the
// memory store to simulate an S3-side drop, runs the hourly cron, and
// asserts:
//   - `pack_audit_state.status` flipped to `quarantined`.
//   - The receipt that grants the pack is upserted into
//     `receipt_audit_state` with status `degraded`.
//   - `prosa.audit.pack_missing` metric was emitted once.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAuditCron } from '../../../src/cron/audit.js'
import {
  type CronTestHarness,
  buildCronTestHarness,
  putPackBytes,
  seedReceiptGrant,
  seedRemotePack,
} from './helpers.js'

describe('Lane 8 audit hourly — missing pack detection', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('quarantines a pack whose bytes vanished and degrades affected receipts', async () => {
    const tenantId = 't_audit_a'
    const packDigest = 'pack_audit_a'
    const receiptId = 'rcp_audit_a'

    // Seed the catalog row plus an authoritative grant.
    const storageUri = await seedRemotePack(h, { tenantId, packDigest, byteLength: 100 })
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId })
    // Seed bytes, then delete them to mimic a missing S3 object.
    await putPackBytes(h.store, storageUri, new Uint8Array(100))
    await h.store.delete(storageUri)

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-hourly']()

    const audit = await h.rawExec<{ status: string; error: unknown }>(
      `SELECT status, error FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.status).toBe('quarantined')

    const receiptAudit = await h.rawExec<{ status: string; affected_pack_count: number }>(
      `SELECT status, affected_pack_count FROM receipt_audit_state WHERE receipt_id = $1`,
      [receiptId],
    )
    expect(receiptAudit).toHaveLength(1)
    expect(receiptAudit[0]!.status).toBe('degraded')
    expect(Number(receiptAudit[0]!.affected_pack_count)).toBeGreaterThanOrEqual(1)

    const events = h.metrics.events.filter((e) => e.name === 'prosa.audit.pack_missing')
    expect(events).toHaveLength(1)
    expect(events[0]!.tags.tenantId).toBe(tenantId)
  })
})
