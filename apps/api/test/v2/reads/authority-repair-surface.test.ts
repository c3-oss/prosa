// Lane 8 — authority refresh surfaces a `repair` hint when the
// receipt is degraded.
//
// Seed a normal authority row, then upsert `receipt_audit_state` to
// `degraded` (as if the audit cron found a quarantined pack the
// receipt grants). The next `GET /v2/stores/:storeId/authority` must
// include a typed `repair` hint pointing at the affected receipt.

import { deriveReceiptId, receiptPayloadBytes } from '@c3-oss/prosa-types-v2'
import { describe, expect, it } from 'vitest'
import { AuthorityTtlCache } from '../../../src/v2/reads/authority-cache.js'
import { type AuthorityRefreshResponse, type CachedAuthority, getAuthority } from '../../../src/v2/reads/authority.js'
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

async function seedAuthorityRow(
  t: TestApp,
  opts: { tenantId: string; storeId: string; deviceId: string; userId: string },
): Promise<{ receiptId: string }> {
  const seed = {
    receiptVersion: 2 as const,
    receiptId: 'placeholder',
    protocolVersion: 2 as const,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath: '/home/test/store',
    deviceId: opts.deviceId,
    issuedAt: '2026-05-20T00:00:00.000Z',
    serverRegion: 'test',
    serverKeyId: t.signer.currentKeyId(),
    previousReceiptId: null,
    previousBundleRoot: null,
    bundleRoot: '00'.repeat(32),
    rawSourceRoot: '11'.repeat(32),
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
      postgresCommitId: 'pgc',
      searchGenerationId: 'gen',
      rowCountsByEntity: {
        artifact: 0,
        content_block: 0,
        edge: 0,
        event: 0,
        message: 0,
        project: 0,
        raw_record: 0,
        search_doc: 0,
        session: 0,
        source_file: 0,
        tool_call: 0,
        tool_result: 0,
        turn: 0,
      },
    },
    verification: {
      uploadDigestVerified: true,
      objectHashesVerifiedAtIngest: true,
      projectionRowsLoaded: true,
      noPerObjectHeadRequired: true,
      backgroundAuditEligible: true,
    },
    clientSignatureStatus: 'absent_v2_0' as const,
  }
  const receiptId = deriveReceiptId(seed)
  const payload = { ...seed, receiptId }
  const signature = await t.signer.signReceipt(receiptPayloadBytes(payload))
  await t.db.rawExec(
    `INSERT INTO device (id, tenant_id, user_id, name)
       VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING`,
    [opts.deviceId, opts.tenantId, opts.userId, opts.deviceId],
  )
  await t.db.rawExec(
    `INSERT INTO receipt (receipt_id, tenant_id, store_id, device_id, payload, signature)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)`,
    [receiptId, opts.tenantId, opts.storeId, opts.deviceId, JSON.stringify(payload), JSON.stringify(signature)],
  )
  await t.db.rawExec(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
       VALUES ($1, $2, $3, $4, now())`,
    [opts.tenantId, opts.storeId, receiptId, '00'.repeat(32)],
  )
  return { receiptId }
}

describe('Lane 8 authority refresh — repair surface', () => {
  it('returns a repair hint when the receipt is degraded in receipt_audit_state', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'auth-repair@example.com', 'Acme', 'acme-auth-repair')
      const { receiptId } = await seedAuthorityRow(t, {
        tenantId: account.tenant.id,
        storeId: 'store-repair',
        deviceId: 'dev-repair',
        userId: account.user.id,
      })
      // Mark the receipt as degraded with three affected packs.
      await t.db.rawExec(
        `INSERT INTO receipt_audit_state (receipt_id, tenant_id, status, affected_pack_count, updated_at)
           VALUES ($1, $2, 'degraded', 3, now())`,
        [receiptId, account.tenant.id],
      )

      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/store-repair/authority',
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as AuthorityRefreshResponse
      expect(body.status).toBe('updated')
      if (body.status !== 'updated') throw new Error('unreachable')
      expect(body.repair).toBeDefined()
      expect(body.repair?.kind).toBe('re_promote_requested')
      expect(body.repair?.affectedReceiptId).toBe(receiptId)
      expect(body.repair?.affectedPackCount).toBe(3)
      expect(body.repair?.reason).toBe('hash_mismatch')
    } finally {
      await t.close()
    }
  })

  it('omits the repair hint when the receipt is healthy in receipt_audit_state', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'auth-ok@example.com', 'Acme', 'acme-auth-ok')
      await seedAuthorityRow(t, {
        tenantId: account.tenant.id,
        storeId: 'store-ok',
        deviceId: 'dev-ok',
        userId: account.user.id,
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/store-ok/authority',
        headers: { authorization: `Bearer ${account.token}` },
      })
      const body = response.json() as AuthorityRefreshResponse
      expect(body.status).toBe('updated')
      if (body.status !== 'updated') throw new Error('unreachable')
      expect(body.repair).toBeUndefined()
    } finally {
      await t.close()
    }
  })

  it('flips the repair reason to `missing_pack` when the pack-level audit status is quarantined', async () => {
    // Pure unit-level check on the in-process resolver — easier to
    // wire than seeding `receipt_pack_grant` + `pack_audit_state`
    // through the HTTP surface.
    const rawExec = (async () => [
      {
        current_receipt_id: 'rcpt_a',
        payload: { receiptId: 'rcpt_a', tenantId: 't', storeId: 's' },
        signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
        store_pack_status: 'quarantined',
        receipt_audit_status: 'degraded',
        receipt_audit_pack_count: 2,
      },
    ]) as Parameters<typeof getAuthority>[0]['rawExec']
    const cache = new AuthorityTtlCache<CachedAuthority>({ ttlMs: 1000 })
    const result = await getAuthority(
      { rawExec, cache, now: () => 1_000 },
      { tenantId: 't', storeId: 's', knownReceiptId: null },
    )
    if (result.status !== 'updated') throw new Error('expected updated')
    expect(result.auditStatus).toBe('quarantined')
    expect(result.repair?.reason).toBe('missing_pack')
    expect(result.repair?.affectedPackCount).toBe(2)
  })
})
