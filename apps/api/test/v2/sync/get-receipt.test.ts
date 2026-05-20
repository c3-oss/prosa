// Lane 5 slice 6 — GET /v2/receipts/:receiptId.
//
// Asserts:
// - unauthenticated → 401 UNAUTHENTICATED,
// - unknown receipt id → 404 RECEIPT_NOT_FOUND with status='not_found',
// - cross-tenant attempt → 404 (existence does not leak across
//   tenants — I1),
// - happy path against a sealed promotion returns the same payload +
//   signature as the seal response.

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

const BEGIN_URL = '/v2/promotions/begin'

function transportHashOf(bytes: Uint8Array): string {
  let hex = ''
  for (const byte of blake3(bytes)) hex += byte.toString(16).padStart(2, '0')
  return `blake3:${hex}`
}

async function signupWithTenant(t: TestApp, email: string, tenantName: string, tenantSlug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName, tenantSlug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
    }
  ).result.data
}

function buildPromotionFixture() {
  const pack = buildCasPack([{ bytes: new TextEncoder().encode('payload-for-get-receipt'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  const objectInventoryBytes = new TextEncoder().encode('opaque-object-inventory-get')
  const projectionInventoryBytes = new TextEncoder().encode('opaque-projection-inventory-get')
  return {
    pack,
    objectInventoryBytes,
    projectionInventoryBytes,
    objectInventoryDigest: transportHashOf(objectInventoryBytes),
    projectionInventoryDigest: transportHashOf(projectionInventoryBytes),
  }
}

function buildBeginBody(opts: {
  tenantId: string
  bundleRoot?: string
  objectInventory: { segmentId: string; digest: string; byteLength: number }
  projectionInventory: { segmentId: string; digest: string; byteLength: number }
}) {
  const storeId = 'store-get'
  const bundleRoot = opts.bundleRoot ?? '77'.repeat(32)
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
      bundleRoot,
      rawSourceRoot: '88'.repeat(32),
      manifestDigest: `blake3:${'99'.repeat(32)}`,
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
        segmentId: opts.objectInventory.segmentId,
        kind: 'inventory_object',
        digest: opts.objectInventory.digest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: opts.objectInventory.byteLength,
      },
      projectionInventorySegment: {
        segmentId: opts.projectionInventory.segmentId,
        kind: 'inventory_projection',
        digest: opts.projectionInventory.digest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: opts.projectionInventory.byteLength,
      },
    },
    device: { deviceId: 'dev-get' },
  }
}

async function driveSeal(
  t: TestApp,
  token: string,
  tenantId: string,
): Promise<{ receiptId: string; payload: Record<string, unknown>; signature: Record<string, unknown> }> {
  const fx = buildPromotionFixture()
  const begin = await t.app.inject({
    method: 'POST',
    url: BEGIN_URL,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: buildBeginBody({
      tenantId,
      objectInventory: {
        segmentId: 'seg-obj-get',
        digest: fx.objectInventoryDigest,
        byteLength: fx.objectInventoryBytes.byteLength,
      },
      projectionInventory: {
        segmentId: 'seg-proj-get',
        digest: fx.projectionInventoryDigest,
        byteLength: fx.projectionInventoryBytes.byteLength,
      },
    }) as never,
  })
  const { promotionId } = begin.json() as { promotionId: string }
  await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/seg-obj-get`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': fx.objectInventoryDigest,
    },
    payload: Buffer.from(fx.objectInventoryBytes),
  })
  await t.app.inject({
    method: 'PUT',
    url: `/v2/promotions/${promotionId}/segments/seg-proj-get`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': fx.projectionInventoryDigest,
    },
    payload: Buffer.from(fx.projectionInventoryBytes),
  })
  await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/object-packs`,
    headers: {
      'content-type': 'application/octet-stream',
      authorization: `Bearer ${token}`,
      'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
    },
    payload: Buffer.from(fx.pack.bytes),
  })
  const seal = await t.app.inject({
    method: 'POST',
    url: `/v2/promotions/${promotionId}/seal`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {} as never,
  })
  expect(seal.statusCode).toBe(200)
  const body = seal.json() as {
    receipt: {
      payload: Record<string, unknown> & { receiptId: string }
      signature: Record<string, unknown>
    }
  }
  return {
    receiptId: body.receipt.payload.receiptId,
    payload: body.receipt.payload,
    signature: body.receipt.signature,
  }
}

describe('GET /v2/receipts/:receiptId — Lane 5 slice 6', () => {
  it('returns 401 to unauthenticated callers', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/v2/receipts/rcpt_anything' })
      expect(response.statusCode).toBe(401)
      expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('returns 404 RECEIPT_NOT_FOUND for an unknown receipt id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'get-404@example.com', 'Acme', 'acme-get-404')
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/receipts/rcpt_doesnotexist',
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(response.statusCode).toBe(404)
      const body = response.json() as { code: string; status: string; receiptId: string }
      expect(body.code).toBe('RECEIPT_NOT_FOUND')
      expect(body.status).toBe('not_found')
      expect(body.receiptId).toBe('rcpt_doesnotexist')
    } finally {
      await t.close()
    }
  })

  it('does not leak receipt existence across tenants (I1)', async () => {
    const t = await buildTestApp()
    try {
      const accountA = await signupWithTenant(t, 'get-iso-a@example.com', 'Acme A', 'acme-get-iso-a')
      const accountB = await signupWithTenant(t, 'get-iso-b@example.com', 'Acme B', 'acme-get-iso-b')
      const sealed = await driveSeal(t, accountA.token, accountA.tenant.id)
      // Tenant B should NOT see A's receipt.
      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/receipts/${sealed.receiptId}`,
        headers: { authorization: `Bearer ${accountB.token}` },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('RECEIPT_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('returns the stored receipt payload + signature for the owning tenant', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'get-ok@example.com', 'Acme', 'acme-get-ok')
      const sealed = await driveSeal(t, account.token, account.tenant.id)

      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/receipts/${sealed.receiptId}`,
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        status: string
        receipt: { payload: { receiptId: string }; signature: { alg: string; sig: string; keyId: string } }
      }
      expect(body.status).toBe('found')
      expect(body.receipt.payload.receiptId).toBe(sealed.receiptId)
      expect(body.receipt.signature.alg).toBe('Ed25519')
      // The returned payload+signature equal what seal returned —
      // server stores them verbatim and the get path is a thin lookup.
      expect(body.receipt.payload).toEqual(sealed.payload)
      expect(body.receipt.signature).toEqual(sealed.signature)
    } finally {
      await t.close()
    }
  })
})
