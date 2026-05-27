// CQ-137: search_generation_current is per-(tenant, store).
// Sealing a second store in the same tenant must not clobber the
// generation pointer for the first store.

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

async function drivePromotionThroughSeal(opts: {
  t: TestApp
  token: string
  tenantId: string
  storeId: string
  bundleRoot: string
  fx: ReturnType<typeof buildFixture>
}): Promise<{ promotionId: string; receiptId: string }> {
  const { t, token, tenantId, storeId, bundleRoot, fx } = opts
  const begin = await t.app.inject({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {
      protocolVersion: 2,
      tenantId,
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
        bundleRoot,
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
          segmentId: `${storeId}-obj`,
          kind: 'inventory_object',
          digest: fx.objDigest,
          logicalRoot: 'objects/inv',
          compression: 'zstd',
          byteLength: fx.objBytes.byteLength,
        },
        projectionInventorySegment: {
          segmentId: `${storeId}-proj`,
          kind: 'inventory_projection',
          digest: fx.projDigest,
          logicalRoot: 'projection/inv',
          compression: 'zstd',
          byteLength: fx.projBytes.byteLength,
        },
      },
      device: { deviceId: 'dev-cq137' },
    } as never,
  })
  expect(begin.statusCode).toBe(200)
  const { promotionId } = begin.json() as { promotionId: string }

  for (const [segmentId, bytes, digest] of [
    [`${storeId}-obj`, fx.objBytes, fx.objDigest] as const,
    [`${storeId}-proj`, fx.projBytes, fx.projDigest] as const,
  ]) {
    const r = await t.app.inject({
      method: 'PUT',
      url: `/v2/promotions/${promotionId}/segments/${segmentId}`,
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${token}`,
        'x-prosa-transport-hash': digest,
        'x-prosa-device-id': 'dev-cq137',
      },
      payload: Buffer.from(bytes),
    })
    expect(r.statusCode).toBe(200)
  }

  const upPack = await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/object-packs`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
      'x-prosa-device-id': 'dev-cq137',
    },
    payload: Buffer.from(fx.pack.bytes),
  })
  expect(upPack.statusCode).toBe(200)

  const seal = await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/seal`,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${token}`,
      'x-prosa-device-id': 'dev-cq137',
    },
    payload: {} as never,
  })
  expect(seal.statusCode).toBe(200)
  const receiptId = (seal.json() as { receipt: { payload: { receiptId: string } } }).receipt.payload.receiptId
  return { promotionId, receiptId }
}

describe('CQ-137: search_generation_current is per-(tenant, store)', () => {
  it('promoting a second store in the same tenant does not overwrite the first store', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq137@example.com', 'Acme', 'acme-cq137')

      const fxA = buildFixture('cq137-store-a')
      const fxB = buildFixture('cq137-store-b')
      const { receiptId: receiptIdA } = await drivePromotionThroughSeal({
        t,
        token: account.token,
        tenantId: account.tenant.id,
        storeId: 'store-cq137-a',
        bundleRoot: 'aa'.repeat(32),
        fx: fxA,
      })
      const { receiptId: receiptIdB } = await drivePromotionThroughSeal({
        t,
        token: account.token,
        tenantId: account.tenant.id,
        storeId: 'store-cq137-b',
        bundleRoot: 'bb'.repeat(32),
        fx: fxB,
      })
      expect(receiptIdB).not.toBe(receiptIdA)

      const rows = await t.db.rawExec<{ store_id: string; receipt_id: string }>(
        `SELECT store_id, receipt_id FROM search_generation_current
          WHERE tenant_id = $1
          ORDER BY store_id ASC`,
        [account.tenant.id],
      )
      expect(rows.length).toBe(2)
      expect(rows[0]).toEqual({ store_id: 'store-cq137-a', receipt_id: receiptIdA })
      expect(rows[1]).toEqual({ store_id: 'store-cq137-b', receipt_id: receiptIdB })
    } finally {
      await t.close()
    }
  })
})
