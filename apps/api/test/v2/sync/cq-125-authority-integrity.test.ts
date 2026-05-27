// CQ-125: BeginPromotion's no-op fast path must validate that
// the receipt referenced by `remote_authority_v2` is internally
// consistent and matches the requested (store, bundleRoot)
// tuple. A missing or mismatched receipt is corrupt state and
// the route must fail closed instead of silently reopening
// promotion.

import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from '../../helpers/test-app.js'

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

function buildBeginBody(opts: { tenantId: string; storeId: string; bundleRoot: string }) {
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
        segmentId: 'cq125-obj',
        kind: 'inventory_object',
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 32,
      },
      projectionInventorySegment: {
        segmentId: 'cq125-proj',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 32,
      },
    },
    device: { deviceId: 'dev-cq125' },
  }
}

async function seedAuthority(
  t: TestApp,
  opts: {
    tenantId: string
    storeId: string
    bundleRoot: string
    receiptId: string
    rowStoreId?: string
    payloadStoreId?: string
    payloadBundleRoot?: string
    payloadReceiptId?: string
    insertReceipt?: boolean
  },
): Promise<void> {
  const insertReceipt = opts.insertReceipt ?? true
  if (insertReceipt) {
    const payload = {
      receiptVersion: 2,
      receiptId: opts.payloadReceiptId ?? opts.receiptId,
      protocolVersion: 2,
      tenantId: opts.tenantId,
      storeId: opts.payloadStoreId ?? opts.storeId,
      storePath: '/home/test/store',
      deviceId: 'dev-cq125',
      issuedAt: '2026-05-20T00:00:00.000Z',
      serverRegion: 'test',
      serverKeyId: 'unknown-key',
      previousReceiptId: null,
      previousBundleRoot: null,
      bundleRoot: opts.payloadBundleRoot ?? opts.bundleRoot,
      rawSourceRoot: '00'.repeat(32),
      counts: {},
      materialization: {},
      verification: {},
      clientSignatureStatus: 'absent_v2_0',
    }
    const signature = { alg: 'Ed25519', keyId: 'unknown-key', sig: Buffer.alloc(64).toString('base64url') }
    await t.db.rawExec(
      `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
      [
        opts.receiptId,
        opts.tenantId,
        opts.rowStoreId ?? opts.storeId,
        'dev-cq125',
        JSON.stringify(payload),
        JSON.stringify(signature),
      ],
    )
  }
  await t.db.rawExec(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())`,
    [opts.tenantId, opts.storeId, opts.receiptId, opts.bundleRoot],
  )
}

describe('CQ-125: BeginPromotion validates authority receipt tuple', () => {
  it('returns 500 AUTHORITY_CORRUPT when authority points to a missing receipt', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125-missing@example.com', 'Acme', 'acme-cq125-missing')
      const storeId = 'store-cq125-missing'
      const bundleRoot = 'aa'.repeat(32)
      await seedAuthority(t, {
        tenantId: account.tenant.id,
        storeId,
        bundleRoot,
        receiptId: 'rcpt_missing',
        insertReceipt: false,
      })
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot }) as never,
      })
      expect(response.statusCode).toBe(500)
      expect((response.json() as { code: string }).code).toBe('AUTHORITY_CORRUPT')
    } finally {
      await t.close()
    }
  })

  it('returns 500 AUTHORITY_CORRUPT when row.store_id disagrees with the authority lookup', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125-row@example.com', 'Acme', 'acme-cq125-row')
      const storeId = 'store-cq125-row'
      const bundleRoot = 'bb'.repeat(32)
      await seedAuthority(t, {
        tenantId: account.tenant.id,
        storeId,
        bundleRoot,
        receiptId: 'rcpt_rowmismatch',
        rowStoreId: 'store-other-row', // row store_id != authority store_id
      })
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot }) as never,
      })
      expect(response.statusCode).toBe(500)
      expect((response.json() as { code: string }).code).toBe('AUTHORITY_CORRUPT')
    } finally {
      await t.close()
    }
  })

  it('returns 500 AUTHORITY_CORRUPT when payload.bundleRoot disagrees with authority', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125-root@example.com', 'Acme', 'acme-cq125-root')
      const storeId = 'store-cq125-root'
      const bundleRoot = 'cc'.repeat(32)
      await seedAuthority(t, {
        tenantId: account.tenant.id,
        storeId,
        bundleRoot,
        receiptId: 'rcpt_rootmismatch',
        payloadBundleRoot: 'dd'.repeat(32), // payload claims a different bundleRoot
      })
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot }) as never,
      })
      expect(response.statusCode).toBe(500)
      expect((response.json() as { code: string }).code).toBe('AUTHORITY_CORRUPT')
    } finally {
      await t.close()
    }
  })

  it('returns 500 AUTHORITY_CORRUPT when payload.receiptId disagrees with authority.current_receipt_id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq125-id@example.com', 'Acme', 'acme-cq125-id')
      const storeId = 'store-cq125-id'
      const bundleRoot = 'ee'.repeat(32)
      await seedAuthority(t, {
        tenantId: account.tenant.id,
        storeId,
        bundleRoot,
        receiptId: 'rcpt_authority',
        payloadReceiptId: 'rcpt_payload', // payload claims a different id
      })
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({ tenantId: account.tenant.id, storeId, bundleRoot }) as never,
      })
      expect(response.statusCode).toBe(500)
      expect((response.json() as { code: string }).code).toBe('AUTHORITY_CORRUPT')
    } finally {
      await t.close()
    }
  })
})
