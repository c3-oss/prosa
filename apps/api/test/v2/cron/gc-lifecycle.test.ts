// Lane 8 — GC three-phase lifecycle.
//
// A pack is unreferenced for >30 days and not held by any open
// promotion. The daily GC pass must:
//   1. Insert `pack_gc_state` with status `tombstone_pending`.
//   2. Once the 24 h tombstone grace elapses, flip to `delete_pending`.
//   3. Delete the object + catalog rows and stamp `deleted` on the
//      audit state row.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes } from './helpers.js'

describe('Lane 8 GC daily — three-phase lifecycle', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('moves an unreferenced pack through tombstone -> delete -> deleted', async () => {
    const tenantId = 't_gc_life'
    const packDigest = 'pack_gc_life'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`

    // Seed a pack ingested 40 days ago (> 30 day unreferenced age).
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 64, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(64))

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })

    // Phase 1: live -> tombstone_pending.
    await handlers['gc-daily']()
    let row = await h.rawExec<{ status: string; first_unreferenced_at: string | null }>(
      `SELECT status, first_unreferenced_at FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row).toHaveLength(1)
    expect(row[0]!.status).toBe('tombstone_pending')

    // Backdate the tombstone so the next tick crosses the 24 h grace.
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    await h.rawExec(`UPDATE pack_gc_state SET first_unreferenced_at = $3 WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
      yesterday,
    ])

    // Phase 2 + 3: tombstone -> delete -> deleted in a single tick.
    await handlers['gc-daily']()
    row = await h.rawExec<{ status: string; first_unreferenced_at: string | null }>(
      `SELECT status, first_unreferenced_at FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('deleted')

    // Catalog rows are gone.
    const packs = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(packs).toHaveLength(0)
    const entries = await h.rawExec(`SELECT 1 FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(entries).toHaveLength(0)
    expect(await h.store.head(storageUri)).toBeNull()

    const events = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(events).toHaveLength(1)
  })
})
