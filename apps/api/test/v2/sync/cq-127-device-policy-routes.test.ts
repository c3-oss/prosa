// CQ-127 follow-up: extend the BeginPromotion device-ownership
// policy to UploadSegment, UploadObjectPack, SealPromotion, and
// GetPromotionStatus.
//
// Policy: when the caller declares `x-prosa-device-id`, the
// device must be registered to the authenticated user AND
// match the staging row's recorded device. A mismatch returns
// 403 DEVICE_MISMATCH. Foreign device ids return 403
// DEVICE_NOT_OWNED. Routes called without the header still
// work (tenant-scoped); the security-critical leak path is
// BeginPromotion's already_promoted fast-path, which always
// reads the request-body deviceId.

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
  return (r.json() as { result: { data: { token: string; user: { id: string }; tenant: { id: string } } } }).result.data
}

function buildBeginBody(opts: { tenantId: string; deviceId: string; storeId: string; bundleRoot: string }) {
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
        objects: 0,
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
        segmentId: 'cq127-route-obj',
        kind: 'inventory_object',
        digest: 'blake3:00000000000000000000000000000000000000000000000000000000000000aa',
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 32,
      },
      projectionInventorySegment: {
        segmentId: 'cq127-route-proj',
        kind: 'inventory_projection',
        digest: 'blake3:00000000000000000000000000000000000000000000000000000000000000bb',
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 32,
      },
    },
    device: { deviceId: opts.deviceId },
  }
}

describe('CQ-127 follow-up: device-ownership policy on upload/seal/status routes', () => {
  it('UploadSegment with a mismatched x-prosa-device-id returns 403 DEVICE_MISMATCH', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127r-up-seg@example.com', 'Acme', 'acme-cq127r-seg')
      // Claim both device ids for this user — only the policy
      // check between staging.device_id and the request matters.
      const ownerDevice = 'cq127r-seg-owner'
      const otherDevice = 'cq127r-seg-other'
      for (const id of [ownerDevice, otherDevice]) {
        await t.db.rawExec(
          `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [id, account.tenant.id, account.user.id, id],
        )
      }
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: ownerDevice,
          storeId: 'store-cq127r-seg',
          bundleRoot: 'aa'.repeat(32),
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const response = await t.app.inject({
        method: 'PUT',
        url: `/v2/promotions/${promotionId}/segments/cq127-route-obj`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': otherDevice,
          'x-prosa-transport-hash': 'blake3:00000000000000000000000000000000000000000000000000000000000000aa',
        },
        payload: Buffer.alloc(32),
      })
      expect(response.statusCode).toBe(403)
      const body = response.json() as { code: string; stagingDeviceId: string; requestingDeviceId: string }
      expect(body.code).toBe('DEVICE_MISMATCH')
      expect(body.stagingDeviceId).toBe(ownerDevice)
      expect(body.requestingDeviceId).toBe(otherDevice)
    } finally {
      await t.close()
    }
  })

  it('UploadObjectPack with a foreign x-prosa-device-id returns 403 DEVICE_NOT_OWNED', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127r-up-pack@example.com', 'Acme', 'acme-cq127r-pack')
      const ownerDevice = 'cq127r-pack-owner'
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [ownerDevice, account.tenant.id, account.user.id, ownerDevice],
      )
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: ownerDevice,
          storeId: 'store-cq127r-pack',
          bundleRoot: 'bb'.repeat(32),
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq127r-pack-bytes'), compression: 'zstd' }], {
        createdAt: '2026-05-20T00:00:00.000Z',
      })
      const response = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          // Device id not registered to this user.
          'x-prosa-device-id': 'cq127r-pack-foreign',
          'x-prosa-transport-hash': transportHashOf(pack.bytes),
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(response.statusCode).toBe(403)
      expect((response.json() as { code: string }).code).toBe('DEVICE_NOT_OWNED')
    } finally {
      await t.close()
    }
  })

  it('SealPromotion with a mismatched device id refuses to swap authority', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127r-seal@example.com', 'Acme', 'acme-cq127r-seal')
      const ownerDevice = 'cq127r-seal-owner'
      const otherDevice = 'cq127r-seal-other'
      for (const id of [ownerDevice, otherDevice]) {
        await t.db.rawExec(
          `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [id, account.tenant.id, account.user.id, id],
        )
      }
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: ownerDevice,
          storeId: 'store-cq127r-seal',
          bundleRoot: 'cc'.repeat(32),
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const seal = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/seal`,
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': otherDevice,
        },
        payload: {} as never,
      })
      expect(seal.statusCode).toBe(403)
      const body = seal.json() as { code: string; stagingDeviceId: string }
      expect(body.code).toBe('DEVICE_MISMATCH')
      expect(body.stagingDeviceId).toBe(ownerDevice)
    } finally {
      await t.close()
    }
  })

  it('GetPromotionStatus with a mismatched device id returns 403 DEVICE_MISMATCH', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127r-status@example.com', 'Acme', 'acme-cq127r-status')
      const ownerDevice = 'cq127r-status-owner'
      const otherDevice = 'cq127r-status-other'
      for (const id of [ownerDevice, otherDevice]) {
        await t.db.rawExec(
          `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
          [id, account.tenant.id, account.user.id, id],
        )
      }
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: ownerDevice,
          storeId: 'store-cq127r-status',
          bundleRoot: 'dd'.repeat(32),
        }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const status = await t.app.inject({
        method: 'GET',
        url: `/v2/promotions/${promotionId}/status`,
        headers: {
          authorization: `Bearer ${account.token}`,
          'x-prosa-device-id': otherDevice,
        },
      })
      expect(status.statusCode).toBe(403)
      expect((status.json() as { code: string }).code).toBe('DEVICE_MISMATCH')
    } finally {
      await t.close()
    }
  })
})
