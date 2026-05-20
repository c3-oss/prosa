// Lane 5 CQ batch A acceptance pins:
//
// - CQ-130: UploadSegment + UploadObjectPack require the
//   `x-prosa-transport-hash` header. The wire schemas declare it
//   mandatory; the server now refuses uploads that omit it.
// - CQ-131: UploadSegment + UploadObjectPack refuse to accept new
//   bytes once the staging slot is `materializing` (in addition to
//   the existing sealed/aborted check).

import { buildCasPack } from '@c3-oss/prosa-bundle-v2'
import { blake3 } from '@noble/hashes/blake3'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

function toHex(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) out += byte.toString(16).padStart(2, '0')
  return out
}

async function signupTenant(t: TestApp, email: string, name: string, slug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: { email, password: 'correct-horse-battery', name: email, tenantName: name, tenantSlug: slug } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; tenant: { id: string } } }
    }
  ).result.data
}

function buildFixture() {
  const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq-batch-a-payload'), compression: 'zstd' }], {
    createdAt: '2026-05-20T00:00:00.000Z',
  })
  const objBytes = new TextEncoder().encode('cq-batch-a-obj-inv')
  const projBytes = new TextEncoder().encode('cq-batch-a-proj-inv')
  return {
    pack,
    objBytes,
    projBytes,
    objDigest: `blake3:${toHex(blake3(objBytes))}`,
    projDigest: `blake3:${toHex(blake3(projBytes))}`,
  }
}

async function openStaging(t: TestApp, token: string, tenantId: string, bundleRoot: string) {
  const fx = buildFixture()
  const response = await t.app.inject({
    method: 'POST',
    url: '/v2/promotions/begin',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: {
      protocolVersion: 2,
      tenantId,
      storeId: 'store-cqa',
      storePath: '/home/test/store',
      head: {
        bundleFormat: 2,
        storeId: 'store-cqa',
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
          segmentId: 'cqa-obj-inv',
          kind: 'inventory_object',
          digest: fx.objDigest,
          logicalRoot: 'objects/inv',
          compression: 'zstd',
          byteLength: fx.objBytes.byteLength,
        },
        projectionInventorySegment: {
          segmentId: 'cqa-proj-inv',
          kind: 'inventory_projection',
          digest: fx.projDigest,
          logicalRoot: 'projection/inv',
          compression: 'zstd',
          byteLength: fx.projBytes.byteLength,
        },
      },
      device: { deviceId: 'dev-cqa' },
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return { promotionId: (response.json() as { promotionId: string }).promotionId, fx }
}

describe('Lane 5 CQ batch A acceptance pins', () => {
  describe('CQ-130: upload routes require x-prosa-transport-hash', () => {
    it('UploadSegment without the header returns 400 INVALID_REQUEST', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cqa-130-seg@example.com', 'Acme', 'acme-cqa-130-seg')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'aa'.repeat(32))
        const response = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/cqa-obj-inv`,
          headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${account.token}` },
          payload: Buffer.from(fx.objBytes),
        })
        expect(response.statusCode).toBe(400)
        const body = response.json() as { code: string; issues: Array<{ field: string; received: string }> }
        expect(body.code).toBe('INVALID_REQUEST')
        const issue = body.issues.find((i) => i.field === 'transportHash')
        expect(issue).toBeDefined()
        expect(issue!.received).toBe('<missing>')
      } finally {
        await t.close()
      }
    })

    it('UploadObjectPack without the header returns 400 INVALID_REQUEST', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cqa-130-pack@example.com', 'Acme', 'acme-cqa-130-pack')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'bb'.repeat(32))
        const response = await t.app.inject({
          method: 'POST',
          url: `/v2/promotions/${promotionId}/object-packs`,
          headers: { 'content-type': 'application/octet-stream', authorization: `Bearer ${account.token}` },
          payload: Buffer.from(fx.pack.bytes),
        })
        expect(response.statusCode).toBe(400)
        const body = response.json() as { code: string; issues: Array<{ field: string; received: string }> }
        expect(body.code).toBe('INVALID_REQUEST')
        const issue = body.issues.find((i) => i.field === 'transportHash')
        expect(issue).toBeDefined()
        expect(issue!.received).toBe('<missing>')
      } finally {
        await t.close()
      }
    })
  })

  describe('CQ-131: upload routes reject `materializing` slots', () => {
    it('UploadSegment against a materializing staging row returns 404', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cqa-131-seg@example.com', 'Acme', 'acme-cqa-131-seg')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'cc'.repeat(32))
        await t.db.rawExec(`UPDATE promotion_staging SET status = 'materializing' WHERE id = $1`, [promotionId])
        const response = await t.app.inject({
          method: 'PUT',
          url: `/v2/promotions/${promotionId}/segments/cqa-obj-inv`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': fx.objDigest,
          },
          payload: Buffer.from(fx.objBytes),
        })
        expect(response.statusCode).toBe(404)
        expect((response.json() as { code: string; message: string }).message).toMatch(/materializing/)
      } finally {
        await t.close()
      }
    })

    it('UploadObjectPack against a materializing staging row returns 404', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cqa-131-pack@example.com', 'Acme', 'acme-cqa-131-pack')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'dd'.repeat(32))
        await t.db.rawExec(`UPDATE promotion_staging SET status = 'materializing' WHERE id = $1`, [promotionId])
        const response = await t.app.inject({
          method: 'POST',
          url: `/v2/promotions/${promotionId}/object-packs`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': `blake3:${toHex(blake3(fx.pack.bytes))}`,
          },
          payload: Buffer.from(fx.pack.bytes),
        })
        expect(response.statusCode).toBe(404)
        expect((response.json() as { code: string; message: string }).message).toMatch(/materializing/)
      } finally {
        await t.close()
      }
    })
  })
})
