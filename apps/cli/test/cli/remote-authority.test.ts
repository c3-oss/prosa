import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '@c3-oss/prosa-api'
import { applySchema } from '@c3-oss/prosa-db'
import { MemoryObjectStore } from '@c3-oss/prosa-storage'
import { PGlite } from '@electric-sql/pglite'
import type { FastifyInstance } from 'fastify'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runCli } from '../../src/cli/main.js'

type Harness = {
  baseUrl: string
  configPath: string
  storePath: string
  rawExec: <Row = Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<Row[]>
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-cli-remote-authority-'))
  const configPath = path.join(tmpRoot, 'config.json')
  const storePath = path.join(tmpRoot, '.prosa')
  await mkdir(storePath, { recursive: true })

  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef',
    PROSA_API_URL: 'http://127.0.0.1:0',
  } as NodeJS.ProcessEnv)
  const pglite = new PGlite()
  await applySchema(pglite)
  const dbHandle = openPgliteDatabase(pglite)
  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = new MemoryObjectStore()
  const app: FastifyInstance = await buildApp({
    config,
    auth,
    db: dbHandle.db,
    rawExec: dbHandle.rawExec,
    transaction: dbHandle.transaction,
    objectStore,
    loggerEnabled: false,
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })

  return {
    baseUrl: address,
    configPath,
    storePath,
    close: async () => {
      await app.close()
      await pglite.close()
      await rm(tmpRoot, { recursive: true, force: true })
    },
    rawExec: dbHandle.rawExec,
  }
}

async function capturedRun(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const originalStdout = process.stdout.write.bind(process.stdout)
  const originalStderr = process.stderr.write.bind(process.stderr)
  const stdout: string[] = []
  const stderr: string[] = []
  process.stdout.write = ((chunk: unknown) => {
    stdout.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stdout.write
  process.stderr.write = ((chunk: unknown) => {
    stderr.push(typeof chunk === 'string' ? chunk : String(chunk))
    return true
  }) as typeof process.stderr.write
  try {
    await runCli(['node', 'prosa', ...args])
  } finally {
    process.stdout.write = originalStdout
    process.stderr.write = originalStderr
  }
  return { stdout: stdout.join(''), stderr: stderr.join('') }
}

async function makeRemoteAuthoritativeWithMissingBundle(h: Harness): Promise<void> {
  const signupOut = await capturedRun([
    'auth',
    'signup',
    '--server',
    h.baseUrl,
    '--email',
    'remote-authority@example.com',
    '--password',
    'correct-horse-battery',
    '--name',
    'Remote Authority',
    '--tenant',
    'Remote Authority Co',
    '--json',
  ])
  const signup = JSON.parse(signupOut.stdout) as { tenant: { id: string } }
  const tenantId = signup.tenant.id
  const config = JSON.parse(await readFile(h.configPath, 'utf8')) as {
    activeServer: string
    servers: Record<
      string,
      {
        user?: { id: string }
        promotions?: Record<string, unknown>
      }
    >
  }
  const server = config.servers[h.baseUrl]
  const userId = server?.user?.id
  if (!server || !userId) throw new Error('signup did not create a config entry')

  await h.rawExec(
    `INSERT INTO "device" (id, tenant_id, user_id, name, platform, cli_version, store_path)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    ['dev_remote_authority_test', tenantId, userId, 'remote-fixture-device', 'test', '0.0.0', h.storePath],
  )
  await h.rawExec(
    `INSERT INTO "sync_batch" (id, tenant_id, device_id, user_id, store_path, status, object_count, row_count)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    ['batch_remote_authority_test', tenantId, 'dev_remote_authority_test', userId, h.storePath, 'verified', 0, 2],
  )

  await h.rawExec(
    `INSERT INTO "projection_session"
       (tenant_id, id, source_kind, project_id, title, started_at, ended_at, turn_count, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [tenantId, 'sess-remote-1', 'codex', null, 'remote session', '2026-05-01T00:00:00.000Z', null, 0, {}],
  )
  await h.rawExec(
    `INSERT INTO "search_doc" (tenant_id, id, session_id, kind, body)
     VALUES ($1, $2, $3, $4, $5)`,
    [tenantId, 'doc-remote-1', 'sess-remote-1', 'session/text', 'needle remote body'],
  )
  await h.rawExec(
    `INSERT INTO "sync_batch_projection_manifest" (batch_id, tenant_id, entity_type, entity_id)
     VALUES ($1, $2, $3, $4), ($1, $2, $5, $6)`,
    ['batch_remote_authority_test', tenantId, 'session', 'sess-remote-1', 'search_doc', 'doc-remote-1'],
  )

  server.promotions = {
    ...(server.promotions ?? {}),
    [h.storePath]: {
      batchId: 'batch_remote_authority_test',
      tenantId,
      promotedAt: '2026-05-01T00:00:00.000Z',
      receipt: { sessionCount: 1, objectCount: 0, searchDocCount: 1 },
      cleanupCompletedAt: '2026-05-01T00:00:00.000Z',
    },
  }
  await writeFile(h.configPath, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rm(path.join(h.storePath, 'manifest.json'), { force: true })
  await rm(path.join(h.storePath, 'prosa.sqlite'), { force: true })
}

describe('remote-authoritative CLI reads', () => {
  let h: Harness

  beforeEach(async () => {
    h = await bootHarness()
    process.env.PROSA_CONFIG_PATH = h.configPath
  })

  afterEach(async () => {
    process.env.PROSA_CONFIG_PATH = undefined
    await h.close()
  })

  it('uses remote routes for supported reads when the local bundle is missing', async () => {
    await makeRemoteAuthoritativeWithMissingBundle(h)

    // CQ-005: remote-authoritative search v0 fails closed. The CLI must
    // surface a clear error rather than masquerade a partial result.
    const searchError = await capturedRun([
      'v1',
      'search',
      'needle',
      '--store',
      h.storePath,
      '--engine',
      'remote-pg',
      '--output-format',
      'json',
    ]).catch((err: unknown) => err)
    expect(searchError).toBeInstanceOf(Error)
    expect((searchError as Error).message).toMatch(/remote-authoritative search is unavailable/i)

    const sessionsOut = await capturedRun(['v1', 'sessions', '--store', h.storePath, '--output-format', 'json'])
    const sessions = JSON.parse(sessionsOut.stdout) as {
      source: string
      rows: Array<{ session_id: string; source_tool: string }>
    }
    expect(sessions.source).toBe('remote')
    expect(sessions.rows).toEqual([expect.objectContaining({ session_id: 'sess-remote-1', source_tool: 'codex' })])

    const countOut = await capturedRun(['v1', 'sessions', 'count', '--store', h.storePath, '--source', 'codex'])
    expect(countOut.stdout).toBe('1\n')
  })

  it('fails closed for unsupported read surfaces when the local bundle is missing', async () => {
    await makeRemoteAuthoritativeWithMissingBundle(h)

    for (const args of [
      ['v1', 'analytics', 'sessions', '--store', h.storePath],
      ['v1', 'query', 'duckdb', 'select 1', '--store', h.storePath],
      ['v1', 'export', 'session', 'sess-remote-1', '--format', 'markdown', '--store', h.storePath],
      ['v1', 'export', 'parquet', '--store', h.storePath],
      ['v1', 'mcp', 'serve', '--store', h.storePath],
      ['v1', 'tui', '--store', h.storePath],
    ]) {
      const error = await capturedRun(args).catch((err: unknown) => err)
      expect(error).toBeInstanceOf(Error)
      expect((error as Error).message).toContain('not available for remote-authoritative store')
      expect((error as Error).message).toContain('Use --local to read the local bundle explicitly')
    }
  })

  it('rejects local-only search engines after promotion unless --local is explicit', async () => {
    await makeRemoteAuthoritativeWithMissingBundle(h)

    const error = await capturedRun(['v1', 'search', 'needle', '--store', h.storePath, '--engine', 'tantivy']).catch(
      (err: unknown) => err,
    )

    expect(error).toBeInstanceOf(Error)
    expect((error as Error).message).toContain('remote-authoritative search uses the remote-pg engine')
  })
})
