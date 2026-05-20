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
  describe('CQ-129: object-store metadata uses the wire transport hash, not the self-referential packDigest', () => {
    it('an accepted pack lands in the object store under its transport hash', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cq129@example.com', 'Acme', 'acme-cq129')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'ee'.repeat(32))

        const packBytes = fx.pack.bytes
        const transportHashHex = toHex(blake3(packBytes))
        const transportHash = `blake3:${transportHashHex}`
        const canonicalPackDigest = fx.pack.packDigest
        // CQ-026 / CQ-129: the two values are intentionally distinct
        // for CAS packs. The store must record the literal wire
        // BLAKE3 so that round-trip head() verification of the
        // bytes succeeds; the catalog row keeps the canonical
        // pack_digest separately.
        expect(canonicalPackDigest).not.toBe(transportHash)

        const response = await t.app.inject({
          method: 'POST',
          url: `/v2/promotions/${promotionId}/object-packs`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHash,
          },
          payload: Buffer.from(packBytes),
        })
        expect(response.statusCode).toBe(200)
        const body = response.json() as { packDigest: string; storageKey: string }
        expect(body.packDigest).toBe(canonicalPackDigest)

        const meta = await t.objectStore.head(body.storageKey)
        expect(meta).not.toBeNull()
        expect(meta!.hash).toBe(transportHashHex)
        expect(meta!.hashAlgorithm).toBe('blake3')
        expect(meta!.compressedSize).toBe(packBytes.byteLength)
      } finally {
        await t.close()
      }
    })
  })

  describe('CQ-133: object packs are linked to the uploading promotion', () => {
    it('UploadObjectPack INSERTs into promotion_uploaded_pack so seal can grant the digest', async () => {
      const t = await buildTestApp()
      try {
        const account = await signupTenant(t, 'cq133@example.com', 'Acme', 'acme-cq133')
        const { promotionId, fx } = await openStaging(t, account.token, account.tenant.id, 'f1'.repeat(32))

        const transportHash = `blake3:${toHex(blake3(fx.pack.bytes))}`
        const response = await t.app.inject({
          method: 'POST',
          url: `/v2/promotions/${promotionId}/object-packs`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHash,
          },
          payload: Buffer.from(fx.pack.bytes),
        })
        expect(response.statusCode).toBe(200)

        const linkRows = await t.db.rawExec<{ pack_digest: string }>(
          `SELECT pack_digest FROM promotion_uploaded_pack WHERE promotion_id = $1 AND tenant_id = $2`,
          [promotionId, account.tenant.id],
        )
        expect(linkRows.length).toBe(1)
        expect(linkRows[0]!.pack_digest).toBe(fx.pack.packDigest)

        // Re-upload of the same pack bytes is idempotent and does
        // not duplicate the linkage row.
        const second = await t.app.inject({
          method: 'POST',
          url: `/v2/promotions/${promotionId}/object-packs`,
          headers: {
            'content-type': 'application/octet-stream',
            authorization: `Bearer ${account.token}`,
            'x-prosa-transport-hash': transportHash,
          },
          payload: Buffer.from(fx.pack.bytes),
        })
        expect(second.statusCode).toBe(200)
        const after = await t.db.rawExec<{ count: string | number }>(
          `SELECT count(*)::int AS count FROM promotion_uploaded_pack WHERE promotion_id = $1`,
          [promotionId],
        )
        expect(Number(after[0]!.count)).toBe(1)
      } finally {
        await t.close()
      }
    })
  })

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
