// CQ-132: UploadObjectPack must delete the freshly-written object-store
// bytes when the remote_pack catalog INSERT fails for any reason
// other than the idempotent unique_violation (23505) it already
// handles.
//
// The handler exposes that policy by:
// 1. Tracking `putIfAbsent`'s `alreadyExisted` flag — only bytes
//    THIS request wrote are eligible for cleanup.
// 2. Catching non-23505 errors from the catalog transaction,
//    best-effort calling `objectStore.delete(storageKey)`, and
//    rethrowing the original error.
//
// We test the function directly (rather than through the HTTP
// route) so we can inject a transaction that throws after the
// object-store write commits. The test asserts the storage key is
// absent afterwards.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { applySchema } from '@c3-oss/prosa-db'
import { PACKS_SCHEMA_SQL, PROMOTION_SCHEMA_SQL } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}
import { openPgliteDatabase } from '../../../src/db.js'
import {
  UploadObjectPackValidationError,
  objectPackStorageKey,
  uploadObjectPack,
} from '../../../src/v2/sync/upload-object-pack.js'

async function buildSandbox() {
  const pglite = new PGlite()
  await applySchema(pglite)
  await pglite.exec(PROMOTION_SCHEMA_SQL)
  await pglite.exec(PACKS_SCHEMA_SQL.replace(/CREATE TABLE IF NOT EXISTS remote_object[\s\S]*?\);/u, ''))
  const db = openPgliteDatabase(pglite)
  const objectStore = new MemoryObjectStore()
  const tenantId = 'tenant-cq132'
  const promotionId = 'prm_cq132'
  await db.rawExec(
    `INSERT INTO promotion_staging (id, tenant_id, user_id, device_id, store_id, store_path, status, head_json, inventory_object_ref, inventory_projection_ref)
     VALUES ($1, $2, 'user-cq132', 'dev-cq132', 'store-cq132', '/home/test/store', 'open', $3::jsonb, NULL, NULL)`,
    [promotionId, tenantId, JSON.stringify({ bundleRoot: 'cq132'.padEnd(64, '0') })],
  )
  return {
    pglite,
    db,
    objectStore,
    tenantId,
    promotionId,
    close: async () => {
      await pglite.close()
    },
  }
}

function buildPack() {
  return buildCasPack([{ bytes: new TextEncoder().encode('cq132-pack-content'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
}

describe('CQ-132: UploadObjectPack cleans up orphan bytes on catalog failure', () => {
  it('best-effort deletes the storage key when the catalog INSERT throws', async () => {
    const sb = await buildSandbox()
    try {
      const pack = buildPack()
      const failingTransaction = async <T>(_fn: (tx: typeof sb.db.rawExec) => Promise<T>): Promise<T> => {
        // Run no SQL — just throw. The handler's transaction body
        // never sees a chance to INSERT into remote_pack, so a
        // catalog-side failure is the only reason the bytes could
        // be orphaned.
        throw new Error('simulated catalog failure (cq-132)')
      }

      await expect(
        uploadObjectPack(
          {
            rawExec: sb.db.rawExec,
            transaction: failingTransaction as unknown as typeof sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
          },
          {
            promotionId: sb.promotionId,
            body: pack.bytes,
            declaredPackDigest: pack.packDigest,
            transportHash: transportHashOf(pack.bytes),
          },
        ),
      ).rejects.toThrow(/simulated catalog failure/)

      const key = objectPackStorageKey(sb.tenantId, pack.packDigest)
      const meta = await sb.objectStore.head(key)
      expect(meta).toBeNull()
      expect(sb.objectStore.size()).toBe(0)

      // No remote_pack row was inserted either.
      const rows = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack WHERE tenant_id = $1`,
        [sb.tenantId],
      )
      expect(Number(rows[0]!.count)).toBe(0)
    } finally {
      await sb.close()
    }
  })

  it('leaves pre-existing bytes intact when an idempotent retry hits the catalog fast path', async () => {
    const sb = await buildSandbox()
    try {
      const pack = buildPack()

      // First upload via the real db.transaction — succeeds and
      // stores bytes + catalog rows.
      const okResult = await uploadObjectPack(
        {
          rawExec: sb.db.rawExec,
          transaction: sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.objectStore,
        },
        { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
      )
      expect(okResult.status).toBe('accepted')
      const key = objectPackStorageKey(sb.tenantId, pack.packDigest)
      expect(await sb.objectStore.head(key)).not.toBeNull()

      // Second upload: pre-existing catalog row hits the fast path
      // before the transaction runs. Use a throwing transaction to
      // prove the route doesn't even open one, AND that the bytes
      // remain in place after the call returns `already_present`.
      const exploder = async <T>(_fn: (tx: typeof sb.db.rawExec) => Promise<T>): Promise<T> => {
        throw new Error('transaction should not run on idempotent retry (cq-132)')
      }
      const second = await uploadObjectPack(
        {
          rawExec: sb.db.rawExec,
          transaction: exploder as unknown as typeof sb.db.transaction,
          tenantId: sb.tenantId,
          objectStore: sb.objectStore,
        },
        { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
      )
      expect(second.status).toBe('already_present')
      // Bytes still present.
      expect(await sb.objectStore.head(key)).not.toBeNull()
      // No duplicate rows.
      const rows = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack WHERE tenant_id = $1`,
        [sb.tenantId],
      )
      expect(Number(rows[0]!.count)).toBe(1)
    } finally {
      await sb.close()
    }
  })

  it('still surfaces validation errors before touching the object store', async () => {
    const sb = await buildSandbox()
    try {
      const pack = buildPack()
      // Invalid pack bytes — verifyCasPack rejects before any
      // putIfAbsent runs, so there is no cleanup to do.
      const corrupted = new Uint8Array(pack.bytes.byteLength)
      corrupted.fill(0x42)
      await expect(
        uploadObjectPack(
          {
            rawExec: sb.db.rawExec,
            transaction: sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
          },
          { promotionId: sb.promotionId, body: corrupted, transportHash: transportHashOf(corrupted) },
        ),
      ).rejects.toBeInstanceOf(UploadObjectPackValidationError)
      expect(sb.objectStore.size()).toBe(0)
    } finally {
      await sb.close()
    }
  })

  it('does not delete bytes a racing request already catalogued (CQ-132 race interleaving)', async () => {
    // Scenario flagged in the reviewer rejection:
    //  - Request A writes bytes (alreadyExisted=false,
    //    newlyWritten=true) and then its catalog transaction
    //    throws non-23505.
    //  - Meanwhile request B observed the same bytes via
    //    putIfAbsent (alreadyExisted=true) and successfully
    //    committed its remote_pack rows.
    //  - A's cleanup must NOT delete the bytes — that would
    //    orphan B's catalog rows.
    //
    // We simulate B by inserting the catalog row directly
    // between A's putIfAbsent and A's failing transaction. The
    // helper exposes the transaction it will run via the
    // injected closure, so we use the seam to drop in the
    // simulated B catalog row before throwing.
    const sb = await buildSandbox()
    try {
      const pack = buildPack()
      const observedDigest = pack.packDigest
      const interleavingTransaction = async <T>(_fn: (tx: typeof sb.db.rawExec) => Promise<T>): Promise<T> => {
        // Simulate concurrent request B: directly write the
        // remote_pack catalog row for this digest as if B
        // committed first.
        await sb.db.rawExec(
          `INSERT INTO remote_pack (
             tenant_id, pack_digest, kind, entry_count, byte_length,
             object_set_root, standalone_large_object, storage_uri
           )
           VALUES ($1, $2, 'cas_object_pack', 1, $3, $4, false, $5)`,
          [
            sb.tenantId,
            observedDigest,
            pack.bytes.byteLength,
            '00'.repeat(32),
            `object-packs/${sb.tenantId}/${observedDigest.slice('blake3:'.length)}.pack`,
          ],
        )
        throw new Error('simulated non-23505 catalog failure with racing B commit (cq-132)')
      }

      await expect(
        uploadObjectPack(
          {
            rawExec: sb.db.rawExec,
            transaction: interleavingTransaction as unknown as typeof sb.db.transaction,
            tenantId: sb.tenantId,
            objectStore: sb.objectStore,
          },
          { promotionId: sb.promotionId, body: pack.bytes, transportHash: transportHashOf(pack.bytes) },
        ),
      ).rejects.toThrow(/cq-132/)

      // Bytes remain because the racing B catalog row references
      // them. The race-safe cleanup re-checks remote_pack and
      // declines to delete when the digest is now catalogued.
      const key = objectPackStorageKey(sb.tenantId, observedDigest)
      expect(await sb.objectStore.head(key)).not.toBeNull()
      const rows = await sb.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_pack WHERE tenant_id = $1 AND pack_digest = $2`,
        [sb.tenantId, observedDigest],
      )
      expect(Number(rows[0]!.count)).toBe(1)
    } finally {
      await sb.close()
    }
  })
})
