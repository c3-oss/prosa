import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CreateBucketCommand, HeadBucketCommand, S3Client } from '@aws-sdk/client-s3'
import { buildApp, createAuth, loadConfig, openPostgresDatabase } from '@c3-oss/prosa-api'
import { closeBundle, initBundle } from '@c3-oss/prosa-core'
import { applySchema } from '@c3-oss/prosa-db'
import { S3ObjectStore } from '@c3-oss/prosa-storage'
import type { FastifyInstance } from 'fastify'
import postgres from 'postgres'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'

const PG_URL = process.env.PROSA_TEST_POSTGRES_URL
const S3_ENDPOINT = process.env.PROSA_TEST_S3_ENDPOINT
const S3_BUCKET = process.env.PROSA_TEST_S3_BUCKET ?? 'prosa-test'
const S3_ACCESS_KEY = process.env.PROSA_TEST_S3_ACCESS_KEY
const S3_SECRET_KEY = process.env.PROSA_TEST_S3_SECRET_KEY
const S3_REGION = process.env.PROSA_TEST_S3_REGION ?? 'us-east-1'

const shouldRun = Boolean(PG_URL && S3_ENDPOINT && S3_ACCESS_KEY && S3_SECRET_KEY)

type Harness = {
  baseUrl: string
  app: FastifyInstance
  configPathA: string
  configPathB: string
  storePath: string
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  if (!PG_URL || !S3_ENDPOINT || !S3_ACCESS_KEY || !S3_SECRET_KEY) {
    throw new Error('e2e env vars missing — should be skipped')
  }

  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-e2e-cli-'))
  const configPathA = path.join(tmpRoot, 'configA.json')
  const configPathB = path.join(tmpRoot, 'configB.json')
  const storePath = path.join(tmpRoot, '.prosa')
  await mkdir(storePath, { recursive: true })

  // Reset the Postgres database for a clean slate.
  const bootstrapClient = postgres(PG_URL, { max: 1, prepare: false })
  await bootstrapClient.unsafe('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;')
  await applySchema({
    exec: async (sql) => {
      await bootstrapClient.unsafe(sql)
    },
  })
  await bootstrapClient.end({ timeout: 2 })

  // Ensure bucket exists in MinIO.
  const s3 = new S3Client({
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    credentials: { accessKeyId: S3_ACCESS_KEY, secretAccessKey: S3_SECRET_KEY },
    forcePathStyle: true,
  })
  try {
    await s3.send(new HeadBucketCommand({ Bucket: S3_BUCKET }))
  } catch {
    await s3.send(new CreateBucketCommand({ Bucket: S3_BUCKET }))
  }

  // Initialize a local prosa bundle with a seeded session row.
  const bundle = await initBundle(storePath)
  bundle.db
    .prepare(
      `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('sess-e2e-1', 'codex', 'sess-e2e-1', null, 'e2e seed', null, null)
  bundle.db
    .prepare(
      `INSERT INTO search_docs (doc_id, entity_type, entity_id, session_id, field_kind, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('doc-e2e-1', 'session', 'sess-e2e-1', 'sess-e2e-1', 'text', 'shared session body')
  closeBundle(bundle)

  // Boot the API against the real Postgres + S3.
  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_AUTH_SECRET: 'e2e-cli-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:0',
    PROSA_OBJECT_STORE_DRIVER: 's3',
    PROSA_OBJECT_STORE_BUCKET: S3_BUCKET,
    PROSA_OBJECT_STORE_REGION: S3_REGION,
    PROSA_OBJECT_STORE_ENDPOINT: S3_ENDPOINT,
    PROSA_OBJECT_STORE_ACCESS_KEY_ID: S3_ACCESS_KEY,
    PROSA_OBJECT_STORE_SECRET_ACCESS_KEY: S3_SECRET_KEY,
  } as NodeJS.ProcessEnv)
  const dbHandle = await openPostgresDatabase(PG_URL)
  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = new S3ObjectStore({
    bucket: S3_BUCKET,
    endpoint: S3_ENDPOINT,
    region: S3_REGION,
    accessKeyId: S3_ACCESS_KEY,
    secretAccessKey: S3_SECRET_KEY,
    forcePathStyle: true,
  })
  const app = await buildApp({
    config,
    auth,
    db: dbHandle.db,
    rawExec: dbHandle.rawExec,
    objectStore,
    loggerEnabled: false,
  })
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })

  return {
    baseUrl,
    app,
    configPathA,
    configPathB,
    storePath,
    close: async () => {
      await app.close()
      await dbHandle.close()
      await rm(tmpRoot, { recursive: true, force: true })
    },
  }
}

async function capturedRun(args: string[]): Promise<{ stdout: string }> {
  const original = process.stdout.write.bind(process.stdout)
  const captured: string[] = []
  process.stdout.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  try {
    await runCli(['node', 'prosa', ...args])
  } finally {
    process.stdout.write = original
  }
  return { stdout: captured.join('') }
}

describe.skipIf(!shouldRun)('CLI + API + Postgres + S3 — two-device E2E', () => {
  let h: Harness
  beforeEach(async () => {
    h = await bootHarness()
  })
  afterEach(async () => {
    await h.close()
  })

  it('Device A promotes a bundle, local data is removed, Device B queries via the server', async () => {
    // ---------------------- Device A: signup + sync ----------------------
    process.env.PROSA_CONFIG_PATH = h.configPathA
    await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'devA@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'Dev A',
      '--tenant',
      'TwoDev Co',
      '--tenant-slug',
      'twodev',
      '--json',
    ])

    const syncOut = await capturedRun([
      'sync',
      '--server',
      h.baseUrl,
      '--store',
      h.storePath,
      '--purge-bundle',
      '--json',
    ])
    expect(syncOut.stdout).toContain('"ok":true')

    // With --purge-bundle, manifest + canonical data must be removed after
    // successful promotion.
    const manifestExists = await stat(`${h.storePath}/manifest.json`).then(
      () => true,
      () => false,
    )
    expect(manifestExists).toBe(false)

    // Device A's local CLI config records the promotion receipt.
    const configA = JSON.parse(await readFile(h.configPathA, 'utf8')) as {
      activeServer: string
      servers: Record<string, { promotions?: Record<string, { batchId: string; tenantId: string }> }>
    }
    const promo = configA.servers[h.baseUrl]?.promotions?.[h.storePath]
    expect(promo?.batchId).toMatch(/^batch_/)

    // ---------------------- Device B: login (different config) ----------------------
    process.env.PROSA_CONFIG_PATH = h.configPathB
    await capturedRun([
      'auth',
      'login',
      '--server',
      h.baseUrl,
      '--email',
      'devA@example.com',
      '--password',
      'correct-horse-battery',
      '--json',
    ])

    // Device B should NOT receive any local bundle; it just queries the
    // server. The `auth status --json` smoke-tests that Device B is logged
    // in and remembers the active tenant.
    const statusOut = await capturedRun(['auth', 'status', '--json'])
    expect(statusOut.stdout).toContain('"loggedIn":true')

    // Direct server query via the active token in Device B's config.
    const configB = JSON.parse(await readFile(h.configPathB, 'utf8')) as {
      servers: Record<string, { token?: string; activeTenant?: { id: string } }>
    }
    const tokenB = configB.servers[h.baseUrl]?.token
    const tenantBId = configB.servers[h.baseUrl]?.activeTenant?.id
    expect(tokenB).toBeTruthy()
    expect(tenantBId).toBeTruthy()
    const sessionsResp = await fetch(`${h.baseUrl}/trpc/sessions.list?input=${encodeURIComponent('{}')}`, {
      headers: {
        authorization: `Bearer ${tokenB}`,
        'x-prosa-tenant-id': tenantBId ?? '',
      },
    })
    expect(sessionsResp.status).toBe(200)
    const sessionsJson = (await sessionsResp.json()) as {
      result: { data: Array<{ id: string; title: string | null }> }
    }
    const ids = sessionsJson.result.data.map((s) => s.id)
    expect(ids).toContain('sess-e2e-1')

    // Re-running sync from Device A must be idempotent / non-destructive.
    process.env.PROSA_CONFIG_PATH = h.configPathA
    // No local bundle remains, so sync would fail; that's expected behavior.
    // We verify the promotion receipt persists on the server.
    const authoritiesResp = await fetch(
      `${h.baseUrl}/trpc/sync.status?input=${encodeURIComponent(JSON.stringify({ storePath: h.storePath }))}`,
      {
        headers: {
          authorization: `Bearer ${tokenB}`,
          'x-prosa-tenant-id': tenantBId ?? '',
        },
      },
    )
    expect(authoritiesResp.status).toBe(200)
    const authoritiesJson = (await authoritiesResp.json()) as {
      result: { data: { authorities: Array<{ store_path: string }> } }
    }
    expect(authoritiesJson.result.data.authorities.length).toBeGreaterThanOrEqual(1)

    process.env.PROSA_CONFIG_PATH = undefined
  }, 120_000)
})
