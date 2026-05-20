// Lane 8 — GC must never tombstone a pack referenced by an open
// `promotion_staging` row via `head_json.pack_digests`.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes } from './helpers.js'

describe('Lane 8 GC daily — blocked by open promotion_staging', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('leaves a pack referenced by an open promotion in `live`', async () => {
    const tenantId = 't_gc_staging'
    const packDigest = 'pack_gc_staging'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()

    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 32, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(32))

    // Insert an OPEN promotion_staging row referencing the pack.
    const head = {
      bundleRoot: 'br_staging_block',
      pack_digests: [packDigest],
    }
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ($1, $2, 'u', 'd', 's', '/p', 'open', $3::jsonb)`,
      ['ps_1', tenantId, JSON.stringify(head)],
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
    expect(rows).toHaveLength(0)
  })

  it('allows GC once the staging row is sealed or aborted', async () => {
    const tenantId = 't_gc_staging_sealed'
    const packDigest = 'pack_gc_staging_sealed'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()

    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 32, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(32))
    const head = { bundleRoot: 'br_sealed_unblock', pack_digests: [packDigest] }
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ($1, $2, 'u', 'd', 's2', '/p', 'aborted', $3::jsonb)`,
      ['ps_aborted', tenantId, JSON.stringify(head)],
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
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe('tombstone_pending')
  })
})
