import { computeHashHex } from '@c3-oss/prosa-storage'
import { describe, expect, it } from 'vitest'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type SignupResult = { token?: string; tenant: { id: string }; user: { id: string } }

async function signup(t: TestApp, email: string, origin?: string): Promise<SignupResult> {
  const slug = email.replaceAll(/[^a-z0-9]/g, '-')
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  const response = await t.app.inject({
    method: 'POST',
    url: '/trpc/auth.signupWithTenant',
    headers,
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

async function postAuth(t: TestApp, path: string, body: unknown, origin?: string) {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (origin) headers.origin = origin
  return t.app.inject({
    method: 'POST',
    url: `/api/auth/${path}`,
    headers,
    payload: body as never,
  })
}

describe('CQ-007 — Better Auth catch-all must strip browser tokens', () => {
  const browserOrigin = 'https://console.prosa.dev'

  it('strips token from sign-up/email for browser-origin callers', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: browserOrigin })
    try {
      const resp = await postAuth(
        t,
        'sign-up/email',
        { email: 'cq007-up@example.com', password: 'correct-horse-battery', name: 'CQ007 Up' },
        browserOrigin,
      )
      expect(resp.statusCode).toBe(200)
      const body = JSON.parse(resp.body) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'token')).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('strips token from sign-in/email for browser-origin callers', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: browserOrigin })
    try {
      // Create the user via the tRPC signup wrapper so a session exists.
      await signup(t, 'cq007-in@example.com')
      const resp = await postAuth(
        t,
        'sign-in/email',
        { email: 'cq007-in@example.com', password: 'correct-horse-battery' },
        browserOrigin,
      )
      expect(resp.statusCode).toBe(200)
      const body = JSON.parse(resp.body) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(body, 'token')).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('strips token when Origin equals the API URL (same-origin browser deploy)', async () => {
    // Codex verifier finding: a same-origin browser deploy attaches
    // Origin = PROSA_API_URL. That still travels from JavaScript and must
    // not receive the bearer token.
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: browserOrigin })
    try {
      const apiOriginUp = await postAuth(
        t,
        'sign-up/email',
        { email: 'cq007-api-origin@example.com', password: 'correct-horse-battery', name: 'API Origin Up' },
        'http://127.0.0.1:3000',
      )
      expect(apiOriginUp.statusCode).toBe(200)
      const upBody = JSON.parse(apiOriginUp.body) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(upBody, 'token')).toBe(false)

      const apiOriginIn = await postAuth(
        t,
        'sign-in/email',
        { email: 'cq007-api-origin@example.com', password: 'correct-horse-battery' },
        'http://127.0.0.1:3000',
      )
      expect(apiOriginIn.statusCode).toBe(200)
      const inBody = JSON.parse(apiOriginIn.body) as Record<string, unknown>
      expect(Object.prototype.hasOwnProperty.call(inBody, 'token')).toBe(false)
    } finally {
      await t.close()
    }
  })

  it('strips token from tRPC auth.signupWithTenant for same-origin browsers', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: browserOrigin })
    try {
      const auth = await signup(t, 'cq007-trpc-same@example.com', 'http://127.0.0.1:3000')
      expect(auth.token).toBeUndefined()
      expect(typeof auth.tenant.id).toBe('string')
    } finally {
      await t.close()
    }
  })

  it('CLI-origin (no Origin header) sign-up still receives the token', async () => {
    const t = await buildTestApp({ PROSA_WEB_ORIGIN: browserOrigin })
    try {
      const resp = await postAuth(t, 'sign-up/email', {
        email: 'cq007-cli@example.com',
        password: 'correct-horse-battery',
        name: 'CQ007 CLI',
      })
      expect(resp.statusCode).toBe(200)
      const body = JSON.parse(resp.body) as { token?: string }
      expect(typeof body.token).toBe('string')
      expect((body.token ?? '').length).toBeGreaterThan(10)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-003 — GET /objects/:objectId requires verified object provenance', () => {
  it('rejects a committed-but-unverified object even after tenant_object grant', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq003-raw@example.com')
      // Insert remote_object + tenant_object directly, but DO NOT add a
      // verified sync_batch_object_manifest entry.
      await t.pglite.query(
        `INSERT INTO "remote_object"(object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key)
         VALUES ('obj-committed', 'h', 'blake3', 'none', 4, 4, 'objects/blake3/aa/bb/h.bin')`,
      )
      await t.pglite.query(
        `INSERT INTO "tenant_object"(tenant_id, object_id, ref_count) VALUES ($1, 'obj-committed', 1)`,
        [auth.tenant.id],
      )

      const resp = await t.app.inject({
        method: 'GET',
        url: '/objects/obj-committed',
        headers: { authorization: `Bearer ${auth.token!}` },
      })
      expect(resp.statusCode).toBe(404)
    } finally {
      await t.close()
    }
  })

  it('serves bytes only when both tenant ownership and verified object manifest exist', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq003-ok@example.com')
      // Boot a real upload via the sync flow, then mark batch verified.
      const handshake = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.handshake',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          cliVersion: '0.0.0',
          device: { name: 'd', platform: 'linux' },
          store: { path: '/tmp/cq003', bundleVersion: '1' },
        } as never,
      })
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      const bytes = Buffer.from('verified raw bytes')
      const hash = computeHashHex(bytes, 'blake3')
      const objectId = `blake3:${hash}`
      const plan = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.planUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          deviceId,
          storePath: '/tmp/cq003',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              transportHash: hash,
              compression: 'none',
              compressedSize: bytes.byteLength,
              uncompressedSize: bytes.byteLength,
            },
          ],
        } as never,
      })
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const objectQuery = new URLSearchParams({
        batchId,
        objectId,
        hash,
        size: String(bytes.byteLength),
        uncompressed: String(bytes.byteLength),
        compression: 'none',
      })
      const put = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?${objectQuery.toString()}`,
        headers: { authorization: `Bearer ${auth.token!}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      expect(put.statusCode).toBe(201)

      // Before verifyPromotion: read must still 404 because the batch is
      // not yet verified.
      const before = await t.app.inject({
        method: 'GET',
        url: `/objects/${objectId}`,
        headers: { authorization: `Bearer ${auth.token!}` },
      })
      expect(before.statusCode).toBe(404)

      // Grant the tenant access to the object and mark the batch verified.
      await t.pglite.query(
        `INSERT INTO "tenant_object"(tenant_id, object_id, ref_count) VALUES ($1, $2, 1)
         ON CONFLICT DO NOTHING`,
        [auth.tenant.id, objectId],
      )
      await t.pglite.query(`UPDATE "sync_batch" SET status = 'verified' WHERE id = $1`, [batchId])

      const after = await t.app.inject({
        method: 'GET',
        url: `/objects/${objectId}`,
        headers: { authorization: `Bearer ${auth.token!}` },
      })
      expect(after.statusCode).toBe(200)
      expect(after.rawPayload.equals(bytes)).toBe(true)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-008 — runtime upload responses must omit storageKey', () => {
  it('PUT /objects response body does not include storageKey on first upload or idempotent re-upload', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq008@example.com')
      const handshake = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.handshake',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          cliVersion: '0.0.0',
          device: { name: 'd', platform: 'linux' },
          store: { path: '/tmp/cq008', bundleVersion: '1' },
        } as never,
      })
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bytes = Buffer.from('cq008-bytes')
      const hash = computeHashHex(bytes, 'blake3')
      const objectId = `blake3:${hash}`
      const plan = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.planUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          deviceId,
          storePath: '/tmp/cq008',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              transportHash: hash,
              compression: 'none',
              compressedSize: bytes.byteLength,
              uncompressedSize: bytes.byteLength,
            },
          ],
        } as never,
      })
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const objectQuery = new URLSearchParams({
        batchId,
        objectId,
        hash,
        size: String(bytes.byteLength),
        uncompressed: String(bytes.byteLength),
        compression: 'none',
      })
      const first = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?${objectQuery.toString()}`,
        headers: { authorization: `Bearer ${auth.token!}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      expect(first.statusCode).toBe(201)
      const firstBody = JSON.parse(first.body) as Record<string, unknown>
      expect(firstBody).toEqual({ objectId, alreadyExisted: false })
      expect(Object.prototype.hasOwnProperty.call(firstBody, 'storageKey')).toBe(false)

      // Idempotent re-upload should still omit storageKey.
      const second = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?${objectQuery.toString()}`,
        headers: { authorization: `Bearer ${auth.token!}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      expect(second.statusCode).toBe(200)
      const secondBody = JSON.parse(second.body) as Record<string, unknown>
      expect(secondBody).toEqual({ objectId, alreadyExisted: true })
      expect(Object.prototype.hasOwnProperty.call(secondBody, 'storageKey')).toBe(false)
    } finally {
      await t.close()
    }
  })
})

describe('CQ-009 — artifact preview caps decoded bytes', () => {
  it('truncates a large raw text payload at maxBytes', async () => {
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq009@example.com')
      // Promote a session via sync, then upload a raw text object and add
      // the artifact + tenant_object + verified manifests directly.
      const handshake = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.handshake',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          cliVersion: '0.0.0',
          device: { name: 'd', platform: 'linux' },
          store: { path: '/tmp/cq009', bundleVersion: '1' },
        } as never,
      })
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
      const bytes = Buffer.from('a'.repeat(8192), 'utf8') // 8 KiB raw
      const hash = computeHashHex(bytes, 'blake3')
      const objectId = `blake3:${hash}`
      const plan = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.planUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          deviceId,
          storePath: '/tmp/cq009',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              transportHash: hash,
              compression: 'none',
              compressedSize: bytes.byteLength,
              uncompressedSize: bytes.byteLength,
            },
          ],
        } as never,
      })
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
      const objectQuery = new URLSearchParams({
        batchId,
        objectId,
        hash,
        size: String(bytes.byteLength),
        uncompressed: String(bytes.byteLength),
        compression: 'none',
      })
      const put = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?${objectQuery.toString()}`,
        headers: { authorization: `Bearer ${auth.token!}`, 'content-type': 'application/octet-stream' },
        payload: bytes,
      })
      expect(put.statusCode).toBe(201)

      // Commit a verified session + manifest entries so the artifact has
      // a verified projection AND a verified object manifest.
      const commit = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.commitUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          batchId,
          deviceId,
          storePath: '/tmp/cq009',
          objects: [
            {
              objectId,
              hash,
              hashAlgorithm: 'blake3',
              transportHash: hash,
              compression: 'none',
              compressedSize: bytes.byteLength,
              uncompressedSize: bytes.byteLength,
            },
          ],
          projection: {
            sessions: [{ id: 'sess-cq009', sourceKind: 'codex', title: 'cq009', turnCount: 1 }],
            searchDocs: [],
          },
        } as never,
      })
      expect(commit.statusCode).toBe(200)

      const verify = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.verifyPromotion',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          batchId,
          storePath: '/tmp/cq009',
          declaredObjectIds: [objectId],
          declaredSessionIds: ['sess-cq009'],
          declaredSearchDocIds: [],
        } as never,
      })
      expect(verify.statusCode).toBe(200)

      // Now insert a projection_artifact row pointing at the verified
      // object. The tenant_object row already exists from the upload path
      // (recordObjectUpload writes it), so the FK is satisfied.
      await t.pglite.query(
        `INSERT INTO "projection_artifact"(tenant_id, id, session_id, kind, object_id, size_bytes, metadata)
         VALUES ($1, 'art-cq009', 'sess-cq009', 'text/plain', $2, $3, NULL)`,
        [auth.tenant.id, objectId, bytes.byteLength],
      )

      // Request a tiny preview. The decode pipeline must stop at maxBytes.
      const maxBytes = 1024
      const resp = await t.app.inject({
        method: 'GET',
        url: `/trpc/artifacts.getText?input=${encodeURIComponent(JSON.stringify({ artifactId: 'art-cq009', maxBytes }))}`,
        headers: { authorization: `Bearer ${auth.token!}` },
      })
      expect(resp.statusCode).toBe(200)
      const data = (
        resp.json() as {
          result: { data: { bytesReturned: number; truncated: boolean; text: string; kind: string } }
        }
      ).result.data
      expect(data.truncated).toBe(true)
      expect(data.bytesReturned).toBe(maxBytes)
      expect(data.kind).toBe('text')
      expect(data.text.length).toBe(maxBytes)
    } finally {
      await t.close()
    }
  })

  it('zstd preview stops decoding before the full payload is consumed', async () => {
    const { compress: zstdCompress } = await import('zstd-napi')
    const t = await buildTestApp()
    try {
      const auth = await signup(t, 'cq009-zstd@example.com')
      const handshake = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.handshake',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          cliVersion: '0.0.0',
          device: { name: 'd', platform: 'linux' },
          store: { path: '/tmp/cq009-zstd', bundleVersion: '1' },
        } as never,
      })
      const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId

      // 64 KiB of mostly-text payload compresses heavily; the compressed
      // bytes are tiny while the decompressed payload is many multiples of
      // the maxBytes preview cap. If the decode pipeline consumed the full
      // payload before applying the cap, bytesReturned would equal the full
      // uncompressed size — the test below asserts it does not.
      const uncompressed = Buffer.from('z'.repeat(64 * 1024), 'utf8')
      const compressed = zstdCompress(uncompressed)
      const transportHash = computeHashHex(compressed, 'blake3')
      const canonicalHash = computeHashHex(uncompressed, 'blake3')
      const objectId = `blake3:${canonicalHash}`

      const plan = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.planUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          deviceId,
          storePath: '/tmp/cq009-zstd',
          objects: [
            {
              objectId,
              hash: canonicalHash,
              hashAlgorithm: 'blake3',
              transportHash,
              compression: 'zstd',
              compressedSize: compressed.byteLength,
              uncompressedSize: uncompressed.byteLength,
            },
          ],
        } as never,
      })
      const batchId = (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId

      const objectQuery = new URLSearchParams({
        batchId,
        objectId,
        hash: canonicalHash,
        transportHash,
        size: String(compressed.byteLength),
        uncompressed: String(uncompressed.byteLength),
        compression: 'zstd',
      })
      const put = await t.app.inject({
        method: 'PUT',
        url: `/objects/${objectId}?${objectQuery.toString()}`,
        headers: { authorization: `Bearer ${auth.token!}`, 'content-type': 'application/octet-stream' },
        payload: compressed,
      })
      expect(put.statusCode).toBe(201)

      const commit = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.commitUpload',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          batchId,
          deviceId,
          storePath: '/tmp/cq009-zstd',
          objects: [
            {
              objectId,
              hash: canonicalHash,
              hashAlgorithm: 'blake3',
              transportHash,
              compression: 'zstd',
              compressedSize: compressed.byteLength,
              uncompressedSize: uncompressed.byteLength,
            },
          ],
          projection: {
            sessions: [{ id: 'sess-cq009-zstd', sourceKind: 'codex', title: 'zstd cap', turnCount: 1 }],
            searchDocs: [],
          },
        } as never,
      })
      expect(commit.statusCode).toBe(200)

      const verify = await t.app.inject({
        method: 'POST',
        url: '/trpc/sync.verifyPromotion',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token!}` },
        payload: {
          batchId,
          storePath: '/tmp/cq009-zstd',
          declaredObjectIds: [objectId],
          declaredSessionIds: ['sess-cq009-zstd'],
          declaredSearchDocIds: [],
        } as never,
      })
      expect(verify.statusCode).toBe(200)

      await t.pglite.query(
        `INSERT INTO "projection_artifact"(tenant_id, id, session_id, kind, object_id, size_bytes, metadata)
         VALUES ($1, 'art-cq009-zstd', 'sess-cq009-zstd', 'text/plain', $2, $3, NULL)`,
        [auth.tenant.id, objectId, uncompressed.byteLength],
      )

      const maxBytes = 4096
      const resp = await t.app.inject({
        method: 'GET',
        url: `/trpc/artifacts.getText?input=${encodeURIComponent(
          JSON.stringify({ artifactId: 'art-cq009-zstd', maxBytes }),
        )}`,
        headers: { authorization: `Bearer ${auth.token!}` },
      })
      expect(resp.statusCode).toBe(200)
      const data = (
        resp.json() as {
          result: { data: { bytesReturned: number; truncated: boolean; text: string; kind: string } }
        }
      ).result.data
      expect(data.truncated).toBe(true)
      expect(data.bytesReturned).toBe(maxBytes)
      expect(data.text.length).toBe(maxBytes)
      // Critically: bytesReturned must be the cap, NOT the full uncompressed
      // size. If the decompressor were drained to completion before
      // capping, bytesReturned would equal uncompressed.byteLength.
      expect(data.bytesReturned).toBeLessThan(uncompressed.byteLength)
    } finally {
      await t.close()
    }
  })
})
