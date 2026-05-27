// CQ-150 — command-level test for `prosa read tool-calls`.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ToolCallsListResponse } from '@c3-oss/prosa-api'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { writeCachedAuthority } from '../../src/cli/v2/authority/index.js'

const TENANT = 'tenant-tc'
const STORE = 'store-tc'
const SERVER = 'http://tool-calls.test'

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
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-read-tc-cmd-'))
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
  return { stdout: out.join(''), stderr: '' }
}

describe('prosa read tool-calls — command-level (CQ-150)', () => {
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

  it('sends sessionId singular + toolNames[] + canonicalToolTypes[] and renders latestResult/timestampStart', async () => {
    const captured: { url: string; init: RequestInit }[] = []
    const response: ToolCallsListResponse = {
      rows: [
        {
          toolCallId: 'tc-1',
          sessionId: 'sess-1',
          turnId: 't1',
          toolName: 'shell',
          canonicalToolType: 'shell.run',
          status: 'completed',
          timestampStart: '2026-05-20T10:00:01.000Z',
          storeId: STORE,
          receiptId: 'r-current',
          latestResult: {
            toolResultId: 'tr-1',
            status: 'ok',
            isError: false,
            exitCode: 0,
            durationMs: 1234,
          },
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
      'tool-calls',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--session',
      'sess-1',
      '--tool-name',
      'shell',
      '--canonical-tool-type',
      'shell.run',
      '--errors-only',
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
    expect(captured[0]!.url).toBe(`${SERVER}/v2/reads/tool-calls/list`)
    const body = JSON.parse(captured[0]!.init.body as string) as Record<string, unknown>
    expect(body.sessionId).toBe('sess-1')
    expect(body.toolNames).toEqual(['shell'])
    expect(body.canonicalToolTypes).toEqual(['shell.run'])
    expect(body.errorsOnly).toBe(true)
    expect((body as { sessionIds?: unknown }).sessionIds).toBeUndefined()
    expect((body as { sourceTools?: unknown }).sourceTools).toBeUndefined()

    const parsed = JSON.parse(out.stdout) as { rows: Array<Record<string, unknown>> }
    const row = parsed.rows[0]!
    expect(row.timestamp_start).toBe('2026-05-20T10:00:01.000Z')
    expect(row.tool_name).toBe('shell')
    expect(row.canonical_tool_type).toBe('shell.run')
    expect(row.status).toBe('completed')
    expect(row.result_status).toBe('ok')
    expect(row.result_is_error).toBe(false)
    expect(row.result_exit_code).toBe(0)
    expect(row.result_duration_ms).toBe(1234)
    expect(row.store_id).toBe(STORE)
    expect(row.receipt_id).toBe('r-current')
  })

  it('local mode now reads tool_call / tool_result projection segments — fails on a non-compiled bundle', async () => {
    // Prior behaviour: `read tool-calls --authority local` failed
    // closed because the v2 local-read service did not exist yet.
    // Lane 7 wires `listToolCallsLocal`, so the command no longer
    // rejects up front. The harness here points at a tmp dir with
    // no compiled v2 bundle (no `head.json`), so the local read
    // service surfaces a "bundle has never been compiled" error.
    await expect(
      capture(['read', 'tool-calls', '--store', h.storePath, '--config', h.configPath, '--authority', 'local']),
    ).rejects.toThrow(/head\.json not found/)
  })
})
