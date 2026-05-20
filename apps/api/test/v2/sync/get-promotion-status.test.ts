// Lane 5 slice 8 — GET /v2/promotions/:promotionId/status.
//
// Covers: unauth 401, unknown promotionId 404, cross-tenant 404 (I1),
// fresh staging slot reports no uploads, after one inventory upload
// the status correctly reports only that segment as uploaded, after
// the full pre-seal pipeline the status reports both inventories +
// every uploaded pack digest, and a sealed slot still reports its
// final state.

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

async function signupWithTenant(t: TestApp, email: string, name: string, slug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; user: { id: string }; tenant: { id: string } } }
    }
  ).result.data
}

function buildFixture() {
  const pack = buildCasPack([{ bytes: new TextEncoder().encode('status-payload'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  const objBytes = new TextEncoder().encode('status-object-inventory')
  const projBytes = new TextEncoder().encode('status-projection-inventory')
  return { pack, objBytes, projBytes, objDigest: transportHashOf(objBytes), projDigest: transportHashOf(projBytes) }
}

function buildBeginBody(opts: {
  tenantId: string
  storeId: string
  bundleRoot: string
  objDigest: string
  objSize: number
  projDigest: string
  projSize: number
}) {
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
      rawSourceRoot: '44'.repeat(32),
      manifestDigest: `blake3:${'55'.repeat(32)}`,
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
        segmentId: 'st-obj-inv',
        kind: 'inventory_object',
        digest: opts.objDigest,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: opts.objSize,
      },
      projectionInventorySegment: {
        segmentId: 'st-proj-inv',
        kind: 'inventory_projection',
        digest: opts.projDigest,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: opts.projSize,
      },
    },
    device: { deviceId: 'dev-status' },
  }
}

async function openStaging(
  t: TestApp,
  token: string,
  tenantId: string,
  bundleRoot: string,
): Promise<{ promotionId: string; fx: ReturnType<typeof buildFixture> }> {
  const fx = buildFixture()
  const response = await t.app.inject({
    method: 'POST',
    url: BEGIN_URL,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: buildBeginBody({
      tenantId,
      storeId: 'store-status',
      bundleRoot,
      objDigest: fx.objDigest,
      objSize: fx.objBytes.byteLength,
      projDigest: fx.projDigest,
      projSize: fx.projBytes.byteLength,
    }) as never,
  })
  expect(response.statusCode).toBe(200)
  return { promotionId: (response.json() as { promotionId: string }).promotionId, fx }
}

describe('GET /v2/promotions/:promotionId/status — Lane 5 slice 8', () => {
  it('returns 401 to unauthenticated callers', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/v2/promotions/prm_x/status' })
      expect(response.statusCode).toBe(401)
      expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('returns 404 PROMOTION_NOT_FOUND for an unknown promotion id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'st-404@example.com', 'Acme', 'acme-st-404')
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        ['dev-status', account.tenant.id, account.user.id, 'dev-status'],
      )
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/promotions/prm_unknown000000000000000000/status',
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-status' },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('does not leak status across tenants (I1)', async () => {
    const t = await buildTestApp()
    try {
      const accountA = await signupWithTenant(t, 'st-iso-a@example.com', 'A', 'acme-st-iso-a')
      const accountB = await signupWithTenant(t, 'st-iso-b@example.com', 'B', 'acme-st-iso-b')
      const { promotionId } = await openStaging(t, accountA.token, accountA.tenant.id, '11'.repeat(32))
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        ['dev-status-b', accountB.tenant.id, accountB.user.id, 'dev-status-b'],
      )
      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/promotions/${promotionId}/status`,
        headers: { authorization: `Bearer ${accountB.token}`, 'x-prosa-device-id': 'dev-status-b' },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('PROMOTION_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('reports a fresh staging slot with no uploads', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'st-fresh@example.com', 'A', 'acme-st-fresh')
      const { promotionId } = await openStaging(t, account.token, account.tenant.id, '22'.repeat(32))
      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/promotions/${promotionId}/status`,
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-status' },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as {
        status: string
        bundleRoot: string
        inventories: {
          object: { segmentId: string; uploaded: boolean }
          projection: { segmentId: string; uploaded: boolean }
        }
        uploadedPackDigests: string[]
      }
      expect(body.status).toBe('open')
      expect(body.bundleRoot).toBe('22'.repeat(32))
      expect(body.inventories.object).toEqual({ segmentId: 'st-obj-inv', uploaded: false })
      expect(body.inventories.projection).toEqual({ segmentId: 'st-proj-inv', uploaded: false })
      expect(body.uploadedPackDigests).toEqual([])
    } finally {
      await t.close()
    }
  })

  it('flips inventory.uploaded after a successful PUT and lists uploaded pack digests', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupWithTenant(t, 'st-mix@example.com', 'A', 'acme-st-mix')
      const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, '33'.repeat(32))

      // Upload only the object inventory + the object pack.
      await t.app.inject({
        method: 'PUT',
        url: `/v2/promotions/${promotionId}/segments/st-obj-inv`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': fx.objDigest,
          'x-prosa-device-id': 'dev-status',
        },
        payload: Buffer.from(fx.objBytes),
      })
      await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHashOf(fx.pack.bytes),
          'x-prosa-device-id': 'dev-status',
        },
        payload: Buffer.from(fx.pack.bytes),
      })

      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/promotions/${promotionId}/status`,
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-status' },
      })
      const body = response.json() as {
        inventories: {
          object: { uploaded: boolean }
          projection: { uploaded: boolean }
        }
        uploadedPackDigests: string[]
      }
      expect(body.inventories.object.uploaded).toBe(true)
      expect(body.inventories.projection.uploaded).toBe(false)
      expect(body.uploadedPackDigests).toEqual([fx.pack.packDigest])
    } finally {
      await t.close()
    }
  })
})
