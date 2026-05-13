import type { Bundle } from '../bundle.js'
import { type ObjectId, putJson } from '../cas/index.js'
import { prepare } from '../db.js'
import { importBatchId } from '../domain/ids.js'
import type { SourceTool } from '../domain/types.js'
import { PROSA_PARSER_VERSION } from '../version.js'

/**
 * In-memory representation of an `import_batches` row while a compile/import
 * run is active.
 *
 * `finished_at` is populated only after `finishBatch` persists terminal status.
 */
export interface ImportBatch {
  /** Stable batch identifier derived from source and start time. */
  batch_id: string
  /** Source importer for this batch, or null for multi-source orchestration. */
  source_tool: SourceTool | null
  /** Parser version that produced this batch. */
  parser_version: string
  /** Source roots or files covered by the batch. */
  paths: string[]
  /** ISO timestamp when the batch was created. */
  started_at: string
  /** ISO timestamp set after terminal status is persisted. */
  finished_at?: string
}

/**
 * Per-batch counters serialized into `import_batches.counts_json`.
 *
 * Counts describe importer work, not necessarily net-new durable rows; skipped
 * source files and idempotent inserts are tracked explicitly.
 */
export interface ImportCounts {
  /** Source files discovered by the importer. */
  source_files_seen: number
  /** Source files parsed and imported. */
  source_files_imported: number
  /** Source files skipped by idempotency checks. */
  source_files_skipped: number
  /** Raw source records preserved. */
  raw_records: number
  /** Session rows inserted or updated. */
  sessions: number
  /** Turn rows inserted or updated. */
  turns: number
  /** Timeline event rows inserted or updated. */
  events: number
  /** Message rows inserted or updated. */
  messages: number
  /** Content block rows inserted or updated. */
  content_blocks: number
  /** Tool call rows inserted or updated. */
  tool_calls: number
  /** Tool result rows inserted or updated. */
  tool_results: number
  /** Artifact rows inserted or updated. */
  artifacts: number
  /** Edge rows inserted or updated. */
  edges: number
  /** Import errors recorded for the batch. */
  errors: number
}

/**
 * Create a zeroed counter object for a new import batch.
 */
export function emptyCounts(): ImportCounts {
  return {
    source_files_seen: 0,
    source_files_imported: 0,
    source_files_skipped: 0,
    raw_records: 0,
    sessions: 0,
    turns: 0,
    events: 0,
    messages: 0,
    content_blocks: 0,
    tool_calls: 0,
    tool_results: 0,
    artifacts: 0,
    edges: 0,
    errors: 0,
  }
}

/**
 * Insert a running import batch and return its process-local handle.
 *
 * Batch IDs are intentionally unique per run so repeated compiles preserve
 * their own audit trail even when all source rows are skipped idempotently.
 */
export function startBatch(bundle: Bundle, sourceTool: SourceTool | null, paths: string[]): ImportBatch {
  const startedAt = new Date().toISOString()
  const id = importBatchId(sourceTool ?? 'all', startedAt)
  prepare(
    bundle.db,
    `INSERT INTO import_batches (
       batch_id, parser_version, source_tool, paths, started_at, status
     ) VALUES (?, ?, ?, ?, ?, 'running')`,
  ).run(id, PROSA_PARSER_VERSION, sourceTool, JSON.stringify(paths), startedAt)

  return {
    batch_id: id,
    source_tool: sourceTool,
    parser_version: PROSA_PARSER_VERSION,
    paths,
    started_at: startedAt,
  }
}

/**
 * Mark an import batch completed or failed and persist final counts.
 */
export function finishBatch(
  bundle: Bundle,
  batch: ImportBatch,
  counts: ImportCounts,
  status: 'completed' | 'failed',
): void {
  prepare(
    bundle.db,
    `UPDATE import_batches
        SET finished_at = ?, status = ?, counts_json = ?
      WHERE batch_id = ?`,
  ).run(new Date().toISOString(), status, JSON.stringify(counts), batch.batch_id)
}

/**
 * Record an importer error tied to an optional source file or raw record.
 *
 * Non-string payloads are preserved in the CAS as JSON and referenced from the
 * error row; this keeps diagnostic detail out of inline SQLite columns while
 * preserving it for later inspection.
 */
export async function recordError(
  bundle: Bundle,
  batchId: string,
  args: {
    sourceFileId?: string | null
    rawRecordId?: string | null
    kind: string
    message: string
    payload?: unknown
  },
): Promise<void> {
  let payloadObjectId: ObjectId | null = null
  if (args.payload !== undefined) {
    payloadObjectId = await putJson(bundle, args.payload)
  }
  prepare(
    bundle.db,
    `INSERT INTO import_errors (
       batch_id, source_file_id, raw_record_id, kind, message,
       payload_object_id, occurred_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    batchId,
    args.sourceFileId ?? null,
    args.rawRecordId ?? null,
    args.kind,
    args.message,
    payloadObjectId,
    new Date().toISOString(),
  )
}
