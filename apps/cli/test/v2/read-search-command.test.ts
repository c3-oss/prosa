// CQ-150 — command-level test for `prosa read search`.
//
// Verifies that the CLI command (a) sends the actual Lane 6
// `/v2/reads/search/query` input shape, (b) renders the
// representative Lane 6 response payload using the right output
// field names, and (c) rejects unsupported filters in local mode.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { SearchQueryResponse } from '@c3-oss/prosa-api'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { writeCachedAuthority } from '../../src/cli/v2/authority/index.js'

const TENANT = 'tenant-search'
const STORE = 'store-search'
const SERVER = 'http://search.test'

function receipt(receiptId: string): PromotionReceiptV2 {
  return {
    payload: {
      receiptVersion: 2,
      receiptId,
      tenantId: TENANT,
      storeId: STORE,
      bundleRoot: 'b3',
      rawSourceRoot: 'b3',
      sealedAt: '2026-05-20T00:00:00.000Z',
      epoch: 1,
      schemaVersion: 'v2',
    } as unknown as PromotionReceiptV2['payload'],
    signature: {
      algorithm: 'ed25519',
      keyId: 'k',
      signedBytes: 'AAA=',
      signature: 'AAA=',
    } as PromotionReceiptV2['signature'],
  }
}

async function setupHarness(): Promise<{ root: string; configPath: string; storePath: string; authorityDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-read-search-cmd-'))
  const configPath = path.join(root, 'config.json')
  const storePath = path.join(root, '.prosa')
  const authorityDir = path.join(root, 'authority')
  await mkdir(storePath, { recursive: true })
  await writeFile(
    configPath,
    JSON.stringify({
      activeServer: SERVER,
      servers: {
        [SERVER]: {
          url: SERVER,
          token: 'tok',
          user: { id: 'u', email: 'u@x', name: 'U' },
          promotions: {
            [path.resolve(storePath)]: {
              batchId: 'b',
              tenantId: TENANT,
              promotedAt: '2026-05-20T00:00:00.000Z',
              receipt: receipt('r-current'),
            },
          },
        },
      },
    }),
    { encoding: 'utf8', mode: 0o600 },
  )
  await writeCachedAuthority(authorityDir, {
    tenantId: TENANT,
    storeId: STORE,
    receiptId: 'r-current',
    receipt: receipt('r-current'),
    serverUrl: SERVER,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    auditStatus: 'ok',
  })
  return { root, configPath, storePath, authorityDir }
}

async function capture(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const out: string[] = []
  const err: string[] = []
  const w1 = process.stdout.write.bind(process.stdout)
  const w2 = process.stderr.write.bind(process.stderr)
  process.stdout.write = ((chunk: unknown) => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    err.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    await runCli(['node', 'prosa', ...args])
  } finally {
    process.stdout.write = w1
    process.stderr.write = w2
  }
  return { stdout: out.join(''), stderr: err.join('') }
}

describe('prosa read search — command-level (CQ-150)', () => {
  let h: { root: string; configPath: string; storePath: string; authorityDir: string }
  let originalAuthorityDir: string | undefined

  beforeEach(async () => {
    h = await setupHarness()
    originalAuthorityDir = process.env.PROSA_AUTHORITY_DIR
    process.env.PROSA_AUTHORITY_DIR = h.authorityDir
  })

  afterEach(async () => {
    if (originalAuthorityDir === undefined) process.env.PROSA_AUTHORITY_DIR = undefined
    else process.env.PROSA_AUTHORITY_DIR = originalAuthorityDir
    vi.unstubAllGlobals()
    await import('node:fs/promises').then((m) => m.rm(h.root, { recursive: true, force: true }))
  })

  it('sends Lane 6 plural-array filters and renders the response with actual field names', async () => {
    const captured: { url: string; init: RequestInit }[] = []
    const response: SearchQueryResponse = {
      rows: [
        {
          docId: 'doc-1',
          entityType: 'message',
          entityId: 'm1',
          sessionId: 'sess-1',
          projectId: 'p1',
          timestamp: '2026-05-20T10:00:00.000Z',
          role: 'user',
          toolName: 'shell',
          canonicalToolType: 'shell.run',
          fieldKind: 'text',
          errorsOnly: false,
          snippet: 'hit needle ',
          rank: 0.5,
          storeId: STORE,
          receiptId: 'r-current',
        },
      ],
      nextCursor: null,
    }
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        captured.push({ url: String(input), init: init ?? {} })
        return new Response(JSON.stringify(response), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }) as unknown as Response
      }),
    )

    const out = await capture([
      'read',
      'search',
      'needle',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--role',
      'user',
      '--tool-name',
      'shell',
      '--canonical-tool-type',
      'shell.run',
      '--entity-type',
      'message',
      '--errors-only',
      '--session',
      'sess-1',
      '--since',
      '2026-05-19T00:00:00Z',
      '--until',
      '2026-05-20T23:00:00Z',
      '--limit',
      '50',
      '--output-format',
      'json',
    ])

    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`${SERVER}/v2/reads/search/query`)
    const body = JSON.parse(captured[0]!.init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      q: 'needle',
      limit: 50,
      roles: ['user'],
      toolNames: ['shell'],
      canonicalToolTypes: ['shell.run'],
      entityTypes: ['message'],
      errorsOnly: true,
      sessionId: 'sess-1',
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T23:00:00Z',
    })

    const parsed = JSON.parse(out.stdout) as { rows: Array<Record<string, unknown>>; source: string }
    expect(parsed.source).toBe('remote')
    expect(parsed.rows).toHaveLength(1)
    const row = parsed.rows[0]!
    expect(row.session_id).toBe('sess-1')
    expect(row.tool_name).toBe('shell')
    expect(row.canonical_tool_type).toBe('shell.run')
    expect(row.entity_type).toBe('message')
    expect(row.errors_only).toBe(false)
    expect(row.snippet).toBe('hit needle ')
    expect(row.rank).toBe(0.5)
    expect(row.store_id).toBe(STORE)
    expect(row.receipt_id).toBe('r-current')
  })

  it('rejects server-only filters in --authority local', async () => {
    await expect(
      capture([
        'read',
        'search',
        'q',
        '--store',
        h.storePath,
        '--config',
        h.configPath,
        '--authority',
        'local',
        '--role',
        'user',
      ]),
    ).rejects.toThrow(/local mode does not support/)
  })
})
