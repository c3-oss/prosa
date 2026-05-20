// CQ-135: SealPromotion must restore the staging row from
// `materializing` back to its prior status on ANY failure that
// happens after the status flip. The reviewer rejected the
// earlier closure because `promotion_uploaded_pack` lookup,
// `signer.currentKeyId()`, `buildReceiptPayload(...)`, and the
// load-bearing transaction can all throw after the flip — and
// none had explicit failure-injection coverage.
//
// We exercise the function directly so we can inject signer +
// transaction failures into a real PGlite + MemoryObjectStore
// sandbox.

import { applySchema } from '@c3-oss/prosa-db'
import { applyV2PromotionSubsetSchema } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

function blake3Hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}
import { openPgliteDatabase } from '../../../src/db.js'
import type { ReceiptSigner } from '../../../src/v2/signing/local-signer.js'
import { createLocalReceiptSigner } from '../../../src/v2/signing/local-signer.js'
import { sealPromotion } from '../../../src/v2/sync/seal-promotion.js'

const tenantId = 'tenant-cq135'
const promotionId = 'prm_cq135'
const storeId = 'store-cq135'
const deviceId = 'dev-cq135'
const bundleRoot = 'cq135'.padEnd(64, '0')

async function buildSandbox() {
  const pglite = new PGlite()
  await applySchema(pglite)
  await applyV2PromotionSubsetSchema(pglite)
  const db = openPgliteDatabase(pglite)
  const objectStore = new MemoryObjectStore()

  // Seed an open staging row whose inventory blobs are already
  // present in the object store (so seal passes its inventory
  // presence check and we can drive a downstream failure).
  const objectInventory = {
    segmentId: 'cq135-obj-inv',
    kind: 'inventory_object' as const,
    digest: 'blake3:00000000000000000000000000000000000000000000000000000000000000aa',
    logicalRoot: 'objects/inv',
    compression: 'zstd' as const,
    byteLength: 16,
  }
  const projectionInventory = {
    segmentId: 'cq135-proj-inv',
    kind: 'inventory_projection' as const,
    digest: 'blake3:00000000000000000000000000000000000000000000000000000000000000bb',
    logicalRoot: 'projection/inv',
    compression: 'zstd' as const,
    byteLength: 16,
  }
  await db.rawExec(
    `INSERT INTO promotion_staging (
       id, tenant_id, user_id, device_id, store_id, store_path,
       status, head_json, inventory_object_ref, inventory_projection_ref
     ) VALUES ($1, $2, 'user-cq135', $3, $4, '/home/test/store', 'open', $5::jsonb, $6, $7)`,
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

  // Drop the inventory blobs into the object store under the
  // canonical staging key shape. The MemoryObjectStore verifies
  // meta.hash against the literal bytes, so we compute the
  // BLAKE3 directly.
  const stagingKey = (segmentId: string) => `staging/${tenantId}/${promotionId}/${segmentId}`
  const objectInventoryBytes = new TextEncoder().encode('cq135-obj-inv-bytes')
  const projectionInventoryBytes = new TextEncoder().encode('cq135-proj-inv-bytes')
  await objectStore.putIfAbsent(stagingKey(objectInventory.segmentId), asyncOnce(objectInventoryBytes), {
    hash: blake3Hex(objectInventoryBytes),
    hashAlgorithm: 'blake3',
    uncompressedSize: objectInventoryBytes.byteLength,
    compressedSize: objectInventoryBytes.byteLength,
  })
  await objectStore.putIfAbsent(stagingKey(projectionInventory.segmentId), asyncOnce(projectionInventoryBytes), {
    hash: blake3Hex(projectionInventoryBytes),
    hashAlgorithm: 'blake3',
    uncompressedSize: projectionInventoryBytes.byteLength,
    compressedSize: projectionInventoryBytes.byteLength,
  })

  return { pglite, db, objectStore, close: async () => void (await pglite.close()) }
}

async function* asyncOnce(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
  yield bytes
}

function failingSigner(reason: string): ReceiptSigner {
  return {
    async signReceipt() {
      throw new Error(reason)
    },
    async verifyReceipt() {
      return false
    },
    publishJwks() {
      return { keys: [] }
    },
    rotateCurrentKey() {
      return 'unused'
    },
    currentKeyId() {
      return 'unused-kid'
    },
  }
}

async function readStatus(db: { rawExec: <T>(sql: string, params?: unknown[]) => Promise<T[]> }): Promise<string> {
  const rows = await db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [promotionId])
  return rows[0]!.status
}

describe('CQ-135: SealPromotion restores staging on post-flip failure', () => {
  it('signer failure leaves the slot retryable (status returns to open)', async () => {
    const sb = await buildSandbox()
    try {
      const signer = failingSigner('signer-down (cq-135)')
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId },
        ),
      ).rejects.toThrow(/signer-down/)
      expect(await readStatus(sb.db)).toBe('open')

      // No receipt / authority / grant rows written.
      const rows = await sb.db.rawExec<{ count: string | number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants
        `,
      )
      expect(rows[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })

      // Retry with a working signer succeeds.
      const realSigner = createLocalReceiptSigner({ kidPrefix: 'cq135-retry' })
      const retry = await sealPromotion(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId,
          objectStore: sb.objectStore,
          signer: realSigner,
        },
        { promotionId },
      )
      expect(retry.status).toBe('sealed')
      expect(await readStatus(sb.db)).toBe('sealed')
    } finally {
      await sb.close()
    }
  })

  it('currentKeyId failure (signer throws synchronously) restores the slot', async () => {
    const sb = await buildSandbox()
    try {
      const signer: ReceiptSigner = {
        async signReceipt() {
          throw new Error('should not reach')
        },
        async verifyReceipt() {
          return false
        },
        publishJwks() {
          return { keys: [] }
        },
        rotateCurrentKey() {
          return 'unused'
        },
        currentKeyId(): string {
          throw new Error('key-id-down (cq-135)')
        },
      }
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId },
        ),
      ).rejects.toThrow(/key-id-down/)
      expect(await readStatus(sb.db)).toBe('open')
    } finally {
      await sb.close()
    }
  })

  it('transaction failure (after signer succeeds) restores the slot', async () => {
    const sb = await buildSandbox()
    try {
      const signer = createLocalReceiptSigner({ kidPrefix: 'cq135-tx' })
      const throwingTransaction = async <T>(_fn: (tx: typeof sb.db.rawExec) => Promise<T>): Promise<T> => {
        throw new Error('tx-down (cq-135)')
      }
      await expect(
        sealPromotion(
          {
            rawExec: sb.db.rawExec,
            transaction: throwingTransaction as unknown as typeof sb.db.transaction,
            tenantId,
            objectStore: sb.objectStore,
            signer,
          },
          { promotionId },
        ),
      ).rejects.toThrow(/tx-down/)
      expect(await readStatus(sb.db)).toBe('open')
    } finally {
      await sb.close()
    }
  })
})
