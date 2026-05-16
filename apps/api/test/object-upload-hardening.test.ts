import {
  MemoryObjectStore,
  type ObjectMeta,
  PUT_PREVERIFIED_BYTES,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  computeHashHex,
} from '@c3-oss/prosa-storage'
import Fastify from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compress as zstdCompress } from 'zstd-napi'
import type { ProsaAuth } from '../src/auth.js'
import type { RawExec } from '../src/db.js'
import { registerObjectRoutes } from '../src/http/objects.js'
import { _resetBatchManifestCache } from '../src/objects/manifest-cache.js'
import { type TestApp, buildTestApp } from './helpers/test-app.js'

type Signup = {
  token: string
  tenant: { id: string }
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
      tenantName: 'Objects',
      tenantSlug: `objects-${crypto.randomUUID()}`,
    },
  })
  expect(response.statusCode).toBe(200)
  return (response.json() as { result: { data: Signup } }).result.data
}

function objectUrl(opts: {
  batchId?: string
  objectId: string
  hash: string
  size: number
  uncompressed: number
  compression?: 'zstd' | 'none'
  transportHash?: string
}) {
  const url = new URL(`/objects/${opts.objectId}`, 'http://localhost')
  if (opts.batchId) url.searchParams.set('batchId', opts.batchId)
  url.searchParams.set('hash', opts.hash)
  url.searchParams.set('size', String(opts.size))
  url.searchParams.set('uncompressed', String(opts.uncompressed))
  url.searchParams.set('compression', opts.compression ?? 'none')
  if (opts.transportHash) url.searchParams.set('transportHash', opts.transportHash)
  return `${url.pathname}${url.search}`
}

async function planObjectUpload(
  t: TestApp,
  auth: Signup,
  object: {
    objectId: string
    hash: string
    compressedSize: number
    uncompressedSize: number
    compression: 'zstd' | 'none'
    transportHash?: string
  },
): Promise<string> {
  const storePath = `/tmp/${crypto.randomUUID()}`
  const handshake = await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.handshake',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: {
      cliVersion: '0.0.0',
      protocolVersion: 1,
      device: { name: `object-test-${crypto.randomUUID()}`, platform: 'test' },
      store: { path: storePath, bundleVersion: '1' },
    },
  })
  expect(handshake.statusCode).toBe(200)
  const deviceId = (handshake.json() as { result: { data: { deviceId: string } } }).result.data.deviceId
  const plan = await t.app.inject({
    method: 'POST',
    url: '/trpc/sync.planUpload',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.token}` },
    payload: {
      deviceId,
      storePath,
      objects: [{ ...object, hashAlgorithm: 'blake3' }],
    },
  })
  expect(plan.statusCode).toBe(200)
  return (plan.json() as { result: { data: { batchId: string } } }).result.data.batchId
}

class PreverifiedOnlyStore implements RemoteObjectStore {
  called = false

  async head(_key: string): Promise<ObjectMeta | null> {
    return null
  }

  async putIfAbsent(): Promise<PutResult> {
    throw new Error('route should use the preverified storage path')
  }

  async [PUT_PREVERIFIED_BYTES](key: string, _bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    this.called = true
    return { meta: { ...meta, storageKey: key }, alreadyExisted: false }
  }

  async get(_key: string): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not used')
  }

  async getRange(_key: string, _offset: number, _length: number): Promise<ReadableStream<Uint8Array>> {
    throw new Error('not used')
  }

  async delete(_key: string): Promise<void> {}
}

describe('object upload hardening', () => {
  let t: TestApp | null = null

  beforeEach(() => {
    _resetBatchManifestCache()
  })

  afterEach(async () => {
    await t?.close()
    t = null
  })

  it('enforces an explicit object route body limit before the handler stores bytes', async () => {
    const app = Fastify({ logger: false })
    await registerObjectRoutes(app, {
      auth: { api: { getSession: async () => null } } as unknown as ProsaAuth,
      rawExec: (async () => []) as RawExec,
      objectStore: new MemoryObjectStore(),
      maxObjectBytes: 4,
    })

    const response = await app.inject({
      method: 'PUT',
      url: '/objects/blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      headers: { 'content-type': 'application/octet-stream' },
      payload: Buffer.alloc(5),
    })

    expect(response.statusCode).toBe(413)
    await app.close()
  })

  it('rejects declared compressed sizes over the route maxObjectBytes limit', async () => {
    const app = Fastify({ logger: false })
    await registerObjectRoutes(app, {
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session-1', userId: 'user-1', activeOrganizationId: 'tenant-1' },
            user: { id: 'user-1', email: 'user@example.com' },
          }),
        },
      } as unknown as ProsaAuth,
      rawExec: (async () => [{ role: 'member' }]) as RawExec,
      objectStore: new MemoryObjectStore(),
      maxObjectBytes: 4,
    })
    const bytes = Buffer.alloc(0)
    const hash = computeHashHex(bytes, 'blake3')

    const response = await app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId: 'batch-too-large',
        objectId: `blake3:${hash}`,
        hash,
        size: 5,
        uncompressed: 0,
        compression: 'none',
      }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('size exceeds maxObjectBytes')
    await app.close()
  })

  it('accepts zero-byte uncompressed objects consistently with the protocol schema', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'zero-byte@example.com')
    const bytes = Buffer.alloc(0)
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const batchId = await planObjectUpload(t, auth, {
      objectId,
      hash,
      compressedSize: 0,
      uncompressedSize: 0,
      compression: 'none',
    })

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({ batchId, objectId, hash, size: 0, uncompressed: 0, compression: 'none' }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    })

    expect(response.statusCode).toBe(201)
    const rows = await t.pglite.query<{ uncompressed_size: string | number; compressed_size: string | number }>(
      'SELECT uncompressed_size, compressed_size FROM "remote_object" WHERE object_id = $1 LIMIT 1',
      [objectId],
    )
    expect(Number(rows.rows[0]?.uncompressed_size)).toBe(0)
    expect(Number(rows.rows[0]?.compressed_size)).toBe(0)
  })

  it('rejects authenticated object uploads that are not tied to an open sync batch', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'orphan-object@example.com')
    const bytes = Buffer.from('orphan upload')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('batchId query parameter required')
  })

  it('stores transport hash metadata separately from the canonical route validation for zstd bodies', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'zstd-object@example.com')
    const plain = Buffer.from('canonical payload that compresses over the wire')
    const compressed = zstdCompress(plain)
    const canonicalHash = computeHashHex(plain, 'blake3')
    const transportHash = computeHashHex(compressed, 'blake3')
    const objectId = `blake3:${canonicalHash}`
    const batchId = await planObjectUpload(t, auth, {
      objectId,
      hash: canonicalHash,
      compressedSize: compressed.byteLength,
      uncompressedSize: plain.byteLength,
      compression: 'zstd',
      transportHash,
    })

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId,
        hash: canonicalHash,
        size: compressed.byteLength,
        uncompressed: plain.byteLength,
        compression: 'zstd',
        transportHash,
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: compressed,
    })

    expect(response.statusCode).toBe(201)
    const key = `objects/blake3/${canonicalHash.slice(0, 2)}/${canonicalHash.slice(2, 4)}/${canonicalHash}.zst`
    await expect(t.objectStore.head(key)).resolves.toMatchObject({
      hash: transportHash,
      compressedSize: compressed.byteLength,
      uncompressedSize: plain.byteLength,
    })
    const rows = await t.pglite.query<{ hash: string; compression: string }>(
      'SELECT hash, compression FROM "remote_object" WHERE object_id = $1 LIMIT 1',
      [objectId],
    )
    expect(rows.rows[0]).toMatchObject({ hash: canonicalHash, compression: 'zstd' })
  })

  it('uses the preverified storage path after route-level byte validation succeeds', async () => {
    const app = Fastify({ logger: false })
    const objectStore = new PreverifiedOnlyStore()
    const bytes = Buffer.from('preverified upload')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const rawExec: RawExec = (async (sql: string, _params?: unknown[]) => {
      if (/from\s+"?member"?/i.test(sql)) return [{ role: 'member' }]
      if (/sync_batch_object_manifest/i.test(sql)) {
        return [
          {
            object_id: objectId,
            canonical_hash: hash,
            transport_hash: hash,
            compression: 'none',
            uncompressed_size: bytes.byteLength,
            compressed_size: bytes.byteLength,
          },
        ]
      }
      if (/^\s*select[\s\S]+from\s+"remote_object"/i.test(sql)) return []
      return []
    }) as RawExec

    await registerObjectRoutes(app, {
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session-1', userId: 'user-1', activeOrganizationId: 'tenant-1' },
            user: { id: 'user-1', email: 'user@example.com' },
          }),
        },
      } as unknown as ProsaAuth,
      rawExec,
      objectStore,
    })

    const response = await app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId: 'batch-preverified',
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })

    expect(response.statusCode).toBe(201)
    expect(objectStore.called).toBe(true)
    await app.close()
  })

  it('serves object bytes with catalog metadata headers without route-level buffering', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'get-object@example.com')
    const bytes = Buffer.from('streamed response body')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const batchId = await planObjectUpload(t, auth, {
      objectId,
      hash,
      compressedSize: bytes.byteLength,
      uncompressedSize: bytes.byteLength,
      compression: 'none',
    })

    const put = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    })
    expect(put.statusCode).toBe(201)
    await t.pglite.query(
      `INSERT INTO "tenant_object"(tenant_id, object_id, ref_count)
       VALUES ($1, $2, 1)`,
      [auth.tenant.id, objectId],
    )
    // CQ-003: GET /objects/:objectId now requires a verified batch entry
    // for this object. Mark the batch verified so the read is authorised.
    await t.pglite.query(`UPDATE "sync_batch" SET status = 'verified' WHERE id = $1`, [batchId])

    const get = await t.app.inject({
      method: 'GET',
      url: `/objects/${objectId}`,
      headers: { authorization: `Bearer ${auth.token}` },
    })

    expect(get.statusCode).toBe(200)
    expect(get.rawPayload).toEqual(bytes)
    expect(get.headers['content-length']).toBe(String(bytes.byteLength))
    expect(get.headers['cache-control']).toBe('no-store')
    expect(get.headers['x-prosa-canonical-hash']).toBe(hash)
    expect(get.headers['x-prosa-compression']).toBe('none')
    expect(get.headers['x-prosa-uncompressed-size']).toBe(String(bytes.byteLength))
  })

  it('rejects conflicting catalog metadata before writing object bytes', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'catalog-conflict@example.com')
    const bytes = Buffer.from('catalog conflict')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const batchId = await planObjectUpload(t, auth, {
      objectId,
      hash,
      compressedSize: bytes.byteLength,
      uncompressedSize: bytes.byteLength,
      compression: 'none',
    })
    await t.pglite.query(
      `INSERT INTO "remote_object"(
         object_id, hash, hash_algorithm, compression, uncompressed_size, compressed_size, storage_key
       )
       VALUES ($1, $2, 'blake3', 'zstd', $3, $4, $5)`,
      [
        objectId,
        hash,
        bytes.byteLength,
        bytes.byteLength,
        `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.zst`,
      ],
    )

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('conflicting remote object metadata')
    expect(t.objectStore.size()).toBe(0)
  })

  it('removes freshly uploaded bytes when a concurrent catalog insert wins incompatibly', async () => {
    const app = Fastify({ logger: false })
    const objectStore = new MemoryObjectStore()
    const bytes = Buffer.from('catalog race loser')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const storageKey = `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.bin`
    let remoteObjectSelects = 0
    const rawExec: RawExec = (async (sql: string, _params?: unknown[]) => {
      if (/from\s+"?member"?/i.test(sql)) return [{ role: 'member' }]
      if (/sync_batch_object_manifest/i.test(sql)) {
        return [
          {
            object_id: objectId,
            canonical_hash: hash,
            transport_hash: hash,
            compression: 'none',
            uncompressed_size: bytes.byteLength,
            compressed_size: bytes.byteLength,
          },
        ]
      }
      if (/^\s*select[\s\S]+from\s+"remote_object"/i.test(sql)) {
        remoteObjectSelects += 1
        if (remoteObjectSelects === 1) return []
        return [
          {
            hash,
            hash_algorithm: 'blake3',
            compression: 'zstd',
            uncompressed_size: bytes.byteLength,
            compressed_size: bytes.byteLength,
            storage_key: storageKey.replace(/\.bin$/, '.zst'),
          },
        ]
      }
      return []
    }) as RawExec

    await registerObjectRoutes(app, {
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session-1', userId: 'user-1', activeOrganizationId: 'tenant-1' },
            user: { id: 'user-1', email: 'user@example.com' },
          }),
        },
      } as unknown as ProsaAuth,
      rawExec,
      objectStore,
    })

    const response = await app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId: 'batch-catalog-race',
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })

    expect(response.statusCode).toBe(409)
    expect(response.body).toContain('conflicting remote object metadata')
    expect(objectStore.size()).toBe(0)
    expect(await objectStore.head(storageKey)).toBeNull()
    await app.close()
  })

  it('rejects transport hash mismatches before storing bytes', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'transport-mismatch@example.com')
    const bytes = Buffer.from('transport mismatch')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const batchId = await planObjectUpload(t, auth, {
      objectId,
      hash,
      compressedSize: bytes.byteLength,
      uncompressedSize: bytes.byteLength,
      compression: 'none',
      transportHash: '0'.repeat(64),
    })

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
        transportHash: '0'.repeat(64),
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: bytes,
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('transport hash mismatch')
  })

  it('rejects canonical hash mismatches after bounded zstd decompression', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'canonical-mismatch@example.com')
    const plain = Buffer.from('real canonical content')
    const compressed = zstdCompress(plain)
    const declaredHash = computeHashHex(Buffer.from('different canonical content'), 'blake3')
    const transportHash = computeHashHex(compressed, 'blake3')
    const batchId = await planObjectUpload(t, auth, {
      objectId: `blake3:${declaredHash}`,
      hash: declaredHash,
      compressedSize: compressed.byteLength,
      uncompressedSize: plain.byteLength,
      compression: 'zstd',
      transportHash,
    })

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId: `blake3:${declaredHash}`,
        hash: declaredHash,
        size: compressed.byteLength,
        uncompressed: plain.byteLength,
        compression: 'zstd',
        transportHash,
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: compressed,
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('canonical hash mismatch')
  })

  it('removes freshly uploaded bytes when the catalog insert fails after putIfAbsent', async () => {
    const app = Fastify({ logger: false })
    const objectStore = new MemoryObjectStore()
    const bytes = Buffer.from('catalog-insert-fails')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    const storageKey = `objects/blake3/${hash.slice(0, 2)}/${hash.slice(2, 4)}/${hash}.bin`

    const rawExec: RawExec = (async (sql: string, _params?: unknown[]) => {
      if (/from\s+"?member"?/i.test(sql)) return [{ role: 'member' }]
      if (/sync_batch_object_manifest/i.test(sql)) {
        return [
          {
            object_id: objectId,
            canonical_hash: hash,
            transport_hash: hash,
            compression: 'none',
            uncompressed_size: bytes.byteLength,
            compressed_size: bytes.byteLength,
          },
        ]
      }
      if (/^\s*select[\s\S]+from\s+"remote_object"/i.test(sql)) return []
      if (/^\s*insert\s+into\s+"remote_object"/i.test(sql)) {
        throw new Error('simulated catalog write failure')
      }
      return []
    }) as RawExec

    await registerObjectRoutes(app, {
      auth: {
        api: {
          getSession: async () => ({
            session: { id: 'session-1', userId: 'user-1', activeOrganizationId: 'tenant-1' },
            user: { id: 'user-1', email: 'user@example.com' },
          }),
        },
      } as unknown as ProsaAuth,
      rawExec,
      objectStore,
    })

    const response = await app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId: 'batch-1',
        objectId,
        hash,
        size: bytes.byteLength,
        uncompressed: bytes.byteLength,
        compression: 'none',
      }),
      headers: { 'content-type': 'application/octet-stream' },
      payload: bytes,
    })

    expect(response.statusCode).toBe(500)
    expect(objectStore.size()).toBe(0)
    expect(await objectStore.head(storageKey)).toBeNull()
    await app.close()
  })

  it('rejects zstd bodies that decompress beyond the declared uncompressed size', async () => {
    t = await buildTestApp()
    const auth = await signup(t, 'decompression-limit@example.com')
    const plain = Buffer.from('declared-size-overrun')
    const compressed = zstdCompress(plain)
    const hash = computeHashHex(plain, 'blake3')
    const transportHash = computeHashHex(compressed, 'blake3')
    const batchId = await planObjectUpload(t, auth, {
      objectId: `blake3:${hash}`,
      hash,
      compressedSize: compressed.byteLength,
      uncompressedSize: plain.byteLength - 1,
      compression: 'zstd',
      transportHash,
    })

    const response = await t.app.inject({
      method: 'PUT',
      url: objectUrl({
        batchId,
        objectId: `blake3:${hash}`,
        hash,
        size: compressed.byteLength,
        uncompressed: plain.byteLength - 1,
        compression: 'zstd',
        transportHash,
      }),
      headers: {
        authorization: `Bearer ${auth.token}`,
        'content-type': 'application/octet-stream',
      },
      payload: compressed,
    })

    expect(response.statusCode).toBe(400)
    expect(response.body).toContain('unable to decompress object body')
  })

  it('serves manifest from cache on second PUT and misses after invalidate', async () => {
    const { loadBatchManifest, invalidateBatchManifest } = await import('../src/objects/manifest-cache.js')
    const bytes = Buffer.from('cache-test-object')
    const hash = computeHashHex(bytes, 'blake3')
    const objectId = `blake3:${hash}`
    let queryCount = 0
    const rawExec: RawExec = (async (sql: string, _params?: unknown[]) => {
      if (/sync_batch_object_manifest/i.test(sql)) {
        queryCount += 1
        return [
          {
            object_id: objectId,
            canonical_hash: hash,
            transport_hash: hash,
            compression: 'none',
            uncompressed_size: bytes.byteLength,
            compressed_size: bytes.byteLength,
          },
        ]
      }
      return []
    }) as RawExec

    const opts = { rawExec, tenantId: 'tenant-cache', batchId: 'batch-cache', userId: 'user-cache' }

    // First call: cache miss — hits Postgres
    const m1 = await loadBatchManifest(opts)
    expect(queryCount).toBe(1)
    expect(m1.has(objectId)).toBe(true)

    // Second call: cache hit — no additional query
    const m2 = await loadBatchManifest(opts)
    expect(queryCount).toBe(1)
    expect(m2).toBe(m1)

    // After invalidate: cache miss — hits Postgres again
    invalidateBatchManifest(opts)
    const m3 = await loadBatchManifest(opts)
    expect(queryCount).toBe(2)
    expect(m3.has(objectId)).toBe(true)
  })
})
