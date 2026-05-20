// CQ-141: tightens both ends of the catalog/bytes invariant.
//
// 1. UploadObjectPack catalog fast path: if `remote_pack` says the
//    `(tenant, pack_digest)` pair is known but the object-store
//    side is in a bad state — bytes missing OR stored bytes don't
//    match the uploaded body's hash/length — the handler must
//    repair from the verified request body BEFORE linking the
//    pack to the current promotion. The reviewer-rejected closure
//    only handled the "missing" case; "wrong content at the
//    canonical key" still got linked and returned
//    `already_present`.
// 2. SealPromotion: even if every catalog row is healthy, the
//    object-store bytes can be lost between upload and seal. Seal
//    must `head()` every linked pack and fail closed if any are
//    missing — granting a receipt for a pack we cannot serve
//    weakens cleanup safety (the spec calls this "promoted data
//    not proven").

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { openPgliteDatabase } from '../../../src/db.js'
import { createLocalReceiptSigner } from '../../../src/v2/signing/local-signer.js'
import { SealPromotionPackBytesMissingError, sealPromotion } from '../../../src/v2/sync/seal-promotion.js'
import { objectPackStorageKey, uploadObjectPack } from '../../../src/v2/sync/upload-object-pack.js'

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

describe('CQ-141 (upload): wrong-content fast path repairs storage before linking', () => {
  it('catalog row + wrong-content storage key: replaces the corrupt bytes and links the pack', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      // Seed the catalog as if a prior upload had committed.
      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, false, $5)`,
        [sb.tenantId, pack.packDigest, pack.bytes.byteLength, 'cq141'.padEnd(64, '0'), storageKey],
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

      // Seed object store at the canonical key with WRONG bytes —
      // simulates a corrupt or out-of-band-tampered storage object.
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
      const storedBefore = await sb.objectStore.head(storageKey)
      expect(storedBefore?.hash).toBe(blake3Hex(corruptBytes))
      expect(storedBefore?.hash).not.toBe(blake3Hex(pack.bytes))

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

      // Storage key now holds the canonical pack bytes.
      const storedAfter = await sb.objectStore.head(storageKey)
      expect(storedAfter).not.toBeNull()
      expect(storedAfter!.hash.toLowerCase()).toBe(blake3Hex(pack.bytes))
      expect(storedAfter!.compressedSize).toBe(pack.bytes.byteLength)

      // The pack was linked to the promotion (so seal can grant
      // it). The catalog stayed at exactly one row.
      const grants = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_uploaded_pack WHERE promotion_id = $1 AND tenant_id = $2`,
        [sb.promotionId, sb.tenantId],
      )
      expect(Number(grants[0]!.count)).toBe(1)
      const packs = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`,
        [sb.tenantId, pack.packDigest],
      )
      expect(Number(packs[0]!.count)).toBe(1)
    } finally {
      await sb.close()
    }
  })

  it('catalog row + missing storage key: writes the canonical pack bytes before linking', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      // Catalog rows present, no bytes in storage.
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
    } finally {
      await sb.close()
    }
  })

  it('catalog row + matching storage key: no-op repair (object store untouched)', async () => {
    const sb = await buildUploadSandbox()
    try {
      const pack = buildPack()
      const storageKey = objectPackStorageKey(sb.tenantId, pack.packDigest)

      // Healthy state: catalog AND canonical bytes already present.
      await sb.db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, false, $5)`,
        [sb.tenantId, pack.packDigest, pack.bytes.byteLength, 'cq141'.padEnd(64, '0'), storageKey],
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

      // Identity preserved — no delete/rewrite happened.
      const after = await sb.objectStore.head(storageKey)
      expect(after?.hash).toBe(before?.hash)
      expect(after?.compressedSize).toBe(before?.compressedSize)
      expect(sb.objectStore.size()).toBe(1)
    } finally {
      await sb.close()
    }
  })
})

describe('CQ-141 (seal): linked pack with missing object-store bytes fails closed', () => {
  it('throws SealPromotionPackBytesMissingError and restores staging to its prior status', async () => {
    const pglite = new PGlite()
    try {
      await applySchema(pglite)
      await applyV2PromotionSubsetSchema(pglite)
      const db = openPgliteDatabase(pglite)
      const objectStore = new MemoryObjectStore()

      const tenantId = 'tenant-cq141-seal'
      const promotionId = 'prm_cq141seal'
      const storeId = 'store-cq141'
      const deviceId = 'dev-cq141'
      const bundleRoot = 'cq141seal'.padEnd(64, '0')
      const packDigest = `blake3:${blake3Hex(new Uint8Array([42]))}`

      // Inventory bytes present so the inventory check passes.
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
            // Declared objects = 0 so the CQ-134 coverage check
            // skips and the new pack-presence check is the only
            // remaining gate.
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

      // Catalog: a pack linked to this promotion. Storage URI is
      // canonical but no bytes exist — simulates out-of-band
      // byte loss between upload and seal.
      const packStorageKey = `object-packs/${tenantId}/${packDigest.slice('blake3:'.length)}.pack`
      await db.rawExec(
        `INSERT INTO remote_pack (
           tenant_id, pack_digest, kind, entry_count, byte_length,
           object_set_root, standalone_large_object, storage_uri
         )
         VALUES ($1, $2, 'cas_object_pack', 1, 64, $3, false, $4)`,
        [tenantId, packDigest, 'cq141'.padEnd(64, '0'), packStorageKey],
      )
      await db.rawExec(
        `INSERT INTO promotion_uploaded_pack (promotion_id, tenant_id, pack_digest) VALUES ($1, $2, $3)`,
        [promotionId, tenantId, packDigest],
      )
      // Confirm storage really is empty for that key.
      expect(await objectStore.head(packStorageKey)).toBeNull()

      const signer = createLocalReceiptSigner({ kidPrefix: 'cq141-seal' })
      await expect(
        sealPromotion(
          { rawExec: db.rawExec, transaction: db.transaction, tenantId, objectStore, signer },
          { promotionId },
        ),
      ).rejects.toBeInstanceOf(SealPromotionPackBytesMissingError)

      // CQ-135 wrapper restored the slot.
      const rows = await db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
        promotionId,
      ])
      expect(rows[0]!.status).toBe('open')

      // No authority / receipt / grant rows written.
      const counts = await db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await pglite.close()
    }
  })
})
