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

  // Initialize a bundle WITH at least one CAS object, a source_file, and a
  // raw_record so the sync command exercises every projection upload path.
  const bundle = await initBundle(storePath)
  const objectId = await putBytes(bundle, new Uint8Array([1, 2, 3, 4, 5]))
  bundle.db
    .prepare(
      `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('sess-cas-1', 'codex', 'sess-cas-1', null, 'cas test', null, null)
  bundle.db
    .prepare(
      `INSERT INTO source_files (source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'sf-cas-1',
      'codex',
      '/source/path',
      'jsonl',
      5,
      new Date().toISOString(),
      'content-hash-1',
      objectId,
      new Date().toISOString(),
    )
  bundle.db
    .prepare(
      `INSERT INTO import_batches (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('ib-cas-1', '0', 'codex', '[]', new Date().toISOString(), null, 'running')
  bundle.db
    .prepare(
      `INSERT INTO raw_records (raw_record_id, source_file_id, source_tool, record_kind, ordinal, line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id, parser_status, confidence, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'rr-cas-1',
      'sf-cas-1',
      'codex',
      'message',
      0,
      1,
      null,
      'native-id-1',
      objectId,
      null,
      'ok',
      'high',
      'ib-cas-1',
    )
  bundle.db
    .prepare(
      `INSERT INTO tool_calls (
         tool_call_id, session_id, turn_id, message_id, event_id, source_call_id, tool_name,
         canonical_tool_type, args_object_id, command, cwd, path, query, timestamp_start,
         timestamp_end, status, raw_record_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'tc-cas-1',
      'sess-cas-1',
      null,
      null,
      null,
      'source-call-1',
      'shell.exec',
      'shell',
      objectId,
      'echo ok',
      null,
      null,
      null,
      '2026-04-01T10:00:00.000Z',
      '2026-04-01T10:00:01.000Z',
      'ok',
      'rr-cas-1',
    )
  bundle.db
    .prepare(
      `INSERT INTO tool_results (
         tool_result_id, tool_call_id, session_id, message_id, event_id, source_call_id, status,
         is_error, exit_code, duration_ms, stdout_object_id, stderr_object_id, output_object_id,
         preview, raw_record_id
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'tr-cas-1',
      'tc-cas-1',
      'sess-cas-1',
      null,
      null,
      'source-call-1',
      'ok',
      0,
      0,
      1000,
      null,
      null,
      objectId,
      'ok',
      'rr-cas-1',
    )
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
    transaction: dbHandle.transaction,
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
    expect(syncOut.stdout).toContain('packed in 1 pack(s)')

    // Confirm tenant_object, source_file, and raw_record rows were all
    // persisted server-side — proves every projection class moved.
    const tenantObjects = await h.pglite.query<{ count: number }>('SELECT count(*)::int AS count FROM "tenant_object"')
    expect(tenantObjects.rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1)
    const sourceFiles = await h.pglite.query<{ count: number }>('SELECT count(*)::int AS count FROM "source_file"')
    expect(sourceFiles.rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1)
    const rawRecords = await h.pglite.query<{ count: number }>('SELECT count(*)::int AS count FROM "raw_record"')
    expect(rawRecords.rows[0]?.count ?? 0).toBeGreaterThanOrEqual(1)
    const toolCalls = await h.pglite.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "projection_tool_call"',
    )
    expect(toolCalls.rows[0]?.count ?? 0).toBe(1)
    const toolResults = await h.pglite.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM "projection_tool_result"',
    )
    expect(toolResults.rows[0]?.count ?? 0).toBe(1)
    // The canonical object_id must match the local catalog: `blake3:<uncompressed hash>`.
    const remoteObject = await h.pglite.query<{ object_id: string; hash: string }>(
      'SELECT object_id, hash FROM "remote_object" LIMIT 1',
    )
    expect(remoteObject.rows[0]?.object_id.startsWith('blake3:')).toBe(true)

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
