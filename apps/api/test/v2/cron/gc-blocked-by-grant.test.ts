// Lane 8 — GC must never tombstone a pack that still has a
// `receipt_pack_grant` row pointing at it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes, seedReceiptGrant } from './helpers.js'

describe('Lane 8 GC daily — blocked by receipt_pack_grant', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('leaves a granted pack in `live` even when older than the unreferenced-age threshold', async () => {
    const tenantId = 't_gc_grant'
    const packDigest = 'pack_gc_grant'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 32, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(32))
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId: 'rcp_alive' })

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['gc-daily']()

    const rows = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    // No row inserted — pack is still live.
    expect(rows).toHaveLength(0)
    // The catalog row is untouched.
    const packs = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(packs).toHaveLength(1)
  })
})
