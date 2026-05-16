import { computeHashHex } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

async function signup(t: TestApp, email: string) {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email,
      tenantName: email,
      tenantSlug: email.replaceAll(/[^a-z0-9]/g, '-'),
    } as never,
  })
  expect(response.statusCode).toBe(200)
  return (
    response.json() as {
      result: { data: { token: string; tenant: { id: string }; user: { id: string } } }
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

async function handshakeAndPlan(t: TestApp, token: string, storePath: string, objects: unknown[] = []) {
  const handshake = await trpc(
    t,
    'sync.handshake',
    {
      cliVersion: '0.0.0-test',
      device: { name: `device-${storePath}`, platform: 'linux' },
      store: { path: storePath, bundleVersion: '1' },
    },
    token,
  )
  const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
  const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects }, token)
  const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
  return { deviceId, batchId }
}

function objectEntry(bytes: Uint8Array) {
  const hash = computeHashHex(bytes, 'blake3')
  return {
    objectId: `blake3:${hash}`,
    hash,
    hashAlgorithm: 'blake3' as const,
    uncompressedSize: bytes.byteLength,
    compressedSize: bytes.byteLength,
    compression: 'none' as const,
  }
}

async function uploadObject(t: TestApp, token: string, batchId: string, bytes: Uint8Array) {
  const entry = objectEntry(bytes)
  const response = await t.app.inject({
    method: 'PUT',
    url:
      `/objects/${entry.objectId}?batchId=${batchId}&hash=${entry.hash}` +
      `&size=${bytes.byteLength}&uncompressed=${bytes.byteLength}&compression=none`,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/octet-stream',
    },
    payload: Buffer.from(bytes),
  })
  expect([200, 201]).toContain(response.statusCode)
  return entry
}

describe('sync server-owned manifest verification', () => {
  it('rejects duplicate object ids during planning', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-duplicate-object@example.com')
      const object = objectEntry(new Uint8Array([1, 2, 3, 4]))
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'duplicate-object-device', platform: 'linux' },
          store: { path: '/tmp/manifest-duplicate-object', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const plan = await trpc(
        t,
        'sync.planUpload',
        {
          deviceId,
          storePath: '/tmp/manifest-duplicate-object',
          objects: [object, object],
        },
        auth.token,
      )

      expect(plan.statusCode).toBe(400)
      expect(plan.body).toContain('Duplicate object_id in manifest')
    } finally {
      await t.close()
    }
  })

  it('rejects commit object drift from the planned manifest', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-drift@example.com')
      const plannedObject = objectEntry(new Uint8Array([1, 2, 3, 4]))
      const committedBytes = new Uint8Array([5, 6, 7, 8])
      const committedObject = objectEntry(committedBytes)
      const { deviceId, batchId } = await handshakeAndPlan(t, auth.token, '/tmp/manifest-drift', [
        plannedObject,
        committedObject,
      ])
      await uploadObject(t, auth.token, batchId, committedBytes)

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/manifest-drift',
          objects: [committedObject],
          projection: {},
        },
        auth.token,
      )

      expect(commit.statusCode).toBe(412)
      expect(commit.body).toContain('Commit objects do not match the planned manifest')
    } finally {
      await t.close()
    }
  })

  it('rejects verify with omitted declarations for a non-empty manifest', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-omitted@example.com')
      const { deviceId, batchId } = await handshakeAndPlan(t, auth.token, '/tmp/manifest-omitted')

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/manifest-omitted',
          objects: [],
          projection: { sessions: [{ id: 'sess-manifest', sourceKind: 'codex', turnCount: 1 }] },
        },
        auth.token,
      )
      expect(commit.statusCode).toBe(200)

      const verify = await trpc(t, 'sync.verifyPromotion', { batchId, storePath: '/tmp/manifest-omitted' }, auth.token)
      expect(verify.statusCode).toBe(412)
      expect(verify.body).toContain('session declarations must exactly match')
    } finally {
      await t.close()
    }
  })

  it('rejects verify when the storePath does not match the planned batch', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-store@example.com')
      const { deviceId, batchId } = await handshakeAndPlan(t, auth.token, '/tmp/manifest-store')
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/manifest-store',
          objects: [],
          projection: { sessions: [{ id: 'sess-store', sourceKind: 'codex', turnCount: 1 }] },
        },
        auth.token,
      )

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/other-store',
          declaredSessionIds: ['sess-store'],
        },
        auth.token,
      )
      expect(verify.statusCode).toBe(412)
      expect(verify.body).toContain('Batch storePath mismatch')
    } finally {
      await t.close()
    }
  })

  it('emits batch-scoped counts and a manifest hash', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-counts@example.com')
      const first = await handshakeAndPlan(t, auth.token, '/tmp/manifest-counts')
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: first.batchId,
          deviceId: first.deviceId,
          storePath: '/tmp/manifest-counts',
          objects: [],
          projection: { sessions: [{ id: 'sess-old', sourceKind: 'codex', turnCount: 1 }] },
        },
        auth.token,
      )
      await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId: first.batchId,
          storePath: '/tmp/manifest-counts',
          declaredSessionIds: ['sess-old'],
        },
        auth.token,
      )

      const second = await handshakeAndPlan(t, auth.token, '/tmp/manifest-counts')
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: second.batchId,
          deviceId: second.deviceId,
          storePath: '/tmp/manifest-counts',
          objects: [],
          projection: {
            sessions: [{ id: 'sess-new', sourceKind: 'codex', turnCount: 1 }],
            searchDocs: [{ id: 'doc-new', sessionId: 'sess-new', kind: 'session', body: 'new body' }],
          },
        },
        auth.token,
      )
      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId: second.batchId,
          storePath: '/tmp/manifest-counts',
          declaredSessionIds: ['sess-new'],
          declaredSearchDocIds: ['doc-new'],
        },
        auth.token,
      )

      expect(verify.statusCode).toBe(200)
      const receipt = (
        verify.json() as {
          result: {
            data: {
              receipt: {
                sessionCount: number
                searchDocCount: number
                batchSessionCount: number
                batchSearchDocCount: number
                manifestHash: string
                cleanupEligible: boolean
              }
            }
          }
        }
      ).result.data.receipt
      expect(receipt.sessionCount).toBe(1)
      expect(receipt.searchDocCount).toBe(1)
      expect(receipt.batchSessionCount).toBe(1)
      expect(receipt.batchSearchDocCount).toBe(1)
      expect(receipt.manifestHash).toMatch(/^sha256:[0-9a-f]{64}$/)
      expect(receipt.cleanupEligible).toBe(true)
    } finally {
      await t.close()
    }
  })

  it('allows ackCleanup only after a verified batch', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'manifest-ack@example.com')
      const { deviceId, batchId } = await handshakeAndPlan(t, auth.token, '/tmp/manifest-ack')

      const openAck = await trpc(
        t,
        'sync.ackCleanup',
        { batchId, storePath: '/tmp/manifest-ack', removedPaths: [] },
        auth.token,
      )
      expect(openAck.statusCode).toBe(412)

      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/manifest-ack',
          objects: [],
          projection: { sessions: [{ id: 'sess-ack', sourceKind: 'codex', turnCount: 1 }] },
        },
        auth.token,
      )
      const committedAck = await trpc(
        t,
        'sync.ackCleanup',
        { batchId, storePath: '/tmp/manifest-ack', removedPaths: [] },
        auth.token,
      )
      expect(committedAck.statusCode).toBe(412)

      await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/manifest-ack',
          declaredSessionIds: ['sess-ack'],
        },
        auth.token,
      )
      const verifiedAck = await trpc(
        t,
        'sync.ackCleanup',
        { batchId, storePath: '/tmp/manifest-ack', removedPaths: ['/tmp/manifest-ack/search'] },
        auth.token,
      )
      expect(verifiedAck.statusCode).toBe(200)
    } finally {
      await t.close()
    }
  })
})
