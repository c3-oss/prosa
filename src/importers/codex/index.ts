import { readFile } from 'node:fs/promises'
import path from 'node:path'
import type { Bundle } from '../../core/bundle.js'
import {
  type ObjectId,
  type PendingObjects,
  createPendingObjects,
  flushPendingObjects,
  stageBytes,
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
  turnId as makeTurnId,
} from '../../core/domain/ids.js'
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
import { discoverCodexSessions } from './discover.js'
import type {
  CodexContentItem,
  CodexEnvelope,
  CodexEventMsgPayload,
  CodexResponseItemPayload,
  CodexSessionMetaPayload,
  CodexTurnContextPayload,
} from './types.js'

/** Result returned after a Codex compile batch finishes or records a failed batch. */
export interface CompileResult {
  /** Import batch created for this Codex run. */
  batch: ImportBatch
  /** Final counts accumulated while importing Codex files. */
  counts: ImportCounts
}

/** Maximum inline text retained in normalized rows before full content moves to CAS. */
const PREVIEW_MAX = 4_000

/**
 * Number of Codex files prepared concurrently before each short per-file
 * database transaction. Prepare is I/O-heavy; applying rows stays serial to
 * avoid long write transactions and growing WAL lookup costs.
 */
const CODEX_PREPARE_CONCURRENCY = 8

/** Compile Codex JSONL session files under `root` into the bundle. */
export async function compileCodex(bundle: Bundle, root: string, options: CompileOptions = {}): Promise<CompileResult> {
  const logger = options.logger
  const batch = startBatch(bundle, 'codex', [root])
  const counts = emptyCounts()
  logger?.info({ batch_id: batch.batch_id, root }, 'codex batch started')

  try {
    const files: string[] = []
    for await (const filePath of discoverCodexSessions(root)) {
      files.push(filePath)
      logger?.debug({ path: filePath }, 'codex source file discovered')
    }
    counts.source_files_seen = files.length

    for (let i = 0; i < files.length; i += CODEX_PREPARE_CONCURRENCY) {
      const slice = files.slice(i, i + CODEX_PREPARE_CONCURRENCY)
      await processCodexBatch(bundle, batch, slice, counts, logger)
    }

    linkSubagentParents(bundle)
    logger?.debug({ batch_id: batch.batch_id }, 'codex subagent parent links refreshed')
    finishBatch(bundle, batch, counts, 'completed')
    logger?.info({ batch_id: batch.batch_id, counts }, 'codex batch completed')
  } catch (error) {
    finishBatch(bundle, batch, counts, 'failed')
    logger?.error({ err: error, batch_id: batch.batch_id, counts }, 'codex batch failed')
    throw error
  }

  return { batch, counts }
}

/** Parsed and CAS-staged Codex file waiting for the short domain insert transaction. */
interface CodexPrepared {
  filePath: string
  pending: PendingState
  meta: { sessionEndTs: string | null; modelFirst: string | null; modelLast: string | null }
}

/** Per-file state tracked while a concurrent Codex prepare slice is applied. */
interface CodexBatchItem {
  filePath: string
  prepared: CodexPrepared | null
  fileCounts: FileCounts
  prepareError: Error | null
  applyError: Error | null
}

/** Prepare a slice concurrently, then apply each prepared file in its own transaction. */
async function processCodexBatch(
  bundle: Bundle,
  batch: ImportBatch,
  slice: string[],
  counts: ImportCounts,
  logger?: CompileLogger,
): Promise<void> {
  // Phase A: parse + CAS flush for the whole slice concurrently. Each file's
  // prepare is independent — registerSourceFile is idempotent and CAS writes
  // are content-addressed — so we can overlap their I/O.
  const items = await Promise.all(
    slice.map(async (filePath): Promise<CodexBatchItem> => {
      try {
        const result = await prepareCodexFile(bundle, batch, filePath, logger)
        return {
          filePath,
          prepared: result.prepared,
          fileCounts: result.counts,
          prepareError: null,
          applyError: null,
        }
      } catch (err) {
        return {
          filePath,
          prepared: null,
          fileCounts: emptyFileCounts(),
          prepareError: err as Error,
          applyError: null,
        }
      }
    }),
  )

  // Phase B: domain INSERTs run one file at a time, each in its own short
  // transaction. We tried wrapping the whole slice in one outer transaction
  // with savepoints per file — that turned the steady-state insert loop CPU-
  // bound because INSERT OR IGNORE lookups had to walk the growing WAL inside
  // the long transaction. Per-file commits keep the WAL small.
  for (const item of items) {
    if (item.prepareError || !item.prepared) continue
    try {
      transactional(bundle.db, () => applyCodexFile(bundle, item.prepared as CodexPrepared))
    } catch (err) {
      item.applyError = err as Error
    }
  }

  // Phase C: aggregate counts and record per-file errors.
  for (const item of items) {
    const err = item.prepareError ?? item.applyError
    if (err) {
      counts.errors++
      logger?.warn({ err, path: item.filePath }, 'codex source file failed')
      await recordError(bundle, batch.batch_id, {
        kind: 'codex_file_failed',
        message: getErrorMessage(err),
        payload: { path: item.filePath },
      })
    } else {
      addCounts(counts, item.fileCounts)
    }
  }
}

/**
 * After every file is committed, fill `sessions.parent_session_id` from any
 * `edges(spawned)` whose target session now exists. We deliberately set
 * `parent_session_id=NULL` during per-file inserts because a subagent file may
 * be processed before the parent file; deferring the link to a single UPDATE
 * keeps every per-file transaction self-contained.
 */
function linkSubagentParents(bundle: Bundle): void {
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
  `)
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

/** Create zeroed file counters for a Codex file that may still fail or be skipped. */
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

/** Merge a single Codex file's normalized row counts into batch totals. */
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

// ---- per-file pipeline ---------------------------------------------------

/** Raw record row staged from a Codex JSONL line before database insertion. */
interface PendingRawRecord {
  raw_record_id: string
  source_file_id: string
  source_tool: 'codex'
  record_kind: 'jsonl_line'
  ordinal: number
  line_no: number
  json_pointer: null
  native_id: string | null
  raw_object_id: ObjectId
  decoded_json_object_id: ObjectId | null
  parser_status: 'ok' | 'partial' | 'failed'
  confidence: 'high' | 'medium' | 'low'
  import_batch_id: string
}

/** Session row staged from `session_meta` or a filename fallback. */
interface PendingSession {
  session_id: string
  source_session_id: string
  parent_session_id: string | null
  is_subagent: 0 | 1
  agent_role: string | null
  agent_nickname: string | null
  title: string | null
  start_ts: string | null
  cwd_initial: string | null
  git_branch_initial: string | null
  raw_record_id: string | null
}

/** Turn row staged from Codex `turn_context` events. */
interface PendingTurn {
  turn_id: string
  ordinal: number
  source_turn_id: string | null
  start_ts: string | null
  model: string | null
  cwd: string | null
  approval_policy: string | null
  sandbox_policy: string | null
  effort: string | null
  raw_record_id: string
}

/** Event row staged from Codex response items and operational event messages. */
interface PendingEvent {
  event_id: string
  ordinal: number
  turn_id: string | null
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

/** Message row staged from Codex assistant/user/tool content. */
interface PendingMessage {
  message_id: string
  turn_id: string | null
  event_id: string | null
  source_message_id: string | null
  role: 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'
  model: string | null
  timestamp: string | null
  ordinal: number
  raw_record_id: string
}

/** Content block row staged from Codex message content arrays. */
interface PendingBlock {
  block_id: string
  message_id: string | null
  event_id: string | null
  ordinal: number
  block_type: string
  text_object_id: ObjectId | null
  text_inline: string | null
  raw_record_id: string
}

/** Tool call row staged from Codex function-call style records. */
interface PendingToolCall {
  tool_call_id: string
  turn_id: string | null
  message_id: string | null
  event_id: string | null
  source_call_id: string | null
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

/** Tool result row staged from function-call output and operational tool events. */
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

/** Artifact row staged from Codex patch or file-producing events. */
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

/** Graph edge row staged for recovered Codex subagent relationships. */
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

/** Search index row staged from normalized Codex messages, commands, paths, and previews. */
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

/** Parse a Codex JSONL file, stage CAS objects, and return rows for later synchronous flush. */
async function prepareCodexFile(
  bundle: Bundle,
  batch: ImportBatch,
  filePath: string,
  logger?: CompileLogger,
): Promise<{ prepared: CodexPrepared | null; counts: FileCounts }> {
  const counts = emptyFileCounts()

  const { row: sourceFileRow, alreadyKnown } = await registerSourceFile(bundle, {
    sourceTool: 'codex',
    absolutePath: path.resolve(filePath),
    fileKind: 'jsonl',
  })

  if (alreadyKnown) {
    // We've already imported this file (same path,size,mtime,hash). Skip.
    counts.source_files_skipped = 1
    logger?.debug({ path: filePath, source_file_id: sourceFileRow.source_file_id }, 'codex source file skipped')
    return { prepared: null, counts }
  }

  counts.source_files_imported = 1
  logger?.debug({ path: filePath, source_file_id: sourceFileRow.source_file_id }, 'codex source file registered')

  const text = await readFile(filePath, 'utf8')
  const rawLines = text.split('\n')
  const lines = rawLines[rawLines.length - 1] === '' ? rawLines.slice(0, -1) : rawLines

  const pending = {
    rawRecords: [] as PendingRawRecord[],
    session: null as PendingSession | null,
    turns: [] as PendingTurn[],
    events: [] as PendingEvent[],
    messages: [] as PendingMessage[],
    blocks: [] as PendingBlock[],
    toolCalls: new Map<string, PendingToolCall>(), // by source_call_id
    toolCallsList: [] as PendingToolCall[],
    toolResults: [] as PendingToolResult[],
    artifacts: [] as PendingArtifact[],
    edges: [] as PendingEdge[],
    searchDocs: [] as PendingSearchDoc[],
    objects: createPendingObjects(),
  }

  let sessionStartTs: string | null = null
  let sessionEndTs: string | null = null
  let modelFirst: string | null = null
  let modelLast: string | null = null
  let messageOrdinal = 0
  let turnOrdinal = 0

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

    let parsed: CodexEnvelope | null = null
    let parserStatus: 'ok' | 'partial' | 'failed' = 'ok'
    try {
      parsed = JSON.parse(line) as CodexEnvelope
    } catch {
      parserStatus = 'failed'
    }

    // The raw line already IS the JSON for `parserStatus === 'ok'`, so we
    // skip storing a re-serialized copy as `decoded_json_object_id`. Saves
    // ~half the CAS writes per file. Nothing reads it back later.
    const decodedObjectId: ObjectId | null = null

    const nativeId = parsed ? extractNativeId(parsed) : null

    const rawRecordId = makeRawRecordId(sourceFileRow.source_file_id, ordinal, rawObjectId)

    pending.rawRecords.push({
      raw_record_id: rawRecordId,
      source_file_id: sourceFileRow.source_file_id,
      source_tool: 'codex',
      record_kind: 'jsonl_line',
      ordinal,
      line_no: lineNo,
      json_pointer: null,
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

    const type = typeof parsed.type === 'string' ? parsed.type : null
    const payload = (parsed.payload ?? {}) as Record<string, unknown>

    if (type === 'session_meta') {
      const meta = payload as CodexSessionMetaPayload
      const sourceSessionId = meta.id ?? path.basename(filePath, '.jsonl')
      const sessionId = makeSessionId('codex', sourceSessionId)

      // First session_meta wins; later ones (rare) become operational events.
      if (!pending.session) {
        const sub = parseSubagent(meta.source)
        pending.session = {
          session_id: sessionId,
          source_session_id: sourceSessionId,
          parent_session_id: sub ? makeSessionId('codex', sub.parent_thread_id) : null,
          is_subagent: sub ? 1 : 0,
          agent_role: meta.agent_role ?? sub?.agent_role ?? null,
          agent_nickname: meta.agent_nickname ?? sub?.agent_nickname ?? null,
          title: null,
          start_ts: meta.timestamp ?? ts,
          cwd_initial: meta.cwd ?? null,
          git_branch_initial: meta.git?.branch ?? null,
          raw_record_id: rawRecordId,
        }
        if (sub) {
          pending.edges.push({
            src_type: 'session',
            src_id: pending.session.parent_session_id ?? '',
            dst_type: 'session',
            dst_id: sessionId,
            edge_type: 'spawned',
            confidence: 'high',
            source: 'explicit',
            raw_record_id: rawRecordId,
          })
        }
      }
      continue
    }

    // From here on, we need a session_id. Ensure we have one (fallback if no
    // session_meta appeared yet).
    const sessionId = pending.session?.session_id ?? makeSessionId('codex', path.basename(filePath, '.jsonl'))
    if (!pending.session) {
      pending.session = {
        session_id: sessionId,
        source_session_id: path.basename(filePath, '.jsonl'),
        parent_session_id: null,
        is_subagent: 0,
        agent_role: null,
        agent_nickname: null,
        title: null,
        start_ts: ts,
        cwd_initial: null,
        git_branch_initial: null,
        raw_record_id: null,
      }
    }

    if (type === 'turn_context') {
      const tc = payload as CodexTurnContextPayload
      const turnId = makeTurnId(sessionId, turnOrdinal, tc.turn_id ?? null)
      const turn: PendingTurn = {
        turn_id: turnId,
        ordinal: turnOrdinal++,
        source_turn_id: tc.turn_id ?? null,
        start_ts: ts,
        model: tc.model ?? null,
        cwd: tc.cwd ?? null,
        approval_policy: tc.approval_policy ?? null,
        sandbox_policy: stringifyOrNull(tc.sandbox_policy),
        effort: tc.effort ?? null,
        raw_record_id: rawRecordId,
      }
      pending.turns.push(turn)
      if (turn.model) {
        if (!modelFirst) modelFirst = turn.model
        modelLast = turn.model
      }
      continue
    }

    const currentTurnId = pending.turns.length > 0 ? pending.turns[pending.turns.length - 1]!.turn_id : null

    if (type === 'response_item') {
      const ri = payload as CodexResponseItemPayload
      handleResponseItem(
        bundle,
        sessionId,
        currentTurnId,
        rawRecordId,
        ordinal,
        ts,
        ri,
        decodedObjectId,
        () => messageOrdinal++,
        modelLast,
        pending,
      )
      continue
    }

    if (type === 'event_msg') {
      const em = payload as CodexEventMsgPayload
      await handleEventMsg(bundle, sessionId, currentTurnId, rawRecordId, ordinal, ts, em, decodedObjectId, pending)
      continue
    }

    if (type === 'compacted') {
      pending.events.push({
        event_id: makeEventId(sessionId, ordinal, 'compaction'),
        ordinal,
        turn_id: currentTurnId,
        source_event_id: null,
        event_type: 'compaction',
        source_type: 'compacted',
        subtype: null,
        timestamp: ts,
        actor: 'system',
        payload_object_id: decodedObjectId,
        raw_record_id: rawRecordId,
        confidence: 'high',
      })
      continue
    }

    // Legacy top-level message / function_call etc.
    if (type === 'message') {
      const ri = payload as CodexResponseItemPayload
      // Treat as if it were wrapped in response_item.
      handleResponseItem(
        bundle,
        sessionId,
        currentTurnId,
        rawRecordId,
        ordinal,
        ts,
        { ...ri, type: 'message' },
        decodedObjectId,
        () => messageOrdinal++,
        modelLast,
        pending,
      )
    }
    // Anything else: keep as raw record, do not normalize. The presence in
    // raw_records is enough for re-processing later.
  }

  if (pending.session) {
    pending.session.start_ts ??= sessionStartTs
  }

  // Build search_docs from messages and tool calls already accumulated.
  buildSearchDocs(pending)

  // Persist the staged CAS objects to disk + the `objects` table BEFORE the
  // domain transaction. We do filesystem writes in parallel (better-sqlite3
  // transactions are synchronous, so this can't run inside `transactional`).
  await flushPendingObjects(bundle, pending.objects)

  counts.raw_records = pending.rawRecords.length
  counts.sessions = pending.session ? 1 : 0
  counts.turns = pending.turns.length
  counts.events = pending.events.length
  counts.messages = pending.messages.length
  counts.content_blocks = pending.blocks.length
  counts.tool_calls = pending.toolCallsList.length
  counts.tool_results = pending.toolResults.length
  counts.artifacts = pending.artifacts.length
  counts.edges = pending.edges.length
  logger?.debug({ path: filePath, source_file_id: sourceFileRow.source_file_id, counts }, 'codex source file prepared')

  return {
    prepared: {
      filePath,
      pending,
      meta: { sessionEndTs, modelFirst, modelLast },
    },
    counts,
  }
}

/** Flush one prepared Codex file's normalized rows inside the caller's transaction. */
function applyCodexFile(bundle: Bundle, prep: CodexPrepared): void {
  flushPending(bundle, prep.pending, {
    sessionEndTs: prep.meta.sessionEndTs,
    modelFirst: prep.meta.modelFirst,
    modelLast: prep.meta.modelLast,
    sourceTool: 'codex',
  })
}

/** All normalized Codex rows staged for one source file before FK-ordered flush. */
interface PendingState {
  rawRecords: PendingRawRecord[]
  session: PendingSession | null
  turns: PendingTurn[]
  events: PendingEvent[]
  messages: PendingMessage[]
  blocks: PendingBlock[]
  toolCalls: Map<string, PendingToolCall>
  toolCallsList: PendingToolCall[]
  toolResults: PendingToolResult[]
  artifacts: PendingArtifact[]
  edges: PendingEdge[]
  searchDocs: PendingSearchDoc[]
  objects: PendingObjects
}

/** Normalize a Codex `response_item` payload into messages, tool calls/results, or events. */
function handleResponseItem(
  _bundle: Bundle,
  sessionId: string,
  currentTurnId: string | null,
  rawRecordId: string,
  ordinal: number,
  ts: string | null,
  ri: CodexResponseItemPayload,
  payloadObjectId: ObjectId | null,
  nextMsgOrdinal: () => number,
  currentModel: string | null,
  pending: PendingState,
): void {
  const subtype = ri.type ?? null

  if (subtype === 'message') {
    const role = mapMessageRole(ri.role)
    const msgOrdinal = nextMsgOrdinal()
    const messageId = makeMessageId(sessionId, msgOrdinal, null)

    const eventId = makeEventId(sessionId, ordinal, 'message')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'message',
      source_type: 'response_item.message',
      subtype: null,
      timestamp: ts,
      actor: ri.role ?? null,
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })

    pending.messages.push({
      message_id: messageId,
      turn_id: currentTurnId,
      event_id: eventId,
      source_message_id: null,
      role,
      model: role === 'assistant' ? currentModel : null,
      timestamp: ts,
      ordinal: msgOrdinal,
      raw_record_id: rawRecordId,
    })

    const contentItems = Array.isArray(ri.content) ? (ri.content as CodexContentItem[]) : []
    for (let bi = 0; bi < contentItems.length; bi++) {
      const item = contentItems[bi]
      if (!item) continue
      const text = typeof item.text === 'string' ? item.text : null
      const blockType = item.type ?? 'text'
      pending.blocks.push({
        block_id: blockId(messageId, bi),
        message_id: messageId,
        event_id: null,
        ordinal: bi,
        block_type: blockType,
        text_object_id: null,
        text_inline: text,
        raw_record_id: rawRecordId,
      })
    }
    return
  }

  if (subtype === 'function_call') {
    const sourceCallId = typeof ri.call_id === 'string' ? ri.call_id : null
    const toolName = typeof ri.name === 'string' ? ri.name : 'unknown'
    const toolCallId = makeToolCallId(sessionId, sourceCallId ?? `${ordinal}`)
    const argsObjectId = ri.arguments != null ? null : null // keep small inline — see below
    const argsText = stringifyOrNull(ri.arguments)
    const command = inferCommandFromArgs(toolName, ri.arguments)

    const eventId = makeEventId(sessionId, ordinal, 'tool_call')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'tool_call',
      source_type: 'response_item.function_call',
      subtype: toolName,
      timestamp: ts,
      actor: 'assistant',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })

    const call: PendingToolCall = {
      tool_call_id: toolCallId,
      turn_id: currentTurnId,
      message_id: null,
      event_id: eventId,
      source_call_id: sourceCallId,
      tool_name: toolName,
      canonical_tool_type: canonicalToolType(toolName),
      args_object_id: argsObjectId,
      command,
      cwd: null,
      path: inferPathFromArgs(ri.arguments),
      query: null,
      timestamp_start: ts,
      status: 'started',
      raw_record_id: rawRecordId,
    }
    if (sourceCallId) pending.toolCalls.set(sourceCallId, call)
    pending.toolCallsList.push(call)
    void argsText
    return
  }

  if (subtype === 'function_call_output') {
    const sourceCallId = typeof ri.call_id === 'string' ? ri.call_id : null
    const outputText = stringifyOrNull(ri.output) ?? ''
    const isError = looksLikeError(outputText) ? 1 : 0

    const eventId = makeEventId(sessionId, ordinal, 'tool_result')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'tool_result',
      source_type: 'response_item.function_call_output',
      subtype: null,
      timestamp: ts,
      actor: 'tool',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })

    const matchedCall = sourceCallId ? pending.toolCalls.get(sourceCallId) : undefined
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionId, sourceCallId ?? `${ordinal}`),
      tool_call_id: matchedCall?.tool_call_id ?? null,
      source_call_id: sourceCallId,
      message_id: null,
      event_id: eventId,
      status: ri.status ?? null,
      is_error: isError,
      exit_code: null,
      duration_ms: null,
      stdout_object_id: null,
      stderr_object_id: null,
      output_object_id: null, // small previews only at this stage
      preview: outputText.slice(0, PREVIEW_MAX),
      raw_record_id: rawRecordId,
    })
    if (matchedCall) {
      matchedCall.status = matchedCall.status === 'started' ? (isError ? 'error' : 'success') : matchedCall.status
    }
    return
  }

  // reasoning, custom_tool_*, web_search_call, ghost_snapshot, etc.: keep as
  // operational events for now. Raw is preserved either way.
  const eventId = makeEventId(sessionId, ordinal, `response_item.${subtype ?? 'unknown'}`)
  pending.events.push({
    event_id: eventId,
    ordinal,
    turn_id: currentTurnId,
    source_event_id: null,
    event_type: subtype ?? 'response_item',
    source_type: `response_item.${subtype ?? 'unknown'}`,
    subtype,
    timestamp: ts,
    actor: 'assistant',
    payload_object_id: payloadObjectId,
    raw_record_id: rawRecordId,
    confidence: 'high',
  })
}

/** Normalize Codex operational `event_msg` payloads while preserving unknown types as events. */
async function handleEventMsg(
  bundle: Bundle,
  sessionId: string,
  currentTurnId: string | null,
  rawRecordId: string,
  ordinal: number,
  ts: string | null,
  em: CodexEventMsgPayload,
  payloadObjectId: ObjectId | null,
  pending: PendingState,
): Promise<void> {
  const subtype = em.type ?? 'unknown'

  if (subtype === 'exec_command_end') {
    const sourceCallId = em.call_id ?? null
    const stdoutId = em.stdout ? stageText(pending.objects, em.stdout, { mimeType: 'text/plain' }) : null
    const stderrId = em.stderr ? stageText(pending.objects, em.stderr, { mimeType: 'text/plain' }) : null
    const preview = (em.formatted_output ?? em.aggregated_output ?? em.stdout ?? '').slice(0, PREVIEW_MAX)
    const exitCode = typeof em.exit_code === 'number' ? em.exit_code : null
    const isError = exitCode != null && exitCode !== 0 ? 1 : 0

    const eventId = makeEventId(sessionId, ordinal, 'exec_command_end')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'tool_result',
      source_type: 'event_msg.exec_command_end',
      subtype: 'shell',
      timestamp: ts,
      actor: 'tool',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })

    const matchedCall = sourceCallId ? pending.toolCalls.get(sourceCallId) : undefined
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionId, `${sourceCallId ?? ordinal}::exec_command_end`),
      tool_call_id: matchedCall?.tool_call_id ?? null,
      source_call_id: sourceCallId,
      message_id: null,
      event_id: eventId,
      status: em.status ?? null,
      is_error: isError,
      exit_code: exitCode,
      duration_ms: durationMs(em.duration),
      stdout_object_id: stdoutId,
      stderr_object_id: stderrId,
      output_object_id: null,
      preview,
      raw_record_id: rawRecordId,
    })
    if (matchedCall) {
      matchedCall.status = isError ? 'error' : 'success'
      if (em.cwd && !matchedCall.cwd) matchedCall.cwd = em.cwd
    }
    return
  }

  if (subtype === 'patch_apply_end') {
    const eventId = makeEventId(sessionId, ordinal, 'patch_apply_end')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'patch',
      source_type: 'event_msg.patch_apply_end',
      subtype: null,
      timestamp: ts,
      actor: 'tool',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })
    if (em.changes && typeof em.changes === 'object') {
      for (const filePath of Object.keys(em.changes)) {
        pending.artifacts.push({
          artifact_id: artifactId(sessionId, 'codex', `${eventId}:${filePath}`),
          kind: 'diff',
          path: filePath,
          logical_path: filePath,
          object_id: null,
          text_object_id: null,
          mime_type: 'text/x-diff',
          size_bytes: 0,
          created_ts: ts,
          raw_record_id: rawRecordId,
        })
      }
    }
    return
  }

  if (subtype === 'mcp_tool_call_end') {
    const sourceCallId = em.call_id ?? null
    const eventId = makeEventId(sessionId, ordinal, 'mcp_tool_call_end')
    pending.events.push({
      event_id: eventId,
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'tool_result',
      source_type: 'event_msg.mcp_tool_call_end',
      subtype: 'mcp',
      timestamp: ts,
      actor: 'tool',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })
    const preview = stringifyOrNull(em.result)?.slice(0, PREVIEW_MAX) ?? null
    const matchedCall = sourceCallId ? pending.toolCalls.get(sourceCallId) : undefined
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionId, `${sourceCallId ?? ordinal}::mcp_tool_call_end`),
      tool_call_id: matchedCall?.tool_call_id ?? null,
      source_call_id: sourceCallId,
      message_id: null,
      event_id: eventId,
      status: 'success',
      is_error: 0,
      exit_code: null,
      duration_ms: durationMs(em.duration),
      stdout_object_id: null,
      stderr_object_id: null,
      output_object_id: null,
      preview,
      raw_record_id: rawRecordId,
    })
    return
  }

  if (subtype === 'context_compacted') {
    pending.events.push({
      event_id: makeEventId(sessionId, ordinal, 'compaction'),
      ordinal,
      turn_id: currentTurnId,
      source_event_id: null,
      event_type: 'compaction',
      source_type: 'event_msg.context_compacted',
      subtype: null,
      timestamp: ts,
      actor: 'system',
      payload_object_id: payloadObjectId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })
    return
  }

  // user_message / agent_message / task_started / task_complete / turn_aborted /
  // token_count / others — keep as operational events.
  pending.events.push({
    event_id: makeEventId(sessionId, ordinal, `event_msg.${subtype}`),
    ordinal,
    turn_id: currentTurnId,
    source_event_id: null,
    event_type: 'system_operational',
    source_type: `event_msg.${subtype}`,
    subtype,
    timestamp: ts,
    actor: 'system',
    payload_object_id: payloadObjectId,
    raw_record_id: rawRecordId,
    confidence: 'high',
  })
}

// ---- helpers -------------------------------------------------------------

/** Pick the best native locator from a loose Codex envelope for raw record lookup. */
function extractNativeId(env: CodexEnvelope): string | null {
  const p = env.payload as Record<string, unknown> | undefined
  if (!p) return null
  if (typeof p.id === 'string') return p.id
  if (typeof p.call_id === 'string') return p.call_id
  if (typeof p.turn_id === 'string') return p.turn_id
  return null
}

/** Map native Codex roles into prosa's normalized message role vocabulary. */
function mapMessageRole(role: unknown): PendingMessage['role'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool'
    case 'developer':
      return 'developer'
    case 'system':
      // Codex 'system' content is real system instructions — map to system_prompt.
      return 'system_prompt'
    default:
      return 'operational'
  }
}

/** Collapse Codex and MCP tool names into broad search/filter tool categories. */
function canonicalToolType(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.startsWith('mcp__')) return 'mcp'
  if (
    lower === 'shell' ||
    lower === 'exec_command' ||
    lower === 'shell_command' ||
    lower === 'write_stdin' ||
    lower === 'unified_exec' ||
    lower === 'run_terminal_cmd'
  ) {
    return 'shell'
  }
  if (lower === 'read_file' || lower === 'readfile') return 'read_file'
  if (lower === 'write_file' || lower === 'writefile') return 'write_file'
  if (lower === 'apply_patch' || lower === 'applypatch' || lower === 'patch') return 'patch'
  if (lower === 'web_search' || lower === 'websearch' || lower === 'web_search_call') {
    return 'web_search'
  }
  if (lower === 'agent' || lower === 'subagent' || lower === 'collab_spawn') return 'subagent'
  return 'other'
}

/** Extract a shell command from loose tool arguments when the native tool exposes one. */
function inferCommandFromArgs(toolName: string, args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>
        return inferCommandFromArgs(toolName, parsed)
      } catch {
        return null
      }
    }
    return null
  }
  const obj = args as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (Array.isArray(obj.command)) {
    return obj.command.map(String).join(' ')
  }
  return null
}

/** Extract a file path from loose tool arguments without treating absence as an error. */
function inferPathFromArgs(args: unknown): string | null {
  if (!args || typeof args !== 'object') {
    if (typeof args === 'string') {
      try {
        const parsed = JSON.parse(args) as Record<string, unknown>
        return inferPathFromArgs(parsed)
      } catch {
        return null
      }
    }
    return null
  }
  const obj = args as Record<string, unknown>
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.absolute_path === 'string') return obj.absolute_path
  return null
}

/** Heuristic for legacy tool outputs that do not carry an explicit error flag. */
function looksLikeError(text: string): boolean {
  return /\b(error|exception|failed|stack trace)\b/i.test(text)
}

/** Convert Codex's seconds/nanoseconds duration object to milliseconds. */
function durationMs(d: CodexEventMsgPayload['duration']): number | null {
  if (!d || typeof d !== 'object') return null
  const secs = typeof d.secs === 'number' ? d.secs : 0
  const nanos = typeof d.nanos === 'number' ? d.nanos : 0
  return secs * 1000 + Math.floor(nanos / 1e6)
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

/** Recover explicit Codex subagent spawn metadata from `session_meta.source`. */
function parseSubagent(
  source: unknown,
): { parent_thread_id: string; agent_role?: string; agent_nickname?: string } | null {
  if (!source || typeof source !== 'object') return null
  const obj = source as Record<string, unknown>
  const sub = obj.subagent
  if (!sub || typeof sub !== 'object') return null
  const ts = (sub as Record<string, unknown>).thread_spawn
  if (!ts || typeof ts !== 'object') return null
  const tso = ts as Record<string, unknown>
  const parent = tso.parent_thread_id
  if (typeof parent !== 'string') return null
  return {
    parent_thread_id: parent,
    agent_role: typeof tso.agent_role === 'string' ? tso.agent_role : undefined,
    agent_nickname: typeof tso.agent_nickname === 'string' ? tso.agent_nickname : undefined,
  }
}

/** Build searchable Codex documents from staged messages, tool calls, and result previews. */
function buildSearchDocs(pending: PendingState): void {
  const sessionId = pending.session?.session_id ?? null
  if (!sessionId) return

  // Group blocks by message for indexing concatenated text.
  const blocksByMsg = new Map<string, PendingBlock[]>()
  for (const b of pending.blocks) {
    if (!b.message_id) continue
    const list = blocksByMsg.get(b.message_id) ?? []
    list.push(b)
    blocksByMsg.set(b.message_id, list)
  }

  for (const m of pending.messages) {
    const text = (blocksByMsg.get(m.message_id) ?? [])
      .filter(
        (b) =>
          b.text_inline && (b.block_type === 'input_text' || b.block_type === 'output_text' || b.block_type === 'text'),
      )
      .map((b) => b.text_inline as string)
      .join('\n')
    if (!text || text.length === 0) continue
    pending.searchDocs.push({
      doc_id: `msg:${m.message_id}`,
      entity_type: 'message',
      entity_id: m.message_id,
      timestamp: m.timestamp,
      role: m.role,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: m.role === 'user' ? 'user_prompt' : 'assistant_text',
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
    if (r.preview) {
      pending.searchDocs.push({
        doc_id: `tr:preview:${r.tool_result_id}`,
        entity_type: 'tool_result',
        entity_id: r.tool_result_id,
        timestamp: null,
        role: null,
        tool_name: null,
        canonical_tool_type: null,
        field_kind: r.is_error ? 'error' : 'command_output_preview',
        text: r.preview,
      })
    }
  }
}

/** Insert staged Codex rows in foreign-key order after CAS objects are already durable. */
function flushPending(
  bundle: Bundle,
  pending: PendingState,
  meta: {
    sessionEndTs: string | null
    modelFirst: string | null
    modelLast: string | null
    sourceTool: 'codex'
  },
): void {
  if (!pending.session) return

  // Order matters under SQLite's immediate FK checking: rows must be inserted
  // before any other row references them. raw_records → sessions →
  // turns/events → messages → blocks → tool_calls → tool_results.
  //
  // We also insert sessions with parent_session_id=NULL initially because the
  // parent session may live in a different file/batch. The cross-file linkage
  // happens in `linkParents` below, after every file is committed.

  const insertRaw = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO raw_records (
       raw_record_id, source_file_id, source_tool, record_kind, ordinal,
       line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id,
       parser_status, confidence, import_batch_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of pending.rawRecords) {
    insertRaw.run(
      r.raw_record_id,
      r.source_file_id,
      r.source_tool,
      r.record_kind,
      r.ordinal,
      r.line_no,
      r.json_pointer,
      r.native_id,
      r.raw_object_id,
      r.decoded_json_object_id,
      r.parser_status,
      r.confidence,
      r.import_batch_id,
    )
  }

  const insertSession = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO sessions (
       session_id, source_tool, source_session_id, project_id, parent_session_id,
       is_subagent, agent_role, agent_nickname, title, summary,
       start_ts, end_ts, cwd_initial, git_branch_initial,
       model_first, model_last, status, timeline_confidence, raw_record_id
     ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'high', ?)`,
  )
  insertSession.run(
    pending.session.session_id,
    meta.sourceTool,
    pending.session.source_session_id,
    null,
    pending.session.is_subagent,
    pending.session.agent_role,
    pending.session.agent_nickname,
    pending.session.title,
    null,
    pending.session.start_ts,
    meta.sessionEndTs,
    pending.session.cwd_initial,
    pending.session.git_branch_initial,
    meta.modelFirst,
    meta.modelLast,
    'completed',
    pending.session.raw_record_id,
  )

  const insertTurn = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO turns (
       turn_id, session_id, source_turn_id, ordinal, start_ts, end_ts,
       model, cwd, git_branch, approval_policy, sandbox_policy, effort, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const t of pending.turns) {
    insertTurn.run(
      t.turn_id,
      pending.session.session_id,
      t.source_turn_id,
      t.ordinal,
      t.start_ts,
      null,
      t.model,
      t.cwd,
      null,
      t.approval_policy,
      t.sandbox_policy,
      t.effort,
      t.raw_record_id,
    )
  }

  const insertEvent = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO events (
       event_id, session_id, turn_id, source_event_id, event_type, source_type,
       subtype, timestamp, ordinal, actor, payload_object_id, raw_record_id,
       confidence, is_derived
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const e of pending.events) {
    insertEvent.run(
      e.event_id,
      pending.session.session_id,
      e.turn_id,
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const m of pending.messages) {
    insertMessage.run(
      m.message_id,
      pending.session.session_id,
      m.turn_id,
      m.event_id,
      m.source_message_id,
      m.role,
      null,
      m.model,
      m.timestamp,
      m.ordinal,
      null,
      null,
      null,
      m.raw_record_id,
    )
  }

  const insertBlock = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO content_blocks (
       block_id, message_id, event_id, session_id, ordinal, block_type,
       text_object_id, text_inline, mime_type, token_count, is_error,
       is_redacted, visibility, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'default', ?)`,
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
      null,
      null,
      0,
      0,
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const c of pending.toolCallsList) {
    insertToolCall.run(
      c.tool_call_id,
      pending.session.session_id,
      c.turn_id,
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
      null,
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
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const a of pending.artifacts) {
    insertArtifact.run(
      a.artifact_id,
      pending.session.session_id,
      null,
      'codex',
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
