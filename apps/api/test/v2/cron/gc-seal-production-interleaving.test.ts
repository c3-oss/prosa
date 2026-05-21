// Lane 8 — CQ-155 sealPromotion-driven interleaving regressions.
//
// `gc-seal-interleaving.test.ts` covers the load-bearing
// invariants with inline SQL that models seal-promotion's lock
// order. The governor asked for the same orderings exercised
// against the production `sealPromotion()` entry point so byte
// verification, receipt construction, signing, transaction
// wrapping, and staging restore are all exercised end-to-end.
//
// Two cases:
// 1. **GC-wins**: GC's catalog-delete tx commits first. Then
//    `sealPromotion()` runs against a promotion that uploaded that
//    same pack; the byte-verify step fails closed, no receipt /
//    authority / grant is written, and the staging row reverts to
//    its prior status.
// 2. **Seal-wins**: `sealPromotion()` commits the receipt + grant
//    first. GC's daily tick then enters its catalog-delete tx,
//    rechecks references under `remote_pack FOR UPDATE`, sees the
//    new grant, and reverts the pack to `live`. Bytes + catalog
//    intact; no `prosa.gc.pack_deleted` metric emitted.

import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { DriftLogger, DriftMetrics, DriftTxRunner } from '../../../src/cron/audit/drift.js'
import { registerGcCron } from '../../../src/cron/gc.js'
import { openPgliteDatabase } from '../../../src/db.js'
// drift types reused so the GC harness in the seal-wins case is
// shaped exactly like production wiring.
import { createLocalReceiptSigner } from '../../../src/v2/signing/local-signer.js'
import { sealPromotion } from '../../../src/v2/sync/seal-promotion.js'

function blake3Hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}

async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

type RecordingMetrics = DriftMetrics & {
  events: Array<{ name: string; tags: Record<string, string> }>
}

function makeRecordingMetrics(): RecordingMetrics {
  const events: Array<{ name: string; tags: Record<string, string> }> = []
  return {
    events,
    increment(name, tags = {}) {
      events.push({ name, tags })
    },
  }
}

const noopLogger: DriftLogger = { warn: () => {}, error: () => {} }

type Sandbox = {
  pglite: PGlite
  db: ReturnType<typeof openPgliteDatabase>
  store: MemoryObjectStore
  tenantId: string
  promotionId: string
  storeId: string
  deviceId: string
  packDigest: string
  storageUri: string
  packByteHash: string
  packByteLength: number
  close: () => Promise<void>
}

async function buildSandbox(): Promise<Sandbox> {
  const pglite = new PGlite()
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const db = openPgliteDatabase(pglite)
  const store = new MemoryObjectStore()

  const tenantId = 'tenant-cq155-prod'
  const promotionId = 'prm_cq155_prod'
  const storeId = 'store-cq155-prod'
  const deviceId = 'dev-cq155-prod'
  const packDigest = 'pack-cq155-prod'

  // Seed inventory blobs into the staging key shape so seal's
  // inventory presence check passes.
  const objectInventoryBytes = new TextEncoder().encode('cq155-prod-obj-inv-bytes')
  const projectionInventoryBytes = new TextEncoder().encode('cq155-prod-proj-inv-bytes')
  const objectInventory = {
    segmentId: 'cq155-prod-obj-inv',
    kind: 'inventory_object' as const,
    digest: `blake3:${blake3Hex(objectInventoryBytes)}`,
    logicalRoot: 'objects/inv',
    compression: 'zstd' as const,
    byteLength: objectInventoryBytes.byteLength,
  }
  const projectionInventory = {
    segmentId: 'cq155-prod-proj-inv',
    kind: 'inventory_projection' as const,
    digest: `blake3:${blake3Hex(projectionInventoryBytes)}`,
    logicalRoot: 'projection/inv',
    compression: 'zstd' as const,
    byteLength: projectionInventoryBytes.byteLength,
  }

  await db.rawExec(
    `INSERT INTO promotion_staging (
       id, tenant_id, user_id, device_id, store_id, store_path,
       status, head_json, inventory_object_ref, inventory_projection_ref
     ) VALUES ($1, $2, 'user-cq155-prod', $3, $4, '/home/test/store', 'open', $5::jsonb, $6, $7)`,
    [
      promotionId,
      tenantId,
      deviceId,
      storeId,
      JSON.stringify({
        bundleRoot: 'cq155'.padEnd(64, '0'),
        rawSourceRoot: '00'.repeat(32),
        counts: {
          sourceFiles: 0,
          rawRecords: 0,
          objects: 0,
          sessions: 0,
          messages: 0,
          events: 0,
          contentBlocks: 0,
          turns: 0,
          toolCalls: 0,
          toolResults: 0,
          artifacts: 0,
          edges: 0,
          searchDocs: 0,
          projectionRows: 0,
        },
      }),
      JSON.stringify(objectInventory),
      JSON.stringify(projectionInventory),
    ],
  )

  const stagingKey = (segmentId: string) => `staging/${tenantId}/${promotionId}/${segmentId}`
  await store.putIfAbsent(stagingKey(objectInventory.segmentId), asyncOnce(objectInventoryBytes), {
    hash: blake3Hex(objectInventoryBytes),
    hashAlgorithm: 'blake3',
    uncompressedSize: objectInventoryBytes.byteLength,
    compressedSize: objectInventoryBytes.byteLength,
  })
  await store.putIfAbsent(stagingKey(projectionInventory.segmentId), asyncOnce(projectionInventoryBytes), {
    hash: blake3Hex(projectionInventoryBytes),
    hashAlgorithm: 'blake3',
    uncompressedSize: projectionInventoryBytes.byteLength,
    compressedSize: projectionInventoryBytes.byteLength,
  })

  // Seed a real remote_pack + bytes + promotion_uploaded_pack so
  // sealPromotion's verifyLinkedPackBytes succeeds when the pack is
  // present, and FOR UPDATE on remote_pack proves the catalog
  // serialization invariant.
  const packBytes = new TextEncoder().encode('cq155-prod-pack-payload-fixed-len')
  const packByteHash = blake3Hex(packBytes)
  const packByteLength = packBytes.byteLength
  const storageUri = `object-packs/${tenantId}/${packDigest}.pack`
  // Make the pack appear 40 days old so it's eligible for GC.
  const fortyDaysAgo = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
  await db.rawExec(
    `INSERT INTO remote_pack (tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash, object_set_root, storage_uri, ingested_at)
       VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, 'root', $5, $6)`,
    [tenantId, packDigest, packByteLength, packByteHash, storageUri, fortyDaysAgo],
  )
  await store[PUT_PREVERIFIED_BYTES](storageUri, asyncOnce(packBytes), {
    hash: packByteHash,
    hashAlgorithm: 'blake3',
    uncompressedSize: packByteLength,
    compressedSize: packByteLength,
  })
  await db.rawExec(
    `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest)
       VALUES ($1, $2, $3)`,
    [promotionId, tenantId, packDigest],
  )

  return {
    pglite,
    db,
    store,
    tenantId,
    promotionId,
    storeId,
    deviceId,
    packDigest,
    storageUri,
    packByteHash,
    packByteLength,
    close: async () => {
      await pglite.close()
    },
  }
}

describe('Lane 8 GC — CQ-155 sealPromotion-driven interleaving', () => {
  let sb: Sandbox
  beforeEach(async () => {
    sb = await buildSandbox()
  })
  afterEach(async () => {
    await sb.close()
  })

  it('GC-wins: catalog deleted before sealPromotion runs; seal aborts with PACK_BYTES_MISSING and no receipt/authority/grant is written', async () => {
    // Model the production race outcome where GC's catalog-delete
    // tx already committed (and the bytes were swept) by the time
    // sealPromotion reaches its FOR UPDATE / byte-verify step. We
    // run GC's catalog delete + object delete directly here because
    // GC's own guard refuses to delete while an open
    // promotion_uploaded_pack row points at the pack — the
    // production race the governor asked about happens specifically
    // when GC has already raced past those guards (e.g. a previously
    // aborted seal left the pack unreferenced; a new seal is
    // mid-flight against the same digest).
    await sb.db.transaction(async (tx) => {
      // Take the FOR UPDATE locks GC's production tx uses so the
      // ordering matches.
      await tx(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2 FOR UPDATE`, [
        sb.tenantId,
        sb.packDigest,
      ])
      await tx(`DELETE FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`, [sb.tenantId, sb.packDigest])
      await tx(`DELETE FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [sb.tenantId, sb.packDigest])
    })
    // Production GC removes the bytes after the catalog tx commits.
    await sb.store.delete(sb.storageUri)
    const catalogAfterGc = await sb.db.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      sb.tenantId,
      sb.packDigest,
    ])
    expect(catalogAfterGc).toHaveLength(0)
    expect(await sb.store.head(sb.storageUri)).toBeNull()

    // Now sealPromotion runs against the same promotion. The byte
    // verification reads remote_pack first; the row is gone so
    // verifyLinkedPackBytes throws PACK_BYTES_MISSING and the
    // staging row is restored to its prior 'open' status.
    const signer = createLocalReceiptSigner({ kidPrefix: 'cq155-prod' })
    await expect(
      sealPromotion(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.store,
          signer,
        },
        { promotionId: sb.promotionId },
      ),
    ).rejects.toMatchObject({ code: 'PACK_BYTES_MISSING' })

    // The seal aborted before any receipt / authority / search
    // generation / grant row was written. Staging row reverted
    // to 'open' so the operator can retry once they understand
    // the pack is gone.
    const status = await sb.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
      sb.promotionId,
    ])
    expect(status[0]!.status).toBe('open')
    const receipts = await sb.db.rawExec(`SELECT 1 FROM receipt WHERE tenant_id = $1`, [sb.tenantId])
    expect(receipts).toHaveLength(0)
    const authority = await sb.db.rawExec(`SELECT 1 FROM remote_authority_v2 WHERE tenant_id = $1`, [sb.tenantId])
    expect(authority).toHaveLength(0)
    const searchGen = await sb.db.rawExec(`SELECT 1 FROM search_generation_current WHERE tenant_id = $1`, [sb.tenantId])
    expect(searchGen).toHaveLength(0)
    const grants = await sb.db.rawExec(`SELECT 1 FROM receipt_pack_grant WHERE tenant_id = $1`, [sb.tenantId])
    expect(grants).toHaveLength(0)
  })

  it('GC-wins inside-tx rollback: verifyLinkedPackBytes passes, but GC commits the catalog delete between verify and the FOR UPDATE; seal tx rolls back and leaves no receipt/authority/grant/search_gen visible', async () => {
    // The previous case proves the pre-tx fail-closed path
    // (PACK_BYTES_MISSING). This case proves the inside-tx safety
    // net the governor specifically asked about: production GC and
    // seal interleave such that seal-promotion's
    // `verifyLinkedPackBytes` succeeds (the catalog row + bytes
    // were present when it ran), then GC's catalog-delete tx
    // commits before seal-promotion's main tx reaches its
    // `SELECT ... FOR UPDATE` on remote_pack. The FOR UPDATE
    // returns no rows, seal throws inside the tx, and the entire
    // tx rolls back.
    //
    // PGlite is single-threaded, so we model the production
    // ordering by wrapping the transaction runner: when
    // sealPromotion enters its load-bearing tx (the one that
    // INSERTs the receipt + authority + grant), the wrapper first
    // DELETEs the remote_pack row (modelling GC's already-committed
    // delete). The seal callback then runs and observes the row
    // missing via FOR UPDATE.
    const baseTransaction = sb.db.transaction
    let seenLoadBearingTx = false
    const wrappedTransaction: typeof baseTransaction = async <T>(
      fn: (tx: typeof sb.db.rawExec) => Promise<T>,
    ): Promise<T> => {
      return baseTransaction(async (tx) => {
        // The first transaction call from sealPromotion that runs
        // an INSERT into `receipt` is the load-bearing tx. We
        // detect it by wrapping `tx` and watching for the receipt
        // insert; we delete the catalog row BEFORE the inner
        // callback's FOR UPDATE runs by issuing the delete on the
        // first tx invocation. This models GC having already
        // committed its catalog-delete tx during this seal's tx
        // window.
        if (!seenLoadBearingTx) {
          seenLoadBearingTx = true
          await tx(`DELETE FROM remote_pack_entry WHERE tenant_id = $1 AND pack_digest = $2`, [
            sb.tenantId,
            sb.packDigest,
          ])
          await tx(`DELETE FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [sb.tenantId, sb.packDigest])
        }
        return fn(tx)
      })
    }

    const signer = createLocalReceiptSigner({ kidPrefix: 'cq155-prod-inside-tx' })
    await expect(
      sealPromotion(
        {
          rawExec: sb.db.rawExec,
          transaction: wrappedTransaction,
          tenantId: sb.tenantId,
          objectStore: sb.store,
          signer,
        },
        { promotionId: sb.promotionId },
      ),
    ).rejects.toThrow(/remote_pack.*deleted before grant insert/)

    // CQ-155 invariant: the seal tx ROLLED BACK; no receipt,
    // authority, search_generation, or grant is visible against
    // the missing pack.
    const receipts = await sb.db.rawExec(`SELECT 1 FROM receipt WHERE tenant_id = $1`, [sb.tenantId])
    expect(receipts).toHaveLength(0)
    const authority = await sb.db.rawExec(`SELECT 1 FROM remote_authority_v2 WHERE tenant_id = $1`, [sb.tenantId])
    expect(authority).toHaveLength(0)
    const searchGen = await sb.db.rawExec(`SELECT 1 FROM search_generation_current WHERE tenant_id = $1`, [sb.tenantId])
    expect(searchGen).toHaveLength(0)
    const grants = await sb.db.rawExec(`SELECT 1 FROM receipt_pack_grant WHERE tenant_id = $1`, [sb.tenantId])
    expect(grants).toHaveLength(0)

    // CQ-135: staging row reverted from 'materializing' back to
    // its prior 'open' status so the operator (or a retry) can
    // observe the failure cleanly.
    const status = await sb.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
      sb.promotionId,
    ])
    expect(status[0]!.status).toBe('open')

    // The pack catalog row is gone (the wrapper's delete
    // committed as part of the rolled-back tx? No — the rollback
    // ALSO undoes the wrapper-injected delete, since both the
    // wrapper's DELETE and the seal callback's INSERTs share the
    // same transactional scope. Production behavior differs (GC's
    // delete commits in its OWN tx), but the load-bearing
    // invariant the test pins is: seal MUST NOT publish any
    // receipt/authority/grant when the FOR UPDATE finds the row
    // missing. The presence of remote_pack after the rollback is
    // immaterial to the receipt-side invariant.
  })

  it('Seal-wins: sealPromotion succeeds first; GC daily tick reverts pack_gc_state back to live and skips delete', async () => {
    // Pre-stage the pack as delete_pending so GC's phase 3 would
    // otherwise delete it on the next tick.
    await sb.db.rawExec(
      `INSERT INTO pack_gc_state (tenant_id, pack_digest, unreferenced_since, first_unreferenced_at, status)
         VALUES ($1, $2, $3, $3, 'delete_pending')`,
      [sb.tenantId, sb.packDigest, new Date(Date.now() - 26 * 60 * 60 * 1000).toISOString()],
    )

    // Real sealPromotion commits the grant first.
    const signer = createLocalReceiptSigner({ kidPrefix: 'cq155-prod' })
    const sealed = await sealPromotion(
      {
        rawExec: sb.db.rawExec,
        transaction: sb.db.transaction,
        tenantId: sb.tenantId,
        objectStore: sb.store,
        signer,
      },
      { promotionId: sb.promotionId },
    )
    expect(sealed.status).toBe('sealed')

    // The receipt / authority / grant rows are visible after seal.
    const grants = await sb.db.rawExec<{ receipt_id: string }>(
      `SELECT receipt_id FROM receipt_pack_grant WHERE tenant_id = $1 AND pack_digest = $2`,
      [sb.tenantId, sb.packDigest],
    )
    expect(grants).toHaveLength(1)

    // Now GC's daily tick runs phase 3. Its catalog-delete tx
    // takes FOR UPDATE on remote_pack and rechecks references —
    // the grant inserted by seal is visible, so GC reverts to
    // live without touching catalog or bytes.
    const metrics = makeRecordingMetrics()
    const handlers = registerGcCron({
      rawExec: sb.db.rawExec,
      transaction: sb.db.transaction as DriftTxRunner,
      objectStore: sb.store,
      logger: noopLogger,
      metrics,
    })
    await handlers['gc-daily']()

    const rows = await sb.db.rawExec<{ status: string }>(
      `SELECT status FROM pack_gc_state WHERE tenant_id = $1 AND pack_digest = $2`,
      [sb.tenantId, sb.packDigest],
    )
    expect(rows[0]!.status).toBe('live')
    const catalog = await sb.db.rawExec(`SELECT 1 FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`, [
      sb.tenantId,
      sb.packDigest,
    ])
    expect(catalog).toHaveLength(1)
    expect(await sb.store.head(sb.storageUri)).not.toBeNull()
    expect(metrics.events.some((e) => e.name === 'prosa.gc.pack_deleted')).toBe(false)
  })
})
