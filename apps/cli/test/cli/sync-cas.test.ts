import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '@c3-oss/prosa-api'
import { closeBundle, initBundle, putBytes } from '@c3-oss/prosa-core'
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
  pglite: PGlite
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-cli-cas-'))
  const configPath = path.join(tmpRoot, 'config.json')
  const storePath = path.join(tmpRoot, '.prosa')
  await mkdir(storePath, { recursive: true })

  // Initialize a bundle WITH at least one CAS object and a source_file row.
  const bundle = await initBundle(storePath)
  const objectId = await putBytes(bundle, new Uint8Array([1, 2, 3, 4, 5]))
  bundle.db
    .prepare(
      `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('sess-cas-1', 'codex', 'sess-cas-1', null, 'cas test', null, null)
  try {
    bundle.db
      .prepare(
        `INSERT INTO source_files (source_file_id, source_tool, source_path, raw_record_id)
         VALUES (?, ?, ?, ?)`,
      )
      .run('sf-cas-1', 'codex', '/source/path', objectId)
  } catch {
    /* schema may differ; ignore */
  }
  closeBundle(bundle)

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
    objectStore,
    loggerEnabled: false,
  })
  const address = await app.listen({ host: '127.0.0.1', port: 0 })

  return {
    baseUrl: address,
    configPath,
    storePath,
    pglite,
    close: async () => {
      await app.close()
      await pglite.close()
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

describe('CLI sync uploads CAS objects', () => {
  let h: Harness
  beforeEach(async () => {
    h = await bootHarness()
    process.env.PROSA_CONFIG_PATH = h.configPath
  })
  afterEach(async () => {
    process.env.PROSA_CONFIG_PATH = undefined
    await h.close()
  })

  it('uploads at least one CAS object and the receipt records the verified counter', async () => {
    await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'cas@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'CAS User',
      '--tenant',
      'CAS Co',
      '--tenant-slug',
      'cas-co',
      '--json',
    ])

    const syncOut = await capturedRun(['sync', '--server', h.baseUrl, '--store', h.storePath, '--verbose', '--json'])
    expect(syncOut.stdout).toContain('"ok":true')

    // Confirm at least one tenant_object row was persisted server-side.
    const tenantObjects = await h.pglite.query<{ count: number }>('SELECT count(*)::int AS count FROM "tenant_object"')
    expect(tenantObjects.rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1)

    // The promotion receipt in the CLI config must report
    // declaredObjectsVerified > 0 — proof that verification actually
    // sampled the uploaded CAS provenance.
    const config = JSON.parse(await readFile(h.configPath, 'utf8')) as {
      servers: Record<
        string,
        { promotions?: Record<string, { receipt: { declaredObjectsVerified?: number; objectCount?: number } }> }
      >
    }
    const promo = config.servers[h.baseUrl]?.promotions?.[h.storePath]
    expect(promo?.receipt.objectCount).toBeGreaterThanOrEqual(1)
    expect(promo?.receipt.declaredObjectsVerified ?? 0).toBeGreaterThanOrEqual(1)

    // Default cleanup keeps canonical data.
    expect(
      await stat(`${h.storePath}/manifest.json`).then(
        () => true,
        () => false,
      ),
    ).toBe(true)
  })
})
