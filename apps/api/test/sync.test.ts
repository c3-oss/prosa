import { computeHashHex } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type Signup = {
  token: string
  user: { id: string; email: string }
  tenant: { id: string; name: string; slug: string | null }
}

async function signup(t: TestApp, email: string): Promise<Signup> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email.split('@')[0],
      tenantName: 'Acme',
      tenantSlug: 'acme',
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { result: { data: Signup } }
  return body.result.data
}

async function trpc(t: TestApp, path: string, input: unknown, token: string, method: 'POST' | 'GET' = 'POST') {
  if (method === 'GET') {
    const q = encodeURIComponent(JSON.stringify(input))
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${q}`,
      headers: { authorization: `Bearer ${token}` },
    })
  }
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    payload: input as never,
  })
}

describe('sync promotion protocol', () => {
  it('runs the full handshake → plan → put → commit → verify path', async () => {
    const t = await buildTestApp()
    try {
      const signupResult = await signup(t, 'sync-user@example.com')

      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'laptop-1', platform: 'linux' },
          store: { path: '/tmp/.prosa-test', bundleVersion: '1' },
        },
        signupResult.token,
      )
      expect(handshake.statusCode).toBe(200)
      const handshakeBody = handshake.json() as {
        result: { data: { deviceId: string; promoted: boolean; protocolVersion: number } }
      }
      expect(handshakeBody.result.data.protocolVersion).toBe(1)
      expect(handshakeBody.result.data.promoted).toBe(false)
      const deviceId = handshakeBody.result.data.deviceId

      const bytes = new Uint8Array(Array.from({ length: 16 }, (_, i) => i))
      const hash = computeHashHex(bytes, 'blake3')
      const objectId = `blake3:${hash}`

      const plan = await trpc(
        t,
        'sync.planUpload',
        {
          deviceId,
          storePath: '/tmp/.prosa-test',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              uncompressedSize: bytes.byteLength,
              compressedSize: bytes.byteLength,
              compression: 'none',
            },
          ],
        },
        signupResult.token,
      )
      expect(plan.statusCode).toBe(200)
      const planBody = plan.json() as {
        result: { data: { batchId: string; missingObjectIds: string[] } }
      }
      expect(planBody.result.data.missingObjectIds).toEqual([objectId])

      // PUT the bytes through the object route.
      const putResp = await t.app.inject({
        method: 'PUT',
        url:
          `/objects/${objectId}?batchId=${planBody.result.data.batchId}&hash=${hash}` +
          `&size=${bytes.byteLength}&uncompressed=${bytes.byteLength}&compression=none`,
        headers: {
          authorization: `Bearer ${signupResult.token}`,
          'content-type': 'application/octet-stream',
        },
        payload: Buffer.from(bytes),
      })
      expect([200, 201]).toContain(putResp.statusCode)

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: planBody.result.data.batchId,
          deviceId,
          storePath: '/tmp/.prosa-test',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              uncompressedSize: bytes.byteLength,
              compressedSize: bytes.byteLength,
              compression: 'none',
            },
          ],
          projection: {
            sessions: [
              {
                id: 'sess-1',
                sourceKind: 'codex',
                title: 'first session',
                turnCount: 3,
              },
            ],
            searchDocs: [{ id: 'doc-1', sessionId: 'sess-1', kind: 'session', body: 'hello world' }],
          },
        },
        signupResult.token,
      )
      expect(commit.statusCode).toBe(200)
      const commitBody = commit.json() as {
        result: { data: { committedObjects: number; committedRows: number } }
      }
      expect(commitBody.result.data.committedRows).toBe(2)

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId: planBody.result.data.batchId,
          storePath: '/tmp/.prosa-test',
          declaredObjectIds: [objectId],
          declaredSessionIds: ['sess-1'],
          declaredSearchDocIds: ['doc-1'],
        },
        signupResult.token,
      )
      expect(verify.statusCode).toBe(200)
      const verifyBody = verify.json() as {
        result: {
          data: {
            receipt: { sessionCount: number; objectCount: number; searchDocCount: number }
            sampledSessions: Array<{ id: string; title: string | null; turnCount: number }>
          }
        }
      }
      expect(verifyBody.result.data.receipt.sessionCount).toBe(1)
      expect(verifyBody.result.data.receipt.objectCount).toBe(1)
      expect(verifyBody.result.data.receipt.searchDocCount).toBe(1)
      expect(verifyBody.result.data.sampledSessions[0]?.title).toBe('first session')

      // After verify, handshake should report `promoted: true`.
      const handshake2 = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'laptop-1', platform: 'linux' },
          store: { path: '/tmp/.prosa-test', bundleVersion: '1' },
        },
        signupResult.token,
      )
      const body2 = handshake2.json() as { result: { data: { promoted: boolean } } }
      expect(body2.result.data.promoted).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('is idempotent when commitUpload is replayed', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-idem@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'box', platform: 'linux' },
          store: { path: '/tmp/x', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/x', objects: [] }, auth.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const commitPayload = {
        batchId,
        deviceId,
        storePath: '/tmp/x',
        objects: [],
        projection: {
          sessions: [{ id: 'sess-1', sourceKind: 'codex', turnCount: 1 }],
        },
      }
      const first = await trpc(t, 'sync.commitUpload', commitPayload, auth.token)
      const second = await trpc(t, 'sync.commitUpload', commitPayload, auth.token)
      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(412)
      const firstBody = first.json() as {
        result: { data: { committedObjects: number; committedRows: number } }
      }
      expect(firstBody.result.data.committedRows).toBe(1)
      expect(second.body).toContain('Batch is not open for commit')
    } finally {
      await t.close()
    }
  })
})
