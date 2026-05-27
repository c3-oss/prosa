// Hermes Provider (v2).
//
// Discovers `*.jsonl` and `session_*.json` files under the sessions
// directory, cheap-identifies by the first `session_id`-bearing field
// (with filename fallback), and emits:
//
//   - one SessionV2 + one SourceFileV2 per file;
//   - one RawRecordV2 per JSONL line, or per `messages[]` entry for JSON
//     snapshots (with `json_pointer: /messages/<i>`), or one whole-doc
//     RawRecordV2 when the snapshot has no `messages` array;
//   - one MessageV2 per envelope with a normalized `role` (`user`,
//     `assistant`, `tool`, `system_prompt`, `developer`, `operational`);
//     `session_meta` envelopes emit EventV2 instead;
//   - one ContentBlockV2 per message for the rendered text content
//     (string, list of `{text}` / `{content}` items, or JSON-stringified
//     fallback);
//   - extra `reasoning` / `reasoning_content` / `reasoning_details` /
//     `codex_reasoning_items` / `codex_message_items` content blocks
//     tagged `hidden_by_default`;
//   - one ToolCallV2 per parsed `tool_calls[]` entry on the same envelope
//     (canonical_tool_type inferred from the tool name; `command` / `path` /
//     `query` inferred from arguments);
//   - one ToolResultV2 per `role: 'tool'` envelope linked back to the
//     matching ToolCallV2 by `source_call_id` (the envelope's
//     `tool_call_id`).
//
// SQLite `state.db` cross-reference and `sessions.json` index merging
// (the full `hermes_sqlite_plus_jsonl` strategy) stay deferred to a
// follow-up.

import { readFile } from 'node:fs/promises'
import { basename, normalize } from 'node:path'

import {
  type MessageRole,
  canonicalTimestamp,
  computeObjectId,
  deriveRawRecordId,
  deriveSourceFileId,
  isValidCanonicalTimestamp,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import { buildSearchDocsFromMessageBlocks } from '../search-doc-builder.js'
import {
  type CanonicalProjectionDraft,
  type CasObjectCandidate,
  type CheapIdentification,
  type DiscoveredSourceFile,
  type LogicalImportUnit,
  type Provider,
  type ProviderProjectInput,
  type ProviderProjectResult,
  emptyDraft,
} from '../types.js'
import { type HermesFileKind, discoverHermesFiles } from './discover.js'

const SOURCE_TOOL = 'hermes' as const
const PREVIEW_MAX = 4096

interface DiscoveredHermesFile extends DiscoveredSourceFile {
  hermes_kind: HermesFileKind
}

interface HermesEnvelope {
  session_id?: string
  sessionId?: string
  id?: string
  timestamp?: string
  type?: string
  role?: string
  model?: string
  content?: unknown
  tool_call_id?: string
  tool_calls?: unknown
  tool_name?: string
  token_count?: number
  finish_reason?: string
  reasoning?: unknown
  reasoning_content?: unknown
  reasoning_details?: unknown
  codex_reasoning_items?: unknown
  codex_message_items?: unknown
}

interface HermesJsonSnapshot {
  session_id?: string
  sessionId?: string
  id?: string
  start_time?: string
  end_time?: string
  model?: string
  summary?: string
  messages?: HermesEnvelope[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function decodeMaybeJson(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function renderContentText(value: unknown): string {
  if (value === null || value === undefined) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === 'string') return item
        if (isRecord(item)) {
          if (typeof item.text === 'string') return item.text
          if (typeof item.content === 'string') return item.content
        }
        try {
          return JSON.stringify(item)
        } catch {
          return ''
        }
      })
      .filter(Boolean)
      .join('\n')
  }
  try {
    return JSON.stringify(value)
  } catch {
    return ''
  }
}

function mapHermesRole(role: string | undefined): MessageRole {
  if (role === 'user' || role === 'assistant' || role === 'tool') return role
  if (role === 'system' || role === 'system_prompt') return 'system_prompt'
  if (role === 'developer') return 'developer'
  return 'operational'
}

function canonicalToolTypeHermes(toolName: string): string {
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

function parseToolCalls(value: unknown): Record<string, unknown>[] {
  const decoded = decodeMaybeJson(value)
  if (Array.isArray(decoded)) return decoded.filter(isRecord)
  if (isRecord(decoded)) return [decoded]
  return []
}

function stringField(record: Record<string, unknown> | null, key: string): string | null {
  if (!record) return null
  const v = record[key]
  return typeof v === 'string' && v.length > 0 ? v : null
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
    const parsed = decodeMaybeJson(args)
    if (isRecord(parsed)) return parsed
    return { value: args }
  }
  return null
}

function rowIdFromKey(prefix: string, key: string): string {
  return `${prefix}_${toHex(blake3(new TextEncoder().encode(key))).slice(0, 32)}`
}

interface ParsedEnvelope {
  env: HermesEnvelope
  rawRecordId: string
  ordinal: number
}

/**
 * Per-envelope projection — emits MessageV2 / ContentBlockV2 /
 * ToolCallV2 / ToolResultV2 / EventV2 for one envelope. Shared by the
 * JSONL and JSON-snapshot paths.
 */
interface ProjectHermesEnvelopeCasHelpers {
  enqueueCasFromText: (text: string, mimeType?: string) => string
  enqueueCasFromJson: (value: unknown) => string | null
}

function projectHermesEnvelope(
  draft: CanonicalProjectionDraft,
  sessionRowId: string,
  p: ParsedEnvelope,
  counters: { messageOrdinal: number; eventOrdinal: number },
  toolCallBySourceId: Map<string, string>,
  cas: ProjectHermesEnvelopeCasHelpers,
): { modelSeen: string | null } {
  const env = p.env
  const utf8 = new TextEncoder()
  const overflowsInline = (text: string): boolean => utf8.encode(text).length > PREVIEW_MAX
  const ts =
    typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)
      ? canonicalTimestamp(env.timestamp)
      : null
  if (env.role === 'session_meta') {
    const eventRowId =
      typeof env.id === 'string' && env.id.length > 0
        ? rowIdFromKey('evt', `hermes:evt:${sessionRowId}:${env.id}`)
        : rowIdFromKey('evt', `hermes:evt:${sessionRowId}:ord:${p.ordinal}`)
    const payloadObjectId = cas.enqueueCasFromJson(env)
    draft.events.push({
      event_id: eventRowId,
      session_id: sessionRowId,
      turn_id: null,
      source_event_id: typeof env.id === 'string' ? env.id : null,
      event_type: 'system_operational',
      source_type: 'session_meta',
      subtype: null,
      timestamp: ts,
      ordinal: counters.eventOrdinal,
      actor: 'system',
      payload_object_id: payloadObjectId,
      raw_record_id: p.rawRecordId,
      confidence: 'high',
      is_derived: false,
    })
    counters.eventOrdinal += 1
    return { modelSeen: null }
  }
  const role = mapHermesRole(env.role)
  const sourceMessageId = typeof env.id === 'string' && env.id.length > 0 ? env.id : null
  const messageRowId =
    sourceMessageId !== null
      ? rowIdFromKey('msg', `hermes:msg:${sessionRowId}:${sourceMessageId}`)
      : rowIdFromKey('msg', `hermes:msg:${sessionRowId}:ord:${p.ordinal}`)
  const modelSeen = role === 'assistant' && typeof env.model === 'string' ? env.model : null
  draft.messages.push({
    message_id: messageRowId,
    session_id: sessionRowId,
    turn_id: null,
    event_id: null,
    source_message_id: sourceMessageId,
    role,
    author_name: null,
    model: modelSeen,
    timestamp: ts,
    ordinal: counters.messageOrdinal,
    parent_message_id: null,
    request_id: null,
    status: typeof env.finish_reason === 'string' ? env.finish_reason : null,
    raw_record_id: p.rawRecordId,
  })
  counters.messageOrdinal += 1

  // Default content block.
  const text = renderContentText(env.content)
  let blockOrdinal = 0
  if (text.length > 0) {
    const textObjectId = overflowsInline(text) ? cas.enqueueCasFromText(text, 'text/plain') : null
    draft.content_blocks.push({
      block_id: rowIdFromKey('blk', `hermes:blk:${messageRowId}:${blockOrdinal}`),
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal: blockOrdinal,
      block_type: 'text',
      text_object_id: textObjectId,
      text_inline: text.slice(0, PREVIEW_MAX),
      mime_type: 'text/plain',
      token_count: typeof env.token_count === 'number' ? env.token_count : null,
      is_error: false,
      is_redacted: false,
      visibility: 'default',
      raw_record_id: p.rawRecordId,
    })
    blockOrdinal += 1
  }
  // Hidden reasoning / Codex passthrough blocks.
  const hidden: Array<[string, unknown]> = [
    ['reasoning', env.reasoning],
    ['reasoning_content', env.reasoning_content],
    ['reasoning_details', env.reasoning_details],
    ['codex_reasoning_items', env.codex_reasoning_items],
    ['codex_message_items', env.codex_message_items],
  ]
  for (const [kind, raw] of hidden) {
    const decoded = decodeMaybeJson(raw)
    const ht = renderContentText(decoded)
    if (ht.length === 0) continue
    const textObjectId = overflowsInline(ht) ? cas.enqueueCasFromText(ht, 'text/plain') : null
    draft.content_blocks.push({
      block_id: rowIdFromKey('blk', `hermes:blk:${messageRowId}:${kind}`),
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal: blockOrdinal,
      block_type: kind,
      text_object_id: textObjectId,
      text_inline: ht.slice(0, PREVIEW_MAX),
      mime_type: 'text/plain',
      token_count: null,
      is_error: false,
      is_redacted: false,
      visibility: 'hidden_by_default',
      raw_record_id: p.rawRecordId,
    })
    blockOrdinal += 1
  }

  // Tool calls inline on this envelope.
  const calls = parseToolCalls(env.tool_calls)
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]
    if (!call) continue
    const sourceCallId = getToolCallSourceId(call, `${messageRowId}:tc:${i}`)
    const toolName = getToolName(call, env.tool_name ?? null)
    const args = getToolArgs(call)
    const toolCallRowId = rowIdFromKey('tcl', `hermes:tcl:${sessionRowId}:${sourceCallId}`)
    toolCallBySourceId.set(sourceCallId, toolCallRowId)
    const argsObjectId = args !== null && args !== undefined ? cas.enqueueCasFromJson(args) : null
    draft.tool_calls.push({
      tool_call_id: toolCallRowId,
      session_id: sessionRowId,
      turn_id: null,
      message_id: messageRowId,
      event_id: null,
      source_call_id: sourceCallId,
      tool_name: toolName,
      canonical_tool_type: canonicalToolTypeHermes(toolName),
      args_object_id: argsObjectId,
      command: stringField(args, 'command'),
      cwd: stringField(args, 'cwd'),
      path: stringField(args, 'path') ?? stringField(args, 'file_path'),
      query: stringField(args, 'query'),
      timestamp_start: ts,
      timestamp_end: null,
      status: typeof env.finish_reason === 'string' ? env.finish_reason : 'started',
      raw_record_id: p.rawRecordId,
    })
  }

  // Tool result: a `role: 'tool'` envelope with a `tool_call_id` is the
  // canonical output of a prior `tool_calls[]` entry.
  if (role === 'tool' && typeof env.tool_call_id === 'string' && env.tool_call_id.length > 0) {
    const sourceCallId = env.tool_call_id
    const matchedToolCallId = toolCallBySourceId.get(sourceCallId) ?? null
    const isError = env.finish_reason === 'error'
    const outputObjectId = text.length > 0 ? cas.enqueueCasFromText(text, 'text/plain') : null
    draft.tool_results.push({
      tool_result_id: rowIdFromKey('tre', `hermes:tre:${sessionRowId}:${sourceCallId}`),
      tool_call_id: matchedToolCallId,
      session_id: sessionRowId,
      message_id: messageRowId,
      event_id: null,
      source_call_id: sourceCallId,
      status: isError ? 'error' : matchedToolCallId !== null ? 'success' : null,
      is_error: isError,
      exit_code: null,
      duration_ms: null,
      stdout_object_id: null,
      stderr_object_id: null,
      output_object_id: outputObjectId,
      preview: text.length > 0 ? text.slice(0, PREVIEW_MAX) : null,
      raw_record_id: p.rawRecordId,
    })
  }
  return { modelSeen }
}

function pickSessionId(env: HermesEnvelope | HermesJsonSnapshot | null): string | null {
  if (!env) return null
  if (typeof env.session_id === 'string' && env.session_id.length > 0) return env.session_id
  if (typeof env.sessionId === 'string' && env.sessionId.length > 0) return env.sessionId
  if (typeof env.id === 'string' && env.id.length > 0) return env.id
  return null
}

export class HermesProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredHermesFile[] = []
    for await (const hint of discoverHermesFiles(root)) {
      const bytes = await readFile(hint.filePath)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      out.push({
        source_file_id: deriveSourceFileId({
          source_tool: SOURCE_TOOL,
          path: normalize(hint.filePath),
          content_hash: contentHash,
        }),
        path: hint.filePath,
        source_tool: SOURCE_TOOL,
        file_kind: hint.kind,
        bytes,
        hermes_kind: hint.kind,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    const bytes = file.bytes ?? (await readFile(file.path))
    const enriched = file as DiscoveredHermesFile
    let sessionId: string | null = null
    if (enriched.hermes_kind === 'session_jsonl') {
      const text = new TextDecoder().decode(bytes)
      for (const line of text.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const env = JSON.parse(trimmed) as HermesEnvelope
          const id = pickSessionId(env)
          if (id !== null) {
            sessionId = id
            break
          }
        } catch {
          // skip malformed line
        }
      }
    } else {
      try {
        const snap = JSON.parse(new TextDecoder().decode(bytes)) as HermesJsonSnapshot
        sessionId = pickSessionId(snap)
      } catch {
        sessionId = null
      }
    }
    if (sessionId === null) {
      // Fall back to filename without extension as the logical id.
      const name = basename(file.path).replace(/\.jsonl?$|\.json$/, '')
      sessionId = name
    }
    return {
      logicalKey: new TextEncoder().encode(`hermes:${sessionId}`),
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('hermes parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const enriched = file as DiscoveredHermesFile

    // CAS staging — mirror of the codex/claude/cursor/gemini pattern.
    const casCandidates: CasObjectCandidate[] = []
    const seenCasIds = new Set<string>()
    const utf8Encoder = new TextEncoder()
    const enqueueCas = (payload: Uint8Array, mimeType?: string): string => {
      const objectId = computeObjectId(payload)
      if (!seenCasIds.has(objectId)) {
        seenCasIds.add(objectId)
        const candidate: CasObjectCandidate = { object_id: objectId, bytes: payload }
        if (mimeType !== undefined) candidate.mime_type = mimeType
        casCandidates.push(candidate)
      }
      return objectId
    }
    const enqueueCasFromText = (textPayload: string, mimeType?: string): string =>
      enqueueCas(utf8Encoder.encode(textPayload), mimeType)
    const enqueueCasFromJson = (value: unknown): string | null => {
      try {
        return enqueueCasFromText(JSON.stringify(value), 'application/json')
      } catch {
        return null
      }
    }

    const rawRecordIds: string[] = []
    let sessionId: string | null = null
    let sessionStartTs: string | null = null
    let sessionEndTs: string | null = null
    let modelFirst: string | null = null
    let modelLast: string | null = null
    let summary: string | null = null
    const parsedEnvelopes: ParsedEnvelope[] = []

    if (enriched.hermes_kind === 'session_jsonl') {
      const text = new TextDecoder().decode(bytes)
      const lines = text.split('\n')
      let ordinal = 0
      let logicalOffset = 0
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i] as string
        if (!line) {
          logicalOffset += 1
          continue
        }
        const byteLength = new TextEncoder().encode(line).length
        let env: HermesEnvelope | null = null
        try {
          env = JSON.parse(line) as HermesEnvelope
        } catch {
          env = null
        }
        if (env) {
          if (sessionId === null) sessionId = pickSessionId(env)
          if (
            sessionStartTs === null &&
            typeof env.timestamp === 'string' &&
            isValidCanonicalTimestamp(env.timestamp)
          ) {
            sessionStartTs = canonicalTimestamp(env.timestamp)
          }
          if (typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)) {
            sessionEndTs = canonicalTimestamp(env.timestamp)
          }
          if (typeof env.model === 'string') {
            if (modelFirst === null) modelFirst = env.model
            modelLast = env.model
          }
        }
        const rawRecordId = deriveRawRecordId({
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          ordinal,
          record_kind: 'session_jsonl_line',
        })
        rawRecordIds.push(rawRecordId)
        const decodedObjectId = env ? enqueueCasFromJson(env) : null
        draft.raw_records.push({
          raw_record_id: rawRecordId,
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          record_kind: 'session_jsonl_line',
          ordinal,
          logical_offset: logicalOffset,
          logical_length: byteLength,
          line_no: i + 1,
          json_pointer: null,
          parser_status: env ? 'parsed' : 'unparseable',
          confidence: env ? 'high' : 'low',
          content_hash: contentHash,
          object_id: contentHash,
          decoded_object_id: decodedObjectId,
          created_at: input.createdAt,
        })
        if (env) parsedEnvelopes.push({ env, rawRecordId, ordinal })
        ordinal += 1
        logicalOffset += byteLength + 1
      }
    } else {
      // session_json — one raw_record per messages[] entry, or one
      // whole-doc record when the snapshot has no messages array.
      let snap: HermesJsonSnapshot | null = null
      try {
        snap = JSON.parse(new TextDecoder().decode(bytes)) as HermesJsonSnapshot
      } catch {
        snap = null
      }
      if (snap) {
        sessionId = pickSessionId(snap)
        if (typeof snap.start_time === 'string' && isValidCanonicalTimestamp(snap.start_time)) {
          sessionStartTs = canonicalTimestamp(snap.start_time)
        }
        if (typeof snap.end_time === 'string' && isValidCanonicalTimestamp(snap.end_time)) {
          sessionEndTs = canonicalTimestamp(snap.end_time)
        }
        if (typeof snap.model === 'string') {
          modelFirst = snap.model
          modelLast = snap.model
        }
        if (typeof snap.summary === 'string') summary = snap.summary
      }
      const messages = snap?.messages ?? []
      if (messages.length > 0) {
        for (let i = 0; i < messages.length; i++) {
          const m = messages[i]
          const rawRecordId = deriveRawRecordId({
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            ordinal: i,
            record_kind: 'session_jsonl_line',
          })
          rawRecordIds.push(rawRecordId)
          const decodedObjectId = m ? enqueueCasFromJson(m) : null
          draft.raw_records.push({
            raw_record_id: rawRecordId,
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            record_kind: 'session_jsonl_line',
            ordinal: i,
            logical_offset: 0,
            logical_length: 0,
            line_no: null,
            json_pointer: `/messages/${i}`,
            parser_status: m ? 'parsed' : 'unparseable',
            confidence: m ? 'high' : 'low',
            content_hash: contentHash,
            object_id: contentHash,
            decoded_object_id: decodedObjectId,
            created_at: input.createdAt,
          })
          if (m) parsedEnvelopes.push({ env: m, rawRecordId, ordinal: i })
        }
      } else {
        const rawRecordId = deriveRawRecordId({
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          ordinal: 0,
          record_kind: 'session_jsonl_line',
        })
        rawRecordIds.push(rawRecordId)
        const decodedObjectId = snap ? enqueueCasFromJson(snap) : null
        draft.raw_records.push({
          raw_record_id: rawRecordId,
          source_tool: SOURCE_TOOL,
          source_file_id: file.source_file_id,
          record_kind: 'session_jsonl_line',
          ordinal: 0,
          logical_offset: 0,
          logical_length: bytes.length,
          line_no: null,
          json_pointer: null,
          parser_status: snap ? 'parsed' : 'unparseable',
          confidence: snap ? 'high' : 'low',
          content_hash: contentHash,
          object_id: contentHash,
          decoded_object_id: decodedObjectId,
          created_at: input.createdAt,
        })
      }
    }

    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: enriched.hermes_kind,
      size_bytes: bytes.length,
      mtime_ns: null,
      content_hash: contentHash,
      object_id: contentHash,
      pack_digest: 'blake3:0000000000000000000000000000000000000000000000000000000000000000',
      stored_offset: 0,
      stored_length: bytes.length,
      compression: 'zstd',
      last_seen_epoch: 1,
    })

    const sessionLogicalId = sessionId ?? basename(file.path).replace(/\.jsonl?$|\.json$/, '')
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(`hermes:${sessionLogicalId}`))).slice(0, 32)}`
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary,
      start_ts: sessionStartTs ?? input.createdAt,
      end_ts: sessionEndTs,
      cwd_initial: null,
      git_branch_initial: null,
      model_first: modelFirst,
      model_last: modelLast,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: rawRecordIds[0] ?? null,
    })

    // CQ-074: per-envelope projection. Run after the session row is in
    // place so projectHermesEnvelope can attach ids to a single
    // session_id. Accumulates additional model_first/last observations
    // from assistant envelopes that may post-date the first-pass scan.
    const counters = { messageOrdinal: 0, eventOrdinal: 0 }
    const toolCallBySourceId = new Map<string, string>()
    const casHelpers = { enqueueCasFromText, enqueueCasFromJson }
    for (const p of parsedEnvelopes) {
      const { modelSeen } = projectHermesEnvelope(draft, sessionRowId, p, counters, toolCallBySourceId, casHelpers)
      if (modelSeen !== null) {
        if (modelFirst === null) modelFirst = modelSeen
        modelLast = modelSeen
      }
    }
    const lastSession = draft.sessions[draft.sessions.length - 1]
    if (lastSession) {
      lastSession.model_first = modelFirst
      lastSession.model_last = modelLast
    }

    // Lane 3 compile-to-index gate: emit one SearchDocV2 per
    // message-with-indexable-text via the shared helper.
    buildSearchDocsFromMessageBlocks(draft)

    const unit: LogicalImportUnit = {
      unit_id: input.identification.unit_id,
      source_tool: SOURCE_TOOL,
      logical_kind: 'session',
      source_file_ids: [file.source_file_id],
      raw_record_ids: rawRecordIds,
      raw_source_payloads: new Map([[file.source_file_id, bytes]]),
      projection: draft,
      raw_source_leaves: [
        {
          source_file_id: file.source_file_id,
          content_hash: contentHash,
          uncompressed_size: bytes.length,
          compression: 'zstd',
          stored_hash: contentHash,
        },
      ],
      cas_object_candidates: casCandidates,
      // The minimal slice treats each file as its own LogicalImportUnit;
      // the full `hermes_sqlite_plus_jsonl` strategy lands in a follow-up.
      merge: { merge_strategy: 'single_source' },
    }
    return { unit, summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length } }
  }
}

export { discoverHermesFiles } from './discover.js'
export type { HermesFileHint, HermesFileKind } from './discover.js'
