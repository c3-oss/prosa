import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '@c3-oss/prosa-core'
import { computeHashHex } from '@c3-oss/prosa-storage'
import type {
  ObjectManifestEntry,
  ProjectionArtifactRow,
  ProjectionContentBlockRow,
  ProjectionEventRow,
  ProjectionMessageRow,
  ProjectionPayload,
  ProjectionSessionRow,
  ProjectionToolCallRow,
  ProjectionToolResultRow,
  RawRecordRow,
  SearchDocRow,
  SourceFileRow,
} from '@c3-oss/prosa-sync'

export type LocalCasObject = {
  entry: ObjectManifestEntry
  storagePath: string
  bytes?: Uint8Array
}

export type LocalBundleUpload = {
  projection: ProjectionPayload
  sessions: ProjectionSessionRow[]
  searchDocs: SearchDocRow[]
  sourceFiles: SourceFileRow[]
  rawRecords: RawRecordRow[]
  toolCalls: ProjectionToolCallRow[]
  toolResults: ProjectionToolResultRow[]
  messages: ProjectionMessageRow[]
  contentBlocks: ProjectionContentBlockRow[]
  events: ProjectionEventRow[]
  artifacts: ProjectionArtifactRow[]
  casObjects: LocalCasObject[]
  metrics: LocalBundleReadMetrics
}

export type LocalBundleReadMetrics = {
  localScanMs: number
  localReadMs: number
  localBytesRead: number
  localObjectsRead: number
}

function readSessionsForUpload(bundle: Bundle): ProjectionSessionRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT s.session_id, s.source_tool, s.project_id, s.title, s.start_ts, s.end_ts,
              s.parent_session_id, s.is_subagent, s.agent_role, s.agent_nickname,
              COALESCE(tc.cnt, 0) AS turn_count
         FROM sessions s
         LEFT JOIN (SELECT session_id, COUNT(*) AS cnt FROM turns GROUP BY session_id) tc
           ON s.session_id = tc.session_id
         ORDER BY s.session_id
        `,
    )
    .all() as Array<{
    session_id: string
    source_tool: string
    project_id: string | null
    title: string | null
    start_ts: string | null
    end_ts: string | null
    parent_session_id: string | null
    is_subagent: number | null
    agent_role: string | null
    agent_nickname: string | null
    turn_count: number
  }>
  return rows.map((row) => ({
    id: row.session_id,
    sourceKind: row.source_tool,
    projectId: row.project_id,
    title: row.title,
    startedAt: row.start_ts,
    endedAt: row.end_ts,
    turnCount: row.turn_count,
    parentSessionId: row.parent_session_id,
    isSubagent: row.is_subagent === 1,
    agentRole: row.agent_role,
    agentNickname: row.agent_nickname,
  }))
}

function readSourceFilesForUpload(bundle: Bundle): SourceFileRow[] {
  // Schema drift should surface as a hard CLI error, not as a silent empty list
  // that lets cleanup proceed with no provenance uploaded.
  const rows = bundle.db
    .prepare(
      `SELECT source_file_id, source_tool, path, file_kind, size_bytes, mtime, content_hash, object_id
         FROM source_files ORDER BY source_file_id`,
    )
    .all() as Array<{
    source_file_id: string
    source_tool: string
    path: string
    file_kind: string | null
    size_bytes: number | null
    mtime: string | null
    content_hash: string | null
    object_id: string | null
  }>
  return rows.map((row) => ({
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
  }))
}

function readRawRecordsForUpload(bundle: Bundle): RawRecordRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT raw_record_id, source_file_id, line_no, raw_object_id,
              decoded_json_object_id, parser_status, confidence, import_batch_id
         FROM raw_records ORDER BY raw_record_id`,
    )
    .all() as Array<{
    raw_record_id: string
    source_file_id: string
    line_no: number | null
    raw_object_id: string
    decoded_json_object_id: string | null
    parser_status: string
    confidence: string
    import_batch_id: string
  }>
  return rows.map((row) => ({
    id: row.raw_record_id,
    sourceFileId: row.source_file_id,
    sequence: row.line_no ?? 0,
    payload: {
      decodedObjectId: row.decoded_json_object_id,
      parserStatus: row.parser_status,
      confidence: row.confidence,
    },
    objectId: row.raw_object_id ?? null,
  }))
}

function readSearchDocsForUpload(bundle: Bundle): SearchDocRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT doc_id, session_id, entity_type, field_kind, text
         FROM search_docs
         WHERE session_id IS NOT NULL
         ORDER BY doc_id`,
    )
    .all() as Array<{
    doc_id: string
    session_id: string
    entity_type: string
    field_kind: string
    text: string
  }>
  return rows.map((row) => ({
    id: row.doc_id,
    sessionId: row.session_id,
    kind: `${row.entity_type}/${row.field_kind}`,
    body: row.text,
  }))
}

function readToolCallsForUpload(bundle: Bundle): ProjectionToolCallRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT tool_call_id, session_id, turn_id, tool_name, status, args_object_id, timestamp_start
         FROM tool_calls
         ORDER BY tool_call_id`,
    )
    .all() as Array<{
    tool_call_id: string
    session_id: string
    turn_id: string | null
    tool_name: string
    status: string | null
    args_object_id: string | null
    timestamp_start: string | null
  }>
  return rows.map((row) => ({
    id: row.tool_call_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    name: row.tool_name,
    status: row.status,
    inputObjectId: row.args_object_id,
    createdAt: row.timestamp_start,
  }))
}

function readToolResultsForUpload(bundle: Bundle): ProjectionToolResultRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT r.tool_result_id, r.tool_call_id,
              COALESCE(r.output_object_id, r.stdout_object_id, r.stderr_object_id) AS output_object_id,
              COALESCE(r.status, CASE WHEN r.is_error <> 0 THEN 'error' ELSE NULL END) AS status,
              c.timestamp_end AS finished_at
         FROM tool_results r
         LEFT JOIN tool_calls c ON c.tool_call_id = r.tool_call_id
         WHERE r.tool_call_id IS NOT NULL
         ORDER BY r.tool_result_id`,
    )
    .all() as Array<{
    tool_result_id: string
    tool_call_id: string
    output_object_id: string | null
    status: string | null
    finished_at: string | null
  }>
  return rows.map((row) => ({
    id: row.tool_result_id,
    toolCallId: row.tool_call_id,
    outputObjectId: row.output_object_id,
    status: row.status,
    finishedAt: row.finished_at,
  }))
}

function readMessagesForUpload(bundle: Bundle): ProjectionMessageRow[] {
  // Map the local SQLite `messages` schema down to the remote projection's
  // narrower column set. Extra local fields (parent_message_id, status,
  // raw_record_id, ordinal, etc.) are not promoted yet — Fase 4 may surface
  // them via a richer transcript API once the manifest contract stabilizes.
  const rows = bundle.db
    .prepare(
      `SELECT message_id, session_id, turn_id, role, model, timestamp
         FROM messages
         ORDER BY message_id`,
    )
    .all() as Array<{
    message_id: string
    session_id: string
    turn_id: string | null
    role: string
    model: string | null
    timestamp: string | null
  }>
  return rows.map((row) => ({
    id: row.message_id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    model: row.model,
    createdAt: row.timestamp,
  }))
}

function readContentBlocksForUpload(bundle: Bundle): ProjectionContentBlockRow[] {
  // Only promote blocks attached to a message — the remote
  // `projection_content_block.message_id` is NOT NULL.
  const rows = bundle.db
    .prepare(
      `SELECT block_id, message_id, ordinal, block_type, text_inline, text_object_id,
              mime_type, token_count, is_error, is_redacted, visibility
         FROM content_blocks
         WHERE message_id IS NOT NULL
         ORDER BY block_id`,
    )
    .all() as Array<{
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
  return rows.map((row) => ({
    id: row.block_id,
    messageId: row.message_id,
    sequence: row.ordinal,
    kind: row.block_type,
    text: row.text_inline,
    tokenCount: row.token_count,
    objectId: row.text_object_id,
    metadata: {
      mimeType: row.mime_type,
      isError: row.is_error === 1,
      isRedacted: row.is_redacted === 1,
      visibility: row.visibility,
    },
  }))
}

function readEventsForUpload(bundle: Bundle): ProjectionEventRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT event_id, session_id, turn_id, ordinal, event_type, subtype, source_type,
              actor, timestamp, confidence, is_derived
         FROM events
         ORDER BY event_id`,
    )
    .all() as Array<{
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
  return rows.map((row) => ({
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
  }))
}

function readArtifactsForUpload(bundle: Bundle): ProjectionArtifactRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT artifact_id, session_id, kind, path, mime_type, size_bytes, object_id
         FROM artifacts
         ORDER BY artifact_id`,
    )
    .all() as Array<{
    artifact_id: string
    session_id: string | null
    kind: string
    path: string | null
    mime_type: string | null
    size_bytes: number | null
    object_id: string | null
  }>
  return rows.map((row) => ({
    id: row.artifact_id,
    sessionId: row.session_id,
    kind: row.kind,
    objectId: row.object_id,
    // Local schema marks `size_bytes` as NOT NULL but coerce defensively for
    // older bundles that may have written 0 vs null.
    sizeBytes: row.size_bytes ?? null,
    metadata: {
      path: row.path,
      mimeType: row.mime_type,
    },
  }))
}

/**
 * Read the bundle's CAS objects from the local catalog and pair each canonical
 * row with the on-disk bytes. The local `object_id` (`blake3:<uncompressed
 * hash>`) is the canonical identity; the on-disk file may carry compressed
 * bytes, in which case we declare a separate `transportHash` so the server
 * can verify the body against the BLAKE3 of what's actually on the wire while
 * keeping the canonical `hash`/`objectId` aligned with the local catalog.
 */
export type ObjectCatalogRow = {
  object_id: string
  hash: string
  size_bytes: number
  compressed_size_bytes: number | null
  compression: 'zstd' | 'none'
  mime_type: string | null
  storage_path: string
  transport_hash: string | null
}

export function readCasObjectCatalogRows(
  bundle: Bundle,
  options: { afterObjectId?: string | null; limit?: number } = {},
): ObjectCatalogRow[] {
  const { afterObjectId = null, limit } = options
  const where = afterObjectId ? 'WHERE object_id > ?' : ''
  const limitClause = limit == null ? '' : 'LIMIT ?'
  const params = [...(afterObjectId ? [afterObjectId] : []), ...(limit == null ? [] : [limit])] as Array<
    string | number
  >
  return bundle.db
    .prepare(
      `SELECT object_id, hash, size_bytes, compressed_size_bytes, compression, mime_type,
              storage_path, transport_hash
         FROM objects
         ${where}
         ORDER BY object_id
         ${limitClause}`,
    )
    .all(...params) as ObjectCatalogRow[]
}

export async function readLocalCasObjectBytes(
  storePath: string,
  object: Pick<LocalCasObject, 'storagePath'>,
): Promise<Uint8Array> {
  const buf = await readFile(path.join(storePath, object.storagePath))
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
}

function backfillObjectTransportHash(bundle: Bundle, objectId: string, transportHash: string): void {
  bundle.db
    .prepare(`UPDATE objects SET transport_hash = ? WHERE object_id = ? AND transport_hash IS NULL`)
    .run(transportHash, objectId)
}

export async function readLocalCasObjectFromCatalogRow(
  bundle: Bundle,
  storePath: string,
  row: ObjectCatalogRow,
): Promise<{ casObject: LocalCasObject; metrics: LocalBundleReadMetrics }> {
  let bytes: Uint8Array | undefined
  let transportHash = row.transport_hash
  let localReadMs = 0
  let localBytesRead = 0
  let localObjectsRead = 0

  if (!transportHash) {
    if (row.compression === 'none') {
      transportHash = row.hash
    } else {
      const readStart = Date.now()
      bytes = await readLocalCasObjectBytes(storePath, { storagePath: row.storage_path })
      localReadMs += Date.now() - readStart
      localBytesRead += bytes.byteLength
      localObjectsRead += 1
      transportHash = computeHashHex(bytes, 'blake3')
    }
    backfillObjectTransportHash(bundle, row.object_id, transportHash)
  }

  const entry: ObjectManifestEntry = {
    objectId: row.object_id,
    hash: row.hash,
    hashAlgorithm: 'blake3',
    uncompressedSize: row.size_bytes,
    compressedSize: row.compressed_size_bytes ?? row.size_bytes,
    compression: row.compression,
    transportHash,
  }
  if (row.mime_type) entry.contentType = row.mime_type
  return {
    casObject: { entry, storagePath: row.storage_path, bytes },
    metrics: { localScanMs: 0, localReadMs, localBytesRead, localObjectsRead },
  }
}

/**
 * Build object manifest entries from the local object catalog. For uncompressed
 * objects the transport hash equals the canonical hash, so bytes are read only
 * if the server later reports the object as missing. Compressed objects use the
 * catalog transport hash; legacy null rows are read once and backfilled.
 */
async function walkCasObjects(
  bundle: Bundle,
  storePath: string,
): Promise<{ casObjects: LocalCasObject[]; metrics: LocalBundleReadMetrics }> {
  // Schema drift in the `objects` catalog should fail the sync command rather
  // than skip the CAS upload silently.
  const scanStart = Date.now()
  const rows = readCasObjectCatalogRows(bundle)
  const localScanMs = Date.now() - scanStart
  const out: LocalCasObject[] = []
  let localReadMs = 0
  let localBytesRead = 0
  let localObjectsRead = 0
  for (const row of rows) {
    const { casObject, metrics } = await readLocalCasObjectFromCatalogRow(bundle, storePath, row)
    localReadMs += metrics.localReadMs
    localBytesRead += metrics.localBytesRead
    localObjectsRead += metrics.localObjectsRead
    out.push(casObject)
  }
  return { casObjects: out, metrics: { localScanMs, localReadMs, localBytesRead, localObjectsRead } }
}

export async function readBundleForUpload(bundle: Bundle, storePath: string): Promise<LocalBundleUpload> {
  const sessions = readSessionsForUpload(bundle)
  const searchDocs = readSearchDocsForUpload(bundle)
  const sourceFiles = readSourceFilesForUpload(bundle)
  const rawRecords = readRawRecordsForUpload(bundle)
  const toolCalls = readToolCallsForUpload(bundle)
  const toolResults = readToolResultsForUpload(bundle)
  const messages = readMessagesForUpload(bundle)
  const contentBlocks = readContentBlocksForUpload(bundle)
  const events = readEventsForUpload(bundle)
  const artifacts = readArtifactsForUpload(bundle)
  const { casObjects, metrics } = await walkCasObjects(bundle, storePath)
  return {
    projection: {
      sourceFiles,
      rawRecords,
      sessions,
      searchDocs,
      toolCalls,
      toolResults,
      messages,
      contentBlocks,
      events,
      artifacts,
    },
    sessions,
    searchDocs,
    sourceFiles,
    rawRecords,
    toolCalls,
    toolResults,
    messages,
    contentBlocks,
    events,
    artifacts,
    casObjects,
    metrics,
  }
}
