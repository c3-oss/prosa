import { PUT_PREVERIFIED_BYTES, computeHashHex, objectStorageKey } from '@c3-oss/prosa-storage'
import { OBJECT_PACK_BINARY_CONTENT_TYPE, encodeBinaryObjectPack } from '@c3-oss/prosa-sync'
import { describe, expect, it } from 'vitest'
import { cleanupExpiredCommitUploadIdempotency } from '../src/trpc/routers/sync/idempotency.js'
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

async function trpc(
  t: TestApp,
  path: string,
  input: unknown,
  token: string,
  method: 'POST' | 'GET' = 'POST',
  headers: Record<string, string> = {},
) {
  if (method === 'GET') {
    const q = encodeURIComponent(JSON.stringify(input))
    return t.app.inject({
      method: 'GET',
      url: `/trpc/${path}?input=${q}`,
      headers: { authorization: `Bearer ${token}`, ...headers },
    })
  }
  return t.app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...headers },
    payload: input as never,
  })
}

async function handshakeDevice(t: TestApp, token: string, storePath: string, name: string): Promise<string> {
  const handshake = await trpc(
    t,
    'sync.handshake',
    {
      cliVersion: '0.0.0-test',
      device: { name, platform: 'linux' },
      store: { path: storePath, bundleVersion: '1' },
    },
    token,
  )
  expect(handshake.statusCode).toBe(200)
  return (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
}

async function readStoreBytes(t: TestApp, storageKey: string): Promise<Buffer> {
  const reader = (await t.objectStore.get(storageKey)).getReader()
  const chunks: Buffer[] = []
  let total = 0
  for (;;) {
    const result = await reader.read()
    if (result.done) break
    chunks.push(Buffer.from(result.value))
    total += result.value.byteLength
  }
  return Buffer.concat(chunks, total)
}

async function* bufferChunks(bytes: Buffer): AsyncIterable<Uint8Array> {
  yield bytes
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

  it('sanitizes NUL bytes in promoted projection text and JSON payloads', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-nul-projection@example.com')
      const storePath = '/tmp/.prosa-nul-projection-test'
      const deviceId = await handshakeDevice(t, auth.token, storePath, 'nul-projection-box')

      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [] }, auth.token)
      expect(plan.statusCode).toBe(200)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const commit = await trpc(
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
                id: 'source-nul',
                sourceKind: 'codex',
                path: '/tmp/source.jsonl',
                metadata: { label: 'source\u0000metadata' },
              },
            ],
            rawRecords: [
              {
                id: 'raw-nul',
                sourceFileId: 'source-nul',
                sequence: 0,
                payload: { text: 'raw\u0000payload' },
              },
            ],
            sessions: [
              {
                id: 'sess-nul',
                sourceKind: 'codex',
                title: 'title\u0000nul',
                turnCount: 1,
                metadata: { title: 'session\u0000metadata' },
              },
            ],
            searchDocs: [{ id: 'doc-nul', sessionId: 'sess-nul', kind: 'session', body: 'hello\u0000world' }],
            messages: [{ id: 'msg-nul', sessionId: 'sess-nul', role: 'assistant', model: 'model\u0000nul' }],
            contentBlocks: [
              {
                id: 'block-nul',
                messageId: 'msg-nul',
                sequence: 0,
                kind: 'text',
                text: 'block\u0000text',
                metadata: { nested: ['block\u0000metadata'] },
              },
            ],
            events: [
              {
                id: 'event-nul',
                sessionId: 'sess-nul',
                sequence: 0,
                kind: 'event',
                payload: { value: 'event\u0000payload' },
              },
            ],
            artifacts: [
              {
                id: 'artifact-nul',
                sessionId: 'sess-nul',
                kind: 'file',
                metadata: { path: '/tmp/artifact\u0000name' },
              },
            ],
          },
        },
        auth.token,
      )

      expect(commit.statusCode).toBe(200)
      const sessions = await t.pglite.query<{ title: string; metadata: { title: string } }>(
        'SELECT title, metadata FROM "projection_session" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'sess-nul'],
      )
      expect(sessions.rows[0]?.title).toBe('title\uFFFDnul')
      expect(sessions.rows[0]?.metadata.title).toBe('session\uFFFDmetadata')

      const searchDocs = await t.pglite.query<{ body: string }>(
        'SELECT body FROM "search_doc" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'doc-nul'],
      )
      expect(searchDocs.rows[0]?.body).toBe('hello\uFFFDworld')

      const rawRecords = await t.pglite.query<{ payload: { text: string } }>(
        'SELECT payload FROM "raw_record" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'raw-nul'],
      )
      expect(rawRecords.rows[0]?.payload.text).toBe('raw\uFFFDpayload')

      const blocks = await t.pglite.query<{ text: string; metadata: { nested: string[] } }>(
        'SELECT text, metadata FROM "projection_content_block" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'block-nul'],
      )
      expect(blocks.rows[0]?.text).toBe('block\uFFFDtext')
      expect(blocks.rows[0]?.metadata.nested).toEqual(['block\uFFFDmetadata'])

      const events = await t.pglite.query<{ payload: { value: string } }>(
        'SELECT payload FROM "projection_event" WHERE tenant_id = $1 AND id = $2',
        [auth.tenant.id, 'event-nul'],
      )
      expect(events.rows[0]?.payload.value).toBe('event\uFFFDpayload')
    } finally {
      await t.close()
    }
  })

  it('fails commit for a fresh zero-missing plan when stored object bytes are mismatched', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-zero-missing-byte-check@example.com')
      const storePath = '/tmp/.prosa-zero-missing-byte-check'
      const deviceId = await handshakeDevice(t, auth.token, storePath, 'zero-missing-byte-check-box')
      const bytes = Buffer.from('commit-byte-proof')
      const object = objectForBytes(bytes)

      const firstPlan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [object] }, auth.token)
      expect(firstPlan.statusCode).toBe(200)
      const firstPlanBody = firstPlan.json() as { result: { data: { batchId: string; missingObjectIds: string[] } } }
      expect(firstPlanBody.result.data.missingObjectIds).toEqual([object.objectId])

      const put = await t.app.inject({
        method: 'PUT',
        url:
          `/objects/${object.objectId}?batchId=${firstPlanBody.result.data.batchId}&hash=${object.hash}` +
          `&size=${bytes.byteLength}&uncompressed=${bytes.byteLength}&compression=none`,
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': 'application/octet-stream',
        },
        payload: bytes,
      })
      expect([200, 201]).toContain(put.statusCode)

      const zeroMissingPlan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [object] }, auth.token)
      expect(zeroMissingPlan.statusCode).toBe(200)
      const zeroMissingPlanBody = zeroMissingPlan.json() as {
        result: { data: { batchId: string; missingObjectIds: string[] } }
      }
      expect(zeroMissingPlanBody.result.data.missingObjectIds).toEqual([])

      const storageKey = objectStorageKey({ hash: object.hash, compression: object.compression })
      const wrongBytes = Buffer.alloc(bytes.byteLength, 0x78)
      await t.objectStore.delete(storageKey)
      await t.objectStore[PUT_PREVERIFIED_BYTES](storageKey, bufferChunks(wrongBytes), {
        hash: object.hash,
        hashAlgorithm: 'blake3',
        uncompressedSize: object.uncompressedSize,
        compressedSize: object.compressedSize,
        contentType: object.contentType,
      })

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId: zeroMissingPlanBody.result.data.batchId,
          deviceId,
          storePath,
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

  it('uploads missing objects as a binary remote pack blob and stores payload bytes only', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-binary-pack-user@example.com')
      const storePath = '/tmp/.prosa-binary-pack-test'
      const deviceId = await handshakeDevice(t, auth.token, storePath, 'binary-pack-box')

      const first = Buffer.from('alpha')
      const second = Buffer.from('beta!')
      const objects = [objectForBytes(first), objectForBytes(second)]
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects }, auth.token)
      expect(plan.statusCode).toBe(200)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const packBytes = Buffer.concat([first, second])
      const encoded = encodeBinaryObjectPack({
        payload: packBytes,
        entries: [
          { ...objects[0]!, offset: 0, length: first.byteLength },
          { ...objects[1]!, offset: first.byteLength, length: second.byteLength },
        ],
      })
      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE,
        },
        payload: Buffer.from(encoded),
      })
      expect(pack.statusCode).toBe(201)
      expect((pack.json() as { objectIds: string[] }).objectIds).toEqual(objects.map((object) => object.objectId))

      const blobs = await t.pglite.query<{ storage_key: string; byte_size: string | number }>(
        'SELECT storage_key, byte_size FROM "remote_blob" WHERE batch_id = $1',
        [batchId],
      )
      expect(blobs.rows).toHaveLength(1)
      expect(Number(blobs.rows[0]?.byte_size)).toBe(packBytes.byteLength)
      await expect(readStoreBytes(t, blobs.rows[0]!.storage_key)).resolves.toEqual(packBytes)
    } finally {
      await t.close()
    }
  })

  it('accepts JSON/base64 object packs as a fallback and stores payload bytes only', async () => {
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
      const blobs = await t.pglite.query<{ storage_key: string; byte_size: string | number }>(
        'SELECT storage_key, byte_size FROM "remote_blob" WHERE batch_id = $1',
        [batchId],
      )
      expect(blobs.rows).toHaveLength(1)
      expect(Number(blobs.rows[0]?.byte_size)).toBe(packBytes.byteLength)
      await expect(readStoreBytes(t, blobs.rows[0]!.storage_key)).resolves.toEqual(packBytes)
    } finally {
      await t.close()
    }
  })

  it('rejects object packs with incompatible catalog rows and removes uploaded pack bytes', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-catalog-conflict@example.com')
      const storePath = '/tmp/.prosa-pack-catalog-conflict'
      const deviceId = await handshakeDevice(t, auth.token, storePath, 'catalog-conflict-box')
      const bytes = Buffer.from('catalog-conflict')
      const object = objectForBytes(bytes)
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [object] }, auth.token)
      expect(plan.statusCode).toBe(200)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      await t.pglite.query(
        `INSERT INTO "remote_object"(
           object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
         )
         VALUES ($1, $2, 'blake3', 'none', $3, $4, NULL)`,
        [object.objectId, '0'.repeat(64), bytes.byteLength, bytes.byteLength],
      )

      const pack = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: { authorization: `Bearer ${auth.token}`, 'content-type': 'application/json' },
        payload: {
          bytesBase64: bytes.toString('base64'),
          entries: [{ ...object, offset: 0, length: bytes.byteLength }],
        },
      })

      expect(pack.statusCode).toBe(409)
      expect(pack.body).toContain('conflicting remote object metadata')
      expect(t.objectStore.size()).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('rejects malformed binary object packs', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-malformed@example.com')
      const response = await t.app.inject({
        method: 'POST',
        url: '/object-packs?batchId=batch_malformed_binary',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE,
        },
        payload: Buffer.from('definitely-not-a-pack'),
      })

      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('binary object pack')
      expect(t.objectStore.size()).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('rejects binary object packs when payload bytes do not match declared hashes', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-hash-mismatch@example.com')
      const storePath = '/tmp/.prosa-pack-hash-mismatch'
      const deviceId = await handshakeDevice(t, auth.token, storePath, 'hash-mismatch-box')
      const bytes = Buffer.from('correct')
      const object = objectForBytes(bytes)
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath, objects: [object] }, auth.token)
      expect(plan.statusCode).toBe(200)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const wrongBytes = Buffer.from('wrong!!')
      const encoded = encodeBinaryObjectPack({
        payload: wrongBytes,
        entries: [{ ...object, offset: 0, length: wrongBytes.byteLength }],
      })

      const response = await t.app.inject({
        method: 'POST',
        url: `/object-packs?batchId=${batchId}`,
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE,
        },
        payload: Buffer.from(encoded),
      })

      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('transport hash mismatch')
      expect(t.objectStore.size()).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('rejects duplicate binary object-pack entries before writing bytes', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-duplicate@example.com')
      const bytes = Buffer.from('dup')
      const object = objectForBytes(bytes)
      const encoded = encodeBinaryObjectPack({
        payload: bytes,
        entries: [
          { ...object, offset: 0, length: bytes.byteLength },
          { ...object, offset: 0, length: bytes.byteLength },
        ],
      })

      const response = await t.app.inject({
        method: 'POST',
        url: '/object-packs?batchId=batch_duplicate_binary',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE,
        },
        payload: Buffer.from(encoded),
      })

      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('duplicate objectId in pack entries')
      expect(t.objectStore.size()).toBe(0)
    } finally {
      await t.close()
    }
  })

  it('rejects binary object packs over the entry limit before writing bytes', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-pack-entry-limit@example.com')
      const bytes = Buffer.alloc(0)
      const object = objectForBytes(bytes)
      const encoded = encodeBinaryObjectPack({
        payload: bytes,
        entries: Array.from({ length: 1025 }, () => ({ ...object, offset: 0, length: 0 })),
      })

      const response = await t.app.inject({
        method: 'POST',
        url: '/object-packs?batchId=batch_entry_limit_binary',
        headers: {
          authorization: `Bearer ${auth.token}`,
          'content-type': OBJECT_PACK_BINARY_CONTENT_TYPE,
        },
        payload: Buffer.from(encoded),
      })

      expect(response.statusCode).toBe(400)
      expect(response.body).toContain('entries exceeds max object manifest count')
      expect(t.objectStore.size()).toBe(0)
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
      const otherHash = 'b'.repeat(64)
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
              objectId: `blake3:${otherHash}`,
              hash: otherHash,
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

  it('replays commitUpload responses for a matching Idempotency-Key', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-idempotency-key@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'box', platform: 'linux' },
          store: { path: '/tmp/idempotency-key', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/idempotency-key', objects: [] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const payload = {
        batchId,
        deviceId,
        storePath: '/tmp/idempotency-key',
        objects: [],
        projection: {
          sessions: [{ id: 'sess-idempotency-key', sourceKind: 'codex', turnCount: 1 }],
        },
      }
      const headers = { 'idempotency-key': `sync.commitUpload:${batchId}` }

      const first = await trpc(t, 'sync.commitUpload', payload, auth.token, 'POST', headers)
      const second = await trpc(t, 'sync.commitUpload', payload, auth.token, 'POST', headers)

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(200)
      expect(second.headers['x-prosa-idempotent-replay']).toBe('true')
      expect(second.json()).toEqual(first.json())

      const stored = await t.pglite.query<{ request_hash: string; response: unknown }>(
        'SELECT request_hash, response FROM "sync_commit_idempotency" WHERE tenant_id = $1',
        [auth.tenant.id],
      )
      expect(stored.rows).toHaveLength(1)
      expect(stored.rows[0]?.request_hash).toMatch(/^sha256:/)
      expect(stored.rows[0]?.response).toMatchObject({
        batchId,
        committedObjects: 0,
        committedRows: 1,
      })
    } finally {
      await t.close()
    }
  })

  it('rejects reusing an Idempotency-Key for a different commitUpload request', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-idempotency-conflict@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'box', platform: 'linux' },
          store: { path: '/tmp/idempotency-conflict', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/idempotency-conflict', objects: [] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const firstPayload = {
        batchId,
        deviceId,
        storePath: '/tmp/idempotency-conflict',
        objects: [],
        projection: {
          sessions: [{ id: 'sess-idempotency-conflict-a', sourceKind: 'codex', turnCount: 1 }],
        },
      }
      const secondPayload = {
        ...firstPayload,
        projection: {
          sessions: [{ id: 'sess-idempotency-conflict-b', sourceKind: 'codex', turnCount: 1 }],
        },
      }
      const headers = { 'idempotency-key': `sync.commitUpload:${batchId}` }

      const first = await trpc(t, 'sync.commitUpload', firstPayload, auth.token, 'POST', headers)
      const second = await trpc(t, 'sync.commitUpload', secondPayload, auth.token, 'POST', headers)

      expect(first.statusCode).toBe(200)
      expect(second.statusCode).toBe(409)
      expect(second.body).toContain('different sync.commitUpload request')
    } finally {
      await t.close()
    }
  })

  it('cleans up expired commitUpload idempotency rows', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-idempotency-cleanup@example.com')
      await t.db.rawExec(
        `INSERT INTO "sync_commit_idempotency"(
           tenant_id, user_id, idempotency_key, request_hash, expires_at
         )
         VALUES ($1, $2, $3, $4, now() - interval '1 minute')`,
        [auth.tenant.id, auth.user.id, 'expired-key', 'sha256:expired'],
      )

      await expect(cleanupExpiredCommitUploadIdempotency(t.db.rawExec)).resolves.toBe(1)
      const remaining = await t.db.rawExec<{ count: number }>(
        'SELECT count(*)::int AS count FROM "sync_commit_idempotency"',
      )
      expect(remaining[0]?.count).toBe(0)
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

  it('accepts message/content_block/event/artifact projection rows end-to-end', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-f3-types@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'transcript-box', platform: 'linux' },
          store: { path: '/tmp/.prosa-f3', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(t, 'sync.planUpload', { deviceId, storePath: '/tmp/.prosa-f3', objects: [] }, auth.token)
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-f3',
          objects: [],
          projection: {
            sessions: [{ id: 'sess-f3', sourceKind: 'codex', title: 't', turnCount: 1 }],
            messages: [
              {
                id: 'msg-1',
                sessionId: 'sess-f3',
                role: 'user',
                createdAt: '2026-04-01T10:00:00.000Z',
              },
            ],
            contentBlocks: [
              {
                id: 'blk-1',
                messageId: 'msg-1',
                sequence: 0,
                kind: 'text',
                text: 'hello',
              },
            ],
            events: [
              {
                id: 'ev-1',
                sessionId: 'sess-f3',
                sequence: 0,
                kind: 'message',
                payload: { source: 'user' },
                occurredAt: '2026-04-01T10:00:00.000Z',
              },
            ],
            artifacts: [
              {
                id: 'art-1',
                sessionId: 'sess-f3',
                kind: 'text',
                sizeBytes: 5,
              },
            ],
          },
        },
        auth.token,
      )
      expect(commit.statusCode).toBe(200)
      const commitBody = commit.json() as { result: { data: { committedRows: number } } }
      // 1 session + 1 msg + 1 block + 1 event + 1 artifact = 5
      expect(commitBody.result.data.committedRows).toBe(5)

      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/.prosa-f3',
          declaredSessionIds: ['sess-f3'],
          declaredMessageIds: ['msg-1'],
          declaredContentBlockIds: ['blk-1'],
          declaredEventIds: ['ev-1'],
          declaredArtifactIds: ['art-1'],
        },
        auth.token,
      )
      expect(verify.statusCode).toBe(200)
      const verifyBody = verify.json() as {
        result: {
          data: {
            receipt: {
              batchMessageCount: number
              batchContentBlockCount: number
              batchEventCount: number
              batchArtifactCount: number
              declaredMessagesVerified: number
              declaredContentBlocksVerified: number
              declaredEventsVerified: number
              declaredArtifactsVerified: number
            }
          }
        }
      }
      expect(verifyBody.result.data.receipt.batchMessageCount).toBe(1)
      expect(verifyBody.result.data.receipt.batchContentBlockCount).toBe(1)
      expect(verifyBody.result.data.receipt.batchEventCount).toBe(1)
      expect(verifyBody.result.data.receipt.batchArtifactCount).toBe(1)
      expect(verifyBody.result.data.receipt.declaredMessagesVerified).toBe(1)
      expect(verifyBody.result.data.receipt.declaredContentBlocksVerified).toBe(1)
      expect(verifyBody.result.data.receipt.declaredEventsVerified).toBe(1)
      expect(verifyBody.result.data.receipt.declaredArtifactsVerified).toBe(1)

      // Each new entity type gets its own manifest row, scoped to this batch+tenant.
      const manifest = await t.pglite.query<{ entity_type: string; entity_id: string }>(
        `SELECT entity_type, entity_id FROM "sync_batch_projection_manifest"
           WHERE batch_id = $1 AND entity_type = ANY(ARRAY['message','content_block','event','artifact'])
           ORDER BY entity_type, entity_id`,
        [batchId],
      )
      expect(manifest.rows).toEqual([
        { entity_type: 'artifact', entity_id: 'art-1' },
        { entity_type: 'content_block', entity_id: 'blk-1' },
        { entity_type: 'event', entity_id: 'ev-1' },
        { entity_type: 'message', entity_id: 'msg-1' },
      ])
    } finally {
      await t.close()
    }
  })

  it('fail-closes verify-promotion when transcript declarations diverge from the batch manifest', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-f3-mismatch@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-test',
          device: { name: 'm', platform: 'linux' },
          store: { path: '/tmp/.prosa-f3-mismatch', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/.prosa-f3-mismatch', objects: [] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-f3-mismatch',
          objects: [],
          projection: {
            sessions: [{ id: 'sess-mm', sourceKind: 'codex', turnCount: 1 }],
            messages: [{ id: 'msg-mm', sessionId: 'sess-mm', role: 'user' }],
          },
        },
        auth.token,
      )

      // Declaring an extra message that is not in the batch must fail-close
      // with a manifest declaration mismatch.
      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/.prosa-f3-mismatch',
          declaredSessionIds: ['sess-mm'],
          declaredMessageIds: ['msg-mm', 'msg-ghost'],
        },
        auth.token,
      )
      expect(verify.statusCode).toBe(412)
      expect(verify.body).toContain('message declarations')
    } finally {
      await t.close()
    }
  })

  it('remains backward-compatible with older clients that omit transcript entity types', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'sync-f3-bc@example.com')
      const handshake = await trpc(
        t,
        'sync.handshake',
        {
          cliVersion: '0.0.0-old',
          device: { name: 'old-cli', platform: 'linux' },
          store: { path: '/tmp/.prosa-f3-bc', bundleVersion: '1' },
        },
        auth.token,
      )
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const plan = await trpc(
        t,
        'sync.planUpload',
        { deviceId, storePath: '/tmp/.prosa-f3-bc', objects: [] },
        auth.token,
      )
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      // Payload mirrors a pre-F3 client: only tool_call/tool_result + session.
      const commit = await trpc(
        t,
        'sync.commitUpload',
        {
          batchId,
          deviceId,
          storePath: '/tmp/.prosa-f3-bc',
          objects: [],
          projection: {
            sessions: [{ id: 'sess-bc', sourceKind: 'codex', turnCount: 1 }],
            toolCalls: [{ id: 'tc-bc', sessionId: 'sess-bc', name: 'shell.exec' }],
            toolResults: [{ id: 'tr-bc', toolCallId: 'tc-bc', status: 'ok' }],
          },
        },
        auth.token,
      )
      expect(commit.statusCode).toBe(200)
      const verify = await trpc(
        t,
        'sync.verifyPromotion',
        {
          batchId,
          storePath: '/tmp/.prosa-f3-bc',
          declaredSessionIds: ['sess-bc'],
          declaredToolCallIds: ['tc-bc'],
          declaredToolResultIds: ['tr-bc'],
        },
        auth.token,
      )
      expect(verify.statusCode).toBe(200)
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
