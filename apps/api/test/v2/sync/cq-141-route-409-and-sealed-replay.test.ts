// CQ-141 route-level + sealed-replay coverage.
//
// Governor 2026-05-20 flagged that the prior closure attempt had:
//   1. No route-level (HTTP) evidence that
//      `UploadObjectPackBytesCorruptError` maps to
//      `409 PACK_BYTES_CORRUPT` and
//      `SealPromotionPackBytesMismatchError` maps to
//      `409 PACK_BYTES_MISMATCH`. Unit-level tests prove the
//      error class is thrown; route mapping was unverified.
//   2. The `status='sealed'` idempotent-replay branch returned
//      the existing receipt WITHOUT re-running linked-pack byte
//      verification. An out-of-band swap / loss after the
//      original seal would otherwise let a replay claim
//      authority over bytes the server can't honestly serve.
//
// This file pins all three via the Fastify HTTP injection
// harness (real route → handler → DB → object store path).

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function blake3Hex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of blake3(bytes)) out += byte.toString(16).padStart(2, '0')
  return out
}

function transportHashOf(bytes: Uint8Array): string {
  return `blake3:${blake3Hex(bytes)}`
}

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const r = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(r.statusCode).toBe(200)
  return (r.json() as { result: { data: { token: string; tenant: { id: string } } } }).result.data
}

function buildBeginBody(opts: { tenantId: string; storeId?: string; objInv: Uint8Array; projInv: Uint8Array }) {
  const storeId = opts.storeId ?? 'store-cq141'
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId,
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId,
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot: 'aa'.repeat(32),
      rawSourceRoot: '11'.repeat(32),
      manifestDigest: `blake3:${'22'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: 1,
        sessions: 1,
        messages: 1,
        events: 0,
        contentBlocks: 0,
        turns: 0,
        toolCalls: 0,
        toolResults: 0,
        artifacts: 0,
        edges: 0,
        searchDocs: 1,
        projectionRows: 2,
      },
      segments: [],
    },
    inventories: {
      objectInventorySegment: {
        segmentId: 'cq141-obj',
        kind: 'inventory_object',
        digest: `blake3:${blake3Hex(opts.objInv)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: opts.objInv.byteLength,
      },
      projectionInventorySegment: {
        segmentId: 'cq141-proj',
        kind: 'inventory_projection',
        digest: `blake3:${blake3Hex(opts.projInv)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: opts.projInv.byteLength,
      },
    },
    device: { deviceId: 'dev-cq141' },
  }
}

describe('CQ-141 route mapping: upload wrong-content → 409 PACK_BYTES_CORRUPT', () => {
  it('returns 409 PACK_BYTES_CORRUPT and leaves stored bytes intact', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141-route-corrupt@example.com', 'Acme', 'acme-cq141-rc')
      const objInvBytes = new TextEncoder().encode('cq141-obj-inv')
      const projInvBytes = new TextEncoder().encode('cq141-proj-inv')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          objInv: objInvBytes,
          projInv: projInvBytes,
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      // First upload: bytes + catalog row present.
      const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq141-route-payload'), compression: 'zstd' }], {
        createdAt: '2026-05-20T00:00:00.000Z',
      })
      const transportHash = transportHashOf(pack.bytes)
      const first = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(first.statusCode).toBe(200)
      const storageKey = (first.json() as { storageKey: string }).storageKey

      // Corrupt the storage object out-of-band: delete + write
      // wrong bytes. The catalog row stays intact and points at
      // the canonical key.
      await t.objectStore.delete(storageKey)
      const corruptBytes = new TextEncoder().encode('corrupt-different-bytes-route-test')
      await t.objectStore.putIfAbsent(
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

      // Re-upload the SAME canonical pack: catalog says
      // (tenant, pack_digest) is known, head() returns wrong
      // bytes. Route must surface 409 PACK_BYTES_CORRUPT.
      const second = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(second.statusCode).toBe(409)
      const body = second.json() as { code: string; op: string; packDigest: string; storageKey: string }
      expect(body.code).toBe('PACK_BYTES_CORRUPT')
      expect(body.op).toBe('UploadObjectPack')
      expect(body.packDigest).toBe(pack.packDigest)
      expect(body.storageKey).toBe(storageKey)

      // The corrupt bytes are STILL present — fail-closed must
      // not delete the existing storage object.
      const after = await t.objectStore.head(storageKey)
      expect(after).not.toBeNull()
      expect(after!.hash.toLowerCase()).toBe(blake3Hex(corruptBytes))
    } finally {
      await t.close()
    }
  })
})

describe('CQ-141 route mapping: seal mismatch → 409 PACK_BYTES_MISMATCH', () => {
  it('returns 409 PACK_BYTES_MISMATCH when linked-pack head() has wrong hash, and restores staging', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141-route-mismatch@example.com', 'Acme', 'acme-cq141-rm')
      const objInvBytes = new TextEncoder().encode('cq141-obj-inv')
      const projInvBytes = new TextEncoder().encode('cq141-proj-inv')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          objInv: objInvBytes,
          projInv: projInvBytes,
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      // Upload a valid pack so the catalog + bytes are healthy.
      const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq141-mismatch-payload'), compression: 'zstd' }], {
        createdAt: '2026-05-20T00:00:00.000Z',
      })
      const transportHash = transportHashOf(pack.bytes)
      const uploadRes = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(uploadRes.statusCode).toBe(200)
      const storageKey = (uploadRes.json() as { storageKey: string }).storageKey

      // Upload inventory segments so seal's inventory presence
      // check passes.
      for (const segment of [
        { id: 'cq141-obj', bytes: objInvBytes },
        { id: 'cq141-proj', bytes: projInvBytes },
      ]) {
        const segRes = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/${segment.id}`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHashOf(segment.bytes),
            'x-prosa-device-id': 'dev-cq141',
          },
          payload: Buffer.from(segment.bytes),
        })
        expect(segRes.statusCode).toBe(200)
      }

      // Corrupt the linked pack's bytes out-of-band: same size,
      // wrong hash.
      const wrongBytes = new Uint8Array(pack.bytes.byteLength)
      wrongBytes.fill(0x55)
      await t.objectStore.delete(storageKey)
      await t.objectStore.putIfAbsent(
        storageKey,
        (async function* () {
          yield wrongBytes
        })(),
        {
          hash: blake3Hex(wrongBytes),
          hashAlgorithm: 'blake3',
          uncompressedSize: wrongBytes.byteLength,
          compressedSize: wrongBytes.byteLength,
        },
      )

      // Seal must fail closed with 409 PACK_BYTES_MISMATCH.
      const sealRes = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: {} as never,
      })
      expect(sealRes.statusCode).toBe(409)
      const body = sealRes.json() as { code: string; op: string; mismatches: Array<{ packDigest: string }> }
      expect(body.code).toBe('PACK_BYTES_MISMATCH')
      expect(body.op).toBe('SealPromotion')
      expect(body.mismatches?.length).toBeGreaterThan(0)
      expect(body.mismatches[0]!.packDigest).toBe(pack.packDigest)

      // Staging restored to a re-usable status (CQ-135 wrapper).
      const stagingRows = await t.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
        promotionId,
      ])
      expect(['open', 'uploading']).toContain(stagingRows[0]!.status)

      // Zero receipt / authority / grant rows survived the
      // failed seal.
      const counts = await t.db.rawExec<{ receipts: number; authorities: number; grants: number }>(
        `SELECT
           (SELECT count(*)::int FROM receipt) AS receipts,
           (SELECT count(*)::int FROM remote_authority_v2) AS authorities,
           (SELECT count(*)::int FROM receipt_pack_grant) AS grants`,
      )
      expect(counts[0]!).toMatchObject({ receipts: 0, authorities: 0, grants: 0 })
    } finally {
      await t.close()
    }
  })
})

describe('CQ-141 sealed-replay: re-verifies linked-pack bytes before returning existing receipt', () => {
  it('fails closed when linked-pack bytes were lost out-of-band after the original seal', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141-replay-loss@example.com', 'Acme', 'acme-cq141-rl')
      const objInvBytes = new TextEncoder().encode('cq141-obj-inv')
      const projInvBytes = new TextEncoder().encode('cq141-proj-inv')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          objInv: objInvBytes,
          projInv: projInvBytes,
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const pack = buildCasPack(
        [{ bytes: new TextEncoder().encode('cq141-replay-loss-payload'), compression: 'zstd' }],
        {
          createdAt: '2026-05-20T00:00:00.000Z',
        },
      )
      const transportHash = transportHashOf(pack.bytes)
      const uploadRes = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(uploadRes.statusCode).toBe(200)
      const storageKey = (uploadRes.json() as { storageKey: string }).storageKey

      for (const segment of [
        { id: 'cq141-obj', bytes: objInvBytes },
        { id: 'cq141-proj', bytes: projInvBytes },
      ]) {
        const segRes = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/${segment.id}`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHashOf(segment.bytes),
            'x-prosa-device-id': 'dev-cq141',
          },
          payload: Buffer.from(segment.bytes),
        })
        expect(segRes.statusCode).toBe(200)
      }

      // First seal succeeds — the bytes are healthy.
      const firstSeal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: {} as never,
      })
      expect(firstSeal.statusCode).toBe(200)
      const sealedReceiptId = (firstSeal.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload
        .receiptId

      // Promotion is now `sealed`. Lose the pack bytes
      // out-of-band — the catalog row + sealed_receipt_id link
      // both remain.
      await t.objectStore.delete(storageKey)
      expect(await t.objectStore.head(storageKey)).toBeNull()

      // Replay the seal: the idempotent `status='sealed'` branch
      // must NOT return the original receipt; it must re-verify
      // the linked pack bytes and fail closed.
      const replay = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: {} as never,
      })
      expect(replay.statusCode).toBe(409)
      const body = replay.json() as { code: string; op: string; missingPackDigests?: string[] }
      expect(body.code).toBe('PACK_BYTES_MISSING')
      expect(body.op).toBe('SealPromotion')
      expect(body.missingPackDigests).toContain(pack.packDigest)

      // The original sealed_receipt_id is still on the staging
      // row (we did NOT touch the catalog / receipt rows on the
      // sealed-replay path — only fail closed on byte check).
      const stagingRows = await t.db.rawExec<{ status: string; sealed_receipt_id: string | null }>(
        `SELECT status, sealed_receipt_id FROM promotion_staging WHERE id = $1`,
        [promotionId],
      )
      expect(stagingRows[0]!.status).toBe('sealed')
      expect(stagingRows[0]!.sealed_receipt_id).toBe(sealedReceiptId)
    } finally {
      await t.close()
    }
  })

  it('fails closed when linked-pack bytes were swapped to wrong nonzero content after the original seal', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141-replay-swap@example.com', 'Acme', 'acme-cq141-rs')
      const objInvBytes = new TextEncoder().encode('cq141-obj-inv')
      const projInvBytes = new TextEncoder().encode('cq141-proj-inv')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          objInv: objInvBytes,
          projInv: projInvBytes,
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const pack = buildCasPack(
        [{ bytes: new TextEncoder().encode('cq141-replay-swap-payload'), compression: 'zstd' }],
        {
          createdAt: '2026-05-20T00:00:00.000Z',
        },
      )
      const transportHash = transportHashOf(pack.bytes)
      const uploadRes = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(uploadRes.statusCode).toBe(200)
      const storageKey = (uploadRes.json() as { storageKey: string }).storageKey

      for (const segment of [
        { id: 'cq141-obj', bytes: objInvBytes },
        { id: 'cq141-proj', bytes: projInvBytes },
      ]) {
        const segRes = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/${segment.id}`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHashOf(segment.bytes),
            'x-prosa-device-id': 'dev-cq141',
          },
          payload: Buffer.from(segment.bytes),
        })
        expect(segRes.statusCode).toBe(200)
      }

      const firstSeal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: {} as never,
      })
      expect(firstSeal.statusCode).toBe(200)

      // Swap the linked pack bytes for same-size wrong content.
      const wrongBytes = new Uint8Array(pack.bytes.byteLength)
      wrongBytes.fill(0x33)
      await t.objectStore.delete(storageKey)
      await t.objectStore.putIfAbsent(
        storageKey,
        (async function* () {
          yield wrongBytes
        })(),
        {
          hash: blake3Hex(wrongBytes),
          hashAlgorithm: 'blake3',
          uncompressedSize: wrongBytes.byteLength,
          compressedSize: wrongBytes.byteLength,
        },
      )

      const replay = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq141',
        },
        payload: {} as never,
      })
      expect(replay.statusCode).toBe(409)
      const body = replay.json() as { code: string; op: string; mismatches?: Array<{ packDigest: string }> }
      expect(body.code).toBe('PACK_BYTES_MISMATCH')
      expect(body.op).toBe('SealPromotion')
      expect(body.mismatches?.[0]!.packDigest).toBe(pack.packDigest)
    } finally {
      await t.close()
    }
  })
})
