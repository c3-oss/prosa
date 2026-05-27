// CQ-127: BeginPromotion enforces device ownership and binds
// the `already_promoted` fast path to the device that actually
// sealed the receipt.
//
// Three cases:
// 1. Same-tenant, same-user, fresh device id auto-registers and
//    returns `needs_inventory`. The device row appears in the
//    catalog with the requesting user.
// 2. Same-tenant, different user trying to claim a device id
//    already owned by user A: 403 DEVICE_OWNED_BY_OTHER_USER.
//    No new device row is written.
// 3. Same-tenant, second device asking after the first device
//    sealed: receives `needs_inventory` (fresh staging slot) —
//    NOT the foreign-device receipt. The first device's
//    receipt is still readable via GetReceipt under the
//    documented tenant-wide policy.

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

// Add a second user to an existing tenant via Better Auth's
// `member` table. We bypass the full signup flow because the
// auth surface doesn't expose a clean "invite to existing
// tenant" route from tests; the `member` row is what
// `resolveMembership` reads, and the v2 plugin only needs that
// row to exist for the second user to act on the tenant.
async function addSecondUserToTenant(
  t: TestApp,
  tenantId: string,
  opts: { email: string; password: string },
): Promise<{ token: string; userId: string }> {
  const signup = await t.app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { 'content-type': 'application/json' },
    payload: { email: opts.email, password: opts.password, name: opts.email } as never,
  })
  expect(signup.statusCode).toBe(200)
  const body = signup.json() as { token: string; user: { id: string } }
  await t.db.rawExec(
    `INSERT INTO "member" (id, user_id, organization_id, role, created_at) VALUES ($1, $2, $3, 'member', now())`,
    [`mem_cq127_${body.user.id}`, body.user.id, tenantId],
  )
  return { token: body.token, userId: body.user.id }
}

function buildBeginBody(opts: { tenantId: string; deviceId: string; bundleRoot: string }) {
  return {
    protocolVersion: 2,
    tenantId: opts.tenantId,
    storeId: 'store-cq127',
    storePath: '/home/test/store',
    head: {
      bundleFormat: 2,
      storeId: 'store-cq127',
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
        segmentId: 'cq127-obj',
        kind: 'inventory_object',
        digest: `blake3:${'aa'.repeat(32)}`,
        logicalRoot: 'objects/inv',
        compression: 'zstd',
        byteLength: 32,
      },
      projectionInventorySegment: {
        segmentId: 'cq127-proj',
        kind: 'inventory_projection',
        digest: `blake3:${'bb'.repeat(32)}`,
        logicalRoot: 'projection/inv',
        compression: 'zstd',
        byteLength: 32,
      },
    },
    device: { deviceId: opts.deviceId },
  }
}

describe('CQ-127: BeginPromotion device ownership', () => {
  it('auto-registers a fresh device id for the authenticated user', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127-register@example.com', 'Acme', 'acme-cq127-reg')
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: 'cq127-dev-fresh',
          bundleRoot: 'aa'.repeat(32),
        }) as never,
      })
      expect(response.statusCode).toBe(200)

      const rows = await t.db.rawExec<{ tenant_id: string; user_id: string }>(
        `SELECT tenant_id, user_id FROM device WHERE id = $1`,
        ['cq127-dev-fresh'],
      )
      expect(rows.length).toBe(1)
      expect(rows[0]!.tenant_id).toBe(account.tenant.id)
      expect(rows[0]!.user_id).toBe(account.user.id)
    } finally {
      await t.close()
    }
  })

  it('refuses 403 DEVICE_OWNED_BY_OTHER_USER when a second user tries to claim a registered device', async () => {
    const t = await buildTestApp()
    try {
      const userA = await signupTenant(t, 'cq127-owner@example.com', 'Acme', 'acme-cq127-owner')
      // User A claims the device id.
      const claim = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${userA.token}` },
        payload: buildBeginBody({
          tenantId: userA.tenant.id,
          deviceId: 'cq127-shared-dev',
          bundleRoot: 'bb'.repeat(32),
        }) as never,
      })
      expect(claim.statusCode).toBe(200)

      // User B joins the same tenant and tries to use the same device id.
      const userB = await addSecondUserToTenant(t, userA.tenant.id, {
        email: 'cq127-thief@example.com',
        password: 'correct-horse-battery',
      })
      const steal = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${userB.token}`,
          'x-prosa-tenant-id': userA.tenant.id,
        },
        payload: buildBeginBody({
          tenantId: userA.tenant.id,
          deviceId: 'cq127-shared-dev',
          bundleRoot: 'cc'.repeat(32),
        }) as never,
      })
      expect(steal.statusCode).toBe(403)
      const body = steal.json() as { code: string }
      expect(body.code).toBe('DEVICE_OWNED_BY_OTHER_USER')

      // The device row is unchanged — still owned by user A.
      const rows = await t.db.rawExec<{ user_id: string }>(`SELECT user_id FROM device WHERE id = $1`, [
        'cq127-shared-dev',
      ])
      expect(rows.length).toBe(1)
      expect(rows[0]!.user_id).toBe(userA.user.id)
    } finally {
      await t.close()
    }
  })

  it('falls through to needs_inventory when a different device asks about an already-promoted bundle', async () => {
    // This avoids leaking the sealing device's receipt to a
    // foreign device. The bundle is already promoted (same
    // tenant, same store, same bundleRoot) but the second
    // device gets its own staging slot rather than a receipt
    // signed under another device's id.
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127-foreign@example.com', 'Acme', 'acme-cq127-foreign')
      const storeId = 'store-cq127'
      const bundleRoot = 'dd'.repeat(32)

      // Seed the authority row + receipt directly (simulating a
      // prior seal from device A). CQ-125: BeginPromotion now
      // verifies deriveReceiptId + signature, so we derive the
      // canonical id and sign with the test app's signer.
      const sealerDeviceId = 'cq127-dev-sealer'
      const { deriveReceiptId, receiptPayloadBytes } = await import('@c3-oss/prosa-types-v2')
      const draft = {
        receiptVersion: 2 as const,
        receiptId: 'rcpt_placeholder',
        protocolVersion: 2 as const,
        tenantId: account.tenant.id,
        storeId,
        storePath: '/home/test/store',
        deviceId: sealerDeviceId,
        issuedAt: '2026-05-20T00:00:00.000Z',
        serverRegion: 'test',
        serverKeyId: 'test-key',
        previousReceiptId: null,
        previousBundleRoot: null,
        bundleRoot,
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
        materialization: {
          postgresCommitId: 'pg-cq127',
          searchGenerationId: 'gen-cq127',
          rowCountsByEntity: {
            session: 0,
            message: 0,
            event: 0,
            content_block: 0,
            turn: 0,
            tool_call: 0,
            tool_result: 0,
            artifact: 0,
            edge: 0,
            project: 0,
            source_file: 0,
            raw_record: 0,
            search_doc: 0,
          },
        },
        verification: {
          uploadDigestVerified: true as const,
          objectHashesVerifiedAtIngest: true as const,
          projectionRowsLoaded: true as const,
          noPerObjectHeadRequired: true as const,
          backgroundAuditEligible: true as const,
        },
        clientSignatureStatus: 'absent_v2_0' as const,
      }
      const receiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId }
      const signature = await t.signer.signReceipt(receiptPayloadBytes(payload))
      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, sealerDeviceId, JSON.stringify(payload), JSON.stringify(signature)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      // Caller asks from a different device.
      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: 'cq127-dev-foreign', // different device id
          bundleRoot,
        }) as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { status: string }
      expect(body.status).toBe('needs_inventory')
    } finally {
      await t.close()
    }
  })

  it('returns already_promoted to the same device that sealed the bundle', async () => {
    // Sanity check: the device check does not block the
    // intended same-device replay path.
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'cq127-same@example.com', 'Acme', 'acme-cq127-same')
      const storeId = 'store-cq127'
      const bundleRoot = 'ee'.repeat(32)
      const sealerDeviceId = 'cq127-dev-same'
      // Claim device A so the registration check accepts it.
      await t.db.rawExec(
        `INSERT INTO device (id, tenant_id, user_id, name) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
        [sealerDeviceId, account.tenant.id, account.user.id, sealerDeviceId],
      )
      const { deriveReceiptId, receiptPayloadBytes } = await import('@c3-oss/prosa-types-v2')
      const draft = {
        receiptVersion: 2 as const,
        receiptId: 'rcpt_placeholder',
        protocolVersion: 2 as const,
        tenantId: account.tenant.id,
        storeId,
        storePath: '/home/test/store',
        deviceId: sealerDeviceId,
        issuedAt: '2026-05-20T00:00:00.000Z',
        serverRegion: 'test',
        serverKeyId: 'test-key',
        previousReceiptId: null,
        previousBundleRoot: null,
        bundleRoot,
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
        materialization: {
          postgresCommitId: 'pg-cq127',
          searchGenerationId: 'gen-cq127',
          rowCountsByEntity: {
            session: 0,
            message: 0,
            event: 0,
            content_block: 0,
            turn: 0,
            tool_call: 0,
            tool_result: 0,
            artifact: 0,
            edge: 0,
            project: 0,
            source_file: 0,
            raw_record: 0,
            search_doc: 0,
          },
        },
        verification: {
          uploadDigestVerified: true as const,
          objectHashesVerifiedAtIngest: true as const,
          projectionRowsLoaded: true as const,
          noPerObjectHeadRequired: true as const,
          backgroundAuditEligible: true as const,
        },
        clientSignatureStatus: 'absent_v2_0' as const,
      }
      const receiptId = deriveReceiptId(draft)
      const payload = { ...draft, receiptId }
      const signature = await t.signer.signReceipt(receiptPayloadBytes(payload))
      await t.db.rawExec(
        `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
        [receiptId, account.tenant.id, storeId, sealerDeviceId, JSON.stringify(payload), JSON.stringify(signature)],
      )
      await t.db.rawExec(
        `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
         VALUES ($1, $2, $3, $4, now())`,
        [account.tenant.id, storeId, receiptId, bundleRoot],
      )

      const response = await t.app.inject({
        method: 'POST',
        url: '/v2/promotions/begin',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${account.token}` },
        payload: buildBeginBody({
          tenantId: account.tenant.id,
          deviceId: sealerDeviceId,
          bundleRoot,
        }) as never,
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as { status: string }
      expect(body.status).toBe('already_promoted')
    } finally {
      await t.close()
    }
  })
})
