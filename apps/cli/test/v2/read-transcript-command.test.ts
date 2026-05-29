// CQ-150 + CQ-152 — command-level test for `prosa v2 read transcript`.
//
// Covers:
//   - JSON rendering against a representative Lane 6 transcript
//     payload (session, turns w/ blocks + tool calls, unattached).
//   - Single-page refresh-once-and-retry on HTTP 412 (CQ-152 fix).
//   - Repeated-412 stops with AuthorityChangedError.
//   - --all-pages multi-page walk fails closed on any 412.

import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { TranscriptPageResponse } from '@c3-oss/prosa-api'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runCli } from '../../src/cli/main.js'
import { writeCachedAuthority } from '../../src/cli/v2/authority/index.js'

const TENANT = 'tenant-tx'
const STORE = 'store-tx'
const SERVER = 'http://transcript.test'

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

function makePage(receiptId: string, nextCursor: string | null = null): TranscriptPageResponse {
  return {
    session: {
      id: 'sess-1',
      sourceTool: 'codex',
      sourceSessionId: 'src',
      title: 'My Session',
      startedAt: '2026-05-20T10:00:00.000Z',
      endedAt: '2026-05-20T10:10:00.000Z',
      durationMs: 600_000,
      storeId: STORE,
      receiptId,
    },
    turns: [
      {
        messageId: 'm1',
        ordinal: 0,
        turnId: 't1',
        role: 'user',
        model: null,
        timestamp: '2026-05-20T10:00:01.000Z',
        blocks: [
          {
            blockId: 'b1',
            blockType: 'text',
            ordinal: 0,
            textInline: 'hello',
            textObjectId: null,
            hidden: false,
            isError: false,
            isRedacted: false,
            mimeType: 'text/plain',
          },
        ],
        toolCalls: [],
      },
    ],
    unattachedToolCalls: [],
    nextCursor,
  }
}

async function setupHarness(): Promise<{ root: string; configPath: string; storePath: string; authorityDir: string }> {
  const root = await mkdtemp(path.join(tmpdir(), 'prosa-read-tx-cmd-'))
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

describe('prosa v2 read transcript — command-level (CQ-150 + CQ-152)', () => {
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

  it('renders a single-page transcript with session/turns/blocks (JSON)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify(makePage('r-current')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response,
      ),
    )

    const out = await capture([
      'v2',
      'read',
      'transcript',
      'sess-1',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--format',
      'json',
    ])
    const parsed = JSON.parse(out.stdout) as TranscriptPageResponse
    expect(parsed).not.toBeNull()
    expect(parsed!.session.id).toBe('sess-1')
    expect(parsed!.session.title).toBe('My Session')
    expect(parsed!.turns[0]!.blocks[0]!.textInline).toBe('hello')
  })

  it('CQ-152 — single-page refresh-once-and-retry on HTTP 412', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        calls += 1
        if (url.endsWith('/v2/reads/sessions/transcript')) {
          // First read call returns 412; second succeeds.
          if (calls === 1) {
            return new Response(JSON.stringify({ code: 'AUTHORITY_CHANGED' }), {
              status: 412,
              headers: { 'content-type': 'application/json' },
            }) as unknown as Response
          }
          return new Response(JSON.stringify(makePage('r-new')), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response
        }
        // Authority refresh.
        return new Response(
          JSON.stringify({
            status: 'updated',
            receipt: receipt('r-new'),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            auditStatus: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response
      }),
    )

    const out = await capture([
      'v2',
      'read',
      'transcript',
      'sess-1',
      '--store',
      h.storePath,
      '--config',
      h.configPath,
      '--format',
      'json',
    ])
    const parsed = JSON.parse(out.stdout) as TranscriptPageResponse
    expect(parsed).not.toBeNull()
    expect(parsed!.session.receiptId).toBe('r-new')
  })

  it('CQ-152 — repeated 412 stops with explicit authority-changed error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/v2/reads/sessions/transcript')) {
          return new Response(JSON.stringify({ code: 'AUTHORITY_CHANGED' }), {
            status: 412,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response
        }
        return new Response(
          JSON.stringify({
            status: 'updated',
            receipt: receipt('r-new'),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            auditStatus: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response
      }),
    )

    await expect(
      capture([
        'v2',
        'read',
        'transcript',
        'sess-1',
        '--store',
        h.storePath,
        '--config',
        h.configPath,
        '--format',
        'json',
      ]),
    ).rejects.toThrow(/authority changed twice/i)
  })

  it('CQ-152 — --all-pages fails closed on first 412 (no refresh + retry)', async () => {
    let calls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input)
        if (url.endsWith('/v2/reads/sessions/transcript')) {
          calls += 1
          return new Response(JSON.stringify({ code: 'AUTHORITY_CHANGED' }), {
            status: 412,
            headers: { 'content-type': 'application/json' },
          }) as unknown as Response
        }
        return new Response(
          JSON.stringify({
            status: 'updated',
            receipt: receipt('r-new'),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            auditStatus: 'ok',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ) as unknown as Response
      }),
    )

    await expect(
      capture([
        'v2',
        'read',
        'transcript',
        'sess-1',
        '--store',
        h.storePath,
        '--config',
        h.configPath,
        '--all-pages',
        '--format',
        'json',
      ]),
    ).rejects.toThrow(/authority changed mid-transcript/i)
    // The walk must NOT retry — only one transcript fetch attempted.
    expect(calls).toBe(1)
  })
})
