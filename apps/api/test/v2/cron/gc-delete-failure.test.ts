// Lane 8 — GC delete failure path.
//
// When the object store delete throws, the pack must revert to
// `live` and the error must be recorded on `pack_gc_state.error`.

import type { RemoteObjectStore } from '@c3-oss/prosa-storage'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness } from './helpers.js'

describe('Lane 8 GC daily — delete failure', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('reverts a `delete_pending` pack to `live` and records the error when S3 delete throws', async () => {
    const tenantId = 't_gc_fail'
    const packDigest = 'pack_gc_fail'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`

    // Seed the catalog row and pre-populate a `pack_gc_state` row in
    // `delete_pending` so phase 3 runs without waiting on the
    // tombstone grace.
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 32, 'root', $3, now() - interval '40 days')`,
      [tenantId, packDigest, storageUri],
    )
    const yesterday = new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO pack_gc_state (tenant_id, pack_digest, unreferenced_since, first_unreferenced_at, status)
         VALUES ($1, $2, $3, $3, 'delete_pending')`,
      [tenantId, packDigest, yesterday],
    )

    // Object store that fails the delete.
    const failingStore: Pick<RemoteObjectStore, 'delete'> = {
      delete: async () => {
        throw new Error('S3 unavailable')
      },
    }

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: failingStore,
      logger: h.logger,
      metrics: h.metrics,
    })
    await handlers['gc-daily']()

    const rows = await h.rawExec<{ status: string; error: unknown }>(
      `SELECT status, error FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('live')
    expect(rows[0]!.error).not.toBeNull()

    // Catalog row still present (no half-deletion).
    const cat = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(cat).toHaveLength(1)

    const failed = h.metrics.events.filter((e) => e.name === 'prosa.gc.delete_failed')
    expect(failed).toHaveLength(1)
  })
})
