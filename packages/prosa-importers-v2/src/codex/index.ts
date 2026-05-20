// Codex Provider (v2).
//
// First iteration covers the load-bearing path: discover JSONL files,
// cheap-identify by the first `session_meta` envelope's id, and
// project a minimal `LogicalImportUnit` containing one `SessionV2`,
// one `RawRecordV2` per JSONL line, and one `SourceFileV2`. Full
// turn/message/tool-call/event projection is left to follow-up
// iterations (the v1 importer is 1,696 lines for a reason). The
// orchestrator's CQ-047 backfill stamps the source_file's pack
// metadata at seal time.

import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'

import {
  canonicalTimestamp,
  deriveRawRecordId,
  deriveSourceFileId,
  isValidCanonicalTimestamp,
  toHex,
} from '@c3-oss/prosa-types-v2'
import { blake3 } from '@noble/hashes/blake3'

import {
  type CheapIdentification,
  type DiscoveredSourceFile,
  type LogicalImportUnit,
  type Provider,
  type ProviderProjectInput,
  type ProviderProjectResult,
  emptyDraft,
} from '../types.js'
import { discoverCodexSessionFiles } from './discover.js'
import type {
  CodexContentItem,
  CodexEnvelope,
  CodexEventMsgPayload,
  CodexResponseItemPayload,
  CodexSessionMetaPayload,
  CodexTurnContextPayload,
} from './types.js'

import type { Actor, MessageRole } from '@c3-oss/prosa-types-v2'

function mapCodexRole(raw: string): MessageRole {
  switch (raw) {
    case 'user':
      return 'user'
    case 'assistant':
      return 'assistant'
    case 'system':
      return 'system_prompt'
    case 'developer':
      return 'developer'
    case 'tool':
      return 'tool'
    default:
      return 'operational'
  }
}

function mapCodexActor(raw: string | null): Actor | null {
  if (raw === null) return null
  switch (raw) {
    case 'user':
    case 'assistant':
    case 'tool':
    case 'system':
    case 'cli':
      return raw
    default:
      return 'cli'
  }
}

function deriveCodexTurnRowId(sessionRowId: string, sourceTurnId: string, fallbackOrdinal: number): string {
  const material =
    sourceTurnId.length > 0
      ? `codex:turn:${sessionRowId}:${sourceTurnId}`
      : `codex:turn:${sessionRowId}:ord:${fallbackOrdinal}`
  return `tur_${toHex(blake3(new TextEncoder().encode(material))).slice(0, 32)}`
}

const SOURCE_TOOL = 'codex' as const
const FILE_KIND = 'session_jsonl'

export class CodexProvider implements Provider {
  readonly source_tool = SOURCE_TOOL

  async discover(root: string): Promise<DiscoveredSourceFile[]> {
    const out: DiscoveredSourceFile[] = []
    for await (const path of discoverCodexSessionFiles(root)) {
      const bytes = await readFile(path)
      const contentHash = `blake3:${toHex(blake3(bytes))}`
      const sourceFileId = deriveSourceFileId({
        source_tool: SOURCE_TOOL,
        path: normalize(path),
        content_hash: contentHash,
      })
      out.push({
        source_file_id: sourceFileId,
        path,
        source_tool: SOURCE_TOOL,
        file_kind: FILE_KIND,
        bytes,
      })
    }
    return out
  }

  async cheapIdentify(file: DiscoveredSourceFile): Promise<CheapIdentification> {
    // Walk just enough of the file to find the first session_meta
    // envelope. The id field there is the canonical logical session
    // identifier (cross-file dedupe key when the same session is
    // discovered through more than one path, e.g. tarball + flat dir).
    const bytes = file.bytes ?? (await readFile(file.path))
    const text = new TextDecoder().decode(bytes)
    let logicalKey: Uint8Array | null = null
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let env: CodexEnvelope
      try {
        env = JSON.parse(trimmed) as CodexEnvelope
      } catch {
        continue
      }
      if (env.type === 'session_meta') {
        const id = (env.payload as CodexSessionMetaPayload | undefined)?.id
        if (typeof id === 'string' && id.length > 0) {
          logicalKey = new TextEncoder().encode(`codex:${id}`)
          break
        }
      }
    }
    if (!logicalKey) {
      // Fall back to the source_file_id when no session_meta exists
      // (rare; some legacy rollouts open with a turn_context). The
      // logical key still dedupes correctly because two files with
      // identical bytes derive the same source_file_id.
      logicalKey = new TextEncoder().encode(`codex:src:${file.source_file_id}`)
    }
    return {
      logicalKey,
      unit_id: `unit_${file.source_file_id}`,
      logical_kind: 'session',
    }
  }

  async parseAndProject(input: ProviderProjectInput): Promise<ProviderProjectResult> {
    const file = input.files[0]
    if (!file) {
      throw new Error('codex parseAndProject: no input file')
    }
    const bytes = file.bytes ?? (await readFile(file.path))
    const contentHash = `blake3:${toHex(blake3(bytes))}`
    const draft = emptyDraft()
    const text = new TextDecoder().decode(bytes)
    const lines = text.split('\n')

    // ── First pass: parse every line into a CodexEnvelope (or null),
    //    emit one raw_record per line, find sessionMetaId, capture
    //    session_meta payload for later use.
    const envelopes: Array<{
      env: CodexEnvelope | null
      rawRecordId: string
      lineNo: number
    }> = []
    const rawRecordIds: string[] = []
    let sessionMetaId: string | null = null
    let sessionMetaPayload: CodexSessionMetaPayload | null = null
    let sessionMetaTimestamp: string | null = null
    let ordinal = 0
    let logicalOffset = 0
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string
      if (!line) {
        logicalOffset += 1
        continue
      }
      const lineByteLength = new TextEncoder().encode(line).length
      let env: CodexEnvelope | null = null
      try {
        env = JSON.parse(line) as CodexEnvelope
      } catch {
        env = null
      }
      if (env?.type === 'session_meta' && sessionMetaId === null) {
        const meta = (env.payload as CodexSessionMetaPayload | undefined) ?? {}
        if (typeof meta.id === 'string') sessionMetaId = meta.id
        sessionMetaPayload = meta
        if (typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)) {
          sessionMetaTimestamp = canonicalTimestamp(env.timestamp)
        } else if (typeof meta.timestamp === 'string' && isValidCanonicalTimestamp(meta.timestamp)) {
          sessionMetaTimestamp = canonicalTimestamp(meta.timestamp)
        }
      }
      const rawRecordId = deriveRawRecordId({
        source_tool: SOURCE_TOOL,
        source_file_id: file.source_file_id,
        ordinal,
        record_kind: 'session_jsonl_line',
      })
      rawRecordIds.push(rawRecordId)
      envelopes.push({ env, rawRecordId, lineNo: i + 1 })
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
        parser_status: env ? 'parsed' : 'unparseable',
        confidence: env ? 'high' : 'low',
        content_hash: contentHash,
        object_id: contentHash,
        decoded_object_id: null,
        created_at: input.createdAt,
      })
      ordinal += 1
      logicalOffset += lineByteLength + 1
    }

    // One source_file row. Orchestrator backfills pack metadata pre-seal.
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

    // ── Resolve the session's canonical row id.
    const sessionLogicalId = sessionMetaId ?? input.identification.unit_id
    const sessionId = `ses_${toHex(blake3(new TextEncoder().encode(`codex:${sessionLogicalId}`))).slice(0, 32)}`
    const firstRawRecordId = rawRecordIds[0] ?? null

    // ── Second pass: per-record projection. Walks envelopes in line
    //    order and emits TurnV2 / MessageV2 / ContentBlockV2 /
    //    ToolCallV2 / ToolResultV2 / EventV2 rows. Each emitted row
    //    carries the raw_record_id of the line it came from for
    //    canonical raw-byte traceback.
    let currentTurnRowId: string | null = null
    let turnOrdinal = 0
    let messageOrdinal = 0
    let blockOrdinal = 0
    let eventOrdinal = 0
    let modelFirst: string | null = null
    let modelLast: string | null = null
    let cwdInitial: string | null = sessionMetaPayload?.cwd ?? null
    const gitBranchInitial: string | null = sessionMetaPayload?.git?.branch ?? null
    let lastTimestamp: string | null = sessionMetaTimestamp
    for (let envIdx = 0; envIdx < envelopes.length; envIdx++) {
      const entry = envelopes[envIdx]!
      const { env, rawRecordId } = entry
      if (!env) continue
      const envTs =
        typeof env.timestamp === 'string' && isValidCanonicalTimestamp(env.timestamp)
          ? canonicalTimestamp(env.timestamp)
          : null
      if (envTs !== null) lastTimestamp = envTs
      if (env.type === 'turn_context') {
        const tc = (env.payload as CodexTurnContextPayload | undefined) ?? {}
        const sourceTurnId = typeof tc.turn_id === 'string' ? tc.turn_id : ''
        currentTurnRowId = deriveCodexTurnRowId(sessionId, sourceTurnId, turnOrdinal)
        const sandboxPolicy =
          typeof tc.sandbox_policy === 'string'
            ? tc.sandbox_policy
            : typeof tc.sandbox_policy?.mode === 'string'
              ? tc.sandbox_policy.mode
              : null
        if (typeof tc.model === 'string') {
          if (modelFirst === null) modelFirst = tc.model
          modelLast = tc.model
        }
        if (cwdInitial === null && typeof tc.cwd === 'string') cwdInitial = tc.cwd
        draft.turns.push({
          turn_id: currentTurnRowId,
          session_id: sessionId,
          source_turn_id: sourceTurnId.length > 0 ? sourceTurnId : null,
          ordinal: turnOrdinal,
          start_ts: envTs,
          end_ts: null,
          model: typeof tc.model === 'string' ? tc.model : null,
          cwd: typeof tc.cwd === 'string' ? tc.cwd : null,
          git_branch: gitBranchInitial,
          approval_policy: typeof tc.approval_policy === 'string' ? tc.approval_policy : null,
          sandbox_policy: sandboxPolicy,
          effort: typeof tc.effort === 'string' ? tc.effort : null,
          raw_record_id: rawRecordId,
        })
        turnOrdinal += 1
      } else if (env.type === 'response_item') {
        const ri = (env.payload as CodexResponseItemPayload | undefined) ?? {}
        const subtype = typeof ri.type === 'string' ? ri.type : 'message'
        if (subtype === 'function_call') {
          // Tool call.
          const callId =
            typeof ri.call_id === 'string' && ri.call_id.length > 0
              ? ri.call_id
              : typeof ri.id === 'string'
                ? ri.id
                : `call_${envIdx}`
          const toolCallId = `tcl_${toHex(blake3(new TextEncoder().encode(`codex:tcl:${sessionId}:${callId}`))).slice(0, 32)}`
          const toolName = typeof ri.name === 'string' ? ri.name : 'unknown'
          let commandPreview: string | null = null
          let pathPreview: string | null = null
          let queryPreview: string | null = null
          let cwdPreview: string | null = null
          const argsObj: Record<string, unknown> | null =
            typeof ri.arguments === 'string'
              ? (() => {
                  try {
                    const parsed = JSON.parse(ri.arguments)
                    return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null
                  } catch {
                    return null
                  }
                })()
              : ri.arguments !== null && typeof ri.arguments === 'object'
                ? (ri.arguments as Record<string, unknown>)
                : null
          if (argsObj !== null) {
            const cmd = argsObj.command
            if (Array.isArray(cmd)) commandPreview = cmd.map((c) => String(c)).join(' ')
            else if (typeof cmd === 'string') commandPreview = cmd
            if (typeof argsObj.path === 'string') pathPreview = argsObj.path
            if (typeof argsObj.file_path === 'string' && pathPreview === null) pathPreview = argsObj.file_path
            if (typeof argsObj.query === 'string') queryPreview = argsObj.query
            if (typeof argsObj.pattern === 'string' && queryPreview === null) queryPreview = argsObj.pattern
            if (typeof argsObj.cwd === 'string') cwdPreview = argsObj.cwd
          }
          draft.tool_calls.push({
            tool_call_id: toolCallId,
            session_id: sessionId,
            turn_id: currentTurnRowId,
            event_id: null,
            message_id: null,
            source_call_id: callId,
            tool_name: toolName,
            canonical_tool_type: null,
            args_object_id: null,
            command: commandPreview,
            cwd: cwdPreview,
            path: pathPreview,
            query: queryPreview,
            timestamp_start: envTs,
            timestamp_end: null,
            status: typeof ri.status === 'string' ? ri.status : null,
            raw_record_id: rawRecordId,
          })
          blockOrdinal += 1
        } else if (subtype === 'function_call_output') {
          const callId =
            typeof ri.call_id === 'string' && ri.call_id.length > 0
              ? ri.call_id
              : typeof ri.id === 'string'
                ? ri.id
                : `call_${envIdx}`
          const toolCallId = `tcl_${toHex(blake3(new TextEncoder().encode(`codex:tcl:${sessionId}:${callId}`))).slice(0, 32)}`
          const toolResultId = `tre_${toHex(blake3(new TextEncoder().encode(`codex:tre:${sessionId}:${callId}`))).slice(0, 32)}`
          let outputText: string | null = null
          if (typeof ri.output === 'string') outputText = ri.output
          else if (ri.output !== undefined && ri.output !== null) {
            try {
              outputText = JSON.stringify(ri.output)
            } catch {
              outputText = null
            }
          }
          const preview = outputText !== null ? outputText.slice(0, 4096) : null
          draft.tool_results.push({
            tool_result_id: toolResultId,
            tool_call_id: toolCallId,
            session_id: sessionId,
            message_id: null,
            event_id: null,
            source_call_id: callId,
            status: typeof ri.status === 'string' ? ri.status : null,
            is_error: ri.is_error === true,
            exit_code: null,
            duration_ms: null,
            stdout_object_id: null,
            stderr_object_id: null,
            output_object_id: null,
            preview,
            raw_record_id: rawRecordId,
          })
          blockOrdinal += 1
        } else {
          // Default: treat as a MessageV2 with one ContentBlockV2 per
          // content array entry.
          const role = mapCodexRole(typeof ri.role === 'string' ? ri.role : 'assistant')
          const sourceMessageId = typeof ri.id === 'string' && ri.id.length > 0 ? ri.id : `msg_${envIdx}`
          const messageRowId = `msg_${toHex(blake3(new TextEncoder().encode(`codex:msg:${sessionId}:${sourceMessageId}`))).slice(0, 32)}`
          const parentSourceId =
            typeof ri.parent_message_id === 'string' && ri.parent_message_id.length > 0 ? ri.parent_message_id : null
          const parentMessageRowId =
            parentSourceId !== null
              ? `msg_${toHex(blake3(new TextEncoder().encode(`codex:msg:${sessionId}:${parentSourceId}`))).slice(0, 32)}`
              : null
          if (typeof ri.model === 'string') {
            if (modelFirst === null) modelFirst = ri.model
            modelLast = ri.model
          }
          draft.messages.push({
            message_id: messageRowId,
            session_id: sessionId,
            turn_id: currentTurnRowId,
            event_id: null,
            source_message_id: sourceMessageId,
            role,
            author_name: null,
            model: typeof ri.model === 'string' ? ri.model : null,
            timestamp: envTs,
            ordinal: messageOrdinal,
            parent_message_id: parentMessageRowId,
            request_id: null,
            status: typeof ri.status === 'string' ? ri.status : null,
            raw_record_id: rawRecordId,
          })
          messageOrdinal += 1
          // Content blocks.
          const contentItems: CodexContentItem[] = Array.isArray(ri.content)
            ? ri.content
            : typeof ri.content === 'string'
              ? [{ type: 'output_text', text: ri.content }]
              : []
          for (let cIdx = 0; cIdx < contentItems.length; cIdx++) {
            const item = contentItems[cIdx]!
            const blockType = typeof item.type === 'string' ? item.type : 'text'
            const text =
              typeof item.text === 'string' ? item.text : typeof item.thinking === 'string' ? item.thinking : null
            const blockRowId = `blk_${toHex(blake3(new TextEncoder().encode(`codex:blk:${messageRowId}:${cIdx}`))).slice(0, 32)}`
            draft.content_blocks.push({
              block_id: blockRowId,
              message_id: messageRowId,
              event_id: null,
              session_id: sessionId,
              ordinal: cIdx,
              block_type: blockType,
              text_object_id: null,
              text_inline: text,
              mime_type: text !== null ? 'text/plain' : null,
              token_count: null,
              is_error: item.is_error === true,
              is_redacted: false,
              visibility: blockType === 'reasoning' || blockType === 'thinking' ? 'hidden_by_default' : 'default',
              raw_record_id: rawRecordId,
            })
          }
        }
      } else if (env.type === 'event_msg') {
        const ev = (env.payload as CodexEventMsgPayload | undefined) ?? {}
        const sourceEventId = typeof ev.id === 'string' && ev.id.length > 0 ? ev.id : `ev_${envIdx}`
        const eventRowId = `evt_${toHex(blake3(new TextEncoder().encode(`codex:evt:${sessionId}:${sourceEventId}`))).slice(0, 32)}`
        draft.events.push({
          event_id: eventRowId,
          session_id: sessionId,
          turn_id: currentTurnRowId,
          source_event_id: sourceEventId,
          event_type: typeof ev.subtype === 'string' ? ev.subtype : 'operational',
          source_type: 'event_msg',
          subtype: typeof ev.subtype === 'string' ? ev.subtype : null,
          timestamp: envTs,
          ordinal: eventOrdinal,
          actor: mapCodexActor(typeof ev.actor === 'string' ? ev.actor : null),
          payload_object_id: null,
          raw_record_id: rawRecordId,
          confidence: 'high',
          is_derived: false,
        })
        eventOrdinal += 1
      }
    }

    draft.sessions.push({
      session_id: sessionId,
      source_tool: SOURCE_TOOL,
      source_session_id: sessionLogicalId,
      project_id: null,
      parent_session_id: null,
      parent_resolution: 'unresolved',
      is_subagent: false,
      agent_role: sessionMetaPayload?.agent_role ?? null,
      agent_nickname: sessionMetaPayload?.agent_nickname ?? null,
      title: null,
      summary: null,
      start_ts: sessionMetaTimestamp ?? input.createdAt,
      end_ts: lastTimestamp,
      cwd_initial: cwdInitial,
      git_branch_initial: gitBranchInitial,
      model_first: modelFirst,
      model_last: modelLast,
      status: null,
      timeline_confidence: 'high',
      raw_record_id: firstRawRecordId,
    })

    // Lane 3 compile-to-index gate: emit one `SearchDocV2` per message
    // that has at least one indexable text content block. Mirrors the
    // load-bearing subset of v1's `buildSearchDocs` (codex variant)
    // without the per-tool-call / per-tool-result fan-out — those land
    // when the v2 codex importer ports its full v1 behaviour. The
    // Tantivy runtime planner / writer only needs the rows to exist;
    // the column shape matches `SEARCH_DOC_FIELDS`.
    const blocksByMessage = new Map<string, string[]>()
    for (const block of draft.content_blocks) {
      const textInline = block.text_inline
      if (typeof textInline !== 'string' || textInline.length === 0) continue
      if (block.block_type !== 'input_text' && block.block_type !== 'output_text' && block.block_type !== 'text') {
        continue
      }
      const messageId = block.message_id
      if (messageId === null) continue
      const list = blocksByMessage.get(messageId) ?? []
      list.push(textInline)
      blocksByMessage.set(messageId, list)
    }
    for (const message of draft.messages) {
      const texts = blocksByMessage.get(message.message_id)
      if (texts === undefined || texts.length === 0) continue
      const text = texts.join('\n')
      draft.search_docs.push({
        doc_id: `msg:${message.message_id}`,
        entity_type: 'message',
        entity_id: message.message_id,
        session_id: sessionId,
        project_id: null,
        timestamp: message.timestamp,
        role: message.role,
        tool_name: null,
        canonical_tool_type: null,
        field_kind: message.role === 'user' ? 'user_prompt' : 'assistant_text',
        errors_only: false,
        text,
      })
    }

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
      merge: { merge_strategy: 'single_source' },
    }
    return {
      unit,
      summary: {
        files: 1,
        sessions: 1,
        rawRecords: rawRecordIds.length,
      },
    }
  }
}

export { discoverCodexSessionFiles } from './discover.js'
export type { CodexEnvelope, CodexSessionMetaPayload } from './types.js'

// Helper for the `join` import — kept for the `path.normalize` semantics
// the orchestrator's per-row path field expects.
export const _normalizePath = (p: string): string => normalize(p)
export const _joinPath = (a: string, b: string): string => join(a, b)
