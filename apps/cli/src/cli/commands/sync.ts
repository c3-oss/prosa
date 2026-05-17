import { stat } from 'node:fs/promises'
import path from 'node:path'
import { type Bundle, closeBundle, defaultBundlePath, openBundle } from '@c3-oss/prosa-core'
import type {
  ProjectionArtifactRow,
  ProjectionContentBlockRow,
  ProjectionEventRow,
  ProjectionMessageRow,
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
import {
  type LocalCasObject,
  readBundleForUpload,
  readCasObjectCatalogRows,
  readLocalCasObjectBytes,
  readLocalCasObjectFromCatalogRow,
} from '../sync/bundle.js'
import {
  type SyncCheckpointHandle,
  openSyncCheckpoint,
  resetSyncCheckpoint,
  syncChunkFingerprint,
} from '../sync/checkpoint.js'
import { mapConcurrentResults } from '../sync/concurrency.js'
import {
  type SyncLimits,
  type UploadCounts,
  readUploadCounts,
  uploadHardLimitViolations,
  uploadLimitViolations,
} from '../sync/limits.js'
import {
  type SyncMetrics,
  emptySyncMetrics,
  mergeSyncMetrics,
  promoteUpload,
  removeLocalBundle,
  uploadMissingCasObjects,
} from '../sync/promotion.js'

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
  objectConcurrency: number
  batchConcurrency: number
  resume?: boolean
  resetSyncCheckpoint?: boolean
}

type SyncResult = {
  batchId: string
  sessionCount: number
  objectCount: number
  searchDocCount: number
  batchCount: number
  chunked: boolean
  metrics: SyncMetrics
}

type LocalCasObjectChunk = LocalCasObject

type ObjectChunk = {
  casObjects: LocalCasObjectChunk[]
  nextCursor: string | null
  metrics: Pick<SyncMetrics, 'localScanMs' | 'localReadMs' | 'localBytesRead' | 'localObjectsRead'>
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
  maxObjectPackBytes?: number
  objectConcurrency: number
  batchConcurrency: number
  verbose?: boolean
  /** Optional Ink progress sink; ignored when running headless. */
  progress?: SyncProgressHandle
  /** Total batches expected, used to drive the progress bar pct. */
  totalBatches?: number
  /** Optional chunk checkpoint, stored outside the local bundle. */
  checkpoint?: SyncCheckpointHandle
}

type ProjectionStream<TEntity> = {
  label: string
  cursor: string | null
  pending: TEntity[]
  done: boolean
  readChunk: (afterId: string | null, limit: number) => ProjectionChunk<TEntity>
  appendRows: (projection: ProjectionPayload, rows: TEntity[]) => void
  referencedObjectIds: (row: TEntity) => Array<string | null | undefined>
}

type PromoteChunkOptions = {
  client: ProsaApiClient
  deviceId: string
  storePath: string
  casObjects: LocalCasObjectChunk[]
  projection: ProjectionPayload
  label: string
  metrics: SyncMetrics
  objectConcurrency: number
  maxObjectPackBytes?: number
  verbose?: boolean
  checkpoint?: SyncCheckpointHandle
}

const DEFAULT_OBJECT_UPLOAD_CONCURRENCY = 32
const MIN_OBJECT_UPLOAD_CONCURRENCY = 1
const MAX_OBJECT_UPLOAD_CONCURRENCY = 128
const DEFAULT_BATCH_CONCURRENCY = 4
const MIN_BATCH_CONCURRENCY = 1
const MAX_BATCH_CONCURRENCY = 8

async function bundleManifestExists(storePath: string): Promise<boolean> {
  return stat(`${storePath}/manifest.json`).then(
    () => true,
    () => false,
  )
}

function emptyProjection(): ProjectionPayload {
  return {
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
}

function parseObjectConcurrency(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < MIN_OBJECT_UPLOAD_CONCURRENCY || parsed > MAX_OBJECT_UPLOAD_CONCURRENCY) {
    throw new CliUserError(
      `--object-concurrency must be an integer from ${MIN_OBJECT_UPLOAD_CONCURRENCY} to ${MAX_OBJECT_UPLOAD_CONCURRENCY}`,
    )
  }
  return parsed
}

function parseBatchConcurrency(value: string): number {
  const parsed = Number(value)
  if (!Number.isInteger(parsed) || parsed < MIN_BATCH_CONCURRENCY || parsed > MAX_BATCH_CONCURRENCY) {
    throw new CliUserError(
      `--batch-concurrency must be an integer from ${MIN_BATCH_CONCURRENCY} to ${MAX_BATCH_CONCURRENCY}`,
    )
  }
  return parsed
}

function addLocalReadMetric(metrics: SyncMetrics, ms: number, bytes: number): void {
  metrics.localReadMs += ms
  metrics.localBytesRead += bytes
  metrics.localObjectsRead += 1
}

async function bytesForUpload(
  storePath: string,
  object: LocalCasObjectChunk,
  metrics: SyncMetrics,
): Promise<Uint8Array> {
  if (object.bytes) return object.bytes
  const readStart = Date.now()
  const bytes = await readLocalCasObjectBytes(storePath, object)
  addLocalReadMetric(metrics, Date.now() - readStart, bytes.byteLength)
  object.bytes = bytes
  return bytes
}

function projectionRowCount(projection: ProjectionPayload): number {
  return (
    projection.sourceFiles.length +
    projection.rawRecords.length +
    projection.sessions.length +
    projection.searchDocs.length +
    projection.toolCalls.length +
    projection.toolResults.length +
    projection.messages.length +
    projection.contentBlocks.length +
    projection.events.length +
    projection.artifacts.length
  )
}

function estimateMixedChunkedUploadBatches(counts: UploadCounts, limits: SyncLimits): number {
  return Math.max(
    Math.ceil(counts.casObjects / limits.maxObjectsPerPlan),
    Math.ceil(counts.totalRows / limits.maxRowsPerCommit),
  )
}

function projectionStreams(bundle: Bundle): Array<ProjectionStream<unknown>> {
  return [
    {
      label: 'source-file',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readSourceFileChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.sourceFiles.push(...(rows as SourceFileRow[]))
      },
      referencedObjectIds: (row) => [(row as SourceFileRow).objectId],
    },
    {
      label: 'session',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readSessionChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.sessions.push(...(rows as ProjectionSessionRow[]))
      },
      referencedObjectIds: () => [],
    },
    {
      label: 'message',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readMessageChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.messages.push(...(rows as ProjectionMessageRow[]))
      },
      referencedObjectIds: () => [],
    },
    {
      label: 'content-block',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readContentBlockChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.contentBlocks.push(...(rows as ProjectionContentBlockRow[]))
      },
      referencedObjectIds: (row) => [(row as ProjectionContentBlockRow).objectId],
    },
    {
      label: 'event',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readEventChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.events.push(...(rows as ProjectionEventRow[]))
      },
      referencedObjectIds: () => [],
    },
    {
      label: 'artifact',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readArtifactChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.artifacts.push(...(rows as ProjectionArtifactRow[]))
      },
      referencedObjectIds: (row) => [(row as ProjectionArtifactRow).objectId],
    },
    {
      label: 'raw-record',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readRawRecordChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.rawRecords.push(...(rows as RawRecordRow[]))
      },
      referencedObjectIds: (row) => [(row as RawRecordRow).objectId],
    },
    {
      label: 'search-doc',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readSearchDocChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.searchDocs.push(...(rows as SearchDocRow[]))
      },
      referencedObjectIds: () => [],
    },
    {
      label: 'tool-call',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readToolCallChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.toolCalls.push(...(rows as ProjectionToolCallRow[]))
      },
      referencedObjectIds: (row) => [(row as ProjectionToolCallRow).inputObjectId],
    },
    {
      label: 'tool-result',
      cursor: null,
      pending: [],
      done: false,
      readChunk: (cursor, limit) => readToolResultChunk(bundle, cursor, limit),
      appendRows: (projection, rows) => {
        projection.toolResults.push(...(rows as ProjectionToolResultRow[]))
      },
      referencedObjectIds: (row) => [(row as ProjectionToolResultRow).outputObjectId],
    },
  ]
}

function canPromoteProjectionRow(
  row: unknown,
  stream: ProjectionStream<unknown>,
  availableObjectIds: Set<string>,
): boolean {
  return stream.referencedObjectIds(row).every((objectId) => objectId == null || availableObjectIds.has(objectId))
}

function projectionStreamsDone(streams: Array<ProjectionStream<unknown>>): boolean {
  return streams.every((stream) => stream.done && stream.pending.length === 0)
}

function fillProjectionBatch(
  streams: Array<ProjectionStream<unknown>>,
  availableObjectIds: Set<string>,
  maxRows: number,
): ProjectionPayload {
  const projection = emptyProjection()
  let remainingRows = maxRows
  while (remainingRows > 0) {
    let addedRows = 0
    for (const stream of streams) {
      const rows: unknown[] = []
      while (remainingRows > 0) {
        if (stream.pending.length === 0) {
          if (stream.done) break
          const chunk = stream.readChunk(stream.cursor, remainingRows)
          if (chunk.rows.length === 0) {
            stream.done = true
            break
          }
          stream.pending.push(...chunk.rows)
          stream.cursor = chunk.nextCursor
        }
        const next = stream.pending[0]
        if (!canPromoteProjectionRow(next, stream, availableObjectIds)) break
        rows.push(stream.pending.shift() as unknown)
        remainingRows -= 1
        addedRows += 1
      }
      if (rows.length > 0) stream.appendRows(projection, rows)
      if (remainingRows === 0) break
    }
    if (addedRows === 0) break
  }
  return projection
}

type ChunkCursor = {
  afterId: string | null
  sequence: number
}

type ChunkPromotionResult = {
  receipt: PromotionReceipt
  metrics: SyncMetrics
  skipped?: boolean
}

function readChunkIds(
  bundle: Bundle,
  table: string,
  idColumn: string,
  afterId: string | null,
  limit: number,
  whereClause?: string,
): string[] {
  const predicates = [...(whereClause ? [whereClause] : []), ...(afterId ? [`${idColumn} > ?`] : [])]
  const sql = `SELECT ${idColumn} AS id
         FROM ${table}
         ${predicates.length > 0 ? `WHERE ${predicates.join(' AND ')}` : ''}
         ORDER BY ${idColumn}
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{ id: string }>
  return rows.map((row) => row.id)
}

function collectChunkCursors(
  bundle: Bundle,
  table: string,
  idColumn: string,
  limit: number,
  whereClause?: string,
): ChunkCursor[] {
  const cursors: ChunkCursor[] = []
  let afterId: string | null = null
  while (true) {
    const ids = readChunkIds(bundle, table, idColumn, afterId, limit, whereClause)
    if (ids.length === 0) break
    cursors.push({ afterId, sequence: cursors.length + 1 })
    afterId = ids[ids.length - 1] ?? null
  }
  return cursors
}

async function readObjectChunk(
  bundle: Bundle,
  storePath: string,
  afterObjectId: string | null,
  limit: number,
): Promise<ObjectChunk> {
  const scanStart = Date.now()
  const rows = readCasObjectCatalogRows(bundle, { afterObjectId, limit })
  const localScanMs = Date.now() - scanStart
  const casObjects: LocalCasObjectChunk[] = []
  let localReadMs = 0
  let localBytesRead = 0
  let localObjectsRead = 0
  for (const row of rows) {
    const { casObject, metrics } = await readLocalCasObjectFromCatalogRow(bundle, storePath, row)
    localReadMs += metrics.localReadMs
    localBytesRead += metrics.localBytesRead
    localObjectsRead += metrics.localObjectsRead
    casObjects.push(casObject)
  }
  return {
    casObjects,
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.object_id ?? null) : null,
    metrics: { localScanMs, localReadMs, localBytesRead, localObjectsRead },
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

function readMessageChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionMessageRow> {
  const sql = afterId
    ? `SELECT message_id, session_id, turn_id, role, model, timestamp
         FROM messages
         WHERE message_id > ?
         ORDER BY message_id
         LIMIT ?`
    : `SELECT message_id, session_id, turn_id, role, model, timestamp
         FROM messages
         ORDER BY message_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    message_id: string
    session_id: string
    turn_id: string | null
    role: string
    model: string | null
    timestamp: string | null
  }>
  return {
    rows: rows.map((row) => ({
      id: row.message_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      role: row.role,
      model: row.model,
      createdAt: row.timestamp,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.message_id ?? null) : null,
  }
}

function readContentBlockChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionContentBlockRow> {
  // Skip blocks that are not attached to a message — the remote
  // `projection_content_block.message_id` is NOT NULL.
  const sql = afterId
    ? `SELECT block_id, message_id, ordinal, block_type, text_inline, text_object_id,
              mime_type, token_count, is_error, is_redacted, visibility
         FROM content_blocks
         WHERE message_id IS NOT NULL AND block_id > ?
         ORDER BY block_id
         LIMIT ?`
    : `SELECT block_id, message_id, ordinal, block_type, text_inline, text_object_id,
              mime_type, token_count, is_error, is_redacted, visibility
         FROM content_blocks
         WHERE message_id IS NOT NULL
         ORDER BY block_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    block_id: string
    message_id: string
    ordinal: number
    block_type: string
    text_inline: string | null
    text_object_id: string | null
    mime_type: string | null
    token_count: number | null
    is_error: number
    is_redacted: number
    visibility: string
  }>
  return {
    rows: rows.map((row) => ({
      id: row.block_id,
      messageId: row.message_id,
      sequence: row.ordinal,
      kind: row.block_type,
      text: row.text_inline,
      objectId: row.text_object_id,
      metadata: {
        mimeType: row.mime_type,
        tokenCount: row.token_count,
        isError: row.is_error === 1,
        isRedacted: row.is_redacted === 1,
        visibility: row.visibility,
      },
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.block_id ?? null) : null,
  }
}

function readEventChunk(bundle: Bundle, afterId: string | null, limit: number): ProjectionChunk<ProjectionEventRow> {
  const sql = afterId
    ? `SELECT event_id, session_id, turn_id, ordinal, event_type, subtype, source_type,
              actor, timestamp, confidence, is_derived
         FROM events
         WHERE event_id > ?
         ORDER BY event_id
         LIMIT ?`
    : `SELECT event_id, session_id, turn_id, ordinal, event_type, subtype, source_type,
              actor, timestamp, confidence, is_derived
         FROM events
         ORDER BY event_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    event_id: string
    session_id: string
    turn_id: string | null
    ordinal: number
    event_type: string
    subtype: string | null
    source_type: string | null
    actor: string | null
    timestamp: string | null
    confidence: string
    is_derived: number
  }>
  return {
    rows: rows.map((row) => ({
      id: row.event_id,
      sessionId: row.session_id,
      turnId: row.turn_id,
      sequence: row.ordinal,
      kind: row.event_type,
      payload: {
        subtype: row.subtype,
        sourceType: row.source_type,
        actor: row.actor,
        confidence: row.confidence,
        isDerived: row.is_derived === 1,
      },
      occurredAt: row.timestamp,
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.event_id ?? null) : null,
  }
}

function readArtifactChunk(
  bundle: Bundle,
  afterId: string | null,
  limit: number,
): ProjectionChunk<ProjectionArtifactRow> {
  const sql = afterId
    ? `SELECT artifact_id, session_id, kind, path, mime_type, size_bytes, object_id
         FROM artifacts
         WHERE artifact_id > ?
         ORDER BY artifact_id
         LIMIT ?`
    : `SELECT artifact_id, session_id, kind, path, mime_type, size_bytes, object_id
         FROM artifacts
         ORDER BY artifact_id
         LIMIT ?`
  const rows = bundle.db.prepare(sql).all(...(afterId ? [afterId, limit] : [limit])) as Array<{
    artifact_id: string
    session_id: string | null
    kind: string
    path: string | null
    mime_type: string | null
    size_bytes: number | null
    object_id: string | null
  }>
  return {
    rows: rows.map((row) => ({
      id: row.artifact_id,
      sessionId: row.session_id,
      kind: row.kind,
      objectId: row.object_id,
      sizeBytes: row.size_bytes ?? null,
      metadata: {
        path: row.path,
        mimeType: row.mime_type,
      },
    })),
    nextCursor: rows.length > 0 ? (rows[rows.length - 1]?.artifact_id ?? null) : null,
  }
}

async function promoteChunk({
  client,
  deviceId,
  storePath,
  casObjects,
  projection,
  label,
  metrics,
  objectConcurrency,
  maxObjectPackBytes,
  verbose,
}: PromoteChunkOptions): Promise<PromotionReceipt> {
  const objectEntries = casObjects.map((c) => c.entry)
  const totalStart = Date.now()
  const planStart = Date.now()
  const plan = await client.syncPlanUpload({ deviceId, storePath, objects: objectEntries })
  metrics.planMs += Date.now() - planStart
  metrics.objectsDeclared += casObjects.length
  metrics.objectsMissing += plan.missingObjectIds.length
  metrics.batches += 1
  if (verbose) {
    process.stderr.write(
      `plan ${label} • batchId=${plan.batchId} declaredObjects=${casObjects.length} missingObjects=${plan.missingObjectIds.length} rows=${projectionRowCount(projection)} planMs=${metrics.planMs}\n`,
    )
  }

  const missingSet = new Set(plan.missingObjectIds)
  const missingObjects = casObjects.filter(({ entry }) => missingSet.has(entry.objectId))
  const uploadStart = Date.now()
  const preparedMissingObjects = await mapConcurrentResults(missingObjects, objectConcurrency, async (object) => {
    const bytes = await bytesForUpload(storePath, object, metrics)
    return { ...object, bytes }
  })
  const uploadStats = await uploadMissingCasObjects({
    client,
    batchId: plan.batchId,
    missingObjects: preparedMissingObjects,
    objectConcurrency,
    ...(maxObjectPackBytes ? { maxObjectPackBytes } : {}),
  })
  metrics.bytesUploaded += preparedMissingObjects.reduce((sum, object) => sum + object.bytes.byteLength, 0)
  metrics.objectsUploaded += uploadStats.packedObjectCount + uploadStats.putObjectCount
  metrics.uploadMs += Date.now() - uploadStart
  if (verbose && casObjects.length > 0) {
    process.stderr.write(
      `uploaded ${missingSet.size} CAS objects bytes=${metrics.bytesUploaded} uploadMs=${metrics.uploadMs} packs=${uploadStats.packCount} packedObjects=${uploadStats.packedObjectCount} putObjects=${uploadStats.putObjectCount}\n`,
    )
  }

  const commitStart = Date.now()
  const commit = await client.syncCommitUpload(
    {
      batchId: plan.batchId,
      deviceId,
      storePath,
      objects: objectEntries,
      projection,
    },
    {
      idempotencyKey: `sync.commitUpload:${plan.batchId}`,
    },
  )
  metrics.commitMs += Date.now() - commitStart
  metrics.rowsCommitted += commit.committedRows
  if (verbose) {
    process.stderr.write(
      `commit ${label} • objects=${commit.committedObjects} rows=${commit.committedRows} commitMs=${metrics.commitMs}\n`,
    )
  }

  const verifyStart = Date.now()
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
    declaredMessageIds: projection.messages.map((m) => m.id),
    declaredContentBlockIds: projection.contentBlocks.map((b) => b.id),
    declaredEventIds: projection.events.map((e) => e.id),
    declaredArtifactIds: projection.artifacts.map((a) => a.id),
  })
  metrics.verifyMs += Date.now() - verifyStart
  metrics.totalMs += Date.now() - totalStart
  if (verbose) {
    process.stderr.write(`verify ${label} • verifyMs=${metrics.verifyMs} totalMs=${metrics.totalMs}\n`)
  }
  return verify.receipt
}

function addObjectChunkMetrics(metrics: SyncMetrics, chunkMetrics: ObjectChunk['metrics']): void {
  metrics.localScanMs += chunkMetrics.localScanMs
  metrics.localReadMs += chunkMetrics.localReadMs
  metrics.localBytesRead += chunkMetrics.localBytesRead
  metrics.localObjectsRead += chunkMetrics.localObjectsRead
}

async function promoteCheckpointedChunk(
  opts: PromoteChunkOptions & { metrics: SyncMetrics },
): Promise<ChunkPromotionResult> {
  const objectEntries = opts.casObjects.map((c) => c.entry)
  const fingerprint = syncChunkFingerprint({
    label: opts.label,
    objects: objectEntries,
    projection: opts.projection,
  })
  const checkpointed = opts.checkpoint?.verifiedChunk(fingerprint)
  if (checkpointed) {
    if (opts.verbose) {
      process.stderr.write(`resume ${opts.label} • skipped verified batch=${checkpointed.batchId}\n`)
    }
    return { receipt: checkpointed.receipt, metrics: opts.metrics, skipped: true }
  }

  const receipt = await promoteChunk(opts)
  await opts.checkpoint?.markVerified({
    fingerprint,
    label: opts.label,
    receipt,
  })
  return { receipt, metrics: opts.metrics }
}

async function promoteBatchTask(
  opts: Omit<PromoteChunkOptions, 'metrics'> & {
    chunkMetrics?: ObjectChunk['metrics']
  },
): Promise<ChunkPromotionResult> {
  const metrics = emptySyncMetrics(opts.objectConcurrency)
  if (opts.chunkMetrics) addObjectChunkMetrics(metrics, opts.chunkMetrics)
  return promoteCheckpointedChunk({ ...opts, metrics })
}

async function promotePhase<TTask extends ChunkCursor>(
  tasks: TTask[],
  concurrency: number,
  worker: (task: TTask) => Promise<ChunkPromotionResult>,
): Promise<ChunkPromotionResult[]> {
  const parallelTasks = tasks.slice(0, -1)
  const finalTask = tasks[tasks.length - 1]
  const results = await mapConcurrentResults(parallelTasks, concurrency, worker)

  // The server stores a batch-scoped receipt as remote_authority on every
  // verify. Keep the logical phase tail last so status output is deterministic.
  if (finalTask) {
    results.push(await worker(finalTask))
  }

  return results
}

export async function promoteChunkedUpload({
  client,
  deviceId,
  storePath,
  bundle,
  maxObjectsPerPlan,
  maxRowsPerCommit,
  maxObjectPackBytes,
  objectConcurrency,
  batchConcurrency,
  verbose,
  progress,
  totalBatches,
  checkpoint,
}: ChunkedPromotionOptions): Promise<SyncResult> {
  let batchCount = 0
  let lastReceipt: PromotionReceipt | null = null
  let metrics = emptySyncMetrics(objectConcurrency)
  const denominator = totalBatches && totalBatches > 0 ? totalBatches : 1
  const tickProgress = () => {
    progress?.setPhase({ kind: 'upload', completed: batchCount, total: denominator })
  }

  const promoteProjectionChunks = async <TRow>(
    label: string,
    table: string,
    idColumn: string,
    whereClause: string | undefined,
    readChunk: (afterId: string | null, limit: number) => ProjectionChunk<TRow>,
    toProjection: (rows: TRow[]) => ProjectionPayload,
  ) => {
    const cursors = collectChunkCursors(bundle, table, idColumn, maxRowsPerCommit, whereClause)
    const phaseStart = batchCount
    const results = await promotePhase(cursors, batchConcurrency, async (cursor) => {
      const chunk = readChunk(cursor.afterId, maxRowsPerCommit)
      return promoteBatchTask({
        client,
        deviceId,
        storePath,
        casObjects: [],
        projection: toProjection(chunk.rows),
        label: `${label} batch ${phaseStart + cursor.sequence}`,
        objectConcurrency,
        ...(maxObjectPackBytes ? { maxObjectPackBytes } : {}),
        verbose,
        checkpoint,
      })
    })
    for (const result of results) {
      metrics = mergeSyncMetrics(metrics, result.metrics)
      lastReceipt = result.receipt
    }
    batchCount += results.length
    tickProgress()
  }

  const hasCasObjects = readCasObjectCatalogRows(bundle, { limit: 1 }).length > 0
  if (!hasCasObjects) {
    await promoteProjectionChunks(
      'source-file',
      'source_files',
      'source_file_id',
      undefined,
      (cursor, limit) => readSourceFileChunk(bundle, cursor, limit),
      (sourceFiles) => ({ ...emptyProjection(), sourceFiles }),
    )
    await promoteProjectionChunks(
      'raw-record',
      'raw_records',
      'raw_record_id',
      undefined,
      (cursor, limit) => readRawRecordChunk(bundle, cursor, limit),
      (rawRecords) => ({ ...emptyProjection(), rawRecords }),
    )
    await promoteProjectionChunks(
      'session',
      'sessions',
      'session_id',
      undefined,
      (cursor, limit) => readSessionChunk(bundle, cursor, limit),
      (sessions) => ({ ...emptyProjection(), sessions }),
    )
    await promoteProjectionChunks(
      'search-doc',
      'search_docs',
      'doc_id',
      'session_id IS NOT NULL',
      (cursor, limit) => readSearchDocChunk(bundle, cursor, limit),
      (searchDocs) => ({ ...emptyProjection(), searchDocs }),
    )
    await promoteProjectionChunks(
      'tool-call',
      'tool_calls',
      'tool_call_id',
      undefined,
      (cursor, limit) => readToolCallChunk(bundle, cursor, limit),
      (toolCalls) => ({ ...emptyProjection(), toolCalls }),
    )
    await promoteProjectionChunks(
      'tool-result',
      'tool_results',
      'tool_result_id',
      'tool_call_id IS NOT NULL',
      (cursor, limit) => readToolResultChunk(bundle, cursor, limit),
      (toolResults) => ({ ...emptyProjection(), toolResults }),
    )
    await promoteProjectionChunks(
      'message',
      'messages',
      'message_id',
      undefined,
      (cursor, limit) => readMessageChunk(bundle, cursor, limit),
      (messages) => ({ ...emptyProjection(), messages }),
    )
    await promoteProjectionChunks(
      'content-block',
      'content_blocks',
      'block_id',
      'message_id IS NOT NULL',
      (cursor, limit) => readContentBlockChunk(bundle, cursor, limit),
      (contentBlocks) => ({ ...emptyProjection(), contentBlocks }),
    )
    await promoteProjectionChunks(
      'event',
      'events',
      'event_id',
      undefined,
      (cursor, limit) => readEventChunk(bundle, cursor, limit),
      (events) => ({ ...emptyProjection(), events }),
    )
    await promoteProjectionChunks(
      'artifact',
      'artifacts',
      'artifact_id',
      undefined,
      (cursor, limit) => readArtifactChunk(bundle, cursor, limit),
      (artifacts) => ({ ...emptyProjection(), artifacts }),
    )
  } else {
    let objectCursor: string | null = null
    let objectCatalogDone = false
    const streams = projectionStreams(bundle)
    const promotedObjectIds = new Set<string>()

    while (true) {
      let casObjects: LocalCasObjectChunk[] = []
      if (!objectCatalogDone) {
        const chunk = await readObjectChunk(bundle, storePath, objectCursor, maxObjectsPerPlan)
        casObjects = chunk.casObjects
        objectCatalogDone = chunk.casObjects.length === 0
        objectCursor = chunk.nextCursor
        addObjectChunkMetrics(metrics, chunk.metrics)
      }

      const batchObjectIds = casObjects.map(({ entry }) => entry.objectId)
      const availableObjectIds = new Set([...promotedObjectIds, ...batchObjectIds])
      const projection = fillProjectionBatch(streams, availableObjectIds, maxRowsPerCommit)
      if (casObjects.length === 0 && projectionRowCount(projection) === 0) {
        if (objectCatalogDone && projectionStreamsDone(streams)) break
        throw new CliUserError(
          'projection rows reference CAS objects that are not available in the local object catalog',
        )
      }

      batchCount += 1
      tickProgress()
      const promoted = await promoteCheckpointedChunk({
        client,
        deviceId,
        storePath,
        casObjects,
        projection,
        label: `chunk ${batchCount}`,
        metrics,
        objectConcurrency,
        ...(maxObjectPackBytes ? { maxObjectPackBytes } : {}),
        verbose,
        checkpoint,
      })
      lastReceipt = promoted.receipt
      for (const objectId of batchObjectIds) promotedObjectIds.add(objectId)
    }
  }

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
    metrics,
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
    .option('--no-resume', 'ignore an existing chunked sync checkpoint and re-submit all chunks')
    .option('--reset-sync-checkpoint', 'delete the chunked sync checkpoint before uploading', false)
    .option(
      '--purge-bundle',
      'also remove canonical raw/CAS data (objects/, raw/, prosa.sqlite, manifest.json). ' +
        'Only use after the remote receipt verifies the declared bundle contents.',
      false,
    )
    .option('--json', 'machine-readable JSON output', false)
    .option('--verbose', 'extra logging', false)
    .option(
      '--object-concurrency <n>',
      `concurrent CAS object uploads per batch (default: ${DEFAULT_OBJECT_UPLOAD_CONCURRENCY}; range ${MIN_OBJECT_UPLOAD_CONCURRENCY}-${MAX_OBJECT_UPLOAD_CONCURRENCY})`,
      parseObjectConcurrency,
      DEFAULT_OBJECT_UPLOAD_CONCURRENCY,
    )
    .option(
      '--batch-concurrency <n>',
      `concurrent chunked sync batches per phase (default: ${DEFAULT_BATCH_CONCURRENCY}; range ${MIN_BATCH_CONCURRENCY}-${MAX_BATCH_CONCURRENCY})`,
      parseBatchConcurrency,
      DEFAULT_BATCH_CONCURRENCY,
    )
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
          process.stderr.write(
            `handshake ok • deviceId=${handshake.deviceId} promoted=${handshake.promoted} objectConcurrency=${options.objectConcurrency} batchConcurrency=${options.batchConcurrency}\n`,
          )
        }

        const counts = readUploadCounts(bundle, handshake.limits)
        const limitViolations = uploadLimitViolations(counts, handshake.limits)
        const hardLimitViolations = uploadHardLimitViolations(counts, handshake.limits)
        const estimatedBatches = estimateMixedChunkedUploadBatches(counts, handshake.limits)

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
            batchConcurrency: options.batchConcurrency,
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
            process.stderr.write(
              `bundle exceeds single-batch limits; switching to chunked sync (~${estimatedBatches} batches). Local cleanup will be skipped.\n`,
            )
          }
          progress.setPhase({ kind: 'upload', completed: 0, total: estimatedBatches })
          const checkpointIdentity = {
            server,
            tenant: tenantHint,
            deviceId: handshake.deviceId,
            storePath,
          }
          if (options.resetSyncCheckpoint) await resetSyncCheckpoint(checkpointIdentity)
          const checkpoint = await openSyncCheckpoint({
            identity: checkpointIdentity,
            resume: options.resume !== false,
          })
          try {
            result = await promoteChunkedUpload({
              client,
              deviceId: handshake.deviceId,
              storePath,
              bundle,
              maxObjectsPerPlan: handshake.limits.maxObjectsPerPlan,
              maxRowsPerCommit: handshake.limits.maxRowsPerCommit,
              maxObjectPackBytes: handshake.limits.maxObjectBytes,
              objectConcurrency: options.objectConcurrency,
              batchConcurrency: options.batchConcurrency,
              verbose: options.verbose,
              progress,
              totalBatches: estimatedBatches,
              checkpoint,
            })
          } finally {
            await checkpoint.release()
          }
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
            objectConcurrency: options.objectConcurrency,
            maxObjectPackBytes: handshake.limits.maxObjectBytes,
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
            metrics: promotion.metrics,
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
            metrics: result.metrics,
            removedLocalPaths: removed,
            keptLocal: Boolean(options.keepLocal) || result.chunked,
            cleanupSkippedReason: result.chunked
              ? 'chunked sync uses per-batch receipts; local cleanup is disabled'
              : null,
          })}\n`
        : `sync ok • batch=${result.batchId} batches=${result.batchCount} mode=${result.chunked ? 'chunked' : 'single-batch'} sessions=${result.sessionCount} searchDocs=${result.searchDocCount}
metrics • planMs=${result.metrics.planMs} uploadMs=${result.metrics.uploadMs} commitMs=${result.metrics.commitMs} verifyMs=${result.metrics.verifyMs} bytesUploaded=${result.metrics.bytesUploaded} rowsCommitted=${result.metrics.rowsCommitted}
${tail}`
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
