import path from 'node:path'
import Database from 'better-sqlite3'
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
import { type CursorStoreDb, discoverCursorStores } from './discover.js'

export interface CompileResult {
  batch: ImportBatch
  counts: ImportCounts
}

const PREVIEW_MAX = 4_000

interface CursorMeta {
  agentId?: string
  latestRootBlobId?: string
  name?: string
  mode?: string
  createdAt?: number
  lastUsedModel?: string
}

interface CursorBlobJson {
  role?: string
  id?: string
  content?: string | CursorContentItem[]
  providerOptions?: Record<string, unknown>
}

interface CursorContentItem {
  type?: string
  text?: string
  toolCallId?: string
  toolName?: string
  args?: unknown
  result?: unknown
  experimental_content?: unknown
  signature?: string
  data?: unknown
}

export async function compileCursor(
  bundle: Bundle,
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const logger = options.logger
  const batch = startBatch(bundle, 'cursor', [root])
  const counts = emptyCounts()
  logger?.info({ batch_id: batch.batch_id, root }, 'cursor batch started')
  try {
    for await (const store of discoverCursorStores(root)) {
      counts.source_files_seen++
      logger?.debug(
        {
          path: store.filePath,
          workspace_id: store.workspaceId,
          agent_id: store.agentId,
        },
        'cursor store discovered',
      )
      try {
        const fc = await compileCursorStore(bundle, batch, store, logger)
        addCounts(counts, fc)
      } catch (error) {
        counts.errors++
        logger?.warn(
          {
            err: error,
            path: store.filePath,
          },
          'cursor store failed',
        )
        await recordError(bundle, batch.batch_id, {
          kind: 'cursor_store_failed',
          message: getErrorMessage(error),
          payload: { path: store.filePath },
        })
      }
    }
    finishBatch(bundle, batch, counts, 'completed')
    logger?.info({ batch_id: batch.batch_id, counts }, 'cursor batch completed')
  } catch (error) {
    finishBatch(bundle, batch, counts, 'failed')
    logger?.error({ err: error, batch_id: batch.batch_id, counts }, 'cursor batch failed')
    throw error
  }
  return { batch, counts }
}

interface FileCounts {
  source_files_imported: number
  source_files_skipped: number
  raw_records: number
  sessions: number
  events: number
  messages: number
  content_blocks: number
  tool_calls: number
  tool_results: number
  artifacts: number
  edges: number
  errors: number
}

function emptyFileCounts(): FileCounts {
  return {
    source_files_imported: 0,
    source_files_skipped: 0,
    raw_records: 0,
    sessions: 0,
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

function addCounts(target: ImportCounts, source: FileCounts): void {
  target.source_files_imported += source.source_files_imported
  target.source_files_skipped += source.source_files_skipped
  target.raw_records += source.raw_records
  target.sessions += source.sessions
  target.events += source.events
  target.messages += source.messages
  target.content_blocks += source.content_blocks
  target.tool_calls += source.tool_calls
  target.tool_results += source.tool_results
  target.artifacts += source.artifacts
  target.edges += source.edges
  target.errors += source.errors
}

interface PendingState {
  rawRecords: PendingRaw[]
  session: PendingSession | null
  events: PendingEvent[]
  messages: PendingMessage[]
  blocks: PendingBlock[]
  toolCalls: Map<string, PendingToolCall>
  toolCallsList: PendingToolCall[]
  toolResults: PendingToolResult[]
  artifacts: PendingArtifact[]
  searchDocs: PendingSearchDoc[]
  objects: PendingObjects
}

interface PendingRaw {
  raw_record_id: string
  source_file_id: string
  ordinal: number
  line_no: null
  json_pointer: string | null
  native_id: string | null
  raw_object_id: ObjectId
  decoded_json_object_id: ObjectId | null
  parser_status: 'ok' | 'partial' | 'failed'
  confidence: 'high' | 'medium' | 'low'
  import_batch_id: string
  record_kind: 'sqlite_meta' | 'sqlite_blob'
}

interface PendingSession {
  session_id: string
  source_session_id: string
  agent_role: string | null
  agent_nickname: string | null
  title: string | null
  start_ts: string | null
  raw_record_id: string
  model: string | null
}

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

interface PendingMessage {
  message_id: string
  event_id: string | null
  source_message_id: string | null
  role: 'system_prompt' | 'developer' | 'user' | 'assistant' | 'tool' | 'operational'
  model: string | null
  timestamp: string | null
  ordinal: number
  raw_record_id: string
}

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

interface PendingToolResult {
  tool_result_id: string
  tool_call_id: string | null
  source_call_id: string
  message_id: string | null
  event_id: string | null
  status: string | null
  is_error: 0 | 1
  output_object_id: ObjectId | null
  preview: string | null
  raw_record_id: string
}

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

async function compileCursorStore(
  bundle: Bundle,
  batch: ImportBatch,
  store: CursorStoreDb,
  logger?: CompileLogger,
): Promise<FileCounts> {
  const counts = emptyFileCounts()

  const { row: sourceFile, alreadyKnown } = await registerSourceFile(bundle, {
    sourceTool: 'cursor',
    absolutePath: path.resolve(store.filePath),
    fileKind: 'sqlite',
    workspaceHint: store.workspaceId,
  })
  if (alreadyKnown) {
    counts.source_files_skipped = 1
    logger?.debug({ path: store.filePath, source_file_id: sourceFile.source_file_id }, 'cursor store skipped')
    return counts
  }
  counts.source_files_imported = 1
  logger?.debug({ path: store.filePath, source_file_id: sourceFile.source_file_id }, 'cursor store registered')

  // Open the Cursor store read-only. We don't lock or write to it, so multiple
  // imports can run while Cursor itself is using the database.
  const cdb = new Database(store.filePath, { readonly: true, fileMustExist: true })

  try {
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
      searchDocs: [],
      objects: createPendingObjects(),
    }

    // ---- meta: hex-encoded JSON ----
    const metaRow = cdb.prepare<[], { value: string }>(`SELECT value FROM meta WHERE key='0'`).get()
    let meta: CursorMeta = {}
    let metaRawId = ''
    if (metaRow) {
      const metaText = hexToUtf8(metaRow.value)
      try {
        meta = JSON.parse(metaText) as CursorMeta
      } catch {
        meta = {}
      }
      const metaObjId = stageBytes(pending.objects, Buffer.from(metaText, 'utf8'), {
        mimeType: 'application/json',
        encoding: 'utf-8',
      })
      metaRawId = makeRawRecordId(sourceFile.source_file_id, 0, metaObjId)
      pending.rawRecords.push({
        raw_record_id: metaRawId,
        source_file_id: sourceFile.source_file_id,
        ordinal: 0,
        line_no: null,
        json_pointer: 'meta/0',
        native_id: meta.agentId ?? store.agentId,
        raw_object_id: metaObjId,
        decoded_json_object_id: metaObjId,
        parser_status: 'ok',
        confidence: 'high',
        import_batch_id: batch.batch_id,
        record_kind: 'sqlite_meta',
      })
    }

    const sourceSessionId = meta.agentId ?? store.agentId
    const sessionPk = makeSessionId('cursor', sourceSessionId)
    const startTs = meta.createdAt ? new Date(meta.createdAt).toISOString() : null
    pending.session = {
      session_id: sessionPk,
      source_session_id: sourceSessionId,
      agent_role: meta.mode ?? null,
      agent_nickname: meta.name ?? null,
      title: meta.name ?? null,
      start_ts: startTs,
      raw_record_id: metaRawId || makeRawRecordId(sourceFile.source_file_id, 0, 'blake3:none'),
      model: meta.lastUsedModel ?? null,
    }

    // ---- blobs ----
    const blobs = cdb.prepare<[], { id: string; data: Buffer }>(`SELECT id, data FROM blobs ORDER BY rowid`).all()

    let messageOrdinal = 0
    for (let i = 0; i < blobs.length; i++) {
      const blob = blobs[i]
      if (!blob) continue
      const ordinal = i + 1
      const blobObjectId = stageBytes(pending.objects, blob.data)
      const blobRawId = makeRawRecordId(sourceFile.source_file_id, ordinal, blobObjectId)

      // Try to parse JSON. Many blobs are protobuf state and won't parse.
      let parsed: CursorBlobJson | null = null
      const firstByte = blob.data[0]
      const looksJson = firstByte === 0x7b /* '{' */ || firstByte === 0x5b /* '[' */
      if (looksJson) {
        try {
          parsed = JSON.parse(blob.data.toString('utf8')) as CursorBlobJson
        } catch {
          parsed = null
        }
      }

      pending.rawRecords.push({
        raw_record_id: blobRawId,
        source_file_id: sourceFile.source_file_id,
        ordinal,
        line_no: null,
        json_pointer: `blobs/${blob.id}`,
        native_id: blob.id,
        raw_object_id: blobObjectId,
        decoded_json_object_id: parsed != null ? stageJson(pending.objects, parsed) : null,
        parser_status: parsed != null ? 'ok' : looksJson ? 'failed' : 'partial',
        confidence: 'low', // timeline order from blob list isn't canonical
        import_batch_id: batch.batch_id,
        record_kind: 'sqlite_blob',
      })

      if (!parsed || typeof parsed.role !== 'string') continue

      // Normalize JSON blobs that look like chat messages.
      const role = mapRole(parsed.role)
      const messageId = makeMessageId(sessionPk, messageOrdinal++, parsed.id ?? blob.id)
      const eventId = makeEventId(sessionPk, ordinal, 'message')

      pending.events.push({
        event_id: eventId,
        ordinal,
        source_event_id: blob.id,
        event_type: 'message',
        source_type: `cursor.${parsed.role}`,
        subtype: null,
        timestamp: null,
        actor: parsed.role,
        payload_object_id: pending.rawRecords[pending.rawRecords.length - 1]?.decoded_json_object_id ?? null,
        raw_record_id: blobRawId,
        confidence: 'low',
      })

      pending.messages.push({
        message_id: messageId,
        event_id: eventId,
        source_message_id: parsed.id ?? blob.id,
        role,
        model: role === 'assistant' ? (meta.lastUsedModel ?? null) : null,
        timestamp: null,
        ordinal: messageOrdinal,
        raw_record_id: blobRawId,
      })

      const content = parsed.content
      if (typeof content === 'string') {
        await pushTextBlock(bundle, pending, messageId, 0, 'text', content, blobRawId)
      } else if (Array.isArray(content)) {
        for (let bi = 0; bi < content.length; bi++) {
          const item = content[bi]
          if (!item) continue
          await processContentItem(bundle, sessionPk, messageId, eventId, bi, item, blobRawId, pending)
        }
      }
    }

    buildSearchDocs(pending)

    // Persist staged CAS objects (FS + objects rows) before the domain
    // transaction. better-sqlite3 transactions are sync.
    await flushPendingObjects(bundle, pending.objects)

    transactional(bundle.db, () => {
      flushPending(bundle, pending)
    })

    counts.raw_records = pending.rawRecords.length
    counts.sessions = 1
    counts.events = pending.events.length
    counts.messages = pending.messages.length
    counts.content_blocks = pending.blocks.length
    counts.tool_calls = pending.toolCallsList.length
    counts.tool_results = pending.toolResults.length
    counts.artifacts = pending.artifacts.length
    logger?.debug({ path: store.filePath, source_file_id: sourceFile.source_file_id, counts }, 'cursor store imported')
    return counts
  } finally {
    cdb.close()
  }
}

function hexToUtf8(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf8')
}

function mapRole(role: string): PendingMessage['role'] {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool'
    case 'system':
      // In Cursor's chat blobs, role=system is actually the system prompt
      // (unlike Claude Code's `type:"system"` event_log usage).
      return 'system_prompt'
    default:
      return 'operational'
  }
}

async function pushTextBlock(
  bundle: Bundle,
  pending: PendingState,
  messageId: string,
  ordinal: number,
  blockType: string,
  text: string,
  rawRecordId: string,
  visibility: 'default' | 'hidden_by_default' | 'audit_only' = 'default',
): Promise<void> {
  if (!text) return
  const overflow = text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null
  pending.blocks.push({
    block_id: blockId(messageId, ordinal),
    message_id: messageId,
    event_id: null,
    ordinal,
    block_type: blockType,
    text_object_id: overflow,
    text_inline: text.slice(0, PREVIEW_MAX),
    is_error: 0,
    visibility,
    raw_record_id: rawRecordId,
  })
}

async function processContentItem(
  bundle: Bundle,
  sessionId: string,
  messageId: string,
  eventId: string,
  ordinal: number,
  item: CursorContentItem,
  rawRecordId: string,
  pending: PendingState,
): Promise<void> {
  const t = item.type
  if (t === 'text') {
    await pushTextBlock(bundle, pending, messageId, ordinal, 'text', item.text ?? '', rawRecordId)
    return
  }
  if (t === 'reasoning') {
    await pushTextBlock(
      bundle,
      pending,
      messageId,
      ordinal,
      'thinking',
      item.text ?? '',
      rawRecordId,
      'hidden_by_default',
    )
    return
  }
  if (t === 'redacted-reasoning') {
    pending.blocks.push({
      block_id: blockId(messageId, ordinal),
      message_id: messageId,
      event_id: null,
      ordinal,
      block_type: 'thinking',
      text_object_id: null,
      text_inline: '[redacted]',
      is_error: 0,
      visibility: 'audit_only',
      raw_record_id: rawRecordId,
    })
    return
  }
  if (t === 'tool-call') {
    const sourceCallId = item.toolCallId ?? `${ordinal}`
    const toolName = item.toolName ?? 'unknown'
    const argsObjectId = item.args != null ? stageJson(pending.objects, item.args) : null
    const tcId = makeToolCallId(sessionId, sourceCallId)

    pending.blocks.push({
      block_id: blockId(messageId, ordinal),
      message_id: messageId,
      event_id: null,
      ordinal,
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
      args_object_id: argsObjectId,
      command:
        typeof (item.args as { command?: unknown })?.command === 'string'
          ? (item.args as { command: string }).command
          : null,
      cwd: null,
      path:
        typeof (item.args as { file_path?: unknown })?.file_path === 'string'
          ? (item.args as { file_path: string }).file_path
          : typeof (item.args as { path?: unknown })?.path === 'string'
            ? (item.args as { path: string }).path
            : null,
      query: null,
      timestamp_start: null,
      status: 'started',
      raw_record_id: rawRecordId,
    }
    pending.toolCalls.set(sourceCallId, call)
    pending.toolCallsList.push(call)
    return
  }
  if (t === 'tool-result') {
    const sourceCallId = item.toolCallId ?? `${ordinal}`
    const text = stringifyOrNull(item.result) ?? ''
    const overflow = text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null
    const isError = readIsError(item) ? 1 : 0

    pending.blocks.push({
      block_id: blockId(messageId, ordinal),
      message_id: messageId,
      event_id: null,
      ordinal,
      block_type: 'tool_result',
      text_object_id: overflow,
      text_inline: text.slice(0, PREVIEW_MAX),
      is_error: isError,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })

    const matched = pending.toolCalls.get(sourceCallId)
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionId, sourceCallId),
      tool_call_id: matched?.tool_call_id ?? null,
      source_call_id: sourceCallId,
      message_id: messageId,
      event_id: eventId,
      status: matched ? (isError ? 'error' : 'success') : null,
      is_error: isError,
      output_object_id: overflow,
      preview: text.slice(0, PREVIEW_MAX) || null,
      raw_record_id: rawRecordId,
    })
    if (matched) matched.status = isError ? 'error' : 'success'
    return
  }

  // Unknown content type — keep as audit-only block.
  pending.blocks.push({
    block_id: blockId(messageId, ordinal),
    message_id: messageId,
    event_id: null,
    ordinal,
    block_type: t ?? 'unknown',
    text_object_id: null,
    text_inline: stringifyOrNull(item)?.slice(0, PREVIEW_MAX) ?? null,
    is_error: 0,
    visibility: 'audit_only',
    raw_record_id: rawRecordId,
  })
}

function readIsError(item: CursorContentItem): boolean {
  // Cursor stores isError under providerOptions.cursor.highLevelToolCallResult.
  const exp = item.experimental_content as { isError?: boolean } | undefined
  if (exp && typeof exp.isError === 'boolean') return exp.isError
  return false
}

function canonicalToolType(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.startsWith('mcp__')) return 'mcp'
  if (lower === 'shell' || lower === 'run_terminal_cmd' || lower === 'bash') return 'shell'
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'read_file'
  if (lower === 'write' || lower === 'writefile' || lower === 'write_file') return 'write_file'
  if (lower === 'strreplace' || lower === 'str_replace' || lower === 'edit' || lower === 'search_replace') {
    return 'edit_file'
  }
  if (lower === 'grep' || lower === 'glob' || lower === 'codebase_search' || lower === 'glob_file_search') {
    return 'search_file'
  }
  if (lower === 'websearch') return 'web_search'
  if (lower === 'applypatch' || lower === 'apply_patch') return 'patch'
  return 'other'
}

function stringifyOrNull(value: unknown): string | null {
  if (value == null) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

function buildSearchDocs(pending: PendingState): void {
  const sessionId = pending.session?.session_id ?? null
  if (!sessionId) return
  const blocksByMsg = new Map<string, PendingBlock[]>()
  for (const b of pending.blocks) {
    if (!b.message_id) continue
    if (b.visibility === 'hidden_by_default' || b.visibility === 'audit_only') continue
    if (!b.text_inline) continue
    const list = blocksByMsg.get(b.message_id) ?? []
    list.push(b)
    blocksByMsg.set(b.message_id, list)
  }
  for (const m of pending.messages) {
    const text = (blocksByMsg.get(m.message_id) ?? [])
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
  for (const tc of pending.toolCallsList) {
    if (tc.command) {
      pending.searchDocs.push({
        doc_id: `tc:cmd:${tc.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: tc.tool_call_id,
        timestamp: tc.timestamp_start,
        role: null,
        tool_name: tc.tool_name,
        canonical_tool_type: tc.canonical_tool_type,
        field_kind: 'command',
        text: tc.command,
      })
    }
    if (tc.path) {
      pending.searchDocs.push({
        doc_id: `tc:path:${tc.tool_call_id}`,
        entity_type: 'tool_call',
        entity_id: tc.tool_call_id,
        timestamp: tc.timestamp_start,
        role: null,
        tool_name: tc.tool_name,
        canonical_tool_type: tc.canonical_tool_type,
        field_kind: 'file_path',
        text: tc.path,
      })
    }
  }
}

function flushPending(bundle: Bundle, pending: PendingState): void {
  if (!pending.session) return

  const insertRaw = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO raw_records (
       raw_record_id, source_file_id, source_tool, record_kind, ordinal,
       line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id,
       parser_status, confidence, import_batch_id
     ) VALUES (?, ?, 'cursor', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const r of pending.rawRecords) {
    insertRaw.run(
      r.raw_record_id,
      r.source_file_id,
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

  prepare(
    bundle.db,
    `INSERT OR REPLACE INTO sessions (
       session_id, source_tool, source_session_id, project_id, parent_session_id,
       is_subagent, agent_role, agent_nickname, title, summary,
       start_ts, end_ts, cwd_initial, git_branch_initial,
       model_first, model_last, status, timeline_confidence, raw_record_id
     ) VALUES (?, 'cursor', ?, NULL, NULL, 0, ?, ?, ?, NULL, ?, NULL, NULL, NULL, ?, ?, NULL, 'low', ?)`,
  ).run(
    pending.session.session_id,
    pending.session.source_session_id,
    pending.session.agent_role,
    pending.session.agent_nickname,
    pending.session.title,
    pending.session.start_ts,
    pending.session.model,
    pending.session.model,
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

  const insertMsg = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO messages (
       message_id, session_id, turn_id, event_id, source_message_id, role,
       author_name, model, timestamp, ordinal, parent_message_id, request_id,
       status, raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, NULL, ?)`,
  )
  for (const m of pending.messages) {
    insertMsg.run(
      m.message_id,
      pending.session.session_id,
      m.event_id,
      m.source_message_id,
      m.role,
      m.model,
      m.timestamp,
      m.ordinal,
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

  const insertCall = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_calls (
       tool_call_id, session_id, turn_id, message_id, event_id,
       source_call_id, tool_name, canonical_tool_type, args_object_id,
       command, cwd, path, query, timestamp_start, timestamp_end, status,
       raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
  )
  for (const c of pending.toolCallsList) {
    insertCall.run(
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

  const insertResult = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_results (
       tool_result_id, tool_call_id, session_id, message_id, event_id,
       source_call_id, status, is_error, exit_code, duration_ms,
       stdout_object_id, stderr_object_id, output_object_id, preview, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL, ?, ?, ?)`,
  )
  for (const r of pending.toolResults) {
    insertResult.run(
      r.tool_result_id,
      r.tool_call_id,
      pending.session.session_id,
      r.message_id,
      r.event_id,
      r.source_call_id,
      r.status,
      r.is_error,
      r.output_object_id,
      r.preview,
      r.raw_record_id,
    )
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

  void artifactId // referenced by other importers; kept here for symmetry
}
