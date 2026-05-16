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
