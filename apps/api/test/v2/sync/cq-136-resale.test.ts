// CQ-136: re-sealing an old sealed promotion must return the
// receipt that promotion actually sealed, not the store's current
// authority pointer.
//
// Scenario: seal bundle A for `store-X`, then seal bundle B for the
// same `store-X` (this advances `remote_authority_v2`). Re-issuing
// `SealPromotion` against the old (A) promotionId must return A's
// receipt, not B's.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
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

function buildFixture(label: string) {
  const objBytes = new TextEncoder().encode(`${label}-obj-inv`)
  const projBytes = new TextEncoder().encode(`${label}-proj-inv`)
  const pack = buildCasPack([{ bytes: new TextEncoder().encode(`${label}-payload`), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  return {
    pack,
    objBytes,
    projBytes,
    objDigest: transportHashOf(objBytes),
    projDigest: transportHashOf(projBytes),
  }
}

function buildBeginBody(opts: {
  tenantId: string
  storeId: string
  bundleRoot: string
  declaredObjectCount: number
  fx: ReturnType<typeof buildFixture>
}) {
  const { fx } = opts
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: opts.storeId,
      storePath: '/home/test/store',
      epoch: 0,
      parserVersion: '0.1.0',
      createdAt: '2026-05-20T00:00:00.000Z',
      previousBundleRoot: null,
      bundleRoot: opts.bundleRoot,
      rawSourceRoot: '11'.repeat(32),
      manifestDigest: `blake3:${'22'.repeat(32)}`,
      counts: {
        sourceFiles: 0,
        rawRecords: 0,
        objects: opts.declaredObjectCount,
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
        segmentId: `${opts.bundleRoot}-obj`,
        kind: 'inventory_object',
        digest: fx.objDigest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: fx.objBytes.byteLength,
      },
      projectionInventorySegment: {
        segmentId: `${opts.bundleRoot}-proj`,
        kind: 'inventory_projection',
        digest: fx.projDigest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: fx.projBytes.byteLength,
      },
    },
    device: { deviceId: 'dev-cq136' },
  }
}

async function drivePromotion(
  t: TestApp,
  token: string,
  body: ReturnType<typeof buildBeginBody>,
  fx: ReturnType<typeof buildFixture>,
) {
  const begin = await t.app.inject({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: body as never,
  })
  expect(begin.statusCode).toBe(200)
  const { promotionId } = begin.json() as { promotionId: string }

  const uploads = [
    {
      segmentId: body.inventories.objectInventorySegment.segmentId,
      bytes: fx.objBytes,
      digest: fx.objDigest,
    },
    {
      segmentId: body.inventories.projectionInventorySegment.segmentId,
      bytes: fx.projBytes,
      digest: fx.projDigest,
    },
  ]
  for (const upload of uploads) {
    const r = await t.app.inject({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/${upload.segmentId}`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${token}`,
        'x-prosa-transport-hash': upload.digest,
        'x-prosa-device-id': 'dev-cq136',
      },
      payload: Buffer.from(upload.bytes),
    })
    expect(r.statusCode).toBe(200)
  }
  return { promotionId }
}

describe('CQ-136: re-sealing an old promotion returns its own receipt', () => {
  it("after seal A then seal B for the same store, re-sealing A returns A's receipt", async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136@example.com', 'Acme', 'acme-cq136')
      const storeId = 'store-cq136'

      // Seal bundle A.
      const fxA = buildFixture('cq136-a')
      const bodyA = buildBeginBody({
        tenantId: account.tenant.id,
        storeId,
        bundleRoot: 'aa'.repeat(32),
        declaredObjectCount: 1,
        fx: fxA,
      })
      const { promotionId: idA } = await drivePromotion(t, account.token, bodyA, fxA)
      // Upload A's pack.
      await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${idA}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHashOf(fxA.pack.bytes),
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: Buffer.from(fxA.pack.bytes),
      })
      const sealA = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${idA}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      expect(sealA.statusCode).toBe(200)
      const receiptIdA = (sealA.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId

      // Seal bundle B for the same store — this updates remote_authority_v2.
      const fxB = buildFixture('cq136-b')
      const bodyB = buildBeginBody({
        tenantId: account.tenant.id,
        storeId,
        bundleRoot: 'bb'.repeat(32),
        declaredObjectCount: 1,
        fx: fxB,
      })
      const { promotionId: idB } = await drivePromotion(t, account.token, bodyB, fxB)
      await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${idB}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHashOf(fxB.pack.bytes),
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: Buffer.from(fxB.pack.bytes),
      })
      const sealB = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${idB}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      expect(sealB.statusCode).toBe(200)
      const receiptIdB = (sealB.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId
      expect(receiptIdB).not.toBe(receiptIdA)

      // Confirm the store's authority points to B's receipt.
      const authority = await t.db.rawExec<{ current_receipt_id: string }>(
        `SELECT current_receipt_id FROM remote_authority_v2 WHERE tenant_id = $1 AND store_id = $2`,
        [account.tenant.id, storeId],
      )
      expect(authority[0]!.current_receipt_id).toBe(receiptIdB)

      // Re-seal A — must return A's receipt, not B's.
      const reSealA = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${idA}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      expect(reSealA.statusCode).toBe(200)
      const reSealAReceiptId = (reSealA.json() as { receipt: { payload: { receiptId: string; bundleRoot: string } } })
        .receipt.payload.receiptId
      expect(reSealAReceiptId).toBe(receiptIdA)
      expect(reSealAReceiptId).not.toBe(receiptIdB)
    } finally {
      await t.close()
    }
  })

  it('fails closed with SEAL_LINK_CORRUPT when sealed_receipt_id points at a tuple-mismatched receipt', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136-corrupt@example.com', 'Acme', 'acme-cq136-corrupt')
      const fx = buildFixture('cq136-corrupt')
      const body = buildBeginBody({
        tenantId: account.tenant.id,
        storeId: 'store-cq136-corrupt',
        bundleRoot: 'dd'.repeat(32),
        declaredObjectCount: 1,
        fx,
      })
      const { promotionId } = await drivePromotion(t, account.token, body, fx)
      await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: Buffer.from(fx.pack.bytes),
      })
      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(200)
      const receiptId = (seal.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId

      // Tamper: insert a same-tenant receipt for a DIFFERENT
      // store / bundleRoot and re-point sealed_receipt_id at it.
      // The replay branch must refuse to return it.
      const foreignReceiptId = 'rcpt_cq136_foreign_link'
      const foreignPayload = {
        receiptVersion: 2,
        receiptId: foreignReceiptId,
        protocolVersion: 2,
        tenantId: account.tenant.id,
        storeId: 'store-other', // different store
        storePath: '/home/test/store',
        deviceId: 'dev-other',
        issuedAt: '2026-05-20T00:00:00.000Z',
        serverRegion: 'test',
        serverKeyId: 'test-key',
        previousReceiptId: null,
        previousBundleRoot: null,
        bundleRoot: 'ff'.repeat(32),
        rawSourceRoot: '00'.repeat(32),
        counts: {},
        materialization: {},
        verification: {},
        clientSignatureStatus: 'absent_v2_0',
      }
      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [
          foreignReceiptId,
          account.tenant.id,
          'store-other',
          'dev-other',
          JSON.stringify(foreignPayload),
          JSON.stringify({ alg: 'Ed25519', keyId: 'test-key', sig: Buffer.alloc(64).toString('base64url') }),
        ],
      )
      await t.db.rawExec(`UPDATE promotion_staging SET sealed_receipt_id = $1 WHERE id = $2`, [
        foreignReceiptId,
        promotionId,
      ])

      const replay = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      expect(replay.statusCode).toBe(500)
      const body2 = replay.json() as { code: string; message: string }
      expect(body2.code).toBe('SEAL_LINK_CORRUPT')
      expect(body2.message).toContain(promotionId)

      // The legitimate receipt is still in the catalog —
      // existence wasn't damaged, only the replay path refused.
      const rows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt WHERE receipt_id = $1`,
        [receiptId],
      )
      expect(Number(rows[0]!.count)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('persists sealed_receipt_id on the staging row inside the seal transaction', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq136-link@example.com', 'Acme', 'acme-cq136-link')
      const fx = buildFixture('cq136-link')
      const body = buildBeginBody({
        tenantId: account.tenant.id,
        storeId: 'store-cq136-link',
        bundleRoot: 'cc'.repeat(32),
        declaredObjectCount: 1,
        fx,
      })
      const { promotionId } = await drivePromotion(t, account.token, body, fx)
      await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: Buffer.from(fx.pack.bytes),
      })

      const beforeRow = await t.db.rawExec<{ sealed_receipt_id: string | null }>(
        `SELECT sealed_receipt_id FROM promotion_staging WHERE id = $1`,
        [promotionId],
      )
      expect(beforeRow[0]!.sealed_receipt_id).toBeNull()

      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq136',
        },
        payload: {} as never,
      })
      const receiptId = (seal.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId

      const afterRow = await t.db.rawExec<{ status: string; sealed_receipt_id: string | null }>(
        `SELECT status, sealed_receipt_id FROM promotion_staging WHERE id = $1`,
        [promotionId],
      )
      expect(afterRow[0]!.status).toBe('sealed')
      expect(afterRow[0]!.sealed_receipt_id).toBe(receiptId)
    } finally {
      await t.close()
    }
  })
})
