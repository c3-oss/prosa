import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
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
