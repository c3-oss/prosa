// Cursor Provider (v2).
//
// Cursor session content lives in a SQLite database at
// `<root>/<workspace>/<agent>/store.db`. The provider reads the database
// read-only via `better-sqlite3`, walks the `meta` table for session
// metadata and the `blobs` table for per-message payloads, and emits:
//
//   - one SourceFileV2 per `store.db`;
//   - one RawRecordV2 per `meta` row (record_kind `session_sqlite_row`,
//     parser_status `parsed`) plus one per `blobs` row (parser_status
//     `parsed` when the blob is JSON-decoded, `binary_only` when it is
//     protobuf state or otherwise opaque);
//   - one SessionV2 (deterministic id from `(workspace, agent)`);
//   - one MessageV2 per JSON blob whose payload has a `role` field
//     (mapped through `mapCursorRole`: `user` / `assistant` / `tool` /
//     `system_prompt` / `operational`);
//   - one ContentBlockV2 per `messages[].content[]` item (text, reasoning
//     → `hidden_by_default` thinking, redacted-reasoning →
//     `audit_only`, tool-call / tool-result tagged blocks, unknown
//     kinds preserved as audit_only with stringified preview);
//   - one ToolCallV2 per `tool-call` content item (canonical_tool_type
//     inferred from `toolName`; `command` / `path` lifted from `args`);
//   - one ToolResultV2 per `tool-result` content item linked back by
//     `source_call_id` with bounded `preview`.
//
// `timeline_confidence` stays `low` because the blob list does not carry
// canonical per-row timestamps; the projection preserves blob order via
// `rowid` so re-imports are deterministic.

import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'

import { type MessageRole, deriveRawRecordId, deriveSourceFileId, toHex } from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'
import Database from 'better-sqlite3'

import { buildSearchDocsFromMessageBlocks } from '../search-doc-builder.js'
import {
  type CheapIdentification,
  type DiscoveredSourceFile,
  type LogicalImportUnit,
  type Provider,
  type ProviderProjectInput,
  type ProviderProjectResult,
  emptyDraft,
} from '../types.js'
import { discoverCursorStores } from './discover.js'

const SOURCE_TOOL = 'cursor' as const
const FILE_KIND = 'session_sqlite'
const PREVIEW_MAX = 4096

interface DiscoveredCursorFile extends DiscoveredSourceFile {
  workspace_id: string
  agent_id: string
}

/** Hex-encoded UTF-8 JSON stored in the `meta` table. */
function hexToUtf8(hex: string): string {
  return Buffer.from(hex, 'hex').toString('utf8')
}

interface CursorMeta {
  agentId?: string
  createdAt?: number | string
  name?: string
  mode?: string
  lastUsedModel?: string
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
  isError?: boolean
}

interface CursorBlobJson {
  role?: string
  id?: string
  content?: string | CursorContentItem[]
  providerOptions?: Record<string, unknown>
}

function mapCursorRole(role: string | undefined): MessageRole {
  switch (role) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'tool':
      return 'tool'
    case 'system':
      // Cursor's chat blob `role=system` is the system prompt itself,
      // not an operational event log.
      return 'system_prompt'
    default:
      return 'operational'
  }
}

function canonicalCursorToolType(toolName: string): string {
  const lower = toolName.toLowerCase()
  if (lower.startsWith('mcp__') || lower.startsWith('mcp_')) return 'mcp'
  if (lower === 'bash' || lower === 'shell' || lower === 'run_terminal_cmd' || lower === 'terminal') return 'shell'
  if (lower === 'read' || lower === 'readfile' || lower === 'read_file') return 'read_file'
  if (lower === 'write' || lower === 'writefile' || lower === 'write_file') return 'write_file'
  if (
    lower === 'edit' ||
    lower === 'str_replace' ||
    lower === 'search_replace' ||
    lower === 'replace' ||
    lower === 'strreplace'
  ) {
    return 'edit_file'
  }
  if (lower === 'grep' || lower === 'glob' || lower === 'glob_file_search' || lower.includes('search')) {
    return 'search_file'
  }
  if (lower.includes('web')) return 'web_search'
  if (lower.includes('agent') || lower.includes('delegate')) return 'subagent'
  return 'other'
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

function inferPathFromArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.file_path === 'string') return obj.file_path
  if (typeof obj.path === 'string') return obj.path
  if (typeof obj.absolute_path === 'string') return obj.absolute_path
  return null
}

function inferCommandFromArgs(args: unknown): string | null {
  if (args === null || typeof args !== 'object') return null
  const obj = args as Record<string, unknown>
  if (typeof obj.command === 'string') return obj.command
  return null
}

function rowIdFromKey(prefix: string, key: string): string {
  return `${prefix}_${toHex(blake3(new TextEncoder().encode(key))).slice(0, 32)}`
}

export class CursorProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredCursorFile[] = []
    for await (const hint of discoverCursorStores(root)) {
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
        file_kind: FILE_KIND,
        bytes,
        workspace_id: hint.workspaceId,
        agent_id: hint.agentId,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // CQ-070: the (workspace, agent) pair is the canonical logical
    // identifier for a Cursor session. Use exactly the same string for
    // the Reserve key AND the SessionV2 derivation in parseAndProject.
    const enriched = file as DiscoveredCursorFile
    const ws = enriched.workspace_id ?? 'unknown-ws'
    const agent = enriched.agent_id ?? 'unknown-agent'
    return {
      logicalKey: new TextEncoder().encode(`cursor:${ws}:${agent}`),
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('cursor parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const enriched = file as DiscoveredCursorFile

    // Logical session id from (workspace, agent). Deterministic across
    // re-imports of the same Cursor store.
    const logicalKey = `cursor:${enriched.workspace_id ?? 'unknown-ws'}:${enriched.agent_id ?? 'unknown-agent'}`
    const sessionRowId = rowIdFromKey('ses', logicalKey)

    const rawRecordIds: string[] = []
    let metaRawId: string | null = null
    let meta: CursorMeta = {}
    let modelFirst: string | null = null
    let modelLast: string | null = null

    // Open SQLite read-only against the on-disk path. The bytes-only
    // fallback would require a temp file; using the existing path
    // matches how discover() found it. If the file does not parse as a
    // SQLite database, fall back to a single `binary_only` raw_record
    // and a minimal session row so the bytes remain preserved (I1).
    let cdb: Database.Database | null = null
    try {
      try {
        cdb = new Database(`file:${file.path}?mode=ro&immutable=1`, { fileMustExist: true })
      } catch {
        cdb = new Database(file.path, { readonly: true, fileMustExist: true })
      }
    } catch {
      cdb = null
    }
    try {
      if (cdb !== null) {
        // ---- meta: hex-encoded JSON in `value` ----
        let metaRow: { value: string } | undefined
        try {
          metaRow = cdb.prepare(`SELECT value FROM meta WHERE key='0'`).get() as { value: string } | undefined
        } catch {
          metaRow = undefined
        }
        if (metaRow && typeof metaRow.value === 'string') {
          const metaText = hexToUtf8(metaRow.value)
          try {
            meta = JSON.parse(metaText) as CursorMeta
          } catch {
            meta = {}
          }
          metaRawId = deriveRawRecordId({
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            ordinal: 0,
            record_kind: 'session_sqlite_row',
          })
          rawRecordIds.push(metaRawId)
          draft.raw_records.push({
            raw_record_id: metaRawId,
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            record_kind: 'session_sqlite_row',
            ordinal: 0,
            logical_offset: 0,
            logical_length: metaText.length,
            line_no: null,
            json_pointer: 'meta/0',
            parser_status: 'parsed',
            confidence: 'high',
            content_hash: contentHash,
            object_id: contentHash,
            decoded_object_id: null,
            created_at: input.createdAt,
          })
          if (typeof meta.lastUsedModel === 'string') {
            modelFirst = meta.lastUsedModel
            modelLast = meta.lastUsedModel
          }
        }

        // ---- blobs: one raw_record per row, projected when JSON ----
        let blobs: { id: string; data: Buffer }[] = []
        try {
          blobs = cdb.prepare('SELECT id, data FROM blobs ORDER BY rowid').all() as { id: string; data: Buffer }[]
        } catch {
          blobs = []
        }

        let messageOrdinal = 0
        for (let i = 0; i < blobs.length; i++) {
          const blob = blobs[i]
          if (!blob) continue
          const ordinal = i + 1
          // Try JSON parse only when the leading byte looks like JSON.
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
          const blobRawId = deriveRawRecordId({
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            ordinal,
            record_kind: 'session_sqlite_row',
          })
          rawRecordIds.push(blobRawId)
          draft.raw_records.push({
            raw_record_id: blobRawId,
            source_tool: SOURCE_TOOL,
            source_file_id: file.source_file_id,
            record_kind: 'session_sqlite_row',
            ordinal,
            logical_offset: 0,
            logical_length: blob.data.length,
            line_no: null,
            json_pointer: `blobs/${blob.id}`,
            parser_status: parsed !== null ? 'parsed' : 'binary_only',
            // Blob order in the rowid sequence is not canonical chat order.
            confidence: parsed !== null ? 'medium' : 'low',
            content_hash: contentHash,
            object_id: contentHash,
            decoded_object_id: null,
            created_at: input.createdAt,
          })
          if (!parsed || typeof parsed.role !== 'string') continue

          // Projected chat message.
          const role = mapCursorRole(parsed.role)
          const sourceMessageId = typeof parsed.id === 'string' && parsed.id.length > 0 ? parsed.id : blob.id
          const messageRowId = rowIdFromKey('msg', `cursor:msg:${sessionRowId}:${sourceMessageId}`)
          const assistantModel = role === 'assistant' ? (meta.lastUsedModel ?? null) : null
          if (assistantModel !== null) {
            if (modelFirst === null) modelFirst = assistantModel
            modelLast = assistantModel
          }
          draft.messages.push({
            message_id: messageRowId,
            session_id: sessionRowId,
            turn_id: null,
            event_id: null,
            source_message_id: sourceMessageId,
            role,
            author_name: null,
            model: assistantModel,
            timestamp: null,
            ordinal: messageOrdinal,
            parent_message_id: null,
            request_id: null,
            status: null,
            raw_record_id: blobRawId,
          })
          messageOrdinal += 1

          const content = parsed.content
          if (typeof content === 'string' && content.length > 0) {
            draft.content_blocks.push({
              block_id: rowIdFromKey('blk', `cursor:blk:${messageRowId}:0`),
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: 0,
              block_type: 'text',
              text_object_id: null,
              text_inline: content.slice(0, PREVIEW_MAX),
              mime_type: 'text/plain',
              token_count: null,
              is_error: false,
              is_redacted: false,
              visibility: 'default',
              raw_record_id: blobRawId,
            })
          } else if (Array.isArray(content)) {
            for (let bi = 0; bi < content.length; bi++) {
              const item = content[bi]
              if (!item) continue
              projectCursorContentItem({
                draft,
                sessionRowId,
                messageRowId,
                ordinal: bi,
                item,
                rawRecordId: blobRawId,
              })
            }
          }
        }
      } // end if (cdb !== null)
    } finally {
      cdb?.close()
    }

    // If the database was not a valid Cursor store (open failed, or no
    // `meta`/`blobs` tables present), preserve the bytes opaquely with
    // a single `binary_only` raw_record so invariant I1 holds.
    if (rawRecordIds.length === 0) {
      const fallbackRawId = deriveRawRecordId({
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        ordinal: 0,
        record_kind: 'session_sqlite_row',
      })
      rawRecordIds.push(fallbackRawId)
      draft.raw_records.push({
        raw_record_id: fallbackRawId,
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        record_kind: 'session_sqlite_row',
        ordinal: 0,
        logical_offset: 0,
        logical_length: bytes.length,
        line_no: null,
        json_pointer: null,
        parser_status: 'binary_only',
        confidence: 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
    }

    // Source file row.
    draft.source_files.push({
      source_file_id: file.source_file_id,
      source_tool: SOURCE_TOOL,
      path: file.path,
      file_kind: FILE_KIND,
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

    const startTs =
      typeof meta.createdAt === 'number'
        ? new Date(meta.createdAt).toISOString()
        : typeof meta.createdAt === 'string'
          ? meta.createdAt
          : input.createdAt
    draft.sessions.push({
      session_id: sessionRowId,
      source_tool: SOURCE_TOOL,
      source_session_id: logicalKey,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: typeof meta.mode === 'string' ? meta.mode : null,
      agent_nickname: typeof meta.name === 'string' ? meta.name : null,
      title: typeof meta.name === 'string' ? meta.name : null,
      summary: null,
      start_ts: startTs,
      end_ts: null,
      cwd_initial: null,
      git_branch_initial: null,
      model_first: modelFirst,
      model_last: modelLast,
      status: null,
      // The blob list does not carry per-row timestamps; ordering is
      // taken from `rowid` (insertion order). Mark accordingly.
      timeline_confidence: 'low',
      raw_record_id: metaRawId ?? rawRecordIds[0] ?? null,
    })

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
      cas_object_candidates: [],
      merge: { merge_strategy: 'single_source' },
    }
    return {
      unit,
      summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length },
    }
  }
}

interface ProjectContentItemInput {
  draft: ReturnType<typeof emptyDraft>
  sessionRowId: string
  messageRowId: string
  ordinal: number
  item: CursorContentItem
  rawRecordId: string
}

function projectCursorContentItem(args: ProjectContentItemInput): void {
  const { draft, sessionRowId, messageRowId, ordinal, item, rawRecordId } = args
  const blockRowId = rowIdFromKey('blk', `cursor:blk:${messageRowId}:${ordinal}`)
  const t = item.type
  if (t === 'text') {
    const text = typeof item.text === 'string' ? item.text : ''
    draft.content_blocks.push({
      block_id: blockRowId,
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal,
      block_type: 'text',
      text_object_id: null,
      text_inline: text.slice(0, PREVIEW_MAX),
      mime_type: 'text/plain',
      token_count: null,
      is_error: false,
      is_redacted: false,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })
    return
  }
  if (t === 'reasoning') {
    const text = typeof item.text === 'string' ? item.text : ''
    draft.content_blocks.push({
      block_id: blockRowId,
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal,
      block_type: 'thinking',
      text_object_id: null,
      text_inline: text.slice(0, PREVIEW_MAX),
      mime_type: 'text/plain',
      token_count: null,
      is_error: false,
      is_redacted: false,
      visibility: 'hidden_by_default',
      raw_record_id: rawRecordId,
    })
    return
  }
  if (t === 'redacted-reasoning') {
    draft.content_blocks.push({
      block_id: blockRowId,
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal,
      block_type: 'thinking',
      text_object_id: null,
      text_inline: '[redacted]',
      mime_type: null,
      token_count: null,
      is_error: false,
      is_redacted: true,
      visibility: 'audit_only',
      raw_record_id: rawRecordId,
    })
    return
  }
  if (t === 'tool-call') {
    const sourceCallId =
      typeof item.toolCallId === 'string' && item.toolCallId.length > 0 ? item.toolCallId : `${messageRowId}:${ordinal}`
    const toolName = typeof item.toolName === 'string' && item.toolName.length > 0 ? item.toolName : 'unknown'
    const toolCallRowId = rowIdFromKey('tcl', `cursor:tcl:${sessionRowId}:${sourceCallId}`)
    draft.content_blocks.push({
      block_id: blockRowId,
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal,
      block_type: 'tool_use',
      text_object_id: null,
      text_inline: null,
      mime_type: null,
      token_count: null,
      is_error: false,
      is_redacted: false,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })
    draft.tool_calls.push({
      tool_call_id: toolCallRowId,
      session_id: sessionRowId,
      turn_id: null,
      message_id: messageRowId,
      event_id: null,
      source_call_id: sourceCallId,
      tool_name: toolName,
      canonical_tool_type: canonicalCursorToolType(toolName),
      args_object_id: null,
      command: inferCommandFromArgs(item.args),
      cwd: null,
      path: inferPathFromArgs(item.args),
      query: null,
      timestamp_start: null,
      timestamp_end: null,
      status: 'started',
      raw_record_id: rawRecordId,
    })
    return
  }
  if (t === 'tool-result') {
    const sourceCallId =
      typeof item.toolCallId === 'string' && item.toolCallId.length > 0 ? item.toolCallId : `${messageRowId}:${ordinal}`
    const text = stringifyOrNull(item.result)
    const preview = text !== null ? text.slice(0, PREVIEW_MAX) : null
    const isError = item.isError === true
    const toolCallRowId = rowIdFromKey('tcl', `cursor:tcl:${sessionRowId}:${sourceCallId}`)
    const matched = draft.tool_calls.find((c) => c.tool_call_id === toolCallRowId) ?? null
    draft.content_blocks.push({
      block_id: blockRowId,
      message_id: messageRowId,
      event_id: null,
      session_id: sessionRowId,
      ordinal,
      block_type: 'tool_result',
      text_object_id: null,
      text_inline: preview,
      mime_type: text !== null ? 'text/plain' : null,
      token_count: null,
      is_error: isError,
      is_redacted: false,
      visibility: 'default',
      raw_record_id: rawRecordId,
    })
    draft.tool_results.push({
      tool_result_id: rowIdFromKey('tre', `cursor:tre:${sessionRowId}:${sourceCallId}`),
      tool_call_id: matched !== null ? matched.tool_call_id : null,
      session_id: sessionRowId,
      message_id: messageRowId,
      event_id: null,
      source_call_id: sourceCallId,
      status: isError ? 'error' : matched !== null ? 'success' : null,
      is_error: isError,
      exit_code: null,
      duration_ms: null,
      stdout_object_id: null,
      stderr_object_id: null,
      output_object_id: null,
      preview,
      raw_record_id: rawRecordId,
    })
    if (matched !== null) matched.status = isError ? 'error' : 'success'
    return
  }
  // Unknown content type — keep as audit_only block.
  draft.content_blocks.push({
    block_id: blockRowId,
    message_id: messageRowId,
    event_id: null,
    session_id: sessionRowId,
    ordinal,
    block_type: typeof t === 'string' && t.length > 0 ? t : 'unknown',
    text_object_id: null,
    text_inline: stringifyOrNull(item)?.slice(0, PREVIEW_MAX) ?? null,
    mime_type: null,
    token_count: null,
    is_error: false,
    is_redacted: false,
    visibility: 'audit_only',
    raw_record_id: rawRecordId,
  })
}

export { discoverCursorStores } from './discover.js'
export type { CursorStoreHint } from './discover.js'
