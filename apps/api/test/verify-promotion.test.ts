import { computeHashHex } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function signup(t: TestApp, email: string, tenantName: string, tenantSlug: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName,
      tenantSlug,
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: {
        data: {
          token: string
          user: { id: string; email: string }
          tenant: { id: string; name: string; slug: string | null }
        }
      }
    }
  ).result.data
}

async function trpc(t: TestApp, path: string, input: unknown, token: string) {
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: input as never,
  })
}

describe('verifyPromotion rigor', () => {
  it('refuses to emit a receipt when the client declares objects it never uploaded', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'verify-a@example.com', 'Alpha', 'verify-alpha')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'box' },
          store: { path: '/tmp/a', bundleVersion: '1' },
        },
        alice.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/a', objects: [] }, alice.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      // Commit with no objects.
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/a',
          objects: [],
          projection: { sessions: [{ id: 'sess-a', sourceKind: 'codex', turnCount: 1 }] },
        },
        alice.token,
      )

      // Verify, declaring a fake object id that was never uploaded.
      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/a',
          declaredObjectIds: ['blake3:missing-object'],
          declaredSessionIds: ['sess-a'],
        },
        alice.token,
      )
      expect(verify.statusCode).toBe(412)
      expect(verify.body).toContain('Promotion verification failed')

      // The batch must be marked verification_failed so a retry can find it.
      const rows = await t.pglite.query<{ status: string }>('SELECT status FROM "sync_batch" WHERE id = $1 LIMIT 1', [
        batchId,
      ])
      expect(rows.rows[0]?.status).toBe('verification_failed')
    } finally {
      await t.close()
    }
  })

  it('refuses when declared sessions are not in the tenant projection', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'verify-sess@example.com', 'Alpha', 'verify-sess')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'box' },
          store: { path: '/tmp/a', bundleVersion: '1' },
        },
        alice.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/a', objects: [] }, alice.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/a',
          objects: [],
          projection: { sessions: [{ id: 'real-sess', sourceKind: 'codex', turnCount: 1 }] },
        },
        alice.token,
      )
      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/a',
          declaredSessionIds: ['real-sess', 'phantom-sess'],
        },
        alice.token,
      )
      expect(verify.statusCode).toBe(412)
      expect(verify.body).toContain('1 sessions')
    } finally {
      await t.close()
    }
  })

  it('emits a receipt with verification counters when a bundle with CAS+sessions is fully promoted', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'verify-full@example.com', 'Alpha', 'verify-full')
      const bytes = new Uint8Array([10, 11, 12, 13, 14])
      const hash = computeHashHex(bytes, 'blake3')
      const objectId = `blake3:${hash}`

      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0',
          device: { name: 'box' },
          store: { path: '/tmp/a', bundleVersion: '1' },
        },
        alice.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const plan = await trpc(
        t,
        'sync.planUpload',
        {
          deviceId,
          storePath: '/tmp/a',
          objects: [{ objectId, hash, hashAlgorithm: 'blake3', uncompressedSize: 5, compressedSize: 5 }],
        },
        alice.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      // Upload the bytes through the object route.
      const putResp = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?hash=${hash}&size=5&uncompressed=5`,
        headers: {
          authorization: `Bearer ${alice.token}`,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from(bytes),
      })
      expect([200, 201]).toContain(putResp.statusCode)

      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/a',
          objects: [{ objectId, hash, hashAlgorithm: 'blake3', uncompressedSize: 5, compressedSize: 5 }],
          projection: {
            sessions: [{ id: 'sess-real', sourceKind: 'codex', title: 'live', turnCount: 1 }],
            searchDocs: [{ id: 'doc-real', sessionId: 'sess-real', kind: 'session', body: 'live body' }],
          },
        },
        alice.token,
      )

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/a',
          declaredObjectIds: [objectId],
          declaredSessionIds: ['sess-real'],
          declaredSearchDocIds: ['doc-real'],
        },
        alice.token,
      )
      expect(verify.statusCode).toBe(200)
      const body = verify.json() as {
        result: {
          data: {
            receipt: {
              declaredObjectsVerified: number
              declaredSessionsVerified: number
              declaredSearchDocsVerified: number
            }
          }
        }
      }
      expect(body.result.data.receipt.declaredObjectsVerified).toBe(1)
      expect(body.result.data.receipt.declaredSessionsVerified).toBe(1)
      expect(body.result.data.receipt.declaredSearchDocsVerified).toBe(1)
    } finally {
      await t.close()
    }
  })
})
