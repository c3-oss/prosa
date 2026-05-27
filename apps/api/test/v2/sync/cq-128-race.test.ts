// CQ-128: concurrent BeginPromotion calls for the same
// `(tenant_id, store_id, bundleRoot)` must collapse onto a single
// active `promotion_staging` row. The partial unique index
// `promotion_staging_active_tuple_idx` (filtered on active statuses)
// turns the post-lookup INSERT into an atomic operation with
// `ON CONFLICT DO NOTHING`; the loser of the race re-reads the
// active row and returns the winner's id.

import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

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

function buildBeginBody(opts: { tenantId: string; bundleRoot: string }) {
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: 'store-cq128',
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: 'store-cq128',
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
        segmentId: 'cq128-obj-inv',
        kind: 'inventory_object',
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 64,
      },
      projectionInventorySegment: {
        segmentId: 'cq128-proj-inv',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 64,
      },
    },
    device: { deviceId: 'dev-cq128' },
  }
}

describe('CQ-128: race-safe BeginPromotion staging', () => {
  it('two concurrent BeginPromotion calls return the same promotionId and leave one active row', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq128-race@example.com', 'Acme', 'acme-cq128-race')
      const payload = buildBeginBody({ tenantId: account.tenant.id, bundleRoot: '33'.repeat(32) })

      // Fire 8 concurrent requests; the unique index must collapse
      // them to a single active staging row.
      const responses = await Promise.all(
        Array.from({ length: 8 }, () =>
          t.app.inject({
            method: 'POST',
            url: '/v2/promotions/begin',
            headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
            payload: payload as never,
          }),
        ),
      )
      for (const response of responses) {
        expect(response.statusCode).toBe(200)
      }
      const promotionIds = responses.map((r) => (r.json() as { promotionId: string }).promotionId)
      const uniqueIds = new Set(promotionIds)
      expect(uniqueIds.size).toBe(1)

      const activeRows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_staging
          WHERE tenant_id = $1
            AND store_id = $2
            AND head_json->>'bundleRoot' = $3
            AND status IN ('open','uploading','materializing')`,
        [account.tenant.id, 'store-cq128', '33'.repeat(32)],
      )
      expect(Number(activeRows[0]!.count)).toBe(1)
    } finally {
      await t.close()
    }
  })

  it('terminal rows do not occupy the active slot — a new BeginPromotion gets a fresh id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq128-terminal@example.com', 'Acme', 'acme-cq128-term')
      const bundleRoot = '44'.repeat(32)
      const payload = buildBeginBody({ tenantId: account.tenant.id, bundleRoot })

      const first = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: payload as never,
      })
      const firstId = (first.json() as { promotionId: string }).promotionId
      await t.db.rawExec(`UPDATE promotion_staging SET status = 'aborted' WHERE id = $1`, [firstId])

      const second = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: payload as never,
      })
      const secondId = (second.json() as { promotionId: string }).promotionId
      expect(secondId).not.toBe(firstId)

      // One aborted (firstId) + one active (secondId) = 2 rows total.
      const rows = await t.db.rawExec<{ count: string | number }>(
        `SELECT count(*)::int AS count FROM promotion_staging
          WHERE tenant_id = $1 AND store_id = $2 AND head_json->>'bundleRoot' = $3`,
        [account.tenant.id, 'store-cq128', bundleRoot],
      )
      expect(Number(rows[0]!.count)).toBe(2)
    } finally {
      await t.close()
    }
  })
})
