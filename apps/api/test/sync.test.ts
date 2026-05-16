import { computeHashHex, objectStorageKey } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type Signup = {
  token: string
  user: { id: string; email: string }
  tenant: { id: string; name: string; slug: string | null }
}

async function signup(t: TestApp, email: string, tenantSlug = 'acme'): Promise<Signup> {
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers: { 'content-type': 'application/json' },
    payload: {
      email,
      password: 'correct-horse-battery',
      name: email.split('@')[0],
      tenantName: 'Acme',
      tenantSlug,
    },
  })
  expect(response.statusCode).toBe(200)
  const body = response.json() as { result: { data: Signup } }
  return body.result.data
}

function objectForBytes(bytes: Buffer) {
  const hash = computeHashHex(bytes, 'blake3')
  return {
    objectId: `blake3:${hash}`,
    hash,
    hashAlgorithm: 'blake3' as const,
    uncompressedSize: bytes.byteLength,
    compressedSize: bytes.byteLength,
    compression: 'none' as const,
    contentType: 'text/plain',
  }
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
            toolCalls: [
              {
                id: 'tc-1',
                sessionId: 'sess-1',
                name: 'shell.exec',
                status: 'ok',
                createdAt: '2026-04-01T10:00:00.000Z',
              },
            ],
            toolResults: [
              {
                id: 'tr-1',
                toolCallId: 'tc-1',
                status: 'ok',
                finishedAt: '2026-04-01T10:00:01.000Z',
              },
            ],
          },
        },
        signupResult.token,
      )
      expect(commit.statusCode).toBe(200)
      const commitBody = commit.json() as {
        result: { data: { committedObjects: number; committedRows: number } }
      }
      expect(commitBody.result.data.committedRows).toBe(4)

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId: planBody.result.data.batchId,
          storePath: '/tmp/.prosa-test',
          declaredObjectIds: [objectId],
          declaredSessionIds: ['sess-1'],
          declaredSearchDocIds: ['doc-1'],
          declaredToolCallIds: ['tc-1'],
          declaredToolResultIds: ['tr-1'],
        },
        signupResult.token,
      )
      expect(verify.statusCode).toBe(200)
      const verifyBody = verify.json() as {
        result: {
          data: {
            receipt: {
              sessionCount: number
              objectCount: number
              searchDocCount: number
              batchToolCallCount: number
              batchToolResultCount: number
            }
            sampledSessions: Array<{ id: string; title: string | null; turnCount: number }>
          }
        }
      }
      expect(verifyBody.result.data.receipt.sessionCount).toBe(1)
      expect(verifyBody.result.data.receipt.objectCount).toBe(1)
      expect(verifyBody.result.data.receipt.searchDocCount).toBe(1)
      expect(verifyBody.result.data.receipt.batchToolCallCount).toBe(1)
      expect(verifyBody.result.data.receipt.batchToolResultCount).toBe(1)
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

  it('uploads missing objects as one remote pack blob and reads them by range', async () => {
    const t = await buildTestApp()
    try {
      const signupResult = await signup(t, 'sync-pack-user@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'laptop-pack', platform: 'linux' },
          store: { path: '/tmp/.prosa-pack-test', bundleVersion: '1' },
        },
        signupResult.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const first = Buffer.from('alpha')
      const second = Buffer.from('beta!')
      const firstHash = computeHashHex(first, 'blake3')
      const secondHash = computeHashHex(second, 'blake3')
      const firstObjectId = `blake3:${firstHash}`
      const secondObjectId = `blake3:${secondHash}`
      const objects = [
        {
          objectId: firstObjectId,
          hash: firstHash,
          hashAlgorithm: 'blake3' as const,
          uncompressedSize: first.byteLength,
          compressedSize: first.byteLength,
          compression: 'none' as const,
          contentType: 'text/plain',
        },
        {
          objectId: secondObjectId,
          hash: secondHash,
          hashAlgorithm: 'blake3' as const,
          uncompressedSize: second.byteLength,
          compressedSize: second.byteLength,
          compression: 'none' as const,
          contentType: 'text/plain',
        },
      ]

      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/.prosa-pack-test', objects },
        signupResult.token,
      )
      expect(plan.statusCode).toBe(200)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const packBytes = Buffer.concat([first, second])

      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: {
          authorization: `Bearer ${signupResult.token}`,
          'content-type': 'application/json',
        },
        payload: {
          bytesBase64: packBytes.toString('base64'),
          entries: [
            { ...objects[0], offset: 0, length: first.byteLength },
            { ...objects[1], offset: first.byteLength, length: second.byteLength },
          ],
        },
      })
      expect(pack.statusCode).toBe(201)
      expect(t.objectStore.size()).toBe(1)

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-pack-test',
          objects,
          projection: {
            sessions: [{ id: 'sess-pack-1', sourceKind: 'codex', title: 'packed session', turnCount: 1 }],
          },
        },
        signupResult.token,
      )
      expect(commit.statusCode).toBe(200)

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/.prosa-pack-test',
          declaredObjectIds: [firstObjectId, secondObjectId],
          declaredSessionIds: ['sess-pack-1'],
        },
        signupResult.token,
      )
      expect(verify.statusCode).toBe(200)

      for (const [objectId, expected] of [
        [firstObjectId, first],
        [secondObjectId, second],
      ] as const) {
        const get = await t.app.inject({
          method: 'GET',
          url: `/objects/${objectId}`,
          headers: { authorization: `Bearer ${signupResult.token}` },
        })
        expect(get.statusCode).toBe(200)
        expect(get.body).toBe(expected.toString('utf8'))
      }

      const preview = await trpc(
        t,
        'artifacts.getText',
        { objectId: secondObjectId, maxBytes: 1024 },
        signupResult.token,
        'GET',
      )
      expect(preview.statusCode).toBe(200)
      const previewBody = preview.json() as { result: { data: { text: string } } }
      expect(previewBody.result.data.text).toBe('beta!')
    } finally {
      await t.close()
    }
  })

  it('does not treat another tenant packed object as present by hash alone', async () => {
    const t = await buildTestApp()
    try {
      const alice = await signup(t, 'sync-pack-alice@example.com', 'alice-pack')
      const aliceHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'alice-box', platform: 'linux' },
          store: { path: '/tmp/alice-pack', bundleVersion: '1' },
        },
        alice.token,
      )
      const aliceDeviceId = (aliceHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bytes = Buffer.from('shared bytes')
      const object = objectForBytes(bytes)
      const alicePlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId: aliceDeviceId, storePath: '/tmp/alice-pack', objects: [object] },
        alice.token,
      )
      const aliceBatchId = (alicePlan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const alicePack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${aliceBatchId}`,
        headers: { authorization: `Bearer ${alice.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: bytes.toString('base64'),
          entries: [{ ...object, offset: 0, length: bytes.byteLength }],
        },
      })
      expect(alicePack.statusCode).toBe(201)

      const bob = await signup(t, 'sync-pack-bob@example.com', 'bob-pack')
      const bobHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'bob-box', platform: 'linux' },
          store: { path: '/tmp/bob-pack', bundleVersion: '1' },
        },
        bob.token,
      )
      const bobDeviceId = (bobHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bobPlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId: bobDeviceId, storePath: '/tmp/bob-pack', objects: [object] },
        bob.token,
      )
      expect(bobPlan.statusCode).toBe(200)
      const bobPlanBody = bobPlan.json() as { result: { data: { batchId: string; missingObjectIds: string[] } } }
      expect(bobPlanBody.result.data.missingObjectIds).toEqual([object.objectId])

      const bobCommit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: bobPlanBody.result.data.batchId,
          deviceId: bobDeviceId,
          storePath: '/tmp/bob-pack',
          objects: [object],
          projection: {},
        },
        bob.token,
      )
      expect(bobCommit.statusCode).toBe(412)
      expect(bobCommit.body).toContain('Object bytes are missing or mismatched')
    } finally {
      await t.close()
    }
  })

  it('rejects object packs whose aggregate uncompressed size exceeds the route cap', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-dos@example.com')
      const empty = Buffer.alloc(0)
      const hash = computeHashHex(empty, 'blake3')
      const overHalfLimit = 129 * 1024 * 1024
      const response = await t.app.inject({
        method: 'POST',
        url: '/object-packs?batchId=batch_aggregate_dos',
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: empty.toString('base64'),
          entries: [
            {
              objectId: `blake3:${hash}`,
              hash,
              hashAlgorithm: 'blake3',
              compression: 'none',
              compressedSize: 0,
              uncompressedSize: overHalfLimit,
              offset: 0,
              length: 0,
            },
            {
              objectId: `blake3:${hash}`,
              hash,
              hashAlgorithm: 'blake3',
              compression: 'none',
              compressedSize: 0,
              uncompressedSize: overHalfLimit,
              offset: 0,
              length: 0,
            },
          ],
        },
      })
      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('pack aggregate uncompressed size exceeds maxObjectBytes')
    } finally {
      await t.close()
    }
  })

  it('fails commit when packed blob identity metadata no longer matches object storage', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-identity@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'identity-box', platform: 'linux' },
          store: { path: '/tmp/identity-pack', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bytes = Buffer.from('identity-check')
      const object = objectForBytes(bytes)
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/identity-pack', objects: [object] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: bytes.toString('base64'),
          entries: [{ ...object, offset: 0, length: bytes.byteLength }],
        },
      })
      expect(pack.statusCode).toBe(201)

      await t.pglite.query('UPDATE "remote_blob" SET hash = $1', ['0'.repeat(64)])
      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/identity-pack',
          objects: [object],
          projection: {},
        },
        auth.token,
      )
      expect(commit.statusCode).toBe(412)
      expect(commit.body).toContain('Object bytes are missing or mismatched')
    } finally {
      await t.close()
    }
  })

  it('fails commit when a packed object location points at the wrong range', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-range@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'range-box', platform: 'linux' },
          store: { path: '/tmp/range-pack', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const first = Buffer.from('first')
      const second = Buffer.from('other')
      const firstObject = objectForBytes(first)
      const secondObject = objectForBytes(second)
      const objects = [firstObject, secondObject]
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/range-pack', objects }, auth.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const packBytes = Buffer.concat([first, second])
      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: packBytes.toString('base64'),
          entries: [
            { ...firstObject, offset: 0, length: first.byteLength },
            { ...secondObject, offset: first.byteLength, length: second.byteLength },
          ],
        },
      })
      expect(pack.statusCode).toBe(201)

      await t.pglite.query('UPDATE "remote_object_location" SET byte_offset = $1 WHERE object_id = $2', [
        first.byteLength,
        firstObject.objectId,
      ])
      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/range-pack',
          objects,
          projection: {},
        },
        auth.token,
      )
      expect(commit.statusCode).toBe(412)
      expect(commit.body).toContain('Object bytes are missing or mismatched')
    } finally {
      await t.close()
    }
  })

  it('rejects legacy PUT against a packed object without writing an orphan object', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-legacy-put@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'legacy-put-box', platform: 'linux' },
          store: { path: '/tmp/legacy-put-pack', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bytes = Buffer.from('packed then put')
      const object = objectForBytes(bytes)
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/legacy-put-pack', objects: [object] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: bytes.toString('base64'),
          entries: [{ ...object, offset: 0, length: bytes.byteLength }],
        },
      })
      expect(pack.statusCode).toBe(201)
      expect(t.objectStore.size()).toBe(1)

      const put = await t.app.inject({
        method: 'PUT',
        url:
          `/objects/${object.objectId}?batchId=${batchId}&hash=${object.hash}` +
          `&size=${bytes.byteLength}&uncompressed=${bytes.byteLength}&compression=none`,
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      expect(put.statusCode).toBe(409)
      expect(put.body).toContain('conflicting remote object location')
      expect(t.objectStore.size()).toBe(1)
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

  it('treats raw record import batch ids as volatile during equivalent re-promotion', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-raw-import-batch@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'box', platform: 'linux' },
          store: { path: '/tmp/raw-a', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      async function commitRawRecord(storePath: string, payload: Record<string, unknown>) {
        const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [] }, auth.token)
        const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
        return trpc(
          t,
          'sync.commitUpload',
          {
            batchId,
            deviceId,
            storePath,
            objects: [],
            projection: {
              sourceFiles: [
                {
                  id: 'source-codex-fixture',
                  sourceKind: 'codex',
                  path: '/fixtures/codex/session.jsonl',
                },
              ],
              rawRecords: [
                {
                  id: 'raw-codex-fixture-line-1',
                  sourceFileId: 'source-codex-fixture',
                  sequence: 1,
                  payload,
                  objectId: null,
                },
              ],
            },
          },
          auth.token,
        )
      }

      const first = await commitRawRecord('/tmp/raw-a', {
        decodedObjectId: null,
        parserStatus: 'ok',
        confidence: 'high',
        importBatchId: 'compile-run-a',
      })
      const second = await commitRawRecord('/tmp/raw-b', {
        decodedObjectId: null,
        parserStatus: 'ok',
        confidence: 'high',
        importBatchId: 'compile-run-b',
      })
      const conflicting = await commitRawRecord('/tmp/raw-c', {
        decodedObjectId: null,
        parserStatus: 'failed',
        confidence: 'high',
        importBatchId: 'compile-run-c',
      })

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(conflicting.statusCode).toBe(409)
      expect(conflicting.body).toContain('Conflicting raw record payload')

      const stored = await t.pglite.query<{ payload: Record<string, unknown> }>(
        'SELECT payload FROM "raw_record" WHERE id = $1',
        ['raw-codex-fixture-line-1'],
      )
      expect(stored.rows[0]?.payload).toEqual({
        decodedObjectId: null,
        parserStatus: 'ok',
        confidence: 'high',
      })
    } finally {
      await t.close()
    }
  })

  it('does not bind device authorization to the last handshaken store path', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-multi-store@example.com')
      const realHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'same-cli-device', platform: 'linux' },
          store: { path: '/home/user/.prosa', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (realHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const realPlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/home/user/.prosa', objects: [] },
        auth.token,
      )
      const realBatchId = (realPlan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const tempHandshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'same-cli-device', platform: 'linux' },
          store: { path: '/tmp/prosa-store', bundleVersion: '1' },
        },
        auth.token,
      )
      expect((tempHandshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId).toBe(deviceId)
      const tempPlan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/prosa-store', objects: [] },
        auth.token,
      )
      const tempBatchId = (tempPlan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const tempCommit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: tempBatchId,
          deviceId,
          storePath: '/tmp/prosa-store',
          objects: [],
          projection: {
            sessions: [{ id: 'temp-session', sourceKind: 'codex', turnCount: 1 }],
          },
        },
        auth.token,
      )
      expect(tempCommit.statusCode).toBe(200)

      const realCommit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: realBatchId,
          deviceId,
          storePath: '/home/user/.prosa',
          objects: [],
          projection: {
            sessions: [{ id: 'real-session', sourceKind: 'codex', turnCount: 1 }],
          },
        },
        auth.token,
      )
      expect(realCommit.statusCode).toBe(200)
    } finally {
      await t.close()
    }
  })
})
