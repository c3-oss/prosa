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
  bytes: Uint8Array
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
}

function readSessionsForUpload(bundle: Bundle): ProjectionSessionRow[] {
  const rows = bundle.db
    .prepare(
      `SELECT s.session_id, s.source_tool, s.project_id, s.title, s.start_ts, s.end_ts,
              (SELECT COUNT(*) FROM turns t WHERE t.session_id = s.session_id) AS turn_count
         FROM sessions s
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
    objectId: row.text_object_id,
    metadata: {
      mimeType: row.mime_type,
      tokenCount: row.token_count,
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
async function walkCasObjects(bundle: Bundle, storePath: string): Promise<LocalCasObject[]> {
  type CatalogRow = {
    object_id: string
    hash: string
    size_bytes: number
    compressed_size_bytes: number | null
    compression: 'zstd' | 'none'
    mime_type: string | null
    storage_path: string
  }
  // Schema drift in the `objects` catalog should fail the sync command rather
  // than skip the CAS upload silently.
  const rows = bundle.db
    .prepare(
      `SELECT object_id, hash, size_bytes, compressed_size_bytes, compression, mime_type, storage_path
         FROM objects
         ORDER BY object_id`,
    )
    .all() as CatalogRow[]
  const out: LocalCasObject[] = []
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
    out.push({ entry, bytes })
  }
  return out
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
  const casObjects = await walkCasObjects(bundle, storePath)
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
  }
}
