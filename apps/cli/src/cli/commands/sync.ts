import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { type Bundle, closeBundle, defaultBundlePath, openBundle } from '@c3-oss/prosa-core'
import { computeHashHex } from '@c3-oss/prosa-storage'
import type {
  ObjectManifestEntry,
  ProjectionPayload,
  ProjectionSessionRow,
  ProjectionToolCallRow,
  ProjectionToolResultRow,
  PromotionReceipt,
  RawRecordRow,
  SearchDocRow,
  SourceFileRow,
} from '@c3-oss/prosa-sync'
import { Command } from 'commander'
import { ProsaApiClient } from '../auth/client.js'
import {
  type ProsaServerEntry,
  activeEntry,
  defaultConfigPath,
  isPromoted,
  loadCliConfig,
  recordPromotion,
  saveCliConfig,
  upsertServer,
} from '../auth/config.js'
import { CliUserError } from '../errors.js'
import { emitStatus } from '../ink/messages.js'
import { type SyncProgressHandle, startSyncProgress } from '../ink/sync-progress.js'
import { readBundleForUpload } from '../sync/bundle.js'
import {
  estimateChunkedUploadBatches,
  readUploadCounts,
  uploadHardLimitViolations,
  uploadLimitViolations,
} from '../sync/limits.js'
import { promoteUpload, removeLocalBundle } from '../sync/promotion.js'

type SyncOptions = {
  server?: string
  tenant?: string
  store?: string
  dryRun?: boolean
  keepLocal?: boolean
  purgeBundle?: boolean
  json?: boolean
  verbose?: boolean
  configPath?: string
}

type SyncResult = {
  batchId: string
  sessionCount: number
  objectCount: number
  searchDocCount: number
  batchCount: number
  chunked: boolean
}

type LocalCasObjectChunk = {
  entry: ObjectManifestEntry
  bytes: Uint8Array
}

type ObjectChunk = {
  casObjects: LocalCasObjectChunk[]
  nextCursor: string | null
}

type ProjectionChunk<TEntity> = {
  rows: TEntity[]
  nextCursor: string | null
}

type ChunkedPromotionOptions = {
  client: ProsaApiClient
  deviceId: string
  storePath: string
  bundle: Bundle
  maxObjectsPerPlan: number
  maxRowsPerCommit: number
  verbose?: boolean
  /** Optional Ink progress sink; ignored when running headless. */
  progress?: SyncProgressHandle
  /** Total batches expected, used to drive the progress bar pct. */
  totalBatches?: number
}

type PromoteChunkOptions = {
  client: ProsaApiClient
  deviceId: string
  storePath: string
  casObjects: LocalCasObjectChunk[]
  projection: ProjectionPayload
  label: string
  verbose?: boolean
}

const OBJECT_UPLOAD_CONCURRENCY = 16

async function bundleManifestExists(storePath: string): Promise<boolean> {
  return stat(`${storePath}/manifest.json`).then(
    () => true,
    () => false,
  )
}

async function mapConcurrent<T>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = next
      next += 1
      const item = items[index]
      if (!item) return
      await worker(item, index)
    }
  })
  await Promise.all(workers)
}

function emptyProjection(): ProjectionPayload {
  return { sourceFiles: [], rawRecords: [], sessions: [], searchDocs: [], toolCalls: [], toolResults: [] }
}

function projectionRowCount(projection: ProjectionPayload): number {
  return (
    projection.sourceFiles.length +
    projection.rawRecords.length +
    projection.sessions.length +
    projection.searchDocs.length +
    projection.toolCalls.length +
    projection.toolResults.length
  )
}

function readObjectCatalogRows(bundle: Bundle, afterObjectId: string | null, limit: number) {
  type CatalogRow = {
    object_id: string
    hash: string
    size_bytes: number
    compressed_size_bytes: number | null
    compression: 'zstd' | 'none'
    mime_type: string | null
    storage_path: string
  }
  const sql = afterObjectId
    ? `SELECT object_id, hash, size_bytes, compressed_size_bytes, compression, mime_type, storage_path
         FROM objects
         WHERE object_id > ?
         ORDER BY object_id
         LIMIT ?`
    : `SELECT object_id, hash, size_bytes, compressed_size_bytes, compression, mime_type, storage_path
         FROM objects
         ORDER BY object_id
         LIMIT ?`
  return bundle.db.prepare(sql).all(...(afterObjectId ? [afterObjectId, limit] : [limit])) as CatalogRow[]
}

async function readObjectChunk(
  bundle: Bundle,
  storePath: string,
  afterObjectId: string | null,
  limit: number,
): Promise<ObjectChunk> {
  const rows = readObjectCatalogRows(bundle, afterObjectId, limit)
  const casObjects: LocalCasObjectChunk[] = []
  for (const row of rows) {
    const full = path.join(storePath, row.storage_path)
    const buf = await readFile(full)
    const bytes = new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    const transportHash = computeHashHex(bytes, 'blake3')
    const entry: ObjectManifestEntry = {
      objectId: row.object_id,
      hash: row.hash,
      hashAlgorithm: 'blake3',
      uncompressedSize: row.size_bytes,
      compressedSize: row.compressed_size_bytes ?? bytes.byteLength,
      compression: row.compression,
      transportHash,
    }
    if (row.mime_type) entry.contentType = row.mime_type
    casObjects.push({ entry, bytes })
  }
  return {
    casObjects,
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.object_id ?? null) : null,
  }
}

function readSourceFileChunk(bundle: Bundle, afterId: string | null, limit: number): ProjectionChunk<SourceFileRow> {
  const sql = afterId
    ? `SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id
         FROM source_files
         WHERE source_file_id > ?
         ORDER BY source_file_id
         LIMIT ?`
    : `SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id
         FROM source_files
         ORDER BY source_file_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    source_file_id: string
    source_tool: string
    path: string
    file_kind: string | null
    size_bytes: number | null
    mtime: string | null
    content_hash: string | null
    object_id: string | null
  }>
  return {
    rows: rows.map((row) => ({
      id: row.source_file_id,
      sourceKind: row.source_tool,
      path: row.path,
      objectId: row.object_id ?? null,
      metadata: {
        fileKind: row.file_kind,
        sizeBytes: row.size_bytes,
        mtime: row.mtime,
        contentHash: row.content_hash,
      },
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.source_file_id ?? null) : null,
  }
}

function readRawRecordChunk(bundle: Bundle, afterId: string | null, limit: number): ProjectionChunk<RawRecordRow> {
  const sql = afterId
    ? `SELECT raw_record_id, source_file_id, line_no, raw_object_id,
              decoded_json_object_id, parser_status, confidence, import_batch_id
         FROM raw_records
         WHERE raw_record_id > ?
         ORDER BY raw_record_id
         LIMIT ?`
    : `SELECT raw_record_id, source_file_id, line_no, raw_object_id,
              decoded_json_object_id, parser_status, confidence, import_batch_id
         FROM raw_records
         ORDER BY raw_record_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    raw_record_id: string
    source_file_id: string
    line_no: number | null
    raw_object_id: string
    decoded_json_object_id: string | null
    parser_status: string
    confidence: string
    import_batch_id: string
  }>
  return {
    rows: rows.map((row) => ({
      id: row.raw_record_id,
      sourceFileId: row.source_file_id,
      sequence: row.line_no ?? 0,
      payload: {
        decodedObjectId: row.decoded_json_object_id,
        parserStatus: row.parser_status,
        confidence: row.confidence,
        importBatchId: row.import_batch_id,
      },
      objectId: row.raw_object_id ?? null,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.raw_record_id ?? null) : null,
  }
}

function readSessionChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionSessionRow> {
  const sql = afterId
    ? `SELECT s.session_id, s.source_tool, s.project_id, s.title, s.start_ts, s.end_ts,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turn_count
         FROM sessions s
         WHERE s.session_id > ?
         ORDER BY s.session_id
         LIMIT ?`
    : `SELECT s.session_id, s.source_tool, s.project_id, s.title, s.start_ts, s.end_ts,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turn_count
         FROM sessions s
         ORDER BY s.session_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    session_id: string
    source_tool: string
    project_id: string | null
    title: string | null
    start_ts: string | null
    end_ts: string | null
    turn_count: number
  }>
  return {
    rows: rows.map((row) => ({
      id: row.session_id,
      sourceKind: row.source_tool,
      projectId: row.project_id,
      title: row.title,
      startedAt: row.start_ts,
      endedAt: row.end_ts,
      turnCount: row.turn_count,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.session_id ?? null) : null,
  }
}

function readSearchDocChunk(bundle: Bundle, afterId: string | null, limit: number): ProjectionChunk<SearchDocRow> {
  const sql = afterId
    ? `SELECT doc_id, session_id, entity_type, field_kind, text
         FROM search_docs
         WHERE session_id IS NOT NULL AND doc_id > ?
         ORDER BY doc_id
         LIMIT ?`
    : `SELECT doc_id, session_id, entity_type, field_kind, text
         FROM search_docs
         WHERE session_id IS NOT NULL
         ORDER BY doc_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    doc_id: string
    session_id: string
    entity_type: string
    field_kind: string
    text: string
  }>
  return {
    rows: rows.map((row) => ({
      id: row.doc_id,
      sessionId: row.session_id,
      kind: `${row.entity_type}/${row.field_kind}`,
      body: row.text,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.doc_id ?? null) : null,
  }
}

function readToolCallChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionToolCallRow> {
  const sql = afterId
    ? `SELECT tool_call_id, session_id, turn_id, tool_name, status, args_object_id, timestamp_start
         FROM tool_calls
         WHERE tool_call_id > ?
         ORDER BY tool_call_id
         LIMIT ?`
    : `SELECT tool_call_id, session_id, turn_id, tool_name, status, args_object_id, timestamp_start
         FROM tool_calls
         ORDER BY tool_call_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    tool_call_id: string
    session_id: string
    turn_id: string | null
    tool_name: string
    status: string | null
    args_object_id: string | null
    timestamp_start: string | null
  }>
  return {
    rows: rows.map((row) => ({
      id: row.tool_call_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      name: row.tool_name,
      status: row.status,
      inputObjectId: row.args_object_id,
      createdAt: row.timestamp_start,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.tool_call_id ?? null) : null,
  }
}

function readToolResultChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionToolResultRow> {
  const sql = afterId
    ? `SELECT r.tool_result_id, r.tool_call_id,
              COALESCE(r.output_object_id, r.stdout_object_id, r.stderr_object_id) AS output_object_id,
              COALESCE(r.status, CASE WHEN r.is_error <> 0 THEN 'error' ELSE NULL END) AS status,
              c.timestamp_end AS finished_at
         FROM tool_results r
         LEFT JOIN tool_calls c ON c.tool_call_id = r.tool_call_id
         WHERE r.tool_call_id IS NOT NULL AND r.tool_result_id > ?
         ORDER BY r.tool_result_id
         LIMIT ?`
    : `SELECT r.tool_result_id, r.tool_call_id,
              COALESCE(r.output_object_id, r.stdout_object_id, r.stderr_object_id) AS output_object_id,
              COALESCE(r.status, CASE WHEN r.is_error <> 0 THEN 'error' ELSE NULL END) AS status,
              c.timestamp_end AS finished_at
         FROM tool_results r
         LEFT JOIN tool_calls c ON c.tool_call_id = r.tool_call_id
         WHERE r.tool_call_id IS NOT NULL
         ORDER BY r.tool_result_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    tool_result_id: string
    tool_call_id: string
    output_object_id: string | null
    status: string | null
    finished_at: string | null
  }>
  return {
    rows: rows.map((row) => ({
      id: row.tool_result_id,
      toolCallId: row.tool_call_id,
      outputObjectId: row.output_object_id,
      status: row.status,
      finishedAt: row.finished_at,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.tool_result_id ?? null) : null,
  }
}

async function promoteChunk({
  client,
  deviceId,
  storePath,
  casObjects,
  projection,
  label,
  verbose,
}: PromoteChunkOptions): Promise<PromotionReceipt> {
  const objectEntries = casObjects.map((c) => c.entry)
  const plan = await client.syncPlanUpload({ deviceId, storePath, objects: objectEntries })
  if (verbose) {
    process.stdout.write(
      `plan ${label} • batchId=${plan.batchId} declaredObjects=${casObjects.length} missingObjects=${plan.missingObjectIds.length} rows=${projectionRowCount(projection)}\n`,
    )
  }

  const missingSet = new Set(plan.missingObjectIds)
  const missingObjects = casObjects.filter(({ entry }) => missingSet.has(entry.objectId))
  await mapConcurrent(missingObjects, OBJECT_UPLOAD_CONCURRENCY, async ({ entry: obj, bytes }) => {
    await client.uploadObjectBytes({
      batchId: plan.batchId,
      objectId: obj.objectId,
      hash: obj.hash,
      ...(obj.transportHash ? { transportHash: obj.transportHash } : {}),
      compression: obj.compression,
      compressedSize: obj.compressedSize,
      uncompressedSize: obj.uncompressedSize,
      bytes,
    })
  })

  const commit = await client.syncCommitUpload({
    batchId: plan.batchId,
    deviceId,
    storePath,
    objects: objectEntries,
    projection,
  })
  if (verbose) {
    process.stdout.write(`commit ${label} • objects=${commit.committedObjects} rows=${commit.committedRows}\n`)
  }

  const verify = await client.syncVerifyPromotion({
    batchId: plan.batchId,
    storePath,
    sampleSessionIds: projection.sessions.slice(0, 5).map((s) => s.id),
    declaredObjectIds: objectEntries.map((obj) => obj.objectId),
    declaredSourceFileIds: projection.sourceFiles.map((s) => s.id),
    declaredRawRecordIds: projection.rawRecords.map((r) => r.id),
    declaredSessionIds: projection.sessions.map((s) => s.id),
    declaredSearchDocIds: projection.searchDocs.map((d) => d.id),
    declaredToolCallIds: projection.toolCalls.map((c) => c.id),
    declaredToolResultIds: projection.toolResults.map((r) => r.id),
  })
  return verify.receipt
}

async function promoteChunkedUpload({
  client,
  deviceId,
  storePath,
  bundle,
  maxObjectsPerPlan,
  maxRowsPerCommit,
  verbose,
  progress,
  totalBatches,
}: ChunkedPromotionOptions): Promise<SyncResult> {
  let batchCount = 0
  let lastReceipt: PromotionReceipt | null = null
  let objectCursor: string | null = null
  const denominator = totalBatches && totalBatches > 0 ? totalBatches : 1
  const tickProgress = () => {
    progress?.setPhase({ kind: 'upload', completed: batchCount, total: denominator })
  }

  while (true) {
    const chunk = await readObjectChunk(bundle, storePath, objectCursor, maxObjectsPerPlan)
    if (chunk.casObjects.length === 0) break
    batchCount += 1
    tickProgress()
    lastReceipt = await promoteChunk({
      client,
      deviceId,
      storePath,
      casObjects: chunk.casObjects,
      projection: emptyProjection(),
      label: `object batch ${batchCount}`,
      verbose,
    })
    objectCursor = chunk.nextCursor
  }

  const promoteProjectionChunks = async <TRow>(
    label: string,
    readChunk: (afterId: string | null, limit: number) => ProjectionChunk<TRow>,
    toProjection: (rows: TRow[]) => ProjectionPayload,
  ) => {
    let cursor: string | null = null
    while (true) {
      const chunk = readChunk(cursor, maxRowsPerCommit)
      if (chunk.rows.length === 0) break
      batchCount += 1
      tickProgress()
      lastReceipt = await promoteChunk({
        client,
        deviceId,
        storePath,
        casObjects: [],
        projection: toProjection(chunk.rows),
        label: `${label} batch ${batchCount}`,
        verbose,
      })
      cursor = chunk.nextCursor
    }
  }

  await promoteProjectionChunks(
    'source-file',
    (cursor, limit) => readSourceFileChunk(bundle, cursor, limit),
    (sourceFiles) => ({ ...emptyProjection(), sourceFiles }),
  )
  await promoteProjectionChunks(
    'raw-record',
    (cursor, limit) => readRawRecordChunk(bundle, cursor, limit),
    (rawRecords) => ({ ...emptyProjection(), rawRecords }),
  )
  await promoteProjectionChunks(
    'session',
    (cursor, limit) => readSessionChunk(bundle, cursor, limit),
    (sessions) => ({ ...emptyProjection(), sessions }),
  )
  await promoteProjectionChunks(
    'search-doc',
    (cursor, limit) => readSearchDocChunk(bundle, cursor, limit),
    (searchDocs) => ({ ...emptyProjection(), searchDocs }),
  )
  await promoteProjectionChunks(
    'tool-call',
    (cursor, limit) => readToolCallChunk(bundle, cursor, limit),
    (toolCalls) => ({ ...emptyProjection(), toolCalls }),
  )
  await promoteProjectionChunks(
    'tool-result',
    (cursor, limit) => readToolResultChunk(bundle, cursor, limit),
    (toolResults) => ({ ...emptyProjection(), toolResults }),
  )

  if (!lastReceipt) {
    throw new CliUserError(`bundle at ${storePath} has no syncable rows or CAS objects`)
  }

  return {
    batchId: lastReceipt.batchId,
    sessionCount: 0,
    objectCount: 0,
    searchDocCount: 0,
    batchCount,
    chunked: true,
  }
}

export function syncCommand(): Command {
  const cmd = new Command('sync')
    .description(
      'Promote a local prosa bundle to the remote server. After successful verification ' +
        'derived artifacts (search/, parquet/, exports/) are removed by default; ' +
        'use --purge-bundle to also remove the canonical raw/CAS data, and ' +
        '--keep-local to skip cleanup entirely.',
    )
    .option('--server <url>', 'override the active server URL')
    .option('--tenant <id-or-slug>', 'override the active tenant')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--dry-run', 'plan only; do not upload bytes or modify state', false)
    .option('--keep-local', 'skip cleanup entirely (still marks remote-authoritative)', false)
    .option(
      '--purge-bundle',
      'also remove canonical raw/CAS data (objects/, raw/, prosa.sqlite, manifest.json). ' +
        'Only use after the remote receipt verifies the declared bundle contents.',
      false,
    )
    .option('--json', 'machine-readable JSON output', false)
    .option('--verbose', 'extra logging', false)
    .option('--config <path>', 'override CLI config path')
    .action(async (options: SyncOptions) => {
      const configPath = options.configPath ?? defaultConfigPath()
      const config = await loadCliConfig(configPath)
      const baseEntry = activeEntry(config)
      const server = options.server ?? baseEntry?.url
      if (!server) throw new CliUserError('no active server. Run `prosa auth login` first.')
      const entry: ProsaServerEntry =
        (baseEntry && baseEntry.url === server) || baseEntry == null ? (baseEntry ?? { url: server }) : { url: server }
      if (!entry.token) throw new CliUserError('not logged in. Run `prosa auth login`.')
      const tenantHint = options.tenant ?? entry.activeTenant?.id
      if (!tenantHint) {
        throw new CliUserError('no active tenant. Run `prosa auth use <tenant>` first.')
      }

      const client = new ProsaApiClient({ baseUrl: server, token: entry.token, tenantId: tenantHint })

      const storePath = path.resolve(options.store ?? defaultBundlePath())
      const exists = await bundleManifestExists(storePath)
      if (!exists) throw new CliUserError(`no prosa bundle at ${storePath}`)

      // Ink progress is suppressed for --json/--dry-run and headless contexts;
      // the imperative flow below drives phase transitions unconditionally,
      // and the inert handle no-ops when Ink isn't active.
      const progress = startSyncProgress({ json: options.json, quiet: options.dryRun })

      const bundle = await openBundle(storePath)
      let result: SyncResult
      try {
        progress.setPhase({ kind: 'handshake' })
        const handshake = await client.syncHandshake({
          cliVersion: process.env.npm_package_version ?? '0.0.0',
          protocolVersion: 1,
          device: { name: `${process.env.USER ?? 'cli'}-${process.platform}`, platform: process.platform },
          store: { path: storePath, bundleVersion: '1' },
        })

        if (options.verbose) {
          process.stdout.write(`handshake ok • deviceId=${handshake.deviceId} promoted=${handshake.promoted}\n`)
        }

        const counts = readUploadCounts(bundle, handshake.limits)
        const limitViolations = uploadLimitViolations(counts, handshake.limits)
        const hardLimitViolations = uploadHardLimitViolations(counts, handshake.limits)
        const estimatedBatches = estimateChunkedUploadBatches(counts, handshake.limits)

        if (options.dryRun) {
          const mode =
            hardLimitViolations.length > 0 ? 'blocked' : limitViolations.length > 0 ? 'chunked' : 'single-batch'
          const payload = {
            dryRun: true,
            mode,
            server,
            tenant: tenantHint,
            store: storePath,
            sessions: counts.sessions,
            searchDocs: counts.searchDocs,
            sourceFiles: counts.sourceFiles,
            rawRecords: counts.rawRecords,
            casObjects: counts.casObjects,
            limitViolations,
            estimatedBatches,
            cleanupEligible: limitViolations.length === 0,
          }
          process.stdout.write(
            options.json
              ? `${JSON.stringify(payload)}\n`
              : `[dry-run] would upload ${counts.sessions} sessions, ${counts.searchDocs} search docs, ${counts.sourceFiles} source files, ${counts.rawRecords} raw records, ${counts.casObjects} CAS objects from ${storePath} using ${mode}${mode === 'chunked' ? ` (~${estimatedBatches} batches; local cleanup disabled)` : ''}\n`,
          )
          return
        }

        if (hardLimitViolations.length > 0) {
          throw new CliUserError(
            `bundle contains objects that cannot be uploaded safely: ${hardLimitViolations.join('; ')}`,
          )
        }

        if (limitViolations.length > 0) {
          if (options.verbose) {
            process.stdout.write(
              `bundle exceeds single-batch limits; switching to chunked sync (~${estimatedBatches} batches). Local cleanup will be skipped.\n`,
            )
          }
          progress.setPhase({ kind: 'upload', completed: 0, total: estimatedBatches })
          result = await promoteChunkedUpload({
            client,
            deviceId: handshake.deviceId,
            storePath,
            bundle,
            maxObjectsPerPlan: handshake.limits.maxObjectsPerPlan,
            maxRowsPerCommit: handshake.limits.maxRowsPerCommit,
            verbose: options.verbose,
            progress,
            totalBatches: estimatedBatches,
          })
          result = {
            ...result,
            sessionCount: counts.sessions,
            objectCount: counts.casObjects,
            searchDocCount: counts.searchDocs,
          }
        } else {
          progress.setPhase({ kind: 'plan' })
          const upload = await readBundleForUpload(bundle, storePath)
          progress.setPhase({ kind: 'upload', completed: 0, total: 1 })
          const promotion = await promoteUpload({
            client,
            deviceId: handshake.deviceId,
            storePath,
            upload,
            verbose: options.verbose,
          })
          progress.setPhase({ kind: 'verify' })

          result = {
            batchId: promotion.batchId,
            sessionCount: promotion.sessionCount,
            objectCount: promotion.objectCount,
            searchDocCount: promotion.searchDocCount,
            batchCount: 1,
            chunked: false,
          }

          const nextEntry = recordPromotion(
            { ...entry, device: { id: handshake.deviceId, name: handshake.deviceId } },
            storePath,
            {
              batchId: promotion.batchId,
              tenantId: promotion.receipt.tenantId,
              promotedAt: promotion.receipt.verifiedAt,
              receipt: promotion.receipt,
            },
          )
          await saveCliConfig(upsertServer(config, nextEntry, true), configPath)
        }
      } catch (err) {
        await progress.stop()
        throw err
      } finally {
        closeBundle(bundle)
      }

      let removed: string[] = []
      if (!options.keepLocal && !result.chunked) {
        progress.setPhase({ kind: 'cleanup' })
        removed = await removeLocalBundle(storePath, Boolean(options.purgeBundle))
        await client
          .syncAckCleanup({ batchId: result.batchId, storePath, removedPaths: removed })
          .catch(() => undefined)
      }

      progress.setPhase({ kind: 'done' })
      await progress.stop()

      const tail = result.chunked
        ? `kept local bundle at ${storePath} (chunked sync uses per-batch receipts; cleanup disabled)\n`
        : options.keepLocal
          ? `kept local bundle at ${storePath} (marked remote-authoritative)\n`
          : `removed ${removed.length} local paths under ${storePath}\n`
      const plain = options.json
        ? `${JSON.stringify({
            ok: true,
            server,
            tenant: tenantHint,
            store: storePath,
            ...result,
            removedLocalPaths: removed,
            keptLocal: Boolean(options.keepLocal) || result.chunked,
            cleanupSkippedReason: result.chunked
              ? 'chunked sync uses per-batch receipts; local cleanup is disabled'
              : null,
          })}\n`
        : `sync ok • batch=${result.batchId} batches=${result.batchCount} mode=${result.chunked ? 'chunked' : 'single-batch'} sessions=${result.sessionCount} searchDocs=${result.searchDocCount}\n${tail}`
      await emitStatus({
        json: options.json,
        variant: 'success',
        message: `sync ok • batch=${result.batchId} batches=${result.batchCount} mode=${result.chunked ? 'chunked' : 'single-batch'} sessions=${result.sessionCount} searchDocs=${result.searchDocCount}`,
        plain,
      })
    })

  cmd
    .command('status')
    .description('Show local bundle / promotion state for the active server.')
    .option('--store <path>', 'bundle directory', defaultBundlePath())
    .option('--json', 'machine-readable output', false)
    .action(async (options) => {
      const opts = cmd.opts<SyncOptions>()
      const configPath = opts.configPath ?? defaultConfigPath()
      const config = await loadCliConfig(configPath)
      const entry = activeEntry(config)
      if (!entry) {
        process.stdout.write('not logged in\n')
        return
      }
      const storePath = path.resolve(options.store ?? defaultBundlePath())
      const local = await bundleManifestExists(storePath)
      const promoted = isPromoted(entry, storePath)
      const payload = {
        server: entry.url,
        store: storePath,
        localBundleExists: local,
        promoted,
        receipt: entry.promotions?.[storePath]?.receipt ?? null,
      }
      if (options.json) {
        process.stdout.write(`${JSON.stringify(payload)}\n`)
      } else {
        process.stdout.write(
          `server: ${payload.server}\n` +
            `store: ${storePath}\n` +
            `local bundle: ${local ? 'present' : 'missing'}\n` +
            `promoted: ${promoted ? 'yes' : 'no'}\n`,
        )
      }
    })

  return cmd
}
