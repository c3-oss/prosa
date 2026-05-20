// CQ-134: SealPromotion must refuse to swap authority when the
// bundle's declared object count exceeds the number of objects
// linked through `promotion_uploaded_pack → remote_pack_entry`.
// Sealing without proof of object coverage would emit a cleanup
// authorization for bytes the remote cannot serve.
//
// We test the happy-path-without-pack-upload scenario: BeginPromotion
// declares N objects, both inventories are uploaded, but no object
// pack is uploaded. SealPromotion must return 409 with code
// OBJECT_COVERAGE_INCOMPLETE and write no receipt / authority /
// grant rows.

import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { result: { data: { token: string; tenant: { id: string } } } }).result.data
}

function buildBeginBody(opts: {
  tenantId: string
  bundleRoot: string
  declaredObjectCount: number
  objDigest: string
  objSize: number
  projDigest: string
  projSize: number
}) {
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: 'store-cq134',
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: 'store-cq134',
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
        segmentId: 'cq134-obj-inv',
        kind: 'inventory_object',
        digest: opts.objDigest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: opts.objSize,
      },
      projectionInventorySegment: {
        segmentId: 'cq134-proj-inv',
        kind: 'inventory_projection',
        digest: opts.projDigest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: opts.projSize,
      },
    },
    device: { deviceId: 'dev-cq134' },
  }
}

describe('CQ-134: SealPromotion refuses authority swap without object coverage', () => {
  it('seal with declared objects but zero uploaded packs returns 409 OBJECT_COVERAGE_INCOMPLETE', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq134-no-pack@example.com', 'Acme', 'acme-cq134-np')
      const objBytes = new TextEncoder().encode('cq134-obj-inv')
      const projBytes = new TextEncoder().encode('cq134-proj-inv')
      const objDigest = transportHashOf(objBytes)
      const projDigest = transportHashOf(projBytes)
      const bundleRoot = 'aa'.repeat(32)

      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          bundleRoot,
          declaredObjectCount: 7, // declares 7 objects
          objDigest,
          objSize: objBytes.byteLength,
          projDigest,
          projSize: projBytes.byteLength,
        }) as never,
      })
      expect(begin.statusCode).toBe(200)
      const { promotionId } = begin.json() as { promotionId: string }

      // Upload both inventories — but DO NOT upload any object pack.
      for (const [segmentId, body, digest] of [
        ['cq134-obj-inv', objBytes, objDigest] as const,
        ['cq134-proj-inv', projBytes, projDigest] as const,
      ]) {
        const upload = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/${segmentId}`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': digest,
            'x-prosa-device-id': 'dev-cq134',
          },
          payload: Buffer.from(body),
        })
        expect(upload.statusCode).toBe(200)
      }

      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq134',
        },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(409)
      const body = seal.json() as {
        code: string
        declaredObjectCount: number
        catalogObjectCount: number
      }
      expect(body.code).toBe('OBJECT_COVERAGE_INCOMPLETE')
      expect(body.declaredObjectCount).toBe(7)
      expect(body.catalogObjectCount).toBe(0)

      // No receipt, no authority, no grant rows.
      const receiptCount = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(Number(receiptCount[0]!.count)).toBe(0)
      const authorityCount = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM remote_authority_v2 WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(Number(authorityCount[0]!.count)).toBe(0)
      const grantCount = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM receipt_pack_grant WHERE tenant_id = $1`,
        [account.tenant.id],
      )
      expect(Number(grantCount[0]!.count)).toBe(0)

      // Staging restored from materializing back to open so the
      // client can retry after uploading the pack (CQ-135).
      const staging = await t.db.rawExec<{ status: string }>(`SELECT status FROM promotion_staging WHERE id = $1`, [
        promotionId,
      ])
      expect(staging[0]!.status).toBe('open')
    } finally {
      await t.close()
    }
  })

  it('bundles declaring zero objects (e.g. empty initial promotion) still seal cleanly', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq134-empty@example.com', 'Acme', 'acme-cq134-empty')
      const objBytes = new TextEncoder().encode('cq134-empty-obj-inv')
      const projBytes = new TextEncoder().encode('cq134-empty-proj-inv')
      const bundleRoot = 'bb'.repeat(32)

      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          bundleRoot,
          declaredObjectCount: 0,
          objDigest: transportHashOf(objBytes),
          objSize: objBytes.byteLength,
          projDigest: transportHashOf(projBytes),
          projSize: projBytes.byteLength,
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }
      for (const [segmentId, body, digest] of [
        ['cq134-obj-inv', objBytes, transportHashOf(objBytes)] as const,
        ['cq134-proj-inv', projBytes, transportHashOf(projBytes)] as const,
      ]) {
        await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/${segmentId}`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': digest,
            'x-prosa-device-id': 'dev-cq134',
          },
          payload: Buffer.from(body),
        })
      }
      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': 'dev-cq134',
        },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(200)
      expect((seal.json() as { status: string }).status).toBe('sealed')
    } finally {
      await t.close()
    }
  })
})
