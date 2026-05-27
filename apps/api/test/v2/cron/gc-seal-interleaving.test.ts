// Lane 8 — CQ-155 two-transaction seal-vs-GC interleavings.
//
// Production GC and seal-promotion both take `FOR UPDATE` on the
// shared `remote_pack(tenant_id, pack_digest)` row. Postgres
// serializes the two transactions on that row, and the lock holder
// commits before the waiter sees the post-commit state. These tests
// model the two possible outcomes against the same load-bearing
// invariant: NO receipt/authority/grant is ever visible against a
// pack whose catalog row has been deleted.
//
// Because PGlite is single-threaded, we model each ordering by
// running the relevant SQL inline (sealing path's grant tx and GC's
// catalog tx), with the same `FOR UPDATE` semantics seal-promotion
// and GC use in production. The point is to prove the lock-order
// invariants hold once the locks actually serialize.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { registerGcCron } from '../../../src/cron/gc.js'
import { type CronTestHarness, buildCronTestHarness, putPackBytes } from './helpers.js'

async function seedDeletePendingPack(h: CronTestHarness, tenantId: string, packDigest: string): Promise<string> {
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
  return storageUri
}

describe('Lane 8 GC — CQ-155 seal-vs-GC interleavings', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('GC-wins: catalog tx commits first; concurrent seal grant insert sees no remote_pack row and aborts before any receipt/authority/grant becomes visible', async () => {
    // Production semantics: seal-promotion takes
    //   SELECT 1 FROM remote_pack WHERE ... FOR UPDATE
    // BEFORE the grant insert. If GC's catalog tx already deleted
    // the remote_pack row, the SELECT returns no rows and the seal
    // path throws — no receipt, no remote_authority_v2, no
    // search_generation_current, no receipt_pack_grant is visible.
    const tenantId = 't_gc_wins'
    const packDigest = 'pack_gc_wins'
    const storageUri = await seedDeletePendingPack(h, tenantId, packDigest)

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    // GC wins the lock first: phase 3 runs, deletes the catalog row.
    await handlers['gc-daily']()
    const catalog = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(catalog).toHaveLength(0)
    expect(await h.store.head(storageUri)).toBeNull()

    // Now the late seal-promotion tries to publish a receipt that
    // links this pack via a grant. Production seal-promotion would
    // run its FOR UPDATE → grant insert inside a single tx and
    // throw when the catalog row is gone; we model that exact
    // sequence here. The tx ROLLS BACK on the throw so no receipt /
    // authority / grant is visible afterwards.
    await expect(
      h.transaction(async (tx) => {
        // Pretend the materializing-side bookkeeping ran already
        // (insert the receipt + authority + search_generation rows).
        await tx(
          `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
             VALUES ('rcp_late', $1, 's', 'd', '{}'::jsonb, '{}'::jsonb)`,
          [tenantId],
        )
        await tx(
          `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
             VALUES ($1, 's', 'rcp_late', 'br', now())`,
          [tenantId],
        )
        await tx(
          `INSERT INTO search_generation_current (tenant_id, store_id, generation_id, receipt_id, promoted_at)
             VALUES ($1, 's', 'gen_late', 'rcp_late', now())`,
          [tenantId],
        )
        // Production CQ-155: FOR UPDATE on remote_pack BEFORE
        // inserting the grant. Empty result means the pack is gone;
        // throw to abort the whole tx.
        const lock = await tx<{ ok: boolean }>(
          `SELECT 1 AS ok FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2 FOR UPDATE`,
          [tenantId, packDigest],
        )
        if (lock.length === 0) {
          throw new Error(`seal-promotion: remote_pack(${packDigest}) was deleted before grant insert`)
        }
        await tx(
          `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest, grant_mode)
             VALUES ('rcp_late', $1, $2, 'all_entries')`,
          [tenantId, packDigest],
        )
      }),
    ).rejects.toThrow(/remote_pack.*deleted/)

    // CQ-155 invariant: NONE of receipt, authority, search
    // generation, or grant is visible — the seal tx rolled back.
    const receipts = await h.rawExec(`SELECT 1 FROM receipt WHERE tenant_id = $1`, [tenantId])
    expect(receipts).toHaveLength(0)
    const authority = await h.rawExec(`SELECT 1 FROM remote_authority_v2 WHERE tenant_id = $1`, [tenantId])
    expect(authority).toHaveLength(0)
    const searchGen = await h.rawExec(`SELECT 1 FROM search_generation_current WHERE tenant_id = $1`, [tenantId])
    expect(searchGen).toHaveLength(0)
    const grants = await h.rawExec(`SELECT 1 FROM receipt_pack_grant WHERE tenant_id = $1`, [tenantId])
    expect(grants).toHaveLength(0)
  })

  it('Seal-wins: grant lands before GC final tx; GC recheck reverts pack to live and skips delete', async () => {
    // Production semantics: seal-promotion locks `remote_pack` and
    // inserts the grant, commits. Then GC enters its catalog-delete
    // tx, takes FOR UPDATE on the same `remote_pack` row, rechecks
    // refs (sees the grant), and reverts to `live` without
    // touching catalog or object bytes.
    const tenantId = 't_seal_wins'
    const packDigest = 'pack_seal_wins'
    const storageUri = await seedDeletePendingPack(h, tenantId, packDigest)

    // Seal commits the grant first.
    await h.transaction(async (tx) => {
      const lock = await tx<{ ok: boolean }>(
        `SELECT 1 AS ok FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2 FOR UPDATE`,
        [tenantId, packDigest],
      )
      expect(lock).toHaveLength(1)
      await tx(
        `INSERT INTO receipt_pack_grant (receipt_id, tenant_id, pack_digest, grant_mode)
           VALUES ('rcp_seal_wins', $1, $2, 'all_entries')`,
        [tenantId, packDigest],
      )
    })

    // Then GC's daily tick runs phase 3. It rechecks under the
    // SAME `FOR UPDATE` on `remote_pack`, sees the grant, and
    // reverts the pack to `live`.
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
})

describe('Lane 8 GC — CQ-155 production promotion_uploaded_pack reversion paths', () => {
  let h: CronTestHarness
  beforeEach(async () => {
    h = await buildCronTestHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('reverts a tombstone_pending pack when an open promotion appears via promotion_uploaded_pack (production-shape head_json is empty)', async () => {
    // Production seal-promotion writes the pack association into
    // `promotion_uploaded_pack`, NOT `head_json.pack_digests`. The
    // post-tombstone revalidation must honor this shape.
    const tenantId = 't_pup_tomb_revert'
    const packDigest = 'pack_pup_tomb_revert'
    const storageUri = `object-packs/${tenantId}/test/${packDigest}.pack`
    const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await h.rawExec(
      `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, object_set_root, storage_uri, ingested_at)
         VALUES ($1, $2, 'cas_object_pack', 1, 16, 'root', $3, $4)`,
      [tenantId, packDigest, storageUri, fortyDaysAgo],
    )
    await putPackBytes(h.store, storageUri, new Uint8Array(16))

    const handlers = registerGcCron({
      rawExec: h.rawExec,
      transaction: h.transaction,
      objectStore: h.store,
      logger: h.logger,
      metrics: h.metrics,
    })
    // Phase 1 tombstones the pack (no references yet).
    await handlers['gc-daily']()
    let row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('tombstone_pending')

    // A new open promotion appears with EMPTY head_json but linked
    // via promotion_uploaded_pack (production seal shape).
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ('ps_tomb_revert', $1, 'u', 'd', 's', '/p', 'uploading', '{}'::jsonb)`,
      [tenantId],
    )
    await h.rawExec(
      `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest)
         VALUES ('ps_tomb_revert', $1, $2)`,
      [tenantId, packDigest],
    )

    await handlers['gc-daily']()

    row = await h.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [tenantId, packDigest],
    )
    expect(row[0]!.status).toBe('live')
    const catalog = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(catalog).toHaveLength(1)
    expect(await h.store.head(storageUri)).not.toBeNull()
  })

  it('reverts a delete_pending pack when an open promotion appears via promotion_uploaded_pack (production-shape head_json is empty)', async () => {
    // The per-row final recheck inside the catalog tx must also
    // honor `promotion_uploaded_pack` linkage. Without this, a
    // pack that reaches `delete_pending` then gains a production
    // promotion_uploaded_pack reference would still be deleted.
    const tenantId = 't_pup_dp_revert'
    const packDigest = 'pack_pup_dp_revert'
    const storageUri = await seedDeletePendingPack(h, tenantId, packDigest)

    // Open promotion + production-shape pack linkage (head_json
    // intentionally does NOT carry pack_digests).
    await h.rawExec(
      `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json)
         VALUES ('ps_dp_revert', $1, 'u', 'd', 's', '/p', 'uploading', '{}'::jsonb)`,
      [tenantId],
    )
    await h.rawExec(
      `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest)
         VALUES ('ps_dp_revert', $1, $2)`,
      [tenantId, packDigest],
    )

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
    const catalog = await h.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      tenantId,
      packDigest,
    ])
    expect(catalog).toHaveLength(1)
    expect(await h.store.head(storageUri)).not.toBeNull()
    const deleted = h.metrics.events.filter((e) => e.name === 'prosa.gc.pack_deleted')
    expect(deleted).toHaveLength(0)
  })
})
