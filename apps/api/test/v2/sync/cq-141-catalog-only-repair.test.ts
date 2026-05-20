// CQ-141: when the catalog row for a pack exists but the
// object-store bytes are missing, UploadObjectPack's fast path
// must repair the bytes from the request body before returning
// `already_present` and linking the pack to the current
// promotion. Otherwise a later seal could grant a digest whose
// remote bytes are absent.

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

function buildBeginBody(opts: { tenantId: string }) {
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: 'store-cq141',
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: 'store-cq141',
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
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 32,
      },
      projectionInventorySegment: {
        segmentId: 'cq141-proj',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 32,
      },
    },
    device: { deviceId: 'dev-cq141' },
  }
}

describe('CQ-141: object-pack fast path repairs missing storage bytes', () => {
  it('catalog-only pack with missing bytes is restored from the request body', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141@example.com', 'Acme', 'acme-cq141')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      // First upload: succeeds, populates remote_pack + object store.
      const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq141-payload'), compression: 'zstd' }], {
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
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(first.statusCode).toBe(200)
      const storageKey = (first.json() as { storageKey: string }).storageKey
      expect(await t.objectStore.head(storageKey)).not.toBeNull()

      // Simulate object-store byte loss while the catalog row
      // remains. (Real-world: out-of-band deletion, multipart
      // failure, drift between catalog and storage.) Also drop
      // the linkage so we can prove the fast path re-links.
      await t.objectStore.delete(storageKey)
      expect(await t.objectStore.head(storageKey)).toBeNull()
      await t.db.rawExec(`DELETE FROM promotion_uploaded_pack WHERE promotion_id = $1`, [promotionId])

      // Second upload of the same pack: hits the catalog fast
      // path. CQ-141 requires that the bytes are repaired before
      // returning already_present + linking the pack.
      const second = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(second.statusCode).toBe(200)
      const body = second.json() as { status: string; storageKey: string }
      expect(body.status).toBe('already_present')

      // Bytes are back, linkage exists.
      const restored = await t.objectStore.head(body.storageKey)
      expect(restored).not.toBeNull()
      expect(restored!.hash).toBe(transportHash.slice('blake3:'.length))

      const linkRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_uploaded_pack WHERE promotion_id = $1`,
        [promotionId],
      )
      expect(Number(linkRows[0]!.count)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('catalog-only pack with present bytes is left alone (no double-write)', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq141-noop@example.com', 'Acme', 'acme-cq141-noop')
      const begin = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id }) as never,
      })
      const { promotionId } = begin.json() as { promotionId: string }

      const pack = buildCasPack([{ bytes: new TextEncoder().encode('cq141-noop-payload'), compression: 'zstd' }], {
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
        },
        payload: Buffer.from(pack.bytes),
      })
      expect(first.statusCode).toBe(200)
      const storeSizeAfterFirst = t.objectStore.size()
      expect(storeSizeAfterFirst).toBe(1)

      // Second upload: bytes present. Fast path returns
      // already_present without churning the object store.
      const second = await t.app.inject({
        method: 'POST',
        url: `/v2/promotions/${promotionId}/object-packs`,
        headers: {
          'content-type': 'application/octet-stream',
          authorization: `Bearer ${account.token}`,
          'x-prosa-transport-hash': transportHash,
        },
        payload: Buffer.from(pack.bytes),
      })
      expect((second.json() as { status: string }).status).toBe('already_present')
      expect(t.objectStore.size()).toBe(storeSizeAfterFirst)
    } finally {
      await t.close()
    }
  })
})
