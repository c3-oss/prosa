// Lane 8 — hourly audit detects a byte-length mismatch.
//
// The MemoryObjectStore exposes `compressedSize` via `head()`. When
// the catalog row's `byte_length` disagrees with that value, the
// audit cron must flip the pack to `quarantined` and emit
// `prosa.audit.pack_mismatch`.

import { toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerAuditCron } from '../../../src/cron/audit.js'
import {
  type CronTestHarness,
  buildCronTestHarness,
  putPackBytes,
  seedReceiptGrant,
  seedRemotePack,
} from './helpers.js'

describe('Lane 8 audit hourly — byte-length mismatch', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('quarantines a pack whose stored bytes do not match the catalog byte_length', async () => {
    const tenantId = 't_audit_b'
    const packDigest = 'pack_audit_b'
    const receiptId = 'rcp_audit_b'

    // Catalog says the pack is 100 bytes, but we store only 50.
    const storageUri = await seedRemotePack(h, { tenantId, packDigest, byteLength: 100 })
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId })
    await putPackBytes(h.store, storageUri, new Uint8Array(50))

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-hourly']()

    const audit = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.status).toBe('quarantined')

    const receiptAudit = await h.rawExec<{ status: string }>(
      `SELECT status FROM receipt_audit_state WHERE receipt_id = $1`,
      [receiptId],
    )
    expect(receiptAudit[0]!.status).toBe('degraded')

    const events = h.metrics.events.filter((e) => e.name === 'prosa.audit.pack_mismatch')
    expect(events).toHaveLength(1)
    expect(events[0]!.tags.reason).toBe('byte_length_mismatch')
  })

  it('keeps a healthy pack out of pack_audit_state with a non-ok status', async () => {
    const tenantId = 't_audit_c'
    const packDigest = 'pack_audit_c'
    const storageUri = await seedRemotePack(h, { tenantId, packDigest, byteLength: 64 })
    await putPackBytes(h.store, storageUri, new Uint8Array(64))

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-hourly']()

    const audit = await h.rawExec<{ status: string; last_header_check_at: string | null }>(
      `SELECT status, last_header_check_at FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.status).toBe('ok')
    expect(audit[0]!.last_header_check_at).not.toBeNull()
    // No mismatch / missing metrics for the happy path.
    expect(h.metrics.events.filter((e) => e.name.startsWith('prosa.audit.'))).toHaveLength(0)
  })
})

describe('Lane 8 audit monthly — CQ-157 BLAKE3 byte rehash', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('leaves a healthy pack with the BLAKE3 byte_hash from upload alone', async () => {
    const tenantId = 't_audit_monthly_ok'
    const packDigest = 'pack_audit_monthly_ok'
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16])
    const byteHash = toHex(blake3(payload))
    const storageUri = await seedRemotePack(h, {
      tenantId,
      packDigest,
      byteLength: payload.byteLength,
      byteHash,
    })
    await putPackBytes(h.store, storageUri, payload)

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-monthly']()

    const audit = await h.rawExec<{ status: string; last_full_hash_at: string | null }>(
      `SELECT status, last_full_hash_at FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.status).toBe('ok')
    expect(audit[0]!.last_full_hash_at).not.toBeNull()
    // No mismatch / missing metrics for a real BLAKE3-matched pack.
    expect(h.metrics.events.filter((e) => e.name === 'prosa.audit.pack_mismatch')).toHaveLength(0)
  })

  it('quarantines a pack whose recomputed BLAKE3 does not match byte_hash', async () => {
    const tenantId = 't_audit_monthly_mismatch'
    const packDigest = 'pack_audit_monthly_mismatch'
    const receiptId = 'rcp_audit_monthly_mismatch'
    const payload = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])
    // Persist a deliberately wrong byte_hash (matching length, BLAKE3
    // of different bytes) so the monthly recompute mismatches.
    const wrongHash = toHex(blake3(new Uint8Array([9, 9, 9, 9, 9, 9, 9, 9])))
    const storageUri = await seedRemotePack(h, {
      tenantId,
      packDigest,
      byteLength: payload.byteLength,
      byteHash: wrongHash,
    })
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId })
    await putPackBytes(h.store, storageUri, payload)

    const handlers = registerAuditCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['audit-monthly']()

    const audit = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_audit_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(audit).toHaveLength(1)
    expect(audit[0]!.status).toBe('quarantined')

    const receiptAudit = await h.rawExec<{ status: string }>(
      `SELECT status FROM receipt_audit_state WHERE receipt_id = $1`,
      [receiptId],
    )
    expect(receiptAudit[0]!.status).toBe('degraded')

    const events = h.metrics.events.filter((e) => e.name === 'prosa.audit.pack_mismatch')
    expect(events).toHaveLength(1)
    expect(events[0]!.tags.reason).toBe('byte_hash_mismatch')
  })
})
