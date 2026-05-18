import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { OBJECT_PACK_BINARY_CONTENT_TYPE, decodeBinaryObjectPack } from '@c3-oss/prosa-sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProsaApiClient } from '../../src/cli/auth/client.js'
import {
  defaultConfigPath,
  loadCliConfig,
  recordPromotion,
  saveCliConfig,
  upsertServer,
} from '../../src/cli/auth/config.js'

describe('cli auth/config helpers', () => {
  let tmp: string
  let configPath: string

  beforeEach(async () => {
    tmp = await mkdtemp(path.join(tmpdir(), 'prosa-cli-config-'))
    configPath = path.join(tmp, 'config.json')
  })

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true })
  })

  it('round-trips through save/load', async () => {
    let config = await loadCliConfig(configPath)
    expect(config.servers).toEqual({})
    config = upsertServer(config, { url: 'http://localhost', token: 'abc', user: { id: 'u1', email: 'a@b.c' } }, true)
    await saveCliConfig(config, configPath)
    const reloaded = await loadCliConfig(configPath)
    expect(reloaded.activeServer).toBe('http://localhost')
    expect(reloaded.servers['http://localhost']?.token).toBe('abc')
  })

  it('records promotion receipts keyed by store path', async () => {
    let config = await loadCliConfig(configPath)
    config = upsertServer(config, { url: 'http://localhost', token: 'abc' }, true)
    const entry = recordPromotion(config.servers['http://localhost']!, '/tmp/.prosa', {
      batchId: 'b1',
      tenantId: 't1',
      promotedAt: new Date().toISOString(),
      receipt: { sessionCount: 3 },
    })
    config.servers['http://localhost'] = entry
    await saveCliConfig(config, configPath)
    const reloaded = await loadCliConfig(configPath)
    expect(reloaded.servers['http://localhost']?.promotions?.['/tmp/.prosa']?.batchId).toBe('b1')
  })
})

describe('ProsaApiClient request shaping', () => {
  it('attaches bearer + tenant headers and sends JSON payloads', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = []
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init })
      return new Response(JSON.stringify({ result: { data: { ok: true } } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example/',
      token: 'xyz',
      tenantId: 't-123',
      fetch: fakeFetch as typeof fetch,
    })
    await client.syncHandshake({
      cliVersion: '0.0.0',
      protocolVersion: 1,
      device: { name: 'box' },
      store: { path: '/tmp', bundleVersion: '1' },
    })
    expect(captured).toHaveLength(1)
    const recorded = captured[0]!
    expect(recorded.url).toBe('http://example/trpc/sync.handshake')
    const headers = recorded.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xyz')
    expect(headers['x-prosa-tenant-id']).toBe('t-123')
    expect(headers['content-type']).toBe('application/json')
  })

  it('throws CliUserError when the server returns a tRPC error', async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ error: { message: 'forbidden' } }), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      })
    const client = new ProsaApiClient({ baseUrl: 'http://example', fetch: fakeFetch as typeof fetch })
    await expect(client.listTenants()).rejects.toThrow(/forbidden/)
  })

  it('sends Idempotency-Key for sync.commitUpload when provided', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = []
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ result: { data: { batchId: 'batch-1', committedObjects: 0, committedRows: 0 } } }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example',
      token: 'xyz',
      tenantId: 't-123',
      fetch: fakeFetch as typeof fetch,
    })

    await client.syncCommitUpload(
      {
        batchId: 'batch-1',
        deviceId: 'device-1',
        storePath: '/tmp/prosa',
        objects: [],
        projection: {},
      },
      { idempotencyKey: 'sync.commitUpload:batch-1' },
    )

    expect(captured).toHaveLength(1)
    const headers = captured[0]?.init?.headers as Record<string, string>
    expect(headers['idempotency-key']).toBe('sync.commitUpload:batch-1')
    expect(headers.authorization).toBe('Bearer xyz')
    expect(headers['x-prosa-tenant-id']).toBe('t-123')
  })

  it('posts binary packed object bytes with ranges and auth headers', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = []
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init })
      return new Response(
        JSON.stringify({ blobId: 'object-pack:t:batch:hash', objectIds: ['blake3:a'], alreadyExisted: false }),
        {
          status: 201,
          headers: { 'content-type': 'application/json' },
        },
      )
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example/',
      token: 'xyz',
      tenantId: 't-123',
      fetch: fakeFetch as typeof fetch,
    })

    await client.uploadObjectPack({
      batchId: 'batch-1',
      objects: [
        {
          objectId: `blake3:${'a'.repeat(64)}`,
          hash: 'a'.repeat(64),
          hashAlgorithm: 'blake3',
          compression: 'none',
          compressedSize: 2,
          uncompressedSize: 2,
          transportHash: 'a'.repeat(64),
          contentType: 'text/plain',
          bytes: new Uint8Array([1, 2]),
        },
        {
          objectId: `blake3:${'b'.repeat(64)}`,
          hash: 'b'.repeat(64),
          hashAlgorithm: 'blake3',
          compression: 'none',
          compressedSize: 3,
          uncompressedSize: 3,
          transportHash: 'b'.repeat(64),
          bytes: new Uint8Array([3, 4, 5]),
        },
      ],
    })

    expect(captured).toHaveLength(1)
    const recorded = captured[0]!
    expect(recorded.url).toBe('http://example/object-packs?batchId=batch-1')
    const headers = recorded.init?.headers as Record<string, string>
    expect(headers.authorization).toBe('Bearer xyz')
    expect(headers['x-prosa-tenant-id']).toBe('t-123')
    expect(headers['content-type']).toBe(OBJECT_PACK_BINARY_CONTENT_TYPE)

    const body = decodeBinaryObjectPack(recorded.init?.body as Uint8Array)
    expect(Buffer.from(body.payload)).toEqual(Buffer.from([1, 2, 3, 4, 5]))
    expect(body.entries).toMatchObject([
      { objectId: `blake3:${'a'.repeat(64)}`, offset: 0, length: 2, contentType: 'text/plain' },
      { objectId: `blake3:${'b'.repeat(64)}`, offset: 2, length: 3 },
    ])
  })

  it('falls back to JSON/base64 object packs when binary media type is unsupported', async () => {
    const captured: Array<{ url: string; init: RequestInit | undefined }> = []
    const retryEvents: string[] = []
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(url), init })
      if (captured.length === 1) {
        return new Response('unsupported media type', { status: 415 })
      }
      return new Response(
        JSON.stringify({ blobId: 'object-pack:t:batch:hash', objectIds: ['blake3:a'], alreadyExisted: false }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example/',
      token: 'xyz',
      tenantId: 't-123',
      fetch: fakeFetch as typeof fetch,
      onRetry: (event) => retryEvents.push(event.operation),
    })
    const hash = 'a'.repeat(64)

    await client.uploadObjectPack({
      batchId: 'batch-1',
      objects: [
        {
          objectId: `blake3:${hash}`,
          hash,
          hashAlgorithm: 'blake3',
          compression: 'none',
          compressedSize: 3,
          uncompressedSize: 3,
          transportHash: hash,
          bytes: new Uint8Array([1, 2, 3]),
        },
      ],
    })

    expect(captured).toHaveLength(2)
    expect((captured[0]?.init?.headers as Record<string, string>)['content-type']).toBe(OBJECT_PACK_BINARY_CONTENT_TYPE)
    expect((captured[1]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json')
    const fallback = JSON.parse(String(captured[1]?.init?.body)) as {
      bytesBase64: string
      entries: Array<{ objectId: string; offset: number; length: number }>
    }
    expect(Buffer.from(fallback.bytesBase64, 'base64')).toEqual(Buffer.from([1, 2, 3]))
    expect(fallback.entries).toMatchObject([{ objectId: `blake3:${hash}`, offset: 0, length: 3 }])
    expect(retryEvents).toEqual([])
  })

  it('retries object pack uploads on retryable network errors', async () => {
    let calls = 0
    const retryEvents: string[] = []
    const fakeFetch = async () => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return new Response(
        JSON.stringify({ blobId: 'object-pack:t:batch:hash', objectIds: ['blake3:a'], alreadyExisted: false }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example/',
      fetch: fakeFetch as typeof fetch,
      onRetry: (event) => retryEvents.push(event.operation),
    })
    const hash = 'a'.repeat(64)

    await expect(
      client.uploadObjectPack({
        batchId: 'batch-1',
        objects: [
          {
            objectId: `blake3:${hash}`,
            hash,
            hashAlgorithm: 'blake3',
            compression: 'none',
            compressedSize: 3,
            uncompressedSize: 3,
            transportHash: hash,
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    ).resolves.toMatchObject({ alreadyExisted: false })
    expect(calls).toBe(2)
    expect(retryEvents).toEqual(['object pack binary upload'])
  })

  it('retries object pack uploads on retryable HTTP status using Retry-After', async () => {
    const statuses: number[] = []
    const fakeFetch = async () => {
      if (statuses.length === 0) {
        statuses.push(503)
        return new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
      }
      statuses.push(201)
      return new Response(
        JSON.stringify({ blobId: 'object-pack:t:batch:hash', objectIds: ['blake3:a'], alreadyExisted: false }),
        { status: 201, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new ProsaApiClient({ baseUrl: 'http://example/', fetch: fakeFetch as typeof fetch })
    const hash = 'a'.repeat(64)

    await expect(
      client.uploadObjectPack({
        batchId: 'batch-1',
        objects: [
          {
            objectId: `blake3:${hash}`,
            hash,
            hashAlgorithm: 'blake3',
            compression: 'none',
            compressedSize: 3,
            uncompressedSize: 3,
            transportHash: hash,
            bytes: new Uint8Array([1, 2, 3]),
          },
        ],
      }),
    ).resolves.toMatchObject({ alreadyExisted: false })
    expect(statuses).toEqual([503, 201])
  })

  it('retries sync.commitUpload with the same Idempotency-Key', async () => {
    const capturedHeaders: Record<string, string>[] = []
    const fakeFetch = async (_url: string | URL | Request, init?: RequestInit) => {
      capturedHeaders.push(init?.headers as Record<string, string>)
      if (capturedHeaders.length === 1) throw new TypeError('fetch failed')
      return new Response(
        JSON.stringify({ result: { data: { batchId: 'batch-1', committedObjects: 0, committedRows: 0 } } }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new ProsaApiClient({
      baseUrl: 'http://example',
      token: 'xyz',
      tenantId: 't-123',
      fetch: fakeFetch as typeof fetch,
    })

    await client.syncCommitUpload(
      {
        batchId: 'batch-1',
        deviceId: 'device-1',
        storePath: '/tmp/prosa',
        objects: [],
        projection: {},
      },
      { idempotencyKey: 'sync.commitUpload:batch-1' },
    )

    expect(capturedHeaders).toHaveLength(2)
    expect(capturedHeaders.map((headers) => headers['idempotency-key'])).toEqual([
      'sync.commitUpload:batch-1',
      'sync.commitUpload:batch-1',
    ])
  })

  it('does not retry structured tRPC application errors from sync.commitUpload', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls += 1
      return new Response(
        JSON.stringify({
          error: {
            message: 'Batch is not open for commit',
            data: { code: 'PRECONDITION_FAILED' },
          },
        }),
        { status: 500, headers: { 'content-type': 'application/json' } },
      )
    }
    const client = new ProsaApiClient({ baseUrl: 'http://example', fetch: fakeFetch as typeof fetch })

    await expect(
      client.syncCommitUpload(
        {
          batchId: 'batch-1',
          deviceId: 'device-1',
          storePath: '/tmp/prosa',
          objects: [],
          projection: {},
        },
        { idempotencyKey: 'sync.commitUpload:batch-1' },
      ),
    ).rejects.toThrow(/Batch is not open for commit/)
    expect(calls).toBe(1)
  })

  it('retries object PUTs on retryable HTTP status using Retry-After', async () => {
    const calls: string[] = []
    const fakeFetch = async (url: string | URL | Request) => {
      calls.push(String(url))
      if (calls.length === 1) {
        return new Response('busy', { status: 503, headers: { 'retry-after': '0' } })
      }
      return new Response(JSON.stringify({ alreadyExisted: false }), { status: 201 })
    }
    const client = new ProsaApiClient({ baseUrl: 'http://example', fetch: fakeFetch as typeof fetch })

    const hash = 'a'.repeat(64)
    await expect(
      client.uploadObjectBytes({
        batchId: 'batch-1',
        objectId: `blake3:${hash}`,
        hash,
        compression: 'none',
        compressedSize: 3,
        uncompressedSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({ alreadyExisted: false })
    expect(calls).toHaveLength(2)
  })

  it('retries object PUTs on retryable network errors', async () => {
    let calls = 0
    const fakeFetch = async () => {
      calls += 1
      if (calls === 1) {
        const err = new Error('socket closed') as Error & { code: string }
        err.code = 'ECONNRESET'
        throw err
      }
      return new Response(JSON.stringify({ alreadyExisted: true }), { status: 200 })
    }
    const client = new ProsaApiClient({ baseUrl: 'http://example', fetch: fakeFetch as typeof fetch })

    const hash = 'c'.repeat(64)
    await expect(
      client.uploadObjectBytes({
        batchId: 'batch-1',
        objectId: `blake3:${hash}`,
        hash,
        compression: 'none',
        compressedSize: 3,
        uncompressedSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).resolves.toEqual({ alreadyExisted: true })
    expect(calls).toBe(2)
  })

  it('does not retry object PUT protocol conflicts', async () => {
    const calls: string[] = []
    const fakeFetch = async (url: string | URL | Request) => {
      calls.push(String(url))
      return new Response('conflict', { status: 409 })
    }
    const client = new ProsaApiClient({ baseUrl: 'http://example', fetch: fakeFetch as typeof fetch })

    const hash = 'b'.repeat(64)
    await expect(
      client.uploadObjectBytes({
        batchId: 'batch-1',
        objectId: `blake3:${hash}`,
        hash,
        compression: 'none',
        compressedSize: 3,
        uncompressedSize: 3,
        bytes: new Uint8Array([1, 2, 3]),
      }),
    ).rejects.toThrow(/409 conflict/)
    expect(calls).toHaveLength(1)
  })
})

describe('defaultConfigPath', () => {
  it('honors PROSA_CONFIG_PATH', () => {
    const old = process.env.PROSA_CONFIG_PATH
    process.env.PROSA_CONFIG_PATH = '/custom/path/config.json'
    try {
      expect(defaultConfigPath()).toBe('/custom/path/config.json')
    } finally {
      process.env.PROSA_CONFIG_PATH = old
    }
  })
})

describe('config files', () => {
  it('writes with 0600 perms', async () => {
    const tmp = await mkdtemp(path.join(tmpdir(), 'prosa-perms-'))
    const configPath = path.join(tmp, 'config.json')
    try {
      await saveCliConfig({ servers: { 'http://x': { url: 'http://x', token: 'tok' } } }, configPath)
      const stats = await import('node:fs/promises').then((m) => m.stat(configPath))
      // Mode last 9 bits should reflect 0o600 (owner read/write only).
      expect(stats.mode & 0o777).toBe(0o600)
      const text = await readFile(configPath, 'utf8')
      expect(JSON.parse(text)).toMatchObject({ servers: { 'http://x': { token: 'tok' } } })
    } finally {
      await rm(tmp, { recursive: true, force: true })
    }
  })
})
