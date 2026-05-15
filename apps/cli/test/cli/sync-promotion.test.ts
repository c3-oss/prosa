import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '@c3-oss/prosa-api'
import { closeBundle, initBundle } from '@c3-oss/prosa-core'
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
  close: () => Promise<void>
}

async function bootHarness(): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-cli-sync-'))
  const configPath = path.join(tmpRoot, 'config.json')
  const storePath = path.join(tmpRoot, '.prosa')
  await mkdir(storePath, { recursive: true })

  // Initialize a small local bundle and seed a session row directly.
  const bundle = await initBundle(storePath)
  bundle.db
    .prepare(
      `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('sess-1', 'codex', 'sess-1', null, 'first', null, null)
  bundle.db
    .prepare(
      `INSERT INTO search_docs (doc_id, entity_type, entity_id, session_id, field_kind, text)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run('doc-1', 'session', 'sess-1', 'sess-1', 'text', 'hello world')
  closeBundle(bundle)

  // Boot the API server on an ephemeral port.
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

describe('CLI auth + sync end-to-end', () => {
  let h: Harness
  beforeEach(async () => {
    h = await bootHarness()
    process.env.PROSA_CONFIG_PATH = h.configPath
  })
  afterEach(async () => {
    process.env.PROSA_CONFIG_PATH = undefined
    await h.close()
  })

  it('signs up, syncs a bundle, and records a promotion receipt', async () => {
    const signupOut = await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'cli@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'CLI Person',
      '--tenant',
      'CLI Co',
      '--tenant-slug',
      'cli-co',
      '--json',
    ])
    expect(signupOut.stdout).toContain('"ok":true')

    const syncOut = await capturedRun(['sync', '--server', h.baseUrl, '--store', h.storePath, '--json', '--verbose'])
    expect(syncOut.stdout).toContain('"ok":true')

    // Default cleanup only removes derived artifacts; canonical data
    // (manifest.json, prosa.sqlite, objects/, raw/) is preserved unless
    // the user opts in to `--purge-bundle`. The store is still marked
    // remote-authoritative via the promotion receipt below.
    const manifestExists = await stat(`${h.storePath}/manifest.json`).then(
      () => true,
      () => false,
    )
    expect(manifestExists).toBe(true)

    // Promotion receipt should be recorded in the config file, and the
    // verification counters should reflect the declared session.
    const config = JSON.parse(await readFile(h.configPath, 'utf8')) as {
      activeServer: string
      servers: Record<
        string,
        {
          promotions?: Record<
            string,
            {
              batchId: string
              receipt: { sessionCount: number; declaredSessionsVerified?: number }
            }
          >
        }
      >
    }
    const server = config.servers[h.baseUrl]
    expect(server).toBeDefined()
    const promo = server?.promotions?.[h.storePath]
    expect(promo?.batchId).toMatch(/^batch_/)
    expect(promo?.receipt.sessionCount).toBeGreaterThanOrEqual(1)
    expect(promo?.receipt.declaredSessionsVerified ?? 0).toBeGreaterThanOrEqual(1)
  })

  it('dry-run reports plan without uploading', async () => {
    await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'dry@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'Dry',
      '--tenant',
      'Dry Co',
      '--json',
    ])
    const out = await capturedRun(['sync', '--server', h.baseUrl, '--store', h.storePath, '--dry-run', '--json'])
    expect(out.stdout).toContain('"dryRun":true')
    // Local bundle should still exist.
    const manifestExists = await stat(`${h.storePath}/manifest.json`).then(
      () => true,
      () => false,
    )
    expect(manifestExists).toBe(true)
  })

  it('--purge-bundle removes canonical raw/CAS data after promotion', async () => {
    await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'purge@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'Purge',
      '--tenant',
      'Purge Co',
      '--json',
    ])
    await capturedRun(['sync', '--server', h.baseUrl, '--store', h.storePath, '--purge-bundle', '--json'])
    const manifestExists = await stat(`${h.storePath}/manifest.json`).then(
      () => true,
      () => false,
    )
    expect(manifestExists).toBe(false)
  })

  it('--keep-local leaves the local bundle in place', async () => {
    await capturedRun([
      'auth',
      'signup',
      '--server',
      h.baseUrl,
      '--email',
      'keep@example.com',
      '--password',
      'correct-horse-battery',
      '--name',
      'Keep',
      '--tenant',
      'Keep Co',
      '--json',
    ])
    await capturedRun(['sync', '--server', h.baseUrl, '--store', h.storePath, '--keep-local', '--json'])
    const manifestExists = await stat(`${h.storePath}/manifest.json`).then(
      () => true,
      () => false,
    )
    expect(manifestExists).toBe(true)
  })
})
