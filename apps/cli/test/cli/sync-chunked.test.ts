import { once } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { closeBundle, initBundle, putBytes } from '@c3-oss/prosa-core'
import type { CommitUploadInput, PlanUploadInput, VerifyPromotionInput } from '@c3-oss/prosa-sync'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { saveCliConfig } from '../../src/cli/auth/config.js'
import { runCli } from '../../src/cli/main.js'

type CommitRecord = {
  objectCount: number
  rowCount: number
  sourceFileCount: number
  sessionCount: number
  rawRecordCount: number
}

type Harness = {
  baseUrl: string
  configPath: string
  stateHome: string
  storePath: string
  commits: CommitRecord[]
  objectUploads: {
    packs: number
    puts: number
  }
  verifyRequests: { count: number }
  close: () => Promise<void>
}

type HarnessOptions = {
  failPlanOnceAt?: number
  failVerifyOnceAt?: number
  bundleFactory?: (storePath: string) => Promise<void>
}

function projectionRowCount(input: CommitUploadInput): number {
  return (
    input.projection.sourceFiles.length +
    input.projection.rawRecords.length +
    input.projection.sessions.length +
    input.projection.toolCalls.length +
    input.projection.toolResults.length +
    input.projection.messages.length +
    input.projection.contentBlocks.length +
    input.projection.events.length +
    input.projection.artifacts.length +
    input.projection.searchDocs.length
  )
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const raw = Buffer.concat(chunks).toString('utf8')
  return raw.length > 0 ? JSON.parse(raw) : {}
}

function writeTrpc<T>(res: ServerResponse, data: T): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ result: { data } }))
}

function writeObjectUpload(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ alreadyExisted: false }))
}

function writeObjectPackUpload(res: ServerResponse): void {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ blobId: 'object-pack:test', objectIds: [], alreadyExisted: false }))
}

function writeError(res: ServerResponse, status: number, message: string): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify({ error: { message, data: { code: 'BAD_REQUEST' } } }))
}

async function listen(server: Server): Promise<string> {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  if (address == null || typeof address === 'string') throw new Error('test server did not bind a TCP port')
  return `http://127.0.0.1:${address.port}`
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return
  server.close()
  await once(server, 'close')
}

async function createMixedBundle(storePath: string): Promise<void> {
  await mkdir(storePath, { recursive: true })
  const bundle = await initBundle(storePath)
  const objectIds = [
    await putBytes(bundle, new Uint8Array([1, 1, 1])),
    await putBytes(bundle, new Uint8Array([2, 2, 2])),
    await putBytes(bundle, new Uint8Array([3, 3, 3])),
  ].sort()
  for (const [index, objectId] of objectIds.entries()) {
    bundle.db
      .prepare(
        `INSERT INTO source_files (source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id, discovered_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `sf-mixed-${index + 1}`,
        'codex',
        `/source/${index + 1}.jsonl`,
        'jsonl',
        3,
        '2026-05-16T00:00:00.000Z',
        `content-hash-${index + 1}`,
        objectId,
        '2026-05-16T00:00:00.000Z',
      )
  }
  for (let index = 1; index <= 3; index += 1) {
    bundle.db
      .prepare(
        `INSERT INTO sessions (session_id, source_tool, source_session_id, project_id, title, start_ts, end_ts)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `sess-mixed-${index}`,
        'codex',
        `sess-mixed-${index}`,
        null,
        `mixed ${index}`,
        '2026-05-16T00:00:00.000Z',
        null,
      )
  }
  closeBundle(bundle)
}

async function createDependentRawRecordBundle(storePath: string): Promise<void> {
  await mkdir(storePath, { recursive: true })
  const bundle = await initBundle(storePath)
  const objectIds = [
    await putBytes(bundle, new Uint8Array([1, 1, 1])),
    await putBytes(bundle, new Uint8Array([2, 2, 2])),
    await putBytes(bundle, new Uint8Array([3, 3, 3])),
    await putBytes(bundle, new Uint8Array([4, 4, 4])),
  ].sort()
  const rawObjectId = objectIds[0]
  const sourceObjectId = objectIds[3]

  bundle.db
    .prepare(
      `INSERT INTO import_batches (batch_id, parser_version, source_tool, paths, started_at, finished_at, status)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run('batch-dependent', 'test', 'codex', '[]', '2026-05-16T00:00:00.000Z', '2026-05-16T00:00:01.000Z', 'completed')
  bundle.db
    .prepare(
      `INSERT INTO source_files (source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id, discovered_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'sf-dependent',
      'codex',
      '/source/dependent.jsonl',
      'jsonl',
      3,
      '2026-05-16T00:00:00.000Z',
      'content-hash-dependent',
      sourceObjectId,
      '2026-05-16T00:00:00.000Z',
    )
  bundle.db
    .prepare(
      `INSERT INTO raw_records (raw_record_id, source_file_id, source_tool, record_kind, ordinal, line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id, parser_status, confidence, import_batch_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      'rr-dependent',
      'sf-dependent',
      'codex',
      'message',
      0,
      0,
      null,
      'native-dependent',
      rawObjectId,
      null,
      'ok',
      'high',
      'batch-dependent',
    )
  closeBundle(bundle)
}

async function bootHarness(options: HarnessOptions = {}): Promise<Harness> {
  const tmpRoot = await mkdtemp(path.join(tmpdir(), 'prosa-cli-chunked-'))
  const configPath = path.join(tmpRoot, 'config.json')
  const stateHome = path.join(tmpRoot, 'state')
  const storePath = path.join(tmpRoot, '.prosa')
  const commits: CommitRecord[] = []
  const objectUploads = { packs: 0, puts: 0 }
  const verifyRequests = { count: 0 }
  const availableObjectIds = new Set<string>()
  const availableSourceFileIds = new Set<string>()
  const availableSessionIds = new Set<string>()
  const availableMessageIds = new Set<string>()
  const availableToolCallIds = new Set<string>()
  let batchIndex = 0
  let planRequestCount = 0
  let verifyRequestCount = 0
  let failedPlan = false
  let failedVerify = false

  await (options.bundleFactory ?? createMixedBundle)(storePath)

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (req.method === 'PUT' && url.pathname.startsWith('/objects/')) {
        objectUploads.puts += 1
        for await (const _chunk of req) {
          // Drain the upload body so fetch can complete cleanly.
        }
        writeObjectUpload(res)
        return
      }
      if (req.method === 'POST' && url.pathname === '/object-packs') {
        objectUploads.packs += 1
        for await (const _chunk of req) {
          // Drain the upload body so fetch can complete cleanly.
        }
        writeObjectPackUpload(res)
        return
      }
      if (req.method !== 'POST') {
        writeError(res, 404, 'not found')
        return
      }
      if (url.pathname === '/trpc/sync.handshake') {
        await readJson(req)
        writeTrpc(res, {
          serverVersion: 'test',
          protocolVersion: 1,
          deviceId: 'device-chunked-test',
          promoted: false,
          limits: { maxObjectsPerPlan: 2, maxRowsPerCommit: 2, maxObjectBytes: 1024 },
        })
        return
      }
      if (url.pathname === '/trpc/sync.planUpload') {
        const input = (await readJson(req)) as PlanUploadInput
        planRequestCount += 1
        if (!failedPlan && options.failPlanOnceAt === planRequestCount) {
          failedPlan = true
          writeError(res, 500, 'planned test failure')
          return
        }
        expect(input.objects.length).toBeLessThanOrEqual(2)
        batchIndex += 1
        writeTrpc(res, {
          batchId: `batch-${batchIndex}`,
          missingObjectIds: input.objects.map((object) => object.objectId),
          uploadUrlTemplate: '/objects/:objectId',
        })
        return
      }
      if (url.pathname === '/trpc/sync.commitUpload') {
        const input = (await readJson(req)) as CommitUploadInput
        expect(input.objects.length).toBeLessThanOrEqual(2)
        const rowCount = projectionRowCount(input)
        expect(rowCount).toBeLessThanOrEqual(2)
        const batchObjectIds = input.objects.map((object) => object.objectId)
        const objectsAvailableForCommit = new Set([...availableObjectIds, ...batchObjectIds])
        const batchSourceFileIds = new Set(input.projection.sourceFiles.map((row) => row.id))
        const batchSessionIds = new Set(input.projection.sessions.map((row) => row.id))
        const batchMessageIds = new Set(input.projection.messages.map((row) => row.id))
        const batchToolCallIds = new Set(input.projection.toolCalls.map((row) => row.id))
        const sourceFilesAvailableForCommit = new Set([...availableSourceFileIds, ...batchSourceFileIds])
        const sessionsAvailableForCommit = new Set([...availableSessionIds, ...batchSessionIds])
        const messagesAvailableForCommit = new Set([...availableMessageIds, ...batchMessageIds])
        const toolCallsAvailableForCommit = new Set([...availableToolCallIds, ...batchToolCallIds])
        for (const sourceFile of input.projection.sourceFiles) {
          expect(sourceFile.objectId == null || objectsAvailableForCommit.has(sourceFile.objectId)).toBe(true)
        }
        for (const rawRecord of input.projection.rawRecords) {
          expect(rawRecord.objectId == null || objectsAvailableForCommit.has(rawRecord.objectId)).toBe(true)
          expect(sourceFilesAvailableForCommit.has(rawRecord.sourceFileId)).toBe(true)
        }
        for (const sessionChild of [
          ...input.projection.messages,
          ...input.projection.events,
          ...input.projection.searchDocs,
          ...input.projection.toolCalls,
        ]) {
          expect(sessionsAvailableForCommit.has(sessionChild.sessionId)).toBe(true)
        }
        for (const artifact of input.projection.artifacts) {
          expect(artifact.objectId == null || objectsAvailableForCommit.has(artifact.objectId)).toBe(true)
          expect(artifact.sessionId == null || sessionsAvailableForCommit.has(artifact.sessionId)).toBe(true)
        }
        for (const contentBlock of input.projection.contentBlocks) {
          expect(contentBlock.objectId == null || objectsAvailableForCommit.has(contentBlock.objectId)).toBe(true)
          expect(messagesAvailableForCommit.has(contentBlock.messageId)).toBe(true)
        }
        for (const toolCall of input.projection.toolCalls) {
          expect(toolCall.inputObjectId == null || objectsAvailableForCommit.has(toolCall.inputObjectId)).toBe(true)
        }
        for (const toolResult of input.projection.toolResults) {
          expect(toolResult.outputObjectId == null || objectsAvailableForCommit.has(toolResult.outputObjectId)).toBe(
            true,
          )
          expect(toolCallsAvailableForCommit.has(toolResult.toolCallId)).toBe(true)
        }
        for (const objectId of batchObjectIds) availableObjectIds.add(objectId)
        for (const sourceFileId of batchSourceFileIds) availableSourceFileIds.add(sourceFileId)
        for (const sessionId of batchSessionIds) availableSessionIds.add(sessionId)
        for (const messageId of batchMessageIds) availableMessageIds.add(messageId)
        for (const toolCallId of batchToolCallIds) availableToolCallIds.add(toolCallId)
        commits.push({
          objectCount: input.objects.length,
          rowCount,
          sourceFileCount: input.projection.sourceFiles.length,
          sessionCount: input.projection.sessions.length,
          rawRecordCount: input.projection.rawRecords.length,
        })
        writeTrpc(res, { batchId: input.batchId, committedObjects: input.objects.length, committedRows: rowCount })
        return
      }
      if (url.pathname === '/trpc/sync.verifyPromotion') {
        const input = (await readJson(req)) as VerifyPromotionInput
        verifyRequestCount += 1
        verifyRequests.count = verifyRequestCount
        if (!failedVerify && options.failVerifyOnceAt === verifyRequestCount) {
          failedVerify = true
          writeError(res, 500, 'planned verify failure')
          return
        }
        writeTrpc(res, {
          receipt: {
            batchId: input.batchId,
            tenantId: 'tenant-chunked-test',
            deviceId: 'device-chunked-test',
            storePath: input.storePath,
            manifestHash: `manifest-${input.batchId}`,
            sessionCount: input.declaredSessionIds.length,
            objectCount: input.declaredObjectIds.length,
            searchDocCount: input.declaredSearchDocIds.length,
            batchObjectCount: input.declaredObjectIds.length,
            batchSourceFileCount: input.declaredSourceFileIds.length,
            batchRawRecordCount: input.declaredRawRecordIds.length,
            batchSessionCount: input.declaredSessionIds.length,
            batchSearchDocCount: input.declaredSearchDocIds.length,
            batchToolCallCount: input.declaredToolCallIds.length,
            batchToolResultCount: input.declaredToolResultIds.length,
            declaredObjectsVerified: input.declaredObjectIds.length,
            declaredSourceFilesVerified: input.declaredSourceFileIds.length,
            declaredRawRecordsVerified: input.declaredRawRecordIds.length,
            declaredSessionsVerified: input.declaredSessionIds.length,
            declaredSearchDocsVerified: input.declaredSearchDocIds.length,
            declaredToolCallsVerified: input.declaredToolCallIds.length,
            declaredToolResultsVerified: input.declaredToolResultIds.length,
            cleanupEligible: false,
            verifiedAt: '2026-05-16T00:00:00.000Z',
          },
          sampledSessions: [],
        })
        return
      }
      writeError(res, 404, 'not found')
    } catch (error) {
      writeError(res, 500, error instanceof Error ? error.message : 'unknown test server error')
    }
  })

  const baseUrl = await listen(server)
  await saveCliConfig(
    {
      activeServer: baseUrl,
      servers: {
        [baseUrl]: {
          url: baseUrl,
          token: 'token-chunked-test',
          activeTenant: { id: 'tenant-chunked-test', name: 'Chunked Test', slug: 'chunked-test' },
        },
      },
    },
    configPath,
  )

  return {
    baseUrl,
    configPath,
    stateHome,
    storePath,
    commits,
    objectUploads,
    verifyRequests,
    close: async () => {
      await closeServer(server)
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

describe('CLI chunked sync batching', () => {
  let h: Harness

  async function replaceHarness(options: HarnessOptions): Promise<void> {
    await h.close()
    h = await bootHarness(options)
    process.env.PROSA_CONFIG_PATH = h.configPath
    process.env.PROSA_STATE_HOME = h.stateHome
  }

  beforeEach(async () => {
    h = await bootHarness()
    process.env.PROSA_CONFIG_PATH = h.configPath
    process.env.PROSA_STATE_HOME = h.stateHome
  })
  afterEach(async () => {
    process.env.PROSA_CONFIG_PATH = undefined
    process.env.PROSA_STATE_HOME = undefined
    await h.close()
  })

  it('mixes CAS objects and projection rows in the same chunked commits', async () => {
    const out = await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])
    const payload = JSON.parse(out.stdout) as { ok: boolean; chunked: boolean; batchCount: number }

    expect(payload.ok).toBe(true)
    expect(payload.chunked).toBe(true)
    expect(payload.batchCount).toBe(3)
    expect(h.commits).toEqual([
      { objectCount: 2, rowCount: 2, sourceFileCount: 2, sessionCount: 0, rawRecordCount: 0 },
      { objectCount: 1, rowCount: 2, sourceFileCount: 1, sessionCount: 1, rawRecordCount: 0 },
      { objectCount: 0, rowCount: 2, sourceFileCount: 0, sessionCount: 2, rawRecordCount: 0 },
    ])
    expect(h.objectUploads).toEqual({ packs: 2, puts: 0 })
  })

  it('waits for parent source files before committing raw records', async () => {
    await replaceHarness({ bundleFactory: createDependentRawRecordBundle })

    const out = await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])
    const payload = JSON.parse(out.stdout) as { ok: boolean; chunked: boolean; batchCount: number }

    expect(payload.ok).toBe(true)
    expect(payload.chunked).toBe(true)
    expect(payload.batchCount).toBe(2)
    expect(h.commits).toEqual([
      { objectCount: 2, rowCount: 0, sourceFileCount: 0, sessionCount: 0, rawRecordCount: 0 },
      { objectCount: 2, rowCount: 2, sourceFileCount: 1, sessionCount: 0, rawRecordCount: 1 },
    ])
  })

  it('resumes chunked sync by skipping chunks that already verified', async () => {
    await replaceHarness({ failPlanOnceAt: 3 })

    await expect(capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])).rejects.toThrow(
      /planned test failure/,
    )
    expect(h.commits).toEqual([
      { objectCount: 2, rowCount: 2, sourceFileCount: 2, sessionCount: 0, rawRecordCount: 0 },
      { objectCount: 1, rowCount: 2, sourceFileCount: 1, sessionCount: 1, rawRecordCount: 0 },
    ])

    const out = await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])
    const payload = JSON.parse(out.stdout) as { ok: boolean; chunked: boolean; batchCount: number }

    expect(payload.ok).toBe(true)
    expect(payload.chunked).toBe(true)
    expect(payload.batchCount).toBe(3)
    expect(h.commits).toEqual([
      { objectCount: 2, rowCount: 2, sourceFileCount: 2, sessionCount: 0, rawRecordCount: 0 },
      { objectCount: 1, rowCount: 2, sourceFileCount: 1, sessionCount: 1, rawRecordCount: 0 },
      { objectCount: 0, rowCount: 2, sourceFileCount: 0, sessionCount: 2, rawRecordCount: 0 },
    ])
  })

  it('retries a transient verifyPromotion failure before checkpointing chunks', async () => {
    await replaceHarness({ failVerifyOnceAt: 1 })

    await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])

    expect(h.commits).toEqual([
      { objectCount: 2, rowCount: 2, sourceFileCount: 2, sessionCount: 0, rawRecordCount: 0 },
      { objectCount: 1, rowCount: 2, sourceFileCount: 1, sessionCount: 1, rawRecordCount: 0 },
      { objectCount: 0, rowCount: 2, sourceFileCount: 0, sessionCount: 2, rawRecordCount: 0 },
    ])
    expect(h.verifyRequests.count).toBe(4)
  })

  it('supports disabling and resetting chunked sync checkpoints', async () => {
    await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])
    expect(h.commits).toHaveLength(3)

    await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--json'])
    expect(h.commits).toHaveLength(3)

    await capturedRun(['v1', 'sync', '--server', h.baseUrl, '--store', h.storePath, '--no-resume', '--json'])
    expect(h.commits).toHaveLength(6)

    await capturedRun([
      'v1',
      'sync',
      '--server',
      h.baseUrl,
      '--store',
      h.storePath,
      '--reset-sync-checkpoint',
      '--json',
    ])
    expect(h.commits).toHaveLength(9)
  })
})
