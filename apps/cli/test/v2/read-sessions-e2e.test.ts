// Lane 7 slice 11 — live E2E smoke for `prosa read sessions`.
//
// Boots a minimal Fastify with the Lane 6 v2 read plugin mounted
// against a v2-only PGlite, stubs ProsaAuth so `auth.api.getSession`
// returns a fixed user + active tenant (bypassing Better Auth's
// table dependencies — the CQ-124 schema conflict prevents a
// single-process v1+v2 boot), seeds a v2 `remote_authority_v2` +
// `receipt` + `projection_session` row, and drives the CLI via a
// `vi.stubGlobal('fetch', ...)` adapter that routes through
// `app.inject(...)`. End-to-end: CLI → V2ReadsClient → Fastify
// route → handler → PGlite → response → CLI rendering.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProsaAuth } from '@c3-oss/prosa-api'
import { applySchemaV2 } from '@c3-oss/prosa-db-v2'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import type { PromotionReceiptV2 } from '@c3-oss/prosa-types-v2'
import { PGlite } from '@electric-sql/pglite'
import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
// Deep import: registerV2ReadRoutes is not in the public index.
// The slice 11 smoke is the only consumer outside apps/api.
import { registerV2ReadRoutes } from '../../../api/src/v2/reads/index.js'
import { runCli } from '../../src/cli/main.js'
import { writeCachedAuthority } from '../../src/cli/v2/authority/index.js'

const TENANT_ID = 'tenant-e2e-1'
const STORE_ID = 'store-e2e-1'
const RECEIPT_ID = 'rcp-e2e-1'
const USER_ID = 'usr-e2e-1'
const SESSION_ID = 'sess-e2e-1'
const SERVER_URL = 'http://e2e.test'

type Harness = {
  app: FastifyInstance
  pglite: PGlite
  configPath: string
  storePath: string
  authorityDir: string
  rawExec: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-slice11-'))
  const configPath = path.join(tmpRoot, 'config.json')
  const storePath = path.join(tmpRoot, '.prosa')
  const authorityDir = path.join(tmpRoot, 'authority')
  await mkdir(storePath, { recursive: true })

  const pglite = new PGlite()
  await applySchemaV2(pglite)

  const rawExec = async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const res = await pglite.query<Row>(sql, params)
    return res.rows
  }

  // CQ-124 workaround for slice 11: skip Better Auth's user/session
  // tables (they require the v1 schema). Stub `auth.api.getSession`
  // so every request resolves to a known user + active organization.
  const stubAuth: ProsaAuth = {
    handler: async () => new Response('not used', { status: 200 }),
    api: {
      getSession: (async () => ({
        session: { activeOrganizationId: TENANT_ID },
        user: { id: USER_ID, email: 'e2e@example.com', name: 'E2E' },
      })) as ProsaAuth['api']['getSession'],
      signUpEmail: (async () => null) as ProsaAuth['api']['signUpEmail'],
      signInEmail: (async () => null) as ProsaAuth['api']['signInEmail'],
      signOut: (async () => null) as ProsaAuth['api']['signOut'],
      createOrganization: (async () => null) as ProsaAuth['api']['createOrganization'],
      setActiveOrganization: (async () => null) as ProsaAuth['api']['setActiveOrganization'],
      listOrganizations: (async () => null) as ProsaAuth['api']['listOrganizations'],
      createInvitation: (async () => null) as ProsaAuth['api']['createInvitation'],
      deviceCode: (async () => null) as ProsaAuth['api']['deviceCode'],
      deviceToken: (async () => null) as ProsaAuth['api']['deviceToken'],
      deviceVerify: (async () => null) as ProsaAuth['api']['deviceVerify'],
    },
  }

  // The slice 11 test ships only the read surface; member-check
  // queries the projection so we seed it directly. The unit-level
  // route tests cover the full member-table gate.
  await rawExec(
    `CREATE TABLE IF NOT EXISTS member (
       id TEXT PRIMARY KEY,
       organization_id TEXT NOT NULL,
       user_id TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'member',
       created_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  )
  await rawExec(`INSERT INTO member (id, organization_id, user_id, role) VALUES ($1, $2, $3, $4)`, [
    'mbr-e2e-1',
    TENANT_ID,
    USER_ID,
    'owner',
  ])

  // Mount just the v2 read plugin (no v1 tRPC, no auth handler).
  const app = Fastify({ logger: false })
  registerV2ReadRoutes(app, {
    auth: stubAuth,
    rawExec,
    objectStore: new MemoryObjectStore(),
  })
  await app.ready()

  return {
    app,
    pglite,
    configPath,
    storePath,
    authorityDir,
    rawExec,
    close: async () => {
      await app.close()
      await pglite.close()
      await rm(tmpRoot, { recursive: true, force: true })
    },
  }
}

async function seed(h: Harness): Promise<void> {
  // remote_authority_v2 + receipt drive the verified-projection gate.
  await h.rawExec(
    `INSERT INTO remote_authority_v2 (tenant_id, store_id, current_receipt_id, current_bundle_root, promoted_at)
     VALUES ($1, $2, $3, $4, now())`,
    [TENANT_ID, STORE_ID, RECEIPT_ID, 'aa'.repeat(16)],
  )
  await h.rawExec(
    `INSERT INTO projection_session
       (tenant_id, session_id, store_id, receipt_id, source_tool, source_session_id,
        project_id, parent_session_id, parent_resolution, is_subagent, title, summary,
        start_ts, end_ts, status, timeline_confidence, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'unresolved', $9, $10, $11, $12::timestamptz, $13::timestamptz,
             $14, 'high', '{}'::jsonb)`,
    [
      TENANT_ID,
      SESSION_ID,
      STORE_ID,
      RECEIPT_ID,
      'codex',
      'src-e2e-1',
      null,
      null,
      false,
      'Live Smoke Session',
      null,
      '2026-05-19T10:00:00.000Z',
      '2026-05-19T10:05:00.000Z',
      'ok',
    ],
  )
}

async function writeCliConfig(h: Harness): Promise<void> {
  const config = {
    activeServer: SERVER_URL,
    servers: {
      [SERVER_URL]: {
        url: SERVER_URL,
        token: 'stub-token',
        user: { id: USER_ID, email: 'e2e@example.com', name: 'E2E' },
        promotions: {
          [path.resolve(h.storePath)]: {
            batchId: 'b-e2e-1',
            tenantId: TENANT_ID,
            promotedAt: '2026-05-19T10:05:00.000Z',
            receipt: {
              payload: {
                receiptVersion: 2,
                receiptId: RECEIPT_ID,
                tenantId: TENANT_ID,
                storeId: STORE_ID,
                bundleRoot: 'b3-bundle-root',
                rawSourceRoot: 'b3-raw-root',
                sealedAt: '2026-05-19T10:05:00.000Z',
                epoch: 1,
                schemaVersion: 'v2',
              },
              signature: { algorithm: 'ed25519', keyId: 'k', signedBytes: 'AAA=', signature: 'AAA=' },
            },
          },
        },
      },
    },
  }
  await writeFile(h.configPath, JSON.stringify(config, null, 2), { encoding: 'utf8', mode: 0o600 })

  // Seed the v2 authority cache so the CLI does not need to call
  // `GET /v2/stores/:storeId/authority` (the focused authority-cache
  // tests already pin that path).
  const cachedReceipt: PromotionReceiptV2 = {
    payload: {
      receiptVersion: 2,
      receiptId: RECEIPT_ID,
      tenantId: TENANT_ID,
      storeId: STORE_ID,
      bundleRoot: 'b3-bundle-root',
      rawSourceRoot: 'b3-raw-root',
      sealedAt: '2026-05-19T10:05:00.000Z',
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
  await writeCachedAuthority(h.authorityDir, {
    tenantId: TENANT_ID,
    storeId: STORE_ID,
    receiptId: RECEIPT_ID,
    receipt: cachedReceipt,
    serverUrl: SERVER_URL,
    checkedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    auditStatus: 'ok',
  })
}

async function captureRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
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

/**
 * Adapter: rewire `globalThis.fetch` so any request to SERVER_URL
 * gets dispatched through `app.inject(...)` instead of the real
 * network. The CLI is unaware; the V2ReadsClient still sees
 * `Response` objects.
 */
function bindFetchToApp(app: FastifyInstance): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlString = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url
    const url = new URL(urlString)
    const headers: Record<string, string> = {}
    const initHeaders = (init?.headers ?? {}) as Record<string, string>
    for (const [k, v] of Object.entries(initHeaders)) headers[k.toLowerCase()] = v
    const response = await app.inject({
      method: (init?.method ?? 'GET') as 'GET' | 'POST',
      url: `${url.pathname}${url.search}`,
      headers,
      payload: typeof init?.body === 'string' ? init.body : undefined,
    })
    return new Response(response.body, {
      status: response.statusCode,
      headers: Object.fromEntries(
        Object.entries(response.headers).map(([k, v]) => [k, Array.isArray(v) ? v.join(', ') : String(v ?? '')]),
      ),
    })
  }) as typeof fetch
}

describe('Lane 7 slice 11 — live `prosa read sessions` E2E', () => {
  let h: Harness
  let originalConfigPath: string | undefined
  let originalAuthorityDir: string | undefined

  beforeEach(async () => {
    h = await bootHarness()
    await seed(h)
    await writeCliConfig(h)
    originalConfigPath = process.env.PROSA_CONFIG_PATH
    originalAuthorityDir = process.env.PROSA_AUTHORITY_DIR
    process.env.PROSA_CONFIG_PATH = h.configPath
    process.env.PROSA_AUTHORITY_DIR = h.authorityDir
    vi.stubGlobal('fetch', bindFetchToApp(h.app))
  })

  afterEach(async () => {
    if (originalConfigPath === undefined) process.env.PROSA_CONFIG_PATH = undefined
    else process.env.PROSA_CONFIG_PATH = originalConfigPath
    if (originalAuthorityDir === undefined) process.env.PROSA_AUTHORITY_DIR = undefined
    else process.env.PROSA_AUTHORITY_DIR = originalAuthorityDir
    vi.unstubAllGlobals()
    await h.close()
  })

  it('`prosa read sessions --output-format json` lists the seeded session', async () => {
    const out = await captureRun(['read', 'sessions', '--store', h.storePath, '--output-format', 'json'])
    const payload = JSON.parse(out.stdout) as {
      source: string
      server: string
      storeId: string
      receiptId: string
      auditStatus: string
      rows: Array<{
        session_id: string
        source_tool: string
        title: string | null
        store_id: string
        receipt_id: string
      }>
    }
    expect(payload.source).toBe('remote')
    expect(payload.server).toBe(SERVER_URL)
    expect(payload.storeId).toBe(STORE_ID)
    expect(payload.receiptId).toBe(RECEIPT_ID)
    expect(payload.auditStatus).toBe('ok')
    expect(payload.rows).toHaveLength(1)
    const row = payload.rows[0]!
    expect(row.session_id).toBe(SESSION_ID)
    expect(row.source_tool).toBe('codex')
    expect(row.title).toBe('Live Smoke Session')
    expect(row.store_id).toBe(STORE_ID)
    expect(row.receipt_id).toBe(RECEIPT_ID)
  })

  it('`prosa read sessions --count` returns the integer count', async () => {
    const out = await captureRun(['read', 'sessions', '--count', '--store', h.storePath])
    expect(out.stdout.trim()).toBe('1')
  })
})
