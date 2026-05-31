import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '../../core/bundle.js'
import {
  type ObjectId,
  type PendingObjects,
  createPendingObjects,
  flushPendingObjects,
  stageBytes,
  stageJson,
  stageText,
} from '../../core/cas/index.js'
import { prepare, transactional } from '../../core/db.js'
import {
  artifactId,
  blockId,
  eventId as makeEventId,
  messageId as makeMessageId,
  rawRecordId as makeRawRecordId,
  sessionId as makeSessionId,
  toolCallId as makeToolCallId,
  toolResultId as makeToolResultId,
} from '../../core/domain/ids.js'
import { normalizeToolCallStatus } from '../../core/domain/status.js'
import { getErrorMessage } from '../../core/errors.js'
import {
  type ImportBatch,
  type ImportCounts,
  emptyCounts,
  finishBatch,
  recordError,
  startBatch,
} from '../../core/ingest/batch.js'
import { registerSourceFile } from '../../core/ingest/idempotency.js'
import type { CompileLogger, CompileOptions } from '../compile-options.js'
import { type ClaudeFile, discoverClaudeFiles } from './discover.js'
import type { ClaudeContentBlock, ClaudeRecord, ClaudeSubagentMeta } from './types.js'

/** Result returned after a Claude compile batch finishes or records a failed batch. */
export interface CompileResult {
  /** Import batch created for this Claude run. */
  batch: ImportBatch
  /** Final counts accumulated while importing Claude files. */
  counts: ImportCounts
}

/** Maximum inline text retained in normalized rows before full content moves to CAS. */
const PREVIEW_MAX = 4_000

/** Compile Claude Code JSONL files under `root` into the bundle. */
export async function compileClaude(
  bundle: Bundle,
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const logger = options.logger
  const batch = startBatch(bundle, 'claude', [root])
  const counts = emptyCounts()
  logger?.info({ batch_id: batch.batch_id, root }, 'claude batch started')

  try {
    for await (const file of discoverClaudeFiles(root)) {
      counts.source_files_seen++
      logger?.debug(
        {
          path: file.filePath,
          project_slug: file.projectSlug,
          is_subagent: file.isSubagent,
        },
        'claude source file discovered',
      )
      try {
        const fc = await compileClaudeFile(bundle, batch, file, logger)
        addCounts(counts, fc)
      } catch (error) {
        counts.errors++
        logger?.warn(
          {
            err: error,
            path: file.filePath,
          },
          'claude source file failed',
        )
        await recordError(bundle, batch.batch_id, {
          kind: 'claude_file_failed',
          message: getErrorMessage(error),
          payload: { path: file.filePath },
        })
      }
    }
    linkSubagentParents(bundle)
    logger?.debug({ batch_id: batch.batch_id }, 'claude subagent parent links refreshed')
    finishBatch(bundle, batch, counts, 'completed')
    logger?.info({ batch_id: batch.batch_id, counts }, 'claude batch completed')
  } catch (error) {
    finishBatch(bundle, batch, counts, 'failed')
    logger?.error({ err: error, batch_id: batch.batch_id, counts }, 'claude batch failed')
    throw error
  }

  return { batch, counts }
}

/** Resolve Claude subagent parent links after all files in the batch have been inserted. */
function linkSubagentParents(bundle: Bundle): void {
  transactional(bundle.db, () => {
    const candidates = prepare<[], { edge_id: number; dst_id: string; resolved_src_id: string }>(
      bundle.db,
      `SELECT e.edge_id, e.dst_id, MIN(m.message_id) AS resolved_src_id
         FROM edges e
         JOIN raw_records r
           ON r.source_tool = 'claude'
          AND r.native_id = e.src_id
         JOIN messages m ON m.raw_record_id = r.raw_record_id
        WHERE e.src_type = 'message'
          AND e.dst_type = 'session'
          AND e.edge_type = 'spawned'
          AND e.source = 'source_tool_assistant_uuid'
          AND NOT EXISTS (SELECT 1 FROM messages current WHERE current.message_id = e.src_id)
        GROUP BY e.edge_id, e.dst_id`,
    ).all()

    const existingEdge = prepare<[string, string], { edge_id: number }>(
      bundle.db,
      `SELECT edge_id
         FROM edges
        WHERE src_type = 'message'
          AND src_id = ?
          AND dst_type = 'session'
          AND dst_id = ?
          AND edge_type = 'spawned'
        LIMIT 1`,
    )
    const deleteEdge = prepare<[number]>(bundle.db, `DELETE FROM edges WHERE edge_id = ?`)
    const updateEdge = prepare<[string, number]>(bundle.db, `UPDATE edges SET src_id = ? WHERE edge_id = ?`)

    for (const candidate of candidates) {
      if (existingEdge.get(candidate.resolved_src_id, candidate.dst_id)) {
        deleteEdge.run(candidate.edge_id)
      } else {
        updateEdge.run(candidate.resolved_src_id, candidate.edge_id)
      }
    }

    bundle.db.exec(`
      UPDATE sessions
         SET parent_session_id = (
               SELECT e.src_id
                 FROM edges e
                WHERE e.edge_type = 'spawned'
                  AND e.dst_type = 'session'
                  AND e.dst_id   = sessions.session_id
                  AND EXISTS (SELECT 1 FROM sessions p WHERE p.session_id = e.src_id)
                LIMIT 1
             )
       WHERE parent_session_id IS NULL
         AND is_subagent = 1
         AND source_tool = 'claude'
    `)
  })
}

/** Per-source-file deltas that are merged into the import batch counts. */
interface FileCounts {
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

/** Create zeroed file counters for a Claude file that may still fail or be skipped. */
function emptyFileCounts(): FileCounts {
  return {
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

/** Merge a single Claude file's normalized row counts into batch totals. */
function addCounts(target: ImportCounts, source: FileCounts): void {
  target.source_files_imported += source.source_files_imported
  target.source_files_skipped += source.source_files_skipped
  target.raw_records += source.raw_records
  target.sessions += source.sessions
  target.turns += source.turns
  target.events += source.events
  target.messages += source.messages
  target.content_blocks += source.content_blocks
  target.tool_calls += source.tool_calls
  target.tool_results += source.tool_results
  target.artifacts += source.artifacts
  target.edges += source.edges
  target.errors += source.errors
}

// -- per file --

/** Raw record row staged from a Claude JSONL line before database insertion. */
interface PendingRawRecord {
  raw_record_id: string
  source_file_id: string
  ordinal: number
  line_no: number
  native_id: string | null
  raw_object_id: ObjectId
  decoded_json_object_id: ObjectId | null
  parser_status: 'ok' | 'partial' | 'failed'
  confidence: 'high' | 'medium' | 'low'
  import_batch_id: string
}

/** Session row staged from the first Claude record with a session id. */
interface PendingSession {
  session_id: string
  source_session_id: string
  is_subagent: 0 | 1
  agent_role: string | null
  agent_nickname: string | null
  title: string | null
  start_ts: string | null
  end_ts: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  raw_record_id: string | null
  /** for subagent files; resolved cross-file in linkSubagentParents */
  parent_session_id_pending: string | null
}

/** Event row staged from Claude user, assistant, system, or operational records. */
interface PendingEvent {
  event_id: string
  ordinal: number
  source_event_id: string | null
  event_type: string
  source_type: string
  subtype: string | null
  timestamp: string | null
  actor: string | null
  payload_object_id: ObjectId | null
  raw_record_id: string
  confidence: 'high' | 'medium' | 'low'
}

/** Message row staged from Claude user and assistant records. */
interface PendingMessage {
  message_id: string
  event_id: string | null
  source_message_id: string | null
  role: 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'
  model: string | null
  timestamp: string | null
  ordinal: number
  parent_message_id: string | null
  parent_uuid: string | null // for parent_of edge linking by uuid
  uuid: string | null
  raw_record_id: string
}

/** Content block row staged from Claude text, thinking, tool, image, or unknown blocks. */
interface PendingBlock {
  block_id: string
  message_id: string | null
  event_id: string | null
  ordinal: number
  block_type: string
  text_object_id: ObjectId | null
  text_inline: string | null
  is_error: 0 | 1
  visibility: 'default' | 'hidden_by_default' | 'audit_only'
  raw_record_id: string
}

/** Tool call row staged from Claude `tool_use` content blocks. */
interface PendingToolCall {
  tool_call_id: string
  message_id: string | null
  event_id: string | null
  source_call_id: string
  tool_name: string
  canonical_tool_type: string
  args_object_id: ObjectId | null
  command: string | null
  cwd: string | null
  path: string | null
  query: string | null
  timestamp_start: string | null
  status: string | null
  raw_record_id: string
}

/** Tool result row staged from Claude `tool_result` content blocks. */
interface PendingToolResult {
  tool_result_id: string
  tool_call_id: string | null
  source_call_id: string | null
  message_id: string | null
  event_id: string | null
  status: string | null
  is_error: 0 | 1
  exit_code: number | null
  duration_ms: number | null
  stdout_object_id: ObjectId | null
  stderr_object_id: ObjectId | null
  output_object_id: ObjectId | null
  preview: string | null
  raw_record_id: string
}

/** Artifact row staged from Claude records that point to external or generated content. */
interface PendingArtifact {
  artifact_id: string
  kind: string
  path: string | null
  logical_path: string | null
  object_id: ObjectId | null
  text_object_id: ObjectId | null
  mime_type: string | null
  size_bytes: number
  created_ts: string | null
  raw_record_id: string
}

/** Graph edge row staged for Claude parent-message and subagent relationships. */
interface PendingEdge {
  src_type: string
  src_id: string
  dst_type: string
  dst_id: string
  edge_type: string
  confidence: 'high' | 'medium' | 'low'
  source: string
  raw_record_id: string | null
}

/** Search index row staged from normalized Claude messages, commands, paths, and previews. */
interface PendingSearchDoc {
  doc_id: string
  entity_type: string
  entity_id: string
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  text: string
}

/** All normalized Claude rows staged for one source file before FK-ordered flush. */
interface PendingState {
  rawRecords: PendingRawRecord[]
  session: PendingSession | null
  events: PendingEvent[]
  messages: PendingMessage[]
  blocks: PendingBlock[]
  toolCalls: Map<string, PendingToolCall>
  toolCallsList: PendingToolCall[]
  toolResults: PendingToolResult[]
  artifacts: PendingArtifact[]
  edges: PendingEdge[]
  searchDocs: PendingSearchDoc[]
  /** map uuid → message_id for parent_of edges resolved at flush time. */
  uuidToMessageId: Map<string, string>
  objects: PendingObjects
}

/** Parse one Claude JSONL file, stage CAS objects, and flush normalized rows. */
async function compileClaudeFile(
  bundle: Bundle,
  batch: ImportBatch,
  file: ClaudeFile,
  logger?: CompileLogger,
): Promise<FileCounts> {
  const counts = emptyFileCounts()

  const { row: sourceFile, alreadyKnown } = await registerSourceFile(bundle, {
    sourceTool: 'claude',
    absolutePath: path.resolve(file.filePath),
    fileKind: 'jsonl',
    workspaceHint: file.projectSlug,
  })

  if (alreadyKnown) {
    counts.source_files_skipped = 1
    logger?.debug({ path: file.filePath, source_file_id: sourceFile.source_file_id }, 'claude source file skipped')
    return counts
  }
  counts.source_files_imported = 1
  logger?.debug({ path: file.filePath, source_file_id: sourceFile.source_file_id }, 'claude source file registered')

  const text = await readFile(file.filePath, 'utf8')
  const rawLines = text.split('\n')
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines

  const meta = file.metaPath ? await readMeta(file.metaPath) : null

  const pending: PendingState = {
    rawRecords: [],
    session: null,
    events: [],
    messages: [],
    blocks: [],
    toolCalls: new Map(),
    toolCallsList: [],
    toolResults: [],
    artifacts: [],
    edges: [],
    searchDocs: [],
    uuidToMessageId: new Map(),
    objects: createPendingObjects(),
  }

  let modelFirst: string | null = null
  let modelLast: string | null = null
  let messageOrdinal = 0
  let sessionStartTs: string | null = null
  let sessionEndTs: string | null = null
  let cwdInitial: string | null = null
  let branchInitial: string | null = null

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line || line.length === 0) continue
    const lineNo = i + 1
    const ordinal = i

    const lineBytes = Buffer.from(line, 'utf8')
    const rawObjectId = stageBytes(pending.objects, lineBytes, {
      mimeType: 'application/jsonl-line',
      encoding: 'utf-8',
    })

    let parsed: ClaudeRecord | null = null
    let parserStatus: 'ok' | 'partial' | 'failed' = 'ok'
    try {
      parsed = JSON.parse(line) as ClaudeRecord
    } catch {
      parserStatus = 'failed'
    }

    // The raw line already IS the JSON for `parserStatus === 'ok'`, so we
    // skip storing a re-serialized copy as `decoded_json_object_id`. Saves
    // ~half the CAS writes per file. Nothing reads it back later.
    const decodedObjectId: ObjectId | null = null

    const nativeId = parsed?.uuid ?? null
    const rawRecordId = makeRawRecordId(sourceFile.source_file_id, ordinal, rawObjectId)

    pending.rawRecords.push({
      raw_record_id: rawRecordId,
      source_file_id: sourceFile.source_file_id,
      ordinal,
      line_no: lineNo,
      native_id: nativeId,
      raw_object_id: rawObjectId,
      decoded_json_object_id: decodedObjectId,
      parser_status: parserStatus,
      confidence: parserStatus === 'ok' ? 'high' : 'low',
      import_batch_id: batch.batch_id,
    })

    if (!parsed) continue

    const ts = typeof parsed.timestamp === 'string' ? parsed.timestamp : null
    if (ts) {
      if (!sessionStartTs || ts < sessionStartTs) sessionStartTs = ts
      if (!sessionEndTs || ts > sessionEndTs) sessionEndTs = ts
    }
    if (!cwdInitial && typeof parsed.cwd === 'string') cwdInitial = parsed.cwd
    if (!branchInitial && typeof parsed.gitBranch === 'string') branchInitial = parsed.gitBranch

    // Resolve session on first record that carries a sessionId.
    if (!pending.session && typeof parsed.sessionId === 'string') {
      pending.session = createSessionFromFirstRecord(file, parsed, meta, ts, rawRecordId)
      if (file.isSubagent && file.parentSessionId) {
        const parentSid = makeSessionId('claude', file.parentSessionId)
        pending.edges.push({
          src_type: 'session',
          src_id: parentSid,
          dst_type: 'session',
          dst_id: pending.session.session_id,
          edge_type: 'spawned',
          confidence: 'high',
          source: 'path_inferred',
          raw_record_id: rawRecordId,
        })
        pending.session.parent_session_id_pending = parentSid
      }
    }

    const sessionId = pending.session?.session_id ?? makeSessionId('claude', `unknown:${path.basename(file.filePath)}`)

    const type = typeof parsed.type === 'string' ? parsed.type : null

    if (type === 'user' || type === 'assistant') {
      const msgRole: PendingMessage['role'] = type === 'user' ? 'user' : 'assistant'
      const role = inferRoleFromContent(parsed, msgRole)
      const msgOrdinal = messageOrdinal++
      const messageId = makeMessageId(sessionId, msgOrdinal, parsed.message?.id ?? parsed.uuid ?? null)
      const eventId = makeEventId(sessionId, ordinal, 'message')

      pending.events.push({
        event_id: eventId,
        ordinal,
        source_event_id: parsed.uuid ?? null,
        event_type: 'message',
        source_type: type,
        subtype: null,
        timestamp: ts,
        actor: msgRole,
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })

      const model = parsed.message?.model ?? null
      if (msgRole === 'assistant' && model) {
        if (!modelFirst) modelFirst = model
        modelLast = model
      }

      pending.messages.push({
        message_id: messageId,
        event_id: eventId,
        source_message_id: parsed.message?.id ?? null,
        role,
        model: msgRole === 'assistant' ? model : null,
        timestamp: ts,
        ordinal: msgOrdinal,
        parent_message_id: null,
        parent_uuid: parsed.parentUuid ?? null,
        uuid: parsed.uuid ?? null,
        raw_record_id: rawRecordId,
      })
      if (parsed.uuid) pending.uuidToMessageId.set(parsed.uuid, messageId)
      if (parsed.isSidechain && parsed.sourceToolAssistantUUID) {
        pending.edges.push({
          src_type: 'message',
          src_id: parsed.sourceToolAssistantUUID,
          dst_type: 'session',
          dst_id: sessionId,
          edge_type: 'spawned',
          confidence: 'high',
          source: 'source_tool_assistant_uuid',
          raw_record_id: rawRecordId,
        })
      }

      const content = parsed.message?.content
      if (typeof content === 'string') {
        pending.blocks.push({
          block_id: blockId(messageId, 0),
          message_id: messageId,
          event_id: null,
          ordinal: 0,
          block_type: 'text',
          text_object_id: null,
          text_inline: content.slice(0, PREVIEW_MAX),
          is_error: 0,
          visibility: 'default',
          raw_record_id: rawRecordId,
        })
        if (content.length > PREVIEW_MAX) {
          // Big text — also store full body in CAS for later retrieval.
          const fullId = stageText(pending.objects, content)
          const last = pending.blocks[pending.blocks.length - 1]
          if (last) last.text_object_id = fullId
        }
      } else if (Array.isArray(content)) {
        for (let bi = 0; bi < content.length; bi++) {
          const block = content[bi] as ClaudeContentBlock | undefined
          if (!block) continue
          await processContentBlock(bundle, sessionId, messageId, eventId, bi, block, ts, rawRecordId, pending)
        }
      }
      continue
    }

    if (type === 'system') {
      // Critical: Claude's `type=system` is OPERATIONAL (hooks, turn duration,
      // local commands, api errors). It's not a system prompt.
      pending.events.push({
        event_id: makeEventId(sessionId, ordinal, 'system_operational'),
        ordinal,
        source_event_id: parsed.uuid ?? null,
        event_type: 'system_operational',
        source_type: 'system',
        subtype: parsed.subtype ?? null,
        timestamp: ts,
        actor: 'system',
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })
      continue
    }

    if (type === 'progress') {
      const progressType = typeof parsed.data?.type === 'string' ? (parsed.data.type as string) : null
      pending.events.push({
        event_id: makeEventId(sessionId, ordinal, `progress.${progressType ?? 'unknown'}`),
        ordinal,
        source_event_id: parsed.uuid ?? null,
        event_type: 'progress',
        source_type: 'progress',
        subtype: progressType,
        timestamp: ts,
        actor: 'system',
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })
      continue
    }

    if (type === 'attachment') {
      pending.events.push({
        event_id: makeEventId(sessionId, ordinal, 'attachment'),
        ordinal,
        source_event_id: parsed.uuid ?? null,
        event_type: 'file_history_snapshot',
        source_type: 'attachment',
        subtype: parsed.attachment?.type ?? null,
        timestamp: ts,
        actor: 'system',
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })
      continue
    }

    if (type === 'file-history-snapshot') {
      pending.events.push({
        event_id: makeEventId(sessionId, ordinal, 'file_history_snapshot'),
        ordinal,
        source_event_id: parsed.uuid ?? null,
        event_type: 'attachment',
        source_type: 'file-history-snapshot',
        subtype: parsed.isSnapshotUpdate ? 'update' : 'snapshot',
        timestamp: ts,
        actor: 'system',
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })
      pending.artifacts.push({
        artifact_id: artifactId(sessionId, 'claude', `snapshot:${parsed.snapshot?.messageId ?? ordinal}`),
        kind: 'snapshot',
        path: null,
        logical_path: null,
        object_id: null,
        text_object_id: null,
        mime_type: 'application/json',
        size_bytes: line.length,
        created_ts: ts,
        raw_record_id: rawRecordId,
      })
      continue
    }

    // permission-mode, last-prompt, queue-operation, agent-name, custom-title,
    // pr-link, etc. — keep as operational events.
    pending.events.push({
      event_id: makeEventId(sessionId, ordinal, `claude.${type ?? 'unknown'}`),
      ordinal,
      source_event_id: parsed.uuid ?? null,
      event_type: 'system_operational',
      source_type: type ?? 'unknown',
      subtype: null,
      timestamp: ts,
      actor: 'system',
      payload_object_id: decodedObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })
  }

  // Resolve parent_of edges by uuid.
  for (const m of pending.messages) {
    if (m.parent_uuid && pending.uuidToMessageId.has(m.parent_uuid)) {
      const parentId = pending.uuidToMessageId.get(m.parent_uuid)!
      m.parent_message_id = parentId
      pending.edges.push({
        src_type: 'message',
        src_id: parentId,
        dst_type: 'message',
        dst_id: m.message_id,
        edge_type: 'parent_of',
        confidence: 'high',
        source: 'explicit',
        raw_record_id: m.raw_record_id,
      })
    }
  }

  if (pending.session) {
    pending.session.start_ts ??= sessionStartTs
    pending.session.end_ts ??= sessionEndTs
    pending.session.cwd_initial ??= cwdInitial
    pending.session.git_branch_initial ??= branchInitial
  }

  buildSearchDocs(pending)

  // Persist staged CAS objects (FS + objects rows) before the domain
  // transaction. better-sqlite3 transactions are sync, so we can't await
  // file writes inside them.
  await flushPendingObjects(bundle, pending.objects)

  transactional(bundle.db, () => {
    flushPending(bundle, pending, { modelFirst, modelLast })
  })

  counts.raw_records = pending.rawRecords.length
  counts.sessions = pending.session ? 1 : 0
  counts.events = pending.events.length
  counts.messages = pending.messages.length
  counts.content_blocks = pending.blocks.length
  counts.tool_calls = pending.toolCallsList.length
  counts.tool_results = pending.toolResults.length
  counts.artifacts = pending.artifacts.length
  counts.edges = pending.edges.length
  logger?.debug(
    { path: file.filePath, source_file_id: sourceFile.source_file_id, counts },
    'claude source file imported',
  )

  return counts
}

/** Build the normalized session id, keeping Claude subagents distinct from parent sessions. */
function createSessionFromFirstRecord(
  file: ClaudeFile,
  parsed: ClaudeRecord,
  meta: ClaudeSubagentMeta | null,
  ts: string | null,
  rawRecordId: string,
): PendingSession {
  const sourceSid = parsed.sessionId as string
  // Subagent and main share the same `sessionId` field. Differentiate by
  // appending the agentId for subagents to keep PKs stable.
  const composite = file.isSubagent && file.agentId ? `${sourceSid}:${file.agentId}` : sourceSid
  return {
    session_id: makeSessionId('claude', composite),
    source_session_id: composite,
    is_subagent: file.isSubagent ? 1 : 0,
    agent_role: meta?.agentType ?? null,
    agent_nickname: parsed.agentName ?? null,
    title: meta?.description ?? null,
    start_ts: ts,
    end_ts: null,
    cwd_initial: parsed.cwd ?? null,
    git_branch_initial: parsed.gitBranch ?? null,
    raw_record_id: rawRecordId,
    parent_session_id_pending: null,
  }
}

/** Read optional Claude subagent metadata, treating missing or malformed files as absent. */
async function readMeta(metaPath: string): Promise<ClaudeSubagentMeta | null> {
  try {
    const text = await readFile(metaPath, 'utf8')
    return JSON.parse(text) as ClaudeSubagentMeta
  } catch {
    return null
  }
}

/** Reclassify tool-result-only Claude user messages as tool output for search and filters. */
function inferRoleFromContent(parsed: ClaudeRecord, fallback: 'user' | 'assistant'): PendingMessage['role'] {
  // A user-typed message that contains only tool_result blocks is the agent
  // delivering tool output back to itself. Mark as 'tool' role for clarity in
  // search/filters; mixed messages stay as 'user'.
  if (fallback !== 'user') return 'assistant'
  const c = parsed.message?.content
  if (!Array.isArray(c) || c.length === 0) return 'user'
  const allToolResult = c.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
  return allToolResult ? 'tool' : 'user'
}

/** Normalize one Claude content block into blocks, tool calls, tool results, or audit rows. */
async function processContentBlock(
  bundle: Bundle,
  sessionId: string,
  messageId: string,
  eventId: string,
  blockOrdinal: number,
  block: ClaudeContentBlock,
  ts: string | null,
  rawRecordId: string,
  pending: PendingState,
): Promise<void> {
  const blkId = blockId(messageId, blockOrdinal)

  if (block.type === 'text') {
    const text = (block as { text?: string }).text ?? ''
    pending.blocks.push({
      block_id: blkId,
      message_id: messageId,
      event_id: null,
      ordinal: blockOrdinal,
      block_type: 'text',
      text_object_id: text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null,
      text_inline: text.slice(0, PREVIEW_MAX),
      is_error: 0,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })
    return
  }

  if (block.type === 'thinking') {
    const text = (block as { thinking?: string }).thinking ?? ''
    pending.blocks.push({
      block_id: blkId,
      message_id: messageId,
      event_id: null,
      ordinal: blockOrdinal,
      block_type: 'thinking',
      text_object_id: text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null,
      text_inline: text.slice(0, PREVIEW_MAX),
      is_error: 0,
      visibility: 'hidden_by_default',
      raw_record_id: rawRecordId,
    })
    return
  }

  if (block.type === 'tool_use') {
    const tu = block as { id?: string; name?: string; input?: unknown }
    const sourceCallId = tu.id ?? `${blockOrdinal}`
    const toolName = tu.name ?? 'unknown'
    const argsId = tu.input != null ? stageJson(pending.objects, tu.input) : null
    const command = inferCommandFromArgs(toolName, tu.input)
    const filePath = inferPathFromArgs(tu.input)
    const tcId = makeToolCallId(sessionId, sourceCallId)

    pending.blocks.push({
      block_id: blkId,
      message_id: messageId,
      event_id: null,
      ordinal: blockOrdinal,
      block_type: 'tool_use',
      text_object_id: null,
      text_inline: null,
      is_error: 0,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })

    const call: PendingToolCall = {
      tool_call_id: tcId,
      message_id: messageId,
      event_id: eventId,
      source_call_id: sourceCallId,
      tool_name: toolName,
      canonical_tool_type: canonicalToolType(toolName),
      args_object_id: argsId,
      command,
      cwd: null,
      path: filePath,
      query: null,
      timestamp_start: ts,
      status: 'started',
      raw_record_id: rawRecordId,
    }
    pending.toolCalls.set(sourceCallId, call)
    pending.toolCallsList.push(call)
    return
  }

  if (block.type === 'tool_result') {
    const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean }
    const sourceCallId = tr.tool_use_id ?? null
    const isError = tr.is_error === true ? 1 : 0
    const text = stringifyOrNull(tr.content) ?? ''
    const overflowId = text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null
    pending.blocks.push({
      block_id: blkId,
      message_id: messageId,
      event_id: null,
      ordinal: blockOrdinal,
      block_type: 'tool_result',
      text_object_id: overflowId,
      text_inline: text.slice(0, PREVIEW_MAX),
      is_error: isError,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })

    const matched = sourceCallId ? pending.toolCalls.get(sourceCallId) : undefined
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionId, sourceCallId ?? `${messageId}:${blockOrdinal}`),
      tool_call_id: matched?.tool_call_id ?? null,
      source_call_id: sourceCallId,
      message_id: messageId,
      event_id: eventId,
      status: normalizeToolCallStatus('claude', matched ? (isError ? 'error' : 'success') : null),
      is_error: isError,
      exit_code: null,
      duration_ms: null,
      stdout_object_id: null,
      stderr_object_id: null,
      output_object_id: overflowId,
      preview: text.slice(0, PREVIEW_MAX),
      raw_record_id: rawRecordId,
    })
    if (matched) {
      matched.status = isError ? 'error' : 'success'
    }
    return
  }

  if (block.type === 'image') {
    pending.blocks.push({
      block_id: blkId,
      message_id: messageId,
      event_id: null,
      ordinal: blockOrdinal,
      block_type: 'image',
      text_object_id: null,
      text_inline: null,
      is_error: 0,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })
    return
  }

  // Unknown block type — keep it as raw inline JSON for visibility.
  pending.blocks.push({
    block_id: blkId,
    message_id: messageId,
    event_id: null,
    ordinal: blockOrdinal,
    block_type: (block as { type?: string }).type ?? 'unknown',
    text_object_id: null,
    text_inline: stringifyOrNull(block)?.slice(0, PREVIEW_MAX) ?? null,
    is_error: 0,
    visibility: 'audit_only',
    raw_record_id: rawRecordId,
  })
}

/** Collapse Claude tool names into broad search/filter tool categories. */
function canonicalToolType(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.startsWith('mcp__')) return 'mcp'
  if (lower === 'bash' || lower === 'shell' || lower === 'run_terminal_cmd') return 'shell'
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'read_file'
  if (lower === 'write' || lower === 'writefile' || lower === 'write_file') return 'write_file'
  if (
    lower === 'edit' ||
    lower === 'strreplace' ||
    lower === 'str_replace' ||
    lower === 'replace' ||
    lower === 'search_replace'
  ) {
    return 'edit_file'
  }
  if (lower === 'grep' || lower === 'glob' || lower === 'glob_file_search') return 'search_file'
  if (lower === 'websearch' || lower === 'google_web_search') return 'web_search'
  if (lower === 'webfetch') return 'other'
  if (lower === 'agent') return 'subagent'
  if (lower === 'applypatch' || lower === 'apply_patch') return 'patch'
  return 'other'
}

/** Extract a shell command from Claude tool arguments when the native tool exposes one. */
function inferCommandFromArgs(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (toolName.toLowerCase() === 'bash' && typeof obj.cmd === 'string') return obj.cmd
  return null
}

/** Extract a file path from Claude tool arguments without treating absence as an error. */
function inferPathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.absolute_path === 'string') return obj.absolute_path
  return null
}

/** Convert arbitrary recovered payload values into compact text previews when possible. */
function stringifyOrNull(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** Build searchable Claude documents while excluding hidden thinking from default search. */
function buildSearchDocs(pending: PendingState): void {
  const sessionId = pending.session?.session_id ?? null
  if (!sessionId) return

  const blocksByMsg = new Map<string, PendingBlock[]>()
  for (const b of pending.blocks) {
    if (!b.message_id) continue
    if (!b.text_inline) continue
    if (b.block_type !== 'text' && b.block_type !== 'thinking' && b.block_type !== 'tool_result') continue
    const list = blocksByMsg.get(b.message_id) ?? []
    list.push(b)
    blocksByMsg.set(b.message_id, list)
  }

  for (const m of pending.messages) {
    const blks = blocksByMsg.get(m.message_id) ?? []
    const text = blks
      .filter((b) => b.block_type !== 'thinking') // hide reasoning from default search
      .map((b) => b.text_inline ?? '')
      .join('\n')
      .trim()
    if (!text) continue
    pending.searchDocs.push({
      doc_id: `msg:${m.message_id}`,
      entity_type: 'message',
      entity_id: m.message_id,
      timestamp: m.timestamp,
      role: m.role,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: m.role === 'user' ? 'user_prompt' : m.role === 'tool' ? 'tool_result' : 'assistant_text',
      text,
    })
  }

  for (const c of pending.toolCallsList) {
    if (c.command) {
      pending.searchDocs.push({
        doc_id: `tc:cmd:${c.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: c.tool_call_id,
        timestamp: c.timestamp_start,
        role: null,
        tool_name: c.tool_name,
        canonical_tool_type: c.canonical_tool_type,
        field_kind: 'command',
        text: c.command,
      })
    }
    if (c.path) {
      pending.searchDocs.push({
        doc_id: `tc:path:${c.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: c.tool_call_id,
        timestamp: c.timestamp_start,
        role: null,
        tool_name: c.tool_name,
        canonical_tool_type: c.canonical_tool_type,
        field_kind: 'file_path',
        text: c.path,
      })
    }
  }

  for (const r of pending.toolResults) {
    if (!r.preview) continue
    pending.searchDocs.push({
      doc_id: `tr:preview:${r.tool_result_id}`,
      entity_type: 'tool_result',
      entity_id: r.tool_result_id,
      timestamp: null,
      role: null,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: r.is_error ? 'error' : 'tool_result',
      text: r.preview,
    })
  }
}

/** Insert staged Claude rows in foreign-key order after CAS objects are already durable. */
function flushPending(
  bundle: Bundle,
  pending: PendingState,
  meta: { modelFirst: string | null; modelLast: string | null },
): void {
  if (!pending.session) return

  const insertRaw = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO raw_records (
       raw_record_id, source_file_id, source_tool, record_kind, ordinal,
       line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id,
       parser_status, confidence, import_batch_id
     ) VALUES (?, ?, 'claude', 'jsonl_line', ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of pending.rawRecords) {
    insertRaw.run(
      r.raw_record_id,
      r.source_file_id,
      r.ordinal,
      r.line_no,
      r.native_id,
      r.raw_object_id,
      r.decoded_json_object_id,
      r.parser_status,
      r.confidence,
      r.import_batch_id,
    )
  }

  prepare(
    bundle.db,
    `INSERT OR REPLACE INTO sessions (
       session_id, source_tool, source_session_id, project_id, parent_session_id,
       is_subagent, agent_role, agent_nickname, title, summary,
       start_ts, end_ts, cwd_initial, git_branch_initial,
       model_first, model_last, status, timeline_confidence, raw_record_id
     ) VALUES (?, 'claude', ?, NULL, NULL, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, 'completed', 'high', ?)`,
  ).run(
    pending.session.session_id,
    pending.session.source_session_id,
    pending.session.is_subagent,
    pending.session.agent_role,
    pending.session.agent_nickname,
    pending.session.title,
    pending.session.start_ts,
    pending.session.end_ts,
    pending.session.cwd_initial,
    pending.session.git_branch_initial,
    meta.modelFirst,
    meta.modelLast,
    pending.session.raw_record_id,
  )

  const insertEvent = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO events (
       event_id, session_id, turn_id, source_event_id, event_type, source_type,
       subtype, timestamp, ordinal, actor, payload_object_id, raw_record_id,
       confidence, is_derived
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const e of pending.events) {
    insertEvent.run(
      e.event_id,
      pending.session.session_id,
      e.source_event_id,
      e.event_type,
      e.source_type,
      e.subtype,
      e.timestamp,
      e.ordinal,
      e.actor,
      e.payload_object_id,
      e.raw_record_id,
      e.confidence,
    )
  }

  const insertMessage = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO messages (
       message_id, session_id, turn_id, event_id, source_message_id, role,
       author_name, model, timestamp, ordinal, parent_message_id, request_id,
       status, raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, NULL, ?)`,
  )
  for (const m of pending.messages) {
    insertMessage.run(
      m.message_id,
      pending.session.session_id,
      m.event_id,
      m.source_message_id,
      m.role,
      m.model,
      m.timestamp,
      m.ordinal,
      m.parent_message_id,
      m.raw_record_id,
    )
  }

  const insertBlock = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO content_blocks (
       block_id, message_id, event_id, session_id, ordinal, block_type,
       text_object_id, text_inline, mime_type, token_count, is_error,
       is_redacted, visibility, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, 0, ?, ?)`,
  )
  for (const b of pending.blocks) {
    insertBlock.run(
      b.block_id,
      b.message_id,
      b.event_id,
      pending.session.session_id,
      b.ordinal,
      b.block_type,
      b.text_object_id,
      b.text_inline,
      b.is_error,
      b.visibility,
      b.raw_record_id,
    )
  }

  const insertToolCall = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_calls (
       tool_call_id, session_id, turn_id, message_id, event_id,
       source_call_id, tool_name, canonical_tool_type, args_object_id,
       command, cwd, path, query, timestamp_start, timestamp_end, status,
       raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
  for (const c of pending.toolCallsList) {
    insertToolCall.run(
      c.tool_call_id,
      pending.session.session_id,
      c.message_id,
      c.event_id,
      c.source_call_id,
      c.tool_name,
      c.canonical_tool_type,
      c.args_object_id,
      c.command,
      c.cwd,
      c.path,
      c.query,
      c.timestamp_start,
      c.status,
      c.raw_record_id,
    )
  }

  const insertToolResult = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_results (
       tool_result_id, tool_call_id, session_id, message_id, event_id,
       source_call_id, status, is_error, exit_code, duration_ms,
       stdout_object_id, stderr_object_id, output_object_id, preview, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of pending.toolResults) {
    insertToolResult.run(
      r.tool_result_id,
      r.tool_call_id,
      pending.session.session_id,
      r.message_id,
      r.event_id,
      r.source_call_id,
      r.status,
      r.is_error,
      r.exit_code,
      r.duration_ms,
      r.stdout_object_id,
      r.stderr_object_id,
      r.output_object_id,
      r.preview,
      r.raw_record_id,
    )
  }

  const insertArtifact = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO artifacts (
       artifact_id, session_id, project_id, source_tool, kind, path,
       logical_path, object_id, text_object_id, mime_type, size_bytes,
       created_ts, raw_record_id
     ) VALUES (?, ?, NULL, 'claude', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const a of pending.artifacts) {
    insertArtifact.run(
      a.artifact_id,
      pending.session.session_id,
      a.kind,
      a.path,
      a.logical_path,
      a.object_id,
      a.text_object_id,
      a.mime_type,
      a.size_bytes,
      a.created_ts,
      a.raw_record_id,
    )
  }

  const insertEdge = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO edges (
       src_type, src_id, dst_type, dst_id, edge_type, confidence, source,
       raw_record_id, metadata_object_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  )
  for (const e of pending.edges) {
    insertEdge.run(e.src_type, e.src_id, e.dst_type, e.dst_id, e.edge_type, e.confidence, e.source, e.raw_record_id)
  }

  const insertSearch = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO search_docs (
       doc_id, entity_type, entity_id, session_id, project_id, timestamp,
       role, tool_name, canonical_tool_type, field_kind, text
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
  )
  for (const d of pending.searchDocs) {
    insertSearch.run(
      d.doc_id,
      d.entity_type,
      d.entity_id,
      pending.session.session_id,
      d.timestamp,
      d.role,
      d.tool_name,
      d.canonical_tool_type,
      d.field_kind,
      d.text,
    )
  }
}
