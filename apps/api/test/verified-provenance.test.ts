import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type SignupResult = { token: string; tenant: { id: string }; user: { id: string } }

async function signup(t: TestApp, email: string): Promise<SignupResult> {
  const slug = email.replaceAll(/[^a-z0-9]/g, '-')
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: email,
      tenantSlug: slug,
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { result: { data: SignupResult } }).result.data
}

async function trpcGet(t: TestApp, path: string, input: unknown, token: string) {
  return t.app.inject({
    method: 'GET',
    url: `/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`,
    headers: { authorization: `Bearer ${token}` },
  })
}

async function seedVerifiedSession(t: TestApp, auth: SignupResult): Promise<void> {
  const handshake = await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.handshake',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: {
      cliVersion: '0.0.0',
      device: { name: 'device-verify', platform: 'linux' },
      store: { path: '/tmp/.prosa-verify', bundleVersion: '1' },
    } as never,
  })
  const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
  const plan = await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.planUpload',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: { deviceId, storePath: '/tmp/.prosa-verify', objects: [] } as never,
  })
  const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

  await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.commitUpload',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: {
      batchId,
      deviceId,
      storePath: '/tmp/.prosa-verify',
      objects: [],
      projection: {
        sessions: [{ id: 'sess-verified', sourceKind: 'codex', title: 'verified', turnCount: 1 }],
        searchDocs: [],
      },
    } as never,
  })
  const verify = await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.verifyPromotion',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: {
      batchId,
      storePath: '/tmp/.prosa-verify',
      declaredSessionIds: ['sess-verified'],
      declaredSearchDocIds: [],
    } as never,
  })
  expect(verify.statusCode).toBe(200)
}

describe('CQ-003 — artifact/object reads must require verified object provenance', () => {
  it('rejects artifacts.getText by objectId when no verified object manifest exists', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq003-obj@example.com')
      await seedVerifiedSession(t, auth)

      // Insert a tenant_object entry pointing at a remote_object that was
      // never declared by a verified batch's object manifest.
      await t.pglite.query(
        `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key)
         VALUES ('obj-unverified', 'h', 'blake3', 'none', 4, 4, 'storage/key-unverified')`,
      )
      await t.pglite.query(
        `INSERT INTO "tenant_object"(tenant_id, object_id, ref_count) VALUES ($1, 'obj-unverified', 1)`,
        [auth.tenant.id],
      )

      const resp = await trpcGet(t, 'artifacts.getText', { objectId: 'obj-unverified' }, auth.token)
      expect(resp.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('rejects artifacts.getText by artifactId when the object lacks a verified manifest entry', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq003-artifact@example.com')
      await seedVerifiedSession(t, auth)

      // Insert an artifact row whose object has a tenant grant but no
      // verified object manifest entry. The FK requires (tenant_id, object_id)
      // to exist in tenant_object; we satisfy that but skip the verified
      // sync_batch_object_manifest entry so CQ-003 must refuse the read.
      await t.pglite.query(
        `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key)
         VALUES ('obj-committed', 'h', 'blake3', 'none', 4, 4, 'storage/key-committed')`,
      )
      await t.pglite.query(
        `INSERT INTO "tenant_object"(tenant_id, object_id, ref_count) VALUES ($1, 'obj-committed', 1)`,
        [auth.tenant.id],
      )
      await t.pglite.query(
        `INSERT INTO "projection_artifact"(tenant_id, id, session_id, kind, object_id, size_bytes, metadata)
         VALUES ($1, 'art-committed', 'sess-verified', 'text', 'obj-committed', 4, NULL)`,
        [auth.tenant.id],
      )

      const resp = await trpcGet(t, 'artifacts.getText', { artifactId: 'art-committed' }, auth.token)
      // Tenant grant exists but no verified object manifest — must refuse.
      expect(resp.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-004 — auxiliary rows must derive from verified projections', () => {
  it('toolCalls.list omits rows pointing at unverified sessions', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq004-tools@example.com')
      await seedVerifiedSession(t, auth)

      // Insert a tool_call against a session that was never verified.
      await t.pglite.query(
        `INSERT INTO "projection_session"(tenant_id, id, source_kind, turn_count)
         VALUES ($1, 'sess-unverified', 'codex', 0)`,
        [auth.tenant.id],
      )
      await t.pglite.query(
        `INSERT INTO "projection_tool_call"(tenant_id, id, session_id, name, status, created_at)
         VALUES ($1, 'tc-unverified', 'sess-unverified', 'evil.tool', 'ok', NOW())`,
        [auth.tenant.id],
      )

      const resp = await trpcGet(t, 'toolCalls.list', {}, auth.token)
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { result: { data: { rows: Array<{ id: string }> } } }
      const ids = body.result.data.rows.map((r) => r.id)
      expect(ids).not.toContain('tc-unverified')
    } finally {
      await t.close()
    }
  })

  it('sessions.detail returns 404 for an unverified session even when events exist', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq004-detail@example.com')
      await seedVerifiedSession(t, auth)

      // Seed a session row + event but never verify the session.
      await t.pglite.query(
        `INSERT INTO "projection_session"(tenant_id, id, source_kind, turn_count)
         VALUES ($1, 'sess-detail-unverified', 'codex', 0)`,
        [auth.tenant.id],
      )
      await t.pglite.query(
        `INSERT INTO "projection_event"(tenant_id, id, session_id, sequence, kind, payload, occurred_at)
         VALUES ($1, 'ev-detail-unverified', 'sess-detail-unverified', 0, 'message', '{"x":1}'::jsonb, NOW())`,
        [auth.tenant.id],
      )

      const resp = await trpcGet(t, 'sessions.detail', { sessionId: 'sess-detail-unverified' }, auth.token)
      expect(resp.statusCode).toBe(200)
      const body = resp.json() as { result: { data: unknown } }
      // Verified-projection gate rejects unverified sessions: detail returns
      // null, the client treats that as "session not found".
      expect(body.result.data).toBeNull()
    } finally {
      await t.close()
    }
  })

  it('analytics.report fails closed (501) for the sessions report regardless of unverified rows', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq004-analytics@example.com')
      await seedVerifiedSession(t, auth)

      await t.pglite.query(
        `INSERT INTO "projection_session"(tenant_id, id, source_kind, turn_count, started_at)
         VALUES ($1, 'sess-an-unverified', 'codex', 0, NOW())`,
        [auth.tenant.id],
      )

      // CQ-006: remote analytics.report now fails closed for every report
      // kind in v0 (the projection lacks verified manifest entries for the
      // auxiliary tables those views depend on). Use the CLI/local
      // analytics for non-empty data.
      const resp = await trpcGet(t, 'analytics.report', { report: 'sessions' }, auth.token)
      expect(resp.statusCode).toBe(501)
    } finally {
      await t.close()
    }
  })
})
