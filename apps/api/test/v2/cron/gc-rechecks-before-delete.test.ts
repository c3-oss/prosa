// Lane 8 — CQ-155.
//
// GC must revalidate `receipt_pack_grant` and open `promotion_staging`
// rows AFTER a pack enters `tombstone_pending`. If a grant or open
// staging row appears during the tombstone window, phase 2/3 must
// revert the pack back to `live` rather than deleting it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes, seedReceiptGrant } from './helpers.js'

async function seedOldPack(h: CronTestHarness, tenantId: string, packDigest: string): Promise<string> {
  const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  await h.rawExec(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
       VALUES ($1, $2, 'cas_object_pack', 1, 32, 'root', $3, $4)`,
    [tenantId, packDigest, storageUri, fortyDaysAgo],
  )
  await putPackBytes(h.store, storageUri, new Uint8Array(32))
  return storageUri
}

describe('Lane 8 GC daily — CQ-155 post-tombstone revalidation', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('reverts a tombstoned pack to live when a receipt grant appears after tombstone', async () => {
    const tenantId = 't_gc_recheck_grant'
    const packDigest = 'pack_gc_recheck_grant'
    const storageUri = await seedOldPack(h, tenantId, packDigest)

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })

    // Phase 1 tombstones the pack.
    await handlers['gc-daily']()
    let row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('tombstone_pending')

    // A new receipt grant appears AFTER tombstone but BEFORE delete.
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId: 'rcp_recheck' })

    // Backdate the tombstone past the 24 h grace so the next tick would
    // normally promote it to delete_pending and then delete.
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    await h.rawExec(`UPDATE pack_gc_state SET first_unreferenced_at = $3 WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
      yesterday,
    ])

    await handlers['gc-daily']()

    // The pack must NOT be deleted; the catalog rows and bytes are intact.
    row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('live')
    const packs = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(packs).toHaveLength(1)
    expect(await h.store.head(storageUri)).not.toBeNull()
    const deletedEvents = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(deletedEvents).toHaveLength(0)
  })

  it('reverts a tombstoned pack to live when an open promotion_staging row appears after tombstone', async () => {
    const tenantId = 't_gc_recheck_staging'
    const packDigest = 'pack_gc_recheck_staging'
    const storageUri = await seedOldPack(h, tenantId, packDigest)

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })

    await handlers['gc-daily']()
    let row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('tombstone_pending')

    // An OPEN promotion_staging row appears post-tombstone.
    const head = { bundleRoot: 'br_recheck', pack_digests: [packDigest] }
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ($1, $2, 'u', 'd', 's', '/p', 'open', $3::jsonb)`,
      ['ps_recheck', tenantId, JSON.stringify(head)],
    )

    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    await h.rawExec(`UPDATE pack_gc_state SET first_unreferenced_at = $3 WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
      yesterday,
    ])

    await handlers['gc-daily']()

    row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('live')
    const packs = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(packs).toHaveLength(1)
    expect(await h.store.head(storageUri)).not.toBeNull()
    const deletedEvents = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(deletedEvents).toHaveLength(0)
  })

  it('CQ-155 final-review race: a grant inserted BEFORE the catalog-tx commits keeps the pack alive', async () => {
    // The atomic catalog-delete tx serializes against seal-promotion
    // via row-level FOR UPDATE on `remote_pack`. If a concurrent
    // seal acquires the lock first and inserts a grant, GC's tx
    // sees the grant in its recheck and reverts the pack to `live`
    // — no bytes are deleted. This test simulates the production
    // serialization by inserting the grant BEFORE GC runs phase 3.
    const tenantId = 't_gc_race'
    const packDigest = 'pack_gc_race'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 16, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(16))
    await h.rawExec(
      `INSERT INTO pack_gc_state (tenant_id, pack_digest, unreferenced_since, first_unreferenced_at, status)
         VALUES ($1, $2, $3, $3, 'delete_pending')`,
      [tenantId, packDigest, new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()],
    )
    // Concurrent seal-promotion landed first and inserted a grant.
    // CQ-155 invariant: bytes MUST NOT be deleted now.
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId: 'rcp_race' })

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['gc-daily']()

    // The pack remains live; catalog row + bytes are intact.
    const rows = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(rows[0]!.status).toBe('live')
    const catalog = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(catalog).toHaveLength(1)
    expect(await h.store.head(storageUri)).not.toBeNull()
    const deleted = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(deleted).toHaveLength(0)
  })

  it('CQ-155 final-review staging guard: an open promotion linked via promotion_uploaded_pack blocks tombstone', async () => {
    // Production seal-promotion writes pack associations into
    // `promotion_uploaded_pack`, NOT `head_json.pack_digests`. The
    // guard must honor that linkage too.
    const tenantId = 't_gc_pup'
    const packDigest = 'pack_gc_pup'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 16, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(16))
    // Open promotion + production-shape pack linkage. The head_json
    // intentionally does NOT carry pack_digests, only
    // `promotion_uploaded_pack` does.
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ($1, $2, 'u', 'd', 's', '/p', 'uploading', '{}'::jsonb)`,
      ['ps_pup', tenantId],
    )
    await h.rawExec(
      `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest)
         VALUES ($1, $2, $3)`,
      ['ps_pup', tenantId, packDigest],
    )

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
    // The pack must NOT be tombstoned (the open promotion holds it).
    expect(rows).toHaveLength(0)
    expect(await h.store.head(storageUri)).not.toBeNull()
  })

  it('reverts a delete_pending pack when a grant appears between phase 2 and phase 3', async () => {
    const tenantId = 't_gc_recheck_late'
    const packDigest = 'pack_gc_recheck_late'
    const storageUri = await seedOldPack(h, tenantId, packDigest)

    // Pre-stamp the row as delete_pending with no references (simulating
    // an earlier sweep that already moved it to delete_pending), then
    // add a grant before the same-tick phase 3 runs.
    await h.rawExec(
      `INSERT INTO pack_gc_state (tenant_id, pack_digest, unreferenced_since, first_unreferenced_at, status)
         VALUES ($1, $2, now() - interval '2 days', now() - interval '2 days', 'delete_pending')`,
      [tenantId, packDigest],
    )
    await seedReceiptGrant(h, { tenantId, packDigest, receiptId: 'rcp_late' })

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['gc-daily']()

    const row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('live')
    expect(await h.store.head(storageUri)).not.toBeNull()
    const deletedEvents = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(deletedEvents).toHaveLength(0)
  })
})
