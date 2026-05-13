import type { Bundle } from '../bundle.js'
import { type ObjectId, putJson } from '../cas/index.js'
import { prepare } from '../db.js'
import { importBatchId } from '../domain/ids.js'
import type { SourceTool } from '../domain/types.js'
import { PROSA_PARSER_VERSION } from '../version.js'

export interface ImportBatch {
  batch_id: string
  source_tool: SourceTool | null
  parser_version: string
  paths: string[]
  started_at: string
  finished_at?: string
}

export interface ImportCounts {
  source_files_seen: number
  source_files_imported: number
  source_files_skipped: number
  raw_records: number
  sessions: number
  turns: number
  events: number
  messages: number
  content_blocks: number
  tool_calls: number
  tool_results: number
  artifacts: number
  edges: number
  errors: number
}

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
