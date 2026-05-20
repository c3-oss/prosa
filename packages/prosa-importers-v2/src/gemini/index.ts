// Gemini CLI Provider (v2).
//
// Each session is a single JSON file with a `messages: []` array. The
// provider discovers `<root>/<project-dir>/chats/session-*.json`,
// cheap-identifies by `sessionId`, and emits:
//
//   - one SessionV2 + one SourceFileV2 + one RawRecordV2 per `messages[]`
//     entry (with `json_pointer: /messages/<i>`);
//   - one MessageV2 per `type: 'user'` / `type: 'gemini'` entry, with one
//     ContentBlockV2 per content[] item (or a single text block when
//     `content` is a bare string); `thoughts[]` map to extra
//     `thinking` blocks at `visibility: 'hidden_by_default'`;
//   - one ToolCallV2 per `toolCalls[]` entry (canonical_tool_type mapped
//     from Gemini-specific tool names like `run_shell_command` /
//     `read_file` / `replace`; `command`/`cwd`/`path`/`query` inferred
//     from `args`);
//   - one ToolResultV2 per `toolCalls[]` entry linked back by
//     `source_call_id` (the tool call's `id`), with bounded `preview`
//     rendered from the call's `result[]`;
//   - one EventV2 per `info` / `error` / unknown record.
//
// Multi-snapshot merging across files of the same `sessionId` is still
// deferred to the Reserve flow at the orchestrator level. File-diff
// artifact synthesis from `resultDisplay` is deferred to a follow-up.

import { readFile } from 'node:fs/promises'
import { normalize } from 'node:path'

import {
  type Actor,
  type MessageRole,
  canonicalTimestamp,
  deriveRawRecordId,
  deriveSourceFileId,
  isValidCanonicalTimestamp,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

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
import { discoverGeminiChats } from './discover.js'
import type { GeminiContentItem, GeminiMessage, GeminiSessionFile, GeminiToolCall, GeminiToolResult } from './types.js'

const SOURCE_TOOL = 'gemini' as const
const FILE_KIND = 'session_json'
const PREVIEW_MAX = 4096

function canonicalToolType(toolName: string): string {
  switch (toolName) {
    case 'run_shell_command':
    case 'shell':
    case 'shell_command':
      return 'shell'
    case 'read_file':
    case 'read_many_files':
      return 'read_file'
    case 'write_file':
      return 'write_file'
    case 'replace':
    case 'search_replace':
      return 'edit_file'
    case 'list_directory':
    case 'glob':
    case 'grep_search':
    case 'search_file_content':
      return 'search_file'
    case 'google_web_search':
      return 'web_search'
    case 'codebase_investigator':
      return 'other'
    default:
      return toolName.startsWith('mcp__') ? 'mcp' : 'other'
  }
}

function renderToolResultText(result: GeminiToolResult[] | undefined): string {
  if (!Array.isArray(result)) return ''
  const parts: string[] = []
  for (const r of result) {
    if (typeof r.text === 'string' && r.text.length > 0) {
      parts.push(r.text)
      continue
    }
    const fr = r.functionResponse?.response
    if (fr) {
      if (fr.error !== null && fr.error !== undefined) {
        parts.push(typeof fr.error === 'string' ? fr.error : JSON.stringify(fr.error))
      } else if (fr.output !== null && fr.output !== undefined) {
        parts.push(typeof fr.output === 'string' ? fr.output : JSON.stringify(fr.output))
      }
    }
  }
  return parts.join('\n')
}

function actorFromGeminiKind(kind: string): Actor {
  if (kind === 'user') return 'user'
  if (kind === 'gemini') return 'assistant'
  if (kind === 'error' || kind === 'info') return 'system'
  return 'system'
}

function roleFromGeminiKind(kind: string): MessageRole | null {
  if (kind === 'user') return 'user'
  if (kind === 'gemini') return 'assistant'
  return null
}

function rowIdFromKey(prefix: string, key: string): string {
  return `${prefix}_${toHex(blake3(new TextEncoder().encode(key))).slice(0, 32)}`
}

interface DiscoveredGeminiFile extends DiscoveredSourceFile {
  project_dir: string
  project_root: string | null
}

export class GeminiProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredGeminiFile[] = []
    for await (const hint of discoverGeminiChats(root)) {
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
        project_dir: hint.projectDir,
        project_root: hint.projectRoot,
      })
    }
    return out as DiscoveredSourceFile[]
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    const bytes = file.bytes ?? (await readFile(file.path))
    let sessionId: string | null = null
    try {
      const parsed = JSON.parse(new TextDecoder().decode(bytes)) as GeminiSessionFile
      if (typeof parsed.sessionId === 'string' && parsed.sessionId.length > 0) {
        sessionId = parsed.sessionId
      }
    } catch {
      // Corrupt file; fall back to source_file_id below.
    }
    const logicalKey =
      sessionId !== null
        ? new TextEncoder().encode(`gemini:${sessionId}`)
        : new TextEncoder().encode(`gemini:src:${file.source_file_id}`)
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) throw new Error('gemini parseAndProject: no input file')
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    let parsed: GeminiSessionFile | null = null
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes)) as GeminiSessionFile
    } catch {
      parsed = null
    }
    const messages = parsed?.messages ?? []
    const rawRecordIds: string[] = []
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i]
      const rawRecordId = deriveRawRecordId({
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        ordinal: i,
        record_kind: 'session_jsonl_line',
      })
      rawRecordIds.push(rawRecordId)
      draft.raw_records.push({
        raw_record_id: rawRecordId,
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        // Gemini messages live inside a single JSON document; the
        // canonical record_kind is the closest existing enum value.
        record_kind: 'session_jsonl_line',
        ordinal: i,
        logical_offset: 0,
        logical_length: 0,
        line_no: null,
        json_pointer: `/messages/${i}`,
        parser_status: msg ? 'parsed' : 'unparseable',
        confidence: msg ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
    }
    // If the file failed to parse, still emit one raw_record covering
    // the whole JSON document so the bytes are preserved.
    if (rawRecordIds.length === 0) {
      const rawRecordId = deriveRawRecordId({
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        ordinal: 0,
        record_kind: 'session_jsonl_line',
      })
      rawRecordIds.push(rawRecordId)
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
        parser_status: parsed ? 'parsed' : 'unparseable',
        confidence: parsed ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
    }

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

    const enriched = file as DiscoveredGeminiFile
    const sessionLogicalId =
      typeof parsed?.sessionId === 'string' && parsed.sessionId.length > 0
        ? parsed.sessionId
        : input.identification.unit_id
    const sessionRowId = `ses_${toHex(blake3(new TextEncoder().encode(`gemini:${sessionLogicalId}`))).slice(0, 32)}`
    const startTs =
      typeof parsed?.startTime === 'string' && isValidCanonicalTimestamp(parsed.startTime)
        ? canonicalTimestamp(parsed.startTime)
        : input.createdAt
    const endTs =
      typeof parsed?.lastUpdated === 'string' && isValidCanonicalTimestamp(parsed.lastUpdated)
        ? canonicalTimestamp(parsed.lastUpdated)
        : null
    // The model field appears on individual messages; take the first
    // assistant message's model as model_first/last for a minimal
    // session row.
    let modelFirst: string | null = null
    let modelLast: string | null = null
    for (const m of messages) {
      if (typeof m?.model === 'string' && m.model.length > 0) {
        if (modelFirst === null) modelFirst = m.model
        modelLast = m.model
      }
    }
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
      summary: typeof parsed?.summary === 'string' ? parsed.summary : null,
      start_ts: startTs,
      end_ts: endTs,
      cwd_initial: enriched.project_root,
      git_branch_initial: null,
      model_first: modelFirst,
      model_last: modelLast,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: rawRecordIds[0] ?? null,
    })

    // CQ-074: per-message projection — emit MessageV2 + ContentBlockV2 +
    // ToolCallV2 + ToolResultV2 + EventV2 across `messages[]`.
    let messageOrdinal = 0
    let eventOrdinal = 0
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i] as GeminiMessage | undefined
      if (!msg) continue
      const rawRecordId = rawRecordIds[i] ?? rawRecordIds[0]!
      const kind = typeof msg.type === 'string' ? msg.type : 'unknown'
      const ts =
        typeof msg.timestamp === 'string' && isValidCanonicalTimestamp(msg.timestamp)
          ? canonicalTimestamp(msg.timestamp)
          : null
      const role = roleFromGeminiKind(kind)
      if (role !== null) {
        const sourceMessageId = typeof msg.id === 'string' && msg.id.length > 0 ? msg.id : null
        const messageRowId =
          sourceMessageId !== null
            ? rowIdFromKey('msg', `gemini:msg:${sessionRowId}:${sourceMessageId}`)
            : rowIdFromKey('msg', `gemini:msg:${sessionRowId}:ord:${i}`)
        draft.messages.push({
          message_id: messageRowId,
          session_id: sessionRowId,
          turn_id: null,
          event_id: null,
          source_message_id: sourceMessageId,
          role,
          author_name: null,
          model: role === 'assistant' && typeof msg.model === 'string' ? msg.model : null,
          timestamp: ts,
          ordinal: messageOrdinal,
          parent_message_id: null,
          request_id: null,
          status: null,
          raw_record_id: rawRecordId,
        })
        messageOrdinal += 1

        // Content blocks: string content → one text block; array content
        // → one block per item; thoughts → trailing thinking blocks.
        let blockOrdinal = 0
        const content = msg.content
        if (typeof content === 'string' && content.length > 0) {
          draft.content_blocks.push({
            block_id: rowIdFromKey('blk', `gemini:blk:${messageRowId}:${blockOrdinal}`),
            message_id: messageRowId,
            event_id: null,
            session_id: sessionRowId,
            ordinal: blockOrdinal,
            block_type: 'text',
            text_object_id: null,
            text_inline: content.slice(0, PREVIEW_MAX),
            mime_type: 'text/plain',
            token_count: null,
            is_error: false,
            is_redacted: false,
            visibility: 'default',
            raw_record_id: rawRecordId,
          })
          blockOrdinal += 1
        } else if (Array.isArray(content)) {
          for (let ci = 0; ci < content.length; ci++) {
            const item = content[ci] as GeminiContentItem | undefined
            if (!item) continue
            const blockType = typeof item.type === 'string' && item.type.length > 0 ? item.type : 'text'
            const text = typeof item.text === 'string' ? item.text : ''
            if (text.length === 0) continue
            draft.content_blocks.push({
              block_id: rowIdFromKey('blk', `gemini:blk:${messageRowId}:${blockOrdinal}`),
              message_id: messageRowId,
              event_id: null,
              session_id: sessionRowId,
              ordinal: blockOrdinal,
              block_type: blockType,
              text_object_id: null,
              text_inline: text.slice(0, PREVIEW_MAX),
              mime_type: 'text/plain',
              token_count: null,
              is_error: false,
              is_redacted: false,
              visibility: 'default',
              raw_record_id: rawRecordId,
            })
            blockOrdinal += 1
          }
        }
        const thoughts = Array.isArray(msg.thoughts) ? msg.thoughts : []
        for (let ti = 0; ti < thoughts.length; ti++) {
          const th = thoughts[ti]
          if (!th) continue
          const text = [th.subject, th.description].filter((s): s is string => typeof s === 'string').join('\n\n')
          if (text.length === 0) continue
          draft.content_blocks.push({
            block_id: rowIdFromKey('blk', `gemini:blk:${messageRowId}:thought:${ti}`),
            message_id: messageRowId,
            event_id: null,
            session_id: sessionRowId,
            ordinal: blockOrdinal,
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
          blockOrdinal += 1
        }

        // Tool calls live on the message itself (not on a separate
        // tool_result content block as Claude has).
        const toolCalls = Array.isArray(msg.toolCalls) ? msg.toolCalls : []
        for (let ti = 0; ti < toolCalls.length; ti++) {
          const tc = toolCalls[ti] as GeminiToolCall | undefined
          if (!tc) continue
          const sourceCallId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `${messageRowId}:tc:${ti}`
          const toolName = typeof tc.name === 'string' && tc.name.length > 0 ? tc.name : 'unknown'
          const toolCallRowId = rowIdFromKey('tcl', `gemini:tcl:${sessionRowId}:${sourceCallId}`)
          const argsObj = tc.args ?? null
          const command = typeof argsObj?.command === 'string' ? (argsObj.command as string) : null
          const cwd = typeof argsObj?.dir_path === 'string' ? (argsObj.dir_path as string) : null
          const path =
            typeof argsObj?.file_path === 'string'
              ? (argsObj.file_path as string)
              : typeof argsObj?.path === 'string'
                ? (argsObj.path as string)
                : null
          const query = typeof argsObj?.query === 'string' ? (argsObj.query as string) : null
          const tcStatus = typeof tc.status === 'string' ? tc.status : null
          draft.tool_calls.push({
            tool_call_id: toolCallRowId,
            session_id: sessionRowId,
            turn_id: null,
            message_id: messageRowId,
            event_id: null,
            source_call_id: sourceCallId,
            tool_name: toolName,
            canonical_tool_type: canonicalToolType(toolName),
            args_object_id: null,
            command,
            cwd,
            path,
            query,
            timestamp_start: typeof tc.timestamp === 'string' ? tc.timestamp : ts,
            timestamp_end: null,
            status: tcStatus,
            raw_record_id: rawRecordId,
          })

          const resultText = renderToolResultText(tc.result)
          const preview = resultText.length > 0 ? resultText.slice(0, PREVIEW_MAX) : null
          draft.tool_results.push({
            tool_result_id: rowIdFromKey('tre', `gemini:tre:${sessionRowId}:${sourceCallId}`),
            tool_call_id: toolCallRowId,
            session_id: sessionRowId,
            message_id: messageRowId,
            event_id: null,
            source_call_id: sourceCallId,
            status: tcStatus,
            is_error: tcStatus === 'error',
            exit_code: null,
            duration_ms: null,
            stdout_object_id: null,
            stderr_object_id: null,
            output_object_id: null,
            preview,
            raw_record_id: rawRecordId,
          })
        }
        continue
      }
      // Operational record → EventV2 (info / error / unknown kinds).
      const eventRowId =
        typeof msg.id === 'string' && msg.id.length > 0
          ? rowIdFromKey('evt', `gemini:evt:${sessionRowId}:${msg.id}`)
          : rowIdFromKey('evt', `gemini:evt:${sessionRowId}:ord:${i}`)
      draft.events.push({
        event_id: eventRowId,
        session_id: sessionRowId,
        turn_id: null,
        source_event_id: typeof msg.id === 'string' ? msg.id : null,
        event_type: kind === 'error' ? 'error' : 'system_operational',
        source_type: kind,
        subtype: null,
        timestamp: ts,
        ordinal: eventOrdinal,
        actor: actorFromGeminiKind(kind),
        payload_object_id: null,
        raw_record_id: rawRecordId,
        confidence: 'high',
        is_derived: false,
      })
      eventOrdinal += 1
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
      merge: { merge_strategy: 'gemini_session_versions' },
    }
    return { unit, summary: { files: 1, sessions: 1, rawRecords: rawRecordIds.length } }
  }
}

export { discoverGeminiChats } from './discover.js'
export type { GeminiChatHint } from './discover.js'
export type { GeminiMessage, GeminiSessionFile } from './types.js'
