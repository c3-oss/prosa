// Lane 6 — authority refresh endpoint pin.
//
// Asserts the gate ladder (401 / 403 / 400), the cache TTL semantics
// (one Postgres query per (tenant, store) per TTL window), and the
// three response shapes — `unchanged`, `updated`, and
// `gone_or_forbidden`.

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
  opts: {
    tenantId: string
    storeId: string
    deviceId: string
    userId: string
    storePath?: string
    previousReceiptId?: string | null
    bundleRoot?: string
  },
): Promise<{ receiptId: string; payload: Record<string, unknown> }> {
  const storePath = opts.storePath ?? '/home/test/store'
  const bundleRoot = opts.bundleRoot ?? '00'.repeat(32)
  const seed = {
    receiptVersion: 2 as const,
    receiptId: 'placeholder',
    protocolVersion: 2 as const,
    tenantId: opts.tenantId,
    storeId: opts.storeId,
    storePath,
    deviceId: opts.deviceId,
    issuedAt: '2026-05-20T00:00:00.000Z',
    serverRegion: 'test',
    serverKeyId: t.signer.currentKeyId(),
    previousReceiptId: opts.previousReceiptId ?? null,
    previousBundleRoot: null,
    bundleRoot,
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
    [opts.tenantId, opts.storeId, receiptId, bundleRoot],
  )
  return { receiptId, payload: payload as unknown as Record<string, unknown> }
}

describe('Lane 6 authority refresh — HTTP route', () => {
  it('returns 401 when unauthenticated', async () => {
    const t = await buildTestApp()
    try {
      const response = await t.app.inject({ method: 'GET', url: '/v2/stores/some-store/authority' })
      expect(response.statusCode).toBe(401)
      expect((response.json() as { code: string }).code).toBe('UNAUTHENTICATED')
    } finally {
      await t.close()
    }
  })

  it('returns 400 when storeId is empty', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'auth-empty@example.com', 'Acme', 'acme-auth-empty')
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/%20/authority',
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(response.statusCode).toBe(400)
      expect((response.json() as { code: string }).code).toBe('INVALID_STORE_ID')
    } finally {
      await t.close()
    }
  })

  it('returns gone_or_forbidden when the store has no authority for the tenant', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'auth-none@example.com', 'Acme', 'acme-auth-none')
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/never-promoted/authority',
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as AuthorityRefreshResponse
      expect(body.status).toBe('gone_or_forbidden')
    } finally {
      await t.close()
    }
  })

  it('returns updated then unchanged when the caller knows the current receipt id', async () => {
    const t = await buildTestApp()
    try {
      const account = await signupTenant(t, 'auth-roundtrip@example.com', 'Acme', 'acme-auth-roundtrip')
      const seeded = await seedAuthorityRow(t, {
        tenantId: account.tenant.id,
        storeId: 'store-roundtrip',
        deviceId: 'dev-roundtrip',
        userId: account.user.id,
      })
      const first = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/store-roundtrip/authority',
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(first.statusCode).toBe(200)
      const firstBody = first.json() as AuthorityRefreshResponse
      expect(firstBody.status).toBe('updated')
      if (firstBody.status !== 'updated') throw new Error('unreachable')
      expect(firstBody.receipt.payload.receiptId).toBe(seeded.receiptId)
      expect(firstBody.auditStatus).toBe('audit_pending')

      const second = await t.app.inject({
        method: 'GET',
        url: `/v2/stores/store-roundtrip/authority?knownReceiptId=${seeded.receiptId}`,
        headers: { authorization: `Bearer ${account.token}` },
      })
      expect(second.statusCode).toBe(200)
      const secondBody = second.json() as AuthorityRefreshResponse
      expect(secondBody.status).toBe('unchanged')
      if (secondBody.status !== 'unchanged') throw new Error('unreachable')
      expect(secondBody.receiptId).toBe(seeded.receiptId)
    } finally {
      await t.close()
    }
  })

  it('does not leak an authority belonging to another tenant', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signupTenant(t, 'auth-alice@example.com', 'Alice', 'auth-alice')
      const bob = await signupTenant(t, 'auth-bob@example.com', 'Bob', 'auth-bob')
      // Bob promotes "shared-name" — Alice must not see Bob's authority.
      await seedAuthorityRow(t, {
        tenantId: bob.tenant.id,
        storeId: 'shared-name',
        deviceId: 'dev-bob',
        userId: bob.user.id,
      })
      const response = await t.app.inject({
        method: 'GET',
        url: '/v2/stores/shared-name/authority',
        headers: { authorization: `Bearer ${alice.token}` },
      })
      expect(response.statusCode).toBe(200)
      const body = response.json() as AuthorityRefreshResponse
      expect(body.status).toBe('gone_or_forbidden')
    } finally {
      await t.close()
    }
  })
})

describe('Lane 6 authority refresh — cache TTL', () => {
  it('serves cached values within the TTL and refetches after expiry', async () => {
    let queryCount = 0
    const rawExec = (async (sql: string, params?: unknown[]) => {
      void params
      queryCount += 1
      // Two-row response — the helper expects an array; the
      // contents are not validated by the cache test because we
      // route the response through `getAuthority` directly.
      return [
        {
          current_receipt_id: 'rcpt_a',
          payload: { receiptId: 'rcpt_a', tenantId: 't_a', storeId: 's_a' },
          signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
          store_pack_status: 'ok',
        },
      ] as Array<{
        current_receipt_id: string
        payload: unknown
        signature: unknown
        store_pack_status: string | null
      }>
    }) as Parameters<typeof getAuthority>[0]['rawExec']

    const cache = new AuthorityTtlCache<CachedAuthority>({ ttlMs: 1000 })
    let now = 1_000_000
    const tick = () => now

    const first = await getAuthority(
      { rawExec, cache, now: tick },
      { tenantId: 't_a', storeId: 's_a', knownReceiptId: null },
    )
    expect(first.status).toBe('updated')
    expect(queryCount).toBe(1)

    // Within TTL — second call must NOT hit Postgres.
    const second = await getAuthority(
      { rawExec, cache, now: tick },
      { tenantId: 't_a', storeId: 's_a', knownReceiptId: 'rcpt_a' },
    )
    expect(second.status).toBe('unchanged')
    expect(queryCount).toBe(1)

    // Past TTL — must refetch.
    now = 1_000_000 + 2000
    const third = await getAuthority(
      { rawExec, cache, now: tick },
      { tenantId: 't_a', storeId: 's_a', knownReceiptId: 'rcpt_a' },
    )
    expect(third.status).toBe('unchanged')
    expect(queryCount).toBe(2)
  })

  it('isolates the cache by (tenant, store) — different keys do not share entries', async () => {
    let queryCount = 0
    const rawExec = (async (sql: string, params?: unknown[]) => {
      queryCount += 1
      const tenant = String(params?.[0] ?? '')
      const store = String(params?.[1] ?? '')
      return [
        {
          current_receipt_id: `rcpt_${tenant}_${store}`,
          payload: { receiptId: `rcpt_${tenant}_${store}`, tenantId: tenant, storeId: store },
          signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
          store_pack_status: null,
        },
      ]
    }) as Parameters<typeof getAuthority>[0]['rawExec']
    const cache = new AuthorityTtlCache<CachedAuthority>({ ttlMs: 60_000 })
    const now = () => 5_000_000
    await getAuthority({ rawExec, cache, now }, { tenantId: 't_a', storeId: 's_a', knownReceiptId: null })
    await getAuthority({ rawExec, cache, now }, { tenantId: 't_a', storeId: 's_b', knownReceiptId: null })
    await getAuthority({ rawExec, cache, now }, { tenantId: 't_b', storeId: 's_a', knownReceiptId: null })
    // Three distinct keys -> three queries.
    expect(queryCount).toBe(3)
    // Re-hit any one — no new queries.
    await getAuthority({ rawExec, cache, now }, { tenantId: 't_a', storeId: 's_a', knownReceiptId: null })
    expect(queryCount).toBe(3)
  })

  it('maps `pack_audit_state.status` to the authority response auditStatus', async () => {
    const cases: Array<{ raw: string | null; expected: 'ok' | 'audit_pending' | 'drift' | 'quarantined' }> = [
      { raw: 'ok', expected: 'ok' },
      { raw: 'drift', expected: 'drift' },
      { raw: 'quarantined', expected: 'quarantined' },
      { raw: null, expected: 'audit_pending' },
      { raw: 'unknown-status', expected: 'audit_pending' },
    ]
    for (const c of cases) {
      const rawExec = (async () => [
        {
          current_receipt_id: 'rcpt',
          payload: { receiptId: 'rcpt', tenantId: 't', storeId: 's' },
          signature: { alg: 'Ed25519', keyId: 'k', sig: 'AA' },
          store_pack_status: c.raw,
        },
      ]) as Parameters<typeof getAuthority>[0]['rawExec']
      const cache = new AuthorityTtlCache<CachedAuthority>({ ttlMs: 1000 })
      const r = await getAuthority(
        { rawExec, cache, now: () => 1_000 },
        { tenantId: 't', storeId: 's', knownReceiptId: null },
      )
      if (r.status !== 'updated' && r.status !== 'unchanged') throw new Error('expected receipt')
      expect(r.auditStatus).toBe(c.expected)
    }
  })
})
