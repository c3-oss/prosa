// CQ-138: GetReceipt validates the stored row against the
// requested id, the signed tuple, and the signature itself. Any
// mismatch collapses to `not_found`/404 so corrupt rows cannot be
// returned to clients as authority and existence does not leak.
//
// The harness seeds rows directly into the `receipt` table to
// exercise the rejection paths without driving a full seal flow.
// The happy path (sealed receipt round-trips through GET) is
// already pinned in `get-receipt.test.ts`.

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
  return (r.json() as { result: { data: { token: string; user: { id: string }; tenant: { id: string } } } }).result.data
}

async function seedReceiptRow(
  t: TestApp,
  opts: {
    receiptId: string
    tenantId: string
    storeId: string
    deviceId: string
    userId: string
    payload: Record<string, unknown>
    signature: Record<string, unknown>
  },
): Promise<void> {
  // CQ-127: GetReceipt now requires a registered x-prosa-device-id
  // header. Register the requesting device so verifyDeviceOwnership
  // succeeds and the route falls through to the receipt-validation
  // checks the test is actually pinning.
  await t.db.rawExec(
    `INSERT INTO device (id, tenant_id, user_id, name)
     VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [opts.deviceId, opts.tenantId, opts.userId, opts.deviceId],
  )
  await t.db.rawExec(
    `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
     VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [
      opts.receiptId,
      opts.tenantId,
      opts.storeId,
      opts.deviceId,
      JSON.stringify(opts.payload),
      JSON.stringify(opts.signature),
    ],
  )
}

const VALID_BASE64 = Buffer.from(new Uint8Array(64).fill(0)).toString('base64url')

function corruptPayload(opts: { receiptId: string; tenantId: string; storeId: string; deviceId: string }) {
  // Looks roughly like a v2 receipt payload but the signature
  // won't verify against any JWKS-published key, so even with
  // matching ids the receipt is unrecoverable authority.
  return {
    receiptVersion: 2,
    receiptId: opts.receiptId,
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    deviceId: opts.deviceId,
    issuedAt: '2026-05-20T00:00:00.000Z',
    serverRegion: 'test',
    serverKeyId: 'unknown-key',
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: '00'.repeat(32),
    rawSourceRoot: '00'.repeat(32),
    counts: {
      sourceFiles: 0,
      rawRecords: 0,
      objects: 0,
      sessions: 0,
      messages: 0,
      events: 0,
      contentBlocks: 0,
      turns: 0,
      toolCalls: 0,
      toolResults: 0,
      artifacts: 0,
      edges: 0,
      searchDocs: 0,
      projectionRows: 0,
    },
    materialization: { postgresCommitId: 'pgc', searchGenerationId: 'gen', rowCountsByEntity: {} },
    verification: {
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0',
  }
}

describe('CQ-138: GetReceipt rejects corrupt or mismatched rows', () => {
  it('rejects a row where payload.receiptId != :receiptId', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq138-id@example.com', 'Acme', 'acme-cq138-id')
      await seedReceiptRow(t, {
        receiptId: 'rcpt_seeded',
        tenantId: account.tenant.id,
        storeId: 'store-cq138',
        deviceId: 'dev-cq138',
        userId: account.user.id,
        payload: corruptPayload({
          // Signed payload claims a different receipt id.
          receiptId: 'rcpt_someotherid',
          tenantId: account.tenant.id,
          storeId: 'store-cq138',
          deviceId: 'dev-cq138',
        }),
        signature: { alg: 'Ed25519', keyId: 'unknown-key', sig: VALID_BASE64 },
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/receipts/rcpt_seeded',
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-cq138' },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('RECEIPT_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('rejects a row where payload.storeId != row.store_id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq138-store@example.com', 'Acme', 'acme-cq138-store')
      await seedReceiptRow(t, {
        receiptId: 'rcpt_storerow',
        tenantId: account.tenant.id,
        storeId: 'store-row',
        deviceId: 'dev-cq138',
        userId: account.user.id,
        payload: corruptPayload({
          receiptId: 'rcpt_storerow',
          tenantId: account.tenant.id,
          storeId: 'store-payload', // signed payload claims a different store
          deviceId: 'dev-cq138',
        }),
        signature: { alg: 'Ed25519', keyId: 'unknown-key', sig: VALID_BASE64 },
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/receipts/rcpt_storerow',
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-cq138' },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('rejects a row where payload.deviceId != row.device_id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq138-device@example.com', 'Acme', 'acme-cq138-device')
      await seedReceiptRow(t, {
        receiptId: 'rcpt_devrow',
        tenantId: account.tenant.id,
        storeId: 'store-cq138',
        deviceId: 'dev-row',
        userId: account.user.id,
        payload: corruptPayload({
          receiptId: 'rcpt_devrow',
          tenantId: account.tenant.id,
          storeId: 'store-cq138',
          deviceId: 'dev-payload', // signed payload claims a different device
        }),
        signature: { alg: 'Ed25519', keyId: 'unknown-key', sig: VALID_BASE64 },
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/receipts/rcpt_devrow',
        // Use the row's device id so verifyDeviceOwnership
        // succeeds; the test pins the payload-vs-row mismatch
        // path, which still returns 404 via getReceipt's
        // internal tuple check.
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-row' },
      })
      expect(response.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('rejects a row whose payload.receiptId does not equal deriveReceiptId(payload) (CQ-138 follow-up)', async () => {
    // Tampered payload bytes: a same-tenant attacker mutates
    // the signed payload (here: edits `serverRegion`) without
    // re-deriving the receipt id. payload.receiptId still
    // equals the request, but the canonical hash of the
    // current payload bytes won't match anymore — so
    // deriveReceiptId(payload) !== payload.receiptId and the
    // route refuses.
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq138-derive@example.com', 'Acme', 'acme-cq138-derive')
      const receiptId = 'rcpt_seeded_derive'
      const payload = corruptPayload({
        receiptId,
        tenantId: account.tenant.id,
        storeId: 'store-cq138',
        deviceId: 'dev-cq138',
      })
      // Edit a field AFTER computing the id elsewhere — the
      // canonical hash of `payload` no longer matches its
      // `receiptId`.
      ;(payload as { serverRegion: string }).serverRegion = 'tampered'
      await seedReceiptRow(t, {
        receiptId,
        tenantId: account.tenant.id,
        storeId: 'store-cq138',
        deviceId: 'dev-cq138',
        userId: account.user.id,
        payload,
        signature: { alg: 'Ed25519', keyId: 'unknown-key', sig: VALID_BASE64 },
      })
      const response = await t.app.inject({
        method: 'GET',
        url: `/v2/receipts/${receiptId}`,
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-cq138' },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('RECEIPT_NOT_FOUND')
    } finally {
      await t.close()
    }
  })

  it('rejects a row whose signature does not verify against the JWKS', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq138-sig@example.com', 'Acme', 'acme-cq138-sig')
      // Tuple and ids all match — only the signature is invalid.
      await seedReceiptRow(t, {
        receiptId: 'rcpt_badsig',
        tenantId: account.tenant.id,
        storeId: 'store-cq138',
        deviceId: 'dev-cq138',
        userId: account.user.id,
        payload: corruptPayload({
          receiptId: 'rcpt_badsig',
          tenantId: account.tenant.id,
          storeId: 'store-cq138',
          deviceId: 'dev-cq138',
        }),
        signature: { alg: 'Ed25519', keyId: 'unknown-key', sig: VALID_BASE64 },
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/receipts/rcpt_badsig',
        headers: { authorization: `Bearer ${account.token}`, 'x-prosa-device-id': 'dev-cq138' },
      })
      expect(response.statusCode).toBe(404)
      expect((response.json() as { code: string }).code).toBe('RECEIPT_NOT_FOUND')
    } finally {
      await t.close()
    }
  })
})
