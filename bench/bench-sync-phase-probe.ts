import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import {
  type ObjectMeta,
  PUT_PREVERIFIED_BYTES,
  type PutMeta,
  type PutResult,
  type RemoteObjectStore,
  MemoryObjectStore,
  computeHashHex,
} from '../packages/prosa-storage/src/index.ts'
import { buildApp, createAuth, loadConfig, openPgliteDatabase } from '../apps/api/src/index.ts'
import { applySchema } from '../packages/prosa-db/src/index.ts'
import type { ObjectManifestEntry, ProjectionPayload } from '../packages/prosa-sync/src/index.ts'

type Phase =
  | 'boot'
  | 'auth'
  | 'handshake'
  | 'cold-plan'
  | 'cold-put'
  | 'cold-commit'
  | 'cold-commit-replay'
  | 'cold-verify'
  | 'warm-plan'
  | 'warm-commit'
  | 'warm-verify'

type Options = {
  objects: number
  sessions: number
  objectBytes: number
  output?: string
}

type SqlStat = {
  calls: number
  totalMs: number
}

type ObjectStoreStats = Record<string, number>

type PhaseReport = {
  wallMs: number
  sqlCalls: number
  sqlMs: number
  objectStore: ObjectStoreStats
  topSql: Array<{ calls: number; totalMs: number; sql: string }>
}

type Report = {
  createdAt: string
  options: Options
  rowCounts: Record<keyof ProjectionPayload, number>
  phases: Record<Phase, PhaseReport>
  derived: {
    coldSqlCallsPerObject: number
    coldSqlCallsPerProjectionRow: number
    warmPlanMissingObjects: number
    coldCommittedRows: number
    warmCommittedRows: number
  }
  caveats: string[]
}

type SignupResult = {
  token: string
  tenant: { id: string }
}

function parseArgs(argv: string[]): Options {
  const opts: Options = {
    objects: 100,
    sessions: 50,
    objectBytes: 256,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (!value) throw new Error(`missing value for ${arg}`)
      i += 1
      return value
    }
    switch (arg) {
      case '--objects':
        opts.objects = positiveInt(arg, next())
        break
      case '--sessions':
        opts.sessions = positiveInt(arg, next())
        break
      case '--object-bytes':
        opts.objectBytes = positiveInt(arg, next())
        break
      case '--output':
        opts.output = next()
        break
      case '--help':
        process.stdout.write(`Usage:
  node --conditions=prosa-dev --import @swc-node/register/esm-register \\
    bench/bench-sync-phase-probe.ts [options]

Options:
  --objects <n>       Synthetic CAS objects to declare and upload (default: 100)
  --sessions <n>      Synthetic sessions; emits all projection row types per session (default: 50)
  --object-bytes <n>  Bytes per synthetic object payload (default: 256)
  --output <path>     Write JSON report to this path instead of stdout
`)
        process.exit(0)
      default:
        throw new Error(`unknown argument: ${arg}`)
    }
  }
  return opts
}

function positiveInt(flag: string, value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} must be a positive integer`)
  }
  return parsed
}

function makePayload(index: number, size: number): Buffer {
  const bytes = Buffer.alloc(size, index % 251)
  bytes.write(`prosa-sync-phase-probe:${index}:`, 0, 'utf8')
  return bytes
}

function makeObjects(count: number, objectBytes: number): Array<{ entry: ObjectManifestEntry; bytes: Buffer }> {
  return Array.from({ length: count }, (_, index) => {
    const bytes = makePayload(index, objectBytes)
    const hash = computeHashHex(bytes, 'blake3')
    return {
      bytes,
      entry: {
        objectId: `blake3:${hash}`,
        hash,
        hashAlgorithm: 'blake3',
        uncompressedSize: bytes.byteLength,
        compressedSize: bytes.byteLength,
        compression: 'none',
        transportHash: hash,
        contentType: 'application/octet-stream',
      },
    }
  })
}

function makeProjection(sessionCount: number, objects: ObjectManifestEntry[]): ProjectionPayload {
  const projection: ProjectionPayload = {
    sourceFiles: [],
    rawRecords: [],
    sessions: [],
    searchDocs: [],
    toolCalls: [],
    toolResults: [],
    messages: [],
    contentBlocks: [],
    events: [],
    artifacts: [],
  }
  for (let i = 0; i < sessionCount; i += 1) {
    const object = objects[i % objects.length] as ObjectManifestEntry
    const stamp = new Date(Date.UTC(2026, 0, 1, 0, 0, i % 60)).toISOString()
    projection.sourceFiles.push({
      id: `sf-${i}`,
      sourceKind: 'codex',
      path: `/synthetic/${i}.jsonl`,
      objectId: object.objectId,
      metadata: { fixture: 'sync-phase-probe' },
    })
    projection.rawRecords.push({
      id: `rr-${i}`,
      sourceFileId: `sf-${i}`,
      sequence: i,
      payload: { index: i, importBatchId: `ignored-${i}` },
      objectId: object.objectId,
    })
    projection.sessions.push({
      id: `sess-${i}`,
      sourceKind: 'codex',
      title: `synthetic session ${i}`,
      startedAt: stamp,
      endedAt: stamp,
      turnCount: 2,
      metadata: { index: i },
    })
    projection.searchDocs.push({
      id: `doc-${i}`,
      sessionId: `sess-${i}`,
      kind: 'session',
      body: `sync benchmark searchable body ${i}`,
    })
    projection.toolCalls.push({
      id: `tc-${i}`,
      sessionId: `sess-${i}`,
      name: 'shell.exec',
      status: 'ok',
      inputObjectId: object.objectId,
      createdAt: stamp,
    })
    projection.toolResults.push({
      id: `tr-${i}`,
      toolCallId: `tc-${i}`,
      outputObjectId: object.objectId,
      status: 'ok',
      finishedAt: stamp,
    })
    projection.messages.push({
      id: `msg-${i}`,
      sessionId: `sess-${i}`,
      role: i % 2 === 0 ? 'user' : 'assistant',
      model: 'synthetic',
      createdAt: stamp,
    })
    projection.contentBlocks.push({
      id: `blk-${i}`,
      messageId: `msg-${i}`,
      sequence: 0,
      kind: 'text',
      text: `content block ${i}`,
      objectId: null,
      metadata: { index: i },
    })
    projection.events.push({
      id: `ev-${i}`,
      sessionId: `sess-${i}`,
      sequence: i,
      kind: 'message',
      payload: { messageId: `msg-${i}` },
      occurredAt: stamp,
    })
    projection.artifacts.push({
      id: `art-${i}`,
      sessionId: `sess-${i}`,
      kind: 'file',
      objectId: object.objectId,
      sizeBytes: object.uncompressedSize,
      metadata: { path: `/tmp/art-${i}.txt` },
    })
  }
  return projection
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

function createPhaseReports() {
  const reports = new Map<Phase, { startedAt: number; wallMs: number; sql: Map<string, SqlStat>; objectStore: ObjectStoreStats }>()
  const ensure = (phase: Phase) => {
    const existing = reports.get(phase)
    if (existing) return existing
    const created = {
      startedAt: 0,
      wallMs: 0,
      sql: new Map<string, SqlStat>(),
      objectStore: { head: 0, putIfAbsent: 0, putPreverified: 0, get: 0, getRange: 0, delete: 0 },
    }
    reports.set(phase, created)
    return created
  }
  return { reports, ensure }
}

class CountingObjectStore implements RemoteObjectStore {
  constructor(
    private readonly inner: MemoryObjectStore,
    private readonly phase: () => Phase,
    private readonly ensure: ReturnType<typeof createPhaseReports>['ensure'],
  ) {}

  async head(key: string): Promise<ObjectMeta | null> {
    this.ensure(this.phase()).objectStore.head += 1
    return this.inner.head(key)
  }

  async putIfAbsent(key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    this.ensure(this.phase()).objectStore.putIfAbsent += 1
    return this.inner.putIfAbsent(key, bytes, meta)
  }

  async [PUT_PREVERIFIED_BYTES](key: string, bytes: AsyncIterable<Uint8Array>, meta: PutMeta): Promise<PutResult> {
    this.ensure(this.phase()).objectStore.putPreverified += 1
    return this.inner[PUT_PREVERIFIED_BYTES](key, bytes, meta)
  }

  async get(key: string): Promise<ReadableStream<Uint8Array>> {
    this.ensure(this.phase()).objectStore.get += 1
    return this.inner.get(key)
  }

  async getRange(key: string, offset: number, length: number): Promise<ReadableStream<Uint8Array>> {
    this.ensure(this.phase()).objectStore.getRange += 1
    return this.inner.getRange(key, offset, length)
  }

  async delete(key: string): Promise<void> {
    this.ensure(this.phase()).objectStore.delete += 1
    return this.inner.delete(key)
  }
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2))
  if (opts.sessions * 10 > 10_000) {
    throw new Error('--sessions is too high for one commit; each session emits 10 projection rows')
  }

  const requireFromApi = createRequire(new URL('../apps/api/package.json', import.meta.url))
  const { PGlite } = await import(requireFromApi.resolve('@electric-sql/pglite'))
  const { reports, ensure } = createPhaseReports()
  let currentPhase: Phase = 'boot'
  const pglite = new PGlite()
  await applySchema(pglite)
  const dbHandle = openPgliteDatabase(pglite)
  const trackedRawExec = async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<Row[]> => {
    const phase = ensure(currentPhase)
    const key = normalizeSql(sql)
    const started = performance.now()
    try {
      return await dbHandle.rawExec<Row>(sql, params)
    } finally {
      const elapsed = performance.now() - started
      const stat = phase.sql.get(key) ?? { calls: 0, totalMs: 0 }
      stat.calls += 1
      stat.totalMs += elapsed
      phase.sql.set(key, stat)
    }
  }
  const trackedTransaction = async <T>(fn: Parameters<typeof dbHandle.transaction<T>>[0]): Promise<T> =>
    dbHandle.transaction(async (tx) =>
      fn(async <Row = Record<string, unknown>>(sql: string, params: unknown[] = []) => {
        const phase = ensure(currentPhase)
        const key = normalizeSql(sql)
        const started = performance.now()
        try {
          return await tx<Row>(sql, params)
        } finally {
          const elapsed = performance.now() - started
          const stat = phase.sql.get(key) ?? { calls: 0, totalMs: 0 }
          stat.calls += 1
          stat.totalMs += elapsed
          phase.sql.set(key, stat)
        }
      }),
    )

  const config = loadConfig({
    PROSA_RUNTIME_MODE: 'test',
    PROSA_OBJECT_STORE_DRIVER: 'memory',
    PROSA_AUTH_SECRET: 'test-secret-1234567890abcdef123456',
    PROSA_API_URL: 'http://127.0.0.1:0',
  } as NodeJS.ProcessEnv)
  const auth = createAuth({ config, db: dbHandle.db })
  const objectStore = new CountingObjectStore(new MemoryObjectStore(), () => currentPhase, ensure)
  const app = await buildApp({
    config,
    auth,
    db: dbHandle.db,
    rawExec: trackedRawExec,
    transaction: trackedTransaction,
    objectStore,
    loggerEnabled: false,
  })

  try {
    const runPhase = async <T>(phase: Phase, fn: () => Promise<T>): Promise<T> => {
      currentPhase = phase
      const report = ensure(phase)
      report.startedAt = performance.now()
      try {
        return await fn()
      } finally {
        report.wallMs += performance.now() - report.startedAt
      }
    }

    const objects = makeObjects(opts.objects, opts.objectBytes)
    const objectEntries = objects.map((object) => object.entry)
    const projection = makeProjection(opts.sessions, objectEntries)
    const storePath = '/tmp/prosa-sync-phase-probe'

    const signup = await runPhase('auth', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/trpc/auth.signupWithTenant',
        headers: { 'content-type': 'application/json' },
        payload: {
          email: `sync-phase-probe-${Date.now()}@example.com`,
          password: 'correct-horse-battery',
          name: 'Sync Phase Probe',
          tenantName: 'Sync Phase Probe',
          tenantSlug: `sync-phase-probe-${Date.now()}`,
        },
      })
      if (response.statusCode !== 200) throw new Error(response.body)
      return (response.json() as { result: { data: SignupResult } }).result.data
    })

    const authHeaders = {
      authorization: `Bearer ${signup.token}`,
      'x-prosa-tenant-id': signup.tenant.id,
    }

    const deviceId = await runPhase('handshake', async () => {
      const response = await trpc(app, 'sync.handshake', authHeaders, {
        cliVersion: '0.0.0-bench',
        device: { name: 'phase-probe', platform: process.platform },
        store: { path: storePath, bundleVersion: '1' },
      })
      return response.deviceId as string
    })

    const coldPlan = await runPhase('cold-plan', () =>
      trpc(app, 'sync.planUpload', authHeaders, { deviceId, storePath, objects: objectEntries }),
    )
    const coldBatchId = String(coldPlan.batchId)

    await runPhase('cold-put', async () => {
      await Promise.all(
        objects.map((object) =>
          app.inject({
            method: 'PUT',
            url:
              `/objects/${object.entry.objectId}?batchId=${coldBatchId}&hash=${object.entry.hash}` +
              `&size=${object.bytes.byteLength}&uncompressed=${object.bytes.byteLength}&compression=none`,
            headers: {
              ...authHeaders,
              'content-type': 'application/octet-stream',
            },
            payload: object.bytes,
          }).then((response) => {
            if (response.statusCode !== 200 && response.statusCode !== 201) {
              throw new Error(response.body)
            }
          }),
        ),
      )
    })

    const coldCommitInput = {
      batchId: coldBatchId,
      deviceId,
      storePath,
      objects: objectEntries,
      projection,
    }
    const coldCommit = await runPhase('cold-commit', () =>
      trpc(app, 'sync.commitUpload', { ...authHeaders, 'idempotency-key': `phase-probe:${coldBatchId}` }, coldCommitInput),
    )
    await runPhase('cold-commit-replay', () =>
      trpc(app, 'sync.commitUpload', { ...authHeaders, 'idempotency-key': `phase-probe:${coldBatchId}` }, coldCommitInput),
    )
    await runPhase('cold-verify', () => verify(app, authHeaders, coldBatchId, storePath, projection, objectEntries))

    const warmPlan = await runPhase('warm-plan', () =>
      trpc(app, 'sync.planUpload', authHeaders, { deviceId, storePath, objects: objectEntries }),
    )
    const warmBatchId = String(warmPlan.batchId)
    const warmCommit = await runPhase('warm-commit', () =>
      trpc(
        app,
        'sync.commitUpload',
        { ...authHeaders, 'idempotency-key': `phase-probe:${warmBatchId}` },
        { batchId: warmBatchId, deviceId, storePath, objects: objectEntries, projection },
      ),
    )
    await runPhase('warm-verify', () => verify(app, authHeaders, warmBatchId, storePath, projection, objectEntries))

    const report = buildReport(opts, reports, projection, {
      warmPlanMissingObjects: (warmPlan.missingObjectIds as unknown[]).length,
      coldCommittedRows: coldCommit.committedRows as number,
      warmCommittedRows: warmCommit.committedRows as number,
    })
    const json = `${JSON.stringify(report, null, 2)}\n`
    if (opts.output) {
      await writeFile(opts.output, json)
      process.stdout.write(`wrote ${opts.output}\n`)
    } else {
      process.stdout.write(json)
    }
  } finally {
    await app.close()
    await pglite.close()
  }
}

async function trpc(
  app: Awaited<ReturnType<typeof buildApp>>,
  path: string,
  headers: Record<string, string>,
  input: unknown,
): Promise<Record<string, unknown>> {
  const response = await app.inject({
    method: 'POST',
    url: `/trpc/${path}`,
    headers: { ...headers, 'content-type': 'application/json' },
    payload: input as never,
  })
  if (response.statusCode !== 200) {
    throw new Error(response.body)
  }
  return (response.json() as { result: { data: Record<string, unknown> } }).result.data
}

async function verify(
  app: Awaited<ReturnType<typeof buildApp>>,
  headers: Record<string, string>,
  batchId: string,
  storePath: string,
  projection: ProjectionPayload,
  objects: ObjectManifestEntry[],
): Promise<Record<string, unknown>> {
  return trpc(app, 'sync.verifyPromotion', headers, {
    batchId,
    storePath,
    declaredObjectIds: objects.map((object) => object.objectId),
    declaredSourceFileIds: projection.sourceFiles.map((row) => row.id),
    declaredRawRecordIds: projection.rawRecords.map((row) => row.id),
    declaredSessionIds: projection.sessions.map((row) => row.id),
    declaredSearchDocIds: projection.searchDocs.map((row) => row.id),
    declaredToolCallIds: projection.toolCalls.map((row) => row.id),
    declaredToolResultIds: projection.toolResults.map((row) => row.id),
    declaredMessageIds: projection.messages.map((row) => row.id),
    declaredContentBlockIds: projection.contentBlocks.map((row) => row.id),
    declaredEventIds: projection.events.map((row) => row.id),
    declaredArtifactIds: projection.artifacts.map((row) => row.id),
  })
}

function buildReport(
  opts: Options,
  reports: Map<Phase, { wallMs: number; sql: Map<string, SqlStat>; objectStore: ObjectStoreStats }>,
  projection: ProjectionPayload,
  derived: Pick<Report['derived'], 'warmPlanMissingObjects' | 'coldCommittedRows' | 'warmCommittedRows'>,
): Report {
  const phaseReports = {} as Record<Phase, PhaseReport>
  const phaseNames: Phase[] = [
    'boot',
    'auth',
    'handshake',
    'cold-plan',
    'cold-put',
    'cold-commit',
    'cold-commit-replay',
    'cold-verify',
    'warm-plan',
    'warm-commit',
    'warm-verify',
  ]
  for (const phase of phaseNames) {
    const report = reports.get(phase)
    const sqlEntries = Array.from(report?.sql.entries() ?? [])
    const sqlCalls = sqlEntries.reduce((sum, [, stat]) => sum + stat.calls, 0)
    const sqlMs = sqlEntries.reduce((sum, [, stat]) => sum + stat.totalMs, 0)
    phaseReports[phase] = {
      wallMs: round(report?.wallMs ?? 0),
      sqlCalls,
      sqlMs: round(sqlMs),
      objectStore: report?.objectStore ?? {},
      topSql: sqlEntries
        .sort((a, b) => b[1].totalMs - a[1].totalMs)
        .slice(0, 8)
        .map(([sql, stat]) => ({ calls: stat.calls, totalMs: round(stat.totalMs), sql })),
    }
  }
  const projectionRows = Object.values(projection).reduce((sum, rows) => sum + rows.length, 0)
  const coldSqlCalls =
    phaseReports['cold-plan'].sqlCalls +
    phaseReports['cold-put'].sqlCalls +
    phaseReports['cold-commit'].sqlCalls +
    phaseReports['cold-verify'].sqlCalls
  return {
    createdAt: new Date().toISOString(),
    options: opts,
    rowCounts: Object.fromEntries(
      Object.entries(projection).map(([name, rows]) => [name, rows.length]),
    ) as Record<keyof ProjectionPayload, number>,
    phases: phaseReports,
    derived: {
      ...derived,
      coldSqlCallsPerObject: round(coldSqlCalls / opts.objects),
      coldSqlCallsPerProjectionRow: round(coldSqlCalls / projectionRows),
    },
    caveats: [
      'Uses in-process Fastify inject, PGlite, and MemoryObjectStore; use Docker/Postgres/MinIO for wall-time claims.',
      'Counts rawExec SQL used by sync/context code; Better Auth Drizzle queries are not included in sqlCalls.',
      'Per-query sqlMs can exceed phase wallMs when concurrent requests overlap.',
      'Synthetic projection emits all ten projection entity types per session, so row mix may differ from a real bundle.',
    ],
  }
}

function round(value: number): number {
  return Math.round(value * 100) / 100
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`)
  process.exitCode = 1
})
