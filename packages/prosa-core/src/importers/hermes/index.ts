import { readFile } from 'node:fs/promises'
import path from 'node:path'
import Database from 'better-sqlite3'
import type { Bundle } from '../../core/bundle.js'
import {
  type ObjectId,
  type PendingObjects,
  createPendingObjects,
  flushPendingObjects,
  stageJson,
  stageText,
} from '../../core/cas/index.js'
import { prepare, transactional } from '../../core/db.js'
import {
  blockId,
  eventId as makeEventId,
  messageId as makeMessageId,
  projectId as makeProjectId,
  rawRecordId as makeRawRecordId,
  sessionId as makeSessionId,
  toolCallId as makeToolCallId,
  toolResultId as makeToolResultId,
} from '../../core/domain/ids.js'
import { normalizeSessionStatus, normalizeToolCallStatus } from '../../core/domain/status.js'
import type { MessageRole, ToolCallStatus } from '../../core/domain/types.js'
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
import type { CompileOptions } from '../compile-options.js'
import { discoverHermesSources } from './discover.js'
import type { HermesMessageRow, HermesSessionJson, HermesSessionRow, HermesTranscriptMessage } from './types.js'

/** Result returned after a Hermes compile batch finishes or records a failed batch. */
export interface CompileResult {
  /** Import batch created for this Hermes run. */
  batch: ImportBatch
  /** Final counts accumulated while importing Hermes files. */
  counts: ImportCounts
}

const PREVIEW_MAX = 4_000
// Hidden reasoning blocks are ordered after default content blocks.
const HIDDEN_BLOCK_ORDINAL_BASE = 100

interface SourceFileRef {
  sourceFileId: string
  path: string
  kind: 'sqlite' | 'json' | 'jsonl' | 'index'
  imported: boolean
}

interface SessionCandidate {
  source: 'sqlite' | 'json' | 'jsonl'
  session: NormalizedSession
  messages: NormalizedMessage[]
  sourceFile: SourceFileRef
}

interface NormalizedSession {
  sourceSessionId: string
  source: string | null
  model: string | null
  systemPrompt: string | null
  parentSessionId: string | null
  startTs: string | null
  endTs: string | null
  status: string | null
  title: string | null
  rawPayload: unknown
}

interface NormalizedMessage {
  sourceMessageId: string
  ordinal: number
  role: string
  content: unknown
  timestamp: string | null
  model: string | null
  toolCallId: string | null
  toolCalls: unknown
  toolName: string | null
  tokenCount: number | null
  finishReason: string | null
  reasoning: unknown
  reasoningContent: unknown
  reasoningDetails: unknown
  codexReasoningItems: unknown
  codexMessageItems: unknown
  rawPayload: unknown
  lineNo: number | null
}

interface PendingState {
  rawRecords: PendingRawRecord[]
  projects: PendingProject[]
  sessions: PendingSession[]
  events: PendingEvent[]
  messages: PendingMessage[]
  blocks: PendingBlock[]
  toolCalls: PendingToolCall[]
  toolResults: PendingToolResult[]
  searchDocs: PendingSearchDoc[]
  objects: PendingObjects
}

interface PendingRawRecord {
  raw_record_id: string
  source_file_id: string
  ordinal: number | null
  line_no: number | null
  json_pointer: string | null
  native_id: string | null
  raw_object_id: ObjectId
  decoded_json_object_id: ObjectId | null
  parser_status: 'ok' | 'partial' | 'failed'
  confidence: 'high' | 'medium' | 'low'
  import_batch_id: string
  record_kind: 'sqlite_row' | 'json_pointer' | 'jsonl_line'
}

interface PendingProject {
  project_id: string
  source_project_id: string
  display_name: string | null
}

interface PendingSession {
  session_id: string
  source_session_id: string
  project_id: string | null
  parent_session_id: string | null
  is_subagent: 0 | 1
  title: string | null
  start_ts: string | null
  end_ts: string | null
  model_first: string | null
  model_last: string | null
  status: string | null
  raw_record_id: string
}

interface PendingEvent {
  event_id: string
  session_id: string
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
  session_id: string
  event_id: string | null
  source_message_id: string | null
  role: MessageRole
  model: string | null
  timestamp: string | null
  ordinal: number
  status: string | null
  raw_record_id: string
}

interface PendingBlock {
  block_id: string
  session_id: string
  message_id: string | null
  event_id: string | null
  ordinal: number
  block_type: string
  text_object_id: ObjectId | null
  text_inline: string | null
  token_count: number | null
  visibility: 'default' | 'hidden_by_default' | 'audit_only'
  raw_record_id: string
}

interface PendingToolCall {
  tool_call_id: string
  session_id: string
  message_id: string | null
  event_id: string | null
  source_call_id: string
  tool_name: string
  canonical_tool_type: string
  args_object_id: ObjectId | null
  command: string | null
  path: string | null
  query: string | null
  timestamp_start: string | null
  status: ToolCallStatus | null
  raw_record_id: string
}

interface PendingToolResult {
  tool_result_id: string
  tool_call_id: string
  session_id: string
  message_id: string | null
  event_id: string | null
  source_call_id: string
  status: ToolCallStatus | null
  is_error: 0 | 1
  output_object_id: ObjectId | null
  preview: string | null
  raw_record_id: string
}

interface PendingSearchDoc {
  doc_id: string
  entity_type: string
  entity_id: string
  session_id: string
  project_id: string | null
  timestamp: string | null
  role: string | null
  tool_name: string | null
  canonical_tool_type: string | null
  field_kind: string
  text: string
}

/** Compile Hermes session storage under `root` into the bundle. */
export async function compileHermes(
  bundle: Bundle,
  root: string,
  options: CompileOptions = {},
): Promise<CompileResult> {
  const logger = options.logger
  const batch = startBatch(bundle, 'hermes', [root])
  const counts = emptyCounts()
  logger?.info({ batch_id: batch.batch_id, root }, 'hermes batch started')

  try {
    const sources = await discoverHermesSources(root)
    const registered: SourceFileRef[] = []
    const candidates: SessionCandidate[] = []
    if (
      !sources.stateDbPath &&
      !sources.indexPath &&
      sources.jsonlFiles.length === 0 &&
      sources.jsonFiles.length === 0
    ) {
      logger?.warn({ root: sources.sessionsDir }, 'no hermes sources discovered')
    }

    if (sources.stateDbPath) {
      counts.source_files_seen++
      const sourceFile = await registerHermesSourceFile(bundle, sources.stateDbPath, 'sqlite', counts)
      registered.push(sourceFile)
      if (sourceFile.imported) {
        logger?.debug(
          { path: sources.stateDbPath, source_file_id: sourceFile.sourceFileId },
          'hermes state db discovered',
        )
        try {
          candidates.push(...readSqliteCandidates(sources.stateDbPath, sourceFile))
        } catch (error) {
          await recordHermesSourceError(bundle, batch, counts, sources.stateDbPath, error, 'hermes_sqlite_failed')
          logger?.warn({ err: error, path: sources.stateDbPath }, 'hermes state db failed')
        }
      } else {
        logger?.debug(
          { path: sources.stateDbPath, source_file_id: sourceFile.sourceFileId },
          'hermes state db unchanged, skipping read',
        )
      }
    }

    for (const filePath of sources.jsonlFiles) {
      counts.source_files_seen++
      const sourceFile = await registerHermesSourceFile(bundle, filePath, 'jsonl', counts)
      registered.push(sourceFile)
      if (!sourceFile.imported) {
        logger?.debug(
          { path: filePath, source_file_id: sourceFile.sourceFileId },
          'hermes jsonl unchanged, skipping read',
        )
        continue
      }
      logger?.debug({ path: filePath, source_file_id: sourceFile.sourceFileId }, 'hermes jsonl transcript discovered')
      try {
        candidates.push(await readJsonlCandidate(filePath, sourceFile))
      } catch (error) {
        await recordHermesSourceError(bundle, batch, counts, filePath, error, 'hermes_file_failed')
        logger?.warn({ err: error, path: filePath }, 'hermes jsonl transcript failed')
      }
    }

    for (const filePath of sources.jsonFiles) {
      counts.source_files_seen++
      const sourceFile = await registerHermesSourceFile(bundle, filePath, 'json', counts)
      registered.push(sourceFile)
      if (!sourceFile.imported) {
        logger?.debug(
          { path: filePath, source_file_id: sourceFile.sourceFileId },
          'hermes json unchanged, skipping read',
        )
        continue
      }
      logger?.debug({ path: filePath, source_file_id: sourceFile.sourceFileId }, 'hermes json snapshot discovered')
      try {
        candidates.push(await readJsonCandidate(filePath, sourceFile))
      } catch (error) {
        await recordHermesSourceError(bundle, batch, counts, filePath, error, 'hermes_file_failed')
        logger?.warn({ err: error, path: filePath }, 'hermes json snapshot failed')
      }
    }

    if (sources.indexPath) {
      counts.source_files_seen++
      const sourceFile = await registerHermesSourceFile(bundle, sources.indexPath, 'index', counts)
      registered.push(sourceFile)
      logger?.debug(
        { path: sources.indexPath, source_file_id: sourceFile.sourceFileId },
        'hermes sessions index discovered',
      )
    }

    const selection = selectCandidates(candidates)
    const pending = buildPending(
      batch,
      selection.selected,
      selection.rejected,
      registered.filter((sourceFile) => sourceFile.imported),
    )
    await flushPendingObjects(bundle, pending.objects)
    transactional(bundle.db, () => flushPending(bundle, pending))

    counts.raw_records = pending.rawRecords.length
    counts.sessions = pending.sessions.length
    counts.events = pending.events.length
    counts.messages = pending.messages.length
    counts.content_blocks = pending.blocks.length
    counts.tool_calls = pending.toolCalls.length
    counts.tool_results = pending.toolResults.length
    counts.artifacts = 0
    counts.edges = 0

    finishBatch(bundle, batch, counts, 'completed')
    logger?.info({ batch_id: batch.batch_id, counts }, 'hermes batch completed')
  } catch (error) {
    finishBatch(bundle, batch, counts, 'failed')
    counts.errors++
    logger?.error({ err: error, batch_id: batch.batch_id, counts }, 'hermes batch failed')
    await recordError(bundle, batch.batch_id, {
      kind: 'hermes_batch_failed',
      message: getErrorMessage(error),
      payload: { root },
    })
    throw error
  }

  return { batch, counts }
}

async function registerHermesSourceFile(
  bundle: Bundle,
  absolutePath: string,
  fileKind: SourceFileRef['kind'],
  counts: ImportCounts,
): Promise<SourceFileRef> {
  const { row, alreadyKnown } = await registerSourceFile(bundle, {
    sourceTool: 'hermes',
    absolutePath: path.resolve(absolutePath),
    fileKind,
  })
  if (alreadyKnown) counts.source_files_skipped++
  else counts.source_files_imported++
  return {
    sourceFileId: row.source_file_id,
    path: row.path,
    kind: fileKind,
    imported: !alreadyKnown,
  }
}

async function recordHermesSourceError(
  bundle: Bundle,
  batch: ImportBatch,
  counts: ImportCounts,
  filePath: string,
  error: unknown,
  kind: 'hermes_file_failed' | 'hermes_sqlite_failed',
): Promise<void> {
  counts.errors++
  await recordError(bundle, batch.batch_id, {
    kind,
    message: getErrorMessage(error),
    payload: { path: filePath },
  })
}

function readSqliteCandidates(dbPath: string, sourceFile: SourceFileRef): SessionCandidate[] {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true })
  try {
    const sessions = db
      .prepare<[], HermesSessionRow>(
        `SELECT id, source, user_id, model, model_config, system_prompt, parent_session_id,
                started_at, ended_at, end_reason, message_count, tool_call_count, title
           FROM sessions ORDER BY started_at, id`,
      )
      .all()
    const messagesBySession = new Map<string, HermesMessageRow[]>()
    const messages = db
      .prepare<[], HermesMessageRow>(
        `SELECT id, session_id, role, content, tool_call_id, tool_calls, tool_name,
                timestamp, token_count, finish_reason, reasoning, reasoning_content,
                reasoning_details, codex_reasoning_items, codex_message_items
           FROM messages ORDER BY session_id, id`,
      )
      .all()
    for (const message of messages) {
      const list = messagesBySession.get(message.session_id) ?? []
      list.push(message)
      messagesBySession.set(message.session_id, list)
    }

    return sessions.map((session) => ({
      source: 'sqlite',
      sourceFile,
      session: {
        sourceSessionId: session.id,
        source: session.source,
        model: session.model,
        systemPrompt: session.system_prompt,
        parentSessionId: session.parent_session_id,
        startTs: unixToIso(session.started_at),
        endTs: unixToIso(session.ended_at),
        status: session.end_reason,
        title: session.title,
        rawPayload: session,
      },
      messages: (messagesBySession.get(session.id) ?? []).map((message, index) =>
        normalizeSqliteMessage(message, index + 1),
      ),
    }))
  } finally {
    db.close()
  }
}

function normalizeSqliteMessage(message: HermesMessageRow, ordinal: number): NormalizedMessage {
  return {
    sourceMessageId: String(message.id),
    ordinal,
    role: message.role,
    content: decodeMaybeJson(message.content),
    timestamp: unixToIso(message.timestamp),
    model: null,
    toolCallId: message.tool_call_id,
    toolCalls: decodeMaybeJson(message.tool_calls),
    toolName: message.tool_name,
    tokenCount: message.token_count,
    finishReason: message.finish_reason,
    reasoning: decodeMaybeJson(message.reasoning),
    reasoningContent: decodeMaybeJson(message.reasoning_content),
    reasoningDetails: decodeMaybeJson(message.reasoning_details),
    codexReasoningItems: decodeMaybeJson(message.codex_reasoning_items),
    codexMessageItems: decodeMaybeJson(message.codex_message_items),
    rawPayload: message,
    lineNo: null,
  }
}

async function readJsonlCandidate(filePath: string, sourceFile: SourceFileRef): Promise<SessionCandidate> {
  const text = await readFile(filePath, 'utf8')
  const messages: NormalizedMessage[] = []
  const sourceSessionId = path.basename(filePath, '.jsonl')
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (!line.trim()) continue
    const parsed = JSON.parse(line) as HermesTranscriptMessage
    messages.push(normalizeTranscriptMessage(parsed, messages.length + 1, i + 1))
  }
  return {
    source: 'jsonl',
    sourceFile,
    session: {
      sourceSessionId,
      source: null,
      model: firstString(messages.map((message) => message.model)),
      systemPrompt: null,
      parentSessionId: null,
      startTs: messages[0]?.timestamp ?? null,
      endTs: messages.at(-1)?.timestamp ?? null,
      status: null,
      title: null,
      rawPayload: { session_id: sourceSessionId, path: filePath },
    },
    messages,
  }
}

async function readJsonCandidate(filePath: string, sourceFile: SourceFileRef): Promise<SessionCandidate> {
  const text = await readFile(filePath, 'utf8')
  const parsed = JSON.parse(text) as HermesSessionJson
  const sourceSessionId = parsed.session_id ?? path.basename(filePath, '.json').replace(/^session_/, '')
  const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map((message, index) =>
    normalizeTranscriptMessage(message, index + 1, null),
  )
  return {
    source: 'json',
    sourceFile,
    session: {
      sourceSessionId,
      source: parsed.platform ?? null,
      model: parsed.model ?? null,
      systemPrompt: parsed.system_prompt ?? null,
      parentSessionId: null,
      startTs: coerceTimestamp(parsed.session_start),
      endTs: coerceTimestamp(parsed.last_updated) ?? messages.at(-1)?.timestamp ?? null,
      status: null,
      title: null,
      rawPayload: parsed,
    },
    messages,
  }
}

function normalizeTranscriptMessage(
  message: HermesTranscriptMessage,
  ordinal: number,
  lineNo: number | null,
): NormalizedMessage {
  return {
    sourceMessageId: String(lineNo ?? ordinal),
    ordinal,
    role: message.role ?? 'unknown',
    content: message.content ?? null,
    timestamp: coerceTimestamp(message.timestamp),
    model: message.model ?? null,
    toolCallId: message.tool_call_id ?? null,
    toolCalls: message.tool_calls ?? null,
    toolName: message.tool_name ?? null,
    tokenCount: message.token_count ?? null,
    finishReason: message.finish_reason ?? null,
    reasoning: message.reasoning ?? null,
    reasoningContent: message.reasoning_content ?? null,
    reasoningDetails: message.reasoning_details ?? null,
    codexReasoningItems: message.codex_reasoning_items ?? null,
    codexMessageItems: message.codex_message_items ?? null,
    rawPayload: message,
    lineNo,
  }
}

function selectCandidates(candidates: SessionCandidate[]): {
  selected: SessionCandidate[]
  rejected: SessionCandidate[]
} {
  const selected = new Map<string, SessionCandidate>()
  const rejected: SessionCandidate[] = []
  for (const candidate of candidates) {
    const existing = selected.get(candidate.session.sourceSessionId)
    if (!existing) {
      selected.set(candidate.session.sourceSessionId, candidate)
      continue
    }
    if (candidate.messages.length > existing.messages.length) {
      rejected.push(existing)
      selected.set(candidate.session.sourceSessionId, candidate)
    } else {
      rejected.push(candidate)
    }
  }
  return { selected: [...selected.values()], rejected }
}

function buildPending(
  batch: ImportBatch,
  selected: SessionCandidate[],
  rejected: SessionCandidate[],
  importedSources: SourceFileRef[],
): PendingState {
  const pending: PendingState = {
    rawRecords: [],
    projects: [],
    sessions: [],
    events: [],
    messages: [],
    blocks: [],
    toolCalls: [],
    toolResults: [],
    searchDocs: [],
    objects: createPendingObjects(),
  }

  const candidateSourceIds = new Set([...selected, ...rejected].map((candidate) => candidate.sourceFile.sourceFileId))
  for (const sourceFile of importedSources) {
    if (candidateSourceIds.has(sourceFile.sourceFileId)) continue
    const payload = { path: sourceFile.path, kind: sourceFile.kind }
    const objectId = stageJson(pending.objects, payload)
    pending.rawRecords.push({
      raw_record_id: makeRawRecordId(sourceFile.sourceFileId, 0, objectId),
      source_file_id: sourceFile.sourceFileId,
      ordinal: 0,
      line_no: null,
      json_pointer: '',
      native_id: null,
      raw_object_id: objectId,
      decoded_json_object_id: objectId,
      parser_status: 'partial',
      confidence: 'high',
      import_batch_id: batch.batch_id,
      record_kind: sourceFile.kind === 'jsonl' ? 'jsonl_line' : 'json_pointer',
    })
  }

  for (const candidate of selected) {
    stageCandidate(batch, candidate, pending)
  }
  for (const candidate of rejected) {
    stageRejectedCandidate(batch, candidate, pending)
  }
  buildSearchDocs(pending)
  return pending
}

function stageRejectedCandidate(batch: ImportBatch, candidate: SessionCandidate, pending: PendingState): void {
  const payloadId = stageJson(pending.objects, candidate.session.rawPayload)
  pending.rawRecords.push({
    raw_record_id: makeRawRecordId(candidate.sourceFile.sourceFileId, 0, payloadId),
    source_file_id: candidate.sourceFile.sourceFileId,
    ordinal: 0,
    line_no: null,
    json_pointer: candidate.source === 'sqlite' ? `$.sessions.${candidate.session.sourceSessionId}` : '$.candidate',
    native_id: candidate.session.sourceSessionId,
    raw_object_id: payloadId,
    decoded_json_object_id: payloadId,
    parser_status: 'partial',
    confidence: 'high',
    import_batch_id: batch.batch_id,
    record_kind: candidate.source === 'sqlite' ? 'sqlite_row' : 'json_pointer',
  })
}

function stageCandidate(batch: ImportBatch, candidate: SessionCandidate, pending: PendingState): void {
  const sessionPk = makeSessionId('hermes', candidate.session.sourceSessionId)
  const sessionPayloadId = stageJson(pending.objects, candidate.session.rawPayload)
  const sessionRawId = makeRawRecordId(candidate.sourceFile.sourceFileId, 0, sessionPayloadId)
  pending.rawRecords.push({
    raw_record_id: sessionRawId,
    source_file_id: candidate.sourceFile.sourceFileId,
    ordinal: 0,
    line_no: null,
    json_pointer: candidate.source === 'sqlite' ? '$.sessions' : '',
    native_id: candidate.session.sourceSessionId,
    raw_object_id: sessionPayloadId,
    decoded_json_object_id: sessionPayloadId,
    parser_status: 'ok',
    confidence: 'high',
    import_batch_id: batch.batch_id,
    record_kind: candidate.source === 'sqlite' ? 'sqlite_row' : 'json_pointer',
  })

  const projectId = candidate.session.source ? makeProjectId('hermes', candidate.session.source) : null
  if (candidate.session.source && projectId) {
    pending.projects.push({
      project_id: projectId,
      source_project_id: candidate.session.source,
      display_name: candidate.session.source,
    })
  }

  const models = candidate.messages.map((message) => message.model).filter((model): model is string => Boolean(model))
  pending.sessions.push({
    session_id: sessionPk,
    source_session_id: candidate.session.sourceSessionId,
    project_id: projectId,
    parent_session_id: candidate.session.parentSessionId
      ? makeSessionId('hermes', candidate.session.parentSessionId)
      : null,
    is_subagent: candidate.session.parentSessionId ? 1 : 0,
    title: candidate.session.title,
    start_ts: candidate.session.startTs,
    end_ts: candidate.session.endTs,
    model_first: candidate.session.model ?? models[0] ?? null,
    model_last: models.at(-1) ?? candidate.session.model ?? null,
    status: normalizeSessionStatus(candidate.session.status),
    raw_record_id: sessionRawId,
  })

  if (candidate.session.systemPrompt) {
    const rawRecordId = sessionRawId
    const messageId = makeMessageId(sessionPk, 0, 'system_prompt')
    pending.messages.push({
      message_id: messageId,
      session_id: sessionPk,
      event_id: null,
      source_message_id: 'system_prompt',
      role: 'system_prompt',
      model: null,
      timestamp: candidate.session.startTs,
      ordinal: 0,
      status: null,
      raw_record_id: rawRecordId,
    })
    pushTextBlock(pending, sessionPk, messageId, null, 0, 'text', candidate.session.systemPrompt, rawRecordId)
  }

  const toolCallsBySourceId = new Map<string, PendingToolCall>()
  for (const message of candidate.messages) {
    stageMessage(candidate, sessionPk, message, batch.batch_id, pending, toolCallsBySourceId)
  }
}

function stageMessage(
  candidate: SessionCandidate,
  sessionPk: string,
  message: NormalizedMessage,
  batchId: string,
  pending: PendingState,
  toolCallsBySourceId: Map<string, PendingToolCall>,
): void {
  const payloadId = stageJson(pending.objects, message.rawPayload)
  const rawRecordId = makeRawRecordId(candidate.sourceFile.sourceFileId, message.ordinal, payloadId)
  pending.rawRecords.push({
    raw_record_id: rawRecordId,
    source_file_id: candidate.sourceFile.sourceFileId,
    ordinal: message.ordinal,
    line_no: message.lineNo,
    json_pointer: candidate.source === 'json' ? `/messages/${message.ordinal - 1}` : null,
    native_id: message.sourceMessageId,
    raw_object_id: payloadId,
    decoded_json_object_id: payloadId,
    parser_status: 'ok',
    confidence: 'high',
    import_batch_id: batchId,
    record_kind:
      candidate.source === 'sqlite' ? 'sqlite_row' : candidate.source === 'jsonl' ? 'jsonl_line' : 'json_pointer',
  })

  if (message.role === 'session_meta') {
    pending.events.push({
      event_id: makeEventId(sessionPk, message.ordinal, 'session_meta'),
      session_id: sessionPk,
      ordinal: message.ordinal,
      source_event_id: message.sourceMessageId,
      event_type: 'system_operational',
      source_type: 'session_meta',
      subtype: null,
      timestamp: message.timestamp,
      actor: 'system',
      payload_object_id: payloadId,
      raw_record_id: rawRecordId,
      confidence: 'high',
    })
    return
  }

  const role = mapRole(message.role)
  const eventId = makeEventId(sessionPk, message.ordinal, 'message')
  const messageId = makeMessageId(sessionPk, message.ordinal, message.sourceMessageId)
  pending.events.push({
    event_id: eventId,
    session_id: sessionPk,
    ordinal: message.ordinal,
    source_event_id: message.sourceMessageId,
    event_type: 'message',
    source_type: message.role,
    subtype: null,
    timestamp: message.timestamp,
    actor: role,
    payload_object_id: payloadId,
    raw_record_id: rawRecordId,
    confidence: 'high',
  })
  pending.messages.push({
    message_id: messageId,
    session_id: sessionPk,
    event_id: eventId,
    source_message_id: message.sourceMessageId,
    role,
    model: role === 'assistant' ? message.model : null,
    timestamp: message.timestamp,
    ordinal: message.ordinal,
    status: message.finishReason,
    raw_record_id: rawRecordId,
  })

  const text = renderContentText(message.content)
  pushTextBlock(pending, sessionPk, messageId, eventId, 0, 'text', text, rawRecordId, 'default', message.tokenCount)
  pushHiddenBlock(pending, sessionPk, messageId, eventId, message, rawRecordId)

  for (const [index, call] of parseToolCalls(message.toolCalls).entries()) {
    const sourceCallId = getToolCallSourceId(call, `${messageId}:${index}`)
    const toolName = getToolName(call, message.toolName)
    const args = getToolArgs(call)
    const toolCallId = makeToolCallId(sessionPk, sourceCallId)
    const pendingCall: PendingToolCall = {
      tool_call_id: toolCallId,
      session_id: sessionPk,
      message_id: messageId,
      event_id: eventId,
      source_call_id: sourceCallId,
      tool_name: toolName,
      canonical_tool_type: canonicalToolType(toolName),
      args_object_id: args ? stageJson(pending.objects, args) : null,
      command: stringField(args, 'command'),
      path: stringField(args, 'path') ?? stringField(args, 'file_path'),
      query: stringField(args, 'query'),
      timestamp_start: message.timestamp,
      status: normalizeToolCallStatus('hermes', message.finishReason),
      raw_record_id: rawRecordId,
    }
    toolCallsBySourceId.set(sourceCallId, pendingCall)
    pending.toolCalls.push(pendingCall)
  }

  if (role === 'tool' && message.toolCallId) {
    const sourceCallId = message.toolCallId
    let pendingCall = toolCallsBySourceId.get(sourceCallId)
    if (!pendingCall) {
      pendingCall = {
        tool_call_id: makeToolCallId(sessionPk, sourceCallId),
        session_id: sessionPk,
        message_id: null,
        event_id: null,
        source_call_id: sourceCallId,
        tool_name: message.toolName ?? 'unknown',
        canonical_tool_type: canonicalToolType(message.toolName ?? 'unknown'),
        args_object_id: null,
        command: null,
        path: null,
        query: null,
        timestamp_start: message.timestamp,
        status: 'unknown',
        raw_record_id: rawRecordId,
      }
      toolCallsBySourceId.set(sourceCallId, pendingCall)
      pending.toolCalls.push(pendingCall)
    }
    const outputObjectId = text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null
    const status = normalizeToolResultStatus(message, text)
    if (status === 'error' || pendingCall.status === 'unknown' || pendingCall.status == null) {
      pendingCall.status = status
    }
    pending.toolResults.push({
      tool_result_id: makeToolResultId(sessionPk, sourceCallId),
      tool_call_id: pendingCall.tool_call_id,
      session_id: sessionPk,
      message_id: messageId,
      event_id: eventId,
      source_call_id: sourceCallId,
      status,
      is_error: status === 'error' ? 1 : 0,
      output_object_id: outputObjectId,
      preview: text.slice(0, PREVIEW_MAX) || null,
      raw_record_id: rawRecordId,
    })
  }
}

function pushTextBlock(
  pending: PendingState,
  sessionId: string,
  messageId: string | null,
  eventId: string | null,
  ordinal: number,
  blockType: string,
  text: string,
  rawRecordId: string,
  visibility: 'default' | 'hidden_by_default' | 'audit_only' = 'default',
  tokenCount: number | null = null,
): void {
  if (!text) return
  const objectId = text.length > PREVIEW_MAX ? stageText(pending.objects, text) : null
  pending.blocks.push({
    block_id: blockId(messageId ?? eventId ?? rawRecordId, ordinal),
    session_id: sessionId,
    message_id: messageId,
    event_id: eventId,
    ordinal,
    block_type: blockType,
    text_object_id: objectId,
    text_inline: text.slice(0, PREVIEW_MAX),
    token_count: tokenCount,
    visibility,
    raw_record_id: rawRecordId,
  })
}

function pushHiddenBlock(
  pending: PendingState,
  sessionId: string,
  messageId: string,
  eventId: string,
  message: NormalizedMessage,
  rawRecordId: string,
): void {
  const hidden = [
    ['reasoning', message.reasoning],
    ['reasoning_content', message.reasoningContent],
    ['reasoning_details', message.reasoningDetails],
    ['codex_reasoning_items', message.codexReasoningItems],
    ['codex_message_items', message.codexMessageItems],
  ] as const
  let offset = HIDDEN_BLOCK_ORDINAL_BASE
  for (const [kind, value] of hidden) {
    const text = renderContentText(value)
    if (!text) continue
    pushTextBlock(pending, sessionId, messageId, eventId, offset++, kind, text, rawRecordId, 'hidden_by_default')
  }
}

function buildSearchDocs(pending: PendingState): void {
  const projectIdBySession = new Map(pending.sessions.map((session) => [session.session_id, session.project_id]))
  for (const message of pending.messages) {
    const text = pending.blocks
      .filter((block) => block.message_id === message.message_id && block.visibility === 'default')
      .map((block) => block.text_inline ?? '')
      .join('\n')
      .trim()
    if (!text) continue
    pending.searchDocs.push({
      doc_id: `msg:${message.message_id}`,
      entity_type: 'message',
      entity_id: message.message_id,
      session_id: message.session_id,
      project_id: projectIdBySession.get(message.session_id) ?? null,
      timestamp: message.timestamp,
      role: message.role,
      tool_name: null,
      canonical_tool_type: null,
      field_kind: message.role === 'user' ? 'user_prompt' : message.role === 'tool' ? 'tool_result' : 'assistant_text',
      text,
    })
  }
  for (const call of pending.toolCalls) {
    const text = [call.tool_name, call.command, call.path, call.query].filter(Boolean).join('\n')
    if (!text) continue
    pending.searchDocs.push({
      doc_id: `tc:${call.tool_call_id}`,
      entity_type: 'tool_call',
      entity_id: call.tool_call_id,
      session_id: call.session_id,
      project_id: projectIdBySession.get(call.session_id) ?? null,
      timestamp: call.timestamp_start,
      role: null,
      tool_name: call.tool_name,
      canonical_tool_type: call.canonical_tool_type,
      field_kind: call.command ? 'command' : 'tool_call',
      text,
    })
  }
  for (const result of pending.toolResults) {
    if (!result.preview) continue
    pending.searchDocs.push({
      doc_id: `tr:${result.tool_result_id}`,
      entity_type: 'tool_result',
      entity_id: result.tool_result_id,
      session_id: result.session_id,
      project_id: projectIdBySession.get(result.session_id) ?? null,
      timestamp: null,
      role: 'tool',
      tool_name: null,
      canonical_tool_type: null,
      field_kind: result.is_error ? 'error' : 'tool_result',
      text: result.preview,
    })
  }
}

function flushPending(bundle: Bundle, pending: PendingState): void {
  const insertRaw = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO raw_records (
       raw_record_id, source_file_id, source_tool, record_kind, ordinal,
       line_no, json_pointer, native_id, raw_object_id, decoded_json_object_id,
       parser_status, confidence, import_batch_id
     ) VALUES (?, ?, 'hermes', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const record of pending.rawRecords) {
    insertRaw.run(
      record.raw_record_id,
      record.source_file_id,
      record.record_kind,
      record.ordinal,
      record.line_no,
      record.json_pointer,
      record.native_id,
      record.raw_object_id,
      record.decoded_json_object_id,
      record.parser_status,
      record.confidence,
      record.import_batch_id,
    )
  }

  const existingSession = prepare<[string], { found: number }>(
    bundle.db,
    `SELECT 1 AS found FROM sessions WHERE session_id = ? LIMIT 1`,
  )
  for (const session of pending.sessions) {
    if (existingSession.get(session.session_id)) {
      deleteSessionProjection(bundle, session.session_id)
    }
  }

  const insertProject = prepare(
    bundle.db,
    `INSERT OR IGNORE INTO projects (
       project_id, canonical_path, path_hash, source_tool, source_project_id,
       display_name, created_at
     ) VALUES (?, NULL, NULL, 'hermes', ?, ?, ?)`,
  )
  for (const project of pending.projects) {
    insertProject.run(project.project_id, project.source_project_id, project.display_name, new Date().toISOString())
  }

  const insertSession = prepare(
    bundle.db,
    `INSERT INTO sessions (
       session_id, source_tool, source_session_id, project_id, parent_session_id,
       is_subagent, agent_role, agent_nickname, title, summary,
       start_ts, end_ts, cwd_initial, git_branch_initial,
       model_first, model_last, status, timeline_confidence, raw_record_id
     ) VALUES (?, 'hermes', ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, NULL, NULL, ?, ?, ?, 'high', ?)
     ON CONFLICT(session_id) DO UPDATE SET
       source_tool = excluded.source_tool,
       source_session_id = excluded.source_session_id,
       project_id = excluded.project_id,
       parent_session_id = excluded.parent_session_id,
       is_subagent = excluded.is_subagent,
       agent_role = excluded.agent_role,
       agent_nickname = excluded.agent_nickname,
       title = excluded.title,
       summary = excluded.summary,
       start_ts = excluded.start_ts,
       end_ts = excluded.end_ts,
       cwd_initial = excluded.cwd_initial,
       git_branch_initial = excluded.git_branch_initial,
       model_first = excluded.model_first,
       model_last = excluded.model_last,
       status = excluded.status,
       timeline_confidence = excluded.timeline_confidence,
       raw_record_id = excluded.raw_record_id`,
  )
  for (const session of pending.sessions) {
    insertSession.run(
      session.session_id,
      session.source_session_id,
      session.project_id,
      session.parent_session_id,
      session.is_subagent,
      session.title,
      session.start_ts,
      session.end_ts,
      session.model_first,
      session.model_last,
      session.status,
      session.raw_record_id,
    )
  }

  const insertEvent = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO events (
       event_id, session_id, turn_id, source_event_id, event_type, source_type,
       subtype, timestamp, ordinal, actor, payload_object_id, raw_record_id,
       confidence, is_derived
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`,
  )
  for (const event of pending.events) {
    insertEvent.run(
      event.event_id,
      event.session_id,
      event.source_event_id,
      event.event_type,
      event.source_type,
      event.subtype,
      event.timestamp,
      event.ordinal,
      event.actor,
      event.payload_object_id,
      event.raw_record_id,
      event.confidence,
    )
  }

  const insertMessage = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO messages (
       message_id, session_id, turn_id, event_id, source_message_id, role,
       author_name, model, timestamp, ordinal, parent_message_id, request_id,
       status, raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?)`,
  )
  for (const message of pending.messages) {
    insertMessage.run(
      message.message_id,
      message.session_id,
      message.event_id,
      message.source_message_id,
      message.role,
      message.model,
      message.timestamp,
      message.ordinal,
      message.status,
      message.raw_record_id,
    )
  }

  const insertBlock = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO content_blocks (
       block_id, message_id, event_id, session_id, ordinal, block_type,
       text_object_id, text_inline, mime_type, token_count, is_error,
       is_redacted, visibility, raw_record_id
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, 0, 0, ?, ?)`,
  )
  for (const block of pending.blocks) {
    insertBlock.run(
      block.block_id,
      block.message_id,
      block.event_id,
      block.session_id,
      block.ordinal,
      block.block_type,
      block.text_object_id,
      block.text_inline,
      block.token_count,
      block.visibility,
      block.raw_record_id,
    )
  }

  const insertCall = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO tool_calls (
       tool_call_id, session_id, turn_id, message_id, event_id,
       source_call_id, tool_name, canonical_tool_type, args_object_id,
       command, cwd, path, query, timestamp_start, timestamp_end, status,
       raw_record_id
     ) VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?)`,
  )
  for (const call of pending.toolCalls) {
    insertCall.run(
      call.tool_call_id,
      call.session_id,
      call.message_id,
      call.event_id,
      call.source_call_id,
      call.tool_name,
      call.canonical_tool_type,
      call.args_object_id,
      call.command,
      call.path,
      call.query,
      call.timestamp_start,
      call.status,
      call.raw_record_id,
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
  for (const result of pending.toolResults) {
    insertResult.run(
      result.tool_result_id,
      result.tool_call_id,
      result.session_id,
      result.message_id,
      result.event_id,
      result.source_call_id,
      result.status,
      result.is_error,
      result.output_object_id,
      result.preview,
      result.raw_record_id,
    )
  }

  const insertSearch = prepare(
    bundle.db,
    `INSERT OR REPLACE INTO search_docs (
       doc_id, entity_type, entity_id, session_id, project_id, timestamp,
       role, tool_name, canonical_tool_type, field_kind, text
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
  for (const doc of pending.searchDocs) {
    insertSearch.run(
      doc.doc_id,
      doc.entity_type,
      doc.entity_id,
      doc.session_id,
      doc.project_id,
      doc.timestamp,
      doc.role,
      doc.tool_name,
      doc.canonical_tool_type,
      doc.field_kind,
      doc.text,
    )
  }
}

function deleteSessionProjection(bundle: Bundle, sessionId: string): void {
  prepare<[string]>(bundle.db, `DELETE FROM search_docs WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM tool_results WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM tool_calls WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM content_blocks WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM messages WHERE session_id = ?`).run(sessionId)
  prepare<[string, string]>(
    bundle.db,
    `DELETE FROM edges WHERE (src_type = 'session' AND src_id = ?) OR (dst_type = 'session' AND dst_id = ?)`,
  ).run(sessionId, sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM artifacts WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM events WHERE session_id = ?`).run(sessionId)
  prepare<[string]>(bundle.db, `DELETE FROM turns WHERE session_id = ?`).run(sessionId)
}

function unixToIso(value: number | null | undefined): string | null {
  if (value == null || !Number.isFinite(value)) return null
  return new Date(value * 1000).toISOString()
}

function coerceTimestamp(value: string | number | null | undefined): string | null {
  if (value == null) return null
  // Hermes currently stores numeric timestamps as unix seconds.
  if (typeof value === 'number') return unixToIso(value)
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function normalizeToolResultStatus(message: NormalizedMessage, text: string): ToolCallStatus {
  if (isToolError(message, text)) return 'error'
  const status = normalizeToolCallStatus('hermes', message.finishReason)
  return status === 'unknown' ? 'success' : status
}

function isToolError(message: NormalizedMessage, text: string): boolean {
  if (message.finishReason === 'error') return true
  if (hasErrorMarker(message.rawPayload)) return true
  if (hasErrorMarker(message.content)) return true
  return /^(error|tool_use_error|exception)[: ]/i.test(text.trim())
}

function hasErrorMarker(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasErrorMarker)
  if (!isRecord(value)) return false
  if (value.is_error === true) return true
  if (typeof value.status === 'string' && value.status.toLowerCase() === 'error') return true
  if (typeof value.type === 'string' && value.type.toLowerCase() === 'tool_use_error') return true
  return false
}

function decodeMaybeJson(value: string | null): unknown {
  if (value == null) return null
  const trimmed = value.trim()
  if (!trimmed) return value
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return value
  try {
    return JSON.parse(trimmed) as unknown
  } catch {
    return value
  }
}

function renderContentText(value: unknown): string {
  if (value == null) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item)) {
          if (typeof item.text === 'string') return item.text
          if (typeof item.content === 'string') return item.content
        }
        return JSON.stringify(item)
      })
      .filter(Boolean)
      .join('\n')
  }
  return JSON.stringify(value)
}

function mapRole(role: string): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  if (role === 'system' || role === 'system_prompt') return 'system_prompt'
  if (role === 'developer') return 'developer'
  return 'operational'
}

function parseToolCalls(value: unknown): Record<string, unknown>[] {
  const decoded = typeof value === 'string' ? decodeMaybeJson(value) : value
  if (Array.isArray(decoded)) return decoded.filter(isRecord)
  if (isRecord(decoded)) return [decoded]
  return []
}

function getToolCallSourceId(call: Record<string, unknown>, fallback: string): string {
  return stringField(call, 'id') ?? stringField(call, 'call_id') ?? stringField(call, 'tool_call_id') ?? fallback
}

function getToolName(call: Record<string, unknown>, fallback: string | null): string {
  const fn = isRecord(call.function) ? call.function : null
  return stringField(fn, 'name') ?? stringField(call, 'name') ?? stringField(call, 'tool_name') ?? fallback ?? 'unknown'
}

function getToolArgs(call: Record<string, unknown>): Record<string, unknown> | null {
  const fn = isRecord(call.function) ? call.function : null
  const args = fn?.arguments ?? call.args ?? call.input
  if (isRecord(args)) return args
  if (typeof args === 'string') {
    try {
      const parsed = JSON.parse(args) as unknown
      return isRecord(parsed) ? parsed : { value: parsed }
    } catch {
      return { value: args }
    }
  }
  return null
}

function canonicalToolType(toolName: string): string {
  const lowered = toolName.toLowerCase()
  if (lowered.includes('shell') || lowered.includes('bash') || lowered.includes('terminal')) return 'shell'
  if (lowered.includes('read')) return 'read_file'
  if (lowered.includes('write')) return 'write_file'
  if (lowered.includes('edit') || lowered.includes('patch')) return 'edit_file'
  if (lowered.includes('search') || lowered.includes('grep') || lowered.includes('glob')) return 'search_file'
  if (lowered.includes('web')) return 'web_search'
  if (lowered.includes('mcp')) return 'mcp'
  if (lowered.includes('delegate') || lowered.includes('agent')) return 'subagent'
  return 'other'
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null
  const value = record[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function firstString(values: Array<string | null>): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
