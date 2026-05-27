// Claude Code Provider (v2).
//
// Discovers JSONL files under `<root>/<project-slug>/` (and subagent files
// under `<sid>/subagents/agent-<aid>.jsonl`), cheap-identifies by the first
// record's `sessionId` (and `agentId` for subagents), and emits a
// `LogicalImportUnit` with full per-record projection:
//
//   - one SessionV2 + one SourceFileV2 + one RawRecordV2 per JSONL line;
//   - one MessageV2 per `type: 'user'` / `type: 'assistant'` record, with
//     one ContentBlockV2 per `message.content[]` entry (or a single text
//     block when `message.content` is a bare string);
//   - one ToolCallV2 per `tool_use` content block (with `source_call_id`,
//     inferred `command` / `cwd` / `path` / `query`, `canonical_tool_type`);
//   - one ToolResultV2 per `tool_result` content block, linked to the
//     prior `tool_use` by `source_call_id` with a bounded `preview`;
//   - one EventV2 per operational record (`type: 'system'`, `progress`,
//     `summary`, `api_error`, anything else not classified as a message).
//
// Subagent files emit a deterministic `spawned` EdgeV2 from the parent
// session row to this subagent session row (CQ-068). GraphResolver picks
// the edge up in the same epoch and sets `parent_session_id` +
// `parent_resolution='edge_derived'` on the subagent's session row.
//
// Cursor-side details intentionally deferred: subagent meta-file parsing
// (`<sid>/subagents/agent-<aid>.meta.json` for `agentType` / `description`)
// and TurnV2 emission (Claude records have no explicit `turn_context`
// envelope; turn boundaries would need to be synthesised from user →
// assistant pair detection).

import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'

import {
  type Actor,
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
  type CasObjectCandidate,
  type CheapIdentification,
  type DiscoveredSourceFile,
  type LogicalImportUnit,
  type Provider,
  type ProviderProjectInput,
  type ProviderProjectResult,
  emptyDraft,
} from '../types.js'
import { discoverClaudeFiles } from './discover.js'
import type { ClaudeContentBlock, ClaudeMessage, ClaudeRecord } from './types.js'

const PREVIEW_MAX = 4096

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

function inferCommandFromArgs(toolName: string, args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  if (toolName.toLowerCase() === 'bash' && typeof obj.cmd === 'string') return obj.cmd
  return null
}

function inferPathFromArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.absolute_path === 'string') return obj.absolute_path
  return null
}

function inferQueryFromArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.query === 'string') return obj.query
  if (typeof obj.pattern === 'string') return obj.pattern
  return null
}

function stringifyOrNull(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return null
  }
}

/** Reclassify tool-result-only Claude `user` messages as `tool` role —
 *  same heuristic as the v1 importer. Mixed user content stays as `user`. */
function inferClaudeRole(parsed: ClaudeRecord, fallback: 'user' | 'assistant'): MessageRole {
  if (fallback !== 'user') return 'assistant'
  const c = parsed.message?.content
  if (!Array.isArray(c) || c.length === 0) return 'user'
  const allToolResult = c.every((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'tool_result')
  return allToolResult ? 'tool' : 'user'
}

function actorFromEventType(t: string): Actor {
  if (t === 'system' || t === 'system_operational') return 'system'
  if (t === 'progress') return 'cli'
  return 'system'
}

function rowIdFromKey(prefix: string, key: string): string {
  return `${prefix}_${toHex(blake3(new TextEncoder().encode(key))).slice(0, 32)}`
}

/** A Claude DiscoveredSourceFile carries the parent-session id and agent
 *  id from the discovery walk so `parseAndProject` can synthesise the
 *  spawned-edge for subagent files. */
interface DiscoveredClaudeFile extends DiscoveredSourceFile {
  parent_session_id: string | null
  agent_id: string | null
  project_slug: string
}

/** Deterministic session row id from a Claude logical key (matches the
 *  hashing inside `parseAndProject` so a spawned-edge from a subagent
 *  unit references the main session's row id even when the two files
 *  land in different `parseAndProject` calls within the same epoch). */
function claudeSessionRowId(args: { sessionId: string; agentId: string | null }): string {
  const material = args.agentId !== null ? `claude:${args.sessionId}:agent:${args.agentId}` : `claude:${args.sessionId}`
  return `ses_${toHex(blake3(new TextEncoder().encode(material))).slice(0, 32)}`
}

const SOURCE_TOOL = 'claude' as const
const FILE_KIND = 'session_jsonl'

/** Source-file id derivation key: includes the path so two copies of the same
 *  bytes in different projects/agents are distinct artifacts. */
function deriveClaudeSourceFileId(filePath: string, contentHash: string): string {
  return deriveSourceFileId({
    source_tool: SOURCE_TOOL,
    path: normalize(filePath),
    content_hash: contentHash,
  })
}

export class ClaudeProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredClaudeFile[] = []
    for await (const hint of discoverClaudeFiles(root)) {
      const bytes = await readFile(hint.filePath)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      out.push({
        source_file_id: deriveClaudeSourceFileId(hint.filePath, contentHash),
        path: hint.filePath,
        source_tool: SOURCE_TOOL,
        file_kind: hint.isSubagent ? 'session_jsonl_subagent' : FILE_KIND,
        bytes,
        parent_session_id: hint.parentSessionId,
        agent_id: hint.agentId,
        project_slug: hint.projectSlug,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // Walk just enough of the file to find the first record carrying a
    // sessionId. Subagent files share their parent session's sessionId
    // but have a distinct agentId; we incorporate both so the logical
    // key dedupes correctly.
    const bytes = file.bytes ?? (await readFile(file.path))
    const text = new TextDecoder().decode(bytes)
    let sessionId: string | null = null
    let agentId: string | null = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let rec: ClaudeRecord
      try {
        rec = JSON.parse(trimmed) as ClaudeRecord
      } catch {
        continue
      }
      if (typeof rec.sessionId === 'string' && rec.sessionId.length > 0) {
        sessionId = rec.sessionId
      }
      if (typeof rec.agentId === 'string' && rec.agentId.length > 0) {
        agentId = rec.agentId
      }
      if (sessionId !== null) break
    }
    const logicalKey =
      sessionId !== null
        ? new TextEncoder().encode(agentId !== null ? `claude:${sessionId}:agent:${agentId}` : `claude:${sessionId}`)
        : new TextEncoder().encode(`claude:src:${file.source_file_id}`)
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) {
      throw new Error('claude parseAndProject: no input file')
    }
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const text = new TextDecoder().decode(bytes)
    const lines = text.split('\n')

    // CAS staging mirror of the codex importer: importer computes the
    // canonical object_id locally, stores it on the row, and pushes a
    // candidate the orchestrator hands to `CasPackWriterPool` so the
    // bytes land in a registered pack before sealEpoch enforces FK
    // closure on `OBJECT_ID_FIELDS`.
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
    let ordinal = 0
    let logicalOffset = 0
    let sessionId: string | null = null
    let agentId: string | null = null
    let sessionStartTs: string | null = null
    let model: string | null = null
    let cwd: string | null = null
    let gitBranch: string | null = null
    let isSubagent = file.file_kind === 'session_jsonl_subagent'

    interface ParsedLine {
      rec: ClaudeRecord | null
      rawRecordId: string
      ordinal: number
    }
    const parsed: ParsedLine[] = []

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!line) {
        logicalOffset += 1
        continue
      }
      const lineByteLength = new TextEncoder().encode(line).length
      let rec: ClaudeRecord | null = null
      try {
        rec = JSON.parse(line) as ClaudeRecord
      } catch {
        rec = null
      }
      if (rec) {
        if (sessionId === null && typeof rec.sessionId === 'string') sessionId = rec.sessionId
        if (agentId === null && typeof rec.agentId === 'string') agentId = rec.agentId
        if (rec.isSidechain === true) isSubagent = true
        if (sessionStartTs === null && typeof rec.timestamp === 'string' && isValidCanonicalTimestamp(rec.timestamp)) {
          sessionStartTs = canonicalTimestamp(rec.timestamp)
        }
        if (cwd === null && typeof rec.cwd === 'string') cwd = rec.cwd
        if (gitBranch === null && typeof rec.gitBranch === 'string') gitBranch = rec.gitBranch
        if (model === null && typeof rec.message?.model === 'string') model = rec.message.model
      }
      const rawRecordId = deriveRawRecordId({
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        ordinal,
        record_kind: 'session_jsonl_line',
      })
      rawRecordIds.push(rawRecordId)
      const decodedObjectId = rec ? enqueueCasFromJson(rec) : null
      draft.raw_records.push({
        raw_record_id: rawRecordId,
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        record_kind: 'session_jsonl_line',
        ordinal,
        logical_offset: logicalOffset,
        logical_length: lineByteLength,
        line_no: i + 1,
        json_pointer: null,
        parser_status: rec ? 'parsed' : 'unparseable',
        confidence: rec ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: decodedObjectId,
        created_at: input.createdAt,
      })
      parsed.push({ rec, rawRecordId, ordinal })
      ordinal += 1
      logicalOffset += lineByteLength + 1
    }

    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: isSubagent ? 'session_jsonl_subagent' : FILE_KIND,
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

    const sessionLogicalId = sessionId ?? input.identification.unit_id
    // For subagent files, include the agentId so the same parent
    // sessionId across main + subagent files derives a distinct session.
    const sessionRowId = claudeSessionRowId({ sessionId: sessionLogicalId, agentId })
    const firstRawRecordId = rawRecordIds[0] ?? null
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: isSubagent,
      agent_role: null,
      agent_nickname: null,
      title: null,
      summary: null,
      start_ts: sessionStartTs ?? input.createdAt,
      end_ts: null,
      cwd_initial: cwd,
      git_branch_initial: gitBranch,
      model_first: model,
      model_last: model,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: firstRawRecordId,
    })

    // CQ-068: subagent files emit a `spawned` Edge from the parent
    // session row to this subagent session row. GraphResolver picks
    // this up in the same epoch and sets parent_session_id +
    // parent_resolution='edge_derived' on the subagent's session row.
    // Without this edge, the orchestrator leaves parent_session_id
    // null for every subagent — losing the Lane 2 acceptance
    // criterion that "spawned edges from Codex/Claude subagents are
    // preserved as canonical EdgeV2 rows".
    const claudeFile = file as DiscoveredClaudeFile
    const parentSidFromHint = claudeFile.parent_session_id ?? null
    if (isSubagent && parentSidFromHint !== null) {
      const parentRowId = claudeSessionRowId({ sessionId: parentSidFromHint, agentId: null })
      // Deterministic edge id so re-importing the same pair yields
      // the same row (I2 idempotency).
      const edgeKey = `claude:edge:${parentRowId}->${sessionRowId}`
      const edgeId = `edg_${toHex(blake3(new TextEncoder().encode(edgeKey))).slice(0, 32)}`
      draft.edges.push({
        edge_id: edgeId,
        src_type: 'session',
        src_id: parentRowId,
        dst_type: 'session',
        dst_id: sessionRowId,
        edge_type: 'spawned',
        confidence: 'high',
        // Directory layout (`<sid>/subagents/agent-<aid>.jsonl`) is the
        // explicit evidence; the subagent file path is the source of
        // truth for the parent linkage.
        source: 'path_inferred',
        metadata_object_id: null,
        raw_record_id: firstRawRecordId,
      })
    }

    // CQ-074: per-record projection — emit MessageV2 + ContentBlockV2 +
    // ToolCallV2 + ToolResultV2 + EventV2 over the parsed JSONL lines.
    // tool_use ↔ tool_result are linked by `source_call_id` (Claude's
    // `tool_use.id` and `tool_result.tool_use_id`).
    let messageOrdinal = 0
    let eventOrdinal = 0
    let modelFirst: string | null = model
    let modelLast: string | null = model
    const toolCallBySourceId = new Map<string, string>()
    for (const p of parsed) {
      if (p.rec === null) continue
      const rec = p.rec
      const recType = typeof rec.type === 'string' ? rec.type : null
      const ts =
        typeof rec.timestamp === 'string' && isValidCanonicalTimestamp(rec.timestamp)
          ? canonicalTimestamp(rec.timestamp)
          : null
      if (recType === 'user' || recType === 'assistant') {
        const msg: ClaudeMessage = rec.message ?? {}
        const role = inferClaudeRole(rec, recType)
        const sourceMessageId = typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : null
        const messageRowId =
          typeof rec.uuid === 'string' && rec.uuid.length > 0
            ? rowIdFromKey('msg', `claude:msg:${sessionRowId}:${rec.uuid}`)
            : rowIdFromKey('msg', `claude:msg:${sessionRowId}:ord:${p.ordinal}`)
        const parentMessageRowId =
          typeof rec.parentUuid === 'string' && rec.parentUuid.length > 0
            ? rowIdFromKey('msg', `claude:msg:${sessionRowId}:${rec.parentUuid}`)
            : null
        if (recType === 'assistant' && typeof msg.model === 'string' && msg.model.length > 0) {
          if (modelFirst === null) modelFirst = msg.model
          modelLast = msg.model
        }
        draft.messages.push({
          message_id: messageRowId,
          session_id: sessionRowId,
          turn_id: null,
          event_id: null,
          source_message_id: sourceMessageId,
          role,
          author_name: typeof rec.agentName === 'string' ? rec.agentName : null,
          model: recType === 'assistant' && typeof msg.model === 'string' ? msg.model : null,
          timestamp: ts,
          ordinal: messageOrdinal,
          parent_message_id: parentMessageRowId,
          request_id: typeof rec.promptId === 'string' ? rec.promptId : null,
          status: typeof msg.stop_reason === 'string' ? msg.stop_reason : null,
          raw_record_id: p.rawRecordId,
        })
        messageOrdinal += 1

        const content = msg.content
        const blocks: ClaudeContentBlock[] = Array.isArray(content)
          ? (content as ClaudeContentBlock[])
          : typeof content === 'string'
            ? [{ type: 'text', text: content }]
            : []
        for (let bi = 0; bi < blocks.length; bi++) {
          const block = blocks[bi]
          if (!block || typeof block !== 'object') continue
          const blockRowId = rowIdFromKey('blk', `claude:blk:${messageRowId}:${bi}`)
          const blockType = typeof block.type === 'string' ? block.type : 'text'

          if (blockType === 'text') {
            const text = typeof (block as { text?: unknown }).text === 'string' ? (block as { text: string }).text : ''
            const textObjectId =
              text.length > 0 && utf8Encoder.encode(text).length > PREVIEW_MAX
                ? enqueueCasFromText(text, 'text/plain')
                : null
            draft.content_blocks.push({
              block_id: blockRowId,
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: bi,
              block_type: 'text',
              text_object_id: textObjectId,
              text_inline: text.slice(0, PREVIEW_MAX),
              mime_type: 'text/plain',
              token_count: null,
              is_error: false,
              is_redacted: false,
              visibility: 'default',
              raw_record_id: p.rawRecordId,
            })
            continue
          }
          if (blockType === 'thinking') {
            const text =
              typeof (block as { thinking?: unknown }).thinking === 'string'
                ? (block as { thinking: string }).thinking
                : ''
            const textObjectId =
              text.length > 0 && utf8Encoder.encode(text).length > PREVIEW_MAX
                ? enqueueCasFromText(text, 'text/plain')
                : null
            draft.content_blocks.push({
              block_id: blockRowId,
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: bi,
              block_type: 'thinking',
              text_object_id: textObjectId,
              text_inline: text.slice(0, PREVIEW_MAX),
              mime_type: 'text/plain',
              token_count: null,
              is_error: false,
              is_redacted: false,
              visibility: 'hidden_by_default',
              raw_record_id: p.rawRecordId,
            })
            continue
          }
          if (blockType === 'tool_use') {
            const tu = block as { id?: string; name?: string; input?: unknown }
            const sourceCallId = typeof tu.id === 'string' && tu.id.length > 0 ? tu.id : `${messageRowId}:${bi}`
            const toolName = typeof tu.name === 'string' && tu.name.length > 0 ? tu.name : 'unknown'
            const toolCallId = rowIdFromKey('tcl', `claude:tcl:${sessionRowId}:${sourceCallId}`)
            toolCallBySourceId.set(sourceCallId, toolCallId)
            const argsObjectId = tu.input !== undefined && tu.input !== null ? enqueueCasFromJson(tu.input) : null
            draft.content_blocks.push({
              block_id: blockRowId,
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: bi,
              block_type: 'tool_use',
              text_object_id: null,
              text_inline: null,
              mime_type: null,
              token_count: null,
              is_error: false,
              is_redacted: false,
              visibility: 'default',
              raw_record_id: p.rawRecordId,
            })
            draft.tool_calls.push({
              tool_call_id: toolCallId,
              session_id: sessionRowId,
              turn_id: null,
              message_id: messageRowId,
              event_id: null,
              source_call_id: sourceCallId,
              tool_name: toolName,
              canonical_tool_type: canonicalToolType(toolName),
              args_object_id: argsObjectId,
              command: inferCommandFromArgs(toolName, tu.input),
              cwd: null,
              path: inferPathFromArgs(tu.input),
              query: inferQueryFromArgs(tu.input),
              timestamp_start: ts,
              timestamp_end: null,
              status: 'started',
              raw_record_id: p.rawRecordId,
            })
            continue
          }
          if (blockType === 'tool_result') {
            const tr = block as { tool_use_id?: string; content?: unknown; is_error?: boolean }
            const sourceCallId =
              typeof tr.tool_use_id === 'string' && tr.tool_use_id.length > 0 ? tr.tool_use_id : `${messageRowId}:${bi}`
            const text = stringifyOrNull(tr.content)
            const preview = text !== null ? text.slice(0, PREVIEW_MAX) : null
            const matchedToolCallId = toolCallBySourceId.get(sourceCallId) ?? null
            // Full tool-result payload to CAS. Codex collapses output
            // into a single field; Claude only has `content`, so all
            // bytes land under `output_object_id`. stdout/stderr stay
            // null (provider has no split).
            const outputObjectId = text !== null ? enqueueCasFromText(text, 'text/plain') : null
            const textObjectId = text !== null && utf8Encoder.encode(text).length > PREVIEW_MAX ? outputObjectId : null
            draft.content_blocks.push({
              block_id: blockRowId,
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: bi,
              block_type: 'tool_result',
              text_object_id: textObjectId,
              text_inline: preview,
              mime_type: text !== null ? 'text/plain' : null,
              token_count: null,
              is_error: tr.is_error === true,
              is_redacted: false,
              visibility: 'default',
              raw_record_id: p.rawRecordId,
            })
            draft.tool_results.push({
              tool_result_id: rowIdFromKey('tre', `claude:tre:${sessionRowId}:${sourceCallId}`),
              tool_call_id: matchedToolCallId,
              session_id: sessionRowId,
              message_id: messageRowId,
              event_id: null,
              source_call_id: sourceCallId,
              status: tr.is_error === true ? 'error' : matchedToolCallId !== null ? 'success' : null,
              is_error: tr.is_error === true,
              exit_code: null,
              duration_ms: null,
              stdout_object_id: null,
              stderr_object_id: null,
              output_object_id: outputObjectId,
              preview,
              raw_record_id: p.rawRecordId,
            })
            continue
          }
          // Unknown block kind: keep it as a content block with stringified
          // inline preview for raw preservation. Tool calls/results above
          // already covered the canonical kinds; this branch preserves
          // image/forward-compat blocks without crashing the projection.
          draft.content_blocks.push({
            block_id: blockRowId,
            message_id: messageRowId,
            event_id: null,
            session_id: sessionRowId,
            ordinal: bi,
            block_type: blockType,
            text_object_id: null,
            text_inline: stringifyOrNull(block)?.slice(0, PREVIEW_MAX) ?? null,
            mime_type: null,
            token_count: null,
            is_error: false,
            is_redacted: false,
            visibility: 'default',
            raw_record_id: p.rawRecordId,
          })
        }
        continue
      }
      // Operational record → EventV2. `system`, `progress`, `summary`,
      // `api_error`, attachments, and anything else not classified as a
      // message land here.
      if (recType !== null) {
        const eventRowId =
          typeof rec.uuid === 'string' && rec.uuid.length > 0
            ? rowIdFromKey('evt', `claude:evt:${sessionRowId}:${rec.uuid}`)
            : rowIdFromKey('evt', `claude:evt:${sessionRowId}:ord:${p.ordinal}`)
        // Claude operational records have no dedicated payload field;
        // the entire record IS the payload. Stage it to CAS so
        // downstream consumers can audit the bytes verbatim.
        const payloadObjectId = enqueueCasFromJson(rec)
        draft.events.push({
          event_id: eventRowId,
          session_id: sessionRowId,
          turn_id: null,
          source_event_id: typeof rec.uuid === 'string' ? rec.uuid : null,
          event_type: recType === 'system' ? 'system_operational' : recType,
          source_type: recType,
          subtype: typeof rec.subtype === 'string' ? rec.subtype : null,
          timestamp: ts,
          ordinal: eventOrdinal,
          actor: actorFromEventType(recType),
          payload_object_id: payloadObjectId,
          raw_record_id: p.rawRecordId,
          confidence: 'high',
          is_derived: false,
        })
        eventOrdinal += 1
      }
    }

    // Patch session row with accumulated model_first / model_last from the
    // per-record pass (the first-pass scan only sees the first message's
    // model field).
    const sessionRow = draft.sessions[draft.sessions.length - 1]
    if (sessionRow) {
      sessionRow.model_first = modelFirst
      sessionRow.model_last = modelLast
    }

    // Null out parent_message_id when the parent uuid lives outside this
    // JSONL file. Claude's `parentUuid` can point to a message in a
    // forked or compacted parent session, which we do not see here; the
    // FK closure check would otherwise refuse the seal.
    const stagedMessageIds = new Set(draft.messages.map((m) => m.message_id))
    for (const m of draft.messages) {
      if (m.parent_message_id !== null && !stagedMessageIds.has(m.parent_message_id)) {
        m.parent_message_id = null
      }
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
      merge: { merge_strategy: 'single_source' },
    }
    return {
      unit,
      summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length },
    }
  }
}

export { discoverClaudeFiles } from './discover.js'
export type { ClaudeFileHint } from './discover.js'
export type { ClaudeMessage, ClaudeRecord } from './types.js'
