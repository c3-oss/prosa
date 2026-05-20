// CQ-141: closes two failure modes the previous closure left
// open and that reviewer/governor rejected on 2026-05-20.
//
// 1. UploadObjectPack catalog fast path: when stored bytes at
//    the canonical key disagree with the uploaded body's
//    hash/length, the prior fix did `delete()` + `putIfAbsent()`
//    which can strand the catalog row pointing at empty storage
//    if the replacement put fails. Closure now fails closed
//    (`UploadObjectPackBytesCorruptError`) without deleting; an
//    operator must reconcile catalog/storage drift out of band.
//    Missing-bytes repair via `putIfAbsent` remains safe because
//    nothing is deleted.
//
// 2. SealPromotion: head() was only required to be non-null +
//    nonzero, so a wrong-nonzero hash/size passed the gate.
//    Closure now compares head().hash + compressedSize against
//    the durable `remote_pack.byte_hash` + `byte_length` and
//    fails closed with `SealPromotionPackBytesMismatchError`,
//    leaving no receipt / authority / grant rows and restoring
//    staging to its prior status via the CQ-135 wrapper.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore, PUT_PREVERIFIED_BYTES, type PutMeta } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { openPgliteDatabase } from '../../../src/db.js'
import { createLocalReceiptSigner } from '../../../src/v2/signing/local-signer.js'
import {
  SealPromotionPackBytesMismatchError,
  SealPromotionPackBytesMissingError,
  sealPromotion,
} from '../../../src/v2/sync/seal-promotion.js'
import {
  UploadObjectPackBytesCorruptError,
  objectPackStorageKey,
  uploadObjectPack,
} from '../../../src/v2/sync/upload-object-pack.js'

function blake3Hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}

function transportHashOf(bytes: Uint8Array): string {
  return `blake3:${blake3Hex(bytes)}`
}

async function buildUploadSandbox() {
  const pglite = new PGlite()
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const db = openPgliteDatabase(pglite)
  const objectStore = new MemoryObjectStore()
  const tenantId = 'tenant-cq141'
  const promotionId = 'prm_cq141'
  await db.rawExec(
    `INSERT INTO promotion_staging (
       id, tenant_id, user_id, device_id, store_id, store_path,
       status, head_json, inventory_object_ref, inventory_projection_ref
     ) VALUES ($1, $2, 'user-cq141', 'dev-cq141', 'store-cq141', '/home/test/store', 'open', $3::jsonb, NULL, NULL)`,
    [promotionId, tenantId, JSON.stringify({ bundleRoot: 'cq141'.padEnd(64, '0') })],
  )
  return {
    pglite,
    db,
    objectStore,
    tenantId,
    promotionId,
    close: async () => void (await pglite.close()),
  }
}

function buildPack() {
  return buildCasPack([{ bytes: new TextEncoder().encode('cq141-pack-content'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
}

describe('CQ-141 (upload): wrong-content fast path fails closed without deleting bytes', () => {
  it('catalog row + wrong-content storage key: throws UploadObjectPackBytesCorruptError and leaves bytes intact', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      // Seed the catalog as if a prior upload had committed.
      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, $5, false, $6)`,
        [
          sb.tenantId,
          pack.packDigest,
          pack.bytes.byteLength,
          blake3Hex(pack.bytes),
          'cq141'.padEnd(64, '0'),
          storageKey,
        ],
      )
      await sb.db.rawExec(
        `INSERT INTO remote_pack_entry (
           tenant_id, pack_digest, entry_index, object_id,
           uncompressed_size, stored_offset, stored_length,
           stored_hash, compression
         ) VALUES ($1, $2, 0, $3, 18, 0, $4, $5, 'zstd')`,
        [
          sb.tenantId,
          pack.packDigest,
          `blake3:${blake3Hex(new Uint8Array([1]))}`,
          pack.bytes.byteLength,
          blake3Hex(pack.bytes),
        ],
      )

      // Seed object store at the canonical key with WRONG bytes.
      const corruptBytes = new TextEncoder().encode('not the canonical pack bytes')
      await sb.objectStore.putIfAbsent(
        storageKey,
        (async function* () {
          yield corruptBytes
        })(),
        {
          hash: blake3Hex(corruptBytes),
          hashAlgorithm: 'blake3',
          uncompressedSize: corruptBytes.byteLength,
          compressedSize: corruptBytes.byteLength,
        },
      )

      await expect(
        uploadObjectPack(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
          },
          { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
        ),
      ).rejects.toBeInstanceOf(UploadObjectPackBytesCorruptError)

      // The corrupt bytes are STILL present — fail-closed must
      // not delete the existing storage object.
      const after = await sb.objectStore.head(storageKey)
      expect(after).not.toBeNull()
      expect(after!.hash.toLowerCase()).toBe(blake3Hex(corruptBytes))
      expect(after!.compressedSize).toBe(corruptBytes.byteLength)

      // The pack was NOT linked to the promotion — refusing to
      // grant authority over corrupt bytes is the whole point.
      const grants = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_uploaded_pack WHERE promotion_id = $1 AND tenant_id = $2`,
        [sb.promotionId, sb.tenantId],
      )
      expect(Number(grants[0]!.count)).toBe(0)
    } finally {
      await sb.close()
    }
  })

  it('catalog row + missing storage key: writes the canonical pack bytes before linking', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      // Catalog rows present, no bytes in storage. byte_hash left
      // null on purpose so the upload-side backfill is also
      // exercised.
      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, false, $5)`,
        [sb.tenantId, pack.packDigest, pack.bytes.byteLength, 'cq141'.padEnd(64, '0'), storageKey],
      )
      expect(await sb.objectStore.head(storageKey)).toBeNull()

      const result = await uploadObjectPack(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.objectStore,
        },
        { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
      )
      expect(result.status).toBe('already_present')

      const stored = await sb.objectStore.head(storageKey)
      expect(stored).not.toBeNull()
      expect(stored!.hash.toLowerCase()).toBe(blake3Hex(pack.bytes))

      // Legacy byte_hash=null row was backfilled with the
      // canonical transport hash so future seals can verify.
      const backfilled = await sb.db.rawExec<{ byte_hash: string | null }>(
        `SELECT byte_hash FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`,
        [sb.tenantId, pack.packDigest],
      )
      expect(backfilled[0]!.byte_hash?.toLowerCase()).toBe(blake3Hex(pack.bytes))
    } finally {
      await sb.close()
    }
  })

  it('catalog row + matching storage key: no-op repair (object store untouched)', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, $5, false, $6)`,
        [
          sb.tenantId,
          pack.packDigest,
          pack.bytes.byteLength,
          blake3Hex(pack.bytes),
          'cq141'.padEnd(64, '0'),
          storageKey,
        ],
      )
      await sb.objectStore.putIfAbsent(
        storageKey,
        (async function* () {
          yield pack.bytes
        })(),
        {
          hash: blake3Hex(pack.bytes),
          hashAlgorithm: 'blake3',
          uncompressedSize: pack.bytes.byteLength,
          compressedSize: pack.bytes.byteLength,
        },
      )
      const before = await sb.objectStore.head(storageKey)

      const result = await uploadObjectPack(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.objectStore,
        },
        { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
      )
      expect(result.status).toBe('already_present')

      const after = await sb.objectStore.head(storageKey)
      expect(after?.hash).toBe(before?.hash)
      expect(after?.compressedSize).toBe(before?.compressedSize)
      expect(sb.objectStore.size()).toBe(1)
    } finally {
      await sb.close()
    }
  })

  it('injected putIfAbsent failure on missing-bytes repair: no link, no surviving partial state', async () => {
    // Reviewer 2026-05-20 required that an upload failure does
    // not leave the catalog row linked to a promotion when bytes
    // were never written. With the destructive-delete branch
    // removed, the only remaining repair path is `putIfAbsent`
    // on a missing key — which is itself safe (nothing to lose).
    // We still pin the failure-mode contract: if the put throws,
    // the pack is NOT linked to the promotion and storage stays
    // empty.
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)
      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, false, $5)`,
        [sb.tenantId, pack.packDigest, pack.bytes.byteLength, 'cq141'.padEnd(64, '0'), storageKey],
      )

      const failingStore: MemoryObjectStore = sb.objectStore
      const realPut = failingStore.putIfAbsent.bind(failingStore)
      let injected = false
      failingStore.putIfAbsent = (async (key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta) => {
        injected = true
        throw new Error('injected put failure on missing-bytes repair')
      }) as typeof failingStore.putIfAbsent
      try {
        await expect(
          uploadObjectPack(
            {
              rawExec: sb.db.rawExec,
              transaction: sb.db.transaction,
              tenantId: sb.tenantId,
              objectStore: failingStore,
            },
            { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
          ),
        ).rejects.toThrow(/injected put failure/)
        expect(injected).toBe(true)
      } finally {
        failingStore.putIfAbsent = realPut
      }

      // No promotion link, no surviving bytes — the storage key
      // is still empty (because the put never wrote anything),
      // and the catalog row pre-existed but is not linked to the
      // promotion.
      expect(await failingStore.head(storageKey)).toBeNull()
      const links = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_uploaded_pack WHERE promotion_id = $1 AND tenant_id = $2`,
        [sb.promotionId, sb.tenantId],
      )
      expect(Number(links[0]!.count)).toBe(0)
    } finally {
      await sb.close()
    }
  })
})

async function buildSealSandbox(opts: { packDigest: string; packByteLength: number; packByteHash: string | null }) {
  const pglite = new PGlite()
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const db = openPgliteDatabase(pglite)
  const objectStore = new MemoryObjectStore()

  const tenantId = 'tenant-cq141-seal'
  const promotionId = 'prm_cq141seal'
  const storeId = 'store-cq141'
  const deviceId = 'dev-cq141'
  const bundleRoot = 'cq141seal'.padEnd(64, '0')

  const objectInventory = {
    segmentId: 'cq141-obj-inv',
    kind: 'inventory_object' as const,
    digest: `blake3:${blake3Hex(new Uint8Array([1]))}`,
    logicalRoot: 'objects/inv',
    compression: 'zstd' as const,
    byteLength: 8,
  }
  const projectionInventory = {
    segmentId: 'cq141-proj-inv',
    kind: 'inventory_projection' as const,
    digest: `blake3:${blake3Hex(new Uint8Array([2]))}`,
    logicalRoot: 'projection/inv',
    compression: 'zstd' as const,
    byteLength: 8,
  }
  await db.rawExec(
    `INSERT INTO promotion_staging (
       id, tenant_id, user_id, device_id, store_id, store_path,
       status, head_json, inventory_object_ref, inventory_projection_ref
     ) VALUES ($1, $2, 'user-cq141', $3, $4, '/home/test/store', 'open', $5::jsonb, $6, $7)`,
    [
      promotionId,
      tenantId,
      deviceId,
      storeId,
      JSON.stringify({
        bundleRoot,
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
  const objInvBytes = new TextEncoder().encode('cq141-obj')
  const projInvBytes = new TextEncoder().encode('cq141-prj')
  await objectStore.putIfAbsent(
    stagingKey(objectInventory.segmentId),
    (async function* () {
      yield objInvBytes
    })(),
    {
      hash: blake3Hex(objInvBytes),
      hashAlgorithm: 'blake3',
      uncompressedSize: objInvBytes.byteLength,
      compressedSize: objInvBytes.byteLength,
    },
  )
  await objectStore.putIfAbsent(
    stagingKey(projectionInventory.segmentId),
    (async function* () {
      yield projInvBytes
    })(),
    {
      hash: blake3Hex(projInvBytes),
      hashAlgorithm: 'blake3',
      uncompressedSize: projInvBytes.byteLength,
      compressedSize: projInvBytes.byteLength,
    },
  )

  const packStorageKey = `object-packs/${tenantId}/${opts.packDigest.slice('blake3:'.length)}.pack`
  await db.rawExec(
    `INSERT INTO remote_pack (
       tenant_id, pack_digest, kind, entry_count, byte_length, byte_hash,
       object_set_root, standalone_large_object, storage_uri
     )
     VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, $5, false, $6)`,
    [tenantId, opts.packDigest, opts.packByteLength, opts.packByteHash, 'cq141'.padEnd(64, '0'), packStorageKey],
  )
  await db.rawExec(`INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest) VALUES ($1, $2, $3)`, [
    promotionId,
    tenantId,
    opts.packDigest,
  ])

  return {
    pglite,
    db,
    objectStore,
    tenantId,
    promotionId,
    packStorageKey,
    close: async () => void (await pglite.close()),
  }
}

describe('CQ-141 (seal): linked pack with missing object-store bytes fails closed', () => {
  it('throws SealPromotionPackBytesMissingError and restores staging to its prior status', async () => {
    const packDigest = `blake3:${blake3Hex(new Uint8Array([42]))}`
    const sb = await buildSealSandbox({ packDigest, packByteLength: 64, packByteHash: 'aa'.repeat(32) })
    try {
      expect(await sb.objectStore.head(sb.packStorageKey)).toBeNull()
      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal' })
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId: sb.promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMissingError)

      const rows = await sb.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
        sb.promotionId,
      ])
      expect(rows[0]!.status).toBe('open')

      const counts = await sb.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await sb.close()
    }
  })
})

describe('CQ-141 (seal): linked pack with wrong nonzero object-store metadata fails closed', () => {
  it('throws SealPromotionPackBytesMismatchError when head().hash disagrees with remote_pack.byte_hash', async () => {
    const packDigest = `blake3:${blake3Hex(new Uint8Array([99]))}`
    const expectedHash = 'aa'.repeat(32)
    const expectedSize = 64
    const sb = await buildSealSandbox({
      packDigest,
      packByteLength: expectedSize,
      packByteHash: expectedHash,
    })
    try {
      // Plant nonzero bytes at the canonical key whose head()
      // returns a WRONG hash — simulates an out-of-band swap /
      // corruption between upload and seal.
      const wrongBytes = new TextEncoder().encode('wrong-nonzero-pack-bytes-cq141-seal-mismatch-fixture-padding-x')
      // Force expectedSize so size matches but hash doesn't.
      const padded = new Uint8Array(expectedSize)
      padded.set(wrongBytes.subarray(0, Math.min(wrongBytes.byteLength, expectedSize)))
      await sb.objectStore.putIfAbsent(
        sb.packStorageKey,
        (async function* () {
          yield padded
        })(),
        {
          hash: blake3Hex(padded),
          hashAlgorithm: 'blake3',
          uncompressedSize: padded.byteLength,
          compressedSize: padded.byteLength,
        },
      )
      const planted = await sb.objectStore.head(sb.packStorageKey)
      expect(planted).not.toBeNull()
      expect(planted!.compressedSize).toBe(expectedSize)
      expect(planted!.hash.toLowerCase()).not.toBe(expectedHash)

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal-mismatch' })
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId: sb.promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMismatchError)

      const rows = await sb.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
        sb.promotionId,
      ])
      expect(rows[0]!.status).toBe('open')

      const counts = await sb.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await sb.close()
    }
  })

  it('throws SealPromotionPackBytesMismatchError when head().compressedSize disagrees with remote_pack.byte_length', async () => {
    const packDigest = `blake3:${blake3Hex(new Uint8Array([7]))}`
    const expectedSize = 64
    const sb = await buildSealSandbox({
      packDigest,
      packByteLength: expectedSize,
      packByteHash: 'bb'.repeat(32),
    })
    try {
      const wrongSized = new TextEncoder().encode('wrong-sized-bytes-cq141')
      await sb.objectStore.putIfAbsent(
        sb.packStorageKey,
        (async function* () {
          yield wrongSized
        })(),
        {
          hash: blake3Hex(wrongSized),
          hashAlgorithm: 'blake3',
          uncompressedSize: wrongSized.byteLength,
          compressedSize: wrongSized.byteLength,
        },
      )
      const planted = await sb.objectStore.head(sb.packStorageKey)
      expect(planted!.compressedSize).not.toBe(expectedSize)

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal-size' })
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId: sb.promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMismatchError)

      const counts = await sb.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await sb.close()
    }
  })

  it('fails closed on legacy null remote_pack.byte_hash even when size matches (size-only is insufficient)', async () => {
    // Reviewer 2026-05-20: catalog rows from before the CQ-141
    // closure may have byte_hash IS NULL. With the old code that
    // treated null as "size-only check", an out-of-band swap that
    // preserved byte_length could still seal wrong same-size
    // bytes. Closure now requires byte_hash to be present (and
    // equal) before authority grant.
    const packDigest = `blake3:${blake3Hex(new Uint8Array([55]))}`
    const expectedSize = 32
    const sb = await buildSealSandbox({
      packDigest,
      packByteLength: expectedSize,
      packByteHash: null,
    })
    try {
      const sameSizeWrongBytes = new Uint8Array(expectedSize)
      sameSizeWrongBytes.fill(0xab)
      await sb.objectStore.putIfAbsent(
        sb.packStorageKey,
        (async function* () {
          yield sameSizeWrongBytes
        })(),
        {
          hash: blake3Hex(sameSizeWrongBytes),
          hashAlgorithm: 'blake3',
          uncompressedSize: sameSizeWrongBytes.byteLength,
          compressedSize: sameSizeWrongBytes.byteLength,
        },
      )
      const planted = await sb.objectStore.head(sb.packStorageKey)
      expect(planted!.compressedSize).toBe(expectedSize)

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal-nullhash' })
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId: sb.promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMismatchError)

      const counts = await sb.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await sb.close()
    }
  })

  it('fails closed when head().hashAlgorithm is not blake3 (wrong algorithm with same hex/size)', async () => {
    // Reviewer 2026-05-20: seal must require `hashAlgorithm ===
    // 'blake3'`. A nonzero object whose hex string and size match
    // the expected metadata but whose `hashAlgorithm` is e.g.
    // `sha256` does NOT carry the canonical CAS identity v2
    // receipts depend on.
    const packDigest = `blake3:${blake3Hex(new Uint8Array([77]))}`
    const expectedHash = 'cc'.repeat(32)
    const expectedSize = 16
    const sb = await buildSealSandbox({
      packDigest,
      packByteLength: expectedSize,
      packByteHash: expectedHash,
    })
    try {
      // Plant bytes via the preverified path so we can forge a
      // head() that returns hash=expectedHash but
      // hashAlgorithm='sha256'. The MemoryObjectStore records
      // meta verbatim from the put call.
      const bytes = new Uint8Array(expectedSize)
      bytes.fill(0x42)
      await sb.objectStore[PUT_PREVERIFIED_BYTES](
        sb.packStorageKey,
        (async function* () {
          yield bytes
        })(),
        {
          hash: expectedHash,
          // biome-ignore lint/suspicious/noExplicitAny: forcing a non-canonical algorithm into ObjectMeta for the test
          hashAlgorithm: 'sha256' as any,
          uncompressedSize: bytes.byteLength,
          compressedSize: bytes.byteLength,
        },
      )
      const planted = await sb.objectStore.head(sb.packStorageKey)
      expect(planted!.hashAlgorithm).toBe('sha256')

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal-algo' })
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId: sb.promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMismatchError)

      const counts = await sb.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await sb.close()
    }
  })

  it('accepts seal when head().hash + size match the durable expected metadata', async () => {
    const packDigest = `blake3:${blake3Hex(new Uint8Array([11]))}`
    const canonicalBytes = new TextEncoder().encode('cq141-canonical-pack-bytes-seal-happy-path')
    const expectedHash = blake3Hex(canonicalBytes)
    const expectedSize = canonicalBytes.byteLength
    const sb = await buildSealSandbox({
      packDigest,
      packByteLength: expectedSize,
      packByteHash: expectedHash,
    })
    try {
      await sb.objectStore.putIfAbsent(
        sb.packStorageKey,
        (async function* () {
          yield canonicalBytes
        })(),
        {
          hash: expectedHash,
          hashAlgorithm: 'blake3',
          uncompressedSize: expectedSize,
          compressedSize: expectedSize,
        },
      )

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal-happy' })
      const result = await sealPromotion(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.objectStore,
          signer,
        },
        { promotionId: sb.promotionId },
      )
      expect(result.status).toBe('sealed')

      const grants = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt_pack_grant WHERE tenant_id = $1 AND pack_digest = $2`,
        [sb.tenantId, packDigest],
      )
      expect(Number(grants[0]!.count)).toBe(1)
    } finally {
      await sb.close()
    }
  })
})
