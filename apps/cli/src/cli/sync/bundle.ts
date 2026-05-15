import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '@c3-oss/prosa-core'
import { computeHashHex } from '@c3-oss/prosa-storage'
import type {
  ObjectManifestEntry,
  ProjectionPayload,
  ProjectionSessionRow,
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
      importBatchId: row.import_batch_id,
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
  const casObjects = await walkCasObjects(bundle, storePath)
  return {
    projection: {
      sourceFiles,
      rawRecords,
      sessions,
      searchDocs,
    },
    sessions,
    searchDocs,
    sourceFiles,
    rawRecords,
    casObjects,
  }
}
