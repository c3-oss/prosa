// CQ-150 — command-level test for `prosa read analytics`.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { AnalyticsReportResponse } from '@c3-oss/prosa-api'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { writeCachedAuthority } from '../../src/cli/v2/authority/index.js'

const TENANT = 'tenant-an'
const STORE = 'store-an'
const SERVER = 'http://analytics.test'

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
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-read-an-cmd-'))
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

async function capture(args: string[]): Promise<{ stdout: string }> {
  const out: string[] = []
  const w = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    out.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await runCli(['node', 'prosa', ...args])
  } finally {
    process.stdout.write = w
  }
  return { stdout: out.join('') }
}

describe('prosa read analytics — command-level (CQ-150)', () => {
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

  it('strict input (no cursor/projectIds) and renders generatedAt + rows', async () => {
    const captured: { url: string; init: RequestInit }[] = []
    const response: AnalyticsReportResponse = {
      report: 'sessions',
      generatedAt: '2026-05-20T11:00:00.000Z',
      rows: [
        { day: '2026-05-19', count: 3 },
        { day: '2026-05-20', count: 5 },
      ],
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
      'analytics',
      'sessions',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--source',
      'codex',
      '--since',
      '2026-05-19T00:00:00Z',
      '--until',
      '2026-05-20T23:00:00Z',
      '--limit',
      '500',
      '--output-format',
      'json',
    ])

    expect(captured).toHaveLength(1)
    expect(captured[0]!.url).toBe(`${SERVER}/v2/reads/analytics/report`)
    const body = JSON.parse(captured[0]!.init.body as string) as Record<string, unknown>
    expect(body).toEqual({
      report: 'sessions',
      limit: 500,
      since: '2026-05-19T00:00:00Z',
      until: '2026-05-20T23:00:00Z',
      sourceTools: ['codex'],
    })
    expect((body as { cursor?: unknown }).cursor).toBeUndefined()
    expect((body as { projectIds?: unknown }).projectIds).toBeUndefined()

    const parsed = JSON.parse(out.stdout) as { rows: Array<Record<string, unknown>>; generatedAt?: string }
    expect(parsed.rows).toHaveLength(2)
    expect(parsed.generatedAt).toBe('2026-05-20T11:00:00.000Z')
  })

  it('rejects invalid report names with a clear message', async () => {
    await expect(
      capture(['read', 'analytics', 'nope', '--store', h.storePath, '--config', h.configPath]),
    ).rejects.toThrow(/invalid report/)
  })
})
